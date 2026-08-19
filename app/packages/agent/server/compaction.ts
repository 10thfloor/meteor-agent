import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES, type AgentMessage } from '../common/types';
import type { ProviderMessage, ToolSchema } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, releaseLease, HEARTBEAT_MS, SERVER_ID,
} from './lease';
import {
  expandMcpTools, resolveTools, toolSchemas, withSkillTool,
} from './tools';
import { runBeforeProviderRequest } from './hooks';
import {
  accruedCost, allocateSeq, classifyProviderError, running,
} from './turn-state';
import { batchSafeBoundary, toProviderMessages } from './transcript';
import type { RunConfig } from './loop';

/**
 * §9 compaction: the assembled context view, the threshold check, the
 * summarization step, and the on-demand `compactSession` entry point.
 *
 * `RunConfig` is imported as a TYPE only (it is defined in `loop.ts`, which
 * imports `maybeCompact`/`assembleContext` from here) — the type import is
 * erased at compile time, so the loop ↔ compaction relationship is a one-way
 * runtime edge, not a cycle.
 */

/** The newest `kind:'compaction'` note, or null. Only the newest matters:
 *  each compaction's summary already folds the previous one in. */
export function latestCompaction(
  msgs: AgentMessage[],
): { seq: number; summary: string; upto: number } | null {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role === 'note' && m.kind === 'compaction' && typeof m.upto === 'number') {
      return { seq: m.seq, summary: m.summary ?? '', upto: m.upto };
    }
  }
  return null;
}

/**
 * What the MODEL sees: from the newest compaction note, its summary as a
 * leading user message, then every non-note message after the note's `upto`.
 * With no compaction, the whole (note-filtered) transcript. The transcript
 * itself is never touched — compaction changes this view only.
 */
export function assembleContext(msgs: AgentMessage[]): ProviderMessage[] {
  const c = latestCompaction(msgs);
  if (!c) return toProviderMessages(msgs);
  return [
    { role: 'user', content: `[Earlier conversation, compacted]\n${c.summary}` },
    ...toProviderMessages(msgs.filter((m) => m.seq > c.upto)),
  ];
}

/**
 * Estimated tokens the next provider call will carry. The last assistant's
 * provider-reported `usage.input` is ground truth for the context size at
 * THAT call; chars/4 approximates what has landed since. Take the max — the
 * estimate feeds a threshold, so erring high compacts a little early, erring
 * low silently never compacts. `lastReportedInput` must come from an
 * assistant NEWER than the latest compaction, or it describes a view that no
 * longer exists (the caller enforces this).
 */
export function estimateContext(
  assembled: ProviderMessage[], lastReportedInput?: number,
): number {
  const chars = JSON.stringify(assembled).length;
  return Math.max(lastReportedInput ?? 0, Math.ceil(chars / 4));
}

/**
 * The seq to compact up to (inclusive), keeping the last `keep` non-note
 * messages — or null when there is nothing worth compacting. The cut NEVER
 * splits an assistant-with-toolCalls from its tool results: a summarized
 * `tool_use` whose `tool_result` survives in the tail (or vice versa) is the
 * same unmatched-pair 400 the repair machinery exists to prevent, introduced
 * by our own bookkeeping. `batchSafeBoundary` is the walk that guarantees it —
 * shared verbatim with session forking.
 */
export function findCompactionCut(msgs: AgentMessage[], keep: number): number | null {
  const c = latestCompaction(msgs);
  const eligible = msgs.filter(
    (m) => m.role !== 'note' && (!c || m.seq > c.upto),
  );
  if (eligible.length <= keep) return null;
  // `eligible.length - keep` is the index of the first KEPT message.
  const cut = batchSafeBoundary(eligible, eligible.length - keep);
  if (cut <= 0) return null;
  return eligible[cut - 1].seq;
}

/**
 * §9. Summarize everything older than the last `keep` messages into a
 * `kind:'compaction'` note, using the turn's own provider. Failure is
 * DEGRADED, never fatal: the turn proceeds uncompacted (too-long context is
 * the provider's error to report, and the next iteration tries again), and no
 * error note is written — compaction is bookkeeping, not the user's request.
 * Returns true when a note was committed (the caller re-reads history).
 *
 * This is the THRESHOLD half only. The step itself is `compactNow`, which the
 * manual `Agent.compact` calls directly — see there.
 */
export async function maybeCompact(
  sessionId: string, agent: string, config: RunConfig, history: AgentMessage[],
  schemas: ToolSchema[] = [], interruptCheckMs = 250,
): Promise<boolean> {
  const ctx = config.context;
  if (!ctx) return false;
  const window = ctx.window ?? 200_000;
  const compactAt = ctx.compactAt ?? 0.8;

  const prior = latestCompaction(history);
  const assembled = assembleContext(history);
  const lastAssistant = [...history].reverse()
    .find((m) => m.role === 'assistant' && typeof m.usage?.input === 'number');
  // A reported input from BEFORE the latest compaction describes the
  // pre-compaction view; using it would re-trigger forever.
  const reported = lastAssistant && (!prior || lastAssistant.seq > prior.seq)
    ? lastAssistant.usage!.input : undefined;
  if (estimateContext(assembled, reported) <= window * compactAt) return false;

  return compactNow(sessionId, agent, config, history, schemas, interruptCheckMs);
}

/**
 * The §9 compaction STEP, with no threshold in it.
 *
 * Factored out of `maybeCompact` so the manual `Agent.compact` runs exactly the
 * automatic path — same cut, same summarizer prompt, same hook seam, same
 * usage accounting, same degrade-never-fail contract — instead of a second
 * implementation that would drift. `maybeCompact` is now the estimate and the
 * `window * compactAt` comparison, and nothing else; everything from the cut
 * down is here, unchanged.
 *
 * `context.keep` still applies (the manual call is "compact now", not "throw
 * the tail away"), and `config.context` may be absent entirely: a caller that
 * asked for this explicitly gets the defaults rather than a silent no-op.
 */
async function compactNow(
  sessionId: string, agent: string, config: RunConfig, history: AgentMessage[],
  schemas: ToolSchema[] = [], interruptCheckMs = 250,
): Promise<boolean> {
  const keep = config.context?.keep ?? 6;
  const prior = latestCompaction(history);

  const upto = findCompactionCut(history, keep);
  if (upto === null) return false;
  // Phase-guarded, not just lease-guarded: `guardedUpdate` filters on the
  // lease only, so without the $nin a stop landing right before this write
  // would be silently overwritten — the same interrupt-erasure hole the M2
  // retry branch had, widened here to a full provider round trip.
  //
  // `awaiting` and `error` join `stopped` as defence in depth behind
  // `compactSession`'s own refusals: all three are DECISIONS, and overwriting
  // one with `compacting` would leave the finally to "restore" a phase that
  // no longer describes the session (an unanswerable pending verdict, a
  // laundered failure). It is inert on the automatic path, which is the point
  // of a backstop — `maybeCompact`'s only call site is inside `runTurn`'s
  // iteration loop, after the head's `phase === 'stopped'` return and after
  // the pending-gate that returns on `awaiting`, with `error` terminal (the
  // loop returns on it, and only a send clears it). The phase there is `idle`
  // on the first iteration and `streaming`/`calling` on later ones — never
  // one of these three.
  const entered = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      'lease.serverId': SERVER_ID,
      phase: { $nin: DECIDED_PHASES },
    },
    { $set: { phase: 'compacting', updatedAt: new Date() } },
  );
  if (entered !== 1) return false;

  const head = history.filter(
    (m) => m.role !== 'note' && (!prior || m.seq > prior.upto) && m.seq <= upto,
  );
  let summary = '';
  let usage = { input: 0, output: 0 } as { input: number; output: number; cost?: number };
  // The summarization is a full provider round trip with no consuming-loop
  // interrupt check of its own — so it polls the phase itself and ABORTS the
  // request on a stop, instead of leaving the user's interrupt waiting on a
  // call they cannot see.
  const abort = new AbortController();
  const poll = setInterval(() => {
    void AgentSessions.findOneAsync(sessionId)
      .then((s) => { if (!s || s.phase === 'stopped') abort.abort(); })
      .catch(() => { /* best-effort */ });
  }, interruptCheckMs);
  try {
    // The SECOND `beforeProviderRequest` seam, and the reason the hook carries
    // a `purpose` at all: this request is the harness's own initiative, not the
    // user's, and an app that wants its own summarizer replaces it here
    // (`ctx.purpose === 'compaction'`) rather than through a bespoke option.
    // `signal` is re-stamped below for the same reason it is on the think path:
    // cancelling this call is the harness's job, not the hook's.
    const request = await runBeforeProviderRequest({
      model: config.model,
      system:
        'You compact conversation history for an agent. Produce a concise brief '
        + 'the agent can continue from, structured as: Goal, Progress, Decisions, '
        + 'Open items. Preserve identifiers, numbers, and constraints exactly. '
        + 'Output only the brief.',
      messages: [
        ...(prior ? [{
          role: 'user' as const,
          content: `[Earlier conversation, compacted]\n${prior.summary}`,
        }] : []),
        ...toProviderMessages(head),
        { role: 'user' as const, content: 'Compact the conversation above now, as instructed.' },
      ],
      // The head keeps its tool_use/tool_result blocks, and Anthropic rejects
      // a request carrying those with no `tools` parameter — so the agent's
      // real tool schemas ride along. The summarizer is told to output only
      // the brief; a tool call in its reply is discarded anyway (only text
      // chunks accumulate below).
      tools: schemas,
    }, { agent, sessionId, purpose: 'compaction' });
    for await (const chunk of config.provider.stream({ ...request, signal: abort.signal })) {
      if (chunk.kind === 'text') summary += chunk.chunk;
      else if (chunk.kind === 'done' && chunk.usage) usage = chunk.usage;
    }
  } catch (e) {
    // An abort is the user's stop arriving mid-summarization — quiet return;
    // the attempt head's phase-conditional write is what honors it. Anything
    // else is degraded-not-fatal, per the compaction contract.
    if (classifyProviderError(e) !== 'abandon') {
      console.warn(
        `[10thfloor:agent] compaction failed for session ${sessionId}; proceeding uncompacted:`,
        (e as Error)?.message,
      );
    }
    return false;
  } finally {
    clearInterval(poll);
  }
  if (!summary.trim()) return false;

  // The summarization call is a real model call: its usage and cost accrue
  // exactly as a think's do, in the same atomic write as the note's seq.
  const noteSeq = await allocateSeq(sessionId, {
    'usage.input': usage.input,
    'usage.output': usage.output,
    'usage.cost': accruedCost(usage, config.pricing),
  });
  if (noteSeq === null) return false;
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'compaction',
    summary, upto, usage, createdAt: new Date(),
  });
  return true;
}

/**
 * What a manual compaction did. A plain union rather than a throw, because this
 * module is deliberately free of the Meteor namespace — `Agent.compact` turns
 * every REFUSING outcome into `Meteor.Error('busy')` and `gone` into
 * `no-session`, and the client sees those.
 */
export type CompactOutcome =
  'compacted' | 'nothing' | 'busy' | 'awaiting' | 'errored' | 'gone' | 'over-budget';

/**
 * The refusing outcomes, and the `reason` each one carries.
 *
 * One error CODE (`busy`) across all three, because that is the contract
 * `Agent.compact` and `agent.compact` already published and every client
 * branches on — but three distinct reasons, because "a turn is running",
 * "answer the approval first" and "this session failed" are three different
 * things for a person to do next, and a UI that only ever sees `busy` would
 * tell all three of them to wait a moment.
 *
 * Here rather than duplicated at the two call sites, which is exactly how the
 * two would drift.
 */
export const COMPACT_REFUSALS: Partial<Record<CompactOutcome, string>> = {
  busy: 'This session is running a turn; compact it when it is idle.',
  awaiting: 'This session is waiting on an approval; answer it before compacting.',
  errored: 'This session has failed; send to it again before compacting.',
};

/**
 * The reason `over-budget` carries. Kept OUT of `COMPACT_REFUSALS` on purpose:
 * that map's every entry maps to `Meteor.Error('busy')`, and this is a distinct
 * `budget-exhausted` code — a compaction bills a provider round trip like a turn
 * does, and a session over its `budget.spend` must be refused it, not told to
 * "try again in a moment". The two call sites (`agent.compact`, `Agent.compact`)
 * branch on `over-budget` before the generic `busy` lookup.
 */
export const COMPACT_OVER_BUDGET =
  'This session has reached its spend budget; compaction bills like a turn.';

/**
 * §9's compaction step, run ON DEMAND against an idle session — the whole point
 * being that the threshold does NOT apply. A UI's "compact now" button, a job
 * trimming a long-running session before it gets expensive.
 *
 * It takes the LEASE for the operation (claim, compact, release) rather than
 * writing under whatever the session's state happens to be. A compaction is a
 * full provider round trip that commits a note at an allocated seq, which is
 * precisely what a turn does — running one beside a live turn would interleave
 * two writers over one transcript. So a session with a live lease, or a turn in
 * flight in this process, is refused as `busy` instead of queued: the caller is
 * a human clicking a button, and "try again in a moment" is an answer they can
 * act on. The in-process `running` Set is held too, for the same reason
 * `runTurn` holds it — `claimLease` succeeds on its "already ours" branch, so
 * the lease alone would not stop a `Meteor.defer`red turn in THIS process from
 * writing straight through the compaction.
 *
 * The heartbeat mirrors `runTurn`'s: LEASE_MS is 30s and a summarization of a
 * long transcript can exceed it, and losing the lease mid-call would make the
 * note's own lease-guarded write fail silently.
 *
 * The watcher is not fought: it recovers sessions whose lease EXPIRED, and this
 * one is heartbeaten and released. The phase is restored on the way out with
 * `runTurn`'s exact rule — `stopped`, `error` and `awaiting` are decisions and
 * are left alone; anything else returns to `idle`, which is what an idle
 * session that was compacted goes back to being.
 *
 * `awaiting` and `error` are refused on the way IN for the same reason the
 * finally leaves them alone on the way out. Neither is leased — a parked run
 * releases its lease, and a failed one is long gone — so the lease check below
 * cannot see them, and without their own guard a compaction would overwrite
 * the phase with `compacting` and the finally would then "restore" `idle`: an
 * approval nobody can answer any more (`recordVerdict` and the watcher sweep
 * both require `awaiting`, and the next send's overtaken-park branch DELETES
 * the parked turn), or a failure laundered into a healthy-looking session.
 */
export async function compactSession(
  sessionId: string, config: RunConfig,
): Promise<CompactOutcome> {
  if (running.has(sessionId)) return 'busy';

  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return 'gone';
  // An approval is a DECISION, not a state to tidy: a human is being asked
  // something, and the only two answers are approve and deny.
  if (session.phase === 'awaiting') return 'awaiting';
  // A terminal failure is STATUS a UI gates on — a banner, a retry button, an
  // alert. Compaction is bookkeeping; it must not launder one into `idle`.
  if (session.phase === 'error') return 'errored';
  // §9. A compaction's summarization is a full provider round trip that accrues
  // `usage.cost` like any other model call, and `budget.spend` is the README's
  // named backstop behind it — but nothing checked it here, so a session already
  // at its spend cap could still be made to bill one more call per compact.
  // Refuse BEFORE claiming the lease or spending anything, exactly where the
  // other decisions above refuse. `>=`, so a limit of N stops the call that
  // would take it past N; `!== undefined` so a session with no spend budget is
  // never refused on a zero it never set.
  if (config.budget?.spend !== undefined && session.usage.cost >= config.budget.spend) {
    return 'over-budget';
  }
  // A live lease is another server's turn (or ours, mid-wind-down). An EXPIRED
  // one is an orphan the watcher will re-run: `claimLease` would take it, and
  // compacting an abandoned turn's half-written transcript is not this call's
  // job — leave it to the recovery that knows how to repair it.
  if (session.lease) return 'busy';

  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return 'busy';
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);
    try {
      // The same assembly a turn makes, and for the same reason `maybeCompact`
      // is given `schemas` at all: the compacted head keeps its
      // tool_use/tool_result blocks, and Anthropic rejects a request carrying
      // those with no `tools` parameter.
      const tools = withSkillTool(
        await expandMcpTools(resolveTools(config.tools)), config.skills,
      );
      const history = await AgentMessages
        .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
      const did = await compactNow(
        sessionId, session.agent, config, history, toolSchemas(tools),
        config.interruptCheckMs ?? 250,
      );
      return did ? 'compacted' : 'nothing';
    } finally {
      clearInterval(beat);
      // `compactNow` leaves `phase: 'compacting'` behind on success — inside a
      // turn the next iteration's `streaming` write clears it, and here there
      // is no next iteration. Same terminal list as `runTurn`'s finally, for
      // the same reasons: a stop that landed mid-summarization (the abort poll
      // honors it) and an approval nobody has answered are decisions, not
      // states to tidy up.
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && !DECIDED_PHASES.includes(current.phase)) {
        await guardedUpdate(sessionId, SERVER_ID, {
          $set: { phase: 'idle', updatedAt: new Date() },
        });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);
  }
}
