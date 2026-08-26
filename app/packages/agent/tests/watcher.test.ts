import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

/** Deferred work (the turn a watcher wakes, the resume a verdict schedules)
 *  exposes no promise to await, so every wait here is bounded by a deadline and
 *  fails loudly rather than hanging the suite. */
const waitFor = async (cond: () => Promise<boolean>, label: string, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

const settle = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The turn is FINISHED — not merely visible.
 *
 * A committed assistant row is not the end of a turn. The loop still removes
 * the message's deltas, checks for a user message that interjected mid-stream,
 * and only THEN, in its `finally`, writes `phase: 'idle'` and releases the
 * lease: four Mongo round trips separate "the answer is in the transcript" from
 * "the session is back at rest". A wait that ends at the first and then asserts
 * the second is asserting on state that has not been written yet.
 *
 * That is the one-run flake two agents saw here and neither could pin. It is a
 * TEST race, not a watcher one — measured with a sampler that read the session
 * the instant the row appeared: `streaming`, lease held, twelve times out of
 * twelve. The 25ms poll below usually lands outside the window and occasionally
 * lands inside it, which is exactly the reported shape (one run in many, always
 * on an orphan-claim path, never reproducible on demand).
 *
 * So every wait ends on the TERMINAL state, and the assertions that follow
 * re-state what was waited for rather than racing it.
 */
const finished = async (sessionId: string, assistants: number): Promise<boolean> => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const n = await AgentMessages.find({ sessionId, role: 'assistant' }).countAsync();
  if (n !== assistants) return false;
  const doc = await AgentSessions.findOneAsync(sessionId);
  return !!doc && doc.phase === 'idle' && !doc.lease;
};

const reset = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
};

/** One session plus the user message a turn has something to answer. Does NOT
 *  wipe: several tests seed two sessions and assert the sweep touches one. */
const seedSession = async (
  sessionId: string, agent: string, overrides: Record<string, unknown> = {},
) => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as any);
  await AgentMessages.insertAsync({
    _id: `${sessionId}-u`, sessionId, seq: 0, role: 'user',
    content: 'refund please', createdAt: new Date(),
  } as any);
};

/**
 * A CHILD session, as a subagent dispatch leaves one: lineage on the document
 * and nothing else. Backdated by default, because the sweep deliberately
 * ignores a child younger than one grace period (a live dispatch writes the
 * child before it writes the parent's `activeChild` marker).
 */
const seedChild = async (
  childId: string, parentId: string, agent: string,
  overrides: Record<string, unknown> = {},
) => {
  const { AgentSessions } = await import('../common/collections');
  await AgentSessions.insertAsync({
    _id: childId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    parent: { sessionId: parentId, toolCallId: 'tc1' },
    depth: 1,
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(),
    ...overrides,
  } as any);
};

/** How many `orphan-child` notes a parent transcript carries. */
const noteCount = async (parentId: string): Promise<number> => {
  const { AgentMessages } = await import('../common/collections');
  return AgentMessages.find(
    { sessionId: parentId, role: 'note', kind: 'orphan-child' } as any,
  ).countAsync();
};

/**
 * Park a real session on an ask-gated tool, exactly as a run does.
 *
 * Registration is load-bearing: the watcher resumes through the REGISTRY
 * config (`getAgent` + `deferTurn`), so the tools and provider it finds have to
 * be the same objects this fixture parked with. The provider answers the first
 * call with the gated tool call and the second with plain text, so a resumed
 * turn that reaches the think loop leaves a SECOND assistant row — the signal
 * that the model saw the tool result.
 */
const parkFixture = async (
  sessionId: string, agentName: string, extra: Record<string, unknown> = {},
) => {
  const { Agent } = await import('../server/agent');
  const { mockProvider } = await import('../server/providers/mock');
  const { runTurn } = await import('../server/loop');

  const state = { ran: [] as string[], providerCalls: 0 };
  const provider = mockProvider(() => {
    state.providerCalls += 1;
    return state.providerCalls === 1
      ? { toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] }
      : { text: 'all done' };
  });
  const tools = [{
    name: 'refund',
    description: 'x',
    gate: 'ask' as const,
    args: { type: 'object', properties: {} },
    run: async () => { state.ran.push('refund'); return { did: 'refund' }; },
  }];

  new Agent(agentName, {
    model: 'mock', instructions: '', tools, provider, ...extra,
  } as any);
  await seedSession(sessionId, agentName);
  await runTurn(sessionId, { model: 'mock', system: '', tools, provider });
  return state;
};

describe('orphan-claim watcher', () => {
  it('claims an orphan the observer sees enter an active phase', async function () {
    this.timeout(60000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    new Agent('watch-observer', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });
    // Seeded 'idle', so the session is OUTSIDE the observer's selector until the
    // update below — and the sweep interval is longer than this whole test, so
    // only the observer can be responsible for what happens next.
    await seedSession('s-obs', 'watch-observer', {
      lease: { serverId: 'dead-server', until: new Date(Date.now() - 60_000) },
    });

    const w = startWatcher({ sweepMs: 600_000 });
    try {
      // Let observeChangesAsync resolve first, so the change below is what the
      // observer reacts to rather than its initial fetch.
      await settle(250);
      await AgentSessions.updateAsync('s-obs', {
        $set: { phase: 'streaming', updatedAt: new Date() },
      } as any);

      // Generous: with no oplog available the live query degrades to
      // poll-and-diff, whose default interval is 10s.
      await waitFor(
        () => finished('s-obs', 1),
        'the observer to claim the orphan and finish its turn',
        40000,
      );

      const msg = await AgentMessages.findOneAsync({ sessionId: 's-obs', role: 'assistant' });
      assert.equal(msg!.content, 'recovered', 'the recovered turn runs the registry config');
      const doc = (await AgentSessions.findOneAsync('s-obs'))!;
      assert.equal(doc.phase, 'idle', 'a recovered turn ends in a normal terminal phase');
      assert.isUndefined(doc.lease, 'and releases the lease it claimed');
    } finally {
      await w.stop();
    }
  });

  it('claims an orphan whose lease expires with no document change', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    new Agent('watch-sweep', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'swept up' })),
    });
    // The belt, not the braces. This session is in an active phase with a LIVE
    // lease when the watcher starts — the observer's initial pass sees a healthy
    // run — and the lease then expires with no write of any kind. There is
    // nothing for an observer to observe, which is exactly why the sweep exists.
    await seedSession('s-sweep', 'watch-sweep', {
      phase: 'streaming',
      lease: { serverId: 'dead-server', until: new Date(Date.now() + 1200) },
    });

    const w = startWatcher({ sweepMs: 120 });
    try {
      await waitFor(
        () => finished('s-sweep', 1),
        'the sweep to notice the expired lease',
      );
      const msg = await AgentMessages.findOneAsync({ sessionId: 's-sweep', role: 'assistant' });
      assert.equal(msg!.content, 'swept up');
      const doc = (await AgentSessions.findOneAsync('s-sweep'))!;
      assert.equal(doc.phase, 'idle');
      assert.isUndefined(doc.lease);
    } finally {
      await w.stop();
    }
  });

  it('denies an approval nobody answered in time, and the model sees it', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    const state = await parkFixture('s-timeout', 'watch-timeout', {
      budget: { approval: 150 },
    });
    const parked = (await AgentSessions.findOneAsync('s-timeout'))!;
    assert.equal(parked.phase, 'awaiting');
    const requestedAt = parked.pending!.requestedAt!;

    // An agent with NO budget.approval: the same sweep must leave its parked
    // request standing however old it is. An unset timeout means "wait for a
    // human", which is the right default for a request a person is expected to
    // see.
    new Agent('watch-noapproval', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'never runs' })),
    });
    await seedSession('s-forever', 'watch-noapproval', {
      phase: 'awaiting',
      pending: {
        toolCallId: 'g9', name: 'refund', args: {},
        requestedAt: new Date(Date.now() - 600_000),
      },
    });

    const w = startWatcher({ sweepMs: 60 });
    try {
      await waitFor(
        () => finished('s-timeout', 2),
        'the timed-out turn to resume and finish',
      );

      assert.deepEqual(state.ran, [], 'a timed-out tool must never run');

      const row = await AgentMessages.findOneAsync({
        sessionId: 's-timeout', role: 'tool', toolCallId: 'g1',
      } as any);
      assert.isDefined(row, 'the parked call must be answered, not dropped');
      assert.equal(row!.error?.error, 'denied');
      assert.equal(row!.error?.reason, 'approval timed out');

      const note = (await AgentMessages.findOneAsync({
        sessionId: 's-timeout', role: 'note', kind: 'approval',
      } as any))!;
      assert.isFalse(note.approved);
      assert.isNull(note.by, 'nobody decided a timeout');
      assert.equal(note.reason, 'approval timed out');
      assert.isTrue(note.timedOut, 'the audit row must distinguish a timeout from a refusal');
      assert.isAtLeast(
        note.createdAt.getTime() - requestedAt.getTime(), 150,
        'the denial must not land before budget.approval has elapsed',
      );

      // The model saw the refusal and answered anyway — the whole point of
      // answering a denial rather than dropping it.
      const msgs = await AgentMessages
        .find({ sessionId: 's-timeout', role: 'assistant' }, { sort: { seq: 1 } }).fetchAsync();
      assert.equal(msgs[1].content, 'all done');

      const doc = (await AgentSessions.findOneAsync('s-timeout'))!;
      assert.equal(doc.phase, 'idle');
      assert.isUndefined(doc.pending, 'the verdict is spent once its call is answered');

      const untouched = (await AgentSessions.findOneAsync('s-forever'))!;
      assert.equal(untouched.phase, 'awaiting', 'no budget.approval means no timeout');
      assert.isUndefined(untouched.pending!.verdict);
    } finally {
      await w.stop();
    }
  });

  it('lets two watchers claim one orphan exactly once', async function () {
    this.timeout(40000);
    const { AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    let calls = 0;
    const slow: Provider = {
      async *stream() {
        calls += 1;
        // Hold the turn open across several sweep ticks of BOTH watchers, so the
        // loser meets a session that is leased and running rather than one that
        // is already finished. (A turn completing between two ticks is a real
        // multi-server window — the phase is 'idle' by then, so the second
        // watcher no longer sees an orphan at all — but it is not the
        // exactly-once property under test here.)
        await new Promise((r) => { setTimeout(r, 600); });
        yield { kind: 'text', chunk: 'once' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    new Agent('watch-race', {
      model: 'mock', instructions: '', tools: [], provider: slow,
    });
    await seedSession('s-race', 'watch-race', {
      phase: 'streaming',
      lease: { serverId: 'dead-server', until: new Date(Date.now() - 60_000) },
    });

    const a = startWatcher({ sweepMs: 80 });
    const b = startWatcher({ sweepMs: 80 });
    try {
      await waitFor(
        async () => (await AgentMessages
          .find({ sessionId: 's-race', role: 'assistant' }).countAsync()) === 1,
        'one of the two watchers to recover the orphan',
      );
      // Both watchers keep sweeping while this settles; a second claim would
      // show up as a second assistant row.
      await settle(500);
      assert.equal(
        await AgentMessages.find({ sessionId: 's-race', role: 'assistant' }).countAsync(), 1,
        'two watchers must produce exactly one recovered turn',
      );
      assert.equal(calls, 1, 'and exactly one provider call');
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('lets two watchers time out one approval exactly once', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    const state = await parkFixture('s-race-timeout', 'watch-race-timeout', {
      budget: { approval: 100 },
    });

    const a = startWatcher({ sweepMs: 60 });
    const b = startWatcher({ sweepMs: 60 });
    try {
      await waitFor(
        () => finished('s-race-timeout', 2),
        'the timed-out turn to resume and finish',
      );
      await settle(400);

      // The verdict's conditional write is the single winner, so two sweeps
      // racing it leave one note and one answered call.
      assert.equal(
        await AgentMessages.find({
          sessionId: 's-race-timeout', role: 'note', kind: 'approval',
        } as any).countAsync(), 1,
        'exactly one timeout verdict may be recorded',
      );
      assert.equal(
        await AgentMessages.find({
          sessionId: 's-race-timeout', role: 'tool', toolCallId: 'g1',
        } as any).countAsync(), 1,
        'and the parked call is answered exactly once',
      );
      assert.equal(
        await AgentMessages.find({
          sessionId: 's-race-timeout', role: 'assistant',
        }).countAsync(), 2,
        'and no extra turn runs behind the resume',
      );
      assert.deepEqual(state.ran, [], 'a timed-out tool must never run');
      assert.isUndefined((await AgentSessions.findOneAsync('s-race-timeout'))!.pending);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('skips a session whose agent is no longer registered, with a warning', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    // The sessions collection outlives any deployment's defineAgent calls: a
    // renamed or retired agent is an ordinary consequence of shipping, and must
    // not crash the sweep that would have recovered every other session.
    await seedSession('s-unregistered', 'watch-agent-that-never-existed', {
      phase: 'streaming',
      lease: { serverId: 'dead-server', until: new Date(Date.now() - 60_000) },
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const w = startWatcher({ sweepMs: 60 });
    try {
      await waitFor(
        async () => warnings.some((m) => m.includes('unregistered agent')),
        'a warning about the skipped session',
      );
      await settle(200);
      assert.equal(
        await AgentMessages.find({ sessionId: 's-unregistered', role: 'assistant' }).countAsync(),
        0, 'nothing may run for an agent that no longer exists',
      );
      const doc = (await AgentSessions.findOneAsync('s-unregistered'))!;
      assert.equal(doc.phase, 'streaming', 'a skipped session is left exactly as found');
      assert.isTrue(
        warnings.some((m) => m.includes('watch-agent-that-never-existed')),
        'the warning must name the agent so an operator can fix it',
      );
      assert.notInclude(warnings.join('\n'), 's-unregistered',
        'bearer-capability session ids must not enter logs');
    } finally {
      console.warn = originalWarn;
      await w.stop();
    }
  });

  it('wakes a session whose verdict a dead resume never consumed', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    const state = await parkFixture('s-standing', 'watch-standing');

    // The liveness gap the loop's wake self-check cannot close: a verdict
    // written exactly as `agent.approve` writes it, with no surviving process
    // behind the resume it deferred. `updatedAt` backdated past the grace period
    // is what marks it as DROPPED rather than in flight — the sweep must never
    // race a legitimate resume that is milliseconds from starting.
    await AgentSessions.updateAsync('s-standing', {
      $set: {
        'pending.verdict': 'approved',
        'pending.by': 'u1',
        phase: 'idle',
        updatedAt: new Date(Date.now() - 30_000),
      },
    } as any);

    const w = startWatcher({ sweepMs: 60, verdictGraceMs: 1000 });
    try {
      await waitFor(
        () => finished('s-standing', 2),
        'the sweep to pick up the dropped wake',
      );
      assert.deepEqual(state.ran, ['refund'], 'the approved tool must finally run — once');
      const row = await AgentMessages.findOneAsync({
        sessionId: 's-standing', role: 'tool', toolCallId: 'g1',
      } as any);
      assert.isDefined(row, 'the approved call must be answered');
      assert.isUndefined(row!.error);
      const doc = (await AgentSessions.findOneAsync('s-standing'))!;
      assert.isUndefined(doc.pending, 'the verdict is spent once consumed');
      assert.equal(doc.phase, 'idle');
    } finally {
      await w.stop();
    }
  });
});

/**
 * §4.3 case 4. A subagent dispatch abandoned between creating the child and
 * committing its result leaves a real session — with a transcript, a cost and
 * possibly an answer — that NO published document points at. The parent's tool
 * row is the only durable handle and it never landed; `activeChild` was the
 * live one and the dispatch cleared it (or the process that held it died).
 *
 * The repair is a pointer, not a turn: one structured note in the PARENT
 * transcript, which is published, so a client holding the conversation can find
 * and subscribe to the child again.
 */
describe('orphaned-child re-link', () => {
  it('re-links an orphaned child into the parent transcript, exactly once', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    await seedSession('p-orphan', 'relink-parent');
    await seedChild('c-orphan', 'p-orphan', 'relink-child');

    const w = startWatcher({ sweepMs: 60, relinkGraceMs: 50 });
    try {
      await waitFor(
        async () => (await noteCount('p-orphan')) === 1,
        'the sweep to re-link the orphaned child',
      );
      // Many more sweeps run in here. The note is its own idempotence guard —
      // it carries `childSessionId`, which is exactly what the sweep reads to
      // decide the child is already reachable.
      await settle(400);
      assert.equal(await noteCount('p-orphan'), 1, 'a later sweep must not write a second note');

      const note = (await AgentMessages.findOneAsync({
        sessionId: 'p-orphan', kind: 'orphan-child',
      } as any))!;
      assert.equal(note.role, 'note');
      assert.equal(note.childSessionId, 'c-orphan', 'the note IS the handle');
      assert.equal(note.childAgent, 'relink-child', 'and a subscription needs the agent name too');
      assert.equal(note.reason, 'recovered');
      assert.isUndefined(note.toolCallId, 'a note answers no tool call');
      // Seq allocation is the atomic one: the parent's user message holds 0,
      // this takes 1, and `nextSeq` moved with it.
      assert.equal(note.seq, 1);
      assert.equal((await AgentSessions.findOneAsync('p-orphan'))!.nextSeq, 2);

      const child = await AgentSessions.findOneAsync('c-orphan');
      assert.isDefined(child, 'the sweep repairs reachability and touches nothing else');
      assert.equal(child!.phase, 'idle');
    } finally {
      await w.stop();
    }
  });

  it('leaves a claimed child alone', async function () {
    this.timeout(40000);
    const { AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    await seedSession('p-claimed', 'relink-parent');
    await seedChild('c-claimed', 'p-claimed', 'relink-child');
    // The row a completed dispatch commits. The child is reachable from the
    // transcript already, so a note would be a duplicate pointer in a
    // conversation a person reads.
    await AgentMessages.insertAsync({
      _id: 'claim-row', sessionId: 'p-claimed', seq: 1, role: 'tool',
      toolCallId: 'tc1', content: 'the child answered',
      childSessionId: 'c-claimed', createdAt: new Date(),
    } as any);

    // The CONTROL orphan: its note is how this test knows a sweep actually ran.
    // Asserting the absence of something without proving the thing that would
    // have written it executed is how a green test hides a broken feature.
    await seedSession('p-control', 'relink-parent');
    await seedChild('c-control', 'p-control', 'relink-child');

    const w = startWatcher({ sweepMs: 60, relinkGraceMs: 50 });
    try {
      await waitFor(
        async () => (await noteCount('p-control')) === 1,
        'the sweep to re-link the control orphan',
      );
      await settle(300);
      assert.equal(await noteCount('p-claimed'), 0, 'a claimed child needs no pointer');
    } finally {
      await w.stop();
    }
  });

  it('does not re-link a child whose dispatch is still in flight', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    // Again a control orphan, because the interesting assertion is a negative
    // one and it has to be made WHILE the live child is unclaimed — after the
    // dispatch returns, the tool row would explain the absence by itself.
    await seedSession('p-control-live', 'relink-parent');
    await seedChild('c-control-live', 'p-control-live', 'relink-child');

    let notesDuring: number | null = null;
    new Agent('relink-slow', {
      model: 'mock',
      instructions: '',
      tools: [],
      provider: {
        async *stream() {
          yield { kind: 'text', chunk: 'thinking ' };
          // Hold the dispatch open until a sweep has demonstrably COMPLETED
          // (the control note is the receipt), by which time this child is
          // older than the grace period and carries no tool row — a candidate
          // in every respect except the parent's `activeChild` marker.
          const deadline = Date.now() + 15000;
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            if (await noteCount('p-control-live') === 1) break;
            if (Date.now() > deadline) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, 25); });
          }
          notesDuring = await noteCount('p-live');
          yield { kind: 'text', chunk: 'done' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      },
    } as any);
    await seedSession('p-live', 'relink-parent');

    const w = startWatcher({ sweepMs: 60, relinkGraceMs: 50 });
    try {
      await runTurn('p-live', {
        model: 'mock',
        system: '',
        tools: [{ subagent: 'relink-slow', description: 'slow child' }],
        provider: mockProvider((req) => (
          req.messages.some((m) => m.role === 'tool')
            ? { text: 'ok' }
            : { toolCalls: [{ id: 'lc1', name: 'relink-slow', args: { prompt: 'think' } }] }
        )),
      });

      assert.equal(notesDuring, 0, 'a child the parent is actively dispatching is not orphaned');
      await settle(300);
      assert.equal(await noteCount('p-live'), 0, 'and the tool row is its durable pointer');
      const row = (await AgentMessages.findOneAsync(
        { sessionId: 'p-live', role: 'tool' } as any,
      ))!;
      assert.isDefined(row.childSessionId);
      assert.isUndefined(
        (await AgentSessions.findOneAsync('p-live'))!.activeChild,
        'the live marker does not outlive the dispatch',
      );
    } finally {
      await w.stop();
    }
  });

  it('warns about a child whose parent is gone, and leaves the child standing', async function () {
    this.timeout(40000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');

    await reset();
    // Nothing in the harness produces this today (see `warnParentlessOnce`),
    // but a sweep must not throw on it and must not decide, on its own
    // authority, that unreachable data is garbage.
    await seedChild('c-no-parent', 'p-vanished', 'relink-child');
    await seedSession('p-control-gone', 'relink-parent');
    await seedChild('c-control-gone', 'p-control-gone', 'relink-child');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const w = startWatcher({ sweepMs: 60, relinkGraceMs: 50 });
    try {
      await waitFor(
        async () => warnings.some((m) => m.includes('child session names a parent')),
        'a warning about the parentless child',
      );
      await waitFor(
        async () => (await noteCount('p-control-gone')) === 1,
        'the same sweep to keep re-linking everything else',
      );
      await settle(300);
      assert.isDefined(
        await AgentSessions.findOneAsync('c-no-parent'),
        'a sweep never deletes session data',
      );
      assert.equal(
        await AgentMessages.find({ kind: 'orphan-child', childSessionId: 'c-no-parent' } as any)
          .countAsync(),
        0, 'and there is no transcript to write the pointer into',
      );
      assert.equal(
        warnings.filter((m) => m.includes('child session names a parent')).length, 1,
        'one warning per process, not one per sweep',
      );
      assert.notInclude(warnings.join('\n'), 'c-no-parent');
      assert.notInclude(warnings.join('\n'), 'p-vanished');
    } finally {
      console.warn = originalWarn;
      await w.stop();
    }
  });
});
