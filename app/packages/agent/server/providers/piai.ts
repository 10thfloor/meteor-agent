import { loadPiAi } from './loader';
import type { Provider, ProviderChunk, ProviderMessage, ProviderRequest } from './types';

/* Mapping layer for @earendil-works/pi-ai. Types read off installed dist. */

/** pi-ai `TextContent`. */
interface PiAiTextContent { type: 'text'; text: string }
/** pi-ai `ImageContent` — base64 `data` + `mimeType`. */
interface PiAiImageContent { type: 'image'; data: string; mimeType: string }
/** pi-ai `ToolCall` content block. Note `arguments`, not `args`. */
interface PiAiToolCallContent {
  type: 'toolCall'; id: string; name: string; arguments: Record<string, any>;
}

/** pi-ai's `Usage`. Required on replayed `AssistantMessage` — see `zeroUsage()`. */
export interface PiAiUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiAiMessage =
  | { role: 'user'; content: string; timestamp: number }
  | {
      role: 'assistant'; content: Array<PiAiTextContent | PiAiToolCallContent>;
      usage: PiAiUsage; timestamp: number;
    }
  | {
      role: 'toolResult'; toolCallId: string; toolName: string;
      content: Array<PiAiTextContent | PiAiImageContent>;
      isError: boolean; timestamp: number;
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

/** Pure mapping from ProviderRequest to pi-ai's request format. Identity trio
 *  and thinking are stamped at stream time by `createPiAiProvider` instead. */
export function toPiAiRequest(req: ProviderRequest, now: number = Date.now()): PiAiRequest {
  const slash = req.model.indexOf('/');
  if (slash <= 0 || slash === req.model.length - 1) {
    const e: any = new Error(
      `[10thfloor:agent] model must be "<provider>/<model-id>" for the pi-ai ` +
      `provider (e.g. "anthropic/claude-sonnet-5"); got "${req.model}"`,
    );
    e.retryable = false;
    throw e;
  }
  // First slash only: openrouter ids are themselves slashed
  // ("openrouter/moonshotai/kimi-k2").
  const provider = req.model.slice(0, slash);
  const modelId = req.model.slice(slash + 1);

  // Recover toolName (required by pi-ai) from the originating call.
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

/** All-zero Usage for replayed assistant messages. pi-ai requires it (crashes
 *  on undefined), and zero makes it fall back to its own context estimate
 *  rather than anchoring on a number we can't supply. */
function zeroUsage(): PiAiUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
      content: [
        { type: 'text', text: m.content ?? '' },
        // Hydrated image blocks ride the tool result.
        ...(m.images ?? []).map((i): PiAiImageContent => ({
          type: 'image', data: i.data, mimeType: i.mimeType,
        })),
      ],
      isError: m.isError === true,
      timestamp: now,
    };
  }
  if (m.role === 'assistant') {
    const content: Array<PiAiTextContent | PiAiToolCallContent> = [];
    // Empty text blocks are dropped by pi-ai anyway.
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls ?? []) {
      content.push({
        type: 'toolCall', id: c.id, name: c.name,
        arguments: (c.args ?? {}) as Record<string, any>,
      });
    }
    return { role: 'assistant', content, usage: zeroUsage(), timestamp: now };
  }
  // Exhaustiveness check: a new ProviderMessage role fails to compile here.
  const user: 'user' = m.role;
  return { role: user, content: m.content ?? '', timestamp: now };
}

/** Extract cost from pi-ai Usage. Zero means unpriced (pi-ai has no rates for
 *  the model), so it's omitted to let the operator's own `pricing` take over. */
function reportedCost(usage: any): number | undefined {
  const raw = typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw;
}

/** One pi-ai event → zero or more ProviderChunks. Unknown events map to []. */
export function translateEvent(ev: any): ProviderChunk[] {
  switch (ev?.type) {
    case 'text_delta':
      return [{ kind: 'text', chunk: String(ev.delta ?? '') }];
    case 'thinking_delta':
      return [{ kind: 'thinking', chunk: String(ev.delta ?? '') }];
    case 'toolcall_delta':
      // Separates interleaved parallel tool calls. Omitted (not defaulted)
      // when absent — a fabricated 0 would merge them.
      return [{
        kind: 'tool_args',
        chunk: String(ev.delta ?? ''),
        ...(typeof ev.contentIndex === 'number' ? { contentIndex: ev.contentIndex } : {}),
      }];
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
        // pi-ai's cost includes cache tokens we can't see; pass it through.
        usage: usage
          ? { input: usage.input ?? 0, output: usage.output ?? 0, ...(cost === undefined ? {} : { cost }) }
          : undefined,
      }];
    }
    default:
      return [];
  }
}

/** Provider over a pi-ai Models collection. Exported so tests can inject a
 *  fauxProvider without a network call. */
export function createPiAiProvider(
  resolveModels: () => Promise<PiAiModels>,
  options?: Record<string, unknown>,
): Provider {
  return {
    capabilities: {
      // Fails closed: a model that can't be resolved is assumed non-vision.
      async imageInput(model: string): Promise<boolean> {
        try {
          const slash = model.indexOf('/');
          if (slash <= 0 || slash === model.length - 1) return false;
          const models = await resolveModels();
          const m: any = models.getModel(model.slice(0, slash), model.slice(slash + 1));
          return Array.isArray(m?.input) && m.input.includes('image');
        } catch {
          return false;
        }
      },
    },
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const { provider, modelId, context } = toPiAiRequest(req);
      const models = await resolveModels();
      const model = models.getModel(provider, modelId);
      if (!model) {
        const e: any = new Error(
          `[10thfloor:agent] pi-ai has no model "${provider}/${modelId}". ` +
          `Check the provider id and model id against pi-ai's catalog.`,
        );
        e.retryable = false;
        throw e;
      }
      // Stamp replayed messages with the live model's identity so pi-ai
      // treats them as same-model rather than rewriting their tool-call ids.
      for (const m of context.messages) {
        if (m.role === 'assistant') {
          Object.assign(m, { provider, model: modelId, api: (model as any).api });
        }
      }
      // signal written last so the loop's controller can't be displaced.
      for await (const ev of models.streamSimple(model, context, { ...options, signal: req.signal })) {
        if (ev?.type === 'error') {
          // pi-ai signals failure as an event; re-throw so the loop handles it.
          const err: any = new Error(
            `[10thfloor:agent] pi-ai stream failed (${ev.reason}): ` +
            `${ev.error?.errorMessage ?? 'unknown error'}`,
          );
          // Abort → abandon (don't retry what the user cancelled).
          if (ev.reason === 'aborted') {
            err.retryable = 'abandon';
          } else {
            // Use pi-ai's own retryable classifier; degrade to no hint if absent.
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

/** Options for the default adapter. An explicit key wins over pi-ai's
 * provider-specific environment lookup; an absent key leaves that lookup
 * untouched. Exported for deterministic configuration tests, not re-exported
 * from the package's public server barrel. */
export function piAiOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, unknown> {
  const apiKey = env.PROVIDER_API_KEY;
  return apiKey === undefined || apiKey === '' ? {} : { apiKey };
}

/** Lazy singleton. Credentials come from the environment. */
export function piAiProvider(): Provider {
  if (singleton) return singleton;
  singleton = createPiAiProvider(() => {
    if (!builtins) {
      builtins = (async () => {
        const all: any = await loadPiAi('providers/all');
        return all.builtinModels() as PiAiModels;
      })();
      // Never cache a rejection — next turn retries from scratch.
      builtins.catch(() => { builtins = null; });
    }
    return builtins;
  }, piAiOptionsFromEnv());
  return singleton;
}
