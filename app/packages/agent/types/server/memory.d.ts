import { type AgentMemory, type MemoryScope, type ResolvedMemory } from '../common/types';
/** The `$or` over every scope this agent may read. Null when nothing is
 *  readable (an anonymous session whose config lists only person scopes). */
export declare function readSelector(scopes: MemoryScope[], userId: string | null, agent: string): {
    $or: Array<Record<string, unknown>>;
} | null;
/** Is this row one the caller may actually see? The predicate form of
 *  `readSelector`, for filtering rows this module did not fetch itself. */
export declare function inScope(row: AgentMemory, scopes: MemoryScope[], userId: string | null, agent: string): boolean;
export interface ListedMemories {
    person: AgentMemory[];
    work: AgentMemory[];
    personTotal: number;
    workTotal: number;
}
/** Standing block read: pinned first, then most-recent, split into person
 *  and work sections. Direct `findAsync` (not the search ladder) so saves
 *  are visible immediately. Overflow pins do not consume recent slots. */
export declare function listForBlock(userId: string | null, agent: string, config: ResolvedMemory): Promise<ListedMemories>;
export type SearchRung = 'installed' | 'vector' | 'text' | 'regex';
/** TEST SEAM: replaces the vector rung. Returns a restore fn; resets probe
 *  cache and warn latch so suites sharing one process stay independent. */
export declare function _setMemorySearch(fn: ((sel: Record<string, unknown>, query: string, limit: number) => Promise<AgentMemory[]>) | null): () => void;
/** The active rung, for tests and diagnostics. */
export declare function _activeRung(): SearchRung | null;
/** TEST SEAM: force the regex rung by disabling vector and text.
 *  Returns a restore fn. */
export declare function _forceRegexRung(): () => void;
/** Recall down the ladder: installed fn -> $vectorSearch -> $text -> regex.
 *  Every rung failure degrades rather than throws — a thin answer beats
 *  killing the turn over a database capability nobody chose. */
export declare function searchMemory(query: string, opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
    limit?: number;
}): Promise<AgentMemory[]>;
export interface SaveArgs {
    text: string;
    scope?: MemoryScope;
    key?: string;
    pinned?: boolean;
}
export type SaveResult = {
    ok: true;
    id: string;
    updated: boolean;
} | {
    ok: false;
    error: string;
    reason: string;
};
/** Save one fact. Returns structured refusals (not throws) so the model can
 *  route around rule violations. `key` is the upsert identity — same key +
 *  scope = one row, making crash-recovery re-runs idempotent. */
export declare function saveMemory(args: SaveArgs, opts: {
    by: string;
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
}): Promise<SaveResult>;
export type ForgetResult = {
    ok: true;
    forgotten: boolean;
} | {
    ok: false;
    error: string;
    reason: string;
};
/** Forget one fact by id. `allowApp` gates shared-pool deletion: DDP passes
 *  false (approval-guarded knowledge), the model's tool passes true. */
export declare function forgetMemory(id: string, opts: {
    userId: string | null;
    agent: string;
    allowApp: boolean;
}): Promise<ForgetResult>;
/** Harness-run hint search — returns titles only so a bad match costs one
 *  line, not a poisoned turn. Threshold-gated by `minScore` where the rung
 *  reports one; text/regex rungs contribute top hits ungated. */
export declare function memoryHint(query: string, opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
}): Promise<string[]>;
export interface MemoryHintSnapshot {
    titles: string[];
    /** Exact source rows represented by the titles. A Memory Frame records
     * these alongside standing-block rows so hint evidence is not invisible. */
    rows: AgentMemory[];
}
/** Hint text and its evidence in one read. The legacy `memoryHint` Interface
 * remains a title-only convenience wrapper. */
export declare function memoryHintSnapshot(query: string, opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
}): Promise<MemoryHintSnapshot>;
export interface MemoryBlockSnapshot {
    /** Exact frozen Fact Memory prompt fragment. */
    text: string;
    /** Exact rows represented by the standing listing. Hint-only search hits are
     * intentionally not included because the hint carries titles, not row ids. */
    rows: AgentMemory[];
}
/** Read and render Fact Memory once so an Agent Experience Memory Frame can
 * freeze both the prompt bytes and their durable evidence ids for a Turn. */
export declare function memoryBlockSnapshot(opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
    /** Titles from the turn's cached hint, already computed. */
    hint?: string[];
}): Promise<MemoryBlockSnapshot>;
/** Render the memory block for the system prompt. Returns `''` when empty. */
export declare function memoryBlock(opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
    hint?: string[];
}): Promise<string>;
//# sourceMappingURL=memory.d.ts.map