import type { AgentMessage } from './types';

/**
 * The lens contract (channels spec §8): what the shared planner emits, what a
 * per-surface lens must render and interpret, and the one law that binds the
 * two halves together.
 *
 * BOTH VOCABULARIES ARE CLOSED, like the `Phase` union — a channel cannot
 * invent items or intents, and extending either set is a framework change made
 * deliberately, here, once. The unit test asserts the item list is total so a
 * new member cannot be added without the totality check knowing about it.
 */

// ---- Delivery items (§8.2) — what the planner can say ----------------------

/** One choice a prompt offers. `token` is CANONICAL (`approve`/`deny`) — the
 *  lens maps it onto whatever the surface does (a button postback, a reply
 *  keyword, a single-use URL) and back. The grammar fields are filled per the
 *  profile's `interact` before the lens sees the item:
 *
 *    `match` — `menu` only: the reply word the surface's grammar registers
 *              ("Reply YES to approve"); the same word lands in the delivery
 *              receipt's `expects`, so the render and the parse are one
 *              artifact by construction.
 *    `url`   — `link` only: the single-use approval URL for this choice,
 *              minted at delivery time (see `issueVerdictToken`). Absent when
 *              the channel supplies no `approvalUrl`.
 */
export interface PromptChoice {
  token: 'approve' | 'deny';
  label: string;
  match?: string;
  url?: string;
}

export type DeliveryItem =
  /** The turn's answer — opaque text, passed through. The core never parses
   *  it (no markdown parser in the shared core, §8.5); a lens that wants
   *  Slack markup or email HTML converts inside its own `out`. */
  | { item: 'reply'; text: string }
  /** A harness note the channel opted into (`statuses` in the channel def).
   *  Structured token in, surface prose out — the lens is a second `noteText`. */
  | {
    item: 'status';
    kind: NonNullable<AgentMessage['kind']>;
    reason?: string;
    /** `kind: 'approval'` notes only — the post-verdict audit outcome. The ASK
     *  itself is never a status; it is always the `prompt` item. */
    approved?: boolean;
    /** `kind: 'approval'` notes only, and only when true: nobody answered
     *  before `budget.approval` elapsed and the watcher denied the ask. A lens
     *  must be able to say "timed out" rather than imply a person refused. */
    timedOut?: boolean;
    budget?: AgentMessage['budget'];
  }
  /** The parked approval, built from `session.pending` — never from a note.
   *  `toolCallId` names the exact ask, and travels into the delivery receipt's
   *  `expects` so a stale reply cannot decide a different later ask. */
  | {
    item: 'prompt';
    name: string;
    args: unknown;
    runAs?: string | null;
    toolCallId: string;
    choices: PromptChoice[];
  }
  /** A reply that would not fit the profile's `limit`: a MECHANICAL head-slice
   *  (the worker never calls a model — no summarization) plus, when the
   *  audience rules allow one, a link to the session's web view. */
  | { item: 'overflow'; head: string; url?: string };

/** Every `item` discriminant, for the totality test and for lens authors who
 *  want to switch exhaustively. Kept adjacent to the union so they cannot
 *  drift apart unnoticed — the unit test asserts they agree. */
export const DELIVERY_ITEM_KINDS = ['reply', 'status', 'prompt', 'overflow'] as const;

// ---- Inbound intents (§8.3) — what an event can mean -----------------------

export type InboundIntent =
  | { kind: 'message'; text: string }
  /** `toolCallId`, when the surface's activation carries one (a native
   *  postback rendered from a prompt item should embed it), lets the router
   *  drop a click whose ask is no longer the parked one — §8.3's staleness
   *  rule. Absent, the single-winner verdict write is still the backstop. */
  | { kind: 'verdict'; verdict: 'approved' | 'denied'; reason?: string; toolCallId?: string }
  | { kind: 'link-request' }
  /** Everything without a defined meaning maps here BY DESIGN, not by
   *  accident: URL-verification handshakes, delivery callbacks, bounces,
   *  message edits, reactions, read receipts, typing indicators, the bot's own
   *  echoes. */
  | { kind: 'noop' };

/**
 * What `lens.in` returns: the intent plus the routing envelope. The envelope
 * is how the generic pipeline (§9) stays provider-free — every
 * provider-specific extraction happens inside the lens.
 *
 * `eventId` must be the provider's REDELIVERY-STABLE id; it powers
 * exactly-once admission. A `noop` may leave the routing fields undefined —
 * nothing routes on it.
 */
export interface InboundReading {
  intent: InboundIntent;
  eventId?: string;
  externalUserId?: string;
  conversationRef?: string;
  /** Where replies to this conversation go — stored on the binding at bind
   *  time, opaque to the core. */
  destination?: unknown;
  /** Whether the destination has one recipient or many — §8.5's capability-URL
   *  rule reads it. Defaults to `'group'` (the safe direction) when a lens
   *  does not say. */
  audience?: 'direct' | 'group';
  /** `noop` only: a body the provider expects echoed in the 200 — Slack's
   *  URL-verification `challenge` is the canonical case. Ignored on routable
   *  intents, whose 200 carries no body. */
  respond?: string;
}

// ---- The lens itself (§8.3) ------------------------------------------------

/**
 * The per-surface adapter: two halves of one object, deliberately — on a
 * surface with no buttons, "Reply YES to approve" is a parse grammar the
 * OUTBOUND render created, and splitting render from interpret is how the two
 * drift (the documented Bot Framework failure). A lens with no gesture for
 * `link-request` simply never emits it.
 *
 * `out` may return one payload or several (a long SMS split into segments);
 * the worker posts them in order under one receipt. Both halves must be PURE —
 * no I/O — which is what lets `assertLensRoundTrip` run with zero provider
 * credentials, and what makes redelivery after a crash re-produce the same
 * payload (idempotence comes from receipts, not from rendering).
 */
export interface Lens {
  out(item: DeliveryItem, destination: unknown): unknown | unknown[];
  in(event: unknown): InboundReading;
}

// ---- The profile (§8.4) ----------------------------------------------------

/**
 * How choices are OFFERED on this surface — not what inbound is accepted
 * (typed YES on a buttons surface still lands in `in`, if the lens registered
 * a text fallback):
 *
 *   `native` — real affordances (buttons, quick replies); postbacks carry the
 *              canonical token.
 *   `menu`   — no affordances, cheap replies (SMS): the prompt renders a reply
 *              menu and registers its tokens in the receipt's `expects`.
 *   `link`   — replies are awkward (email): each choice is a single-use
 *              URL bound to the specific pending verdict.
 *
 * `limit` is the hard payload budget; a reply over it becomes an `overflow`
 * item (head-slice + web link, audience permitting).
 */
export interface ChannelProfile {
  interact: 'native' | 'menu' | 'link';
  limit?: number;
}

// ---- The transport ---------------------------------------------------------

/**
 * The provider call itself — supplied by the channel package (Slack SDK,
 * Twilio, SMTP), never by the core, so the package takes no provider
 * dependency. `post` receives whatever `lens.out` produced.
 *
 * `idempotencyKey` is passed where the provider honors one (tier A, §11);
 * `reconcile` is tier B — "did a post carrying this key already land at this
 * destination?" — and its presence is what makes `onUncertainDelivery:
 * 'reconcile'` legal for the channel. The key it is asked about is the BARE
 * receipt id, which is what segment 0 of a multi-payload post was sent under
 * (later segments carry `<receiptId>:<i>`); "did segment 0 land" is the
 * question, because a post that got past its first segment has a receipt
 * worth settling.
 */
export interface ChannelTransport {
  post(
    destination: unknown,
    payload: unknown,
    opts: { idempotencyKey: string },
  ): Promise<{ providerMessageId?: string } | void>;
  reconcile?(destination: unknown, idempotencyKey: string): Promise<boolean>;
}

// ---- The menu grammar (§8.4) -----------------------------------------------

/** The `menu` grammar's canonical reply words. ONE place — the planner fills
 *  choices from it, the receipt's `expects` registers it, and the round-trip
 *  helper normalizes its corpus with it — so render, registration and test
 *  can never disagree about the words. */
export const MENU_MATCHES: Record<'approve' | 'deny', string> = {
  approve: 'YES',
  deny: 'NO',
};

/** The canonical choice token → the verdict it records. ONE place, so the
 *  planner's grammar, the round-trip helper, the `link` token mint and every
 *  lens's postback agree on which word means what. */
export const VERDICT_FOR = { approve: 'approved', deny: 'denied' } as const;

// ---- The linking gesture (§12) ---------------------------------------------

/** The bare word that asks for an account link: exact after trimming, any
 *  case — "link" and " LINK " ask; "link my account" is a message. The core's
 *  own group hint names this word ("send me the word "link" in a direct
 *  message"), so it lives here and lenses read it rather than spelling their
 *  own: what the hint says to type is, by construction, what the lens
 *  interprets. A lens with a surface-specific spelling (`/link@Bot`) still
 *  accepts this one. */
export const LINK_GESTURE = 'link';
export function isLinkGesture(text: string): boolean {
  return text.trim().toLowerCase() === LINK_GESTURE;
}

// ---- The native-postback codec (§8.4) --------------------------------------

/**
 * The wire shape a `native` lens embeds in a button's postback, so the click
 * comes back carrying the canonical token AND the ask it answers (§8.3's
 * staleness rule): terse JSON, `{ t: 'a' | 'd', c: toolCallId }`. Pure, and
 * shared so every surface's buttons decode the same way.
 *
 * `maxBytes` is for providers that cap the postback (Telegram's
 * `callback_data` is 64 bytes). Over the cap the id is DROPPED, not cut:
 * `{ t }` alone still decides the parked ask (the single-winner verdict write
 * is the backstop), whereas a truncated id would name a WRONG ask and be
 * dropped as stale — or worse, collide. Degrading to token-only is deliberate.
 */
export function encodeVerdictPostback(
  token: 'approve' | 'deny', toolCallId: string, opts: { maxBytes?: number } = {},
): string {
  const t = token === 'approve' ? 'a' : 'd';
  const full = JSON.stringify({ t, c: toolCallId });
  if (opts.maxBytes === undefined || utf8Bytes(full) <= opts.maxBytes) return full;
  return JSON.stringify({ t });
}

/**
 * The other half: a postback (the raw string, or a value the provider already
 * parsed) → the verdict and, when it rode along, the ask. `null` for anything
 * that is not a verdict postback — malformed JSON, a non-object, an unknown
 * `t` — so a lens maps it to `noop` rather than throwing.
 *
 * `JSON.parse('null')` SUCCEEDS and yields `null`, whose `typeof` is
 * `'object'` — a user-craftable payload that would pass a bare object check
 * and then throw on the `t` read. Guarded explicitly.
 */
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

/**
 * The ONE rule deciding whether free inbound text answers an outstanding
 * prompt, shared by the pipeline and the round-trip helper so they cannot
 * drift: exact word after trimming, case-insensitive — "yes" and " YES "
 * decide, "yes please" is a message. `toolCallId` travels with the verdict so
 * the router can drop a match whose ask is no longer the parked one.
 */
export function matchExpectation(
  text: string,
  expects: ReadonlyArray<{ match: string; verdict: 'approved' | 'denied'; toolCallId: string }>,
): { verdict: 'approved' | 'denied'; toolCallId: string } | null {
  const normalized = text.trim().toUpperCase();
  for (const e of expects) {
    if (normalized === e.match.trim().toUpperCase()) {
      return { verdict: e.verdict, toolCallId: e.toolCallId };
    }
  }
  return null;
}

/**
 * The reply grammar a delivered prompt registers (§8.3): what the receipt's
 * `expects` records, and what the inbound side matches free text against
 * before falling through to "this is a message". Only `menu` choices carry a
 * text grammar — `native` postbacks and `link` redemptions arrive as their own
 * event shapes, interpreted by the lens and the token table respectively.
 */
export function expectationsFor(
  prompt: Extract<DeliveryItem, { item: 'prompt' }>,
): Array<{ match: string; verdict: 'approved' | 'denied'; toolCallId: string }> {
  return prompt.choices
    .filter((c) => c.match !== undefined)
    .map((c) => ({
      match: c.match!,
      verdict: VERDICT_FOR[c.token],
      toolCallId: prompt.toolCallId,
    }));
}

// ---- The one law, as a test (§8.3 / §8.7) ----------------------------------

/** Canonical exemplars, one per item kind — the default corpus
 *  `assertLensRoundTrip` renders when the caller supplies none. */
export function exemplarItems(): DeliveryItem[] {
  return [
    { item: 'reply', text: 'The order shipped this morning.' },
    { item: 'status', kind: 'error', reason: 'provider-failed' },
    {
      item: 'prompt',
      name: 'orders.refund',
      args: { orderId: 'o1' },
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
  /**
   * The half only the lens author can supply: the inbound event the SURFACE
   * would deliver when a user activates `choice` of a rendered prompt. The
   * framework cannot forge a provider's wire format — this closure is where
   * that knowledge lives, next to the lens it tests.
   */
  synthesize?: (choice: PromptChoice, rendered: unknown | unknown[]) => unknown;
  /** A plain inbound message event carrying `text`; checked to read back as a
   *  `message` intent with that text. */
  message?: (text: string) => unknown;
}

/**
 * The shipped round-trip helper. Two jobs:
 *
 *  TOTALITY — every delivery item renders to a non-null payload, so no surface
 *  can silently drop an approval ask.
 *
 *  ROUND-TRIP — every affordance `out` offers, `in` interprets back to the
 *  exact canonical intent: render the prompt, feed each choice's synthetic
 *  event through `in`, require the matching verdict. If a lens renders a
 *  button it must interpret the click; if it renders "Reply YES" it must
 *  interpret YES.
 *
 * Throws with a named failure on the first violation; returns quietly when the
 * lens holds. Pure lens + caller-supplied synthetic events = runnable with no
 * provider credentials.
 */
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
    // Normalize the corpus exactly as the planner would (§8.4): under a
    // `menu` profile, prompt choices carry the canonical reply words — the
    // grammar the receipt would register — so the helper tests the item the
    // lens would actually be handed, not a bare one.
    const item: DeliveryItem = raw.item === 'prompt' && profile.interact === 'menu'
      ? {
        ...raw,
        choices: raw.choices.map((c) => ({ ...c, match: c.match ?? MENU_MATCHES[c.token] })),
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

    if (item.item === 'prompt') {
      if (!opts.synthesize) {
        throw new Error(
          '[10thfloor:agent] assertLensRoundTrip needs `synthesize` to check the '
          + 'prompt round-trip: only the lens author knows the wire shape of a '
          + `${profile.interact} activation. Supply (choice, rendered) => event.`,
        );
      }
      // The menu grammar answers with FREE TEXT — the lens reads it as a
      // `message` and the PIPELINE converts it via the registered `expects`
      // (§8.3). The round-trip check models exactly that: the same
      // `matchExpectation` the pipeline runs, over the same choices the
      // render was handed. Native/link activations arrive as their own event
      // shapes and must read back as verdicts from `in` directly.
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
}
