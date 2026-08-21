import { assert } from 'chai';
import type { AgentMessage, AgentSession } from '../common/types';
import type { ChannelDef, RawInbound } from '../server/channels/registry';
import type { DeliveryItem, InboundReading } from '../server/channels/contract';

/**
 * Channels (channels spec): the planner's line, the lens law, the
 * single-winner claim/advance, binding-first creation, exactly-once admission,
 * effectively-once delivery through receipts, the expects grammar with its
 * staleness rule, and account linking with history claiming.
 */

const sessionBase = {
  agent: 'channel-agent', userId: null, phase: 'idle' as const, model: 'mock',
  nextSeq: 0,
  usage: { input: 0, output: 0, cost: 0 },
  budgetSpent: { turns: 0, toolCalls: 0 },
  createdAt: new Date(), updatedAt: new Date(),
};

function msg(over: Partial<AgentMessage> & { sessionId: string; seq: number }): AgentMessage {
  return {
    _id: over._id ?? `m-${over.sessionId}-${over.seq}`,
    role: 'assistant',
    createdAt: new Date(),
    ...over,
  } as AgentMessage;
}

/** A deterministic test surface: JSON events, header signature, a menu-style
 *  prose renderer that USES the choices' registered match words. */
function testLens() {
  return {
    out(item: DeliveryItem): unknown {
      if (item.item === 'reply') return { text: item.text };
      if (item.item === 'status') return { text: `[${item.kind}] ${item.reason ?? ''}` };
      if (item.item === 'overflow') return { text: `${item.head}${item.url ? ` ${item.url}` : ''}` };
      const menu = item.choices
        .map((c) => (c.match ? `Reply ${c.match} to ${c.label.toLowerCase()}` : c.label))
        .join(', ');
      return { text: `Approve ${item.name}? ${menu}` };
    },
    in(event: any): InboundReading {
      if (event.type === 'noop') return { intent: { kind: 'noop' } };
      const envelope = {
        eventId: event.id,
        externalUserId: event.user,
        conversationRef: event.convo,
        destination: { to: event.convo },
        audience: 'direct' as const,
      };
      if (event.type === 'action') {
        return {
          intent: {
            kind: 'verdict',
            verdict: event.token === 'approve' ? 'approved' : 'denied',
            toolCallId: event.toolCallId,
          },
          ...envelope,
        };
      }
      if (event.type === 'link') return { intent: { kind: 'link-request' }, ...envelope };
      return { intent: { kind: 'message', text: event.text }, ...envelope };
    },
  };
}

/** A transport that records every post; `fail` makes the next N posts throw. */
function testTransport() {
  const posts: Array<{ destination: unknown; payload: any; key: string }> = [];
  let failures = 0;
  return {
    posts,
    fail(n: number) { failures = n; },
    async post(destination: unknown, payload: unknown, opts: { idempotencyKey: string }) {
      if (failures > 0) { failures -= 1; throw new Error('transport down'); }
      posts.push({ destination, payload, key: opts.idempotencyKey });
      return { providerMessageId: `pm-${posts.length}` };
    },
  };
}

async function registerTestChannel(over: Partial<ChannelDef> = {}) {
  const { Agent, mockProvider } = await import('../server/index');
  const { _clearChannels } = await import('../server/channels/registry');
  _clearChannels();
  new Agent('channel-agent').define({
    model: 'mock', instructions: 'test',
    provider: mockProvider(() => ({ text: 'the answer' })),
  });
  const transport = testTransport();
  const def: ChannelDef = {
    agent: 'channel-agent',
    transport,
    lens: testLens(),
    profile: { interact: 'menu' },
    verify: (raw: RawInbound) => raw.headers['x-sig'] === 'ok',
    parse: (raw: RawInbound) => JSON.parse(raw.rawBody),
    ...over,
  };
  Agent.channel('test', def);
  return { transport, def };
}

function raw(event: unknown, sig = 'ok'): RawInbound {
  return { headers: { 'x-sig': sig }, rawBody: JSON.stringify(event) };
}

async function cleanChannels() {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const {
    ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
    DeliveryReceipts, InboundSubmissions,
  } = await import('../server/channels/collections');
  const { _clearThrottle } = await import('../server/channels/ingress');
  const { _clearChannels } = await import('../server/channels/registry');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await ChannelBindings.removeAsync({});
  await ChannelIdentities.removeAsync({});
  await ChannelLinkTokens.removeAsync({});
  await ChannelVerdictTokens.removeAsync({});
  await DeliveryReceipts.removeAsync({});
  await InboundSubmissions.removeAsync({});
  _clearThrottle();
  _clearChannels();
}

async function until(fn: () => Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('until: condition never held');
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

describe('channels', () => {
  beforeEach(cleanChannels);
  after(cleanChannels);

  // ---- The planner (§8.2 / §7) ---------------------------------------------

  describe('planner', () => {
    it('posts only turn-final assistant rows and opted-in notes; advances past the rest', async () => {
      const { planItems } = await import('../server/channels/plan');
      const rows = [
        msg({ sessionId: 's', seq: 1, role: 'user', content: 'hi' }),
        msg({ sessionId: 's', seq: 2, toolCalls: [{ id: 't1', name: 'x', args: {} }], content: 'planning' }),
        msg({ sessionId: 's', seq: 3, role: 'tool', toolCallId: 't1', content: '{}' }),
        msg({ sessionId: 's', seq: 4, content: 'the answer' }),
        msg({ sessionId: 's', seq: 5, role: 'note', kind: 'error', reason: 'provider-failed' }),
        msg({ sessionId: 's', seq: 6, role: 'note', kind: 'compaction', summary: 'x', upto: 3 }),
      ];
      const planned = planItems(rows, { statuses: ['error'], profile: { interact: 'menu' } });
      assert.deepEqual(
        planned.map((p) => p.item?.item ?? null),
        [null, null, null, 'reply', 'status', null],
        'exactly the answer and the opted-in note post; everything else advances',
      );
    });

    it('turns an over-limit reply into a mechanical head-slice, link included only when given', async () => {
      const { planItems } = await import('../server/channels/plan');
      const long = 'x'.repeat(500);
      const rows = [msg({ sessionId: 's', seq: 1, content: long })];
      const linked = planItems(rows, {
        profile: { interact: 'menu', limit: 100 }, overflowUrl: 'https://app.test/s/1',
      })[0].item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.equal(linked.item, 'overflow');
      assert.isAtMost(linked.head.length, 100);
      assert.equal(linked.url, 'https://app.test/s/1');
      const bare = planItems(rows, { profile: { interact: 'menu', limit: 100 } })[0]
        .item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.isUndefined(bare.url, 'no url unless the caller allowed one');
    });

    it('builds the prompt from the parked state only while unanswered, with menu matches', async () => {
      const { promptItem, MENU_MATCHES } = await import('../server/channels/plan');
      const parked: AgentSession = {
        ...sessionBase, _id: 'p1', phase: 'awaiting',
        pending: { toolCallId: 'tc1', name: 'orders.refund', args: { id: 1 } },
      };
      const item = promptItem(parked, { interact: 'menu' })!;
      assert.equal(item.toolCallId, 'tc1');
      assert.deepEqual(item.choices.map((c) => c.match), [MENU_MATCHES.approve, MENU_MATCHES.deny]);
      const native = promptItem(parked, { interact: 'native' })!;
      assert.isUndefined(native.choices[0].match, 'native choices carry no text grammar');
      const decided: AgentSession = {
        ...parked,
        pending: { ...parked.pending!, verdict: 'approved' },
      };
      assert.isNull(promptItem(decided, { interact: 'menu' }), 'an answered ask is no prompt');
    });
  });

  // ---- The lens law (§8.3 / §8.7) ------------------------------------------

  describe('assertLensRoundTrip', () => {
    it('accepts a lens whose grammar round-trips, menu text included', async () => {
      const { assertLensRoundTrip } = await import('../server/channels/contract');
      const lens = testLens();
      assertLensRoundTrip(lens, { interact: 'menu' }, {
        synthesize: (choice) => ({ type: 'msg', text: choice.match ?? choice.token, id: 'e', user: 'u', convo: 'c' }),
        message: (text) => ({ type: 'msg', text, id: 'e', user: 'u', convo: 'c' }),
      });
    });

    it('rejects a lens that drops an item (totality)', async () => {
      const { assertLensRoundTrip } = await import('../server/channels/contract');
      const lens = testLens();
      const dropping = {
        ...lens,
        out: (item: DeliveryItem) => (item.item === 'prompt' ? null : lens.out(item)),
      };
      assert.throws(
        () => assertLensRoundTrip(dropping as any, { interact: 'menu' }, {
          synthesize: (c) => ({ type: 'msg', text: c.match ?? '', id: 'e', user: 'u', convo: 'c' }),
        }),
        /returned nothing for a 'prompt'/,
      );
    });

    it('rejects a lens whose offered affordance does not read back (the one law)', async () => {
      const { assertLensRoundTrip } = await import('../server/channels/contract');
      const lens = testLens();
      assert.throws(
        () => assertLensRoundTrip(lens, { interact: 'native' }, {
          // A native surface whose clicks come back as free text the lens
          // reads as a message — the drift the law exists to catch.
          synthesize: (choice) => ({ type: 'msg', text: choice.token, id: 'e', user: 'u', convo: 'c' }),
        }),
        /round-trip failed/,
      );
    });
  });

  // ---- Claim and advance (§6.3 / §6.6) -------------------------------------

  describe('claim and cursor', () => {
    async function seedBinding(_id: string) {
      const { ChannelBindings } = await import('../server/channels/collections');
      await ChannelBindings.insertAsync({
        _id, kind: 'test', conversationRef: _id, destination: {}, audience: 'direct',
        agent: 'channel-agent', sessionId: `s-${_id}`, userId: null,
        deliveredSeq: 0, createdAt: new Date(), updatedAt: new Date(),
      });
    }

    it('lets exactly one of two racing workers claim a binding, and the owner renew', async () => {
      const { claimBinding } = await import('../server/channels/egress');
      await seedBinding('b1');
      const [a, b] = await Promise.all([
        claimBinding('b1', 30_000, 'A'), claimBinding('b1', 30_000, 'B'),
      ]);
      assert.equal([a, b].filter(Boolean).length, 1, 'exactly one winner');
      const winner = a ? 'A' : 'B';
      assert.isTrue(await claimBinding('b1', 30_000, winner), 'the owner renews');
      assert.isFalse(await claimBinding('b1', 30_000, a ? 'B' : 'A'), 'the loser stays out');
    });

    it('advances the cursor only under the claim and only from the expected seq', async () => {
      const { claimBinding, advanceCursor } = await import('../server/channels/egress');
      await seedBinding('b2');
      await claimBinding('b2', 30_000, 'A');
      assert.isFalse(await advanceCursor('b2', 0, 3, 'B'), 'no claim, no advance');
      assert.isTrue(await advanceCursor('b2', 0, 3, 'A'));
      assert.isFalse(await advanceCursor('b2', 0, 5, 'A'), 'a stale fromSeq no-ops');
      assert.isTrue(await advanceCursor('b2', 3, 5, 'A'));
    });
  });

  // ---- Ingress (§9 / §11) --------------------------------------------------

  describe('ingress', () => {
    it('refuses a bad signature before anything else', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const out = await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'e1', user: 'u1', convo: 'c1' }, 'bad'));
      assert.equal(out.status, 401);
      const { ChannelBindings } = await import('../server/channels/collections');
      assert.equal(await ChannelBindings.find({}).countAsync(), 0, 'nothing was spent');
    });

    it('creates binding first and session second, channel descriptor included', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const out = await handleInbound('test', raw({ type: 'msg', text: 'hello', id: 'e1', user: 'u1', convo: 'c1' }));
      assert.equal(out.status, 200);

      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const binding = (await ChannelBindings.findOneAsync('test:c1'))!;
      assert.equal(binding.agent, 'channel-agent');
      assert.equal(binding.userId, null, 'unlinked sender → anonymous owner');
      assert.equal(binding.externalUserId, 'u1');
      const session = (await AgentSessions.findOneAsync(binding.sessionId))!;
      assert.deepEqual(session.channel, { origin: 'test', assurance: 'none' });
      const users = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).fetchAsync();
      assert.deepEqual(users.map((u) => u.content), ['hello']);
    });

    it('admits each provider event exactly once — a retry runs no second turn', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const event = raw({ type: 'msg', text: 'hello', id: 'same-event', user: 'u1', convo: 'c1' });
      assert.equal((await handleInbound('test', event)).status, 200);
      assert.equal((await handleInbound('test', event)).status, 200, 'the retry is answered politely');
      const { AgentMessages } = await import('../common/collections');
      const { ChannelBindings } = await import('../server/channels/collections');
      const binding = (await ChannelBindings.findOneAsync('test:c1'))!;
      const users = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).fetchAsync();
      assert.equal(users.length, 1, 'one admission, one user row');
    });

    it('throttles a flood per sender without buying admission writes', async () => {
      await registerTestChannel({ throttle: { limit: 2, intervalMs: 60_000 } });
      const { handleInbound } = await import('../server/channels/ingress');
      const { InboundSubmissions } = await import('../server/channels/collections');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await handleInbound(
          'test', raw({ type: 'msg', text: 'x', id: `e${i}`, user: 'flooder', convo: 'c1' }),
        )).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429]);
      assert.equal(await InboundSubmissions.find({}).countAsync(), 2, 'throttled events bought no insert');
    });

    it('routes noop without touching anything', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      assert.equal((await handleInbound('test', raw({ type: 'noop' }))).status, 200);
      const { ChannelBindings, InboundSubmissions } = await import('../server/channels/collections');
      assert.equal(await ChannelBindings.find({}).countAsync(), 0);
      assert.equal(await InboundSubmissions.find({}).countAsync(), 0);
    });

    it('answers a link request with a one-time URL whose redemption claims the conversation', async () => {
      const { transport } = await registerTestChannel({
        linkUrl: (token: string) => `https://app.test/link/${token}`,
      });
      const { handleInbound } = await import('../server/channels/ingress');
      // The sender talks first (anonymous session), then asks to link.
      await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'e1', user: 'ext-9', convo: 'c-9' }));
      await handleInbound('test', raw({ type: 'link', id: 'e2', user: 'ext-9', convo: 'c-9' }));

      const { ChannelLinkTokens, ChannelBindings } = await import('../server/channels/collections');
      const tokens = await ChannelLinkTokens.find({}).fetchAsync();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].externalUserId, 'ext-9', 'the token is bound to the asker');
      const offer = transport.posts.find((p) => String(p.payload.text).includes(`/link/${tokens[0]._id}`));
      assert.isDefined(offer, 'the URL was delivered back on the same surface');

      const { redeemLinkToken } = await import('../server/channels/linking');
      const identity = (await redeemLinkToken(tokens[0]._id, 'web-user'))!;
      assert.equal(identity.userId, 'web-user');
      const binding = (await ChannelBindings.findOneAsync('test:c-9'))!;
      assert.equal(binding.userId, 'web-user', 'redeeming from the signed-in side claimed the conversation');
    });

    it('echoes a noop respond as the 200 body — the URL-verification shape', async () => {
      const { def } = await registerTestChannel();
      const base = def.lens.in.bind(def.lens);
      def.lens.in = (event: any) => (event.type === 'handshake'
        ? { intent: { kind: 'noop' }, respond: event.challenge }
        : base(event));
      const { handleInbound } = await import('../server/channels/ingress');
      const out = await handleInbound('test', raw({ type: 'handshake', challenge: 'c-42' }));
      assert.equal(out.status, 200);
      assert.equal(out.body, 'c-42');
    });
  });

  // ---- Egress (§6.4 / §11) -------------------------------------------------

  describe('egress delivery', () => {
    async function seedConversation() {
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { ChannelBindings } = await import('../server/channels/collections');
      await AgentSessions.insertAsync({ ...sessionBase, _id: 'sx', nextSeq: 3 } as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 0, role: 'user', content: 'q' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 1, content: 'first answer' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 2, content: 'second answer' }) as any);
      await ChannelBindings.insertAsync({
        _id: 'test:conv', kind: 'test', conversationRef: 'conv', destination: { to: 'conv' },
        audience: 'direct', agent: 'channel-agent', sessionId: 'sx', userId: null,
        deliveredSeq: 0, createdAt: new Date(), updatedAt: new Date(),
      });
    }

    it('delivers the backlog once, advances the cursor, and a replay posts nothing', async () => {
      const { transport } = await registerTestChannel();
      const { deliverBinding } = await import('../server/channels/egress');
      await seedConversation();
      await deliverBinding('test', 'test:conv');
      assert.deepEqual(
        transport.posts.map((p) => p.payload.text),
        ['first answer', 'second answer'],
        'the user row advanced silently; both answers posted in order',
      );
      const { ChannelBindings } = await import('../server/channels/collections');
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 2);

      // The observer's whole-backlog replay on boot, in miniature: reset the
      // cursor and deliver again — the receipts make every row a no-op.
      await ChannelBindings.updateAsync('test:conv', { $set: { deliveredSeq: 0 } });
      await deliverBinding('test', 'test:conv');
      assert.equal(transport.posts.length, 2, 'replay found receipts and posted nothing');
    });

    it('a transport failure leaves the cursor unadvanced; the retry declared by the channel re-posts', async () => {
      const { transport } = await registerTestChannel({ onUncertainDelivery: 'retry' });
      const { deliverBinding } = await import('../server/channels/egress');
      const { ChannelBindings, DeliveryReceipts } = await import('../server/channels/collections');
      await seedConversation();
      transport.fail(1);
      await deliverBinding('test', 'test:conv').catch(() => { /* the failure propagates */ });
      const after = (await ChannelBindings.findOneAsync('test:conv'))!;
      assert.equal(after.deliveredSeq, 0, 'nothing confirmed, nothing advanced');
      const receipt = await DeliveryReceipts.findOneAsync({ bindingId: 'test:conv', state: 'sending' });
      assert.isDefined(receipt, 'the reserve stands, mid-sending');

      await deliverBinding('test', 'test:conv');
      assert.deepEqual(transport.posts.map((p) => p.payload.text), ['first answer', 'second answer']);
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 2);
    });

    it("honors 'abandon': the ambiguous receipt is given up and delivery moves on", async () => {
      const { transport } = await registerTestChannel({ onUncertainDelivery: 'abandon' });
      const { deliverBinding } = await import('../server/channels/egress');
      const { DeliveryReceipts, ChannelBindings } = await import('../server/channels/collections');
      await seedConversation();
      // A crash mid-send from some earlier worker:
      await DeliveryReceipts.insertAsync({
        _id: 'deliver:test:conv:m-sx-1', bindingId: 'test:conv', state: 'sending',
        attempts: 1, at: new Date(),
      });
      await deliverBinding('test', 'test:conv');
      const abandoned = (await DeliveryReceipts.findOneAsync('deliver:test:conv:m-sx-1'))!;
      assert.equal(abandoned.state, 'abandoned');
      assert.deepEqual(transport.posts.map((p) => p.payload.text), ['second answer'], 'the rest still flows');
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 2);
    });

    it("honors 'reconcile': a read-back that finds the post confirms without re-posting", async () => {
      const { transport, def } = await registerTestChannel();
      (def.transport as any).reconcile = async () => true;
      def.onUncertainDelivery = 'reconcile';
      const { deliverBinding } = await import('../server/channels/egress');
      const { DeliveryReceipts } = await import('../server/channels/collections');
      await seedConversation();
      await DeliveryReceipts.insertAsync({
        _id: 'deliver:test:conv:m-sx-1', bindingId: 'test:conv', state: 'sending',
        attempts: 1, at: new Date(),
      });
      await deliverBinding('test', 'test:conv');
      assert.equal((await DeliveryReceipts.findOneAsync('deliver:test:conv:m-sx-1'))!.state, 'sent');
      assert.deepEqual(transport.posts.map((p) => p.payload.text), ['second answer'], 'no double post');
    });

    it('delivers a parked prompt once with its registered grammar, and YES decides it', async () => {
      const { transport } = await registerTestChannel();
      const { deliverBinding } = await import('../server/channels/egress');
      const { AgentSessions } = await import('../common/collections');
      const { DeliveryReceipts } = await import('../server/channels/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await seedConversation();
      await AgentSessions.updateAsync('sx', {
        $set: {
          phase: 'awaiting',
          pending: { toolCallId: 'tc9', name: 'orders.refund', args: { id: 9 }, requestedAt: new Date() },
        },
      });

      await deliverBinding('test', 'test:conv');
      const promptPost = transport.posts.find((p) => String(p.payload.text).includes('orders.refund'))!;
      assert.include(promptPost.payload.text, 'Reply YES', 'the render used the registered grammar');
      const receipt = (await DeliveryReceipts.findOneAsync('deliver:test:conv:prompt:tc9'))!;
      assert.deepEqual(receipt.expects!.map((e) => e.match), ['YES', 'NO']);

      // Re-sweep: the same ask is not re-delivered.
      const posted = transport.posts.length;
      await deliverBinding('test', 'test:conv');
      assert.equal(transport.posts.length, posted, 'one ask, one delivery');

      // The reply grammar decides the ask — through the full pipeline. The
      // durable fact is the audit NOTE (written inside recordVerdict, before
      // the deferred resume that may consume `pending` at any moment).
      const out = await handleInbound('test', raw({ type: 'msg', text: ' yes ', id: 'ev', user: 'u1', convo: 'conv' }));
      assert.equal(out.status, 200);
      const { AgentMessages } = await import('../common/collections');
      const note = await AgentMessages.findOneAsync({ sessionId: 'sx', kind: 'approval' });
      assert.isDefined(note, 'the verdict left its audit row');
      assert.isTrue(note!.approved);
    });

    it('drops a stale YES whose ask has moved on — it becomes an ordinary message', async () => {
      await registerTestChannel();
      const { deliverBinding } = await import('../server/channels/egress');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await seedConversation();
      await AgentSessions.updateAsync('sx', {
        $set: {
          phase: 'awaiting',
          pending: { toolCallId: 'tc-old', name: 'orders.refund', args: {}, requestedAt: new Date() },
        },
      });
      await deliverBinding('test', 'test:conv');   // registers tc-old's grammar

      // The old ask resolves and a DIFFERENT one parks; the old receipt stands.
      await AgentSessions.updateAsync('sx', {
        $set: {
          phase: 'awaiting',
          pending: { toolCallId: 'tc-new', name: 'orders.cancel', args: {}, requestedAt: new Date() },
        },
      });
      await handleInbound('test', raw({ type: 'msg', text: 'YES', id: 'ev2', user: 'u1', convo: 'conv' }));
      const session = (await AgentSessions.findOneAsync('sx'))!;
      assert.isUndefined(session.pending?.verdict, "the stale grammar decided nothing");
      const users = await AgentMessages.find({ sessionId: 'sx', role: 'user' }).fetchAsync();
      assert.include(users.map((u) => u.content), 'YES', 'the text became a message instead');
    });

    it('a native postback carries its ask and is dropped when the ask changed', async () => {
      await registerTestChannel({ profile: { interact: 'native' } });
      const { AgentSessions } = await import('../common/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      const { ChannelBindings } = await import('../server/channels/collections');
      await AgentSessions.insertAsync({
        ...sessionBase, _id: 'sn', phase: 'awaiting',
        pending: { toolCallId: 'tc-current', name: 'x', args: {} },
      } as any);
      await ChannelBindings.insertAsync({
        _id: 'test:convN', kind: 'test', conversationRef: 'convN', destination: {},
        audience: 'direct', agent: 'channel-agent', sessionId: 'sn', userId: null,
        deliveredSeq: 0, createdAt: new Date(), updatedAt: new Date(),
      });

      const { AgentMessages } = await import('../common/collections');
      await handleInbound('test', raw({ type: 'action', token: 'approve', toolCallId: 'tc-stale', id: 'a1', user: 'u1', convo: 'convN' }));
      assert.isUndefined(
        await AgentMessages.findOneAsync({ sessionId: 'sn', kind: 'approval' }),
        'stale click decided nothing',
      );

      await handleInbound('test', raw({ type: 'action', token: 'approve', toolCallId: 'tc-current', id: 'a2', user: 'u1', convo: 'convN' }));
      const note = await AgentMessages.findOneAsync({ sessionId: 'sn', kind: 'approval' });
      assert.isDefined(note, 'the live click left its audit row');
      assert.isTrue(note!.approved);
    });

    it('the worker observes a committed row and delivers it without waiting for a sweep', async function () {
      this.timeout(10_000);
      const { transport } = await registerTestChannel();
      const { startEgress } = await import('../server/channels/egress');
      const { AgentMessages } = await import('../common/collections');
      await seedConversation();
      const worker = startEgress('test', { sweepMs: 3_600_000 });   // sweep effectively off
      try {
        await until(async () => transport.posts.length >= 2);   // the initial added pass drains the backlog
        await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 3, content: 'third answer' }) as any);
        await until(async () => transport.posts.some((p) => p.payload.text === 'third answer'));
      } finally {
        await worker.stop();
      }
    });
  });

  // ---- Linking (§12) -------------------------------------------------------

  describe('linking', () => {
    it('redeems a link token once, claims anonymous history, and never downgrades assurance', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'e1', user: 'ext-1', convo: 'c-1' }));

      const {
        issueLinkToken, redeemLinkToken, linkIdentity, resolveIdentity,
      } = await import('../server/channels/linking');
      const token = await issueLinkToken('test', 'ext-1');
      const identity = (await redeemLinkToken(token, 'meteor-user'))!;
      assert.equal(identity.userId, 'meteor-user');
      assert.equal(identity.assurance, 'link');
      assert.isNull(await redeemLinkToken(token, 'meteor-user'), 'single-use');

      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentSessions } = await import('../common/collections');
      const binding = (await ChannelBindings.findOneAsync('test:c-1'))!;
      assert.equal(binding.userId, 'meteor-user', 'the anonymous binding was claimed');
      const session = (await AgentSessions.findOneAsync(binding.sessionId))!;
      assert.equal(session.userId, 'meteor-user', 'and its session with it');
      assert.equal(session.channel?.assurance, 'link');

      await linkIdentity('test', 'ext-1', 'meteor-user', 'oidc');
      await linkIdentity('test', 'ext-1', 'meteor-user', 'link');
      assert.equal((await resolveIdentity('test', 'ext-1'))!.assurance, 'oidc', 'stronger proof survives');
    });

    it('a linked sender opens sessions owned by their account', async () => {
      await registerTestChannel();
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'ext-2', 'owner-2', 'oidc');
      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'e2', user: 'ext-2', convo: 'c-2' }));
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentSessions } = await import('../common/collections');
      const binding = (await ChannelBindings.findOneAsync('test:c-2'))!;
      assert.equal(binding.userId, 'owner-2');
      const session = (await AgentSessions.findOneAsync(binding.sessionId))!;
      assert.deepEqual(session.channel, { origin: 'test', assurance: 'oidc' });
    });

    it('redeems a verdict token once, against the currently parked ask only', async () => {
      await registerTestChannel();
      const { AgentSessions } = await import('../common/collections');
      await AgentSessions.insertAsync({
        ...sessionBase, _id: 'sv', phase: 'awaiting',
        pending: { toolCallId: 'tcv', name: 'x', args: {} },
      } as any);
      const { issueVerdictToken, redeemVerdictToken } = await import('../server/channels/linking');

      const stale = await issueVerdictToken('channel-agent', 'sv', 'tc-other', 'approved');
      assert.isFalse(await redeemVerdictToken(stale), 'a token for a different ask decides nothing');

      const token = await issueVerdictToken('channel-agent', 'sv', 'tcv', 'approved');
      assert.isTrue(await redeemVerdictToken(token));
      const { AgentMessages } = await import('../common/collections');
      const note = await AgentMessages.findOneAsync({ sessionId: 'sv', kind: 'approval' });
      assert.isDefined(note, 'the redemption left its audit row');
      assert.isTrue(note!.approved);
      assert.isFalse(await redeemVerdictToken(token), 'single-use');
    });
  });
});
