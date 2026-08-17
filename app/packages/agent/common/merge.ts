import type { AgentDelta, AgentMessage, ViewMessage } from './types';

/**
 * Merge committed messages with in-flight deltas into one ordered view.
 *
 * A capped collection evicts the OLDEST documents, so a gap in delta `seq` is
 * always a missing HEAD. Walking forward from seq 0 would render an empty
 * string for any message whose start had aged out — the routine case. We walk
 * back from the highest seq instead and flag `truncatedHead`.
 */
export function mergeView(
  committedMessages: AgentMessage[],
  deltaDocs: AgentDelta[],
): ViewMessage[] {
  const committed: ViewMessage[] = committedMessages.map((m) => ({ ...m, streaming: false }));
  const committedIds = new Set(committed.map((m) => m._id));

  const seen = new Set<string>();
  const byMessage = new Map<string, AgentDelta[]>();
  for (const d of deltaDocs) {
    if (seen.has(d._id)) continue;
    seen.add(d._id);
    if (committedIds.has(d.messageId)) continue;   // commit always wins
    const bucket = byMessage.get(d.messageId);
    if (bucket) bucket.push(d);
    else byMessage.set(d.messageId, [d]);
  }

  const inFlight: ViewMessage[] = [];
  for (const [messageId, ds] of byMessage) {
    ds.sort((a, b) => a.seq - b.seq);

    let cut = ds.length - 1;
    while (cut > 0 && ds[cut].seq - ds[cut - 1].seq === 1) cut -= 1;
    const tail = ds.slice(cut);

    const join = (kind: AgentDelta['kind']) =>
      tail.filter((d) => d.kind === kind).map((d) => d.chunk).join('');

    // Tool arguments are accumulated PER contentIndex, unlike text and
    // thinking, which are one stream each. Providers interleave parallel tool
    // calls, so a single joined string would be two calls' JSON spliced
    // together — valid-looking and unparseable. A delta with no index (a
    // provider that reports none) buckets under 0.
    let toolArgs: Record<number, string> | undefined;
    for (const d of tail) {
      if (d.kind !== 'tool_args') continue;
      const idx = typeof d.contentIndex === 'number' ? d.contentIndex : 0;
      if (!toolArgs) toolArgs = {};
      toolArgs[idx] = (toolArgs[idx] ?? '') + d.chunk;
    }

    const thinking = join('thinking');
    inFlight.push({
      _id: messageId,
      sessionId: ds[0].sessionId,
      seq: ds[0].msgSeq,
      role: 'assistant',
      content: join('text'),
      thinking: thinking || undefined,
      streaming: true,
      truncatedHead: tail[0].seq !== 0,
      deltaCount: tail.length,
      ...(toolArgs ? { toolArgs } : {}),
    });
  }

  return [...committed, ...inFlight].sort((a, b) =>
    a.seq !== b.seq ? a.seq - b.seq : (a._id < b._id ? -1 : 1));
}
