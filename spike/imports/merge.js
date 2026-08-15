// The §4.4 merge: committed messages + in-flight deltas -> one ordered view.
// Isomorphic and PURE so it can be tested without a client.
//
// Two properties drive the design:
//   1. A capped collection evicts the OLDEST documents, so any gap in delta
//      seq numbers is a missing HEAD. Rendering a "contiguous prefix from 0"
//      would therefore render nothing. We render the contiguous TAIL and flag
//      truncatedHead so the UI can show a leading ellipsis.
//   2. A committed message always supersedes deltas for the same messageId.
//      Deltas may still arrive (or be evicted) after commit; both are no-ops.

export function mergeView(committedMessages, deltaDocs) {
  const committed = [...committedMessages].map((m) => ({ ...m, streaming: false }));
  const committedIds = new Set(committed.map((m) => m._id));

  // Dedupe by _id, drop deltas belonging to an already-committed message.
  const seen = new Set();
  const byMessage = new Map();
  for (const d of deltaDocs) {
    if (seen.has(d._id)) continue;
    seen.add(d._id);
    if (committedIds.has(d.messageId)) continue;
    if (!byMessage.has(d.messageId)) byMessage.set(d.messageId, []);
    byMessage.get(d.messageId).push(d);
  }

  const inFlight = [];
  for (const [messageId, ds] of byMessage) {
    ds.sort((a, b) => a.seq - b.seq);

    // Contiguous TAIL: walk back from the highest seq while seq decrements by 1.
    let cut = ds.length - 1;
    while (cut > 0 && ds[cut].seq - ds[cut - 1].seq === 1) cut -= 1;
    const tail = ds.slice(cut);
    const truncatedHead = tail[0].seq !== 0;

    const text = tail.filter((d) => d.kind === 'text').map((d) => d.chunk).join('');
    const thinking = tail.filter((d) => d.kind === 'thinking').map((d) => d.chunk).join('');
    const toolOutput = tail.filter((d) => d.kind === 'tool_output').map((d) => d.chunk).join('');

    inFlight.push({
      _id: messageId,
      sessionId: ds[0].sessionId,
      seq: ds[0].msgSeq,
      role: 'assistant',
      content: text,
      thinking: thinking || undefined,
      toolOutput: toolOutput || undefined,
      streaming: true,
      truncatedHead,
      deltaCount: tail.length,
    });
  }

  return [...committed, ...inFlight].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a._id < b._id ? -1 : 1; // stable tiebreak
  });
}

// Rendered text of a merged view — what a user would actually see.
export function renderText(view) {
  return view.map((m) => (m.truncatedHead ? `…${m.content}` : m.content)).join('|');
}
