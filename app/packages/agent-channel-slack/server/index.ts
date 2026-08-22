import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ChannelDef, ChannelProfile, ChannelTransport, DeliveryItem, InboundReading,
  Lens, RawInbound,
} from 'meteor/10thfloor:agent';

/**
 * The Slack channel: exactly what the channels spec's §8.7 promises a channel
 * package is — one lens, one transport, one profile default — plus Slack's
 * two pieces of wire grime (the v0 signing scheme and the events/interactivity
 * payload split). Everything durable (bindings, receipts, admission dedup,
 * the worker, approvals) lives in `10thfloor:agent`; nothing here touches a
 * collection.
 *
 * The app-facing surface is the `slack()` factory:
 *
 *   Agent.channel('slack', slack({
 *     agent: 'support',
 *     botToken: Meteor.settings.packages['10thfloor:agent'].slack.botToken,
 *     signingSecret: Meteor.settings.packages['10thfloor:agent'].slack.signingSecret,
 *   }));
 *
 * WHAT THE LENS ANSWERS, deliberately: direct messages, and channel messages
 * only when the bot is @-mentioned (subscribe to exactly `message.im` and
 * `app_mention`). Un-mentioned channel chatter maps to noop — an agent that
 * answers every message in a channel it was invited to is a bug, not a
 * feature. A thread follow-up therefore needs a fresh mention; that is the
 * common Slack-bot contract and it is stated in the README.
 *
 * ECHO SUPPRESSION is load-bearing, not cosmetic: the worker posts a reply,
 * Slack fires a message event FOR THAT POST, and without the `bot_id`/
 * `subtype` drop below the agent would answer itself forever.
 */

// ---- Text: minimal Markdown → mrkdwn ---------------------------------------

/** Slack requires exactly these three escapes in message text. Applied before
 *  the conversions below, which then INTRODUCE Slack's own control sequences
 *  (`<url|label>`) on purpose. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The lens's per-surface markdown opt-in (spec §8.5): the model may emit
 * Markdown, the core passes it through opaque, and THIS surface chooses to
 * convert the constructs Slack renders differently. Deliberately minimal —
 * bold, links, headings — because mrkdwn already shares `_italic_`,
 * `` `code` `` and ``` fences with Markdown. Constructs inside code fences are
 * converted too; a lens that cares can override `out` per §8.7.
 */
export function toMrkdwn(markdown: string): string {
  return escapeSlack(markdown)
    // [label](url) → <url|label> — http(s) ONLY. The text is model-generated,
    // and a `<javascript:…|click>` or `<data:…|…>` link is exactly the kind of
    // thing a prompt-injected model could be steered into emitting; a
    // non-http link stays literal (and already escaped) text.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    // **bold** → *bold*
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    // # Heading → *Heading* (mrkdwn has no headings)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
}

// ---- Status prose — this surface's `noteText` ------------------------------

function statusProse(item: Extract<DeliveryItem, { item: 'status' }>): string {
  switch (item.kind) {
    case 'error':
      return `:warning: Something went wrong${item.reason ? ` (${escapeSlack(item.reason)})` : ''}. Send a message to try again.`;
    case 'budget':
      return `:no_entry: The session reached its ${item.budget ?? 'usage'} limit.`;
    case 'interrupted':
      return ':octagonal_sign: The turn was stopped.';
    case 'approval':
      if (item.reason === 'approval timed out') return ':hourglass: The approval request timed out and was denied.';
      return item.approved ? ':white_check_mark: Approved.' : ':x: Denied.';
    case 'compaction':
      return ':package: Earlier conversation was summarized to stay within context.';
    case 'orphan-child':
      return ':wrench: A background sub-task was recovered.';
    default:
      return `[${item.kind}]${item.reason ? ` ${escapeSlack(item.reason)}` : ''}`;
  }
}

// ---- The signature (the trust boundary) ------------------------------------

/**
 * Slack's v0 signing scheme, checked the way Slack documents it: the HMAC of
 * `v0:{timestamp}:{rawBody}` under the signing secret must equal
 * `x-slack-signature`, and the timestamp must be recent (±5 minutes) so a
 * captured request cannot be replayed later. Constant-time comparison —
 * a signature check that leaks by timing is not a trust boundary.
 */
export function verifySlackSignature(
  raw: RawInbound, signingSecret: string, nowMs = Date.now(),
): boolean {
  const header = raw.headers['x-slack-signature'];
  const ts = raw.headers['x-slack-request-timestamp'];
  const signature = Array.isArray(header) ? header[0] : header;
  const timestamp = Array.isArray(ts) ? ts[0] : ts;
  if (!signature || !timestamp) return false;
  // A non-numeric timestamp must FAIL the window, not skip it: `NaN > 300`
  // is false, so without the finiteness check a garbage timestamp would
  // bypass the replay guard (the HMAC would still have to verify, so this is
  // hygiene rather than a hole — but hygiene is free).
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(nowMs / 1000 - tsSeconds) > 300) return false;
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${raw.rawBody}`)
    .digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Parse: HTTP body → one of three Slack shapes --------------------------

/** What `parse` hands the lens: Slack's three request shapes, classified. The
 *  lens stays pure over these; the classification is the only place that
 *  knows events arrive as JSON and interactivity as `payload=`-form-encoding. */
export type SlackEvent =
  | { slack: 'url_verification'; challenge: string }
  | { slack: 'event'; envelope: any }
  | { slack: 'action'; payload: any }
  | { slack: 'ignore' };

export function parseSlackRequest(raw: RawInbound): SlackEvent {
  // Interactivity posts application/x-www-form-urlencoded with one `payload`
  // field carrying JSON. Events post plain JSON.
  if (raw.rawBody.startsWith('payload=')) {
    try {
      const payload = JSON.parse(decodeURIComponent(raw.rawBody.slice('payload='.length).replace(/\+/g, ' ')));
      return { slack: 'action', payload };
    } catch {
      return { slack: 'ignore' };
    }
  }
  try {
    const body = JSON.parse(raw.rawBody);
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return { slack: 'url_verification', challenge: body.challenge };
    }
    if (body.type === 'event_callback' && body.event) {
      return { slack: 'event', envelope: body };
    }
    return { slack: 'ignore' };
  } catch {
    return { slack: 'ignore' };
  }
}

// ---- The lens --------------------------------------------------------------

const NOOP: InboundReading = { intent: { kind: 'noop' } };

/** `<@U123>` mention tokens, removed from inbound text — the mention addressed
 *  the bot; it is not part of what the user said. */
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, '').trim();
}

/** A Slack conversation id starting with `D` is a direct message — the one
 *  audience where an anonymous session's capability URL may travel (§8.5). */
function audienceOf(channel: string, channelType?: string): 'direct' | 'group' {
  if (channelType === 'im') return 'direct';
  return channel?.startsWith('D') ? 'direct' : 'group';
}

export const slackLens: Lens = {
  out(item: DeliveryItem): unknown {
    switch (item.item) {
      case 'reply':
        return { text: toMrkdwn(item.text) };
      case 'status':
        return { text: statusProse(item) };
      case 'overflow':
        return { text: `${toMrkdwn(item.head)}${item.url ? `\n<${item.url}|Continue on the web>` : ''}` };
      case 'prompt': {
        // Tool name and arguments are MODEL-influenced text landing in live
        // mrkdwn: escape them like any other model text, and neutralize a
        // fence inside the arguments — an arg of "```<!channel> approve now"
        // would otherwise close our code block and put a mass-ping and a
        // spoofed approval line into the thread. A zero-width space between
        // the backticks keeps the characters visible and the fence closed.
        const args = JSON.stringify(item.args ?? {}, null, 2);
        const clamped = escapeSlack(args.length > 2000 ? `${args.slice(0, 2000)}…` : args)
          .replace(/```/g, '`​`​`');
        const name = escapeSlack(item.name).replace(/`/g, '‘');
        const runAs = 'runAs' in item && item.runAs !== undefined
          ? `\n_runs as ${escapeSlack(String(item.runAs ?? 'anonymous service context'))}_` : '';
        const fallback = `Approval needed: ${name}`;
        return {
          text: fallback,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `The agent wants to run \`${name}\`:\n\`\`\`${clamped}\`\`\`${runAs}`,
              },
            },
            {
              type: 'actions',
              elements: item.choices.map((choice) => ({
                type: 'button',
                text: { type: 'plain_text', text: choice.label },
                ...(choice.token === 'approve' ? { style: 'primary' } : { style: 'danger' }),
                action_id: `agent-verdict-${choice.token}`,
                // The postback carries the canonical token AND the exact ask —
                // the staleness rule (§8.3) rides the button, so a click on
                // last week's message cannot decide today's different ask.
                value: JSON.stringify({ token: choice.token, toolCallId: item.toolCallId }),
              })),
            },
          ],
        };
      }
      default:
        return null;
    }
  },

  in(event: unknown): InboundReading {
    const e = event as SlackEvent;
    if (!e || typeof e !== 'object') return NOOP;

    if (e.slack === 'url_verification') {
      return { intent: { kind: 'noop' }, respond: e.challenge };
    }

    if (e.slack === 'event') {
      const { envelope } = e;
      const ev = envelope.event ?? {};
      // ECHO SUPPRESSION and non-messages: our own posts carry `bot_id`;
      // edits, joins, and other alterations carry `subtype`. Both are noops
      // BY DESIGN — answering them is the self-reply loop.
      if (ev.bot_id || ev.subtype) return NOOP;
      if (ev.type !== 'message' && ev.type !== 'app_mention') return NOOP;
      // Channel chatter without a mention is not addressed to the agent.
      if (ev.type === 'message' && ev.channel_type !== 'im') return NOOP;
      // A mention typed INSIDE a DM can arrive as BOTH `message.im` and
      // `app_mention` — two events, two event_ids, so admission dedup cannot
      // collapse them and the agent would answer twice. One side must yield:
      // the DM's own `message.im` is authoritative there, so a DM-shaped
      // app_mention is a noop.
      if (ev.type === 'app_mention' && String(ev.channel ?? '').startsWith('D')) return NOOP;

      const text = stripMentions(String(ev.text ?? ''));
      if (text === '') return NOOP;
      const team = envelope.team_id ?? '';
      // THE CONVERSATION KEY differs by surface shape, and getting it wrong
      // is amnesia: a DM is ONE ongoing conversation (key it by the channel —
      // keying by message ts would mint a fresh session per message), while a
      // channel conversation is the THREAD the mention started. Replies post
      // accordingly: into the DM's main flow, into the channel's thread.
      const dm = ev.channel_type === 'im' || String(ev.channel ?? '').startsWith('D');
      // The account-linking gesture (spec §12): the bare word "link" asks for
      // a one-time URL that ties this Slack identity to a signed-in web
      // account. A reserved word rather than a slash command so it needs no
      // extra Slack configuration; it is an exact-word match, so "link my
      // account please" still reaches the agent as an ordinary message. DMs
      // ONLY: the URL is a credential, and the core refuses to post one into
      // a group anyway — in a channel the word is just a message.
      const linkRequested = dm && text.trim().toLowerCase() === 'link';
      const threadTs = ev.thread_ts ?? ev.ts;
      return {
        intent: linkRequested ? { kind: 'link-request' } : { kind: 'message', text },
        eventId: envelope.event_id,
        externalUserId: `${team}:${ev.user}`,
        conversationRef: dm ? `${team}:${ev.channel}` : `${team}:${ev.channel}:${threadTs}`,
        destination: { channel: ev.channel, ...(dm ? {} : { threadTs }) },
        audience: audienceOf(ev.channel, ev.channel_type),
      };
    }

    if (e.slack === 'action') {
      const { payload } = e;
      if (payload.type !== 'block_actions' || !payload.actions?.length) return NOOP;
      const action = payload.actions[0];
      let value: { token?: string; toolCallId?: string } = {};
      try { value = JSON.parse(action.value ?? '{}'); } catch { return NOOP; }
      // `JSON.parse('null')` succeeds — guard the shape before reading it, or
      // a crafted value becomes a TypeError, a 500, and a provider retry loop.
      if (!value || typeof value !== 'object') return NOOP;
      if (value.token !== 'approve' && value.token !== 'deny') return NOOP;
      const team = payload.user?.team_id ?? payload.team?.id ?? '';
      const channel = payload.channel?.id ?? '';
      // The same conversation key as the message path — a click must land on
      // the binding the message created, or verdicts route into a phantom
      // conversation.
      const dm = String(channel).startsWith('D');
      const threadTs = payload.message?.thread_ts ?? payload.message?.ts;
      return {
        intent: {
          kind: 'verdict',
          verdict: value.token === 'approve' ? 'approved' : 'denied',
          toolCallId: value.toolCallId,
        },
        // Interactivity has no redelivery-stable event id (Slack does not
        // retry action posts); the user+click timestamp is stable across the
        // double-click case, which is the duplicate that actually happens.
        eventId: `act:${payload.user?.id}:${action.action_ts}`,
        externalUserId: `${team}:${payload.user?.id}`,
        conversationRef: dm ? `${team}:${channel}` : `${team}:${channel}:${threadTs}`,
        destination: { channel, ...(dm ? {} : { threadTs }) },
        audience: audienceOf(channel),
      };
    }

    return NOOP;
  },
};

// ---- The transport ---------------------------------------------------------

export interface SlackTransportOptions {
  botToken: string;
  /** TEST SEAM: the fetch to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * `chat.postMessage`, nothing else — the worker threads every post into the
 * bound conversation via the destination the binding recorded. The delivery
 * receipt's key is attached as message METADATA so a future read-back
 * (`onUncertainDelivery: 'reconcile'`, spec §11 tier B) has something to look
 * for; this package does not SHIP `reconcile` yet, because metadata read-back
 * on the thread-replies endpoint is unverified (the spec's own §11 caveat) —
 * so the channel's default recovery tier is `retry`.
 */
export function slackTransport(options: SlackTransportOptions): ChannelTransport {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async post(destination: unknown, payload: unknown, opts: { idempotencyKey: string }) {
      const dest = (destination ?? {}) as { channel?: string; threadTs?: string };
      // Payload FIRST, addressing and policy LAST: a lens payload (ours, or an
      // app's override) can never redirect a post to another channel or
      // thread, and the rendering policy cannot be loosened from a payload.
      // `parse: 'none'` + `link_names: false` pin Slack's defaults so a bare
      // @channel in model text stays inert even if those defaults ever move.
      const body = {
        ...(payload as Record<string, unknown>),
        channel: dest.channel,
        ...(dest.threadTs ? { thread_ts: dest.threadTs } : {}),
        parse: 'none',
        link_names: false,
        unfurl_links: false,
        metadata: {
          event_type: 'agent_delivery',
          event_payload: { receipt: opts.idempotencyKey },
        },
      };
      const res = await doFetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (!json?.ok) {
        throw new Error(`[agent-channel-slack] chat.postMessage failed: ${json?.error ?? res.status}`);
      }
      return { providerMessageId: json.ts as string };
    },
  };
}

// ---- The factory (§8.7 tier 1: install, configure, done) -------------------

export interface SlackChannelOptions {
  /** The registered agent this workspace talks to. */
  agent: string;
  /** `xoxb-…` — the app's bot token (OAuth & Permissions page). */
  botToken: string;
  /** The app's signing secret (Basic Information page). */
  signingSecret: string;
  /** Note kinds to deliver as statuses. Default `['error', 'approval']` —
   *  a failed turn and a decided approval are worth saying in the thread. */
  statuses?: ChannelDef['statuses'];
  onUncertainDelivery?: ChannelDef['onUncertainDelivery'];
  sessionUrl?: ChannelDef['sessionUrl'];
  /** Turns a minted linking token into the web URL a "link" DM is answered
   *  with (spec §12). Without it, link requests are acknowledged and ignored. */
  linkUrl?: ChannelDef['linkUrl'];
  throttle?: ChannelDef['throttle'];
  /** Override pieces of the default `{ interact: 'native', limit: 12000 }`. */
  profile?: Partial<ChannelProfile>;
  /** TEST SEAM, threaded to the transport. */
  fetchImpl?: typeof fetch;
}

export function slack(options: SlackChannelOptions): ChannelDef {
  if (!options?.agent) throw new Error('[agent-channel-slack] slack({ agent }) is required');
  if (!options.botToken) throw new Error('[agent-channel-slack] slack({ botToken }) is required');
  if (!options.signingSecret) throw new Error('[agent-channel-slack] slack({ signingSecret }) is required');
  return {
    agent: options.agent,
    transport: slackTransport({ botToken: options.botToken, fetchImpl: options.fetchImpl }),
    lens: slackLens,
    profile: { interact: 'native', limit: 12000, ...options.profile },
    verify: (raw) => verifySlackSignature(raw, options.signingSecret),
    parse: parseSlackRequest,
    statuses: options.statuses ?? ['error', 'approval'],
    ...(options.onUncertainDelivery ? { onUncertainDelivery: options.onUncertainDelivery } : {}),
    ...(options.sessionUrl ? { sessionUrl: options.sessionUrl } : {}),
    ...(options.linkUrl ? { linkUrl: options.linkUrl } : {}),
    ...(options.throttle ? { throttle: options.throttle } : {}),
  };
}
