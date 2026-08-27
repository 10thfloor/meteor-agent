import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
import { mergeView } from '../common/merge';
import type { Phase, ViewMessage } from '../common/types';
import type { SessionQuery } from '../common/db';

/** Client-side handle on one agent. Uses minimongo's synchronous API
 *  (the async-only rule is server-side). */
export class Agent {
  /** Client-only collection holding the merged view. */
  private view = new Mongo.Collection<ViewMessage>(null);
  private computation: Tracker.Computation | null = null;
  /** Retained so `stop()` can clean it up. */
  private handle: Meteor.SubscriptionHandle | null = null;
  /** Which session is being watched — `stop(sessionId)` guard. */
  private watching: string | null = null;

  constructor(public readonly name: string) {}

  subscribe(sessionId: string) {
    // Re-subscribe replaces: stop the old handle to avoid a leaked subscription.
    if (this.handle) this.handle.stop();
    this.handle = Meteor.subscribe(NAMES.pubSession, this.name, sessionId);
    this.watching = sessionId;
    this.startMerging(sessionId);
    return this.handle;
  }

  /** Tear down computation + subscription + view. Idempotent (React 18
   *  StrictMode double-fires). `sessionId` is a guard: a stale unmount
   *  cleanup cannot tear down a newer subscription. */
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
    // Evict stale rows — the subscription that fed them is gone.
    this.view.remove({});
  }

  /** Keep `view` = mergeView(committed, deltas) for one session.
   *  Sweeps the whole view so a re-subscribe evicts the old session. */
  private startMerging(sessionId: string) {
    if (this.computation) this.computation.stop();
    this.computation = Tracker.autorun(() => {
      const committed = AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetch();
      const deltas = AgentDeltas.find({ sessionId }).fetch();
      const merged = mergeView(committed, deltas);

      // nonreactive: writes must not re-trigger the autorun that reads.
      Tracker.nonreactive(() => {
        const keep = new Set(merged.map((m) => m._id));
        this.view.find({}).forEach((doc) => {
          if (!keep.has(doc._id)) this.view.remove(doc._id);
        });
        for (const m of merged) {
          // Full replace, not $set — stale in-flight fields must not survive commit.
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

  /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name).
   *  Archived sessions are left out unless asked for. */
  subscribeSessions(includeArchived = false) {
    return Meteor.subscribe(NAMES.pubSessions, this.name, includeArchived);
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
    // Stable across Meteor's transparent method retry: the server's private
    // Transcript Commit Module uses this only as an idempotency identity.
    return Meteor.callAsync(NAMES.mSend, this.name, sessionId, text, Random.id());
  }

  interrupt(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mInterrupt, this.name, sessionId);
  }

  /** Branch at atSeq (clamped to batch-safe cut). Returns new session id. */
  fork(sessionId: string, opts?: { atSeq?: number; title?: string }): Promise<string> {
    return Meteor.callAsync(
      NAMES.mFork, this.name, sessionId, opts?.atSeq,
      opts?.title === undefined ? undefined : { title: opts.title },
    );
  }

  /** Force-compact now. True = summary committed, false = nothing to compact.
   *  Rejects 'busy' if a turn is running — gate on idle. */
  compact(sessionId: string): Promise<boolean> {
    return Meteor.callAsync(NAMES.mCompact, this.name, sessionId);
  }

  /** Parked tool call awaiting human answer, or undefined. */
  pending(sessionId: string) {
    return this.session(sessionId)?.pending;
  }

  /** Mint a single-use download URL (burned on GET, ~60s TTL). */
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

  /** Shelve a session: it drops out of `sessions()` and keeps everything else,
   *  including the ability to take a turn. */
  archive(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mArchive, this.name, sessionId);
  }

  unarchive(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mUnarchive, this.name, sessionId);
  }
}
