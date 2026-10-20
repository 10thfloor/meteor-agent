// Topics: the #-named conversations inside a Mission.
//
// A Mission's first conversation is #general and keeps the Mission's id. Every other topic is its own agent session,
// marked on the session as `missionTopic: { missionId }` and listed in `constellation_mission_topics`. A thread is a
// session forked from one message of a topic (`thread: { sessionId, seq, messageId }`, written by the agent package).
// Both share the Mission's crew, files, plans, decisions and settings.

export const GENERAL_TOPIC = 'general';
export const TOPIC_NAME_MAX = 40;
export const TOPIC_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** "Pricing Tiers!" as "pricing-tiers". Returns '' when nothing usable is left. */
export function normalizeTopicName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, TOPIC_NAME_MAX)
    .replace(/-+$/, '');
}

/** Why a name can't be used, or null when it can. `taken` holds the Mission's other topic names. */
export function topicNameProblem(name, taken = []) {
  if (!name) return 'Use letters, numbers or dashes.';
  if (!TOPIC_NAME_PATTERN.test(name)) return 'Use letters, numbers or dashes.';
  if (name === GENERAL_TOPIC) return '#general already exists.';
  if (taken.includes(name)) return `#${name} already exists.`;
  return null;
}

export const topicLabel = (name) => `#${name || GENERAL_TOPIC}`;

/** The session a conversation root belongs to: a thread's topic, or a topic's Mission. */
export function conversationHop(session) {
  return session?.thread?.sessionId ?? session?.missionTopic?.missionId ?? null;
}

/** A Mission is a root orchestrator session that is neither a topic nor a thread. */
export function isMissionRoot(session) {
  return session?.agent === 'orchestrator' && !session.parent?.sessionId
    && !session.missionTopic && !session.thread;
}

/** Mongo selector fragment for listings of Missions. */
export const MISSION_ROOT_SELECTOR = Object.freeze({
  missionTopic: { $exists: false },
  thread: { $exists: false },
});
