import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import type { AgentMessage, SessionParticipant } from '../common/types';

/**
 * The participants model (participants spec §4): roster mechanics, membership
 * authorization, mechanical addressing, durable relays, the per-model
 * provider projection — and the byte-identical-1:1 guarantee that everything
 * above is invisible until a roster exists.
 */

const waitFor = async (cond: () => Promise<boolean>, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

const clean = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  for (let i = 0; i < 6; i += 1) {
    const removed = (await AgentSessions.removeAsync({}))
      + (await AgentMessages.removeAsync({}))
      + (await AgentDeltas.removeAsync({}));
    if (removed === 0 && i > 0) return;
    await new Promise((r) => { setTimeout(r, 150); });
  }
};

/** A rostered session, inserted directly — the seeded shape `addParticipant`
 *  materializes, so the mechanics tests exercise exactly what production
 *  writes. */
const seedRostered = async (
  sessionId: string, agent: string, userId: string | null,
  extra: SessionParticipant[] = [],
) => {
  const { AgentSessions } = await import('../common/collections');
  const now = new Date();
  const participants: SessionParticipant[] = [
    {
      id: userId === null ? 'h:anon' : `h:${userId}`,
      kind: 'human', role: 'owner', userId, displayName: 'owner', joinedAt: now,
    },
    { id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt: now },
    ...extra,
  ];
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId, phase: 'idle', model: 'mock',
    nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    participants,
    createdAt: now, updatedAt: now,
  });
  return participants;
};

const human = (userId: string, name?: string): SessionParticipant => ({
  id: `h:${userId}`, kind: 'human', role: 'member', userId,
  displayName: name ?? userId, joinedAt: new Date(),
});
const model = (agent: string): SessionParticipant => ({
  id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt: new Date(),
});

const rejectsWith = async (fn: () => Promise<unknown>, code: string): Promise<any> => {
  try {
    await fn();
  } catch (e: any) {
    assert.equal(e.error ?? e.message, code, `expected ${code}, got ${e.error ?? e.message}`);
    return e;
  }
  return assert.fail(`expected ${code}, but the call resolved`);
};

describe('participants', () => {
  describe('pure helpers', () => {
    it('resolves addressees mechanically: explicit to, leading @, else null', async () => {
      const { resolveAddressee, resolveRelay } = await import('../common/participants');
      const session = {
        agent: 'prime',
        participants: [
          { id: 'h:u1', kind: 'human' as const, role: 'owner' as const, userId: 'u1', displayName: 'o', joinedAt: new Date() },
          model('prime'), model('analyst'),
        ],
      };
      // Explicit `to` wins — by participant id and by bare agent name.
      assert.deepEqual(resolveAddressee('hello', 'm:analyst', session), { id: 'm:analyst', agent: 'analyst' });
      assert.deepEqual(resolveAddressee('hello', 'analyst', session), { id: 'm:analyst', agent: 'analyst' });
      // The leading token, exactly once, only at the head.
      assert.deepEqual(resolveAddressee('@analyst check this', undefined, session), { id: 'm:analyst', agent: 'analyst' });
      // Sentence punctuation after the name still addresses — the class
      // admits '.'/'-' for dotted agent names, so the miss retries trimmed.
      assert.deepEqual(resolveAddressee('@analyst. Can you review?', undefined, session), { id: 'm:analyst', agent: 'analyst' });
      assert.deepEqual(resolveAddressee('@analyst— thoughts?', undefined, session), { id: 'm:analyst', agent: 'analyst' });
      assert.isNull(resolveAddressee('ask @analyst later', undefined, session), 'mid-text mentions are speech');
      assert.isNull(resolveAddressee('@nobody hi', undefined, session), 'an unmatched @name is just text');
      assert.isNull(resolveAddressee('plain text', undefined, session));
      // No roster, no addressing.
      assert.isNull(resolveAddressee('@analyst hi', undefined, { agent: 'prime' }));
      // A relay never targets its own author.
      assert.isNull(resolveRelay('@prime back to you', session, 'prime'));
      assert.deepEqual(resolveRelay('@analyst over to you', session, 'prime'), { id: 'm:analyst', agent: 'analyst' });
    });

    it('names the near miss: a model mentioned but not addressed', async () => {
      const { unroutedMention } = await import('../common/participants');
      const session = {
        agent: 'prime',
        participants: [
          { id: 'h:u1', kind: 'human' as const, role: 'owner' as const, userId: 'u1', displayName: 'o', joinedAt: new Date() },
          model('prime'), model('analyst'),
        ],
      };

      // The shape that keeps happening: a sentence of preamble, then the
      // mention. It reads as addressed and schedules nothing.
      assert.strictEqual(
        unroutedMention('Let me correct course and consult @analyst as the process requires.', session, 'prime'),
        'analyst',
      );
      // Punctuation retry, same as the addressee parse.
      assert.strictEqual(unroutedMention('over to @analyst.', session, 'prime'), 'analyst');

      // It DID address someone: nothing was missed, so nothing to say.
      assert.isNull(unroutedMention('@analyst please look', session, 'prime'));
      // Naming yourself is not a missed relay — a model cannot relay to itself.
      assert.isNull(unroutedMention('I, @prime, will handle it', session, 'prime'));
      // Not a participant, so not a near miss — just text.
      assert.isNull(unroutedMention('ask @nobody about it', session, 'prime'));
      assert.isNull(unroutedMention('no mentions at all', session, 'prime'));
      // No roster, no addressing, so no near miss either.
      assert.isNull(unroutedMention('ask @analyst', { agent: 'prime' }, 'prime'));
    });

    it('prefixes only when attribution disambiguates, and the block names colleagues', async () => {
      const { needsAttribution, participantsBlock } = await import('../common/participants');
      const owner = { id: 'h:u1', kind: 'human' as const, role: 'owner' as const, userId: 'u1', displayName: 'Mackenzie', joinedAt: new Date() };
      assert.isFalse(needsAttribution([owner, model('prime')]), '1 human + 1 model = the classic pair');
      assert.isTrue(needsAttribution([owner, human('u2'), model('prime')]));
      assert.isTrue(needsAttribution([owner, model('prime'), model('analyst')]));

      const block = participantsBlock(
        { agent: 'prime', participants: [owner, model('prime'), model('analyst')] }, 'prime',
      );
      assert.include(block, 'You are "prime"');
      assert.include(block, 'Mackenzie (human, owner)');
      assert.include(block, '@analyst');
      assert.notInclude(block, '- prime (model)', 'the block never lists the model it addresses');
      assert.equal(participantsBlock({ agent: 'prime' }, 'prime'), '', 'rosterless = no block');
    });
  });

  describe('roster mechanics', () => {
    it('seeds on first join, adopts duplicates, and enforces the cap', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { addParticipant, removeParticipant } = await import('../server/participants');
      await clean();

      await AgentSessions.insertAsync({
        _id: 'pr1', agent: 'pp-r', userId: 'u1', phase: 'idle', model: 'mock',
        nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });

      const id = await addParticipant('pr1', {
        id: 'h:u2', kind: 'human', role: 'member', userId: 'u2', displayName: 'Dana',
      }, { by: 'h:u1' });
      assert.equal(id, 'h:u2');

      const after = await AgentSessions.findOneAsync('pr1');
      const roster = after!.participants!;
      // Seeded COMPLETE: owner + primary + the joiner, exactly once each.
      assert.deepEqual(
        roster.map((p) => p.id).sort(),
        ['h:u1', 'h:u2', 'm:pp-r'],
        'materialization seeds the owner and primary alongside the join',
      );
      assert.equal(roster.find((p) => p.id === 'h:u1')!.role, 'owner');
      assert.equal(roster.find((p) => p.id === 'h:u2')!.addedBy, 'h:u1');

      // A duplicate join ADOPTS — one row, not two (compose's crash re-run).
      assert.equal(await addParticipant('pr1', {
        id: 'h:u2', kind: 'human', role: 'member', userId: 'u2', displayName: 'Dana',
      }), 'h:u2');
      const again = await AgentSessions.findOneAsync('pr1');
      assert.lengthOf(again!.participants!.filter((p) => p.id === 'h:u2'), 1);

      // Two RACING different-id joins both land, and the seed happens once.
      const [a, b] = await Promise.all([
        addParticipant('pr1', { id: 'h:u3', kind: 'human', role: 'member', userId: 'u3' }),
        addParticipant('pr1', { id: 'h:u4', kind: 'human', role: 'member', userId: 'u4' }),
      ]);
      assert.equal(a, 'h:u3');
      assert.equal(b, 'h:u4');
      const raced = await AgentSessions.findOneAsync('pr1');
      assert.lengthOf(raced!.participants!.filter((p) => p.role === 'owner'), 1, 'one owner row, however many raced');

      // The cap: fill to 16, then refuse.
      for (let i = 5; await addParticipant('pr1', { id: `h:x${i}`, kind: 'human', role: 'member', userId: `x${i}` }) !== null; i += 1) { /* fill */ }
      const full = await AgentSessions.findOneAsync('pr1');
      assert.lengthOf(full!.participants!, 16);
      assert.isNull(await addParticipant('pr1', { id: 'h:overflow', kind: 'human', role: 'member', userId: 'of' }));

      // Removal: a member goes; the owner never does.
      assert.isTrue(await removeParticipant('pr1', 'h:u2'));
      const removed = await AgentSessions.findOneAsync('pr1');
      assert.isUndefined(removed!.participants!.find((p) => p.id === 'h:u2'));
      try {
        await removeParticipant('pr1', 'h:u1');
        assert.fail('removing the owner must throw');
      } catch (e: any) {
        assert.include(String(e.message), 'owner');
      }
    });
  });

  describe('membership authorization', () => {
    it('admits account members and the via principal; null stays the owner\'s alone', async function () {
      this.timeout(30000);
      const { requireSession } = await import('../server/methods');
      await clean();
      await seedRostered('pm1', 'pp-auth', 'u1', [
        human('u2', 'Dana'),
        {
          id: 'x:email:dana@x.co', kind: 'human', role: 'member', userId: null,
          identity: { kind: 'email', externalUserId: 'dana@x.co' },
          assurance: 'none', displayName: 'dana@x.co', joinedAt: new Date(),
        },
      ]);

      // Owner and member both pass; a stranger and a null caller both fail
      // with the indistinguishable no-session.
      assert.equal((await requireSession('pp-auth', 'pm1', 'u1'))._id, 'pm1');
      assert.equal((await requireSession('pp-auth', 'pm1', 'u2'))._id, 'pm1');
      await rejectsWith(() => requireSession('pp-auth', 'pm1', 'u3'), 'no-session');
      await rejectsWith(() => requireSession('pp-auth', 'pm1', null), 'no-session');

      // The trusted via principal matches its roster row — and only its row.
      assert.equal(
        (await requireSession('pp-auth', 'pm1', null, { kind: 'email', externalUserId: 'dana@x.co' }))._id,
        'pm1',
      );
      await rejectsWith(
        () => requireSession('pp-auth', 'pm1', null, { kind: 'email', externalUserId: 'mallory@x.co' }),
        'no-session',
      );
      await rejectsWith(
        () => requireSession('pp-auth', 'pm1', null, { kind: 'sms', externalUserId: 'dana@x.co' }),
        'no-session',
      );
    });

    it('stamps from off the authenticated sender, never the text', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentMessages } = await import('../common/collections');
      await clean();

      // eslint-disable-next-line no-new
      new Agent('pp-auth2', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: 'ok' })),
      });
      await seedRostered('pm2', 'pp-auth2', 'u1', [
        human('u2', 'Dana'),
        {
          id: 'x:email:dana@x.co', kind: 'human', role: 'member', userId: null,
          identity: { kind: 'email', externalUserId: 'dana@x.co' },
          assurance: 'none', displayName: 'dana@x.co', joinedAt: new Date(),
        },
      ]);

      await sendToSession('pp-auth2', 'pm2', 'hello from dana the member', 'u2');
      await sendToSession('pp-auth2', 'pm2', 'hello from the mailbox', null, {
        via: { kind: 'email', externalUserId: 'dana@x.co' },
      });

      const rows = await AgentMessages.find({ sessionId: 'pm2', role: 'user' }, { sort: { seq: 1 } }).fetchAsync();
      assert.equal(rows[0].from?.participant, 'h:u2');
      assert.equal(rows[0].from?.name, 'Dana');
      assert.equal(rows[1].from?.participant, 'x:email:dana@x.co');
      assert.equal(rows[1].from?.name, 'dana@x.co');
    });
  });

  describe('the 1:1 session is byte-identical', () => {
    it('stamps nothing and projects exactly as before', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { toProviderMessages } = await import('../server/transcript');
      await clean();

      // eslint-disable-next-line no-new
      new Agent('pp-solo', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: '@nobody I echo mentions' })),
      });
      await AgentSessions.insertAsync({
        _id: 'ps1', agent: 'pp-solo', userId: 'u1', phase: 'idle', model: 'mock',
        nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });
      await sendToSession('pp-solo', 'ps1', '@somebody hi', 'u1');
      await waitFor(async () => !!(await AgentMessages.findOneAsync({ sessionId: 'ps1', role: 'assistant' })), 'the solo reply');

      const msgs = await AgentMessages.find({ sessionId: 'ps1' }, { sort: { seq: 1 } }).fetchAsync();
      for (const m of msgs) {
        assert.isUndefined(m.from, `no from on a rosterless ${m.role} row`);
        assert.isUndefined(m.to, `no to on a rosterless ${m.role} row`);
      }
      const session = await AgentSessions.findOneAsync('ps1');
      assert.isUndefined(session!.relay);
      assert.isUndefined(session!.pendingRelay);

      // The no-view projection carries no prefixes and no drops.
      const projected = toProviderMessages(msgs);
      assert.deepEqual(
        projected.map((p) => [p.role, p.content]),
        [['user', '@somebody hi'], ['assistant', '@nobody I echo mentions']],
      );
    });
  });

  describe('addressing', () => {
    it('routes @agent to that model\'s config, with the participants block in its prompt', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentMessages } = await import('../common/collections');
      await clean();

      let primaryCalls = 0;
      let analystSystem = '';
      // eslint-disable-next-line no-new
      new Agent('pp-prime', {
        model: 'mock', instructions: 'prime instructions', tools: [],
        provider: mockProvider(() => { primaryCalls += 1; return { text: 'prime here' }; }),
      });
      const analystProvider: Provider = {
        async *stream(req) {
          analystSystem = req.system;
          for (const ch of 'analyst here') yield { kind: 'text', chunk: ch };
          yield { kind: 'done', usage: { input: 1, output: 2 } };
        },
      };
      // eslint-disable-next-line no-new
      new Agent('pp-analyst', {
        model: 'mock', instructions: 'analyst instructions', tools: [],
        provider: analystProvider,
      });

      await seedRostered('pa1', 'pp-prime', 'u1', [model('pp-analyst')]);
      await sendToSession('pp-prime', 'pa1', '@pp-analyst what do you think?', 'u1');
      await waitFor(async () => !!(await AgentMessages.findOneAsync({ sessionId: 'pa1', role: 'assistant' })), 'the analyst reply');

      const reply = await AgentMessages.findOneAsync({ sessionId: 'pa1', role: 'assistant' });
      assert.equal(reply!.content, 'analyst here', 'the ADDRESSEE answered');
      assert.deepEqual(reply!.from, { participant: 'm:pp-analyst', name: 'pp-analyst' });
      assert.equal(primaryCalls, 0, 'the primary never streamed');

      const userRow = await AgentMessages.findOneAsync({ sessionId: 'pa1', role: 'user' });
      assert.equal(userRow!.to, 'm:pp-analyst', 'the send stamped its addressee');

      assert.include(analystSystem, 'analyst instructions', 'the addressee runs its own config');
      assert.include(analystSystem, 'You are "pp-analyst"', 'the participants block rides the prompt');
      assert.include(analystSystem, 'owner (human, owner)');
    });

    it('an addressed message landing MID-STREAM still reaches its addressee (durable handoff)', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { sendToSession } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await clean();

      // The primary streams SLOWLY, so the interjection lands mid-stream —
      // the ordering whose bare-seq tail check read "answered" the moment
      // the primary's own reply committed (the reviewer-confirmed strand).
      const slow: Provider = {
        async *stream(req) {
          // Which MODEL is this request for? The instructions lead the
          // system prompt (the participants block is appended after), so the
          // prefix is the discriminator — the roster listing mentions both
          // names in both prompts.
          if (req.system.startsWith('you are pp-mid-b')) {
            for (const ch of 'b saw it') yield { kind: 'text', chunk: ch };
            yield { kind: 'done', usage: { input: 1, output: 8 } };
            return;
          }
          for (const ch of 'a slow reply from the primary') {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, 12); });
            yield { kind: 'text', chunk: ch };
          }
          yield { kind: 'done', usage: { input: 1, output: 10 } };
        },
      };
      // eslint-disable-next-line no-new
      new Agent('pp-mid-a', { model: 'mock', instructions: 'you are pp-mid-a', tools: [], provider: slow });
      // eslint-disable-next-line no-new
      new Agent('pp-mid-b', { model: 'mock', instructions: 'you are pp-mid-b', tools: [], provider: slow });

      await seedRostered('pmid1', 'pp-mid-a', 'u1', [model('pp-mid-b')]);
      await sendToSession('pp-mid-a', 'pmid1', 'go', 'u1');
      await waitFor(async () => (await AgentSessions.findOneAsync('pmid1'))?.phase === 'streaming', "A's stream starting");
      // Lands mid-stream: B's own deferred turn drops on the running guard.
      await sendToSession('pp-mid-a', 'pmid1', '@pp-mid-b check this', 'u1');

      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'pmid1', role: 'assistant', content: 'b saw it',
      })), "the addressee answering the mid-stream interjection", 20000);
      const reply = await AgentMessages.findOneAsync({ sessionId: 'pmid1', role: 'assistant', content: 'b saw it' });
      assert.deepEqual(reply!.from, { participant: 'm:pp-mid-b', name: 'pp-mid-b' });
    });

    it('a message QUEUED behind an approval reaches its addressee, not the resuming model', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession, recordVerdict } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await clean();

      let toolRan = false;
      // eslint-disable-next-line no-new
      new Agent('pp-q-prime', {
        model: 'mock', instructions: '',
        tools: [{
          name: 'gated', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { toolRan = true; return { ok: true }; },
        }],
        provider: mockProvider((req) => (req.messages.some((m) => m.role === 'tool')
          ? { text: 'prime finished its batch' }
          : { toolCalls: [{ id: 'q1', name: 'gated', args: {} }] })),
      });
      // eslint-disable-next-line no-new
      new Agent('pp-q-c', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: 'c answered the queued ask' })),
      });

      await seedRostered('pq1', 'pp-q-prime', 'u1', [model('pp-q-c')]);
      await sendToSession('pp-q-prime', 'pq1', 'do the gated thing', 'u1');
      await waitFor(async () => (await AgentSessions.findOneAsync('pq1'))?.phase === 'awaiting', 'the park');

      // Queued while awaiting: C's deferred turn exits on the pending gate.
      await sendToSession('pp-q-prime', 'pq1', '@pp-q-c summarize the contract', 'u1');
      await recordVerdict({ userId: 'u1' }, 'pp-q-prime', 'pq1', 'approved');

      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'pq1', role: 'assistant', content: 'c answered the queued ask',
      })), "the queued addressee's turn", 20000);
      assert.isTrue(toolRan, "the approved call still ran under the resuming model");
      const cReply = await AgentMessages.findOneAsync({
        sessionId: 'pq1', role: 'assistant', content: 'c answered the queued ask',
      });
      assert.deepEqual(cReply!.from, { participant: 'm:pp-q-c', name: 'pp-q-c' },
        'the queued @-message was never answered by the model that happened to be resuming');
    });
  });

  describe('relays', () => {
    it('a model\'s @reply schedules its colleague durably, once', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await clean();

      // eslint-disable-next-line no-new
      new Agent('pp-relay-a', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: '@pp-relay-b please review' })),
      });
      // eslint-disable-next-line no-new
      new Agent('pp-relay-b', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: 'reviewed, all good' })),
      });

      await seedRostered('pl1', 'pp-relay-a', 'u1', [model('pp-relay-b')]);
      await sendToSession('pp-relay-a', 'pl1', 'go', 'u1');

      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'pl1', role: 'assistant', content: 'reviewed, all good',
      })), 'the relayed colleague\'s reply');

      const rows = await AgentMessages.find({ sessionId: 'pl1', role: 'assistant' }, { sort: { seq: 1 } }).fetchAsync();
      assert.lengthOf(rows, 2);
      assert.equal(rows[0].to, 'm:pp-relay-b', 'the relaying row is addressed');
      assert.deepEqual(rows[0].from, { participant: 'm:pp-relay-a', name: 'pp-relay-a' });
      assert.deepEqual(rows[1].from, { participant: 'm:pp-relay-b', name: 'pp-relay-b' });

      const session = await AgentSessions.findOneAsync('pl1');
      assert.isUndefined(session!.pendingRelay, 'the relay wake was consumed');
      assert.equal(session!.relay, 1, 'one hop since the human message');
    });

    it('caps the chain with a note-only budget row, session still answerable', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await clean();

      // A ping-pong pair, capped at ONE hop by the PRIMARY's budget.
      // eslint-disable-next-line no-new
      new Agent('pp-ping', {
        model: 'mock', instructions: '', budget: { relay: 1 }, tools: [],
        provider: mockProvider(() => ({ text: '@pp-pong your move' })),
      });
      // eslint-disable-next-line no-new
      new Agent('pp-pong', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: '@pp-ping right back' })),
      });

      await seedRostered('pl2', 'pp-ping', 'u1', [model('pp-pong')]);
      await sendToSession('pp-ping', 'pl2', 'go', 'u1');

      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'pl2', role: 'note', kind: 'budget',
      })), 'the relay-cap note');
      // Settle: nothing further may schedule.
      await new Promise((r) => { setTimeout(r, 400); });

      const assistants = await AgentMessages.find({ sessionId: 'pl2', role: 'assistant' }).fetchAsync();
      assert.lengthOf(assistants, 2, 'ping spoke, pong spoke, nobody relayed past the cap');
      const note = await AgentMessages.findOneAsync({ sessionId: 'pl2', role: 'note', kind: 'budget' });
      assert.equal(note!.budget, 'relay');

      const session = await AgentSessions.findOneAsync('pl2');
      assert.equal(session!.phase, 'idle', 'note-ONLY: the session is not stopped');
      assert.isUndefined(session!.pendingRelay);

      // A human message resets the count and the conversation continues.
      await sendToSession('pp-ping', 'pl2', 'thanks both', 'u1');
      await waitFor(async () => (await AgentSessions.findOneAsync('pl2'))!.relay === 1
        && (await AgentMessages.find({ sessionId: 'pl2', role: 'assistant' }).countAsync()) >= 4,
      'the chain resumed after the human reset');
    });
  });

  describe('parked addressee turns', () => {
    it('resumes an approved call under the model that parked it', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession, recordVerdict } = await import('../server/methods');
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      await clean();

      // eslint-disable-next-line no-new
      new Agent('pp-gate-prime', {
        model: 'mock', instructions: '', tools: [],
        provider: mockProvider(() => ({ text: 'prime here' })),
      });
      let specialRan = false;
      let bCalls = 0;
      // eslint-disable-next-line no-new
      new Agent('pp-gate-b', {
        model: 'mock',
        instructions: '',
        tools: [{
          name: 'special',
          description: 'only B has this',
          gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { specialRan = true; return { ok: true }; },
        }],
        provider: mockProvider(() => {
          bCalls += 1;
          if (bCalls === 1) return { toolCalls: [{ id: 'sp1', name: 'special', args: {} }] };
          return { text: 'done with special' };
        }),
      });

      await seedRostered('pg1', 'pp-gate-prime', 'u1', [model('pp-gate-b')]);
      await sendToSession('pp-gate-prime', 'pg1', '@pp-gate-b use your tool', 'u1');

      await waitFor(async () => (await AgentSessions.findOneAsync('pg1'))?.phase === 'awaiting', 'the park');
      const parked = await AgentSessions.findOneAsync('pg1');
      assert.equal(parked!.pending?.agent, 'pp-gate-b', 'the park records WHOSE turn it is');
      assert.isFalse(specialRan);

      // Approved through the PRIMARY's name — the DDP surface — and resumed
      // as B: the regression this exists for is the resume resolving the
      // primary's toolset and answering `unknown-tool` for a call a human
      // just approved.
      await recordVerdict({ userId: 'u1' }, 'pp-gate-prime', 'pg1', 'approved');
      await waitFor(async () => specialRan, 'the approved tool running under its own model');
      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'pg1', role: 'assistant', content: 'done with special',
      })), 'B\'s turn completing after the resume');

      const toolRow = await AgentMessages.findOneAsync({ sessionId: 'pg1', role: 'tool' });
      assert.deepEqual(toolRow!.from, { participant: 'm:pp-gate-b', name: 'pp-gate-b' }, 'tool rows carry their model');
      const note = await AgentMessages.findOneAsync({ sessionId: 'pg1', role: 'note', kind: 'approval' });
      assert.equal(note!.byParticipant, 'h:u1', 'group audits name the deciding member');
    });
  });

  describe('approval legibility (participants spec §8)', () => {
    it('a tool\'s describe lands on pending.display at park; a broken one costs only the display', async function () {
      this.timeout(30000);
      const { Agent } = await import('../server/agent');
      const { mockProvider } = await import('../server/providers/mock');
      const { sendToSession } = await import('../server/methods');
      const { AgentSessions } = await import('../common/collections');
      await clean();

      // eslint-disable-next-line no-new
      new Agent('pp-desc', {
        model: 'mock', instructions: '',
        tools: [
          {
            name: 'send_report',
            description: 'x',
            gate: 'ask',
            args: { type: 'object', properties: {} },
            describe: async (args: any) => `Send the Q3 report to ${args.to} (2 files, 18 KB)`,
            run: async () => ({ ok: true }),
          },
          {
            name: 'broken_describe',
            description: 'x',
            gate: 'ask',
            args: { type: 'object', properties: {} },
            describe: async () => { throw new Error('boom'); },
            run: async () => ({ ok: true }),
          },
        ],
        provider: mockProvider((req) => {
          const wantBroken = JSON.stringify(req.messages).includes('use the broken one');
          return {
            toolCalls: [{
              id: wantBroken ? 'd2' : 'd1',
              name: wantBroken ? 'broken_describe' : 'send_report',
              args: { to: 'dana@ourco.com' },
            }],
          };
        }),
      });

      await AgentSessions.insertAsync({
        _id: 'pd1', agent: 'pp-desc', userId: 'u1', phase: 'idle', model: 'mock',
        nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });
      await sendToSession('pp-desc', 'pd1', 'send it', 'u1');
      await waitFor(async () => (await AgentSessions.findOneAsync('pd1'))?.phase === 'awaiting', 'the park');
      const parked = await AgentSessions.findOneAsync('pd1');
      assert.equal(
        parked!.pending?.display,
        'Send the Q3 report to dana@ourco.com (2 files, 18 KB)',
        'the approver reads the tool\'s own account, not raw args',
      );

      // A describe that throws parks anyway, display absent.
      await AgentSessions.insertAsync({
        _id: 'pd2', agent: 'pp-desc', userId: 'u1', phase: 'idle', model: 'mock',
        nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });
      await sendToSession('pp-desc', 'pd2', 'use the broken one', 'u1');
      await waitFor(async () => (await AgentSessions.findOneAsync('pd2'))?.phase === 'awaiting', 'the second park');
      const broken = await AgentSessions.findOneAsync('pd2');
      assert.isUndefined(broken!.pending?.display, 'no display beats no park');
      assert.equal(broken!.pending?.name, 'broken_describe');
    });

    it('promptItem passes the display through to the lenses', async () => {
      const { promptItem } = await import('../server/channels/plan');
      const item = promptItem({
        phase: 'awaiting',
        pending: {
          toolCallId: 'tcd', name: 'send_report', args: { to: 'x' },
          display: 'Email dana@ourco.com — "Q3" — report.csv (18 KB)',
        },
      } as any, { interact: 'menu' });
      assert.equal(item!.display, 'Email dana@ourco.com — "Q3" — report.csv (18 KB)');
    });
  });

  describe('the provider view', () => {
    const now = new Date();
    const row = (partial: Partial<AgentMessage>): AgentMessage => ({
      _id: Math.random().toString(36).slice(2), sessionId: 's', seq: 0,
      role: 'user', createdAt: now, ...partial,
    } as AgentMessage);
    const roster: SessionParticipant[] = [
      { id: 'h:u1', kind: 'human', role: 'owner', userId: 'u1', displayName: 'Mackenzie', joinedAt: now },
      { id: 'x:email:dana@x.co', kind: 'human', role: 'member', identity: { kind: 'email', externalUserId: 'dana@x.co' }, displayName: 'dana@x.co', joinedAt: now },
      { id: 'm:prime', kind: 'model', role: 'member', agent: 'prime', displayName: 'prime', joinedAt: now },
      { id: 'm:analyst', kind: 'model', role: 'member', agent: 'analyst', displayName: 'analyst', joinedAt: now },
    ];
    const msgs = () => [
      row({ seq: 0, role: 'user', content: 'pre-roster question' }),                    // from-less: defaults to owner
      row({ seq: 1, role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'work', args: {} }], from: { participant: 'm:prime', name: 'prime' } }),
      row({ seq: 2, role: 'tool', toolCallId: 't1', content: '"done"', from: { participant: 'm:prime', name: 'prime' } }),
      row({ seq: 3, role: 'assistant', content: 'prime\'s answer', from: { participant: 'm:prime', name: 'prime' } }),
      row({ seq: 4, role: 'user', content: 'dana\'s reply', from: { participant: 'x:email:dana@x.co', name: 'dana@x.co' } }),
      row({ seq: 5, role: 'assistant', content: '@prime your call', from: { participant: 'm:analyst', name: 'analyst' }, to: 'm:prime' }),
    ];

    it('projects a colleague\'s turn as its spoken outcome, and prefixes humans', async () => {
      const { toProviderMessages } = await import('../server/transcript');
      const view = { self: 'm:analyst', primary: 'm:prime', participants: roster };
      const out = toProviderMessages(msgs(), view);
      assert.deepEqual(out.map((p) => [p.role, p.content]), [
        ['user', '[Mackenzie]: pre-roster question'],       // from-less user row → the owner
        // prime's toolCall assistant and tool rows DROP — a colleague's working
        ['user', '[prime]: prime\'s answer'],               // prime's turn-final → attributed input
        ['user', '[dana@x.co]: dana\'s reply'],
        ['assistant', '@prime your call'],                  // analyst's own row keeps its role, unprefixed
      ]);
    });

    it('keeps its own working and drops nothing of itself', async () => {
      const { toProviderMessages } = await import('../server/transcript');
      const view = { self: 'm:prime', primary: 'm:prime', participants: roster };
      const out = toProviderMessages(msgs(), view);
      assert.deepEqual(out.map((p) => [p.role, p.content ?? '']), [
        ['user', '[Mackenzie]: pre-roster question'],
        ['assistant', ''],                                   // own toolCall row survives
        ['tool', '"done"'],
        ['assistant', 'prime\'s answer'],
        ['user', '[dana@x.co]: dana\'s reply'],
        ['user', '[analyst]: @prime your call'],             // the colleague's final, as input
      ]);
      assert.deepEqual(out[1].toolCalls?.map((c) => c.id), ['t1']);
    });

    it('the omniscient view keeps structure and attributes every speaker', async () => {
      const { toProviderMessages } = await import('../server/transcript');
      const view = { primary: 'm:prime', participants: roster };
      const out = toProviderMessages(msgs(), view);
      assert.deepEqual(out.map((p) => [p.role, p.content ?? '']), [
        ['user', '[Mackenzie]: pre-roster question'],
        ['assistant', ''],
        ['tool', '"done"'],
        ['assistant', '[prime]: prime\'s answer'],
        ['user', '[dana@x.co]: dana\'s reply'],
        ['assistant', '[analyst]: @prime your call'],
      ]);
    });

    it('a 2-human 1-model roster prefixes humans but leaves the model\'s own view clean', async () => {
      const { toProviderMessages } = await import('../server/transcript');
      const pair: SessionParticipant[] = [roster[0], roster[1], roster[2]];
      const view = { self: 'm:prime', primary: 'm:prime', participants: pair };
      const out = toProviderMessages([
        row({ seq: 0, role: 'user', content: 'hi', from: { participant: 'h:u1', name: 'Mackenzie' } }),
        row({ seq: 1, role: 'assistant', content: 'hello', from: { participant: 'm:prime', name: 'prime' } }),
      ], view);
      assert.deepEqual(out.map((p) => [p.role, p.content]), [
        ['user', '[Mackenzie]: hi'],
        ['assistant', 'hello'],
      ]);
    });
  });
});
