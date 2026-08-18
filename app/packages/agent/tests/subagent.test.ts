import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

/** Deferred work (the resume a verdict schedules) exposes no promise to await,
 *  so every wait here is bounded by a deadline and fails loudly rather than
 *  hanging the suite. Same helper the gate suite uses. */
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

/** A ROOT session (no `parent`, no `depth`) with one user message, exactly as
 *  `agent.start` + `agent.send` would leave it. */
const seedRoot = async (sessionId: string, agent: string, text = 'go') => {
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
    _id: 'root-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

/** A provider that asks for one tool call and then answers with the result it
 *  got back — branching on the HISTORY, never on a call counter, so one script
 *  can serve several sessions (a subagent chain runs many at once). */
const delegating = async (toolName: string, args: unknown = { prompt: 'look it up' }) => {
  const { mockProvider } = await import('../server/providers/mock');
  return mockProvider((req) => {
    const toolRow = req.messages.find((m) => m.role === 'tool');
    if (!toolRow) {
      return { toolCalls: [{ id: `call-${toolName}`, name: toolName, args }] };
    }
    return { text: `saw:${toolRow.content}` };
  });
};

/**
 * A parent turn whose subagent parks on an ask-gate, run to completion.
 * Registration is load-bearing: `agent.approve` resumes the CHILD through the
 * registry, so the tools and provider the method finds have to be the same ones
 * the park was produced with.
 */
const parkFixture = async (sessionId: string, childAgent: string) => {
  const { Agent } = await import('../server/agent');
  const { mockProvider } = await import('../server/providers/mock');
  const { runTurn } = await import('../server/loop');
  const { AgentMessages } = await import('../common/collections');

  const state = { refundRan: false };
  new Agent(childAgent, {
    model: 'mock',
    instructions: '',
    tools: [{
      name: 'refund',
      description: 'x',
      gate: 'ask',
      args: { type: 'object', properties: {} },
      run: async () => { state.refundRan = true; return { did: 'refund' }; },
    }],
    provider: mockProvider((req) => (
      req.messages.some((m) => m.role === 'tool')
        ? { text: 'refunded after approval' }
        : { toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] }
    )),
  });

  await seedRoot(sessionId, 'park-parent');
  await runTurn(sessionId, {
    model: 'mock',
    system: '',
    tools: [{ subagent: childAgent, description: 'may need approval' }],
    provider: await delegating(childAgent),
  });

  const row = (await AgentMessages.findOneAsync({ sessionId, role: 'tool' } as any))!;
  return { state, row };
};

describe('subagents', () => {
  it('runs a child session that persists, with lineage, and answers the parent', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    new Agent('sub-researcher', {
      model: 'mock',
      instructions: ({ userId }) => `you serve ${userId}`,
      tools: [],
      provider: mockProvider(() => ({ text: 'Ottawa' })),
    });

    await seedRoot('s-sub-basic', 'sub-writer', 'what is the capital of Canada?');
    await runTurn('s-sub-basic', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'sub-researcher', description: 'Ask the researcher' }],
      provider: await delegating('sub-researcher', { prompt: 'capital of Canada' }),
    });

    // The parent's tool row: the child's final assistant text, verbatim — the
    // `ask()` contract — plus the handle on the child transcript.
    const parentMsgs = await AgentMessages
      .find({ sessionId: 's-sub-basic' }, { sort: { seq: 1 } }).fetchAsync();
    const row = parentMsgs.find((m) => m.role === 'tool')!;
    assert.isDefined(row, 'the subagent call must be answered');
    assert.isUndefined(row.error);
    assert.equal(row.content, JSON.stringify('Ottawa'));
    assert.isString(row.childSessionId, 'the tool row must record the child session id');
    assert.equal(parentMsgs[parentMsgs.length - 1].content, `saw:${JSON.stringify('Ottawa')}`);

    // The CHILD outlives the call. This is the whole difference from `ask`,
    // which deletes its throwaway before returning.
    const child = (await AgentSessions.findOneAsync(row.childSessionId!))!;
    assert.isDefined(child, 'the child session must persist after the call completes');
    assert.equal(child.agent, 'sub-researcher');
    assert.equal(child.userId, 'u1', 'the child inherits the parent session owner');
    assert.equal(child.depth, 1);
    assert.deepEqual(child.parent, {
      sessionId: 's-sub-basic', toolCallId: 'call-sub-researcher',
    });
    assert.equal(child.phase, 'idle');

    const childMsgs = await AgentMessages
      .find({ sessionId: child._id }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(childMsgs[0].role, 'user');
    assert.equal(childMsgs[0].content, 'capital of Canada', 'args.prompt is the first message');
    assert.equal(childMsgs[childMsgs.length - 1].content, 'Ottawa');
    // Its own turn accounting, on its own document.
    assert.equal(child.budgetSpent.turns, 1);
  });

  it('streams the child transcript live, under the child session id', async function () {
    this.timeout(30000);
    const { AgentDeltas, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    // Deltas are removed at commit, so they must be captured DURING the child's
    // stream — the same idiom the loop suite uses, moved onto the CHILD agent's
    // provider, which is the only place with a window into a live child turn.
    let midFlight: { session: any; deltas: any[] } | null = null;
    const paced: Provider = {
      async *stream() {
        for (const ch of 'streamed by the child') yield { kind: 'text', chunk: ch };
        await new Promise((r) => { setTimeout(r, 200); });  // > flushMs
        const session = await AgentSessions.findOneAsync({ 'parent.sessionId': 's-sub-live' } as any);
        midFlight = {
          session,
          deltas: session ? await AgentDeltas.find({ sessionId: session._id }).fetchAsync() : [],
        };
        yield { kind: 'done', usage: { input: 1, output: 21 } };
      },
    };
    new Agent('sub-live', {
      model: 'mock', instructions: '', tools: [], provider: paced,
    });

    await seedRoot('s-sub-live', 'live-parent');
    await runTurn('s-sub-live', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'sub-live', description: 'watch me' }],
      provider: await delegating('sub-live'),
    });

    const seen = midFlight as unknown as { session: any; deltas: any[] } | null;
    assert.isNotNull(seen, 'the child provider must have run');
    assert.isDefined(seen!.session, 'the child session must exist WHILE it streams');
    assert.equal(seen!.session.depth, 1);
    assert.equal(seen!.session.phase, 'streaming');
    assert.isAbove(seen!.deltas.length, 0, 'the child must stream deltas of its own');
    assert.equal(
      seen!.deltas.map((d: any) => d.chunk).join(''), 'streamed by the child',
      'a subscriber to the child sees the same text the child commits',
    );
  });

  it('refuses past the depth limit with a structured result and creates no session', async function () {
    this.timeout(60000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { MAX_SUBAGENT_DEPTH } = await import('../server/subagent');

    // A four-hop chain from a root session: depth 1, 2 and 3 are legal; the
    // fourth is the one the guard exists for.
    let deepestRan = false;
    for (const [name, next] of [['d-a', 'd-b'], ['d-b', 'd-c'], ['d-c', 'd-d']] as const) {
      new Agent(name, {
        model: 'mock',
        instructions: '',
        tools: [{ subagent: next, description: `delegate to ${next}` }],
        provider: await delegating(next),
      });
    }
    // Registered, so the refusal below is about DEPTH and not about an unknown
    // agent name — and so "it never ran" is a fact about the guard.
    new Agent('d-d', {
      model: 'mock',
      instructions: '',
      tools: [],
      provider: mockProvider(() => { deepestRan = true; return { text: 'too deep to speak' }; }),
    });

    await seedRoot('s-depth', 'd-root');
    await runTurn('s-depth', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'd-a', description: 'delegate to d-a' }],
      provider: await delegating('d-a'),
    });

    assert.isFalse(deepestRan, 'the refused subagent must never run');

    const sessions = await AgentSessions.find({}).fetchAsync();
    const byDepth = sessions.map((s) => s.depth ?? 0).sort();
    assert.deepEqual(byDepth, [0, 1, 2, 3], 'exactly three children, none past the limit');
    assert.equal(MAX_SUBAGENT_DEPTH, 3);

    // The refusal lands as a TOOL RESULT inside the deepest child, so the model
    // there can route around it — not as a throw that would kill four turns.
    const deepest = sessions.find((s) => s.depth === 3)!;
    assert.equal(deepest.agent, 'd-c');
    const refusal = (await AgentMessages
      .find({ sessionId: deepest._id, role: 'tool' } as any).fetchAsync())[0];
    assert.equal(refusal.error!.error, 'subagent-depth');
    assert.include(refusal.error!.reason!, 'level 4');
    assert.isUndefined(refusal.childSessionId, 'a refused call opens no child session');
    assert.equal(deepest.phase, 'idle', 'the refused turn still finishes normally');

    // And it survives all the way back up: the root's answer quotes it.
    const rootMsgs = await AgentMessages
      .find({ sessionId: 's-depth' }, { sort: { seq: 1 } }).fetchAsync();
    assert.include(rootMsgs[rootMsgs.length - 1].content!, 'subagent-depth');
  });

  it('answers the parent subagent-parked while the CHILD stays awaiting', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');

    const { state, row } = await parkFixture('s-park-parent', 'sub-parker');

    // The PARENT does not hang: a turn waiting on a human it cannot reach is
    // the failure `ask-parked` exists to prevent, and the same reasoning
    // applies one level down.
    assert.equal(row.error!.error, 'subagent-parked');
    assert.include(row.error!.reason!, 'refund');
    assert.isString(row.childSessionId, 'the parked child is exactly what a human must open');
    const parent = (await AgentSessions.findOneAsync('s-park-parent'))!;
    assert.equal(parent.phase, 'idle', 'the parent turn completed');

    // …and the CHILD is genuinely parked, not merely reported as parked: a real
    // session, a standing `pending`, waiting for the ordinary approve/deny path.
    const child = (await AgentSessions.findOneAsync(row.childSessionId!))!;
    assert.equal(child.phase, 'awaiting');
    assert.deepInclude(child.pending as any, { toolCallId: 'g1', name: 'refund' });
    assert.isUndefined(child.lease, 'a parked run holds no lease');
    assert.isFalse(state.refundRan, 'the gated tool must not have run');
  });

  it('lets a human approve the parked child, which then completes on its own', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // The escape hatch the `subagent-parked` rejection buys: the child's session
    // is real, so `agent.approve` authorizes against it exactly as it would for
    // a top-level session — the child's own agent name, the INHERITED userId.
    const { state, row } = await parkFixture('s-park-approve', 'sub-parker-2');
    const childId = row.childSessionId!;

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'sub-parker-2', childId);

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: childId, role: 'assistant' }).countAsync()) === 2,
      'the approved child to finish its own turn',
    );

    const child = (await AgentSessions.findOneAsync(childId))!;
    assert.equal(child.phase, 'idle');
    assert.isUndefined(child.pending);
    assert.isTrue(state.refundRan, 'the approval runs the gated tool, once');
    const childMsgs = await AgentMessages
      .find({ sessionId: childId }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(childMsgs[childMsgs.length - 1].content, 'refunded after approval');

    // The parent was answered long ago and is untouched by any of this: a
    // subagent's later life is its own.
    const parentMsgs = await AgentMessages
      .find({ sessionId: 's-park-approve' }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(
      parentMsgs.filter((m) => m.role === 'tool').length, 1,
      'the approval must not write a second result into the parent',
    );
  });

  it('answers subagent-failed, sanitized, when the child fails terminally', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runTurn } = await import('../server/loop');

    const broken: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        const e: any = new Error('invalid x-api-key sk-SECRET');
        e.status = 401;
        throw e;
      },
    };
    new Agent('sub-broken', {
      model: 'mock', instructions: '', tools: [], provider: broken, retry: { attempts: 1 },
    });

    await seedRoot('s-sub-fail', 'fail-parent');
    await runTurn('s-sub-fail', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'sub-broken', description: 'will fail' }],
      provider: await delegating('sub-broken'),
    });

    const row = (await AgentMessages
      .findOneAsync({ sessionId: 's-sub-fail', role: 'tool' } as any))!;
    assert.equal(row.error!.error, 'subagent-failed');
    assert.include(row.error!.reason!, 'The model request failed.');
    // The row is published. The raw provider message never reaches it — not
    // through the child's note, and not through the parent's tool result.
    assert.notInclude(JSON.stringify(row), 'SECRET');
    assert.isString(row.childSessionId, 'a failed child is still worth opening');

    const child = (await AgentSessions.findOneAsync(row.childSessionId!))!;
    assert.equal(child.phase, 'error', 'the child keeps its own terminal state');
    const note = await AgentMessages.findOneAsync(
      { sessionId: child._id, role: 'note', kind: 'error' } as any,
    );
    assert.isDefined(note, 'the child transcript records why, for whoever opens it');
  });

  it('answers unknown-agent for a name nothing registered, without a session', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    // Names resolve at DISPATCH, not at define(): agents register in file-load
    // order, so a define-time check would make correctness depend on it. The
    // price is this result — which the model can route around, unlike a throw.
    await seedRoot('s-sub-unknown', 'unknown-parent');
    await runTurn('s-sub-unknown', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'nobody-defined-this', description: 'nope' }],
      provider: await delegating('nobody-defined-this'),
    });

    const row = (await AgentMessages
      .findOneAsync({ sessionId: 's-sub-unknown', role: 'tool' } as any))!;
    assert.equal(row.error!.error, 'unknown-agent');
    assert.include(row.error!.reason!, 'nobody-defined-this');
    assert.isUndefined(row.childSessionId);
    assert.equal(await AgentSessions.find({}).countAsync(), 1, 'no child session was created');
  });

  it('spends one parent tool call; the child\'s own spend stays on the child', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    new Agent('sub-spender', {
      model: 'mock',
      instructions: '',
      pricing: { input: 1000, output: 1000 },
      tools: [{
        name: 'note', description: 'x', args: { type: 'object', properties: {} },
        run: async () => ({ ok: true }),
      }],
      provider: mockProvider((req) => {
        const done = req.messages.filter((m) => m.role === 'tool').length;
        return done < 2
          ? { toolCalls: [{ id: `n${done}`, name: 'note', args: {} }] }
          : { text: 'child finished' };
      }),
    });

    await seedRoot('s-sub-budget', 'budget-parent');
    await runTurn('s-sub-budget', {
      model: 'mock',
      system: '',
      tools: [{ subagent: 'sub-spender', description: 'does its own work' }],
      provider: await delegating('sub-spender'),
      pricing: { input: 1000, output: 1000 },
    });

    const parent = (await AgentSessions.findOneAsync('s-sub-budget'))!;
    const child = (await AgentSessions.findOneAsync({ 'parent.sessionId': 's-sub-budget' } as any))!;

    // Budgets COMPOSE, they do not merge. The parent paid for one tool call —
    // the generic dispatch accounting, nothing subagent-specific — while the
    // child's two calls and its whole cost accrued to the child's own document
    // under the child agent's own config. Which is how an operator bounds a
    // subagent-heavy parent: the parent's `toolCalls` caps how many
    // consultations, each child agent's own `spend` caps what one may cost.
    assert.equal(parent.budgetSpent.toolCalls, 1);
    assert.equal(child.budgetSpent.toolCalls, 2);
    assert.isAbove(child.usage.cost, 0, 'the child priced its own calls');

    // The parent's totals are exactly its OWN model calls, to the token: none
    // of the child's three iterations leaked upward.
    const parentAssistants = await AgentMessages
      .find({ sessionId: 's-sub-budget', role: 'assistant' } as any).fetchAsync();
    const ownOutput = parentAssistants.reduce((n, m) => n + (m.usage?.output ?? 0), 0);
    assert.equal(parentAssistants.length, 2);
    assert.equal(parent.usage.output, ownOutput);
    assert.isAbove(child.usage.output, 0);
  });

  it('excludes children from agent.sessions while agent.session still serves them', async () => {
    const { registerPublications } = await import('../server/publications');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    registerPublications();
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    const base = {
      userId: 'u1', phase: 'idle' as const, model: 'mock', nextSeq: 1,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    };
    await AgentSessions.insertAsync({ ...base, _id: 'pub-root', agent: 'pub-parent' } as any);
    await AgentSessions.insertAsync({
      ...base,
      _id: 'pub-kid',
      agent: 'pub-child',
      parent: { sessionId: 'pub-root', toolCallId: 'c1' },
      depth: 1,
    } as any);
    await AgentMessages.insertAsync({
      _id: 'pub-kid-msg', sessionId: 'pub-kid', seq: 0, role: 'user',
      content: 'do the sub-work', createdAt: new Date(),
    } as any);

    const list = (Meteor.server as any).publish_handlers[NAMES.pubSessions];
    // A session list is conversation-level: one turn's internal work has no
    // business at the top of it, sorted above what the user actually said.
    assert.deepEqual(
      (await list.call({ userId: 'u1' }, 'pub-parent').fetchAsync()).map((d: any) => d._id),
      ['pub-root'],
    );
    assert.deepEqual(
      await list.call({ userId: 'u1' }, 'pub-child').fetchAsync(), [],
      'a child must not be enumerable even under its own agent name',
    );

    // But it IS subscribable, with no special case in the publication: the
    // child inherited the parent's userId, so the ownership check authorizes
    // the same people. The `agent` argument is the CHILD's agent name.
    const one = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const cursors = await one.call({ userId: 'u1' }, 'pub-child', 'pub-kid');
    assert.equal(cursors.length, 3);
    assert.deepEqual(
      (await cursors[1].fetchAsync()).map((m: any) => m._id), ['pub-kid-msg'],
    );
    // And a stranger gets nothing, exactly as for a root session.
    assert.deepEqual(await one.call({ userId: 'u2' }, 'pub-child', 'pub-kid'), []);
  });

  it('resolves a subagent spec: default name, default args schema, lazy agent lookup', async () => {
    const { resolveTools, SUBAGENT_ARGS } = await import('../server/tools');
    const [plain, named] = resolveTools([
      { subagent: 'researcher', description: 'Ask the researcher' },
      {
        subagent: 'researcher',
        name: 'deep_research',
        description: 'Ask for the long version',
        args: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
        gate: 'ask',
      },
    ]);

    assert.equal(plain.kind, 'subagent');
    assert.equal(plain.name, 'researcher', 'the tool is named for the agent by default');
    assert.equal(plain.subagent, 'researcher');
    assert.equal(plain.gate, 'auto');
    assert.deepEqual(plain.args, SUBAGENT_ARGS);

    assert.equal(named.name, 'deep_research');
    assert.equal(named.subagent, 'researcher');
    assert.equal(named.gate, 'ask');
    assert.deepEqual(named.args, {
      type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'],
    });

    // Neither resolved to a registry entry: no agent by that name exists in
    // this process, and resolution deliberately does not care.
    const { getAgent } = await import('../server/registry');
    assert.isUndefined(getAgent('researcher'));
  });

  it('rejects a spec that mixes "subagent" with "run" or "method"', async () => {
    const { resolveTools } = await import('../server/tools');
    assert.throws(() => resolveTools([{
      subagent: 'researcher', description: 'x', run: async () => 'nope',
    } as any]));
    assert.throws(() => resolveTools([{
      subagent: 'researcher', description: 'x', method: 'orders.lookup',
    } as any]));
    assert.throws(() => resolveTools([{ subagent: '', description: 'x' } as any]));
  });

  it('serializes custom subagent arguments into the child\'s first message', async () => {
    const { subagentPrompt } = await import('../server/subagent');
    // The default schema's shape: prose in, prose out.
    assert.equal(subagentPrompt({ prompt: 'find the invoice' }), 'find the invoice');
    // A custom schema: the whole object, serialized. The child is an agent
    // reading a message, and this is at least an honest one.
    assert.equal(subagentPrompt({ topic: 'x', depth: 2 }), '{"topic":"x","depth":2}');
    assert.equal(subagentPrompt(undefined), 'null');
  });
});

describe('subagents: budgets and the live handle', () => {
  it('a child enforces its OWN toolCalls budget, independent of the parent', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');

    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    // The child wants to call its tool twice; its budget allows one.
    let childToolRuns = 0;
    new Agent('sub-budgeted', {
      model: 'mock',
      instructions: '',
      budget: { toolCalls: 1 },
      tools: [{
        name: 'dig', description: 'x', args: { type: 'object', properties: {} },
        run: async () => { childToolRuns += 1; return 'dug'; },
      }],
      provider: mockProvider((req) => {
        const digs = req.messages.filter((m) => m.role === 'tool').length;
        if (digs < 2) return { toolCalls: [{ id: `dig-${digs + 1}`, name: 'dig', args: {} }] };
        return { text: 'done digging' };
      }),
    });

    await AgentSessions.insertAsync({
      _id: 's-parent-budget', agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'pb-msg', sessionId: 's-parent-budget', seq: 0, role: 'user',
      content: 'delegate', createdAt: new Date(),
    } as any);

    const { mockProvider: mp } = await import('../server/providers/mock');
    await runTurn('s-parent-budget', {
      model: 'mock', system: '',
      tools: [{ subagent: 'sub-budgeted', description: 'delegate digging' }],
      provider: mp((req) => (
        req.messages.some((m) => m.role === 'tool')
          ? { text: 'delegated' }
          : { toolCalls: [{ id: 'd1', name: 'sub-budgeted', args: { prompt: 'dig twice' } }] }
      )),
    });

    // The child ran ONE dig, then its own budget note stopped it — the parent's
    // (absent) budget had nothing to do with it, and the parent turn completed.
    assert.equal(childToolRuns, 1, "the child's second tool call must be refused by ITS budget");
    const child = await AgentSessions.findOneAsync({ 'parent.sessionId': 's-parent-budget' } as any);
    assert.isDefined(child, 'the child session persists');
    const budgetNote = await AgentMessages.findOneAsync(
      { sessionId: child!._id, role: 'note', kind: 'budget' } as any,
    );
    assert.isDefined(budgetNote, "the stop is recorded in the CHILD's transcript");
    const parentRow = await AgentMessages.findOneAsync(
      { sessionId: 's-parent-budget', role: 'tool' } as any,
    );
    assert.isDefined(parentRow, 'the parent still gets a tool result');
  });

  it('announces a running child on the parent session, and clears it after', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');

    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    // The child pauses mid-stream, long enough for the test to observe the
    // parent's activeChild marker WHILE the dispatch is in flight — the only
    // client-reachable route to a child that is still streaming.
    let seenDuring: any = 'unread';
    new Agent('sub-slow', {
      model: 'mock',
      instructions: '',
      tools: [],
      provider: {
        async *stream() {
          yield { kind: 'text', chunk: 'thinking ' };
          seenDuring = (await AgentSessions.findOneAsync('s-parent-live'))?.activeChild ?? null;
          yield { kind: 'text', chunk: 'done' };
          yield { kind: 'done', usage: { input: 1, output: 2 } };
        },
      },
    });

    await AgentSessions.insertAsync({
      _id: 's-parent-live', agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'pl-msg', sessionId: 's-parent-live', seq: 0, role: 'user',
      content: 'go', createdAt: new Date(),
    } as any);

    await runTurn('s-parent-live', {
      model: 'mock', system: '',
      tools: [{ subagent: 'sub-slow', description: 'slow child' }],
      provider: mockProvider((req) => (
        req.messages.some((m) => m.role === 'tool')
          ? { text: 'ok' }
          : { toolCalls: [{ id: 'sc1', name: 'sub-slow', args: { prompt: 'think' } }] }
      )),
    });

    assert.isObject(seenDuring, 'activeChild must be visible WHILE the child streams');
    assert.equal(seenDuring.toolCallId, 'sc1');
    const parentAfter = await AgentSessions.findOneAsync('s-parent-live');
    assert.isUndefined(
      (parentAfter as any).activeChild,
      'the marker must not outlive the dispatch',
    );
    const row = await AgentMessages.findOneAsync(
      { sessionId: 's-parent-live', role: 'tool' } as any,
    );
    assert.equal((row as any).childSessionId, seenDuring.sessionId,
      'the durable handle and the live handle must name the same child');
  });

  /**
   * IDEMPOTENCY. A parent turn abandoned mid-batch is recovered by discarding
   * its assistant row and running the turn again, so the same subagent call is
   * DISPATCHED TWICE — and used to open a whole second child.
   *
   * Both tests below drive that through the lease-steal-mid-batch idiom the loop
   * suite uses: a two-call batch whose SECOND call steals the lease from inside
   * its own `run`, after the subagent's result row has already landed. The
   * abandonment discards the assistant and the whole batch's rows; the child
   * session survives, unclaimed, which is exactly the state the lookup exists
   * to recognize.
   */
  const stealOnce = (sessionId: string, state: { steals: number }) => ({
    name: 'thief',
    description: 'x',
    args: { type: 'object', properties: {} },
    run: async () => {
      const { AgentSessions } = await import('../common/collections');
      state.steals += 1;
      // ONCE. The second dispatch must be allowed to finish, or the recovery
      // this test is about would never commit anything.
      if (state.steals === 1) {
        await AgentSessions.updateAsync(sessionId, {
          $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60_000) } },
        } as any);
      }
      return { stole: state.steals };
    },
  });

  /** The parent's script: one batch of [subagent, thief], then a plain answer
   *  once the batch is answered. Branches on HISTORY, so the re-dispatch after
   *  a discard re-emits the identical batch — including the identical call ids,
   *  which is what a provider that reuses ids does and what the lookup keys on. */
  const batchProvider = async (childTool: string, state: { calls: number }) => {
    const { mockProvider } = await import('../server/providers/mock');
    return mockProvider((req) => {
      state.calls += 1;
      return req.messages.some((m) => m.role === 'tool')
        ? { text: 'wrapped up' }
        : {
          toolCalls: [
            { id: 'c1', name: childTool, args: { prompt: 'look it up' } },
            { id: 'c2', name: 'thief', args: {} },
          ],
        };
    });
  };

  it('reuses the finished child when recovery re-dispatches an abandoned batch', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    const child = { calls: 0 };
    new Agent('sub-idem', {
      model: 'mock',
      instructions: '',
      tools: [],
      provider: mockProvider(() => { child.calls += 1; return { text: 'the answer' }; }),
    });

    await seedRoot('s-idem', 'sub-idem-parent');
    const thief = { steals: 0 };
    const parent = { calls: 0 };
    const config = {
      model: 'mock',
      system: '',
      tools: [
        { subagent: 'sub-idem', description: 'ask the child' },
        stealOnce('s-idem', thief),
      ],
      provider: await batchProvider('sub-idem', parent),
    };

    await runTurn('s-idem', config as any);

    // The abandonment: nothing of the turn survives except the child itself.
    assert.equal(thief.steals, 1, 'the steal must actually have fired');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-idem', role: 'assistant' }).countAsync(), 0,
      'the abandoned assistant row must be discarded',
    );
    assert.equal(
      await AgentMessages.find({ sessionId: 's-idem', role: 'tool' }).countAsync(), 0,
      "and the batch's already-landed result with it — which is what makes the child unclaimed",
    );
    const firstChild = (await AgentSessions.findOneAsync(
      { 'parent.sessionId': 's-idem' } as any,
    ))!;
    assert.isDefined(firstChild, 'the child session outlives the turn that opened it');
    assert.equal(child.calls, 1, 'the child ran exactly once');

    // Recovery. The stolen lease is released (the steal is what drove the
    // abandonment, not a claim this test means to keep contesting) and the turn
    // is simply run again — recovery is calling `runTurn` again, nothing more.
    await AgentSessions.updateAsync('s-idem', { $unset: { lease: 1 } } as any);
    await runTurn('s-idem', config as any);

    assert.equal(
      await AgentSessions.find({ 'parent.sessionId': 's-idem' } as any).countAsync(), 1,
      'a re-dispatched subagent call must NOT open a second child session',
    );
    assert.equal(
      child.calls, 1,
      'and must not call the provider again — the finished child already has the answer',
    );

    const row = (await AgentMessages.findOneAsync(
      { sessionId: 's-idem', role: 'tool', toolCallId: 'c1' } as any,
    ))!;
    assert.isDefined(row, 'the recovered turn answers the subagent call');
    assert.isUndefined(row.error, 'a reused finished child answers exactly as a fresh one would');
    assert.equal(row.content, JSON.stringify('the answer'));
    assert.equal(row.childSessionId, firstChild._id, 'and names the child that actually ran');
    const last = await AgentMessages.findOneAsync(
      { sessionId: 's-idem', role: 'assistant' } as any, { sort: { seq: -1 } },
    );
    assert.equal((last as any).content, 'wrapped up', 'the recovered turn runs to completion');
    assert.equal(
      parent.calls, 3,
      'the PARENT still pays for its own turns (one abandoned batch, one re-dispatched batch, '
      + 'one wrap-up) — idempotency is about the child, not about free model calls',
    );
  });

  it('reuses a PARKED child on re-dispatch, naming the session already open', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    const child = { calls: 0, ran: [] as string[] };
    new Agent('sub-idem-park', {
      model: 'mock',
      instructions: '',
      tools: [{
        name: 'refund',
        description: 'x',
        gate: 'ask' as const,
        args: { type: 'object', properties: {} },
        run: async () => { child.ran.push('refund'); return { did: 'refund' }; },
      }],
      provider: mockProvider(() => {
        child.calls += 1;
        return { toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] };
      }),
    });

    await seedRoot('s-idem-park', 'sub-idem-park-parent');
    const thief = { steals: 0 };
    const parent = { calls: 0 };
    const config = {
      model: 'mock',
      system: '',
      tools: [
        { subagent: 'sub-idem-park', description: 'ask the child' },
        stealOnce('s-idem-park', thief),
      ],
      provider: await batchProvider('sub-idem-park', parent),
    };

    await runTurn('s-idem-park', config as any);
    const parked = (await AgentSessions.findOneAsync(
      { 'parent.sessionId': 's-idem-park' } as any,
    ))!;
    assert.equal(parked.phase, 'awaiting', 'the child parked on its ask-gate');
    assert.equal(child.calls, 1);

    await AgentSessions.updateAsync('s-idem-park', { $unset: { lease: 1 } } as any);
    await runTurn('s-idem-park', config as any);

    assert.equal(
      await AgentSessions.find({ 'parent.sessionId': 's-idem-park' } as any).countAsync(), 1,
      'a re-dispatch must not open a SECOND session parked on the same question',
    );
    assert.equal(child.calls, 1, 'and must not re-run the child to re-discover the park');
    assert.deepEqual(child.ran, [], 'the gated tool is still waiting for a human');

    const row = (await AgentMessages.findOneAsync(
      { sessionId: 's-idem-park', role: 'tool', toolCallId: 'c1' } as any,
    ))!;
    assert.equal(row.error?.error, 'subagent-parked');
    assert.equal(
      row.childSessionId, parked._id,
      'the parent must be pointed at the child that is ALREADY open — approving that one '
      + 'is what completes the call',
    );
    const stillParked = (await AgentSessions.findOneAsync(parked._id))!;
    assert.equal(stillParked.phase, 'awaiting', 'reuse must not disturb the parked child');
  });
});
