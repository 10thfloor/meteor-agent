import type { AgentSession, ResolvedMemory } from '../common/types';
import type { AgentMemoryFrame, ExperienceAudience, ResolvedExperience, ResolvedPractice } from '../common/learning';
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
    /** Stable identity-bound Experience Tools. Presence reserves their names;
     * the Frame closes proposal provenance and frozen recall. */
    learning?: {
        config?: ResolvedExperience;
        practice?: ResolvedPractice;
        agentId: string;
        frame?: AgentMemoryFrame;
        /** Required when constructing recall outside a frozen Turn Frame. */
        audience?: ExperienceAudience;
    };
    /** Reserve framework-owned Experience Tool names when a caller intentionally
     * prepares a runtime without a Learning snapshot. Identity-enabled
     * `Agent.ask()` Turns supply their throwaway Frame and enabled Learning Tools. */
    reserveLearningNames?: boolean;
}
//# sourceMappingURL=tool-runtime.d.ts.map