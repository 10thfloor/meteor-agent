import { assert } from 'chai';
import type { RawInbound } from 'meteor/10thfloor:agent';

/** The Telegram channel package: secret-token verification, the update →
 *  intent mapping (chat-keyed conversations, bot/edit noops, the link
 *  gesture), the 64-byte callback_data guard, the grammar round-trip against
 *  the actually rendered keyboard, and the transport wire shape. */

function raw(body: unknown, secret = 's3cret'): RawInbound {
  return {
    headers: { 'x-telegram-bot-api-secret-token': secret },
    rawBody: JSON.stringify(body),
  };
}

function messageUpdate(over: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) {
  return {
    update_id: 1001,
    message: {
      message_id: 7,
      from: { id: 42, is_bot: false, first_name: 'M' },
      chat: { id: 4242, type: 'private', ...chat },
      text: 'hello there',
      ...over,
    },
  };
}

describe('agent-channel-telegram', () => {
  describe('hostile and group inputs', () => {
    it('treats a literal-null callback_data as a noop, not a crash', async () => {
      const { parseTelegramUpdate, telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      const update = {
        update_id: 2002,
        callback_query: {
          id: 'cq1', from: { id: 42, is_bot: false },
          message: { message_id: 9, chat: { id: 4242, type: 'private' } },
          data: 'null',
        },
      };
      const reading = telegramLens.in(parseTelegramUpdate(raw(update)));
      assert.equal(reading.intent.kind, 'noop');
    });

    it('honors the link gesture in private chats only — in a group it is just a message', async () => {
      const { parseTelegramUpdate, telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      const inGroup = telegramLens.in(parseTelegramUpdate(raw(
        messageUpdate({ text: '/link' }, { id: -100777, type: 'supergroup' }),
      )));
      assert.equal(inGroup.intent.kind, 'message', 'a group /link never earns a credential');
      const inPrivate = telegramLens.in(parseTelegramUpdate(raw(messageUpdate({ text: '/link' }))));
      assert.equal(inPrivate.intent.kind, 'link-request');
    });
  });

  describe('verify', () => {
    it('accepts the registered secret token and rejects everything else', async () => {
      const { verifyTelegramSecret } = await import('meteor/10thfloor:agent-channel-telegram');
      assert.isTrue(verifyTelegramSecret(raw({}, 'hush'), 'hush'));
      assert.isFalse(verifyTelegramSecret(raw({}, 'wrong'), 'hush'));
      assert.isFalse(verifyTelegramSecret({ headers: {}, rawBody: '{}' }, 'hush'), 'missing header');
    });
  });

  describe('lens.in', () => {
    it('keys a conversation by chat id, with audience by chat type', async () => {
      const { telegramLens, parseTelegramUpdate } = await import('meteor/10thfloor:agent-channel-telegram');
      const dm = telegramLens.in(parseTelegramUpdate(raw(messageUpdate())));
      assert.deepEqual(dm.intent, { kind: 'message', text: 'hello there' });
      assert.equal(dm.conversationRef, '4242');
      assert.equal(dm.externalUserId, '42');
      assert.equal(dm.eventId, '1001');
      assert.deepEqual(dm.destination, { chatId: 4242 });
      assert.equal(dm.audience, 'direct');

      const group = telegramLens.in(parseTelegramUpdate(raw(
        messageUpdate({}, { id: -100999, type: 'supergroup' }),
      )));
      assert.equal(group.conversationRef, '-100999');
      assert.equal(group.audience, 'group');
    });

    it('noops other bots, edits, and empty/media messages', async () => {
      const { telegramLens, parseTelegramUpdate } = await import('meteor/10thfloor:agent-channel-telegram');
      const bot = telegramLens.in(parseTelegramUpdate(raw(
        messageUpdate({ from: { id: 9, is_bot: true } }),
      )));
      assert.equal(bot.intent.kind, 'noop');
      const edited = telegramLens.in(parseTelegramUpdate(raw({
        update_id: 1002, edited_message: { chat: { id: 1 }, from: { id: 2 }, text: 'x' },
      })));
      assert.equal(edited.intent.kind, 'noop');
      const sticker = telegramLens.in(parseTelegramUpdate(raw(messageUpdate({ text: undefined }))));
      assert.equal(sticker.intent.kind, 'noop');
    });

    it('reads link / /link / /link@Bot as the link gesture, but not sentences', async () => {
      const { telegramLens, parseTelegramUpdate } = await import('meteor/10thfloor:agent-channel-telegram');
      for (const text of ['link', ' /link ', '/link@MyAgentBot']) {
        const reading = telegramLens.in(parseTelegramUpdate(raw(messageUpdate({ text }))));
        assert.equal(reading.intent.kind, 'link-request', `"${text}" is the gesture`);
      }
      const sentence = telegramLens.in(parseTelegramUpdate(raw(messageUpdate({ text: 'link my account' }))));
      assert.equal(sentence.intent.kind, 'message');
    });

    it('reads a button press as a verdict carrying the exact ask', async () => {
      const { telegramLens, parseTelegramUpdate } = await import('meteor/10thfloor:agent-channel-telegram');
      const reading = telegramLens.in(parseTelegramUpdate(raw({
        update_id: 1003,
        callback_query: {
          id: 'cbq1',
          from: { id: 42 },
          message: { chat: { id: 4242, type: 'private' } },
          data: JSON.stringify({ t: 'a', c: 'tc9' }),
        },
      })));
      assert.deepEqual(reading.intent, { kind: 'verdict', verdict: 'approved', toolCallId: 'tc9' });
      assert.equal(reading.conversationRef, '4242');
      assert.equal(reading.eventId, '1003');
    });
  });

  describe('the callback payload', () => {
    it('stays under Telegram’s 64-byte cap, degrading to token-only for a huge ask id', async () => {
      const { telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      const prompt = {
        item: 'prompt' as const, name: 'x', args: {},
        toolCallId: 'tc-'.padEnd(120, 'z'),
        choices: [
          { token: 'approve' as const, label: 'Approve' },
          { token: 'deny' as const, label: 'Deny' },
        ],
      };
      const rendered: any = telegramLens.out(prompt, { chatId: 1 });
      for (const row of rendered.reply_markup.inline_keyboard) {
        assert.isAtMost(Buffer.byteLength(row[0].callback_data, 'utf8'), 64);
        const data = JSON.parse(row[0].callback_data);
        assert.isUndefined(data.c, 'the over-long ask degraded to token-only, never a truncated wrong ask');
      }
    });
  });

  describe('the one law', () => {
    it('round-trips: the rendered keyboard interprets back to its verdicts', async () => {
      const { assertLensRoundTrip } = await import('meteor/10thfloor:agent');
      const { telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      assertLensRoundTrip(telegramLens, { interact: 'native' }, {
        destination: { chatId: 4242 },
        synthesize: (choice, rendered) => {
          const rows = (rendered as any).reply_markup.inline_keyboard as any[];
          const button = rows.flat().find((b: any) => JSON.parse(b.callback_data).t === (choice.token === 'approve' ? 'a' : 'd'));
          return {
            update_id: 9,
            callback_query: {
              id: 'cbq', from: { id: 42 },
              message: { chat: { id: 4242, type: 'private' } },
              data: button.callback_data,
            },
          };
        },
        message: (text) => messageUpdate({ text }),
      });
    });
  });

  describe('transport', () => {
    it('posts sendMessage with the chat threaded in and reports the message id', async () => {
      const { telegramTransport } = await import('meteor/10thfloor:agent-channel-telegram');
      const calls: any[] = [];
      const fetchImpl = (async (url: any, init: any) => {
        calls.push({ url, init });
        return { json: async () => ({ ok: true, result: { message_id: 77 } }) };
      }) as unknown as typeof fetch;
      const transport = telegramTransport({ botToken: '123:ABC', fetchImpl });
      const posted = await transport.post({ chatId: 4242 }, { text: 'hi' }, { idempotencyKey: 'k' });
      assert.deepEqual(posted, { providerMessageId: '77' });
      assert.include(calls[0].url, '/bot123:ABC/sendMessage');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.chat_id, 4242);
      assert.equal(body.text, 'hi');
    });

    it('throws the API description so the receipt stays mid-sending for the retry', async () => {
      const { telegramTransport } = await import('meteor/10thfloor:agent-channel-telegram');
      const fetchImpl = (async () => ({
        json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
      })) as unknown as typeof fetch;
      const transport = telegramTransport({ botToken: 't', fetchImpl });
      try {
        await transport.post({ chatId: 1 }, { text: 'x' }, { idempotencyKey: 'k' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.include(String(e.message), 'chat not found');
      }
    });
  });

  describe('telegram() factory', () => {
    it('assembles a ChannelDef with wired verification and merged profile', async () => {
      const { telegram } = await import('meteor/10thfloor:agent-channel-telegram');
      const def = telegram({
        agent: 'demo', botToken: '123:ABC', webhookSecret: 'hush',
        profile: { limit: 1000 },
      });
      assert.equal(def.agent, 'demo');
      assert.deepEqual(def.profile, { interact: 'native', limit: 1000 });
      assert.deepEqual(def.statuses, ['error', 'approval']);
      assert.isTrue(await def.verify(raw({}, 'hush')));
      assert.isFalse(await def.verify(raw({}, 'nope')));
    });

    it('refuses missing credentials at construction', async () => {
      const { telegram } = await import('meteor/10thfloor:agent-channel-telegram');
      assert.throws(() => telegram({ agent: 'demo', botToken: '', webhookSecret: 's' } as any), /botToken/);
      assert.throws(() => telegram({ agent: 'demo', botToken: 't', webhookSecret: '' } as any), /webhookSecret/);
      assert.throws(() => telegram({ agent: '', botToken: 't', webhookSecret: 's' } as any), /agent/);
    });
  });
});
