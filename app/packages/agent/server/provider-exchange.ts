import { AgentSessions } from '../common/collections';
import { createHash } from 'crypto';
import { runBeforeProviderRequest, type ProviderRequestHookContext } from './hooks';
import { SERVER_ID } from './lease';
import type { Provider, ProviderChunk, ProviderRequest } from './providers/types';
import { AGENT_MEMORY_FRAME_CLOSE, AGENT_MEMORY_FRAME_OPEN } from './learning';

/** @internal A Provider Exchange is one attempt, not a retry policy. It owns
 * hook ordering and cancellation so every caller presents the same request
 * seam to Provider Adapters. */
export interface ProviderExchangeOptions {
  sessionId: string;
  provider: Provider;
  request: Omit<ProviderRequest, 'signal'>;
  context: ProviderRequestHookContext;
  /** Frozen Constitution/Practice material. Application hooks may rewrite the
   * ordinary request, but this suffix is stamped afterwards so a hook cannot
   * remove or replace the Agent's adopted Memory Frame. */
  protectedSystem?: string;
  /** Digest-only audit Seam. It runs after hooks and protected-layer
   * finalization, immediately before paid work. Throwing fails the exchange
   * closed; callers should never persist the raw request. */
  onEffectiveRequest?: (
    request: Omit<ProviderRequest, 'signal'>, digest: string,
  ) => void | Promise<void>;
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

export function effectiveProviderRequestDigest(
  request: Omit<ProviderRequest, 'signal'>,
): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** Reserved markers are an authority signal only the harness may emit — in
 * the system string, exactly once. An occurrence arriving inside MESSAGE
 * content (a tool result, MCP output, user text, a compaction summary) is
 * untrusted data wearing the governance uniform: break the byte sequence
 * with a zero-width space so the model cannot mistake it for a reviewed
 * Frame, while keeping the surrounding text legible. */
function neutralizeFrameMarkers(text: string): string {
  const zwsp = String.fromCharCode(0x200b); // zero-width space
  return text
    .split(AGENT_MEMORY_FRAME_OPEN).join(`<${zwsp}${AGENT_MEMORY_FRAME_OPEN.slice(1)}`)
    .split(AGENT_MEMORY_FRAME_CLOSE).join(`<${zwsp}${AGENT_MEMORY_FRAME_CLOSE.slice(1)}`);
}

/** Hooks may rewrite ordinary prompt material, but cannot forge a second
 * protected layer. Remove complete and dangling reserved markers before the
 * harness appends its validated Frame bytes. */
function finalizeProtectedSystem(hooked: string, protectedSystem?: string): string {
  if (!protectedSystem) return hooked;
  if (count(protectedSystem, AGENT_MEMORY_FRAME_OPEN) !== 1
    || count(protectedSystem, AGENT_MEMORY_FRAME_CLOSE) !== 1) {
    throw new Error('[10thfloor:agent] malformed protected Agent Memory Frame');
  }
  const complete = new RegExp(
    `${AGENT_MEMORY_FRAME_OPEN}[\\s\\S]*?${AGENT_MEMORY_FRAME_CLOSE}`,
    'g',
  );
  const cleaned = hooked.replace(complete, '')
    .split(AGENT_MEMORY_FRAME_OPEN).join('')
    .split(AGENT_MEMORY_FRAME_CLOSE).join('');
  // The protected block owns its leading separator. Removing a forged block
  // must not leave an ever-growing run of blank lines at this boundary.
  return `${cleaned.trimEnd()}${protectedSystem}`;
}

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
    const hooked = await runBeforeProviderRequest(options.request, options.context);
    const request = {
      ...hooked,
      system: finalizeProtectedSystem(hooked.system, options.protectedSystem),
      // The forgery boundary must cover the whole request, not just the
      // system string — transcript content is the dominant injection surface.
      ...(options.protectedSystem ? {
        messages: hooked.messages.map((message) => (
          typeof message.content === 'string' && message.content
            ? { ...message, content: neutralizeFrameMarkers(message.content) }
            : message)),
      } : {}),
    };
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
      await options.onEffectiveRequest?.(
        request, effectiveProviderRequestDigest(request),
      );
      // Auditing may itself await storage or hooks long enough for the Lease,
      // Session, or lifecycle fence to change. Re-prove authority at the final
      // boundary before constructing the paid Provider stream.
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
