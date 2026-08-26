import { assert } from 'chai';
import type { AgentMessage, AgentSession } from '../common/types';
import type { ChannelDef, RawInbound } from '../server/channels/registry';
import type { DeliveryItem, InboundReading } from '../common/channel-contract';
import type { ChannelBinding } from '../server/channels/collections';

/**
 * Channels (channels spec): the planner's line, the lens law, the
 * single-winner claim/advance, binding-first creation, deduplicated admission,
 * receipt-backed delivery, the expects grammar with its
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
      // The naming clause: a text surface names each file it cannot carry.
      const files = (item.item === 'reply' || item.item === 'overflow')
        ? (item.attachments ?? []).map((a) => ` [file: ${a.name}]`).join('')
        : '';
      if (item.item === 'reply') return { text: `${item.text}${files}` };
      if (item.item === 'status') return { text: `[${item.kind}] ${item.reason ?? ''}` };
      if (item.item === 'overflow') return { text: `${item.head}${item.url ? ` ${item.url}` : ''}${files}` };
      const menu = item.choices
        .map((c) => (c.match ? `Reply ${c.match} to ${c.label.toLowerCase()}` : c.url ? `${c.label}: ${c.url}` : c.label))
        .join(', ');
      // The display clause: a conforming lens shows the tool's own account of
      // the call, not just the name and the affordances.
      const account = item.display ? `${item.display} ` : '';
      return { text: `Approve ${item.name}? ${account}${menu}` };
    },
    in(event: any): InboundReading {
      if (event.type === 'noop') return { intent: { kind: 'noop' } };
      const envelope = {
        eventId: event.id,
        externalUserId: event.user,
        conversationRef: event.convo,
        destination: { to: event.convo },
        // `group: true` on a test event models a surface others can see.
        audience: (event.group ? 'group' : 'direct') as 'group' | 'direct',
        // A forgeable-sender surface (email) sets this false when the mail was
        // not authenticated; omitted models a provider-authenticated surface.
        ...(event.senderVerified !== undefined ? { senderVerified: event.senderVerified } : {}),
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
      return {
        intent: { kind: 'message', text: event.text },
        ...envelope,
        // Files a test event carries — the email-shaped pass-through.
        ...(event.files ? { attachments: event.files } : {}),
      };
    },
  };
}

/** A transport that records every post; `fail` makes the next N posts throw. */
function testTransport(extra: { reconcile?: () => Promise<boolean> } = {}) {
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
    ...(extra.reconcile ? { reconcile: extra.reconcile } : {}),
  };
}

async function registerTestChannel(over: Partial<ChannelDef> = {}, transport = testTransport()) {
  const { Agent, mockProvider } = await import('../server/index');
  const { _clearChannels } = await import('../server/channels/registry');
  _clearChannels();
  new Agent('channel-agent').define({
    model: 'mock', instructions: 'test',
    provider: mockProvider(() => ({ text: 'the answer' })),
  });
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

async function seedBinding(_id: string, over: Partial<ChannelBinding> = {}) {
  const { ChannelBindings } = await import('../server/channels/collections');
  await ChannelBindings.insertAsync({
    _id, kind: 'test', conversationRef: _id.replace(/^test:/, ''), destination: {}, audience: 'direct',
    agent: 'channel-agent', sessionId: `s-${_id}`, userId: null, deliveredSeq: 0,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });
}

/** Park an ask on an existing session — the shape promptItem reads. */
async function parkAsk(sessionId: string, toolCallId: string, name = 'orders.refund') {
  const { AgentSessions } = await import('../common/collections');
  await AgentSessions.updateAsync(sessionId, {
    $set: { phase: 'awaiting', pending: { toolCallId, name, args: {}, requestedAt: new Date() } },
  });
}

async function cleanChannels() {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const {
    ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
    DeliveryReceipts, InboundSubmissions,
  } = await import('../server/channels/collections');
  const { _clearThrottle } = await import('../server/channels/ingress');
  const { _clearChannels } = await import('../server/channels/registry');
  const { AgentAttachments } = await import('../server/attachments');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentAttachments.removeAsync({});
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

    it('advances silently past an empty answer and passes status fields through', async () => {
      const { planItems } = await import('../server/channels/plan');
      const rows = [
        msg({ sessionId: 's', seq: 1, content: '' }),
        msg({ sessionId: 's', seq: 2, role: 'note', kind: 'approval', approved: false, timedOut: true, reason: 'approval timed out' }),
        msg({ sessionId: 's', seq: 3, role: 'note', kind: 'budget', budget: 'toolCalls' }),
      ];
      const planned = planItems(rows, { statuses: ['approval', 'budget'], profile: { interact: 'menu' } });
      assert.isNull(planned[0].item, 'nothing to say is nothing to post — the cursor still moves');
      assert.deepEqual(planned[1].item, { item: 'status', kind: 'approval', reason: 'approval timed out', approved: false, timedOut: true }, 'the timeout FLAG rides the item — lenses key on it, not on the reason');
      assert.deepEqual(planned[2].item, { item: 'status', kind: 'budget', budget: 'toolCalls' });
    });

    it('turns an over-limit reply into a mechanical head-slice, link included only when given', async () => {
      const { planItems } = await import('../server/channels/plan');
      const long = 'x'.repeat(500);
      const rows = [msg({ sessionId: 's', seq: 1, content: long })];
      const linked = planItems(rows, {
        profile: { interact: 'menu', limit: 100 }, overflowUrl: 'https://app.test/s/1',
      })[0].item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.equal(linked.item, 'overflow');
      assert.isAtMost(linked.head.length + 1 + linked.url!.length, 100, 'head + space + url fits the limit');
      assert.equal(linked.url, 'https://app.test/s/1');
      const bare = planItems(rows, { profile: { interact: 'menu', limit: 100 } })[0]
        .item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.isUndefined(bare.url, 'no url unless the caller allowed one');
      const tiny = planItems(rows, { profile: { interact: 'menu', limit: 3 }, overflowUrl: 'https://x' })[0]
        .item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.equal(tiny.head, 'x…', 'a limit under the reserve still yields one character');
    });

    it('never cuts a surrogate pair when slicing the head', async () => {
      const { planItems } = await import('../server/channels/plan');
      // 'a' then an emoji (two UTF-16 code units): with limit 4 the reserve of
      // 2 leaves end = 2, which would split the pair — the slice backs off.
      const rows = [msg({ sessionId: 's', seq: 1, content: `a😀${'b'.repeat(10)}` })];
      const split = planItems(rows, { profile: { interact: 'menu', limit: 4 } })[0]
        .item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.equal(split.head, 'a…', 'the high surrogate was not left dangling');
      // With room for the whole pair, it stays.
      const whole = planItems(rows, { profile: { interact: 'menu', limit: 5 } })[0]
        .item as Extract<DeliveryItem, { item: 'overflow' }>;
      assert.equal(whole.head, 'a😀…');
    });

    it('builds the prompt from the parked state only while unanswered, with menu matches', async () => {
      const { promptItem } = await import('../server/channels/plan');
      const { MENU_MATCHES } = await import('../common/channel-contract');
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
      assert.isNull(promptItem({ ...parked, phase: 'idle' }, { interact: 'menu' }), 'only a parked session prompts');
      assert.notProperty(item, 'runAs');
      const svc = promptItem({ ...parked, pending: { ...parked.pending!, runAs: null } }, { interact: 'menu' })!;
      assert.property(svc, 'runAs');
      assert.isNull(svc.runAs, 'null is a real value, not absence');
    });

    it('matchExpectation decides on the exact word only; native prompts register no grammar', async () => {
      const { promptItem } = await import('../server/channels/plan');
      const { matchExpectation, expectationsFor } = await import('../common/channel-contract');
      const expects = [{ match: 'YES', verdict: 'approved' as const, toolCallId: 'tc1' }, { match: 'NO', verdict: 'denied' as const, toolCallId: 'tc1' }];
      assert.deepEqual(matchExpectation(' yes ', expects), { verdict: 'approved', toolCallId: 'tc1' });
      assert.deepEqual(matchExpectation('No', expects), { verdict: 'denied', toolCallId: 'tc1' });
      assert.isNull(matchExpectation('yes please', expects), 'a sentence is a message');
      assert.isNull(matchExpectation('YES', []));
      const parked: AgentSession = { ...sessionBase, _id: 'p', phase: 'awaiting', pending: { toolCallId: 'tc1', name: 'x', args: {} } };
      assert.deepEqual(expectationsFor(promptItem(parked, { interact: 'native' })!), []);
      assert.deepEqual(expectationsFor(promptItem(parked, { interact: 'menu' })!).map((e) => [e.match, e.verdict]), [['YES', 'approved'], ['NO', 'denied']]);
    });
  });

  // ---- The lens law (§8.3 / §8.7) ------------------------------------------

  describe('lens contract', () => {
    it('accepts a lens whose grammar round-trips, menu text included', async () => {
      const { assertLensRoundTrip } = await import('../common/channel-contract');
      const lens = testLens();
      assertLensRoundTrip(lens, { interact: 'menu' }, {
        synthesize: (choice) => ({ type: 'msg', text: choice.match ?? choice.token, id: 'e', user: 'u', convo: 'c' }),
        message: (text) => ({ type: 'msg', text, id: 'e', user: 'u', convo: 'c' }),
      });
    });

    it('rejects a lens that drops an item (totality)', async () => {
      const { assertLensRoundTrip } = await import('../common/channel-contract');
      const lens = testLens();
      const dropping = {
        ...lens,
        out: (item: DeliveryItem) => (item.item === 'prompt' ? null : lens.out(item)),
      };
      assert.throws(
        () => assertLensRoundTrip(dropping, { interact: 'menu' }, {
          synthesize: (c) => ({ type: 'msg', text: c.match ?? '', id: 'e', user: 'u', convo: 'c' }),
        }),
        /returned nothing for a 'prompt'/,
      );
    });

    it('rejects a lens that drops the tool’s account (the display clause)', async () => {
      const { assertLensRoundTrip } = await import('../common/channel-contract');
      const lens = testLens();
      // Renders the name, the args and both affordances — everything except
      // the one line that tells the human what they are agreeing to. This is
      // exactly what four shipped lenses did, and it passed until the clause.
      const silent = {
        ...lens,
        out: (item: DeliveryItem) => (item.item === 'prompt'
          ? {
            text: `Approve ${item.name}? ${item.choices
              .map((c) => `Reply ${c.match} to ${c.label.toLowerCase()}`).join(', ')}`,
          }
          : lens.out(item)),
      };
      assert.throws(
        () => assertLensRoundTrip(silent, { interact: 'menu' }, {
          synthesize: (c) => ({ type: 'msg', text: c.match ?? '', id: 'e', user: 'u', convo: 'c' }),
        }),
        /carried `display`/,
      );
    });

    it('promptDisplay trims, clamps without splitting a surrogate pair, and escapes', async () => {
      const { promptDisplay } = await import('../common/channel-contract');
      assert.equal(promptDisplay(undefined), '', 'an unhydrated account renders nothing');
      assert.equal(promptDisplay('   '), '', 'and so does a blank one');
      assert.equal(promptDisplay('  hi  '), 'hi');
      assert.equal(
        promptDisplay('<b>', { escape: (t) => t.replace(/</g, '&lt;') }), '&lt;b>',
        'the surface\'s own escaping applies — display carries model text',
      );
      const long = promptDisplay('a'.repeat(50), { limit: 10 });
      assert.equal(long, `${'a'.repeat(10)}…`);
      // A lone high surrogate is a payload providers reject deterministically,
      // so the clamp steps back off a pair rather than cutting through it.
      const pair = promptDisplay(`${'a'.repeat(9)}😀tail`, { limit: 10 });
      assert.equal(pair, `${'a'.repeat(9)}…`);
    });

    it('rejects a lens whose offered affordance does not read back (the one law)', async () => {
      const { assertLensRoundTrip } = await import('../common/channel-contract');
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

    it('names the missing corpus kind, the missing synthesize, and a message that does not read back', async () => {
      const { assertLensRoundTrip, exemplarItems } = await import('../common/channel-contract');
      const lens = testLens();
      const ev = (text: string) => ({ type: 'msg', text, id: 'e', user: 'u', convo: 'c' });
      assert.throws(() => assertLensRoundTrip(lens, { interact: 'menu' }, {
        items: exemplarItems().filter((i) => i.item !== 'overflow'), synthesize: (c) => ev(c.match ?? ''),
      }), /carries no 'overflow' item/);
      assert.throws(() => assertLensRoundTrip(lens, { interact: 'menu' }), /needs `synthesize`/);
      assert.throws(() => assertLensRoundTrip(lens, { interact: 'menu' }, {
        synthesize: (c) => ev(c.match ?? ''), message: () => ({ type: 'noop' }),
      }), /plain inbound message event read back/);
      const emptyArray = { ...lens, out: (i: DeliveryItem) => (i.item === 'status' ? [] : lens.out(i)) };
      assert.throws(() => assertLensRoundTrip(emptyArray, { interact: 'menu' }, { synthesize: (c) => ev(c.match ?? '') }), /returned nothing for a 'status'/);
    });

    it('the shared postback codec round-trips, degrades to token-only over a byte cap, and rejects junk', async () => {
      const {
        encodeVerdictPostback, decodeVerdictPostback, VERDICT_FOR, isLinkGesture, LINK_GESTURE,
      } = await import('../common/channel-contract');
      assert.deepEqual(decodeVerdictPostback(encodeVerdictPostback('approve', 'tc1')), { verdict: 'approved', toolCallId: 'tc1' });
      assert.deepEqual(decodeVerdictPostback(encodeVerdictPostback('deny', 'tc1')), { verdict: 'denied', toolCallId: 'tc1' });
      assert.equal(VERDICT_FOR.approve, 'approved');
      assert.equal(VERDICT_FOR.deny, 'denied');
      // Over the cap the id is DROPPED, never truncated into a wrong ask.
      const long = encodeVerdictPostback('approve', 'x'.repeat(100), { maxBytes: 64 });
      assert.isAtMost(Buffer.byteLength(long, 'utf8'), 64);
      assert.deepEqual(decodeVerdictPostback(long), { verdict: 'approved' });
      // The cap is BYTES, not UTF-16 units: 20 emoji are 40 code units but 80 bytes.
      const wide = encodeVerdictPostback('approve', '😀'.repeat(20), { maxBytes: 64 });
      assert.isAtMost(Buffer.byteLength(wide, 'utf8'), 64);
      assert.deepEqual(decodeVerdictPostback(wide), { verdict: 'approved' }, 'a multibyte id over the byte cap is dropped — its char count would have fit');
      // An already-parsed value decodes too; junk maps to null, not a throw.
      assert.deepEqual(decodeVerdictPostback({ t: 'd', c: 'tc2' }), { verdict: 'denied', toolCallId: 'tc2' });
      assert.isNull(decodeVerdictPostback('null'), "JSON.parse('null') is guarded");
      assert.isNull(decodeVerdictPostback('not json'));
      assert.isNull(decodeVerdictPostback({ t: 'x' }));
      assert.isNull(decodeVerdictPostback(42));
      assert.isTrue(isLinkGesture(` ${LINK_GESTURE.toUpperCase()} `), 'exact word, any case, trimmed');
      assert.isFalse(isLinkGesture('link my account'), 'a sentence is a message');
    });

    it('DELIVERY_ITEM_KINDS and the DeliveryItem union name the same kinds — both ways, at compile time', async () => {
      const { DELIVERY_ITEM_KINDS, exemplarItems } = await import('../common/channel-contract');
      type Listed = (typeof DELIVERY_ITEM_KINDS)[number];
      // A union member absent from the list fails the first line (missing key);
      // a listed kind absent from the union fails the second.
      const byUnion: Record<DeliveryItem['item'], Listed> = { reply: 'reply', status: 'status', prompt: 'prompt', overflow: 'overflow' };
      const byList: Record<Listed, DeliveryItem['item']> = byUnion;
      void byList;
      // Every kind is covered; `reply` appears twice on purpose (a bare one
      // and a file-bearing one, so the naming clause is exercised by default).
      assert.sameMembers([...new Set(exemplarItems().map((i) => i.item))], [...DELIVERY_ITEM_KINDS], 'the default corpus covers every kind');
    });
  });

  // ---- Claim and advance (§6.3 / §6.6) -------------------------------------

  describe('claim and cursor', () => {
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

    it('binds the conversation and opens its session with the channel descriptor', async () => {
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

    it('admits inbound files under the channel caps: refs ride the user row, rejections become notes', async () => {
      await registerTestChannel({ attachments: { maxFileBytes: 10 } });
      const { handleInbound } = await import('../server/channels/ingress');
      const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
      const out = await handleInbound('test', raw({
        type: 'msg', text: 'the data is attached', id: 'e1', user: 'u1', convo: 'c1',
        files: [
          { name: 'data.csv', contentType: 'text/csv', size: 8, content: b64('a,b\n1,2\n') },
          { name: 'big.bin', contentType: 'application/octet-stream', size: 20, content: b64('x'.repeat(20)) },
        ],
      }));
      assert.equal(out.status, 200);
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentMessages } = await import('../common/collections');
      const { AgentAttachments } = await import('../server/attachments');
      const binding = (await ChannelBindings.findOneAsync('test:c1'))!;
      const user = (await AgentMessages.findOneAsync({ sessionId: binding.sessionId, role: 'user' }))!;
      assert.equal(user.attachments!.length, 1, 'the kept file rides the row as a ref');
      assert.equal(user.attachments![0].name, 'data.csv');
      assert.match(user.content!, /^the data is attached\n\[file "big\.bin" \(20 bytes\) exceeded the 10 bytes limit/);
      const stored = (await AgentAttachments.findOneAsync({ _id: user.attachments![0].id }))!;
      assert.equal(stored.sessionId, binding.sessionId);
      assert.equal(Buffer.from(stored.content, 'base64').toString('utf8'), 'a,b\n1,2\n');
    });

    it('an attachment-only event is a message now, and `attachments: false` restores v1', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
      const file = { name: 'answer.txt', contentType: 'text/plain', size: 3, content: b64('yes') };
      await handleInbound('test', raw({ type: 'msg', text: '', id: 'e1', user: 'u1', convo: 'c1', files: [file] }));
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentMessages } = await import('../common/collections');
      const binding = (await ChannelBindings.findOneAsync('test:c1'))!;
      const user = (await AgentMessages.findOneAsync({ sessionId: binding.sessionId, role: 'user' }))!;
      assert.equal(user.content, '', 'empty text, a message even so');
      assert.equal(user.attachments![0].name, 'answer.txt');

      // The opt-out: files dropped without a store write, a ref or a note —
      // and an attachment-only event is then nothing at all: no user row.
      await registerTestChannel({ attachments: false });
      await handleInbound('test', raw({ type: 'msg', text: '', id: 'e2', user: 'u2', convo: 'c2', files: [file] }));
      const b2 = await ChannelBindings.findOneAsync('test:c2');
      if (b2) {
        assert.equal(await AgentMessages.find({ sessionId: b2.sessionId, role: 'user' }).countAsync(), 0);
      }
      const { AgentAttachments } = await import('../server/attachments');
      assert.equal(await AgentAttachments.find({ name: 'answer.txt' }).countAsync(), 1, 'only the admitted copy exists');
    });

    it('repairs a binding whose session is missing (the crash window) with the OWNER\'s assurance, not the sender\'s', async () => {
      await registerTestChannel();
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await ChannelBindings.insertAsync({
        _id: 'test:crashed', kind: 'test', conversationRef: 'crashed', destination: { to: 'crashed' },
        audience: 'direct', agent: 'channel-agent', sessionId: 'ghost', userId: 'owner-1', assurance: 'oidc',
        externalUserId: 'u1', deliveredSeq: 0, createdAt: new Date(), updatedAt: new Date(),
      });
      assert.isUndefined(await AgentSessions.findOneAsync('ghost'), 'the winner crashed between its two writes');
      // An UNLINKED sender triggers the repair; the session must still carry the owner's proof.
      assert.equal((await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'e1', user: 'u1', convo: 'crashed' }))).status, 200);
      const session = (await AgentSessions.findOneAsync('ghost'))!;
      assert.equal(session.userId, 'owner-1');
      assert.deepEqual(session.channel, { origin: 'test', assurance: 'oidc' });
      assert.equal(await AgentMessages.find({ sessionId: 'ghost', role: 'user' }).countAsync(), 0, 'the unlinked sender still cannot drive the owned session');
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

    it('throttles a flood per sender — dropped with a 200, and without buying admission writes', async () => {
      await registerTestChannel({ throttle: { limit: 2, intervalMs: 60_000 } });
      const { handleInbound } = await import('../server/channels/ingress');
      const { InboundSubmissions } = await import('../server/channels/collections');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await handleInbound(
          'test', raw({ type: 'msg', text: 'x', id: `e${i}`, user: 'flooder', convo: 'c1' }),
        )).status);
      }
      // 200 throughout: a 429 would be a failure the provider retries and
      // counts against the integration — throttled events are settled, not
      // refused. The admission count is the proof they were dropped.
      assert.deepEqual(statuses, [200, 200, 200, 200]);
      assert.equal(await InboundSubmissions.find({}).countAsync(), 2, 'throttled events bought no insert');
    });

    it('never posts a linking URL into a group — it offers a hint instead', async () => {
      const { transport } = await registerTestChannel({
        linkUrl: (token: string) => `https://app.test/link/${token}`,
      });
      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'hi', id: 'g1', user: 'ext-g', convo: 'room', group: true }));
      await handleInbound('test', raw({ type: 'link', id: 'g2', user: 'ext-g', convo: 'room', group: true }));
      const { ChannelLinkTokens } = await import('../server/channels/collections');
      assert.equal(await ChannelLinkTokens.find({}).countAsync(), 0, 'no token was minted for a group request');
      assert.isTrue(
        transport.posts.some((p) => String(p.payload.text).includes('direct message')),
        'the group got a hint, not a credential',
      );
      assert.isFalse(transport.posts.some((p) => String(p.payload.text).includes('/link/')), 'no URL left the server');
    });

    it('an anonymous group conversation answers only to the member who opened it', async () => {
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { ChannelBindings } = await import('../server/channels/collections');
      await handleInbound('test', raw({ type: 'msg', text: 'opener here', id: 'o1', user: 'opener', convo: 'thread', group: true }));
      const binding = (await ChannelBindings.findOneAsync('test:thread'))!;
      assert.equal(binding.userId, null, 'anonymous conversation');
      assert.equal(binding.audience, 'group');
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();

      // A bystander sends into it — nothing enters.
      await handleInbound('test', raw({ type: 'msg', text: 'me too', id: 'b1', user: 'bystander', convo: 'thread', group: true }));
      assert.equal(await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync(), before);

      // The opener's first message kicked off a REAL (mock) turn. Let it
      // finish before hand-parking the session: a turn still winding down
      // idles the phase back in its `finally`, and the park would be undone
      // under the click — a race the test must not invite.
      await until(async () => {
        const s = await AgentSessions.findOneAsync(binding.sessionId);
        const replied = await AgentMessages.find({ sessionId: binding.sessionId, role: 'assistant' }).countAsync();
        return s?.phase === 'idle' && replied > 0;
      });

      // A bystander clicks Approve on the opener's parked ask — nothing decided.
      await parkAsk(binding.sessionId, 'tc-g', 'refund');
      await handleInbound('test', raw({ type: 'action', token: 'approve', toolCallId: 'tc-g', id: 'b2', user: 'bystander', convo: 'thread', group: true }));
      assert.isUndefined(await AgentMessages.findOneAsync({ sessionId: binding.sessionId, kind: 'approval' }), 'bystander decided nothing');

      // The opener still can.
      await handleInbound('test', raw({ type: 'action', token: 'approve', toolCallId: 'tc-g', id: 'o2', user: 'opener', convo: 'thread', group: true }));
      assert.isDefined(await AgentMessages.findOneAsync({ sessionId: binding.sessionId, kind: 'approval' }), 'the opener decides their own ask');
    });

    it('a direct thread whose ref is not the sender (email-shaped) still rejects a stranger', async () => {
      // Email's conversationRef is a THREAD key, not the sender, so a Cc'd or
      // reply-all party reaches the opener's binding with a different id. The
      // opener guard must fire even though the audience is 'direct' — the
      // provider-keyed surfaces are unaffected (there the ref embeds the
      // sender, so a stranger is a different binding and this never arises).
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const { AgentMessages } = await import('../common/collections');
      const { ChannelBindings } = await import('../server/channels/collections');
      await handleInbound('test', raw({ type: 'msg', text: 'opener here', id: 'd1', user: 'ada', convo: 'thread-x' }));
      const binding = (await ChannelBindings.findOneAsync('test:thread-x'))!;
      assert.equal(binding.userId, null, 'anonymous conversation');
      assert.equal(binding.audience, 'direct');
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();

      // A different sender on the SAME thread — the shared-key stranger.
      await handleInbound('test', raw({ type: 'msg', text: 'me too', id: 'd2', user: 'bob', convo: 'thread-x' }));
      assert.equal(
        await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync(), before,
        'a stranger on a direct thread injects nothing',
      );
    });

    it('an unverified sender never resolves to a linked account (the email spoof gate)', async () => {
      // ext-x is a linked identity. A surface whose sender id is forgeable
      // (email without author-aligned DKIM) marks the reading senderVerified:
      // false — and the pipeline must then treat the sender as anonymous, so a
      // spoofed `From: ext-x` cannot act as the account ext-x linked to.
      await registerTestChannel();
      const { handleInbound } = await import('../server/channels/ingress');
      const { linkIdentity } = await import('../server/channels/linking');
      const { ChannelBindings } = await import('../server/channels/collections');
      await linkIdentity('test', 'ext-x', 'acct-1', 'oidc');

      await handleInbound('test', raw({ type: 'msg', text: 'spoofed', id: 'u1', user: 'ext-x', convo: 'thread-spoof', senderVerified: false }));
      const spoofed = (await ChannelBindings.findOneAsync('test:thread-spoof'))!;
      assert.equal(spoofed.userId, null, 'unverified sender stays anonymous despite the linked identity');

      await handleInbound('test', raw({ type: 'msg', text: 'genuine', id: 'u2', user: 'ext-x', convo: 'thread-real', senderVerified: true }));
      const genuine = (await ChannelBindings.findOneAsync('test:thread-real'))!;
      assert.equal(genuine.userId, 'acct-1', 'a verified sender resolves to the linked account');
    });

    it('a native postback carries its ask and is dropped when the ask changed', async () => {
      await registerTestChannel({ profile: { interact: 'native' } });
      const { AgentSessions } = await import('../common/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await AgentSessions.insertAsync({
        ...sessionBase, _id: 'sn', phase: 'awaiting',
        pending: { toolCallId: 'tc-current', name: 'x', args: {} },
      } as any);
      await seedBinding('test:convN', { sessionId: 'sn' });

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

    it('forgets senders whose window has aged out — the throttle is bounded by concurrency, not history', async () => {
      await registerTestChannel({ throttle: { limit: 5, intervalMs: 1_000 } });
      const { handleInbound, _throttleStats } = await import('../server/channels/ingress');
      for (let i = 0; i < 25; i += 1) {
        await handleInbound('test', raw({ type: 'msg', text: 'x', id: `e${i}`, user: `sender-${i}`, convo: `c-${i}` }));
      }
      assert.equal(_throttleStats().tracked, 25, 'each distinct sender holds a window while live');
      // A second later every window has aged out; the sweep must drop them all.
      assert.equal(_throttleStats(Date.now() + 1_500).tracked, 0, 'aged-out senders are forgotten');
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

    it('refuses an oversize webhook body with 413 before verifying anything', async () => {
      await registerTestChannel();
      const { mountChannelRoutes, MAX_INBOUND_BYTES } = await import('../server/channels/ingress');
      let handler: ((req: any, res: any) => void) | null = null;
      mountChannelRoutes({ use(_path: string, fn: any) { handler = fn; } });
      assert.isFunction(handler, 'the route was mounted');

      // A fake request that LIES about its length (small header) and streams
      // past the cap, and a fake response that records the status.
      const listeners: Record<string, (x?: any) => void> = {};
      let destroyed = false;
      const req = {
        headers: { 'content-length': '10', 'x-sig': 'ok' },
        url: '/agent/channels/test',
        setEncoding() {},
        on(ev: string, fn: (x?: any) => void) { listeners[ev] = fn; },
        destroy() { destroyed = true; },
      };
      let status = 0;
      const res = { writeHead(s: number) { status = s; }, end() {} };
      handler!(req, res);
      // Stream 2 MiB in 64 KiB chunks — the cap must trip mid-stream.
      const chunk = 'x'.repeat(64 * 1024);
      for (let sent = 0; sent < 2 * MAX_INBOUND_BYTES && !destroyed; sent += chunk.length) {
        listeners.data(chunk);
      }
      await new Promise((r) => { setTimeout(r, 20); });
      assert.isTrue(destroyed, 'the socket was closed at the cap');
      assert.equal(status, 413);
    });

    it('preverifies headers before buffering, then still runs full verification', async () => {
      let verifyCalls = 0;
      await registerTestChannel({
        preverify: (head) => {
          if (head.headers['x-preverify'] === 'throw') {
            throw new Error('SECRET pre-verifier detail');
          }
          return head.headers['x-preverify'] === 'ok';
        },
        verify: (request) => {
          verifyCalls += 1;
          return request.headers['x-sig'] === 'ok';
        },
      });
      const { mountChannelRoutes } = await import('../server/channels/ingress');
      let handler: ((req: any, res: any) => void) | null = null;
      mountChannelRoutes({ use(_path: string, fn: any) { handler = fn; } });

      let rejectedStatus = 0;
      let rejectedEnded!: () => void;
      const rejectedDone = new Promise<void>((resolve) => { rejectedEnded = resolve; });
      let drained = false;
      handler!({
        headers: { 'x-preverify': 'bad', 'x-sig': 'ok' },
        url: '/agent/channels/test',
        setEncoding() { throw new Error('body buffering must not start'); },
        on() { throw new Error('body listeners must not be installed'); },
        resume() { drained = true; },
      }, {
        writeHead(next: number) { rejectedStatus = next; },
        end() { rejectedEnded(); },
      });
      await rejectedDone;
      assert.equal(rejectedStatus, 401);
      assert.isTrue(drained, 'the rejected request is drained without buffering');
      assert.equal(verifyCalls, 0, 'full body verification is not reached after rejection');

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      let thrownStatus = 0;
      let thrownEnded!: () => void;
      const thrownDone = new Promise<void>((resolve) => { thrownEnded = resolve; });
      try {
        handler!({
          headers: { 'x-preverify': 'throw', 'x-sig': 'ok' },
          url: '/agent/channels/test',
          setEncoding() { throw new Error('body buffering must not start'); },
          on() { throw new Error('body listeners must not be installed'); },
          resume() {},
        }, {
          writeHead(next: number) { thrownStatus = next; },
          end() { thrownEnded(); },
        });
        await thrownDone;
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(thrownStatus, 401, 'a pre-verifier exception fails closed');
      assert.include(warnings.join('\n'), 'pre-verification failed closed');
      assert.notInclude(warnings.join('\n'), 'SECRET');
      assert.equal(verifyCalls, 0);

      const listeners: Record<string, (chunk?: any) => void> = {};
      let acceptedStatus = 0;
      let acceptedEnded!: () => void;
      const acceptedDone = new Promise<void>((resolve) => { acceptedEnded = resolve; });
      handler!({
        headers: { 'x-preverify': 'ok', 'x-sig': 'ok' },
        url: '/agent/channels/test',
        setEncoding() {},
        on(event: string, fn: (chunk?: any) => void) { listeners[event] = fn; },
        destroy() {},
      }, {
        writeHead(next: number) { acceptedStatus = next; },
        end() { acceptedEnded(); },
      });
      // `preverify` may be async, so body listeners are installed only after
      // its promise permits the request.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      const body = JSON.stringify({ type: 'noop' });
      listeners.data(body);
      listeners.end();
      await acceptedDone;
      assert.equal(acceptedStatus, 200);
      assert.equal(verifyCalls, 1, 'preverification never replaces full verification');
    });

    it('does not copy raw webhook exceptions into the server log', async () => {
      await registerTestChannel();
      const { mountChannelRoutes } = await import('../server/channels/ingress');
      let handler: ((req: any, res: any) => void) | null = null;
      mountChannelRoutes({ use(_path: string, fn: any) { handler = fn; } });

      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      let status = 0;
      let ended!: () => void;
      const done = new Promise<void>((resolve) => { ended = resolve; });
      try {
        handler!({
          headers: { 'x-sig': 'ok' },
          url: '/agent/channels/test',
          setEncoding() { throw new Error('SECRET body or credential detail'); },
        }, {
          writeHead(next: number) { status = next; },
          end() { ended(); },
        });
        await done;
      } finally {
        console.error = originalError;
      }
      assert.equal(status, 500);
      assert.include(logs.join('\n'), 'webhook failed');
      assert.notInclude(logs.join('\n'), 'SECRET');
    });

    it('settles a verified event the lens cannot interpret with 200 — never a retry-inviting 500', async () => {
      const { def } = await registerTestChannel();
      const base = def.lens.in.bind(def.lens);
      def.lens.in = (event: any) => {
        if (event.type === 'poison') throw new TypeError("Cannot read properties of null (reading 't')");
        return base(event);
      };
      const { handleInbound } = await import('../server/channels/ingress');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      try {
        const out = await handleInbound('test', raw({ type: 'poison' }));
        assert.equal(out.status, 200);
      } finally {
        console.warn = originalWarn;
      }
      assert.include(warnings.join('\n'), 'lens could not interpret');
      assert.notInclude(warnings.join('\n'), 'Cannot read properties');
      // And the pipeline is intact afterwards.
      const ok = await handleInbound('test', raw({ type: 'msg', text: 'still here', id: 'p1', user: 'u', convo: 'c' }));
      assert.equal(ok.status, 200);
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
      await AgentSessions.insertAsync({ ...sessionBase, _id: 'sx', nextSeq: 3 } as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 0, role: 'user', content: 'q' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 1, content: 'first answer' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 2, content: 'second answer' }) as any);
      await seedBinding('test:conv', { sessionId: 'sx', destination: { to: 'conv' } });
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

    it('hydrates a file-bearing reply on the POST path, and an expired ref becomes a note, not a wedge', async () => {
      // A lens that CARRIES bytes (the email shape): attachments ride the
      // payload as `files`; the item arrives hydrated — the lens never fetches.
      const base = testLens();
      const byteLens = {
        ...base,
        out(item: DeliveryItem): unknown {
          if (item.item === 'reply') return { text: item.text, files: item.attachments ?? [] };
          return base.out(item);
        },
      };
      const { transport } = await registerTestChannel({ lens: byteLens });
      const { deliverBinding } = await import('../server/channels/egress');
      const { createAttachment } = await import('../server/attachments');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await AgentSessions.insertAsync({ ...sessionBase, _id: 'sf', nextSeq: 2 } as any);
      const ref = await createAttachment({
        sessionId: 'sf', name: 'summary.csv', contentType: 'text/csv', content: 'a,b\n',
      });
      const gone = { id: 'attgone', name: 'expired.csv', contentType: 'text/csv', size: 4 };
      await AgentMessages.insertAsync(msg({ sessionId: 'sf', seq: 0, role: 'user', content: 'q' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sf', seq: 1, content: 'the report', attachments: [ref, gone] }) as any);
      await seedBinding('test:convf', { sessionId: 'sf', destination: { to: 'convf' } });
      await deliverBinding('test', 'test:convf');
      assert.equal(transport.posts.length, 1);
      const p = transport.posts[0].payload as { text: string; files: Array<{ name: string; content: string }> };
      assert.match(p.text, /^the report\n\[the file "expired\.csv" expired before this could be delivered\]$/);
      assert.equal(p.files.length, 1, 'the courier never claims a file it did not deliver');
      assert.equal(Buffer.from(p.files[0].content, 'base64').toString('utf8'), 'a,b\n', 'bytes hydrated from the store');
      const { ChannelBindings } = await import('../server/channels/collections');
      assert.equal((await ChannelBindings.findOneAsync('test:convf'))!.deliveredSeq, 1, 'the conversation moved on');
    });

    it('sends the overflow link only where §8.5 allows: an anonymous session\'s URL never enters a group', async () => {
      const { transport } = await registerTestChannel({
        profile: { interact: 'menu', limit: 40 },
        sessionUrl: (s) => `https://app.test/s/${s._id}`,
      });
      const { deliverBinding } = await import('../server/channels/egress');
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await seedConversation();   // sx is anonymous (userId: null)
      await ChannelBindings.updateAsync('test:conv', { $set: { audience: 'group' } });
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 3, content: 'x'.repeat(200) }) as any);
      await deliverBinding('test', 'test:conv');
      assert.notInclude(String(transport.posts.at(-1)!.payload.text), 'https://app.test/s/sx', 'anonymous + group: the link is a credential and stays home');
      await AgentSessions.updateAsync('sx', { $set: { userId: 'owner' } });
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 4, content: 'y'.repeat(200) }) as any);
      await deliverBinding('test', 'test:conv');
      assert.include(String(transport.posts.at(-1)!.payload.text), 'https://app.test/s/sx', 'an owned session\'s URL is login-gated and may go anywhere');
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

      // The retry runs on the backoff schedule — a later sweep, not the very
      // next tick — so age the receipt past its first window as the sweep
      // would find it.
      await DeliveryReceipts.updateAsync(receipt!._id, { $set: { at: new Date(Date.now() - 60_000) } });
      await deliverBinding('test', 'test:conv');
      assert.deepEqual(transport.posts.map((p) => p.payload.text), ['first answer', 'second answer']);
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 2);
    });

    it('backs off a failing receipt instead of re-posting every sweep, then gives up after the cap', async () => {
      const { transport } = await registerTestChannel({ onUncertainDelivery: 'retry' });
      const { deliverBinding, MAX_DELIVERY_ATTEMPTS } = await import('../server/channels/egress');
      const { ChannelBindings, DeliveryReceipts } = await import('../server/channels/collections');
      await seedConversation();
      transport.fail(1);
      await deliverBinding('test', 'test:conv').catch(() => { /* first post fails */ });
      assert.equal(transport.posts.length, 0);

      // Immediately again: inside the backoff window → deferred, no post,
      // cursor untouched.
      await deliverBinding('test', 'test:conv');
      assert.equal(transport.posts.length, 0, 'deferred: no hammering inside the window');
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 0);

      // Age the receipt past its window → the retry runs and delivery resumes.
      await DeliveryReceipts.updateAsync('deliver:test:conv:m-sx-1', { $set: { at: new Date(Date.now() - 60_000) } });
      await deliverBinding('test', 'test:conv');
      assert.deepEqual(transport.posts.map((p) => p.payload.text), ['first answer', 'second answer']);

      // The cap: a receipt at the attempt ceiling is abandoned and the
      // conversation moves on rather than wedging forever.
      await DeliveryReceipts.insertAsync({
        _id: 'deliver:test:conv:m-sx-3', bindingId: 'test:conv', state: 'sending',
        attempts: MAX_DELIVERY_ATTEMPTS, at: new Date(Date.now() - 60_000),
      });
      const { AgentMessages } = await import('../common/collections');
      await AgentMessages.insertAsync(msg({ sessionId: 'sx', seq: 3, content: 'third answer' }) as any);
      await deliverBinding('test', 'test:conv');
      assert.equal((await DeliveryReceipts.findOneAsync('deliver:test:conv:m-sx-3'))!.state, 'abandoned');
      assert.equal((await ChannelBindings.findOneAsync('test:conv'))!.deliveredSeq, 3, 'the cursor moved past the abandoned row');
    });

    it('sweeps only recently active bindings — a parked prompt on a stale binding waits for activity', async function () {
      this.timeout(10_000);
      const { transport } = await registerTestChannel();
      const { startEgress } = await import('../server/channels/egress');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { ChannelBindings } = await import('../server/channels/collections');
      // Two parked sessions with NO assistant rows (the message observer has
      // nothing to fire on — only the sweep can deliver a prompt). One binding
      // was last active two days ago; the other is fresh and is the CONTROL:
      // once its prompt has posted, a sweep has provably run, and the stale
      // binding must still be untouched.
      const park = (id: string, name: string) => AgentSessions.insertAsync({
        ...sessionBase, _id: id, nextSeq: 1, phase: 'awaiting',
        pending: { toolCallId: `tc-${id}`, name, args: {} },
      } as any);
      await park('stale', 'x');
      await park('fresh', 'fresh-tool');
      await AgentMessages.insertAsync(msg({ sessionId: 'stale', seq: 0, role: 'user', content: 'q' }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'fresh', seq: 0, role: 'user', content: 'q' }) as any);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3_600_000);
      await seedBinding('test:stale', { sessionId: 'stale', createdAt: twoDaysAgo, updatedAt: twoDaysAgo });
      await seedBinding('test:fresh', { sessionId: 'fresh' });
      const worker = startEgress('test', { sweepMs: 60 });
      try {
        const posted = (name: string) => transport.posts.some((p) => String(p.payload.text).includes(`Approve ${name}`));
        await until(async () => posted('fresh-tool'));   // a sweep has run
        assert.isFalse(posted('x'), 'a stale binding is outside the sweep lookback');
        // Activity bumps it back into the window; the next sweep delivers.
        await ChannelBindings.updateAsync('test:stale', { $set: { updatedAt: new Date() } });
        await until(async () => posted('x'));
      } finally {
        await worker.stop();
      }
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

    it('posts a segmented render under per-segment keys, segment 0 carrying the bare receipt id', async () => {
      const { transport, def } = await registerTestChannel();
      const base = def.lens.out.bind(def.lens);
      // A surface that splits a reply into two payloads (a segmented SMS).
      def.lens.out = (item: DeliveryItem, destination: unknown) => (item.item === 'reply'
        ? [{ text: `${item.text} [1/2]` }, { text: `${item.text} [2/2]` }]
        : base(item, destination));
      const { deliverOnce } = await import('../server/channels/egress');
      const { ChannelBindings } = await import('../server/channels/collections');
      await seedConversation();
      const binding = (await ChannelBindings.findOneAsync('test:conv'))!;
      assert.equal(await deliverOnce(binding, { item: 'reply', text: 'hello' }, 'seg'), 'delivered');
      // The bare id on segment 0 is what `reconcile` is later asked about; the
      // suffix on the rest keeps a tier-A provider from collapsing them.
      assert.deepEqual(transport.posts.map((p) => p.key), ['deliver:test:conv:seg', 'deliver:test:conv:seg:1']);
      assert.equal(await deliverOnce(binding, { item: 'reply', text: 'hello' }, 'seg'), 'delivered');
      assert.lengthOf(transport.posts, 2, 'a settled receipt posts nothing again');
    });

    it("honors 'reconcile': a read-back that finds the post confirms without re-posting", async () => {
      const { transport } = await registerTestChannel({ onUncertainDelivery: 'reconcile' }, testTransport({ reconcile: async () => true }));
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
      const { DeliveryReceipts } = await import('../server/channels/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await seedConversation();
      await parkAsk('sx', 'tc9');

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

    it("a 'link' profile mints one signed URL per choice at delivery, and redeeming one decides the ask", async () => {
      const { transport } = await registerTestChannel({
        profile: { interact: 'link' }, approvalUrl: (t) => `https://app.test/v/${t}`,
      });
      const { deliverBinding } = await import('../server/channels/egress');
      const { redeemVerdictToken } = await import('../server/channels/linking');
      const { AgentMessages } = await import('../common/collections');
      await seedConversation();
      await parkAsk('sx', 'tc-l');
      await deliverBinding('test', 'test:conv');
      const text = String(transport.posts.find((p) => String(p.payload.text).includes('orders.refund'))!.payload.text);
      const tokens = [...text.matchAll(/\/v\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      assert.lengthOf(tokens, 2, 'one URL per choice');
      assert.isTrue(await redeemVerdictToken(tokens[0]), 'the approve link decides');
      assert.isTrue((await AgentMessages.findOneAsync({ sessionId: 'sx', kind: 'approval' }))!.approved);
      assert.isFalse(await redeemVerdictToken(tokens[1]), 'the deny link is dead once the ask is decided');
    });

    it("a 'link' profile mints its verdict tokens only when the prompt actually posts — a re-sweep mints none", async () => {
      const { transport } = await registerTestChannel({
        profile: { interact: 'link' }, approvalUrl: (t) => `https://app.test/v/${t}`,
      });
      const { deliverBinding } = await import('../server/channels/egress');
      const { ChannelVerdictTokens } = await import('../server/channels/collections');
      await seedConversation();
      await parkAsk('sx', 'tc-l2');
      await deliverBinding('test', 'test:conv');
      await deliverBinding('test', 'test:conv');
      await deliverBinding('test', 'test:conv');
      assert.equal(await ChannelVerdictTokens.find().countAsync(), 2, 'two choices, two tokens — once, not per sweep');
      assert.lengthOf(transport.posts.filter((p) => String(p.payload.text).includes('orders.refund')), 1, 'one ask, one delivery');
    });

    it('drops a stale YES whose ask has moved on — it becomes an ordinary message', async () => {
      await registerTestChannel();
      const { deliverBinding } = await import('../server/channels/egress');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { handleInbound } = await import('../server/channels/ingress');
      await seedConversation();
      await parkAsk('sx', 'tc-old');
      await deliverBinding('test', 'test:conv');   // registers tc-old's grammar

      // The old ask resolves and a DIFFERENT one parks; the old receipt stands.
      await parkAsk('sx', 'tc-new', 'orders.cancel');
      await handleInbound('test', raw({ type: 'msg', text: 'YES', id: 'ev2', user: 'u1', convo: 'conv' }));
      const session = (await AgentSessions.findOneAsync('sx'))!;
      assert.isUndefined(session.pending?.verdict, "the stale grammar decided nothing");
      const users = await AgentMessages.find({ sessionId: 'sx', role: 'user' }).fetchAsync();
      assert.include(users.map((u) => u.content), 'YES', 'the text became a message instead');
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

    it('an unlinked sender can never act as the conversation\'s linked owner', async () => {
      await registerTestChannel();
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'owner-ext', 'owner-acct', 'oidc');
      const { handleInbound } = await import('../server/channels/ingress');
      // The owner opens the conversation on a GROUP surface (others can see it).
      await handleInbound('test', raw({ type: 'msg', text: 'mine', id: 'o1', user: 'owner-ext', convo: 'shared', group: true }));
      const { ChannelBindings } = await import('../server/channels/collections');
      const { AgentMessages } = await import('../common/collections');
      const binding = (await ChannelBindings.findOneAsync('test:shared'))!;
      assert.equal(binding.userId, 'owner-acct');
      assert.equal(binding.audience, 'group');
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();

      // A bystander in the same thread — unlinked — tries to drive it.
      const out = await handleInbound('test', raw({ type: 'msg', text: 'refund everything', id: 'b1', user: 'bystander', convo: 'shared', group: true }));
      assert.equal(out.status, 200, 'settled, not retried');
      const after = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();
      assert.equal(after, before, 'the bystander\'s message never entered the owner\'s session');
    });

    it('refuses to re-point a linked identity at a different account — and never relabels a weak proof as oidc', async () => {
      await registerTestChannel();
      const {
        linkIdentity, issueLinkToken, redeemLinkToken, resolveIdentity,
      } = await import('../server/channels/linking');
      await linkIdentity('test', 'ext-x', 'account-1', 'oidc');
      let refused = false;
      try {
        await linkIdentity('test', 'ext-x', 'account-2', 'link');
      } catch (e: any) {
        refused = e?.error === 'already-linked';
      }
      assert.isTrue(refused, 'cross-account relink is refused');
      const still = (await resolveIdentity('test', 'ext-x'))!;
      assert.equal(still.userId, 'account-1');
      assert.equal(still.assurance, 'oidc');
      // Through the token path the refusal is the same indistinguishable null.
      const token = await issueLinkToken('test', 'ext-x');
      assert.isNull(await redeemLinkToken(token, 'account-2'));
      assert.equal((await resolveIdentity('test', 'ext-x'))!.userId, 'account-1', 'unchanged');
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

  // ---- Membership admission (participants spec decision 11) ----------------

  describe('membership admission', () => {
    /** An OWNED conversation: link the owner, open it, return its binding. */
    const openOwned = async (opts: { convo?: string; owner?: string } = {}) => {
      const convo = opts.convo ?? 'mconv';
      const owner = opts.owner ?? 'owner-acct';
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'owner-ext', owner, 'oidc');
      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'mine', id: `open-${convo}`, user: 'owner-ext', convo }));
      const { ChannelBindings } = await import('../server/channels/collections');
      return (await ChannelBindings.findOneAsync(`test:${convo}`))!;
    };

    it("the default 'opener' binding refuses even a roster member — the binding gates ingress", async () => {
      await registerTestChannel();
      const binding = await openOwned();
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'member-ext', 'member-acct', 'link');
      const { Agent } = await import('../server/agent');
      await Agent.participants.add(binding.sessionId, {
        id: 'h:member-acct', kind: 'human', role: 'member', userId: 'member-acct', displayName: 'Dana',
      });

      const { handleInbound } = await import('../server/channels/ingress');
      const { AgentMessages } = await import('../common/collections');
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();
      const out = await handleInbound('test', raw({ type: 'msg', text: 'me too', id: 'm1', user: 'member-ext', convo: 'mconv' }));
      assert.equal(out.status, 200);
      const after = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();
      assert.equal(after, before, "an 'opener' binding admits nobody but the owner — the roster gates DDP, not this surface");
    });

    it("a 'members' binding admits an account member, attributed", async () => {
      await registerTestChannel({ admits: 'members' });
      const binding = await openOwned({ convo: 'mconv2' });
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'member-ext', 'member-acct', 'link');
      const { Agent } = await import('../server/agent');
      await Agent.participants.add(binding.sessionId, {
        id: 'h:member-acct', kind: 'human', role: 'member', userId: 'member-acct', displayName: 'Dana',
      });

      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'from dana', id: 'm2', user: 'member-ext', convo: 'mconv2' }));
      const { AgentMessages } = await import('../common/collections');
      const row = await AgentMessages.findOneAsync({ sessionId: binding.sessionId, role: 'user', content: 'from dana' });
      assert.isDefined(row, "the member's message entered the owner's session");
      assert.deepEqual(row!.from, { participant: 'h:member-acct', name: 'Dana' });
    });

    it("a 'members' binding admits a channel-identified member through via — senderVerified false included", async () => {
      await registerTestChannel({ admits: 'members' });
      const binding = await openOwned({ convo: 'mconv3' });
      const { Agent } = await import('../server/agent');
      await Agent.participants.add(binding.sessionId, {
        id: 'x:test:dana-ext', kind: 'human', role: 'member', userId: null,
        identity: { kind: 'test', externalUserId: 'dana-ext' },
        assurance: 'none', displayName: 'dana-ext',
      });

      const { handleInbound } = await import('../server/channels/ingress');
      // The forgeable-sender shape (email): unverified, unlinked — standing
      // comes from the roster row alone, through the trusted via principal.
      await handleInbound('test', raw({
        type: 'msg', text: 'the reply', id: 'm3', user: 'dana-ext', convo: 'mconv3', senderVerified: false,
      }));
      const { AgentMessages } = await import('../common/collections');
      const row = await AgentMessages.findOneAsync({ sessionId: binding.sessionId, role: 'user', content: 'the reply' });
      assert.isDefined(row, 'the identity member was admitted');
      assert.deepEqual(row!.from, { participant: 'x:test:dana-ext', name: 'dana-ext' });

      // A NON-member stranger on the same binding still settles.
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();
      await handleInbound('test', raw({ type: 'msg', text: 'let me in', id: 'm4', user: 'mallory-ext', convo: 'mconv3' }));
      assert.equal(
        await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync(),
        before, 'a stranger is settled silently',
      );
    });

    it("a 'linked' binding auto-joins a LINKED sender as a member; unlinked still settles", async () => {
      await registerTestChannel({ admits: 'linked' });
      const binding = await openOwned({ convo: 'mconv4' });
      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'colleague-ext', 'colleague-acct', 'oidc');

      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({ type: 'msg', text: 'joining in', id: 'm5', user: 'colleague-ext', convo: 'mconv4', group: true }));
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const session = (await AgentSessions.findOneAsync(binding.sessionId))!;
      const joined = session.participants?.find((p) => p.userId === 'colleague-acct');
      assert.isDefined(joined, 'the linked sender auto-joined the roster');
      assert.equal(joined!.role, 'member');
      assert.equal(joined!.assurance, 'oidc');
      assert.lengthOf(session.participants!.filter((p) => p.role === 'owner'), 1, 'the seed rode the join');
      const row = await AgentMessages.findOneAsync({ sessionId: binding.sessionId, role: 'user', content: 'joining in' });
      assert.isDefined(row, 'and their message landed');

      // An UNLINKED stranger has no path in: 'linked' admits proofs, not claims.
      const before = await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync();
      await handleInbound('test', raw({ type: 'msg', text: 'anon here', id: 'm6', user: 'rando-ext', convo: 'mconv4', group: true }));
      assert.equal(
        await AgentMessages.find({ sessionId: binding.sessionId, role: 'user' }).countAsync(),
        before,
      );
    });

    it('a member binding receives replies only — no prompts, no statuses, no capability URL', async () => {
      const { transport } = await registerTestChannel({
        statuses: ['error'],
        profile: { interact: 'menu', limit: 40 },
        sessionUrl: () => 'https://app.test/s/anon',
      });
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      // An ANONYMOUS session — the case where the URL is the credential.
      await AgentSessions.insertAsync({ ...sessionBase, _id: 'sm1' } as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sm1', seq: 1, content: 'x'.repeat(100) }) as any);
      await AgentMessages.insertAsync(msg({ sessionId: 'sm1', seq: 2, role: 'note', kind: 'error', reason: 'provider-failed' }) as any);
      await parkAsk('sm1', 'tc-m');
      await seedBinding('test:member-conv', {
        sessionId: 'sm1', member: true, participant: 'x:test:dana-ext', audience: 'direct',
      });

      const { deliverBinding } = await import('../server/channels/egress');
      await deliverBinding('test', 'test:member-conv');

      assert.lengthOf(transport.posts, 1, 'exactly the overflow reply — no status, no prompt');
      const text = transport.posts[0].payload.text as string;
      assert.include(text, '…', 'the over-limit reply overflowed');
      assert.notInclude(text, 'https://app.test', 'no capability URL to a member binding');
      assert.notInclude(JSON.stringify(transport.posts), 'Approve', 'the parked ask never reached the member');

      // The same session through a NORMAL binding still gets the prompt.
      await seedBinding('test:owner-conv', { sessionId: 'sm1', audience: 'direct' });
      await deliverBinding('test', 'test:owner-conv');
      assert.include(JSON.stringify(transport.posts), 'Approve', 'the owner surface still asks');
    });

    it('deliberation rows — assistant replies addressed to a model — are advanced past', async () => {
      const { planItems } = await import('../server/channels/plan');
      const rows = [
        msg({ sessionId: 's', seq: 1, content: '@analyst your call', to: 'm:analyst' }),
        msg({ sessionId: 's', seq: 2, content: 'the outward answer' }),
      ];
      const planned = planItems(rows, { profile: { interact: 'menu' } });
      assert.deepEqual(
        planned.map((p) => p.item?.item ?? null),
        [null, 'reply'],
        'colleague-addressed speech never reaches a channel; the human-facing reply does',
      );
    });

    it('linking reconciles roster rows and never claims a member binding', async () => {
      await registerTestChannel();
      const { AgentSessions } = await import('../common/collections');
      const now = new Date();
      // An anonymous COMPOSING session whose roster holds the recipient.
      await AgentSessions.insertAsync({
        ...sessionBase,
        _id: 'sl1',
        participants: [
          { id: 'h:anon', kind: 'human', role: 'owner', userId: null, displayName: 'owner', joinedAt: now },
          { id: 'm:channel-agent', kind: 'model', role: 'member', agent: 'channel-agent', displayName: 'channel-agent', joinedAt: now },
          {
            id: 'x:test:dana-ext', kind: 'human', role: 'member', userId: null,
            identity: { kind: 'test', externalUserId: 'dana-ext' },
            assurance: 'none', displayName: 'dana-ext', joinedAt: now,
          },
        ],
      } as any);
      // The compose-shaped member binding: the RECIPIENT is its recorded
      // opener, the owner is pinned, member is stamped.
      await seedBinding('test:reply-key', {
        sessionId: 'sl1', member: true, participant: 'x:test:dana-ext',
        externalUserId: 'dana-ext', userId: null, admits: 'members',
      });

      const { linkIdentity } = await import('../server/channels/linking');
      await linkIdentity('test', 'dana-ext', 'dana-acct', 'link');

      const session = (await AgentSessions.findOneAsync('sl1'))!;
      assert.equal(session.userId, null, 'the composing session was NOT re-owned to the recipient');
      const member = session.participants!.find((p) => p.id === 'x:test:dana-ext')!;
      assert.equal(member.userId, 'dana-acct', 'the roster row learned the account');
      assert.equal(member.assurance, 'link');

      const { ChannelBindings } = await import('../server/channels/collections');
      const binding = (await ChannelBindings.findOneAsync('test:reply-key'))!;
      assert.equal(binding.userId, null, 'the member binding was never claimed');
    });

    it("an ANONYMOUS session's member binding attributes the sender's own row, never the owner's", async () => {
      await registerTestChannel();
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const now = new Date();
      // The compose-'continue'-from-an-anonymous-session shape: null owner,
      // the recipient on the roster, a member binding whose OPENER is the
      // recipient. The anonymous-opener branch admits them — and must hand
      // the roster its via principal, or their speech stamps as the owner's.
      await AgentSessions.insertAsync({
        ...sessionBase,
        _id: 'san1',
        participants: [
          { id: 'h:anon', kind: 'human', role: 'owner', userId: null, displayName: 'owner', joinedAt: now },
          { id: 'm:channel-agent', kind: 'model', role: 'member', agent: 'channel-agent', displayName: 'channel-agent', joinedAt: now },
          {
            id: 'x:test:dana-ext', kind: 'human', role: 'member', userId: null,
            identity: { kind: 'test', externalUserId: 'dana-ext' },
            assurance: 'none', displayName: 'dana-ext', joinedAt: now,
          },
        ],
      } as any);
      await seedBinding('test:anon-reply-key', {
        sessionId: 'san1', member: true, admits: 'members',
        externalUserId: 'dana-ext', userId: null, audience: 'direct',
      });

      const { handleInbound } = await import('../server/channels/ingress');
      await handleInbound('test', raw({
        type: 'msg', text: 'my reply', id: 'an1', user: 'dana-ext', convo: 'anon-reply-key', senderVerified: false,
      }));
      const row = await AgentMessages.findOneAsync({ sessionId: 'san1', role: 'user', content: 'my reply' });
      assert.isDefined(row, 'the recipient-opener was admitted');
      assert.deepEqual(
        row!.from, { participant: 'x:test:dana-ext', name: 'dana-ext' },
        "the reply is the RECIPIENT's speech — not silently attributed to the anonymous owner",
      );
    });

    it('removing a participant tears down their member bindings', async () => {
      await registerTestChannel();
      const { AgentSessions } = await import('../common/collections');
      const now = new Date();
      await AgentSessions.insertAsync({
        ...sessionBase,
        _id: 'sr1',
        userId: 'owner-1',
        participants: [
          { id: 'h:owner-1', kind: 'human', role: 'owner', userId: 'owner-1', displayName: 'owner', joinedAt: now },
          { id: 'm:channel-agent', kind: 'model', role: 'member', agent: 'channel-agent', displayName: 'channel-agent', joinedAt: now },
          {
            id: 'x:test:dana-ext', kind: 'human', role: 'member', userId: null,
            identity: { kind: 'test', externalUserId: 'dana-ext' },
            assurance: 'none', displayName: 'dana-ext', joinedAt: now,
          },
        ],
      } as any);
      await seedBinding('test:dana-thread', {
        sessionId: 'sr1', member: true, participant: 'x:test:dana-ext', userId: 'owner-1',
      });
      await seedBinding('test:owner-thread', { sessionId: 'sr1', userId: 'owner-1' });

      const { Agent } = await import('../server/agent');
      assert.isTrue(await Agent.participants.remove('sr1', 'x:test:dana-ext'));

      const { ChannelBindings } = await import('../server/channels/collections');
      assert.isUndefined(await ChannelBindings.findOneAsync('test:dana-thread'), "the member's binding went with them");
      assert.isDefined(await ChannelBindings.findOneAsync('test:owner-thread'), 'everyone else\'s stayed');
      const session = (await AgentSessions.findOneAsync('sr1'))!;
      assert.isUndefined(session.participants!.find((p) => p.id === 'x:test:dana-ext'));
    });
  });
});
