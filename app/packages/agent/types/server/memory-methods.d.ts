import type { ResolvedMemory } from '../common/types';
/** Test seam: assert the latch without a second process. */
export declare function _memoryMethodsRegistered(): boolean;
/** Which memory config governs a DDP call. Injected by `registry` to
 *  avoid a circular import. */
export type GoverningConfig = () => {
    config?: ResolvedMemory;
    agent: string;
};
export declare function ensureMemoryMethods(resolve: GoverningConfig): void;
//# sourceMappingURL=memory-methods.d.ts.map