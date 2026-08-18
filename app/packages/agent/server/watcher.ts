import { AgentMessages, AgentSessions } from '../common/collections';
import { ACTIVE_PHASES, type AgentSession, type Phase } from '../common/types';
import { getAgent } from './registry';
import { deferTurn, recordTimeoutVerdict } from './methods';
import { isRunning } from './loop';

/**
 * §4.3. Recovery with nobody present.
 *
 * Every other entry point into a turn needs a person: a send, an approve, a
 * deny. That leaves four states no user action will ever clear —
 *
 *   1. An ORPHAN: a session parked in an active phase whose owner died. The
 *      lease expires and nothing notices, because noticing was the dead
 *      process's job.
 *   2. A TIMED-OUT APPROVAL: a `gate: 'ask'` request nobody will answer. The
 *      park holds no process and runs no timer by design, so there is nothing
 *      in-turn left to enforce `budget.approval`.
 *   3. A DROPPED WAKE: a verdict recorded, and the resume it deferred died
 *      before consuming it. The loop's own wind-down self-check closes the
 *      window it can see; a process that dies inside that window leaves the
 *      verdict standing forever.
 *
 *   4. An ORPHANED CHILD: a subagent session whose parent transcript never got
 *      the tool row that names it. The dispatch died between creating the child
 *      and committing its result, so the child is real, finished (or claimable
 *      by case 1) and reachable from NOTHING a client can see. Unlike the other
 *      three there is no turn to resume here — the repair is a pointer.
 *
 * For 1–3 this module NOTICES and CALLS the machinery that already handles
 * them — `runTurn` (via `deferTurn`, so a recovered turn runs with exactly the
 * config a user-initiated one would) and `recordTimeoutVerdict` (via the same
 * single-winner conditional write a human verdict goes through). It contains no
 * repair logic, no lease logic and no verdict logic of its own: `claimLease` and
 * repair-on-entry are what make a recovered turn safe, and duplicating either
 * here would give the fleet two implementations of the thing that must be
 * exactly one. Case 4 is the one exception, and only because there is nothing to
 * delegate to: no other caller writes an `orphan-child` note, and the write
 * itself is one transcript row through the same atomic-seq idiom `writeVerdict`
 * uses for its own.
 *
 * Multi-server safety needs no new coordination for the same reason. Two servers
 * racing on one orphan resolve through `claimLease` (one wins, the loser's
 * `runTurn` returns without writing); racing on one timeout resolve through the
 * verdict's conditional write (one wins, the loser gets a quiet false); racing
 * on one orphaned child resolve through the note's DERIVED `_id` (one wins, the
 * loser's insert is a duplicate key it swallows).
 */

/** Phases in which a turn is supposed to be RUNNING. A session sitting in one of
 *  these with no live lease is, by definition, nobody's. Defined in
 *  `common/types` and re-exported here, where it was born: subagent dispatch
 *  needs the same list to tell a mid-run child from a settled one. */
export { ACTIVE_PHASES };

/** Phases that are not the watcher's to wake, and the same list the loop's own
 *  wake self-check excludes: `awaiting` is a live question for a human,
 *  `stopped` is an interrupt that outranks any standing verdict until the next
 *  send, and `error` is a failed turn whose note is already in the transcript.
 *  The two lists disagreeing was a reviewed defect once; they must stay equal. */
const WAKE_EXCLUDED: Phase[] = ['awaiting', 'stopped', 'error'];

export interface WatcherOptions {
  /** How often the sweep runs. Default 15s; tests lower it. */
  sweepMs?: number;
  /**
   * How long a standing verdict must have gone unconsumed before the sweep
   * treats it as a DROPPED wake rather than a live one (case 3).
   *
   * Without this the sweep would race every legitimate resume: `agent.approve`
   * writes the verdict and defers the run, and for the few milliseconds before
   * that run marks itself running, the session looks exactly like a dropped
   * wake. Waking it then risks a second turn nobody asked for — a provider
   * charge and an assistant row appended to a finished turn — because the
   * legitimate resume may spend the verdict in between, leaving the woken run to
   * fall straight into the think loop.
   *
   * `updatedAt` is the clock: the verdict write sets it, and a session in this
   * state has no other writer. Default one sweep interval, floored at 1s.
   */
  verdictGraceMs?: number;
  /**
   * How old a CHILD session must be before the sweep will re-link it (case 4).
   *
   * The same reasoning as `verdictGraceMs`, against a different race. A live
   * dispatch writes the child session first and the parent's `activeChild`
   * marker second; for the width of that one write a perfectly healthy child
   * looks exactly like an abandoned one. The `activeChild` check is what
   * normally excludes a live dispatch, and this is what covers the window
   * BEFORE that marker exists.
   *
   * `createdAt` is the clock — a child's birth is the only moment that matters
   * here, and it never moves. Default one sweep interval, floored at 1s; tests
   * lower it to make a sweep observable.
   */
  relinkGraceMs?: number;
}

export interface Watcher {
  /** Tear down the observer AND the interval, awaiting whatever is in flight. */
  stop(): Promise<void>;
}

/** "No server is on this session": unleased, or leased past expiry. Mirrors
 *  `claimLease`'s own `$or` exactly — the watcher must consider claimable
 *  precisely what `claimLease` will claim, or it either skips real orphans or
 *  queues wake-ups that can only fail the claim. */
function noLiveLease(now: Date): Record<string, unknown> {
  return {
    $or: [
      { lease: { $exists: false } },
      { lease: null },
      { 'lease.until': { $lt: now } },
    ],
  };
}

/** Same predicate as `noLiveLease`, in memory, for the observer path. */
function isOrphan(session: AgentSession, now: Date): boolean {
  if (!ACTIVE_PHASES.includes(session.phase)) return false;
  const until = session.lease?.until;
  return !until || until.getTime() < now.getTime();
}

/**
 * Wake a session through the ordinary deferred-turn path.
 *
 * An unregistered agent is logged and skipped, never thrown: the sessions
 * collection outlives any given deployment's `defineAgent` calls, so a renamed
 * or retired agent is an ordinary consequence of shipping — and one such session
 * must not take down the sweep that would have recovered all the others.
 */
/** Warned-once session ids: an orphan naming a retired agent matches EVERY
 *  sweep forever (nothing can ever clear it), and a warn per sweep per
 *  session is a log flood that buries real problems. One warning per session
 *  per process is the signal; the set is process-lifetime and bounded by the
 *  number of such sessions. */
const warnedUnregistered = new Set<string>();

function warnUnregisteredOnce(session: AgentSession, why: string): void {
  if (warnedUnregistered.has(session._id)) return;
  warnedUnregistered.add(session._id);
  console.warn(
    `[10thfloor:agent] watcher: session ${session._id} names unregistered agent `
    + `"${session.agent}"; skipping ${why} (warned once per process)`,
  );
}

/** Warned-once child ids, for the same reason as `warnedUnregistered`: a child
 *  whose parent document is gone matches every sweep forever, because the sweep
 *  deliberately does not delete it. */
const warnedParentless = new Set<string>();

/**
 * A child whose PARENT SESSION no longer exists.
 *
 * Nothing in the harness produces this today and the audit trail is worth more
 * than the tidiness would be, so the sweep leaves the document exactly where it
 * is and says so once. `Agent.ask` deletes its own headless session, and it
 * cannot leave children behind: an `ask` session is a root (no `parent`), and a
 * child of it would be created and finished INSIDE the turn `ask` awaits, so
 * the delete happens after the child is already settled — the child survives,
 * pointing at a parent id that resolves to nothing. That is the one shape this
 * warning is really for. A fork does not copy `parent`, so a fork's source
 * being deleted cannot orphan anything either.
 *
 * POLICY, stated so the next reader does not have to guess: a sweep NEVER
 * deletes session data. Deciding that an unreachable child is garbage is a
 * retention question (how long, whose consent, what about its transcript), and
 * a background loop that quietly removes documents on a rule nobody configured
 * is the worst possible place to answer it. Left for v4 alongside the rest of
 * retention.
 */
function warnParentlessOnce(child: AgentSession): void {
  if (warnedParentless.has(child._id)) return;
  warnedParentless.add(child._id);
  console.warn(
    `[10thfloor:agent] watcher: child session ${child._id} names parent `
    + `${child.parent?.sessionId} which no longer exists; leaving it in place `
    + '(warned once per process)',
  );
}

function wake(session: AgentSession, why: string): void {
  const config = getAgent(session.agent);
  if (!config) {
    warnUnregisteredOnce(session, why);
    return;
  }
  deferTurn(session._id, config, session.userId);
}

/**
 * CASE 4 — children the parent transcript lost.
 *
 * THREE QUERIES for the whole sweep, not three per child. The candidate set is
 * every child session older than the grace period, which in a healthy
 * deployment is every child that ever ran — so a per-child parent lookup and a
 * per-child transcript lookup would make this the most expensive thing the
 * watcher does, forever, to discover that nothing is wrong. Batching by `$in`
 * keeps the cost proportional to sweeps rather than to history.
 *
 * REACHABILITY is the test, and one query answers it: `childSessionId` is
 * carried by exactly two kinds of row — the `role: 'tool'` result that answers
 * the dispatch, and this note — so a child named by ANY row in its parent's
 * transcript is already reachable and needs nothing. That single set gives both
 * the claimed check (a) and the idempotence check (b) at once.
 *
 * What it deliberately does NOT read is the child's phase. A child still
 * streaming under a dead server is the case that most needs a pointer (case 1
 * will finish it, and the finished transcript should be reachable when it
 * does); a settled one needs it just as much. The live-dispatch exclusion is
 * `activeChild` plus the grace period, not liveness.
 */
async function relinkOrphanChildren(cutoff: Date, isStopped: () => boolean): Promise<void> {
  const children = await AgentSessions.find(
    { 'parent.sessionId': { $exists: true }, createdAt: { $lt: cutoff } } as any,
    { fields: { agent: 1, parent: 1 } },
  ).fetchAsync();
  if (children.length === 0) return;

  const parentIds = [...new Set(children.map((c) => c.parent!.sessionId))];
  const parents = new Map(
    (await AgentSessions.find(
      { _id: { $in: parentIds } } as any, { fields: { activeChild: 1 } },
    ).fetchAsync()).map((p) => [p._id, p] as [string, AgentSession]),
  );
  const reachable = new Set(
    (await AgentMessages.find(
      {
        sessionId: { $in: parentIds },
        childSessionId: { $in: children.map((c) => c._id) },
      } as any,
      { fields: { childSessionId: 1 } },
    ).fetchAsync()).map((m) => m.childSessionId),
  );

  for (const child of children) {
    if (isStopped()) return;
    const parentId = child.parent!.sessionId;
    const parent = parents.get(parentId);
    if (!parent) { warnParentlessOnce(child); continue; }
    // A dispatch in flight: the parent will write the tool row itself when the
    // child resolves, and a note for a child that is about to be claimed is
    // noise in a transcript a person reads.
    if (parent.activeChild?.sessionId === child._id) continue;
    if (reachable.has(child._id)) continue;

    // The same atomic allocation `agent.send` and `writeVerdict` use, and for
    // the same reason: the parent may be running a turn right now (this child
    // is not that turn's business), and read-then-insert would hand this note
    // the seq the running loop is about to commit its assistant at.
    // eslint-disable-next-line no-await-in-loop
    const before = await AgentSessions.rawCollection().findOneAndUpdate(
      { _id: parentId },
      { $inc: { nextSeq: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'before' },
    );
    // The parent went away between the two reads. Next sweep warns.
    if (!before) continue;

    try {
      // DERIVED `_id`, not `Random.id()`: it is what makes "one note per child"
      // hold across SERVERS, whose sweeps cannot see each other's reachability
      // sets. The loser's insert fails on the primary key and the catch below
      // swallows it, leaving the winner's row and a skipped seq — a gap in the
      // sequence is already ordinary (`discardTurn` leaves them) and costs
      // nothing but a number.
      // eslint-disable-next-line no-await-in-loop
      await AgentMessages.insertAsync({
        _id: `orphan-child-${child._id}`,
        sessionId: parentId,
        seq: (before as any).nextSeq,
        role: 'note',
        kind: 'orphan-child',
        childSessionId: child._id,
        childAgent: child.agent,
        reason: 'recovered',
        createdAt: new Date(),
      } as any);
    } catch (e: any) {
      // 11000 is the duplicate key another server's sweep just won (matched on
      // the message too, because what wraps a driver error on the way through
      // Meteor's collection layer is not this module's to assume). Anything
      // else is a real write failure and belongs in the sweep's error handler.
      const duplicate = e?.code === 11000 || /duplicate key/i.test(String(e?.message ?? ''));
      if (!duplicate) throw e;
    }
  }
}

export function startWatcher(opts: WatcherOptions = {}): Watcher {
  const sweepMs = opts.sweepMs ?? 15_000;
  const verdictGraceMs = opts.verdictGraceMs ?? Math.max(sweepMs, 1000);
  const relinkGraceMs = opts.relinkGraceMs ?? Math.max(sweepMs, 1000);

  let stopped = false;

  /**
   * One sweep. Three queries for the three wake/timeout cases (one wake per
   * session), then case 4's three of its own.
   *
   * Cases 1 and 3 both end in the same call, and a session can match both (an
   * active phase, no lease, and a standing verdict is one document), so they are
   * unioned by `_id` first: two `deferTurn`s for one session would be two
   * `runTurn`s, and the second could start after the first finished — a turn
   * nobody asked for.
   */
  const sweep = async (): Promise<void> => {
    const now = new Date();
    const toWake = new Map<string, { session: AgentSession; why: string }>();

    // CASE 1 — orphan: an active phase with no live lease. The dead-server case.
    const orphans = await AgentSessions.find({
      phase: { $in: ACTIVE_PHASES },
      ...noLiveLease(now),
    } as any).fetchAsync();
    for (const session of orphans) {
      if (!isRunning(session._id)) toWake.set(session._id, { session, why: 'orphan claim' });
    }

    // CASE 3 — a standing verdict nobody consumed: the dropped wake. Excludes
    // the same phases the loop's own wake self-check excludes, requires no live
    // lease (a leased session is someone's business), and requires the verdict
    // to have stood longer than the grace period so a legitimate in-flight
    // resume is never raced.
    const stale = await AgentSessions.find({
      'pending.verdict': { $exists: true },
      phase: { $nin: WAKE_EXCLUDED },
      updatedAt: { $lt: new Date(now.getTime() - verdictGraceMs) },
      ...noLiveLease(now),
    } as any).fetchAsync();
    for (const session of stale) {
      if (!isRunning(session._id) && !toWake.has(session._id)) {
        toWake.set(session._id, { session, why: 'standing verdict' });
      }
    }

    for (const { session, why } of toWake.values()) {
      if (stopped) return;
      wake(session, why);
    }

    // CASE 2 — an approval nobody answered. The age limit is per AGENT
    // (`budget.approval`), so the query selects every unanswered park that
    // recorded a `requestedAt` and the limit is applied per document: one
    // indexed query beats one query per registered agent, and a session whose
    // agent sets no limit is skipped rather than defaulted — an unset timeout
    // means "wait for a human", which is the right default for a request a
    // person is expected to see.
    const parked = await AgentSessions.find({
      phase: 'awaiting',
      'pending.verdict': { $exists: false },
      'pending.requestedAt': { $exists: true },
    } as any).fetchAsync();
    for (const session of parked) {
      if (stopped) return;
      const config = getAgent(session.agent);
      if (!config) {
        warnUnregisteredOnce(session, 'approval timeout');
        continue;
      }
      const limit = config.budget?.approval;
      const requestedAt = session.pending?.requestedAt;
      if (limit === undefined || !requestedAt) continue;
      if (now.getTime() - requestedAt.getTime() < limit) continue;
      // Awaited, not deferred: the write is the single-winner point, and letting
      // two sweeps of this same process overlap on it buys nothing.
      // eslint-disable-next-line no-await-in-loop
      await recordTimeoutVerdict(session._id);
    }

    // CASE 4 — a child nothing points at. Last, and awaited: it competes with
    // nothing above (no session it touches is one the wakes above can be
    // driving) and it is the only case that writes a transcript row of its own.
    if (stopped) return;
    await relinkOrphanChildren(new Date(now.getTime() - relinkGraceMs), () => stopped);
  };

  /** In-flight sweep, so `stop()` can await it. A sweep that outlives its
   *  watcher would wake sessions a test has already torn down. */
  let sweeping: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || sweeping) return;   // never overlap: a slow sweep skips a tick
    sweeping = sweep()
      .catch((e) => {
        // A sweep is a background loop: one bad document must not stop the next
        // tick, and an unhandled rejection is fatal by default on Node >= 15.
        console.error('[10thfloor:agent] watcher sweep failed:', e);
      })
      .then(() => { sweeping = null; });
  };

  const timer = setInterval(runSweep, sweepMs);

  /**
   * The observer: the braces to the sweep's belt.
   *
   * It catches the transitions a document change makes visible — a lease
   * released without the phase leaving an active one, a session entering an
   * active phase already unleased — within milliseconds instead of within a
   * sweep interval, and its INITIAL `added` pass is what recovers every orphan
   * left behind by the crash this process just restarted from.
   *
   * What it cannot catch is a lease that simply EXPIRES: no write happens, so
   * there is nothing to observe. That is the sweep's whole reason for existing,
   * and why neither half is redundant.
   *
   * The projection is not decoration: without it every `nextSeq`/`usage` bump
   * during a healthy turn would fire `changed`, and the re-read below with it.
   */
  let handle: { stop(): void } | null = null;
  /** Considers are serialized through one chain rather than fired in parallel:
   *  ordering matters little, but `stop()` needs one thing to await. */
  let chain: Promise<void> = Promise.resolve();

  const consider = async (sessionId: string): Promise<void> => {
    if (stopped) return;
    // A single indexed read per notification. The observer's own fields would
    // save it, but `changed` carries only the fields that changed, so deciding
    // orphanhood from them means reconstructing the document — and getting that
    // wrong means either missing orphans or claiming live sessions.
    const session = await AgentSessions.findOneAsync(sessionId);
    if (!session || stopped) return;
    if (!isOrphan(session, new Date())) return;
    if (isRunning(sessionId)) return;
    wake(session, 'orphan claim');
  };

  const notice = (sessionId: string): void => {
    chain = chain.then(() => consider(sessionId)).catch((e) => {
      console.error(`[10thfloor:agent] watcher: orphan check failed for ${sessionId}:`, e);
    });
  };

  const observing = AgentSessions.find(
    { phase: { $in: ACTIVE_PHASES } } as any,
    { fields: { agent: 1, userId: 1, phase: 1, lease: 1 } },
  ).observeChangesAsync({
    added(id: string) { notice(id); },
    changed(id: string) { notice(id); },
  }).then((h: any) => {
    // `stop()` can win the race against a still-resolving observe. Stopping the
    // handle the moment it exists is what keeps a torn-down watcher from
    // holding a live query forever — a leaked observer poisons every later test
    // and, in production, every later deploy.
    handle = h;
    if (stopped) h.stop();
    return undefined;
  }).catch((e: unknown) => {
    console.error('[10thfloor:agent] watcher: could not observe sessions:', e);
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await observing;
      if (handle) { handle.stop(); handle = null; }
      await chain;
      if (sweeping) await sweeping;
    },
  };
}
