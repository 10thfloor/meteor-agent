import { assert } from 'chai';
import { createHmac } from 'crypto';
import type { RawInbound } from 'meteor/10thfloor:agent';

/** The SMS channel package: the Twilio signature over url+params, the number-
 *  pair conversation key, status-callback noops, the MENU grammar proven
 *  through the shared matching rule, plain-text conversion, and the
 *  transport's form-encoded wire shape. */

const URL_CFG = 'https://app.test/agent/channels/sms';

function signed(params: Record<string, string>, authToken = 'tok', url = URL_CFG): RawInbound {
  const rawBody = new URLSearchParams(params).toString();
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const signature = createHmac('sha1', authToken).update(data).digest('base64');
  return { headers: { 'x-twilio-signature': signature }, rawBody };
}

function inbound(over: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SM001', From: '+15550001111', To: '+15559990000',
    Body: 'hello there', ...over,
  };
}

describe('agent-channel-sms', () => {
  describe('verify', () => {
    it('accepts Twilio’s url+params signature and rejects tampering anywhere', async () => {
      const { verifyTwilioSignature } = await import('meteor/10thfloor:agent-channel-sms');
      const params = inbound();
      const good = signed(params);
      assert.isTrue(verifyTwilioSignature(good, 'tok', URL_CFG));
      assert.isFalse(verifyTwilioSignature(good, 'wrong', URL_CFG), 'wrong token');
      assert.isFalse(
        verifyTwilioSignature(good, 'tok', 'https://app.test/agent/channels/sms/'),
        'the configured URL must match to the character — a trailing slash breaks it',
      );
      const tampered = { ...good, rawBody: new URLSearchParams(inbound({ Body: 'evil' })).toString() };
      assert.isFalse(verifyTwilioSignature(tampered, 'tok', URL_CFG), 'tampered params');
      assert.isFalse(verifyTwilioSignature({ headers: {}, rawBody: '' }, 'tok', URL_CFG), 'missing header');
    });
  });

  describe('lens.in', () => {
    it('keys the conversation by the NUMBER PAIR, always direct', async () => {
      const { smsLens, parseTwilioForm } = await import('meteor/10thfloor:agent-channel-sms');
      const reading = smsLens.in(parseTwilioForm(new URLSearchParams(inbound()).toString()));
      assert.deepEqual(reading.intent, { kind: 'message', text: 'hello there' });
      assert.equal(reading.conversationRef, '+15559990000:+15550001111');
      assert.equal(reading.externalUserId, '+15550001111');
      assert.equal(reading.eventId, 'SM001');
      assert.deepEqual(reading.destination, { to: '+15550001111', from: '+15559990000' });
      assert.equal(reading.audience, 'direct');
      // A second text from the same phone lands in the SAME conversation.
      const again = smsLens.in(parseTwilioForm(
        new URLSearchParams(inbound({ MessageSid: 'SM002', Body: 'another' })).toString(),
      ));
      assert.equal(again.conversationRef, '+15559990000:+15550001111');
    });

    it('noops delivery-status callbacks', async () => {
      const { smsLens } = await import('meteor/10thfloor:agent-channel-sms');
      const status = smsLens.in({
        MessageSid: 'SM001', MessageStatus: 'delivered', To: '+15550001111', From: '+15559990000', Body: '',
      });
      assert.equal(status.intent.kind, 'noop');
    });

    it('reads the bare word "link" as the link gesture; YES stays a MESSAGE for the pipeline to judge', async () => {
      const { smsLens } = await import('meteor/10thfloor:agent-channel-sms');
      const link = smsLens.in(inbound({ Body: ' Link ' }));
      assert.equal(link.intent.kind, 'link-request');
      const yes = smsLens.in(inbound({ Body: 'YES' }));
      assert.deepEqual(yes.intent, { kind: 'message', text: 'YES' },
        'whether YES decides an approval is the receipt-backed pipeline’s call, never the stateless lens’s');
    });
  });

  describe('the one law (menu grammar)', () => {
    it('round-trips: the words the prompt offers are the words the grammar accepts', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { smsLens } = await import('meteor/10thfloor:agent-channel-sms');
      assertLensRoundTrip(smsLens, { interact: 'menu' }, {
        destination: { to: '+15550001111', from: '+15559990000' },
        // A menu activation IS a plain text: the helper routes it through the
        // same matchExpectation the pipeline uses.
        synthesize: (choice) => inbound({ Body: ` ${choice.match!.toLowerCase()} ` }),
        message: (text) => inbound({ Body: text }),
      });
    });

    it('renders the registered words into the prompt prose', async () => {
      const { smsLens } = await import('meteor/10thfloor:agent-channel-sms');
      const rendered: any = smsLens.out({
        item: 'prompt', name: 'orders.refund', args: { id: 9 }, toolCallId: 'tc1',
        choices: [
          { token: 'approve', label: 'Approve', match: 'YES' },
          { token: 'deny', label: 'Deny', match: 'NO' },
        ],
      }, { to: '+1', from: '+2' });
      assert.include(rendered.body, 'orders.refund');
      assert.include(rendered.body, 'Reply YES to approve, or NO to deny.');
    });
  });

  describe('lens.out statuses', () => {
    it('reads the approval outcome from the structured flags, never the note’s prose', async () => {
      const { smsLens } = await import('meteor/10thfloor:agent-channel-sms');
      const dest = { to: '+1', from: '+2' };
      const out = (extra: object): string =>
        (smsLens.out({ item: 'status', kind: 'approval', ...extra } as any, dest) as any).body;
      assert.equal(out({ approved: true }), 'Approved.');
      assert.equal(out({ approved: false }), 'Denied.');
      assert.include(out({ approved: false, timedOut: true }), 'timed out',
        'the flag decides — a timeout is a denial nobody made, and the text must say so');
    });
  });

  describe('toPlainText', () => {
    it('strips decoration and keeps both halves of a link', async () => {
      const { toPlainText } = await import('meteor/10thfloor:agent-channel-sms');
      assert.equal(toPlainText('**bold** and _italic_'), 'bold and italic');
      assert.equal(toPlainText('see [the docs](https://x.test/a)'), 'see the docs (https://x.test/a)');
      assert.equal(toPlainText('## Heading\nbody'), 'Heading\nbody');
      assert.equal(toPlainText('a_var_name stays'), 'a_var_name stays');
    });
  });

  describe('transport', () => {
    it('posts form-encoded Messages.json with Basic auth and reports the sid', async () => {
      const { smsTransport } = await import('meteor/10thfloor:agent-channel-sms');
      const calls: any[] = [];
      const fetchImpl = (async (url: any, init: any) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ sid: 'SMout1' }) };
      }) as unknown as typeof fetch;
      const transport = smsTransport({ accountSid: 'AC1', authToken: 'tok', fetchImpl });
      const posted = await transport.post(
        { to: '+15550001111', from: '+15559990000' }, { body: 'hi there' }, { idempotencyKey: 'k' },
      );
      assert.deepEqual(posted, { providerMessageId: 'SMout1' });
      assert.include(calls[0].url, '/Accounts/AC1/Messages.json');
      assert.equal(
        calls[0].init.headers.authorization,
        `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
      );
      const form = new URLSearchParams(calls[0].init.body);
      assert.equal(form.get('To'), '+15550001111');
      assert.equal(form.get('From'), '+15559990000');
      assert.equal(form.get('Body'), 'hi there');
    });

    it('throws Twilio’s message so the receipt stays mid-sending for the retry', async () => {
      const { smsTransport } = await import('meteor/10thfloor:agent-channel-sms');
      const fetchImpl = (async () => ({
        ok: false, json: async () => ({ message: 'The number is unverified', error_code: 21608 }),
      })) as unknown as typeof fetch;
      const transport = smsTransport({ accountSid: 'AC1', authToken: 'tok', fetchImpl });
      try {
        await transport.post({ to: '+1', from: '+2' }, { body: 'x' }, { idempotencyKey: 'k' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.include(String(e.message), 'unverified');
      }
    });
  });

  describe('sms() factory', () => {
    it('assembles a ChannelDef with wired verification and the menu profile', async () => {
      const { sms } = await import('meteor/10thfloor:agent-channel-sms');
      const def = sms({
        agent: 'demo', accountSid: 'AC1', authToken: 'tok', webhookUrl: URL_CFG,
      });
      assert.equal(def.agent, 'demo');
      assert.deepEqual(def.profile, { interact: 'menu', limit: 1500 });
      assert.isTrue(await def.verify(signed(inbound())));
      assert.isFalse(await def.verify(signed(inbound(), 'other')));
    });

    it('refuses missing credentials at construction', async () => {
      const { sms } = await import('meteor/10thfloor:agent-channel-sms');
      assert.throws(() => sms({ agent: 'd', accountSid: '', authToken: 't', webhookUrl: 'u' } as any), /accountSid/);
      assert.throws(() => sms({ agent: 'd', accountSid: 'a', authToken: '', webhookUrl: 'u' } as any), /authToken/);
      assert.throws(() => sms({ agent: 'd', accountSid: 'a', authToken: 't', webhookUrl: '' } as any), /webhookUrl/);
    });
  });
});
