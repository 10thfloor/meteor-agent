import type { AgentMessage, AgentSession } from '../common/types';
/**
 * The seq a fork copies UP TO, inclusive — `atSeq` clamped DOWN to the nearest
 * batch-safe cut point. Returns -1 when nothing may be copied at all.
 *
 * A fork point is not a free choice. Copying an assistant's `tool_use` without
 * the `tool_result` that answered it produces a transcript every provider
 * rejects with a 400, forever, and the fork would be born broken with no repair
 * path (repair-on-entry deletes stranded turns, so the fork would silently
 * lose its last exchange on first run). So the requested point is walked back
 * with `batchSafeBoundary` — the SAME walk compaction uses to keep a summarized
 * head from stranding a kept tail. Two operations, one definition of "a legal
 * place to divide a transcript".
 *
 * Notes ride along with the target rather than with the walk: they are
 * transcript bookkeeping (`compaction`, `approval`, `error`, `budget`) that no
 * provider ever sees, so they can never strand a tool call — and a compaction
 * note at-or-before the cut MUST be copied or the fork's model view silently
 * expands back to the full uncompacted history. Hence the boundary walk runs
 * over the note-free list, while the returned cut is the requested `atSeq`
 * itself whenever the walk did not have to move.
 *
 * WHEN THE WALK DOES MOVE, trailing notes are DROPPED: the cut becomes the last
 * non-note message still in the head, so a note sitting between that message and
 * the requested `atSeq` is not copied — including a `compaction` note. That is a
 * deliberate choice, not an oversight, and the consequence is COST ONLY:
 *
 *   - correctness is unaffected. Dropping a compaction note can only WIDEN the
 *     fork's model view (it falls back to an earlier note, or to the raw
 *     transcript), and every row that view then covers is a row the fork
 *     actually holds. It can never point at rows the fork excluded.
 *   - the price is that the fork's first turn may re-summarize history its
 *     parent had already summarized — one extra compaction call, once.
 *
 * The alternative — copying a note whose `upto` sits past the cut — buys nothing
 * and costs clarity: `assembleContext` starts the view AT `upto`, so the fork
 * would render as the summary alone, describing an exchange its own transcript
 * does not contain. A cheap, self-correcting re-compaction beats a view that
 * disagrees with the rows underneath it. `fork.test.ts` pins this behaviour.
 */
export declare function findForkCut(msgs: AgentMessage[], atSeq?: number): number;
/**
 * Branch a session at a batch-safe cut point and return the NEW session's id.
 *
 * The source is assumed already authorized — `agent.fork` runs `requireSession`
 * and `Agent.fork` does its own scoped lookup — so this takes the source
 * DOCUMENT, not an id, and never re-decides who may call it.
 *
 * What a fork carries: the transcript up to the cut (new `_id`s, original
 * `seq`s, every other field verbatim), the agent, the owner, and the model the
 * source was running. What it does NOT carry, and why:
 *
 *   - `parent` / `depth` — a fork is a new ROOT conversation. Copying `parent`
 *     would make the user's own fork invisible in `agent.sessions` (children
 *     are excluded there on purpose); copying `depth` would charge a root
 *     conversation for subagent hops it never took. The lineage a fork does
 *     have lives in `forkedFrom`, which is a different relationship — see the
 *     field's comment in common/types.ts.
 *   - `activeChild` — a live-dispatch marker for a subagent running RIGHT NOW
 *     under the source's lease. It describes a run, not a transcript.
 *   - `pending` — an approval request belongs to the turn that parked it, and
 *     that turn is not in the fork: `findForkCut` walks the cut back past an
 *     unanswered batch, so the parked assistant is never copied in the first
 *     place. Copying the marker would leave the fork `awaiting` a
 *     `toolCallId` no message in it mentions, answerable by nobody.
 *   - `lease` / `phase` — a fork is idle and owned by no server until it runs.
 *   - `usage` / `budgetSpent` — ZEROS. A fork has spent nothing; it costs from
 *     the moment it runs, not from its parent's history.
 */
export declare function forkSession(source: AgentSession, opts?: {
    atSeq?: number;
    title?: string;
}): Promise<string>;
/**
 * `Agent.fork`'s lookup half: resolve and authorize the source session, then
 * fork it.
 *
 * `userId` present (including `null`, which is the anonymous capability-URL
 * owner) SCOPES the lookup, so a server-side caller acting for a user cannot
 * reach someone else's session; absent, the fork runs as a direct server call
 * and the source's own owner is used. Either way the fork inherits
 * `source.userId` — a fork never changes hands.
 *
 * The test is `'userId' in opts`, not `!== undefined`: a key the caller wrote
 * always scopes, even when the value it carried turned out to be undefined.
 * That direction fails CLOSED (the lookup finds nothing) instead of silently
 * promoting a caller's missing user into an unscoped server call.
 */
export declare function forkSessionById(agent: string, sessionId: string, opts?: {
    atSeq?: number;
    title?: string;
    userId?: string | null;
}): Promise<string>;
//# sourceMappingURL=fork.d.ts.map