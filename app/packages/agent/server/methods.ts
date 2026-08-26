import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentMessages, AgentSessions } from '../common/collections';
import {
  getAgent, buildRunConfig, resolveBudget, memoryOpt, type AgentConfig,
} from './registry';
import { runTurn } from './loop';
import { COMPACT_OVER_BUDGET, COMPACT_REFUSALS, compactSession } from './compaction';
import { forkSession } from './fork';
import { MAX_SUBAGENT_DEPTH } from './subagent';
import {
  ACTIVE_PHASES, type AgentSession, type AttachmentRef, type SessionInc,
} from '../common/types';
import {
  startSystemTurnWith, consumeSystemIntent, type SystemTurnResult,
} from './system-turn';
import type { SessionQuery, SessionSet } from '../common/db';
import {
  humanParticipantId, identityParticipantId, participantByIdentity,
  participantByUserId, resolveAddressee,
} from '../common/participants';
import { resolveWakeAgent } from './participants';
import { issueAttachmentToken } from './downloads';

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
  const session = await AgentSessions.findOneAsync({ _id: sessionId, agent, $or: clauses });
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

/** Fire-and-forget a turn. `.catch` is load-bearing (Node unhandled = fatal). */
export function deferTurn(
  sessionId: string, config: AgentConfig, userId: string | null,
  opts?: Parameters<typeof buildRunConfig>[2],
): void {
  Meteor.defer(() => {
    // `opts` composes the addressee's config with the primary's budget (§4.3).
    runTurn(sessionId, buildRunConfig(config, userId, opts)).catch((e) => {
      console.error(`[10thfloor:agent] turn failed for session ${sessionId}:`, e);
    });
  });
}

/** Resolve the addressed model (decision 6) and defer a turn as it.
 *  Falls back to the primary if the addressee is no longer registered. */
export async function deferResolvedTurn(session: AgentSession): Promise<boolean> {
  const primary = getAgent(session.agent);
  if (!primary) return false;
  const name = await resolveWakeAgent(session);
  if (name === session.agent) {
    deferTurn(session._id, primary, session.userId);
    return true;
  }
  const addressee = getAgent(name);
  if (!addressee) {
    console.warn(
      `[10thfloor:agent] session ${session._id}: addressed model "${name}" is not `
      + `registered; waking as the primary "${session.agent}" instead`,
    );
    deferTurn(session._id, primary, session.userId);
    return true;
  }
  deferTurn(session._id, addressee, session.userId, {
    agentName: name,
    budget: resolveBudget(primary.budget),
    // The addressee may declare no memory of its own; the conversation's
    // memory is the PRIMARY's either way (spec decision 19), or recall would
    // differ by whoever was @-mentioned.
    ...memoryOpt(primary),
  });
  return true;
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
  const $set: SessionSet = {
    'pending.verdict': verdict,
    'pending.by': by,
    // Written atomically with the verdict so the loop's self-check can tell
    // whether the standing verdict is still its own.
    'pending.wakeToken': Random.id(),
    phase: 'idle',
    updatedAt: new Date(),
  };
  // Only when given: `$set` with an undefined value is not a field write.
  if (reason !== undefined) $set['pending.reason'] = reason;

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
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    { _id: sessionId },
    { $inc: { nextSeq: 1 } satisfies SessionInc, $set: { updatedAt: new Date() } },
    { returnDocument: 'before' },
  ) as unknown as AgentSession | null;
  if (before) {
    // The parked marker as it stood a moment ago — `before` is the document
    // BEFORE this seq allocation, which is after the verdict write, so
    // `pending` is still there with everything the park recorded.
    const parked = before.pending;
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: before.nextSeq,
      role: 'note', kind: 'approval',
      approved: verdict === 'approved', by, reason,
      // Rostered sessions name the deciding MEMBER, not just an account id —
      // the group audit question is "which participant answered".
      ...(before.participants?.length ? {
        byParticipant: participantByUserId(before, by)?.id ?? humanParticipantId(by),
      } : {}),
      // Record the escalated identity if present (runAs: null is a real value).
      ...(parked && 'runAs' in parked ? { runAs: parked.runAs } : {}),
      // Absent (not false) for human verdicts so UIs can distinguish them.
      timedOut: timedOut || undefined,
      createdAt: new Date(),
    });
  } else {
    // Session vanished after the verdict; the missing row is an audit gap.
    console.warn(
      `[10thfloor:agent] session ${sessionId} vanished before its ${verdict} `
      + 'note could be written; the approval has no audit row',
    );
  }
  return true;
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
  // Re-read: the verdict write mutated `pending`.
  const after = await AgentSessions.findOneAsync(sessionId);
  if (after) await deferResolvedTurn(after);
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

  // Wake runs as the session's owner, never the approver.
  const after = await AgentSessions.findOneAsync(sessionId);
  if (after) await deferResolvedTurn(after);
}

/** Core of `agent.send` (§5.1). `mSend` is a DDP cap over this. */
export async function sendToSession(
  agent: string, sessionId: string, text: string, userId: string | null,
  /** Server-side extras (attachments, via identity, explicit addressee). */
  extras?: { attachments?: AttachmentRef[]; via?: ViaIdentity; to?: string },
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

  // Turn budget enforced atomically inside the allocation ($lt in the filter)
  // so concurrent sends cannot overshoot.
  const turnFilter: Record<string, unknown> = { _id: sessionId };
  if (config.budget?.turns !== undefined) {
    // Matches when under budget. Sessions seeded before this field existed
    // have budgetSpent.turns set by mStart, so $lt sees a number.
    turnFilter['budgetSpent.turns'] = { $lt: config.budget.turns };
  }

  // Atomic seq allocation to avoid racing the in-flight turn loop.
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    turnFilter,
    {
      $inc: { nextSeq: 1, 'budgetSpent.turns': 1 } satisfies SessionInc,
      // Human message resets relay/hop count (decision 7); rosterless skip.
      $set: {
        updatedAt: new Date(),
        ...(roster?.length ? { relay: 0 } : {}),
      },
      ...(roster?.length ? { $unset: { pendingRelay: 1 } } : {}),
    },
    { returnDocument: 'before' },
  ) as unknown as AgentSession | null;
  if (!before) {
    // requireSession above proved the session exists and is the caller's, so a
    // non-match here can only be the budget filter.
    if (config.budget?.turns !== undefined) {
      throw new Meteor.Error('budget-exhausted', 'This session has used its turn budget.');
    }
    throw new Meteor.Error('no-session', 'Session not found');
  }

  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq: before.nextSeq, role: 'user',
    content: text,
    ...(extras?.attachments?.length ? { attachments: extras.attachments } : {}),
    // Attribution on rostered rows only; addressee stamped only when resolved.
    ...(roster?.length ? { from } : {}),
    ...(addressee ? { to: addressee.id } : {}),
    createdAt: new Date(),
  });

  // A new message is the resume signal after an interrupt OR a provider
  // failure — the send clears both durable phases, conditionally, so a send
  // during a live turn does not stomp `streaming`.
  await AgentSessions.updateAsync(
    { _id: sessionId, phase: { $in: ['stopped', 'error'] } },
    { $set: { phase: 'idle' } },
  );

  // Wake as owner (decision 10); addressed sends compose with primary's budget.
  if (addressee && addressee.agent !== agent) {
    const target = getAgent(addressee.agent);
    if (target) {
      deferTurn(sessionId, target, session.userId, {
        agentName: addressee.agent,
        budget: resolveBudget(config.budget),
        // Memory follows the primary (decision 19), not the addressed colleague.
        ...memoryOpt(config),
      });
      return sessionId;
    }
    console.warn(
      `[10thfloor:agent] session ${sessionId}: addressed model "${addressee.agent}" `
      + `is not registered; the primary "${agent}" answers instead`,
    );
  }
  deferTurn(sessionId, config, session.userId);
  return sessionId;
}

/* System turns — public door: `deferTurn` wired into `system-turn.ts`. */

export async function startSystemTurn(
  sessionId: string,
  prompt: string,
  opts?: { key?: string; agent?: string; source?: string },
): Promise<SystemTurnResult> {
  return startSystemTurnWith(deferTurn, sessionId, prompt, opts);
}

/** Consume a standing intent, dispatching through `deferTurn`. The watcher's
 *  sweep and `Agent#systemTurn` both land here; the loop's wind-down passes its
 *  own dispatcher instead. */
export async function consumeStandingIntent(sessionId: string): Promise<boolean> {
  return consumeSystemIntent(sessionId, deferTurn);
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

    async [NAMES.mSend](this: any, agent: string, sessionId: string, text: string) {
      check(agent, String);
      check(sessionId, String);
      check(text, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);

      // `startable: false` must close send too, or the flag is a fiction.
      // Lives on the DDP cap, not in `sendToSession` (server callers are app code).
      if (config.startable === false) {
        throw new Meteor.Error('not-startable', 'This agent cannot be driven directly');
      }

      // The core carries the rest — see `sendToSession` above (channels spec §5.1):
      // one body, two callers.
      return sendToSession(agent, sessionId, text, this.userId ?? null);
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      // `pending` left in place: the interrupt cancels the wait, not the record.
      // The loop's `finally` preserves `stopped` rather than idling it back.
      await AgentSessions.updateAsync(sessionId, {
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
      await AgentSessions.updateAsync(sessionId, { $set: { archived: new Date() } });
    },

    async [NAMES.mUnarchive](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      await AgentSessions.updateAsync(sessionId, { $unset: { archived: 1 } });
    },
  });
}
