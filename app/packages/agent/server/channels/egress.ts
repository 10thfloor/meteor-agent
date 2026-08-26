import { createHash } from 'crypto';
import { AgentMessages, AgentSessions } from '../../common/collections';
import type { AgentSession } from '../../common/types';
import { SERVER_ID } from '../lease';
import {
  ChannelBindings, DeliveryReceipts, insertOrLose,
  type ChannelBinding, type ReceiptExpectation,
  receiptIdFor, promptSuffix,
} from './collections';
import { planItems, promptItem, type PlannedRow } from './plan';
import { expectationsFor } from '../../common/channel-contract';
import { hydrateRefs } from '../attachments';
import { issueVerdictToken } from './linking';
import { getChannel, uncertainDeliveryMode, type ChannelDef } from './registry';
import { VERDICT_FOR, type DeliveryItem } from '../../common/channel-contract';

/** Egress worker: one per channel kind, observer + timed sweep.
 *  All multi-server races resolve through atomic conditional writes. */

export interface EgressOptions {
  /** How often the sweep runs. Default 15s; tests lower it. */
  sweepMs?: number;
  /** How long a delivery claim lasts. Renewed per row; default 30s. */
  claimMs?: number;
  /** How far back the sweep looks (default 24h). Bounds sweep cost to live
   *  conversations. The observer handles fresh rows on older bindings. */
  sweepLookbackMs?: number;
}

/** Retry backoff for mid-sending receipts. Caps prevent infinite re-posting. */
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

/** Cursor advance — guarded on claim + expected `fromSeq` (single-winner). */
export async function advanceCursor(
  bindingId: string, fromSeq: number, toSeq: number, serverId = SERVER_ID,
): Promise<boolean> {
  const n = await ChannelBindings.updateAsync(
    { _id: bindingId, 'claim.serverId': serverId, deliveredSeq: fromSeq },
    { $set: { deliveredSeq: toSeq, updatedAt: new Date() } },
  );
  return n === 1;
}

/** Audience rule for the overflow URL: members get none; anonymous sessions
 *  only to direct destinations (the URL is a capability). */
function overflowUrlFor(
  def: ChannelDef, binding: ChannelBinding, session: AgentSession,
): string | undefined {
  if (!def.sessionUrl) return undefined;
  if (binding.member) return undefined;
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

/** Three-phase delivery: reserve → post → confirm. Receipt-keyed for
 *  idempotency. Returns delivered/abandoned/deferred. Throws on transport
 *  failure (the next sweep retries). Exported for tool-body idempotency. */

/** What `deliverOnce` reads from a binding — a real row satisfies it; a
 *  synthetic one is these three fields and nothing more. */
export type DeliverableBinding = Pick<ChannelBinding, '_id' | 'kind' | 'destination'>;

export async function deliverOnce(
  binding: DeliverableBinding,
  item: DeliveryItem | (() => Promise<DeliveryItem>),
  suffix: string,
  opts: {
    expects?: ReceiptExpectation[];
    /** The transport/lens/tier to deliver through, when the caller holds them
     *  directly (compose). Default: the registry's def for `binding.kind`. */
    def?: Pick<ChannelDef, 'transport' | 'lens' | 'onUncertainDelivery'>;
  } = {},
): Promise<'delivered' | 'abandoned' | 'deferred'> {
  const def = opts.def ?? getChannel(binding.kind);
  if (!def) throw new Error(`[10thfloor:agent] deliverOnce: unknown channel "${binding.kind}"`);
  const receiptId = receiptIdFor(binding._id, suffix);

  // RESERVE. The duplicate-key loser reads the winner's state instead of
  // posting: `sent`/`abandoned` are settled; `sending` is the one ambiguous
  // state, resolved per the channel's declared tier (§11).
  const reserved = await insertOrLose(DeliveryReceipts, {
    _id: receiptId, bindingId: binding._id, state: 'sending',
    ...(opts.expects && opts.expects.length > 0 ? { expects: opts.expects } : {}),
    attempts: 1, at: new Date(),
  });

  if (!reserved) {
    const existing = await DeliveryReceipts.findOneAsync(receiptId);
    if (!existing || existing.state === 'sent') return 'delivered';
    if (existing.state === 'abandoned') return 'abandoned';
    // Mid-`sending`: crash between post and confirm — apply declared recovery.
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
    // Retry on a doubling backoff schedule; give up after MAX_DELIVERY_ATTEMPTS.
    // `deferred` means the backoff window has not elapsed yet.
    if (existing.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await settleReceipt(receiptId, 'abandoned');
      return 'abandoned';
    }
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, existing.attempts - 1), BACKOFF_MAX_MS);
    if (Date.now() - existing.at.getTime() < wait) return 'deferred';
    await DeliveryReceipts.updateAsync(receiptId, { $inc: { attempts: 1 }, $set: { at: new Date() } });
  }

  // POST. Thunk resolved only here so side effects (verdict tokens) never run
  // on a re-sweep that finds the receipt already settled.
  const resolved = typeof item === 'function' ? await item() : item;
  const rendered = def.lens.out(resolved, binding.destination);
  const payloads = Array.isArray(rendered) ? rendered : [rendered];
  let providerMessageId: string | undefined;
  for (let i = 0; i < payloads.length; i += 1) {
    // Segment 0 carries the bare receipt id — that is the key `reconcile`
    // looks for; later segments are suffixed so a tier-A provider does not
    // collapse them.
    const key = i === 0 ? receiptId : `${receiptId}:${i}`;
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

/** Hydrate attachments lazily (only on the POST path). Expired refs become
 *  bracket notes rather than stalling delivery. */
function deliverable(
  binding: ChannelBinding, row: PlannedRow,
): DeliveryItem | (() => Promise<DeliveryItem>) {
  const item = row.item!;
  const refs = row.message.attachments;
  if (!refs?.length || (item.item !== 'reply' && item.item !== 'overflow')) return item;
  return async () => {
    const { attachments, missing } = await hydrateRefs(binding.sessionId, refs);
    const note = missing
      .map((r) => `\n[the file "${r.name}" expired before this could be delivered]`)
      .join('');
    const files = attachments.length > 0 ? { attachments } : {};
    return item.item === 'reply'
      ? { ...item, text: `${item.text}${note}`, ...files }
      : { ...item, head: `${item.head}${note}`, ...files };
  };
}

/** Deliver one binding's backlog: claim, plan, post, advance cursor,
 *  then offer any parked prompt. */
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
    // Member bindings receive outward replies and overflow ONLY (participants
    // spec decision 14): status notes are the owner's operational telemetry
    // (errors, approval outcomes), not a correspondent's business.
    statuses: binding.member ? undefined : def.statuses,
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
      const outcome = await deliverOnce(binding, deliverable(binding, row), row.message._id);
      // A deferred row is in its backoff window: stop here, cursor unmoved,
      // and let a later sweep retry it. Rows behind it wait — in-order
      // delivery is the contract.
      if (outcome === 'deferred') return;
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await advanceCursor(bindingId, cursor, row.message.seq))) return;
    cursor = row.message.seq;
  }

  // Parked ask, once per toolCallId. Never to a member binding — the prompt's
  // verdict URLs would hand approval authority to an outsider.
  const prompt = binding.member ? null : promptItem(session, def.profile);
  if (prompt) {
    // Verdict URLs minted lazily — only on deliverOnce's POST path.
    const withUrls = async () => {
      if (def.profile.interact === 'link' && def.approvalUrl) {
        for (const choice of prompt.choices) {
          // eslint-disable-next-line no-await-in-loop
          const token = await issueVerdictToken(
            binding.agent, binding.sessionId, prompt.toolCallId, VERDICT_FOR[choice.token],
          );
          choice.url = def.approvalUrl(token);
        }
      }
      return prompt;
    };
    await deliverOnce(binding, withUrls, promptSuffix(prompt.toolCallId), {
      expects: expectationsFor(prompt),
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
    chain = chain.then(() => deliver(bindingId)).catch(() => {
      // A failed delivery is the next sweep's business; an unhandled
      // rejection is fatal by default on Node >= 15.
      console.error(`[10thfloor:agent] egress(${kind}): delivery failed for binding ${redact(bindingId)}`);
    });
  };

  /** Re-attempt every active binding. Also the only path that notices a
   *  parked prompt or an expired claim from another server. */
  const sweep = async (): Promise<void> => {
    // Only bindings active within the lookback — see `sweepLookbackMs`.
    const since = new Date(Date.now() - (opts.sweepLookbackMs ?? 24 * 60 * 60_000));
    const bindings = await ChannelBindings.find(
      { kind, updatedAt: { $gt: since } }, { fields: { _id: 1 } },
    ).fetchAsync();
    for (const b of bindings) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await deliver(b._id).catch(() => {
        console.error(`[10thfloor:agent] egress(${kind}): sweep delivery failed for binding ${redact(b._id)}`);
      });
    }
  };

  let sweeping: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || sweeping) return;   // never overlap: a slow sweep skips a tick
    sweeping = sweep()
      .catch(() => {
        console.error(`[10thfloor:agent] egress(${kind}) sweep failed`);
      })
      .then(() => { sweeping = null; });
  };
  const timer = setInterval(runSweep, sweepMs);

  /** Live observer: committed rows reach surfaces within ms. `added` replays
   *  the full backlog on boot (receipts prevent re-delivery). INSERT-ONLY
   *  collection, so `changed` is unnecessary. */
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
      }).catch(() => {
        console.error(`[10thfloor:agent] egress(${kind}): binding lookup failed`);
      });
    },
  }).then((h: any) => {
    // stop() can win the race against a still-resolving observe — stop the
    // handle the moment it exists (the watcher's own guard).
    handle = h;
    if (stopped) h.stop();
    return undefined;
  }).catch(() => {
    console.error(`[10thfloor:agent] egress(${kind}): could not observe messages`);
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
