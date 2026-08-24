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

  describe('attachments (email v2)', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const files = [
      { Name: 'report.csv', Content: b64('a,b\n1,2\n'), ContentType: 'text/csv', ContentLength: 8, ContentID: '' },
      { Name: 'logo.png', Content: b64('png'), ContentType: 'image/png', ContentLength: 3, ContentID: 'cid:logo@sig' },
    ];

    it('passes real attachments through and skips inline ContentID entries', async () => {
      const r = await read(pm({ Attachments: files }));
      assert.equal(r.intent.kind, 'message');
      assert.equal(r.attachments!.length, 1, 'the signature logo is furniture, not a file');
      assert.deepEqual(r.attachments![0], {
        name: 'report.csv', contentType: 'text/csv', size: 8, content: b64('a,b\n1,2\n'),
      });
    });

    it('an attachment-only mail is a message now — empty text, files riding', async () => {
      const r = await read(pm({ StrippedTextReply: '', TextBody: '', Attachments: [files[0]] }));
      assert.deepEqual(r.intent, { kind: 'message', text: '' });
      assert.equal(r.attachments!.length, 1);
      // No text and no kept files stays a noop — the v1 rule's floor.
      const empty = await read(pm({ StrippedTextReply: '', TextBody: '', Attachments: [files[1]] }));
      assert.equal(empty.intent.kind, 'noop', 'inline-only mail has nothing to send');
    });

    it('renders reply and overflow attachments as Postmark\'s Attachments field', async () => {
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      const dest = { to: 'ada@example.com', subject: 'Re: Order A-1001', replyKey: 'k' };
      const hydrated = [{ name: 'summary.csv', contentType: 'text/csv', size: 8, content: b64('x,y\n1,2\n') }];
      const reply: any = emailLens.out({ item: 'reply', text: 'Attached.', attachments: hydrated }, dest);
      assert.equal(reply.TextBody, 'Attached.');
      assert.deepEqual(reply.Attachments, [
        { Name: 'summary.csv', Content: b64('x,y\n1,2\n'), ContentType: 'text/csv' },
      ]);
      const overflow: any = emailLens.out({ item: 'overflow', head: 'Long…', attachments: hydrated }, dest);
      assert.equal(overflow.Attachments.length, 1, 'the text overflowed, not the work product');
      const bare: any = emailLens.out({ item: 'reply', text: 'No files.' }, dest);
      assert.notProperty(bare, 'Attachments');
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

  describe('composeEmailTool (email v2 §9)', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

    /** A transport-capturing fetch: every Postmark send body, in order. */
    function fakePostmark() {
      const sends: any[] = [];
      const fetchImpl = (async (_url: unknown, init: any) => {
        sends.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ MessageID: `pm-${sends.length}`, ErrorCode: 0 }) };
      }) as unknown as typeof fetch;
      return { sends, fetchImpl };
    }

    const factory = async (over: Record<string, unknown> = {}, fetchImpl?: typeof fetch) => {
      const { composeEmailTool } = await import('meteor/10thfloor:agent-channel-email');
      return composeEmailTool({
        serverToken: 't', from: 'Agent <agent@ourco.com>', inboundAddress: 'inbound@ourco.com',
        recipients: ['dana@ourco.com'],
        fetchImpl,
        ...over,
      } as any);
    };

    beforeEach(async () => {
      const { DeliveryReceipts, AgentAttachments, ChannelIdentities } = await import('meteor/10thfloor:agent');
      await (DeliveryReceipts as any).removeAsync({});
      await (AgentAttachments as any).removeAsync({});
      await (ChannelIdentities as any).removeAsync({});
    });

    it('requires a recipients policy and gates ask by default', async () => {
      const { composeEmailTool } = await import('meteor/10thfloor:agent-channel-email');
      assert.throws(() => composeEmailTool({
        serverToken: 't', from: 'a@b', inboundAddress: 'i@b',
      } as any), /recipients/);
      const tool = await factory();
      assert.equal(tool.gate, 'ask', 'every compose parks for approval unless the app loosens it');
      assert.equal((await factory({ gate: 'auto' })).gate, 'auto');
      assert.equal(tool.name, 'compose_email');
    });

    it('the model proposes `to`; the policy decides — allowlist, predicate, and fail-closed on a broken one', async () => {
      const { sends, fetchImpl } = fakePostmark();
      const ctx = { userId: 'u1', sessionId: 's1', toolCallId: 'tc-a' };
      const allow = await factory({}, fetchImpl);
      const refused: any = await allow.run({ to: 'stranger@evil.test', subject: 's', body: 'b' }, ctx as any);
      assert.isTrue(refused.refused);
      assert.equal(refused.reason, 'recipient-not-allowed');
      assert.equal(sends.length, 0, 'a refusal posts nothing');
      const badShape: any = await allow.run({ to: 'not-an-address', subject: 's', body: 'b' }, ctx as any);
      assert.equal(badShape.reason, 'invalid-recipient');

      const sent: any = await allow.run({ to: 'Dana@OurCo.com', subject: 'Hi', body: 'The summary.' }, ctx as any);
      assert.isTrue(sent.sent, 'the allowlist compares case-insensitively');
      assert.equal(sends.length, 1);

      const predicate = await factory({
        recipients: (to: string) => to.endsWith('@ourco.com'),
      }, fetchImpl);
      assert.isTrue((await predicate.run({ to: 'eng@ourco.com', subject: 's', body: 'b' }, { ...ctx, toolCallId: 'tc-b' } as any) as any).sent);
      assert.isTrue((await predicate.run({ to: 'eng@other.com', subject: 's', body: 'b' }, { ...ctx, toolCallId: 'tc-c' } as any) as any).refused);

      const broken = await factory({
        recipients: () => { throw new Error('boom'); },
      }, fetchImpl);
      const out: any = await broken.run({ to: 'dana@ourco.com', subject: 's', body: 'b' }, { ...ctx, toolCallId: 'tc-d' } as any);
      assert.isTrue(out.refused, 'a policy that throws mails nobody');
    });

    it("'linked' allows exactly the session owner's linked addresses", async () => {
      const { linkIdentity } = await import('meteor/10thfloor:agent');
      const { sends, fetchImpl } = fakePostmark();
      await linkIdentity('email', 'me@personal.test', 'u1', 'link');
      const tool = await factory({ recipients: 'linked' }, fetchImpl);
      const mine: any = await tool.run({ to: 'me@personal.test', subject: 's', body: 'b' }, { userId: 'u1', sessionId: 's1', toolCallId: 'tc-1' } as any);
      assert.isTrue(mine.sent);
      const theirs: any = await tool.run({ to: 'me@personal.test', subject: 's', body: 'b' }, { userId: 'u2', sessionId: 's2', toolCallId: 'tc-2' } as any);
      assert.isTrue(theirs.refused, "someone else's linked address is not yours to mail");
      const anon: any = await tool.run({ to: 'me@personal.test', subject: 's', body: 'b' }, { userId: null, sessionId: 's3', toolCallId: 'tc-3' } as any);
      assert.isTrue(anon.refused, 'an anonymous session has no linked addresses');
      assert.equal(sends.length, 1);
    });

    it('sends through the thin transport: plain Reply-To, auto-generated, the receipt in the header', async () => {
      const { sends, fetchImpl } = fakePostmark();
      const { AgentAttachments } = await import('meteor/10thfloor:agent');
      await (AgentAttachments as any).insertAsync({
        _id: 'attC1', sessionId: 's1', name: 'summary.csv', contentType: 'text/csv',
        size: 8, content: b64('a,b\n1,2\n'), origin: 'tool', createdAt: new Date(),
      });
      const tool = await factory({}, fetchImpl);
      const out: any = await tool.run(
        { to: 'dana@ourco.com', subject: 'Q3 numbers', body: 'Attached.', attachments: ['attC1', 'attGone'] },
        { userId: 'u1', sessionId: 's1', toolCallId: 'tc-9' } as any,
      );
      assert.isTrue(out.sent);
      assert.deepEqual(out.attached, ['summary.csv']);
      assert.deepEqual(out.missingAttachments, ['attGone'], 'a foreign or expired id is reported, never guessed at');
      const body = sends[0];
      assert.equal(body.To, 'dana@ourco.com');
      assert.equal(body.Subject, 'Q3 numbers');
      assert.equal(body.ReplyTo, 'inbound@ourco.com', 'no thread key — a reply opens a FRESH conversation (decision 8)');
      assert.deepEqual(body.Attachments, [{ Name: 'summary.csv', Content: b64('a,b\n1,2\n'), ContentType: 'text/csv' }]);
      const headers = Object.fromEntries(body.Headers.map((h: any) => [h.Name, h.Value]));
      assert.equal(headers['Auto-Submitted'], 'auto-generated', 'opens a correspondence; not auto-replied');
      assert.equal(headers['X-Agent-Receipt'], 'deliver:compose:email:tc-9:send');
    });

    it('is effectively-once on the tool call: a crash-recovery re-run reads the receipt instead of re-sending', async () => {
      const { sends, fetchImpl } = fakePostmark();
      const tool = await factory({}, fetchImpl);
      const ctx = { userId: 'u1', sessionId: 's1', toolCallId: 'tc-once' };
      const first: any = await tool.run({ to: 'dana@ourco.com', subject: 's', body: 'b' }, ctx as any);
      const second: any = await tool.run({ to: 'dana@ourco.com', subject: 's', body: 'b' }, ctx as any);
      assert.isTrue(first.sent);
      assert.isTrue(second.sent, 'the re-run reports the same settled fact');
      assert.equal(sends.length, 1, 'one mail, whatever dispatch recovery does');
      // A DIFFERENT tool call is a different receipt — a genuinely new send.
      await tool.run({ to: 'dana@ourco.com', subject: 's', body: 'b' }, { ...ctx, toolCallId: 'tc-two' } as any);
      assert.equal(sends.length, 2);
    });

    it('describe shows the approver names and sizes, never ref ids (participants spec §8)', async () => {
      const { AgentAttachments } = await import('meteor/10thfloor:agent');
      await (AgentAttachments as any).insertAsync({
        _id: 'attL1', sessionId: 's-desc', name: 'report.csv', contentType: 'text/csv',
        size: 18_432, content: b64('a'), origin: 'tool', createdAt: new Date(),
      });
      const tool: any = await factory();
      const display = await tool.describe(
        { to: 'Dana@OurCo.com', subject: 'Q3 numbers', body: 'Please review the attached figures.', attachments: ['attL1', 'attGone'] },
        { userId: 'u1', sessionId: 's-desc' },
      );
      assert.include(display, 'dana@ourco.com');
      assert.include(display, '"Q3 numbers"');
      assert.include(display, 'report.csv (18 KB)', 'names and sizes, resolved session-scoped');
      assert.include(display, 'attGone (not found)', 'a stale id is said plainly, not guessed at');
      assert.include(display, 'Please review');

      // The email lens leads with it, args underneath.
      const { emailLens } = await import('meteor/10thfloor:agent-channel-email');
      const rendered: any = emailLens.out({
        item: 'prompt', name: 'compose_email', args: { attachments: ['attL1'] },
        display: 'Email dana@ourco.com — "Q3 numbers"\nFiles: report.csv (18 KB)',
        toolCallId: 'tcp',
        choices: [
          { token: 'approve', label: 'Approve', match: 'YES' },
          { token: 'deny', label: 'Deny', match: 'NO' },
        ],
      } as any, { subject: 'Re: x' });
      assert.match(rendered.TextBody, /report\.csv \(18 KB\)[\s\S]*attL1/, 'the display leads; the raw args remain the record');
    });
  });

  describe("onReply: 'continue' — the composed loop (participants spec §5)", () => {
    /** A transport-capturing fetch shared by the channel AND the tool. */
    function fakePostmark() {
      const sends: any[] = [];
      const fetchImpl = (async (_url: unknown, init: any) => {
        sends.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ MessageID: `pm-${sends.length}`, ErrorCode: 0 }) };
      }) as unknown as typeof fetch;
      return { sends, fetchImpl };
    }

    const cleanLoop = async () => {
      const {
        AgentSessions, AgentMessages, ChannelBindings, DeliveryReceipts, InboundSubmissions,
      } = await import('meteor/10thfloor:agent');
      await (AgentSessions as any).removeAsync({});
      await (AgentMessages as any).removeAsync({});
      await (ChannelBindings as any).removeAsync({});
      await (DeliveryReceipts as any).removeAsync({});
      await (InboundSubmissions as any).removeAsync({});
    };

    /** A REAL (non-throwaway) composing session with some history. */
    const seedComposing = async (
      _id: string, agent: string, over: Record<string, unknown> = {},
    ) => {
      const { AgentSessions, AgentMessages } = await import('meteor/10thfloor:agent');
      await (AgentSessions as any).insertAsync({
        _id, agent, userId: 'owner-1', phase: 'idle', model: 'mock',
        nextSeq: 5, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(), ...over,
      });
      await (AgentMessages as any).insertAsync({
        _id: `${_id}-old`, sessionId: _id, seq: 4, role: 'assistant',
        content: 'old backlog the recipient must never receive', createdAt: new Date(),
      });
    };

    it("refuses 'continue' when the reply channel is not registered", async () => {
      await cleanLoop();
      const { composeEmailTool } = await import('meteor/10thfloor:agent-channel-email');
      const { fetchImpl, sends } = fakePostmark();
      const tool = composeEmailTool({
        serverToken: 't', from: 'a@ourco.com', inboundAddress: 'inbound@ourco.com',
        recipients: ['dana@ourco.com'], onReply: 'continue', kind: 'em-none', fetchImpl,
      } as any);
      await seedComposing('sc0', 'email-loop-agent');
      const out: any = await tool.run(
        { to: 'dana@ourco.com', subject: 's', body: 'b' },
        { userId: 'owner-1', sessionId: 'sc0', toolCallId: 'tc-n1' } as any,
      );
      assert.isTrue(out.refused);
      assert.equal(out.reason, 'reply-channel-unregistered');
      assert.equal(sends.length, 0, 'a correspondence nobody can answer is never opened');
    });

    it("refuses 'continue' when the roster is full — no phantom correspondents", async () => {
      await cleanLoop();
      const { Agent, mockProvider, ChannelBindings, AgentSessions } = await import('meteor/10thfloor:agent');
      const { composeEmailTool, email } = await import('meteor/10thfloor:agent-channel-email');
      const { fetchImpl, sends } = fakePostmark();
      new (Agent as any)('email-loop-agent', {
        model: 'mock', instructions: '', provider: mockProvider(() => ({ text: 'ok' })),
      });
      (Agent as any).channel('em-full', email({
        agent: 'email-loop-agent', serverToken: 't', from: 'a@ourco.com',
        inboundAddress: 'inbound@ourco.com', webhookUser: 'hook', webhookPassword: 'pw',
        fetchImpl,
      } as any));
      const tool = composeEmailTool({
        serverToken: 't', from: 'a@ourco.com', inboundAddress: 'inbound@ourco.com',
        recipients: ['dana@ourco.com'], onReply: 'continue', kind: 'em-full', fetchImpl,
      } as any);

      const now = new Date();
      await seedComposing('sc-full', 'email-loop-agent', {
        participants: Array.from({ length: 16 }, (_, i) => ({
          id: i === 0 ? 'h:owner-1' : `h:u${i}`,
          kind: 'human', role: i === 0 ? 'owner' : 'member',
          userId: i === 0 ? 'owner-1' : `u${i}`, displayName: `p${i}`, joinedAt: now,
        })),
      });
      const out: any = await tool.run(
        { to: 'dana@ourco.com', subject: 's', body: 'b' },
        { userId: 'owner-1', sessionId: 'sc-full', toolCallId: 'tc-full' } as any,
      );
      assert.isTrue(out.refused);
      assert.equal(out.reason, 'roster-full');
      assert.equal(sends.length, 0, 'refused BEFORE the mail, so nobody is told they joined');
      assert.equal(await (ChannelBindings as any).find({ kind: 'em-full' }).countAsync(), 0);
      const session: any = await (AgentSessions as any).findOneAsync('sc-full');
      assert.lengthOf(session.participants, 16, 'the roster is untouched');
    });

    it("refuses 'continue' in throwaway and subagent-child sessions", async () => {
      await cleanLoop();
      const { Agent, mockProvider } = await import('meteor/10thfloor:agent');
      const { composeEmailTool, email } = await import('meteor/10thfloor:agent-channel-email');
      const { fetchImpl } = fakePostmark();
      new (Agent as any)('email-loop-agent', {
        model: 'mock', instructions: '', provider: mockProvider(() => ({ text: 'ok' })),
      });
      (Agent as any).channel('em-eph', email({
        agent: 'email-loop-agent', serverToken: 't', from: 'a@ourco.com',
        inboundAddress: 'inbound@ourco.com', webhookUser: 'hook', webhookPassword: 'pw',
        fetchImpl,
      } as any));
      const tool = composeEmailTool({
        serverToken: 't', from: 'a@ourco.com', inboundAddress: 'inbound@ourco.com',
        recipients: ['dana@ourco.com'], onReply: 'continue', kind: 'em-eph', fetchImpl,
      } as any);

      await seedComposing('sc-eph', 'email-loop-agent', { ephemeral: true });
      const eph: any = await tool.run(
        { to: 'dana@ourco.com', subject: 's', body: 'b' },
        { userId: 'owner-1', sessionId: 'sc-eph', toolCallId: 'tc-e1' } as any,
      );
      assert.equal(eph.reason, 'session-cannot-continue', 'a throwaway cannot hold a correspondence');

      await seedComposing('sc-child', 'email-loop-agent', { parent: { sessionId: 'p1', toolCallId: 'tc' } });
      const child: any = await tool.run(
        { to: 'dana@ourco.com', subject: 's', body: 'b' },
        { userId: 'owner-1', sessionId: 'sc-child', toolCallId: 'tc-e2' } as any,
      );
      assert.equal(child.reason, 'session-cannot-continue', "a subagent's private child cannot either");
    });

    it('mints the key, pre-binds member-shaped, joins the roster — and the reply continues the session', async function () {
      this.timeout(15000);
      await cleanLoop();
      const {
        Agent, mockProvider, handleInbound, ChannelBindings, AgentSessions, AgentMessages,
      } = await import('meteor/10thfloor:agent');
      const { composeEmailTool, email, threadKey, replyToFor } = await import('meteor/10thfloor:agent-channel-email');
      const { sends, fetchImpl } = fakePostmark();

      new (Agent as any)('email-loop-agent', {
        model: 'mock', instructions: '', provider: mockProvider(() => ({ text: 'ok' })),
      });
      (Agent as any).channel('em-loop', email({
        agent: 'email-loop-agent', serverToken: 't', from: 'a@ourco.com',
        inboundAddress: 'inbound@ourco.com', webhookUser: 'hook', webhookPassword: 'pw',
        fetchImpl,
      } as any));
      const tool = composeEmailTool({
        serverToken: 't', from: 'a@ourco.com', inboundAddress: 'inbound@ourco.com',
        recipients: ['dana@ourco.com'], onReply: 'continue', kind: 'em-loop', fetchImpl,
      } as any);
      await seedComposing('sc1', 'email-loop-agent');

      const out: any = await tool.run(
        { to: 'Dana@OurCo.com', subject: 'Q3 numbers', body: 'Please review.' },
        { userId: 'owner-1', sessionId: 'sc1', toolCallId: 'tc-l1' } as any,
      );
      assert.isTrue(out.sent);
      assert.equal(out.joined, 'dana@ourco.com', 'normalized before any derived write');

      // The mail carries the minted key — the mechanism decision 8 withheld.
      const key = threadKey('compose:sc1:dana@ourco.com');
      assert.equal(sends[0].ReplyTo, replyToFor('inbound@ourco.com', key));
      const headers = Object.fromEntries(sends[0].Headers.map((h: any) => [h.Name, h.Value]));
      assert.equal(headers['Auto-Submitted'], 'auto-generated');

      // The pre-bind: member-shaped, owner-pinned, snapshot-cursored.
      const binding: any = await (ChannelBindings as any).findOneAsync(`em-loop:${key}`);
      assert.isDefined(binding, 'the conversation is pre-bound to the composing session');
      assert.equal(binding.sessionId, 'sc1');
      assert.equal(binding.userId, 'owner-1', 'pinned — claim-history can never re-own this');
      assert.isTrue(binding.member);
      assert.equal(binding.admits, 'members');
      assert.equal(binding.externalUserId, 'dana@ourco.com');
      assert.equal(binding.participant, 'x:em-loop:dana@ourco.com');
      assert.equal(binding.deliveredSeq, 4, 'delivery starts at the composed message, not the backlog');
      assert.equal((binding.destination as any).subject, 'Re: Q3 numbers');

      // The roster: seeded complete, recipient joined, attributed by the model.
      const session: any = await (AgentSessions as any).findOneAsync('sc1');
      const ids = session.participants.map((p: any) => p.id).sort();
      assert.deepEqual(ids, ['h:owner-1', 'm:email-loop-agent', 'x:em-loop:dana@ourco.com']);
      assert.equal(
        session.participants.find((p: any) => p.id === 'x:em-loop:dana@ourco.com').addedBy,
        'm:email-loop-agent',
      );

      // A SECOND compose to the same recipient adopts — one conversation, one
      // binding, one roster row, two mails.
      await tool.run(
        { to: 'dana@ourco.com', subject: 'One more thing', body: 'Also this.' },
        { userId: 'owner-1', sessionId: 'sc1', toolCallId: 'tc-l2' } as any,
      );
      assert.equal(sends.length, 2);
      assert.equal(await (ChannelBindings as any).find({ kind: 'em-loop' }).countAsync(), 1);
      const again: any = await (AgentSessions as any).findOneAsync('sc1');
      assert.lengthOf(
        again.participants.filter((p: any) => p.id === 'x:em-loop:dana@ourco.com'), 1,
      );

      // A STRANGER'S EARLY REPLY must not teach the binding its threading
      // root: adoption runs only for ADMITTED senders (a refused message
      // that still set the thread's one-shot root would let anyone holding
      // the reply key hijack threading before the recipient ever spoke).
      await handleInbound('em-loop', {
        headers: { authorization: `Basic ${Buffer.from('hook:pw').toString('base64')}` },
        rawBody: JSON.stringify({
          MessageID: 'pm-eve-1',
          FromFull: { Email: 'eve@evil.test', Name: 'Eve' },
          From: 'eve@evil.test',
          To: 'inbound+hash@ourco.com',
          ToFull: [{ Email: 'inbound@ourco.com', MailboxHash: key }],
          MailboxHash: key,
          Subject: 'Invoice overdue',
          TextBody: 'pay here',
          StrippedTextReply: 'pay here',
          Headers: [
            { Name: 'Message-ID', Value: '<e1@evil.test>' },
            { Name: 'In-Reply-To', Value: '<evil-root@evil.test>' },
          ],
        }),
      });
      const unadopted: any = await (ChannelBindings as any).findOneAsync(`em-loop:${key}`);
      assert.isUndefined(
        (unadopted.destination as any).rootMessageId,
        "a refused stranger's message sets nothing",
      );

      // THE REPLY — unverified From (the common case), carrying the key as
      // the mailbox hash: admitted through the roster, attributed, in the
      // composing session.
      const reply = {
        MessageID: 'pm-reply-1',
        FromFull: { Email: 'dana@ourco.com', Name: 'Dana' },
        From: 'Dana <dana@ourco.com>',
        To: 'inbound+hash@ourco.com',
        ToFull: [{ Email: 'inbound@ourco.com', MailboxHash: key }],
        MailboxHash: key,
        Subject: 'Re: Q3 numbers',
        TextBody: 'Looks good, ship it.',
        StrippedTextReply: 'Looks good, ship it.',
        Headers: [
          { Name: 'Message-ID', Value: '<r1@dana.test>' },
          { Name: 'In-Reply-To', Value: '<composed-rfc-id@pm.test>' },
        ],
      };
      const res = await handleInbound('em-loop', {
        headers: { authorization: `Basic ${Buffer.from('hook:pw').toString('base64')}` },
        rawBody: JSON.stringify(reply),
      });
      assert.equal(res.status, 200);

      const row: any = await (AgentMessages as any).findOneAsync({
        sessionId: 'sc1', role: 'user', content: 'Looks good, ship it.',
      });
      assert.isDefined(row, "the recipient's reply CONTINUED the composing session");
      assert.deepEqual(row.from, { participant: 'x:em-loop:dana@ourco.com', name: 'dana@ourco.com' });

      // Destination adoption: the binding learned its threading root from the
      // reply, so every later reply we send threads in Dana's client.
      const adopted: any = await (ChannelBindings as any).findOneAsync(`em-loop:${key}`);
      assert.equal(
        (adopted.destination as any).rootMessageId, 'composed-rfc-id@pm.test',
        'the first admitted reply taught the binding its root',
      );

      // And a STRANGER carrying the key is still nobody: not the owner, not
      // in the roster — settled without a row.
      const before = await (AgentMessages as any).find({ sessionId: 'sc1', role: 'user' }).countAsync();
      await handleInbound('em-loop', {
        headers: { authorization: `Basic ${Buffer.from('hook:pw').toString('base64')}` },
        rawBody: JSON.stringify({
          ...reply,
          MessageID: 'pm-mallory-1',
          FromFull: { Email: 'mallory@evil.test', Name: 'M' },
          From: 'mallory@evil.test',
          StrippedTextReply: 'let me in',
          TextBody: 'let me in',
        }),
      });
      assert.equal(
        await (AgentMessages as any).find({ sessionId: 'sc1', role: 'user' }).countAsync(),
        before, 'the reply key routes; the roster admits',
      );
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

    it('raises the webhook body ceiling for attachment-bearing mail, app knob winning', async () => {
      const { email } = await import('meteor/10thfloor:agent-channel-email');
      const base = { agent: 'demo', serverToken: 't', from: 'a@b', inboundAddress: 'i@b', webhookUser: 'u', webhookPassword: 'p' };
      assert.equal(email(base).maxInboundBytes, 50 * 1024 * 1024, 'Postmark inbound runs to 35 MB of files, base64d');
      assert.equal(email({ ...base, maxInboundBytes: 2 * 1024 * 1024 }).maxInboundBytes, 2 * 1024 * 1024);
      assert.deepEqual(email({ ...base, attachments: { maxFiles: 2 } }).attachments, { maxFiles: 2 }, 'the admission knob forwards');
    });
  });
});
