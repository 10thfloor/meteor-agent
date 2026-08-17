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
  const seed = async (sessionId: string) => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({ _id: sessionId } as any);
    await AgentMessages.removeAsync({ sessionId });
    await AgentDeltas.removeAsync({ sessionId });
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'compact-test', userId: 'u1', phase: 'idle', model: 'mock',
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
