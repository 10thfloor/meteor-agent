import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { NAMES } from '../common/names';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
import { mergeView } from '../common/merge';
import type { Phase, ViewMessage } from '../common/types';
import type { SessionQuery } from '../common/db';

/**
 * Client-side handle on one agent.
 *
 * Server-backed reads below use minimongo's SYNCHRONOUS API on purpose: the
 * async-only rule this package follows is a server rule (a Meteor 3 server
 * collection call must not block the event loop). On the client `find`,
 * `findOne`, `fetch`, `upsert` and `remove` are the idiomatic — and reactive —
 * calls.
 */
export class Agent {
  /** Client-only collection holding the merged view. */
  private view = new Mongo.Collection<ViewMessage>(null);
  private computation: Tracker.Computation | null = null;
  /** The handle from the LAST `subscribe()`, retained so `stop()` has something
   *  to stop. `Meteor.subscribe` outside a reactive computation is never
   *  cleaned up for you — returning the handle and keeping no reference to it
   *  was the leak. */
  private handle: Meteor.SubscriptionHandle | null = null;
  /** Which session `subscribe()` last opened — the identity `stop(sessionId)`
   *  checks itself against. */
  private watching: string | null = null;

  constructor(public readonly name: string) {}

  subscribe(sessionId: string) {
    // One Agent instance watches one session, so a re-subscribe REPLACES:
    // stopping the previous handle here is the other half of the leak fix,
    // since `startMerging` already replaces the computation and the old
    // subscription would otherwise keep shipping a session nothing renders.
    if (this.handle) this.handle.stop();
    this.handle = Meteor.subscribe(NAMES.pubSession, this.name, sessionId);
    this.watching = sessionId;
    this.startMerging(sessionId);
    return this.handle;
  }

  /**
   * Tear down everything `subscribe()` started: the merge computation, the
   * subscription, and the merged view it maintained.
   *
   * Call it from a component's unmount — `useEffect(() => () =>
   * agent.stop(sessionId), [sessionId])`. A `Tracker.autorun` created outside a
   * parent computation and a `Meteor.subscribe` called outside one both live
   * until stopped explicitly; without this, navigating away from a chat leaves
   * an autorun recomputing on every delta of a session nobody is looking at,
   * and a subscription still shipping them over DDP.
   *
   * Idempotent, because unmount paths double-fire (React 18 StrictMode mounts,
   * unmounts and remounts every effect in development): the second call finds
   * both handles already null and does nothing.
   *
   * `sessionId` is an optional GUARD, not a selector — this instance only ever
   * holds one session. Pass it and the teardown happens only if that session is
   * still the one being watched, so a stale unmount cleanup arriving AFTER a
   * re-subscribe to a newer session (React runs the old effect's cleanup after
   * the new render in some orderings) cannot tear down the live subscription.
   *
   * `subscribe()` afterwards works exactly as the first time: nothing here is
   * one-way.
   */
  stop(sessionId?: string): void {
    if (sessionId !== undefined && this.watching !== null && sessionId !== this.watching) return;

    if (this.computation) {
      this.computation.stop();
      this.computation = null;
    }
    if (this.handle) {
      this.handle.stop();
      this.handle = null;
    }
    this.watching = null;
    // The view is a client-only mirror of a subscription that no longer
    // exists. Leaving its rows behind would let `messages()` keep serving a
    // transcript the component already tore down — and the merge computation
    // that used to evict them is stopped.
    this.view.remove({});
  }

  /**
   * Keep `view` equal to mergeView(committed, deltas) for ONE session.
   *
   * The sweep is over the whole view, not over `{ sessionId }`: re-subscribing
   * to a different session must evict the previous session's rows rather than
   * leave them behind for `messages()` to serve. One Agent instance therefore
   * shows one session at a time — construct a second Agent to watch two.
   */
  private startMerging(sessionId: string) {
    if (this.computation) this.computation.stop();
    this.computation = Tracker.autorun(() => {
      const committed = AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetch();
      const deltas = AgentDeltas.find({ sessionId }).fetch();
      const merged = mergeView(committed, deltas);

      // Writes are nonreactive so this computation depends only on what it
      // READS (messages + deltas), never on the view it maintains — otherwise
      // every write here would re-trigger the autorun that made it.
      Tracker.nonreactive(() => {
        const keep = new Set(merged.map((m) => m._id));
        this.view.find({}).forEach((doc) => {
          if (!keep.has(doc._id)) this.view.remove(doc._id);
        });
        for (const m of merged) {
          // Whole-document replace, not `$set`: a field-merge would leave
          // stale in-flight fields (`truncatedHead`, `deltaCount`, a partial
          // `thinking`) on the row after the real message commits without
          // them.
          this.view.upsert(m._id, m);
        }
      });
    });
  }

  messages(sessionId: string) {
    return this.view.find({ sessionId }, { sort: { seq: 1 } });
  }

  session(sessionId: string) {
    return AgentSessions.findOne(sessionId);
  }

  status(sessionId: string): Phase {
    return this.session(sessionId)?.phase ?? 'idle';
  }

  usage(sessionId: string) {
    return this.session(sessionId)?.usage ?? { input: 0, output: 0, cost: 0 };
  }

  /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name). */
  subscribeSessions() {
    return Meteor.subscribe(NAMES.pubSessions, this.name);
  }

  sessions(selector: SessionQuery = {}) {
    return AgentSessions.find(
      { ...selector, agent: this.name },
      { sort: { updatedAt: -1 } },
    );
  }

  start(opts?: { title?: string }): Promise<string> {
    return Meteor.callAsync(NAMES.mStart, this.name, opts);
  }

  send(sessionId: string, text: string): Promise<string> {
    return Meteor.callAsync(NAMES.mSend, this.name, sessionId, text);
  }

  interrupt(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mInterrupt, this.name, sessionId);
  }

  /**
   * Branch this session into a new one sharing its history up to `atSeq`, and
   * resolve with the NEW session id — `subscribe()` it and carry on from there.
   *
   * `atSeq` defaults to the whole conversation and is clamped DOWN to the
   * nearest batch-safe cut point server-side, so passing the seq of the row a
   * user clicked is always safe even when that row sits inside a tool batch.
   * The fork shows up in `sessions()` like any other conversation.
   */
  fork(sessionId: string, opts?: { atSeq?: number; title?: string }): Promise<string> {
    return Meteor.callAsync(
      NAMES.mFork, this.name, sessionId, opts?.atSeq,
      opts?.title === undefined ? undefined : { title: opts.title },
    );
  }

  /**
   * Compact this session's history NOW, whatever the `context.compactAt`
   * threshold says — a "compact now" button. Resolves true when a summary note
   * was committed, false when there was nothing worth compacting.
   *
   * Rejects with `busy` while a turn is running: a compaction writes to the
   * transcript exactly as a turn does. Gate the button on
   * `status(id) === 'idle'`.
   *
   * The transcript keeps every message, so nothing disappears from your UI —
   * the note changes only what the MODEL sees from here on.
   */
  compact(sessionId: string): Promise<boolean> {
    return Meteor.callAsync(NAMES.mCompact, this.name, sessionId);
  }

  /**
   * The tool call waiting on a human answer, or undefined when nothing is
   * parked. Reactive, like `status()` — render it beside `status(id) ===
   * 'awaiting'` to show what is being asked, then call `approve`/`deny`.
   */
  pending(sessionId: string) {
    return this.session(sessionId)?.pending;
  }

  /**
   * Mint a single-use download URL for one attachment ref (participants spec
   * §7) — call it ON CLICK and navigate immediately: the token lives about a
   * minute and is burned by the GET, so the URL is a fetch handle, never a
   * share handle. Rejects `no-attachment` for an id this session does not
   * hold.
   */
  async attachmentUrl(sessionId: string, attachmentId: string): Promise<string> {
    const token: string = await Meteor.callAsync(
      NAMES.mAttachmentToken, this.name, sessionId, attachmentId,
    );
    return `/agent/attachments/${token}`;
  }

  approve(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mApprove, this.name, sessionId);
  }

  /** `reason` reaches the model as the denied tool result, so it is the model's
   *  only account of why — worth writing for it, not just for the log. */
  deny(sessionId: string, reason?: string): Promise<void> {
    return Meteor.callAsync(NAMES.mDeny, this.name, sessionId, reason);
  }
}
