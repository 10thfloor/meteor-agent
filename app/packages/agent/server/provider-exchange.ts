import { AgentSessions } from '../common/collections';
import { runBeforeProviderRequest, type ProviderRequestHookContext } from './hooks';
import { SERVER_ID } from './lease';
import type { Provider, ProviderChunk, ProviderRequest } from './providers/types';

/** @internal A Provider Exchange is one attempt, not a retry policy. It owns
 * hook ordering and cancellation so every caller presents the same request
 * seam to Provider Adapters. */
export interface ProviderExchangeOptions {
  sessionId: string;
  provider: Provider;
  request: Omit<ProviderRequest, 'signal'>;
  context: ProviderRequestHookContext;
  interruptCheckMs?: number;
  onChunk: (chunk: ProviderChunk) => void;
}

/** @internal Provider failures stay opaque here: the Turn decides whether to
 * retry, while compaction decides whether to degrade. */
export type ProviderExchangeResult =
  | { kind: 'complete' }
  | { kind: 'interrupted' }
  | { kind: 'failed'; error: unknown };

const usageCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0
);

/** Provider Adapters are replaceable application code. Normalize their only
 * values that become arithmetic Mongo updates before callers observe them. */
function normalizeChunk(chunk: ProviderChunk): ProviderChunk {
  if (chunk.kind !== 'done' || !chunk.usage) return chunk;
  const cost = chunk.usage.cost;
  return {
    ...chunk,
    usage: {
      input: usageCount(chunk.usage.input),
      output: usageCount(chunk.usage.output),
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? { cost: Math.min(Number.MAX_SAFE_INTEGER, cost) }
        : {}),
    },
  };
}

/** @internal Run one Provider attempt under the Session's stop signal.
 *
 * The Interface guarantees that hooks cannot replace the AbortSignal, a stop
 * before the first chunk aborts a stalled Adapter, a non-cooperative Adapter is
 * abandoned at its next yield, and a stop after its last yield is observed
 * before the caller performs post-exchange side effects. Durable commit guards
 * remain the final atomic authority for the last possible race. */
export async function runProviderExchange(
  options: ProviderExchangeOptions,
): Promise<ProviderExchangeResult> {
  const abort = new AbortController();
  let interrupted = false;
  let failed = false;
  let failure: unknown;
  let interruptPoll: Promise<void> | null = null;

  const hasAuthority = async (): Promise<boolean> => !!(await AgentSessions.findOneAsync({
    _id: options.sessionId,
    phase: { $ne: 'stopped' },
    'lease.serverId': SERVER_ID,
    'lease.until': { $gt: new Date() },
    erasingAt: { $exists: false },
    purgingAt: { $exists: false },
  }, { fields: { _id: 1 } }));

  const interrupt = (): void => {
    interrupted = true;
    if (!abort.signal.aborted) abort.abort();
  };

  const pollForInterrupt = (): void => {
    if (interruptPoll || abort.signal.aborted) return;
    interruptPoll = (async () => {
      try {
        if (!(await hasAuthority())) interrupt();
      } catch {
        // Starting or continuing paid work requires positive authority. A
        // transient read failure leaves durable evidence for recovery.
        interrupt();
      }
    })().finally(() => {
      interruptPoll = null;
    });
  };

  const timer = setInterval(
    pollForInterrupt,
    Math.max(1, options.interruptCheckMs ?? 250),
  );
  try {
    // Do not run application hooks or start paid work for an exchange whose
    // exact Lease/fence authority was already lost during request assembly.
    pollForInterrupt();
    const initial = interruptPoll;
    if (initial) await initial;
    if (interrupted || abort.signal.aborted) return { kind: 'interrupted' };
    // Hooks never own cancellation. Stamp the harness signal after their
    // replacement request has been accepted.
    const request = await runBeforeProviderRequest(options.request, options.context);
    // A hook may have awaited long enough for the Lease to expire or move.
    // Re-prove authority immediately before starting paid Provider work rather
    // than waiting for the next periodic observation.
    if (!abort.signal.aborted) {
      try {
        if (!(await hasAuthority())) interrupt();
      } catch {
        interrupt();
      }
    }
    if (!abort.signal.aborted) {
      for await (const chunk of options.provider.stream({
        ...request,
        signal: abort.signal,
      })) {
        // A non-cooperative Adapter may yield after its signal was aborted.
        // Do not let that late chunk reach Deltas or any other caller state.
        if (abort.signal.aborted) break;
        options.onChunk(normalizeChunk(chunk));
        if (abort.signal.aborted) break;
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    clearInterval(timer);
    const pending = interruptPoll;
    if (pending) await pending;
  }

  // Close the final-yield race instead of waiting for the next interval. This
  // is still observational; callers pair it with an atomic unless-stopped
  // Transcript commit.
  if (!interrupted) {
    try {
      if (!(await hasAuthority())) interrupt();
    } catch {
      interrupt();
    }
  }

  if (interrupted) return { kind: 'interrupted' };
  if (failed) return { kind: 'failed', error: failure };
  return { kind: 'complete' };
}
