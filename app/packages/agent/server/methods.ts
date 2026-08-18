import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentMessages, AgentSessions } from '../common/collections';
import { getAgent, buildRunConfig, type AgentConfig } from './registry';
import { COMPACT_REFUSALS, compactSession, runTurn } from './loop';
import { forkSession } from './fork';
import { MAX_SUBAGENT_DEPTH } from './subagent';
import { ACTIVE_PHASES } from '../common/types';

/**
 * Authorize BEFORE acting, on every method that touches an existing session.
 *
 * Scoped by `agent` as well as `userId`, matching the `agent.session`
 * publication's filter exactly. Without the agent scope, `Agent('a').send(id)`
 * would run agent A's model, system prompt and tools against a transcript the
 * session document says belongs to agent B — a session the same caller cannot
 * even subscribe to under that name. Same-user only, so not a disclosure bug,
 * but the two halves of the API must agree on what a session is.
 *
 * The error is deliberately identical for "no such session" and "not yours":
 * distinguishing them would confirm the existence of another user's session id.
 */
async function requireSession(agent: string, sessionId: string, userId: string | null) {
  const session = await AgentSessions.findOneAsync({ _id: sessionId, agent, userId } as any);
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

/**
 * Wake a run: return to the caller immediately and let the turn stream in the
 * background, watched through the subscription.
 *
 * Every method that starts work goes through this, so a send and an approval
 * resume a session on identical terms — same registry config, same pi-ai
 * fallback, same error containment. Exported for the watcher (§4.3), which wakes
 * an orphan through this same shape rather than assembling a `RunConfig` of its
 * own: a recovered turn must run with exactly the config a user-initiated one
 * would.
 *
 * The `.catch` is load-bearing, not decoration: an unhandled rejection is
 * fatal by default on Node >= 15, so a bare `void runTurn(...)` would let one
 * bad provider call take down the whole app server.
 */
export function deferTurn(sessionId: string, config: AgentConfig, userId: string | null): void {
  Meteor.defer(() => {
    // `buildRunConfig` is shared with `Agent.ask` and with a subagent's child
    // run, so a turn runs on identical terms however it was started — see the
    // note there.
    runTurn(sessionId, buildRunConfig(config, userId)).catch((e) => {
      console.error(`[10thfloor:agent] turn failed for session ${sessionId}:`, e);
    });
  });
}

/**
 * The single-winner verdict write, and the audit row that records it.
 *
 * The ONE place that decides a parked approval, shared by `agent.approve` /
 * `agent.deny` (a human answering) and by the watcher's approval timeout (§4.3,
 * nobody answering). Both need the identical conditional write — `phase:
 * 'awaiting'` and no verdict yet, matched atomically — so two approvers
 * clicking at once, or two servers' sweeps timing out the same request at once,
 * produce exactly one winner and exactly one side effect. Duplicating that
 * selector for the timeout path would be duplicating the thing that makes it
 * correct.
 *
 * Returns whether THIS caller won. It deliberately does not throw: a human
 * caller is owed a `no-pending` error, a sweep is owed a quiet false.
 *
 * Authorization is NOT here. It belongs to the caller that has one
 * (`recordVerdict`), and a timeout has none to check — see
 * `recordTimeoutVerdict`.
 */
async function writeVerdict(
  sessionId: string,
  verdict: 'approved' | 'denied',
  by: string | null,
  reason: string | undefined,
  timedOut = false,
): Promise<boolean> {
  const $set: Record<string, unknown> = {
    'pending.verdict': verdict,
    'pending.by': by,
    // The wake's IDENTITY, written in the same atomic write as the verdict it
    // identifies — never separately, or a deferred resume could capture a
    // token for a verdict that is not yet there. The loop's wind-down
    // self-check captures it and re-checks it inside its deferred callback:
    // "is a verdict standing" is a boolean answer to the question "is it still
    // MY verdict standing". See `AgentSession.pending.wakeToken`.
    'pending.wakeToken': Random.id(),
    phase: 'idle',
    updatedAt: new Date(),
  };
  // Only when given: `$set` with an undefined value is not a field write.
  if (reason !== undefined) $set['pending.reason'] = reason;

  const won = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      phase: 'awaiting',
      'pending.verdict': { $exists: false },
    } as any,
    { $set } as any,
  );
  // Zero matched means someone else answered between our read and our write.
  if (won !== 1) return false;

  // The verdict is history: who decided, which way, and why. Structured
  // fields, never prose — a UI renders it and an audit reads it.
  //
  // The seq comes from a direct atomic allocation rather than the loop's
  // `allocateSeq`, which guards on the lease: a parked run holds no lease (it
  // exited), so this is the same shape `agent.send` uses to interleave safely
  // with a running turn.
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    { _id: sessionId },
    { $inc: { nextSeq: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'before' },
  );
  if (before) {
    // The parked marker as it stood a moment ago — `before` is the document
    // BEFORE this seq allocation, which is after the verdict write, so
    // `pending` is still there with everything the park recorded.
    const parked = (before as any).pending as { runAs?: string | null } | undefined;
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: (before as any).nextSeq,
      role: 'note', kind: 'approval',
      approved: verdict === 'approved', by, reason,
      // AUDIT COMPLETENESS: what was authorized, not merely that someone said
      // yes. A call that runs as `service-account` is a different fact from one
      // that runs as the approver, and the tool spec (the only other place that
      // knows) can be edited or deleted long before anyone reads this row.
      //
      // Presence, not truthiness: `runAs: null` is the anonymous service
      // context, and a spread keeps the key ABSENT for the ordinary case rather
      // than writing an explicit undefined.
      ...(parked && 'runAs' in parked ? { runAs: parked.runAs } : {}),
      // `undefined` is not a field write, so a human verdict carries no
      // `timedOut` key at all rather than an explicit false. A UI that
      // distinguishes "denied by someone" from "nobody answered in time" must
      // be able to tell them apart from the row alone.
      timedOut: timedOut || undefined,
      createdAt: new Date(),
    } as any);
  } else {
    // No seq means the session vanished between the verdict write and here.
    // The verdict itself is already durable and the tool may well execute, so
    // the missing row is an audit gap, not a cosmetic one: say so rather than
    // letting an approved side effect leave no trace of who authorized it.
    console.warn(
      `[10thfloor:agent] session ${sessionId} vanished before its ${verdict} `
      + 'note could be written; the approval has no audit row',
    );
  }
  return true;
}

/**
 * §4.3. Deny a parked approval that nobody answered in time, and wake the run.
 *
 * The watcher's sweep decides WHEN (it owns `budget.approval` and the clock);
 * this owns WHAT a timeout is: a denial, recorded through the same single-winner
 * core a human verdict goes through, with `by: null` because no one decided, and
 * `timedOut: true` on the audit row so the distinction survives in history. The
 * loop then answers the parked call with `{ error: 'denied', reason: 'approval
 * timed out' }` — the model sees the refusal and routes around it, exactly as it
 * does for a human denial.
 *
 * No `config.approve` check: that predicate says who may ANSWER, and nobody is
 * answering. No ownership check either — there is no caller to authorize.
 *
 * Returns false when the session or its agent is gone, or when another server's
 * sweep won the race. Never throws: a sweep is not a caller.
 */
export async function recordTimeoutVerdict(sessionId: string): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return false;
  // The watcher has already warned about an unregistered agent (it needs the
  // config to read `budget.approval` at all); this is the second line of
  // defense for a direct caller, and the reason a missing config is not fatal:
  // a verdict we could not resume would strand the session worse than the
  // timeout it was fixing.
  const config = getAgent(session.agent);
  if (!config) return false;

  if (!(await writeVerdict(sessionId, 'denied', null, 'approval timed out', true))) {
    return false;
  }
  deferTurn(sessionId, config, session.userId);
  return true;
}

/**
 * Stop the RUNNING DESCENDANTS of an interrupted session.
 *
 * Stop must stop the work the user can see. A parent that delegates spends most
 * of its turn inside `runSubagent`, and stopping only the parent left the child
 * streaming to completion on the parent's clock — tokens billed, a transcript
 * growing, and a Stop button that had visibly done nothing. The chain is walked
 * through `activeChild`, which is the live handle and is set for exactly as long
 * as a dispatch is in flight (a child may itself be dispatching, hence a walk
 * rather than a single hop).
 *
 * TWO THINGS IT WILL NOT DO.
 *
 * It will not touch a PARKED descendant. A child sitting in `awaiting` is a
 * question in front of a human, and the parent's turn already gave up on it:
 * `subagent-parked` told the model so, and the whole design of that answer is
 * that the child stays open and answerable through `agent.approve` afterwards.
 * Stopping it would cancel a decision the parent's interrupt was never about,
 * and (because a stop is durable until the next `agent.send`) would strand a
 * request nobody can ever answer — a parked child has no `send` path a UI
 * offers. The phase filter is what encodes this: only `ACTIVE_PHASES` match,
 * so `awaiting`, `idle`, `error` and an already-`stopped` descendant are all
 * left exactly as they are.
 *
 * It will not recurse without a bound. `MAX_SUBAGENT_DEPTH` hops is the whole
 * legal chain, so the cap is not a heuristic; it is also what keeps a stale or
 * cyclic `activeChild` (a marker left behind by a lease steal mid-dispatch —
 * the field's own docs call it a hint, not a contract) from turning a Stop into
 * an unbounded walk.
 *
 * The writes are plain, unguarded `$set`s, exactly like the interrupt's own —
 * and for the identical reason. There is no lease to hold: the interrupting
 * CALLER owns no session, and the process driving the descendant is precisely
 * the one this write is trying to reach. `stopped` is a terminal state every
 * writer in the loop already defends (the commit, the park and the retry
 * branch are all conditional on `phase: { $ne: 'stopped' }`, and the outer
 * `finally` preserves it), so the worst a racing write can do is arrive at a
 * session that has already finished — which the phase filter then declines to
 * stop. The walk is a best-effort read of hints, so it neither retries nor
 * reports: what makes the stop authoritative is the descendant's own mid-stream
 * check, not this write's return value.
 */
async function stopRunningDescendants(sessionId: string): Promise<void> {
  let current = await AgentSessions.findOneAsync(sessionId);
  for (let hop = 0; hop < MAX_SUBAGENT_DEPTH; hop += 1) {
    const next = current?.activeChild?.sessionId;
    if (!next) return;
    // eslint-disable-next-line no-await-in-loop
    await AgentSessions.updateAsync(
      { _id: next, phase: { $in: ACTIVE_PHASES } } as any,
      { $set: { phase: 'stopped', updatedAt: new Date() } } as any,
    );
    // Re-read rather than trusting the write: the walk continues past a
    // descendant it did NOT stop (a parked one, or one that finished a
    // microsecond ago) because that descendant's own children — if it somehow
    // has any in flight — are still the user's work.
    // eslint-disable-next-line no-await-in-loop
    current = await AgentSessions.findOneAsync(next);
  }
}

/**
 * The shared body of `agent.approve` and `agent.deny`: authorize, decide once,
 * record the verdict in the transcript, and wake the parked run.
 *
 * Order is the whole design here. Authorization comes first (`requireSession`,
 * then the agent's own `approve` predicate) so a refused caller changes
 * nothing at all — the run stays parked and the transcript stays clean. The
 * verdict write is conditional on the state it read (`phase: 'awaiting'`, no
 * verdict yet) rather than on a re-read, so two people clicking Approve at the
 * same instant produce exactly one winner and exactly one side effect; the
 * loser is told `no-pending` rather than being handed a silent success for a
 * tool it never authorized.
 */
async function recordVerdict(
  ctx: { userId: string | null },
  agent: string,
  sessionId: string,
  verdict: 'approved' | 'denied',
  reason?: string,
): Promise<void> {
  const config = getAgent(agent);
  if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
  const session = await requireSession(agent, sessionId, ctx.userId);

  if (session.phase !== 'awaiting' || !session.pending || session.pending.verdict) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }

  // Ownership says the caller may drive this session; `config.approve` says
  // whether they may answer for it. A four-eyes policy ("not the same person
  // who asked") lives here, and returning false must leave the request
  // standing for someone who can.
  if (config.approve && !(await config.approve({ userId: ctx.userId }))) {
    throw new Meteor.Error('not-allowed', 'You may not answer this approval');
  }

  // Losing the conditional write means someone else answered between our read
  // and our write: tell the loser rather than handing them a silent success for
  // a tool they never authorized.
  if (!(await writeVerdict(sessionId, verdict, ctx.userId, reason))) {
    throw new Meteor.Error('no-pending', 'Nothing is waiting for approval');
  }

  deferTurn(sessionId, config, ctx.userId);
}

export function registerMethods(): void {
  Meteor.methods({
    async [NAMES.mStart](this: any, agent: string, opts?: { title?: string }) {
      check(agent, String);
      check(opts, Match.Maybe({ title: Match.Maybe(String) }));
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const _id = Random.id();
      await AgentSessions.insertAsync({
        _id, agent, userId: this.userId ?? null, title: opts?.title,
        phase: 'idle', model: config.model, nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
      return _id;
    },

    async [NAMES.mSend](this: any, agent: string, sessionId: string, text: string) {
      check(agent, String);
      check(sessionId, String);
      check(text, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      await requireSession(agent, sessionId, this.userId ?? null);

      // §9: the turn budget, enforced INSIDE the atomic allocation below, not
      // as a separate read-then-check. `budgetSpent.turns` is only ever $inc'd
      // here, but concurrent sends all reading the same pre-inc value would
      // each pass a separate check — with capability-URL sessions the caller
      // count is unbounded, so the overshoot would be too. Folding
      // `$lt: limit` into the filter makes check-and-spend one operation: a
      // budget of N permits exactly N sends under any concurrency.
      //
      // A refusal, not a stop. The other two budgets trip inside a running
      // loop, where the only way to say no is a transcript note; here there is
      // a caller on the other end of a method, so tell them — and write
      // nothing at all, so a refused send costs neither a seq nor a message
      // nor the budget it was refused for. Asking again is refused identically
      // until an operator raises the limit.
      const turnFilter: Record<string, unknown> = { _id: sessionId };
      if (config.budget?.turns !== undefined) {
        // Matches when under budget. Sessions seeded before this field existed
        // have budgetSpent.turns set by mStart, so $lt sees a number.
        turnFilter['budgetSpent.turns'] = { $lt: config.budget.turns };
      }

      // Seq allocation is ATOMIC (single findOneAndUpdate), not read-then-
      // insert. A read-then-insert here races the in-flight turn loop: both
      // read the same nextSeq and the user message lands on the same seq the
      // assistant is about to commit at, making transcript order
      // non-deterministic. The loop allocates its seqs the same way.
      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        turnFilter,
        {
          $inc: { nextSeq: 1, 'budgetSpent.turns': 1 },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'before' },
      );
      if (!before) {
        // requireSession above proved the session exists and is the caller's,
        // so a non-match here can only be the budget filter.
        if (config.budget?.turns !== undefined) {
          throw new Meteor.Error(
            'budget-exhausted', 'This session has used its turn budget.',
          );
        }
        throw new Meteor.Error('no-session', 'Session not found');
      }

      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: (before as any).nextSeq, role: 'user',
        content: text, createdAt: new Date(),
      } as any);

      // A new message is the resume signal after an interrupt OR a provider
      // failure: both `stopped` and `error` are durable (the loop refuses to
      // run while either stands, and its `finally` preserves both), so the
      // send is what clears them — matching §10's "the model usually
      // recovers" philosophy for `error`. Conditional on the current phase so
      // a send during a live turn does not stomp `streaming`.
      await AgentSessions.updateAsync(
        { _id: sessionId, phase: { $in: ['stopped', 'error'] } } as any,
        { $set: { phase: 'idle' } } as any,
      );

      deferTurn(sessionId, config, this.userId ?? null);
      return sessionId;
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      // The loop's `finally` preserves a `stopped` phase rather than idling it
      // back, so this survives the in-flight turn winding down.
      //
      // A session parked on an approval is stopped the same way, and `pending`
      // is deliberately LEFT in place: the interrupt cancels the wait, not the
      // record of what was asked. `approve`/`deny` require `phase: 'awaiting'`
      // and so refuse from here on, and the next `agent.send` clears the stop
      // — at which point the resumed turn discards the dead request rather
      // than leaving its `tool_use` unanswered.
      await AgentSessions.updateAsync(sessionId, {
        $set: { phase: 'stopped', updatedAt: new Date() },
      } as any);

      // The named session first, its running descendants second. Order is not
      // cosmetic: a subagent chain is driven from the top, so stopping the
      // parent before the child means the parent cannot start ANOTHER child
      // between the two writes (its next dispatch reads a stopped phase and
      // abandons the batch). The reverse order leaves exactly that hole.
      //
      // Authorization is the parent's, and needs no addition: a child inherits
      // its parent's `userId`, so anyone entitled to stop the parent is
      // entitled to stop the work the parent started. There is no path from
      // here to a session outside that lineage — `activeChild` is written only
      // by a dispatch, only on the dispatching session, and only ever naming
      // the child it just created.
      await stopRunningDescendants(sessionId);
    },

    /**
     * Branch a session at a batch-safe cut point; returns the NEW session id.
     *
     * `atSeq` is a REQUEST, not a command: it is clamped down to the nearest
     * legal cut (see `findForkCut`), so a UI can hand this the seq of the row a
     * user clicked without knowing anything about tool batches. Defaults to the
     * last message — "fork the whole thing".
     *
     * Authorization is on the SOURCE only: the fork is created for the source's
     * owner, so a caller who may drive the source may fork it, and no one else
     * can name a session id they cannot already read.
     */
    async [NAMES.mFork](
      this: any, agent: string, sessionId: string, atSeq?: number,
      opts?: { title?: string },
    ) {
      check(agent, String);
      check(sessionId, String);
      check(atSeq, Match.Maybe(Match.Integer));
      check(opts, Match.Maybe({ title: Match.Maybe(String) }));
      // The registry check mirrors mStart/mSend: forking into an agent this
      // server does not define would produce a session nothing can ever run.
      if (!getAgent(agent)) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const source = await requireSession(agent, sessionId, this.userId ?? null);
      // `Match.Maybe` accepts null as well as undefined, and DDP turns a
      // trailing `undefined` argument into null on the wire — so normalize
      // rather than letting a null `atSeq` reach the arithmetic downstream.
      return forkSession(source, { atSeq: atSeq ?? undefined, title: opts?.title });
    },

    /**
     * §9's compaction on demand, ignoring the threshold. Resolves true when a
     * note was committed, false when there was nothing to compact.
     *
     * Authorized exactly as every other session method is, then handed to
     * `compactSession`, which owns the lease for the operation — so this cannot
     * race a turn, and a session that is running one is refused with `busy`
     * rather than queued. It is deliberately NOT `deferTurn`-shaped: the caller
     * asked for a specific piece of bookkeeping and is owed its result, and a
     * compaction commits at most one note.
     *
     * The turn budget is untouched: a compaction is not a turn. Its
     * summarization call still accrues usage and cost like any other model
     * call, so `budget.spend` remains the backstop — and `rateLimit.compacts`
     * is the front one: this is the second method (after `send`) whose every
     * accepted call buys a provider round trip, so it gets a knob of its own.
     */
    async [NAMES.mCompact](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const session = await requireSession(agent, sessionId, this.userId ?? null);

      // The SESSION's owner, not `this.userId`: an anonymous capability-URL
      // session compacts under the same null identity its turns run under, and
      // the two are the same value anyway after `requireSession` matched on it.
      const outcome = await compactSession(
        sessionId, buildRunConfig(config, session.userId),
      );
      // One code, three reasons — `busy` also covers a session parked on an
      // approval and one sitting in `error`. See `COMPACT_REFUSALS`.
      const refusal = COMPACT_REFUSALS[outcome];
      if (refusal) throw new Meteor.Error('busy', refusal);
      if (outcome === 'gone') throw new Meteor.Error('no-session', 'Session not found');
      return outcome === 'compacted';
    },

    async [NAMES.mApprove](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await recordVerdict({ userId: this.userId ?? null }, agent, sessionId, 'approved');
    },

    async [NAMES.mDeny](this: any, agent: string, sessionId: string, reason?: string) {
      check(agent, String);
      check(sessionId, String);
      check(reason, Match.Maybe(String));
      await recordVerdict({ userId: this.userId ?? null }, agent, sessionId, 'denied', reason);
    },
  });
}
