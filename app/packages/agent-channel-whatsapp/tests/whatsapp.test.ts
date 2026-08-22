import { assert } from 'chai';
import { createHmac } from 'crypto';
import type { RawInbound } from 'meteor/10thfloor:agent';

/** The WhatsApp channel package: the two-shape trust boundary (GET handshake
 *  by verify_token, POST events by X-Hub-Signature-256), the number-pair
 *  conversation key, status-echo noops, button verdicts carrying the exact
 *  ask, the grammar round-trip against the actually rendered buttons, and
 *  the Graph API wire shape. */

function signed(body: unknown, appSecret = 'app-secret'): RawInbound {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return {
    headers: { 'x-hub-signature-256': signature },
    rawBody,
    url: '/agent/channels/whatsapp',
  };
}

function handshake(token = 'verify-me', challenge = 'chal-42'): RawInbound {
  return {
    headers: {},
    rawBody: '',
    url: `/agent/channels/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`,
  };
}

function textEvent(over: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'PN1' },
          messages: [{
            id: 'wamid.001', from: '15550001111', type: 'text',
            text: { body: 'hello there' }, ...over,
          }],
        },
      }],
    }],
  };
}

describe('agent-channel-whatsapp', () => {
  describe('hostile inputs', () => {
    it('treats a literal-null button id as a noop, not a crash', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const event = textEvent({
        type: 'interactive',
        text: undefined,
        interactive: { type: 'button_reply', button_reply: { id: 'null', title: 'Approve' } },
      });
      const reading = whatsappLens.in(parseWhatsAppRequest(signed(event)));
      assert.equal(reading.intent.kind, 'noop');
    });
  });

  describe('verify', () => {
    it('authenticates the GET handshake by verify_token', async () => {
      const { verifyWhatsAppRequest } = await import('meteor/10thfloor:agent-channel-whatsapp');
      assert.isTrue(verifyWhatsAppRequest(handshake('verify-me'), 'app-secret', 'verify-me'));
      assert.isFalse(verifyWhatsAppRequest(handshake('wrong'), 'app-secret', 'verify-me'));
    });

    it('authenticates event POSTs by X-Hub-Signature-256 over the raw body', async () => {
      const { verifyWhatsAppRequest } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const good = signed(textEvent());
      assert.isTrue(verifyWhatsAppRequest(good, 'app-secret', 'verify-me'));
      assert.isFalse(verifyWhatsAppRequest(good, 'other-secret', 'verify-me'), 'wrong app secret');
      const tampered = { ...good, rawBody: JSON.stringify(textEvent({ text: { body: 'evil' } })) };
      assert.isFalse(verifyWhatsAppRequest(tampered, 'app-secret', 'verify-me'), 'tampered body');
      assert.isFalse(
        verifyWhatsAppRequest({ headers: {}, rawBody: '{}' }, 'app-secret', 'verify-me'),
        'missing signature',
      );
    });
  });

  describe('parse + lens.in', () => {
    it('echoes the handshake challenge as a noop respond', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const reading = whatsappLens.in(parseWhatsAppRequest(handshake('verify-me', 'chal-42')));
      assert.equal(reading.intent.kind, 'noop');
      assert.equal(reading.respond, 'chal-42');
    });

    it('keys the conversation by business number + wa_id, always direct', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const reading = whatsappLens.in(parseWhatsAppRequest(signed(textEvent())));
      assert.deepEqual(reading.intent, { kind: 'message', text: 'hello there' });
      assert.equal(reading.conversationRef, 'PN1:15550001111');
      assert.equal(reading.externalUserId, '15550001111');
      assert.equal(reading.eventId, 'wamid.001');
      assert.deepEqual(reading.destination, { phoneNumberId: 'PN1', to: '15550001111' });
      assert.equal(reading.audience, 'direct');
    });

    it('noops status echoes and unsupported media', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const statusEcho = whatsappLens.in(parseWhatsAppRequest(signed({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.out', status: 'delivered' }] } }] }],
      })));
      assert.equal(statusEcho.intent.kind, 'noop', 'our own sends echo as statuses — the echo rule');
      const image = whatsappLens.in(parseWhatsAppRequest(signed(textEvent({ type: 'image', text: undefined }))));
      assert.equal(image.intent.kind, 'noop');
    });

    it('reads the bare word "link" as the link gesture', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const link = whatsappLens.in(parseWhatsAppRequest(signed(textEvent({ text: { body: ' Link ' } }))));
      assert.equal(link.intent.kind, 'link-request');
      const sentence = whatsappLens.in(parseWhatsAppRequest(signed(textEvent({ text: { body: 'link me up' } }))));
      assert.equal(sentence.intent.kind, 'message');
    });

    it('reads a button reply as a verdict carrying the exact ask', async () => {
      const { parseWhatsAppRequest, whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const reading = whatsappLens.in(parseWhatsAppRequest(signed(textEvent({
        type: 'interactive',
        text: undefined,
        interactive: {
          type: 'button_reply',
          button_reply: { id: JSON.stringify({ t: 'deny', c: 'tc7' }), title: 'Deny' },
        },
      }))));
      assert.deepEqual(reading.intent, { kind: 'verdict', verdict: 'denied', toolCallId: 'tc7' });
      assert.equal(reading.conversationRef, 'PN1:15550001111');
    });
  });

  describe('the one law', () => {
    it('round-trips: the rendered buttons interpret back to their verdicts', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      assertLensRoundTrip(whatsappLens, { interact: 'native' }, {
        destination: { phoneNumberId: 'PN1', to: '15550001111' },
        synthesize: (choice, rendered) => {
          const buttons = (rendered as any).interactive.action.buttons as any[];
          const button = buttons.find((b) => JSON.parse(b.reply.id).t === choice.token);
          return {
            wa: 'event',
            body: textEvent({
              type: 'interactive',
              text: undefined,
              interactive: { type: 'button_reply', button_reply: { id: button.reply.id, title: button.reply.title } },
            }),
          };
        },
        message: (text) => ({ wa: 'event', body: textEvent({ text: { body: text } }) }),
      });
    });

    it('keeps button titles within the Cloud API’s 20-character cap', async () => {
      const { whatsappLens } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const rendered: any = whatsappLens.out({
        item: 'prompt', name: 'x', args: {}, toolCallId: 'tc1',
        choices: [
          { token: 'approve', label: 'Approve' },
          { token: 'deny', label: 'Deny' },
        ],
      }, { phoneNumberId: 'PN1', to: '1' });
      for (const b of rendered.interactive.action.buttons) {
        assert.isAtMost(b.reply.title.length, 20);
        assert.isAtMost(b.reply.id.length, 256);
      }
    });
  });

  describe('transport', () => {
    it('posts to the phone number’s /messages with Bearer auth and reports the wamid', async () => {
      const { whatsappTransport } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const calls: any[] = [];
      const fetchImpl = (async (url: any, init: any) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.out9' }] }) };
      }) as unknown as typeof fetch;
      const transport = whatsappTransport({ accessToken: 'EAAB', fetchImpl });
      const posted = await transport.post(
        { phoneNumberId: 'PN1', to: '15550001111' },
        { type: 'text', text: { body: 'hi' } },
        { idempotencyKey: 'k' },
      );
      assert.deepEqual(posted, { providerMessageId: 'wamid.out9' });
      assert.include(calls[0].url, '/v20.0/PN1/messages');
      assert.equal(calls[0].init.headers.authorization, 'Bearer EAAB');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.messaging_product, 'whatsapp');
      assert.equal(body.to, '15550001111');
      assert.equal(body.text.body, 'hi');
    });

    it('throws the Graph error message — the 24-hour-window refusal lands here', async () => {
      const { whatsappTransport } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const fetchImpl = (async () => ({
        ok: false,
        json: async () => ({ error: { message: 'Re-engagement message', code: 131047 } }),
      })) as unknown as typeof fetch;
      const transport = whatsappTransport({ accessToken: 't', fetchImpl });
      try {
        await transport.post({ phoneNumberId: 'PN1', to: '1' }, { type: 'text', text: { body: 'x' } }, { idempotencyKey: 'k' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.include(String(e.message), 'Re-engagement');
      }
    });
  });

  describe('whatsapp() factory', () => {
    it('assembles a ChannelDef with both trust checks wired', async () => {
      const { whatsapp } = await import('meteor/10thfloor:agent-channel-whatsapp');
      const def = whatsapp({
        agent: 'demo', accessToken: 'EAAB', appSecret: 'app-secret', verifyToken: 'verify-me',
      });
      assert.equal(def.agent, 'demo');
      assert.deepEqual(def.profile, { interact: 'native', limit: 4000 });
      assert.isTrue(await def.verify(handshake('verify-me')));
      assert.isFalse(await def.verify(handshake('nope')));
      assert.isTrue(await def.verify(signed(textEvent())));
      assert.isFalse(await def.verify(signed(textEvent(), 'other')));
    });

    it('refuses missing credentials at construction', async () => {
      const { whatsapp } = await import('meteor/10thfloor:agent-channel-whatsapp');
      assert.throws(() => whatsapp({ agent: 'd', accessToken: '', appSecret: 's', verifyToken: 'v' } as any), /accessToken/);
      assert.throws(() => whatsapp({ agent: 'd', accessToken: 'a', appSecret: '', verifyToken: 'v' } as any), /appSecret/);
      assert.throws(() => whatsapp({ agent: 'd', accessToken: 'a', appSecret: 's', verifyToken: '' } as any), /verifyToken/);
    });
  });
});
