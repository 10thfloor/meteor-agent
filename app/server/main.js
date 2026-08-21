import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import {
  Agent, AgentSessions, mockProvider, redeemLinkToken,
} from 'meteor/10thfloor:agent';
import { slack } from 'meteor/10thfloor:agent-channel-slack';

/**
 * The demo agent behind the chat UI in `client/`.
 *
 * With ANTHROPIC_API_KEY (or another pi-ai-recognized key) in the
 * environment, it talks to the real model — `provider` is simply omitted.
 * Without one it runs a scripted mock that still exercises the interesting
 * surface: streaming, a tool call, and an ask-gated tool the UI must approve.
 */
const live = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

// A word-per-chunk script so streaming is visible at human speed in the demo.
const demoScript = (() => {
  let calls = 0;
  return (req) => {
    calls += 1;
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = (lastUser?.content ?? '').toLowerCase();
    // "Did MY tool call just come back?" — the last message is a tool result.
    // (Not `.some(role === 'tool')`: any earlier turn's tool row would make
    // that true forever and this script would never call a tool again.)
    const answeredTool = req.messages[req.messages.length - 1]?.role === 'tool';
    if (text.includes('time') && !answeredTool) {
      return { toolCalls: [{ id: `clock-${calls}`, name: 'clock', args: {} }] };
    }
    if (text.includes('refund') && !answeredTool) {
      return { toolCalls: [{ id: `refund-${calls}`, name: 'refund', args: { orderId: 'A-1001' } }] };
    }
    if (answeredTool) {
      return { text: 'Done — the tool result is right above this message. ' };
    }
    return {
      text:
        'Hello! I am the demo agent, running on a SCRIPTED provider — no API '
        + 'key, no network. Say something with "time" in it to watch a tool '
        + 'call, or "refund" to hit an approval gate. Set ANTHROPIC_API_KEY '
        + 'and restart to talk to a real model instead.',
    };
  };
})();

new Agent('demo', {
  model: live ? 'anthropic/claude-haiku-4-5' : 'demo/scripted',
  instructions:
    'You are a concise demo assistant for the 10thfloor:agent Meteor package. '
    + 'You have a clock tool and an ask-gated refund tool; use them when asked.',
  tools: [
    {
      name: 'clock',
      description: 'The current server time',
      args: { type: 'object', properties: {} },
      run: async () => new Date().toISOString(),
    },
    {
      name: 'refund',
      description: 'Refund an order (requires human approval)',
      args: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
      gate: 'ask',
      run: async ({ orderId }) => `Refunded ${orderId} (demo — nothing real happened)`,
    },
  ],
  budget: { turns: 50, toolCalls: 20, approval: 10 * 60 * 1000 },
  ...(live ? {} : { provider: mockProvider(demoScript) }),
});

/**
 * Slack as a second surface for the SAME demo agent (channels spec): DM the
 * bot or @-mention it, and "refund…" parks an approval that arrives in Slack
 * as Approve/Deny buttons. Registered only when settings carry the app's
 * credentials — see settings.example.json and the channel package's README
 * for the Slack-side setup — so a plain `meteor run` stays exactly as it was.
 */
const slackCfg = Meteor.settings?.packages?.['10thfloor:agent']?.slack;
const slackReady = !!(slackCfg?.botToken && slackCfg?.signingSecret);
if (slackReady) {
  Agent.channel('slack', slack({
    agent: 'demo',
    botToken: slackCfg.botToken,
    signingSecret: slackCfg.signingSecret,
    // The account-linking loop (spec §12): DM the bare word "link" to the bot
    // and it answers with this one-time URL; the web client recognizes the
    // /link/<token> path and redeems it through the method below — from the
    // SIGNED-IN side, which is the direction linking must run.
    linkUrl: (token) => Meteor.absoluteUrl(`link/${token}`),
  }));
}

Meteor.methods({
  /**
   * Redeem a channel-linking token for the LOGGED-IN user. The token proves
   * control of the external identity (only its Slack DM ever saw it); the
   * DDP session proves the web account; the package's `redeemLinkToken` burns
   * the token atomically, writes the identity row, and claims the anonymous
   * conversations that identity created. Returns what the UI needs to say.
   */
  /**
   * Adopt the anonymous conversation this browser already holds, at sign-in.
   *
   * Consistent with the capability model rather than a loosening of it: for an
   * anonymous session, KNOWING THE ID is full ownership (send, read, approve),
   * so converting possession into durable ownership for the signed-in holder
   * grants nothing the caller lacked — it makes it survive localStorage. The
   * update is guarded on `userId: null`, so a session someone already owns can
   * never be taken; and claiming ends the id's shared-capability life, which
   * is the point of claiming.
   *
   * Returns 'claimed' (adopted just now), 'yours' (already this account's —
   * a re-login), or 'no' (unknown, or owned by someone else — the two are
   * deliberately indistinguishable).
   */
  async 'demo.claimSession'(sessionId) {
    check(sessionId, String);
    if (!this.userId) {
      throw new Meteor.Error('not-signed-in', 'Sign in first.');
    }
    const claimed = await AgentSessions.updateAsync(
      { _id: sessionId, userId: null },
      { $set: { userId: this.userId, updatedAt: new Date() } },
    );
    if (claimed === 1) return 'claimed';
    const mine = await AgentSessions.findOneAsync({ _id: sessionId, userId: this.userId });
    return mine ? 'yours' : 'no';
  },

  async 'demo.linkChannel'(token) {
    check(token, String);
    if (!this.userId) {
      throw new Meteor.Error('not-signed-in', 'Sign in first — linking runs from the authenticated side.');
    }
    const identity = await redeemLinkToken(token, this.userId);
    if (!identity) {
      // Unknown, spent, or expired — one indistinguishable answer, on purpose.
      throw new Meteor.Error('bad-token', 'That link is invalid or has expired. Ask the bot for a new one.');
    }
    return { kind: identity.kind, externalUserId: identity.externalUserId };
  },
});

Meteor.startup(() => {
  console.log(
    `[demo] agent ready (${live ? 'LIVE provider via pi-ai' : 'scripted mock — set ANTHROPIC_API_KEY for live'})`,
  );
  if (slackReady) {
    console.log('[demo] slack channel registered — webhook at /agent/channels/slack');
  } else {
    console.log('[demo] slack channel not configured (add slack credentials to settings — see settings.example.json)');
  }
});
