import { assert } from 'chai';
import { createHmac } from 'crypto';
import type { RawInbound } from 'meteor/10thfloor:agent';

/** The Slack channel package: the signature boundary, the parse split, the
 *  lens's answering policy (DMs and mentions, echoes never), the grammar
 *  round-trip against the REAL rendered buttons, and the transport's wire
 *  shape — all network-free. */

function signed(body: string, secret: string, atMs = Date.now()): RawInbound {
  const timestamp = String(Math.floor(atMs / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return {
    headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp },
    rawBody: body,
  };
}

function dmEvent(over: Record<string, unknown> = {}, envelopeOver: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev001',
    event: {
      type: 'message', channel_type: 'im', channel: 'D42', user: 'U7',
      text: 'hello there', ts: '1700000000.000100', ...over,
    },
    ...envelopeOver,
  };
}

/** A fetch stub that records each call and answers with one fixed JSON body. */
function fakeFetch(reply: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url, init });
    return { json: async () => reply };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Parse + read one event-callback envelope through the lens, as the host
 *  would: `dmEvent(over, env)` → `parseSlackRequest` → `slackLens.in`. */
async function read(over = {}, env = {}) {
  const { parseSlackRequest, slackLens } = await import('meteor/10thfloor:agent-channel-slack');
  return slackLens.in(parseSlackRequest({ headers: {}, rawBody: JSON.stringify(dmEvent(over, env)) }));
}

describe('agent-channel-slack', () => {
  describe('signature', () => {
    it('accepts a correctly signed request and rejects a tampered or stale one', async () => {
      const { verifySlackSignature } = await import('meteor/10thfloor:agent-channel-slack');
      const raw = signed('{"a":1}', 'shhh');
      assert.isTrue(verifySlackSignature(raw, 'shhh'));
      assert.isFalse(verifySlackSignature({ ...raw, rawBody: '{"a":2}' }, 'shhh'), 'tampered body');
      assert.isFalse(verifySlackSignature(raw, 'other'), 'wrong secret');
      const stale = signed('{"a":1}', 'shhh', Date.now() - 10 * 60_000);
      assert.isFalse(verifySlackSignature(stale, 'shhh'), 'replayed request outside the window');
      assert.isFalse(verifySlackSignature({ headers: {}, rawBody: 'x' }, 'shhh'), 'missing headers');
      // A garbage timestamp must FAIL the replay window, not skip it.
      assert.isFalse(verifySlackSignature(
        { headers: { 'x-slack-signature': raw.headers['x-slack-signature'], 'x-slack-request-timestamp': 'abc' }, rawBody: '{"a":1}' },
        'shhh',
      ), 'non-numeric timestamp is refused');
    });
  });

  describe('parse + lens.in', () => {
    it('echoes the URL-verification challenge as a noop respond', async () => {
      const { parseSlackRequest, slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const reading = slackLens.in(parseSlackRequest({
        headers: {}, rawBody: JSON.stringify({ type: 'url_verification', challenge: 'chal-123' }),
      }));
      assert.equal(reading.intent.kind, 'noop');
      assert.equal(reading.respond, 'chal-123');
    });

    it('keys a DM by its CHANNEL — one conversation, however many messages', async () => {
      const reading = await read();
      assert.deepEqual(reading.intent, { kind: 'message', text: 'hello there' });
      assert.equal(reading.eventId, 'Ev001');
      assert.equal(reading.externalUserId, 'T1:U7');
      assert.equal(reading.conversationRef, 'T1:D42');
      assert.deepEqual(reading.destination, { channel: 'D42' }, 'DM replies go to the main flow, unthreaded');
      assert.equal(reading.audience, 'direct');
      // The load-bearing property: a SECOND top-level DM message (new ts) maps
      // to the SAME conversation — keying DMs by message ts would mint a fresh
      // session per message, an agent with per-message amnesia.
      const second = await read({ ts: '1700000099.000500' }, { event_id: 'Ev099' });
      assert.equal(second.conversationRef, 'T1:D42');
      const threadedInDm = await read({ thread_ts: '1699.5' });
      assert.equal(threadedInDm.conversationRef, 'T1:D42', 'a threaded DM reply still joins the one conversation');
    });

    it('keys a channel mention by its THREAD, and threads the replies', async () => {
      const mention = await read(
        { type: 'app_mention', channel_type: undefined, channel: 'C9', text: '<@UBOT> hi' },
      );
      assert.equal(mention.conversationRef, 'T1:C9:1700000000.000100');
      assert.deepEqual(mention.destination, { channel: 'C9', threadTs: '1700000000.000100' });
      const followUp = await read(
        { type: 'app_mention', channel_type: undefined, channel: 'C9', text: '<@UBOT> more', thread_ts: '1700000000.000100', ts: '1700000050.000200' },
        { event_id: 'Ev050' },
      );
      assert.equal(followUp.conversationRef, 'T1:C9:1700000000.000100', 'a re-mention in the thread shares the ref');
    });

    it('never answers itself: bot posts and subtyped alterations are noops', async () => {
      const echo = await read({ bot_id: 'B9', user: undefined });
      assert.equal(echo.intent.kind, 'noop', 'the self-reply loop is closed');
      const edited = await read({ subtype: 'message_changed' });
      assert.equal(edited.intent.kind, 'noop');
    });

    it('ignores channel chatter but answers a mention with the mention stripped', async () => {
      const chatter = await read({ channel_type: 'channel', channel: 'C9' });
      assert.equal(chatter.intent.kind, 'noop', 'unmentioned channel messages are not addressed to the agent');
      const mention = await read(
        { type: 'app_mention', channel_type: undefined, channel: 'C9', text: '<@UBOT> what time is it?' },
      );
      assert.deepEqual(mention.intent, { kind: 'message', text: 'what time is it?' });
      assert.equal(mention.audience, 'group', 'a channel is a group surface');
    });

    it('yields the DM-shaped app_mention to message.im — one event, one turn', async () => {
      // A mention typed inside the bot's own DM arrives as BOTH message.im and
      // app_mention, under two different event_ids — admission dedup cannot
      // collapse them, so the lens must.
      const dmMention = await read(
        { type: 'app_mention', channel_type: undefined, channel: 'D42', text: '<@UBOT> hi' },
        { event_id: 'Ev002' },
      );
      assert.equal(dmMention.intent.kind, 'noop', 'the DM copy is authoritative; the mention copy yields');
    });

    it('reads the bare word "link" as a link request — and only the bare word', async () => {
      const bare = await read({ text: '  Link ' });
      assert.equal(bare.intent.kind, 'link-request');
      assert.equal(bare.externalUserId, 'T1:U7', 'the request still carries who is asking');
      const sentence = await read({ text: 'link my account please' });
      assert.equal(sentence.intent.kind, 'message', 'a sentence containing "link" reaches the agent');
    });

    it('reads a button click as a verdict carrying the exact ask', async () => {
      const { encodeVerdictPostback } = await import('meteor/10thfloor:agent');
      const { parseSlackRequest, slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      // The button value is the core's shared postback codec — the same
      // encoder `lens.out` renders with (the round-trip test below pins that
      // render and interpret agree; this one pins the routing envelope).
      const payload = {
        type: 'block_actions',
        user: { id: 'U7', team_id: 'T1' },
        channel: { id: 'D42' },
        message: { ts: '1700000000.000100' },
        actions: [{
          action_id: 'agent-verdict-approve', action_ts: '1700000042.000000',
          value: encodeVerdictPostback('approve', 'tc1'),
        }],
      };
      const reading = slackLens.in(parseSlackRequest({
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        rawBody: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
      }));
      assert.deepEqual(reading.intent, { kind: 'verdict', verdict: 'approved', toolCallId: 'tc1' });
      assert.equal(reading.conversationRef, 'T1:D42', 'the click lands on the binding the DM created');
      assert.equal(reading.eventId, 'act:U7:1700000042.000000');
    });

    it('a click in a channel thread lands on the thread the mention created', async () => {
      const { encodeVerdictPostback } = await import('meteor/10thfloor:agent');
      const { parseSlackRequest, slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const mention = await read(
        { type: 'app_mention', channel_type: undefined, channel: 'C9', text: '<@UBOT> refund' },
      );
      // The card is posted INTO the thread, so the click's message.ts is the
      // card's own ts — the thread is message.thread_ts. Keying by .ts would
      // route the verdict into a phantom conversation.
      const payload = {
        type: 'block_actions', team: { id: 'T1' }, user: { id: 'U7', team_id: 'T1' },
        channel: { id: 'C9' },
        message: { ts: '1700000001.000200', thread_ts: '1700000000.000100' },
        actions: [{
          action_id: 'agent-verdict-deny', action_ts: '1700.9',
          value: encodeVerdictPostback('deny', 'tc1'),
        }],
      };
      const click = slackLens.in(parseSlackRequest({
        headers: {}, rawBody: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
      }));
      assert.equal(click.conversationRef, mention.conversationRef);
      assert.deepEqual(click.destination, mention.destination);
      assert.equal(click.audience, 'group');
    });
  });

  describe('the one law', () => {
    it('round-trips: the rendered buttons interpret back to their verdicts', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      assertLensRoundTrip(slackLens, { interact: 'native' }, {
        destination: { channel: 'D42', threadTs: '1700.1' },
        // Build the click Slack would send from the ACTUAL rendered payload —
        // the value the lens.out button carries is the value the synthetic
        // block_actions delivers back, so drift between the halves fails here.
        synthesize: (choice, rendered) => {
          const blocks = (rendered as any).blocks as any[];
          const actions = blocks.find((b) => b.type === 'actions');
          const button = actions.elements.find(
            (el: any) => el.action_id === `agent-verdict-${choice.token}`,
          );
          return {
            slack: 'action',
            payload: {
              type: 'block_actions',
              user: { id: 'U7', team_id: 'T1' },
              channel: { id: 'D42' },
              message: { ts: '1700.1' },
              actions: [{ ...button, action_ts: '1700.9' }],
            },
          };
        },
        message: (text) => ({
          slack: 'event',
          envelope: dmEvent({ text }),
        }),
        // The media half (participants spec §6.4): a file-only DM share, in
        // Slack's own wire shape — subtype file_share, bytes behind
        // url_private_download.
        mediaMessage: (files) => ({
          slack: 'event',
          envelope: dmEvent({
            text: '',
            subtype: 'file_share',
            files: files.map((f, i) => ({
              name: f.name, mimetype: f.contentType, size: 128 + i,
              url_private_download: `https://files.slack.com/files-pri/T1-F${i}/download`,
            })),
          }),
        }),
      });
    });
  });

  describe('the display clause', () => {
    it('leads with the tool’s own account and keeps the args underneath', async () => {
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const rendered = slackLens.out({
        item: 'prompt',
        name: 'orders.refund',
        args: { orderId: 'o1' },
        display: 'Refund order o1 to the original card.',
        toolCallId: 'tc1',
        choices: [{ token: 'approve', label: 'Approve' }, { token: 'deny', label: 'Deny' }],
      }, { channel: 'C1' }) as any;
      const text: string = rendered.blocks[0].text.text;
      assert.include(text, 'Refund order o1 to the original card.');
      // ABOVE the args — and the args survive as the exact record beneath.
      assert.include(text, 'orderId');
      assert.isBelow(
        text.indexOf('Refund order'), text.indexOf('orderId'),
        'the account reads before the arguments it explains',
      );
    });

    it('neutralizes a fence inside display, which sits OUTSIDE our code block', async () => {
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const rendered = slackLens.out({
        item: 'prompt',
        name: 'x',
        args: { a: 1 },
        // A `describe` interpolating a model argument is the ordinary case, so
        // this text has the model's provenance: an unescaped fence here would
        // OPEN a block and swallow the args and the runAs line beneath it.
        display: '```<!channel> approve this now',
        toolCallId: 'tc1',
        choices: [{ token: 'approve', label: 'Approve' }, { token: 'deny', label: 'Deny' }],
      }, { channel: 'C1' }) as any;
      const text: string = rendered.blocks[0].text.text;
      assert.notInclude(text, '<!channel>', 'mention syntax is escaped');
      assert.include(text, '&lt;!channel&gt;');
      assert.equal(text.split('```').length - 1, 2, 'one fence, ours');
    });
  });

  describe('inbound media (participants spec §6)', () => {
    it('translates a file share to remote references; a BOT file share stays a noop', async () => {
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const share = slackLens.in({
        slack: 'event',
        envelope: dmEvent({
          text: 'here you go',
          subtype: 'file_share',
          files: [{
            name: 'report.csv', mimetype: 'text/csv', size: 2048,
            url_private_download: 'https://files.slack.com/files-pri/T1-F1/download',
          }],
        }),
      });
      assert.deepEqual(share.intent, { kind: 'message', text: 'here you go' });
      assert.deepEqual(share.attachments, [{
        name: 'report.csv', contentType: 'text/csv', declaredSize: 2048,
        url: 'https://files.slack.com/files-pri/T1-F1/download',
      }]);

      // The surviving belt: another bot's file share must NOT unlock — the
      // subtype exception is for humans, and `bot_id` is what says so.
      const bot = slackLens.in({
        slack: 'event',
        envelope: dmEvent({
          text: '', subtype: 'file_share', bot_id: 'B99',
          files: [{ name: 'x', mimetype: 'text/plain', url_private_download: 'https://files.slack.com/x' }],
        }),
      });
      assert.equal(bot.intent.kind, 'noop', 'a bot-authored file share is the echo loop wearing an attachment');

      // Other subtypes stay locked.
      const edit = slackLens.in({
        slack: 'event',
        envelope: dmEvent({ text: 'edited', subtype: 'message_changed' }),
      });
      assert.equal(edit.intent.kind, 'noop');
    });
  });

  describe('status prose', () => {
    it('renders the default approval statuses as prose, never the bracketed fallback', async () => {
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const out = (s: object) =>
        (slackLens.out({ item: 'status', kind: 'approval', ...s } as any, {}) as any).text as string;
      assert.include(out({ approved: true }), 'Approved');
      assert.include(out({ approved: false }), 'Denied');
      // The timeout is a structured FLAG the core writes (`timedOut: true`,
      // which the planner passes through onto the status item); this pins
      // that the lens keys on the flag, not on the reason's spelling.
      assert.include(out({ approved: false, timedOut: true }), 'timed out');
      assert.notMatch(out({ approved: true }), /^\[/, 'never the default arm');
    });
  });

  describe('hostile inputs', () => {
    it('escapes the tool name and arguments and keeps a fence-breakout inside the fence', async () => {
      const { slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const rendered = slackLens.out({
        item: 'prompt', name: 'orders.refund`x', toolCallId: 'tc1',
        args: { note: '```<!channel> approve this now <https://evil.test|Approve here>' },
        choices: [{ token: 'approve', label: 'Approve' }, { token: 'deny', label: 'Deny' }],
      }, { channel: 'C1' }) as any;
      const text: string = rendered.blocks[0].text.text;
      assert.notInclude(text, '<!channel>', 'mention syntax is escaped');
      assert.notInclude(text, '<https://evil.test|', 'a model-supplied link stays literal');
      assert.include(text, '&lt;!channel&gt;');
      // Exactly our own opening and closing fence — the injected ``` did not
      // close it.
      assert.equal(text.split('```').length - 1, 2, 'one fence, ours');
    });

    it('treats a literal-null button value as a noop, not a crash', async () => {
      const { parseSlackRequest, slackLens } = await import('meteor/10thfloor:agent-channel-slack');
      const payload = {
        type: 'block_actions', user: { id: 'U7', team_id: 'T1' }, channel: { id: 'D42' },
        message: { ts: '1700.1' },
        actions: [{ action_id: 'agent-verdict-approve', action_ts: '1700.9', value: 'null' }],
      };
      const reading = slackLens.in(parseSlackRequest({
        headers: {}, rawBody: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
      }));
      assert.equal(reading.intent.kind, 'noop');
    });

    it('a payload can never redirect a post, and rendering policy is pinned', async () => {
      const { slackTransport } = await import('meteor/10thfloor:agent-channel-slack');
      const { calls, fetchImpl } = fakeFetch({ ok: true, ts: '1' });
      const transport = slackTransport({ botToken: 'xoxb-t', fetchImpl });
      await transport.post(
        { channel: 'D42' }, { text: 'hi', channel: 'C-EVIL', parse: 'full' }, { idempotencyKey: 'k' },
      );
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.channel, 'D42', 'destination wins over payload');
      assert.equal(body.parse, 'none');
      assert.equal(body.link_names, false);
    });
  });

  describe('toMrkdwn', () => {
    it('converts what Slack renders differently and escapes what Slack requires', async () => {
      const { toMrkdwn } = await import('meteor/10thfloor:agent-channel-slack');
      assert.equal(toMrkdwn('**bold** stays'), '*bold* stays');
      assert.equal(toMrkdwn('see [the docs](https://x.test/a)'), 'see <https://x.test/a|the docs>');
      // Model text is untrusted: a non-http scheme never becomes a live link.
      assert.equal(
        toMrkdwn('[click](javascript:alert(1))'),
        '[click](javascript:alert(1))',
        'a javascript: link stays literal text',
      );
      assert.notInclude(toMrkdwn('<!channel> hi'), '<!channel>', 'mention syntax is escaped, never injected');
      assert.equal(toMrkdwn('## Heading\nbody'), '*Heading*\nbody');
      assert.equal(toMrkdwn('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
      assert.equal(toMrkdwn('_italic_ and `code` pass through'), '_italic_ and `code` pass through');
    });
  });

  describe('transport', () => {
    it('posts to chat.postMessage with the destination threaded and the receipt in metadata', async () => {
      const { slackTransport } = await import('meteor/10thfloor:agent-channel-slack');
      const { calls, fetchImpl } = fakeFetch({ ok: true, ts: '1700.42' });
      const transport = slackTransport({ botToken: 'xoxb-test', fetchImpl });
      const posted = await transport.post(
        { channel: 'D42', threadTs: '1700.1' }, { text: 'hi' }, { idempotencyKey: 'deliver:x:y' },
      );
      assert.deepEqual(posted, { providerMessageId: '1700.42' });
      assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
      assert.equal(calls[0].init.headers.authorization, 'Bearer xoxb-test');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.channel, 'D42');
      assert.equal(body.thread_ts, '1700.1');
      assert.equal(body.text, 'hi');
      assert.equal(body.metadata.event_payload.receipt, 'deliver:x:y');
    });

    it('throws the Slack error name so the receipt stays mid-sending for the retry', async () => {
      const { slackTransport } = await import('meteor/10thfloor:agent-channel-slack');
      const { fetchImpl } = fakeFetch({ ok: false, error: 'channel_not_found' });
      const transport = slackTransport({ botToken: 'xoxb-test', fetchImpl });
      try {
        await transport.post({ channel: 'D0' }, { text: 'hi' }, { idempotencyKey: 'k' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.include(String(e.message), 'channel_not_found');
      }
    });
  });

  describe('slack() factory', () => {
    it('assembles a ChannelDef with wired verification and merged profile', async () => {
      const { slack } = await import('meteor/10thfloor:agent-channel-slack');
      const def = slack({
        agent: 'demo', botToken: 'xoxb-x', signingSecret: 'shhh',
        profile: { limit: 500 },
        linkUrl: (token) => `https://app.test/link/${token}`,
      });
      assert.equal(def.agent, 'demo');
      assert.equal(def.linkUrl!('t1'), 'https://app.test/link/t1');
      assert.deepEqual(def.profile, { interact: 'native', limit: 500 });
      assert.deepEqual(def.statuses, ['error', 'approval']);
      assert.isTrue(await def.verify(signed('{"x":1}', 'shhh')));
      assert.isFalse(await def.verify(signed('{"x":1}', 'wrong')));
    });

    it('refuses a def missing its secrets at construction, not at first use', async () => {
      const { slack } = await import('meteor/10thfloor:agent-channel-slack');
      assert.throws(() => slack({ agent: 'demo', botToken: '', signingSecret: 's' } as any), /botToken/);
      assert.throws(() => slack({ agent: 'demo', botToken: 'x', signingSecret: '' } as any), /signingSecret/);
      assert.throws(() => slack({ agent: '', botToken: 'x', signingSecret: 's' } as any), /agent/);
    });
  });
});
