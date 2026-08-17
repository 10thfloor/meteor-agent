export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;          // JSON Schema, produced by TypeBox
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;
  /** `role: 'tool'` only, and set only when true: this result is a FAILURE.
   *  The content already says so in JSON, but providers carry a first-class
   *  error flag on a tool result and read it — Anthropic renders it as
   *  `is_error`, which changes how the model treats the block. Set from the
   *  transcript row's `error` field by `toProviderMessages`. */
  isError?: boolean;
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

export type ProviderChunk =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_args'; chunk: string }
  | { kind: 'done';
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
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
      } };

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}
