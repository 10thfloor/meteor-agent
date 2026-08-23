import { createHash } from 'crypto';
import {
  channelKnobs, headerValue, isLinkGesture, safeEqual,
  type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport,
  type DeliveryItem, type InboundReading, type Lens, type RawInbound,
} from 'meteor/10thfloor:agent';

/**
 * The email channel — Postmark as the reference provider: one lens, one
 * transport, one profile default, zero npm dependencies (Postmark is JSON
 * both ways over `fetch`; the inbound webhook's trust boundary is the
 * Basic-auth credential Postmark sends, compared in constant time).
 *
 * The five decisions, stated up front — email answers them least like the
 * chat surfaces, which is why it is worth having:
 *
 *  CONVERSATION KEY — the THREAD, recovered STATELESSLY. The first message's
 *  Message-ID is the thread root; its key is a short hash of that id. Every
 *  reply we send sets `Reply-To: <local>+<key>@<inbound domain>`, so a later
 *  reply — even from a client that drops `References` — comes back carrying
 *  the key as Postmark's `MailboxHash`. Fallback order: mailbox hash, then
 *  the first `References` entry (the root), then `In-Reply-To`, then the
 *  message's own id (a new thread). The lens never needs a lookup table.
 *
 *  IDENTITY KEY — the sender address, normalized. WEAK: a From header is
 *  forgeable unless the receiving provider enforced DKIM/SPF on the way in,
 *  and that is the provider's setting, not ours. Fine to recognize, never to
 *  privilege until linked — and linking by answering the word "link" to that
 *  very address is the classic email verification.
 *
 *  AUDIENCE — `direct`: our replies go to one address, the sender.
 *
 *  INTERACTION — `link`: approvals render as single-use Approve / Deny URLs
 *  the core mints per choice at delivery (`approvalUrl`). Without an
 *  `approvalUrl` the factory falls back to `menu` — "Reply YES to approve" —
 *  which the pipeline matches against the reply's stripped text. Both are
 *  honest email; the link form is the one that survives mail clients.
 *
 *  ECHO RULE — the email self-reply loop is auto-responder ping-pong:
 *  out-of-office replies, bounces, mailer-daemon and list traffic are noops
 *  (`Auto-Submitted`, `X-Autoreply`, `Precedence`, the daemon senders), so
 *  the agent never answers a machine that will answer it back.
 */

// ---- Threading -------------------------------------------------------------

/** The thread key: a short, address-safe hash of the root Message-ID.
 *  Normalized (no angle brackets, lower-cased, trimmed) so the same id keyed
 *  from a `References` entry and from a `Message-ID` header agree. */
export function threadKey(rootMessageId: string): string {
  const normalized = rootMessageId.trim().replace(/^<|>$/g, '').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

const THREAD_KEY = /^[0-9a-f]{24}$/;

/** `reply+<key>@inbound.example.com` — the address whose plus-hash carries
 *  the conversation back to us, whatever the client does to the headers. */
export function replyToFor(inboundAddress: string, key: string): string {
  const at = inboundAddress.lastIndexOf('@');
  if (at < 0) return inboundAddress;
  return `${inboundAddress.slice(0, at)}+${key}${inboundAddress.slice(at)}`;
}

/** `Re:` once, whatever the incoming subject carried. */
export function reSubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  if (s === '') return 'Re: (no subject)';
  return /^(re|aw|sv|vs)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** The addr-spec out of `Name <addr>` / `addr`, lower-cased. */
function addressOf(value: string | undefined): string {
  const v = (value ?? '').trim();
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}

/** Every `<id>` in a References / In-Reply-To header, brackets stripped. */
function messageIds(value: string | undefined): string[] {
  return [...(value ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
}

// ---- Quoted-reply stripping -----------------------------------------------

/**
 * The new text above a quoted reply — what the sender actually wrote.
 * Postmark's `StrippedTextReply` does this well when present; this is the
 * fallback for providers and clients that do not. Cuts at the common reply
 * markers ("On … wrote:", Outlook's "-----Original Message-----" / "From:"
 * block, the "___" rule), drops `>`-quoted lines, and trims a "-- "
 * signature. Conservative on purpose: when unsure it keeps text — a reply
 * with a stray quoted line is a message; a reply stripped to nothing is a
 * noop nobody can explain.
 */
export function stripQuotedReply(text: string): string {
  let body = text.replace(/\r\n/g, '\n');
  const markers = [
    /^On\b[^\n]{0,120}(?:\n[^\n]{0,120})?wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^_{5,}\s*$/m,
    /^From:\s.+\n(?:Sent|Date):\s.+$/m,
  ];
  let cut = body.length;
  for (const re of markers) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);
  const lines = body.split('\n').filter((l) => !/^\s*>/.test(l));
  const sig = lines.findIndex((l) => l === '-- ');
  const kept = sig >= 0 ? lines.slice(0, sig) : lines;
  return kept.join('\n').trim();
}

// ---- Status prose ----------------------------------------------------------

function statusProse(item: Extract<DeliveryItem, { item: 'status' }>): string {
  switch (item.kind) {
    case 'error':
      return `Something went wrong${item.reason ? ` (${item.reason})` : ''}. Reply to try again.`;
    case 'budget':
      return `This conversation reached its ${item.budget ?? 'usage'} limit.`;
    case 'interrupted':
      return 'The reply was stopped.';
    case 'approval':
      if (item.timedOut) return 'The approval request timed out and was denied.';
      return item.approved ? 'Approved.' : 'Denied.';
    case 'compaction':
      return 'Earlier conversation was summarized to stay within context.';
    case 'orphan-child':
      return 'A background task was recovered.';
    default:
      return `[${item.kind}]${item.reason ? ` ${item.reason}` : ''}`;
  }
}

// ---- Verify: the webhook's Basic-auth credential ---------------------------

/**
 * Postmark's inbound webhook carries no signature; the documented trust
 * boundary is HTTP Basic auth in the webhook URL (`https://user:pass@host/…`),
 * which Postmark sends as an `Authorization: Basic …` header on every post.
 * Compared in constant time; an IP allowlist at the edge is the belt to this
 * suspenders (README).
 */
export function verifyPostmarkWebhook(raw: RawInbound, user: string, password: string): boolean {
  const auth = headerValue(raw, 'authorization');
  if (!auth || !auth.startsWith('Basic ')) return false;
  const expected = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  return safeEqual(auth.slice('Basic '.length).trim(), expected);
}

// ---- Parse -----------------------------------------------------------------

export type EmailEvent =
  | { email: 'inbound'; body: any }
  | { email: 'ignore' };

export function parsePostmarkInbound(raw: RawInbound): EmailEvent {
  try {
    const body = JSON.parse(raw.rawBody);
    if (body && typeof body === 'object' && (body.FromFull || body.From)) {
      return { email: 'inbound', body };
    }
    return { email: 'ignore' };
  } catch {
    return { email: 'ignore' };
  }
}

// ---- The lens --------------------------------------------------------------

const NOOP: InboundReading = { intent: { kind: 'noop' } };

/** What the transport needs to thread a reply, fixed at bind time. `subject`
 *  and `rootMessageId` never change for the thread's life; `to` is the
 *  sender; `replyKey` is what becomes the Reply-To mailbox hash. */
export interface EmailDestination {
  to: string;
  subject: string;
  rootMessageId?: string;
  replyKey: string;
}

/** Automated senders and automated mail — the surface's echo rule. */
function isAutomated(headers: Map<string, string>, from: string): boolean {
  const auto = headers.get('auto-submitted');
  if (auto && auto.toLowerCase() !== 'no') return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  if (headers.has('x-auto-response-suppress')) return true;
  const precedence = (headers.get('precedence') ?? '').toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return true;
  return false;
}

export const emailLens: Lens = {
  out(item: DeliveryItem, destination: unknown): unknown {
    const dest = (destination ?? {}) as Partial<EmailDestination>;
    const Subject = dest.subject ?? 'Re: (no subject)';
    switch (item.item) {
      case 'reply':
        return { Subject, TextBody: item.text };
      case 'status':
        return { Subject, TextBody: statusProse(item) };
      case 'overflow':
        return {
          Subject,
          TextBody: `${item.head}${item.url ? `\n\nContinue on the web: ${item.url}` : ''}`,
        };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {}, null, 2);
        const clamped = args.length > 2000 ? `${args.slice(0, 2000)}…` : args;
        const runAs = 'runAs' in item && item.runAs !== undefined
          ? `\n(runs as: ${item.runAs ?? 'anonymous service context'})` : '';
        // Two grammars, chosen by what the planner handed us: `url` on a
        // choice (link profile — the worker minted single-use URLs) renders
        // as a link; `match` (menu profile) renders as a reply word. Each
        // choice is one line either way.
        const choices = item.choices.map((c) => {
          if (c.url) return `${c.label}: ${c.url}`;
          if (c.match) return `Reply ${c.match} to ${c.label.toLowerCase()}`;
          return c.label;
        }).join('\n');
        return {
          Subject,
          TextBody: `The agent wants to run ${item.name}:\n\n${clamped}${runAs}\n\n${choices}`,
        };
      }
      default:
        return null;
    }
  },

  in(event: unknown): InboundReading {
    const e = event as EmailEvent;
    if (!e || typeof e !== 'object' || e.email !== 'inbound') return NOOP;
    const b = e.body;

    const headers = new Map<string, string>();
    for (const h of Array.isArray(b.Headers) ? b.Headers : []) {
      if (h && typeof h.Name === 'string') headers.set(h.Name.toLowerCase(), String(h.Value ?? ''));
    }
    const from = addressOf(b.FromFull?.Email ?? b.From);
    if (from === '') return NOOP;
    if (isAutomated(headers, from)) return NOOP;

    // The new text — Postmark's stripped reply when it has one, else our own
    // strip over the plain body. No text (an HTML-only or attachment-only
    // mail) is a noop: there is nothing to send the agent.
    const stripped = String(b.StrippedTextReply ?? '').trim();
    const text = stripped !== '' ? stripped : stripQuotedReply(String(b.TextBody ?? ''));
    if (text === '') return NOOP;

    // The thread key: mailbox hash first (our own Reply-To coming back), then
    // the root of the References chain, then In-Reply-To, then this message's
    // own id — a new thread.
    const ownId = messageIds(headers.get('message-id'))[0] ?? headers.get('message-id');
    const refs = messageIds(headers.get('references'));
    const inReplyTo = messageIds(headers.get('in-reply-to'))[0];
    const mailboxHash = String(b.MailboxHash ?? b.ToFull?.[0]?.MailboxHash ?? '').trim();
    const root = refs[0] ?? inReplyTo ?? ownId ?? String(b.MessageID ?? '');
    const key = THREAD_KEY.test(mailboxHash) ? mailboxHash : threadKey(root);

    const destination: EmailDestination = {
      to: from,
      subject: reSubject(b.Subject),
      ...(root ? { rootMessageId: root.replace(/^<|>$/g, '') } : {}),
      replyKey: key,
    };
    const envelope = {
      // Postmark's inbound MessageID is stable across its webhook retries;
      // the RFC Message-ID is the fallback for a provider that lacks one.
      eventId: String(b.MessageID ?? ownId ?? ''),
      externalUserId: from,
      conversationRef: key,
      destination,
      audience: 'direct' as const,
    };
    if (isLinkGesture(text)) return { intent: { kind: 'link-request' }, ...envelope };
    return { intent: { kind: 'message', text }, ...envelope };
  },
};

// ---- The transport ---------------------------------------------------------

export interface EmailTransportOptions {
  /** Postmark Server API token (the server's "API Tokens" page). */
  serverToken: string;
  /** The From address — a verified Sender Signature or domain. */
  from: string;
  /** The inbound address whose plus-hash carries the thread key back —
   *  `inbound@yourdomain.com` (MX'd to Postmark) or the stream's
   *  `…@inbound.postmarkapp.com` address. */
  inboundAddress: string;
  /** Postmark message stream; default `outbound`. */
  messageStream?: string;
  /** TEST SEAM. */
  fetchImpl?: typeof fetch;
}

/**
 * `POST https://api.postmarkapp.com/email` — one call, JSON. The lens's
 * payload (Subject, TextBody) is spread FIRST and addressing last, so no
 * payload can redirect a post (the sweep's rule for every transport). The
 * receipt key rides a custom header; Postmark has no idempotency key on
 * send, so this channel's recovery tier is `retry` (§11 tier C, declared).
 */
export function emailTransport(options: EmailTransportOptions): ChannelTransport {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async post(destination: unknown, payload: unknown, opts: { idempotencyKey: string }) {
      const dest = (destination ?? {}) as Partial<EmailDestination>;
      const root = dest.rootMessageId ? `<${dest.rootMessageId}>` : undefined;
      const body = {
        ...(payload as Record<string, unknown>),
        From: options.from,
        To: dest.to,
        ReplyTo: dest.replyKey ? replyToFor(options.inboundAddress, dest.replyKey) : options.inboundAddress,
        MessageStream: options.messageStream ?? 'outbound',
        Headers: [
          ...(root ? [{ Name: 'In-Reply-To', Value: root }, { Name: 'References', Value: root }] : []),
          { Name: 'X-Agent-Receipt', Value: opts.idempotencyKey },
        ],
      };
      const res = await doFetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': options.serverToken,
        },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (!res.ok || (json && json.ErrorCode !== undefined && json.ErrorCode !== 0)) {
        throw new Error(`[agent-channel-email] Postmark send failed: ${json?.ErrorCode ?? res.status} ${json?.Message ?? ''}`.trim());
      }
      return { providerMessageId: json?.MessageID as string | undefined };
    },
  };
}

// ---- The factory -----------------------------------------------------------

export interface EmailChannelOptions extends ChannelKnobs {
  agent: string;
  serverToken: string;
  from: string;
  inboundAddress: string;
  /** The Basic-auth credential you put in the inbound webhook URL. */
  webhookUser: string;
  webhookPassword: string;
  /** Turns a minted verdict token into the URL an approval mail's Approve /
   *  Deny lines carry (`link` profile). Omit it and the factory falls back
   *  to the `menu` profile — "Reply YES to approve". */
  approvalUrl?: ChannelDef['approvalUrl'];
  messageStream?: string;
  /** Override `limit` only; `interact` follows from `approvalUrl`. */
  profile?: Pick<ChannelProfile, 'limit'>;
  fetchImpl?: typeof fetch;
}

export function email(options: EmailChannelOptions): ChannelDef {
  for (const k of ['agent', 'serverToken', 'from', 'inboundAddress', 'webhookUser', 'webhookPassword'] as const) {
    if (!options?.[k]) throw new Error(`[agent-channel-email] email({ ${k} }) is required`);
  }
  return {
    agent: options.agent,
    transport: emailTransport({
      serverToken: options.serverToken, from: options.from,
      inboundAddress: options.inboundAddress, messageStream: options.messageStream,
      fetchImpl: options.fetchImpl,
    }),
    lens: emailLens,
    profile: {
      interact: options.approvalUrl ? 'link' : 'menu',
      limit: options.profile?.limit ?? 20_000,
    },
    verify: (raw) => verifyPostmarkWebhook(raw, options.webhookUser, options.webhookPassword),
    parse: parsePostmarkInbound,
    statuses: options.statuses ?? ['error', 'approval'],
    ...(options.approvalUrl ? { approvalUrl: options.approvalUrl } : {}),
    ...channelKnobs(options),
  };
}
