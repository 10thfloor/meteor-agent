import { assert } from 'chai';
import type { Provider, ProviderRequest } from '../server/providers/types';

/** A session in the shape every entry into a turn expects, seeded for one
 *  named agent. Same helper the loop tests use, agent-parameterized because
 *  skills and hook contexts are both read off the SESSION's agent. */
const seed = async (sessionId: string, text: string, agent: string) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await AgentMessages.insertAsync({
    _id: 'u-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

/** A long transcript whose estimated context blows a tiny window — the only
 *  way to make the loop issue a COMPACTION request, which is half of what
 *  `beforeProviderRequest`'s `purpose` exists to distinguish. */
const seedLong = async (sessionId: string, agent: string) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 5, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  const pad = 'x'.repeat(80);
  const rows: Array<[number, string, string]> = [
    [0, 'user', `OLD-1 ${pad}`], [1, 'assistant', `OLD-2 ${pad}`],
    [2, 'user', `OLD-3 ${pad}`], [3, 'assistant', `OLD-4 ${pad}`],
    [4, 'user', 'ask now'],
  ];
  for (const [seq, role, content] of rows) {
    await AgentMessages.insertAsync({
      _id: `m${seq}`, sessionId, seq, role, content, createdAt: new Date(),
    } as any);
  }
};

/** The resume an approval schedules is deferred and exposes no promise to
 *  await, so the wait is bounded by a deadline and fails loudly rather than
 *  hanging the suite. */
const waitFor = async (cond: () => Promise<boolean>, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

const SKILLS = [
  { name: 'refunds', description: 'How to process a refund.', content: 'REFUND-BODY-MARKER' },
  { name: 'shipping', description: 'When parcels arrive.', content: 'SHIPPING-BODY-MARKER' },
];

describe('skills', () => {
  it('lists name and description in the system prompt, never the content', async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');

    let seen: ProviderRequest | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req;
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    defineAgent('skilled-listing', {
      model: 'mock', instructions: 'You are helpful.', provider: capturing, skills: SKILLS,
    });
    await seed('sk-listing', 'hi', 'skilled-listing');
    await runTurn('sk-listing', buildRunConfig(getAgent('skilled-listing')!, 'u1'));

    const req = seen! as ProviderRequest;
    assert.include(req.system, 'You are helpful.');
    assert.include(req.system, '## Skills');
    assert.include(req.system, '- refunds — How to process a refund.');
    assert.include(req.system, '- shipping — When parcels arrive.');
    assert.include(
      req.system,
      "Load a skill's full instructions with the skill tool when its description matches the task.",
    );
    // The token economy, asserted rather than assumed: descriptions always,
    // bodies never.
    assert.notInclude(req.system, 'REFUND-BODY-MARKER');
    assert.notInclude(req.system, 'SHIPPING-BODY-MARKER');

    // The loader exists only because this agent has skills, and it is offered
    // to the model like any other tool.
    assert.deepEqual(req.tools.map((t) => t.name), ['skill']);
  });

  it('the skill tool loads a skill body into the tool row', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');

    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'sk1', name: 'skill', args: { name: 'refunds' } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        for (const ch of 'refunded') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 8 } };
      },
    };
    defineAgent('skilled-load', {
      model: 'mock', instructions: 'x', provider: scripted, skills: SKILLS,
    });
    await seed('sk-load', 'refund please', 'skilled-load');
    await runTurn('sk-load', buildRunConfig(getAgent('skilled-load')!, 'u1'));

    const row = await AgentMessages.findOneAsync({ sessionId: 'sk-load', role: 'tool' } as any);
    assert.isDefined(row, 'the skill tool must answer with a tool row');
    assert.include((row as any).content, 'REFUND-BODY-MARKER');
    assert.isUndefined((row as any).error, 'a loaded skill is a success');
    // The OTHER skill's body is not delivered by loading this one.
    assert.notInclude((row as any).content, 'SHIPPING-BODY-MARKER');
  });

  it('an unknown skill name answers a structured error naming the available skills', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');

    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'sk1', name: 'skill', args: { name: 'refunds-v2' } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    defineAgent('skilled-unknown', {
      model: 'mock', instructions: 'x', provider: scripted, skills: SKILLS,
    });
    await seed('sk-unknown', 'go', 'skilled-unknown');
    await runTurn('sk-unknown', buildRunConfig(getAgent('skilled-unknown')!, 'u1'));

    const row = await AgentMessages.findOneAsync({ sessionId: 'sk-unknown', role: 'tool' } as any);
    assert.equal((row as any).error.error, 'unknown-skill');
    // Names only: the descriptions are already in the system prompt, and
    // repeating them here would spend the tokens the design exists to save.
    assert.include((row as any).error.reason, 'refunds, shipping');
    assert.notInclude((row as any).error.reason, 'How to process a refund.');
    // The turn still finishes — an unknown skill is a result the model routes
    // around, not a failure.
    const reply = await AgentMessages.findOneAsync(
      { sessionId: 'sk-unknown', role: 'assistant', content: 'ok' } as any,
    );
    assert.isDefined(reply);
  });

  it("an app's own tool named skill wins, and the built-in is skipped with one warn", async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { _resetSkillWarnings } = await import('../server/tools');
    const { runTurn } = await import('../server/loop');

    let seen: ProviderRequest | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req;
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    defineAgent('skilled-collision', {
      model: 'mock',
      instructions: 'x',
      provider: capturing,
      skills: SKILLS,
      tools: [{
        name: 'skill',
        description: "THE APP'S OWN SKILL TOOL",
        args: { type: 'object', properties: {} },
        run: async () => 'app',
      }],
    });
    await seed('sk-collision', 'go', 'skilled-collision');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      _resetSkillWarnings();
      await runTurn('sk-collision', buildRunConfig(getAgent('skilled-collision')!, 'u1'));
    } finally {
      console.warn = originalWarn;
    }

    const req = seen! as ProviderRequest;
    // Exactly one `skill`, and it is the app's: a provider rejects a duplicate
    // tool name outright, so shipping both would break the whole turn.
    assert.deepEqual(req.tools.map((t) => t.name), ['skill']);
    assert.equal(req.tools[0].description, "THE APP'S OWN SKILL TOOL");
    assert.lengthOf(warnings, 1);
    assert.include(warnings[0], 'built-in skill loader');
  });

  it('refuses a malformed skill at define time', async function () {
    const { defineAgent } = await import('../server/registry');
    const base = { model: 'mock', instructions: 'x' } as any;

    assert.throws(
      () => defineAgent('bad-dup', {
        ...base,
        skills: [
          { name: 'refunds', description: 'a', content: 'A' },
          { name: 'refunds', description: 'b', content: 'B' },
        ],
      }),
      /Two skills are named "refunds"/,
    );
    assert.throws(
      () => defineAgent('bad-name', {
        ...base, skills: [{ name: 'not a name!', description: 'a', content: 'A' }],
      }),
      /must be 1-64 letters, digits or hyphens/,
    );
    assert.throws(
      () => defineAgent('bad-content', {
        ...base, skills: [{ name: 'refunds', description: 'a' } as any],
      }),
      /needs a non-empty "content" string/,
    );
    assert.throws(
      () => defineAgent('bad-description', {
        ...base, skills: [{ name: 'refunds', description: '  ', content: 'A' } as any],
      }),
      /needs a non-empty "description" string/,
    );
  });
});

describe('hooks', () => {
  it('refuses an unknown hook name at registration', async () => {
    const { Agent } = await import('../server/agent');
    try {
      assert.throws(
        () => (Agent as any).hook('beforeToolCall', () => {}),
        /Unknown hook "beforeToolCall"/,
      );
      assert.throws(
        () => (Agent as any).hook('afterToolResult', 'not a function'),
        /needs a function/,
      );
    } finally {
      Agent.clearHooks();
    }
  });

  it('beforeProviderRequest observes and patches the think request', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    const contexts: any[] = [];
    let seen: ProviderRequest | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req;
        for (const ch of 'answered') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 8 } };
      },
    };

    await seed('hk-before', 'hello', 'support');
    try {
      // Observer: returns nothing, so the request must pass through unchanged
      // by it.
      Agent.hook('beforeProviderRequest', (req, ctx) => { contexts.push(ctx); });
      Agent.hook('beforeProviderRequest', (req) => ({
        ...req, system: `${req.system} [PREAMBLE 2026-08-17]`,
      }));
      await runTurn('hk-before', {
        model: 'mock', system: 'be helpful', tools: [], provider: capturing,
      });
    } finally {
      Agent.clearHooks();
    }

    assert.lengthOf(contexts, 1);
    assert.deepEqual(contexts[0], {
      agent: 'support', sessionId: 'hk-before', purpose: 'think',
    });
    const req = seen! as ProviderRequest;
    assert.equal(req.system, 'be helpful [PREAMBLE 2026-08-17]');
    // The harness re-stamps its own abort signal after the hooks, so a hook
    // that rebuilds the request cannot disable the interrupt.
    assert.isDefined(req.signal, 'the interrupt signal must survive a rebuilt request');
    const reply = await AgentMessages.findOneAsync(
      { sessionId: 'hk-before', role: 'assistant' } as any,
    );
    assert.equal((reply as any).content, 'answered');
  });

  it('hooks run in registration order, each seeing the previous one\'s patch', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let seen = '';
    const capturing: Provider = {
      async *stream(req) {
        seen = req.system;
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seed('hk-order', 'hello', 'support');
    try {
      Agent.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}-A` }));
      Agent.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}-B` }));
      await runTurn('hk-order', {
        model: 'mock', system: 'base', tools: [], provider: capturing,
      });
    } finally {
      Agent.clearHooks();
    }

    assert.equal(seen, 'base-A-B', 'the second hook must see the first one\'s output');
  });

  it('beforeProviderRequest sees the compaction request too, and can replace it', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    const purposes: string[] = [];
    const scripted: Provider = {
      async *stream(req) {
        // The app's summarizer, recognizable because the hook wrote it.
        if (req.system.startsWith('CUSTOM-SUMMARIZER')) {
          for (const ch of 'BRIEF-FROM-THE-HOOK') yield { kind: 'text', chunk: ch };
        } else {
          for (const ch of 'final answer') yield { kind: 'text', chunk: ch };
        }
        yield { kind: 'done', usage: { input: 7, output: 3 } };
      },
    };

    await seedLong('hk-compact', 'support');
    try {
      Agent.hook('beforeProviderRequest', (req, ctx) => {
        purposes.push(ctx.purpose);
        // The summarizer hook, for free: swap the compaction request wholesale.
        if (ctx.purpose !== 'compaction') return undefined;
        return { ...req, system: 'CUSTOM-SUMMARIZER: one line only.' };
      });
      await runTurn('hk-compact', {
        model: 'mock', system: 'be helpful', tools: [], provider: scripted,
        context: { window: 100, compactAt: 0.5, keep: 2 },
      });
    } finally {
      Agent.clearHooks();
    }

    assert.deepEqual(purposes, ['compaction', 'think'],
      'every provider request runs the hook, compaction included');
    const note = await AgentMessages.findOneAsync(
      { sessionId: 'hk-compact', role: 'note', kind: 'compaction' } as any,
    );
    assert.equal((note as any).summary, 'BRIEF-FROM-THE-HOOK',
      'the replaced compaction request is what actually ran');
  });

  it('afterToolResult rewrites a result before the row is written', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    const observed: any[] = [];
    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'c1', name: 'lookup', args: { id: 7 } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seed('hk-after', 'look it up', 'support');
    try {
      Agent.hook('afterToolResult', (result, call, ctx) => {
        observed.push({ result, call, ctx });
        return {
          ok: true,
          value: JSON.stringify(result.value).replace(/4111\d+/, '[REDACTED]'),
        };
      });
      await runTurn('hk-after', {
        model: 'mock',
        system: '',
        tools: [{
          name: 'lookup',
          description: 'x',
          args: { type: 'object', properties: {} },
          run: async () => ({ card: '4111111111111111' }),
        }],
        provider: scripted,
      });
    } finally {
      Agent.clearHooks();
    }

    // The ROW is the assertion that matters: the hook runs before truncation
    // and before the write, so the transcript never held the original.
    const row = await AgentMessages.findOneAsync({ sessionId: 'hk-after', role: 'tool' } as any);
    assert.include((row as any).content, '[REDACTED]');
    assert.notInclude((row as any).content, '4111111111111111');

    assert.lengthOf(observed, 1);
    assert.deepEqual(observed[0].result, { ok: true, value: { card: '4111111111111111' } });
    assert.deepEqual(observed[0].call, { id: 'c1', name: 'lookup', args: { id: 7 } });
    assert.deepEqual(observed[0].ctx, {
      agent: 'support', sessionId: 'hk-after', userId: 'u1',
    });
  });

  it('skips a replacement request that drops `system`, and sends the original', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let seen: ProviderRequest | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req;
        yield { kind: 'text', chunk: 'answered' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seed('hk-nosystem', 'hello', 'support');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      // The shape a hook that rebuilds the request from scratch produces: model
      // and messages, no system prompt. Accepting it would send the model no
      // instructions, no skills listing and no tool guidance — an agent
      // answering as a bare chat model, with nothing in the transcript to say
      // why. `system` is not optional on `ProviderRequest`; the check now says so.
      Agent.hook('beforeProviderRequest', (req) => ({
        model: req.model, messages: req.messages,
      } as any));
      await runTurn('hk-nosystem', {
        model: 'mock', system: 'be helpful', tools: [], provider: capturing,
      });
    } finally {
      console.warn = originalWarn;
      Agent.clearHooks();
    }

    const req = seen! as ProviderRequest;
    assert.equal(req.system, 'be helpful', 'the request the harness built must stand');
    assert.isArray(req.tools, 'and stand whole — not half-replaced');
    assert.lengthOf(warnings, 1);
    assert.include(warnings[0], 'not a provider request');
    assert.include(
      warnings[0], '`model`, `system` and `messages`',
      'the warning must name what was missing',
    );
  });

  it('records a structured error for a result that cannot be serialized, and finishes the turn', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          // TWO calls in the batch: the warn latch is per KIND, not per
          // occurrence, so two unserializable results must produce one warning.
          yield {
            kind: 'done',
            toolCalls: [
              { id: 'c1', name: 'lookup', args: {} },
              { id: 'c2', name: 'lookup', args: {} },
            ],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        yield { kind: 'text', chunk: 'carried on' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seed('hk-circular', 'look it up', 'support');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      // A hook is app code and hands back what it likes. `JSON.stringify` throws
      // on a circular value (and on a BigInt), and that throw used to escape the
      // dispatch loop and abandon a turn that had already done all of its work.
      Agent.hook('afterToolResult', () => {
        const circular: any = { note: 'cannot be JSON' };
        circular.self = circular;
        return { ok: true, value: circular };
      });
      await runTurn('hk-circular', {
        model: 'mock',
        system: '',
        tools: [{
          name: 'lookup',
          description: 'x',
          args: { type: 'object', properties: {} },
          run: async () => ({ fine: true }),
        }],
        provider: scripted,
      });
    } finally {
      console.warn = originalWarn;
      Agent.clearHooks();
    }

    const rows = await AgentMessages
      .find({ sessionId: 'hk-circular', role: 'tool' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(rows, 2, 'both calls must still be answered — an unanswered tool_use 400s');
    for (const row of rows) {
      assert.equal((row as any).error?.error, 'unserializable-result');
      assert.equal(
        (row as any).content,
        JSON.stringify({
          error: 'unserializable-result',
          reason: 'The tool result could not be serialized.',
        }),
        'the row carries the structured substitute, never a half-written string',
      );
    }

    const reply = await AgentMessages.findOneAsync(
      { sessionId: 'hk-circular', role: 'assistant', content: 'carried on' } as any,
    );
    assert.isDefined(reply, 'the turn must complete — a bad value is the app\'s mistake, not ours');
    assert.equal((await AgentSessions.findOneAsync('hk-circular'))!.phase, 'idle');
    assert.lengthOf(
      warnings.filter((m) => m.includes('could not be serialized')), 1,
      'one warn per kind, not one per occurrence',
    );
  });

  it('a hook that throws — or returns junk — is skipped with one warn per kind, and the turn completes', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let calls = 0;
    const scripted: Provider = {
      async *stream(req) {
        calls += 1;
        assert.equal(req.system, 'be helpful', 'a thrown hook must leave the request alone');
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'c1', name: 'lookup', args: {} }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        for (const ch of 'survived') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 8 } };
      },
    };

    await seed('hk-throw', 'go', 'support');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      Agent.hook('beforeProviderRequest', () => { throw new Error('extension is broken'); });
      // The other way a hook goes wrong: it returns something that is not a
      // request at all (a `&&` chain, a forgotten `await`). Same treatment.
      Agent.hook('beforeProviderRequest', () => true as any);
      Agent.hook('afterToolResult', () => { throw new Error('redactor is broken'); });
      await runTurn('hk-throw', {
        model: 'mock',
        system: 'be helpful',
        tools: [{
          name: 'lookup',
          description: 'x',
          args: { type: 'object', properties: {} },
          run: async () => 'the real value',
        }],
        provider: scripted,
      });
    } finally {
      console.warn = originalWarn;
      Agent.clearHooks();
    }

    // Two provider calls' worth of failures, one tool result's worth — and one
    // warning per KIND, not one per occurrence. Three kinds fired here, and
    // "a hook threw" must not suppress "a hook returned junk".
    assert.lengthOf(warnings, 3);
    assert.include(warnings.join('\n'), 'a beforeProviderRequest hook threw and was skipped');
    assert.include(warnings.join('\n'), 'not a provider request');
    assert.include(warnings.join('\n'), 'an afterToolResult hook threw and was skipped');

    const row = await AgentMessages.findOneAsync({ sessionId: 'hk-throw', role: 'tool' } as any);
    assert.include((row as any).content, 'the real value', 'the un-hooked result stands');
    const reply = await AgentMessages.findOneAsync(
      { sessionId: 'hk-throw', role: 'assistant', content: 'survived' } as any,
    );
    assert.isDefined(reply, 'a broken extension must not kill the turn');
    assert.equal((await AgentSessions.findOneAsync('hk-throw'))!.phase, 'idle');
  });

  /**
   * The seam's contract is "nothing reaches a row unseen", and a turn writes
   * tool rows from THREE places: the streaming dispatch (covered above), the
   * `canUse` refusal that never dispatched at all, and the resume an approval
   * wakes. The two below are those other two — a redaction hook that covered
   * only the first would be a footgun rather than a guarantee, and a hook that
   * could be dodged by parking a call is no gate at all.
   */
  it('afterToolResult sees a canUse refusal, and its rewrite is what the row carries', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    const observed: any[] = [];
    let ran = false;
    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'd1', name: 'forbidden', args: { amt: 1 } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        for (const ch of 'moved on') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await seed('hk-denied', 'do the forbidden thing', 'support');
    try {
      // A rewrite that flips the arm as well as the text: an app turning the
      // harness's blunt `not-allowed` into a house-style answer is the obvious
      // use, and it is also what proves the row's `error` is written from the
      // POST-hook result — an unguarded write would stamp `not-allowed` onto a
      // row whose content now says it succeeded.
      Agent.hook('afterToolResult', (result, call, ctx) => {
        observed.push({ result, call, ctx });
        return { ok: true, value: 'REWRITTEN-BY-HOOK' };
      });
      await runTurn('hk-denied', {
        model: 'mock',
        system: '',
        tools: [{
          name: 'forbidden',
          description: 'x',
          // Gated as well as forbidden: §7's backstop must refuse BEFORE the
          // gate, so this call reaches the hook rather than parking.
          gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { ran = true; return 'never'; },
        }],
        canUse: async (tool) => tool !== 'forbidden',
        provider: scripted,
      });
    } finally {
      Agent.clearHooks();
    }

    assert.isFalse(ran, 'a forbidden tool must not run');
    const row = (await AgentMessages.findOneAsync(
      { sessionId: 'hk-denied', role: 'tool' } as any,
    ))!;
    assert.include((row as any).content, 'REWRITTEN-BY-HOOK', 'the ROW must carry the rewrite');
    assert.notInclude((row as any).content, 'may not use');
    assert.isUndefined(
      (row as any).error,
      'the rewritten result says ok — the row must not still claim not-allowed',
    );

    // And the hook was handed the harness's own refusal, unabridged.
    assert.lengthOf(observed, 1);
    assert.isFalse(observed[0].result.ok);
    assert.equal(observed[0].result.error.error, 'not-allowed');
    assert.include(observed[0].result.error.reason, 'forbidden');
    assert.deepEqual(observed[0].call, { id: 'd1', name: 'forbidden', args: { amt: 1 } });
    assert.deepEqual(observed[0].ctx, {
      agent: 'support', sessionId: 'hk-denied', userId: 'u1',
    });
  });

  it('afterToolResult runs on the resume an approval wakes, so parking cannot dodge it', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');
    const { getAgent, buildRunConfig } = await import('../server/registry');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const observed: any[] = [];
    let calls = 0;
    const scripted: Provider = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'p1', name: 'lookup', args: { id: 7 } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        for (const ch of 'finished') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    // Registered, because approve resumes through the REGISTRY config: the
    // tools and provider the method finds must be the ones that parked.
    new Agent('hk-gate').define({
      model: 'mock',
      instructions: '',
      provider: scripted,
      tools: [{
        name: 'lookup',
        description: 'x',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => ({ card: '4111111111111111' }),
      }],
    });
    await seed('hk-gate-session', 'look it up', 'hk-gate');
    await runTurn('hk-gate-session', buildRunConfig(getAgent('hk-gate')!, 'u1'));
    assert.equal(
      (await AgentSessions.findOneAsync('hk-gate-session'))!.phase, 'awaiting',
      'the fixture must actually park',
    );

    try {
      Agent.hook('afterToolResult', (result, call, ctx) => {
        observed.push({ result, call, ctx });
        return {
          ok: true,
          value: JSON.stringify(result.value).replace(/4111\d+/, '[REDACTED]'),
        };
      });
      const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
      await approve.call({ userId: 'u1', unblock() {} }, 'hk-gate', 'hk-gate-session');
      await waitFor(
        async () => !!(await AgentMessages.findOneAsync(
          { sessionId: 'hk-gate-session', role: 'tool', toolCallId: 'p1' } as any,
        )),
        'the approved call to be answered',
      );
    } finally {
      Agent.clearHooks();
    }

    const row = (await AgentMessages.findOneAsync(
      { sessionId: 'hk-gate-session', role: 'tool', toolCallId: 'p1' } as any,
    ))!;
    assert.include((row as any).content, '[REDACTED]', 'the resumed row must carry the rewrite');
    assert.notInclude(
      (row as any).content, '4111111111111111',
      'a redaction hook must not be dodgeable by parking the call',
    );
    assert.lengthOf(observed, 1);
    assert.deepEqual(observed[0].result, { ok: true, value: { card: '4111111111111111' } });
    assert.deepEqual(observed[0].call, { id: 'p1', name: 'lookup', args: { id: 7 } });
    assert.deepEqual(observed[0].ctx, {
      agent: 'hk-gate', sessionId: 'hk-gate-session', userId: 'u1',
    });
  });

  /**
   * PER-AGENT hooks (v3). Same two seams, scoped by `ctx.agent` — which is read
   * off the SESSION document, so a child session reports the child's agent and
   * a subagent's hooks are the subagent's.
   */
  it('a per-agent hook runs only for its own agent, and clears on its own', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let seen: string | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req.system;
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    const run = (sessionId: string) => runTurn(sessionId, {
      model: 'mock', system: 'base', tools: [], provider: capturing,
    });

    const mine = new Agent('hk-mine');
    try {
      Agent.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+GLOBAL` }));
      mine.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+MINE` }));

      await seed('hk-scoped-mine', 'hi', 'hk-mine');
      await run('hk-scoped-mine');
      assert.equal(seen, 'base+GLOBAL+MINE');

      // A DIFFERENT agent, same process, same global hook: the per-agent one
      // must not follow it. This is the assertion the whole feature is for —
      // without it, `agentInstance.hook` would just be `Agent.hook` with extra
      // syntax.
      await seed('hk-scoped-other', 'hi', 'hk-other');
      await run('hk-scoped-other');
      assert.equal(seen, 'base+GLOBAL', "another agent must not see hk-mine's hook");

      // The narrow half of the test seam: one agent's hooks go, the global ones
      // stay. (`Agent.clearHooks()` clears both — the `finally` below relies on
      // exactly that, and every other test in this file already did.)
      mine.clearHooks();
      await seed('hk-scoped-cleared', 'hi', 'hk-mine');
      await run('hk-scoped-cleared');
      assert.equal(seen, 'base+GLOBAL', 'instance clearHooks() clears only that agent');
    } finally {
      Agent.clearHooks();
    }
  });

  it('runs every global hook first, then the agent\'s own, each in registration order', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    let seen: string | null = null;
    const capturing: Provider = {
      async *stream(req) {
        seen = req.system;
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    const ordered = new Agent('hk-ordered');
    await seed('hk-order-session', 'hi', 'hk-ordered');
    try {
      // Registered INTERLEAVED — agent, global, agent, global — so the assertion
      // below can only pass if the order comes from the SCOPE and not from the
      // sequence of `hook()` calls. Each hook appends its own tag, so the
      // composition is the whole chain, in order, in one string.
      ordered.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+A1` }));
      Agent.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+G1` }));
      ordered.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+A2` }));
      Agent.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+G2` }));

      await runTurn('hk-order-session', {
        model: 'mock', system: 'base', tools: [], provider: capturing,
      });
    } finally {
      Agent.clearHooks();
    }

    // Globals first (in their own registration order), then the agent's (in
    // theirs). The agent's hook sees the global chain's output and gets the
    // last word — specificity, exactly as the README documents it.
    assert.equal(seen, 'base+G1+G2+A1+A2');
  });

});
