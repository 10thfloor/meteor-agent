import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, AgentSession } from '../common/types';
import type { SessionQuery } from '../common/db';
import { batchSafeBoundary } from './transcript';

/** How many copied message documents go in one `insertMany`. Big enough that a
 *  long transcript costs a handful of round trips, small enough that one
 *  command stays well under Mongo's 16MB/100k-op limits even with 8000-char
 *  tool results (§5.2's `maxResultChars`). */
const COPY_CHUNK = 500;

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
export function findForkCut(msgs: AgentMessage[], atSeq?: number): number {
  const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : -1;
  // Default: the whole transcript. A caller's `atSeq` past the end is clamped
  // to it rather than refused — "fork everything" is what they asked for.
  const target = Math.min(atSeq ?? lastSeq, lastSeq);
  if (target < 0) return -1;

  const eligible = msgs.filter((m) => m.role !== 'note');
  // Index of the first non-note message NOT in the head.
  const firstExcluded = eligible.findIndex((m) => m.seq > target);
  const boundary = firstExcluded === -1 ? eligible.length : firstExcluded;

  const safe = batchSafeBoundary(eligible, boundary);
  // The walk did not move: `atSeq` was already a legal cut, so keep it exactly
  // — including any notes between the last real message and it.
  if (safe === boundary) return target;
  // It moved: the cut is the last non-note message still in the head. Anything
  // after it (notes included) belongs to the batch we just walked out of.
  return safe > 0 ? eligible[safe - 1].seq : -1;
}

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
export async function forkSession(
  source: AgentSession,
  opts?: { atSeq?: number; title?: string },
): Promise<string> {
  const msgs = await AgentMessages
    .find({ sessionId: source._id }, { sort: { seq: 1 } }).fetchAsync();
  const cut = findForkCut(msgs, opts?.atSeq);
  const copied = msgs.filter((m) => m.seq <= cut);

  const forkId = Random.id();
  const docs = copied.map((m) => ({
    ...m,
    // A NEW identity in the same collection, but the SAME seq: the transcript
    // is the source's history verbatim, so its ordering — and every `upto` a
    // compaction note carries — has to keep meaning what it meant.
    //
    // `childSessionId` on a copied tool row is deliberately left pointing at
    // the source's child session. That child is finished history shared by
    // both transcripts, owned by the same user; re-running it to give the fork
    // a private copy would repeat every side effect the child had.
    _id: Random.id(),
    sessionId: forkId,
  }));

  // CHUNKED insertMany on the raw collection, not `insertAsync` per message.
  // A fork of a 10k-message session is 10k round trips the naive way, inside a
  // method the caller is waiting on. The tradeoff is that a raw insert skips
  // Meteor's document transforms and any collection hooks — this package
  // defines none, and these documents were read out of this very collection a
  // few lines above, so there is nothing left for a hook to normalize. If a
  // hook is ever added here, this is the call site that must learn about it.
  for (let i = 0; i < docs.length; i += COPY_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    await AgentMessages.rawCollection().insertMany(
      docs.slice(i, i + COPY_CHUNK),
      { ordered: true },
    );
  }

  try {
    await AgentSessions.insertAsync({
      _id: forkId,
      agent: source.agent,
      userId: source.userId,
      title: opts?.title ?? `Fork of ${source.title || source._id}`,
      phase: 'idle',
      // The model the SOURCE was running, not the registry's current one: the
      // session's `model` field is a record of what produced this transcript.
      // What the fork's next turn actually calls comes from the registry at run
      // time (`buildRunConfig`), exactly as it does for any other session.
      model: source.model,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      // Copied messages keep their seqs, so the next allocation continues the
      // source's numbering from the cut. `cut` is simply the MAX copied seq, so
      // `cut + 1` is the next free one — and -1 + 1 = 0 is the right answer for
      // a fork that copied nothing.
      //
      // It is NOT the number of messages copied. Seqs are allocated
      // monotonically but are not contiguous: `discardTurn` deletes rows and
      // leaves their seqs behind, so a transcript routinely has gaps and a fork
      // of it holds fewer documents than `cut + 1`. Only the "next free seq"
      // reading is load-bearing here.
      nextSeq: cut + 1,
      forkedFrom: { sessionId: source._id, seq: cut },
      // The ROSTER travels with the transcript it can read (participants spec
      // decision 20): a member who forks gets a session they can still open,
      // and every other member keeps standing in the copy. `relay` and
      // `pendingRelay` do NOT copy — a fork is idle, and a relay is a live
      // wake belonging to the source's own turn.
      ...(source.participants?.length ? { participants: source.participants } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e) {
    // The session document is written LAST so nothing can observe a
    // half-copied transcript: with no session there is no publication
    // (`agent.session` authorizes through the session document) and no method
    // (`requireSession` finds nothing), so the copied rows are unreachable
    // rather than visibly corrupt. If the session insert fails they are also
    // garbage, so take them with it.
    await AgentMessages.removeAsync({ sessionId: forkId }).catch(() => {});
    throw e;
  }

  return forkId;
}

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
export async function forkSessionById(
  agent: string,
  sessionId: string,
  opts?: { atSeq?: number; title?: string; userId?: string | null },
): Promise<string> {
  const selector: SessionQuery = { _id: sessionId, agent };
  if (opts && 'userId' in opts) {
    // The same membership widening `requireSession` grew (participants spec
    // §4.2): a signed-in roster MEMBER may fork; the null clause stays the
    // owner's alone.
    const uid = opts.userId ?? null;
    selector.$or = [
      { userId: uid },
      ...(uid !== null
        ? [{ participants: { $elemMatch: { kind: 'human', userId: uid } } }]
        : []),
    ];
  }
  const source = await AgentSessions.findOneAsync(selector);
  if (!source) throw new Meteor.Error('no-session', 'Session not found');
  return forkSession(source, opts);
}
