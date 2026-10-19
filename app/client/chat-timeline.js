// Each integration owns one source. Updating plan runs must not remove decision
// cards (or vice versa), including when a reactive subscription briefly empties.
const timelines = new WeakMap();

export function setChatTimelineSource(chat, source, items) {
  let sources = timelines.get(chat);
  if (!sources) { sources = new Map(); timelines.set(chat, sources); }
  if (items.length) sources.set(source, items);
  else sources.delete(source);
  chat.timelineItems = [...sources.values()].flat();
}
