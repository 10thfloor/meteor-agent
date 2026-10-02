// What the server and the browser both need to know about Threads, the
// surface on `10thfloor:durable`. Nothing here touches Meteor.

/** The `Durable` definition's name: a thread's storage is `threads/<thread id>`. */
export const DURABLE_DEFINITION = 'threads';

/** The document a conversation's plan lives in. */
export const DURABLE_PLAN_KIND = 'constellation.plan';

export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'done']);

/** A catalog model ID is `provider/modelId`; the model part may itself contain slashes. */
export function splitModelId(id) {
  const slash = String(id).indexOf('/');
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Not a model ID: ${JSON.stringify(id)}`);
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/** Dollars in one usage record of Pi Durable's (`pi.usage`, or a session's total): every model and tool bucket. */
export function threadSpend(usage) {
  let total = 0;
  for (const bucket of [usage?.models, usage?.tools]) {
    for (const entry of Object.values(bucket ?? {})) {
      const cost = Number(entry?.cost?.total);
      if (Number.isFinite(cost)) total += cost;
    }
  }
  return total;
}

/** Tokens in one usage record: what was sent, and what came back. */
export function threadTokens(usage) {
  let input = 0;
  let output = 0;
  for (const bucket of [usage?.models, usage?.tools]) {
    for (const entry of Object.values(bucket ?? {})) {
      input += (Number(entry?.input) || 0) + (Number(entry?.cacheRead) || 0) + (Number(entry?.cacheWrite) || 0);
      output += Number(entry?.output) || 0;
    }
  }
  return { input, output };
}

/** A thread's title, from the first thing said in it. */
export function titleFromInput(text, max = 60) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (line === '') return 'New thread';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The text of a pi-ai message's content, without images or tool calls. */
export function messageText(message) {
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap((part) => (part?.type === 'text' ? [part.text] : [])).join('');
}

/**
 * A conversation's entries as the rows a transcript shows, oldest first.
 * `entries` are Pi Durable entry records; `head` is where the active context
 * begins, so a row before it is something the model no longer sees.
 */
export function transcriptRows(entries) {
  let head;
  for (const entry of entries) if (entry.head !== undefined) head = entry.head;
  const rows = [];
  for (const entry of entries) {
    const message = entry.model?.[0];
    const past = head !== undefined && entry.id < head;
    switch (entry.kind) {
      case 'pi.user':
        rows.push({ id: entry.id, kind: 'user', text: messageText(message), past });
        break;
      case 'pi.assistant': {
        const calls = (Array.isArray(message?.content) ? message.content : [])
          .filter((part) => part?.type === 'toolCall')
          .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments }));
        const text = messageText(message);
        const stopped = message?.stopReason === 'aborted' || message?.stopReason === 'error';
        if (text !== '' || calls.length === 0 || stopped) {
          rows.push({
            id: entry.id,
            kind: 'assistant',
            text,
            past,
            // Stopped by a person, or left unfinished by a server that went away: the entry does not say which.
            ...(message?.stopReason === 'aborted' ? { note: 'Cut short' } : {}),
            ...(message?.stopReason === 'error' ? { note: message.errorMessage || 'The model request failed' } : {}),
          });
        }
        for (const call of calls) rows.push({ id: entry.id, kind: 'call', call, past });
        break;
      }
      case 'pi.tool-result':
        rows.push({
          id: entry.id,
          kind: 'result',
          callId: message?.toolCallId,
          name: message?.toolName,
          text: messageText(message),
          failed: message?.isError === true,
          past,
        });
        break;
      case 'pi.reset':
        rows.push({ id: entry.id, kind: 'marker', text: 'New context', detail: messageText(message), past: false });
        break;
      case 'pi.compaction':
        rows.push({ id: entry.id, kind: 'marker', text: 'Earlier messages were summarized', past: false });
        break;
      default:
        break;
    }
  }
  return rows;
}
