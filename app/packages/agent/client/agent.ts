import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { NAMES } from '../common/names';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
import { mergeView } from '../common/merge';
import type { Phase, ViewMessage } from '../common/types';

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

  constructor(public readonly name: string) {}

  subscribe(sessionId: string) {
    const handle = Meteor.subscribe(NAMES.pubSession, this.name, sessionId);
    this.startMerging(sessionId);
    return handle;
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
      const committed = AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetch() as any[];
      const deltas = AgentDeltas.find({ sessionId }).fetch() as any[];
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
          this.view.upsert(m._id, m as any);
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
    return (this.session(sessionId) as any)?.phase ?? 'idle';
  }

  usage(sessionId: string) {
    return (this.session(sessionId) as any)?.usage ?? { input: 0, output: 0, cost: 0 };
  }

  /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name). */
  subscribeSessions() {
    return Meteor.subscribe(NAMES.pubSessions, this.name);
  }

  sessions(selector: Record<string, unknown> = {}) {
    return AgentSessions.find(
      { ...selector, agent: this.name } as any,
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
   * The tool call waiting on a human answer, or undefined when nothing is
   * parked. Reactive, like `status()` — render it beside `status(id) ===
   * 'awaiting'` to show what is being asked, then call `approve`/`deny`.
   */
  pending(sessionId: string) {
    return (this.session(sessionId) as any)?.pending;
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
