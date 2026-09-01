import { Meteor } from 'meteor/meteor';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentSession } from '../common/types';
import { AgentAttachments } from './attachments';
import {
  ChannelBindings, ChannelVerdictTokens, DeliveryReceipts,
} from './channels/collections';
import { AttachmentDownloadTokens } from './downloads';
import { AgentMemoryFrames } from './learning-collections';
import { isRunning } from './turn-state';
import { discardTurn, locateBatch, UserMessageReservations } from './transcript';

/** Outcome deliberately hides whether an id belonged to another owner/agent. */
export type SessionErasure = 'erased' | 'absent';

/** Result of fencing parked work for one Agent identity. The host must first
 * make that Agent unavailable (for example by committing an archive status),
 * so no fresh turn can create another park while this finite sweep runs. */
export interface AbandonedAgentTurns {
  sessions: number;
  toolCalls: string[];
}

const QUIESCE_MS = 5_000;
const POLL_MS = 25;

const pause = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Cancel every parked turn owned by one Agent for an exact Session owner.
 *
 * The Session fence lands before transcript cleanup. That ordering makes a
 * racing approval lose its conditional write and revokes any resume Lease;
 * should best-effort cleanup be interrupted, the ordinary unanswered-tool-use
 * repair removes the now-unreferenced assistant batch before the next turn.
 * Agent-owned learning is deliberately untouched.
 *
 * Host lifecycle primitive used after its own availability fence. It is
 * exported for applications that archive Agent definitions outside the core. */
export async function abandonPendingAgentTurns(
  agent: string, userId: string | null,
): Promise<AbandonedAgentTurns> {
  const toolCalls: string[] = [];
  const sessionIds = new Set<string>();
  // Activation can change a phase between the read and the conditional fence.
  // Once the host's availability fence is durable that race is finite, so
  // repeat to a fixed point instead of silently declaring a missed candidate
  // clean. A storage failure throws and leaves the host cleanup receipt set.
  for (let pass = 0; pass < 40; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const candidates = await AgentSessions.find({
      userId,
      'pending.agent': agent,
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
    }, {
      fields: { _id: 1, phase: 1, pending: 1 },
      sort: { _id: 1 },
    }).fetchAsync();
    if (candidates.length === 0) {
      return { sessions: sessionIds.size, toolCalls };
    }
    let progressed = false;

    for (const candidate of candidates) {
      const pending = candidate.pending;
      if (!pending) continue;
      const at = new Date();
      // Include the observed phase and exact call identity. If activation or a
      // replacement park wins first, the next fixed-point pass adopts it.
      // eslint-disable-next-line no-await-in-loop
      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        {
          _id: candidate._id,
          userId,
          phase: candidate.phase,
          'pending.agent': agent,
          'pending.toolCallId': pending.toolCallId,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
        },
        {
          $set: {
            ...(candidate.phase === 'stopped' ? {} : { phase: 'idle' }),
            updatedAt: at,
          },
          $unset: { pending: '', lease: '' },
        },
        { returnDocument: 'before' },
      ) as unknown as AgentSession | null;
      if (!before?.pending) continue;

      progressed = true;
      sessionIds.add(before._id);
      toolCalls.push(before.pending.toolCallId);
      // eslint-disable-next-line no-await-in-loop
      const messages = await AgentMessages.find(
        { sessionId: before._id }, { sort: { seq: 1 } },
      ).fetchAsync();
      const batch = locateBatch(messages, before.pending.toolCallId);
      if (batch) {
        // eslint-disable-next-line no-await-in-loop
        await discardTurn(
          before._id,
          batch.assistant._id,
          batch.assistant.seq,
          (batch.assistant.toolCalls ?? []).map((call) => call.id),
          batch.windowEnd,
        );
      }
    }
    if (!progressed) {
      // A resume already beyond its own atomic phase change is winding down.
      // Give its revoked Lease a bounded opportunity to observe the host
      // fence; never spin forever inside an archive command.
      // eslint-disable-next-line no-await-in-loop
      await pause(POLL_MS);
    }
  }
  throw new Error('[10thfloor:agent] pending Agent turns did not quiesce');
}

/** Graph truth is `parent.sessionId`; `activeChild` is only a live hint. */
async function sessionTree(rootId: string): Promise<AgentSession[]> {
  const found = new Map<string, AgentSession>();
  let frontier = [rootId];

  while (frontier.length > 0) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await AgentSessions.find({
      $or: [
        { _id: { $in: frontier } },
        { 'parent.sessionId': { $in: frontier } },
      ],
    }).fetchAsync();
    const next: string[] = [];
    for (const row of rows) {
      if (found.has(row._id)) continue;
      found.set(row._id, row);
      if (row._id !== rootId) next.push(row._id);
    }
    frontier = next;
  }

  return [...found.values()];
}

async function fence(rows: AgentSession[], at: Date): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row._id);
  await AgentSessions.rawCollection().updateMany(
    { _id: { $in: ids } },
    {
      $set: { erasingAt: at, phase: 'stopped', updatedAt: at },
      $unset: { pendingRelay: '', pendingSystem: '', activeChild: '' },
    },
  );
  // A worker that already noticed a binding must lose its next claim before
  // package-owned state begins disappearing.
  await ChannelBindings.rawCollection().updateMany(
    { sessionId: { $in: ids } },
    { $set: { erasingAt: at } },
  );
}

function hasLiveLease(row: AgentSession, now: number): boolean {
  return !!row.lease && row.lease.until.getTime() > now;
}

function hasLiveOperation(row: AgentSession, now: number): boolean {
  return !!row.operations?.some((operation) => operation.until.getTime() > now);
}

async function quiescent(ids: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await AgentSessions.find(
      { _id: { $in: ids } }, { fields: { lease: 1, operations: 1 } },
    ).fetchAsync();
    const now = Date.now();
    if (!rows.some((row) => (
      isRunning(row._id) || hasLiveLease(row, now) || hasLiveOperation(row, now)
    ))) return true;
    if (now >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await pause(Math.min(POLL_MS, deadline - now));
  }
}

/** Atomically close the expiry/heartbeat race. A heartbeat that wins remains
 * live and makes this selector lose; once this gate wins, no heartbeat or new
 * operation can resurrect work while dependent rows are being purged. */
async function claimPurge(ids: string[]): Promise<boolean> {
  const now = new Date();
  const claimed = await AgentSessions.rawCollection().updateMany(
    {
      _id: { $in: ids },
      $or: [
        { purgingAt: { $exists: true } },
        {
          purgingAt: { $exists: false },
          $nor: [{ operations: { $elemMatch: { until: { $gt: now } } } }],
        },
      ],
    },
    { $set: { purgingAt: now } },
  );
  return claimed.matchedCount === ids.length;
}

/** Idempotent, collection-local cascade. Account identity, Fact Memory, and
 * Agent-owned learning are intentionally absent; only the trigger-scoped
 * Memory Frame follows its Session. */
async function purge(rootId: string, rows: AgentSession[]): Promise<void> {
  const ids = rows.map((row) => row._id);
  const bindings = await ChannelBindings.find(
    { sessionId: { $in: ids } }, { fields: { _id: 1 } },
  ).fetchAsync();
  const bindingIds = bindings.map((binding) => binding._id);

  await DeliveryReceipts.removeAsync({ sessionId: { $in: ids } });
  if (bindingIds.length > 0) {
    // Compatibility cleanup for receipts written before they carried a direct
    // Session ownership key.
    await DeliveryReceipts.removeAsync({ bindingId: { $in: bindingIds } });
  }
  await ChannelVerdictTokens.removeAsync({ sessionId: { $in: ids } });
  await AttachmentDownloadTokens.removeAsync({ sessionId: { $in: ids } });
  await ChannelBindings.removeAsync({ sessionId: { $in: ids } });
  await AgentDeltas.removeAsync({ sessionId: { $in: ids } });
  await AgentMessages.removeAsync({ sessionId: { $in: ids } });
  await UserMessageReservations.removeAsync({ sessionId: { $in: ids } } as any);
  await AgentAttachments.removeAsync({ sessionId: { $in: ids } });
  // A Memory Frame is the exact causal snapshot for one Session trigger. It
  // follows Session erasure, unlike Agent-owned Identity, Constitution,
  // Experience, and Practice records. Delete Frames before Session rows so a
  // crash leaves the durable root fence available for an idempotent retry.
  await AgentMemoryFrames.removeAsync({ sessionId: { $in: ids } });

  // Root last: a durable fence remains visible until every dependent store is
  // gone. Forks survive because lineage is not a parent relationship.
  const childIds = ids.filter((id) => id !== rootId);
  if (childIds.length > 0) await AgentSessions.removeAsync({ _id: { $in: childIds } });
  await AgentSessions.removeAsync(rootId);
}

/** Finish an already-authorized erasure. Returns false while a Turn/Lease is
 * still winding down; the durable fence makes a later retry safe. */
async function finish(rootId: string, timeoutMs: number): Promise<boolean> {
  const at = new Date();
  for (;;) {
    const rows = await sessionTree(rootId);
    if (rows.length === 0) return true;
    await fence(rows, at);
    const ids = rows.map((row) => row._id);
    if (!(await quiescent(ids, timeoutMs))) return false;
    if (!(await claimPurge(ids))) return false;

    // A child can have been created just before the parent fence won. Close
    // the graph to a fixed point after all known Turns are quiet.
    const closed = await sessionTree(rootId);
    if (closed.length === rows.length) {
      await purge(rootId, closed);
      return true;
    }
  }
}

/** @internal The `Agent#erase` Implementation: owner-scoped, root-only, recursive. */
export async function eraseOwnedSession(
  agent: string, sessionId: string, userId: string | null,
): Promise<SessionErasure> {
  const at = new Date();
  const root = await AgentSessions.rawCollection().findOneAndUpdate(
    {
      _id: sessionId,
      agent,
      userId,
      parent: { $exists: false },
    },
    { $set: { erasingAt: at, phase: 'stopped', updatedAt: at } },
    { returnDocument: 'after' },
  ) as unknown as AgentSession | null;
  if (!root) return 'absent';

  try {
    if (await finish(root._id, QUIESCE_MS)) return 'erased';
  } catch {
    // The fence remains durable; lifecycle recovery or an explicit retry
    // resumes the idempotent cascade. Do not expose storage errors or ids.
  }
  throw new Meteor.Error(
    'erase-incomplete',
    'The session is unavailable and its data cleanup is still pending; retry later.',
  );
}

/** @internal Recover a crash or a Turn that outlived the public wait. Periodic
 * callers isolate a bad root so later roots still progress; the startup barrier
 * opts into strict mode because exposing entry points before fencing every
 * descendant would violate erasure's fail-closed contract. */
export async function resumeSessionErasures(
  opts: { strict?: boolean } = {},
): Promise<void> {
  const roots = await AgentSessions.find({
    erasingAt: { $exists: true }, parent: { $exists: false },
  }, { fields: { _id: 1 } }).fetchAsync();
  for (const root of roots) {
    // Zero wait: a live Lease belongs to a later sweep.
    // eslint-disable-next-line no-await-in-loop
    if (opts.strict) {
      // eslint-disable-next-line no-await-in-loop
      const complete = await finish(root._id, 0);
      if (!complete) {
        throw new Error('[10thfloor:agent] Session erasure recovery is not yet quiescent');
      }
    } else {
      // eslint-disable-next-line no-await-in-loop
      await finish(root._id, 0).catch(() => { /* next sweep retries */ });
    }
  }
}

/** @internal Independent lifecycle recovery. It remains active when the Turn
 * watcher is disabled, because data cleanup and Turn recovery are separate. */
export function startSessionLifecycleRecovery(sweepMs = 15_000): {
  stop(): Promise<void>;
} {
  let stopped = false;
  let running: Promise<void> | null = null;
  const sweep = (): void => {
    if (stopped || running) return;
    running = resumeSessionErasures()
      .catch(() => { /* the next sweep retries without exposing storage detail */ })
      .then(() => { running = null; });
  };
  const timer = setInterval(sweep, sweepMs);
  (timer as any).unref?.();
  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
