import type { Provider, ProviderChunk, ProviderRequest } from './types';
/** pi-ai `TextContent`. */
interface PiAiTextContent {
    type: 'text';
    text: string;
}
/** pi-ai `ImageContent` (types.d.ts) — base64 `data` + `mimeType`, legal on
 *  user messages and tool results. The harness sends it only on tool results
 *  (participants spec decision 13: images enter context through
 *  `read_attachment` alone). */
interface PiAiImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}
/** pi-ai `ToolCall` content block. Note `arguments`, not `args`. */
interface PiAiToolCallContent {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, any>;
}
/**
 * pi-ai's `Usage`. Required on a replayed `AssistantMessage`, not optional —
 * see `zeroUsage()`.
 */
export interface PiAiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
export type PiAiMessage = {
    role: 'user';
    content: string;
    timestamp: number;
} | {
    role: 'assistant';
    content: Array<PiAiTextContent | PiAiToolCallContent>;
    usage: PiAiUsage;
    timestamp: number;
} | {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: Array<PiAiTextContent | PiAiImageContent>;
    isError: boolean;
    timestamp: number;
};
export interface PiAiTool {
    name: string;
    description: string;
    parameters: unknown;
}
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
export declare function toPiAiRequest(req: ProviderRequest, now?: number): PiAiRequest;
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
export declare function translateEvent(ev: any): ProviderChunk[];
/**
 * The `Provider` seam over an arbitrary pi-ai `Models` collection. Exported so
 * tests can drive the whole stream path through pi-ai's own `fauxProvider()`
 * without a network call or an API key.
 *
 * `options` are merged into every `streamSimple` call. The type is pi-ai's
 * `ModelsSimpleStreamOptions` minus the fields this adapter owns — `apiKey`,
 * `fetch`, `headers`, `timeoutMs`, … (`ProviderRequestOptions`, types.d.ts:49).
 * `piAiProvider()` passes nothing, so the shipped behavior is unchanged and
 * keys keep coming from the environment; the seam exists so a test can inject a
 * `fetch` and read the request body the real converter produces, which is the
 * only way to check the wire format without a network call.
 */
export declare function createPiAiProvider(resolveModels: () => Promise<PiAiModels>, options?: Record<string, unknown>): Provider;
/**
 * Lazy: pi-ai is only loaded the first time a turn actually streams, and the
 * built-in catalog is built once. API keys come from the environment exactly as
 * pi-ai itself reads them (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
 * `OPENAI_API_KEY`, …, resolved per provider); this package adds no key
 * plumbing of its own in M2.
 */
export declare function piAiProvider(): Provider;
export {};
//# sourceMappingURL=piai.d.ts.map