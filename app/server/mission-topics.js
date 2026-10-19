// Topics on the server: creating, renaming and archiving them, resolving any conversation to its Mission, and keeping
// every topic and thread on the Mission's crew. See imports/constellation/topics.js for the model.
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';
import {
  conversationHop, isMissionRoot, MISSION_ROOT_SELECTOR, normalizeTopicName, topicLabel, topicNameProblem,
} from '../imports/constellation/topics';

export const MissionTopics = new Mongo.Collection('constellation_mission_topics');

const LIVE = Object.freeze({ erasingAt: { $exists: false } });
const MAX_DEPTH = 8;

/** The session at the top of a conversation's subagent tree (the topic or thread itself for its own work). */
export async function conversationRoot(Sessions, sessionId) {
  let session = sessionId ? await Sessions.findOneAsync(sessionId) : null;
  for (let depth = 0; session?.parent?.sessionId && depth < MAX_DEPTH; depth += 1) {
    session = await Sessions.findOneAsync(session.parent.sessionId);
  }
  return session ?? null;
}

/** The Mission (#general's session) any session belongs to: its subagents, its topics and their threads. */
export async function missionRoot(Sessions, sessionId) {
  let session = await conversationRoot(Sessions, sessionId);
  for (let hop = 0; session && conversationHop(session) && hop < 4; hop += 1) {
    session = await conversationRoot(Sessions, conversationHop(session));
  }
  return isMissionRoot(session) ? session : null;
}

/** #general, every topic and every thread of one Mission, #general first. */
export async function missionConversationIds(Sessions, userId, missionId) {
  const topics = await Sessions.find(
    { userId, 'missionTopic.missionId': missionId, ...LIVE }, { fields: { _id: 1 } },
  ).fetchAsync();
  const owners = [missionId, ...topics.map((row) => row._id)];
  const threads = await Sessions.find(
    { userId, 'thread.sessionId': { $in: owners }, ...LIVE }, { fields: { _id: 1 } },
  ).fetchAsync();
  return [...owners, ...threads.map((row) => row._id)];
}

const sameRoster = (a = [], b = []) => JSON.stringify(a.map(({ id, kind, role, agent, userId, displayName }) => (
  [id, kind, role, agent, userId, displayName]))) === JSON.stringify(b.map(({ id, kind, role, agent, userId, displayName }) => (
  [id, kind, role, agent, userId, displayName])));

export function installMissionTopics({
  AgentSessions, orchestrator, claimWorkspace, ensureMissionConfig, stopConversation,
}) {
  const ownedMission = async (userId, missionId) => {
    const mission = await AgentSessions.findOneAsync({
      _id: missionId, userId, agent: 'orchestrator', 'parent.sessionId': { $exists: false },
      ...MISSION_ROOT_SELECTOR, ...LIVE,
    });
    if (!mission) throw new Meteor.Error('no-session', 'Mission not found.');
    return mission;
  };
  const ownedTopic = async (userId, topicId) => {
    const topic = await MissionTopics.findOneAsync({ _id: topicId, userId });
    if (!topic) throw new Meteor.Error('no-topic', 'Topic not found.');
    await ownedMission(userId, topic.missionId);
    return topic;
  };
  const cleanName = async (userId, missionId, value, exceptId) => {
    const name = normalizeTopicName(value);
    const taken = (await MissionTopics.find(
      { userId, missionId, archivedAt: { $exists: false }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
      { fields: { name: 1 } },
    ).fetchAsync()).map((row) => row.name);
    const problem = topicNameProblem(name, taken);
    if (problem) throw new Meteor.Error('invalid-topic', problem);
    return name;
  };

  // A topic or thread carries the Mission's roster. #general's roster is the one every crew method edits; copy it to
  // the Mission's other conversations whenever it changes, so no method has to know about topics.
  const mirrorQueue = new Map();
  const mirrorRoster = async (userId, missionId) => {
    const mission = await AgentSessions.findOneAsync({ _id: missionId, userId, ...LIVE }, { fields: { participants: 1 } });
    if (!mission) return;
    const ids = (await missionConversationIds(AgentSessions, userId, missionId)).filter((id) => id !== missionId);
    if (!ids.length) return;
    const targets = await AgentSessions.find({ _id: { $in: ids }, userId, ...LIVE }, { fields: { participants: 1 } }).fetchAsync();
    const stale = targets.filter((row) => !sameRoster(row.participants, mission.participants)).map((row) => row._id);
    if (!stale.length) return;
    await AgentSessions.updateAsync(
      { _id: { $in: stale }, userId, ...LIVE },
      { $set: { participants: mission.participants ?? [], updatedAt: new Date() } },
      { multi: true },
    );
  };
  const queueMirror = (userId, missionId) => {
    const previous = mirrorQueue.get(missionId) ?? Promise.resolve();
    const next = previous.then(() => mirrorRoster(userId, missionId)).catch((error) => {
      console.warn('[constellation] Topic crew update failed:', error?.message ?? error);
    });
    mirrorQueue.set(missionId, next);
    next.finally(() => { if (mirrorQueue.get(missionId) === next) mirrorQueue.delete(missionId); });
    return next;
  };

  Meteor.startup(async () => {
    await MissionTopics.rawCollection().createIndex({ userId: 1, missionId: 1, createdAt: 1 });
    // `activeName` is the name while the topic is in the list; archiving removes it, so an archived name can be reused.
    await MissionTopics.rawCollection().createIndex(
      { missionId: 1, activeName: 1 },
      { unique: true, partialFilterExpression: { activeName: { $exists: true } } },
    );
    await AgentSessions.rawCollection().createIndex(
      { userId: 1, 'missionTopic.missionId': 1 },
      { partialFilterExpression: { missionTopic: { $exists: true } } },
    );
    // Missions with other conversations are brought up to date once, then kept so.
    const missions = await MissionTopics.rawCollection().distinct('missionId');
    for (const missionId of missions) {
      const mission = await AgentSessions.findOneAsync(missionId, { fields: { userId: 1 } });
      if (mission) await queueMirror(mission.userId, missionId);
    }
    await AgentSessions.find(
      { agent: 'orchestrator', 'parent.sessionId': { $exists: false }, ...MISSION_ROOT_SELECTOR, ...LIVE },
      { fields: { participants: 1, userId: 1 } },
    ).observeChangesAsync({
      changed(id, fields) {
        if (!('participants' in fields)) return;
        AgentSessions.findOneAsync(id, { fields: { userId: 1 } })
          .then((row) => row && queueMirror(row.userId, id));
      },
    });
  });

  Meteor.methods({
    async 'constellation.topicCreate'(missionId, name) {
      check(missionId, String);
      check(name, String);
      await claimWorkspace(this.userId);
      const userId = this.userId;
      const mission = await ownedMission(userId, missionId);
      if (mission.archived) throw new Meteor.Error('mission-archived', 'Unarchive this Mission before adding a topic.');
      await ensureMissionConfig(userId, mission);
      const clean = await cleanName(userId, missionId, name);
      // A fork at the start copies nothing but the roster: an empty conversation with the Mission's crew.
      const topicId = await orchestrator.fork(missionId, { atSeq: 0, title: topicLabel(clean), userId });
      const now = new Date();
      try {
        await MissionTopics.insertAsync({
          _id: topicId, missionId, userId, name: clean, activeName: clean, createdAt: now, updatedAt: now,
        });
      } catch (error) {
        await orchestrator.erase?.(topicId, { userId }).catch(() => {});
        if (error?.code === 11000) throw new Meteor.Error('invalid-topic', `#${clean} already exists.`);
        throw error;
      }
      await AgentSessions.updateAsync(
        { _id: topicId, userId, ...LIVE },
        { $set: { missionTopic: { missionId }, updatedAt: now }, $unset: { forkedFrom: '' }, $max: { nextSeq: 1 } },
      );
      await queueMirror(userId, missionId);
      return { _id: topicId, missionId, name: clean };
    },

    async 'constellation.topicRename'(topicId, name) {
      check(topicId, String);
      check(name, String);
      await claimWorkspace(this.userId);
      const userId = this.userId;
      const topic = await ownedTopic(userId, topicId);
      const clean = await cleanName(userId, topic.missionId, name, topicId);
      if (clean === topic.name) return clean;
      try {
        await MissionTopics.updateAsync(
          { _id: topicId, userId },
          { $set: { name: clean, ...(topic.archivedAt ? {} : { activeName: clean }), updatedAt: new Date() } },
        );
      } catch (error) {
        if (error?.code === 11000) throw new Meteor.Error('invalid-topic', `#${clean} already exists.`);
        throw error;
      }
      await AgentSessions.updateAsync({ _id: topicId, userId, ...LIVE }, { $set: { title: topicLabel(clean), updatedAt: new Date() } });
      return clean;
    },

    // Archiving stops the topic's work and takes it out of the list. Its transcript stays; unarchive brings it back.
    async 'constellation.topicArchive'(topicId) {
      check(topicId, String);
      await claimWorkspace(this.userId);
      const userId = this.userId;
      const topic = await ownedTopic(userId, topicId);
      if (topic.archivedAt) return true;
      const session = await AgentSessions.findOneAsync({ _id: topicId, userId, ...LIVE });
      if (session) await stopConversation(userId, session);
      await MissionTopics.updateAsync(
        { _id: topicId, userId },
        { $set: { archivedAt: new Date(), updatedAt: new Date() }, $unset: { activeName: '' } },
      );
      return true;
    },

    // Which Mission each session belongs to, for the Mission's Reviews: learning is recorded against the session
    // where it happened, which may be a specialist's, a topic's or a thread's. Unknown or foreign ids map to null.
    async 'constellation.sessionMissions'(sessionIds) {
      check(sessionIds, [String]);
      if (!this.userId) throw new Meteor.Error('not-authorized', 'Sign in to view reviews.');
      if (sessionIds.length > 400) throw new Meteor.Error('invalid-request', 'Ask for at most 400 sessions.');
      const result = {};
      for (const id of new Set(sessionIds)) {
        const root = await missionRoot(AgentSessions, id);
        result[id] = root?.userId === this.userId ? root._id : null;
      }
      return result;
    },

    async 'constellation.topicUnarchive'(topicId) {
      check(topicId, String);
      await claimWorkspace(this.userId);
      const userId = this.userId;
      const topic = await ownedTopic(userId, topicId);
      if (!topic.archivedAt) return topic.name;
      // The name may have been reused while it was archived.
      const clean = await cleanName(userId, topic.missionId, topic.name, topicId).catch(() => null);
      if (!clean) throw new Meteor.Error('invalid-topic', `#${topic.name} is in use. Rename the other topic first.`);
      try {
        await MissionTopics.updateAsync(
          { _id: topicId, userId },
          { $unset: { archivedAt: '' }, $set: { activeName: clean, updatedAt: new Date() } },
        );
      } catch (error) {
        if (error?.code === 11000) throw new Meteor.Error('invalid-topic', `#${clean} is in use. Rename the other topic first.`);
        throw error;
      }
      return clean;
    },
  });

  // Topic rows, plus what the list needs from each topic's session: whether an agent is working, whether an approval
  // waits, and how far the conversation has gone (for unread).
  Meteor.publish('constellation.missionTopics', function publishMissionTopics() {
    if (!this.userId) return this.ready();
    return [
      MissionTopics.find({ userId: this.userId }, { fields: { userId: 0 } }),
      AgentSessions.find(
        { userId: this.userId, missionTopic: { $exists: true }, ...LIVE },
        {
          fields: {
            missionTopic: 1, title: 1, phase: 1, nextSeq: 1, updatedAt: 1, createdAt: 1,
            'pending.toolCallId': 1, usage: 1, budgetSpent: 1,
          },
        },
      ),
    ];
  });

  return { mirrorRoster: queueMirror };
}
