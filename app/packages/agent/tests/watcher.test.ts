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
        async () => (await AgentMessages
          .find({ sessionId: 's-obs', role: 'assistant' }).countAsync()) === 1,
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
        async () => (await AgentMessages
          .find({ sessionId: 's-sweep', role: 'assistant' }).countAsync()) === 1,
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
        async () => (await AgentMessages
          .find({ sessionId: 's-timeout', role: 'assistant' }).countAsync()) === 2,
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
        async () => (await AgentMessages
          .find({ sessionId: 's-race-timeout', role: 'assistant' }).countAsync()) === 2,
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
        async () => warnings.some((m) => m.includes('s-unregistered')),
        'a warning naming the skipped session',
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
        async () => (await AgentMessages
          .find({ sessionId: 's-standing', role: 'assistant' }).countAsync()) === 2,
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
