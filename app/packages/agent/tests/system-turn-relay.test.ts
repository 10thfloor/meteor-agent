import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import type { SystemTurnResult } from '../server/system-turn';
import {
  canned, clean, countRole, finished, model, recorder, seedRostered, seedSolo,
  settle, slowProvider, systemRow, waitFor,
} from './system-turn-helpers';

/**
 * System turns, matrix groups E and F (system-turn spec §10).
 *
 * GROUP E is decision 7 stated as tests: **a machine's prompt does not outrank
 * work in flight.** `sendToSession` writes `relay: 0` and `$unset:
 * { pendingRelay: 1 }` in the same atomic write that allocates a human
 * message's seq; `startSystemTurn` copies neither clause, and that omission IS
 * the decision. Every test here is therefore an assertion about something the
 * park deliberately does NOT write — which is why each one seeds the field
 * first and, where it can, shows the human path moving the same field in the
 * same session (E1, E6). An assertion that a counter did not change proves
 * nothing if nothing ever writes that counter.
 *
 * GROUP F is fork and recovery: the two markers a fork must not inherit, the
 * new row shape travelling through a copy, and the two paths that pick a system
 * turn back up after the process that started it went away.
 *
 * Helpers are IMPORTED (`./system-turn-helpers`), not copied: three suites
 * share one definition of "the turn is over", which is the race
 * `watcher.test.ts` documents at length.
 */

/** Both success shapes, written once so the assertions read as identities
 *  rather than as three loose fields. */
const RAN: SystemTurnResult = { ok: true, ran: true };
const PARKED: SystemTurnResult = { ok: true, ran: false, parked: true };

/**
 * Register an agent under a name this file owns.
 *
 * Registration is load-bearing rather than decorative: every path under test
 * resolves its config through `getAgent` at dispatch time — the park, the
 * consume, `deferResolvedTurn` — so the provider a test asserts on has to be
 * the object the registry hands back, not one a hand-built `RunConfig` carried
 * in. The registry is a Map that overwrites cleanly, so re-registering across
 * tests is safe; the `str-` prefix keeps this file's names off every other
 * suite's.
 */
const register = async (
  name: string, provider: Provider, extra: Record<string, unknown> = {},
): Promise<void> => {
  const { Agent } = await import('../server/agent');
  // eslint-disable-next-line no-new
  new Agent(name, {
    model: 'mock', instructions: '', tools: [], provider, ...extra,
  } as any);
};

/** The assistant rows of a session, in transcript order. */
const assistants = async (sessionId: string) => {
  const { AgentMessages } = await import('../common/collections');
  return AgentMessages
    .find({ sessionId, role: 'assistant' }, { sort: { seq: 1 } }).fetchAsync();
};

describe('system turns — relay, fork and recovery', () => {
  // A standing intent is durable by design, so a test that leaves one behind
  // poisons the next: `startSystemTurn` refuses a second park (decision 9) and
  // the watcher would sweep the survivor into a turn nobody asked for.
  beforeEach(async function beforeEachClean() {
    this.timeout(30000);
    await clean();
  });
  after(async function afterClean() {
    this.timeout(30000);
    await clean();
  });

  describe('E — the relay is not a machine\'s to reset', () => {
    it('E1: a system turn leaves the hop count exactly where it found it', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { startSystemTurn, sendToSession } = await import('../server/methods');

      await register('str-e1', canned('all quiet'));
      await seedRostered('srr-e1', 'str-e1', 'u1', [], { relay: 3 });

      assert.deepEqual(await startSystemTurn('srr-e1', 'nightly check'), RAN);
      await waitFor(() => finished('srr-e1', 1), 'the system turn to finish');

      const doc = (await AgentSessions.findOneAsync('srr-e1'))!;
      assert.equal(
        doc.relay, 3,
        'three hops before, three hops after: a scheduled prompt is not an '
        + 'interjection and has no standing to reset the chain',
      );
      assert.isUndefined(doc.pendingSystem, 'the turn\'s first commit cleared the intent');
      assert.equal(doc.budgetSpent.systemTurns, 1, 'and spent the system purse');
      assert.equal(doc.budgetSpent.turns, 0, 'never the human one');

      // The differential. Without it, `relay === 3` would pass just as happily
      // against a field nothing in this session ever writes — the assertion
      // above only means something once the same field is shown moving.
      await sendToSession('str-e1', 'srr-e1', 'thanks', 'u1');
      assert.equal(
        (await AgentSessions.findOneAsync('srr-e1'))!.relay, 0,
        'a HUMAN send resets it in the same atomic write that takes its seq',
      );
      await waitFor(() => finished('srr-e1', 2), 'the human\'s turn to finish');
    });

    it('E2: a park leaves a standing relay identical — the same token, not merely one', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      await register('str-e2', canned('must not run'));
      await register('str-e2b', canned('must not run either'));
      // `awaiting` is the shape this feature exists for — a session parked on a
      // human's approval — and it is also what makes this test sharp: the
      // consume bails on a DECIDED phase, so the relay's fate is decided by the
      // PARK alone, with no turn in between to muddy which write touched it.
      await seedRostered('srr-e2', 'str-e2', 'u1', [model('str-e2b')], {
        phase: 'awaiting',
        relay: 2,
        pendingRelay: { agent: 'str-e2b', token: 'srr-e2-relay-token' },
      });

      assert.deepEqual(await startSystemTurn('srr-e2', 'nightly check'), PARKED);
      await settle();

      const doc = (await AgentSessions.findOneAsync('srr-e2'))!;
      assert.deepEqual(
        doc.pendingRelay, { agent: 'str-e2b', token: 'srr-e2-relay-token' },
        'IDENTITY, not existence: a re-issued token is a DIFFERENT wake, and '
        + 'the loop\'s wind-down re-check compares tokens, not presence',
      );
      assert.equal(doc.relay, 2, 'and the hop count is untouched too');
      assert.isDefined(doc.pendingSystem, 'the intent stands behind the live work');
      assert.equal(doc.pendingSystem!.prompt, 'nightly check');
      assert.equal(
        await countRole('srr-e2', 'system'), 0,
        'a parked intent has not materialized its row yet',
      );
      assert.equal(await countRole('srr-e2', 'assistant'), 0, 'and nothing ran');
      assert.isUndefined(
        doc.budgetSpent.systemTurns,
        'the budget rides the first commit, so a park that never ran is unbilled',
      );
    });

    it('E3: the relay a system turn ran past is still honoured afterwards', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      await register('str-e3a', canned('the system prompt, answered'));
      await register('str-e3b', canned('and now the relay, answered'));
      await seedRostered('srr-e3', 'str-e3a', 'u1', [model('str-e3b')], {
        relay: 1,
        pendingRelay: { agent: 'str-e3b', token: 'srr-e3-relay-token' },
      });

      assert.deepEqual(await startSystemTurn('srr-e3', 'nightly check'), RAN);
      // TWO turns: the primary answers the system row, and its wind-down then
      // fires the relay it never consumed (the marker names str-e3b, and this
      // turn ran as str-e3a, so `consumingRelay` was false at entry).
      await waitFor(() => finished('srr-e3', 2), 'the system turn AND the relay it stepped over');

      const rows = await assistants('srr-e3');
      assert.lengthOf(rows, 2);
      assert.equal(rows[0].content, 'the system prompt, answered');
      assert.deepEqual(rows[0].from, { participant: 'm:str-e3a', name: 'str-e3a' });
      assert.equal(rows[1].content, 'and now the relay, answered');
      assert.deepEqual(
        rows[1].from, { participant: 'm:str-e3b', name: 'str-e3b' },
        'the colleague the relay named still got its turn',
      );

      const doc = (await AgentSessions.findOneAsync('srr-e3'))!;
      assert.isUndefined(doc.pendingRelay, 'consumed by the addressee\'s own first commit');
      assert.equal(doc.relay, 1, 'consuming a relay does not count a hop; scheduling one does');
      assert.equal(doc.budgetSpent.systemTurns, 1, 'one system turn, not two');
    });

    it('E4: a system-started turn that relays counts from the PRE-system hop count', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      await register('str-e4a', canned('@str-e4b over to you'));
      await register('str-e4b', canned('taken, thanks'));
      await seedRostered('srr-e4', 'str-e4a', 'u1', [model('str-e4b')], { relay: 3 });

      assert.deepEqual(await startSystemTurn('srr-e4', 'nightly check'), RAN);
      await waitFor(() => finished('srr-e4', 2), 'the relayed chain to finish');

      const doc = (await AgentSessions.findOneAsync('srr-e4'))!;
      assert.equal(
        doc.relay, 4,
        '3 -> 4. If the park had reset the count the way a send does, this '
        + 'would read 1 — and the chain would have four fresh hops to spend',
      );
      assert.isUndefined(doc.pendingRelay, 'the colleague consumed its wake');
      assert.equal(doc.budgetSpent.systemTurns, 1);

      const rows = await assistants('srr-e4');
      assert.lengthOf(rows, 2);
      assert.equal(rows[0].to, 'm:str-e4b', 'the relaying row is addressed');
      assert.deepEqual(rows[1].from, { participant: 'm:str-e4b', name: 'str-e4b' });
      assert.equal(await countRole('srr-e4', 'note'), 0, 'the fourth hop is under the cap');
    });

    it('E5: the cap trips from the pre-system count, note-only', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      // No `budget.relay` declared, so the default cap of 4 applies — and the
      // seeded count is already AT it. A system turn that reset the count would
      // find three hops still available and this would never trip.
      await register('str-e5a', canned('@str-e5b your move'));
      await register('str-e5b', canned('must never be reached'));
      await seedRostered('srr-e5', 'str-e5a', 'u1', [model('str-e5b')], { relay: 4 });

      assert.deepEqual(await startSystemTurn('srr-e5', 'nightly check'), RAN);
      // `finished` ends on the TERMINAL state, which the loop writes after the
      // budget note — so waiting on it is what makes the note assertion safe.
      await waitFor(() => finished('srr-e5', 1), 'the capped system turn to finish');
      await settle();

      const note = (await AgentMessages.findOneAsync(
        { sessionId: 'srr-e5', role: 'note', kind: 'budget' } as any,
      ))!;
      assert.isDefined(note, 'a capped relay explains itself in the transcript');
      assert.equal(note.budget, 'relay');

      const rows = await assistants('srr-e5');
      assert.lengthOf(rows, 1, 'the reply committed; nobody was scheduled');
      assert.equal(
        rows[0].to, 'm:str-e5b',
        'the addressee is still stamped, so the transcript shows who was asked',
      );

      const doc = (await AgentSessions.findOneAsync('srr-e5'))!;
      assert.equal(doc.relay, 4, 'a capped relay counts no hop');
      assert.isUndefined(doc.pendingRelay, 'and schedules nothing');
      assert.equal(doc.phase, 'idle', 'note-ONLY: the session is answerable, not wedged');
      assert.equal(doc.budgetSpent.systemTurns, 1);
    });

    it('E6: a human send after a system-started chain still resets the count to 0', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { startSystemTurn, sendToSession } = await import('../server/methods');

      // Relays once — for the system turn — and speaks plainly ever after, so
      // the human's turn cannot re-arm the chain and confuse the reading.
      let primaryCalls = 0;
      await register('str-e6a', mockProvider(() => {
        primaryCalls += 1;
        return primaryCalls === 1
          ? { text: '@str-e6b over to you' }
          : { text: 'plainly, to the room' };
      }));
      await register('str-e6b', canned('taken, thanks'));
      await seedRostered('srr-e6', 'str-e6a', 'u1', [model('str-e6b')], { relay: 3 });

      assert.deepEqual(await startSystemTurn('srr-e6', 'nightly check'), RAN);
      await waitFor(() => finished('srr-e6', 2), 'the system-started chain to finish');
      assert.equal((await AgentSessions.findOneAsync('srr-e6'))!.relay, 4);

      await sendToSession('str-e6a', 'srr-e6', 'thanks both', 'u1');
      assert.equal(
        (await AgentSessions.findOneAsync('srr-e6'))!.relay, 0,
        'decision 7 is an asymmetry, not a suspension: the human rule is intact',
      );

      await waitFor(() => finished('srr-e6', 3), 'the human\'s turn to finish');
      const doc = (await AgentSessions.findOneAsync('srr-e6'))!;
      assert.equal(doc.relay, 0, 'and the reply that followed relayed nothing');
      assert.isUndefined(doc.pendingRelay);
      assert.equal(doc.budgetSpent.turns, 1, 'one human send');
      assert.equal(doc.budgetSpent.systemTurns, 1, 'one system turn');
    });

    it('E7: resolveWakeAgent ranks relay > unanswered addressee > standing intent', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { resolveWakeAgent } = await import('../server/participants');

      // Called DIRECTLY with hand-seeded documents. The ordering is a property
      // of one function over four durable fields; driving four turns to observe
      // it would be slower, and would only ever exercise whichever branch the
      // fixture happened to reach.
      await seedRostered('srr-e7', 'str-e7', 'u1', [
        model('str-e7-relay'), model('str-e7-ask'), model('str-e7-sys'),
      ]);
      const base = (await AgentSessions.findOneAsync('srr-e7'))!;
      const intent = {
        prompt: 'nightly check', agent: 'str-e7-sys', source: 'routine',
        token: 'srr-e7-intent-token', at: new Date(),
      };
      const withIntent = { ...base, pendingSystem: intent };

      // A person's open question, addressed and unanswered.
      await AgentMessages.insertAsync({
        _id: 'srr-e7-u0', sessionId: 'srr-e7', seq: 0, role: 'user',
        content: 'can you look at this?', to: 'm:str-e7-ask',
        from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
      } as any);

      assert.equal(
        await resolveWakeAgent({
          ...withIntent, pendingRelay: { agent: 'str-e7-relay', token: 'srr-e7-relay-token' },
        }),
        'str-e7-relay',
        'a standing relay is work the team is mid-way through; the intent waits',
      );
      assert.equal(
        await resolveWakeAgent(withIntent), 'str-e7-ask',
        'and so does a person\'s unanswered question — decision 7 from the other side',
      );

      // The addressee answers. Nothing older is owed any more.
      await AgentMessages.insertAsync({
        _id: 'srr-e7-a1', sessionId: 'srr-e7', seq: 1, role: 'assistant',
        content: 'looked, all fine',
        from: { participant: 'm:str-e7-ask', name: 'str-e7-ask' }, createdAt: new Date(),
      } as any);

      assert.equal(
        await resolveWakeAgent(withIntent), 'str-e7-sys',
        'only then does the intent name its own target',
      );
      assert.equal(
        await resolveWakeAgent(base), 'str-e7',
        'and with no intent at all, the primary',
      );

      // And on a ROSTERLESS session — the 1:1 shape scheduled work actually
      // uses. This assertion caught a real ordering bug: the
      // `!session.participants?.length` bail used to sit ABOVE the intent
      // clause, so an orphaned system turn on a 1:1 session resumed as the
      // primary and ignored the teammate the intent named. The bail now sits
      // below it, and the unanswered-addressee check is guarded instead of
      // short-circuiting the whole function.
      await seedSolo('srr-e7-solo', 'str-e7');
      const solo = (await AgentSessions.findOneAsync('srr-e7-solo'))!;
      assert.equal(
        await resolveWakeAgent({ ...solo, pendingSystem: intent }), 'str-e7-sys',
        'a rosterless orphan resumes as the agent its intent named, not the primary',
      );
      assert.equal(
        await resolveWakeAgent(solo), 'str-e7',
        'and with no intent, still the primary',
      );
    });

    it('E8: an unanswered colleague-addressed tail outranks a system-started turn', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { startSystemTurn } = await import('../server/methods');

      // §4.8: the turn-final addressee re-resolution stays `role: 'user'`-only
      // ON PURPOSE. The human's addressed question is older and still
      // unanswered, so the turn hands off before it ever calls a provider.
      let primaryCalls = 0;
      await register('str-e8a', mockProvider(() => {
        primaryCalls += 1;
        return { text: 'the primary must never speak here' };
      }));
      await register('str-e8b', canned('reviewed, all good'));
      await seedRostered('srr-e8', 'str-e8a', 'u1', [model('str-e8b')], { nextSeq: 1 });
      await AgentMessages.insertAsync({
        _id: 'srr-e8-u0', sessionId: 'srr-e8', seq: 0, role: 'user',
        content: '@str-e8b review this', to: 'm:str-e8b',
        from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
      } as any);

      assert.deepEqual(await startSystemTurn('srr-e8', 'nightly check'), RAN);
      await waitFor(() => finished('srr-e8', 1), 'the colleague to answer the human');
      await settle();

      assert.equal(
        primaryCalls, 0,
        'the primary was dispatched and handed off at the iteration top, '
        + 'before spending a single provider call',
      );
      const rows = await assistants('srr-e8');
      assert.lengthOf(rows, 1, 'one turn, by the model the human addressed');
      assert.equal(rows[0].content, 'reviewed, all good');
      assert.deepEqual(rows[0].from, { participant: 'm:str-e8b', name: 'str-e8b' });

      const sys = (await systemRow('srr-e8'))!;
      assert.isDefined(sys, 'the system row is materialized either way');
      assert.equal(sys.seq, 1, 'and sits after the question it did not displace');

      const doc = (await AgentSessions.findOneAsync('srr-e8'))!;
      assert.isUndefined(doc.pendingSystem, 'the handoff turn\'s first commit cleared it');
      assert.isUndefined(doc.pendingRelay, 'and consumed the handoff marker itself');
      assert.equal(doc.budgetSpent.systemTurns, 1, 'billed once, to the model that ran it');
    });
  });

  describe('F — fork and recovery', () => {
    it('F1: a fork inherits neither the standing intent nor the idempotency slot', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { forkSession } = await import('../server/fork');
      const { startSystemTurn } = await import('../server/methods');

      await register('str-f1', canned('the fork, answering'));
      await seedRostered('srr-f1', 'str-f1', 'u1', [], {
        nextSeq: 2,
        relay: 2,
        pendingRelay: { agent: 'str-f1', token: 'srr-f1-relay-token' },
        pendingSystem: {
          prompt: 'nightly check', agent: 'str-f1', source: 'routine',
          key: 'srr-f1-slot', token: 'srr-f1-intent-token', at: new Date(),
        },
        lastSystemKey: 'srr-f1-slot',
      });
      await AgentMessages.insertAsync({
        _id: 'srr-f1-m0', sessionId: 'srr-f1', seq: 0, role: 'user',
        content: 'kick off', createdAt: new Date(),
      } as any);
      await AgentMessages.insertAsync({
        _id: 'srr-f1-m1', sessionId: 'srr-f1', seq: 1, role: 'assistant',
        content: 'started', createdAt: new Date(),
      } as any);

      const forkId = await forkSession((await AgentSessions.findOneAsync('srr-f1'))!);
      const fork = (await AgentSessions.findOneAsync(forkId))!;
      assert.isUndefined(fork.pendingSystem, 'a fork is idle; a live wake belongs to the source');
      assert.isUndefined(fork.lastSystemKey, 'and its schedule slot is the source\'s history');
      assert.isUndefined(fork.pendingRelay, 'the same rule the relay already followed');
      assert.isUndefined(fork.relay);
      assert.deepEqual(fork.budgetSpent, { turns: 0, toolCalls: 0 });

      const src = (await AgentSessions.findOneAsync('srr-f1'))!;
      assert.isDefined(src.pendingSystem, 'a fork COPIES; it does not move the source\'s markers');
      assert.equal(src.lastSystemKey, 'srr-f1-slot');

      // The consequence §9 names: a fork is a different conversation, so it is
      // free to run a slot the source already claimed. `isUndefined` above says
      // the field is absent; this says the absence actually means something.
      assert.deepEqual(
        await startSystemTurn(forkId, 'nightly check', { key: 'srr-f1-slot' }), RAN,
        'the source\'s claimed key does not refuse the fork',
      );
      // TWO assistant rows: the one the fork copied, plus the one its own
      // system turn just wrote. Waiting on one would be true before the turn
      // had started.
      await waitFor(() => finished(forkId, 2), 'the fork\'s own system turn');
      assert.equal((await AgentSessions.findOneAsync(forkId))!.lastSystemKey, 'srr-f1-slot');
    });

    it('F3: system rows copy into a fork verbatim — original seqs, fresh ids, `from` riding along', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { forkSession } = await import('../server/fork');
      const { systemFrom } = await import('../common/participants');

      await seedSolo('srr-f3', 'str-f3', { nextSeq: 3 });
      await AgentMessages.insertAsync({
        _id: 'srr-f3-m0', sessionId: 'srr-f3', seq: 0, role: 'user',
        content: 'kick off', createdAt: new Date(),
      } as any);
      // Stamped through the real producer, not a hand-written literal: if
      // `systemFrom`'s shape ever changes, this fixture changes with it.
      await AgentMessages.insertAsync({
        _id: 'srr-f3-m1', sessionId: 'srr-f3', seq: 1, role: 'system',
        content: 'nightly review', from: systemFrom('routine'), createdAt: new Date(),
      } as any);
      await AgentMessages.insertAsync({
        _id: 'srr-f3-m2', sessionId: 'srr-f3', seq: 2, role: 'assistant',
        content: 'reviewed', createdAt: new Date(),
      } as any);

      const forkId = await forkSession((await AgentSessions.findOneAsync('srr-f3'))!);
      const copied = await AgentMessages
        .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();

      assert.lengthOf(copied, 3);
      assert.deepEqual(copied.map((m) => m.seq), [0, 1, 2], 'seqs are preserved verbatim');
      assert.deepEqual(copied.map((m) => m.role), ['user', 'system', 'assistant'],
        'a system row is ordinary transcript: it copies like a user row, not like a note');

      const sys = copied[1];
      assert.equal(sys.content, 'nightly review');
      assert.deepEqual(
        sys.from, { participant: 's:routine', name: 'routine' },
        'attribution rides along, so the copy still says a machine spoke and which one',
      );
      assert.notEqual(sys._id, 'srr-f3-m1', 'a NEW identity in the same collection');
      assert.equal(sys.sessionId, forkId);

      const fork = (await AgentSessions.findOneAsync(forkId))!;
      assert.equal(fork.nextSeq, 3, 'allocation continues the source\'s numbering');
      assert.deepEqual(fork.forkedFrom, { sessionId: 'srr-f3', seq: 2 });
      // The source keeps its own row: this is a copy, not a move.
      assert.equal(await countRole('srr-f3', 'system'), 1);
    });

    it('F4: a system row is a legal fork cut point', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { forkSession } = await import('../server/fork');
      const { systemFrom } = await import('../common/participants');

      await seedSolo('srr-f4', 'str-f4', { nextSeq: 4 });
      for (const row of [
        { seq: 0, role: 'user', content: 'q1' },
        { seq: 1, role: 'assistant', content: 'a1' },
        { seq: 2, role: 'system', content: 'nightly review', from: systemFrom('routine') },
        { seq: 3, role: 'assistant', content: 'a2' },
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await AgentMessages.insertAsync({
          _id: `srr-f4-m${row.seq}`, sessionId: 'srr-f4', createdAt: new Date(), ...row,
        } as any);
      }

      const forkId = await forkSession(
        (await AgentSessions.findOneAsync('srr-f4'))!, { atSeq: 2 },
      );
      const copied = await AgentMessages
        .find({ sessionId: forkId }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(copied.map((m) => m.seq), [0, 1, 2],
        'the boundary walk did not have to move: a system row strands no tool call');
      assert.equal(copied[2].role, 'system', 'the fork ends ON the system row');
      const fork = (await AgentSessions.findOneAsync(forkId))!;
      assert.equal(fork.nextSeq, 3);
      assert.deepEqual(fork.forkedFrom, { sessionId: 'srr-f4', seq: 2 });

      // And a system row sitting AFTER a completed tool batch is still a legal
      // cut — the batch-safety walk inspects assistant and tool rows only, so
      // the new role slides through it untouched.
      await seedSolo('srr-f4b', 'str-f4', { nextSeq: 4 });
      for (const row of [
        { seq: 0, role: 'user', content: 'q1' },
        { seq: 1, role: 'assistant', toolCalls: [{ id: 't1', name: 'noop', args: {} }] },
        { seq: 2, role: 'tool', toolCallId: 't1', content: '{"ok":true}' },
        { seq: 3, role: 'system', content: 'nightly review', from: systemFrom('routine') },
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await AgentMessages.insertAsync({
          _id: `srr-f4b-m${row.seq}`, sessionId: 'srr-f4b', createdAt: new Date(), ...row,
        } as any);
      }
      const forkB = await forkSession(
        (await AgentSessions.findOneAsync('srr-f4b'))!, { atSeq: 3 },
      );
      const copiedB = await AgentMessages
        .find({ sessionId: forkB }, { sort: { seq: 1 } }).fetchAsync();
      assert.deepEqual(copiedB.map((m) => m.seq), [0, 1, 2, 3],
        'an answered batch plus a trailing system row copies whole');
      assert.deepEqual((await AgentSessions.findOneAsync(forkB))!.forkedFrom,
        { sessionId: 'srr-f4b', seq: 3 });
    });

    it('F5: orphan-claim recovery resumes a system turn as the intent\'s agent', async function () {
      this.timeout(60000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { systemFrom } = await import('../common/participants');
      const { systemRowId } = await import('../server/system-turn');
      const { startWatcher } = await import('../server/watcher');

      // The state a crash leaves BETWEEN the consume and the turn's first
      // commit: the row is written, the intent still stands (decision 14 —
      // only a commit clears it), and the session is stuck in an active phase
      // under a lease whose owner is gone.
      let primaryCalls = 0;
      await register('str-f5a', mockProvider(() => {
        primaryCalls += 1;
        return { text: 'the primary must not answer this' };
      }));
      // Slow enough that every dispatch this sweep and the observer both queue
      // lands inside one running turn, where the `running` guard swallows it.
      await register('str-f5b', slowProvider('recovered by the colleague', 12));

      await seedRostered('srr-f5', 'str-f5a', 'u1', [model('str-f5b')], {
        nextSeq: 1,
        phase: 'streaming',
        lease: { serverId: 'dead-server', until: new Date(Date.now() - 60_000) },
        pendingSystem: {
          prompt: 'nightly check', agent: 'str-f5b', source: 'routine',
          key: 'srr-f5-slot', token: 'srr-f5-intent-token', at: new Date(),
        },
      });
      await AgentMessages.insertAsync({
        _id: systemRowId('srr-f5', 'srr-f5-slot'),
        sessionId: 'srr-f5', seq: 0, role: 'system',
        content: 'nightly check', from: systemFrom('routine'), createdAt: new Date(),
      } as any);

      // `verdictGraceMs` is pushed past the whole test on purpose: it disables
      // the watcher's CASE 6, which would consume the intent by DISPATCHING its
      // agent explicitly and so would prove nothing about `resolveWakeAgent`.
      // What is left is CASE 1 — the plain orphan claim, which re-derives the
      // model from durable state.
      const w = startWatcher({ sweepMs: 150, verdictGraceMs: 600_000 });
      try {
        await waitFor(
          () => finished('srr-f5', 1),
          'the orphan claim to recover the system turn',
          40000,
        );

        const rows = await assistants('srr-f5');
        assert.lengthOf(rows, 1, 'recovered exactly once');
        assert.equal(rows[0].content, 'recovered by the colleague');
        assert.deepEqual(
          rows[0].from, { participant: 'm:str-f5b', name: 'str-f5b' },
          'the intent named its target and recovery honoured it',
        );
        assert.equal(primaryCalls, 0, 'the primary never ran the colleague\'s work');

        const doc = (await AgentSessions.findOneAsync('srr-f5'))!;
        assert.isUndefined(doc.pendingSystem, 'the recovered turn\'s first commit cleared it');
        assert.equal(doc.budgetSpent.systemTurns, 1, 'and billed it, once, on that same write');
        assert.equal(doc.phase, 'idle');
        assert.isUndefined(doc.lease);
        assert.equal(await countRole('srr-f5', 'system'), 1,
          'the row was already materialized; recovery did not write a second');
      } finally {
        await w.stop();
      }
    });

    it('F7: a system turn against a stranded tool_use repairs before it answers', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      // A recorder rather than a canned reply: the assertion that matters is
      // what the MODEL was shown. An unanswered `tool_use` reaching a provider
      // is a 400 on every retry, forever.
      const { provider, requests } = recorder('repaired and answered');
      await register('str-f7', provider);
      await seedSolo('srr-f7', 'str-f7', { nextSeq: 2 });
      await AgentMessages.insertAsync({
        _id: 'srr-f7-m0', sessionId: 'srr-f7', seq: 0, role: 'user',
        content: 'do it', createdAt: new Date(),
      } as any);
      await AgentMessages.insertAsync({
        _id: 'srr-f7-m1', sessionId: 'srr-f7', seq: 1, role: 'assistant',
        content: '', toolCalls: [{ id: 't1', name: 'noop', args: {} }],
        createdAt: new Date(),
      } as any);

      assert.deepEqual(await startSystemTurn('srr-f7', 'nightly check'), RAN);
      // NOT `finished(…, 1)`: the stranded row is already an assistant row, so
      // that predicate is true before anything happens. The wait ends on the
      // terminal state of a transcript that holds exactly the NEW reply.
      await waitFor(async () => {
        const rows = await assistants('srr-f7');
        const doc = await AgentSessions.findOneAsync('srr-f7');
        return rows.length === 1 && rows[0].content === 'repaired and answered'
          && !!doc && doc.phase === 'idle' && !doc.lease;
      }, 'the repaired system turn to finish');

      assert.isUndefined(
        await AgentMessages.findOneAsync('srr-f7-m1'),
        'repair-on-entry deleted the abandoned turn',
      );
      const sys = (await systemRow('srr-f7'))!;
      assert.equal(sys.seq, 2, 'the system row was written before repair and survived it');

      assert.isAtLeast(requests.length, 1, 'the provider was called');
      const shown = requests[0].messages as Array<{ role: string; content?: string; toolCalls?: unknown[] }>;
      assert.isTrue(
        shown.every((m) => !(m.toolCalls && m.toolCalls.length)),
        'no `tool_use` reached the provider — repair ran FIRST, not after the 400',
      );
      assert.isTrue(
        shown.some((m) => m.role === 'user' && m.content === '[system] nightly check'),
        'and the prompt it was called for is the marked system row',
      );

      const doc = (await AgentSessions.findOneAsync('srr-f7'))!;
      assert.isUndefined(doc.pendingSystem);
      assert.equal(doc.budgetSpent.systemTurns, 1);
    });

    it('F8: a subagent child session accepts a system turn', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages } = await import('../common/collections');
      const { startSystemTurn } = await import('../server/methods');

      await register('str-f8', canned('the child, answering'));
      await seedSolo('srr-f8p', 'str-f8');
      // Lineage on the document and nothing else — the shape a subagent
      // dispatch leaves. Nothing in the park or the consume path reads
      // `parent`, and §9 says so deliberately: a child is a real session with a
      // real transcript.
      await seedSolo('srr-f8c', 'str-f8', {
        parent: { sessionId: 'srr-f8p', toolCallId: 'tc1' },
        depth: 1,
      });

      assert.deepEqual(
        await startSystemTurn('srr-f8c', 'nightly check', { source: 'routine' }), RAN,
      );
      await waitFor(() => finished('srr-f8c', 1), 'the child\'s system turn to finish');

      const sys = (await systemRow('srr-f8c'))!;
      assert.isDefined(sys, 'the child got its own system row');
      assert.equal(sys.seq, 0);
      assert.equal(sys.content, 'nightly check');
      assert.deepEqual(
        sys.from, { participant: 's:routine', name: 'routine' },
        'attributed to the source that scheduled it, never to the parent\'s owner',
      );

      const child = (await AgentSessions.findOneAsync('srr-f8c'))!;
      assert.isUndefined(child.pendingSystem);
      assert.equal(child.budgetSpent.systemTurns, 1);
      assert.deepEqual(child.parent, { sessionId: 'srr-f8p', toolCallId: 'tc1' },
        'and its lineage is untouched');

      assert.equal(
        await AgentMessages.find({ sessionId: 'srr-f8p' }).countAsync(), 0,
        'the parent transcript is not the child\'s business',
      );
    });
  });
});
