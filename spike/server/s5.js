// S5 — adversarial tests for the §4.4 merge. Pure, so no client needed.
import { mergeView, renderText } from '../imports/merge.js';

const delta = (messageId, seq, chunk, opts = {}) => ({
  _id: `${messageId}:${seq}`,
  sessionId: 's1',
  messageId,
  msgSeq: opts.msgSeq ?? 10,
  seq,
  kind: opts.kind ?? 'text',
  chunk,
});

const streamOf = (messageId, text, opts = {}) =>
  text.split('').map((c, i) => delta(messageId, i, c, opts));

// Deterministic shuffle (LCG) so failures reproduce.
function shuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function s5Report() {
  const cases = [];
  const check = (name, actual, expected) =>
    cases.push({ name, pass: actual === expected, actual, expected });

  // 1. Baseline — in-order deltas, nothing committed.
  check('baseline in-order', renderText(mergeView([], streamOf('m1', 'hello'))), 'hello');

  // 2. Order independence — 50 deterministic shuffles must all agree.
  const src = streamOf('m1', 'hello world');
  let orderIndependent = true;
  for (let s = 1; s <= 50; s += 1) {
    if (renderText(mergeView([], shuffle(src, s))) !== 'hello world') orderIndependent = false;
  }
  check('order independence (50 shuffles)', orderIndependent, true);

  // 3. Duplicate delivery is deduped.
  check('duplicates deduped', renderText(mergeView([], [...src, ...src])), 'hello world');

  // 4. Commit supersedes deltas — no phantom in-flight copy.
  const committed = [{ _id: 'm1', sessionId: 's1', seq: 10, role: 'assistant', content: 'hello world' }];
  check('commit supersedes deltas', renderText(mergeView(committed, src)), 'hello world');

  // 5. HEAD eviction — the capped-collection case. seqs 0-5 evicted.
  const evictedHead = streamOf('m1', 'hello world').filter((d) => d.seq >= 6);
  check('head eviction renders tail', renderText(mergeView([], evictedHead)), '…world');

  // 6. Mid gap — only the contiguous tail is rendered.
  const midGap = streamOf('m1', 'abcdefghij').filter((d) => d.seq <= 2 || d.seq >= 7);
  check('mid gap renders contiguous tail', renderText(mergeView([], midGap)), '…hij');

  // 7. Deltas arriving AFTER their message committed are inert.
  const lateDeltas = [...src, delta('m1', 99, 'X')];
  check('late deltas after commit inert', renderText(mergeView(committed, lateDeltas)), 'hello world');

  // 8. Interleaved messages order by msgSeq, not arrival.
  const two = shuffle(
    [...streamOf('mA', 'AAA', { msgSeq: 11 }), ...streamOf('mB', 'BBB', { msgSeq: 12 })],
    7,
  );
  check('interleaved messages ordered', renderText(mergeView([], two)), 'AAA|BBB');

  // 9. Committed and in-flight interleave correctly by seq.
  const mixed = mergeView(
    [{ _id: 'm0', sessionId: 's1', seq: 9, role: 'user', content: 'Q' }],
    streamOf('m1', 'A', { msgSeq: 10 }),
  );
  check('committed + in-flight ordering', renderText(mixed), 'Q|A');

  // 10. Non-text kinds do not leak into content.
  const withThinking = [
    ...streamOf('m1', 'hi'),
    delta('m1', 2, 'ponder', { kind: 'thinking' }),
  ];
  check('thinking excluded from content', renderText(mergeView([], withThinking)), 'hi');

  // 11. Degenerate inputs.
  check('empty everything', renderText(mergeView([], [])), '');
  check('committed only', renderText(mergeView(committed, [])), 'hello world');

  // 12. Single delta with seq > 0 (whole head evicted) still renders.
  check('single late delta', renderText(mergeView([], [delta('m1', 7, 'z')])), '…z');

  // 13. Idempotency — merging a view's inputs twice is stable.
  const once = renderText(mergeView([], src));
  const twice = renderText(mergeView([], [...src]));
  check('idempotent', once === twice, true);

  const failures = cases.filter((c) => !c.pass);
  return { pass: failures.length === 0, total: cases.length, failures, cases };
}
