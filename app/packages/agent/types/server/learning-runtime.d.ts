import type { AgentSession, ResolvedMemory } from '../common/types';
import type { ExperienceAudience, ExperienceScope, IdentityConfig, ResolvedExperience, ResolvedPractice } from '../common/learning';
import { freezeMemoryFrame } from './learning';
/** The small Turn-facing Interface to the deeper Learning Modules. A Turn
 * receives one immutable Frame plus the exact Fact Memory bytes proven against
 * that Frame; it does not know how Identity, Practice, or Experience are stored. */
export interface TurnLearningSnapshot {
    agentId: string;
    memoryFrameId: string;
    triggerSeq: number;
    frame: Awaited<ReturnType<typeof freezeMemoryFrame>>['value'];
    protectedSystem: string;
    factMemoryText: string;
}
export interface PrepareTurnLearningOptions {
    session: AgentSession;
    agentName: string;
    identity: IdentityConfig;
    experience?: ResolvedExperience;
    practice?: ResolvedPractice;
    factMemory?: ResolvedMemory;
}
/** Resolve a config scope to one immutable Turn audience. Owner scope never
 * persists an empty/anonymous owner key; anonymous owners are Session-local. */
export declare function resolveTurnExperienceAudience(agentId: string, session: Pick<AgentSession, '_id' | 'userId'>, scope: ExperienceScope): ExperienceAudience;
/** Fail-closed: the frozen causes themselves were edited or erased. The park
 *  (if any) is destroyed — resuming would mix causal snapshots. */
export declare class LearningIntegrityError extends Error {
}
/** Retryable: the store could not be read. The park and its recorded verdict
 *  are the repairable state and MUST survive; activation retries the resume. */
export declare class LearningUnavailableError extends Error {
    readonly transient = true;
}
/** Freeze or adopt one Agent/Session/trigger Frame before paid Provider work.
 * Existing Frames win over mutable current state. Fact prompt bytes are not
 * duplicated durably for privacy; recovery therefore re-renders and verifies
 * their digest/evidence, failing closed if the source facts changed. */
export declare function prepareTurnLearning(options: PrepareTurnLearningOptions): Promise<TurnLearningSnapshot | undefined>;
//# sourceMappingURL=learning-runtime.d.ts.map