import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES } from '../common/types';
import {
  modelFrom, modelParticipantId, participantsBlock, resolveAddressee, resolveRelay,
} from '../common/participants';
import { resolveWakeAgent, unansweredAddressee } from './participants';
import { getAgent, buildRunConfig, resolveBudget } from './registry';
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
  /**
   * WHICH AGENT this turn runs as (participants spec §4.3) — set by
   * `buildRunConfig` when a turn is addressed to a non-primary model
   * participant. Absent = the session's own agent, today's behavior. The loop
   * and dispatch read it for `from` stamps, `pending.agent`, and hook
   * context; the BUDGET is composed separately (always the primary's — one
   * purse per conversation).
   */
  agentName?: string;
  maxIterations?: number;
  flushMs?: number;
  /** How often the stream loop re-reads the session to honor an interrupt
   *  (`phase: 'stopped'`). Tests lower it; the default keeps the cost to a few
   *  indexed reads per response. */
  interruptCheckMs?: number;
  /** §10: bounded retry with full-jitter exponential backoff for a provider
   *  stream that throws mid-iteration. `attempts` counts the initial try
   *  (default 3); the delay is uniform in
   *  `[0, min(maxDelayMs, baseMs * 2^attemptIndex)]` (defaults 500 / 10_000). */
  retry?: { attempts?: number; baseMs?: number; maxDelayMs?: number };
  /** §9 compaction thresholds (defaults 200_000 / 0.8 / 6); absent =
   *  compaction disabled. */
  context?: { window?: number; compactAt?: number; keep?: number };
  /** §9, threaded from the registry by `deferTurn`. `spend` is already parsed
   *  to dollars (`parseSpend` runs at define() time). `turns` is enforced in
   *  `mSend`, not here — by the time a turn runs, the send it would refuse has
   *  already happened. `relay` caps model-to-model hops (participants spec
   *  decision 7; default 4). On an ADDRESSED turn this whole bundle is the
   *  PRIMARY agent's, whatever config the rest of the run came from. */
  budget?: { turns?: number; toolCalls?: number; spend?: number; relay?: number };
  /** $ per million tokens. The FALLBACK for a provider that reports no cost of
   *  its own; see `accruedCost`. */
  pricing?: { input: number; output: number };
  /** §5.2. A tool result enters the transcript AND every later provider
   *  request; one oversized result inside compaction's kept tail can exceed
   *  the context window with nothing compaction can do about it. Truncation
   *  is explicit in the content so the model knows it saw a prefix.
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
  /** The agent's skills. Their descriptions are already in `system` (see
   *  `buildSystemPrompt`); the loop reads this only to decide whether to add
   *  the built-in `skill` tool and what it can load. Absent or empty = no
   *  loader tool at all. */
  skills?: Skill[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Full jitter: uniform in [0, min(maxDelayMs, baseMs * 2^attemptIndex)].
 *  A deterministic exponential resynchronizes every session that failed
 *  together — a provider-wide 529 would have the whole fleet retrying in
 *  lockstep, which is how outages prolong themselves. */
export function backoffDelay(attemptIndex: number, baseMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseMs * 2 ** attemptIndex);
}

let backoff: typeof backoffDelay = backoffDelay;

/**
 * TEST SEAM, not public API — the same shape as lease.ts's `_setLeaseTimings`.
 * Full jitter draws a delay that can legitimately be ~0ms, which makes the
 * between-attempts `retrying` phase unobservable by any sampler (and the
 * test-environment Mongo observer runs on the polling driver, which coalesces
 * transient states away entirely). A test that must SEE the phase pins the
 * delay deterministic here and restores in `finally`. Pass null to restore
 * the jittered default. Not re-exported from server/index.ts.
 */
export function _setBackoff(fn: typeof backoffDelay | null): () => void {
  const previous = backoff;
  backoff = fn ?? backoffDelay;
  return () => { backoff = previous; };
}

/**
 * Run one turn to completion. Assistant messages commit only at boundaries and
 * every abandonment path erases what it had already written, so the transcript
 * a turn leaves behind always ends in `user` or `tool` — the two states a turn
 * can legally start from. A recovering server additionally repairs on entry,
 * because cleanup by the abandoning process is not guaranteed to run at all.
 * Recovery is therefore just calling this again.
 */
export async function runTurn(sessionId: string, config: RunConfig): Promise<void> {
  const maxIterations = config.maxIterations ?? 10;
  const flushMs = config.flushMs ?? 60;
  // 256 KiB per turn. Generous by design: the largest argument payload any of
  // this package's own tools produces is three orders of magnitude smaller, so
  // a turn that reaches this is pathological, not merely busy.
  const maxToolArgBytes = config.maxToolArgBytes ?? DEFAULT_MAX_TOOL_ARG_BYTES;
  const interruptCheckMs = config.interruptCheckMs ?? 250;
  // `attempts` counts the INITIAL try, so 1 means "no retry" and 0 means
  // nothing coherent at all: `attemptIndex + 1 < 0` is false on the first
  // pass, so 0 silently behaved as 1 — a config that reads like "never call
  // the provider" quietly calling it once. Floor it instead of trusting it.
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
  // The strip-and-degrade latch (participants spec §9): a provider can refuse
  // an image the byte gate passed (pixel caps are invisible to a byte check),
  // and the ref sits on a COMMITTED row — without this, one bad image would
  // re-hydrate into every future request and 400 the session forever. One
  // extra attempt, images stripped, text results intact.
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
      // The ONE async step in tool assembly, and the only concession the loop
      // makes to MCP: a `{ mcp: … }` spec carries a server name, and its
      // description, its schema and (for a whole-server spec) its very
      // existence come from that server's `tools/list`. Resolution stays
      // synchronous; discovery is awaited here, once per turn, before anything
      // is shown to the model. Connections and catalogs are cached per process,
      // so this is a Map lookup from the second turn on, and a no-op array
      // pass-through for an agent with no MCP tools. A server that is down
      // costs one failed connect and never fails the turn — see
      // `expandMcpTools`.
      //
      // AFTER `claimLease`, and after the heartbeat is running, deliberately.
      // Discovery spawns subprocesses and can burn a full
      // `MCP_DISCOVERY_TIMEOUT_MS` per server; doing it before the lease meant
      // a run that another server already owns paid the whole bill before
      // finding out it had nothing to do — every duplicate wake-up spawning its
      // own copy of every MCP server. Under the heartbeat, a slow discovery
      // cannot cost us the lease either. Nothing above reads `tools` or
      // `schemas`, so there is nothing to reorder around.
      //
      // The built-in `skill` loader joins the list AFTER expansion, for a
      // reason that only shows up with MCP in the tree: a whole-server spec's
      // tool names are not known until discovery has run, so appending earlier
      // could put two tools named `skill` in front of a provider that rejects
      // duplicates outright. Appending here makes the collision visible, and
      // `withSkillTool` resolves it in the app's favor with one warning.
      const tools = withSkillTool(
        await expandMcpTools(resolveTools(config.tools)), config.skills,
      );
      const schemas = toolSchemas(tools);

      // The turn's vision capability (participants spec §9), answered ONCE:
      // absent surface, absent answer, and any failure all read as NO — the
      // gate fails closed (see Provider.capabilities). Threaded to every
      // tool's ctx through the limits bundle.
      try {
        const answer = config.provider.capabilities?.imageInput?.(config.model);
        limits.imageInput = (await answer) === true;
      } catch {
        limits.imageInput = false;
      }

      if (!(await repairUnansweredToolUse(sessionId))) return;

      // An approval gate is resolved BEFORE the think loop, because the
      // transcript currently ends in an unanswered `tool_use`: streaming from
      // here would 400 on every provider. Once the batch is answered the
      // history ends in a `tool` row — the ordinary shape an iteration expects.
      const entry = await AgentSessions.findOneAsync(sessionId);
      if (!entry) return;
      // WHICH MODEL PARTICIPANT this turn runs as (participants spec §4.3):
      // the addressed composition's name, else the session's own agent. Every
      // stamp (`from`, `pending.agent`), the hook context, and the relay
      // parse read this one value.
      const selfAgent = config.agentName ?? entry.agent;
      // A relay addressed to us is the wake this turn IS — but it is NOT
      // consumed here (a reviewer-confirmed window): consumption at entry
      // meant a crash anywhere in this turn's first provider call dropped
      // the marker, and recovery — finding no durable addressee — resumed
      // the PRIMARY against a history ending in a colleague's question. The
      // marker is cleared by this turn's FIRST COMMIT (`allocateSeq`'s
      // `$unset` rides the same atomic write), so the whole pre-commit
      // stretch stays recoverable as the right model.
      const consumingRelay = entry.pendingRelay?.agent === selfAgent;
      if (entry.pending) {
        if (!entry.pending.verdict) {
          // Still parked, and re-entry here is the recovering-server case: exit
          // exactly as the parking run did, leaving the marker standing.
          //
          // 'awaiting' is a live request waiting on a human, and ONLY
          // approve/deny resolves it. A send that arrives while awaiting does
          // not cancel the approval and does not wake anything: `agent.send`
          // clears 'stopped'/'error' and nothing else, so the message is
          // QUEUED — it sits in the transcript until a verdict resumes the
          // batch, at which point the think loop reads the whole history and
          // answers it along with the tool results. (To cancel instead, the
          // caller interrupts first: that is what 'stopped' below is.)
          //
          // 'stopped' is that same request with an interrupt over it. There a
          // later send DOES clear the phase, and the overtaken branch below
          // discards the dead request rather than leaving its `tool_use`
          // unanswered.
          if (entry.phase === 'awaiting' || entry.phase === 'stopped') return;

          // Any other phase means the park was OVERTAKEN: `agent.interrupt`
          // stopped it and a later `agent.send` cleared the stop to 'idle'.
          // approve/deny require 'awaiting', so nothing can ever answer this
          // call now — and an unanswered `tool_use` 400s every provider call
          // from here on. Discard the dead turn exactly as an interrupt during
          // dispatch already does, then answer the message the user just sent.
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
          // WHOSE park is this (decision 6)? A queued ADDRESSED send's
          // deferred turn runs as its addressee and can reach a
          // verdict-carrying park first — and resuming a COLLEAGUE's batch
          // under this turn's toolset answers a human-approved call with
          // `unknown-tool`. Only the parking model's turn consumes the
          // verdict; anyone else's wake leaves it standing for the resume
          // that `recordVerdict` already scheduled via `pending.agent` (and
          // this turn's own wind-down self-check re-fires it if that resume
          // was the one that got dropped).
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
        // An interrupt is durable until the next send clears it (`agent.send`
        // flips stopped→idle). Without this check the unconditional
        // 'streaming' write below would silently erase a stop that landed
        // between iterations — or between Meteor.defer and the first one.
        if (session.phase === 'stopped') return;

        // §9: BEFORE the provider call, not after it — the point of a spend cap
        // is to prevent the next charge, and a check after the fact only
        // reports one. Reading it per ITERATION rather than once per turn is
        // what makes a tool-using run stop at the boundary instead of running
        // its whole batch out: each iteration is another model call.
        //
        // `>=` against the accrued total, so the turn that CROSSES the cap
        // still completes (its cost was already committed to when it started)
        // and the next one is refused. Combined with the note's
        // `phase: 'stopped'`, a session that has overspent needs an operator to
        // raise the budget: the next send clears the stop, and the very first
        // iteration trips again right here, before spending anything.
        if (config.budget?.spend !== undefined
          && session.usage.cost >= config.budget.spend) {
          await commitBudgetNote(sessionId, 'spend');
          return;
        }

        let history = await AgentMessages
          .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

        // QUEUED ADDRESSED MESSAGES re-resolve at the iteration top
        // (participants spec §4.3, a reviewer-confirmed miss): a message
        // addressed to a colleague can enter this turn's history without
        // passing the interjection branch — queued while the session was
        // awaiting an approval, or landed between tool-batch iterations —
        // and answering it under THIS config would be the wrong model
        // speaking. The handoff is durable (`pendingRelay`, the same marker
        // a model relay writes) so the wind-down self-check and the
        // watcher's sweep both know who is owed the turn.
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

        // §9: compact BEFORE this iteration's provider call, so the call that
        // would have overflowed is the one that benefits. A committed note
        // changes the assembled view; re-read so this iteration streams
        // against it (the note also occupies a seq).
        if (await maybeCompact(
          sessionId, session.agent, config, history, schemas, interruptCheckMs,
        )) {
          history = await AgentMessages
            .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
        }

        const historyMaxSeq = history.length ? history[history.length - 1].seq : -1;

        let messageId = Random.id();
        // Deltas sort the in-flight row at the seq the message is EXPECTED to
        // commit at. If a user message interjects mid-stream, the committed
        // assistant lands one seq later (allocated atomically below) and the
        // committed row simply supersedes the in-flight one at its new, still
        // correct position — after the interjection, which is what a reader
        // expects. Retries reuse this SAME msgSeq (only messageId changes per
        // attempt): a retry is still logically the one reply this iteration
        // owes the transcript.
        const msgSeq = session.nextSeq;

        let text = '';
        let thinking = '';
        let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
        let usage: { input: number; output: number; cost?: number } = { input: 0, output: 0 };
        let interrupted = false;

        // §10: pi-ai's adapter (and any other Provider) turns a terminal
        // provider failure into a THROW mid-iteration, not a rejected
        // promise. One pass of this loop is one attempt: a fresh DeltaWriter
        // over a fresh messageId, because a failed attempt's deltas are
        // removed below and a retry must never stream under an id a
        // straggler flush from the dead attempt could still land under.
        for (let attemptIndex = 0; ; attemptIndex += 1) {
          // Per ATTEMPT, not once per iteration: a retry that left the phase
          // on 'retrying' for the whole of its own stream tells the client a
          // retry is still pending while tokens are already arriving.
          // 'retrying' must be visible only BETWEEN attempts.
          //
          // Phase-conditional as well as lease-guarded: compaction sits
          // between the iteration head's stopped-check and this write, a full
          // provider round trip in which an interrupt can land. A lease-only
          // write here would erase it — the M2 retry-branch hole, reopened.
          // Zero matched (stop OR lost lease) → return; the finally preserves
          // a stop.
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
            // The `beforeProviderRequest` seam for the turn's own call. Run per
            // ATTEMPT rather than once per iteration, so a retry re-runs the
            // chain instead of resending a request a hook built before the
            // backoff (a hook stamping the current time is the obvious case).
            //
            // `signal` is attached AFTER the hooks and never handed to them to
            // preserve: a hook that rebuilds the request wholesale must not be
            // able to silently disable the interrupt — cancellation is the
            // harness's contract with the user, not the extension's.
            // The COMPACTED view when a compaction note stands; the raw
            // (note-filtered) transcript otherwise — projected for THIS
            // model participant when a roster stands (§4.4): its own rows
            // keep their roles, colleagues' turn-final rows arrive as
            // attributed user rows, colleagues' working drops.
            const assembled = assembleContext(history, session.participants?.length ? {
              self: modelParticipantId(selfAgent),
              primary: modelParticipantId(session.agent),
              participants: session.participants,
            } : undefined);
            // Image hydration (participants spec §9) — the separate async
            // step, HERE and only here: after maybeCompact's estimate (base64
            // in the estimator reads as megatokens and wedges compaction),
            // never on the summarizer path, and skipped entirely once the
            // strip-and-degrade latch fired or the model has no vision.
            let requestHasImages = false;
            if (limits.imageInput === true && !imagesStripped) {
              requestHasImages = await hydrateImageRefs(sessionId, history, assembled);
            }
            const request = await runBeforeProviderRequest({
              model: config.model,
              // The participants block is appended PER ITERATION from the
              // session just re-read — never baked into `config.system` — so
              // a roster that changed mid-conversation (compose joining its
              // recipient) is visible at the next boundary (§4.3).
              system: session.participants?.length
                ? config.system + participantsBlock(session, selfAgent)
                : config.system,
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
                  // Streamed for FIDELITY, not for dispatch: the tool calls the
                  // loop actually runs come off the terminal `done` chunk,
                  // already parsed. These deltas exist so a client can show a
                  // tool call forming, and they carry `contentIndex` so two
                  // calls forming at once stay apart. Nothing accumulates them
                  // in memory here — a partial-JSON buffer the commit never
                  // reads would be dead weight on every turn.
                  writer.push('tool_args', chunk.chunk, chunk.contentIndex);
                } else if (chunk.kind === 'done') {
                  toolCalls = chunk.toolCalls;
                  usage = chunk.usage ?? usage;
                }
                // Honor an interrupt WHILE streaming, not after. `agent.interrupt`
                // sets `phase: 'stopped'`; without this check the stream runs to
                // completion, commits, and dispatches its tools anyway — a stop
                // button that only relabels the phase after the fact.
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
              // A tail-flush rejection is NOT a provider failure. `stop()`
              // propagates an `insertAsync` rejection, so a Mongo blip after a
              // fully successful stream would land in `providerError`,
              // classify retryable (no status), and re-stream the entire
              // response — a second provider charge for a database hiccup.
              // The commit is built from the in-memory `text`, not from
              // deltas, so a lost tail flush costs nothing durable.
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

            // A stop outranks BOTH the retry and the error note. Re-read the
            // session once here because this branch is otherwise blind to an
            // interrupt: an attempt that throws before yielding a single chunk
            // (the ordinary 429/503 shape) never runs the in-stream check at
            // all, and every write below is guarded on the LEASE only — so a
            // `stopped` written by `agent.interrupt` while the attempt was
            // failing would be overwritten with 'retrying', the after-sleep
            // re-check would read back the value this branch itself wrote, and
            // a later attempt would commit a message the user cancelled. The
            // same hole let the fatal path stamp an error note over a stop.
            // The `finally` preserves `stopped`, so returning is enough.
            const live = await AgentSessions.findOneAsync(sessionId);
            if (interrupted || !live || live.phase === 'stopped') return;

            const classification = classifyProviderError(providerError);
            // An abandoned request is the interrupt path with a different
            // trigger: deltas are already cleaned above, no note is owed to
            // the user (nothing failed AT them), and the finally preserves a
            // stop if one stands. Returning here is the whole handling.
            if (classification === 'abandon') return;
            // STRIP-AND-DEGRADE (participants spec §9): a fatal answer to a
            // request carrying hydrated images gets ONE retry with the images
            // stripped (text results intact) — pixel caps are invisible to
            // the byte gate, the offending ref sits on a committed row, and
            // without this every future request would re-hydrate it and fail
            // identically. Latched, so a genuinely fatal request cannot loop.
            if (classification === 'fatal' && attemptHadImages && !imagesStripped) {
              imagesStripped = true;
              messageId = Random.id();   // fresh id: the old deltas are gone
              continue;
            }
            const hasMoreAttempts = attemptIndex + 1 < retryAttempts;
            if (classification === 'retryable' && hasMoreAttempts) {
              if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'retrying' } }))) return;
              await sleep(backoff(attemptIndex, retryBaseMs, retryMaxDelayMs));
              // The interrupt check above only fires WHILE a stream is
              // running; re-check here so an interrupt landing during the
              // backoff sleep itself still stops the turn, instead of being
              // silently overwritten by the next attempt's 'streaming' phase.
              const afterSleep = await AgentSessions.findOneAsync(sessionId);
              if (!afterSleep || afterSleep.phase === 'stopped') return;
              messageId = Random.id(); // fresh id: the old deltas are gone
              continue;
            }

            // Fatal, or every attempt exhausted: commit a sanitized note
            // through the normal atomic path and end the turn in a
            // terminal, visible phase. NEVER the raw provider message — it
            // can carry request headers, key fragments, or other upstream
            // detail that must not reach the transcript.
            const noteSeq = await allocateSeq(sessionId);
            if (noteSeq !== null) {
              await AgentMessages.insertAsync({
                _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'error',
                error: { error: 'provider-failed', reason: 'The model request failed.' },
                createdAt: new Date(),
              });
              await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'error' } });
            } else {
              // The only silent exit in this structure: the lease went to
              // another server between the failure and the note, so neither
              // the note nor the terminal phase can be written and the
              // session is left showing whatever phase it last had.
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

        // Commit is conditional on still owning the lease, and the seq is
        // allocated ATOMICALLY in the same write — see allocateSeq. Losing the
        // lease means another server is redoing this turn; abandon without
        // writing, taking the deltas streamed under this messageId with us.
        // Cost rides the SAME atomic write that allocates the seq and accrues
        // the tokens — no second write, and no window in which a committed
        // message exists whose cost the spend budget has not yet seen.
        // A RELAY (participants spec decision 7): a rostered turn-final reply
        // whose leading `@` names another model participant schedules that
        // model's turn. Parsed BEFORE the seq allocation so the durable wake
        // (`pendingRelay`) rides the SAME atomic write — a bare defer from
        // inside a committing turn lands in exactly the non-durable-wake race
        // the verdict machinery documents. Over the cap, the reply still
        // commits and delivers; it just schedules nothing, and the note below
        // says why.
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
        }, relaying ? {
          pendingRelay: { agent: relayHit!.agent, token: Random.id() },
          relay: relayCount + 1,
        } : undefined,
        // The relay's CONSUMPTION (decision 7): the addressee's first commit
        // clears the marker it answers — never turn entry, so a crash before
        // any commit leaves the wake standing for recovery. A commit that
        // itself relays onward OVERWRITES instead (the $set above).
        !relaying && consumingRelay ? { pendingRelay: 1 } : undefined);
        if (commitSeq === null) { await discardTurn(sessionId, messageId, msgSeq); return; }

        // The TURN-FINAL row (no toolCalls) claims the session's staged
        // attachment refs and embeds them — the reply becomes a file-bearing
        // message (email v2 spec §8). After the seq allocation proved we still
        // own the lease, before the insert. A crash between claim and insert
        // strands the claimed refs unstaged and undelivered; the file survives
        // in the store, the re-run turn's `create` re-stages it idempotently,
        // and delivery follows the row that actually commits.
        //
        // A RELAY-ADDRESSED reply claims nothing (participants spec decision
        // 13): it is internal deliberation the channel planner skips, and a
        // file claimed onto it would be silently undeliverable. The refs stay
        // staged for the eventual outward reply.
        const staged = (turnFinal && !relayHit)
          ? await claimStagedRefs(sessionId)
          : [];

        await AgentMessages.insertAsync({
          _id: messageId, sessionId, seq: commitSeq, role: 'assistant',
          content: text, thinking: thinking || undefined,
          toolCalls, usage,
          ...(staged.length > 0 ? { attachments: staged } : {}),
          // Attribution (decision 4) on ROSTERED rows only — a 1:1 row stays
          // byte-identical and projects under the primary default. The
          // addressee is stamped whenever a relay resolved — capped relays
          // included, so the transcript still shows who was asked even when
          // nothing was scheduled.
          ...(roster ? { from: modelFrom(selfAgent) } : {}),
          ...(relayHit ? { to: relayHit.id } : {}),
          createdAt: new Date(),
        });

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

        // The committed message supersedes its deltas; remove them now rather
        // than letting them accumulate. Without this, subscribing to an old
        // session ships every token ever streamed in it, and the client
        // re-merges the full delta history on every flush of the NEXT turn.
        // Ordering is safe: the client receives the committed message first,
        // and mergeView already suppresses deltas by committed id.
        await AgentDeltas.removeAsync({ messageId });

        if (!toolCalls || toolCalls.length === 0) {
          // A reply that scheduled a relay ends this turn — the addressee's
          // wake is durable (`pendingRelay`) and the wind-down self-check
          // fires it in-process; the watcher is the cross-crash net.
          if (relaying) return;
          // A send that landed mid-stream committed a user message this turn
          // never saw (its history was read before the interjection). Ending
          // the turn here would strand that message unanswered until the user
          // sends AGAIN — so loop instead, still bounded by maxIterations.
          const interjected = await AgentMessages.findOneAsync({
            sessionId, role: 'user', seq: { $gt: historyMaxSeq },
          });
          if (interjected) {
            // Rostered sessions RE-RESOLVE the interjection's addressee
            // (participants spec §4.3): its own deferred wake was dropped by
            // the running/lease guards, and continuing here would answer a
            // message mechanically addressed to a colleague under the wrong
            // config. The handoff is DURABLE (a reviewer-confirmed strand:
            // the bare tail predicate reads this exact ordering — our reply
            // committed after the interjection — as answered): the same
            // `pendingRelay` marker a model relay writes, fired by the
            // wind-down self-check and swept by the watcher. Same-addressee
            // interjections keep today's continue.
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
      // `stopped` is a deliberate terminal state set by an interrupt, `error`
      // is the terminal state this turn just set on a fatal or exhausted
      // provider failure, and `awaiting` is a live approval request — idling
      // any of them back would erase the decision (the user's stop, the
      // failure the transcript note just recorded, or the question a human is
      // being asked) that the phase exists to preserve. For `awaiting` the
      // damage would be worse than cosmetic: approve/deny only fire on that
      // phase, so idling it back would strand the parked call permanently.
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && !DECIDED_PHASES.includes(current.phase)) {
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);

    // The wake is otherwise not durable. `agent.approve`/`agent.deny` record a
    // verdict and defer a resume; if that verdict lands in the window between
    // this turn's park write and the two lines above (the `releaseLease` in the
    // inner `finally`, then `running.delete`), the deferred resume hits
    // `running.has` in this process — or `claimLease` from another server —
    // returns immediately, and NOTHING retries. What is left is a recorded
    // verdict, `phase: 'idle'`, a tool that never ran, and a UI that says the
    // turn is done. This closes that window: the state is re-read once here,
    // after the lease is released and the in-process guard is clear, so a
    // verdict that raced the wind-down still gets a run of its own.
    //
    // Bounded, not a watcher. It fires only for a run that actually held the
    // lease (`owned`) and that did not itself resume a verdict (`resumed`) —
    // the pair that stops a rescued run from rescuing itself forever, and stops
    // a run that never got the lease from spinning against the server that did.
    // `awaiting` means the batch re-parked on its NEXT gate (nobody's verdict to
    // spend), and `stopped` means an interrupt outranks the verdict until a
    // send clears it: neither is ours to wake.
    if (owned) {
      const after = await AgentSessions.findOneAsync(sessionId).catch(() => null);
      // 'error' belongs in this exclusion list for the same reason it is in
      // the finally's terminal list: a failed turn is not ours to wake, and
      // the two lists disagreeing was itself a reviewed defect.
      const wakeable = after
        && !DECIDED_PHASES.includes(after.phase)
        && !running.has(sessionId);
      // THREE wake kinds now feed one self-check (participants spec §4.3):
      //   - a standing VERDICT (the original case; still excluded for a run
      //     that itself resumed one, which would otherwise rescue itself
      //     forever);
      //   - a standing RELAY — the wake this turn's own commit scheduled, or
      //     one left by a turn that died after writing it;
      //   - an UNANSWERED ADDRESSED TAIL (rostered sessions only): a send
      //     addressed to a different model landed mid-turn, its own deferred
      //     wake was dropped by the running/lease guards, and the interjection
      //     branch deliberately ended this turn instead of answering it under
      //     the wrong config. Restricted to a tail whose addressee is NOT the
      //     model this turn ran as, so a classic maxIterations exhaustion
      //     still ends quietly.
      const verdictWake = !!(wakeable && !resumed && after.pending?.verdict);
      const relayWake = !!(wakeable && after.pendingRelay);
      let tailWake = false;
      if (wakeable && !verdictWake && !relayWake
        && after.participants?.length && !after.pending) {
        // ADDRESSEE-AWARE (a reviewer-confirmed strand): "any assistant row
        // after the user row" reads a colleague-addressed interjection as
        // answered the moment OUR OWN reply commits — the helper counts only
        // an answer FROM the addressee.
        const owed = await unansweredAddressee(after).catch(() => null);
        tailWake = !!owed && owed.agent !== (config.agentName ?? after.agent);
      }
      if (verdictWake || relayWake || tailWake) {
        // WHICH verdict this wake is for. `writeVerdict` stamps a fresh token
        // with every verdict, so this is identity where the old re-check had
        // only a boolean: a verdict consumed, the batch re-parked on its next
        // gate, and a SECOND verdict written (with its own deferred resume
        // already queued) all before this timer fires is three writes that
        // still leave "a verdict stands" true — and this callback would then
        // run a turn nobody asked for, behind the resume that already owns it.
        // Undefined only for a verdict written before the field existed, where
        // the comparison degrades to the old boolean form rather than
        // stranding the session.
        const wakeToken = after!.pending?.wakeToken;
        const relayToken = after!.pendingRelay?.token;
        // `setTimeout(…, 0)` rather than `Meteor.defer`: this module is
        // deliberately free of the Meteor namespace (methods.ts owns that
        // plumbing and calls in), and the only thing `defer` would add is an
        // environment binding a fresh `runTurn` has no use for — it reads its
        // own session and takes no ambient method invocation. The `.catch` is
        // the same load-bearing one `deferTurn` uses: an unhandled rejection is
        // fatal by default on Node >= 15.
        setTimeout(() => {
          void (async () => {
            // Re-read INSIDE the deferred callback, not before it: the
            // legitimate resume can start AND finish between the check above
            // and this timer firing. It spends the verdict (or consumes the
            // relay); a woken run that then finds nothing standing would fall
            // straight into the think loop and make a provider call nobody
            // asked for — a charge, and an assistant row appended to a turn
            // the user considered finished. Each wake kind re-verifies its own
            // condition by IDENTITY where one exists (the verdict token, the
            // relay token), and the tail wake re-derives from the transcript.
            const still = await AgentSessions.findOneAsync(sessionId).catch(() => null);
            if (!still || DECIDED_PHASES.includes(still.phase) || running.has(sessionId)) return;
            if (verdictWake) {
              if (!still.pending?.verdict || still.pending.wakeToken !== wakeToken) return;
            } else if (relayWake) {
              if (still.pendingRelay?.token !== relayToken) return;
            } else {
              // Re-verify the tail with the same addressee-aware predicate
              // the check above used.
              if (!(await unansweredAddressee(still).catch(() => null))) return;
            }
            // The woken turn runs as the participant the durable state names
            // (participants spec decision 6) — the parked turn's model, the
            // relay's addressee, the tail's addressee — composed with the
            // PRIMARY's budget and the OWNER's identity, exactly as
            // `deferResolvedTurn` composes it for the recovery paths.
            const agentName = await resolveWakeAgent(still);
            // The SAME config when the wake belongs to the model this run
            // already was — which is every 1:1 wake, and what lets a test's
            // hand-built RunConfig (mock provider included) survive its own
            // verdict wake. A different addressee builds fresh from the
            // registry: the addressee's config, the primary's budget.
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
              : { agentName, budget: resolveBudget(primary.budget) }));
          })().catch((e) => {
            console.error(`[10thfloor:agent] wake-up turn failed for session ${sessionId}:`, e);
          });
        }, 0);
      }
    }
  }
}
