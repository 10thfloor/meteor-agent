import type { AgentMessage, AgentSession } from '../common/types';
/** The seq a fork copies up to, clamped to the nearest batch-safe cut
 *  point (same walk compaction uses). Returns -1 when nothing may be
 *  copied. When the walk moves, trailing notes are dropped — the fork
 *  may re-compact once, but its view always agrees with its rows. */
export declare function findForkCut(msgs: AgentMessage[], atSeq?: number): number;
/** The seq a thread on the row at `anchorSeq` copies up to: the smallest
 *  batch-safe cut that still includes the anchor, walking FORWARD to the end
 *  of its tool batch (a fork walks back). Null while that batch is open. */
export declare function findThreadCut(msgs: AgentMessage[], anchorSeq: number): number | null;
/** Short default title for a thread, from its first message. */
export declare function threadTitle(anchor: Pick<AgentMessage, 'content'>): string;
/** Branch a session at a batch-safe cut and return the new session id.
 *  Source assumed authorized. A fork is a new root: no parent/depth,
 *  no lease/phase/pending, zero usage — only transcript + roster.
 *  With `thread`, the cut includes that message (see `findThreadCut`) and
 *  the new session records it as its thread anchor. */
export declare function forkSession(source: AgentSession, opts?: {
    atSeq?: number;
    title?: string;
    thread?: {
        messageId: string;
    };
}): Promise<string>;
/** Resolve, authorize, and fork. `userId` in opts scopes the lookup
 *  (fails closed); absent = unscoped server call. */
export declare function forkSessionById(agent: string, sessionId: string, opts?: {
    atSeq?: number;
    title?: string;
    userId?: string | null;
}): Promise<string>;
//# sourceMappingURL=fork.d.ts.map