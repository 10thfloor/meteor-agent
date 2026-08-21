import { AgentMessages, AgentSessions } from '../../common/collections';
import type { AgentSession } from '../../common/types';
import { SERVER_ID } from '../lease';
import {
  ChannelBindings, DeliveryReceipts, isDuplicateKey,
  type ChannelBinding, type ReceiptExpectation,
} from './collections';
import { expectationsFor, planItems, promptItem } from './plan';
import { issueVerdictToken } from './linking';
import { getChannel, uncertainDeliveryMode, type ChannelDef } from './registry';
import type { DeliveryItem } from './contract';

/**
 * The egress worker (channels spec §6.4/§11) — `startWatcher` with the
 * collection swapped, deliberately: one worker per channel kind per process,
 * an observer for latency plus a timed sweep for everything no write signals,
 * `{ stop() }` returned, all state in closure vars.
 *
 * ONE worker, query-sliced — never an observer per conversation. A browser
 * tab's subscription dies with the tab; a Slack thread never disconnects, so
 * per-conversation observers accumulate forever. The observer here watches
 * committed MESSAGES (insert-only, so `added` is the whole story and the
 * session document's `nextSeq`/`usage` churn never wakes it) and the sweep
 * walks the kind's bindings.
 *
 * Every multi-server race resolves through an atomic conditional write — the
 * claim (all four `claimLease` branches, INCLUDING "already ours", because a
 * delivering worker is a renewing owner, not the watcher's discoverer), the
 * cursor advance (guarded on claim AND expected value), and the receipt's
 * derived `_id`. No Redis, no leader election.
 */

export interface EgressOptions {
  /** How often the sweep runs. Default 15s; tests lower it. */
  sweepMs?: number;
  /** How long a delivery claim lasts. Renewed per row; default 30s. */
  claimMs?: number;
}

export interface EgressWorker {
  stop(): Promise<void>;
}

/** The per-binding claim — `claimLease`'s idiom on the binding row. Win iff
 *  n === 1; of N racers exactly one matches. */
export async function claimBinding(
  bindingId: string, claimMs: number, serverId = SERVER_ID,
): Promise<boolean> {
  const now = new Date();
  const n = await ChannelBindings.updateAsync(
    {
      _id: bindingId,
      $or: [
        { claim: { $exists: false } },
        { claim: null },
        { 'claim.until': { $lt: now } },
        { 'claim.serverId': serverId },   // 'already ours' — a renewing owner keeps its row
      ],
    },
    { $set: { claim: { serverId, until: new Date(now.getTime() + claimMs) } } },
  );
  return n === 1;
}

/** The cursor advance — guarded on BOTH the claim and the expected `fromSeq`,
 *  the `writeVerdict` single-winner shape: a stale worker's late write matches
 *  nothing and no-ops. Advanced only after the row is HANDLED (posted and
 *  receipted, or planned as advance-past). */
export async function advanceCursor(
  bindingId: string, fromSeq: number, toSeq: number, serverId = SERVER_ID,
): Promise<boolean> {
  const n = await ChannelBindings.updateAsync(
    { _id: bindingId, 'claim.serverId': serverId, deliveredSeq: fromSeq },
    { $set: { deliveredSeq: toSeq, updatedAt: new Date() } },
  );
  return n === 1;
}

/** §8.5's audience rule for the overflow/web link: an OWNED session's URL is
 *  login-gated and may go anywhere; an anonymous session's URL IS the
 *  credential (§12) and may only be sent to a single-recipient destination. */
function overflowUrlFor(
  def: ChannelDef, binding: ChannelBinding, session: AgentSession,
): string | undefined {
  if (!def.sessionUrl) return undefined;
  if (session.userId === null && binding.audience !== 'direct') return undefined;
  return def.sessionUrl(session);
}

const dup = isDuplicateKey;

/**
 * The three-phase intent log (§11): reserve → post → confirm, keyed on a
 * DERIVED receipt id (`deliver:<bindingId>:<suffix>`), so "the surface shows
 * it once" holds across servers and across the observer's whole-backlog replay
 * on every boot.
 *
 * Returns `'delivered'` when the item is durably `sent` (whether by this call
 * or a previous one), `'abandoned'` when the channel's declared recovery gave
 * it up. Throws when the transport fails — the caller stops and the next
 * sweep retries under the same receipt.
 *
 * EXPORTED for tool bodies (§7's `channel.notify` shape): tool dispatch
 * re-runs on crash recovery — the package's own dispatch comment calls that
 * window "irreducible without idempotency keys carried through to the tools
 * themselves" — and this, keyed on the tool call's id, is that idempotency
 * key carried through.
 */
export async function deliverOnce(
  kind: string,
  binding: ChannelBinding,
  item: DeliveryItem,
  suffix: string,
  opts: { expects?: ReceiptExpectation[]; def?: ChannelDef } = {},
): Promise<'delivered' | 'abandoned'> {
  const def = opts.def ?? getChannel(kind);
  if (!def) throw new Error(`[10thfloor:agent] deliverOnce: unknown channel "${kind}"`);
  const receiptId = `deliver:${binding._id}:${suffix}`;

  // RESERVE. The duplicate-key loser reads the winner's state instead of
  // posting: `sent`/`abandoned` are settled; `sending` is the one ambiguous
  // state, resolved per the channel's declared tier (§11).
  let reserved = false;
  try {
    await DeliveryReceipts.insertAsync({
      _id: receiptId, bindingId: binding._id, state: 'sending',
      ...(opts.expects && opts.expects.length > 0 ? { expects: opts.expects } : {}),
      attempts: 1, at: new Date(),
    });
    reserved = true;
  } catch (e) {
    if (!dup(e)) throw e;
  }

  if (!reserved) {
    const existing = await DeliveryReceipts.findOneAsync(receiptId);
    if (!existing || existing.state === 'sent') return 'delivered';
    if (existing.state === 'abandoned') return 'abandoned';
    // Mid-`sending`: a crash between post and confirm, or a concurrent worker
    // still in flight. The claim serializes workers per binding, so by the
    // time we are here under the claim, "concurrent" is over and this is the
    // crash case — apply the declared recovery.
    const mode = uncertainDeliveryMode(def);
    if (mode === 'abandon') {
      await DeliveryReceipts.updateAsync(
        { _id: receiptId, state: 'sending' },
        { $set: { state: 'abandoned', at: new Date() } },
      );
      return 'abandoned';
    }
    if (mode === 'reconcile' && def.transport.reconcile) {
      const landed = await def.transport.reconcile(binding.destination, receiptId);
      if (landed) {
        await DeliveryReceipts.updateAsync(
          { _id: receiptId, state: 'sending' },
          { $set: { state: 'sent', at: new Date() } },
        );
        return 'delivered';
      }
    }
    // 'retry' (tier A: the provider collapses the repeated key; tier C: the
    // channel DECLARED it accepts possible duplicates) — fall through to post.
    await DeliveryReceipts.updateAsync(receiptId, { $inc: { attempts: 1 } });
  }

  // POST. A lens may return several payloads (a segmented SMS); each gets its
  // own provider-side key — one shared key would make a tier-A provider
  // collapse the segments into one.
  const rendered = def.lens.out(item, binding.destination);
  const payloads = Array.isArray(rendered) ? rendered : [rendered];
  let providerMessageId: string | undefined;
  for (let i = 0; i < payloads.length; i += 1) {
    const key = payloads.length === 1 ? receiptId : `${receiptId}:${i}`;
    // eslint-disable-next-line no-await-in-loop
    const posted = await def.transport.post(binding.destination, payloads[i], {
      idempotencyKey: key,
    });
    if (i === 0 && posted && typeof posted === 'object' && posted.providerMessageId) {
      providerMessageId = posted.providerMessageId;
    }
  }

  // CONFIRM — guarded on `sending`, so a racing settle wins exactly once.
  await DeliveryReceipts.updateAsync(
    { _id: receiptId, state: 'sending' },
    {
      $set: {
        state: 'sent',
        ...(providerMessageId !== undefined ? { providerMessageId } : {}),
        at: new Date(),
      },
    },
  );
  return 'delivered';
}

/**
 * Deliver one binding's backlog: claim it, walk the transcript past the
 * cursor, post what the planner says to post, advance past the rest, then
 * offer the parked prompt (receipt-guarded — a prompt is session state, not a
 * seq row, so it advances no cursor and re-delivers only when a NEW ask
 * parks).
 */
export async function deliverBinding(
  kind: string, bindingId: string, opts: EgressOptions = {},
): Promise<void> {
  const def = getChannel(kind);
  if (!def) return;
  const claimMs = opts.claimMs ?? 30_000;
  if (!(await claimBinding(bindingId, claimMs))) return;

  const binding = await ChannelBindings.findOneAsync(bindingId);
  if (!binding) return;
  const session = await AgentSessions.findOneAsync(binding.sessionId);
  // A binding whose session does not exist yet is the ingress crash window
  // (§9 — binding first, session second); ingress repairs it on the next
  // message, and there is nothing to deliver from a session with no rows.
  if (!session) return;

  const tail = await AgentMessages.find(
    { sessionId: binding.sessionId, seq: { $gt: binding.deliveredSeq } },
    { sort: { seq: 1 } },
  ).fetchAsync();

  const planned = planItems(tail, {
    statuses: def.statuses,
    profile: def.profile,
    overflowUrl: overflowUrlFor(def, binding, session),
  });

  let cursor = binding.deliveredSeq;
  for (const row of planned) {
    // Renew per row — a long backlog must not outlive a 30s claim. The
    // "already ours" branch is what makes renewal a cheap win.
    // eslint-disable-next-line no-await-in-loop
    if (!(await claimBinding(bindingId, claimMs))) return;
    if (row.item) {
      // eslint-disable-next-line no-await-in-loop
      await deliverOnce(kind, binding, row.item, row.message._id, { def });
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await advanceCursor(bindingId, cursor, row.message.seq))) return;
    cursor = row.message.seq;
  }

  // The parked ask, once per ask: the receipt suffix carries the toolCallId,
  // so a re-park of a DIFFERENT call is a new receipt and a re-sweep of the
  // same one is a settled no-op.
  const prompt = promptItem(session, def.profile);
  if (prompt) {
    if (def.profile.interact === 'link' && def.approvalUrl) {
      for (const choice of prompt.choices) {
        // eslint-disable-next-line no-await-in-loop
        const token = await issueVerdictToken(
          binding.agent, binding.sessionId, prompt.toolCallId,
          choice.token === 'approve' ? 'approved' : 'denied',
        );
        choice.url = def.approvalUrl(token);
      }
    }
    await deliverOnce(kind, binding, prompt, `prompt:${prompt.toolCallId}`, {
      def, expects: expectationsFor(prompt),
    });
  }
}

export function startEgress(kind: string, opts: EgressOptions = {}): EgressWorker {
  const def = getChannel(kind);
  if (!def) {
    throw new Error(
      `[10thfloor:agent] startEgress("${kind}"): no such channel is registered — `
      + 'call Agent.channel(kind, def) first',
    );
  }
  const sweepMs = opts.sweepMs ?? 15_000;

  let stopped = false;

  /** In-process, per-binding serialization: the claim already serializes
   *  ACROSS processes, and this keeps one process from queueing the same
   *  binding twice while a delivery is in flight. */
  const inFlight = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const deliver = async (bindingId: string): Promise<void> => {
    if (stopped || inFlight.has(bindingId)) return;
    inFlight.add(bindingId);
    try {
      await deliverBinding(kind, bindingId, opts);
    } finally {
      inFlight.delete(bindingId);
    }
  };

  const notice = (bindingId: string): void => {
    chain = chain.then(() => deliver(bindingId)).catch((e) => {
      // A failed delivery is the next sweep's business; an unhandled
      // rejection is fatal by default on Node >= 15.
      console.error(`[10thfloor:agent] egress(${kind}): delivery failed for ${bindingId}:`, e);
    });
  };

  /**
   * The sweep — the braces. It re-attempts every binding of this kind: the
   * tail read per binding is one `{ sessionId, seq }` range scan, and a
   * binding with nothing new advances nothing and posts nothing. It is also
   * the only path that notices a PARKED prompt (a park writes the session
   * document, which the message observer deliberately does not watch) and an
   * expired claim another server left mid-delivery.
   */
  const sweep = async (): Promise<void> => {
    const bindings = await ChannelBindings.find(
      { kind }, { fields: { _id: 1 } },
    ).fetchAsync();
    for (const b of bindings) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await deliver(b._id).catch((e) => {
        console.error(`[10thfloor:agent] egress(${kind}): sweep delivery failed for ${b._id}:`, e);
      });
    }
  };

  let sweeping: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || sweeping) return;   // never overlap: a slow sweep skips a tick
    sweeping = sweep()
      .catch((e) => {
        console.error(`[10thfloor:agent] egress(${kind}) sweep failed:`, e);
      })
      .then(() => { sweeping = null; });
  };
  const timer = setInterval(runSweep, sweepMs);

  /**
   * The observer — the belt: a committed row reaches its surfaces within
   * milliseconds instead of within a sweep interval, and its initial `added`
   * pass replays the whole backlog on boot — which is exactly how post-crash
   * deliveries recover, and exactly why the receipts table exists (§11): the
   * replayed rows find their receipts already `sent` and do nothing.
   *
   * `AgentMessages` is INSERT-ONLY, so `added` is the whole story — a
   * `changed` handler would be dead code. Assistant rows and notes are the
   * only kinds the planner can post, but the binding lookup is by sessionId,
   * so the projection carries only that.
   */
  let handle: { stop(): void } | null = null;
  const observing = AgentMessages.find(
    { role: { $in: ['assistant', 'note'] } },
    { fields: { sessionId: 1 } },
  ).observeChangesAsync({
    added(_id: string, fields: { sessionId?: string }) {
      if (stopped || !fields.sessionId) return;
      void ChannelBindings.find(
        { kind, sessionId: fields.sessionId }, { fields: { _id: 1 } },
      ).fetchAsync().then((bindings) => {
        for (const b of bindings) notice(b._id);
      }).catch((e) => {
        console.error(`[10thfloor:agent] egress(${kind}): binding lookup failed:`, e);
      });
    },
  }).then((h: any) => {
    // stop() can win the race against a still-resolving observe — stop the
    // handle the moment it exists (the watcher's own guard).
    handle = h;
    if (stopped) h.stop();
    return undefined;
  }).catch((e: unknown) => {
    console.error(`[10thfloor:agent] egress(${kind}): could not observe messages:`, e);
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
