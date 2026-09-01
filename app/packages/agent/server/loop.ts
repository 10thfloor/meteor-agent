import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES, type ResolvedMemory } from '../common/types';
import { memoryBlock, memoryHint } from './memory';
import type { IdentityConfig, ResolvedExperience, ResolvedPractice } from '../common/learning';
import {
  modelFrom, modelParticipantId, participantsBlock, resolveAddressee, resolveRelay,
  unroutedMention,
} from '../common/participants';
import { systemRowId } from './system-turn';
import type { Provider } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, releaseLease,
  HEARTBEAT_MS, SERVER_ID,
} from './lease';
import type { Skill, ToolSpec } from './tools';
import { prepareToolRuntime } from './tool-runtime';
import { runProviderExchange } from './provider-exchange';
import {
  accruedCost, classifyProviderError, commitBudgetNote, running,
} from './turn-state';

// Re-exported so the loop tests keep destructuring `classifyProviderError` from
// `./loop`. Its definition now lives in `./turn-state`.
export { classifyProviderError } from './turn-state';
import { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';

// Re-exported for the same reason: `DeltaWriter` and `DEFAULT_MAX_TOOL_ARG_BYTES`
// are the attribution/perf tests' seams, and `index.ts` re-exports the ceiling
// from here as public API. Their definitions now live in `./deltas`.
export { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';
import {
  commitLeasedMessage, discardTurn, locateBatch, repairUnansweredToolUse,
} from './transcript';
import { claimStagedRefs, hydrateImageRefs } from './attachments';

// `toProviderMessages` is re-exported for the transcript tests (they destructure
// it from `./loop`); the three imported above are internal cross-module calls.
// Definitions now live in `./transcript`.
export { toProviderMessages } from './transcript';
import { assembleContext, maybeCompact } from './compaction';

// `assembleContext`/`estimateContext`/`findCompactionCut` are re-exported for the
// compaction tests; `assembleContext` and `maybeCompact` are the loop's own calls
// into the subsystem. Definitions now live in `./compaction`.
export { assembleContext, estimateContext, findCompactionCut } from './compaction';
import { dispatchCalls, resumeParkedTurn, type DispatchLimits } from './dispatch';
import { activate, installTurnRunner } from './activation';
import type { SessionQuery } from '../common/db';
import {
  LearningIntegrityError, prepareTurnLearning, type TurnLearningSnapshot,
} from './learning-runtime';
import { recordProviderRequestDigest } from './learning';

// `runTurn` passes itself to `dispatchCalls`/`resumeParkedTurn` (see the RunTurn
// note in `./dispatch`); `DispatchLimits` is the bundle it builds for them.

export interface RunConfig {
  model: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  /** Which agent this turn runs as (§4.3). Absent = session's own agent. */
  agentName?: string;
  maxIterations?: number;
  flushMs?: number;
  /** How often the stream loop re-reads the session to honor an interrupt
   *  (`phase: 'stopped'`). Tests lower it; the default keeps the cost to a few
   *  indexed reads per response. */
  interruptCheckMs?: number;
  /** §10: bounded retry with full-jitter backoff. `attempts` includes the
   *  initial try (default 3). */
  retry?: { attempts?: number; baseMs?: number; maxDelayMs?: number };
  /** §9 compaction thresholds (defaults 200_000 / 0.8 / 6); absent =
   *  compaction disabled. */
  context?: { window?: number; compactAt?: number; keep?: number };
  /** §9 budget. Always the PRIMARY agent's, even on addressed turns. */
  budget?: {
    turns?: number; systemTurns?: number; toolCalls?: number;
    spend?: number; relay?: number;
  };
  /** $ per million tokens. The FALLBACK for a provider that reports no cost of
   *  its own; see `accruedCost`. */
  pricing?: { input: number; output: number };
  /** §5.2. Oversized results are truncated to avoid wedging compaction.
   *  Default 8000. */
  maxResultChars?: number;
  /** Per-TURN ceiling on the bytes of `tool_args` deltas this turn may publish.
   *  Default 256 KiB; see `DeltaWriter`'s constructor. Display-stream hygiene
   *  only — the committed message's `toolCalls` are never clamped. */
  maxToolArgBytes?: number;
  /** §7's backstop: agent-level tool authorization, checked before gates and
   *  before dispatch. A refusal is a structured result the model reads and
   *  routes around — never a park, never a throw. */
  canUse?: (tool: string, ctx: {
    userId: string | null;
    sessionId: string;
    /** Exact model arguments for this call. Optional preserves source
     * compatibility for hosts that invoke an existing predicate directly. */
    args?: unknown;
    /** Stable provider tool-call id when the call came from a committed
     * assistant batch. */
    toolCallId?: string;
  })
    => boolean | Promise<boolean>;
  /** Skills available to the `skill` loader tool. Absent = no loader. */
  skills?: Skill[];
  /** Durable recall (memory spec). Always the PRIMARY's config so every
   *  participant sees the same memory. Absent = disabled. */
  memory?: ResolvedMemory;
  /** Stable Agent Identity and the settled episodic-learning policy. */
  identity?: IdentityConfig;
  experience?: ResolvedExperience;
  practice?: ResolvedPractice;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Full jitter to prevent lockstep retries after a provider-wide failure. */
export function backoffDelay(attemptIndex: number, baseMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseMs * 2 ** attemptIndex);
}

let backoff: typeof backoffDelay = backoffDelay;

/** TEST SEAM: pin a deterministic delay so `retrying` phase is observable.
 *  Pass null to restore the jittered default. */
export function _setBackoff(fn: typeof backoffDelay | null): () => void {
  const previous = backoff;
  backoff = fn ?? backoffDelay;
  return () => { backoff = previous; };
}

/** Run one Turn to completion. Activation supplies a lazy config factory so
 * application callbacks run only after this process wins the exact Lease. */
export async function runTurn(
  sessionId: string,
  configOrFactory: RunConfig | (() => RunConfig),
  expected?: SessionQuery,
): Promise<void> {
  let owned = false;
  // Strip-and-degrade latch (§9): one retry with images stripped if a
  // provider refuses an image the byte gate passed.
  let imagesStripped = false;

  if (running.has(sessionId)) return;   // already running in THIS process
  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId, SERVER_ID, expected))) return;
    owned = true;

    // LEASE_MS is 30s; one provider call plus a tool round trip routinely
    // exceeds that. Without this, losing the lease mid-turn is the normal case.
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);

    try {
      const config = typeof configOrFactory === 'function'
        ? configOrFactory()
        : configOrFactory;
      const maxIterations = config.maxIterations ?? 10;
      const flushMs = config.flushMs ?? 60;
      // 256 KiB per Turn. Generous by design: the largest argument payload any
      // built-in Tool produces is three orders of magnitude smaller.
      const maxToolArgBytes = config.maxToolArgBytes ?? DEFAULT_MAX_TOOL_ARG_BYTES;
      const interruptCheckMs = config.interruptCheckMs ?? 250;
      const retryAttempts = Math.max(1, config.retry?.attempts ?? 3);
      const retryBaseMs = config.retry?.baseMs ?? 500;
      const retryMaxDelayMs = config.retry?.maxDelayMs ?? 10_000;
      const limits: DispatchLimits = {
        maxResultChars: config.maxResultChars ?? 8000,
        canUse: config.canUse,
      };
      // Vision capability (§9): fails closed on absent surface or error.
      try {
        const answer = config.provider.capabilities?.imageInput?.(config.model);
        limits.imageInput = (await answer) === true;
      } catch {
        limits.imageInput = false;
      }

      if (!(await repairUnansweredToolUse(sessionId))) return;

      // Resolve any standing approval gate before the think loop — an
      // unanswered tool_use would 400 every provider call.
      const entry = await AgentSessions.findOneAsync(sessionId);
      if (!entry) return;
      // Which model participant this turn runs as (§4.3).
      const selfAgent = config.agentName ?? entry.agent;
      // Memory prompt context is suppressed for subagent children and
      // throwaways (decision 20). The Prepared Runtime independently owns the
      // matching tool eligibility and reserves the names on every surface.
      const memoryForPrompt = config.memory && !entry.parent && !entry.ephemeral
        ? config.memory : undefined;
      let learning: TurnLearningSnapshot | undefined;
      if (config.identity) {
        try {
          learning = await prepareTurnLearning({
            session: entry,
            agentName: selfAgent,
            identity: config.identity,
            experience: config.experience,
            practice: config.practice,
            factMemory: memoryForPrompt,
          });
        } catch (learningError) {
          console.error(
            '[10thfloor:agent] the Agent Memory Frame could not be prepared:',
            (learningError as Error)?.message ?? learningError,
          );
          if (entry.pending && !(learningError instanceof LearningIntegrityError)) {
            // Only a changed-causes verdict may destroy a park. Anything
            // else — a store read failure, an identity read hiccup — leaves
            // the park and its recorded verdict as the repairable state.
            // Activation latches an unchanged cause per drain, so the retry
            // arrives with the watcher sweep or the next session activity;
            // the pause bounds spin when a drain does re-attempt.
            await sleep(1000);
            return;
          }
          // A parked Turn may be recovering after its frozen Fact Memory
          // EVIDENCE was edited or erased. Fail closed without leaving its
          // approval marker immortal: fence the park and record the
          // actionable restart state atomically, then discard the incomplete
          // tool batch. The next user message gets a new trigger and
          // therefore a fresh immutable Frame.
          let pendingBatch: ReturnType<typeof locateBatch> = null;
          if (entry.pending) {
            const messages = await AgentMessages.find(
              { sessionId }, { sort: { seq: 1 } },
            ).fetchAsync();
            pendingBatch = locateBatch(messages, entry.pending.toolCallId);
          }
          const errorSeq = await commitLeasedMessage(sessionId, {
            _id: Random.id(), role: 'note', kind: 'error',
            error: {
              error: 'learning-unavailable',
              reason: entry.pending
                ? 'The Agent memory snapshot changed while this turn was waiting. Send the request again to restart with current memory.'
                : 'The Agent identity and learning frame could not be prepared.',
            },
            createdAt: new Date(),
          }, {
            set: { phase: 'error' },
            ...(entry.pending ? { unset: { pending: 1 as const } } : {}),
            unlessStopped: true,
          });
          if (errorSeq !== null && pendingBatch) {
            await discardTurn(
              sessionId,
              pendingBatch.assistant._id,
              pendingBatch.assistant.seq,
              (pendingBatch.assistant.toolCalls ?? []).map((call) => call.id),
              pendingBatch.windowEnd,
            );
          }
          return;
        }
      }
      // Discovery runs only after the exact Lease claim. One Prepared Runtime
      // owns both the dispatch catalog and provider schemas, including the
      // built-in name precedence, so those two views cannot drift.
      const prepared = await prepareToolRuntime({
        specs: config.tools,
        skills: config.skills,
        memory: config.memory
          ? {
            config: config.memory,
            session: entry,
            agent: selfAgent,
          }
          : undefined,
        learning: learning && (
          config.experience || config.practice
          || learning.frame.learningPolicy?.experienceRecording
          || (learning.frame.learningPolicy?.experienceRecallLimit ?? 0) > 0
          || (learning.frame.learningPolicy?.practiceAcquisition ?? 'disabled') !== 'disabled'
        )
          ? {
            config: config.experience,
            practice: config.practice,
            agentId: learning.agentId,
            frame: learning.frame,
          }
          : undefined,
        reserveLearningNames: !!(config.experience || config.practice),
      });
      const { tools, schemas } = prepared;
      // Hint cached by user-row seq (§6) — recomputed only on interjection
      // or compaction, not per attempt.
      let hintSeq = -1;
      let hintTitles: string[] = [];
      // Relay marker consumed on first COMMIT, not at entry — a crash
      // before any commit must leave the wake standing for recovery.
      const consumingRelayToken = entry.pendingRelay?.agent === selfAgent
        ? entry.pendingRelay.token : undefined;
      let relayStanding = consumingRelayToken;
      // Latch on the intent's ROW, not the marker — a concurrent send can
      // start while an intent stands.
      const consumingSystemToken = entry.pendingSystem !== undefined
        && (await AgentMessages.findOneAsync(
          systemRowId(sessionId, entry.pendingSystem.key ?? entry.pendingSystem.token),
        )) !== undefined
        ? entry.pendingSystem.token : undefined;
      // Bill system-turn budget once, not per iteration — without the latch
      // a multi-iteration system turn would over-count.
      let systemUnbilled = consumingSystemToken !== undefined;
      if (entry.pending) {
        if (!entry.pending.verdict) {
          // Re-entry while parked (recovering-server case): exit as the
          // parking run did. 'awaiting' = live request, only approve/deny
          // resolves it; 'stopped' = interrupted, a later send clears it.
          if (entry.phase === 'awaiting' || entry.phase === 'stopped') return;

          // Park was overtaken (interrupted then sent again) — the call can
          // never be answered now, so discard the dead turn.
          const msgs = await AgentMessages
            .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
          const batch = locateBatch(msgs, entry.pending.toolCallId);
          if (batch) {
            await discardTurn(
              sessionId, batch.assistant._id, batch.assistant.seq,
              (batch.assistant.toolCalls ?? []).map((c) => c.id), batch.windowEnd,
            );
          }
          if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) return;
        } else {
          // Only the parking model's turn consumes the verdict (decision 6);
          // anyone else's wake leaves it standing.
          if ((entry.pending.agent ?? entry.agent) !== selfAgent) return;
          const outcome = await resumeParkedTurn(
            sessionId, entry.pending, tools, entry.userId, selfAgent,
            config.budget, limits, runTurn,
            entry.participants?.length ? modelFrom(selfAgent) : undefined,
            learning ? {
              agentId: learning.agentId, memoryFrameId: learning.memoryFrameId,
            } : undefined,
          );
          // 'parked' means the NEXT gate in the same batch is now waiting on a
          // human; 'abandoned' means the turn is gone. Either way the think
          // loop must not run.
          if (outcome !== 'completed') return;
        }
      }

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const session = await AgentSessions.findOneAsync(sessionId);
        if (!session) return;
        // A stop that landed between iterations must not be overwritten
        // by the 'streaming' write below.
        if (session.phase === 'stopped') return;

        // §9: checked per iteration BEFORE the provider call so a tool-using
        // run stops at the boundary. The turn that crosses the cap still
        // completes; the next one is refused.
        if (config.budget?.spend !== undefined
          && session.usage.cost >= config.budget.spend) {
          await commitBudgetNote(sessionId, 'spend');
          return;
        }

        let history = await AgentMessages
          .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

        // Re-resolve addressed messages at the iteration top (§4.3) — a
        // colleague-addressed message can enter history without passing the
        // interjection branch, and answering it here would be the wrong model.
        if (session.participants?.length) {
          const tail = [...history].reverse().find((m) => m.role === 'user');
          if (tail) {
            const target = resolveAddressee(tail.content, tail.to, session);
            if (target && target.agent !== selfAgent
              && !history.some((m) => m.role === 'assistant' && m.seq > tail.seq
                && (m.from?.participant ?? modelParticipantId(session.agent)) === target.id)) {
              await guardedUpdate(sessionId, SERVER_ID, {
                $set: { pendingRelay: { agent: target.agent, token: Random.id() } },
              });
              return;
            }
          }
        }

        // §9: compact before the provider call; re-read if a note was committed.
        if (await maybeCompact(
          sessionId, session.agent, config, history, schemas, interruptCheckMs,
        )) {
          history = await AgentMessages
            .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
        }

        const historyMaxSeq = history.length ? history[history.length - 1].seq : -1;

        let messageId = Random.id();
        // Deltas sort at the expected commit seq; an interjection bumps the
        // committed seq but the row still supersedes the in-flight one.
        // Retries reuse msgSeq (only messageId changes per attempt).
        const msgSeq = session.nextSeq;
        // Distinguishes THIS process's attempts from a pre-crash run's: the
        // attempt counter restarts at zero on recovery, and the rebuilt
        // request is not guaranteed byte-identical (roster, MCP tool order, a
        // redeployed prompt), so a durable key reusing the counter would
        // conflict at the paid-work boundary instead of recording truthfully.
        const attemptRun = Random.id(8);

        let text = '';
        let thinking = '';
        let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
        let usage: { input: number; output: number; cost?: number } = { input: 0, output: 0 };
        let interrupted = false;

        // §10: each pass is one attempt with a fresh DeltaWriter/messageId
        // so straggler flushes from a dead attempt cannot collide.
        for (let attemptIndex = 0; ; attemptIndex += 1) {
          // Per ATTEMPT: phase-conditional so a stop that landed during
          // compaction is not overwritten. Zero matched = return.
          const streaming = await AgentSessions.updateAsync(
            { _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' } },
            { $set: { phase: 'streaming', updatedAt: new Date() } },
          );
          if (streaming !== 1) return;

          const writer = new DeltaWriter(
            sessionId, messageId, msgSeq, flushMs, maxToolArgBytes,
            // Streaming attribution (participants spec §4.1): rostered turns
            // stamp the speaker on their deltas so the in-flight row can be
            // labelled; 1:1 deltas stay byte-identical.
            session.participants?.length ? modelFrom(selfAgent) : undefined,
          );
          text = '';
          thinking = '';
          toolCalls = undefined;
          usage = { input: 0, output: 0 };
          const attemptOutput: {
            toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
            usage: { input: number; output: number; cost?: number };
          } = { toolCalls: undefined, usage };
          interrupted = false;
          let providerFailed = false;
          let providerError: unknown;
          // Whether THIS attempt's request carried hydrated images — the
          // strip-and-degrade branch below keys on it (participants spec §9).
          let attemptHadImages = false;

          try {
            const assembled = assembleContext(history, session.participants?.length ? {
              self: modelParticipantId(selfAgent),
              primary: modelParticipantId(session.agent),
              participants: session.participants,
            } : undefined);
            // Memory block (§6). Listing rebuilt per attempt so freshly saved
            // facts are immediately visible; hint is cached (see above).
            let memoryText = learning?.factMemoryText ?? '';
            if (memoryForPrompt && !learning) {
              if (memoryForPrompt.hints) {
                const lastUser = [...history].reverse().find((m) => m.role === 'user');
                if (lastUser && hintSeq !== lastUser.seq) {
                  hintSeq = lastUser.seq;
                  hintTitles = await memoryHint(lastUser.content ?? '', {
                    userId: session.userId, agent: selfAgent, config: memoryForPrompt,
                  });
                }
              }
              memoryText = await memoryBlock({
                userId: session.userId,
                agent: selfAgent,
                config: memoryForPrompt,
                ...(hintTitles.length ? { hint: hintTitles } : {}),
              });
            }
            // Image hydration (§9) — after compaction estimate, never on the
            // summarizer path, skipped once strip-and-degrade fired.
            let requestHasImages = false;
            if (limits.imageInput === true && !imagesStripped) {
              requestHasImages = await hydrateImageRefs(sessionId, history, assembled);
            }
            attemptHadImages = requestHasImages;
            const exchange = await runProviderExchange({
              sessionId,
              provider: config.provider,
              interruptCheckMs,
              context: {
                agent: selfAgent, sessionId, purpose: 'think',
                ...(learning ? {
                  agentId: learning.agentId, memoryFrameId: learning.memoryFrameId,
                } : {}),
              },
              request: {
                model: config.model,
                // Participants block appended per iteration so roster changes
                // mid-conversation are visible at the next boundary.
                system: (session.participants?.length
                  ? config.system + participantsBlock(session, selfAgent)
                  : config.system) + memoryText,
                messages: assembled,
                tools: schemas,
              },
              protectedSystem: learning?.protectedSystem,
              onEffectiveRequest: learning
                ? async (_request, digest) => {
                  await recordProviderRequestDigest(
                    learning!.memoryFrameId,
                    digest,
                    {
                      kind: 'system',
                      // The durable assistant commit slot survives process
                      // restarts; the per-run nonce keeps a recovery's
                      // attempt 0 from aliasing the pre-crash attempt 0 whose
                      // rebuilt bytes may differ. Every attempt records; the
                      // audit trail carries them all.
                      key: `provider:${learning!.memoryFrameId}:${msgSeq}:${attemptRun}:${attemptIndex}`,
                      sessionId,
                      triggerSeq: learning!.triggerSeq,
                    },
                  );
                }
                : undefined,
              onChunk(chunk) {
                if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
                else if (chunk.kind === 'thinking') {
                  thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
                } else if (chunk.kind === 'tool_args') {
                  // Streamed for display only — dispatch reads the parsed calls
                  // off the `done` chunk, not these deltas.
                  writer.push('tool_args', chunk.chunk, chunk.contentIndex);
                } else if (chunk.kind === 'done') {
                  attemptOutput.toolCalls = chunk.toolCalls;
                  attemptOutput.usage = chunk.usage ?? attemptOutput.usage;
                }
              },
            });
            toolCalls = attemptOutput.toolCalls;
            usage = attemptOutput.usage;
            if (exchange.kind === 'interrupted') interrupted = true;
            else if (exchange.kind === 'failed') {
              providerFailed = true;
              providerError = exchange.error;
            }
          } catch (error) {
            providerFailed = true;
            providerError = error;
          } finally {
            // Tail-flush rejection is NOT a provider failure — a Mongo blip
            // here must not re-stream the entire response.
            await writer.stop().catch(() => {
              /* deltas are ephemeral; the commit supersedes them */
            });
          }

          if (interrupted) {
            await AgentDeltas.removeAsync({ messageId });
            return;
          }

          if (providerFailed) {
            // Per-attempt cleanup: this attempt's partial never commits, so
            // its deltas must not linger as a streaming ghost row either.
            await AgentDeltas.removeAsync({ messageId });

            // A stop outranks retry and error-note paths. Provider Exchange
            // closes the final-yield race; this read also covers local request
            // assembly failures that happened before the exchange began.
            const live = await AgentSessions.findOneAsync(sessionId);
            if (!live || live.phase === 'stopped') return;

            const classification = classifyProviderError(providerError);
            // Abandoned request — nothing failed at the user, just exit.
            if (classification === 'abandon') return;
            // Strip-and-degrade retry (see the latch doc above).
            if (classification === 'fatal' && attemptHadImages && !imagesStripped) {
              imagesStripped = true;
              messageId = Random.id();   // fresh id: the old deltas are gone
              continue;
            }
            const hasMoreAttempts = attemptIndex + 1 < retryAttempts;
            if (classification === 'retryable' && hasMoreAttempts) {
              if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'retrying' } }))) return;
              await sleep(backoff(attemptIndex, retryBaseMs, retryMaxDelayMs));
              // Re-check for interrupt after the backoff sleep.
              const afterSleep = await AgentSessions.findOneAsync(sessionId);
              if (!afterSleep || afterSleep.phase === 'stopped') return;
              messageId = Random.id(); // fresh id: the old deltas are gone
              continue;
            }

            // Fatal or exhausted: commit a sanitized note. NEVER the raw
            // provider message — it can carry key fragments.
            const noteSeq = await commitLeasedMessage(sessionId, {
              _id: Random.id(), role: 'note', kind: 'error',
              error: { error: 'provider-failed', reason: 'The model request failed.' },
              createdAt: new Date(),
            }, { set: { phase: 'error' }, unlessStopped: true });
            if (noteSeq === null) {
              // Lost lease between failure and note — session may show stale phase.
              console.warn(
                '[10thfloor:agent] lost lease before error note; the session '
                + 'may display a stale phase',
              );
            }
            return;
          }

          break; // this attempt succeeded; fall through to commit below
        }

        if (interrupted) {
          // Nothing committed yet: the partial exists only as deltas. Remove
          // them or they render as a streaming ghost row forever.
          await AgentDeltas.removeAsync({ messageId });
          return;
        }

        // Commit + cost ride ONE Transcript transaction — no window where
        // a committed message's cost is unseen by the spend budget.

        // Relay: a turn-final @mention schedules the named model's turn.
        // Parsed before commit so the wake rides the same atomic transaction.
        const turnFinal = !toolCalls || toolCalls.length === 0;
        const roster = session.participants?.length ? session.participants : null;
        const relayHit = turnFinal && roster
          ? resolveRelay(text, session, selfAgent) : null;
        const relayCount = session.relay ?? 0;
        const relayCap = config.budget?.relay ?? 4;
        const relaying = relayHit !== null && relayCount < relayCap;

        // Claim staged attachment refs on turn-final rows (§8). Relay-addressed
        // replies skip this (decision 13) — refs stay for the outward reply.
        const staged = (turnFinal && !relayHit)
          ? await claimStagedRefs(sessionId)
          : [];

        const commitSeq = await commitLeasedMessage(sessionId, {
          _id: messageId, role: 'assistant',
          // What this reply actually answered: the newest user row the model
          // SAW. A mid-stream interjection outranks it, so activation starts
          // a fresh turn instead of classifying the interjection answered.
          answeredThrough: history.reduce(
            (max, m) => (m.role === 'user' && m.seq > max ? m.seq : max), 0,
          ),
          content: text, thinking: thinking || undefined,
          toolCalls, usage,
          ...(staged.length > 0 ? { attachments: staged } : {}),
          // Attribution (decision 4) on rostered rows only.
          ...(roster ? { from: modelFrom(selfAgent) } : {}),
          ...(relayHit ? { to: relayHit.id } : {}),
          createdAt: new Date(),
        }, {
          inc: {
            'usage.input': usage.input,
            'usage.output': usage.output,
            'usage.cost': accruedCost(usage, config.pricing),
            // System-turn budget is billed on the first real commit.
            ...(systemUnbilled ? { 'budgetSpent.systemTurns': 1 } : {}),
          },
          set: relaying
            ? {
              pendingRelay: { agent: relayHit!.agent, token: Random.id() },
              relay: relayCount + 1,
            }
            : (!turnFinal ? { phase: 'calling' } : undefined),
          // Relay/intent consumption occurs on first commit, not Turn entry.
          unset: {
            ...(!relaying && relayStanding ? { pendingRelay: 1 as const } : {}),
            ...(systemUnbilled && consumingSystemToken
              ? { pendingSystem: 1 as const } : {}),
          },
          unlessStopped: true,
          ...(!relaying && relayStanding
            ? { pendingRelayToken: relayStanding } : {}),
          ...(systemUnbilled && consumingSystemToken
            ? { pendingSystemToken: consumingSystemToken } : {}),
        });
        if (commitSeq === null) { await discardTurn(sessionId, messageId, msgSeq); return; }
        // The Message and charge committed together; later iterations must not bill again.
        systemUnbilled = false;
        relayStanding = undefined;

        // Note-only near-miss: a model was named but not addressed.
        // See `unroutedMention` for why auto-addressing is the wrong fix.
        if (turnFinal && roster && !relayHit) {
          const missed = unroutedMention(text, session, selfAgent);
          if (missed) {
            await commitLeasedMessage(sessionId, {
              _id: Random.id(), role: 'note',
              kind: 'unrouted-mention', mentioned: missed,
              error: {
                error: 'unrouted-mention',
                reason: `@${missed} was named but not addressed — only a mention at the `
                  + 'START of a message schedules a turn, so nothing was sent.',
              },
              createdAt: new Date(),
            });
          }
        }

        // The capped relay's explanation — note-ONLY, deliberately not
        // `commitBudgetNote`, which stops the session: a conversation that
        // hit its hop limit is idle and answerable, not wedged (decision 7).
        if (relayHit && !relaying) {
          await commitLeasedMessage(sessionId, {
            _id: Random.id(), role: 'note', kind: 'budget', budget: 'relay',
            error: {
              error: 'budget-exhausted',
              reason: 'Relay budget reached — a human message resets it.',
            },
            createdAt: new Date(),
          });
        }

        // Committed message supersedes its deltas — remove so old sessions
        // don't ship every token ever streamed.
        await AgentDeltas.removeAsync({ messageId });

        if (!toolCalls || toolCalls.length === 0) {
          // A reply that scheduled a relay ends this turn — the addressee's
          // wake is durable (`pendingRelay`) and the wind-down self-check
          // fires it in-process; the watcher is the cross-crash net.
          if (relaying) return;
          // A send that landed mid-stream would be stranded unanswered
          // unless we loop to pick it up.
          const interjected = await AgentMessages.findOneAsync({
            sessionId, role: 'user', seq: { $gt: historyMaxSeq },
          });
          if (interjected) {
            // Re-resolve a rostered interjection's addressee (§4.3) — its
            // deferred wake was dropped by the running/lease guards.
            // Same-addressee interjections keep the continue.
            if (roster) {
              const target = resolveAddressee(interjected.content, interjected.to, session);
              if (target && target.agent !== selfAgent) {
                await guardedUpdate(sessionId, SERVER_ID, {
                  $set: { pendingRelay: { agent: target.agent, token: Random.id() } },
                });
                return;
              }
            }
            // A Memory Frame belongs to exactly one trigger. Let Activation
            // start a new Turn so a same-Agent interjection cannot continue
            // under the previous trigger's frozen causes.
            if (learning) return;
            continue;
          }
          return;
        }

        const callIds = toolCalls.map((c) => c.id);

        const outcome = await dispatchCalls(sessionId, toolCalls, tools, {
          userId: session.userId,
          agent: selfAgent,
          messageId,
          assistantSeq: commitSeq,
          batchIds: callIds,
          ...(learning ? {
            agentId: learning.agentId, memoryFrameId: learning.memoryFrameId,
          } : {}),
          ...(roster ? { from: modelFrom(selfAgent) } : {}),
        }, config.budget, limits, runTurn);
        // A park exits the turn with the batch deliberately unanswered; an
        // abandonment has already erased it. Only a fully answered batch may
        // go round again and ask the model what to do with the results.
        if (outcome !== 'completed') return;
      }

      // Falling out of the bounded loop used to look like a successful idle
      // turn even though no terminal model answer existed. Preserve the last
      // valid tool result and expose a durable, structured terminal failure.
      const reason = `The agent reached the configured limit of ${maxIterations} model iterations.`;
      await commitLeasedMessage(sessionId, {
        _id: Random.id(), role: 'note', kind: 'error',
        error: { error: 'max-iterations', reason },
        createdAt: new Date(),
      }, { set: { phase: 'error' }, unlessStopped: true });
    } finally {
      clearInterval(beat);
      // `stopped`, `error`, and `awaiting` are deliberate terminal states —
      // idling them back would erase the decision they preserve.
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && !DECIDED_PHASES.includes(current.phase)) {
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);
    // Every caller, recovery path, and wind-down now crosses the same
    // level-triggered Activation Interface. A stale nudge is a no-op.
    if (owned) activate(sessionId);
  }
}

// Internal Adapter installation keeps Activation free of a Turn import cycle.
installTurnRunner(runTurn);
