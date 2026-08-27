import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentSessions } from '../common/collections';
import { buildRunConfig, getAgent } from './registry';
import { COMPACT_OVER_BUDGET, COMPACT_REFUSALS, compactSession } from './compaction';
import { forkSession } from './fork';
import { MAX_SUBAGENT_DEPTH } from './subagent';
import {
  ACTIVE_PHASES, type AgentSession, type AttachmentRef,
} from '../common/types';
import { consumeSystemIntent, type SystemTurnResult } from './system-turn';
import type { SessionQuery, SessionSet } from '../common/db';
import {
  humanParticipantId, identityParticipantId, participantByIdentity,
  participantByUserId, resolveAddressee,
} from '../common/participants';
import { issueAttachmentToken } from './downloads';
import { beginSessionMutationOperation } from './session-operations';
import { activate, requestSystemTurn } from './activation';
import { commitOperationMessage, commitUserMessage } from './transcript';

/** Verified channel identity (decision 12); server-side only, never from DDP. */
export interface ViaIdentity { kind: string; externalUserId: string }

/** Authorize by agent + userId (or roster membership / via identity).
 *  Same error for "not found" and "not yours" to avoid confirming ids. */
export async function requireSession(
  agent: string, sessionId: string, userId: string | null, via?: ViaIdentity,
) {
  const clauses: SessionQuery[] = [{ userId }];
  if (userId !== null) {
    clauses.push({ participants: { $elemMatch: { kind: 'human', userId } } });
  }
  if (via) {
    clauses.push({
      participants: {
        $elemMatch: {
          kind: 'human',
          'identity.kind': via.kind,
          'identity.externalUserId': via.externalUserId,
        },
      },
    });
  }
  const session = await AgentSessions.findOneAsync({
    _id: sessionId, agent, erasingAt: { $exists: false }, $or: clauses,
  });
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

/** Single-winner verdict write + audit row. Shared by human approve/deny and
 *  the watcher's timeout. Returns whether THIS caller won. No auth here. */
async function writeVerdict(
  sessionId: string,
  verdict: 'approved' | 'denied',
  by: string | null,
  reason: string | undefined,
  timedOut = false,
): Promise<boolean> {
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) return false;
  try {
    const $set: SessionSet = {
      'pending.verdict': verdict,
      'pending.by': by,
      // Written atomically with the verdict. Activation snapshots it and the
      // Turn's exact Lease claim rejects a superseded verdict.
      'pending.wakeToken': Random.id(),
      phase: 'idle',
      updatedAt: new Date(),
    };
    // Only when given: `$set` with an undefined value is not a field write.
    if (reason !== undefined) $set['pending.reason'] = reason;

    await operation.assertActive();
    const won = await AgentSessions.updateAsync(
      {
        _id: sessionId,
        phase: 'awaiting',
        'pending.verdict': { $exists: false },
      },
      { $set },
    );
    // Zero matched means someone else answered between our read and our write.
    if (won !== 1) return false;

    // Audit row: direct atomic seq allocation (no lease held when parked).
    const auditSeq = await commitOperationMessage(
      operation,
      sessionId,
      Random.id(),
      {},
      {},
      (before) => {
        // This pre-image is after the verdict write, so `pending` still carries
        // the exact Gate identity and any escalated runAs value being audited.
        const parked = before.pending;
        return {
          role: 'note', kind: 'approval',
          approved: verdict === 'approved', by, reason,
          // Rostered sessions name the deciding MEMBER, not just an account id —
          // the group audit question is "which participant answered".
          ...(before.participants?.length ? {
            byParticipant: participantByUserId(before, by)?.id ?? humanParticipantId(by),
          } : {}),
          // Record escalated identity when present (runAs: null is a real value).
          ...(parked && 'runAs' in parked ? { runAs: parked.runAs } : {}),
          // Absent (not false) for human verdicts so UIs can distinguish them.
          timedOut: timedOut || undefined,
          createdAt: new Date(),
        };
      },
    );
    if (auditSeq === null) {
      // Session vanished after the verdict; the missing row is an audit gap.
      console.warn(
        `[10thfloor:agent] a session vanished before its ${verdict} `
        + 'note could be written; the approval has no audit row',
      );
    }
    return true;
  } finally {
    await operation.close();
  }
}

/** §4.3. Timeout denial: deny via `writeVerdict`, then wake. Never throws. */
export async function recordTimeoutVerdict(sessionId: string): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return false;
  // Missing config is not fatal: stranding the session is worse.
  const config = getAgent(session.agent);
  if (!config) return false;

  if (!(await writeVerdict(sessionId, 'denied', null, 'approval timed out', true))) {
    return false;
  }
  activate(sessionId);
  return true;
}

/** Walk `activeChild` and stop every running descendant. Skips parked children. */
async function stopRunningDescendants(sessionId: string): Promise<void> {
  let current = await AgentSessions.findOneAsync(sessionId);
  for (let hop = 0; hop < MAX_SUBAGENT_DEPTH; hop += 1) {
    const next = current?.activeChild?.sessionId;
    if (!next) return;
    // eslint-disable-next-line no-await-in-loop
    await AgentSessions.updateAsync(
      { _id: next, phase: { $in: ACTIVE_PHASES } },
      { $set: { phase: 'stopped', updatedAt: new Date() } },
    );
    // Re-read: the walk continues past un-stopped descendants.
    // eslint-disable-next-line no-await-in-loop
    current = await AgentSessions.findOneAsync(next);
  }
}

/** Authorize, decide once (conditional write), record, and wake. */
export async function recordVerdict(
  ctx: { userId: string | null },
  agent: string,
  sessionId: string,
  verdict: 'approved' | 'denied',
  reason?: string,
): Promise<void> {
  const config = getAgent(agent);
  if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  const session = await requireSession(agent, sessionId, ctx.userId);

  if (session.phase !== 'awaiting' || !session.pending || session.pending.verdict) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }

  // `config.approve` gates who may answer (always the primary's predicate).
  if (config.approve && !(await config.approve({ userId: ctx.userId }))) {
    throw new Meteor.Error('not-allowed', 'You may not answer this approval');
  }

  // Losing the conditional write means someone else answered between our read
  // and our write: tell the loser rather than handing them a silent success for
  // a tool they never authorized.
  if (!(await writeVerdict(sessionId, verdict, ctx.userId, reason))) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }

  // Activation derives the running Agent from the durable Gate marker.
  activate(sessionId);
}

/** Core of `agent.send` (§5.1). `mSend` is a DDP cap over this. */
export async function sendToSession(
  agent: string, sessionId: string, text: string, userId: string | null,
  /** Server-side extras (attachments, via identity, explicit addressee). */
  extras?: {
    attachments?: AttachmentRef[];
    via?: ViaIdentity;
    to?: string;
    /** @internal Stable DDP retry identity; server callers omit it. */
    commitKey?: string;
  },
): Promise<string> {
  const config = getAgent(agent);
  if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  const session = await requireSession(agent, sessionId, userId, extras?.via);
  const roster = session.participants;

  // Resolve the sender from the authenticated source (decision 4).
  const sender = (extras?.via && participantByIdentity(
    session, extras.via.kind, extras.via.externalUserId,
  ))
    ?? participantByUserId(session, userId)
    ?? roster?.find((p) => p.role === 'owner');
  const from = sender
    ? { participant: sender.id, name: sender.displayName }
    : {
      participant: extras?.via
        ? identityParticipantId(extras.via.kind, extras.via.externalUserId)
        : humanParticipantId(userId),
      name: extras?.via ? extras.via.externalUserId : 'user',
    };

  // WHICH MODEL answers (decision 5): explicit `to`, else the leading `@`
  // token, else the primary — resolved here, mechanically, once.
  const addressee = resolveAddressee(text, extras?.to, session);

  await commitUserMessage({
    sessionId,
    commitKey: extras?.commitKey,
    turnLimit: config.budget?.turns,
    draft: {
      content: text,
      ...(extras?.attachments?.length ? { attachments: extras.attachments } : {}),
      // Attribution on rostered rows only; addressee stamped only when resolved.
      ...(roster?.length ? { from } : {}),
      ...(addressee ? { to: addressee.id } : {}),
    },
  });

  // A compact wake link remains until the Transcript proves the input was
  // answered. Activation re-derives addressee, primary budget, and Memory.
  activate(sessionId);
  return sessionId;
}

/* System turns — public door into the same Activation Module. */

export async function startSystemTurn(
  sessionId: string,
  prompt: string,
  opts?: { key?: string; agent?: string; source?: string },
): Promise<SystemTurnResult> {
  return requestSystemTurn(sessionId, prompt, opts);
}

/** Compatibility entry for consuming a standing intent through Activation. */
export async function consumeStandingIntent(sessionId: string): Promise<boolean> {
  return consumeSystemIntent(sessionId, (id) => activate(id));
}

export function registerMethods(): void {
  Meteor.methods({
    async [NAMES.mStart](this: any, agent: string, opts?: { title?: string }) {
      check(agent, String);
      // Read before `check`: @types/meteor narrows opts fields to `never` after.
      const title = opts?.title;
      check(opts, Match.Maybe({ title: Match.Maybe(String) }));
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      // §7. Refuse direct start of a subagent-only specialist.
      // `=== false` only: undefined is the compat default.
      if (config.startable === false) {
        throw new Meteor.Error('not-startable', 'This agent cannot be started directly');
      }
      const _id = Random.id();
      await AgentSessions.insertAsync({
        _id, agent, userId: this.userId ?? null, title,
        phase: 'idle', model: config.model, nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });
      return _id;
    },

    async [NAMES.mSend](
      this: any, agent: string, sessionId: string, text: string, commitKey?: string,
    ) {
      check(agent, String);
      check(sessionId, String);
      check(text, String);
      check(commitKey, Match.Maybe(Match.Where(
        (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value),
      )));
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);

      // `startable: false` must close send too, or the flag is a fiction.
      // Lives on the DDP cap, not in `sendToSession` (server callers are app code).
      if (config.startable === false) {
        throw new Meteor.Error('not-startable', 'This agent cannot be driven directly');
      }

      // The core carries the rest — see `sendToSession` above (channels spec §5.1):
      // one body, two callers.
      return sendToSession(agent, sessionId, text, this.userId ?? null, { commitKey });
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      // `pending` left in place: the interrupt cancels the wait, not the record.
      // The loop's `finally` preserves `stopped` rather than idling it back.
      await AgentSessions.updateAsync({ _id: sessionId, erasingAt: { $exists: false } }, {
        $set: { phase: 'stopped', updatedAt: new Date() },
      });

      // Parent first: prevents it from starting another child between writes.
      await stopRunningDescendants(sessionId);
    },

    /** Fork at a batch-safe cut. `atSeq` is clamped to the nearest legal cut. */
    async [NAMES.mFork](
      this: any, agent: string, sessionId: string, atSeq?: number,
      opts?: { title?: string },
    ) {
      check(agent, String);
      check(sessionId, String);
      check(atSeq, Match.Maybe(Match.Integer));
      // Read before `check` (see mStart).
      const title = opts?.title;
      check(opts, Match.Maybe({ title: Match.Maybe(String) }));
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      // §7. `startable: false` forbids forks too (same guard as mStart).
      if (config.startable === false) {
        throw new Meteor.Error('not-startable', 'This agent cannot be started directly');
      }
      const source = await requireSession(agent, sessionId, this.userId ?? null);
      // DDP turns trailing undefined to null; normalize for arithmetic.
      return forkSession(source, { atSeq: atSeq ?? undefined, title });
    },

    /** §9 compaction on demand. Resolves true when a note was committed. */
    async [NAMES.mCompact](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const session = await requireSession(agent, sessionId, this.userId ?? null);

      // Use the session's owner, not `this.userId`.
      const outcome = await compactSession(
        sessionId, buildRunConfig(config, session.userId),
      );
      // A session over its spend budget is refused compaction with its OWN code
      // — a compaction bills like a turn, so `budget-exhausted` is the honest
      // answer, not `busy`. Checked before the `busy` family below.
      if (outcome === 'over-budget') {
        throw new Meteor.Error('budget-exhausted', COMPACT_OVER_BUDGET);
      }
      // One code, three reasons — `busy` also covers a session parked on an
      // approval and one sitting in `error`. See `COMPACT_REFUSALS`.
      const refusal = COMPACT_REFUSALS[outcome];
      if (refusal) throw new Meteor.Error('busy', refusal);
      if (outcome === 'gone') throw new Meteor.Error('no-session', 'Session not found');
      return outcome === 'compacted';
    },

    /** Mint a single-use download token for one attachment ref (§7). */
    async [NAMES.mAttachmentToken](
      this: any, agent: string, sessionId: string, attachmentId: string,
    ) {
      check(agent, String);
      check(sessionId, String);
      check(attachmentId, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      await requireSession(agent, sessionId, this.userId ?? null);
      const token = await issueAttachmentToken(sessionId, attachmentId);
      if (!token) throw new Meteor.Error('no-attachment', 'Attachment not found');
      return token;
    },

    async [NAMES.mApprove](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await recordVerdict({ userId: this.userId ?? null }, agent, sessionId, 'approved');
    },

    async [NAMES.mDeny](this: any, agent: string, sessionId: string, reason?: string) {
      check(agent, String);
      check(sessionId, String);
      check(reason, Match.Maybe(String));
      await recordVerdict({ userId: this.userId ?? null }, agent, sessionId, 'denied', reason);
    },

    /** Shelve/unshelve. Display state only, no phase/lease change. */
    async [NAMES.mArchive](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      // Not `guardedUpdate`: that path is for writes that must lose to a
      // running turn's lease, and this one is display state a turn never reads.
      await AgentSessions.updateAsync(
        { _id: sessionId, erasingAt: { $exists: false } },
        { $set: { archived: new Date() } },
      );
    },

    async [NAMES.mUnarchive](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      await AgentSessions.updateAsync(
        { _id: sessionId, erasingAt: { $exists: false } },
        { $unset: { archived: 1 } },
      );
    },
  });
}
