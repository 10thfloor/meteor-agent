import type { AgentMemoryFrame, ExperienceAudience, ResolvedExperience, ResolvedPractice } from '../common/learning';
import { type ResolvedTool, type ToolSpec } from './tools';
export declare const EXPERIENCE_PROPOSE_TOOL_NAME: 'experience_propose';
export declare const EXPERIENCE_SEARCH_TOOL_NAME: 'experience_search';
export declare const PRACTICE_PROPOSE_TOOL_NAME: 'practice_propose';
export declare const LEARNING_TOOL_NAMES: readonly ["experience_propose", "experience_search", "practice_propose"];
/** Reserve Learning names against app-authored Tools at Agent.define time. */
export declare function assertLearningNamesFree(tools?: ToolSpec[]): void;
export interface LearningToolOptions {
    /** Current config is only a legacy-Frame fallback; new Frames freeze policy. */
    config?: ResolvedExperience;
    practice?: ResolvedPractice;
    /** Stable Identity id, closed over by Tools and never supplied by the model. */
    agentId: string;
    /** Frozen Turn frame. Required for proposing and constrains recall when present. */
    frame?: AgentMemoryFrame;
    /** Required for recall built outside a Frame; ignored only when exactly equal to Frame audience. */
    audience?: ExperienceAudience;
}
/** Build only the Tools enabled by the settled Experience config and current frame. */
export declare function buildLearningTools(opts: LearningToolOptions): ResolvedTool[];
/** Append Learning Tools. Authored collisions are configuration errors. */
export declare function withLearningTools(tools: ResolvedTool[], opts?: LearningToolOptions): ResolvedTool[];
//# sourceMappingURL=learning-tools.d.ts.map