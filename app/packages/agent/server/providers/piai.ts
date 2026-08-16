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
 * `model`, `usage` and `stopReason` as required, but those describe a RESPONSE;
 * no API implementation reads them back off replayed history (verified across
 * every `dist/api/*.js` converter), so this emits only what is actually read.
 * Thinking is likewise not replayed: pi-ai needs the provider's opaque
 * `thinkingSignature` to send a thinking block back, and the transcript does
 * not store one — Anthropic's converter downgrades an unsigned thinking block
 * to plain text anyway.
 */
export function toPiAiRequest(req: ProviderRequest, now: number = Date.now()): PiAiRequest {
  const slash = req.model.indexOf('/');
  if (slash <= 0 || slash === req.model.length - 1) {
    throw new Error(
      `[10thfloor:agent] model must be "<provider>/<model-id>" for the pi-ai ` +
      `provider (e.g. "anthropic/claude-sonnet-5"); got "${req.model}"`,
    );
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
      // ProviderMessage has no error flag; the transcript's `error` field is
      // dropped by the loop's toProviderMessages. Tool failures reach the model
      // as their JSON content either way.
      isError: false,
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
      return [{
        kind: 'done',
        toolCalls: calls.length > 0 ? calls : undefined,
        // pi-ai also reports cacheRead/cacheWrite/reasoning tokens; the
        // ProviderChunk union carries only input/output, so cache tokens are
        // currently priced as neither. Task 5 (pricing) will need them.
        usage: usage ? { input: usage.input ?? 0, output: usage.output ?? 0 } : undefined,
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
        throw new Error(
          `[10thfloor:agent] pi-ai has no model "${provider}/${modelId}". ` +
          `Check the provider id and model id against pi-ai's catalog.`,
        );
      }
      for await (const ev of models.streamSimple(model, context)) {
        if (ev?.type === 'error') {
          // pi-ai terminates a failed stream with an event, not a rejection.
          // Throwing turns it back into the failure the turn loop expects: the
          // turn aborts, nothing is committed, and `agent.send` logs it. The
          // message is pi-ai's own formatted error string, never a raw payload,
          // and this adapter writes nothing to Mongo.
          throw new Error(
            `[10thfloor:agent] pi-ai stream failed (${ev.reason}): ` +
            `${ev.error?.errorMessage ?? 'unknown error'}`,
          );
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
    }
    return builtins;
  });
  return singleton;
}
