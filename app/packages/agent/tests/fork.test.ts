import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

/** Deferred work (the turn a send schedules) exposes no promise to await, so
 *  every wait here is bounded by a deadline and fails loudly rather than
 *  hanging the suite. Same helper the loop and subagent suites use. */
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

/** A source session plus its transcript, wiped clean of everything else. `rows`
 *  are message fields; `session` overrides the envelope. */
const seedSource = async (
  sessionId: string,
  rows: Array<Record<string, any>>,
  session: Record<string, any> = {},
  agent = 'forker',
) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: rows.length, usage: { input: 0, output: 0, cost: 0 },
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

/** The agent every fixture here forks. Registered per test because the registry
 *  is a Map that overwrites cleanly (methods are not — they are registered once
 *  by the package's own startup). */
const defineForker = async (
  reply: (req: any) => any = () => ({ text: 'ok' }), name = 'forker',
) => {
  const { Agent } = await import('../server/agent');
  const { mockProvider } = await import('../server/providers/mock');
  new Agent(name, {
    model: 'mock', instructions: 'x', tools: [], provider: mockProvider(reply),
  });
};

const forkHandler = async () => {
  const { NAMES } = await import('../common/names');
  const { Meteor } = await import('meteor/meteor');
  return (Meteor.server as any).method_handlers[NAMES.mFork];
};

describe('session forking', () => {
  it('copies the transcript with fresh ids, original seqs and zeroed usage', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    await defineForker();

    // The source carries every field a fork must NOT inherit: a spent budget,
    // real usage, a lease, and — artificially, since a real root session has
    // none — the three subagent markers. Seeding them is the point: a fork that
    // copied `parent` would vanish from `agent.sessions`, one that copied
    // `depth` would be charged for hops it never took, and `activeChild`
    // describes a dispatch running under someone else's lease.
    await seedSource(
      'f-copy',
      [
        { seq: 0, role: 'user', content: 'q1' },
        { seq: 1, role: 'assistant', content: 'a1', usage: { input: 9, output: 3 } },
        { seq: 2, role: 'user', content: 'q2' },
        { seq: 3, role: 'assistant', content: 'a2' },
      ],
      {
        title: 'Order help',
        usage: { input: 100, output: 50, cost: 1.5 },
        budgetSpent: { turns: 3, toolCalls: 2 },
        lease: { serverId: 'srv-1', until: new Date() },
        parent: { sessionId: 'someone-else', toolCallId: 'tc1' },
        depth: 2,
        activeChild: { sessionId: 'live-child', toolCallId: 'tc2' },
      },
    );

    const fork = await forkHandler();
    const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-copy');
    assert.notEqual(forkId, 'f-copy');

    const doc = (await AgentSessions.findOneAsync(forkId))! as any;
    assert.equal(doc.agent, 'forker');
    assert.equal(doc.userId, 'u1');
    assert.equal(doc.phase, 'idle', 'a fork is idle until it runs');
    assert.deepEqual(doc.forkedFrom, { sessionId: 'f-copy', seq: 3 });
    assert.equal(doc.title, 'Fork of Order help');
    // A fork costs nothing until it runs.
    assert.deepEqual(doc.usage, { input: 0, output: 0, cost: 0 });
    assert.deepEqual(doc.budgetSpent, { turns: 0, toolCalls: 0 });
    // Copied messages keep their seqs, so allocation continues from the cut.
    assert.equal(doc.nextSeq, 4);
    for (const field of ['parent', 'depth', 'activeChild', 'pending', 'lease']) {
      assert.isUndefined(doc[field], `a fork must not carry ${field}`);
    }

    const copied = await AgentMessages
      .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(copied, 4);
    assert.deepEqual(copied.map((m) => m.seq), [0, 1, 2, 3], 'seqs are preserved verbatim');
    assert.deepEqual(copied.map((m) => m.content), ['q1', 'a1', 'q2', 'a2']);
    assert.deepEqual((copied[1] as any).usage, { input: 9, output: 3 },
      'every other field rides along unchanged');
    // Fresh identities: sharing an `_id` would make one document two
    // transcripts' rows, and editing either would edit both.
    const sourceIds = new Set(
      (await AgentMessages.find({ sessionId: 'f-copy' }).fetchAsync()).map((m) => m._id),
    );
    assert.isEmpty(copied.filter((m) => sourceIds.has(m._id)), 'copies need new _ids');
    assert.equal(sourceIds.size, 4, 'the source transcript is untouched');

    // An explicit title wins over the generated one.
    const titled: string = await fork.call(
      { userId: 'u1' }, 'forker', 'f-copy', undefined, { title: 'What if we refunded' },
    );
    assert.equal(((await AgentSessions.findOneAsync(titled))! as any).title,
      'What if we refunded');
  });

  it('diverges independently: a send to one never reaches the other', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    // Answer with the last user message so the two branches are told apart by
    // content, not by counting.
    await defineForker((req: any) => {
      const lastUser = [...req.messages].reverse().find((m: any) => m.role === 'user');
      return { text: `re:${lastUser?.content}` };
    });

    await seedSource('f-diverge', [
      { seq: 0, role: 'user', content: 'shared question' },
      { seq: 1, role: 'assistant', content: 'shared answer' },
    ]);

    const fork = await forkHandler();
    const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-diverge');
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];

    await send.call({ userId: 'u1' }, 'forker', forkId, 'branch A');
    await send.call({ userId: 'u1' }, 'forker', 'f-diverge', 'branch B');

    const answered = async (sessionId: string, text: string) => (
      await AgentMessages.find({ sessionId, role: 'assistant', content: `re:${text}` })
        .countAsync()) === 1;
    await waitFor(() => answered(forkId, 'branch A'), 'the fork to answer its own send');
    await waitFor(() => answered('f-diverge', 'branch B'), 'the source to answer its own send');

    const forkMsgs = await AgentMessages
      .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
    const srcMsgs = await AgentMessages
      .find({ sessionId: 'f-diverge' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isEmpty(forkMsgs.filter((m) => m.content === 'branch B'), 'no cross-talk into the fork');
    assert.isEmpty(srcMsgs.filter((m) => m.content === 'branch A'), 'no cross-talk into the source');
    // Both continued the SHARED history rather than starting from nothing.
    assert.equal(forkMsgs[0].content, 'shared question');
    assert.equal(srcMsgs[0].content, 'shared question');
    // Seq allocation resumed from the cut on both sides, with no collisions.
    assert.deepEqual(forkMsgs.map((m) => m.seq), [0, 1, 2, 3]);
    assert.deepEqual(srcMsgs.map((m) => m.seq), [0, 1, 2, 3]);
  });

  it('forks a fork, at a point of its own', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    await defineForker();

    await seedSource('f-root', [
      { seq: 0, role: 'user', content: 'q0' },
      { seq: 1, role: 'assistant', content: 'a1' },
      { seq: 2, role: 'user', content: 'q2' },
      { seq: 3, role: 'assistant', content: 'a3' },
    ]);

    const fork = await forkHandler();
    const first: string = await fork.call({ userId: 'u1' }, 'forker', 'f-root');
    // The second fork cuts EARLIER than the first — a fork is an ordinary
    // session, so it forks by exactly the same rules.
    const second: string = await fork.call({ userId: 'u1' }, 'forker', first, 1);

    const doc = (await AgentSessions.findOneAsync(second))! as any;
    assert.deepEqual(doc.forkedFrom, { sessionId: first, seq: 1 },
      'lineage points at the fork it came from, not at the original root');
    assert.equal(doc.nextSeq, 2);
    const msgs = await AgentMessages
      .find({ sessionId: second }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(msgs.map((m) => m.content), ['q0', 'a1']);
  });

  it('clamps a mid-batch atSeq back to before the batch, and leaves a legal one alone',
    async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineForker();

      // One assistant with two parallel tool calls, both answered. seq 1 cuts
      // between the assistant and its results; seq 2 cuts between the two
      // results. Both would strand a `tool_use`. seq 3 is the LAST result, so
      // it closes the batch — a legal cut, and the walk must leave it alone
      // rather than pessimistically dropping a whole complete exchange.
      await seedSource('f-batch', [
        { seq: 0, role: 'user', content: 'refund it' },
        {
          seq: 1,
          role: 'assistant',
          toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }],
        },
        { seq: 2, role: 'tool', toolCallId: 't1', content: '{"ok":1}' },
        { seq: 3, role: 'tool', toolCallId: 't2', content: '{"ok":2}' },
        { seq: 4, role: 'assistant', content: 'done' },
      ]);

      const fork = await forkHandler();
      const cutAt = async (atSeq: number) => {
        const id: string = await fork.call({ userId: 'u1' }, 'forker', 'f-batch', atSeq);
        const doc = (await AgentSessions.findOneAsync(id))! as any;
        const msgs = await AgentMessages
          .find({ sessionId: id }, { sort: { seq: 1 } }).fetchAsync();
        return { seq: doc.forkedFrom.seq, nextSeq: doc.nextSeq, roles: msgs.map((m) => m.role) };
      };

      for (const atSeq of [1, 2]) {
        // eslint-disable-next-line no-await-in-loop
        const got = await cutAt(atSeq);
        assert.equal(got.seq, 0, `atSeq ${atSeq} must clamp to before the assistant`);
        assert.deepEqual(got.roles, ['user'],
          'a fork must never carry a tool_use whose tool_result it left behind');
        assert.equal(got.nextSeq, 1);
      }

      // The batch is complete at seq 3, and outside it at seq 4: both are legal
      // cuts and both are taken as given.
      const closing = await cutAt(3);
      assert.equal(closing.seq, 3, 'the last result of a batch is a legal cut');
      assert.deepEqual(closing.roles, ['user', 'assistant', 'tool', 'tool']);
      const after = await cutAt(4);
      assert.equal(after.seq, 4);
      assert.deepEqual(after.roles, ['user', 'assistant', 'tool', 'tool', 'assistant']);
    });

  it('forking an awaiting session cuts before the parked batch and carries no pending',
    async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineForker();

      // The exact shape a `gate: 'ask'` park leaves: a committed assistant with
      // an UNANSWERED tool_use, `phase: 'awaiting'`, and the marker. The cut
      // falls out of the same batch-safety walk — an unanswered call's answer
      // is "after everything", so a head ending on that assistant strands it.
      await seedSource(
        'f-parked',
        [
          { seq: 0, role: 'user', content: 'refund order 7' },
          { seq: 1, role: 'assistant', toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] },
        ],
        {
          phase: 'awaiting',
          pending: { toolCallId: 'g1', name: 'refund', args: { amt: 5 }, requestedAt: new Date() },
        },
      );

      const fork = await forkHandler();
      const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-parked');

      const doc = (await AgentSessions.findOneAsync(forkId))! as any;
      assert.equal(doc.phase, 'idle', 'a fork does not inherit the wait');
      assert.isUndefined(doc.pending, 'the approval belongs to the turn that parked it');
      assert.deepEqual(doc.forkedFrom, { sessionId: 'f-parked', seq: 0 });
      assert.equal(doc.nextSeq, 1);

      const msgs = await AgentMessages
        .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(msgs.map((m) => m.role), ['user'],
        'the parked assistant is excluded — nothing can ever answer its tool_use here');
      // The source is still parked: forking reads, it never resolves.
      const src = (await AgentSessions.findOneAsync('f-parked'))! as any;
      assert.equal(src.phase, 'awaiting');
      assert.equal(src.pending.toolCallId, 'g1');
    });

  it('copies a compaction note, and the fork\'s first call sees the compacted view',
    async function () {
      this.timeout(30000);
      const { AgentMessages } = await import('../common/collections');
      const { NAMES } = await import('../common/names');
      const { Meteor } = await import('meteor/meteor');
      const { Agent } = await import('../server/agent');

      // A compaction note is transcript history the MODEL VIEW depends on:
      // drop it and the fork silently reverts to the full uncompacted
      // conversation — the context blow-up compaction just paid a provider call
      // to avoid.
      await seedSource('f-compact', [
        { seq: 0, role: 'user', content: 'ORIGINAL-QUESTION' },
        { seq: 1, role: 'assistant', content: 'ORIGINAL-ANSWER' },
        { seq: 2, role: 'note', kind: 'compaction', summary: 'THE-BRIEF', upto: 1 },
        { seq: 3, role: 'user', content: 'after the compaction' },
        { seq: 4, role: 'assistant', content: 'sure' },
      ]);

      let seen: any[] = [];
      const capturing: Provider = {
        async *stream(req: any) {
          seen = req.messages;
          yield { kind: 'text', chunk: 'forked reply' };
          yield { kind: 'done', usage: { input: 1, output: 2 } };
        },
      };
      new Agent('forker', {
        model: 'mock', instructions: 'x', tools: [], provider: capturing,
      });

      const fork = await forkHandler();
      const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-compact');

      const copied = await AgentMessages
        .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
      const note = copied.find((m) => m.role === 'note')! as any;
      assert.isDefined(note, 'the compaction note must be copied');
      assert.equal(note.summary, 'THE-BRIEF');
      assert.equal(note.upto, 1, 'the note keeps its `upto` — copied seqs are unchanged');

      const send = (Meteor.server as any).method_handlers[NAMES.mSend];
      await send.call({ userId: 'u1' }, 'forker', forkId, 'and now?');
      await waitFor(
        async () => (await AgentMessages
          .find({ sessionId: forkId, content: 'forked reply' }).countAsync()) === 1,
        'the fork\'s first turn to commit',
      );

      assert.include(seen[0].content, 'THE-BRIEF', 'the summary leads the view');
      assert.isEmpty(seen.filter((m: any) => m.content === 'ORIGINAL-QUESTION'),
        'compacted history must not reappear in the fork');
      assert.isEmpty(seen.filter((m: any) => m.role === 'note'),
        'notes never reach a provider');
      assert.equal(seen[seen.length - 1].content, 'and now?');
    });

  it('a walk-moved cut DROPS the trailing notes, and the fork re-compacts rather than lying',
    async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await defineForker();

      // `atSeq: 4` is illegal — it would copy the assistant at seq 1 without the
      // `tool_result` at seq 5 — so the walk moves the cut back to seq 0. The
      // compaction note at seq 3 sits between the moved cut and the requested
      // atSeq, so it is NOT copied.
      //
      // This is the documented tradeoff in `findForkCut`'s header, pinned. The
      // note's `upto: 2` covers rows the fork does not hold, so copying it would
      // make `assembleContext` start the view AFTER everything the fork owns and
      // render the summary alone — a view describing an exchange the transcript
      // underneath it does not contain. Dropping it costs at most one
      // re-compaction and can only ever WIDEN the view to rows that are really
      // there.
      await seedSource('f-note-drop', [
        { seq: 0, role: 'user', content: 'q0' },
        { seq: 1, role: 'assistant', toolCalls: [{ id: 't1', name: 'a', args: {} }] },
        { seq: 2, role: 'user', content: 'interjected' },
        { seq: 3, role: 'note', kind: 'compaction', summary: 'THE-BRIEF', upto: 2 },
        { seq: 4, role: 'note', kind: 'error', reason: 'transient' },
        { seq: 5, role: 'tool', toolCallId: 't1', content: '{"ok":1}' },
      ]);

      const fork = await forkHandler();
      const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-note-drop', 4);

      const doc = (await AgentSessions.findOneAsync(forkId))! as any;
      assert.deepEqual(doc.forkedFrom, { sessionId: 'f-note-drop', seq: 0 },
        'the cut moves back past the unanswered assistant');
      assert.equal(doc.nextSeq, 1);

      const msgs = await AgentMessages
        .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(msgs.map((m) => m.seq), [0],
        'every row after the moved cut is dropped, notes included');
      assert.isEmpty(msgs.filter((m) => m.role === 'note'),
        'a note between the moved cut and atSeq is not copied');

      // The contrast, in one assertion: when the walk does NOT move, the very
      // same note IS copied — the drop is a consequence of moving, not a rule
      // about notes.
      const kept: string = await fork.call({ userId: 'u1' }, 'forker', 'f-note-drop', 5);
      const keptMsgs = await AgentMessages
        .find({ sessionId: kept }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(keptMsgs.map((m) => m.seq), [0, 1, 2, 3, 4, 5]);
    });

  it('agent.sessions lists a fork: it is a root conversation, not a child', async function () {
    this.timeout(30000);
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    await defineForker();

    await seedSource('f-listed', [{ seq: 0, role: 'user', content: 'hello' }]);
    const fork = await forkHandler();
    const forkId: string = await fork.call({ userId: 'u1' }, 'forker', 'f-listed');

    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSessions];
    const docs = await handler.call({ userId: 'u1' }, 'forker').fetchAsync();
    const ids = docs.map((d: any) => d._id);
    assert.include(ids, forkId, 'a fork is listed — it carries no `parent`');
    assert.include(ids, 'f-listed');
  });

  it('refuses a fork of a session the caller does not own', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    await defineForker();
    await defineForker(() => ({ text: 'x' }), 'forker-other');

    await seedSource('f-auth', [{ seq: 0, role: 'user', content: 'private' }]);
    const fork = await forkHandler();

    const rejects = async (fn: () => Promise<unknown>, label: string) => {
      try { await fn(); } catch (e: any) {
        assert.equal(e.error, 'no-session', label);
        return;
      }
      assert.fail(`${label}: expected no-session, but the call succeeded`);
    };
    await rejects(() => fork.call({ userId: 'u2' }, 'forker', 'f-auth'), 'another user');
    await rejects(() => fork.call({ userId: null }, 'forker', 'f-auth'), 'anonymous');
    await rejects(() => fork.call({ userId: 'u1' }, 'forker-other', 'f-auth'), 'wrong agent');
    // Nothing was created by any of the three refusals.
    assert.equal(await AgentSessions.find({}).countAsync(), 1,
      'a refused fork must create nothing at all');
  });

  it('Agent.fork forks server-side, scoping the lookup when a userId is given',
    async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { Agent } = await import('../server/agent');
      await defineForker();

      await seedSource('f-server', [
        { seq: 0, role: 'user', content: 'q' },
        { seq: 1, role: 'assistant', content: 'a' },
      ]);
      const Forker = new Agent('forker');

      // A direct server call needs no userId: the source's own owner is used.
      const plain = await Forker.fork('f-server');
      const doc = (await AgentSessions.findOneAsync(plain))! as any;
      assert.equal(doc.userId, 'u1', 'a fork never changes hands');
      assert.deepEqual(doc.forkedFrom, { sessionId: 'f-server', seq: 1 });

      // A caller acting FOR someone scopes the lookup with their id.
      const scoped = await Forker.fork('f-server', { userId: 'u1', atSeq: 0, title: 'T' });
      assert.equal(((await AgentSessions.findOneAsync(scoped))! as any).title, 'T');

      let threw: any;
      try { await Forker.fork('f-server', { userId: 'u2' }); } catch (e) { threw = e; }
      assert.equal(threw?.error, 'no-session', 'a foreign userId must not reach the session');
    });
});
