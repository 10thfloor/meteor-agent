import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import {
  ACTIVE_PHASES, DECIDED_PHASES, type AgentSession,
} from '../common/types';
import { getAgent, buildRunConfig, resolveBudget, memoryOpt } from './registry';
import {
  resolveWakeAgent, unansweredAddressee, unansweredMessageAddressee,
} from './participants';
import { assistantAnswers } from '../common/participants';
import { running } from './turn-state';
import {
  beginSessionOperation, beginSessionTreeOperation,
} from './session-operations';
import {
  consumeSystemIntent, startSystemTurnWith,
  systemRowId, type SystemTurnResult,
} from './system-turn';
import type { RunConfig } from './loop';
import type { SessionQuery } from '../common/db';
import {
  clearAnsweredUserMessageLinks, commitOperationMessage, reconcileUserMessageCommits,
  UserMessageReservations,
} from './transcript';

/** Activation is level-triggered: callers merely nudge after committing a
 * durable cause. This Module owns whether and which Agent may start a Turn. */

type TurnRunner = (
  sessionId: string,
  config: RunConfig | (() => RunConfig),
  expected?: SessionQuery,
) => Promise<void>;

type ActivationKind = 'lease-recovery' | 'verdict' | 'relay' | 'message' | 'system';

interface ActivationCandidate {
  kind: ActivationKind;
  fingerprint: string;
  session: AgentSession;
  agent: string;
  expected: SessionQuery;
}

interface LocalSlot {
  queued: boolean;
  running: boolean;
  dirty: boolean;
}

const slots = new Map<string, LocalSlot>();
let turnRunner: TurnRunner | null = null;
const warnedUnavailableAgents = new Set<string>();
const LEGACY_INPUT_WRITE_GRACE_MS = 30_000;

/** @internal Install the Turn Implementation without creating an
 * Activation↔Turn import cycle. Production supplies `runTurn`; tests may
 * temporarily supply a deterministic Adapter. */
export function installTurnRunner(runner: TurnRunner): () => void {
  const previous = turnRunner;
  turnRunner = runner;
  return () => { turnRunner = previous; };
}

function liveLease(session: AgentSession, now: Date): boolean {
  return !!session.lease && session.lease.until.getTime() > now.getTime();
}

interface InputState {
  owed: { seq: number; agent: string } | null;
  answered: NonNullable<AgentSession['pendingInputs']>;
}

async function inputState(session: AgentSession): Promise<InputState> {
  if (session.pendingInputs?.length) {
    const links = [...session.pendingInputs].sort((a, b) => b.seq - a.seq);
    const messages = await AgentMessages.find({
      sessionId: session._id,
      _id: { $in: links.map((link) => link.messageId) },
      role: 'user',
    }).fetchAsync();
    const byId = new Map(messages.map((message) => [message._id, message]));
    const [lastAssistant] = session.participants?.length ? [] : await AgentMessages.find(
      { sessionId: session._id, role: 'assistant' }, { sort: { seq: -1 }, limit: 1 },
    ).fetchAsync();

    let owed: InputState['owed'] = null;
    const answered: InputState['answered'] = [];
    for (const link of links) {
      const message = byId.get(link.messageId);
      if (!message || message.seq !== link.seq) {
        throw new Error('A durable Transcript link has no exact Message');
      }
      if (session.participants?.length) {
        // eslint-disable-next-line no-await-in-loop
        const addressee = await unansweredMessageAddressee(session, message);
        if (addressee) {
          owed ??= { seq: link.seq, agent: addressee.agent };
        } else {
          answered.push(link);
        }
      } else if (!lastAssistant || !assistantAnswers(lastAssistant, link.seq)) {
        owed ??= { seq: link.seq, agent: session.agent };
      } else {
        answered.push(link);
      }
    }
    return { owed, answered };
  }

  const [lastUser] = await AgentMessages.find(
    { sessionId: session._id, role: 'user' }, { sort: { seq: -1 }, limit: 1 },
  ).fetchAsync();
  if (!lastUser) return { owed: null, answered: [] };

  if (session.participants?.length) {
    const owed = await unansweredAddressee(session);
    return {
      owed: owed ? { seq: lastUser.seq, agent: owed.agent } : null,
      answered: [],
    };
  }

  const [lastAssistant] = await AgentMessages.find(
    { sessionId: session._id, role: 'assistant' }, { sort: { seq: -1 }, limit: 1 },
  ).fetchAsync();
  return {
    owed: !lastAssistant || !assistantAnswers(lastAssistant, lastUser.seq)
      ? { seq: lastUser.seq, agent: session.agent }
      : null,
    answered: [],
  };
}

async function clearSatisfiedInput(
  session: AgentSession, activationOperationId: string,
): Promise<void> {
  const marker = session.pendingInput;
  const token = marker?.token;
  if (!token) return;
  // The Session allocation intentionally precedes Message insertion. An
  // observer may see that allocation in the middle; preserve the exact marker
  // until its Message arrives or its exact writer operation is no longer live.
  // Recovery later clears a genuinely abandoned reservation.
  if (marker.messageId) {
    const message = await AgentMessages.findOneAsync(marker.messageId);
    if (!message) {
      const now = new Date();
      // New markers name their owning operation. An expired/missing operation
      // proves that writer can no longer commit; a live one may run for any
      // duration and must keep its marker. Legacy rows conservatively wait for
      // every live operation (plus their old write grace) to finish.
      if (!marker.operationId
        && now.getTime() - marker.at.getTime() < LEGACY_INPUT_WRITE_GRACE_MS) return;
      await AgentSessions.rawCollection().updateOne(
        {
          _id: session._id,
          'pendingInput.token': token,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
          operations: {
            $not: {
              $elemMatch: {
                id: marker.operationId ?? { $ne: activationOperationId },
                until: { $gt: now },
              },
            },
          },
        },
        { $unset: { pendingInput: 1 } },
      );
      return;
    }
  }
  await AgentSessions.updateAsync(
    {
      _id: session._id,
      'pendingInput.token': token,
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
    },
    { $unset: { pendingInput: 1 } },
  );
}

function expectedSnapshot(session: AgentSession): SessionQuery {
  return {
    agent: session.agent,
    userId: session.userId,
    phase: session.phase,
    nextSeq: session.nextSeq,
    updatedAt: session.updatedAt,
    'pending.verdict': session.pending?.verdict ?? { $exists: false },
    'pending.wakeToken': session.pending?.wakeToken ?? { $exists: false },
    'pendingRelay.token': session.pendingRelay?.token ?? { $exists: false },
    'pendingSystem.token': session.pendingSystem?.token ?? { $exists: false },
    'pendingInput.token': session.pendingInput?.token ?? { $exists: false },
    pendingInputs: session.pendingInputs ?? { $exists: false },
  };
}

async function materializedSystem(session: AgentSession): Promise<boolean> {
  const intent = session.pendingSystem;
  if (!intent) return false;
  return !!(await AgentMessages.findOneAsync(
    systemRowId(session._id, intent.key ?? intent.token),
  ));
}

/** Read current durable causes and prepare the one Turn they jointly imply. */
async function candidateFor(
  sessionId: string, activationOperationId: string,
): Promise<ActivationCandidate | null> {
  // Materialize exact reserved rows before asking what the Transcript owes.
  if (!(await reconcileUserMessageCommits(sessionId))) return null;
  let session = await AgentSessions.findOneAsync({
    _id: sessionId,
    erasingAt: { $exists: false },
    purgingAt: { $exists: false },
  });
  if (!session || DECIDED_PHASES.includes(session.phase) || running.has(sessionId)) return null;

  const now = new Date();
  if (liveLease(session, now)) return null;

  const inputs = await inputState(session);
  if (inputs.answered.length) {
    await clearAnsweredUserMessageLinks(sessionId, inputs.answered);
    // Select from a fresh exact Session revision after pruning compact links.
    return candidateFor(sessionId, activationOperationId);
  }
  const input = inputs.owed;
  if (!input && session.pendingInput) {
    await clearSatisfiedInput(session, activationOperationId);
  }
  if (!input && session.pendingInputs?.length) {
    await clearAnsweredUserMessageLinks(sessionId, session.pendingInputs);
    // An exact cleanup and a concurrent send are both new durable facts.
    return candidateFor(sessionId, activationOperationId);
  }
  const systemReady = await materializedSystem(session);
  const orphan = ACTIVE_PHASES.includes(session.phase);

  let kind: ActivationKind | null = null;
  if (orphan) kind = 'lease-recovery';
  else if (session.pending?.verdict) kind = 'verdict';
  // A Relay is the team's in-progress handoff and outranks a later human
  // interjection. Without one, human input outranks scheduled work.
  else if (session.pendingRelay && input) kind = 'relay';
  else if (input) kind = 'message';
  // An explicitly requested System Turn materializes its row before nudging.
  // It therefore owns this activation even if an older Relay is still parked.
  else if (systemReady) kind = 'system';
  else if (session.pendingRelay) kind = 'relay';
  else if (session.pendingSystem) {
    // A parked intent behind other work is materialized only once it becomes
    // the selected cause. This keeps approvals, Relays, and human input from
    // accidentally consuming a System Turn that was waiting behind them.
    const consumed = await consumeSystemIntent(sessionId, () => {});
    return consumed ? candidateFor(sessionId, activationOperationId) : null;
  }
  if (!kind) return null;

  let agent: string;
  if (session.pending?.verdict) agent = session.pending.agent ?? session.agent;
  else if (kind === 'system' || (orphan && systemReady)) {
    agent = session.pendingSystem?.agent ?? session.agent;
  } else if (session.pendingRelay) agent = session.pendingRelay.agent;
  else if (input) agent = input.agent;
  else agent = await resolveWakeAgent(session);

  const fingerprint = JSON.stringify([
    kind,
    session.phase,
    session.nextSeq,
    session.updatedAt.getTime(),
    session.pending?.wakeToken ?? null,
    session.pendingRelay?.token ?? null,
    session.pendingSystem?.token ?? null,
    session.pendingInput?.token ?? null,
    session.pendingInputs?.map((link) => [link.messageId, link.seq]) ?? null,
    input?.seq ?? null,
  ]);
  return {
    kind,
    fingerprint,
    session,
    agent,
    expected: expectedSnapshot(session),
  };
}

function configFor(candidate: ActivationCandidate): RunConfig | null {
  const primary = getAgent(candidate.session.agent);
  if (!primary) return null;
  const target = candidate.agent === candidate.session.agent
    ? primary
    : getAgent(candidate.agent);
  // Addressed/relay/verdict work is authority-bearing. If its named Agent is
  // unavailable, leave the durable cause standing for later registration.
  if (!target) return null;
  return buildRunConfig(target, candidate.session.userId, target === primary
    ? undefined
    : {
      agentName: candidate.agent,
      budget: resolveBudget(primary.budget),
      ...memoryOpt(primary),
    });
}

function unavailableAgent(candidate: ActivationCandidate): string | null {
  if (!getAgent(candidate.session.agent)) return candidate.session.agent;
  return getAgent(candidate.agent) ? null : candidate.agent;
}

async function persistActivationFailure(candidate: ActivationCandidate): Promise<void> {
  const operation = await beginSessionOperation(candidate.session._id);
  if (!operation) return;
  try {
    await operation.assertActive();
    await commitOperationMessage(
      operation,
      candidate.session._id,
      Random.id(),
      {
        phase: { $nin: DECIDED_PHASES },
        lease: { $exists: false },
        $and: [candidate.expected as any],
      },
      { set: { phase: 'error' } },
      () => ({
        role: 'note', kind: 'error',
        error: { error: 'turn-failed', reason: 'The agent turn could not be started.' },
        createdAt: new Date(),
      }),
    );
  } finally {
    await operation.close();
  }
}

function slotFor(sessionId: string): LocalSlot {
  const existing = slots.get(sessionId);
  if (existing) return existing;
  const created = { queued: false, running: false, dirty: false };
  slots.set(sessionId, created);
  return created;
}

async function drain(sessionId: string, slot: LocalSlot): Promise<void> {
  slot.queued = false;
  if (slot.running) return;
  slot.running = true;
  const attempted = new Set<string>();
  try {
    for (;;) {
      slot.dirty = false;
      // Acquire the lifecycle-root operation before discovery performs any
      // marker cleanup or System-intent materialization. Root erasure and this
      // acquisition are atomic competitors; the winner fences the whole pass.
      const treeOperation = await beginSessionTreeOperation(sessionId);
      if (!treeOperation) break;
      try {
        const candidate = await candidateFor(sessionId, treeOperation.id);
        if (!candidate || attempted.has(candidate.fingerprint)) break;
        attempted.add(candidate.fingerprint);

        const missing = unavailableAgent(candidate);
        if (missing) {
          if (!warnedUnavailableAgents.has(missing)) {
            warnedUnavailableAgents.add(missing);
            console.warn(
              `[10thfloor:agent] activation: unregistered agent "${missing}"; `
              + 'durable work remains pending',
            );
          }
          break;
        }
        const run = turnRunner;
        if (!run) {
          console.error('[10thfloor:agent] activation has no Turn runner installed');
          break;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await run(sessionId, () => {
            const config = configFor(candidate);
            if (!config) throw new Error('Agent unavailable during activation');
            return config;
          }, candidate.expected);
        } catch {
          // eslint-disable-next-line no-await-in-loop
          await persistActivationFailure(candidate);
          break;
        }
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await treeOperation.close();
      }
    }
  } catch {
    console.error('[10thfloor:agent] activation failed');
  } finally {
    const rerun = slot.dirty;
    slot.running = false;
    if (rerun && !slot.queued) {
      slot.queued = true;
      setTimeout(() => { void drain(sessionId, slot); }, 0);
    } else if (!slot.queued && !slot.running) {
      slots.delete(sessionId);
    }
  }
}

/** @internal Nudge current durable Session facts toward one eligible Turn.
 * Idempotent, fire-and-forget, and intentionally server-private. */
export function activate(sessionId: string): void {
  const slot = slotFor(sessionId);
  slot.dirty = true;
  if (slot.running || slot.queued) return;
  slot.queued = true;
  setTimeout(() => { void drain(sessionId, slot); }, 0);
}

/** @internal Park scheduled work, then nudge the same Activation Module used
 * by every other cause. The result vocabulary remains application-compatible. */
export async function requestSystemTurn(
  sessionId: string,
  prompt: string,
  opts?: { key?: string; agent?: string; source?: string },
): Promise<SystemTurnResult> {
  const treeOperation = await beginSessionTreeOperation(sessionId);
  if (!treeOperation) return { ok: false, reason: 'no-session' };
  try {
    return await startSystemTurnWith((id) => activate(id), sessionId, prompt, opts);
  } finally {
    await treeOperation.close();
  }
}

/** @internal */
export interface ActivationRecoveryOptions {
  sweepMs?: number;
  graceMs?: number;
}

/** @internal Observer plus expiry sweep. Both only nudge; the same
 * level-triggered planner owns final eligibility and Agent selection. */
export function startActivationRecovery(
  opts: ActivationRecoveryOptions = {},
): { stop(): Promise<void> } {
  const sweepMs = opts.sweepMs ?? 15_000;
  const graceMs = opts.graceMs ?? Math.max(sweepMs, 1000);
  let stopped = false;
  let sweeping: Promise<void> | null = null;
  let reservationCursor: { createdAt: Date; id: string } | null = null;

  const sweep = async (): Promise<void> => {
    const now = new Date();
    const rows = await AgentSessions.find({
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
      $or: [
        {
          phase: { $in: ACTIVE_PHASES },
          $or: [
            { lease: { $exists: false } },
            { lease: null },
            { 'lease.until': { $lt: now } },
          ],
        },
        {
          phase: { $nin: DECIDED_PHASES },
          updatedAt: { $lt: new Date(now.getTime() - graceMs) },
          $or: [
            { 'pending.verdict': { $exists: true } },
            { pendingRelay: { $exists: true } },
          ],
        },
        {
          phase: { $nin: DECIDED_PHASES },
          'pendingSystem.at': { $lt: new Date(now.getTime() - graceMs) },
        },
        {
          phase: { $nin: DECIDED_PHASES },
          'pendingInput.at': { $lt: new Date(now.getTime() - graceMs) },
        },
        {
          phase: { $nin: DECIDED_PHASES },
          'pendingInputs.at': { $lt: new Date(now.getTime() - graceMs) },
        },
      ],
    }, { fields: { _id: 1 } }).fetchAsync();
    // A reservation can be the only durable fact when a process died before
    // allocating its compact Session link. Revisit oldest-first every sweep;
    // the observer is only the low-latency hint, never the sole recovery path.
    const reservationQuery = reservationCursor ? {
      $or: [
        { createdAt: { $gt: reservationCursor.createdAt } },
        { createdAt: reservationCursor.createdAt, _id: { $gt: reservationCursor.id } },
      ],
    } : {};
    const reservations = await UserMessageReservations.find(reservationQuery as any, {
      sort: { createdAt: 1, _id: 1 }, fields: { sessionId: 1 }, limit: 1000,
    }).fetchAsync();
    const lastReservation = reservations.at(-1);
    reservationCursor = lastReservation
      ? { createdAt: lastReservation.createdAt, id: lastReservation._id }
      : null;

    const reservedSessionIds = [...new Set(
      reservations.map((reservation) => reservation.sessionId),
    )];
    const existingReservedSessions = reservedSessionIds.length
      ? await AgentSessions.find(
        { _id: { $in: reservedSessionIds } }, { fields: { _id: 1 } },
      ).fetchAsync()
      : [];
    const existingIds = new Set(existingReservedSessions.map((session) => session._id));
    const orphanIds = reservations
      .filter((reservation) => !existingIds.has(reservation.sessionId))
      .map((reservation) => reservation._id);
    if (orphanIds.length) {
      await UserMessageReservations.removeAsync({ _id: { $in: orphanIds } } as any);
    }

    const sessionIds = new Set(rows.map((row) => row._id));
    existingIds.forEach((id) => sessionIds.add(id));
    for (const sessionId of sessionIds) {
      if (stopped) return;
      activate(sessionId);
    }
  };

  const runSweep = (): void => {
    if (stopped || sweeping) return;
    sweeping = sweep()
      .catch(() => { console.error('[10thfloor:agent] activation recovery failed'); })
      .then(() => { sweeping = null; });
  };
  const timer = setInterval(runSweep, sweepMs);
  (timer as any).unref?.();

  let handle: { stop(): void } | null = null;
  let chain: Promise<void> = Promise.resolve();
  const notice = (sessionId: string): void => {
    chain = chain.then(() => {
      if (!stopped) activate(sessionId);
    }).catch(() => { console.error('[10thfloor:agent] activation observer failed'); });
  };
  const observing = AgentSessions.find({
    erasingAt: { $exists: false },
    purgingAt: { $exists: false },
    $or: [
      { phase: { $in: ACTIVE_PHASES } },
      { 'pending.verdict': { $exists: true } },
      { pendingRelay: { $exists: true } },
      { pendingSystem: { $exists: true } },
      { pendingInput: { $exists: true } },
      { pendingInputs: { $exists: true } },
    ],
  }, {
    fields: {
      phase: 1, pending: 1, pendingRelay: 1,
      pendingSystem: 1, pendingInput: 1, pendingInputs: 1,
      erasingAt: 1, purgingAt: 1,
    },
  }).observeChangesAsync({
    added(id: string) { notice(id); },
    changed(id: string) { notice(id); },
  }).then((observer: any) => {
    handle = observer;
    if (stopped) observer.stop();
  }).catch(() => { console.error('[10thfloor:agent] could not observe activation causes'); });

  let reservationHandle: { stop(): void } | null = null;
  const observingReservations = UserMessageReservations.find({}, {
    fields: { sessionId: 1 },
  }).observeChangesAsync({
    added(_id: string, fields: { sessionId?: string }) {
      if (fields.sessionId) notice(fields.sessionId);
    },
  }).then((observer: any) => {
    reservationHandle = observer;
    if (stopped) observer.stop();
  }).catch(() => {
    console.error('[10thfloor:agent] could not observe Transcript reservations');
  });

  // Do not wait one full interval for startup recovery. The observer is the
  // low-latency path for later writes; this first sweep covers existing rows.
  runSweep();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await observing;
      if (handle) { handle.stop(); handle = null; }
      await observingReservations;
      if (reservationHandle) { reservationHandle.stop(); reservationHandle = null; }
      await chain;
      if (sweeping) await sweeping;
    },
  };
}
