import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES, type AgentMessage } from '../common/types';
import type { ProviderMessage, ToolSchema } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, releaseLease, HEARTBEAT_MS, SERVER_ID,
} from './lease';
import { prepareToolRuntime } from './tool-runtime';
import { runProviderExchange } from './provider-exchange';
import {
  accruedCost, classifyProviderError, running,
} from './turn-state';
import {
  batchSafeBoundary, commitLeasedMessage, toProviderMessages, type TranscriptView,
} from './transcript';
import { modelParticipantId } from '../common/participants';
import { getAgent, resolveProvider } from './registry';
import type { RunConfig } from './loop';

/** §9 compaction: context assembly, threshold check, summarization, and
 *  on-demand `compactSession`. `RunConfig` is a type-only import (no cycle). */

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

/** Build the model's context view: compaction summary + messages after `upto`,
 *  or the full transcript if uncompacted. `view` is the participant projection. */
export function assembleContext(
  msgs: AgentMessage[], view?: TranscriptView,
): ProviderMessage[] {
  const c = latestCompaction(msgs);
  if (!c) return toProviderMessages(msgs, view);
  return [
    { role: 'user', content: `[Earlier conversation, compacted]\n${c.summary}` },
    ...toProviderMessages(msgs.filter((m) => m.seq > c.upto), view),
  ];
}

/** Estimated context tokens: max of last reported input and chars/4.
 *  Errs high (compacts early) rather than low (never compacts). */
export function estimateContext(
  assembled: ProviderMessage[], lastReportedInput?: number,
): number {
  const chars = JSON.stringify(assembled).length;
  return Math.max(lastReportedInput ?? 0, Math.ceil(chars / 4));
}

/** Find the seq to compact up to, keeping `keep` tail messages. Uses
 *  `batchSafeBoundary` so the cut never splits tool_use from its tool_result. */
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

/** Compact if estimated context exceeds `window * compactAt`. Failure is
 *  degraded, never fatal. Returns true when a compaction note was committed. */
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
  // Ignore reported input from before the latest compaction (stale view).
  const reported = lastAssistant && (!prior || lastAssistant.seq > prior.seq)
    ? lastAssistant.usage!.input : undefined;
  if (estimateContext(assembled, reported) <= window * compactAt) return false;

  return compactNow(sessionId, agent, config, history, schemas, interruptCheckMs);
}

/** The compaction step with no threshold. Shared by `maybeCompact` (automatic)
 *  and `compactSession` (manual) so both use the same path. */
async function compactNow(
  sessionId: string, agent: string, config: RunConfig, history: AgentMessage[],
  schemas: ToolSchema[] = [], interruptCheckMs = 250,
): Promise<boolean> {
  const keep = config.context?.keep ?? 6;
  const prior = latestCompaction(history);

  const upto = findCompactionCut(history, keep);
  if (upto === null) return false;
  // Phase-guarded (not just lease-guarded): a stop/awaiting/error landing
  // before this write must not be overwritten — they are decisions, not
  // transient states. Defence in depth behind `compactSession`'s refusals.
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

  // Group sessions summarize through the omniscient projection (§4.4) so every
  // participant's speech is visible. 1:1 sessions pass no view.
  const sessionDoc = await AgentSessions.findOneAsync(sessionId);
  const view: TranscriptView | undefined = sessionDoc?.participants?.length
    ? {
      primary: modelParticipantId(sessionDoc.agent),
      participants: sessionDoc.participants,
    }
    : undefined;

  // Pin summarization to the primary agent's model (§4.4) so billing doesn't
  // depend on which participant's context overflowed.
  let billing = config;
  if (config.agentName !== undefined && config.agentName !== agent) {
    const primary = getAgent(agent);
    if (primary) {
      billing = {
        ...config,
        model: primary.model,
        provider: resolveProvider(primary.provider),
        pricing: primary.pricing,
      };
    }
  }

  let summary = '';
  let usage = { input: 0, output: 0 } as { input: number; output: number; cost?: number };
  // Hook ordering, signal ownership, and stop observation are shared with an
  // ordinary Turn through the private Provider Exchange Module.
  const exchange = await runProviderExchange({
    sessionId,
    provider: billing.provider,
    interruptCheckMs,
    context: { agent, sessionId, purpose: 'compaction' },
    request: {
      model: billing.model,
      system:
        'You compact conversation history for an agent. Produce a concise brief '
        + 'the agent can continue from, structured as: Goal, Progress, Decisions, '
        + 'Open items. Preserve identifiers, numbers, and constraints exactly. '
        + (view
          ? 'Messages may be prefixed with [name]: naming their speaker; preserve '
            + 'who said and decided what. '
          : '')
        + 'Output only the brief.',
      messages: [
        ...(prior ? [{
          role: 'user' as const,
          content: `[Earlier conversation, compacted]\n${prior.summary}`,
        }] : []),
        ...toProviderMessages(head, view),
        { role: 'user' as const, content: 'Compact the conversation above now, as instructed.' },
      ],
      // Anthropic rejects tool_use blocks without a `tools` parameter.
      tools: schemas,
    },
    onChunk(chunk) {
      if (chunk.kind === 'text') summary += chunk.chunk;
      else if (chunk.kind === 'done' && chunk.usage) usage = chunk.usage;
    },
  });
  if (exchange.kind === 'interrupted') return false;
  if (exchange.kind === 'failed') {
    // Abort = user's stop mid-summarization; anything else is degraded, not fatal.
    if (classifyProviderError(exchange.error) !== 'abandon') {
      console.warn('[10thfloor:agent] compaction failed; proceeding uncompacted');
    }
    return false;
  }
  if (!summary.trim()) return false;

  // Accrue usage/cost atomically with the note's seq allocation.
  const noteSeq = await commitLeasedMessage(sessionId, {
    _id: Random.id(), role: 'note', kind: 'compaction',
    summary, upto, usage, createdAt: new Date(),
  }, { inc: {
    'usage.input': usage.input,
    'usage.output': usage.output,
    'usage.cost': accruedCost(usage, billing.pricing),
  }, unlessStopped: true });
  if (noteSeq === null) return false;
  return true;
}

/** Result of a manual compaction. Meteor-free; callers map to `Meteor.Error`. */
export type CompactOutcome =
  'compacted' | 'nothing' | 'busy' | 'awaiting' | 'errored' | 'gone' | 'over-budget';

/** Refusal reasons, shared by both call sites. All map to error code `busy`
 *  but carry distinct reasons so the UI can tell the user what to do next. */
export const COMPACT_REFUSALS: Partial<Record<CompactOutcome, string>> = {
  busy: 'This session is running a turn; compact it when it is idle.',
  awaiting: 'This session is waiting on an approval; answer it before compacting.',
  errored: 'This session has failed; send to it again before compacting.',
};

/** Separate from `COMPACT_REFUSALS`: this maps to `budget-exhausted`, not `busy`. */
export const COMPACT_OVER_BUDGET =
  'This session has reached its spend budget; compaction bills like a turn.';

/** On-demand compaction (no threshold). Takes a lease like `runTurn` so it
 *  never interleaves with a live turn; refuses busy/awaiting/errored sessions. */
export async function compactSession(
  sessionId: string, config: RunConfig,
): Promise<CompactOutcome> {
  if (running.has(sessionId)) return 'busy';

  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return 'gone';
  // A pending approval is a decision, not a state to tidy.
  if (session.phase === 'awaiting') return 'awaiting';
  // A terminal failure must not be laundered into `idle`.
  if (session.phase === 'error') return 'errored';
  // Refuse before claiming the lease if over spend budget.
  if (config.budget?.spend !== undefined && session.usage.cost >= config.budget.spend) {
    return 'over-budget';
  }
  // A live or expired lease means someone else owns recovery.
  if (session.lease) return 'busy';

  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return 'busy';
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);
    try {
      // Tool schemas are prepared through the same catalog as an ordinary
      // Turn because the compacted head may carry any of its tool_use blocks.
      const selfAgent = config.agentName ?? session.agent;
      const prepared = await prepareToolRuntime({
        specs: config.tools,
        skills: config.skills,
        memory: config.memory
          ? {
            config: config.memory,
            session,
            agent: selfAgent,
          }
          : undefined,
      });
      const history = await AgentMessages
        .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
      const did = await compactNow(
        sessionId, session.agent, config, history, prepared.schemas,
        config.interruptCheckMs ?? 250,
      );
      return did ? 'compacted' : 'nothing';
    } finally {
      clearInterval(beat);
      // Restore phase to `idle` unless a decision landed mid-compaction.
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
