import { assert } from 'chai';
import type { RawInbound } from 'meteor/10thfloor:agent';

/** The email channel: the webhook's Basic-auth boundary, stateless thread
 *  recovery in all four orders, the auto-responder echo rules, the quoted-
 *  reply stripper, both approval grammars' round trips, and the transport's
 *  wire shape — all network-free. */

const pm = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({
  MessageID: 'pm-inbound-1',
  FromFull: { Email: 'Ada@Example.com', Name: 'Ada' },
  From: 'Ada <Ada@Example.com>',
  To: 'agent@inbound.test',
  ToFull: [{ Email: 'agent@inbound.test', MailboxHash: '' }],
  MailboxHash: '',
  Subject: 'Order A-1001',
  TextBody: 'Where is my order?',
  StrippedTextReply: '',
  Headers: Object.entries({ 'Message-ID': '<m1@example.com>', ...headers }).map(([Name, Value]) => ({ Name, Value })),
  ...over,
});

function basic(user: string, pass: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

async function read(body: unknown) {
  const { parsePostmarkInbound, emailLens } = await import('meteor/10thfloor:agent-channel-email');
  const raw: RawInbound = { headers: {}, rawBody: JSON.stringify(body) };
  return emailLens.in(parsePostmarkInbound(raw));
}

describe('agent-channel-email', () => {
  describe('webhook credential', () => {
    it('accepts the configured Basic-auth pair and rejects anything else', async () => {
      const { verifyPostmarkWebhook } = await import('meteor/10thfloor:agent-channel-email');
      assert.isTrue(verifyPostmarkWebhook({ headers: basic('hook', 's3cret'), rawBody: '{}' }, 'hook', 's3cret'));
      assert.isFalse(verifyPostmarkWebhook({ headers: basic('hook', 'wrong'), rawBody: '{}' }, 'hook', 's3cret'));
      assert.isFalse(verifyPostmarkWebhook({ headers: basic('other', 's3cret'), rawBody: '{}' }, 'hook', 's3cret'));
      assert.isFalse(verifyPostmarkWebhook({ headers: {}, rawBody: '{}' }, 'hook', 's3cret'), 'missing header');
      assert.isFalse(verifyPostmarkWebhook({ headers: { authorization: 'Bearer x' }, rawBody: '{}' }, 'hook', 's3cret'));
    });
  });

  describe('threading — the conversation key, recovered statelessly', () => {
    it('keys a fresh message by the hash of its own Message-ID, and threads the reply destination', async () => {
      const { threadKey } = await import('meteor/10thfloor:agent-channel-email');
      const r = await read(pm());
      assert.deepEqual(r.intent, { kind: 'message', text: 'Where is my order?' });
      assert.equal(r.conversationRef, threadKey('m1@example.com'));
      assert.equal(r.externalUserId, 'ada@example.com', 'address normalized');
      assert.equal(r.eventId, 'pm-inbound-1');
      assert.equal(r.audience, 'direct');
      assert.deepEqual(r.destination, {
        to: 'ada@example.com', subject: 'Re: Order A-1001', rootMessageId: 'm1@example.com',
        replyKey: threadKey('m1@example.com'),
      });
    });

    it('recovers the same key from the mailbox hash, from References, and from In-Reply-To', async () => {
      const { threadKey } = await import('meteor/10thfloor:agent-channel-email');
      const key = threadKey('m1@example.com');
      const viaHash = await read(pm({ MailboxHash: key, MessageID: 'pm-2' }, { 'Message-ID': '<m9@example.com>' }));
      assert.equal(viaHash.conversationRef, key, 'our Reply-To came back — hash wins, whatever the headers say');
      const viaRefs = await read(pm({ MessageID: 'pm-3' }, {
        'Message-ID': '<m3@example.com>', References: '<m1@example.com> <pm-out-1@mtasv.net>',
      }));
      assert.equal(viaRefs.conversationRef, key, 'the first References entry is the root');
      const viaIrt = await read(pm({ MessageID: 'pm-4' }, {
        'Message-ID': '<m4@example.com>', 'In-Reply-To': '<M1@EXAMPLE.COM>',
      }));
      assert.equal(viaIrt.conversationRef, key, 'In-Reply-To, case-insensitively');
      const fresh = await read(pm({ MessageID: 'pm-5' }, { 'Message-ID': '<unrelated@example.com>' }));
      assert.notEqual(fresh.conversationRef, key, 'a message with no ties is a new thread');
    });

    it('keeps one Re: however the subject came in, and builds the plus-hash reply address', async () => {
      const { reSubject, replyToFor } = await import('meteor/10thfloor:agent-channel-email');
      assert.equal(reSubject('Order A-1001'), 'Re: Order A-1001');
      assert.equal(reSubject('RE: Order A-1001'), 'RE: Order A-1001');
      assert.equal(reSubject('  '), 'Re: (no subject)');
      assert.equal(replyToFor('agent@inbound.test', 'abc123'), 'agent+abc123@inbound.test');
    });
  });

  describe('echo and text rules', () => {
    it('drops auto-replies, bounces, and daemon mail — the auto-responder loop never forms', async () => {
      assert.equal((await read(pm({}, { 'Auto-Submitted': 'auto-replied' }))).intent.kind, 'noop');
      assert.equal((await read(pm({}, { Precedence: 'bulk' }))).intent.kind, 'noop');
      assert.equal((await read(pm({}, { 'X-Autoreply': 'yes' }))).intent.kind, 'noop');
      assert.equal((await read(pm({ FromFull: { Email: 'MAILER-DAEMON@mx.test' } }))).intent.kind, 'noop');
      assert.equal((await read(pm({}, { 'Auto-Submitted': 'no' }))).intent.kind, 'message', '"no" is the explicit non-auto value');
    });

    it('prefers the provider\'s stripped reply, strips quotes itself otherwise, and noops on no text', async () => {
      const stripped = await read(pm({ StrippedTextReply: 'Just the new part', TextBody: 'Just the new part\n\nOn Mon, Ada wrote:\n> old' }));
      assert.deepEqual(stripped.intent, { kind: 'message', text: 'Just the new part' });
      const fallback = await read(pm({ StrippedTextReply: '', TextBody: 'Thanks!\n\nOn Mon, 23 Aug 2026 at 10:00, Agent <agent@inbound.test> wrote:\n> earlier\n> text' }));
      assert.deepEqual(fallback.intent, { kind: 'message', text: 'Thanks!' });
      const empty = await read(pm({ StrippedTextReply: '', TextBody: '' }));
      assert.equal(empty.intent.kind, 'noop');
    });

    it('reads the bare word "link" as a link request', async () => {
      assert.equal((await read(pm({ TextBody: ' Link ' }))).intent.kind, 'link-request');
      assert.equal((await read(pm({ TextBody: 'link my account please' }))).intent.kind, 'message');
    });

    it('stripQuotedReply handles the common reply shapes conservatively', async () => {
      const { stripQuotedReply } = await import('meteor/10thfloor:agent-channel-email');
      assert.equal(stripQuotedReply('Yes please.\r\n\r\n-----Original Message-----\r\nFrom: x\r\nblah'), 'Yes please.');
      assert.equal(stripQuotedReply('Sounds good\n\nFrom: Agent <a@b>\nSent: Monday\nTo: me\nSubject: hi\nquoted'), 'Sounds good');
      assert.equal(stripQuotedReply('Done\n-- \nAda\nSome Corp'), 'Done', 'signature trimmed');
      assert.equal(stripQuotedReply('line one\n> quoted\nline two'), 'line one\nline two', 'quoted lines dropped, rest kept');
      assert.equal(stripQuotedReply('On the whole I agree.\nMore.'), 'On the whole I agree.\nMore.', 'a sentence starting with "On" is not a reply marker');
      assert.equal(stripQuotedReply('On Mon, Agent wrote:\n> may I refund?\nYES'), 'YES', 'bottom-posted new text under the quote is not swallowed');
    });
  });

  describe('sender verification (the linked-account gate)', () => {
    it('trusts a From only when the mail passed author-aligned DKIM', async () => {
      const { isFromAuthenticated } = await import('meteor/10thfloor:agent-channel-email');
      const h = (v: string) => new Map([['x-spam-tests', v]]);
      assert.isTrue(isFromAuthenticated(h('DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS')));
      assert.isFalse(isFromAuthenticated(h('DKIM_SIGNED,DKIM_VALID,SPF_PASS')), 'valid but not author-aligned is not enough');
      assert.isFalse(isFromAuthenticated(h('SPF_PASS')), 'SPF authenticates the envelope return-path, not the From');
      assert.isFalse(isFromAuthenticated(new Map()), 'no header — fail closed');
      assert.isFalse(isFromAuthenticated(h('X_DKIM_VALID_AUX')), 'token boundary — no substring match');
    });

    it('reflects it on the reading, so the pipeline keeps an unverified sender anonymous', async () => {
      const spoofable = await read(pm());
      assert.isFalse(spoofable.senderVerified, 'a bare From never resolves to a linked account');
      const aligned = await read(pm({}, { 'X-Spam-Tests': 'DKIM_VALID_AU' }));
      assert.isTrue(aligned.senderVerified);
    });
  });

  describe('lens.out statuses', () => {
    it('reads the approval outcome from the structured flags, never the note prose', async () => {
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      const dest = { to: 'ada@example.com', subject: 'Re: x', replyKey: 'k' };
      const body = (extra: object): string =>
        (emailLens.out({ item: 'status', kind: 'approval', ...extra } as any, dest) as any).TextBody;
      assert.equal(body({ approved: true }), 'Approved.');
      assert.equal(body({ approved: false }), 'Denied.');
      assert.include(body({ approved: false, timedOut: true }), 'timed out',
        'the flag decides — a timeout is a denial nobody made, and the text must say so');
    });
  });

  describe('the one law', () => {
    it('under the link profile, renders every choice\'s single-use URL', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      assertLensRoundTrip(emailLens, { interact: 'link' }, {
        destination: { to: 'ada@example.com', subject: 'Re: x', replyKey: 'k' },
        message: (text) => ({ email: 'inbound', body: pm({ TextBody: text }) }),
      });
    });

    it('pairs each choice label with ITS OWN url, one per line', async () => {
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      // assertLensRoundTrip only proves every url is PRESENT; this pins the
      // label↔url association an index-zip regression would silently break.
      const out = emailLens.out({
        item: 'prompt', name: 'orders.refund', args: { id: 9 }, toolCallId: 'tc1',
        choices: [
          { token: 'approve', label: 'Approve', url: 'https://app.test/verdict/aaa' },
          { token: 'deny', label: 'Deny', url: 'https://app.test/verdict/ddd' },
        ],
      } as any, { to: 'ada@example.com', subject: 'Re: x', replyKey: 'k' }) as any;
      assert.include(out.TextBody, 'Approve: https://app.test/verdict/aaa');
      assert.include(out.TextBody, 'Deny: https://app.test/verdict/ddd');
    });

    it('under the menu profile, the reply words round-trip through the pipeline\'s grammar', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      assertLensRoundTrip(emailLens, { interact: 'menu' }, {
        destination: { to: 'ada@example.com', subject: 'Re: x', replyKey: 'k' },
        synthesize: (choice) => ({ email: 'inbound', body: pm({ TextBody: choice.match ?? choice.token }) }),
        message: (text) => ({ email: 'inbound', body: pm({ TextBody: text }) }),
      });
    });
  });

  describe('transport', () => {
    it('posts one threaded Postmark email: addressing last, Reply-To carries the key, receipt in a header', async () => {
      const { emailTransport } = await import('meteor/10thfloor:agent-channel-email');
      const calls: any[] = [];
      const fetchImpl = (async (url: any, init: any) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ ErrorCode: 0, MessageID: 'pm-out-1' }) };
      }) as unknown as typeof fetch;
      const transport = emailTransport({ serverToken: 'tok', from: 'Agent <agent@example.com>', inboundAddress: 'agent@inbound.test', fetchImpl });
      const posted = await transport.post(
        { to: 'ada@example.com', subject: 'Re: Order', rootMessageId: 'm1@example.com', replyKey: 'abc' },
        { Subject: 'Re: Order', TextBody: 'On its way.', To: 'attacker@evil.test' },
        { idempotencyKey: 'deliver:email:abc:m9' },
      );
      assert.deepEqual(posted, { providerMessageId: 'pm-out-1' });
      assert.equal(calls[0].url, 'https://api.postmarkapp.com/email');
      assert.equal(calls[0].init.headers['x-postmark-server-token'], 'tok');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.To, 'ada@example.com', 'a payload To cannot redirect the post');
      assert.equal(body.ReplyTo, 'agent+abc@inbound.test');
      assert.equal(body.TextBody, 'On its way.');
      const headers = Object.fromEntries(body.Headers.map((h: any) => [h.Name, h.Value]));
      assert.equal(headers['In-Reply-To'], '<m1@example.com>');
      assert.equal(headers.References, '<m1@example.com>');
      assert.equal(headers['X-Agent-Receipt'], 'deliver:email:abc:m9');
    });

    it('throws Postmark\'s error so the receipt stays mid-sending for the retry', async () => {
      const { emailTransport } = await import('meteor/10thfloor:agent-channel-email');
      const fetchImpl = (async () => ({ ok: true, json: async () => ({ ErrorCode: 300, Message: 'Invalid email request' }) })) as unknown as typeof fetch;
      const transport = emailTransport({ serverToken: 'tok', from: 'a@b', inboundAddress: 'i@b', fetchImpl });
      try {
        await transport.post({ to: 'x@y', subject: 's', replyKey: 'k' }, { TextBody: 'hi' }, { idempotencyKey: 'k' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.include(String(e.message), '300');
        assert.include(String(e.message), 'Invalid email request');
      }
    });
  });

  describe('email() factory', () => {
    it('picks the link profile with an approvalUrl and the menu profile without one', async () => {
      const { email } = await import('meteor/10thfloor:agent-channel-email');
      const base = { agent: 'demo', serverToken: 't', from: 'a@b', inboundAddress: 'i@b', webhookUser: 'u', webhookPassword: 'p' };
      const withLinks = email({ ...base, approvalUrl: (t) => `https://app.test/verdict/${t}` });
      assert.deepEqual(withLinks.profile, { interact: 'link', limit: 20_000 });
      assert.equal(withLinks.approvalUrl!('tok'), 'https://app.test/verdict/tok');
      const menu = email(base);
      assert.deepEqual(menu.profile, { interact: 'menu', limit: 20_000 });
      assert.isUndefined(menu.approvalUrl);
      assert.deepEqual(menu.statuses, ['error', 'approval']);
      assert.isTrue(await menu.verify({ headers: basic('u', 'p'), rawBody: '{}' }));
      assert.isFalse(await menu.verify({ headers: basic('u', 'x'), rawBody: '{}' }));
    });

    it('refuses a def missing its credentials at construction', async () => {
      const { email } = await import('meteor/10thfloor:agent-channel-email');
      assert.throws(() => email({ agent: 'demo', serverToken: '', from: 'a@b', inboundAddress: 'i@b', webhookUser: 'u', webhookPassword: 'p' }), /serverToken/);
      assert.throws(() => email({ agent: 'demo', serverToken: 't', from: 'a@b', inboundAddress: 'i@b', webhookUser: '', webhookPassword: 'p' }), /webhookUser/);
    });
  });
});
