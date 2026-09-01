import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Agent } from '../server/agent';
import type { Provider, ProviderRequest } from '../server/providers/types';

/**
 * The M4 small candidates: the provider registry, manual compaction, and
 * `runAs`. The approvals rate-limit entry lives with the other `applyRateLimits`
 * assertions in capped.test.ts, beside the HEADROOM idiom they share.
 */

Meteor.methods({
  'test.whoAmI'(this: any) {
    return `as:${this.userId}`;
  },
});

/** A provider that records every request it is given and answers to script. */
const recorder = (answer: (req: ProviderRequest) => string) => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async *stream(req) {
      requests.push(req);
      for (const ch of answer(req)) yield { kind: 'text', chunk: ch };
      yield { kind: 'done', usage: { input: 7, output: 3 } };
    },
  };
  return { provider, requests };
};

/** Deferred work (the resume an approval schedules) exposes no promise to
 *  await, so every wait here is bounded by a deadline and fails loudly rather
 *  than hanging the suite. */
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

/** Capture `console.warn` for the duration of `fn`. Restored in a `finally`, so
 *  a failing assertion cannot leave the suite without a working warn. */
const captureWarn = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return seen;
};

describe('Agent.provider registry', () => {
  it('resolves a `provider: "name"` string through the registry at run time', async () => {
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { provider } = recorder(() => 'hi');

    Agent.provider('registry-test', provider);
    defineAgent('provider-string', {
      model: 'mock', instructions: 'be helpful', provider: 'registry-test',
    });

    const run = buildRunConfig(getAgent('provider-string')!, 'u1');
    assert.strictEqual(
      run.provider, provider,
      'the string must resolve to the registered implementation itself',
    );
  });

  it('throws for an unknown name at buildRunConfig — NOT at define()', async () => {
    // The order matters and is the whole reason resolution is late: an agent
    // may legitimately name a provider whose registration lives in a file that
    // loads afterwards, so define() must accept the string.
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');

    defineAgent('provider-unknown', {
      model: 'mock', instructions: 'be helpful', provider: 'no-such-provider',
    });

    let threw: any;
    try {
      buildRunConfig(getAgent('provider-unknown')!, null);
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'an unregistered provider name must throw when a turn needs it');
    assert.include(
      threw.message, 'no-such-provider',
      'the message must name the provider that was asked for',
    );
    assert.include(threw.message, 'Agent.provider', 'and how to register it');
  });

  it('overwrites a re-registered name with one warning, and the newest wins', async () => {
    const { getProvider } = await import('../server/registry');
    const first = recorder(() => 'first').provider;
    const second = recorder(() => 'second').provider;

    Agent.provider('registry-dup', first);
    const warns = await captureWarn(() => { Agent.provider('registry-dup', second); });

    assert.lengthOf(warns, 1, 'exactly one warning per overwrite — a hot reload is not an error');
    assert.include(warns[0], 'registry-dup');
    assert.strictEqual(getProvider('registry-dup'), second, 'the newest registration wins');
  });

  it('refuses an implementation with no stream method, at registration', async () => {
    // This one CAN be checked eagerly: it is a shape error in the argument
    // itself, not a question about what else has loaded yet.
    let threw: any;
    try {
      (Agent as any).provider('registry-bad', { notAStream: true });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw);
    assert.include(threw.message, 'stream');
  });
});

describe('manual compaction (Agent.compact)', () => {
  const SESSION = 's-manual-compact';

  /** Five padded messages under a threshold so high the automatic path can
   *  never fire — the only thing that can compact this session is a manual
   *  call, which is exactly what these tests are about. */
  const seed = async (sessionId: string, agent = 'compact-test') => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({ _id: sessionId } as any);
    await AgentMessages.removeAsync({ sessionId });
    await AgentDeltas.removeAsync({ sessionId });
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
        _id: `${sessionId}-${seq}`, sessionId, seq, role, content, createdAt: new Date(),
      } as any);
    }
  };

  const define = (provider: Provider) => new Agent('compact-test').define({
    model: 'mock',
    instructions: 'be helpful',
    provider,
    // A threshold that can never trip: window * compactAt is far past anything
    // this transcript estimates at.
    context: { window: 1_000_000, compactAt: 0.99, keep: 2 },
  });

  it('compacts below the threshold, and the next turn thinks against the summary', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');

    await seed(SESSION);
    const { provider, requests } = recorder(
      (req) => (req.system.includes('compact') ? 'SUMMARY-BRIEF' : 'final answer'),
    );
    const agent = define(provider);

    assert.isTrue(await agent.compact(SESSION), 'a manual compact must commit a note');
    assert.lengthOf(requests, 1, 'exactly one summarization call, the threshold notwithstanding');

    const note = await AgentMessages.findOneAsync(
      { sessionId: SESSION, role: 'note', kind: 'compaction' } as any,
    );
    assert.isDefined(note, 'the note is what makes the compaction durable');
    assert.equal((note as any).summary, 'SUMMARY-BRIEF');
    assert.equal((note as any).upto, 2, 'keep=2 keeps OLD-4 and "ask now"');

    // The TRANSCRIPT keeps every message — a manual compaction deletes nothing.
    assert.equal(await AgentMessages.find({ sessionId: SESSION }).countAsync(), 6);

    // And the model's view has actually moved: the next think starts from the
    // summary, not from OLD-2.
    await runTurn(SESSION, buildRunConfig(getAgent('compact-test')!, 'u1'));
    const think = requests[1];
    assert.isDefined(think, 'the turn after a manual compaction must still run');
    assert.include(think.messages[0].content, '[Earlier conversation, compacted]');
    assert.include(think.messages[0].content, 'SUMMARY-BRIEF');
    assert.notInclude(
      JSON.stringify(think.messages), 'OLD-2',
      'compacted messages must not reach the model after a manual compact either',
    );
  });

  it('leaves an idle session idle and unleased — nothing for the watcher to fight', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');

    await seed('s-manual-idle');
    const { provider } = recorder(() => 'BRIEF');
    await new Agent('compact-test').define({
      model: 'mock',
      instructions: 'be helpful',
      provider,
      context: { window: 1_000_000, compactAt: 0.99, keep: 2 },
    }).compact('s-manual-idle');

    const after = await AgentSessions.findOneAsync('s-manual-idle');
    assert.equal(
      after!.phase, 'idle',
      'compaction leaves `compacting` behind inside a turn; a manual one must clear it',
    );
    assert.isNotOk(
      (after as any).lease,
      'the lease is taken for the operation and released — an orphan here would be '
      + 'claimed and re-run by the watcher',
    );
  });

  it('refuses with `busy` while another server holds the lease', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    await seed('s-manual-busy');
    await AgentSessions.updateAsync('s-manual-busy', {
      $set: { lease: { serverId: 'another-server', until: new Date(Date.now() + 60_000) } },
    } as any);

    const { provider, requests } = recorder(() => 'BRIEF');
    let threw: any;
    try {
      await new Agent('compact-test').define({
        model: 'mock', instructions: 'be helpful', provider,
        context: { window: 1_000_000, compactAt: 0.99, keep: 2 },
      }).compact('s-manual-busy');
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a leased session must refuse, not queue');
    assert.equal(threw.error, 'busy');
    assert.lengthOf(requests, 0, 'and it must refuse BEFORE spending a model call');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-manual-busy', role: 'note' } as any).countAsync(),
      0,
      'a refused compaction writes nothing at all',
    );
  });

  it('refuses a session parked on an approval, and the verdict still resolves it', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');
    const { NAMES } = await import('../common/names');

    // A parked run holds NO lease — it releases it when it parks — so the
    // `busy` check above cannot see this session. Without a phase guard the
    // compaction would write `compacting` over `awaiting` and its finally would
    // restore `idle`: `recordVerdict` requires `awaiting`, so the pending
    // approval would become unanswerable, and the next send's overtaken-park
    // branch would DELETE the parked turn.
    await seed('s-compact-park', 'compact-park');
    const requests: ProviderRequest[] = [];
    let toolRan = 0;
    let calls = 0;
    const provider: Provider = {
      async *stream(req) {
        requests.push(req);
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'gp1', name: 'refund', args: { amt: 5 } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        for (const ch of 'all done') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };
    const parking = new Agent('compact-park').define({
      model: 'mock',
      instructions: 'be helpful',
      provider,
      tools: [{
        name: 'refund',
        description: 'x',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { toolRan += 1; return { did: 'refund' }; },
      }],
      // keep=2 against a six-message transcript: there IS a legal cut here, so
      // the refusal below is a refusal and not a disguised `nothing`.
      context: { window: 1_000_000, compactAt: 0.99, keep: 2 },
    });

    await runTurn('s-compact-park', buildRunConfig(getAgent('compact-park')!, 'u1'));
    const parked = (await AgentSessions.findOneAsync('s-compact-park'))!;
    assert.equal(parked.phase, 'awaiting', 'the fixture must actually park');
    assert.isNotOk(parked.lease, 'and a parked run holds no lease — hence the phase guard');

    let threw: any;
    try {
      await parking.compact('s-compact-park');
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'compacting a parked session must refuse, not proceed');
    assert.equal(threw.error, 'busy', 'the published error code is unchanged');
    assert.include(
      threw.reason, 'approval',
      'and its reason must say WHICH kind of busy — a person has an answer to give',
    );

    const after = (await AgentSessions.findOneAsync('s-compact-park'))!;
    assert.equal(after.phase, 'awaiting', 'the phase a UI gates its approval bar on must stand');
    assert.deepInclude(
      after.pending as any, { toolCallId: 'gp1', name: 'refund' },
      'the pending request must survive untouched',
    );
    assert.lengthOf(requests, 1, 'a refused compaction spends no model call');
    assert.equal(
      await AgentMessages.find(
        { sessionId: 's-compact-park', role: 'note' } as any,
      ).countAsync(),
      0, 'and writes nothing',
    );

    // The whole point of refusing: the approval is still answerable, end to end.
    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1', unblock() {} }, 'compact-park', 's-compact-park');
    await waitFor(
      // Phase belongs in the condition: the final commit lands a beat before
      // the wind-down idles the phase, and sampling between them is a race.
      async () => !!(await AgentMessages.findOneAsync(
        { sessionId: 's-compact-park', role: 'assistant', content: 'all done' } as any,
      )) && (await AgentSessions.findOneAsync('s-compact-park'))?.phase === 'idle',
      'the approved turn to resume and finish',
    );
    assert.equal(toolRan, 1, 'the approved tool must run exactly once');
    const done = (await AgentSessions.findOneAsync('s-compact-park'))!;
    assert.isUndefined(done.pending, 'the verdict is spent');
    assert.equal(done.phase, 'idle');
  });

  it('refuses an errored session rather than laundering it back to idle', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // `error` is terminal STATUS — a banner, a retry button, an alert someone
    // is paged by — and it is unleased exactly like a parked session. Compaction
    // is bookkeeping; the finally that restores `idle` would silently clear it.
    await seed('s-compact-errored');
    await AgentSessions.updateAsync('s-compact-errored', {
      $set: { phase: 'error', updatedAt: new Date() },
    } as any);

    const { provider, requests } = recorder(() => 'BRIEF');
    let threw: any;
    try {
      await define(provider).compact('s-compact-errored');
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'an errored session must refuse');
    assert.equal(threw.error, 'busy');
    assert.include(threw.reason, 'failed', 'the reason must name the terminal state');

    const after = (await AgentSessions.findOneAsync('s-compact-errored'))!;
    assert.equal(after.phase, 'error', 'the failure must still be visible to a UI');
    assert.isNotOk(after.lease, 'and no lease may be left behind by a refusal');
    assert.lengthOf(requests, 0, 'no model call is spent on a refusal');
    assert.equal(
      await AgentMessages.find(
        { sessionId: 's-compact-errored', role: 'note' } as any,
      ).countAsync(),
      0,
    );
  });

  it('refuses compaction for a session over its spend budget (M-COMPACT-BUDGET)', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // A compaction is a full provider round trip that bills like a turn, and
    // `budget.spend` is its named backstop — so a session already at its spend
    // cap must be refused compaction BEFORE it spends one more call.
    await seed('s-compact-budget', 'compact-budgeted');
    await AgentSessions.updateAsync('s-compact-budget', {
      $set: { 'usage.cost': 5 },
    } as any);

    const { provider, requests } = recorder(() => 'BRIEF');
    const budgeted = new Agent('compact-budgeted').define({
      model: 'mock', instructions: 'be helpful', provider,
      budget: { spend: '$1.00' },
      context: { window: 1_000_000, compactAt: 0.99, keep: 2 },
    });

    let threw: any;
    try {
      await budgeted.compact('s-compact-budget');
    } catch (e) { threw = e; }
    assert.isDefined(threw, 'a session over its spend budget must refuse compaction');
    assert.equal(threw.error, 'budget-exhausted', 'with its OWN code, not `busy`');

    assert.lengthOf(requests, 0, 'and it must refuse BEFORE spending a model call');
    assert.equal(
      await AgentMessages.find(
        { sessionId: 's-compact-budget', role: 'note' } as any,
      ).countAsync(),
      0, 'a refused compaction writes nothing',
    );
    // A session UNDER its cap still compacts — the guard is `>=`, not "has a budget".
    await AgentSessions.updateAsync('s-compact-budget', { $set: { 'usage.cost': 0.5 } } as any);
    assert.isTrue(
      await budgeted.compact('s-compact-budget'),
      'a session below its spend cap compacts normally',
    );
  });

  it('is reachable over DDP as agent.compact, authorized like every session method', async function () {
    this.timeout(30000);
    await seed('s-manual-ddp');
    const { provider } = recorder(() => 'BRIEF');
    define(provider);

    const { NAMES } = await import('../common/names');
    const handler = (Meteor as any).server.method_handlers[NAMES.mCompact];
    assert.isFunction(handler, 'agent.compact must be registered');

    // The session belongs to u1, so a caller who is not u1 must not be able to
    // compact it — the same `requireSession` refusal send and fork give.
    let threw: any;
    try {
      await handler.call(
        { userId: 'someone-else', unblock() {} }, 'compact-test', 's-manual-ddp',
      );
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw);
    assert.equal(threw.error, 'no-session');

    const compacted = await handler.call(
      { userId: 'u1', unblock() {} }, 'compact-test', 's-manual-ddp',
    );
    assert.isTrue(compacted, 'the owner gets the compaction and its boolean result');
  });
});

describe('runAs on tool specs', () => {
  it('runs an inline tool as `runAs`, with the session owner still visible in ctx', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'svc',
      description: 'x',
      args: { type: 'object', properties: {} },
      runAs: 'service-account',
      run: async (_args: any, ctx: any) => `${ctx.userId}/${ctx.callerUserId}`,
    }]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isTrue(r.ok);
    assert.equal(
      r.value, 'service-account/u1',
      'ctx.userId is the escalated identity; callerUserId keeps the real owner',
    );
  });

  it('makes `runAs: null` an anonymous service context, not "unset"', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'anon',
      description: 'x',
      args: { type: 'object', properties: {} },
      runAs: null,
      run: async (_args: any, ctx: any) => ctx.userId,
    }]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isNull(r.value, 'null must not fall back to the session user');
  });

  it('gives an adopted method `runAs` as its own this.userId', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [escalated] = resolveTools([{
      method: 'test.whoAmI', description: 'x', args: { type: 'object', properties: {} },
      runAs: 'admin',
    }]);
    const [plain] = resolveTools([
      { method: 'test.whoAmI', description: 'x', args: { type: 'object', properties: {} } },
    ]);

    assert.equal((await runTool(escalated, {}, { userId: 'u1', sessionId: 's1' })).value, 'as:admin');
    assert.equal(
      (await runTool(plain, {}, { userId: 'u1', sessionId: 's1' })).value, 'as:u1',
      'the same method without runAs still runs as the session owner',
    );
  });

  it('refuses runAs on subagent and MCP specs at resolveTools', async () => {
    const { resolveTools } = await import('../server/tools');
    for (const spec of [
      { subagent: 'researcher', description: 'x', runAs: 'admin' },
      { mcp: { server: 'docs', tool: 'search' }, description: 'x', runAs: null },
    ]) {
      let threw: any;
      try {
        resolveTools([spec as any]);
      } catch (e) {
        threw = e;
      }
      assert.isDefined(threw, `runAs must be refused on ${JSON.stringify(spec)}`);
      assert.include(threw.message, 'runAs');
    }
  });
});
