import type { Provider, ProviderChunk, ProviderRequest } from './types';

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: { input: number; output: number };
}

export type MockScript = (req: ProviderRequest) => MockTurn;

/** Deterministic scripted provider — no API key, no network. Text emitted
 *  one char per chunk for partial-stream assertions. `opts.imageInput`
 *  declares vision capability (the gate fails closed without it). */
export function mockProvider(
  script: MockScript, opts?: { imageInput?: boolean },
): Provider {
  return {
    ...(opts?.imageInput !== undefined ? {
      capabilities: { imageInput: () => opts.imageInput === true },
    } : {}),
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const turn = script(req);
      for (const ch of (turn.text ?? '')) {
        yield { kind: 'text', chunk: ch };
      }
      yield {
        kind: 'done',
        toolCalls: turn.toolCalls,
        usage: turn.usage ?? { input: 10, output: (turn.text ?? '').length },
      };
    },
  };
}
