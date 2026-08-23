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
import type { AttachmentRef } from '../../common/types';
import { deliverOnce } from './egress';
import { issueLinkToken, resolveIdentity } from './linking';
import { getChannel, listChannels, type ChannelDef, type RawInbound } from './registry';

/**
 * Ingress (channels spec §9): one provider-free pipeline every channel shares.
 *
 *   verify signature → lens.in(event) → throttle → claim eventId → route
 *
 * Everything provider-specific happens inside `def.verify`/`def.parse` and the
 * lens; everything after the reading is generic. The core is `handleInbound` —
 * a plain function over `{ headers, rawBody }` returning a status — so the
 * whole pipeline is testable without an HTTP server; `mountChannelRoutes` is
 * the thin express glue that feeds it.
 */

interface InboundResponse { status: number; body?: string }

// ---- The per-sender throttle (§9 step 3) -----------------------------------

/** In-memory sliding windows, per process: the brake on a flood, deliberately
 *  BEFORE the admission claim — the throttle is a counter, the claim is a
 *  database write, and validly-signed junk must not buy an insert each. A
 *  throttled event is settled with a 200 and forgotten — it buys neither a
 *  write nor a provider retry (see the handler: a 429 would be a failure the
 *  provider retries and holds against the integration).
 *
 *  Bounded by CONCURRENT senders, not history: every `PRUNE_EVERY` calls the
 *  map is swept and any key whose newest hit has aged out of its own window
 *  is dropped, so a phone number that texted once last month does not hold
 *  an entry forever. (Only signature-verified senders ever create a key —
 *  the throttle runs after `verify` — so an anonymous flood cannot grow it;
 *  the sweep is about long-lived processes, not attackers.) */
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

/**
 * Find or create the binding for one external conversation. The ORDER is the
 * point: insert the binding FIRST with a pre-generated sessionId, create the
 * session only after winning that insert. The loser of a two-server race
 * catches the duplicate key having created NOTHING, and adopts the winner's
 * binding — whereas session-first would orphan a session on every lost race.
 *
 * `findOrCreateBinding` wins or adopts the binding; `ensureSession` then
 * repairs the session it names.
 */
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
    // Activity bump: the egress sweep only walks RECENTLY active bindings
    // (its lookback is what keeps a process's sweep cost proportional to live
    // conversations, not history), so every inbound event marks its binding.
    await ChannelBindings.updateAsync(bindingId, { $set: { updatedAt: new Date() } });
  }
  return binding;
}

/**
 * Repair-on-entry: create the session the binding names if it does not
 * exist yet — first contact, or the winner crashed between its two writes and
 * this pass repairs it on the next message (the loop's own repair-on-entry
 * ethos). The EXACT document `agent.start` builds, field for field, plus the
 * additive channel descriptor (§5.2) — the loop, the lease and the watcher
 * all read this shape.
 */
async function ensureSession(kind: string, binding: ChannelBinding): Promise<boolean> {
  const config = getAgent(binding.agent);
  if (!config) {
    console.warn(
      `[10thfloor:agent] channel "${kind}": the binding for session ${binding.sessionId} names `
      + `unregistered agent "${binding.agent}"; dropping the event`,
    );
    return false;
  }
  const existing = await AgentSessions.findOneAsync(binding.sessionId);
  if (!existing) {
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

/**
 * "YES" from a phone number is a verdict ONLY IF an approval prompt is
 * outstanding on that binding — otherwise it is a message. The receipt is the
 * memory of what was offered, looked up by the CURRENTLY parked toolCallId —
 * that lookup is the staleness guard: last week's prompt receipt is never
 * consulted. The `toolCallId` check on the match is a belt-and-braces
 * invariant (exported `deliverOnce` callers build their own `expects`); and
 * beneath both, the single-winner verdict write remains the final authority.
 */
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

/**
 * The whole webhook, as a function — §9's five steps in order. Returns the
 * HTTP answer; throws only on a genuinely unexpected failure — the claim is
 * RELEASED on the way out (the catch below) so the provider's retry can try
 * again, and the mount answers 500.
 */
export async function handleInbound(kind: string, raw: RawInbound): Promise<InboundResponse> {
  const def = getChannel(kind);
  if (!def) return { status: 404 };

  // 1. VERIFY — the trust boundary. Everything after this line believes the
  // event came from the provider; nothing before it has spent anything.
  if (!(await def.verify(raw))) return { status: 401 };

  // 2. INTERPRET — pure: raw → provider event → reading. No side effects yet.
  // A VERIFIED event the lens cannot interpret (a user-craftable callback
  // payload of literal `null`, a shape the provider added last week) must
  // SETTLE, not 500: a 500 invites the provider's retry loop, and a lens bug
  // must never become a channel-wide outage. Logged once per event, answered
  // 200, forgotten.
  let reading: InboundReading;
  try {
    reading = def.lens.in(def.parse(raw));
  } catch (e) {
    console.warn(`[10thfloor:agent] channel "${kind}": lens could not interpret a verified event:`, e);
    return { status: 200 };
  }

  // A noop settles immediately — and may carry a provider-mandated echo
  // (Slack's URL-verification challenge rides `reading.respond`).
  if (reading.intent.kind === 'noop') return { status: 200, body: reading.respond };

  // 3. THROTTLE — per sender, before the claim buys a write. Throttled events
  // are DROPPED with a 200, not refused with a 429: providers retry non-2xx
  // (Slack up to three times, Twilio likewise) and count failures toward
  // disabling the integration, so a 429 would let one abusive sender degrade
  // the whole channel. Settled and forgotten is the safe answer.
  const t = def.throttle ?? { limit: 30, intervalMs: 60_000 };
  const sender = reading.externalUserId ?? reading.conversationRef ?? 'unknown';
  if (throttled(`${kind}:${sender}`, t.limit, t.intervalMs)) return { status: 200 };

  // 4. CLAIM the event id — exactly-once admission (§11). A provider retry
  // collides on the derived _id and is answered 200 without running twice.
  const claimId = reading.eventId !== undefined ? `${kind}:${reading.eventId}` : null;
  if (claimId && !(await insertOrLose(InboundSubmissions, { _id: claimId, at: new Date() }))) {
    return { status: 200 };   // already admitted
  }

  // 5. ROUTE by intent. Failures past the claim would strand the event as
  // "admitted but never acted on", so the claim is RELEASED on the way out of
  // a crash and the provider's retry gets a clean run.
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

/**
 * The admission precedence (participants spec decision 11), one order:
 *
 *   1. An ANONYMOUS conversation admits only its recorded opener — v1's
 *      guard, verbatim, before anything else and regardless of `admits`.
 *      It fires regardless of `audience`: email's conversationRef is a THREAD
 *      key, so a Cc'd or reply-all party lands on the opener's binding with a
 *      different `From`, and admitting them would be impersonation by
 *      proximity (approving someone else's parked ask). The rare legitimate
 *      case — the opener replying from a second address before linking — is
 *      refused too: the safe direction, resolved the moment they link.
 *   2. The OWNER — a resolved account equal to the binding's — passes as
 *      today.
 *   3. A NON-OWNER passes only through a `members`/`linked` binding, and only
 *      through the roster: an account member by their userId, a
 *      channel-identified member through the trusted `via` principal —
 *      REGARDLESS of `senderVerified`, deliberately (participants spec §5):
 *      most legitimate mail lacks author-aligned DKIM, and requiring it would
 *      silently strand the composed loop. What the tradeoff costs is one
 *      attributed, powerless message from a From-spoofer who also knows the
 *      reply key; what verification still gates is ACCOUNT resolution, above.
 *   4. `admits: 'linked'` grows the roster: a sender with a LINKED identity
 *      auto-joins as a member on first message (the group-thread acquisition
 *      path), capped by the roster like any join.
 *   5. Everyone else settles — including, under the default `'opener'`, a
 *      roster member: the binding gates ingress, the roster gates DDP.
 */
async function admitSender(
  kind: string, binding: ChannelBinding, reading: InboundReading,
  identity: { userId: string; assurance: 'link' | 'oidc' } | null,
): Promise<Admission> {
  const sender = reading.externalUserId;

  if (binding.userId === null) {
    const opener = binding.externalUserId;
    if (opener !== undefined && sender !== opener) return 'refused';
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

  // Identity resolution is gated on the channel VOUCHING for the sender's
  // claimed id (§12). Provider-authenticated surfaces (SMS/WhatsApp/Slack/
  // Telegram) leave `senderVerified` undefined — the provider already proved
  // the number or account, so the external id is trustworthy to map to a
  // linked account. Email is forgeable: its lens sets `senderVerified: false`
  // unless the inbound mail passed author-aligned DKIM, and an UNVERIFIED
  // sender must never resolve to a linked identity — else a spoofed `From:`
  // inherits the victim's account (send AND approve, as the owner). An
  // unverified sender still drives its OWN anonymous conversation (below);
  // it just cannot become someone who linked.
  const identity = reading.externalUserId !== undefined && reading.senderVerified !== false
    ? await resolveIdentity(kind, reading.externalUserId)
    : null;
  const binding = await bindConversation(kind, def, reading.conversationRef, reading, identity);
  if (!binding) return { status: 200 };

  // ADMISSION (participants spec decision 11): one precedence order decides
  // who this event acts as — or that it acts as nobody and settles. `via` is
  // the trusted ingress principal for a channel-identified member; `userId`
  // is everything requireSession's equality (and membership branch) needs for
  // the rest. 'refused' settles silently: a refusal posted into the thread is
  // itself a spam channel.
  const admission = await admitSender(kind, binding, reading, identity);
  if (admission === 'refused') return { status: 200 };
  const { userId, via } = admission;

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

      // Files the event carried (email v2 spec §6): admission is CORE policy —
      // apply the channel's caps, store what passes, and append one bracket
      // note per rejected file so the model and the web transcript both see
      // exactly what the agent actually has. `attachments: false` restores
      // v1's ignore-them behavior. An attachment-only event (empty text, kept
      // files — or dropped files whose notes are the whole story) is a
      // MESSAGE now; only an event with no text, no files kept and nothing to
      // report settles without a send.
      let text = intent.text;
      let refs: AttachmentRef[] | undefined;
      if (def.attachments !== false && reading.attachments?.length) {
        const admitted = await admitInboundAttachments(
          binding.sessionId, reading.attachments, def.attachments || undefined,
        );
        if (admitted.refs.length > 0) refs = admitted.refs;
        if (admitted.notes.length > 0) {
          text = [text, ...admitted.notes].filter((s) => s !== '').join('\n');
        }
      }
      if (text === '' && !refs) return { status: 200 };
      await sendToSession(
        binding.agent, binding.sessionId, text, userId,
        (refs || via) ? {
          ...(refs ? { attachments: refs } : {}),
          // The trusted principal (participants spec decision 12): a
          // channel-identified member's standing, vouched for by this
          // admission, for exactly this send. Verdict branches never carry
          // it — channel-identified members cannot answer approvals.
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

    // link-request. The linking URL is a CREDENTIAL: whoever opens it while
    // signed in becomes this external identity's account and inherits the
    // anonymous history it created. So, exactly like the overflow URL (§8.5),
    // it only ever travels to a `direct` destination — posted into a group it
    // would let any member hijack the requester. On a group surface the
    // answer is a hint, not a token. Without a `linkUrl` there is nothing to
    // offer at all.
    if (!def.linkUrl || reading.externalUserId === undefined) return { status: 200 };
    if (binding.audience !== 'direct') {
      const outcome = await deliverOnce(binding, {
        item: 'reply',
        text: `To link your account, send me the word "${LINK_GESTURE}" in a direct message — not here.`,
      }, `link-hint:${reading.eventId ?? reading.externalUserId}`);
      if (outcome !== 'delivered') {
        console.warn(`[10thfloor:agent] channel "${kind}": link hint for session ${binding.sessionId} not delivered (${outcome})`);
      }
      return { status: 200 };
    }
    const token = await issueLinkToken(kind, reading.externalUserId);
    const outcome = await deliverOnce(binding, {
      item: 'reply',
      text: `To link this conversation to your account, open: ${def.linkUrl(token)}`,
    }, `link:${reading.eventId ?? token}`);
    if (outcome !== 'delivered') {
      // Link replies are not seq rows, so no sweep retries them: say so, and
      // the user can send "link" again (a fresh eventId, a fresh receipt).
      console.warn(`[10thfloor:agent] channel "${kind}": link reply for session ${binding.sessionId} not delivered (${outcome}); nothing retries it`);
    }
    return { status: 200 };
  } catch (e) {
    // The agent-facing calls refuse with Meteor.Errors that are SETTLED facts
    // about this event — not-yours (`no-session`), out of budget, nothing
    // pending. A provider retry would meet the identical refusal forever, so
    // answer 200 and log; only unexpected failures propagate to the 500/
    // release path in `handleInbound`.
    if (e instanceof Meteor.Error) {
      // The session id, never the binding id: binding ids embed the
      // conversation key, which for SMS/WhatsApp is a phone number — PII that
      // has no business in a log line.
      console.warn(
        `[10thfloor:agent] channel "${kind}": ${intent.kind} for session ${binding.sessionId} `
        + `refused (${String(e.error)}); the event is settled`,
      );
      return { status: 200 };
    }
    throw e;
  }
}

// ---- The mount -------------------------------------------------------------

/**
 * The most a webhook body may be. Every provider's payload is small (a Slack
 * event envelope is a few KB; Twilio's form a few hundred bytes), and this
 * read happens BEFORE signature verification — so without a cap an
 * unauthenticated sender could stream gigabytes into process memory. Over
 * the cap the socket is closed and the request answered 413, having spent
 * nothing but the bytes already buffered.
 */
export const MAX_INBOUND_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() { super('request body over MAX_INBOUND_BYTES'); }
}

/** Read the whole request body UNPARSED: signature schemes sign raw bytes, and
 *  a re-serialized body never verifies. Capped — `MAX_INBOUND_BYTES` unless
 *  the channel declared its own ceiling (`maxInboundBytes` — email's webhook
 *  legitimately carries tens of MB of base64'd attachments). */
function readRawBody(req: any, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Honor a declared length first: a truthful oversize client is refused
    // before a single chunk is buffered.
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
        // Stop reading and close the socket — do not keep buffering while a
        // lying client streams past its declared length.
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

/**
 * Mount every registered channel at `/agent/channels/<kind>` on Meteor's
 * connect/express handler stack. Called from the package's `Meteor.startup`
 * (server/index.ts), by which point every app-file `Agent.channel(...)` has
 * run — startup callbacks fire after all code loads.
 */
export function mountChannelRoutes(webAppHandlers: {
  use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void {
  for (const [kind, def] of listChannels()) {
    const maxBytes = def.maxInboundBytes ?? MAX_INBOUND_BYTES;
    webAppHandlers.use(`/agent/channels/${kind}`, (req: any, res: any) => {
      void (async () => {
        try {
          const rawBody = await readRawBody(req, maxBytes);
          // `originalUrl`, not `url`: under `handlers.use('/agent/channels/<kind>', fn)`
          // express strips the mount prefix from `req.url`, and `RawInbound.url`
          // promises the path+query as Node saw it (a signature that covers the
          // full webhook URL needs the real path). The fallback is for a bare
          // Node request with no express in front.
          const url = req.originalUrl ?? req.url;
          const out = await handleInbound(kind, {
            headers: req.headers ?? {}, rawBody,
            ...(url ? { url } : {}),
          });
          res.writeHead(out.status, { 'content-type': 'text/plain' });
          res.end(out.body ?? '');
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            // Not an error worth a stack trace — and not a 500 a provider
            // would retry. The socket may already be destroyed; writing is
            // best-effort.
            try { res.writeHead(413); res.end(); } catch { /* socket gone */ }
            return;
          }
          console.error(`[10thfloor:agent] channel "${kind}" webhook failed:`, e);
          res.writeHead(500);
          res.end();
        }
      })();
    });
  }
}

