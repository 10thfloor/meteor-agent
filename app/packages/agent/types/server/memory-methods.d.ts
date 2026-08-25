import type { ResolvedMemory } from '../common/types';
/** TEST SEAM, not public API: lets a suite assert the latch without a second
 *  process. Not re-exported from `server/index.ts`. */
export declare function _memoryMethodsRegistered(): boolean;
/**
 * Which memory config governs a DDP call.
 *
 * The client names no agent, and it should not have to: person memory follows
 * the HUMAN, not the model (decision 2), so ANY memory-declaring agent's
 * config resolves the same person store. The first registered wins for caps;
 * the store it points at is identical either way.
 *
 * Installed by `registry` rather than imported FROM it: `registry` calls
 * `ensureMemoryMethods`, so importing the registry back here would close a
 * cycle. An injected resolver keeps this module a leaf.
 */
export type GoverningConfig = () => {
    config?: ResolvedMemory;
    agent: string;
};
export declare function ensureMemoryMethods(resolve: GoverningConfig): void;
//# sourceMappingURL=memory-methods.d.ts.map