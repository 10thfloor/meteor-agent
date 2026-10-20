// Agent colours in chat: every <agent-chat> on the page gets the same agent → colour map, taken from the crew
// configs, and keeps it current when an agent's colour changes. The colours are the --crew-* tokens in main.css,
// so the chat's names match the crew avatars.
import { Tracker } from 'meteor/tracker';

const CREW_COLORS = new Set(['amber', 'blue', 'green', 'red', 'violet', 'steel']);

/** Agent id → CSS colour, for the agents whose config names one of the crew colours. */
export function crewAgentColors(configs) {
  return Object.fromEntries((configs ?? [])
    .filter((config) => config?.agent && CREW_COLORS.has(config.color))
    .map((config) => [config.agent, `var(--crew-${config.color})`]));
}

/** Keeps every chat handed to `color()` on the current map. `readConfigs` is reactive. */
export function trackAgentColors(readConfigs) {
  const chats = new Set();
  let colors = {};
  Tracker.autorun(() => {
    colors = crewAgentColors(readConfigs());
    for (const chat of chats) {
      if (chat.isConnected) chat.agentColors = colors;
      else chats.delete(chat);
    }
  });
  return {
    color(chat) {
      if (!chat) return;
      chats.add(chat);
      chat.agentColors = colors;
    },
  };
}
