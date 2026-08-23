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

/** Parse + read one update through the lens, as the host would. */
async function read(update: unknown) {
  const { parseTelegramUpdate, telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
  return telegramLens.in(parseTelegramUpdate(raw(update)));
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

describe('agent-channel-telegram', () => {
  describe('hostile and group inputs', () => {
    it('treats a literal-null callback_data as a noop, not a crash', async () => {
      const update = {
        update_id: 2002,
        callback_query: {
          id: 'cq1', from: { id: 42, is_bot: false },
          message: { message_id: 9, chat: { id: 4242, type: 'private' } },
          data: 'null',
        },
      };
      const reading = await read(update);
      assert.equal(reading.intent.kind, 'noop');
    });

    it('honors the link gesture in private chats only — in a group it is just a message', async () => {
      const inGroup = await read(messageUpdate({ text: '/link' }, { id: -100777, type: 'supergroup' }));
      assert.equal(inGroup.intent.kind, 'message', 'a group /link never earns a credential');
      const inPrivate = await read(messageUpdate({ text: '/link' }));
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
      const dm = await read(messageUpdate());
      assert.deepEqual(dm.intent, { kind: 'message', text: 'hello there' });
      assert.equal(dm.conversationRef, '4242');
      assert.equal(dm.externalUserId, '42');
      assert.equal(dm.eventId, '1001');
      assert.deepEqual(dm.destination, { chatId: 4242 });
      assert.equal(dm.audience, 'direct');

      const group = await read(messageUpdate({}, { id: -100999, type: 'supergroup' }));
      assert.equal(group.conversationRef, '-100999');
      assert.equal(group.audience, 'group');
    });

    it('noops other bots, edits, and empty/media messages', async () => {
      const bot = await read(messageUpdate({ from: { id: 9, is_bot: true } }));
      assert.equal(bot.intent.kind, 'noop');
      const edited = await read({
        update_id: 1002, edited_message: { chat: { id: 1 }, from: { id: 2 }, text: 'x' },
      });
      assert.equal(edited.intent.kind, 'noop');
      const sticker = await read(messageUpdate({ text: undefined }));
      assert.equal(sticker.intent.kind, 'noop');
    });

    it('reads link / /link / /link@Bot as the link gesture, but not sentences', async () => {
      for (const text of ['link', ' /link ', '/link@MyAgentBot']) {
        const reading = await read(messageUpdate({ text }));
        assert.equal(reading.intent.kind, 'link-request', `"${text}" is the gesture`);
      }
      const sentence = await read(messageUpdate({ text: 'link my account' }));
      assert.equal(sentence.intent.kind, 'message');
      for (const text of ['/link@MyAgentBot please', 'link@anything goes']) {
        const r = await read(messageUpdate({ text }));
        assert.equal(r.intent.kind, 'message', `"${text}" is a message, not the gesture`);
      }
    });

    it('reads a button press as a verdict carrying the exact ask', async () => {
      const reading = await read({
        update_id: 1003,
        callback_query: {
          id: 'cbq1',
          from: { id: 42 },
          message: { chat: { id: 4242, type: 'private' } },
          data: JSON.stringify({ t: 'a', c: 'tc9' }),
        },
      });
      assert.deepEqual(reading.intent, { kind: 'verdict', verdict: 'approved', toolCallId: 'tc9' });
      assert.equal(reading.conversationRef, '4242');
      assert.equal(reading.eventId, '1003');
    });
  });

  describe('the callback payload', () => {
    it('carries the exact ask on every button, degrading to token-only past Telegram’s 64-byte cap', async () => {
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

      // The normal path: a sane ask id rides every button verbatim, so the
      // staleness rule (exact toolCallId) survives render → click.
      const normal: any = telegramLens.out({ ...prompt, toolCallId: 'tc1' }, { chatId: 1 });
      for (const row of normal.reply_markup.inline_keyboard) {
        assert.equal(JSON.parse(row[0].callback_data).c, 'tc1', 'a normal ask rides the button');
      }
    });
  });

  describe('the one law', () => {
    it('round-trips: the rendered keyboard interprets back to its verdicts', async () => {
      const { assertLensRoundTrip, decodeVerdictPostback, VERDICT_FOR } = await import('meteor/10thfloor:agent');
      const { telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      assertLensRoundTrip(telegramLens, { interact: 'native' }, {
        destination: { chatId: 4242 },
        synthesize: (choice, rendered) => {
          // Pick the button by what its ACTUAL rendered callback_data decodes
          // to, so the synthetic click is the wire payload verbatim.
          const rows = (rendered as any).reply_markup.inline_keyboard as any[];
          const button = rows.flat().find(
            (b: any) => decodeVerdictPostback(b.callback_data)?.verdict === VERDICT_FOR[choice.token],
          );
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
        // The media half (participants spec §6.4): a caption-less document, in
        // the Bot API's own shape — a file_id needing getFile then the
        // token-in-path download.
        mediaMessage: (files) => messageUpdate({
          text: undefined,
          document: {
            file_id: `FILE-${files[0].name}`, file_name: files[0].name,
            mime_type: files[0].contentType, file_size: 4096,
          },
        }),
      });
    });
  });

  describe('inbound media (participants spec §6)', () => {
    it('a photo is ONE reference — the largest size — and the caption is the words', async () => {
      const { telegramLens } = await import('meteor/10thfloor:agent-channel-telegram');
      const r = telegramLens.in(messageUpdate({
        text: undefined,
        caption: 'whiteboard from standup',
        photo: [
          { file_id: 'PH-S', file_size: 1200, width: 90, height: 90 },
          { file_id: 'PH-M', file_size: 24_000, width: 320, height: 320 },
          { file_id: 'PH-L', file_size: 180_000, width: 1280, height: 1280 },
        ],
      }));
      assert.deepEqual(r.intent, { kind: 'message', text: 'whiteboard from standup' });
      assert.lengthOf(r.attachments!, 1, 'thumbnail sizes are the SAME image — one file, not four');
      const att: any = r.attachments![0];
      assert.equal(att.ref, 'PH-L', 'the largest size is the photo');
      assert.isTrue(att.indirect);
      assert.equal(att.contentType, 'image/jpeg');
    });
  });

  describe('transport', () => {
    it('posts sendMessage with the chat threaded in and reports the message id', async () => {
      const { telegramTransport } = await import('meteor/10thfloor:agent-channel-telegram');
      const { calls, fetchImpl } = fakeFetch({ ok: true, result: { message_id: 77 } });
      const transport = telegramTransport({ botToken: '123:ABC', fetchImpl });
      const posted = await transport.post({ chatId: 4242 }, { text: 'hi' }, { idempotencyKey: 'k' });
      assert.deepEqual(posted, { providerMessageId: '77' });
      assert.include(calls[0].url, '/bot123:ABC/sendMessage');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.chat_id, 4242);
      assert.equal(body.text, 'hi');
    });

    it('a payload can never redirect a post to another chat', async () => {
      const { telegramTransport } = await import('meteor/10thfloor:agent-channel-telegram');
      const { calls, fetchImpl } = fakeFetch({ ok: true, result: { message_id: 1 } });
      await telegramTransport({ botToken: 't', fetchImpl })
        .post({ chatId: 4242 }, { text: 'hi', chat_id: -999 }, { idempotencyKey: 'k' });
      assert.equal(JSON.parse(calls[0].init.body).chat_id, 4242, 'destination wins over payload');
    });

    it('throws the API description so the receipt stays mid-sending for the retry', async () => {
      const { telegramTransport } = await import('meteor/10thfloor:agent-channel-telegram');
      const { fetchImpl } = fakeFetch({ ok: false, description: 'Bad Request: chat not found' });
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
