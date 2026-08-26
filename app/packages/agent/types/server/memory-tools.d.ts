import type { ResolvedMemory } from '../common/types';
import { type ResolvedTool } from './tools';
export interface MemoryToolOptions {
    config: ResolvedMemory;
    /** Session owner. Null = anonymous (app scope not offered). */
    userId?: string | null;
    /** Running model's participant id (`m:<agent>`) — the `by` stamp. */
    by: string;
    /** Agent registry name — scopes `agent`-scope rows. */
    agent: string;
}
/** Append memory tools. Same-name app tool wins (skipped with a warning). */
export declare function withMemoryTools(tools: ResolvedTool[], opts?: MemoryToolOptions): ResolvedTool[];
//# sourceMappingURL=memory-tools.d.ts.map