import type { AgentMessage } from './types';

/** Lens contract (§8): closed item/intent vocabularies, isomorphic (no Node
 *  globals) — extending either set is a deliberate framework change. */

// ---- Attachments (email v2 spec §4) ----------------------------------------

/** A file on a delivery item at render time — hydrated base64, never fetched
 *  by the lens. Base64 end-to-end to stay isomorphic. */
export interface ChannelAttachment {
  name: string;
  contentType: string;
  /** DECODED byte count — what a human-readable size line should say. */
  size: number;
  /** The bytes, base64. */
  content: string;
}

/** A provider-delivered file reference (not bytes). The lens translates the
 *  event into this; core fetches under the channel def's `media` recipe. */
export interface RemoteAttachment {
  name: string;
  contentType: string;
  /** Provider's claimed size — checked before fetch. Absent = fetch and find out. */
  declaredSize?: number;
  /** The resource, when the event names one directly (https only). */
  url?: string;
  /** Provider's file id when naming the resource needs credentials. */
  ref?: string;
  /** Two-step providers: first fetch yields JSON, `media.resolveIndirect`
   *  extracts the real target, fetched next with the same credentials. */
  indirect?: true;
}

/** A lens hands core either bytes (email inlines them in the webhook) or a
 *  reference (everything else). The discriminant is `content`. */
export type InboundAttachment = ChannelAttachment | RemoteAttachment;

export function isRemoteAttachment(a: InboundAttachment): a is RemoteAttachment {
  return typeof (a as ChannelAttachment).content !== 'string';
}

/** Naming-clause floor: one text line per file for surfaces that cannot carry
 *  bytes. Empty string when nothing to name, so call sites append freely. */
export function attachmentNotice(
  attachments?: ChannelAttachment[],
  /** Surface's text escaping, applied to each name. */
  escape: (name: string) => string = (n) => n,
): string {
  if (!attachments || attachments.length === 0) return '';
  return attachments.map((a) => `\n[file attached: ${escape(a.name)}]`).join('');
}

/** Display-clause floor: the tool's one-line account of a parked call, so
 *  approvers read intent rather than raw arg ids. Empty string when absent. */
export function promptDisplay(
  display: string | undefined,
  opts: {
    /** Clamped with an ellipsis past this. */
    limit?: number;
    /** Surface's text escaping — display interpolates model args, same provenance as model text. */
    escape?: (text: string) => string;
  } = {},
): string {
  if (display === undefined) return '';
  const text = display.trim();
  if (text === '') return '';
  const limit = opts.limit ?? 600;
  const escape = opts.escape ?? ((t: string) => t);
  if (text.length <= limit) return escape(text);
  // Never cut a surrogate pair: a lone high surrogate is a payload providers
  // reject deterministically — the same rule the planner's `overflow` keeps.
  let end = Math.max(1, limit);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${escape(text.slice(0, end))}…`;
}

// ---- Delivery items (§8.2) — what the planner can say ----------------------

/** One choice a prompt offers. `token` is canonical; the lens maps it to the
 *  surface's affordance. `match` (menu) / `url` (link) filled per profile. */
export interface PromptChoice {
  token: 'approve' | 'deny';
  label: string;
  match?: string;
  url?: string;
}

export type DeliveryItem =
  /** The turn's answer. `attachments` is a sidecar — files ride with the
   *  reply so a single message carries both (every lens must name them). */
  | { item: 'reply'; text: string; attachments?: ChannelAttachment[] }
  /** A harness note the channel opted into — structured token in, surface prose out. */
  | {
    item: 'status';
    kind: NonNullable<AgentMessage['kind']>;
    reason?: string;
    /** `kind: 'approval'` only — post-verdict audit outcome. */
    approved?: boolean;
    /** `kind: 'approval'` only, when true: watcher denied after timeout. */
    timedOut?: boolean;
    budget?: AgentMessage['budget'];
  }
  /** The parked approval from `session.pending`. `toolCallId` names the exact
   *  ask so stale replies cannot decide a different one. */
  | {
    item: 'prompt';
    name: string;
    args: unknown;
    /** The tool's own one-line account of the call (participants spec §8),
     *  hydrated at park time — a lens renders it ABOVE (or instead of) the
     *  raw args, so an approver reads names and sizes, not ref ids. */
    display?: string;
    runAs?: string | null;
    toolCallId: string;
    choices: PromptChoice[];
  }
  /** A reply over the profile's `limit`: mechanical head-slice (no model),
   *  optional web-view link. Keeps attachments — text overflowed, not files. */
  | { item: 'overflow'; head: string; url?: string; attachments?: ChannelAttachment[] };

/** Every `item` discriminant — the unit test asserts this agrees with the union. */
export const DELIVERY_ITEM_KINDS = ['reply', 'status', 'prompt', 'overflow'] as const;

// ---- Inbound intents (§8.3) — what an event can mean -----------------------

export type InboundIntent =
  | { kind: 'message'; text: string }
  /** `toolCallId` lets the router drop a stale click (§8.3). */
  | { kind: 'verdict'; verdict: 'approved' | 'denied'; reason?: string; toolCallId?: string }
  | { kind: 'link-request' }
  /** Catch-all for events with no routable meaning (handshakes, bounces, echoes, etc.). */
  | { kind: 'noop' };

/** What `lens.in` returns: intent plus routing envelope. `eventId` must be
 *  redelivery-stable (deduplicated admission within the retention window). */
export interface InboundReading {
  intent: InboundIntent;
  eventId?: string;
  externalUserId?: string;
  /** Gates identity resolution, not routing: `false` keeps a forgeable sender
   *  anonymous so a spoofed id cannot inherit a linked account (§12). */
  senderVerified?: boolean;
  conversationRef?: string;
  /** Where replies to this conversation go — stored on the binding at bind
   *  time, opaque to the core. */
  destination?: unknown;
  /** One recipient or many — defaults to `'group'` (the safe direction). */
  audience?: 'direct' | 'group';
  /** `noop` only: body echoed in the 200 (e.g. Slack's URL-verification challenge). */
  respond?: string;
  /** Files on a `message` intent — the lens translates, core enforces caps. */
  attachments?: InboundAttachment[];
}

// ---- The lens itself (§8.3) ------------------------------------------------

/** Per-surface adapter. Render and interpret are ONE object to prevent drift.
 *  Both halves must be pure (no I/O) — idempotence comes from receipts. */
export interface Lens {
  out(item: DeliveryItem, destination: unknown): unknown | unknown[];
  in(event: unknown): InboundReading;
}

// ---- The profile (§8.4) ----------------------------------------------------

/** How choices are offered: `native` (buttons), `menu` (reply words),
 *  `link` (single-use URLs). `limit` triggers overflow when exceeded. */
export interface ChannelProfile {
  interact: 'native' | 'menu' | 'link';
  limit?: number;
}

// ---- The transport ---------------------------------------------------------

/** Provider call — supplied by the channel package, not core. `reconcile`
 *  enables tier-B uncertain-delivery recovery (§11). */
export interface ChannelPostOptions {
  idempotencyKey: string;
  /** Cancels the provider request when the caller no longer needs the post. */
  signal?: AbortSignal;
}

export interface ChannelTransport {
  post(
    destination: unknown,
    payload: unknown,
    opts: ChannelPostOptions,
  ): Promise<{ providerMessageId?: string } | void>;
  reconcile?(destination: unknown, idempotencyKey: string): Promise<boolean>;
}

// ---- The menu grammar (§8.4) -----------------------------------------------

/** Canonical reply words — one place so render, registration, and test agree. */
export const MENU_MATCHES: Record<'approve' | 'deny', string> = {
  approve: 'YES',
  deny: 'NO',
};

/** Canonical token → verdict mapping — one place for all consumers. */
export const VERDICT_FOR = { approve: 'approved', deny: 'denied' } as const;

// ---- The linking gesture (§12) ---------------------------------------------

/** The bare word that asks for an account link — exact after trim, any case.
 *  Lives here so the core's hint and every lens agree on the word. */
export const LINK_GESTURE = 'link';
export function isLinkGesture(text: string): boolean {
  return text.trim().toLowerCase() === LINK_GESTURE;
}

// ---- The native-postback codec (§8.4) --------------------------------------

/** Encode a verdict postback as `{ t, c }`. Over `maxBytes` the toolCallId
 *  is DROPPED (not cut) — a truncated id would name the wrong ask. */
export function encodeVerdictPostback(
  token: 'approve' | 'deny', toolCallId: string, opts: { maxBytes?: number } = {},
): string {
  const t = token === 'approve' ? 'a' : 'd';
  const full = JSON.stringify({ t, c: toolCallId });
  if (opts.maxBytes === undefined || utf8Bytes(full) <= opts.maxBytes) return full;
  return JSON.stringify({ t });
}

/** Decode a verdict postback → verdict + optional toolCallId, or `null`.
 *  Guards against `JSON.parse('null')` yielding a typeof-object null. */
export function decodeVerdictPostback(
  raw: unknown,
): { verdict: 'approved' | 'denied'; toolCallId?: string } | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (value === null || typeof value !== 'object') return null;
  const { t, c } = value as { t?: unknown; c?: unknown };
  const verdict = t === 'a' ? VERDICT_FOR.approve : t === 'd' ? VERDICT_FOR.deny : null;
  if (!verdict) return null;
  return { verdict, ...(typeof c === 'string' ? { toolCallId: c } : {}) };
}

/** UTF-8 length without `Buffer` — this module is isomorphic and must not
 *  reach for a Node global. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---- The menu grammar's matching rule (§8.3) -------------------------------

/** One registered prompt choice. `toolCallId` ties the match to the exact
 *  parked call so a stale reply cannot decide a different ask (§8.3). */
export interface ReceiptExpectation {
  match: string;
  verdict: 'approved' | 'denied';
  toolCallId: string;
}

export function matchExpectation(
  text: string,
  expects: ReadonlyArray<ReceiptExpectation>,
): { verdict: 'approved' | 'denied'; toolCallId: string } | null {
  const normalized = text.trim().toUpperCase();
  for (const e of expects) {
    if (normalized === e.match.trim().toUpperCase()) {
      return { verdict: e.verdict, toolCallId: e.toolCallId };
    }
  }
  return null;
}

/** Build the receipt's `expects` from a prompt's menu-grammar choices. */
export function expectationsFor(
  prompt: Extract<DeliveryItem, { item: 'prompt' }>,
): ReceiptExpectation[] {
  return prompt.choices
    .filter((c) => c.match !== undefined)
    .map((c) => ({
      match: c.match!,
      verdict: VERDICT_FOR[c.token],
      toolCallId: prompt.toolCallId,
    }));
}

// ---- The one law, as a test (§8.3 / §8.7) ----------------------------------

/** Default corpus for `assertLensRoundTrip` — one per item kind, including a
 *  file-bearing reply and a prompt with `display` to exercise both clauses. */
export function exemplarItems(): DeliveryItem[] {
  return [
    { item: 'reply', text: 'The order shipped this morning.' },
    {
      item: 'reply',
      text: 'The summary is attached.',
      attachments: [{
        name: 'report.csv',
        contentType: 'text/csv',
        size: 21,
        content: 'aWQsdG90YWwKMSwyMDAKMiwzNTAK',   // "id,total\n1,200\n2,350\n"
      }],
    },
    { item: 'status', kind: 'error', reason: 'provider-failed' },
    {
      item: 'prompt',
      name: 'orders.refund',
      args: { orderId: 'o1' },
      display: 'Refund order o1 to the original card.',
      toolCallId: 'tc-exemplar',
      choices: [
        { token: 'approve', label: 'Approve' },
        { token: 'deny', label: 'Deny' },
      ],
    },
    { item: 'overflow', head: 'The first part of a long answer…', url: 'https://example.test/s/x' },
  ];
}

export interface RoundTripOptions {
  /** The corpus to render; defaults to `exemplarItems()`. */
  items?: DeliveryItem[];
  /** A destination `out` accepts; defaults to `{}`. */
  destination?: unknown;
  /** Lens-author-supplied: synthesize the inbound event a surface would
   *  deliver when a user activates `choice` of a rendered prompt. */
  synthesize?: (choice: PromptChoice, rendered: unknown | unknown[]) => unknown;
  /** A plain inbound message event carrying `text`; checked to read back as a
   *  `message` intent with that text. */
  message?: (text: string) => unknown;
  /** A file-only inbound event (no text) — checked to read back as a
   *  `message` with attachments preserving name and contentType. */
  mediaMessage?: (files: Array<{ name: string; contentType: string }>) => unknown;
}

/** Asserts totality (every item renders) and round-trip (every affordance
 *  `out` offers, `in` interprets back). Throws on first violation. */
export function assertLensRoundTrip(
  lens: Lens, profile: ChannelProfile, opts: RoundTripOptions = {},
): void {
  const destination = opts.destination ?? {};
  const items = opts.items ?? exemplarItems();

  const covered = new Set(items.map((i) => i.item));
  for (const kind of DELIVERY_ITEM_KINDS) {
    if (!covered.has(kind)) {
      throw new Error(
        `[10thfloor:agent] assertLensRoundTrip: the corpus carries no '${kind}' `
        + 'item, so totality cannot be checked. Add one (or use the default corpus).',
      );
    }
  }

  for (const raw of items) {
    // Normalize the corpus as the planner would (§8.4): fill menu reply
    // words or link placeholder URLs so the test matches the real item.
    const item: DeliveryItem = raw.item === 'prompt' && profile.interact === 'menu'
      ? {
        ...raw,
        choices: raw.choices.map((c) => ({ ...c, match: c.match ?? MENU_MATCHES[c.token] })),
      }
      : raw.item === 'prompt' && profile.interact === 'link'
        ? {
          ...raw,
          choices: raw.choices.map((c) => ({
            ...c, url: c.url ?? `https://example.test/verdict/${c.token}-placeholder`,
          })),
        }
        : raw;
    const payload = lens.out(item, destination);
    const empty = payload === null || payload === undefined
      || (Array.isArray(payload) && payload.length === 0);
    if (empty) {
      throw new Error(
        `[10thfloor:agent] lens.out returned nothing for a '${item.item}' item — `
        + 'every lens must render all four items (totality, spec §8.7).',
      );
    }

    // NAMING CLAUSE: every attachment must appear by name in the payload.
    if ((item.item === 'reply' || item.item === 'overflow') && item.attachments) {
      const rendered = JSON.stringify(payload);
      for (const a of item.attachments) {
        if (!rendered.includes(a.name)) {
          throw new Error(
            `[10thfloor:agent] round-trip failed: a '${item.item}' item carried the `
            + `attachment "${a.name}" but its name does not appear in the rendered `
            + 'payload. A lens that cannot carry bytes must still NAME the file '
            + '(the naming clause) — silently vanishing a file is forbidden.',
          );
        }
      }
    }

    // DISPLAY CLAUSE: a prompt with `display` must render it (or its opening).
    if (item.item === 'prompt' && item.display) {
      const rendered = JSON.stringify(payload);
      const opening = item.display.slice(0, 40);
      if (!rendered.includes(item.display) && !rendered.includes(opening)) {
        throw new Error(
          '[10thfloor:agent] round-trip failed: the prompt carried `display` '
          + `(${JSON.stringify(item.display)}) but it does not appear in the rendered `
          + 'payload. A lens must render the tool\'s own account of the call — above '
          + 'the raw args, or instead of them on a surface with no room (the display '
          + 'clause) — because arguments alone are not a decision.',
        );
      }
    }

    if (item.item === 'prompt' && profile.interact === 'link') {
      // `link` surfaces: no inbound event — check that every choice URL is rendered.
      const rendered = JSON.stringify(payload);
      for (const choice of item.choices) {
        if (!choice.url || !rendered.includes(choice.url)) {
          throw new Error(
            `[10thfloor:agent] round-trip failed: the '${choice.token}' choice's URL `
            + 'does not appear in the rendered prompt. A link-profile lens must carry '
            + 'every choice\'s url (§8.4).',
          );
        }
      }
    } else if (item.item === 'prompt') {
      if (!opts.synthesize) {
        throw new Error(
          '[10thfloor:agent] assertLensRoundTrip needs `synthesize` to check the '
          + 'prompt round-trip: only the lens author knows the wire shape of a '
          + `${profile.interact} activation. Supply (choice, rendered) => event.`,
        );
      }
      // Menu grammar: lens reads free text as `message`, pipeline converts via
      // `expects`. Native activations must read back as verdicts directly.
      const expects = expectationsFor(item);
      for (const choice of item.choices) {
        const reading = lens.in(opts.synthesize(choice, payload));
        const want = VERDICT_FOR[choice.token];
        const direct = reading.intent.kind === 'verdict' && reading.intent.verdict === want;
        const viaGrammar = profile.interact === 'menu'
          && reading.intent.kind === 'message'
          && matchExpectation(reading.intent.text, expects)?.verdict === want;
        if (!direct && !viaGrammar) {
          throw new Error(
            `[10thfloor:agent] round-trip failed: the '${choice.token}' affordance `
            + `read back as ${JSON.stringify(reading.intent)} instead of a `
            + `'${want}' verdict. What out() offers, in() must interpret (§8.3).`,
          );
        }
      }
    }
  }

  if (opts.message) {
    const text = 'a plain inbound message';
    const reading = lens.in(opts.message(text));
    if (reading.intent.kind !== 'message' || reading.intent.text !== text) {
      throw new Error(
        '[10thfloor:agent] round-trip failed: a plain inbound message event read '
        + `back as ${JSON.stringify(reading.intent)} instead of a 'message' intent `
        + 'carrying its text.',
      );
    }
  }

  if (opts.mediaMessage) {
    // One file: some surfaces deliver exactly one per message.
    const files = [{ name: 'diagram.png', contentType: 'image/png' }];
    const reading = lens.in(opts.mediaMessage(files));
    if (reading.intent.kind !== 'message') {
      throw new Error(
        '[10thfloor:agent] round-trip failed: a FILE-ONLY inbound event read back '
        + `as ${JSON.stringify(reading.intent)} — a file with no words is still a `
        + 'message (the sharpened guard, participants spec §6).',
      );
    }
    // Must preserve file count and contentType (not name — some providers omit it).
    const got = reading.attachments ?? [];
    if (got.length !== files.length) {
      throw new Error(
        `[10thfloor:agent] round-trip failed: the file-only event carried `
        + `${files.length} file(s) but the reading carries ${got.length}. The lens `
        + 'must hand every file to admission (participants spec §6.4).',
      );
    }
    for (const f of files) {
      if (!got.some((a) => a.contentType === f.contentType)) {
        throw new Error(
          `[10thfloor:agent] round-trip failed: the file-only event's `
          + `${f.contentType} file did not survive translation — the reading `
          + `carries ${JSON.stringify(got.map((a) => a.contentType))}.`,
        );
      }
    }
  }
}
