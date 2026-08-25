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
/**
 * The standing block's read (spec §6): pinned first, then most-recent, split
 * into the person and work sections so neither can crowd the other out.
 *
 * A DIRECT `findAsync`, never the search ladder — that is what makes a fact
 * saved this turn visible in the next iteration's block and in a colleague's
 * next turn, without waiting on mongot's change stream to index it.
 *
 * Overflow pinned rows do NOT consume recent slots: the caps are per-section
 * and the totals below tell the model more exist.
 */
export declare function listForBlock(userId: string | null, agent: string, config: ResolvedMemory): Promise<ListedMemories>;
export type SearchRung = 'installed' | 'vector' | 'text' | 'regex';
/** TEST SEAM, not public API: replaces the vector rung so a suite can drive
 *  the ladder without a mongot. Returns a restore fn, and resets the probe
 *  cache and the warn latch — `tests/server.ts` runs every suite in one
 *  process, so a latch armed by one test would silence the next. */
export declare function _setMemorySearch(fn: ((sel: Record<string, unknown>, query: string, limit: number) => Promise<AgentMemory[]>) | null): () => void;
/** The active rung, for tests and diagnostics. */
export declare function _activeRung(): SearchRung | null;
/** TEST SEAM, not public API: force the FLOOR rung by declaring the two rungs
 *  above it unavailable. Without this a suite cannot reach `regexSearch` at
 *  all — the text index exists in the test database, so the text rung answers
 *  first and the escaping the hint path depends on goes unexercised. Returns
 *  a restore fn. */
export declare function _forceRegexRung(): () => void;
/**
 * Recall, down the ladder: installed fn → `$vectorSearch` → `$text` → regex.
 *
 * Every rung failure DEGRADES rather than throws. A search that takes the turn
 * down is worse than a search that returns less: the model can route around a
 * thin answer, but a thrown error inside the hint path kills a conversation
 * over a database capability nobody chose.
 */
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
/**
 * Remember one fact.
 *
 * Structured refusals rather than throws for every rule the MODEL can trip
 * (too long, unknown scope, scope not enabled, no account, pool full): a
 * refusal the model can read is a refusal it can route around, where a throw
 * spends a turn on an error note.
 *
 * `key` is the deliberate-upsert identity: two saves with the same key over
 * the same scope resolve to ONE row. That is what makes a crash-recovery
 * re-run of the tool idempotent — the participants spec's thread-key lesson,
 * applied to a store the model writes.
 */
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
/**
 * Forget one fact, by id.
 *
 * `allowApp` is the decision-7a knob: the DDP surface passes `false`, because
 * shared work knowledge arrived through an approval and must not be deletable
 * by any signed-in client. The model's tool passes `true` — its call went
 * through the same gate its save did.
 */
export declare function forgetMemory(id: string, opts: {
    userId: string | null;
    agent: string;
    allowApp: boolean;
}): Promise<ForgetResult>;
/**
 * The hint's search (spec §10): mechanical, harness-run, never a model call.
 *
 * Returns TITLES ONLY. Content never enters context this way — the model must
 * still call `memory_search` — so a bad match costs one line, not a poisoned
 * turn. Threshold-gated by `minScore` where the rung reports one; the regex
 * and text rungs have no comparable score, so they contribute their top hits
 * and the cap does the limiting.
 */
export declare function memoryHint(query: string, opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
}): Promise<string[]>;
/**
 * Render the memory block appended to the system prompt.
 *
 * Returns `''` when there is nothing to say — an empty block is a section
 * header the model must read on every call that can only ever mean "no".
 */
export declare function memoryBlock(opts: {
    userId: string | null;
    agent: string;
    config: ResolvedMemory;
    /** Titles from the turn's cached hint, already computed. */
    hint?: string[];
}): Promise<string>;
//# sourceMappingURL=memory.d.ts.map