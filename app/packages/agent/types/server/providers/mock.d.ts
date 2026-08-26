import type { Provider, ProviderRequest } from './types';
export interface MockTurn {
    text?: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        args: unknown;
    }>;
    usage?: {
        input: number;
        output: number;
    };
}
export type MockScript = (req: ProviderRequest) => MockTurn;
/** Deterministic scripted provider — no API key, no network. Text emitted
 *  one char per chunk for partial-stream assertions. `opts.imageInput`
 *  declares vision capability (the gate fails closed without it). */
export declare function mockProvider(script: MockScript, opts?: {
    imageInput?: boolean;
}): Provider;
//# sourceMappingURL=mock.d.ts.map