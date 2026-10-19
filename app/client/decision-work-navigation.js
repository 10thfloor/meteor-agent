import { resolveDecisionWorkMessage } from '../imports/constellation/decision-work-target';

/** Reveal saved work only. Navigation must never schedule a new agent turn. */
export function createDecisionWorkNavigator(host, { timeoutMs = 4000, pollMs = 50 } = {}) {
  let generation = 0;
  return async function openDecisionWork(sessionId, agent, continuation = {}) {
    const request = ++generation;
    let chat;
    let isCurrent;
    try {
      if (!sessionId) throw new Error('Missing conversation');
      if (host.isMission(sessionId)) {
        // Reselecting the current mission resets composer mode. Only change
        // views here, so following a card preserves the user's unfinished note.
        if (host.currentMission() !== sessionId) host.openMission(sessionId);
        else host.showMission();
        chat = host.rootChat();
        isCurrent = () => host.currentMission() === sessionId && host.missionVisible();
      } else {
        const dialog = host.openChild(sessionId, agent);
        chat = dialog?.querySelector('agent-chat');
        isCurrent = () => dialog?.open && dialog.querySelector('agent-chat') === chat;
      }
      if (!continuation.key) {
        host.toast('This decision’s reply cannot be located. Inspect its history for the recorded result.');
        return false;
      }
      const deadline = Date.now() + timeoutMs;
      do {
        // Allow session hydration and the custom element's reactive paint to
        // finish before looking for a visible message. New navigation cancels
        // the request instead of pulling the user back to an old conversation.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (request !== generation || !chat?.isConnected || !isCurrent()) return false;
        if (chat.sessionId !== sessionId) continue;
        const rows = chat.agentInstance?.messages(sessionId).fetch() ?? [];
        const messageId = resolveDecisionWorkMessage(rows, { sessionId, agent, key: continuation.key });
        if (messageId && chat.revealMessage(messageId)) return true;
      } while (Date.now() < deadline);
      host.toast(['preparing', 'queued', 'resumed', 'working', 'waiting'].includes(continuation.status)
        ? 'No reply from this continuation yet. Inspect the decision for its current status.'
        : 'The reply is not available in this transcript. Inspect the decision’s history for the recorded result.');
    } catch {
      if (request === generation) host.toast('Could not open this work. Try again or inspect the decision’s history.', 'error');
    }
    return false;
  };
}
