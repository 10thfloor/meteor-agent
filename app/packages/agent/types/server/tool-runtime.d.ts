import type { AgentSession, ResolvedMemory } from '../common/types';
import { type Skill, type ToolSpec } from './tools';
export interface PrepareToolRuntimeOptions {
    specs: ToolSpec[];
    skills?: Skill[];
    /** Configured Memory and the facts that decide whether this Session may
     * expose it. Presence protects the reserved names even for an ineligible
     * child/throwaway Session. */
    memory?: {
        config: ResolvedMemory;
        session: Pick<AgentSession, 'parent' | 'ephemeral' | 'userId'>;
        agent: string;
    };
}
//# sourceMappingURL=tool-runtime.d.ts.map