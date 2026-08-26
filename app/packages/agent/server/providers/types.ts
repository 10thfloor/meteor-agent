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
  /** `role: 'tool'` only: providers carry a first-class error flag that
   *  changes how the model treats the block. */
  isError?: boolean;
  /** Image blocks from `read_attachment` (§9, decision 13). Hydrated at
   *  request-build time from refs on the committed row. */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolSchema[];
  /** Must cancel the underlying HTTP request — breaking out of the consuming
   *  loop alone only stops reading, not billing. */
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_args';
      chunk: string;
      /** Which content block this fragment belongs to. Providers stream
       *  parallel tool calls interleaved; without it the deltas would merge.
       *  Optional — absent means index 0. */
      contentIndex?: number }
  | { kind: 'done';
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
      usage?: {
        input: number;
        output: number;
        /** Provider-reported cost in dollars. Preferred over `pricing` math
         *  because cache token rates can't be expressed in a two-rate table. */
        cost?: number;
      } };

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  /** Optional capability declarations (§9). Fails closed — omitting
   *  `imageInput` means no image blocks on requests for that model. */
  capabilities?: {
    imageInput?: (model: string) => boolean | Promise<boolean>;
  };
}
