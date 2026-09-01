import { assert } from 'chai';
import { Agent } from '../server/agent';
import {
  activate, installTurnRunner, requestSystemTurn, startActivationRecovery,
} from '../server/activation';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import { assistantAnswers } from '../common/participants';
import { mockProvider } from '../server/providers/mock';
import type { Provider } from '../server/providers/types';
import { beginSessionOperation } from '../server/session-operations';
import { commitUserMessage, UserMessageReservations } from '../server/transcript';

const waitFor = async (
  condition: () => Promise<boolean>, label: string, timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await condition()) return;
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
};

const settle = (ms = 150): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const rawMessageInsertPrototype = (): object => {
  let holder = Object.getPrototypeOf(AgentMessages.rawCollection());
  while (holder && !Object.prototype.hasOwnProperty.call(holder, 'insertOne')) {
    holder = Object.getPrototypeOf(holder);
  }
  if (!holder) throw new Error('Mongo raw Collection has no insertOne implementation');
  return holder;
};

const reset = async (): Promise<void> => {
  await UserMessageReservations.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentSessions.removeAsync({});
};

const seedInput = async (
  sessionId: string,
  agent: string,
  overrides: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): Promise<void> => {
  const now = new Date();
  await AgentSessions.insertAsync({
    _id: sessionId,
    agent,
    userId: 'activation-owner',
    phase: 'idle',
    model: 'mock',
    nextSeq: 1,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 1, toolCalls: 0 },
    pendingInput: { token: `${sessionId}-input`, at: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any);
  await AgentMessages.insertAsync({
    _id: `${sessionId}-user`,
    sessionId,
    seq: 0,
    role: 'user',
    content: 'please continue',
    createdAt: now,
    ...message,
  } as any);
};

const seedSessionForAddressedInputs = async (
  sessionId: string, joinedAt: Date,
): Promise<void> => {
  await AgentSessions.insertAsync({
    _id: sessionId,
    agent: 'activation-older-addressee',
    userId: 'activation-owner',
    phase: 'idle',
    model: 'mock',
    nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    participants: [
      {
        id: 'h:activation-owner', kind: 'human', role: 'owner',
        userId: 'activation-owner', displayName: 'Owner', joinedAt,
      },
      {
        id: 'm:activation-older-addressee', kind: 'model', role: 'member',
        agent: 'activation-older-addressee', displayName: 'Older', joinedAt,
      },
      {
        id: 'm:activation-newer-addressee', kind: 'model', role: 'member',
        agent: 'activation-newer-addressee', displayName: 'Newer', joinedAt,
      },
    ],
    createdAt: joinedAt,
    updatedAt: joinedAt,
  } as any);
};

const finished = async (sessionId: string, assistants = 1): Promise<boolean> => {
  const count = await AgentMessages.find({
    sessionId, role: 'assistant',
  }).countAsync();
  if (count !== assistants) return false;
  const session = await AgentSessions.findOneAsync(sessionId);
  return !!session
    && session.phase === 'idle'
    && !session.lease
    && !session.pendingInput;
};

describe('Activation Module Interface', () => {
  beforeEach(reset);
  afterEach(reset);

  it('recovers a durable pending input without caller-supplied Agent or Turn state', async function () {
    this.timeout(30_000);
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-pending-input', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'recovered from durable input' };
      }),
    });
    await seedInput('activation-input-session', 'activation-pending-input');

    activate('activation-input-session');

    await waitFor(
      () => finished('activation-input-session'),
      'the durable input to complete one Turn',
    );
    const [answer] = await AgentMessages.find(
      { sessionId: 'activation-input-session', role: 'assistant' },
    ).fetchAsync();
    assert.equal(answer.content, 'recovered from durable input');
    assert.equal(calls, 1);
  });

  it('does not activate an input before its Message transaction commits', async function () {
    this.timeout(30_000);
    const { sendToSession } = await import('../server/methods');
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-input-write-race', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'the reserved message survived' };
      }),
    });
    const now = new Date();
    await AgentSessions.insertAsync({
      _id: 'activation-input-write-race-session',
      agent: 'activation-input-write-race', userId: 'activation-owner',
      phase: 'idle', model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: now, updatedAt: now,
    } as any);

    const rawPrototype = rawMessageInsertPrototype() as any;
    const descriptor = Object.getOwnPropertyDescriptor(rawPrototype, 'insertOne')!;
    const original = descriptor.value;
    let uncommittedStateStayedInvisible = false;
    let firstInsert = true;
    let releaseCompetingInsert!: () => void;
    const competingInsertReleased = new Promise<void>((resolve) => {
      releaseCompetingInsert = resolve;
    });
    Object.defineProperty(rawPrototype, 'insertOne', {
      ...descriptor,
      value: async function delayedInsert(doc: any, ...rest: any[]) {
        if (doc.sessionId === 'activation-input-write-race-session' && doc.role === 'user') {
          if (firstInsert) {
            firstInsert = false;
            activate(doc.sessionId);
            await settle(150);
            const session = await AgentSessions.findOneAsync(doc.sessionId);
            uncommittedStateStayedInvisible = !(session?.pendingInputs?.some(
              (pending) => pending.messageId === doc._id,
            ) ?? false) && calls === 0;
            releaseCompetingInsert();
          } else {
            await competingInsertReleased;
          }
        }
        return original.call(this, doc, ...rest);
      },
    });
    try {
      await sendToSession(
        'activation-input-write-race',
        'activation-input-write-race-session',
        'arriving between allocation and activation',
        'activation-owner',
      );
      await waitFor(
        () => finished('activation-input-write-race-session'),
        'the reserved Message to be answered',
      );
    } finally {
      releaseCompetingInsert();
      Object.defineProperty(rawPrototype, 'insertOne', descriptor);
    }

    assert.isTrue(
      uncommittedStateStayedInvisible,
      'Activation must see neither wake link nor Message before their transaction commits',
    );
    assert.equal(calls, 1);
  });

  it('keeps an old missing pendingInput while its writer operation is live', async function () {
    this.timeout(30_000);
    const sessionId = 'activation-input-live-operation';
    const now = new Date();
    await AgentSessions.insertAsync({
      _id: sessionId,
      agent: 'activation-input-live-operation-agent',
      userId: 'activation-owner',
      phase: 'idle',
      model: 'mock',
      nextSeq: 1,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 1, toolCalls: 0 },
      pendingInput: {
        token: 'activation-input-live-operation-token',
        // Deliberately older than Activation's missing-Message grace. The
        // operation, rather than elapsed wall time, proves the writer lives.
        at: new Date(now.getTime() - 60_000),
        messageId: 'activation-input-live-operation-message',
      },
      createdAt: now,
      updatedAt: now,
    } as any);

    const operation = await beginSessionOperation(sessionId);
    assert.isNotNull(operation);
    if (!operation) return;

    let survivedWhileLive = false;
    try {
      activate(sessionId);
      await settle(200);
      survivedWhileLive = (await AgentSessions.findOneAsync(sessionId))
        ?.pendingInput?.messageId === 'activation-input-live-operation-message';
    } finally {
      await operation.close();
    }

    // Once the writer operation is gone, recovery may collect the genuinely
    // abandoned reservation rather than sweeping it forever.
    activate(sessionId);
    await waitFor(
      async () => !(await AgentSessions.findOneAsync(sessionId))?.pendingInput,
      'the abandoned pendingInput marker to clear after its operation closes',
    );
    assert.isTrue(
      survivedWhileLive,
      'elapsed grace must not clear a reservation while its Session operation is live',
    );
  });

  it('coalesces repeated local activation into one Turn', async function () {
    this.timeout(30_000);
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-coalesced', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'one answer' };
      }),
    });
    await seedInput('activation-coalesced-session', 'activation-coalesced');

    for (let i = 0; i < 20; i += 1) activate('activation-coalesced-session');

    await waitFor(
      () => finished('activation-coalesced-session'),
      'the coalesced Turn to finish',
    );
    await settle();
    assert.equal(calls, 1);
    assert.equal(
      await AgentMessages.find({
        sessionId: 'activation-coalesced-session', role: 'assistant',
      }).countAsync(),
      1,
    );
  });

  it('retries the durable cause when an exact Session revision invalidates its first claim', async function () {
    this.timeout(30_000);
    const sessionId = 'activation-exact-revision';
    const now = new Date();
    let runnerAttempts = 0;
    let revisionAdvanced = false;
    let providerCalls = 0;
    let toolRuns = 0;

    // eslint-disable-next-line no-new
    new Agent('activation-exact-revision-agent', {
      model: 'mock',
      instructions: '',
      tools: [{
        name: 'refund',
        description: 'refund the request',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { toolRuns += 1; return { refunded: true }; },
      }],
      provider: mockProvider(() => {
        providerCalls += 1;
        return { text: 'revision retry completed' };
      }),
    });
    await AgentSessions.insertAsync({
      _id: sessionId,
      agent: 'activation-exact-revision-agent',
      userId: 'activation-owner',
      phase: 'idle',
      model: 'mock',
      nextSeq: 2,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 1, toolCalls: 0 },
      pending: {
        toolCallId: 'revision-call',
        name: 'refund',
        args: {},
        requestedAt: now,
        verdict: 'approved',
        by: 'activation-owner',
        agent: 'activation-exact-revision-agent',
        wakeToken: 'activation-exact-revision-wake',
      },
      createdAt: now,
      updatedAt: now,
    } as any);
    await AgentMessages.insertAsync({
      _id: 'activation-exact-revision-user',
      sessionId,
      seq: 0,
      role: 'user',
      content: 'please refund this',
      createdAt: now,
    } as any);
    await AgentMessages.insertAsync({
      _id: 'activation-exact-revision-assistant',
      sessionId,
      seq: 1,
      role: 'assistant',
      toolCalls: [{ id: 'revision-call', name: 'refund', args: {} }],
      createdAt: now,
    } as any);

    const { runTurn } = await import('../server/loop');
    const restoreRunner = installTurnRunner(async (id, config, expected) => {
      if (id !== sessionId) return runTurn(id, config, expected);
      runnerAttempts += 1;
      if (runnerAttempts === 1) {
        // Mirror the verdict writer's audit allocation after Activation has
        // already snapshotted its exact Lease predicate. The coalesced nudge
        // lands while this slot is running, before the stale claim returns.
        const advanced = await AgentSessions.updateAsync(
          { _id: sessionId, nextSeq: 2 },
          {
            $inc: { nextSeq: 1 },
            $set: { updatedAt: new Date(now.getTime() + 1) },
          } as any,
        );
        revisionAdvanced = advanced === 1;
        await AgentMessages.insertAsync({
          _id: 'activation-exact-revision-approval',
          sessionId,
          seq: 2,
          role: 'note',
          kind: 'approval',
          approved: true,
          by: 'activation-owner',
          createdAt: new Date(),
        } as any);
        activate(sessionId);
      }
      return runTurn(id, config, expected);
    });

    try {
      activate(sessionId);
      await waitFor(
        async () => {
          const final = await AgentMessages.findOneAsync({
            sessionId, role: 'assistant', content: 'revision retry completed',
          });
          const session = await AgentSessions.findOneAsync(sessionId);
          return !!final && session?.phase === 'idle' && !session.lease && !session.pending;
        },
        'Activation to retry the revised exact snapshot',
      );
      await settle();
    } finally {
      restoreRunner();
    }

    assert.isTrue(revisionAdvanced, 'the first attempt must have been made stale');
    assert.equal(runnerAttempts, 2, 'the revised snapshot gets one fresh attempt');
    assert.equal(toolRuns, 1, 'the parked call runs exactly once');
    assert.equal(providerCalls, 1, 'only the successful retry reaches the provider');
    assert.isDefined(await AgentMessages.findOneAsync({
      sessionId, role: 'tool', toolCallId: 'revision-call',
    } as any));
  });

  it('recovers active Sessions after an expired or missing Lease', async function () {
    this.timeout(30_000);
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-lease-recovery', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'lease recovered' };
      }),
    });
    await seedInput('activation-expired-lease', 'activation-lease-recovery', {
      phase: 'streaming',
      lease: {
        serverId: 'departed-server',
        until: new Date(Date.now() - 60_000),
      },
    });
    await seedInput('activation-missing-lease', 'activation-lease-recovery', {
      phase: 'streaming',
    });

    const recovery = startActivationRecovery({ sweepMs: 25, graceMs: 0 });
    try {
      await waitFor(
        async () => (await finished('activation-expired-lease'))
          && (await finished('activation-missing-lease')),
        'both orphaned Turns to recover',
      );
    } finally {
      await recovery.stop();
    }

    assert.equal(calls, 2);
    assert.equal(
      await AgentMessages.find({
        sessionId: { $in: ['activation-expired-lease', 'activation-missing-lease'] },
        role: 'assistant',
      }).countAsync(),
      2,
    );
  });

  it('chooses the addressed Agent when system and input activation are both durable', async function () {
    this.timeout(30_000);
    let primaryCalls = 0;
    let colleagueCalls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-primary', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        primaryCalls += 1;
        return { text: 'primary answer' };
      }),
    });
    // eslint-disable-next-line no-new
    new Agent('activation-colleague', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        colleagueCalls += 1;
        return { text: 'colleague answer' };
      }),
    });
    const joinedAt = new Date();
    await seedInput('activation-precedence-session', 'activation-primary', {
      participants: [
        {
          id: 'h:activation-owner', kind: 'human', role: 'owner',
          userId: 'activation-owner', displayName: 'Owner', joinedAt,
        },
        {
          id: 'm:activation-primary', kind: 'model', role: 'member',
          agent: 'activation-primary', displayName: 'Primary', joinedAt,
        },
        {
          id: 'm:activation-colleague', kind: 'model', role: 'member',
          agent: 'activation-colleague', displayName: 'Colleague', joinedAt,
        },
      ],
    }, {
      content: '@activation-colleague please review this',
      to: 'm:activation-colleague',
      from: { participant: 'h:activation-owner', name: 'Owner' },
    });

    const result = await requestSystemTurn(
      'activation-precedence-session',
      'also run the scheduled review',
      { key: 'activation-slot', source: 'scheduler' },
    );
    assert.isTrue(result.ok);
    if (result.ok) assert.isTrue(result.ran);

    await waitFor(
      () => finished('activation-precedence-session'),
      'the addressed Agent to consume the durable causes',
    );
    const [answer] = await AgentMessages.find(
      { sessionId: 'activation-precedence-session', role: 'assistant' },
    ).fetchAsync();
    assert.equal(primaryCalls, 0);
    assert.equal(colleagueCalls, 1);
    assert.equal(answer.content, 'colleague answer');
    assert.equal(answer.from?.participant, 'm:activation-colleague');
    assert.isUndefined(
      (await AgentSessions.findOneAsync('activation-precedence-session'))?.pendingSystem,
    );
  });

  it('answers the newest addressed input first without dropping an older model wake', async function () {
    this.timeout(30_000);
    const sessionId = 'activation-two-addressed-inputs';
    let releaseOlder!: () => void;
    let enterOlder!: () => void;
    const olderReleased = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const olderEntered = new Promise<void>((resolve) => { enterOlder = resolve; });
    const order: string[] = [];
    const olderProvider: Provider = {
      async *stream() {
        order.push('older');
        enterOlder();
        await olderReleased;
        yield { kind: 'text', chunk: 'older input answered' };
        yield { kind: 'done', usage: { input: 1, output: 3 } };
      },
    };
    // eslint-disable-next-line no-new
    new Agent('activation-older-addressee', {
      model: 'mock', instructions: '', tools: [], provider: olderProvider,
    });
    // eslint-disable-next-line no-new
    new Agent('activation-newer-addressee', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        order.push('newer');
        return { text: 'newer input answered' };
      }),
    });
    const joinedAt = new Date();
    await seedSessionForAddressedInputs(sessionId, joinedAt);
    const older = await commitUserMessage({
      sessionId,
      commitKey: 'activation-older-addressed-key',
      draft: {
        content: '@activation-older-addressee handle the first item',
        to: 'm:activation-older-addressee',
        from: { participant: 'h:activation-owner', name: 'Owner' },
      },
    });
    const newer = await commitUserMessage({
      sessionId,
      commitKey: 'activation-newer-addressed-key',
      draft: {
        content: '@activation-newer-addressee handle the second item',
        to: 'm:activation-newer-addressee',
        from: { participant: 'h:activation-owner', name: 'Owner' },
      },
    });

    activate(sessionId);
    await olderEntered;
    try {
      assert.deepEqual(order, ['newer', 'older']);
      assert.isDefined(await AgentMessages.findOneAsync({
        sessionId, role: 'assistant', content: 'newer input answered',
      }));
      const between = (await AgentSessions.findOneAsync(sessionId))!;
      assert.isTrue(
        (between as any).pendingInputs.some(
          (link: { messageId: string }) => link.messageId === older.messageId,
        ),
        'answering the newer addressee must leave the older model wake durable',
      );
      assert.isFalse(
        (between as any).pendingInputs.some(
          (link: { messageId: string }) => link.messageId === newer.messageId,
        ),
        'the answered newer link must stop consuming the bounded input queue',
      );
      assert.notEqual(older.messageId, newer.messageId);
    } finally {
      releaseOlder();
    }

    await waitFor(
      async () => {
        const session = await AgentSessions.findOneAsync(sessionId);
        return (await AgentMessages.find({ sessionId, role: 'assistant' }).countAsync()) === 2
          && session?.phase === 'idle' && !session.lease
          && (session.pendingInputs?.length ?? 0) === 0;
      },
      'both addressed inputs to finish in priority order',
    );
    assert.deepEqual(order, ['newer', 'older']);
  });

  it('keeps every Activation entry inert after Session Lifecycle fencing', async function () {
    this.timeout(30_000);
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-fenced', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'must not run' };
      }),
    });
    await seedInput('activation-fenced-session', 'activation-fenced', {
      erasingAt: new Date(),
      phase: 'stopped',
    });

    const system = await requestSystemTurn(
      'activation-fenced-session', 'must not be scheduled',
    );
    assert.deepEqual(system, { ok: false, reason: 'no-session' });

    activate('activation-fenced-session');
    activate('activation-fenced-session');
    const recovery = startActivationRecovery({ sweepMs: 20, graceMs: 0 });
    try {
      await settle(200);
    } finally {
      await recovery.stop();
    }

    assert.equal(calls, 0);
    assert.equal(
      await AgentMessages.find({
        sessionId: 'activation-fenced-session', role: 'assistant',
      }).countAsync(),
      0,
    );
    assert.isDefined(
      (await AgentSessions.findOneAsync('activation-fenced-session'))?.pendingInput,
      'the lifecycle owner, not Activation, decides when fenced state is purged',
    );
  });

  it('treats an ancestor lifecycle fence as a fence on a child Turn', async function () {
    this.timeout(30_000);
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-fenced-child', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'must not run below an erasing root' };
      }),
    });
    const now = new Date();
    await AgentSessions.insertAsync({
      _id: 'activation-fenced-root', agent: 'activation-fenced-child',
      userId: 'activation-owner', phase: 'stopped', model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      erasingAt: now, createdAt: now, updatedAt: now,
    } as any);
    await seedInput('activation-fenced-child-session', 'activation-fenced-child', {
      parent: { sessionId: 'activation-fenced-root', toolCallId: 'child-call' },
      depth: 1,
    });

    activate('activation-fenced-child-session');
    const system = await requestSystemTurn(
      'activation-fenced-child-session', 'must not be parked below the fence',
    );
    const recovery = startActivationRecovery({ sweepMs: 20, graceMs: 0 });
    try {
      await settle(250);
    } finally {
      await recovery.stop();
    }

    assert.deepEqual(system, { ok: false, reason: 'no-session' });
    assert.equal(calls, 0);
    assert.equal(await AgentMessages.find({
      sessionId: 'activation-fenced-child-session', role: 'assistant',
    }).countAsync(), 0);
    const child = (await AgentSessions.findOneAsync('activation-fenced-child-session'))!;
    assert.isUndefined(child.lease);
    assert.isUndefined(child.pendingSystem);
  });

  it('does not materialize child System work below an ancestor lifecycle fence', async function () {
    this.timeout(30_000);
    const { consumeStandingIntent } = await import('../server/methods');
    let calls = 0;
    // eslint-disable-next-line no-new
    new Agent('activation-fenced-system-child', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => {
        calls += 1;
        return { text: 'must not run below an erasing root' };
      }),
    });
    const now = new Date();
    await AgentSessions.insertAsync({
      _id: 'activation-fenced-system-root',
      agent: 'activation-fenced-system-child',
      userId: 'activation-owner', phase: 'stopped', model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      erasingAt: now, createdAt: now, updatedAt: now,
    } as any);

    const seedChildIntent = async (sessionId: string): Promise<void> => {
      await AgentSessions.insertAsync({
        _id: sessionId,
        agent: 'activation-fenced-system-child',
        userId: 'activation-owner', phase: 'idle', model: 'mock', nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        parent: {
          sessionId: 'activation-fenced-system-root',
          toolCallId: `${sessionId}-call`,
        },
        depth: 1,
        pendingSystem: {
          prompt: 'must remain unmaterialized below the root fence',
          token: `${sessionId}-system-token`,
          at: now,
        },
        createdAt: now,
        updatedAt: now,
      } as any);
    };

    await seedChildIntent('activation-fenced-system-automatic');
    await seedChildIntent('activation-fenced-system-compatibility');

    activate('activation-fenced-system-automatic');
    const compatibilityConsumed = await consumeStandingIntent(
      'activation-fenced-system-compatibility',
    );
    await settle(250);

    assert.isFalse(
      compatibilityConsumed,
      'the compatibility consumer must cross the same ancestor lifecycle fence',
    );
    assert.equal(calls, 0);
    assert.equal(
      await AgentMessages.find({
        sessionId: {
          $in: [
            'activation-fenced-system-automatic',
            'activation-fenced-system-compatibility',
          ],
        },
        role: 'system',
      }).countAsync(),
      0,
      'neither Activation nor its compatibility consumer may materialize a System row',
    );
    for (const sessionId of [
      'activation-fenced-system-automatic',
      'activation-fenced-system-compatibility',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const child = await AgentSessions.findOneAsync(sessionId);
      assert.isUndefined(child?.lease);
      assert.isDefined(child?.pendingSystem);
    }
  });

  it('never clears a replacement System intent with the older Turn token', async function () {
    this.timeout(30_000);
    const { SYSTEM_INTENT_TTL_MS } = await import('../server/system-turn');
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let calls = 0;
    const provider: Provider = {
      async *stream() {
        calls += 1;
        const call = calls;
        if (call === 1) {
          enteredFirst();
          await released;
        }
        const answer = call === 1 ? 'obsolete answer' : 'fresh answer';
        for (const chunk of answer) yield { kind: 'text', chunk };
        yield { kind: 'done', usage: { input: 1, output: answer.length } };
      },
    };
    // eslint-disable-next-line no-new
    new Agent('activation-system-token', {
      model: 'mock', instructions: '', tools: [], provider,
    });
    const now = new Date();
    await AgentSessions.insertAsync({
      _id: 'activation-system-token-session', agent: 'activation-system-token',
      userId: 'activation-owner', phase: 'idle', model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: now, updatedAt: now,
    } as any);

    const first = await requestSystemTurn(
      'activation-system-token-session', 'old scheduled work', { key: 'old' },
    );
    assert.isTrue(first.ok);
    await entered;
    await AgentSessions.updateAsync('activation-system-token-session', {
      $set: {
        'pendingSystem.at': new Date(Date.now() - SYSTEM_INTENT_TTL_MS - 1000),
      },
    } as any);
    const replacement = await requestSystemTurn(
      'activation-system-token-session', 'new scheduled work', { key: 'new' },
    );
    assert.deepEqual(replacement, { ok: true, ran: false, parked: true });
    releaseFirst();

    await waitFor(
      () => finished('activation-system-token-session'),
      'the replacement System Turn to finish',
    );
    const assistants = await AgentMessages.find({
      sessionId: 'activation-system-token-session', role: 'assistant',
    }).fetchAsync();
    assert.lengthOf(assistants, 1);
    assert.equal(assistants[0].content, 'fresh answer');
    assert.equal(calls, 2);
    const done = (await AgentSessions.findOneAsync('activation-system-token-session'))!;
    assert.isUndefined(done.pendingSystem);
    assert.equal(done.budgetSpent.systemTurns, 1);
  });
});

describe('assistantAnswers()', () => {
  it('answers a user row its context watermark reaches', () => {
    assert.isTrue(assistantAnswers({ seq: 5, answeredThrough: 4 }, 4));
    assert.isTrue(assistantAnswers({ seq: 5, answeredThrough: 4 }, 3));
  });

  it('keeps a mid-stream interjection owed even though the assistant committed above it', () => {
    // The interjection shape: user seq 4 lands while streaming, and the blind
    // reply commits at seq 5 having seen only through seq 3. The legacy
    // comparison (5 >= 4) would call this answered.
    assert.isFalse(assistantAnswers({ seq: 5, answeredThrough: 3 }, 4));
    // A zero watermark is a present watermark — the first turn's reply saw
    // only the seq-0 trigger, so it does not answer a seq-1 interjection.
    assert.isFalse(assistantAnswers({ seq: 2, answeredThrough: 0 }, 1));
    assert.isTrue(assistantAnswers({ seq: 1, answeredThrough: 0 }, 0));
  });

  it('falls back to the legacy commit-order comparison when no watermark exists', () => {
    assert.isTrue(assistantAnswers({ seq: 5 }, 4));
    assert.isTrue(assistantAnswers({ seq: 4 }, 4));
    assert.isFalse(assistantAnswers({ seq: 3 }, 4));
  });
});
