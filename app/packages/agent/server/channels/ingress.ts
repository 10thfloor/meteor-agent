import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from '../../common/collections';
import { getAgent } from '../registry';
import { recordVerdict, sendToSession, type ViaIdentity } from '../methods';
import {
  humanParticipantId, participantByIdentity, participantByUserId,
} from '../../common/participants';
import { addParticipant } from '../participants';
import {
  ChannelBindings, DeliveryReceipts, InboundSubmissions, insertOrLose,
  type ChannelBinding,
  receiptIdFor, promptSuffix,
} from './collections';
import { LINK_GESTURE, matchExpectation, type InboundReading } from '../../common/channel-contract';
import { admitInboundAttachments } from '../attachments';
import { resolveInboundAttachments } from './media';
import type { AttachmentRef } from '../../common/types';
import { deliverOnce } from './egress';
import { issueLinkToken, resolveIdentity } from './linking';
import { getChannel, listChannels, type ChannelDef, type RawInbound } from './registry';

/* Ingress (§9): verify → lens.in → throttle → claim → route.
 * Provider-specific logic lives in def.verify/def.parse and the lens;
 * everything after the reading is generic. */

interface InboundResponse { status: number; body?: string }

// ---- The per-sender throttle (§9 step 3) -----------------------------------

/** Per-sender sliding windows, before the admission claim — flood costs
 *  counters, not DB writes. Settles 200 (429 would invite retries). */
const windows = new Map<string, { hits: number[]; intervalMs: number }>();
const PRUNE_EVERY = 512;
let callsSincePrune = 0;

function pruneWindows(now: number): void {
  for (const [key, w] of windows) {
    const newest = w.hits[w.hits.length - 1];
    if (newest === undefined || now - newest >= w.intervalMs) windows.delete(key);
  }
}

function throttled(key: string, limit: number, intervalMs: number): boolean {
  const now = Date.now();
  if ((callsSincePrune += 1) >= PRUNE_EVERY) {
    callsSincePrune = 0;
    pruneWindows(now);
  }
  const hits = (windows.get(key)?.hits ?? []).filter((t) => now - t < intervalMs);
  const over = hits.length >= limit;
  if (!over) hits.push(now);
  windows.set(key, { hits, intervalMs });
  return over;
}

/** TEST SEAM: throttle state is process-lifetime, and a test must not inherit
 *  the previous test's windows. */
export function _clearThrottle(): void {
  windows.clear();
  callsSincePrune = 0;
}

/** TEST SEAM: how many senders the throttle is currently tracking, and a way
 *  to force the sweep — the bound is the property under test. */
export function _throttleStats(now = Date.now()): { tracked: number } {
  pruneWindows(now);
  return { tracked: windows.size };
}

// ---- Binding first, session second (§6.2 / §9) -----------------------------

/** Binding first, session second: the loser of a two-server race catches
 *  a duplicate key having created nothing. Session-first would orphan. */
async function bindConversation(
  kind: string, def: ChannelDef, conversationRef: string, reading: InboundReading,
  identity: { userId: string; assurance: 'link' | 'oidc' } | null,
): Promise<ChannelBinding | null> {
  const binding = await findOrCreateBinding(kind, def, conversationRef, reading, identity);
  if (!binding) return null;
  return (await ensureSession(kind, binding)) ? binding : null;
}

async function findOrCreateBinding(
  kind: string, def: ChannelDef, conversationRef: string, reading: InboundReading,
  identity: { userId: string; assurance: 'link' | 'oidc' } | null,
): Promise<ChannelBinding | null> {
  const bindingId = `${kind}:${conversationRef}`;

  let binding = await ChannelBindings.findOneAsync(bindingId);
  if (!binding) {
    const sessionId = Random.id();
    // Win or lose, the next read is the same: the race's loser adopts the
    // winner's binding, having created nothing.
    await insertOrLose(ChannelBindings, {
      _id: bindingId,
      kind,
      conversationRef,
      destination: reading.destination ?? null,
      // Default 'group' — the SAFE direction for §8.5's capability-URL rule.
      audience: reading.audience ?? 'group',
      agent: def.agent,
      sessionId,
      userId: identity?.userId ?? null,
      // The OPENER's proof strength, recorded at bind time so a later
      // repair-on-entry (`ensureSession`) stamps the session with the owner's
      // assurance — not that of whoever happens to trigger the repair.
      assurance: identity?.assurance ?? 'none',
      ...(reading.externalUserId !== undefined
        ? { externalUserId: reading.externalUserId } : {}),
      // The channel's declared admission posture for NEW conversations
      // (participants spec decision 11); absent reads 'opener', v1 verbatim.
      ...(def.admits !== undefined ? { admits: def.admits } : {}),
      deliveredSeq: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    binding = await ChannelBindings.findOneAsync(bindingId);
    if (!binding) return null;
  } else {
    // Activity bump for the egress sweep's lookback window. Destination
    // adoption deliberately happens AFTER admission in `route`.
    await ChannelBindings.updateAsync(bindingId, { $set: { updatedAt: new Date() } });
  }
  return binding;
}

/** Repair-on-entry: create the session the binding names if it doesn't
 *  exist yet (first contact, or the winner crashed between its two writes). */
async function ensureSession(kind: string, binding: ChannelBinding): Promise<boolean> {
  const config = getAgent(binding.agent);
  if (!config) {
    console.warn(
      `[10thfloor:agent] channel "${kind}": a binding names unregistered agent `
      + `"${binding.agent}"; dropping the event`,
    );
    return false;
  }
  const existing = await AgentSessions.findOneAsync(binding.sessionId);
  if (existing?.erasingAt) return false;
  if (!existing) {
    // A binding deleted/fenced by Session erasure must never repair its old
    // capability id back into a live Session.
    const liveBinding = await ChannelBindings.findOneAsync({
      _id: binding._id, erasingAt: { $exists: false },
    });
    if (!liveBinding || liveBinding.sessionId !== binding.sessionId) return false;
    // A lost insert is another server's repair winning — fine either way.
    await insertOrLose(AgentSessions, {
      _id: binding.sessionId,
      agent: binding.agent,
      userId: binding.userId,
      phase: 'idle',
      model: config.model,
      nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      // The OWNER's assurance, from the binding — not the current sender's.
      channel: { origin: kind, assurance: binding.assurance ?? 'none' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return true;
}

// ---- Free text against an outstanding prompt (§8.3) ------------------------

/** Free text matches a verdict grammar only when an approval prompt is
 *  currently parked on this binding. Receipt lookup by toolCallId is the
 *  staleness guard; the single-winner verdict write is the final authority. */
async function verdictFromExpects(
  binding: ChannelBinding, text: string,
): Promise<'approved' | 'denied' | null> {
  const session = await AgentSessions.findOneAsync(binding.sessionId);
  const pending = session?.pending;
  if (!session || session.phase !== 'awaiting' || !pending || pending.verdict) return null;
  const receipt = await DeliveryReceipts.findOneAsync(
    receiptIdFor(binding._id, promptSuffix(pending.toolCallId)),
  );
  if (!receipt?.expects) return null;
  const match = matchExpectation(text, receipt.expects);
  if (!match) return null;
  if (match.toolCallId !== pending.toolCallId) return null;   // invariant: expects built for this ask
  return match.verdict;
}

// ---- The pipeline ----------------------------------------------------------

/** The whole webhook as a function — §9's five steps. Throws only on
 *  unexpected failures; the claim is released so the provider's retry works. */
export async function handleInbound(kind: string, raw: RawInbound): Promise<InboundResponse> {
  const def = getChannel(kind);
  if (!def) return { status: 404 };

  // 1. VERIFY — the trust boundary. Everything after this line believes the
  // event came from the provider; nothing before it has spent anything.
  if (!(await def.verify(raw))) return { status: 401 };

  // 2. INTERPRET — a lens failure settles 200, not 500 (a 500 invites retries).
  let reading: InboundReading;
  try {
    reading = def.lens.in(def.parse(raw));
  } catch {
    // A lens may throw with parsed provider/user content in its message. Keep
    // the operational signal without copying that content into server logs.
    console.warn(`[10thfloor:agent] channel "${kind}": lens could not interpret a verified event`);
    return { status: 200 };
  }

  // A noop settles immediately — and may carry a provider-mandated echo
  // (Slack's URL-verification challenge rides `reading.respond`).
  if (reading.intent.kind === 'noop') return { status: 200, body: reading.respond };

  // 3. THROTTLE — dropped with a 200, not 429 (providers retry non-2xx).
  const t = def.throttle ?? { limit: 30, intervalMs: 60_000 };
  const sender = reading.externalUserId ?? reading.conversationRef ?? 'unknown';
  if (throttled(`${kind}:${sender}`, t.limit, t.intervalMs)) return { status: 200 };

  // 4. CLAIM the event id — deduplicated admission (§11). A provider retry
  // collides on the derived _id and is answered 200 without running twice.
  const claimId = reading.eventId !== undefined ? `${kind}:${reading.eventId}` : null;
  if (claimId && !(await insertOrLose(InboundSubmissions, { _id: claimId, at: new Date() }))) {
    return { status: 200 };   // already admitted
  }

  // 5. ROUTE — release the claim on crash so the provider's retry works.
  try {
    return await route(kind, def, reading);
  } catch (e) {
    if (claimId) {
      await InboundSubmissions.removeAsync(claimId).catch(() => { /* best effort */ });
    }
    throw e;
  }
}

/** What an admitted event acts as: the resolved account (or null), plus the
 *  trusted `via` principal when the sender's standing is a channel identity
 *  in the roster rather than an account. */
type Admission = { userId: string | null; via?: ViaIdentity } | 'refused';

/** Admission precedence: anonymous opener → owner → roster → auto-join
 *  (if admits:'linked') → refused. */
async function admitSender(
  kind: string, binding: ChannelBinding, reading: InboundReading,
  identity: { userId: string; assurance: 'link' | 'oidc' } | null,
): Promise<Admission> {
  const sender = reading.externalUserId;

  if (binding.userId === null) {
    const opener = binding.externalUserId;
    if (opener !== undefined && sender !== opener) return 'refused';
    // On a member binding the opener isn't the session owner — return a `via`
    // principal so the message is attributed correctly.
    if (sender !== undefined
      && (binding.member || (binding.admits !== undefined && binding.admits !== 'opener'))) {
      const session = await AgentSessions.findOneAsync(binding.sessionId);
      if (session && participantByIdentity(session, kind, sender)) {
        return { userId: identity?.userId ?? null, via: { kind, externalUserId: sender } };
      }
    }
    return { userId: identity?.userId ?? null };
  }

  if (identity && identity.userId === binding.userId) {
    return { userId: identity.userId };
  }

  const admits = binding.admits ?? 'opener';
  if (admits === 'opener' || sender === undefined) return 'refused';

  const session = await AgentSessions.findOneAsync(binding.sessionId);
  if (!session) return 'refused';

  if (identity && participantByUserId(session, identity.userId)) {
    return { userId: identity.userId };
  }
  if (participantByIdentity(session, kind, sender)) {
    return { userId: identity?.userId ?? null, via: { kind, externalUserId: sender } };
  }
  if (admits === 'linked' && identity) {
    const joined = await addParticipant(binding.sessionId, {
      id: humanParticipantId(identity.userId),
      kind: 'human',
      role: 'member',
      userId: identity.userId,
      assurance: identity.assurance,
      identity: { kind, externalUserId: sender },
      displayName: sender,
    });
    if (joined) return { userId: identity.userId };
  }
  return 'refused';
}

async function route(
  kind: string, def: ChannelDef, reading: InboundReading,
): Promise<InboundResponse> {
  const intent = reading.intent;
  if (reading.conversationRef === undefined) {
    // Routable intents need a conversation; a lens that returns none for a
    // routable intent is miswired — say so once per event, settle the event.
    console.warn(`[10thfloor:agent] channel "${kind}": ${intent.kind} with no conversationRef`);
    return { status: 200 };
  }

  // Resolve identity only for verified senders — spoofed From must not inherit a linked account.
  const identity = reading.externalUserId !== undefined && reading.senderVerified !== false
    ? await resolveIdentity(kind, reading.externalUserId)
    : null;
  const binding = await bindConversation(kind, def, reading.conversationRef, reading, identity);
  if (!binding) return { status: 200 };

  // ADMISSION — 'refused' settles silently (a refusal posted into the
  // thread is itself a spam channel).
  const admission = await admitSender(kind, binding, reading, identity);
  if (admission === 'refused') return { status: 200 };
  const { userId, via } = admission;

  // DESTINATION ADOPTION — AFTER admission so a refused stranger can't set
  // the thread's root.
  if (def.adoptDestination) {
    const merged = def.adoptDestination(binding.destination, reading.destination);
    if (merged !== undefined) {
      const adopted = await ChannelBindings.updateAsync({
        _id: binding._id,
        sessionId: binding.sessionId,
        erasingAt: { $exists: false },
      }, {
        $set: { destination: merged, updatedAt: new Date() },
      });
      // A stale webhook must not mutate a replacement binding that reused the
      // provider's deterministic conversation id after Session erasure.
      if (adopted !== 1) return { status: 200 };
      binding.destination = merged;
    }
  }

  try {
    if (intent.kind === 'message') {
      // Free text answers an outstanding prompt first (§8.3), else it is a
      // send. The verdict write's single-winner selector remains the backstop.
      const verdict = await verdictFromExpects(binding, intent.text);
      if (verdict) {
        await recordVerdict(
          { userId }, binding.agent, binding.sessionId, verdict,
          verdict === 'denied' ? intent.text : undefined,
        );
        return { status: 200 };
      }

      // Attachments (§6): resolve remote refs, apply caps, store what passes,
      // bracket-note each rejection. Runs AFTER the admission claim so
      // provider retries during a slow fetch collide harmlessly.
      let text = intent.text;
      let refs: AttachmentRef[] | undefined;
      if (def.attachments !== false && reading.attachments?.length) {
        const capBase = def.attachments || undefined;
        const resolved = await resolveInboundAttachments(
          reading.attachments, def.media, capBase,
        );
        const admitted = await admitInboundAttachments(
          binding.sessionId, resolved.files, capBase,
        );
        if (admitted.refs.length > 0) refs = admitted.refs;
        const notes = [...resolved.notes, ...admitted.notes];
        if (notes.length > 0) {
          text = [text, ...notes].filter((s) => s !== '').join('\n');
        }
      }
      if (text === '' && !refs) return { status: 200 };
      await sendToSession(
        binding.agent, binding.sessionId, text, userId,
        (refs || via) ? {
          ...(refs ? { attachments: refs } : {}),
          // Trusted principal for channel-identified members (decision 12).
          ...(via ? { via } : {}),
        } : undefined,
      );
      return { status: 200 };
    }

    if (intent.kind === 'verdict') {
      // A native postback. The staleness guard (§8.3): a click that names an
      // ask no longer parked decides nothing.
      if (intent.toolCallId !== undefined) {
        const session = await AgentSessions.findOneAsync(binding.sessionId);
        if (session?.pending?.toolCallId !== intent.toolCallId) return { status: 200 };
      }
      await recordVerdict(
        { userId }, binding.agent, binding.sessionId, intent.verdict, intent.reason,
      );
      return { status: 200 };
    }

    // link-request. The URL is a credential — only travels to a `direct`
    // destination; groups get a hint instead.
    if (!def.linkUrl || reading.externalUserId === undefined) return { status: 200 };
    if (binding.audience !== 'direct') {
      const outcome = await deliverOnce(binding, {
        item: 'reply',
        text: `To link your account, send me the word "${LINK_GESTURE}" in a direct message — not here.`,
      }, `link-hint:${reading.eventId ?? reading.externalUserId}`);
      if (outcome !== 'delivered') {
        console.warn(`[10thfloor:agent] channel "${kind}": link hint not delivered (${outcome})`);
      }
      return { status: 200 };
    }
    const token = await issueLinkToken(kind, reading.externalUserId);
    const outcome = await deliverOnce(binding, {
      item: 'reply',
      text: `To link this conversation to your account, open: ${def.linkUrl(token)}`,
    }, `link:${reading.eventId ?? token}`);
    if (outcome !== 'delivered') {
      // Not a seq row — no sweep retries it; the user can send "link" again.
      console.warn(`[10thfloor:agent] channel "${kind}": link reply not delivered (${outcome}); nothing retries it`);
    }
    return { status: 200 };
  } catch (e) {
    // Meteor.Errors are settled refusals (no-session, over budget, nothing
    // pending) — answer 200. Only unexpected failures propagate to 500.
    if (e instanceof Meteor.Error) {
      console.warn(
        `[10thfloor:agent] channel "${kind}": ${intent.kind} refused `
        + `(${String(e.error)}); the event is settled`,
      );
      return { status: 200 };
    }
    throw e;
  }
}

// ---- The mount -------------------------------------------------------------

/** Cap on webhook bodies — read before full raw-body verification, so without
 *  it a channel lacking header pre-verification could stream GB into memory. */
export const MAX_INBOUND_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() { super('request body over MAX_INBOUND_BYTES'); }
}

/** Read the body UNPARSED (signature schemes sign raw bytes). Capped by
 *  `maxInboundBytes` or `MAX_INBOUND_BYTES`. */
function readRawBody(req: any, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Refuse a truthful oversize length before buffering anything.
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLarge());
      return;
    }
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes) {
        // Close the socket immediately.
        req.destroy();
        reject(new BodyTooLarge());
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Mount every registered channel on Meteor's connect handler. Called from
 *  `Meteor.startup`, after all `Agent.channel(...)` registrations. */
export function mountChannelRoutes(webAppHandlers: {
  use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void {
  for (const [kind, def] of listChannels()) {
    const maxBytes = def.maxInboundBytes ?? MAX_INBOUND_BYTES;
    webAppHandlers.use(`/agent/channels/${kind}`, (req: any, res: any) => {
      void (async () => {
        try {
          // `originalUrl`: express strips the mount prefix from `req.url`,
          // but signatures need the full path.
          const url = req.originalUrl ?? req.url;
          const head = {
            headers: req.headers ?? {},
            ...(url ? { url } : {}),
          };
          if (def.preverify) {
            let allowed = false;
            try {
              allowed = await def.preverify(head);
            } catch {
              // A verifier exception may contain credential/provider content.
              // Fail closed and log only the failure category.
              console.warn(`[10thfloor:agent] channel "${kind}" webhook pre-verification failed closed`);
            }
            if (!allowed) {
              res.writeHead(401, { 'content-type': 'text/plain' });
              res.end('');
              // Drain without buffering so a keep-alive connection remains
              // usable while an attacker cannot grow process memory.
              if (typeof req.resume === 'function') req.resume();
              return;
            }
          }
          const rawBody = await readRawBody(req, maxBytes);
          const out = await handleInbound(kind, {
            ...head, rawBody,
          });
          res.writeHead(out.status, { 'content-type': 'text/plain' });
          res.end(out.body ?? '');
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            // Socket may already be destroyed; writing is best-effort.
            try { res.writeHead(413); res.end(); } catch { /* socket gone */ }
            return;
          }
          // Request/parser/provider exceptions may carry body or credential
          // content. Keep the signal generic at this trust boundary.
          console.error(`[10thfloor:agent] channel "${kind}" webhook failed`);
          res.writeHead(500);
          res.end();
        }
      })();
    });
  }
}
