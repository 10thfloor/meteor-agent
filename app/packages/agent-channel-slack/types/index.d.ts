import { type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport, type Lens, type RawInbound } from 'meteor/10thfloor:agent';
/**
 * The lens's per-surface markdown opt-in (spec §8.5): the model may emit
 * Markdown, the core passes it through opaque, and THIS surface chooses to
 * convert the constructs Slack renders differently. Deliberately minimal —
 * bold, links, headings — because mrkdwn already shares `_italic_`,
 * `` `code` `` and ``` fences with Markdown. Constructs inside code fences are
 * converted too; a lens that cares can override `out` per §8.7.
 */
export declare function toMrkdwn(markdown: string): string;
/**
 * Slack's v0 signing scheme, checked the way Slack documents it: the HMAC of
 * `v0:{timestamp}:{rawBody}` under the signing secret must equal
 * `x-slack-signature`, and the timestamp must be recent (±5 minutes) so a
 * captured request cannot be replayed later. Constant-time comparison —
 * a signature check that leaks by timing is not a trust boundary.
 */
export declare function verifySlackSignature(raw: RawInbound, signingSecret: string, nowMs?: number): boolean;
/** What `parse` hands the lens: Slack's three request shapes, classified. The
 *  lens stays pure over these; the classification is the only place that
 *  knows events arrive as JSON and interactivity as `payload=`-form-encoding. */
export type SlackEvent = {
    slack: 'url_verification';
    challenge: string;
} | {
    slack: 'event';
    envelope: any;
} | {
    slack: 'action';
    payload: any;
} | {
    slack: 'ignore';
};
export declare function parseSlackRequest(raw: RawInbound): SlackEvent;
export declare const slackLens: Lens;
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
export declare function slackTransport(options: SlackTransportOptions): ChannelTransport;
/**
 * The factory's options: Slack's own three, the profile override, the test
 * seam — and the core's `ChannelKnobs`, typed and documented once on
 * `ChannelDef` and forwarded untouched. The one default
 * this package sets: `statuses` is `['error', 'approval']` — a failed turn and
 * a decided approval are worth saying in the thread. `linkUrl` is what turns
 * a "link" DM into an answer (spec §12); without it, link requests are
 * acknowledged and ignored.
 */
export interface SlackChannelOptions extends ChannelKnobs {
    /** The registered agent this workspace talks to. */
    agent: string;
    /** `xoxb-…` — the app's bot token (OAuth & Permissions page). */
    botToken: string;
    /** The app's signing secret (Basic Information page). */
    signingSecret: string;
    /** Override pieces of the default `{ interact: 'native', limit: 12000 }`. */
    profile?: Partial<ChannelProfile>;
    /** TEST SEAM, threaded to the transport. */
    fetchImpl?: typeof fetch;
}
export declare function slack(options: SlackChannelOptions): ChannelDef;
//# sourceMappingURL=index.d.ts.map