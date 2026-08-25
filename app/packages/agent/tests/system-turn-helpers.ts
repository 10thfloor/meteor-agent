import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import type { SessionParticipant } from '../common/types';

/**
 * Shared fixtures for the system-turn suites.
 *
 * The suite convention elsewhere is to COPY these idioms per file rather than
 * share them. Three files exercise one feature here — attribution and the
 * stall, idempotency and budgets, relays and recovery — and three drifting
 * copies of `finished()` would be three different definitions of "the turn is
 * over", which is exactly the race its docblock in watcher.test.ts was written
 * to kill. One definition, imported.
 */

/** Deferred work exposes no promise to await, so every wait is deadline-bounded
 *  and fails loudly rather than hanging the suite. */
export const waitFor = async (
  cond: () => Promise<boolean>, label: string, ms = 20000,
) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

/** Let deferred work that should NOT happen have its chance to happen. Every
 *  assert-an-absence test needs one of these or it proves nothing. */
export const settle = (ms = 400) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The turn is FINISHED — not merely visible. A committed assistant row is not
 * the end of a turn: the loop still clears deltas, checks for an interjection
 * and only then writes `phase: 'idle'` and releases the lease. Waiting on the
 * row and asserting on the phase is asserting state that has not been written.
 */
export const finished = async (
  sessionId: string, assistants: number,
): Promise<boolean> => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const n = await AgentMessages.find({ sessionId, role: 'assistant' }).countAsync();
  if (n !== assistants) return false;
  const doc = await AgentSessions.findOneAsync(sessionId);
  return !!doc && doc.phase === 'idle' && !doc.lease;
};

/** Retrying wipe: a turn deferred by a previous test can still be writing. */
export const clean = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const removed = (await AgentSessions.removeAsync({}))
      // eslint-disable-next-line no-await-in-loop
      + (await AgentMessages.removeAsync({}))
      // eslint-disable-next-line no-await-in-loop
      + (await AgentDeltas.removeAsync({}));
    if (removed === 0 && i > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 150); });
  }
};

/** A plain 1:1 session with NO roster — the shape scheduled work actually uses,
 *  and the one where decision 3's unconditional `from` stamp matters. */
export const seedSolo = async (
  sessionId: string, agent: string, overrides: Record<string, unknown> = {},
) => {
  const { AgentSessions } = await import('../common/collections');
  const now = new Date();
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: now, updatedAt: now,
    ...overrides,
  } as any);
};

/** A rostered session, inserted directly — the shape `addParticipant`
 *  materializes. */
export const seedRostered = async (
  sessionId: string, agent: string, userId: string | null,
  extra: SessionParticipant[] = [], overrides: Record<string, unknown> = {},
) => {
  const { AgentSessions } = await import('../common/collections');
  const now = new Date();
  const participants: SessionParticipant[] = [
    {
      id: userId === null ? 'h:anon' : `h:${userId}`,
      kind: 'human', role: 'owner', userId, displayName: 'owner', joinedAt: now,
    },
    { id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt: now },
    ...extra,
  ];
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId, phase: 'idle', model: 'mock',
    nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    participants,
    createdAt: now, updatedAt: now,
    ...overrides,
  } as any);
  return participants;
};

export const model = (agent: string): SessionParticipant => ({
  id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt: new Date(),
});

/** Answers with a fixed line, immediately. */
export const canned = (text: string): Provider => ({
  async *stream() {
    yield { kind: 'text', chunk: text };
    yield { kind: 'done', usage: { input: 1, output: 2 } };
  },
});

/** Answers slowly enough that a test can catch the session mid-`streaming` and
 *  park an intent behind a live turn. */
export const slowProvider = (text = 'a slow reply', stepMs = 12): Provider => ({
  async *stream() {
    for (const ch of text) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, stepMs); });
      yield { kind: 'text', chunk: ch };
    }
    yield { kind: 'done', usage: { input: 1, output: 5 } };
  },
});

/** Records every provider request, so a test can assert on what the MODEL was
 *  actually shown — the only way to catch the projection casting a system row
 *  straight onto the wire. */
export const recorder = (text = 'ok') => {
  const requests: any[] = [];
  const provider: Provider = {
    async *stream(req) {
      requests.push(req);
      yield { kind: 'text', chunk: text };
      yield { kind: 'done', usage: { input: 1, output: 2 } };
    },
  };
  return { provider, requests };
};

/** The system row of a session, if one was written. */
export const systemRow = async (sessionId: string) => {
  const { AgentMessages } = await import('../common/collections');
  return AgentMessages.findOneAsync({ sessionId, role: 'system' } as any);
};

export const countRole = async (sessionId: string, role: string) => {
  const { AgentMessages } = await import('../common/collections');
  return AgentMessages.find({ sessionId, role } as any).countAsync();
};
