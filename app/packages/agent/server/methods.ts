import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { createHash } from 'crypto';
import { NAMES } from '../common/names';
import { AgentMessages, AgentSessions } from '../common/collections';
import { buildRunConfig, getAgent } from './registry';
import { COMPACT_OVER_BUDGET, COMPACT_REFUSALS, compactSession } from './compaction';
import { forkSession } from './fork';
import { MAX_SUBAGENT_DEPTH } from './subagent';
import {
  ACTIVE_PHASES, type AgentSession, type AttachmentRef, type MessageSource,
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
import {
  commitOperationMessage, commitUserMessage, MAX_USER_MESSAGE_BYTES,
} from './transcript';

/** Verified channel identity (decision 12); server-side only, never from DDP. */
export interface ViaIdentity { kind: string; externalUserId: string }

function sessionAccessClauses(userId: string | null, via?: ViaIdentity): SessionQuery[] {
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
  return clauses;
}

/** Authorize by agent + userId (or roster membership / via identity).
 *  Same error for "not found" and "not yours" to avoid confirming ids. */
export async function requireSession(
  agent: string, sessionId: string, userId: string | null, via?: ViaIdentity,
) {
  const session = await AgentSessions.findOneAsync({
    _id: sessionId, agent, erasingAt: { $exists: false },
    $or: sessionAccessClauses(userId, via),
  });
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

/** DDP control-plane mutations belong to the Session owner, not every human
 * who may participate in its transcript. `null` remains the owner of an
 * anonymous capability Session; normalize a missing legacy value accordingly.
 * Server-side Agent APIs do not pass through this browser-method guard. */
async function requireSessionOwner(
  agent: string, sessionId: string, userId: string | null,
): Promise<AgentSession> {
  const session = await requireSession(agent, sessionId, userId);
  if ((session.userId ?? null) !== userId) {
    throw new Meteor.Error(
      'not-allowed', 'Only the session owner can change session controls.',
    );
  }
  return session;
}

/** Resolve a human author strictly from the authenticated account/channel
 * principal. Text never participates in attribution. */
function humanFrom(
  session: AgentSession, userId: string | null, via?: ViaIdentity,
): { participant: string; name: string } {
  const sender = (via && participantByIdentity(
    session, via.kind, via.externalUserId,
  ))
    ?? participantByUserId(session, userId)
    ?? session.participants?.find((p) => p.role === 'owner');
  return sender
    ? { participant: sender.id, name: sender.displayName }
    : {
      participant: via
        ? identityParticipantId(via.kind, via.externalUserId)
        : humanParticipantId(userId),
      name: via ? via.externalUserId : 'user',
    };
}

function sameSource(a?: MessageSource, b?: MessageSource): boolean {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'channel' && b?.kind === 'channel') {
    return a.channel === b.channel && a.origin === b.origin;
  }
  return a === undefined ? b === undefined : true;
}

function contributionMessageId(sessionId: string, commitKey: string): string {
  return `c:${createHash('sha256')
    .update('10thfloor:agent:crew-note\0')
    .update(sessionId)
    .update('\0')
    .update(commitKey)
    .digest('hex')}`;
}

/** Single-winner verdict write + audit row. Shared by human approve/deny and
 *  the watcher's timeout. Returns whether THIS caller won. No auth here. */
async function writeVerdict(
  sessionId: string,
  verdict: 'approved' | 'denied',
  by: string | null,
  reason: string | undefined,
  timedOut = false,
  expectedToolCallId?: string,
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
        // Optional for backward compatibility. New UI/channel callers bind a
        // displayed decision to the exact Gate even if another ask parks
        // between authorization and this single-winner write.
        ...(expectedToolCallId !== undefined
          ? { 'pending.toolCallId': expectedToolCallId }
          : {}),
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
          ...(parked?.toolCallId ? { toolCallId: parked.toolCallId } : {}),
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

  if (!(await writeVerdict(
    sessionId, 'denied', null, 'approval timed out', true, session.pending?.toolCallId,
  ))) {
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
  expectedToolCallId?: string,
): Promise<void> {
  const config = getAgent(agent);
  if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  const session = await requireSession(agent, sessionId, ctx.userId);

  if (session.phase !== 'awaiting' || !session.pending || session.pending.verdict) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }
  if (expectedToolCallId !== undefined
    && session.pending.toolCallId !== expectedToolCallId) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }
  // Compatibility callers may omit the id, but they still authorize the Gate
  // they observed — never whichever Gate happens to be parked after an async
  // approval predicate returns.
  const targetToolCallId = expectedToolCallId ?? session.pending.toolCallId;

  // `config.approve` gates who may answer (always the primary's predicate).
  if (config.approve && !(await config.approve({ userId: ctx.userId }))) {
    throw new Meteor.Error('not-allowed', 'You may not answer this approval');
  }

  // Losing the conditional write means someone else answered between our read
  // and our write: tell the loser rather than handing them a silent success for
  // a tool they never authorized.
  if (!(await writeVerdict(
    sessionId, verdict, ctx.userId, reason, false, targetToolCallId,
  ))) {
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
    /** Trusted ingress attribution. DDP/channel callers stamp this themselves;
     *  no public method argument accepts it. */
    source?: MessageSource;
    /** @internal Stable DDP retry identity; server callers omit it. */
    commitKey?: string;
  },
): Promise<string> {
  const config = getAgent(agent);
  if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  const session = await requireSession(agent, sessionId, userId, extras?.via);
  const roster = session.participants;

  // Resolve the sender from the authenticated source (decision 4).
  const from = humanFrom(session, userId, extras?.via);

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
      ...(extras?.source ? { source: extras.source } : {}),
    },
  });

  // A compact wake link remains until the Transcript proves the input was
  // answered. Activation re-derives addressee, primary budget, and Memory.
  activate(sessionId);
  return sessionId;
}

/** Commit a human crew note without scheduling model work. It is deliberately
 * a `user` row (so a later turn sees it as conversation context) with
 * `kind:'crew-note'` (so recovery/routing never treats it as unanswered).
 * There is no pending-input link, Turn-budget charge, addressee resolution or
 * Activation call. */
export async function contributeToSession(
  agent: string, sessionId: string, text: string, userId: string | null,
  extras?: {
    via?: ViaIdentity;
    source?: MessageSource;
    /** @internal Stable DDP retry identity; server callers omit it. */
    commitKey?: string;
  },
): Promise<string> {
  if (!getAgent(agent)) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_USER_MESSAGE_BYTES) {
    throw new Meteor.Error(
      'message-too-large',
      `Messages may not exceed ${MAX_USER_MESSAGE_BYTES} UTF-8 bytes.`,
    );
  }

  // The first read gives us the expected authenticated author for replay
  // conflict detection. The commit selector repeats authorization inside the
  // transaction, so removal between this read and the write cannot land a row.
  const session = await requireSession(agent, sessionId, userId, extras?.via);
  const rostered = !!session.participants?.length;
  const expectedFrom = rostered ? humanFrom(session, userId, extras?.via) : undefined;
  const source = extras?.source;
  const messageId = contributionMessageId(sessionId, extras?.commitKey ?? Random.id());
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  try {
    const seq = await commitOperationMessage(
      operation,
      sessionId,
      messageId,
      { agent, $or: sessionAccessClauses(userId, extras?.via) },
      {},
      (before) => ({
        role: 'user',
        kind: 'crew-note',
        content: text,
        ...(before.participants?.length
          ? { from: humanFrom(before, userId, extras?.via) }
          : {}),
        ...(source ? { source } : {}),
        createdAt: new Date(),
      }),
    );
    if (seq === null) throw new Meteor.Error('no-session', 'Session not found');

    // `commitOperationMessage` adopts an existing deterministic id. Verify it
    // belongs to this exact input so one retry key can never alias two notes
    // (including two different roster members).
    const row = await AgentMessages.findOneAsync(messageId);
    const conflict = !row
      || row.sessionId !== sessionId
      || row.role !== 'user'
      || row.kind !== 'crew-note'
      || row.content !== text
      || row.from?.participant !== expectedFrom?.participant
      || (row.from === undefined) !== (expectedFrom === undefined)
      || !sameSource(row.source, source);
    if (conflict) {
      throw new Meteor.Error(
        'commit-conflict',
        'This message commit key is already associated with different input.',
      );
    }
    return sessionId;
  } finally {
    await operation.close();
  }
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
      return sendToSession(agent, sessionId, text, this.userId ?? null, {
        commitKey, source: { kind: 'desktop' },
      });
    },

    /** Human-to-crew context without a model wake. Same authenticated Session
     * capability and retry-key contract as `agent.send`; source is server-set. */
    async [NAMES.mContribute](
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
      if (config.startable === false) {
        throw new Meteor.Error('not-startable', 'This agent cannot be driven directly');
      }
      return contributeToSession(agent, sessionId, text, this.userId ?? null, {
        commitKey, source: { kind: 'desktop' },
      });
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSessionOwner(agent, sessionId, this.userId ?? null);
      // The control is an execution interrupt, not a way to cancel durable
      // questions or terminal state. Re-check at the authoritative write so a
      // stale UI click cannot stop a turn that parked or completed in flight.
      const stopped = await AgentSessions.updateAsync({
        _id: sessionId,
        erasingAt: { $exists: false },
        phase: { $in: ACTIVE_PHASES },
      }, { $set: { phase: 'stopped', updatedAt: new Date() } });
      if (stopped !== 1) return;

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
      const source = await requireSessionOwner(agent, sessionId, this.userId ?? null);
      // DDP turns trailing undefined to null; normalize for arithmetic.
      return forkSession(source, { atSeq: atSeq ?? undefined, title });
    },

    /** §9 compaction on demand. Resolves true when a note was committed. */
    async [NAMES.mCompact](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const session = await requireSessionOwner(agent, sessionId, this.userId ?? null);

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

    async [NAMES.mApprove](
      this: any, agent: string, sessionId: string, expectedToolCallId?: string,
    ) {
      check(agent, String);
      check(sessionId, String);
      check(expectedToolCallId, Match.Maybe(String));
      await recordVerdict(
        { userId: this.userId ?? null }, agent, sessionId, 'approved',
        undefined, expectedToolCallId,
      );
    },

    async [NAMES.mDeny](
      this: any, agent: string, sessionId: string,
      reason?: string, expectedToolCallId?: string,
    ) {
      check(agent, String);
      check(sessionId, String);
      check(reason, Match.Maybe(String));
      check(expectedToolCallId, Match.Maybe(String));
      await recordVerdict(
        { userId: this.userId ?? null }, agent, sessionId, 'denied',
        reason, expectedToolCallId,
      );
    },

    /** Shelve/unshelve. Display state only, no phase/lease change. */
    async [NAMES.mArchive](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSessionOwner(agent, sessionId, this.userId ?? null);
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
      await requireSessionOwner(agent, sessionId, this.userId ?? null);
      await AgentSessions.updateAsync(
        { _id: sessionId, erasingAt: { $exists: false } },
        { $unset: { archived: 1 } },
      );
    },
  });
}
