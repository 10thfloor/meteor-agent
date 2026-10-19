const sequence = (value) => Number.isSafeInteger(value) && value >= 0;
const hasText = (row) => typeof row.content === 'string' && row.content.trim().length > 0;
const hasCalls = (row) => Array.isArray(row.toolCalls) && row.toolCalls.length > 0;
const modelAddress = (value) => typeof value === 'string' && value.startsWith('m:');

/**
 * Find a visible receipt for one exact approval continuation, not the newest
 * message in its conversation. This is deliberately conservative: ViewMessages
 * do not carry trace ids, and answeredThrough covers user rows, not system rows.
 * A null result means the caller should keep the conversation open without
 * claiming an unrelated message is the result.
 */
export function resolveDecisionWorkMessage(rows, { sessionId, key, agent } = {}) {
  if (!Array.isArray(rows) || ![sessionId, key, agent].every(
    (value) => typeof value === 'string' && value.length > 0,
  )) return null;

  // Streaming reconstructions lack the answeredThrough watermark and may share
  // a provisional sequence with an interjection. Only durable rows prove work.
  const messages = rows.filter((row) => row?.sessionId === sessionId
    && row.streaming !== true && sequence(row.seq) && typeof row._id === 'string')
    .sort((left, right) => left.seq - right.seq);
  const triggers = messages.filter((row) => row._id === `sys:${sessionId}:${key}`);
  if (triggers.length !== 1) return null;
  const trigger = triggers[0];
  if (trigger.role !== 'system'
    || (trigger.to !== undefined && trigger.to !== `m:${agent}`)
    || (trigger.from !== undefined && trigger.from?.participant !== 's:decision-review')) return null;

  const after = messages.filter((row) => row.seq > trigger.seq);
  const seen = new Set([trigger.seq]);
  for (const row of after) {
    if (seen.has(row.seq)) return null;
    seen.add(row.seq);
  }
  // A later system intent or model-to-model relay is a new cause. There is no
  // system/relay equivalent of answeredThrough to disambiguate its replies.
  const boundary = after.find((row) => row.role === 'system'
    || (row.role === 'assistant' && modelAddress(row.to)))?.seq ?? Infinity;
  const window = after.filter((row) => row.seq < boundary);
  const nextInput = window.find((row) => row.role === 'user' && row.kind !== 'crew-note')?.seq
    ?? Infinity;
  const previousUserSeq = messages.reduce((latest, row) => (
    row.seq < trigger.seq && row.role === 'user' ? Math.max(latest, row.seq) : latest
  ), 0);
  const sameActor = (row) => row.from === undefined || row.from?.participant === `m:${agent}`;
  const belongs = (row) => {
    if (row.role !== 'assistant' || !sameActor(row)) return false;
    const watermark = row.answeredThrough;
    if (watermark !== undefined && (!sequence(watermark)
      || watermark >= row.seq || watermark < previousUserSeq)) return false;
    // A reply may commit after a newer human request without having seen it.
    // Crew notes are context, not new requests, and do not end the continuation.
    if (row.seq > nextInput && (!sequence(watermark) || watermark >= nextInput)) return false;
    return true;
  };
  const assistants = window.filter(belongs);
  const final = assistants.filter((row) => !hasCalls(row)
    && (hasText(row) || row.attachments?.length)).at(-1);
  if (final) return final._id;

  // Tool ids are unique only inside one assistant response. Attribute a receipt
  // to the immediately preceding assistant, never to an old matching call id.
  let precedingAssistant = null;
  const receipts = [];
  for (const row of window) {
    if (row.role === 'assistant') {
      precedingAssistant = row;
      continue;
    }
    const linked = !!row.toolCallId && precedingAssistant && belongs(precedingAssistant)
      && precedingAssistant.toolCalls?.some((call) => call.id === row.toolCallId);
    if (row.role === 'tool' && linked && sameActor(row)) receipts.push(row);
    if (row.role !== 'note') continue;
    if (row.kind === 'approval' && linked) receipts.push(row);
    else if (['error', 'budget', 'interrupted'].includes(row.kind)
      && row.seq < nextInput && sameActor(row)
      && (!precedingAssistant || belongs(precedingAssistant))) receipts.push(row);
  }
  if (receipts.length) return receipts.at(-1)._id;
  // An operation proposal is useful while waiting for approval, but never wins
  // over a finished answer or an exact failure/completion receipt.
  return assistants.filter((row) => hasText(row) || hasCalls(row)).at(-1)?._id ?? null;
}
