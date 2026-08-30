import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Agent } from '../server/agent';
import { AgentMessages, AgentSessions } from '../common/collections';
import { NAMES } from '../common/names';
import { mockProvider } from '../server/providers/mock';
import {
  commitUserMessage, MAX_PENDING_INPUTS, MAX_USER_MESSAGE_BYTES,
  reconcileUserMessageCommits, UserMessageReservations,
} from '../server/transcript';

const reset = async (): Promise<void> => {
  await UserMessageReservations.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentSessions.removeAsync({});
};

const seedSession = async (
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  const now = new Date();
  await AgentSessions.insertAsync({
    _id: sessionId,
    agent: 'transcript-test-agent',
    userId: 'transcript-owner',
    phase: 'idle',
    model: 'mock',
    nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any);
};

const errorCode = (reason: PromiseRejectedResult): unknown => (
  reason.reason as { error?: unknown }
)?.error;

const rawMessageInsertPrototype = (): object => {
  let holder = Object.getPrototypeOf(AgentMessages.rawCollection());
  while (holder && !Object.prototype.hasOwnProperty.call(holder, 'insertOne')) {
    holder = Object.getPrototypeOf(holder);
  }
  if (!holder) throw new Error('Mongo raw Collection has no insertOne implementation');
  return holder;
};

describe('Transcript Commit Module Interface', () => {
  beforeEach(reset);
  afterEach(reset);

  it('commits one complete user Message and charges its sequence and Turn atomically', async () => {
    const sessionId = 'transcript-normal';
    await seedSession(sessionId, { phase: 'stopped', relay: 4 });
    const draft = {
      content: 'please inspect the attachment',
      attachments: [{
        id: 'transcript-ref', name: 'evidence.txt', contentType: 'text/plain', size: 8,
      }],
      from: { participant: 'h:transcript-owner', name: 'Owner' },
      to: 'm:transcript-test-agent',
    };

    const committed = await commitUserMessage({
      sessionId, draft, turnLimit: 3, commitKey: 'transcript-normal-key',
    });

    assert.equal(committed.seq, 0);
    assert.isFalse(committed.replayed);
    const row = (await AgentMessages.findOneAsync(committed.messageId))!;
    assert.deepInclude(row, {
      _id: committed.messageId,
      sessionId,
      seq: 0,
      role: 'user',
      ...draft,
    });
    assert.instanceOf(row.createdAt, Date);

    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 1);
    assert.equal(session.budgetSpent.turns, 1);
    assert.equal(session.phase, 'idle', 'a human commit makes a stopped Session answerable');
    assert.equal(session.relay, 0, 'a human commit resets the Relay hop count');
    assert.lengthOf((session as any).pendingInputs, 1);
    assert.deepInclude((session as any).pendingInputs[0], {
      messageId: committed.messageId, seq: committed.seq,
    }, 'the committed input remains a durable Activation cause until answered');
  });

  it('rolls back a failed Message insert, then reconciles the reservation exactly once', async () => {
    const sessionId = 'transcript-allocation-crash';
    const commitKey = 'transcript-allocation-crash-key';
    await seedSession(sessionId);

    const rawPrototype = rawMessageInsertPrototype() as any;
    const descriptor = Object.getOwnPropertyDescriptor(rawPrototype, 'insertOne')!;
    const original = descriptor.value;
    let injected = false;
    let messageId: string | undefined;
    Object.defineProperty(rawPrototype, 'insertOne', {
      ...descriptor,
      value: async function injectedInsert(doc: any, ...rest: any[]) {
      if (!injected && doc.sessionId === sessionId && doc.role === 'user') {
        injected = true;
        messageId = doc._id;
        throw new Error('injected Transcript Message insert failure');
      }
        return original.call(this, doc, ...rest);
      },
    });
    try {
      await commitUserMessage({
        sessionId,
        commitKey,
        draft: { content: 'recover this exact input' },
      });
      assert.fail('the injected Message failure must reject the first commit');
    } catch (error) {
      assert.include(String(error), 'injected Transcript Message insert failure');
    } finally {
      Object.defineProperty(rawPrototype, 'insertOne', descriptor);
    }
    assert.isTrue(injected);
    assert.isString(messageId);
    if (!messageId) return;

    const rolledBack = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(rolledBack.nextSeq, 0, 'the failed transaction must not allocate a sequence');
    assert.equal(
      rolledBack.budgetSpent.turns, 0,
      'the failed transaction must not charge a Turn',
    );
    assert.isUndefined(
      (rolledBack as any).pendingInputs,
      'the failed transaction must not publish wake evidence without its Message',
    );
    assert.isUndefined(await AgentMessages.findOneAsync(messageId));
    assert.deepInclude(
      await UserMessageReservations.findOneAsync(messageId),
      { _id: messageId, sessionId, draft: { content: 'recover this exact input' } },
      'the durable reservation is the only state recovery needs after rollback',
    );

    assert.isTrue(await reconcileUserMessageCommits(sessionId));
    assert.isTrue(await reconcileUserMessageCommits(sessionId), 'reconciliation is idempotent');
    const recovered = (await AgentMessages.findOneAsync(messageId))!;
    assert.deepInclude(recovered, {
      _id: messageId,
      sessionId,
      seq: 0,
      role: 'user',
      content: 'recover this exact input',
    });
    const reconciled = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(reconciled.nextSeq, 1, 'recovery allocates exactly once');
    assert.equal(reconciled.budgetSpent.turns, 1, 'recovery charges exactly once');
    assert.deepInclude((reconciled as any).pendingInputs[0], { messageId, seq: 0 });
    assert.equal(await AgentMessages.find({ _id: messageId }).countAsync(), 1);
    assert.isUndefined(
      await UserMessageReservations.findOneAsync(messageId),
      'a materialized reservation is removed in the same commit',
    );
  });

  it('bounds UTF-8 message bytes before reserving or charging a Turn', async () => {
    const sessionId = 'transcript-message-bytes';
    await seedSession(sessionId);
    const exact = 'é'.repeat(MAX_USER_MESSAGE_BYTES / 2);

    const accepted = await commitUserMessage({
      sessionId,
      commitKey: 'transcript-message-exact-limit',
      draft: { content: exact },
    });
    assert.isDefined(await AgentMessages.findOneAsync(accepted.messageId));

    let rejected: unknown;
    try {
      await commitUserMessage({
        sessionId,
        commitKey: 'transcript-message-over-limit',
        draft: { content: `${exact}a` },
      });
    } catch (error) {
      rejected = error;
    }
    assert.equal((rejected as { error?: unknown })?.error, 'message-too-large');
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 1);
    assert.equal(session.budgetSpent.turns, 1);
    assert.equal(await AgentMessages.find({ sessionId, role: 'user' }).countAsync(), 1);
    assert.equal(await UserMessageReservations.find({ sessionId }).countAsync(), 0);
  });

  it('refuses a send when the durable unanswered-input queue is full', async () => {
    const sessionId = 'transcript-queue-full';
    const now = new Date();
    await seedSession(sessionId, {
      nextSeq: MAX_PENDING_INPUTS,
      budgetSpent: { turns: MAX_PENDING_INPUTS, toolCalls: 0 },
      pendingInputs: Array.from({ length: MAX_PENDING_INPUTS }, (_, seq) => ({
        messageId: `standing-message-${seq}`, seq, at: now,
      })),
    });

    let rejected: unknown;
    try {
      await commitUserMessage({
        sessionId,
        commitKey: 'transcript-queue-full-key',
        draft: { content: 'this must wait for queue capacity' },
      });
    } catch (error) {
      rejected = error;
    }

    assert.equal((rejected as { error?: unknown })?.error, 'queue-full');
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, MAX_PENDING_INPUTS);
    assert.equal(session.budgetSpent.turns, MAX_PENDING_INPUTS);
    assert.lengthOf((session as any).pendingInputs, MAX_PENDING_INPUTS);
    assert.equal(await AgentMessages.find({ sessionId }).countAsync(), 0);
    assert.equal(await UserMessageReservations.find({ sessionId }).countAsync(), 0);
  });

  it('gives concurrent distinct commits unique consecutive sequences and exact budget charges', async () => {
    const sessionId = 'transcript-concurrent';
    await seedSession(sessionId);
    const count = 12;

    const committed = await Promise.all(Array.from({ length: count }, (_, i) => (
      commitUserMessage({
        sessionId,
        commitKey: `transcript-concurrent-${i}`,
        draft: { content: `message-${i}` },
      })
    )));

    assert.deepEqual(
      committed.map((result) => result.seq).sort((a, b) => a - b),
      Array.from({ length: count }, (_, i) => i),
    );
    assert.equal(new Set(committed.map((result) => result.messageId)).size, count);
    assert.isTrue(committed.every((result) => !result.replayed));

    const rows = await AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(rows.map((row) => row.seq), Array.from({ length: count }, (_, i) => i));
    for (let i = 0; i < count; i += 1) {
      const result = committed[i];
      assert.equal(
        rows.find((row) => row._id === result.messageId)?.content,
        `message-${i}`,
        'the sequence winner must retain its own draft',
      );
    }
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, count);
    assert.equal(session.budgetSpent.turns, count);
    assert.deepEqual(
      (session as any).pendingInputs.map((input: { seq: number }) => input.seq)
        .sort((a: number, b: number) => a - b),
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it('admits exactly one concurrent commit at the final Turn-budget slot', async () => {
    const sessionId = 'transcript-budget-edge';
    await seedSession(sessionId, { budgetSpent: { turns: 2, toolCalls: 0 } });

    const settled = await Promise.allSettled([
      commitUserMessage({
        sessionId, commitKey: 'transcript-budget-a',
        draft: { content: 'budget contender a' }, turnLimit: 3,
      }),
      commitUserMessage({
        sessionId, commitKey: 'transcript-budget-b',
        draft: { content: 'budget contender b' }, turnLimit: 3,
      }),
    ]);

    const accepted = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commitUserMessage>>> =>
        result.status === 'fulfilled',
    );
    const refused = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.lengthOf(accepted, 1);
    assert.lengthOf(refused, 1);
    assert.equal(errorCode(refused[0]), 'budget-exhausted');
    assert.equal(await AgentMessages.find({ sessionId, role: 'user' }).countAsync(), 1);

    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 1);
    assert.equal(session.budgetSpent.turns, 3);
    assert.lengthOf((session as any).pendingInputs, 1);
    assert.equal((session as any).pendingInputs[0].messageId, accepted[0].value.messageId);
  });

  it('replays one commit key deterministically without another Message, sequence, or charge', async () => {
    const sessionId = 'transcript-replay';
    await seedSession(sessionId);
    const command = {
      sessionId,
      commitKey: 'transcript-replay-key',
      draft: { content: 'retry-safe input' },
    };

    const first = await commitUserMessage(command);
    const replayed = await Promise.all(Array.from(
      { length: 8 }, () => commitUserMessage(command),
    ));

    assert.isFalse(first.replayed);
    replayed.forEach((result) => {
      assert.equal(result.messageId, first.messageId);
      assert.equal(result.seq, first.seq);
      assert.isTrue(result.replayed);
    });
    assert.equal(await AgentMessages.find({ sessionId, role: 'user' }).countAsync(), 1);
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 1);
    assert.equal(session.budgetSpent.turns, 1);
    assert.lengthOf((session as any).pendingInputs, 1);
    assert.deepInclude((session as any).pendingInputs[0], {
      messageId: first.messageId,
      seq: first.seq,
    });
  });

  it('rejects a reused commit key with a different draft without overwriting either state', async () => {
    const sessionId = 'transcript-conflict';
    await seedSession(sessionId);
    const first = await commitUserMessage({
      sessionId,
      commitKey: 'transcript-conflict-key',
      draft: { content: 'original content' },
    });

    let conflict: unknown;
    try {
      await commitUserMessage({
        sessionId,
        commitKey: 'transcript-conflict-key',
        draft: { content: 'different content' },
      });
    } catch (error) {
      conflict = error;
    }

    assert.equal((conflict as { error?: unknown })?.error, 'commit-conflict');
    const [row] = await AgentMessages.find({ sessionId, role: 'user' }).fetchAsync();
    assert.equal(row._id, first.messageId);
    assert.equal(row.content, 'original content');
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 1);
    assert.equal(session.budgetSpent.turns, 1);
    assert.lengthOf((session as any).pendingInputs, 1);
    assert.deepInclude((session as any).pendingInputs[0], {
      messageId: first.messageId,
      seq: first.seq,
    });
  });

  it('keeps legacy send, and makes send/contribute retry keys idempotent', async () => {
    const sessionId = 'transcript-method-idempotency';
    const agentName = 'transcript-method-idempotency-agent';
    // eslint-disable-next-line no-new
    new Agent(agentName, {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'must remain parked' })),
    });
    await seedSession(sessionId, { agent: agentName, phase: 'awaiting' });
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];

    assert.equal(
      await send.call(
        { userId: 'transcript-owner' }, agentName, sessionId, 'legacy three arguments',
      ),
      sessionId,
    );
    const commitKey = 'transcript-method-retry-key';
    await send.call(
      { userId: 'transcript-owner' }, agentName, sessionId, 'retry-safe method input', commitKey,
    );
    await send.call(
      { userId: 'transcript-owner' }, agentName, sessionId, 'retry-safe method input', commitKey,
    );

    const contribute = (Meteor.server as any).method_handlers[NAMES.mContribute];
    const contributionKey = 'transcript-crew-note-key';
    await contribute.call(
      { userId: 'transcript-owner' }, agentName, sessionId, 'human-only context', contributionKey,
    );
    await contribute.call(
      { userId: 'transcript-owner' }, agentName, sessionId, 'human-only context', contributionKey,
    );

    const rows = await AgentMessages.find(
      { sessionId, role: 'user' }, { sort: { seq: 1 } },
    ).fetchAsync();
    assert.deepEqual(rows.map((row) => row.content), [
      'legacy three arguments', 'retry-safe method input', 'human-only context',
    ]);
    assert.notEqual(rows[1]._id, commitKey, 'the public retry key must not become a document id');
    assert.equal(rows[2].kind, 'crew-note');
    assert.deepEqual(rows.map((row) => row.source), [
      { kind: 'desktop' }, { kind: 'desktop' }, { kind: 'desktop' },
    ], 'browser write methods stamp their trusted surface server-side');
    const session = (await AgentSessions.findOneAsync(sessionId))!;
    assert.equal(session.nextSeq, 3);
    assert.equal(session.budgetSpent.turns, 2);
    assert.lengthOf((session as any).pendingInputs, 2);
  });
});
