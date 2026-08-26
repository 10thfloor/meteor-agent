import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES, type ResolvedMemory } from '../common/types';
import { memoryBlock, memoryHint } from './memory';
import { withMemoryTools } from './memory-tools';
import {
  modelFrom, modelParticipantId, participantsBlock, resolveAddressee, resolveRelay,
  unroutedMention,
} from '../common/participants';
import { resolveWakeAgent, unansweredAddressee } from './participants';
import { getAgent, buildRunConfig, resolveBudget, memoryOpt } from './registry';
import { consumeSystemIntent, systemRowId } from './system-turn';
import type { Provider } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, releaseLease,
  HEARTBEAT_MS, SERVER_ID,
} from './lease';
import {
  expandMcpTools, resolveTools, toolSchemas, withSkillTool,
  type Skill, type ToolSpec,
} from './tools';
import { runBeforeProviderRequest } from './hooks';
import {
  accruedCost, allocateSeq, classifyProviderError, commitBudgetNote, running,
} from './turn-state';

// Re-exported so the loop tests keep destructuring `classifyProviderError` from
// `./loop`. Its definition now lives in `./turn-state`.
export { classifyProviderError } from './turn-state';
import { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';

// Re-exported for the same reason: `DeltaWriter` and `DEFAULT_MAX_TOOL_ARG_BYTES`
// are the attribution/perf tests' seams, and `index.ts` re-exports the ceiling
// from here as public API. Their definitions now live in `./deltas`.
export { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';
import { discardTurn, locateBatch, repairUnansweredToolUse } from './transcript';
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
  canUse?: (tool: string, ctx: { userId: string | null; sessionId: string })
    => boolean | Promise<boolean>;
  /** Skills available to the `skill` loader tool. Absent = no loader. */
  skills?: Skill[];
  /** Durable recall (memory spec). Always the PRIMARY's config so every
   *  participant sees the same memory. Absent = disabled. */
  memory?: ResolvedMemory;
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

/** Run one turn to completion. Idempotent: recovery is just calling again. */
export async function runTurn(sessionId: string, config: RunConfig): Promise<void> {
  const maxIterations = config.maxIterations ?? 10;
  const flushMs = config.flushMs ?? 60;
  // 256 KiB per turn. Generous by design: the largest argument payload any of
  // this package's own tools produces is three orders of magnitude smaller, so
  // a turn that reaches this is pathological, not merely busy.
  const maxToolArgBytes = config.maxToolArgBytes ?? DEFAULT_MAX_TOOL_ARG_BYTES;
  const interruptCheckMs = config.interruptCheckMs ?? 250;
  // `attempts` counts the initial try; 0 would silently behave as 1, so floor it.
  const retryAttempts = Math.max(1, config.retry?.attempts ?? 3);
  const retryBaseMs = config.retry?.baseMs ?? 500;
  const retryMaxDelayMs = config.retry?.maxDelayMs ?? 10_000;
  const limits: DispatchLimits = {
    maxResultChars: config.maxResultChars ?? 8000,
    canUse: config.canUse,
  };
  // Both feed the durable-wake check in the outer `finally` — see there.
  let owned = false;
  let resumed = false;
  // Strip-and-degrade latch (§9): one retry with images stripped if a
  // provider refuses an image the byte gate passed.
  let imagesStripped = false;

  if (running.has(sessionId)) return;   // already running in THIS process
  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return;   // another server owns this run
    owned = true;

    // LEASE_MS is 30s; one provider call plus a tool round trip routinely
    // exceeds that. Without this, losing the lease mid-turn is the normal case.
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);

    try {
      // MCP discovery runs AFTER claimLease: discovery can burn a full timeout
      // per server, and doing it before the lease spawned duplicate copies.
      const baseTools = withSkillTool(
        await expandMcpTools(resolveTools(config.tools)), config.skills,
      );

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
      // Memory tools need `selfAgent` for the `by` stamp. Suppressed for
      // subagent children and throwaways (decision 20).
      const memoryOn = config.memory && !entry.parent && !entry.ephemeral
        ? config.memory : undefined;
      const tools = withMemoryTools(
        baseTools,
        memoryOn
          ? {
            config: memoryOn,
            by: modelParticipantId(selfAgent),
            agent: selfAgent,
            userId: entry.userId,
          }
          : undefined,
      );
      const schemas = toolSchemas(tools);
      // Hint cached by user-row seq (§6) — recomputed only on interjection
      // or compaction, not per attempt.
      let hintSeq = -1;
      let hintTitles: string[] = [];
      // Relay marker consumed on first COMMIT, not at entry — a crash
      // before any commit must leave the wake standing for recovery.
      const consumingRelay = entry.pendingRelay?.agent === selfAgent;
      // Latch on the intent's ROW, not the marker — a concurrent send can
      // start while an intent stands.
      const consumingSystem = entry.pendingSystem !== undefined
        && (await AgentMessages.findOneAsync(
          systemRowId(sessionId, entry.pendingSystem.key ?? entry.pendingSystem.token),
        )) !== undefined;
      // Bill system-turn budget once, not per iteration — without the latch
      // a multi-iteration system turn would over-count.
      let systemUnbilled = consumingSystem;
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
          resumed = true;
          const outcome = await resumeParkedTurn(
            sessionId, entry.pending, tools, entry.userId, selfAgent,
            config.budget, limits, runTurn,
            entry.participants?.length ? modelFrom(selfAgent) : undefined,
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
          interrupted = false;
          let lastPhaseCheck = Date.now();
          let providerError: unknown = null;
          // Whether THIS attempt's request carried hydrated images — the
          // strip-and-degrade branch below keys on it (participants spec §9).
          let attemptHadImages = false;
          // Fresh per attempt: an aborted attempt's signal must not poison its
          // retry, and a signal is single-shot.
          const abort = new AbortController();

          try {
            // Hooks run per ATTEMPT so a retry re-runs the chain. `signal` is
            // attached AFTER hooks — a hook must not disable the interrupt.
            const assembled = assembleContext(history, session.participants?.length ? {
              self: modelParticipantId(selfAgent),
              primary: modelParticipantId(session.agent),
              participants: session.participants,
            } : undefined);
            // Memory block (§6). Listing rebuilt per attempt so freshly saved
            // facts are immediately visible; hint is cached (see above).
            let memoryText = '';
            if (memoryOn) {
              if (memoryOn.hints) {
                const lastUser = [...history].reverse().find((m) => m.role === 'user');
                if (lastUser && hintSeq !== lastUser.seq) {
                  hintSeq = lastUser.seq;
                  hintTitles = await memoryHint(lastUser.content ?? '', {
                    userId: session.userId, agent: selfAgent, config: memoryOn,
                  });
                }
              }
              memoryText = await memoryBlock({
                userId: session.userId,
                agent: selfAgent,
                config: memoryOn,
                ...(hintTitles.length ? { hint: hintTitles } : {}),
              });
            }
            // Image hydration (§9) — after compaction estimate, never on the
            // summarizer path, skipped once strip-and-degrade fired.
            let requestHasImages = false;
            if (limits.imageInput === true && !imagesStripped) {
              requestHasImages = await hydrateImageRefs(sessionId, history, assembled);
            }
            const request = await runBeforeProviderRequest({
              model: config.model,
              // Participants block appended per iteration so roster changes
              // mid-conversation are visible at the next boundary.
              system: (session.participants?.length
                ? config.system + participantsBlock(session, selfAgent)
                : config.system) + memoryText,
              messages: assembled,
              tools: schemas,
            }, { agent: selfAgent, sessionId, purpose: 'think' });
            attemptHadImages = requestHasImages;
            try {
              for await (const chunk of config.provider.stream({
                ...request, signal: abort.signal,
              })) {
                if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
                else if (chunk.kind === 'thinking') {
                  thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
                } else if (chunk.kind === 'tool_args') {
                  // Streamed for display only — dispatch reads the parsed calls
                  // off the `done` chunk, not these deltas.
                  writer.push('tool_args', chunk.chunk, chunk.contentIndex);
                } else if (chunk.kind === 'done') {
                  toolCalls = chunk.toolCalls;
                  usage = chunk.usage ?? usage;
                }
                // Honor an interrupt WHILE streaming — without this the stream
                // runs to completion and dispatches its tools anyway.
                if (Date.now() - lastPhaseCheck >= interruptCheckMs) {
                  lastPhaseCheck = Date.now();
                  const s = await AgentSessions.findOneAsync(sessionId);
                  if (!s || s.phase === 'stopped') {
                    // Abort BEFORE breaking: the break only stops consuming;
                    // the abort is what cancels the HTTP request behind the
                    // stream, which otherwise keeps arriving and billing.
                    abort.abort();
                    interrupted = true;
                    break;
                  }
                }
              }
            } finally {
              // Tail-flush rejection is NOT a provider failure — a Mongo blip
              // here must not re-stream the entire response.
              await writer.stop().catch(() => {
                /* deltas are ephemeral; the commit supersedes them */
              });
            }
          } catch (e) {
            providerError = e;
          }

          if (providerError) {
            // Per-attempt cleanup: this attempt's partial never commits, so
            // its deltas must not linger as a streaming ghost row either.
            await AgentDeltas.removeAsync({ messageId });

            // A stop outranks retry and error-note paths. Re-read because an
            // attempt that throws before yielding any chunk never runs the
            // in-stream interrupt check.
            const live = await AgentSessions.findOneAsync(sessionId);
            if (interrupted || !live || live.phase === 'stopped') return;

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
            const noteSeq = await allocateSeq(sessionId);
            if (noteSeq !== null) {
              await AgentMessages.insertAsync({
                _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'error',
                error: { error: 'provider-failed', reason: 'The model request failed.' },
                createdAt: new Date(),
              });
              await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'error' } });
            } else {
              // Lost lease between failure and note — session may show stale phase.
              console.warn(
                `[10thfloor:agent] lost lease before error note; session ${sessionId} `
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

        // Commit + cost ride ONE atomic write (allocateSeq) — no window where
        // a committed message's cost is unseen by the spend budget.

        // Relay: a turn-final @mention schedules the named model's turn.
        // Parsed before allocateSeq so the wake rides the same atomic write.
        const turnFinal = !toolCalls || toolCalls.length === 0;
        const roster = session.participants?.length ? session.participants : null;
        const relayHit = turnFinal && roster
          ? resolveRelay(text, session, selfAgent) : null;
        const relayCount = session.relay ?? 0;
        const relayCap = config.budget?.relay ?? 4;
        const relaying = relayHit !== null && relayCount < relayCap;

        const commitSeq = await allocateSeq(sessionId, {
          'usage.input': usage.input,
          'usage.output': usage.output,
          'usage.cost': accruedCost(usage, config.pricing),
          // System-turn budget billed here (decision 14), not at park — a
          // turn that never ran is never billed. See `systemUnbilled`.
          ...(systemUnbilled ? { 'budgetSpent.systemTurns': 1 } : {}),
        }, relaying ? {
          pendingRelay: { agent: relayHit!.agent, token: Random.id() },
          relay: relayCount + 1,
        } : undefined,
        // Relay/intent consumption (decision 7): cleared on first commit,
        // not turn entry, so a crash leaves the wake standing for recovery.
        {
          ...(!relaying && consumingRelay ? { pendingRelay: 1 as const } : {}),
          ...(consumingSystem ? { pendingSystem: 1 as const } : {}),
        });
        if (commitSeq === null) { await discardTurn(sessionId, messageId, msgSeq); return; }
        // A real commit landed and carried the charge; every later commit this
        // turn makes must not repeat it. (A null return meant a lost lease and
        // no write, so the latch stays true for a clean single bill on recovery.)
        systemUnbilled = false;

        // Claim staged attachment refs on turn-final rows (§8). Relay-addressed
        // replies skip this (decision 13) — refs stay for the outward reply.
        const staged = (turnFinal && !relayHit)
          ? await claimStagedRefs(sessionId)
          : [];

        await AgentMessages.insertAsync({
          _id: messageId, sessionId, seq: commitSeq, role: 'assistant',
          content: text, thinking: thinking || undefined,
          toolCalls, usage,
          ...(staged.length > 0 ? { attachments: staged } : {}),
          // Attribution (decision 4) on rostered rows only.
          ...(roster ? { from: modelFrom(selfAgent) } : {}),
          ...(relayHit ? { to: relayHit.id } : {}),
          createdAt: new Date(),
        });

        // Note-only near-miss: a model was named but not addressed.
        // See `unroutedMention` for why auto-addressing is the wrong fix.
        if (turnFinal && roster && !relayHit) {
          const missed = unroutedMention(text, session, selfAgent);
          if (missed) {
            const noteSeq = await allocateSeq(sessionId);
            if (noteSeq !== null) {
              await AgentMessages.insertAsync({
                _id: Random.id(), sessionId, seq: noteSeq, role: 'note',
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
        }

        // The capped relay's explanation — note-ONLY, deliberately not
        // `commitBudgetNote`, which stops the session: a conversation that
        // hit its hop limit is idle and answerable, not wedged (decision 7).
        if (relayHit && !relaying) {
          const noteSeq = await allocateSeq(sessionId);
          if (noteSeq !== null) {
            await AgentMessages.insertAsync({
              _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'budget',
              budget: 'relay',
              error: {
                error: 'budget-exhausted',
                reason: 'Relay budget reached — a human message resets it.',
              },
              createdAt: new Date(),
            });
          }
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
            continue;
          }
          return;
        }

        const callIds = toolCalls.map((c) => c.id);
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'calling' } });

        const outcome = await dispatchCalls(sessionId, toolCalls, tools, {
          userId: session.userId,
          agent: selfAgent,
          messageId,
          assistantSeq: commitSeq,
          batchIds: callIds,
          ...(roster ? { from: modelFrom(selfAgent) } : {}),
        }, config.budget, limits, runTurn);
        // A park exits the turn with the batch deliberately unanswered; an
        // abandonment has already erased it. Only a fully answered batch may
        // go round again and ask the model what to do with the results.
        if (outcome !== 'completed') return;
      }
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

    // Durable-wake self-check: a verdict/relay/intent/tail that raced the
    // wind-down gets a run of its own. Bounded (not a watcher) — fires only
    // for a lease-holding run that did not itself resume a verdict.
    if (owned) {
      const after = await AgentSessions.findOneAsync(sessionId).catch(() => null);
      // 'error' belongs in this exclusion list for the same reason it is in
      // the finally's terminal list: a failed turn is not ours to wake, and
      // the two lists disagreeing was itself a reviewed defect.
      const wakeable = after
        && !DECIDED_PHASES.includes(after.phase)
        && !running.has(sessionId);
      // Four wake kinds: verdict, relay, system intent, unanswered tail.
      const verdictWake = !!(wakeable && !resumed && after.pending?.verdict);
      const relayWake = !!(wakeable && after.pendingRelay);
      // System intent (§4.6): its transcript row doesn't exist yet, so
      // the arm below calls `consumeSystemIntent` rather than `runTurn`.
      const intentWake = !!(wakeable && after.pendingSystem);
      let tailWake = false;
      if (wakeable && !verdictWake && !relayWake && !intentWake
        && after.participants?.length && !after.pending) {
        // Addressee-aware: counts only an answer FROM the addressee.
        const owed = await unansweredAddressee(after).catch(() => null);
        tailWake = !!owed && owed.agent !== (config.agentName ?? after.agent);
      }
      if (verdictWake || relayWake || intentWake || tailWake) {
        // Token-based identity: prevents a stale callback from waking a turn
        // that a newer verdict's own resume already owns.
        const wakeToken = after!.pending?.wakeToken;
        const relayToken = after!.pendingRelay?.token;
        const intentToken = after!.pendingSystem?.token;
        // `setTimeout(0)` not `Meteor.defer` — this module stays free of the
        // Meteor namespace. `.catch` is load-bearing (Node >= 15).
        setTimeout(() => {
          void (async () => {
            // Re-read inside the callback: the legitimate resume can finish
            // before this timer fires, spending the verdict/relay.
            const still = await AgentSessions.findOneAsync(sessionId).catch(() => null);
            if (!still || DECIDED_PHASES.includes(still.phase) || running.has(sessionId)) return;
            if (verdictWake) {
              if (!still.pending?.verdict || still.pending.wakeToken !== wakeToken) return;
            } else if (relayWake) {
              if (still.pendingRelay?.token !== relayToken) return;
            } else if (intentWake) {
              // Identity check — a different intent is somebody else's wake.
              // Must sit BEFORE the final `else` (tail).
              if (still.pendingSystem?.token !== intentToken) return;
              // The one wake that materializes its transcript row before
              // running. Dispatches via `runTurn`, not `deferTurn`.
              await consumeSystemIntent(sessionId, (id, target, userId, opts) => {
                setTimeout(() => {
                  void runTurn(id, buildRunConfig(target, userId, opts)).catch((e) => {
                    console.error(
                      `[10thfloor:agent] system turn failed for session ${id}:`, e,
                    );
                  });
                }, 0);
              });
              return;
            } else {
              // Re-verify the tail with the same addressee-aware predicate
              // the check above used.
              if (!(await unansweredAddressee(still).catch(() => null))) return;
            }
            // Resolve which participant the woken turn runs as (decision 6).
            const agentName = await resolveWakeAgent(still);
            // Reuse config for same-model wakes (preserves test mocks);
            // build fresh from registry for a different addressee.
            if (agentName === (config.agentName ?? still.agent)) {
              await runTurn(sessionId, config);
              return;
            }
            const primary = getAgent(still.agent);
            if (!primary) return;
            const target = agentName === still.agent ? primary : getAgent(agentName);
            if (!target) return;
            await runTurn(sessionId, buildRunConfig(target, still.userId, target === primary
              ? undefined
              : {
                agentName,
                budget: resolveBudget(primary.budget),
                ...memoryOpt(primary),
              }));
          })().catch((e) => {
            console.error(`[10thfloor:agent] wake-up turn failed for session ${sessionId}:`, e);
          });
        }, 0);
      }
    }
  }
}
