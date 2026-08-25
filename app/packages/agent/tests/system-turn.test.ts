import { assert } from 'chai';
import {
  clean, countRole, finished, model, recorder, seedRostered, seedSolo, settle,
  systemRow, waitFor,
} from './system-turn-helpers';
import type { Provider, ProviderMessage } from '../server/providers/types';
import type { SystemTurnResult } from '../server/system-turn';
import type { AgentMessage, SessionParticipant } from '../common/types';

/**
 * System turns, groups A and B of the matrix (system-turn spec §10):
 * ATTRIBUTION — who the transcript says started the work, and what the model is
 * actually shown — and THE STALL — what happens when the work arrives at a
 * session that is not free to do it.
 *
 * Helpers are imported from `./system-turn-helpers`, deliberately against the
 * copy-per-file convention elsewhere: three suites exercise one feature here,
 * and three drifting definitions of "the turn is over" would be three different
 * races.
 */

/** One comparable token per `SystemTurnResult`, so an outcome assertion reads
 *  as one line instead of a union narrowing. */
const outcome = (r: SystemTurnResult): string => {
  if (!r.ok) return r.reason;
  return r.ran ? 'ran' : 'parked';
};

/** The three roles `ProviderMessage` admits. Held as strings on purpose: the
 *  bug under test produces a value OUTSIDE the union, which a typed comparison
 *  would refuse to even express. */
const PROVIDER_ROLES: readonly string[] = ['user', 'assistant', 'tool'];

const assertLegalRoles = (msgs: ProviderMessage[], where: string): void => {
  msgs.forEach((m, i) => {
    assert.include(
      PROVIDER_ROLES, m.role as string,
      `${where}[${i}] reached the provider as role "${m.role}". `
      + 'ProviderMessage.role is user|assistant|tool; the generic build in '
      + "transcript.ts casts `m.role as ProviderMessage['role']` unchecked, and an "
      + 'adapter with no default case re-labels whatever it gets as `user` — '
      + 'telling the model a PERSON said it, which is the exact confusion the '
      + 'system role exists to prevent.',
    );
  });
};

/**
 * A provider whose FIRST call blocks until released, so a test can hold a
 * session in `streaming` and park an intent behind live work.
 *
 * A fixed sleep would be a race dressed up as a delay; this is a gate with a
 * deadline, so a test that forgets to release fails loudly instead of hanging.
 */
const gatedProvider = (text = 'the live turn') => {
  const state = { calls: 0, open: false };
  const provider: Provider = {
    async *stream() {
      state.calls += 1;
      if (state.calls === 1) {
        const deadline = Date.now() + 20000;
        while (!state.open && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => { setTimeout(r, 15); });
        }
      }
      yield { kind: 'text' as const, chunk: text };
      yield { kind: 'done' as const, usage: { input: 1, output: 2 } };
    },
  };
  return { provider, state, release: () => { state.open = true; } };
};

/** A session with one user row, so the transcript a turn answers is not empty
 *  and `nextSeq` is where a real send would have left it. */
const seedWithUser = async (
  sessionId: string, agent: string, overrides: Record<string, unknown> = {},
) => {
  const { AgentMessages } = await import('../common/collections');
  await seedSolo(sessionId, agent, { nextSeq: 1, ...overrides });
  await AgentMessages.insertAsync({
    _id: `${sessionId}-u`, sessionId, seq: 0, role: 'user',
    content: 'refund please', createdAt: new Date(),
  });
};

/**
 * The system turn HAS RUN: its row is in the transcript, an assistant answered
 * it, the marker is spent and the session is back at rest.
 *
 * Used where the total assistant count is not fixed in advance (an interjection
 * makes the live turn loop once more), so the wait ends on the property under
 * test rather than on a number that depends on scheduling.
 */
const systemTurnDone = async (sessionId: string): Promise<boolean> => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const row = await systemRow(sessionId);
  if (!row) return false;
  const answered = await AgentMessages
    .find({ sessionId, role: 'assistant', seq: { $gt: row.seq } }).countAsync();
  if (answered < 1) return false;
  const doc = await AgentSessions.findOneAsync(sessionId);
  return !!doc && doc.phase === 'idle' && !doc.lease && !doc.pendingSystem;
};

/** A standing intent as a crash leaves one: parked, never consumed, and OLD
 *  enough that the sweep's grace window has passed. */
const strandedIntent = (prompt: string, token: string, source = 'routine') => ({
  prompt, source, token, at: new Date(Date.now() - 30_000),
});

/* ══ GROUP A — attribution ══════════════════════════════════════════════════ */

describe('system turns — attribution', () => {
  beforeEach(clean);
  after(clean);

  it('A1: attributes the row to an `s:` origin, never the owner, and writes no user row', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { AgentMessages } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-a1', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'noted' })),
    });
    await seedSolo('sst-a1', 'st-a1');

    assert.equal(
      outcome(await startSystemTurn('sst-a1', 'the 06:30 review', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-a1', 1), 'the sourced system turn');

    // A second firing with no `source`: the DEFAULT attribution, which must
    // still be an `s:` id and still not a person.
    assert.equal(outcome(await startSystemTurn('sst-a1', 'the unattributed one')), 'ran');
    await waitFor(() => finished('sst-a1', 2), 'the unsourced system turn');
    await settle();

    const rows = await AgentMessages
      .find({ sessionId: 'sst-a1', role: 'system' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(rows, 2);
    assert.deepEqual(rows[0].from, { participant: 's:routine', name: 'routine' });
    assert.deepEqual(rows[1].from, { participant: 's:system', name: 'system' });
    for (const r of rows) {
      assert.isTrue(
        r.from!.participant.startsWith('s:'),
        'the `s:` namespace is disjoint from h:/x:/m: by construction (decision 2)',
      );
      assert.notEqual(
        r.from!.participant, 'h:u1',
        "a machine's work must never be recorded as the owner's",
      );
    }
    // The whole point of the fourth role: the lie the workaround told was a
    // `role: 'user'` row.
    assert.equal(await countRole('sst-a1', 'user'), 0, 'a system turn writes no user row');
    assert.equal(await countRole('sst-a1', 'system'), 2);
  });

  it('A2: stamps `from` on a ROSTERLESS session, where a human send would not', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-a2', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'noted' })),
    });
    await seedSolo('sst-a2', 'st-a2');

    // The control, and the contrast decision 3 is ABOUT: `sendToSession`
    // roster-gates its stamp, so this row carries no `from` at all.
    await sendToSession('st-a2', 'sst-a2', 'a person typed this', 'u1');
    await waitFor(() => finished('sst-a2', 1), 'the human turn');
    const userRow = (await AgentMessages.findOneAsync({ sessionId: 'sst-a2', role: 'user' }))!;
    assert.isUndefined(userRow.from, 'the 1:1 payload is byte-identical for human rows');

    assert.equal(
      outcome(await startSystemTurn('sst-a2', 'the scheduled one', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-a2', 2), 'the system turn');

    // Decision 3: unconditional. A system row is net-new, so there is no
    // byte-identical projection to preserve — and roster-gating it would drop
    // attribution in precisely the 1:1 case scheduled work actually uses.
    const row = (await systemRow('sst-a2'))!;
    assert.deepEqual(row.from, { participant: 's:routine', name: 'routine' });

    const doc = (await AgentSessions.findOneAsync('sst-a2'))!;
    assert.isUndefined(doc.participants, 'attribution needs an id, not a roster row');
  });

  it('A3: leaves the roster untouched, and the `s:` id never resolves as an addressee', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { resolveAddressee } = await import('../common/participants');
    const { AgentSessions } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-a3-prime', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'noted' })),
    });
    const before = await seedRostered('sst-a3', 'st-a3-prime', 'u1', [model('st-a3-analyst')]);

    assert.equal(
      outcome(await startSystemTurn('sst-a3', 'the roster is not yours to edit', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-a3', 1), 'the system turn');
    await settle();

    const doc = (await AgentSessions.findOneAsync('sst-a3'))!;
    const after = doc.participants!;
    assert.deepEqual(
      after.map((p) => `${p.id}/${p.kind}/${p.role}`),
      before.map((p) => `${p.id}/${p.kind}/${p.role}`),
      'a system turn joins nobody — the roster is exactly as it was',
    );
    assert.isUndefined(
      after.find((p) => p.id.startsWith('s:')),
      'a `kind: system` roster row would rewrite the prompt of every rostered session',
    );

    const row = (await systemRow('sst-a3'))!;
    assert.isUndefined(row.to, 'a system row addresses nobody');
    // Addressing is resolved against the roster's MODELS. An `s:` id names no
    // model, so neither an explicit `to` nor a leading mention can reach it.
    assert.isNull(resolveAddressee(row.content, 's:routine', doc));
    assert.isNull(resolveAddressee('@routine take this', undefined, doc));
    assert.isNull(resolveAddressee('@system take this', undefined, doc));
  });

  it('A4: every projected role is a legal provider role, and the marker carries the prompt', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');

    // The recorder is the only way to assert on what the MODEL was shown —
    // reading the transcript back proves what was STORED, which is precisely
    // the half of this that was never in doubt.
    const rec = recorder('acknowledged');
    // eslint-disable-next-line no-new
    new Agent('st-a4', {
      model: 'mock', instructions: '', tools: [], provider: rec.provider,
    });
    await seedSolo('sst-a4', 'st-a4');

    await sendToSession('st-a4', 'sst-a4', 'a human opened the conversation', 'u1');
    await waitFor(() => finished('sst-a4', 1), 'the human turn');

    assert.equal(
      outcome(await startSystemTurn('sst-a4', 'run the 06:30 review', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-a4', 2), 'the system turn');

    assert.lengthOf(rec.requests, 2, 'one human turn, one system turn');
    rec.requests.forEach((req, i) => {
      assertLegalRoles(req.messages as ProviderMessage[], `request ${i} message`);
    });

    // The SECOND request is the one that carries the system row, alongside the
    // history the model already had.
    const shown = rec.requests[1].messages as ProviderMessage[];
    assert.deepEqual(
      shown.map((m) => m.role), ['user', 'assistant', 'user'],
      'the system row projects as a MARKED user row — no provider has a '
      + 'mid-conversation system message',
    );
    assert.equal(
      shown[2].content, '[routine] run the 06:30 review',
      "the marker is `[source] body`, and it is not gated on the roster's prefixing rule",
    );
    assert.isFalse(
      shown.some((m) => m.content === 'run the 06:30 review'),
      'an unmarked copy of the prompt would be machine input the model reads as a person',
    );
  });

  it('A5: the omniscient compaction view projects a system row legally', async function () {
    this.timeout(30000);
    const { toProviderMessages } = await import('../server/transcript');

    const participants: SessionParticipant[] = [
      {
        id: 'h:u1', kind: 'human', role: 'owner', userId: 'u1',
        displayName: 'owner', joinedAt: new Date(),
      },
      model('st-a5-prime'),
      model('st-a5-analyst'),
    ];
    const msgs: AgentMessage[] = [
      {
        _id: 'a5-0', sessionId: 'sst-a5', seq: 0, role: 'user', content: 'a person spoke',
        from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
      },
      {
        _id: 'a5-1', sessionId: 'sst-a5', seq: 1, role: 'assistant', content: 'the model answered',
        from: { participant: 'm:st-a5-prime', name: 'st-a5-prime' }, createdAt: new Date(),
      },
      {
        _id: 'a5-2', sessionId: 'sst-a5', seq: 2, role: 'system', content: 'the scheduled prompt',
        from: { participant: 's:routine', name: 'routine' }, createdAt: new Date(),
      },
    ];

    // No `self` — the summarizer's view, which sees every row.
    const out = toProviderMessages(msgs, { primary: 'm:st-a5-prime', participants });
    assertLegalRoles(out, 'omniscient projection message');
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(out[0].content, '[owner]: a person spoke');
    assert.equal(out[1].content, '[st-a5-prime]: the model answered');
    assert.equal(out[2].content, '[routine] the scheduled prompt');
  });

  it('A6: a colleague\'s own view keeps the marker unprefixed', async function () {
    this.timeout(30000);
    const { toProviderMessages } = await import('../server/transcript');

    const participants: SessionParticipant[] = [
      {
        id: 'h:u1', kind: 'human', role: 'owner', userId: 'u1',
        displayName: 'owner', joinedAt: new Date(),
      },
      model('st-a6-prime'),
      model('st-a6-analyst'),
    ];
    const msgs: AgentMessage[] = [
      {
        _id: 'a6-0', sessionId: 'sst-a6', seq: 0, role: 'user', content: 'a person spoke',
        from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
      },
      {
        _id: 'a6-1', sessionId: 'sst-a6', seq: 1, role: 'assistant', content: 'the model answered',
        from: { participant: 'm:st-a6-prime', name: 'st-a6-prime' }, createdAt: new Date(),
      },
      {
        _id: 'a6-2', sessionId: 'sst-a6', seq: 2, role: 'system', content: 'the scheduled prompt',
        from: { participant: 's:routine', name: 'routine' }, createdAt: new Date(),
      },
    ];

    const out = toProviderMessages(msgs, {
      self: 'm:st-a6-analyst', primary: 'm:st-a6-prime', participants,
    });
    assertLegalRoles(out, 'colleague projection message');
    assert.deepEqual(out.map((m) => m.role), ['user', 'user', 'user']);
    // A human row gets the disambiguating `[name]: ` prefix, a colleague's
    // turn-final reply gets it too — and the system row keeps its OWN marker,
    // pushed by its own branch, never doubled and never colon-suffixed.
    assert.equal(out[0].content, '[owner]: a person spoke');
    assert.equal(out[1].content, '[st-a6-prime]: the model answered');
    assert.equal(out[2].content, '[routine] the scheduled prompt');
    assert.notInclude(out[2].content!, '[routine]:', 'the system marker is not the human prefix');
  });

  it('A7: `needsAttribution` is unchanged by a system turn', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { needsAttribution } = await import('../common/participants');
    const { toProviderMessages } = await import('../server/transcript');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-a7', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'noted' })),
    });
    const before = await seedRostered('sst-a7', 'st-a7', 'u1');
    assert.isFalse(needsAttribution(before), 'one human + one model is the classic pair');

    await sendToSession('st-a7', 'sst-a7', 'a person typed this', 'u1');
    await waitFor(() => finished('sst-a7', 1), 'the human turn');
    assert.equal(
      outcome(await startSystemTurn('sst-a7', 'the scheduled one', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-a7', 2), 'the system turn');

    const doc = (await AgentSessions.findOneAsync('sst-a7'))!;
    assert.isFalse(
      needsAttribution(doc.participants!),
      'a system origin is NOT a roster row, so it cannot flip `[name]: ` prefixing '
      + 'on for a session that had none',
    );

    // The consequence, stated as behaviour: human rows stay unprefixed while
    // the system row keeps its marker regardless.
    const msgs = await AgentMessages
      .find({ sessionId: 'sst-a7' }, { sort: { seq: 1 } }).fetchAsync();
    const out = toProviderMessages(msgs, {
      primary: 'm:st-a7', participants: doc.participants!,
    });
    assertLegalRoles(out, 'A7 projection message');
    assert.equal(out[0].content, 'a person typed this');
    assert.equal(out[2].content, '[routine] the scheduled one');
  });

  it('A8: `unansweredAddressee` ignores a system row', async function () {
    this.timeout(30000);
    const { unansweredAddressee } = await import('../server/participants');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // (a) An ANSWERED conversation with a system row appended. If the predicate
    // counted system rows the way it counts user rows, the tail would look like
    // an unanswered question and `resolveWakeAgent` would hand the turn to the
    // primary for no reason.
    await seedRostered('sst-a8a', 'st-a8-prime', 'u1', [model('st-a8-analyst')]);
    await AgentMessages.insertAsync({
      _id: 'a8a-0', sessionId: 'sst-a8a', seq: 0, role: 'user', content: 'hello',
      from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
    });
    await AgentMessages.insertAsync({
      _id: 'a8a-1', sessionId: 'sst-a8a', seq: 1, role: 'assistant', content: 'hello back',
      from: { participant: 'm:st-a8-prime', name: 'st-a8-prime' }, createdAt: new Date(),
    });
    await AgentMessages.insertAsync({
      _id: 'a8a-2', sessionId: 'sst-a8a', seq: 2, role: 'system', content: 'the scheduled prompt',
      from: { participant: 's:routine', name: 'routine' }, createdAt: new Date(),
    });
    assert.isNull(
      await unansweredAddressee((await AgentSessions.findOneAsync('sst-a8a'))!),
      'a system row is not an unanswered question',
    );

    // (b) A genuinely unanswered colleague-addressed tail, with a system row
    // landing after it. The system row must neither ANSWER it nor supersede it:
    // decision 7 runs in this direction too.
    await seedRostered('sst-a8b', 'st-a8-prime', 'u1', [model('st-a8-analyst')]);
    await AgentMessages.insertAsync({
      _id: 'a8b-0', sessionId: 'sst-a8b', seq: 0, role: 'user',
      content: '@st-a8-analyst please look', to: 'm:st-a8-analyst',
      from: { participant: 'h:u1', name: 'owner' }, createdAt: new Date(),
    });
    await AgentMessages.insertAsync({
      _id: 'a8b-1', sessionId: 'sst-a8b', seq: 1, role: 'system', content: 'the scheduled prompt',
      from: { participant: 's:routine', name: 'routine' }, createdAt: new Date(),
    });
    assert.deepEqual(
      await unansweredAddressee((await AgentSessions.findOneAsync('sst-a8b'))!),
      { id: 'm:st-a8-analyst', agent: 'st-a8-analyst' },
      "a person's open question outranks a machine's prompt, and a system row "
      + 'does not count as its answer',
    );
  });

  it('A9: `opts.agent` answers, its reply names it, and an unknown one is refused', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    let primeCalls = 0;
    // eslint-disable-next-line no-new
    new Agent('st-a9-prime', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => { primeCalls += 1; return { text: 'the primary should not speak' }; }),
    });
    const analyst = recorder('analyst reporting');
    // eslint-disable-next-line no-new
    new Agent('st-a9-analyst', {
      model: 'mock', instructions: '', tools: [], provider: analyst.provider,
    });
    await seedRostered('sst-a9', 'st-a9-prime', 'u1', [model('st-a9-analyst')]);

    assert.equal(
      outcome(await startSystemTurn('sst-a9', 'the analyst brief', {
        agent: 'st-a9-analyst', source: 'routine',
      })),
      'ran',
    );
    await waitFor(() => finished('sst-a9', 1), 'the addressed system turn');
    await settle();

    assert.equal(primeCalls, 0, 'the primary must not answer an intent addressed elsewhere');
    assert.lengthOf(analyst.requests, 1);
    assert.isTrue(
      (analyst.requests[0].messages as ProviderMessage[])
        .some((m) => m.content === '[routine] the analyst brief'),
      'the addressed colleague is shown the marked prompt',
    );

    const reply = (await AgentMessages.findOneAsync({ sessionId: 'sst-a9', role: 'assistant' }))!;
    assert.equal(reply.content, 'analyst reporting');
    assert.deepEqual(reply.from, { participant: 'm:st-a9-analyst', name: 'st-a9-analyst' });
    assert.deepEqual((await systemRow('sst-a9'))!.from, { participant: 's:routine', name: 'routine' });
    assert.equal((await AgentSessions.findOneAsync('sst-a9'))!.budgetSpent.systemTurns, 1);

    // §4.3 step 2: an intent naming an unregistered teammate is a HARD refusal,
    // never the visible primary fallback the recovery paths use. A schedule
    // pointing at a colleague that no longer exists is a config bug, and
    // answering as somebody else would hide it.
    assert.equal(
      outcome(await startSystemTurn('sst-a9', 'nobody home', { agent: 'st-a9-nobody' })),
      'no-agent',
    );
    await settle();
    const doc = (await AgentSessions.findOneAsync('sst-a9'))!;
    assert.isUndefined(doc.pendingSystem, 'a refused intent writes nothing at all');
    assert.equal(await countRole('sst-a9', 'system'), 1);
    assert.equal(doc.budgetSpent.systemTurns, 1, 'and costs nothing');
  });
});

/* ══ GROUP B — the stall ════════════════════════════════════════════════════ */

describe('system turns — the stall', () => {
  beforeEach(clean);
  after(clean);

  it('B1: an idle session runs the intent immediately', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { AgentSessions } = await import('../common/collections');

    const rec = recorder('reviewed');
    // eslint-disable-next-line no-new
    new Agent('st-b1', {
      model: 'mock', instructions: '', tools: [], provider: rec.provider,
    });
    await seedSolo('sst-b1', 'st-b1');

    const r = await startSystemTurn('sst-b1', 'the morning review', { source: 'routine' });
    assert.equal(outcome(r), 'ran', 'a free session consumes its own park immediately');
    await waitFor(() => finished('sst-b1', 1), 'the immediate system turn');

    const row = (await systemRow('sst-b1'))!;
    assert.equal(row.content, 'the morning review');
    assert.equal(row.seq, 0, 'the row is allocated a real seq in the transcript');

    const doc = (await AgentSessions.findOneAsync('sst-b1'))!;
    assert.isUndefined(doc.pendingSystem, "the turn's commit clears the marker");
    assert.equal(doc.budgetSpent.systemTurns, 1);
    assert.equal(doc.budgetSpent.turns, 0, 'scheduled work is a different purse from human work');
    assert.lengthOf(rec.requests, 1);
  });

  it('B2: a streaming session PARKS, and the park costs no provider call', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { AgentSessions } = await import('../common/collections');

    const gate = gatedProvider('the live reply');
    // eslint-disable-next-line no-new
    new Agent('st-b2', {
      model: 'mock', instructions: '', tools: [], provider: gate.provider,
    });
    await seedSolo('sst-b2', 'st-b2');

    await sendToSession('st-b2', 'sst-b2', 'a person is mid-conversation', 'u1');
    await waitFor(async () => gate.state.calls === 1, 'the live turn to reach the provider');

    const r = await startSystemTurn('sst-b2', 'the parked review', { source: 'routine' });
    assert.equal(outcome(r), 'parked', 'a busy session defers the request rather than dropping it');

    // The absence is the assertion, so give the thing that must not happen its
    // chance to happen.
    await settle();
    assert.equal(gate.state.calls, 1, 'parking must not start a second provider call');
    assert.isUndefined(await systemRow('sst-b2'), 'and must not materialize a row yet');
    const parked = (await AgentSessions.findOneAsync('sst-b2'))!;
    assert.isDefined(parked.pendingSystem, 'the intent is DURABLE — that is decision 8');
    assert.equal(parked.pendingSystem!.prompt, 'the parked review');
    assert.equal(parked.pendingSystem!.source, 'routine');
    assert.isString(parked.pendingSystem!.token);
    assert.isUndefined(
      parked.budgetSpent.systemTurns,
      'a parked-but-never-run intent is not billed (decision 14)',
    );

    // Drain, so the next test starts from rest.
    gate.release();
    await waitFor(() => finished('sst-b2', 2), 'the parked intent to fire at wind-down');
  });

  it('B3: the parked intent is consumed EXACTLY once, at the next idle', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { AgentSessions } = await import('../common/collections');

    const gate = gatedProvider('the live reply');
    // eslint-disable-next-line no-new
    new Agent('st-b3', {
      model: 'mock', instructions: '', tools: [], provider: gate.provider,
    });
    await seedSolo('sst-b3', 'st-b3');

    await sendToSession('st-b3', 'sst-b3', 'a person is mid-conversation', 'u1');
    await waitFor(async () => gate.state.calls === 1, 'the live turn to reach the provider');
    assert.equal(outcome(await startSystemTurn('sst-b3', 'the parked review', { source: 'routine' })), 'parked');

    gate.release();
    await waitFor(() => finished('sst-b3', 2), 'the parked intent to fire at wind-down');
    // Three triggers share ONE consume path; a second firing would show up as a
    // second row, a second turn or a second charge.
    await settle(600);

    assert.equal(await countRole('sst-b3', 'system'), 1, 'exactly one row for one intent');
    assert.equal(await countRole('sst-b3', 'assistant'), 2, 'the live turn, then the system turn');
    assert.equal(gate.state.calls, 2);
    const doc = (await AgentSessions.findOneAsync('sst-b3'))!;
    assert.isUndefined(doc.pendingSystem);
    assert.equal(doc.budgetSpent.systemTurns, 1);
    assert.equal(doc.budgetSpent.turns, 1, 'the human send, and only the human send');
  });

  it('B4: an awaiting session keeps its park intact, and both the approved tool and the system turn run in seq order', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { recordVerdict, startSystemTurn } = await import('../server/methods');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // A REAL parked approval — the case this whole feature exists for. Under
    // the app-level workaround a session parked on an approval is not `idle`,
    // so the next firing was skipped and its schedule slot advanced: dropped,
    // not deferred.
    const state = { ran: [] as string[], calls: 0, saw: [] as string[] };
    const provider = mockProvider((req) => {
      state.calls += 1;
      for (const m of req.messages) {
        if (typeof m.content === 'string' && m.content.startsWith('[')) state.saw.push(m.content);
      }
      if (state.calls === 1) return { toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] };
      return { text: state.calls === 2 ? 'all done' : 'review complete' };
    });
    const tools = [{
      name: 'refund',
      description: 'x',
      gate: 'ask' as const,
      args: { type: 'object', properties: {} },
      run: async () => { state.ran.push('refund'); return { did: 'refund' }; },
    }];
    // eslint-disable-next-line no-new
    new Agent('st-b4', {
      model: 'mock', instructions: '', tools, provider,
    } as any);
    await seedWithUser('sst-b4', 'st-b4');
    await runTurn('sst-b4', {
      model: 'mock', system: '', tools, provider,
    } as any);

    const parked = (await AgentSessions.findOneAsync('sst-b4'))!;
    assert.equal(parked.phase, 'awaiting');
    assert.equal(parked.pending!.toolCallId, 'g1');

    // `awaiting` still PARKS. It is not `stopped`/`error`, so decision 11's
    // refusal does not apply — and the consume bails because `awaiting` is a
    // decided phase a human still owns.
    assert.equal(
      outcome(await startSystemTurn('sst-b4', 'the standing review', { source: 'routine' })),
      'parked',
    );
    await settle();

    const held = (await AgentSessions.findOneAsync('sst-b4'))!;
    assert.equal(held.phase, 'awaiting', 'parking an intent must not disturb the approval');
    assert.equal(held.pending!.toolCallId, 'g1', 'the park is untouched');
    assert.isUndefined(held.pending!.verdict, 'and undecided');
    const intentToken = held.pendingSystem!.token;
    assert.isDefined(intentToken, 'the intent stands behind it');
    assert.isUndefined(await systemRow('sst-b4'), 'nothing is materialized while the session is held');

    await recordVerdict({ userId: 'u1' }, 'st-b4', 'sst-b4', 'approved');
    // Deliberately NOT `finished(…, 2)`. Once the resume commits, the standing
    // intent's wind-down wake fires immediately, so "exactly 2 assistants AND
    // idle AND unleased" is a state that may never be observable — the third
    // turn starts inside the poll interval. Wait on the monotonic fact instead.
    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 'sst-b4', role: 'assistant' }).countAsync()) >= 2,
      "the approval's resume to commit",
    );
    assert.deepEqual(state.ran, ['refund'], 'the approved tool runs — once');

    // THE ASSERTION THIS TEST EXISTS FOR. The approval resume is NOT the
    // intent's turn: it was dispatched by `recordVerdict`, its transcript row
    // is the tool result, and it never wrote a system row. Decision 14's latch
    // (`consumingSystem = !!entry.pendingSystem`, loop.ts:298) has no way to
    // tell the two apart, so it clears a marker its turn did not consume and
    // bills a budget line nothing spent.
    const mid = (await AgentSessions.findOneAsync('sst-b4'))!;
    assert.isTrue(
      !!mid.pendingSystem || !!(await systemRow('sst-b4')),
      'a turn started by an APPROVAL must not swallow a standing system intent: '
      + 'the intent is either still standing or already materialized, never gone. '
      + '(loop.ts:298 latches `consumingSystem` on the mere PRESENCE of '
      + '`pendingSystem` at turn entry — decision 9 makes the standing intent '
      + 'unique, but uniqueness is not evidence that THIS turn was started by it. '
      + 'The consume materializes the row BEFORE dispatching, so the honest test '
      + "is whether this turn's system row exists.)",
    );

    await waitFor(() => finished('sst-b4', 3), 'the system turn to run behind the approval');

    const toolRow = (await AgentMessages.findOneAsync({ sessionId: 'sst-b4', role: 'tool' }))!;
    const sysRow = (await systemRow('sst-b4'))!;
    const assistants = await AgentMessages
      .find({ sessionId: 'sst-b4', role: 'assistant' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isBelow(toolRow.seq, sysRow.seq, 'the approved tool ran first — it was there first');
    assert.isBelow(sysRow.seq, assistants[2].seq, 'and the system turn answers after it');
    assert.equal(assistants[2].content, 'review complete');
    assert.include(state.saw, '[routine] the standing review');

    const done = (await AgentSessions.findOneAsync('sst-b4'))!;
    assert.isUndefined(done.pendingSystem);
    assert.isUndefined(done.pending, 'the verdict is spent once its call is answered');
    assert.equal(done.budgetSpent.systemTurns, 1, 'one system turn, one charge');
  });

  it('B5: a `stopped` session refuses the park, and is not refused forever', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { AgentSessions } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-b5', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'reviewed' })),
    });
    await seedSolo('sst-b5', 'st-b5', { phase: 'stopped' });

    // Decision 11: parking into a halted session would stand forever (the sweep
    // excludes those phases) and then refuse every later firing — a permanent
    // block from a transient failure. Refusing NOW tells the scheduler on its
    // next tick.
    assert.equal(
      outcome(await startSystemTurn('sst-b5', 'the review', { key: 'b5', source: 'routine' })),
      'session-halted',
    );
    await settle();
    const refused = (await AgentSessions.findOneAsync('sst-b5'))!;
    assert.isUndefined(refused.pendingSystem, 'a refusal writes nothing');
    assert.isUndefined(refused.lastSystemKey, 'and does not burn the idempotency key');
    assert.isUndefined(refused.budgetSpent.systemTurns, 'and costs no budget');
    assert.equal(await countRole('sst-b5', 'system'), 0);

    // A human send is what clears `stopped`. Once it is clear, the SAME key
    // must still work — the refusal was about the phase, not the firing.
    await AgentSessions.updateAsync('sst-b5', { $set: { phase: 'idle' } });
    assert.equal(
      outcome(await startSystemTurn('sst-b5', 'the review', { key: 'b5', source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-b5', 1), 'the retried system turn');
    assert.equal((await systemRow('sst-b5'))!.content, 'the review');
    assert.equal((await AgentSessions.findOneAsync('sst-b5'))!.lastSystemKey, 'b5');
  });

  it('B6: an `error` session refuses the park, and is not refused forever', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { AgentSessions } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-b6', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'reviewed' })),
    });
    await seedSolo('sst-b6', 'st-b6', { phase: 'error' });

    assert.equal(
      outcome(await startSystemTurn('sst-b6', 'the review', { key: 'b6', source: 'routine' })),
      'session-halted',
    );
    await settle();
    const refused = (await AgentSessions.findOneAsync('sst-b6'))!;
    assert.isUndefined(refused.pendingSystem);
    assert.isUndefined(refused.lastSystemKey);
    assert.equal(await countRole('sst-b6', 'system'), 0);

    await AgentSessions.updateAsync('sst-b6', { $set: { phase: 'idle' } });
    assert.equal(
      outcome(await startSystemTurn('sst-b6', 'the review', { key: 'b6', source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-b6', 1), 'the retried system turn');
    assert.equal((await systemRow('sst-b6'))!.content, 'the review');
  });

  it('B7: a second intent is refused, not queued and not overwritten', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    const gate = gatedProvider('the live reply');
    // eslint-disable-next-line no-new
    new Agent('st-b7', {
      model: 'mock', instructions: '', tools: [], provider: gate.provider,
    });
    await seedSolo('sst-b7', 'st-b7');

    await sendToSession('st-b7', 'sst-b7', 'a person is mid-conversation', 'u1');
    await waitFor(async () => gate.state.calls === 1, 'the live turn to reach the provider');

    assert.equal(outcome(await startSystemTurn('sst-b7', 'the first intent', { source: 'routine' })), 'parked');
    // Decision 9: overwriting silently destroys scheduled work, and queueing N
    // is a job queue. A refused caller is a scheduler that comes back next tick.
    assert.equal(
      outcome(await startSystemTurn('sst-b7', 'the second intent', { source: 'routine' })),
      'intent-standing',
    );
    await settle();
    assert.equal(
      (await AgentSessions.findOneAsync('sst-b7'))!.pendingSystem!.prompt, 'the first intent',
      'the standing intent is the one that was there first',
    );

    gate.release();
    await waitFor(() => finished('sst-b7', 2), 'the one standing intent to fire');
    await settle(600);

    assert.equal(await countRole('sst-b7', 'system'), 1, 'exactly one turn runs');
    assert.equal((await systemRow('sst-b7'))!.content, 'the first intent');
    assert.lengthOf(
      await AgentMessages.find({ sessionId: 'sst-b7', content: 'the second intent' }).fetchAsync(),
      0, 'the refused intent left no trace',
    );
    assert.equal((await AgentSessions.findOneAsync('sst-b7'))!.budgetSpent.systemTurns, 1);
  });

  it('B8: a human send does not cancel a standing intent — human first, system after', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    const gate = gatedProvider('the live reply');
    // eslint-disable-next-line no-new
    new Agent('st-b8', {
      model: 'mock', instructions: '', tools: [], provider: gate.provider,
    });
    await seedSolo('sst-b8', 'st-b8');

    await sendToSession('st-b8', 'sst-b8', 'the first human message', 'u1');
    await waitFor(async () => gate.state.calls === 1, 'the live turn to reach the provider');
    assert.equal(outcome(await startSystemTurn('sst-b8', 'the standing review', { source: 'routine' })), 'parked');
    const token = (await AgentSessions.findOneAsync('sst-b8'))!.pendingSystem!.token;

    // Decision 10, the deliberate asymmetry with decision 7: a relay is
    // cancelled by a human because the human is answering the same conversation
    // the relay was about. A standing intent is UNRELATED work that happens to
    // share a session; dropping it because somebody typed would make scheduled
    // work vanish at random.
    await sendToSession('st-b8', 'sst-b8', 'the second human message', 'u1');
    await settle();
    const afterSend = (await AgentSessions.findOneAsync('sst-b8'))!;
    assert.isDefined(afterSend.pendingSystem, 'a send does not clear a standing intent');
    assert.equal(afterSend.pendingSystem!.token, token, 'and does not replace it either');

    gate.release();
    await waitFor(() => systemTurnDone('sst-b8'), 'the intent to fire once the humans are served');

    const sys = (await systemRow('sst-b8'))!;
    const second = (await AgentMessages.findOneAsync({
      sessionId: 'sst-b8', content: 'the second human message',
    }))!;
    assert.isBelow(second.seq, sys.seq, 'the human is live; the intent waits its turn');
    const answeredHuman = await AgentMessages.find({
      sessionId: 'sst-b8', role: 'assistant', seq: { $gt: second.seq, $lt: sys.seq },
    }).countAsync();
    assert.isAtLeast(answeredHuman, 1, 'the interjection is answered BEFORE the system row lands');

    const doc = (await AgentSessions.findOneAsync('sst-b8'))!;
    assert.equal(doc.budgetSpent.turns, 2, 'two human sends spend the human purse');
    assert.equal(doc.budgetSpent.systemTurns, 1, 'and one system turn spends its own');
    assert.equal(await countRole('sst-b8', 'system'), 1);
  });

  it('B9: the watcher sweeps a stranded intent', async function () {
    this.timeout(40000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startWatcher } = await import('../server/watcher');
    const { AgentSessions } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-b9', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'swept up' })),
    });
    // Exactly what a crash between park and consume leaves behind: the marker
    // standing, the budget unspent, no row.
    await seedSolo('sst-b9', 'st-b9', {
      pendingSystem: strandedIntent('the stranded review', 'st-b9-token'),
    });

    const w = startWatcher({ sweepMs: 60, verdictGraceMs: 1000 });
    try {
      await waitFor(() => finished('sst-b9', 1), 'the sweep to pick up the stranded intent');
      const row = (await systemRow('sst-b9'))!;
      assert.equal(row.content, 'the stranded review');
      assert.deepEqual(row.from, { participant: 's:routine', name: 'routine' });
      assert.equal(
        row._id, 'sys:sst-b9:st-b9-token',
        'the row `_id` is derived, which is what makes a re-consume harmless',
      );
      const doc = (await AgentSessions.findOneAsync('sst-b9'))!;
      assert.isUndefined(doc.pendingSystem, 'consumed');
      assert.equal(doc.budgetSpent.systemTurns, 1, 'and billed only now that it ran');
    } finally {
      await w.stop();
    }
  });

  it('B10: the watcher leaves an awaiting session\'s intent alone', async function () {
    this.timeout(40000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startWatcher } = await import('../server/watcher');
    const { AgentSessions } = await import('../common/collections');

    // NO `budget.approval`, so the sweep's approval timeout can never be the
    // thing that moved this session.
    // eslint-disable-next-line no-new
    new Agent('st-b10', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'swept up' })),
    });
    await seedSolo('sst-b10-held', 'st-b10', {
      phase: 'awaiting',
      pending: {
        toolCallId: 'g9', name: 'refund', args: {},
        requestedAt: new Date(Date.now() - 600_000),
      },
      pendingSystem: strandedIntent('the held review', 'st-b10-token'),
    });
    // The CONTROL. Asserting an absence without proving the sweep that would
    // have caused it actually ran is how a green test hides a broken feature.
    await seedSolo('sst-b10-control', 'st-b10', {
      pendingSystem: strandedIntent('the control review', 'st-b10-control-token'),
    });

    const w = startWatcher({ sweepMs: 60, verdictGraceMs: 1000 });
    try {
      await waitFor(() => finished('sst-b10-control', 1), 'the sweep to consume the control intent');
      await settle(400);

      const held = (await AgentSessions.findOneAsync('sst-b10-held'))!;
      assert.equal(held.phase, 'awaiting', 'a live approval question is a human\'s to answer');
      assert.equal(held.pending!.toolCallId, 'g9', 'and its park is untouched');
      assert.isDefined(held.pendingSystem, 'the intent still stands');
      assert.equal(held.pendingSystem!.token, 'st-b10-token');
      assert.equal(await countRole('sst-b10-held', 'system'), 0, 'nothing materialized');
      assert.equal(await countRole('sst-b10-held', 'assistant'), 0, 'and no turn ran');
      assert.isUndefined(held.budgetSpent.systemTurns);
    } finally {
      await w.stop();
    }
  });

  it('B11: two watchers consume one intent exactly once', async function () {
    this.timeout(40000);
    const { Agent } = await import('../server/agent');
    const { startWatcher } = await import('../server/watcher');
    const { AgentSessions } = await import('../common/collections');

    let calls = 0;
    const slow: Provider = {
      async *stream() {
        calls += 1;
        // Hold the turn open across several ticks of BOTH watchers, so the
        // loser meets a session that is leased and running rather than one that
        // is already finished.
        await new Promise((r) => { setTimeout(r, 600); });
        yield { kind: 'text' as const, chunk: 'once' };
        yield { kind: 'done' as const, usage: { input: 1, output: 1 } };
      },
    };
    // eslint-disable-next-line no-new
    new Agent('st-b11', {
      model: 'mock', instructions: '', tools: [], provider: slow,
    });
    await seedSolo('sst-b11', 'st-b11', {
      pendingSystem: strandedIntent('the raced review', 'st-b11-token'),
    });

    const a = startWatcher({ sweepMs: 80, verdictGraceMs: 1000 });
    const b = startWatcher({ sweepMs: 80, verdictGraceMs: 1000 });
    try {
      await waitFor(
        async () => (await countRole('sst-b11', 'assistant')) === 1,
        'one of the two watchers to consume the intent',
      );
      // Both keep sweeping while this settles; a second consume would show up
      // as a second row, a second turn, or a second charge.
      await settle(600);
      assert.equal(await countRole('sst-b11', 'system'), 1, 'one row for one intent');
      assert.equal(await countRole('sst-b11', 'assistant'), 1, 'and one turn');
      assert.equal(calls, 1, 'and exactly one provider call');
      const doc = (await AgentSessions.findOneAsync('sst-b11'))!;
      assert.isUndefined(doc.pendingSystem);
      assert.equal(doc.budgetSpent.systemTurns, 1);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('B12: the loop\'s wind-down fires a parked intent with no watcher at all', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');
    const { watcher } = await import('../server/index');
    const { AgentSessions } = await import('../common/collections');

    // The in-process fast path, isolated: the boot watcher is disabled under
    // test (`UNDER_TEST` in server/index.ts) and this test starts none, so the
    // only thing that can consume the intent is the loop's own wind-down.
    assert.isNull(watcher, 'no boot watcher may be running, or this proves nothing');

    const gate = gatedProvider('the live reply');
    // eslint-disable-next-line no-new
    new Agent('st-b12', {
      model: 'mock', instructions: '', tools: [], provider: gate.provider,
    });
    await seedSolo('sst-b12', 'st-b12');

    await sendToSession('st-b12', 'sst-b12', 'a person is mid-conversation', 'u1');
    await waitFor(async () => gate.state.calls === 1, 'the live turn to reach the provider');
    assert.equal(outcome(await startSystemTurn('sst-b12', 'the parked review', { source: 'routine' })), 'parked');

    const t0 = Date.now();
    gate.release();
    await waitFor(() => finished('sst-b12', 2), 'the wind-down to consume the intent');
    assert.isBelow(
      Date.now() - t0, 10_000,
      'the wind-down is the fast path; the sweep is only the floor',
    );
    assert.equal((await systemRow('sst-b12'))!.content, 'the parked review');
    assert.isUndefined((await AgentSessions.findOneAsync('sst-b12'))!.pendingSystem);
  });

  it('B13: an intent older than the TTL is replaced by a fresh park', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');
    const { SYSTEM_INTENT_TTL_MS } = await import('../server/system-turn');
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // eslint-disable-next-line no-new
    new Agent('st-b13', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'reviewed' })),
    });
    // The state decision 11 exists to unstick: an intent parked into a session
    // that then halted, standing so long that — by decision 9 — it would refuse
    // every later firing forever.
    await seedSolo('sst-b13', 'st-b13', {
      pendingSystem: {
        prompt: 'the ancient review', source: 'stale', token: 'st-b13-old',
        at: new Date(Date.now() - SYSTEM_INTENT_TTL_MS - 60_000),
      },
    });

    // Contrast with B7, which proves a LIVE intent is refused: the replacement
    // here is the TTL's doing, not an unconditional overwrite.
    assert.equal(
      outcome(await startSystemTurn('sst-b13', 'the fresh review', { source: 'routine' })),
      'ran',
    );
    await waitFor(() => finished('sst-b13', 1), 'the replacing intent to run');
    await settle();

    assert.equal(await countRole('sst-b13', 'system'), 1, 'one row — the replacement, not both');
    const row = (await systemRow('sst-b13'))!;
    assert.equal(row.content, 'the fresh review');
    assert.deepEqual(row.from, { participant: 's:routine', name: 'routine' });
    assert.lengthOf(
      await AgentMessages.find({ sessionId: 'sst-b13', content: 'the ancient review' }).fetchAsync(),
      0, 'the stale intent is dropped, never materialized',
    );
    const doc = (await AgentSessions.findOneAsync('sst-b13'))!;
    assert.isUndefined(doc.pendingSystem);
    assert.equal(doc.budgetSpent.systemTurns, 1, 'one replacement, one charge');
  });
});
