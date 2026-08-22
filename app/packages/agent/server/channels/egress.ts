import { createHash } from 'crypto';
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
  /**
   * How far back the sweep looks: only bindings active (any inbound event,
   * any delivery) within this window are walked. Default 24h. This is what
   * keeps a process's per-sweep cost proportional to LIVE conversations
   * rather than to every conversation ever bound — without it a single
   * workspace member could mint thousands of thread bindings that every
   * instance would then re-read every 15 seconds, forever. Fresh rows on an
   * older binding still deliver promptly: the observer fires per committed
   * message regardless of age, and its delivery bumps the binding back into
   * the window.
   */
  sweepLookbackMs?: number;
}

/** Retry policy for a receipt found mid-`sending` (§11 `retry` tier): doubling
 *  from one sweep interval, capped at an hour, and given up after
 *  `MAX_DELIVERY_ATTEMPTS`. Without it a payload the provider rejects
 *  DETERMINISTICALLY (a cut surrogate pair, a closed WhatsApp window) would be
 *  re-posted every sweep forever and wedge the conversation behind it. */
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 48;

/** Binding ids embed conversation keys — phone numbers on SMS/WhatsApp — so
 *  log lines carry a short hash: enough to correlate, not enough to identify. */
function redact(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 10);
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

/** Settle a `sending` receipt — guarded on `sending`, so of a crash-recovery
 *  worker and a racing settle exactly one write lands. */
async function settleReceipt(
  receiptId: string, state: 'sent' | 'abandoned', providerMessageId?: string,
): Promise<void> {
  await DeliveryReceipts.updateAsync(
    { _id: receiptId, state: 'sending' },
    { $set: { state, ...(providerMessageId !== undefined ? { providerMessageId } : {}), at: new Date() } },
  );
}

/**
 * The three-phase intent log (§11): reserve → post → confirm, keyed on a
 * DERIVED receipt id (`deliver:<bindingId>:<suffix>`), so "the surface shows
 * it once" holds across servers and across the observer's whole-backlog replay
 * on every boot.
 *
 * Returns `'delivered'` when the item is durably `sent` (whether by this call
 * or a previous one), `'abandoned'` when the channel's declared recovery or
 * the attempt cap gave it up, and `'deferred'` when a prior `sending` receipt
 * is still inside its backoff window — nothing was posted; a cursor-driven
 * caller stops and the next sweep retries, a one-shot caller (ingress, a tool
 * body) should treat it as not sent. Throws when the transport fails — the
 * caller stops and the next sweep retries under the same receipt.
 *
 * `item` may be a thunk; it runs only when a post actually happens.
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
  item: DeliveryItem | (() => Promise<DeliveryItem>),
  suffix: string,
  opts: { expects?: ReceiptExpectation[]; def?: ChannelDef } = {},
): Promise<'delivered' | 'abandoned' | 'deferred'> {
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
    if (!isDuplicateKey(e)) throw e;
  }

  if (!reserved) {
    const existing = await DeliveryReceipts.findOneAsync(receiptId);
    if (!existing || existing.state === 'sent') return 'delivered';
    if (existing.state === 'abandoned') return 'abandoned';
    // Mid-`sending`: a crash between post and confirm, or a concurrent worker
    // still in flight. Under `deliverBinding` the claim serializes workers per
    // binding, so "concurrent" is over and this is the crash case; a one-shot
    // caller is serialized by its own guard (the inbound event claim, the loop
    // lease). Either way: apply the declared recovery.
    const mode = uncertainDeliveryMode(def);
    if (mode === 'abandon') {
      await settleReceipt(receiptId, 'abandoned');
      return 'abandoned';
    }
    if (mode === 'reconcile' && def.transport.reconcile) {
      const landed = await def.transport.reconcile(binding.destination, receiptId);
      if (landed) {
        await settleReceipt(receiptId, 'sent');
        return 'delivered';
      }
    }
    // 'retry' (tier A: the provider collapses the repeated key; tier C: the
    // channel DECLARED it accepts possible duplicates) — but on a SCHEDULE.
    // A receipt that keeps failing is given up after MAX_DELIVERY_ATTEMPTS
    // (abandoned; the cursor moves on), and between attempts it waits a
    // doubling backoff measured from its last attempt — so a deterministic
    // rejection neither hammers the provider every sweep nor wedges the
    // conversation forever. `deferred` tells the caller to stop here and
    // leave the cursor where it is.
    if (existing.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await settleReceipt(receiptId, 'abandoned');
      return 'abandoned';
    }
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, existing.attempts - 1), BACKOFF_MAX_MS);
    if (Date.now() - existing.at.getTime() < wait) return 'deferred';
    await DeliveryReceipts.updateAsync(receiptId, { $inc: { attempts: 1 }, $set: { at: new Date() } });
  }

  // POST. A lens may return several payloads (a segmented SMS); each gets its
  // own provider-side key — one shared key would make a tier-A provider
  // collapse the segments into one.
  //
  // A thunk is resolved only here, on the POST path — side effects a
  // rendering needs (a `link` channel's per-choice verdict tokens) must not
  // run on a re-sweep that finds the receipt already settled or backed off.
  const resolved = typeof item === 'function' ? await item() : item;
  const rendered = def.lens.out(resolved, binding.destination);
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

  // CONFIRM.
  await settleReceipt(receiptId, 'sent', providerMessageId);
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
      const outcome = await deliverOnce(kind, binding, row.item, row.message._id, { def });
      // A deferred row is in its backoff window: stop here, cursor unmoved,
      // and let a later sweep retry it. Rows behind it wait — in-order
      // delivery is the contract.
      if (outcome === 'deferred') return;
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
    // `link` channels mint the per-choice verdict URLs here — LAZILY, as a
    // thunk deliverOnce runs only on its POST path. Each token is a live
    // single-use capability; minting eagerly would issue two per sweep per
    // parked ask, forever, while the receipt is already `sent`.
    const withUrls = async () => {
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
      return prompt;
    };
    await deliverOnce(kind, binding, withUrls, `prompt:${prompt.toolCallId}`, {
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
      console.error(`[10thfloor:agent] egress(${kind}): delivery failed for binding ${redact(bindingId)}:`, e);
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
    // Only bindings active within the lookback — see `sweepLookbackMs`.
    const since = new Date(Date.now() - (opts.sweepLookbackMs ?? 24 * 60 * 60_000));
    const bindings = await ChannelBindings.find(
      { kind, updatedAt: { $gt: since } }, { fields: { _id: 1 } },
    ).fetchAsync();
    for (const b of bindings) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await deliver(b._id).catch((e) => {
        console.error(`[10thfloor:agent] egress(${kind}): sweep delivery failed for binding ${redact(b._id)}:`, e);
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
