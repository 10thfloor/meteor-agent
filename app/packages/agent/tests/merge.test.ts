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
