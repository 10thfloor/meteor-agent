import { loadPiAi } from './loader';
import type { Provider, ProviderChunk, ProviderMessage, ProviderRequest } from './types';

/*
 * Mapping layer for @earendil-works/pi-ai 0.84.2. Every name below was read off
 * the installed `dist/*.d.ts` — pi-ai is pre-1.0 and none of it is guessed:
 *
 *   Models.streamSimple(model: Model<Api>, context: Context,
 *                       options?: SimpleStreamOptions): AssistantMessageEventStream
 *   Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
 *   Message = UserMessage | AssistantMessage | ToolResultMessage
 *             (roles "user" | "assistant" | "toolResult")
 *   ToolCall { type: "toolCall"; id; name; arguments }
 *   AssistantMessageEvent = start | text_start/_delta/_end
 *                         | thinking_start/_delta/_end
 *                         | toolcall_start/_delta/_end
 *                         | { type: "done"; reason; message: AssistantMessage }
 *                         | { type: "error"; reason; error: AssistantMessage }
 *   Usage { input; output; cacheRead; cacheWrite; totalTokens; cost }  (on the
 *           final AssistantMessage, i.e. `done.message.usage`)
 *
 * There is no top-level `streamSimple` export: streaming hangs off a `Models`
 * collection, and the built-in catalog lives behind the `providers/all`
 * subpath export (`builtinModels()`), which is why the loader gained a subpath
 * parameter.
 */

/** pi-ai `TextContent`. */
interface PiAiTextContent { type: 'text'; text: string }
/** pi-ai `ToolCall` content block. Note `arguments`, not `args`. */
interface PiAiToolCallContent {
  type: 'toolCall'; id: string; name: string; arguments: Record<string, any>;
}

export type PiAiMessage =
  | { role: 'user'; content: string; timestamp: number }
  | { role: 'assistant'; content: Array<PiAiTextContent | PiAiToolCallContent>; timestamp: number }
  | {
      role: 'toolResult'; toolCallId: string; toolName: string;
      content: PiAiTextContent[]; isError: boolean; timestamp: number;
    };

export interface PiAiTool { name: string; description: string; parameters: unknown }

export interface PiAiContext {
  systemPrompt?: string;
  messages: PiAiMessage[];
  tools?: PiAiTool[];
}

export interface PiAiRequest {
  /** pi-ai provider id, e.g. `anthropic`. */
  provider: string;
  /** pi-ai model id within that provider, e.g. `claude-sonnet-5`. */
  modelId: string;
  context: PiAiContext;
}

/** The slice of pi-ai's `Models` this adapter uses. */
export interface PiAiModels {
  getModel(provider: string, id: string): unknown;
  streamSimple(model: unknown, context: PiAiContext, options?: unknown): AsyncIterable<any>;
}

/**
 * `ProviderRequest` -> pi-ai's `(model, Context)` pair. PURE: `now` is injected
 * so the result is a function of its arguments alone.
 *
 * pi-ai's `AssistantMessage` type additionally declares `api`, `provider`,
 * `model`, `usage` and `stopReason`. The identity trio IS read off replayed
 * history — `transform-messages`' `isSameModel` compares them against the live
 * model, and OpenAI Responses normalizes tool-call ids for "foreign" messages —
 * but the values require the resolved model object, which this pure function
 * does not have. `createPiAiProvider` stamps them at stream time instead.
 * Thinking is not replayed: pi-ai needs the provider's opaque
 * `thinkingSignature` to send a thinking block back, and the transcript does
 * not store one — Anthropic's converter downgrades an unsigned thinking block
 * to plain text anyway.
 */
export function toPiAiRequest(req: ProviderRequest, now: number = Date.now()): PiAiRequest {
  const slash = req.model.indexOf('/');
  if (slash <= 0 || slash === req.model.length - 1) {
    const e: any = new Error(
      `[10thfloor:agent] model must be "<provider>/<model-id>" for the pi-ai ` +
      `provider (e.g. "anthropic/claude-sonnet-5"); got "${req.model}"`,
    );
    // A malformed model string is a configuration error: deterministic, so
    // retrying burns attempts and backoff on a certainty. The hint routes it
    // straight to the loop's fatal path (error note + phase 'error').
    e.retryable = false;
    throw e;
  }
  // First slash only: openrouter ids are themselves slashed
  // ("openrouter/moonshotai/kimi-k2").
  const provider = req.model.slice(0, slash);
  const modelId = req.model.slice(slash + 1);

  // pi-ai's ToolResultMessage requires `toolName`, which ProviderMessage does
  // not carry. Recover it from the call that produced the result.
  const toolNames = new Map<string, string>();
  for (const m of req.messages) {
    for (const c of m.toolCalls ?? []) toolNames.set(c.id, c.name);
  }

  const messages = req.messages.map((m) => toPiAiMessage(m, toolNames, now));

  return {
    provider,
    modelId,
    context: {
      systemPrompt: req.system || undefined,
      messages,
      tools: req.tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      })),
    },
  };
}

function toPiAiMessage(
  m: ProviderMessage, toolNames: Map<string, string>, now: number,
): PiAiMessage {
  if (m.role === 'tool') {
    return {
      role: 'toolResult',
      toolCallId: m.toolCallId ?? '',
      toolName: toolNames.get(m.toolCallId ?? '') ?? '',
      content: [{ type: 'text', text: m.content ?? '' }],
      // The transcript's `error` field, carried this far by the loop's
      // `toProviderMessages` as `ProviderMessage.isError`. pi-ai's
      // ToolResultMessage requires the flag, so an absent one is `false` —
      // a successful result — rather than omitted.
      isError: m.isError === true,
      timestamp: now,
    };
  }
  if (m.role === 'assistant') {
    const content: Array<PiAiTextContent | PiAiToolCallContent> = [];
    // An empty text block is dropped by pi-ai's converters anyway; not emitting
    // it keeps the mapping's output equal to what actually goes on the wire.
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls ?? []) {
      content.push({
        type: 'toolCall', id: c.id, name: c.name,
        arguments: (c.args ?? {}) as Record<string, any>,
      });
    }
    return { role: 'assistant', content, timestamp: now };
  }
  return { role: 'user', content: m.content ?? '', timestamp: now };
}

/**
 * Dollars off a pi-ai `Usage`, or undefined when it has not priced the call.
 *
 * pi-ai 0.84's `Usage.cost` is a BREAKDOWN object
 * (`{input, output, cacheRead, cacheWrite, total}`), not a number — the `total`
 * is the figure. A plain number is accepted too, so a future release that
 * flattens the field does not silently start reporting nothing.
 *
 * Zero is treated as ABSENT, deliberately. pi-ai reports `total: 0` for a model
 * its catalog has no rates for, which is indistinguishable from "this call was
 * free" — and the two differ only in whether `AgentConfig.pricing` gets a
 * chance to price it. Accruing a zero would silently suppress the operator's
 * own configured fallback; omitting it costs nothing when the call really was
 * free, since accruing zero and accruing nothing are the same `$inc`.
 */
function reportedCost(usage: any): number | undefined {
  const raw = typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw;
}

/**
 * One pi-ai stream event -> zero or more `ProviderChunk`s. PURE and stateless:
 * the terminal `done` event carries the complete `AssistantMessage`, so tool
 * calls and usage are read off it rather than accumulated across events.
 *
 * Unknown event types map to `[]` — a future pi-ai event must never crash a
 * turn. `error` also maps to `[]`; it is a stream TERMINATION, handled by
 * `stream()` below, which throws so the turn fails rather than committing a
 * silently truncated answer.
 */
export function translateEvent(ev: any): ProviderChunk[] {
  switch (ev?.type) {
    case 'text_delta':
      return [{ kind: 'text', chunk: String(ev.delta ?? '') }];
    case 'thinking_delta':
      return [{ kind: 'thinking', chunk: String(ev.delta ?? '') }];
    case 'toolcall_delta':
      return [{ kind: 'tool_args', chunk: String(ev.delta ?? '') }];
    case 'done': {
      const content: any[] = ev.message?.content ?? [];
      const calls = content
        .filter((c) => c?.type === 'toolCall')
        .map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
      const usage = ev.message?.usage;
      const cost = reportedCost(usage);
      return [{
        kind: 'done',
        toolCalls: calls.length > 0 ? calls : undefined,
        // pi-ai also reports cacheRead/cacheWrite/reasoning tokens, which the
        // ProviderChunk union does not carry — so per-token math over
        // input/output alone would misprice every cached call. pi-ai has
        // already done that arithmetic against its own catalog, so its
        // `cost.total` is passed straight through and the loop prefers it over
        // any configured `pricing`.
        usage: usage
          ? { input: usage.input ?? 0, output: usage.output ?? 0, ...(cost === undefined ? {} : { cost }) }
          : undefined,
      }];
    }
    default:
      return [];
  }
}

/**
 * The `Provider` seam over an arbitrary pi-ai `Models` collection. Exported so
 * tests can drive the whole stream path through pi-ai's own `fauxProvider()`
 * without a network call or an API key.
 */
export function createPiAiProvider(resolveModels: () => Promise<PiAiModels>): Provider {
  return {
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const { provider, modelId, context } = toPiAiRequest(req);
      const models = await resolveModels();
      const model = models.getModel(provider, modelId);
      if (!model) {
        const e: any = new Error(
          `[10thfloor:agent] pi-ai has no model "${provider}/${modelId}". ` +
          `Check the provider id and model id against pi-ai's catalog.`,
        );
        // Deterministic configuration error — see the matching hint in
        // toPiAiRequest. Retrying cannot make the catalog grow the model.
        e.retryable = false;
        throw e;
      }
      // Stamp replayed assistant messages with the live model's identity.
      // pi-ai's converters compare `provider`/`api`/`model` on history against
      // the live model (`isSameModel`) and, on OpenAI Responses, rewrite
      // tool-call ids for messages that look "foreign" — which, unstamped,
      // is ALL of them. The transcript does not record which model produced
      // each message, so this assumes the session stayed on one model; a
      // mid-session model switch makes older turns claim the new identity,
      // which at worst downgrades pi-ai's same-model replay optimizations.
      for (const m of context.messages) {
        if (m.role === 'assistant') {
          Object.assign(m, { provider, model: modelId, api: (model as any).api });
        }
      }
      // The third argument is the only thing that reaches the HTTP request:
      // `ModelsSimpleStreamOptions` extends `ProviderRequestOptions`, which
      // declares `signal?: AbortSignal` (types.d.ts:50). Without it, an
      // interrupt stops only the reading.
      for await (const ev of models.streamSimple(model, context, { signal: req.signal })) {
        if (ev?.type === 'error') {
          // pi-ai terminates a failed stream with an event, not a rejection.
          // Throwing turns it back into the failure the turn loop expects: the
          // turn aborts, nothing is committed, and `agent.send` logs it. The
          // message is pi-ai's own formatted error string, never a raw payload,
          // and this adapter writes nothing to Mongo.
          const err: any = new Error(
            `[10thfloor:agent] pi-ai stream failed (${ev.reason}): ` +
            `${ev.error?.errorMessage ?? 'unknown error'}`,
          );
          // §10 retry hint, read by loop.ts's classifyProviderError
          // (`e.retryable` short-circuits its status-based classification).
          // An abort is neither transient (retrying re-issues the request the
          // user just cancelled, at full price) nor a failure to report at
          // them (they cancelled it) — 'abandon' routes it onto the loop's
          // interrupt path: deltas cleaned, no error note, stop preserved.
          if (ev.reason === 'aborted') {
            err.retryable = 'abandon';
          } else {
            // Reuse pi-ai's own transient-vs-terminal classifier (rate
            // limits/timeouts/overloaded upstreams vs auth/quota errors)
            // rather than re-implementing its pattern list. Defensive: a
            // future pi-ai release that renames or drops this export must
            // degrade to no hint — classifyProviderError's status-based
            // fallback still applies — not a crash.
            try {
              const piai: any = await loadPiAi();
              if (typeof piai.isRetryableAssistantError === 'function') {
                err.retryable = piai.isRetryableAssistantError(ev.error);
              }
            } catch { /* no-hint fallback */ }
          }
          throw err;
        }
        for (const chunk of translateEvent(ev)) yield chunk;
      }
    },
  };
}

let singleton: Provider | null = null;
let builtins: Promise<PiAiModels> | null = null;

/**
 * Lazy: pi-ai is only loaded the first time a turn actually streams, and the
 * built-in catalog is built once. API keys come from the environment exactly as
 * pi-ai itself reads them (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
 * `OPENAI_API_KEY`, …, resolved per provider); this package adds no key
 * plumbing of its own in M2.
 */
export function piAiProvider(): Provider {
  if (singleton) return singleton;
  singleton = createPiAiProvider(() => {
    if (!builtins) {
      builtins = (async () => {
        const all: any = await loadPiAi('providers/all');
        return all.builtinModels() as PiAiModels;
      })();
      // Never cache a rejection: one transient load failure at first use must
      // not poison every later turn for the process lifetime. The next turn
      // rebuilds the promise from scratch.
      builtins.catch(() => { builtins = null; });
    }
    return builtins;
  });
  return singleton;
}
