export interface ToolSchema {
    name: string;
    description: string;
    parameters: unknown;
}
export interface ProviderMessage {
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        args: unknown;
    }>;
    toolCallId?: string;
    /** `role: 'tool'` only, and set only when true: this result is a FAILURE.
     *  The content already says so in JSON, but providers carry a first-class
     *  error flag on a tool result and read it — Anthropic renders it as
     *  `is_error`, which changes how the model treats the block. Set from the
     *  transcript row's `error` field by `toProviderMessages`. */
    isError?: boolean;
    /**
     * Multimodal reads (participants spec §9): image blocks riding a `tool`
     * row's result — the ONE way image bytes reach a model, because
     * `read_attachment` is the one gate (decision 13: an image is offered as a
     * ref and read by choice). HYDRATED at request-build time in the loop —
     * after the compaction estimate, never on the summarizer path — from refs
     * the read stamped on the committed row; the row itself never carries
     * bytes. Adapters map them into their tool-result content blocks; the mock
     * simply exposes them to the script.
     */
    images?: Array<{
        data: string;
        mimeType: string;
    }>;
}
export interface ProviderRequest {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolSchema[];
    /** Aborting this must cancel the underlying HTTP request. Breaking out of
     *  the consuming loop alone only stops READING — the response keeps
     *  arriving and the provider keeps billing it. The loop passes a fresh
     *  per-attempt signal; providers that cannot honor it (the scripted mock,
     *  whose streams end immediately) may ignore it. */
    signal?: AbortSignal;
}
export type ProviderChunk = {
    kind: 'text';
    chunk: string;
} | {
    kind: 'thinking';
    chunk: string;
} | {
    kind: 'tool_args';
    chunk: string;
    /**
     * WHICH tool call this fragment belongs to, as the provider's index into
     * the assistant message's content blocks. Providers stream PARALLEL tool
     * calls interleaved, so without it a consumer joining `tool_args` deltas
     * in arrival order reconstructs one call's JSON spliced into another's —
     * two valid-looking fragments, neither parseable.
     *
     * Optional: a provider that reports no index (the scripted mock) still
     * streams, and everything downstream buckets those fragments together
     * under 0. `DeltaWriter` coalesces runs only WITHIN one index, and
     * `mergeView` accumulates per index.
     */
    contentIndex?: number;
} | {
    kind: 'done';
    toolCalls?: Array<{
        id: string;
        name: string;
        args: unknown;
    }>;
    usage?: {
        input: number;
        output: number;
        /**
         * Dollars for this call, when the provider prices it itself. OPTIONAL,
         * and preferred over the harness's own `pricing` math when present:
         * pi-ai bills cacheRead/cacheWrite tokens at rates a two-rate
         * input/output table cannot express, so recomputing from
         * `input`/`output` alone would misprice every cached call. A provider
         * that omits it falls back to `AgentConfig.pricing`, and to zero when
         * neither is configured.
         */
        cost?: number;
    };
};
export interface Provider {
    stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
    /**
     * OPTIONAL capability declarations (participants spec §9). `imageInput`
     * answers "may image blocks ride requests for this model?" — the pi-ai
     * adapter reads its catalog's input modalities; the mock declares it per
     * test; a provider that omits the whole surface answers NO by construction:
     * the gate FAILS CLOSED, because pi-ai silently downgrades images to text
     * placeholders for non-vision models, and a fail-open would quietly
     * contradict the read tool's own result text.
     */
    capabilities?: {
        imageInput?: (model: string) => boolean | Promise<boolean>;
    };
}
//# sourceMappingURL=types.d.ts.map