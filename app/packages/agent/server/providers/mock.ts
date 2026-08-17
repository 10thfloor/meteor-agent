import type { Provider, ProviderChunk, ProviderRequest } from './types';

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: { input: number; output: number };
}

export type MockScript = (req: ProviderRequest) => MockTurn;

/** Deterministic scripted provider — no API key, no network. Text is emitted
 *  one character per chunk so tests can assert on partial streams.
 *  `req.signal` is deliberately ignored: there is no HTTP request behind a
 *  scripted stream to cancel, and it ends immediately anyway. Tests that need
 *  to observe the abort write their own saboteur provider. */
export function mockProvider(script: MockScript): Provider {
  return {
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
