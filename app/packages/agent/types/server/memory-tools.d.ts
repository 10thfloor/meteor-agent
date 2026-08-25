import type { ResolvedMemory } from '../common/types';
import { type ResolvedTool } from './tools';
export interface MemoryToolOptions {
    config: ResolvedMemory;
    /** The SESSION's owner. Anonymous sessions cannot write any scope, so the
     *  tools must not advertise one — offering `'app'` there parked the turn on
     *  an approval, rendered the model's text into the approval surface, and
     *  only then answered `no-account`. The block is already honest with the
     *  model about this; the tool schema should be too. */
    userId?: string | null;
    /** The RUNNING model's participant id (`m:<agent>`) — the `by` stamp. Never
     *  the speaking human's: the member's id lives on the message `from` and
     *  does not reach a tool body (spec decision 14). */
    by: string;
    /** The running agent's registry name — scopes `agent`-scope rows. */
    agent: string;
}
/**
 * Append the three memory tools to an agent's expanded tool list.
 *
 * Called AFTER `expandMcpTools` and beside `withSkillTool`, with the same
 * collision policy: an app tool of the same name WINS and the built-in is
 * skipped, with one warning. The app's tool is something it deliberately
 * defined and may already call from a UI; silently overriding it would be the
 * worse surprise. (Define-time reservation catches the common case earlier;
 * this covers a name arriving from a whole-server MCP spec, which is not
 * knowable until expansion.)
 */
export declare function withMemoryTools(tools: ResolvedTool[], opts?: MemoryToolOptions): ResolvedTool[];
//# sourceMappingURL=memory-tools.d.ts.map