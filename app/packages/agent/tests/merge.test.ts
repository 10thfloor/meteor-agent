import { assert } from 'chai';
import { mergeView } from '../common/merge';
import type { AgentDelta, AgentMessage, ViewMessage } from '../common/types';

const delta = (
  messageId: string, seq: number, chunk: string,
  opts: { msgSeq?: number; kind?: AgentDelta['kind'] } = {},
): AgentDelta => ({
  _id: `${messageId}:${seq}`,
  sessionId: 's1',
  messageId,
  msgSeq: opts.msgSeq ?? 10,
  seq,
  kind: opts.kind ?? 'text',
  chunk,
  at: new Date(0),
});

const streamOf = (messageId: string, text: string, opts = {}) =>
  text.split('').map((c, i) => delta(messageId, i, c, opts));

const render = (view: ViewMessage[]) =>
  view.map((m) => (m.truncatedHead ? `…${m.content}` : m.content)).join('|');

function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const committed: AgentMessage[] = [{
  _id: 'm1', sessionId: 's1', seq: 10, role: 'assistant',
  content: 'hello world', createdAt: new Date(0),
}];

describe('mergeView', () => {
  it('renders an in-order stream', () => {
    assert.equal(render(mergeView([], streamOf('m1', 'hello'))), 'hello');
  });

  it('is order-independent across 50 shuffles', () => {
    const src = streamOf('m1', 'hello world');
    for (let s = 1; s <= 50; s += 1) {
      assert.equal(render(mergeView([], shuffle(src, s))), 'hello world', `seed ${s}`);
    }
  });

  it('dedupes duplicate delivery', () => {
    const src = streamOf('m1', 'hello world');
    assert.equal(render(mergeView([], [...src, ...src])), 'hello world');
  });

  it('lets a committed message supersede its deltas', () => {
    assert.equal(render(mergeView(committed, streamOf('m1', 'hello world'))), 'hello world');
    assert.lengthOf(mergeView(committed, streamOf('m1', 'hello world')), 1);
  });

  it('renders the contiguous TAIL when the head is evicted', () => {
    const evicted = streamOf('m1', 'hello world').filter((d) => d.seq >= 6);
    assert.equal(render(mergeView([], evicted)), '…world');
  });

  it('renders the contiguous tail across a mid gap', () => {
    const gap = streamOf('m1', 'abcdefghij').filter((d) => d.seq <= 2 || d.seq >= 7);
    assert.equal(render(mergeView([], gap)), '…hij');
  });

  it('ignores deltas arriving after commit', () => {
    const late = [...streamOf('m1', 'hello world'), delta('m1', 99, 'X')];
    assert.equal(render(mergeView(committed, late)), 'hello world');
  });

  it('orders interleaved in-flight messages by msgSeq', () => {
    const two = shuffle([
      ...streamOf('mA', 'AAA', { msgSeq: 11 }),
      ...streamOf('mB', 'BBB', { msgSeq: 12 }),
    ], 7);
    assert.equal(render(mergeView([], two)), 'AAA|BBB');
  });

  it('interleaves committed and in-flight by seq', () => {
    const view = mergeView(
      [{ _id: 'm0', sessionId: 's1', seq: 9, role: 'user', content: 'Q', createdAt: new Date(0) }],
      streamOf('m1', 'A', { msgSeq: 10 }),
    );
    assert.equal(render(view), 'Q|A');
  });

  it('keeps non-text kinds out of content', () => {
    const withThinking = [...streamOf('m1', 'hi'), delta('m1', 2, 'ponder', { kind: 'thinking' })];
    const view = mergeView([], withThinking);
    assert.equal(view[0].content, 'hi');
    assert.equal(view[0].thinking, 'ponder');
  });

  it('handles degenerate inputs', () => {
    assert.deepEqual(mergeView([], []), []);
    assert.equal(render(mergeView(committed, [])), 'hello world');
  });

  it('renders a single delta whose head is gone', () => {
    assert.equal(render(mergeView([], [delta('m1', 7, 'z')])), '…z');
  });

  it('marks in-flight rows as streaming', () => {
    const view = mergeView([], streamOf('m1', 'hi'));
    assert.isTrue(view[0].streaming);
    assert.isFalse(mergeView(committed, [])[0].streaming);
  });
});

describe('mergeView note rows', () => {
  // WHY HERE AND NOT IN A CLIENT RENDER TEST. `client/agent.ts` renders nothing
  // itself — it is a reactive store whose whole output is `mergeView(messages,
  // deltas)`, and `mergeView` is shared common/ code with no Meteor, DDP or DOM
  // dependency. A client integration test would need a live subscription, a
  // real turn to produce each note kind, and a DOM assertion, to end up
  // exercising this same pure function; the only thing it would add is
  // confidence in Meteor's own reactivity, which the existing client
  // integration test already covers for ordinary rows. The risk that IS worth a
  // test is `mergeView` silently mangling a note: dropping the kind-specific
  // fields a UI renders (which limit tripped, who approved, what was
  // summarized), reordering notes away from the message they explain, or
  // treating one as an in-flight assistant row and stamping `streaming: true`
  // on transcript history. All four are asserted below, on the server, with no
  // fixture beyond plain objects.

  const note = (
    _id: string, seq: number, extra: Partial<AgentMessage>,
  ): AgentMessage => ({
    _id, sessionId: 's1', seq, role: 'note', createdAt: new Date(0), ...extra,
  });

  const errorNote = note('n-err', 11, {
    kind: 'error', error: { error: 'provider unavailable', reason: 'http 503' },
  });
  const budgetNote = note('n-bud', 13, {
    kind: 'budget', budget: 'toolCalls',
    error: { error: 'budget exhausted', reason: 'tool call limit reached' },
  });
  const approvalNote = note('n-app', 15, {
    kind: 'approval', approved: false, by: null,
    reason: 'approval timed out', timedOut: true,
  });
  const compactionNote = note('n-cmp', 17, {
    kind: 'compaction', summary: 'Goal: ship. Progress: partial.', upto: 14,
  });
  const notes = [errorNote, budgetNote, approvalNote, compactionNote];

  const user = (id: string, seq: number, content: string): AgentMessage => ({
    _id: id, sessionId: 's1', seq, role: 'user', content, createdAt: new Date(0),
  });

  it('passes every note kind through with its fields intact', () => {
    const view = mergeView(notes, []);
    assert.lengthOf(view, 4);
    for (const original of notes) {
      const row: any = view.find((m) => m._id === original._id);
      assert.isDefined(row, `${original._id} vanished`);
      // Every field the source note carried survives, unchanged.
      for (const [k, v] of Object.entries(original)) assert.deepEqual(row[k], v, `${original._id}.${k}`);
    }
    const compaction: any = view.find((m) => m._id === 'n-cmp');
    assert.equal(compaction.summary, 'Goal: ship. Progress: partial.');
    assert.equal(compaction.upto, 14);
    const approval: any = view.find((m) => m._id === 'n-app');
    assert.isFalse(approval.approved);
    assert.isNull(approval.by, 'a timed-out approval has no decider');
    assert.isTrue(approval.timedOut);
    const budget: any = view.find((m) => m._id === 'n-bud');
    assert.equal(budget.budget, 'toolCalls', 'a UI must be able to name the limit that tripped');
  });

  it('sorts notes by seq among ordinary messages', () => {
    // Shuffled input: order must come from `seq`, not from arrival.
    const view = mergeView(
      shuffle([user('u1', 10, 'Q'), errorNote, user('u2', 12, 'again'), budgetNote,
        user('u3', 14, 'ok'), approvalNote, user('u4', 16, 'more'), compactionNote], 3),
      [],
    );
    assert.deepEqual(view.map((m) => m._id),
      ['u1', 'n-err', 'u2', 'n-bud', 'u3', 'n-app', 'u4', 'n-cmp']);
    assert.deepEqual(view.map((m) => m.seq), [10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('never treats a note as in-flight, even beside a live stream', () => {
    // A note commonly sits right where a stream is running: the error note that
    // ends a turn, the compaction note written mid-turn.
    const view = mergeView([...notes, user('u1', 10, 'Q')], streamOf('m1', 'partial', { msgSeq: 18 }));
    for (const row of view.filter((m) => m.role === 'note')) {
      assert.isFalse(row.streaming, `${row._id} was marked streaming`);
      assert.isUndefined(row.truncatedHead, `${row._id} got delta-reconstruction fields`);
      assert.isUndefined(row.deltaCount, `${row._id} got delta-reconstruction fields`);
    }
    // The in-flight row is still there, still last, still streaming.
    const live = view[view.length - 1];
    assert.equal(live._id, 'm1');
    assert.isTrue(live.streaming);
    assert.equal(live.content, 'partial');
  });

  it('lets a committed note supersede stray deltas that share its id', () => {
    // Defensive: notes are written by allocateSeq with no delta stream of their
    // own, so this must never happen — but if a delta ever named a note's id,
    // the commit has to win rather than the note being rebuilt as an
    // `assistant` row out of chunks.
    const view = mergeView([compactionNote], streamOf('n-cmp', 'junk', { msgSeq: 17 }));
    assert.lengthOf(view, 1);
    assert.equal(view[0].role, 'note');
    assert.equal((view[0] as any).summary, 'Goal: ship. Progress: partial.');
    assert.isFalse(view[0].streaming);
  });
});

describe('mergeView tool-argument attribution', () => {
  // M4 Task 1. Providers stream PARALLEL tool calls interleaved, tagging each
  // fragment with the content-block index it belongs to. Joining them in
  // arrival order produces one string that looks like JSON and parses as
  // nothing — so accumulation is keyed by that index, all the way from the
  // delta document to the merged row.
  const argDelta = (
    seq: number, chunk: string, contentIndex?: number,
  ): AgentDelta => ({
    _id: `m1:${seq}`, sessionId: 's1', messageId: 'm1', msgSeq: 10, seq,
    kind: 'tool_args', chunk,
    ...(contentIndex === undefined ? {} : { contentIndex }),
    at: new Date(0),
  });

  it('keeps two interleaved tool calls apart, by contentIndex', () => {
    const view = mergeView([], [
      argDelta(0, '{"city":', 0),
      argDelta(1, '{"stock":', 1),
      argDelta(2, '"Paris"}', 0),
      argDelta(3, '"ACME"}', 1),
    ]);
    assert.lengthOf(view, 1);
    assert.deepEqual(view[0].toolArgs, {
      0: '{"city":"Paris"}',
      1: '{"stock":"ACME"}',
    });
    // Both halves are real JSON — the property the naive join destroys.
    for (const partial of Object.values(view[0].toolArgs!)) JSON.parse(partial);
  });

  it('is order-independent across shuffles, like the text stream', () => {
    const src = [
      argDelta(0, '{"a":', 0), argDelta(1, '{"b":', 1),
      argDelta(2, '1}', 0), argDelta(3, '2}', 1),
    ];
    for (let s = 1; s <= 20; s += 1) {
      assert.deepEqual(
        mergeView([], shuffle(src, s))[0].toolArgs,
        { 0: '{"a":1}', 1: '{"b":2}' },
        `seed ${s}`,
      );
    }
  });

  it('buckets index-less fragments under 0 and leaves text untouched', () => {
    const view = mergeView([], [
      delta('m1', 0, 'thinking about it '),
      argDelta(1, '{"q":'),
      argDelta(2, '1}'),
    ]);
    assert.equal(view[0].content, 'thinking about it ');
    assert.deepEqual(view[0].toolArgs, { 0: '{"q":1}' });
  });

  it('omits toolArgs entirely when no tool-argument fragment arrived', () => {
    assert.isUndefined(mergeView([], streamOf('m1', 'hello'))[0].toolArgs);
    assert.isUndefined(mergeView(committed, [])[0].toolArgs);
  });
});
