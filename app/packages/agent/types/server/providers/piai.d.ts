import type { Provider, ProviderChunk, ProviderRequest } from './types';
/** pi-ai `TextContent`. */
interface PiAiTextContent {
    type: 'text';
    text: string;
}
/** pi-ai `ImageContent` — base64 `data` + `mimeType`. */
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
/** pi-ai's `Usage`. Required on replayed `AssistantMessage` — see `zeroUsage()`. */
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
/** Pure mapping from ProviderRequest to pi-ai's request format. Identity trio
 *  and thinking are stamped at stream time by `createPiAiProvider` instead. */
export declare function toPiAiRequest(req: ProviderRequest, now?: number): PiAiRequest;
/** One pi-ai event → zero or more ProviderChunks. Unknown events map to []. */
export declare function translateEvent(ev: any): ProviderChunk[];
/** Provider over a pi-ai Models collection. Exported so tests can inject a
 *  fauxProvider without a network call. */
export declare function createPiAiProvider(resolveModels: () => Promise<PiAiModels>, options?: Record<string, unknown>): Provider;
/** Options for the default adapter. An explicit key wins over pi-ai's
 * provider-specific environment lookup; an absent key leaves that lookup
 * untouched. Exported for deterministic configuration tests, not re-exported
 * from the package's public server barrel. */
export declare function piAiOptionsFromEnv(env?: Readonly<Record<string, string | undefined>>): Record<string, unknown>;
/** Lazy singleton. Credentials come from the environment. */
export declare function piAiProvider(): Provider;
export {};
//# sourceMappingURL=piai.d.ts.map