import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from '../../common/collections';
import { getAgent } from '../registry';
import { recordVerdict, sendToSession } from '../methods';
import {
  ChannelBindings, DeliveryReceipts, InboundSubmissions, isDuplicateKey,
  type ChannelBinding,
} from './collections';
import { matchExpectation } from './contract';
import type { InboundReading } from './contract';
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
 *  throttled provider retry simply retries later and collides with the claim
 *  then. Keys are pruned as they empty, so the map is bounded by concurrent
 *  senders, not history. */
const windows = new Map<string, number[]>();

function throttled(key: string, limit: number, intervalMs: number): boolean {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < intervalMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return true;
  }
  hits.push(now);
  windows.set(key, hits);
  return false;
}

/** TEST SEAM: throttle state is process-lifetime, and a test must not inherit
 *  the previous test's windows. */
export function _clearThrottle(): void {
  windows.clear();
}

// ---- Binding first, session second (§6.2 / §9) -----------------------------

/**
 * Find or create the binding for one external conversation. The ORDER is the
 * point: insert the binding FIRST with a pre-generated sessionId, create the
 * session only after winning that insert. The loser of a two-server race
 * catches the duplicate key having created NOTHING, and adopts the winner's
 * binding — whereas session-first would orphan a session on every lost race.
 *
 * A winner that crashes between the two writes leaves a binding whose session
 * does not exist yet; the `ensureSession` pass below repairs it on the next
 * message — the loop's own repair-on-entry ethos.
 */
async function upsertBinding(
  kind: string, def: ChannelDef, reading: InboundReading,
  identity: { userId: string; assurance: 'link' | 'oidc' } | null,
): Promise<ChannelBinding | null> {
  const ref = reading.conversationRef!;
  const bindingId = `${kind}:${ref}`;

  let binding = await ChannelBindings.findOneAsync(bindingId);
  if (!binding) {
    const sessionId = Random.id();
    try {
      await ChannelBindings.insertAsync({
        _id: bindingId,
        kind,
        conversationRef: ref,
        destination: reading.destination ?? null,
        // Default 'group' — the SAFE direction for §8.5's capability-URL rule.
        audience: reading.audience ?? 'group',
        agent: def.agent,
        sessionId,
        userId: identity?.userId ?? null,
        ...(reading.externalUserId !== undefined
          ? { externalUserId: reading.externalUserId } : {}),
        deliveredSeq: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // The race's loser: adopt the winner's binding, having created nothing.
    }
    binding = await ChannelBindings.findOneAsync(bindingId);
    if (!binding) return null;
  }

  // Repair-on-entry: create the session the binding names if it does not
  // exist yet (first contact, or the winner crashed between its two writes).
  // The EXACT document `agent.start` builds, field for field, plus the
  // additive channel descriptor (§5.2) — the loop, the lease and the watcher
  // all read this shape.
  const config = getAgent(binding.agent);
  if (!config) {
    console.warn(
      `[10thfloor:agent] channel "${kind}": binding ${bindingId} names `
      + `unregistered agent "${binding.agent}"; dropping the event`,
    );
    return null;
  }
  const existing = await AgentSessions.findOneAsync(binding.sessionId);
  if (!existing) {
    try {
      await AgentSessions.insertAsync({
        _id: binding.sessionId,
        agent: binding.agent,
        userId: binding.userId,
        phase: 'idle',
        model: config.model,
        nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        channel: { origin: kind, assurance: identity?.assurance ?? 'none' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;   // another server's repair won — fine
    }
  }
  return binding;
}

// ---- Free text against an outstanding prompt (§8.3) ------------------------

/**
 * "YES" from a phone number is a verdict ONLY IF an approval prompt is
 * outstanding on that binding — otherwise it is a message. The receipt is the
 * memory of what was offered; the `toolCallId` guard drops a match whose ask
 * is no longer the parked one; and beneath both, the single-winner verdict
 * write remains the final authority.
 */
async function verdictFromExpects(
  binding: ChannelBinding, text: string,
): Promise<'approved' | 'denied' | null> {
  const session = await AgentSessions.findOneAsync(binding.sessionId);
  const pending = session?.pending;
  if (!session || session.phase !== 'awaiting' || !pending || pending.verdict) return null;
  const receipt = await DeliveryReceipts.findOneAsync(
    `deliver:${binding._id}:prompt:${pending.toolCallId}`,
  );
  if (!receipt?.expects) return null;
  const match = matchExpectation(text, receipt.expects);
  if (!match) return null;
  if (match.toolCallId !== pending.toolCallId) return null;   // a stale grammar
  return match.verdict;
}

// ---- The pipeline ----------------------------------------------------------

/**
 * The whole webhook, as a function — §9's five steps in order. Returns the
 * HTTP answer; throws only on a genuinely unexpected failure (the mount
 * answers 500 and RELEASES the admission claim so the provider's retry can
 * try again — see `handleInbound`'s catch).
 */
export async function handleInbound(kind: string, raw: RawInbound): Promise<InboundResponse> {
  const def = getChannel(kind);
  if (!def) return { status: 404 };

  // 1. VERIFY — the trust boundary. Everything after this line believes the
  // event came from the provider; nothing before it has spent anything.
  if (!(await def.verify(raw))) return { status: 401 };

  // 2. INTERPRET — pure: raw → provider event → reading. No side effects yet.
  const reading = def.lens.in(def.parse(raw));

  // A noop settles immediately — and may carry a provider-mandated echo
  // (Slack's URL-verification challenge rides `reading.respond`).
  if (reading.intent.kind === 'noop') return { status: 200, body: reading.respond };

  // 3. THROTTLE — per sender, before the claim buys a write.
  const t = def.throttle ?? { limit: 30, intervalMs: 60_000 };
  const sender = reading.externalUserId ?? reading.conversationRef ?? 'unknown';
  if (throttled(`${kind}:${sender}`, t.limit, t.intervalMs)) return { status: 429 };

  // 4. CLAIM the event id — exactly-once admission (§11). A provider retry
  // collides on the derived _id and is answered 200 without running twice.
  const eventId = reading.eventId;
  let claimId: string | null = null;
  if (eventId !== undefined) {
    claimId = `${kind}:${eventId}`;
    try {
      await InboundSubmissions.insertAsync({ _id: claimId, at: new Date() });
    } catch (e) {
      if (isDuplicateKey(e)) return { status: 200 };   // already admitted
      throw e;
    }
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

  const identity = reading.externalUserId !== undefined
    ? await resolveIdentity(kind, reading.externalUserId)
    : null;
  const binding = await upsertBinding(kind, def, reading, identity);
  if (!binding) return { status: 200 };

  // The identity the agent-facing calls run under. `requireSession` stays the
  // authority: a sender whose identity does not own the bound session gets
  // `no-session`, which settles as 200 below — the channel is a courier, not
  // an authority.
  const userId = identity?.userId ?? binding.userId ?? null;

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
      await sendToSession(binding.agent, binding.sessionId, intent.text, userId);
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

    // link-request: mint the one-time token and offer it on the SAME surface
    // the request came from — idempotent per event via the receipt, like any
    // other delivery. Without a `linkUrl` there is nothing to offer.
    if (!def.linkUrl || reading.externalUserId === undefined) return { status: 200 };
    const token = await issueLinkToken(kind, reading.externalUserId);
    await deliverOnce(kind, binding, {
      item: 'reply',
      text: `To link this conversation to your account, open: ${def.linkUrl(token)}`,
    }, `link:${reading.eventId ?? token}`, { def });
    return { status: 200 };
  } catch (e) {
    // The agent-facing calls refuse with Meteor.Errors that are SETTLED facts
    // about this event — not-yours (`no-session`), out of budget, nothing
    // pending. A provider retry would meet the identical refusal forever, so
    // answer 200 and log; only unexpected failures propagate to the 500/
    // release path in `handleInbound`.
    if (e instanceof Meteor.Error) {
      console.warn(
        `[10thfloor:agent] channel "${kind}": ${intent.kind} for ${binding._id} `
        + `refused (${String(e.error)}); the event is settled`,
      );
      return { status: 200 };
    }
    throw e;
  }
}

// ---- The mount -------------------------------------------------------------

/** Read the whole request body UNPARSED: signature schemes sign raw bytes, and
 *  a re-serialized body never verifies. */
function readRawBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
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
  for (const [kind] of listChannels()) {
    webAppHandlers.use(`/agent/channels/${kind}`, (req: any, res: any) => {
      void (async () => {
        try {
          const rawBody = await readRawBody(req);
          const out = await handleInbound(kind, {
            headers: req.headers ?? {}, rawBody,
            ...(req.url ? { url: req.url } : {}),
          });
          res.writeHead(out.status, { 'content-type': 'text/plain' });
          res.end(out.body ?? '');
        } catch (e) {
          console.error(`[10thfloor:agent] channel "${kind}" webhook failed:`, e);
          res.writeHead(500);
          res.end();
        }
      })();
    });
  }
}

