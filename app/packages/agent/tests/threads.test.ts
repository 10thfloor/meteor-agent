import { assert } from 'chai';
import type { Provider, ProviderRequest } from '../server/providers/types';

/** Message threads: a thread is a fork of its parent at one message that runs
 *  beside the parent. Waits are bounded by deadlines (the turns a send
 *  schedules expose no promise). */
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

const settle = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

const rejectsWith = async (fn: () => Promise<unknown>, code: string, label: string) => {
  try {
    await fn();
  } catch (e: any) {
    assert.equal(e?.error, code, `${label}: ${e?.reason ?? e?.message}`);
    return;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
};

const reset = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  const { UserMessageReservations } = await import('../server/transcript');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await UserMessageReservations.removeAsync({});
};

const roster = (agent: string) => {
  const joinedAt = new Date();
  return [
    { id: 'h:u1', kind: 'human', role: 'owner', userId: 'u1', displayName: 'Ola', joinedAt },
    { id: 'h:u2', kind: 'human', role: 'member', userId: 'u2', displayName: 'Mia', joinedAt },
    { id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt },
  ];
};

/** A parent session and its transcript. Row `_id`s are `<sessionId>-m<seq>`. */
const seed = async (
  sessionId: string, agent: string,
  rows: Array<Record<string, any>>, session: Record<string, any> = {},
) => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: rows.length ? rows[rows.length - 1].seq + 1 : 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
    ...session,
  } as any);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await AgentMessages.insertAsync({
      _id: `${sessionId}-m${r.seq}`, sessionId, createdAt: new Date(), ...r,
    } as any);
  }
};

const CHAT = [
  { seq: 0, role: 'user', content: 'first question' },
  { seq: 1, role: 'assistant', content: 'first answer' },
  { seq: 2, role: 'user', content: 'second question' },
  { seq: 3, role: 'assistant', content: 'second answer' },
];

/** Registers `name` with a recording provider; `reply` may be async. */
const defineAgent = async (
  name: string,
  reply: (req: ProviderRequest) => any = () => ({ text: 'ok' }),
  extra: Record<string, unknown> = {},
) => {
  const { Agent } = await import('../server/agent');
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async *stream(req) {
      requests.push(req);
      const turn = await reply(req);
      for (const ch of (turn.text ?? '')) yield { kind: 'text', chunk: ch };
      yield {
        kind: 'done', toolCalls: turn.toolCalls,
        usage: { input: 10, output: (turn.text ?? '').length },
      };
    },
  };
  new Agent(name, {
    model: 'mock', instructions: 'x', tools: [], provider, ...extra,
  } as any);
  return requests;
};

const method = async (name: 'mThread' | 'mSend' | 'mFork') => {
  const { NAMES } = await import('../common/names');
  const { Meteor } = await import('meteor/meteor');
  return (Meteor.server as any).method_handlers[NAMES[name]];
};

const publication = async (name: 'pubThreads' | 'pubSessions') => {
  const { NAMES } = await import('../common/names');
  const { Meteor } = await import('meteor/meteor');
  return (Meteor.server as any).publish_handlers[NAMES[name]];
};

const answered = async (sessionId: string, afterSeq: number) => {
  const { AgentMessages, AgentSessions } = await import('../common/collections');
  const reply = await AgentMessages.findOneAsync({
    sessionId, role: 'assistant', seq: { $gt: afterSeq },
  });
  const doc = await AgentSessions.findOneAsync(sessionId);
  return !!reply && doc?.phase === 'idle' && !doc.lease;
};

const lastContent = (req: ProviderRequest) => {
  const last = req.messages[req.messages.length - 1];
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
};

describe('message threads', () => {
  beforeEach(reset);

  describe('anchoring', () => {
    it('cuts exactly at a user row and records the thread', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineAgent('thr-a');
      await seed('ta-1', 'thr-a', CHAT, { title: 'Topic' });

      const thread = await method('mThread');
      const id: string = await thread.call({ userId: 'u1' }, 'thr-a', 'ta-1', 'ta-1-m2');
      const doc = (await AgentSessions.findOneAsync(id))!;
      assert.deepEqual(doc.thread, {
        sessionId: 'ta-1', seq: 2, messageId: 'ta-1-m2', anchorSeq: 2, replies: 0, repliers: [],
      });
      assert.deepEqual(doc.forkedFrom, { sessionId: 'ta-1', seq: 2 });
      assert.equal(doc.title, 'second question', 'titled from its first message');
      assert.equal(doc.phase, 'idle', 'opening a thread runs nothing');
      assert.deepEqual(doc.usage, { input: 0, output: 0, cost: 0 });
      assert.deepEqual(doc.budgetSpent, { turns: 0, toolCalls: 0 });
      assert.isUndefined(doc.parent, 'a thread is a root, not a child');
      assert.equal(doc.nextSeq, 3);
      const rows = await AgentMessages.find({ sessionId: id }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(rows.map((m) => m.content),
        ['first question', 'first answer', 'second question']);
      assert.notInclude(rows.map((m) => m._id), 'ta-1-m2', 'copies get fresh ids');
    });

    it('cuts FORWARD past an assistant row\'s finished tool batch', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineAgent('thr-b');
      await seed('tb-1', 'thr-b', [
        { seq: 0, role: 'user', content: 'look it up' },
        {
          seq: 1, role: 'assistant', content: 'checking',
          toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }],
        },
        { seq: 2, role: 'tool', toolCallId: 't1', content: '1' },
        { seq: 3, role: 'tool', toolCallId: 't2', content: '2' },
        { seq: 4, role: 'assistant', content: 'found it' },
        { seq: 5, role: 'user', content: 'thanks' },
      ]);
      const thread = await method('mThread');
      const id: string = await thread.call({ userId: 'u1' }, 'thr-b', 'tb-1', 'tb-1-m1');
      const doc = (await AgentSessions.findOneAsync(id))!;
      assert.equal(doc.thread!.seq, 3, 'the cut includes the whole batch the anchor opened');
      assert.equal(doc.thread!.messageId, 'tb-1-m1');
      assert.equal(doc.thread!.anchorSeq, 1, 'the anchor sits below the cut');
      const seqs = (await AgentMessages.find({ sessionId: id }, { sort: { seq: 1 } })
        .fetchAsync()).map((m) => m.seq);
      assert.deepEqual(seqs, [0, 1, 2, 3]);
    });

    it('refuses an anchor whose tool batch is still open', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      await defineAgent('thr-c');
      await seed('tc-1', 'thr-c', [
        { seq: 0, role: 'user', content: 'look it up' },
        {
          seq: 1, role: 'assistant', content: 'checking',
          toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }],
        },
        { seq: 2, role: 'tool', toolCallId: 't1', content: '1' },
        // A user interjection inside the open batch is open too.
        { seq: 3, role: 'user', content: 'also this' },
      ]);
      const thread = await method('mThread');
      await rejectsWith(() => thread.call({ userId: 'u1' }, 'thr-c', 'tc-1', 'tc-1-m1'),
        'thread-anchor-open', 'assistant row with an unanswered call');
      await rejectsWith(() => thread.call({ userId: 'u1' }, 'thr-c', 'tc-1', 'tc-1-m3'),
        'thread-anchor-open', 'user row inside an open batch');
      assert.equal(await AgentSessions.find({ thread: { $exists: true } }).countAsync(), 0);
    });

    it('refuses tool, note and system anchors and unknown ids', async function () {
      this.timeout(30000);
      await defineAgent('thr-d');
      await seed('td-1', 'thr-d', [
        { seq: 0, role: 'user', content: 'q' },
        { seq: 1, role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', args: {} }] },
        { seq: 2, role: 'tool', toolCallId: 't1', content: '1' },
        { seq: 3, role: 'note', kind: 'error', error: { error: 'x' } },
        { seq: 4, role: 'system', content: 'scheduled' },
        { seq: 5, role: 'assistant', content: 'done' },
      ]);
      const thread = await method('mThread');
      for (const anchor of ['td-1-m2', 'td-1-m3', 'td-1-m4', 'nope']) {
        // eslint-disable-next-line no-await-in-loop
        await rejectsWith(() => thread.call({ userId: 'u1' }, 'thr-d', 'td-1', anchor),
          'thread-anchor-invalid', anchor);
      }
    });
  });

  it('converges concurrent opens on one thread', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    await defineAgent('thr-e');
    await seed('te-1', 'thr-e', CHAT, { participants: roster('thr-e') });
    const thread = await method('mThread');
    const ids: string[] = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      thread.call({ userId: i % 2 ? 'u2' : 'u1' }, 'thr-e', 'te-1', 'te-1-m1')));
    assert.lengthOf(new Set(ids), 1, `every caller gets the same thread: ${ids.join(',')}`);
    assert.equal(await AgentSessions.find({ 'thread.sessionId': 'te-1' }).countAsync(), 1);
    // A later open finds it too, and the server API agrees.
    const { Agent } = await import('../server/agent');
    assert.equal(
      await new Agent('thr-e').fork('te-1', { thread: { messageId: 'te-1-m1' }, userId: 'u2' }),
      ids[0],
    );
  });

  it('lets any human member open and reply; refuses outsiders and unstartable agents', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    await defineAgent('thr-f', () => ({ text: 'thread reply' }));
    await defineAgent('thr-f-hidden', () => ({ text: 'x' }), { startable: false });
    await seed('tf-1', 'thr-f', CHAT, { participants: roster('thr-f') });
    await seed('tf-2', 'thr-f-hidden', CHAT);
    const thread = await method('mThread');
    const send = await method('mSend');
    const fork = await method('mFork');

    // Contrast: fork stays owner-only.
    await rejectsWith(() => fork.call({ userId: 'u2' }, 'thr-f', 'tf-1'), 'not-allowed', 'member fork');

    const id: string = await thread.call({ userId: 'u2' }, 'thr-f', 'tf-1', 'tf-1-m3');
    await send.call({ userId: 'u2' }, 'thr-f', id, 'member asks in the thread', 'k'.repeat(16));
    await waitFor(() => answered(id, 3 + 1), 'the thread to answer the member');
    const user = await AgentMessages.findOneAsync({ sessionId: id, content: 'member asks in the thread' });
    assert.equal(user!.from!.participant, 'h:u2');

    await rejectsWith(() => thread.call({ userId: 'u3' }, 'thr-f', 'tf-1', 'tf-1-m3'),
      'no-session', 'outsider open');
    await rejectsWith(() => thread.call({ userId: null }, 'thr-f', 'tf-1', 'tf-1-m3'),
      'no-session', 'anonymous open of an owned session');
    await rejectsWith(() => send.call({ userId: 'u3' }, 'thr-f', id, 'hi'),
      'no-session', 'outsider send to the thread');
    await rejectsWith(() => thread.call({ userId: 'u1' }, 'thr-f-hidden', 'tf-2', 'tf-2-m1'),
      'not-startable', 'startable:false agent');
  });

  describe('reply in thread', () => {
    it('commits the parent row and the thread together, and only the thread runs', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const requests = await defineAgent('thr-g', () => ({ text: 'answered in thread' }));
      await seed('tg-1', 'thr-g', CHAT, { participants: roster('thr-g') });
      const send = await method('mSend');

      const result = await send.call(
        { userId: 'u2' }, 'thr-g', 'tg-1', 'side question', 'replyinthread-key-1',
        { replyIn: 'thread', to: 'm:thr-g' },
      );
      assert.equal(result.sessionId, 'tg-1');
      const tid: string = result.threadSessionId;
      assert.isString(tid);

      const row = (await AgentMessages.findOneAsync({ sessionId: 'tg-1', content: 'side question' }))!;
      assert.equal(row.seq, 4);
      assert.equal(row.threadSessionId, tid);
      assert.equal(row.to, 'm:thr-g');
      assert.equal(row.from!.participant, 'h:u2');

      const thread = (await AgentSessions.findOneAsync(tid))!;
      assert.deepEqual(
        { ...thread.thread, lastReplyAt: undefined },
        {
          sessionId: 'tg-1', seq: 4, messageId: row._id, anchorSeq: 4,
          replies: 0, repliers: [], lastReplyAt: undefined,
        },
      );
      const copy = (await AgentMessages.findOneAsync({ sessionId: tid, seq: 4 }))!;
      assert.equal(copy.content, 'side question');
      assert.equal(copy.to, 'm:thr-g', 'the copy carries its addressee');
      assert.isUndefined(copy.threadSessionId, 'in its thread the row is the open request');

      await waitFor(() => answered(tid, 4), 'the thread to answer');
      await settle(400);
      const parent = (await AgentSessions.findOneAsync('tg-1'))!;
      assert.isUndefined(parent.pendingInputs, 'the parent holds no wake link');
      assert.equal(parent.budgetSpent.turns, 0, 'the parent is not charged a turn');
      assert.equal(parent.phase, 'idle');
      assert.equal(
        await AgentMessages.find({ sessionId: 'tg-1', role: 'assistant', seq: { $gt: 4 } }).countAsync(),
        0, 'the parent did not answer',
      );
      assert.lengthOf(requests, 1, 'exactly one model call, in the thread');
      assert.equal(lastContent(requests[0]), '[Mia]: side question',
        'the thread sees the row as a plain request');

      // A retried send with the same key returns the same thread.
      const again = await send.call(
        { userId: 'u2' }, 'thr-g', 'tg-1', 'side question', 'replyinthread-key-1',
        { replyIn: 'thread', to: 'm:thr-g' },
      );
      assert.equal(again.threadSessionId, tid);
      assert.equal(await AgentMessages.find({ sessionId: 'tg-1', content: 'side question' }).countAsync(), 1);
    });

    it('leaves neither the row nor the thread when the thread cannot be written', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineAgent('thr-h');
      await seed('th-1', 'thr-h', CHAT);
      const raw = AgentMessages.rawCollection();
      let holder = Object.getPrototypeOf(raw);
      while (holder && !Object.prototype.hasOwnProperty.call(holder, 'insertMany')) {
        holder = Object.getPrototypeOf(holder);
      }
      const original = holder.insertMany;
      holder.insertMany = function (this: any, docs: any[], ...rest: any[]) {
        if (this.collectionName === raw.collectionName && docs[0]?.sessionId !== 'th-1') {
          return Promise.reject(new Error('copy failed'));
        }
        return original.call(this, docs, ...rest);
      };
      try {
        const send = await method('mSend');
        try {
          await send.call({ userId: 'u1' }, 'thr-h', 'th-1', 'doomed', undefined, { replyIn: 'thread' });
          assert.fail('the send should fail');
        } catch (e: any) {
          assert.include(String(e?.message), 'copy failed');
        }
      } finally {
        holder.insertMany = original;
      }
      assert.equal(await AgentMessages.find({ content: 'doomed' }).countAsync(), 0);
      assert.equal(await AgentSessions.find({ thread: { $exists: true } }).countAsync(), 0);
      assert.equal((await AgentSessions.findOneAsync('th-1'))!.nextSeq, 4, 'no seq was spent');
    });

    it('shows the parent\'s model the row as answered in the thread', async function () {
      this.timeout(30000);
      const { AgentMessages } = await import('../common/collections');
      const { THREAD_REPLY_MARKER } = await import('../server/transcript');
      const requests = await defineAgent('thr-i', (req) => ({ text: `reply ${req.messages.length}` }));
      await seed('ti-1', 'thr-i', CHAT);
      const send = await method('mSend');
      const { threadSessionId } = await send.call(
        { userId: 'u1' }, 'thr-i', 'ti-1', 'branch off here', undefined, { replyIn: 'thread' },
      );
      await waitFor(() => answered(threadSessionId, 4), 'the thread to answer');

      await send.call({ userId: 'u1' }, 'thr-i', 'ti-1', 'back in the topic');
      await waitFor(() => answered('ti-1', 5), 'the parent to answer the new message');
      const parentRequest = requests[requests.length - 1];
      const contents = parentRequest.messages.map((m) => String(m.content));
      assert.include(contents, `branch off here\n\n${THREAD_REPLY_MARKER}`);
      assert.equal(contents[contents.length - 1], 'back in the topic');
      const stored = (await AgentMessages.findOneAsync({ sessionId: 'ti-1', content: 'branch off here' }))!;
      assert.equal(stored.content, 'branch off here', 'the marker never reaches stored content');
      // The thread's own request never carries the marker.
      assert.notInclude(requests[0].messages.map((m) => String(m.content)).join('\n'), THREAD_REPLY_MARKER);
    });
  });

  it('alsoToParent copies the message into the parent without waking it', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { FROM_THREAD_MARKER } = await import('../server/transcript');
    const requests = await defineAgent('thr-j', () => ({ text: 'ok' }));
    await seed('tj-1', 'thr-j', CHAT, { participants: roster('thr-j') });
    const thread = await method('mThread');
    const send = await method('mSend');
    const tid: string = await thread.call({ userId: 'u1' }, 'thr-j', 'tj-1', 'tj-1-m3');

    await rejectsWith(
      () => send.call({ userId: 'u1' }, 'thr-j', 'tj-1', 'x', undefined, { alsoToParent: true }),
      'not-a-thread', 'alsoToParent on a non-thread',
    );
    await rejectsWith(
      () => send.call({ userId: 'u1' }, 'thr-j', tid, 'x', undefined, { alsoToParent: true, replyIn: 'thread' }),
      'invalid-options', 'both options',
    );

    const result = await send.call(
      { userId: 'u2' }, 'thr-j', tid, 'decision: ship it', 'alsoparent-key-001', { alsoToParent: true },
    );
    assert.deepEqual(result, { sessionId: tid });
    await waitFor(() => answered(tid, 4), 'the thread to answer');
    await settle(400);

    const copy = (await AgentMessages.findOneAsync({ sessionId: 'tj-1', content: 'decision: ship it' }))!;
    assert.equal(copy.fromThreadSessionId, tid);
    assert.equal(copy.from!.participant, 'h:u2');
    assert.equal(copy.role, 'user');
    const parent = (await AgentSessions.findOneAsync('tj-1'))!;
    assert.isUndefined(parent.pendingInputs);
    assert.equal(parent.budgetSpent.turns, 0);
    assert.equal(
      await AgentMessages.find({ sessionId: 'tj-1', role: 'assistant', seq: { $gt: 3 } }).countAsync(),
      0, 'the parent did not answer the copy',
    );
    assert.lengthOf(requests, 1);

    // Retried with the same key: one copy.
    await send.call(
      { userId: 'u2' }, 'thr-j', tid, 'decision: ship it', 'alsoparent-key-001', { alsoToParent: true },
    );
    assert.equal(await AgentMessages.find({ sessionId: 'tj-1', content: 'decision: ship it' }).countAsync(), 1);

    // The parent's model later sees it as context.
    await send.call({ userId: 'u1' }, 'thr-j', 'tj-1', 'next topic message');
    await waitFor(() => answered('tj-1', 5), 'the parent to answer');
    const contents = requests[requests.length - 1].messages.map((m) => String(m.content));
    assert.include(contents, `[Mia]: decision: ship it\n\n${FROM_THREAD_MARKER}`);
  });

  it('keeps reply count, repliers and last reply time with the rows', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    let calls = 0;
    new Agent('thr-k', {
      model: 'mock', instructions: 'x',
      tools: [{
        name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
        run: async () => ({ found: true }),
      }],
      provider: mockProvider(() => {
        calls += 1;
        return calls % 2 === 1
          ? { toolCalls: [{ id: `c${calls}`, name: 'lookup', args: {} }] }
          : { text: 'here you go' };
      }),
    } as any);
    await seed('tk-1', 'thr-k', CHAT, { participants: roster('thr-k') });
    const send = await method('mSend');
    const { threadSessionId: tid } = await send.call(
      { userId: 'u1' }, 'thr-k', 'tk-1', 'please look', undefined, { replyIn: 'thread' },
    );
    await waitFor(async () => (await AgentMessages.findOneAsync({
      sessionId: tid, role: 'assistant', content: 'here you go',
    })) !== undefined && await answered(tid, 4), 'the tool-using reply');

    let doc = (await AgentSessions.findOneAsync(tid))!;
    // The anchor is the cut; the tool step is not a reply, the final answer is.
    assert.equal(doc.thread!.replies, 1);
    assert.deepEqual(doc.thread!.repliers, ['m:thr-k']);
    const final = (await AgentMessages.findOneAsync({ sessionId: tid, content: 'here you go' }))!;
    assert.equal(doc.thread!.lastReplyAt!.getTime(), final.createdAt.getTime());

    await send.call({ userId: 'u2' }, 'thr-k', tid, 'and again?');
    // The member's question and the second final answer.
    await waitFor(async () => (await AgentSessions.findOneAsync(tid))!.thread!.replies === 3
      && await answered(tid, final.seq + 1), 'the second exchange');
    doc = (await AgentSessions.findOneAsync(tid))!;
    assert.deepEqual(doc.thread!.repliers, ['m:thr-k'], 'repliers are distinct');
    const rows = await AgentMessages.find({ sessionId: tid, seq: { $gt: 4 } }).fetchAsync();
    const counted = rows.filter((m) => m.role === 'user'
      || (m.role === 'assistant' && !m.toolCalls?.length));
    assert.equal(doc.thread!.replies, counted.length);
    const newest = Math.max(...counted.map((m) => m.createdAt.getTime()));
    assert.equal(doc.thread!.lastReplyAt!.getTime(), newest);
    // The parent is not a thread: its own commits leave it without stats.
    assert.isUndefined((await AgentSessions.findOneAsync('tk-1'))!.thread);
  });

  it('runs a thread while its parent is mid-turn', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const requests = await defineAgent('thr-l', async (req) => {
      if (lastContent(req) === 'slow parent work') await gate;
      return { text: lastContent(req) === 'slow parent work' ? 'parent done' : 'thread done' };
    });
    await seed('tl-1', 'thr-l', CHAT);
    const send = await method('mSend');
    try {
      await send.call({ userId: 'u1' }, 'thr-l', 'tl-1', 'slow parent work');
      await waitFor(async () => requests.length === 1, 'the parent turn to start');
      const { threadSessionId: tid } = await send.call(
        { userId: 'u1' }, 'thr-l', 'tl-1', 'quick side question', undefined, { replyIn: 'thread' },
      );
      await waitFor(() => answered(tid, 5), 'the thread to answer while the parent runs');
      const parent = (await AgentSessions.findOneAsync('tl-1'))!;
      assert.equal(parent.phase, 'streaming', 'the parent is still mid-turn');
      // The thread copied the parent through its own row, not the parent's
      // unfinished reply.
      const copied = await AgentMessages.find({ sessionId: tid }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(copied.slice(0, 6).map((m) => m.content), [
        'first question', 'first answer', 'second question', 'second answer',
        'slow parent work', 'quick side question',
      ]);
    } finally {
      release();
    }
    await waitFor(() => answered('tl-1', 4), 'the parent to finish');
    await settle(400);
    assert.lengthOf(requests, 2, 'the parent did not loop back for the thread row');
    const replies = await AgentMessages.find({ sessionId: 'tl-1', role: 'assistant', seq: { $gt: 3 } }).fetchAsync();
    assert.deepEqual(replies.map((m) => m.content), ['parent done']);
  });

  it('lists threads under their parent only, for the people in it', async function () {
    this.timeout(30000);
    await defineAgent('thr-m');
    await seed('tm-1', 'thr-m', CHAT, { participants: roster('thr-m') });
    await seed('tm-2', 'thr-m', CHAT);
    const thread = await method('mThread');
    const t1: string = await thread.call({ userId: 'u1' }, 'thr-m', 'tm-1', 'tm-1-m1');
    const t2: string = await thread.call({ userId: 'u2' }, 'thr-m', 'tm-1', 'tm-1-m3');
    const other: string = await thread.call({ userId: 'u1' }, 'thr-m', 'tm-2', 'tm-2-m1');

    const sessions = await publication('pubSessions');
    const listed = await sessions.call({ userId: 'u1' }, 'thr-m', true).fetchAsync();
    assert.sameMembers(listed.map((s: any) => s._id), ['tm-1', 'tm-2'], 'threads stay out of the list');

    const threads = await publication('pubThreads');
    for (const uid of ['u1', 'u2']) {
      // eslint-disable-next-line no-await-in-loop
      const cursor = await threads.call({ userId: uid }, 'thr-m', 'tm-1');
      // eslint-disable-next-line no-await-in-loop
      const docs = await cursor.fetchAsync();
      assert.sameMembers(docs.map((d: any) => d._id), [t1, t2], `${uid} sees this parent's threads`);
      const doc = docs.find((d: any) => d._id === t1);
      assert.equal(doc.thread.messageId, 'tm-1-m1');
      assert.isUndefined(doc.lease);
      assert.isUndefined(doc.nextSeq, 'summary fields only');
      assert.isDefined(doc.participants);
    }
    assert.deepEqual(await threads.call({ userId: 'u3' }, 'thr-m', 'tm-1'), [], 'outsider');
    assert.deepEqual(await threads.call({ userId: 'u2' }, 'thr-m', 'tm-2'), [], 'not a member there');
    assert.deepEqual(await threads.call({ userId: 'u1' }, 'other-agent', 'tm-1'), [], 'wrong agent');
    const own = await (await threads.call({ userId: 'u1' }, 'thr-m', 'tm-2')).fetchAsync();
    assert.deepEqual(own.map((d: any) => d._id), [other]);
  });

  it('erases a parent\'s threads with it, but not its plain forks', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    await defineAgent('thr-n');
    await seed('tn-1', 'thr-n', CHAT);
    const agent = new Agent('thr-n');
    const t1 = await agent.fork('tn-1', { thread: { messageId: 'tn-1-m1' }, userId: 'u1' });
    const nested = await agent.fork(t1, { thread: { messageId: (await AgentMessages.findOneAsync({ sessionId: t1, seq: 0 }))!._id } });
    const fork = await agent.fork('tn-1', { userId: 'u1' });

    assert.equal(await agent.erase('tn-1', { userId: 'u1' }), 'erased');
    for (const id of ['tn-1', t1, nested]) {
      // eslint-disable-next-line no-await-in-loop
      assert.isUndefined(await AgentSessions.findOneAsync(id), `${id} erased`);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await AgentMessages.find({ sessionId: id }).countAsync(), 0);
    }
    assert.isDefined(await AgentSessions.findOneAsync(fork), 'a plain fork survives');
  });

  it('the orphan-child watcher leaves threads alone', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { startWatcher } = await import('../server/watcher');
    await defineAgent('thr-o');
    await seed('to-1', 'thr-o', CHAT);
    const thread = await method('mThread');
    const tid: string = await thread.call({ userId: 'u1' }, 'thr-o', 'to-1', 'to-1-m1');
    await AgentSessions.updateAsync(tid, { $set: { createdAt: new Date(Date.now() - 60_000) } } as any);
    const w = startWatcher({ sweepMs: 50, relinkGraceMs: 10 });
    try {
      await settle(600);
    } finally {
      await w.stop();
    }
    assert.equal(await AgentMessages.find({ kind: 'orphan-child' } as any).countAsync(), 0);
    assert.isDefined(await AgentSessions.findOneAsync(tid));
  });
});
