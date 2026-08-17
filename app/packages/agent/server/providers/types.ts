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
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolSchema[];
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
