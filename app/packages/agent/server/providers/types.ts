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
      usage?: { input: number; output: number } };

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}
