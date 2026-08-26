import { createHash, randomBytes } from 'crypto';
import {
  Agent, AgentAttachments, AgentSessions, ChannelBindings,
  DEFAULT_ATTACHMENT_CAPS, MAX_PARTICIPANTS, channelKnobs, deliverOnce,
  getChannel, headerValue,
  insertOrLose, isLinkGesture, prettySize, resolveIdentity, safeEqual,
  type ChannelAttachment, type ChannelDef, type ChannelKnobs, type ChannelProfile,
  type ChannelTransport, type DeliveryItem, type Gate, type InboundReading,
  type InlineTool, type Lens, type RawInbound,
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
  const body = text.replace(/\r\n/g, '\n');
  const markers = [
    /^On\b[^\n]{0,120}(?:\n[^\n]{0,120})?wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^_{5,}\s*$/m,
    /^From:\s.+\n(?:Sent|Date):\s.+$/m,
  ];
  // Drop `>`-quoted lines and a trailing "-- " signature from a block of text.
  const dropQuotesAndSig = (s: string): string => {
    const lines = s.split('\n').filter((l) => !/^\s*>/.test(l));
    const sig = lines.findIndex((l) => l === '-- ');
    return (sig >= 0 ? lines.slice(0, sig) : lines).join('\n').trim();
  };

  // TOP-POSTED — the common case: the new words sit ABOVE the first reply
  // marker. Cut at the earliest marker and keep what's before it.
  const cut = markers.reduce((c, re) => {
    const m = re.exec(body);
    return m && m.index < c ? m.index : c;
  }, body.length);
  const above = dropQuotesAndSig(body.slice(0, cut));
  if (above !== '') return above;

  // BOTTOM-POSTED — the quote (and its "On … wrote:" / "From:/Sent:"
  // attribution line) comes first with the new text UNDERNEATH, so cutting at
  // the marker left nothing. Delete the marker lines themselves and keep
  // whatever unquoted text remains below. This is the case the old code lost:
  // a reply is a message, and a "YES" bottom-posted under the quote must not
  // vanish into a noop nobody can explain (or an unanswerable approval).
  const withoutMarkers = markers.reduce((s, re) => s.replace(re, ''), body);
  return dropQuotesAndSig(withoutMarkers);
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

/**
 * Whether the mail's `From` was authenticated by the receiving provider —
 * the gate on letting this sender resolve to a LINKED account (a raw From is
 * forgeable SMTP; an unverified one must stay anonymous, per the header
 * comment). Postmark exposes no dedicated auth field: it runs SpamAssassin on
 * inbound mail and reports the verdicts in `X-Spam-Tests` (a comma/space
 * list). `DKIM_VALID_AU` is the token that matters — a DKIM signature that is
 * valid AND aligned to the AUTHOR (the From domain), i.e. the From was not
 * forged. `SPF_PASS` is deliberately NOT accepted: SPF authenticates the
 * envelope return-path, not the header From, so it does not prove the From a
 * human reads (and a spoofer's own domain passes its own SPF). An absent
 * header — SpamAssassin disabled on the stream, or a provider that does not
 * emit it — reads as UNVERIFIED: fail closed, the sender is treated
 * anonymously and simply cannot inherit a linked account (see the README).
 */
export function isFromAuthenticated(headers: Map<string, string>): boolean {
  const tests = headers.get('x-spam-tests') ?? '';
  return /(^|[,\s])DKIM_VALID_AU([,\s]|$)/.test(tests);
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
    // Email is the surface that carries real BYTES (email v2 spec §8): a
    // file-bearing reply/overflow renders Postmark's `Attachments` field —
    // which also satisfies the naming clause (the `Name` field IS the name).
    // The item arrives hydrated; a lens never fetches.
    const files = (item.item === 'reply' || item.item === 'overflow') && item.attachments?.length
      ? {
        Attachments: item.attachments.map((a) => ({
          Name: a.name, Content: a.content, ContentType: a.contentType,
        })),
      }
      : {};
    switch (item.item) {
      case 'reply':
        // A file with no cover note still needs a body — Postmark refuses an
        // empty TextBody, and a deterministic provider rejection would burn
        // MAX_DELIVERY_ATTEMPTS on a healthy message.
        return {
          Subject,
          TextBody: item.text === '' && 'Attachments' in files
            ? 'The file is attached.' : item.text,
          ...files,
        };
      case 'status':
        return { Subject, TextBody: statusProse(item) };
      case 'overflow':
        return {
          Subject,
          TextBody: `${item.head}${item.url ? `\n\nContinue on the web: ${item.url}` : ''}`,
          ...files,
        };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {}, null, 2);
        const clamped = args.length > 2000 ? `${args.slice(0, 2000)}…` : args;
        // The tool's own account of the call (participants spec §8) leads
        // when the park hydrated one — an approver reads names and sizes
        // first; the raw args stay underneath as the exact record of what
        // was asked.
        const display = item.display ? `${item.display}\n\n` : '';
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
          TextBody: `The agent wants to run ${item.name}:\n\n${display}${clamped}${runAs}\n\n${choices}`,
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

    // Files the mail carried (email v2 spec §6): pass through what Postmark
    // delivered — `Content` is already base64 — minus inline `ContentID`
    // entries, which are overwhelmingly signature furniture. `ContentLength`
    // is advisory; admission recomputes sizes from the actual bytes. CAPS ARE
    // NOT THE LENS'S JOB — the pipeline applies the channel's caps and notes
    // what it drops; this only translates.
    const attachments: ChannelAttachment[] = (Array.isArray(b.Attachments) ? b.Attachments : [])
      .filter((a: any) => a && typeof a.Content === 'string'
        && !(typeof a.ContentID === 'string' && a.ContentID !== ''))
      .map((a: any) => ({
        name: String(a.Name ?? 'file'),
        contentType: String(a.ContentType ?? 'application/octet-stream'),
        size: Number(a.ContentLength ?? 0) || 0,
        content: String(a.Content),
      }));

    // The new text — Postmark's stripped reply when it has one, else our own
    // strip over the plain body. The v1 noop rule sharpens (email v2 spec
    // §6): NEITHER text NOR attachments is a noop. An attachment-only mail —
    // a person answering "can you check this?" with just the file — is a
    // message now, carried as empty text plus the files.
    const stripped = String(b.StrippedTextReply ?? '').trim();
    const text = stripped !== '' ? stripped : stripQuotedReply(String(b.TextBody ?? ''));
    if (text === '' && attachments.length === 0) return NOOP;

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
      // A raw From is forgeable; the core may only resolve it to a LINKED
      // account when the provider authenticated it (author-aligned DKIM).
      // Unverified mail still routes — it just stays anonymous.
      senderVerified: isFromAuthenticated(headers),
      conversationRef: key,
      destination,
      audience: 'direct' as const,
    };
    if (isLinkGesture(text)) return { intent: { kind: 'link-request' }, ...envelope };
    return {
      intent: { kind: 'message', text },
      ...envelope,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
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
  /**
   * The RFC 3834 class stamped on outbound mail. `auto-replied` (default) is
   * the reactive channel's answer-to-a-message; COMPOSE stamps
   * `auto-generated` — a machine-sent mail that OPENS a correspondence rather
   * than answering one. Both suppress well-behaved auto-responders, and our
   * own inbound `isAutomated` drops any echo of either.
   */
  autoSubmitted?: 'auto-replied' | 'auto-generated';
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
          // RFC 3834: mark our own mail as machine-generated. A well-behaved
          // remote auto-responder suppresses replying to auto-submitted mail,
          // and our OWN inbound `isAutomated` reads this exact header — so a
          // reply that loops back to us is dropped and the ping-pong the header
          // comment promises "never forms" actually cannot.
          { Name: 'Auto-Submitted', Value: options.autoSubmitted ?? 'auto-replied' },
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
  // Shape, not just presence: the inbound address's plus-hash is how every
  // reply threads back, so a value with no local-part@domain would silently
  // un-thread the channel (and Postmark rejects a malformed Reply-To on the
  // first send). Fail at construction, where the fix is obvious.
  if (options.inboundAddress.lastIndexOf('@') < 1) {
    throw new Error('[agent-channel-email] email({ inboundAddress }) must be a full address (local-part@domain) — its plus-hash is how replies thread back');
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
    preverify: (raw) => verifyPostmarkWebhook(
      { ...raw, rawBody: '' }, options.webhookUser, options.webhookPassword,
    ),
    verify: (raw) => verifyPostmarkWebhook(raw, options.webhookUser, options.webhookPassword),
    parse: parsePostmarkInbound,
    // Destination adoption (participants spec §5): a compose pre-bind stores
    // no rootMessageId (Postmark's send response id is not the RFC header),
    // so the FIRST admitted reply teaches the binding its threading root —
    // and the re-subjected subject line with it. A destination that already
    // knows its root keeps it: the thread's root never moves.
    adoptDestination: (bound: unknown, incoming: unknown) => {
      const b = (bound ?? {}) as Partial<EmailDestination>;
      const inc = (incoming ?? {}) as Partial<EmailDestination>;
      if (b.rootMessageId || !inc.rootMessageId) return undefined;
      return { ...b, rootMessageId: inc.rootMessageId, subject: inc.subject ?? b.subject };
    },
    statuses: options.statuses ?? ['error', 'approval'],
    // Postmark delivers up to 35 MB of cumulative attachments base64'd INSIDE
    // the webhook JSON (~47 MB encoded, plus bodies and headroom). The shared
    // 1 MB default would 413 the whole mail — text included — so email raises
    // its own ceiling; admission caps still decide what is KEPT. An app knob
    // of the same name (channelKnobs, spread below) wins.
    maxInboundBytes: 50 * 1024 * 1024,
    ...(options.approvalUrl ? { approvalUrl: options.approvalUrl } : {}),
    ...channelKnobs(options),
  };
}

// ---- Compose — the tool (email v2 spec §9) ---------------------------------

/**
 * The recipient POLICY — the one decision compose refuses to default (§7's
 * rule survives contact with a destination parameter: the model PROPOSES
 * `to`; trusted app code decides):
 *
 *   `'linked'`   — addresses in `ChannelIdentities` belonging to the SESSION'S
 *                  OWNER (kind `'email'`). Covers "email it to me"; an
 *                  anonymous session has no linked addresses and every
 *                  recipient is refused.
 *   `string[]`   — an explicit allowlist, compared case-insensitively.
 *   a predicate  — `(to, { sessionId, userId }) => boolean`, sync or async.
 *                  A predicate that THROWS refuses (fail closed).
 */
export type ComposeRecipientsPolicy =
  | 'linked'
  | string[]
  | ((to: string, session: { sessionId: string; userId: string | null }) =>
    boolean | Promise<boolean>);

export interface ComposeEmailToolOptions {
  /** The same thin transport the channel uses — compose depends on the
   *  TRANSPORT, not on the channel registration; an app can list this tool
   *  with no email channel registered at all (§2 decision 6). `'continue'`
   *  is the one mode that needs the registration — see `onReply`. */
  serverToken: string;
  from: string;
  /** Where a recipient's REPLY lands. `'fresh'` (the default): composed mail
   *  replies-to the PLAIN inbound address — no thread key — so their answer
   *  starts its own fresh conversation (email v2 decision 8). `'continue'`
   *  supersedes it (participants spec §5). */
  inboundAddress: string;
  messageStream?: string;
  fetchImpl?: typeof fetch;
  /** REQUIRED — no permissive default exists. See `ComposeRecipientsPolicy`. */
  recipients: ComposeRecipientsPolicy;
  /** Default `'ask'`: every compose parks for approval unless the app
   *  explicitly loosens it. The parked prompt shows `to`, `subject`, `body`
   *  and the ref ids through the existing prompt rendering. */
  gate?: Gate;
  /**
   * What a recipient's reply does (participants spec §5, superseding email
   * v2 decision 8). `'fresh'` (the default): the reply opens its own new
   * conversation. `'continue'`: the send mints the thread key decision 8
   * withheld, pre-binds the conversation to the COMPOSING session (a
   * `member: true` binding — outward replies only, no prompts, no capability
   * URLs), and joins the recipient to the roster — their reply continues
   * this session, attributed. NAMED LOUDLY: 'continue' turns the session
   * into a group conversation; every subsequent outward reply is delivered
   * to the recipient. It requires the `kind` channel to be REGISTERED (the
   * reply needs a webhook to arrive through) and refuses — structured,
   * model-routable — inside throwaway (`Agent.ask`) and subagent-child
   * sessions, whose lifetimes cannot honor a promised correspondence.
   */
  onReply?: 'fresh' | 'continue';
  /** The registered channel KIND whose webhook carries `'continue'` replies —
   *  kinds are app-chosen strings, so it cannot be assumed. Default 'email'.
   *  The registered channel's inboundAddress must be THIS tool's
   *  `inboundAddress`, or the minted Reply-To points at a webhook that will
   *  never see the reply. */
  kind?: string;
  name?: string;
  description?: string;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function recipientAllowed(
  policy: ComposeRecipientsPolicy, to: string,
  session: { sessionId: string; userId: string | null },
): Promise<boolean> {
  try {
    if (policy === 'linked') {
      if (session.userId === null) return false;
      const identity = await resolveIdentity('email', to);
      return identity?.userId === session.userId;
    }
    if (Array.isArray(policy)) {
      return policy.some((a) => a.trim().toLowerCase() === to);
    }
    return (await policy(to, session)) === true;
  } catch {
    return false;   // a broken policy must not mail anyone
  }
}

/**
 * A tool factory: compose and send a NEW email — the §7 side-action pattern
 * with the one parameter §7 forbids (a destination) handled the only
 * acceptable way: validated by app-authored policy, gated `'ask'` by default.
 *
 *   tools: [composeEmailTool({
 *     serverToken, from: 'Agent <agent@ourdomain.com>', inboundAddress,
 *     recipients: (to) => to.endsWith('@ourco.com'),
 *   })]
 *
 * Effectively-once through the existing three-phase receipt log: the tool
 * passes `deliverOnce` a SYNTHETIC binding keyed on the tool call
 * (`compose:email:<toolCallId>`), so the crash-recovery re-run of a dispatched
 * tool finds the receipt settled and does not re-send — §7's "idempotency key
 * carried through to the tool itself", verbatim.
 *
 * What compose is NOT: a reply path. The worker already delivers the turn's
 * answer to the conversation's own surfaces; composing to the person you are
 * talking to is the double-delivery trap. The description says so to the model.
 */
export function composeEmailTool(options: ComposeEmailToolOptions): InlineTool {
  for (const k of ['serverToken', 'from', 'inboundAddress'] as const) {
    if (!options?.[k]) throw new Error(`[agent-channel-email] composeEmailTool({ ${k} }) is required`);
  }
  if (options.recipients === undefined || options.recipients === null) {
    throw new Error(
      '[agent-channel-email] composeEmailTool requires a `recipients` policy — an '
      + 'unconfigured compose tool that mails anyone the model names would ship a '
      + "prompt-injection hole. Pass 'linked', an allowlist array, or a predicate.",
    );
  }
  const transport = emailTransport({
    serverToken: options.serverToken,
    from: options.from,
    inboundAddress: options.inboundAddress,
    messageStream: options.messageStream,
    // A mail that OPENS a correspondence, not one answering a message.
    autoSubmitted: 'auto-generated',
    fetchImpl: options.fetchImpl,
  });
  // Everything deliverOnce needs, supplied directly — no channel registration
  // required. Postmark has no send idempotency key, so the tier is `retry`
  // (declared): a crash in the post-confirm window may re-send.
  const def = { transport, lens: emailLens, onUncertainDelivery: 'retry' as const };

  const continueMode = options.onReply === 'continue';
  const kind = options.kind ?? 'email';

  return {
    name: options.name ?? 'compose_email',
    description: options.description
      ?? 'Compose and send a NEW email to a specific address. Use this only to reach '
      + 'someone this conversation is not already talking to — the person you are '
      + 'conversing with receives your replies automatically, and composing to them '
      + 'would deliver twice. The recipient must be allowed by the application\'s '
      + 'policy; a refusal comes back as { refused: true } — do not retry the same '
      + 'address. `attachments` takes ids of files already in this conversation.'
      + (continueMode
        ? ' A successful send JOINS the recipient to this conversation: their '
        + 'replies arrive here, and your future replies — including the one you '
        + 'write after this call — are delivered to them too.'
        : ''),
    args: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The recipient address' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text body' },
        attachments: {
          type: 'array', items: { type: 'string' },
          description: 'Attachment ids (att…) from this conversation to include',
        },
      },
      required: ['to', 'subject', 'body'],
    },
    gate: options.gate ?? 'ask',
    // Approval legibility (participants spec §8): the approver reads the
    // recipient, the subject, a head of the body, and each attachment by NAME
    // and size — resolved session-scoped at park time, so the ref ids stop
    // leaking into approval prompts. Advisory: `run` re-validates everything
    // (policy, refs, caps) after the verdict, exactly as before.
    async describe(args: { to?: string; subject?: string; body?: string; attachments?: string[] }, ctx) {
      const to = String(args.to ?? '').trim().toLowerCase();
      const subject = String(args.subject ?? '');
      const body = String(args.body ?? '');
      const head = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      const ids = Array.isArray(args.attachments)
        ? args.attachments.filter((x): x is string => typeof x === 'string')
        : [];
      const names: string[] = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const row = await AgentAttachments.findOneAsync({ _id: id, sessionId: ctx.sessionId });
        names.push(row ? `${row.name} (${prettySize(row.size)})` : `${id} (not found)`);
      }
      const filesLine = names.length > 0
        ? `\nFiles: ${names.join(', ')}` : '';
      const joins = continueMode
        ? `\nA send JOINS ${to} to this conversation: they will receive future replies here.`
        : '';
      return `Email ${to} — "${subject}"${filesLine}${joins}\n\n${head}`;
    },
    async run(args: { to: string; subject: string; body: string; attachments?: string[] }, ctx) {
      const to = String(args.to ?? '').trim().toLowerCase();
      if (!EMAIL_SHAPE.test(to)) return { refused: true, reason: 'invalid-recipient' };
      const session = { sessionId: ctx.sessionId, userId: ctx.userId };
      if (!(await recipientAllowed(options.recipients, to, session))) {
        return { refused: true, reason: 'recipient-not-allowed', to };
      }

      // Refs → hydrated files, SESSION-SCOPED: an id from another conversation
      // reads as missing. The model supplies ids to files trusted code already
      // holds; it never supplies bytes.
      const ids = Array.isArray(args.attachments)
        ? args.attachments.filter((x): x is string => typeof x === 'string')
        : [];
      const files: ChannelAttachment[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const row = await AgentAttachments.findOneAsync({ _id: id, sessionId: ctx.sessionId });
        if (row) {
          files.push({
            name: row.name, contentType: row.contentType, size: row.size, content: row.content,
          });
        } else missing.push(id);
      }
      const caps = DEFAULT_ATTACHMENT_CAPS;
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (files.length > caps.maxFiles || total > caps.maxTotalBytes) {
        return {
          refused: true,
          reason: 'attachments-over-limit',
          detail: `${files.length} files, ${prettySize(total)} — the limits are ${caps.maxFiles} files / ${prettySize(caps.maxTotalBytes)}`,
        };
      }

      // `'continue'` preconditions (participants spec §5), checked BEFORE the
      // send: the reply path must exist (the kind's webhook), and the session
      // must be one a correspondence can point at — not a throwaway about to
      // be deleted, not a subagent's private child.
      let composing: { agent: string; userId: string | null; nextSeq: number } | null = null;
      if (continueMode) {
        if (!getChannel(kind)) {
          return {
            refused: true,
            reason: 'reply-channel-unregistered',
            detail: `onReply 'continue' needs the '${kind}' channel registered — its webhook is where the reply arrives.`,
          };
        }
        const session = await AgentSessions.findOneAsync(ctx.sessionId);
        if (!session) return { refused: true, reason: 'session-gone' };
        if (session.ephemeral || session.parent) {
          return {
            refused: true,
            reason: 'session-cannot-continue',
            detail: 'This session cannot hold a continued correspondence '
              + '(it is a throwaway or a subagent child); send without onReply, '
              + 'or compose from a real conversation.',
          };
        }
        // Roster capacity, BEFORE the send (a reviewer-confirmed phantom): a
        // full roster with the binding still inserted would mail the
        // recipient every future reply while silently refusing every answer
        // they send — told they joined, never actually admitted.
        const alreadyMember = session.participants?.some(
          (p) => p.identity?.kind === kind && p.identity.externalUserId === to,
        ) ?? false;
        if (!alreadyMember
          && (session.participants?.length ?? 0) >= MAX_PARTICIPANTS) {
          return {
            refused: true,
            reason: 'roster-full',
            detail: `This conversation already has ${MAX_PARTICIPANTS} participants; `
              + 'nobody else can join it. Send without onReply, or remove a participant first.',
          };
        }
        // The deliveredSeq SNAPSHOT rides this read, BEFORE the send: the
        // recipient's mailbox starts at the composed message, never the
        // session's backlog.
        composing = { agent: session.agent, userId: session.userId, nextSeq: session.nextSeq };
      }

      // The thread key `'continue'` mints — and `'fresh'` (decision 8)
      // withholds. Derived from SESSION + RECIPIENT, never the toolCallId
      // alone (only unique within one provider response — the attachment
      // store's deviation-3 lesson): a crash-recovery re-run AND a second
      // compose to the same address both collide into the SAME conversation.
      const replyKey = continueMode ? threadKey(`compose:${ctx.sessionId}:${to}`) : '';
      const destination: EmailDestination = {
        to, subject: String(args.subject ?? ''), replyKey,
      };
      // The receipt id derives from the TOOL CALL: dispatch's crash-recovery
      // re-run collides on it and reads the settled receipt instead of
      // re-sending. A caller outside dispatch (a test driving run directly,
      // with no toolCallId) gets a random key — and no idempotency, which is
      // exactly what "no idempotency key" should cost.
      const binding = {
        _id: `compose:email:${ctx.toolCallId ?? randomBytes(9).toString('hex')}`,
        kind: 'email',
        destination,
      };
      const item: DeliveryItem = {
        item: 'reply',
        text: String(args.body ?? ''),
        ...(files.length > 0 ? { attachments: files } : {}),
      };
      const outcome = await deliverOnce(binding, item, 'send', { def });
      if (outcome === 'delivered') {
        // The loop closes on a CONFIRMED send only (participants spec §5) —
        // an abandoned mail must not leave a phantom participant receiving
        // every future reply. Both writes are idempotent (derived binding id,
        // guarded roster push), which is what closes the crash window between
        // the settled receipt and here: the dispatch re-run completes them.
        if (continueMode && composing) {
          await insertOrLose(ChannelBindings, {
            _id: `${kind}:${replyKey}`,
            kind,
            conversationRef: replyKey,
            // Replies WE send into this conversation thread as "Re:" of the
            // composed subject; the rootMessageId arrives with the
            // recipient's first reply (destination adoption, the factory).
            destination: { to, subject: reSubject(destination.subject), replyKey },
            audience: 'direct',
            agent: composing.agent,
            // The COMPOSING session's owner — pinned so claim-history's
            // `userId: null` sweep can never re-own this session to the
            // recipient (its member exclusion is the belt to this brace).
            userId: composing.userId,
            sessionId: ctx.sessionId,
            // The recipient IS this conversation's opener; with `admits:
            // 'members'` their roster row is what admits their replies.
            externalUserId: to,
            assurance: 'none',
            admits: 'members',
            member: true,
            participant: `x:${kind}:${to}`,
            // Delivery starts at the composed message: everything already in
            // the session is history the recipient was not part of.
            deliveredSeq: Math.max(0, composing.nextSeq - 1),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          const joinedId = await Agent.participants.add(ctx.sessionId, {
            id: `x:${kind}:${to}`,
            kind: 'human',
            role: 'member',
            userId: null,
            identity: { kind, externalUserId: to },
            assurance: 'none',
            displayName: to,
          }, { by: `m:${composing.agent}` });
          if (joinedId === null) {
            // The pre-check makes this a racing-joins case only, but a
            // phantom must still not exist: without the roster row the
            // binding would deliver forever while refusing every reply.
            await ChannelBindings.removeAsync(`${kind}:${replyKey}`);
            return {
              sent: true, to, subject: destination.subject, joined: false,
              note: 'roster-full — the mail was sent, but replies will open a fresh conversation',
            };
          }
        }
        return {
          sent: true, to, subject: destination.subject,
          ...(continueMode ? { joined: to } : {}),
          ...(files.length > 0 ? { attached: files.map((f) => f.name) } : {}),
          ...(missing.length > 0 ? { missingAttachments: missing } : {}),
        };
      }
      // 'abandoned': the attempt cap gave up on a payload the provider keeps
      // rejecting. 'deferred': a previous attempt's receipt is inside its
      // backoff window — in flight, not sent. Both are facts the model can
      // relay, not errors to throw.
      return { sent: false, state: outcome, to };
    },
  };
}
