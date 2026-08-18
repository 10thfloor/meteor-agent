import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import type { AgentMessage } from '../common/types';

/** Every unanswered `toolCalls[].id` in a transcript. A provider rejects a
 *  `tool_use` with no matching `tool_result` with a 400 on every retry, so an
 *  abandoned turn must never leave one behind. */
const unansweredToolUses = (msgs: AgentMessage[]): string[] => {
  const answered = new Set(
    msgs.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId),
  );
  return msgs
    .flatMap((m) => m.toolCalls ?? [])
    .map((c) => c.id)
    .filter((id) => !answered.has(id));
};

/** Deferred work (the resume a verdict schedules, the turn a send defers)
 *  exposes no promise to await, so every wait here is bounded by a deadline and
 *  fails loudly rather than hanging the suite. */
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

const seed = async (sessionId: string, text: string, agent = 'support') => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await AgentMessages.insertAsync({
    _id: 'u-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

describe('turn loop', () => {
  it('streams deltas then commits one assistant message', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s1', 'hello');
    await runTurn('s1', {
      model: 'mock', system: 'You are a test.', tools: [],
      provider: mockProvider(() => ({ text: 'hi there' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's1' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(msgs, 2);
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'hi there');

    // The committed message supersedes its deltas, which are removed at
    // commit — old sessions must not accumulate every token ever streamed.
    const remaining = await AgentDeltas.find({ sessionId: 's1' }).countAsync();
    assert.equal(remaining, 0, 'commit must clean up the deltas it supersedes');
  });

  it('reconstructs the same text from deltas as it commits', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mergeView } = await import('../common/merge');
    const { runTurn } = await import('../server/loop');

    await seed('s2', 'hello');
    // Deltas are removed at commit, so they must be captured DURING the
    // stream: after the last text chunk, wait past the flush interval, then
    // snapshot before yielding 'done'.
    let captured: any[] = [];
    const capturing: Provider = {
      async *stream() {
        for (const ch of 'streamed answer') yield { kind: 'text', chunk: ch };
        await new Promise((r) => setTimeout(r, 200)); // > flushMs: all flushed
        captured = await AgentDeltas.find({ sessionId: 's2' }).fetchAsync();
        yield { kind: 'done', usage: { input: 1, output: 15 } };
      },
    };
    await runTurn('s2', { model: 'mock', system: '', tools: [], provider: capturing });

    const committed = await AgentMessages.findOneAsync({ sessionId: 's2', role: 'assistant' });
    assert.isAbove(captured.length, 0, 'tokens should have streamed');
    assert.equal(captured[0].msgSeq, committed!.seq, 'deltas must carry the future seq');

    // mergeView walks back only while seq decrements by exactly 1, so a gap —
    // or a seq assigned out of push order — silently truncates the render.
    const seqs = captured.map((d) => d.seq).sort((a, b) => a - b);
    seqs.forEach((s, i) => assert.equal(s, i, 'delta seqs must be contiguous from 0'));

    const fromDeltas = mergeView([], captured).map((m) => m.content).join('');
    assert.equal(fromDeltas, committed!.content);
  });

  it('recovers the unwritten remainder when a delta insert throws mid-batch', async function () {
    this.timeout(30000);
    const { AgentDeltas, AgentMessages } = await import('../common/collections');
    const { mergeView } = await import('../common/merge');
    const { runTurn } = await import('../server/loop');

    await seed('s-delta-remainder', 'hello');

    // Alternate kinds so consecutive chunks do NOT coalesce — `DeltaWriter.push`
    // only merges a chunk into the previous buffered item when the kind
    // matches — giving the flush batch several distinct items to fail partway
    // through, per the brief's "same-kind chunks coalesce" note.
    const script: Array<{ kind: 'text' | 'thinking'; chunk: string }> = [
      { kind: 'thinking', chunk: 'a' },
      { kind: 'text', chunk: '1' },
      { kind: 'thinking', chunk: 'b' },
      { kind: 'text', chunk: '2' },
      { kind: 'thinking', chunk: 'c' },
      { kind: 'text', chunk: '3' },
    ];
    let captured: any[] = [];
    const staggered: Provider = {
      async *stream() {
        for (const c of script) yield c as any;
        // Same idiom as the 'reconstructs' test above: > flushMs, and long
        // enough for the interval's own retry (the injected failure below
        // fires only once, on the first flush attempt) to have landed before
        // we snapshot.
        await new Promise((r) => { setTimeout(r, 400); });
        captured = await AgentDeltas.find({ sessionId: 's-delta-remainder' }).fetchAsync();
        yield { kind: 'done', usage: { input: 1, output: 6 } };
      },
    };

    // Fail the SECOND insertAsync call exactly once — mid-batch, since all 6
    // chunks land in `this.buf` well before the first flush tick fires, so
    // the first flush's batch holds all of them.
    const original = (AgentDeltas as any).insertAsync.bind(AgentDeltas);
    const descriptor = Object.getOwnPropertyDescriptor(AgentDeltas, 'insertAsync');
    let calls = 0;
    let injected = false;
    (AgentDeltas as any).insertAsync = async (doc: any, ...rest: any[]) => {
      calls += 1;
      if (!injected && calls === 2) {
        injected = true;
        throw new Error('injected mid-batch delta failure');
      }
      return original(doc, ...rest);
    };

    try {
      await runTurn('s-delta-remainder', {
        model: 'mock', system: '', tools: [], provider: staggered,
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentDeltas, 'insertAsync', descriptor);
      else delete (AgentDeltas as any).insertAsync;
    }

    assert.isTrue(injected, 'the injected mid-batch failure must actually have fired');

    const committed = await AgentMessages
      .findOneAsync({ sessionId: 's-delta-remainder', role: 'assistant' });
    assert.equal(committed!.content, '123', 'the commit is built from in-memory text, unaffected');
    assert.equal(committed!.thinking, 'abc');

    assert.isAbove(
      captured.length, 1,
      'the flush batch must have had more than one item for a mid-batch failure to be meaningful',
    );
    const seqs = captured.map((d) => d.seq).sort((a, b) => a - b);
    seqs.forEach((s, i) => assert.equal(
      s, i, 'delta seqs must be complete and contiguous — a gap is where the failed insert '
      + 'would have been dropped without the remainder-recovery fix',
    ));

    const fromDeltas = mergeView([], captured);
    assert.lengthOf(fromDeltas, 1, 'all deltas belong to the one in-flight message');
    assert.equal(fromDeltas[0].content, '123');
    assert.equal(fromDeltas[0].thinking, 'abc');
  });

  it('sweeps crash-orphaned deltas on the next turn (repair-on-entry)', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-crash', 'hello');
    // A SIGKILL mid-stream leaves deltas under a messageId that was never
    // committed: discardTurn never ran, and nothing in mergeView suppresses
    // them — they render as a permanently-streaming ghost row at the SAME
    // msgSeq the retry will stream at. Repair-on-entry must sweep them.
    await AgentDeltas.insertAsync({
      _id: 'ghost-1', sessionId: 's-crash', messageId: 'never-committed',
      msgSeq: 1, seq: 0, kind: 'text', chunk: 'half an ans', at: new Date(),
    } as any);

    await runTurn('s-crash', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'clean retry' })),
    });

    const ghosts = await AgentDeltas
      .find({ sessionId: 's-crash', messageId: 'never-committed' }).countAsync();
    assert.equal(ghosts, 0, 'crash-orphaned deltas must be swept on entry');
    const committed = await AgentMessages
      .findOneAsync({ sessionId: 's-crash', role: 'assistant' });
    assert.equal(committed!.content, 'clean retry');
  });

  it('runs a tool call and feeds the result back', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s3', 'look it up');
    let call = 0;
    await runTurn('s3', {
      model: 'mock', system: '',
      tools: [{
        name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
        run: async () => ({ found: 42 }),
      }],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: 't1', name: 'lookup', args: {} }] }
          : { text: 'it is 42' };
      }),
    });

    const msgs = await AgentMessages.find({ sessionId: 's3' }, { sort: { seq: 1 } }).fetchAsync();
    const roles = msgs.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(msgs[3].content, 'it is 42');
    assert.equal(msgs[2].content, JSON.stringify({ found: 42 }));
  });

  it('commits nothing when the lease is stolen mid-stream', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s4', 'hello');

    // Another server steals the lease BETWEEN yields — after the turn is
    // underway. Stealing it before `runTurn` would make `claimLease` fail and
    // the loop return having exercised nothing at all.
    const stealer: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'should ' };
        await AgentSessions.updateAsync('s4', {
          $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
        } as any);
        yield { kind: 'text', chunk: 'not commit' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s4', { model: 'mock', system: '', tools: [], provider: stealer });

    assert.equal(
      await AgentMessages.find({ sessionId: 's4', role: 'assistant' }).countAsync(), 0,
      'no assistant message may commit once the lease is gone',
    );
    assert.equal(
      await AgentDeltas.find({ sessionId: 's4' }).countAsync(), 0,
      'orphaned deltas would render as a permanent streaming ghost row',
    );

    const msgs = await AgentMessages.find({ sessionId: 's4' }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });

  it('leaves no unanswered tool_use when the lease is stolen during a tool call', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s6', 'look it up');
    let call = 0;
    await runTurn('s6', {
      model: 'mock', system: '',
      tools: [{
        name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
        // The steal lands after the assistant(toolCalls) row is committed and
        // before its tool result can be written — the exact window that used
        // to strand a tool_use forever.
        run: async () => {
          await AgentSessions.updateAsync('s6', {
            $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
          } as any);
          return { found: 42 };
        },
      }],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: 't1', name: 'lookup', args: {} }] }
          : { text: 'it is 42' };
      }),
    });

    const msgs = await AgentMessages.find({ sessionId: 's6' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'an abandoned tool turn must not leave a tool_use the provider will 400 on',
    );
    assert.equal(
      msgs.filter((m) => m.role === 'assistant').length, 0,
      'the assistant row whose tool results never landed must be removed',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
    assert.equal(
      await AgentDeltas.find({ sessionId: 's6' }).countAsync(), 0,
      'the abandoned turn must take its deltas with it',
    );
  });

  it('discardTurn fails toward the repairable state when the LAST removal (the '
    + 'assistant row) throws', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Two calls in the batch, not one: 'first' dispatches and its `tool` row
    // actually lands in Mongo BEFORE the steal, so this test can tell whether
    // discardTurn reached the tool-row removal step (which targets the WHOLE
    // batch, landed results included — see discardTurn's docstring) before it
    // failed. A single-call batch never writes a real tool row here, so it
    // cannot distinguish "cleanup ran, then the last step failed" from
    // "nothing ran because a failure hit fast" — the two states this test
    // exists to tell apart.
    await seed('s-discard-order', 'look it up');
    let call = 0;

    // The assistant-row removal (`AgentMessages.removeAsync({ _id: messageId })`)
    // is the LAST of discardTurn's three removals, and the only one selected
    // by `_id` — the tool-row removal selects on toolCallId/seq, the delta
    // removal is a different collection entirely. Throw exactly once, on
    // that specific selector.
    const original = (AgentMessages as any).removeAsync.bind(AgentMessages);
    const descriptor = Object.getOwnPropertyDescriptor(AgentMessages, 'removeAsync');
    let injected = false;
    (AgentMessages as any).removeAsync = async (sel: any, ...rest: any[]) => {
      if (!injected && sel && typeof sel === 'object' && '_id' in sel) {
        injected = true;
        throw new Error('injected assistant-row removal failure');
      }
      return original(sel, ...rest);
    };

    try {
      await runTurn('s-discard-order', {
        model: 'mock', system: '',
        tools: [
          {
            name: 'first', description: 'x', args: { type: 'object', properties: {} },
            run: async () => ({ found: 1 }),
          },
          {
            name: 'second', description: 'x', args: { type: 'object', properties: {} },
            // The steal lands inside the SECOND call's own `run`, after the
            // first call's `tool` row already committed and after
            // assistant(toolCalls) itself is committed — the window that
            // drives `dispatchCalls` into `discardTurn`'s abandon() path.
            // Test-only failure injection: no production ordering changes.
            run: async () => {
              await AgentSessions.updateAsync('s-discard-order', {
                $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
              } as any);
              return { found: 2 };
            },
          },
        ],
        provider: mockProvider(() => {
          call += 1;
          return call === 1
            ? {
              toolCalls: [
                { id: 't1', name: 'first', args: {} },
                { id: 't2', name: 'second', args: {} },
              ],
            }
            : { text: 'never reached' };
        }),
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentMessages, 'removeAsync', descriptor);
      else delete (AgentMessages as any).removeAsync;
    }

    assert.isTrue(injected, 'the injected assistant-row removal failure must actually have fired');

    // REPAIRABLE state: cleanup is best-effort and swallows its own failure
    // (discardTurn's catch), so nothing here surfaces as a runTurn error. What
    // distinguishes "fail toward repairable" from "fail toward broken" is
    // BOTH of the following holding at once:
    //   - the assistant row still stands (it is removed LAST, so a failure
    //     there never reaches the removal at all) — the anchor
    //     `repairUnansweredToolUse` looks for;
    //   - the batch's already-landed `t1` result is GONE — discardTurn erases
    //     the tool rows for the WHOLE batch before ever attempting the
    //     assistant, so by the time the injected failure fires that cleanup
    //     has already happened. A reordering that removes the assistant
    //     FIRST would abort before ever reaching that removal, leaving `t1`'s
    //     answered row stranded next to a surviving assistant — silent
    //     double-cleanup debt a later repair does not re-check for.
    const afterFailure = await AgentMessages
      .find({ sessionId: 's-discard-order' }, { sort: { seq: 1 } }).fetchAsync();
    const strandedAssistant = afterFailure.find((m) => m.role === 'assistant');
    assert.isDefined(
      strandedAssistant, 'discardTurn must fail BEFORE the assistant row is removed — that is '
      + 'the whole point of removing it last',
    );
    assert.deepEqual(
      unansweredToolUses(afterFailure).sort(), ['t1', 't2'],
      'the assistant survives with the whole batch unanswered — the repairable shape',
    );
    assert.isUndefined(
      afterFailure.find((m) => m.role === 'tool' && m.toolCallId === 't1'),
      "the batch's already-landed t1 result must be erased along with the rest of the "
      + 'abandoned turn — cleanup must have run BEFORE the injected failure, which only '
      + 'holds if the assistant row is removed last',
    );

    // A subsequent recovery turn must repair it. Free the lease the tool's
    // `run` handed to 'other' first — that steal is what drove THIS run's
    // abandonment, not a claim this test means to keep contesting.
    await AgentSessions.updateAsync('s-discard-order', { $unset: { lease: 1 } } as any);
    await runTurn('s-discard-order', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const final = await AgentMessages
      .find({ sessionId: 's-discard-order' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(final), [],
      'the recovery turn must repair the stranded assistant away — no unanswered tool_use left',
    );
    assert.equal(final[final.length - 1].content, 'recovered', 'the recovery turn must complete');
  });

  it('repairs an unanswered tool_use left behind by a previous run', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Hand-seed what a crash between commit and tool dispatch leaves behind:
    // [user, assistant(toolCalls)] with no tool results, and a free lease.
    await seed('s7', 'look it up');
    await AgentMessages.insertAsync({
      _id: 'a-orphan', sessionId: 's7', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't-dead', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentDeltas.insertAsync({
      _id: 'd-orphan', sessionId: 's7', messageId: 'a-orphan', msgSeq: 1, seq: 0,
      kind: 'text', chunk: 'half an answer', at: new Date(),
    } as any);
    await AgentSessions.updateAsync('s7', { $set: { nextSeq: 2 } } as any);

    await runTurn('s7', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's7' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isUndefined(
      msgs.find((m) => m._id === 'a-orphan'), 'the dangling assistant must be repaired away',
    );
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.equal(msgs[msgs.length - 1].role, 'assistant', 'the recovery turn must complete');
    assert.equal(msgs[msgs.length - 1].content, 'recovered');
    assert.equal(
      await AgentDeltas.find({ messageId: 'a-orphan' }).countAsync(), 0,
      'the orphan deltas must go with the message that never got answered',
    );
  });

  it('repairs an assistant whose tool calls were only partially answered', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Parallel tool calls are the DEFAULT for Anthropic and OpenAI alike, so a
    // kill between the first and second result is the common crash, not an
    // exotic one. Tool rows carry a HIGHER seq than the assistant they answer,
    // so what it leaves behind ends in a `tool` row — a transcript that looks
    // healthy to anything that only inspects the tail, while `t2` stays
    // unanswered and 400s every provider call from here to forever.
    await seed('s8', 'look them both up');
    await AgentMessages.insertAsync({
      _id: 'a-partial', sessionId: 's8', seq: 1, role: 'assistant', content: '',
      toolCalls: [
        { id: 't1', name: 'lookup', args: {} },
        { id: 't2', name: 'lookup', args: {} },
      ],
      createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'tool-t1', sessionId: 's8', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ found: 1 }), createdAt: new Date(),
    } as any);
    await AgentSessions.updateAsync('s8', { $set: { nextSeq: 3 } } as any);

    await runTurn('s8', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's8' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'repair must scan the whole transcript, not just its tail',
    );
    assert.isUndefined(
      msgs.find((m) => m._id === 'a-partial'),
      'the half-answered assistant must be repaired away',
    );
    assert.isUndefined(
      msgs.find((m) => m._id === 'tool-t1'),
      'its landed partial answer must go with it, or it strands a tool_result',
    );
    assert.equal(msgs[msgs.length - 1].content, 'recovered', 'the recovery turn must complete');
  });

  it('scopes tool-call answered-detection to its own turn window, not the whole session', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // `t1` is answered once, at seq 2 — then reused, unanswered, by a LATER
    // assistant at seq 5. A session-wide "answered" set would see `t1` in the
    // set from the seq-2 tool row and never flag the seq-5 assistant: a
    // permanent 400 with no self-heal. Detection must be scoped to each
    // assistant's own (seq, next-assistant-seq) window.
    await seed('s10', 'look it up');
    await AgentMessages.insertAsync({
      _id: 'a1', sessionId: 's10', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'tool1', sessionId: 's10', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ found: 1 }), createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'a-done', sessionId: 's10', seq: 3, role: 'assistant', content: 'done',
      createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'u2', sessionId: 's10', seq: 4, role: 'user', content: 'again', createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'a2', sessionId: 's10', seq: 5, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentSessions.updateAsync('s10', { $set: { nextSeq: 6 } } as any);

    await runTurn('s10', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's10' }, { sort: { seq: 1 } }).fetchAsync();

    assert.isUndefined(
      msgs.find((m) => m._id === 'a2'),
      'the seq-5 assistant with an unanswered t1 must be repaired away',
    );
    assert.isDefined(
      msgs.find((m) => m._id === 'a1'),
      'the seq-1 assistant, whose t1 WAS answered inside its own window, must survive untouched',
    );
    assert.isDefined(
      msgs.find((m) => m._id === 'tool1'),
      'the seq-2 tool row that answered seq-1 must survive untouched',
    );
    assert.equal(msgs[msgs.length - 1].content, 'recovered', 'the recovery turn must complete');
  });

  it('does not dispatch a second tool once the lease is gone', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s9', 'look them both up');
    let ranSecond = false;

    // The takeover has to land AFTER the first result commits. Stealing from
    // inside the first tool's `run` trips the post-hoc `guardedUpdate` instead
    // — the branch the s6 test above already covers — and the loop returns
    // before a second dispatch ever happens. Both guards test the identical
    // lease predicate, so the only way to reach the pre-flight `holdsLease` is
    // for another server to take over in the window between one tool result
    // landing and the next dispatch. Hooking the insert puts the steal exactly
    // there, with no timing race.
    const original = (AgentMessages as any).insertAsync.bind(AgentMessages);
    const descriptor = Object.getOwnPropertyDescriptor(AgentMessages, 'insertAsync');
    (AgentMessages as any).insertAsync = async (doc: any, ...rest: any[]) => {
      const id = await original(doc, ...rest);
      if (doc.role === 'tool' && doc.toolCallId === 't1') {
        await AgentSessions.updateAsync('s9', {
          $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
        } as any);
      }
      return id;
    };

    try {
      let call = 0;
      await runTurn('s9', {
        model: 'mock', system: '',
        tools: [
          {
            name: 'first', description: 'x', args: { type: 'object', properties: {} },
            run: async () => ({ found: 1 }),
          },
          {
            name: 'second', description: 'x', args: { type: 'object', properties: {} },
            run: async () => { ranSecond = true; return { found: 2 }; },
          },
        ],
        provider: mockProvider(() => {
          call += 1;
          return call === 1
            ? {
              toolCalls: [
                { id: 't1', name: 'first', args: {} },
                { id: 't2', name: 'second', args: {} },
              ],
            }
            : { text: 'never reached' };
        }),
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentMessages, 'insertAsync', descriptor);
      else delete (AgentMessages as any).insertAsync;
    }

    assert.isFalse(
      ranSecond,
      'a tool is a real side effect — it must not run under a lease we no longer hold',
    );
    const msgs = await AgentMessages.find({ sessionId: 's9' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'abandoning at the pre-flight must still take the whole turn with it',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });

  it('sets phase back to idle and releases the lease when done', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s5', 'hello');
    await runTurn('s5', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'done' })),
    });

    const doc = await AgentSessions.findOneAsync('s5');
    assert.equal(doc!.phase, 'idle');
    assert.isUndefined(doc!.lease);
  });

  it('honors an interrupt mid-stream: no commit, no ghost deltas, phase stays stopped', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-int', 'hello');
    // The interrupt lands between chunks, exactly as agent.interrupt would:
    // phase flips to 'stopped' while the provider is mid-response.
    const interrupting: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'should ' };
        await new Promise((r) => setTimeout(r, 30));
        await AgentSessions.updateAsync('s-int', { $set: { phase: 'stopped' } } as any);
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'text', chunk: 'never ' };
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'text', chunk: 'commit' };
        yield { kind: 'done', usage: { input: 1, output: 3 } };
      },
    };

    await runTurn('s-int', {
      model: 'mock', system: '', tools: [],
      provider: interrupting, interruptCheckMs: 5,
    });

    const assistants = await AgentMessages
      .find({ sessionId: 's-int', role: 'assistant' }).countAsync();
    assert.equal(assistants, 0, 'an interrupted stream must not commit');
    const deltas = await AgentDeltas.find({ sessionId: 's-int' }).countAsync();
    assert.equal(deltas, 0, 'an interrupted stream must clean up its deltas');
    const doc = await AgentSessions.findOneAsync('s-int');
    assert.equal(doc!.phase, 'stopped', 'the finally must preserve the stop');
  });

  it('an interrupt aborts the provider request, not just the consuming loop', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-abort', 'hello');
    // Breaking out of the for-await only stops CONSUMING the stream: the HTTP
    // request behind it keeps arriving and the provider keeps billing the
    // whole response. The signal is the only thing that reaches the provider,
    // so the provider is what has to observe it flip.
    let signal: AbortSignal | undefined;
    let abortedWhileStreaming: boolean | undefined;
    const observing: Provider = {
      async *stream(req) {
        signal = req.signal;
        abortedWhileStreaming = req.signal?.aborted;
        yield { kind: 'text', chunk: 'should ' };
        await new Promise((r) => setTimeout(r, 30));
        await AgentSessions.updateAsync('s-abort', { $set: { phase: 'stopped' } } as any);
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'text', chunk: 'never commit' };
        yield { kind: 'done', usage: { input: 1, output: 3 } };
      },
    };

    await runTurn('s-abort', {
      model: 'mock', system: '', tools: [], provider: observing, interruptCheckMs: 5,
    });

    assert.isDefined(signal, 'the loop must hand the provider a signal to honor');
    assert.isFalse(abortedWhileStreaming, 'the signal starts live');
    assert.isTrue(signal!.aborted, 'an interrupt must abort the in-flight request');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-abort', role: 'assistant' }).countAsync(), 0,
      'an aborted stream must not commit',
    );
    assert.equal((await AgentSessions.findOneAsync('s-abort'))!.phase, 'stopped');
  });

  it('interrupt during tool dispatch discards the turn instead of stranding tool_use', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-int2', 'do two things');
    let secondToolRan = false;
    let call = 0;

    await runTurn('s-int2', {
      model: 'mock', system: '',
      tools: [
        {
          name: 'first', description: 'x', args: { type: 'object', properties: {} },
          run: async () => {
            // Interrupt lands while tool 1 runs; tool 2 must never dispatch.
            await AgentSessions.updateAsync('s-int2', { $set: { phase: 'stopped' } } as any);
            return 'one';
          },
        },
        {
          name: 'second', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { secondToolRan = true; return 'two'; },
        },
      ],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [
              { id: 'i1', name: 'first', args: {} },
              { id: 'i2', name: 'second', args: {} },
            ] }
          : { text: 'unreachable' };
      }),
    });

    assert.isFalse(secondToolRan, 'the second tool must not run after an interrupt');
    const msgs = await AgentMessages
      .find({ sessionId: 's-int2' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no stranded tool_use after interrupt');
    assert.equal(
      msgs[msgs.length - 1].role, 'user',
      'the discarded turn must leave the transcript resumable',
    );
  });

  it('a send landing mid-stream never duplicates a seq', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // Methods are already registered by the package's own Meteor.startup —
    // registering again throws "already defined". Registry entries, by
    // contrast, live in a Map and overwrite cleanly.
    // mSend resolves its config from the registry; the deferred runTurn it
    // schedules hits the in-process running guard and returns immediately.
    new Agent('support', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'unused' })),
    });

    await seed('s-race', 'first message');
    const sendHandler = (Meteor.server as any).method_handlers[NAMES.mSend];

    // The provider injects a REAL agent.send between yields — the exact
    // interleaving that used to hand the user message and the streaming
    // assistant the same seq (both read nextSeq before either $inc'd it).
    // One-shot: the loop answers the interjection with a SECOND iteration,
    // which calls the provider again.
    let injected = false;
    const racing: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'reply ' };
        if (!injected) {
          injected = true;
          await sendHandler.call({ userId: 'u1' }, 'support', 's-race', 'second message');
        }
        yield { kind: 'text', chunk: 'text' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s-race', {
      model: 'mock', system: '', tools: [], provider: racing,
    });

    const msgs = await AgentMessages
      .find({ sessionId: 's-race' }, { sort: { seq: 1 } }).fetchAsync();
    const seqs = msgs.map((m) => m.seq);
    assert.equal(new Set(seqs).size, seqs.length,
      `every message must own a unique seq, got [${seqs.join(', ')}]`);
    assert.lengthOf(
      msgs.filter((m) => m.role === 'user' && m.content === 'second message'), 1,
      'the mid-stream send must be committed, not lost',
    );
    // The interjection must be ANSWERED, not merely committed: the loop
    // notices a user message it never saw and runs another iteration instead
    // of ending the turn. Two user messages, two assistant replies, and the
    // final message is the answer.
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 2,
      'the mid-stream send must be answered by a second iteration');
    assert.equal(msgs[msgs.length - 1].role, 'assistant');
  });

  it('rejects send and interrupt against a session the caller does not own', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    new Agent('authtest', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
    });
    // Registered so the wrong-agent case below fails on session lookup
    // ('no-session'), not on registry lookup ('no-agent').
    new Agent('authtest-other', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
    });

    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({
      _id: 'auth-s1', agent: 'authtest', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    const interrupt = (Meteor.server as any).method_handlers[NAMES.mInterrupt];

    const rejects = async (fn: () => Promise<unknown>, label: string) => {
      try { await fn(); } catch (e: any) {
        assert.equal(e.error, 'no-session', label);
        return;
      }
      assert.fail(`${label}: expected no-session, but the call succeeded`);
    };

    // Another user and an anonymous caller are both strangers to this session.
    await rejects(() => send.call({ userId: 'u2' }, 'authtest', 'auth-s1', 'hi'), 'send as other user');
    await rejects(() => send.call({ userId: null }, 'authtest', 'auth-s1', 'hi'), 'send as anonymous');
    await rejects(() => interrupt.call({ userId: 'u2' }, 'authtest', 'auth-s1'), 'interrupt as other user');
    // The wrong AGENT name is a stranger too, even for the owner.
    await rejects(() => send.call({ userId: 'u1' }, 'authtest-other', 'auth-s1', 'hi'), 'send via wrong agent');
    // And the owner through the right agent works.
    const sid = await send.call({ userId: 'u1' }, 'authtest', 'auth-s1', 'hello');
    assert.equal(sid, 'auth-s1');
  });

  it('a send clears a stranded error phase and the deferred turn recovers', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    new Agent('recover', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    // The state a fatal provider failure leaves behind: a terminal `error`
    // phase and a note explaining it. §10's position is that the model usually
    // recovers, so a send is the resume signal — and clearing the phase is what
    // makes it one.
    await seed('s-error-clear', 'first message', 'recover');
    await AgentMessages.insertAsync({
      _id: 'err-note', sessionId: 's-error-clear', seq: 1, role: 'note', kind: 'error',
      error: { error: 'provider-failed', reason: 'The model request failed.' },
      createdAt: new Date(),
    } as any);
    await AgentSessions.updateAsync(
      { _id: 's-error-clear' } as any,
      { $set: { phase: 'error', nextSeq: 2 } } as any,
    );

    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'recover', 's-error-clear', 'try again');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-error-clear', role: 'assistant' }).countAsync()) === 1,
      'the deferred turn to answer the send that cleared the error',
    );

    // The phase is the whole point. The loop's `finally` treats `error` as
    // terminal and PRESERVES it, so without mSend's conditional clear this
    // session would answer perfectly while still displaying a failure forever —
    // and a UI keying its retry affordance off `phase === 'error'` would offer
    // to retry a turn that already succeeded.
    const doc = (await AgentSessions.findOneAsync('s-error-clear'))!;
    assert.equal(doc.phase, 'idle', 'a send must clear the error phase it recovered from');

    const msgs = await AgentMessages
      .find({ sessionId: 's-error-clear' }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(msgs[msgs.length - 1].content, 'recovered');
    // Clearing the phase is not rewriting history: the failure note stays in
    // the transcript, and both user messages are still there.
    assert.isDefined(await AgentMessages.findOneAsync('err-note'));
    assert.lengthOf(msgs.filter((m) => m.role === 'user'), 2);
  });

  it('retries a retryable provider failure and then succeeds', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry', 'hello');
    let attempts = 0;
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        if (attempts < 3) { const e: any = new Error('rate limited'); e.status = 429; throw e; }
        yield { kind: 'text', chunk: 'recovered' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    await runTurn('s-retry', { model: 'mock', system: '', tools: [], provider: flaky, retry: { attempts: 3, baseMs: 10 } });
    assert.equal(attempts, 3);
    const committed = await AgentMessages.findOneAsync({ sessionId: 's-retry', role: 'assistant' });
    assert.equal(committed!.content, 'recovered');
    assert.equal((await AgentSessions.findOneAsync('s-retry'))!.phase, 'idle');
  });

  it('does not retry a fatal provider error and surfaces a sanitized note', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-fatal', 'hello');
    let attempts = 0;
    const broken: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() { attempts += 1; const e: any = new Error('invalid x-api-key sk-SECRET'); e.status = 401; throw e; },
    };
    await runTurn('s-fatal', { model: 'mock', system: '', tools: [], provider: broken, retry: { attempts: 3, baseMs: 10 } });
    assert.equal(attempts, 1, 'a 401 must not be retried');
    const note = await AgentMessages.findOneAsync({ sessionId: 's-fatal', role: 'note', kind: 'error' } as any);
    assert.isDefined(note);
    assert.notInclude(JSON.stringify(note), 'SECRET', 'raw provider messages must never reach the transcript');
    assert.equal((await AgentSessions.findOneAsync('s-fatal'))!.phase, 'error');
  });

  it('exhausted retries also produce an error note, and no partial commit', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-exhaust', 'hello');
    const alwaysDown: Provider = {
      async *stream() { yield { kind: 'text', chunk: 'par' }; const e: any = new Error('boom'); e.status = 503; throw e; },
    };
    await runTurn('s-exhaust', { model: 'mock', system: '', tools: [], provider: alwaysDown, retry: { attempts: 2, baseMs: 10 } });
    assert.equal(await AgentMessages.find({ sessionId: 's-exhaust', role: 'assistant' }).countAsync(), 0);
    assert.equal(await AgentDeltas.find({ sessionId: 's-exhaust' }).countAsync(), 0, 'partial deltas cleaned per attempt');
    assert.isDefined(await AgentMessages.findOneAsync({ sessionId: 's-exhaust', role: 'note', kind: 'error' } as any));
    assert.equal((await AgentSessions.findOneAsync('s-exhaust'))!.phase, 'error');
  });

  it('a stop landing during a failed attempt outranks the retry', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions, AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-stop-retry', 'hello');
    let attempts = 0;
    // The shape a 429/503 actually takes: the stream throws BEFORE yielding a
    // single chunk, so the in-stream interrupt check never runs even once.
    // The user's stop therefore reaches the retry branch and nowhere else —
    // and the retry branch is the only place left that can honor it.
    const saboteur: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        attempts += 1;
        await AgentSessions.updateAsync('s-stop-retry', {
          $set: { phase: 'stopped', updatedAt: new Date() },
        } as any);
        const e: any = new Error('rate limited'); e.status = 429; throw e;
      },
    };

    await runTurn('s-stop-retry', {
      model: 'mock', system: '', tools: [], provider: saboteur,
      retry: { attempts: 3, baseMs: 10 },
    });

    assert.equal(attempts, 1, 'a stop must prevent the retry entirely');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-stop-retry', role: 'assistant' }).countAsync(), 0,
      'a cancelled turn must never commit an assistant message',
    );
    assert.equal(
      await AgentMessages.find({ sessionId: 's-stop-retry', role: 'note' } as any).countAsync(), 0,
      'a stop outranks the error note too — the user cancelled, nothing failed at them',
    );
    assert.equal(await AgentDeltas.find({ sessionId: 's-stop-retry' }).countAsync(), 0);
    assert.equal((await AgentSessions.findOneAsync('s-stop-retry'))!.phase, 'stopped',
      'retry must not overwrite the stop with `retrying`/`error`');
  });

  it('treats an aborted stream as abandon: no retry, no error note, no commit', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-abandon', 'hello');
    let attempts = 0;
    // The shape an aborted request takes once the signal fires: the stream
    // rejects with an AbortError rather than an HTTP status. It is a
    // deliberate stop, so it must NOT retry — a retry re-issues the very
    // request that was just cancelled, at full price — and must NOT write a
    // failure note at the user, because nothing failed at them.
    const aborting: Provider = {
      async *stream() {
        attempts += 1;
        yield { kind: 'text', chunk: 'par' };
        const e: any = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
    };
    await runTurn('s-abandon', {
      model: 'mock', system: '', tools: [], provider: aborting,
      retry: { attempts: 3, baseMs: 10 },
    });

    assert.equal(attempts, 1, 'an abort must never be retried');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-abandon', role: 'note' } as any).countAsync(), 0,
      'an abort is a cancellation, not a provider failure to report',
    );
    assert.equal(
      await AgentMessages.find({ sessionId: 's-abandon', role: 'assistant' }).countAsync(), 0,
    );
    assert.equal(
      await AgentDeltas.find({ sessionId: 's-abandon' }).countAsync(), 0,
      'the abandoned attempt must take its deltas with it, exactly as an interrupt does',
    );
    assert.notEqual(
      (await AgentSessions.findOneAsync('s-abandon'))!.phase, 'error',
      'nothing failed, so the turn must not end in the failure phase',
    );

    // And when the abort followed the user's own stop, the stop is what
    // survives — the same terminal state the interrupt path leaves behind.
    await seed('s-abandon-stop', 'hello');
    const stoppedAbort: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await AgentSessions.updateAsync('s-abandon-stop', {
          $set: { phase: 'stopped', updatedAt: new Date() },
        } as any);
        const e: any = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
    };
    await runTurn('s-abandon-stop', {
      model: 'mock', system: '', tools: [], provider: stoppedAbort,
      retry: { attempts: 3, baseMs: 10 },
    });
    assert.equal((await AgentSessions.findOneAsync('s-abandon-stop'))!.phase, 'stopped');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-abandon-stop', role: 'note' } as any).countAsync(), 0,
    );
  });

  it('shows phase `retrying` between attempts', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry-phase', 'hello');
    let attempts = 0;
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        if (attempts === 1) { const e: any = new Error('down'); e.status = 503; throw e; }
        yield { kind: 'text', chunk: 'back up' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    // `retrying` is only observable BETWEEN attempts, and full jitter draws
    // the backoff from [0, cap] — so a fixed-period sampler races a window
    // that can legitimately be ~0ms (the original 15ms poll flaked ~1-in-4).
    // An observeChangesAsync observer is NOT the answer here: the
    // test-environment mongod is standalone, so Meteor's observer falls back
    // to the POLLING driver, which diffs ~10s snapshots and coalesces
    // transient states away entirely (verified: it saw only [idle], three
    // runs out of three). So the WINDOW is pinned instead, through the
    // loop's own test seam: a deterministic full-cap delay makes 120ms of
    // `retrying` a certainty for a 15ms sampler, with no global
    // Math.random patching.
    const { _setBackoff } = await import('../server/loop');
    const restoreBackoff = _setBackoff(
      (i: number, base: number, max: number) => Math.min(max, base * 2 ** i),
    );
    const seenPhases = new Set<string>();
    const sampler = setInterval(() => {
      void AgentSessions.findOneAsync('s-retry-phase')
        .then((s) => { if (s) seenPhases.add(s.phase); })
        .catch(() => { /* sampling is best-effort */ });
    }, 15);
    try {
      await runTurn('s-retry-phase', {
        model: 'mock', system: '', tools: [], provider: flaky,
        retry: { attempts: 2, baseMs: 120 },
      });
    } finally {
      restoreBackoff();
      clearInterval(sampler);
    }

    assert.equal(attempts, 2);
    assert.isTrue(seenPhases.has('retrying'),
      `the retry must be visible to the client, saw [${[...seenPhases].join(', ')}]`);
    // No duration assertion: full jitter draws the delay from [0, cap], so a
    // legitimate backoff can be ~0ms and any floor here is a flake generator.
    // The delay itself is pinned by `backoffDelay()`'s own test below.
    const committed = await AgentMessages.findOneAsync({ sessionId: 's-retry-phase', role: 'assistant' });
    assert.equal(committed!.content, 'back up');
  });

  it('streams every attempt under a fresh messageId', async function () {
    this.timeout(30000);
    const { AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry-ids', 'hello');
    let attempts = 0;
    let firstAttemptIds: string[] = [];
    let secondAttemptDeltas: any[] = [];
    // Same mid-stream capture idiom as the 'reconstructs' test: deltas are
    // removed the moment an attempt ends, so they must be read from inside
    // the stream, after a wait longer than the flush interval.
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        yield { kind: 'text', chunk: 'partial ' };
        yield { kind: 'text', chunk: 'answer' };
        await new Promise((r) => { setTimeout(r, 200); });
        const live = await AgentDeltas.find({ sessionId: 's-retry-ids' }).fetchAsync();
        if (attempts === 1) {
          firstAttemptIds = [...new Set(live.map((d: any) => d.messageId))];
          const e: any = new Error('down'); e.status = 503; throw e;
        }
        secondAttemptDeltas = live;
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s-retry-ids', {
      model: 'mock', system: '', tools: [], provider: flaky,
      retry: { attempts: 2, baseMs: 10 },
    });

    assert.isAbove(firstAttemptIds.length, 0, 'attempt 1 should have streamed deltas');
    assert.isAbove(secondAttemptDeltas.length, 0, 'attempt 2 should have streamed deltas');
    const dead = new Set(firstAttemptIds);
    secondAttemptDeltas.forEach((d: any) => assert.isFalse(
      dead.has(d.messageId),
      'a retry must stream under a fresh messageId, or a straggler flush from '
      + 'the dead attempt lands under the live one',
    ));
    assert.equal(
      secondAttemptDeltas.filter((d: any) => dead.has(d.messageId)).length
      + (await AgentDeltas.find({ messageId: { $in: [...dead] } } as any).countAsync()),
      0, 'no delta from the failed attempt may survive',
    );
  });
});

describe('approval gates', () => {
  /**
   * Register an agent, seed a session for it, and run one turn whose first
   * provider response asks for `calls`. Registration is load-bearing: approve
   * and deny resume through the REGISTRY config, exactly as a real caller
   * would, so the tools and provider the method finds have to be the same
   * objects this fixture drives the initial park with.
   */
  const buildFixture = async (
    sessionId: string,
    agentName: string,
    calls: Array<{ id: string; name: string; gate: 'auto' | 'ask' }>,
    extra: Record<string, unknown> = {},
  ) => {
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    const state = { ran: [] as string[], providerCalls: 0 };
    const provider = mockProvider(() => {
      state.providerCalls += 1;
      return state.providerCalls === 1
        ? { toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: { amt: 5 } })) }
        : { text: 'all done' };
    });
    const tools = calls.map((c) => ({
      name: c.name,
      description: 'x',
      gate: c.gate,
      args: { type: 'object', properties: {} },
      run: async () => { state.ran.push(c.name); return { did: c.name }; },
    }));

    new Agent(agentName, {
      model: 'mock', instructions: '', tools, provider, ...extra,
    } as any);
    await seed(sessionId, 'refund please', agentName);
    await runTurn(sessionId, { model: 'mock', system: '', tools, provider });
    return state;
  };

  it('parks on an ask-gated tool: pending set, lease released, nothing dispatched', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { mockProvider } = await import('../server/providers/mock');

    await seed('s-gate', 'refund please');
    let toolRan = false;
    await runTurn('s-gate', {
      model: 'mock',
      system: '',
      tools: [{
        name: 'refund',
        description: 'x',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { toolRan = true; return 'refunded'; },
      }],
      provider: mockProvider(() => ({ toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] })),
    });

    assert.isFalse(toolRan, 'an ask-gated tool must not run before a human answers');
    const doc = (await AgentSessions.findOneAsync('s-gate'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.deepInclude(doc.pending as any, { toolCallId: 'g1', name: 'refund' });
    assert.isUndefined(doc.lease, 'a parked run holds no lease');

    // The assistant carrying the tool_use is COMMITTED — it is legitimate
    // history, and the thing the human is being asked to approve.
    const assistant = await AgentMessages.findOneAsync({ sessionId: 's-gate', role: 'assistant' });
    assert.isDefined(assistant);
    assert.isDefined(assistant!.toolCalls);
    assert.equal(assistant!.toolCalls![0].id, 'g1');
    // No result row: the batch is deliberately unanswered while parked.
    assert.equal(await AgentMessages.find({ sessionId: 's-gate', role: 'tool' }).countAsync(), 0);
  });

  it('approve wakes the run, executes the parked tool, and continues the turn', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-approve', 'gate-approve', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    assert.equal((await AgentSessions.findOneAsync('s-approve'))!.phase, 'awaiting');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-approve', 's-approve');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-approve', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to produce a final assistant reply',
    );

    assert.deepEqual(state.ran, ['refund'], 'approval must run the tool exactly once');
    const msgs = await AgentMessages
      .find({ sessionId: 's-approve' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no tool_use may be left stranded');

    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the approved call must be answered');
    assert.isUndefined(row.error);
    assert.equal(row.content, JSON.stringify({ did: 'refund' }));

    const note = msgs.find((m) => m.role === 'note' && (m as any).kind === 'approval') as any;
    assert.isDefined(note, 'the verdict belongs in the transcript');
    assert.isTrue(note.approved);
    assert.equal(note.by, 'u1');
    assert.isUndefined(note.content, 'notes carry structured fields, not prose');

    const doc = (await AgentSessions.findOneAsync('s-approve'))!;
    assert.isUndefined(doc.pending, 'the marker must be cleared once resolved');
    assert.equal(doc.phase, 'idle');
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('deny writes a denied tool result the model can see, and continues', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-deny', 'gate-deny', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const deny = (Meteor.server as any).method_handlers[NAMES.mDeny];
    await deny.call({ userId: 'u1' }, 'gate-deny', 's-deny', 'too large');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-deny', role: 'assistant' }).countAsync()) === 2,
      'the denied turn to continue rather than wedge',
    );

    assert.deepEqual(state.ran, [], 'a denied tool must never run');
    const msgs = await AgentMessages
      .find({ sessionId: 's-deny' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), []);

    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the model must SEE the refusal, not just miss a result');
    assert.deepEqual(row.error, { error: 'denied', reason: 'too large' });
    assert.include(row.content!, 'denied');

    const note = msgs.find((m) => m.role === 'note' && (m as any).kind === 'approval') as any;
    assert.isFalse(note.approved);
    assert.equal(note.reason, 'too large');

    const doc = (await AgentSessions.findOneAsync('s-deny'))!;
    assert.isUndefined(doc.pending);
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('a parked run survives repair-on-entry untouched', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { getAgent } = await import('../server/registry');

    await buildFixture('s-park-repair', 'gate-repair', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    const config = getAgent('gate-repair')!;

    // Re-entering with no verdict is the recovering-server case: repair must
    // read `pending`/`awaiting` as legitimate history, not as an abandoned
    // turn, and the loop must exit still parked rather than re-streaming over
    // an unanswered tool_use.
    await runTurn('s-park-repair', {
      model: 'mock', system: '', tools: config.tools ?? [], provider: config.provider!,
    });

    const msgs = await AgentMessages
      .find({ sessionId: 's-park-repair' }, { sort: { seq: 1 } }).fetchAsync();
    const assistants = msgs.filter((m) => m.role === 'assistant');
    assert.lengthOf(assistants, 1, 'repair must not discard the parked assistant');
    assert.equal(assistants[0].toolCalls![0].id, 'g1');
    assert.deepEqual(
      unansweredToolUses(msgs), ['g1'],
      'the unanswered call is the REQUEST — it must survive until a human answers',
    );

    const doc = (await AgentSessions.findOneAsync('s-park-repair'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.deepInclude(doc.pending as any, { toolCallId: 'g1' });
    assert.isUndefined((doc.pending as any).verdict);
    assert.isUndefined(doc.lease);
  });

  it('approving one call of a mixed batch still answers the auto-gated rest', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // The park happens at call 1, so call 2 was never dispatched. Resuming
    // ONLY call 1 would leave `g2` a stranded tool_use — a permanent 400.
    const state = await buildFixture('s-batch-mixed', 'gate-mixed', [
      { id: 'g1', name: 'refund', gate: 'ask' },
      { id: 'g2', name: 'logit', gate: 'auto' },
    ]);
    assert.deepEqual(state.ran, [], 'the park precedes every dispatch in the batch');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-mixed', 's-batch-mixed');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-batch-mixed', role: 'assistant' }).countAsync()) === 2,
      'the resumed batch to finish and the think loop to reply',
    );

    assert.deepEqual(state.ran, ['refund', 'logit'], 'the whole batch must run, in order');
    const msgs = await AgentMessages
      .find({ sessionId: 's-batch-mixed' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'the rest of the batch must be answered, not stranded',
    );
    assert.lengthOf(msgs.filter((m) => m.role === 'tool'), 2);
    assert.isUndefined((await AgentSessions.findOneAsync('s-batch-mixed'))!.pending);
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('approving one call of an all-gated batch parks again on the next gate', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-batch-gated', 'gate-both', [
      { id: 'g1', name: 'refund', gate: 'ask' },
      { id: 'g2', name: 'escalate', gate: 'ask' },
    ]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-both', 's-batch-gated');

    // Each remaining call is re-gated on its OWN declaration: approving g1
    // says nothing about g2.
    await waitFor(
      async () => {
        const s = await AgentSessions.findOneAsync('s-batch-gated');
        return (s?.pending as any)?.toolCallId === 'g2';
      },
      'the second gate to park',
    );

    assert.deepEqual(state.ran, ['refund'], 'only the approved call may run');
    let doc = (await AgentSessions.findOneAsync('s-batch-gated'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.isUndefined((doc.pending as any).verdict, 'the re-park must carry no verdict');
    assert.isUndefined(doc.lease, 'the re-parked run holds no lease either');
    let msgs = await AgentMessages
      .find({ sessionId: 's-batch-gated' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), ['g2']);
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 1, 'the think loop must not run yet');

    // And the second verdict finishes the batch.
    await approve.call({ userId: 'u1' }, 'gate-both', 's-batch-gated');
    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-batch-gated', role: 'assistant' }).countAsync()) === 2,
      'the second approval to finish the batch and continue the turn',
    );

    assert.deepEqual(state.ran, ['refund', 'escalate']);
    msgs = await AgentMessages
      .find({ sessionId: 's-batch-gated' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no stranded tool_use at any exit');
    doc = (await AgentSessions.findOneAsync('s-batch-gated'))!;
    assert.isUndefined(doc.pending);
    assert.lengthOf(msgs.filter((m) => m.role === 'note' && (m as any).kind === 'approval'), 2);
  });

  it('rejects approve and deny from a non-owner and from an anonymous caller', async function () {
    this.timeout(30000);
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    await buildFixture('s-auth', 'gate-auth', [{ id: 'g1', name: 'refund', gate: 'ask' }]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    const deny = (Meteor.server as any).method_handlers[NAMES.mDeny];
    const rejects = async (fn: () => Promise<unknown>, code: string, label: string) => {
      try { await fn(); } catch (e: any) {
        assert.equal(e.error, code, label);
        return;
      }
      assert.fail(`${label}: expected ${code}, but the call succeeded`);
    };

    await rejects(() => approve.call({ userId: 'u2' }, 'gate-auth', 's-auth'), 'no-session', 'approve as other user');
    await rejects(() => approve.call({ userId: null }, 'gate-auth', 's-auth'), 'no-session', 'approve as anonymous');
    await rejects(() => deny.call({ userId: 'u2' }, 'gate-auth', 's-auth', 'no'), 'no-session', 'deny as other user');
    await rejects(() => deny.call({ userId: null }, 'gate-auth', 's-auth', 'no'), 'no-session', 'deny as anonymous');
  });

  it('rejects approve when nothing is pending', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    new Agent('gate-nopending', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'unused' })),
    });
    await seed('s-nopending', 'hello', 'gate-nopending');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-nopending', 's-nopending');
    } catch (e: any) {
      assert.equal(e.error, 'no-pending');
      return;
    }
    assert.fail('approving an idle session must not succeed');
  });

  it('lets exactly one of two racing approvers win', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-race-approve', 'gate-race', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    // Both callers read the parked state before either writes: the verdict
    // write is what has to break the tie, not the pre-check.
    const results = await Promise.allSettled([
      approve.call({ userId: 'u1' }, 'gate-race', 's-race-approve'),
      approve.call({ userId: 'u1' }, 'gate-race', 's-race-approve'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.lengthOf(won, 1, 'exactly one approver may win');
    assert.lengthOf(lost, 1, 'the loser gets an error, never a silent success');
    assert.equal((lost[0] as PromiseRejectedResult).reason.error, 'no-pending');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-race-approve', role: 'assistant' }).countAsync()) === 2,
      'the single winning resume to finish',
    );
    assert.deepEqual(state.ran, ['refund'], 'a raced approval must not run the tool twice');
    const notes = await AgentMessages
      .find({ sessionId: 's-race-approve', role: 'note', kind: 'approval' } as any).countAsync();
    assert.equal(notes, 1, 'one verdict, one note');
  });

  it('refuses a caller that config.approve rejects', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture(
      's-notallowed', 'gate-notallowed',
      [{ id: 'g1', name: 'refund', gate: 'ask' }],
      { approve: async () => false },
    );

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-notallowed', 's-notallowed');
      assert.fail('config.approve returning false must block the verdict');
    } catch (e: any) {
      assert.equal(e.error, 'not-allowed');
    }

    assert.deepEqual(state.ran, [], 'a blocked approval must not run the tool');
    const doc = (await AgentSessions.findOneAsync('s-notallowed'))!;
    assert.equal(doc.phase, 'awaiting', 'the run must stay parked');
    assert.isUndefined((doc.pending as any).verdict);
    assert.equal(
      await AgentMessages.find({ sessionId: 's-notallowed', role: 'note' } as any).countAsync(), 0,
      'a refused verdict is not transcript history',
    );
  });

  it('answers an approved call whose tool is gone with the unknown-tool result', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-gone', 'gate-gone', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    // Redefine the agent WITHOUT the tool: a rename or a removal deployed
    // while the request sat on someone's screen. The gate declaration is what
    // parked the call, so the resume still owes it an answer — and a
    // `tool_use` left unanswered because a name moved is a permanent 400.
    new Agent('gate-gone', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'all done' })),
    });

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-gone', 's-gone');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-gone', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to close the batch and reply',
    );

    assert.deepEqual(state.ran, [], 'there is no tool left to run');
    const msgs = await AgentMessages
      .find({ sessionId: 's-gone' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'a vanished tool must not strand its call');
    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.equal(row.error!.error, 'unknown-tool');
    assert.isUndefined((await AgentSessions.findOneAsync('s-gone'))!.pending);
  });

  it('an interrupt cancels the park, and the next send is answered not wedged', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-park-stop', 'gate-stop', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const interrupt = (Meteor.server as any).method_handlers[NAMES.mInterrupt];
    await interrupt.call({ userId: 'u1' }, 'gate-stop', 's-park-stop');

    // The stop cancels the WAIT, not the record of what was asked.
    const stopped = (await AgentSessions.findOneAsync('s-park-stop'))!;
    assert.equal(stopped.phase, 'stopped');
    assert.deepInclude(stopped.pending as any, { toolCallId: 'g1' });

    // And a verdict is no longer answerable: approve/deny require 'awaiting'.
    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-stop', 's-park-stop');
      assert.fail('an interrupted park must not accept a verdict');
    } catch (e: any) {
      assert.equal(e.error, 'no-pending');
    }

    // The send clears the stop. The dead request must go with it — otherwise
    // its unanswered tool_use 400s every provider call from here on, and the
    // message the user just sent is never answered at all.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-stop', 's-park-stop', 'never mind');

    await waitFor(
      async () => !!(await AgentMessages.findOneAsync({
        sessionId: 's-park-stop', role: 'assistant', content: 'all done',
      } as any)),
      'the send after an interrupted park to be answered',
    );

    assert.deepEqual(state.ran, [], 'a cancelled gate never runs its tool');
    const msgs = await AgentMessages
      .find({ sessionId: 's-park-stop' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the cancelled request must not strand a call');
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 1, 'the dead turn was discarded');
    const doc = (await AgentSessions.findOneAsync('s-park-stop'))!;
    assert.isUndefined(doc.pending, 'the dead marker must not outlive the turn');
    assert.equal(doc.phase, 'idle');
  });

  it('resumes the parked turn, not an older one that reused the same call id', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Tool call ids are unique only within ONE provider response — this repo's
    // own mock reuses `t1` on every turn. Turn 1 asked for `t1` and was
    // answered at seq 2; turn 2 asked for `t1` again and parked on a gate.
    // Locating the batch by "first assistant carrying this id" finds the OLD,
    // already-answered turn: the approval is silently voided (the tool never
    // runs, `pending` is cleared) while the real `tool_use` stays unanswered.
    await seed('s-locate', 'refund please');
    await AgentMessages.insertAsync({
      _id: 'old-a', sessionId: 's-locate', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'refund', args: {} }], createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'old-tool', sessionId: 's-locate', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ did: 'an older refund' }), createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'parked-a', sessionId: 's-locate', seq: 3, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'refund', args: { amt: 5 } }], createdAt: new Date(),
    } as any);
    // The state approve() leaves behind: verdict recorded, phase back to idle,
    // lease free — the parking run exited long ago.
    await AgentSessions.updateAsync('s-locate', {
      $set: {
        nextSeq: 4,
        phase: 'idle',
        pending: {
          toolCallId: 't1', name: 'refund', args: { amt: 5 },
          requestedAt: new Date(), verdict: 'approved', by: 'u1',
        },
      },
    } as any);

    const ran: string[] = [];
    await runTurn('s-locate', {
      model: 'mock', system: '',
      tools: [{
        name: 'refund', description: 'x', gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { ran.push('refund'); return { did: 'refund' }; },
      }],
      provider: mockProvider(() => ({ text: 'all done' })),
    });

    assert.deepEqual(ran, ['refund'], 'the approval must run the tool the PARKED turn asked for');
    const msgs = await AgentMessages
      .find({ sessionId: 's-locate' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isDefined(msgs.find((m) => m._id === 'old-a'), "turn 1's assistant must survive");
    assert.isDefined(msgs.find((m) => m._id === 'old-tool'), "turn 1's answer must survive");
    assert.isDefined(
      msgs.find((m) => m._id === 'parked-a'),
      'the parked assistant IS the request being approved',
    );
    assert.isDefined(
      msgs.find((m) => m.role === 'tool' && m.toolCallId === 't1' && m.seq > 3),
      'the parked call must be answered inside ITS OWN window, not by turn 1',
    );
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.isUndefined((await AgentSessions.findOneAsync('s-locate'))!.pending);
  });

  it('a verdict landing while the parking run winds down still runs the tool', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // approve/deny record a verdict and defer a resume. A verdict landing
    // between the park write and the parking run's releaseLease/running.delete
    // makes that deferred resume a no-op — it finds the session still running
    // in-process (or still leased, from another server) and returns, and
    // nothing retries. Residue: verdict recorded, phase idle, tool never ran,
    // UI says done. Here the verdict is written with NO defer at all, so the
    // ONLY thing that can pick it up is the winding-down run's own self-check.
    const original = (AgentSessions as any).updateAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'updateAsync');
    let injected = false;
    (AgentSessions as any).updateAsync = async (sel: any, mod: any, ...rest: any[]) => {
      const n = await original(sel, mod, ...rest);
      // The park is the only write that sets `pending`.
      if (!injected && mod?.$set?.pending) {
        injected = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake' } as any,
          { $set: { 'pending.verdict': 'approved', 'pending.by': 'u1', phase: 'idle' } } as any,
        );
      }
      return n;
    };

    let state: { ran: string[]; providerCalls: number } | null = null;
    try {
      state = await buildFixture('s-wake', 'gate-wake', [
        { id: 'g1', name: 'refund', gate: 'ask' },
      ]);
    } finally {
      if (descriptor) Object.defineProperty(AgentSessions, 'updateAsync', descriptor);
      else delete (AgentSessions as any).updateAsync;
    }
    assert.isTrue(injected, 'the verdict must have landed on the park write');

    await waitFor(
      async () => state!.ran.length === 1,
      'the winding-down run to notice the verdict and execute the approved tool',
    );

    assert.deepEqual(state!.ran, ['refund'], 'a dropped wake-up loses an approved tool');
    const msgs = await AgentMessages
      .find({ sessionId: 's-wake' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the woken batch must close cleanly');
    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the approved call must be answered');
    assert.isUndefined((await AgentSessions.findOneAsync('s-wake'))!.pending);
  });

  it('a wake whose verdict was already spent does not run an unrequested turn', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // The mirror image of the test above. The wake-check reads the session,
    // sees a standing verdict, and defers a re-run — but the legitimate resume
    // can START AND FINISH inside that window, spending the verdict. The woken
    // run then finds no `pending` at all, falls straight into the think loop,
    // and makes a provider call nobody asked for: a charge, and an assistant
    // message appended to a turn the user considered finished.
    //
    // The window is forced through the wake-check's own read: the session is
    // stripped of its verdict the instant a read returns it with the lease
    // already released, which is exactly the wind-down snapshot the deferred
    // re-run is scheduled from.
    const original = (AgentSessions as any).findOneAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'findOneAsync');
    let spent = false;
    (AgentSessions as any).findOneAsync = async (...args: any[]) => {
      const doc = await original(...args);
      if (!spent && doc?._id === 's-wake-stale' && doc.pending?.verdict && !doc.lease) {
        spent = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake-stale' } as any, { $unset: { pending: 1 } } as any,
        );
      }
      return doc;
    };

    // Same verdict injection as the test above: written on the park write, with
    // no defer of its own, so the winding-down run's self-check is the only
    // thing that can act on it.
    const originalUpdate = (AgentSessions as any).updateAsync.bind(AgentSessions);
    const updateDescriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'updateAsync');
    let injected = false;
    (AgentSessions as any).updateAsync = async (sel: any, mod: any, ...rest: any[]) => {
      const n = await originalUpdate(sel, mod, ...rest);
      if (!injected && mod?.$set?.pending) {
        injected = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake-stale' } as any,
          { $set: { 'pending.verdict': 'approved', 'pending.by': 'u1', phase: 'idle' } } as any,
        );
      }
      return n;
    };

    let state: { ran: string[]; providerCalls: number } | null = null;
    try {
      state = await buildFixture('s-wake-stale', 'gate-wake-stale', [
        { id: 'g1', name: 'refund', gate: 'ask' },
      ]);
    } finally {
      if (updateDescriptor) Object.defineProperty(AgentSessions, 'updateAsync', updateDescriptor);
      else delete (AgentSessions as any).updateAsync;
      if (descriptor) Object.defineProperty(AgentSessions, 'findOneAsync', descriptor);
      else delete (AgentSessions as any).findOneAsync;
    }
    assert.isTrue(injected, 'the verdict must have landed on the park write');
    assert.isTrue(spent, 'the verdict must have been spent inside the wake window');

    // The deferred re-run fires on a zero timer; give it room to misbehave.
    await new Promise((r) => { setTimeout(r, 400); });

    assert.equal(
      state!.providerCalls, 1,
      'a stale wake must not call the provider — the verdict it woke for is gone',
    );
    const assistants = await AgentMessages
      .find({ sessionId: 's-wake-stale', role: 'assistant' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(assistants, 1, 'no extra assistant row may appear');
    // Identity matters, not just the count: a woken run repairs on entry, so it
    // would DISCARD this parked turn (its `tool_use` is unanswered by design)
    // and commit its own reply in its place — one row either way, a different
    // transcript entirely.
    assert.deepEqual(
      (assistants[0].toolCalls ?? []).map((c) => c.id), ['g1'],
      'the parked turn must survive a wake that had nothing to do',
    );
    assert.deepEqual(state!.ran, [], 'nothing was approved any more, so nothing runs');
  });

  it('a wake refuses a verdict that is not the one it captured', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // The residual the boolean re-check could not see. "Is a verdict standing?"
    // is a boolean answer to an IDENTITY question: verdict A can be consumed,
    // the batch re-park on its NEXT gate, and a second verdict B be recorded —
    // with its own resume already deferred — before the first timer fires.
    // Three writes later the boolean still says yes, and the stale callback
    // runs a turn behind the resume that legitimately owns B.
    //
    // Forced here through the wind-down read itself: the moment the self-check
    // snapshots a session carrying verdict A with the lease already released,
    // `pending` is replaced wholesale with a DIFFERENT verdict under a
    // different token — exactly the document B's resume would have left.
    const original = (AgentSessions as any).findOneAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'findOneAsync');
    let superseded = false;
    (AgentSessions as any).findOneAsync = async (...args: any[]) => {
      const doc = await original(...args);
      if (!superseded && doc?._id === 's-wake-token' && doc.pending?.verdict && !doc.lease) {
        superseded = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake-token' } as any,
          {
            $set: {
              pending: {
                toolCallId: 'g2', name: 'refund', args: {},
                verdict: 'approved', by: 'u1', wakeToken: 'TOKEN-B',
              },
            },
          } as any,
        );
      }
      return doc;
    };

    // Verdict A, stamped with its own token, injected on the park write with no
    // defer of its own — so the winding-down run's self-check is the only thing
    // that can act on it, exactly as the two tests above arrange.
    const originalUpdate = (AgentSessions as any).updateAsync.bind(AgentSessions);
    const updateDescriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'updateAsync');
    let injected = false;
    (AgentSessions as any).updateAsync = async (sel: any, mod: any, ...rest: any[]) => {
      const n = await originalUpdate(sel, mod, ...rest);
      if (!injected && mod?.$set?.pending) {
        injected = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake-token' } as any,
          {
            $set: {
              'pending.verdict': 'approved',
              'pending.by': 'u1',
              'pending.wakeToken': 'TOKEN-A',
              phase: 'idle',
            },
          } as any,
        );
      }
      return n;
    };

    let state: { ran: string[]; providerCalls: number } | null = null;
    try {
      state = await buildFixture('s-wake-token', 'gate-wake-token', [
        { id: 'g1', name: 'refund', gate: 'ask' },
      ]);
    } finally {
      if (updateDescriptor) Object.defineProperty(AgentSessions, 'updateAsync', updateDescriptor);
      else delete (AgentSessions as any).updateAsync;
      if (descriptor) Object.defineProperty(AgentSessions, 'findOneAsync', descriptor);
      else delete (AgentSessions as any).findOneAsync;
    }
    assert.isTrue(injected, 'verdict A must have landed on the park write');
    assert.isTrue(superseded, 'verdict B must have replaced it inside the wake window');

    // The deferred re-run fires on a zero timer; give it room to misbehave.
    await new Promise((r) => { setTimeout(r, 400); });

    assert.equal(
      state!.providerCalls, 1,
      'the wake must not run: the verdict standing is not the one it captured, and B '
      + 'already has a resume of its own',
    );
    assert.lengthOf(
      await AgentMessages
        .find({ sessionId: 's-wake-token', role: 'assistant' }).fetchAsync(), 1,
      'no extra assistant row may appear',
    );
    assert.deepEqual(state!.ran, [], 'and no tool may run for a verdict this wake never saw');
    // B is left exactly as found — untouched, for the resume that owns it.
    const doc = (await AgentSessions.findOneAsync('s-wake-token'))!;
    assert.equal(doc.pending?.wakeToken, 'TOKEN-B');
    assert.equal(doc.pending?.verdict, 'approved');
  });

  it('a stop outranks a recorded verdict, and the send that clears it resumes', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    const { runTurn } = await import('../server/loop');
    const { getAgent } = await import('../server/registry');

    const state = await buildFixture('s-stop-verdict', 'gate-stopverdict', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    const config = getAgent('gate-stopverdict')!;

    // Exactly what agent.approve writes, followed by an interrupt that lands
    // before the resumed run reaches the tool. Running it anyway is a real
    // side effect the user just cancelled — and dispatchCalls would then
    // discard the assistant AND the executed call's row, leaving a transcript
    // that says "approved" with no record it ever ran.
    await AgentSessions.updateAsync('s-stop-verdict', {
      $set: { 'pending.verdict': 'approved', 'pending.by': 'u1', phase: 'idle' },
    } as any);
    await AgentSessions.updateAsync('s-stop-verdict', {
      $set: { phase: 'stopped' },
    } as any);

    await runTurn('s-stop-verdict', {
      model: 'mock', system: '', tools: config.tools ?? [], provider: config.provider!,
    });

    assert.deepEqual(state.ran, [], 'a stop must cancel an approved tool that has not run yet');
    let doc = (await AgentSessions.findOneAsync('s-stop-verdict'))!;
    assert.equal(doc.phase, 'stopped', 'the interrupt is durable until a send clears it');
    assert.deepInclude(
      doc.pending as any, { toolCallId: 'g1', verdict: 'approved' },
      'the verdict must survive: it is what makes the next send resume this batch',
    );
    let msgs = await AgentMessages
      .find({ sessionId: 's-stop-verdict' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(msgs.filter((m) => m.role === 'tool'), 0, 'nothing ran, so nothing answered');
    assert.lengthOf(
      msgs.filter((m) => m.role === 'assistant'), 1,
      'the parked assistant must survive a refusal to run',
    );

    // Re-assert after a beat. The wind-down wake-check schedules its re-run on
    // a timer, so a stop that only LOOKS honored synchronously would be undone
    // a tick later by a woken run that runs the tool anyway.
    await new Promise((r) => { setTimeout(r, 250); });
    assert.deepEqual(state.ran, [], 'no deferred wake may run the cancelled tool');
    doc = (await AgentSessions.findOneAsync('s-stop-verdict'))!;
    assert.equal(doc.phase, 'stopped', 'and no woken run may idle the stop away');
    assert.deepInclude(doc.pending as any, { toolCallId: 'g1', verdict: 'approved' });

    // The send clears the stop; the verdict is still standing, so the batch
    // resumes rather than stranding its tool_use.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-stopverdict', 's-stop-verdict', 'go ahead');

    await waitFor(async () => state.ran.length === 1, 'the send to resume the approved call');
    msgs = await AgentMessages
      .find({ sessionId: 's-stop-verdict' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the resumed batch must close cleanly');
    doc = (await AgentSessions.findOneAsync('s-stop-verdict'))!;
    assert.isUndefined(doc.pending, 'the spent verdict must be cleared');
  });

  it('a send while awaiting is queued, then answered once the verdict resumes', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-queue', 'gate-queue', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    // A send while awaiting does not cancel the approval and does not wake
    // anything: `agent.send` clears 'stopped'/'error' only, and the loop exits
    // on 'awaiting'. The message is QUEUED — and the think loop that runs after
    // the verdict is what has to answer it, or it sits there forever.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-queue', 's-queue', 'and hurry');

    const parked = (await AgentSessions.findOneAsync('s-queue'))!;
    assert.equal(parked.phase, 'awaiting', 'a send must not cancel a live approval request');
    assert.deepInclude(parked.pending as any, { toolCallId: 'g1' });
    assert.isUndefined((parked.pending as any).verdict, 'a send is not a verdict');
    assert.deepEqual(state.ran, [], 'and it must not run the gated tool either');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-queue', 's-queue');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-queue', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to answer the queued message',
    );

    assert.deepEqual(state.ran, ['refund']);
    const msgs = await AgentMessages
      .find({ sessionId: 's-queue' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.lengthOf(
      msgs.filter((m) => m.role === 'user' && m.content === 'and hurry'), 1,
      'the queued message must be committed exactly once',
    );
    assert.equal(msgs[msgs.length - 1].role, 'assistant', 'and it must be ANSWERED, not just stored');
    assert.equal(msgs[msgs.length - 1].content, 'all done');
    assert.isUndefined((await AgentSessions.findOneAsync('s-queue'))!.pending);
  });

  it('a stop landing between the phase check and the park is not overwritten', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-park-race', 'do both');
    let firstRan = false;
    let refundRan = false;
    let sabotaged = false;

    // The park write is the last thing a gated call does, and the phase it
    // acted on was read before the previous tool ran — a window as long as
    // that tool takes. Guarded on the lease alone, the park overwrites a
    // `stopped` that landed inside it: a cancelled turn resurrected as an
    // approval request that only approve/deny can ever clear. The stop is
    // injected immediately after the gated call's own phase check reads a
    // healthy phase, which is the only way into that window.
    const original = (AgentSessions as any).findOneAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'findOneAsync');
    (AgentSessions as any).findOneAsync = async (sel: any, ...rest: any[]) => {
      const doc = await original(sel, ...rest);
      // `holdsLease` passes a selector OBJECT; the dispatch phase check passes
      // the bare id — so this fires on the phase check and nowhere else.
      if (firstRan && !sabotaged && sel === 's-park-race') {
        sabotaged = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-park-race' } as any, { $set: { phase: 'stopped' } } as any,
        );
      }
      return doc;
    };

    try {
      await runTurn('s-park-race', {
        model: 'mock', system: '',
        tools: [
          {
            name: 'logit', description: 'x', gate: 'auto',
            args: { type: 'object', properties: {} },
            run: async () => { firstRan = true; return 'logged'; },
          },
          {
            name: 'refund', description: 'x', gate: 'ask',
            args: { type: 'object', properties: {} },
            run: async () => { refundRan = true; return 'refunded'; },
          },
        ],
        provider: mockProvider(() => ({
          toolCalls: [
            { id: 'p1', name: 'logit', args: {} },
            { id: 'p2', name: 'refund', args: {} },
          ],
        })),
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentSessions, 'findOneAsync', descriptor);
      else delete (AgentSessions as any).findOneAsync;
    }

    assert.isTrue(sabotaged, 'the stop must have landed inside the park window');
    assert.isFalse(refundRan, 'a gated tool never runs at the park itself');
    const doc = (await AgentSessions.findOneAsync('s-park-race'))!;
    assert.equal(doc.phase, 'stopped', 'the park must not overwrite an interrupt');
    assert.isUndefined(
      doc.pending, 'a cancelled turn must not leave an approval request standing',
    );
    const msgs = await AgentMessages
      .find({ sessionId: 's-park-race' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [], 'the abandoned batch must take its tool_use with it',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });
});

describe('budgets', () => {
  it('refuses the send that would exceed the turn budget', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // DDPRateLimiter never sees a loop-initiated call, so the turn budget is
    // the only thing standing between a user and unbounded model spend.
    new Agent('budget-turns', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
      budget: { turns: 1 },
    } as any);
    await seed('s-budget-turns', 'seeded', 'budget-turns');

    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    // `seed` commits a user row but spends nothing: mSend is what $incs
    // budgetSpent.turns, so this send is the one that exhausts a budget of 1.
    await send.call({ userId: 'u1' }, 'budget-turns', 's-budget-turns', 'first');
    await waitFor(
      async () => (await AgentSessions.findOneAsync('s-budget-turns'))!.phase === 'idle',
      'the first turn to finish',
    );
    assert.equal(
      (await AgentSessions.findOneAsync('s-budget-turns'))!.budgetSpent.turns, 1,
      'the allowed send must spend its turn',
    );

    try {
      await send.call({ userId: 'u1' }, 'budget-turns', 's-budget-turns', 'second');
      assert.fail('the send past the turn budget must be refused, not queued');
    } catch (e: any) {
      assert.equal(e.error, 'budget-exhausted');
    }

    const doc = (await AgentSessions.findOneAsync('s-budget-turns'))!;
    assert.equal(
      doc.budgetSpent.turns, 1,
      'a refused send must not spend the budget it was refused for',
    );
    assert.equal(
      await AgentMessages
        .find({ sessionId: 's-budget-turns', content: 'second' } as any).countAsync(), 0,
      'the refused message must not reach the transcript either',
    );
  });

  it('stops mid-turn when the tool-call budget trips, stranding no tool_use', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-budget-tools', 'do both');
    const ran: string[] = [];
    let call = 0;

    await runTurn('s-budget-tools', {
      model: 'mock',
      system: '',
      budget: { toolCalls: 1 },
      tools: [
        {
          name: 'first', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { ran.push('first'); return { did: 1 }; },
        },
        {
          name: 'second', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { ran.push('second'); return { did: 2 }; },
        },
      ],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? {
            toolCalls: [
              { id: 'b1', name: 'first', args: {} },
              { id: 'b2', name: 'second', args: {} },
            ],
          }
          : { text: 'unreachable' };
      }),
    });

    assert.deepEqual(ran, ['first'], 'the check is BEFORE the spend: the limit stops call two');
    assert.equal(call, 1, 'a tripped budget must not go round the think loop again');

    const msgs = await AgentMessages
      .find({ sessionId: 's-budget-tools' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'a budget trip must discard the in-flight turn exactly as an interrupt does',
    );
    assert.lengthOf(
      msgs.filter((m) => m.role === 'assistant'), 0,
      'the half-answered assistant must go with the batch it can no longer finish',
    );
    assert.equal(
      msgs.filter((m) => m.role !== 'note').pop()!.role, 'user',
      'the discarded turn must leave the transcript resumable',
    );

    const note = msgs.find((m) => m.role === 'note' && m.kind === 'budget') as any;
    assert.isDefined(note, 'a tripped budget is transcript history, not a silent stop');
    assert.equal(note.budget, 'toolCalls');
    assert.deepEqual(note.error, { error: 'budget-exhausted', reason: 'Tool-call budget reached.' });
    assert.isUndefined(note.content, 'notes carry structured fields, not prose');

    const doc = (await AgentSessions.findOneAsync('s-budget-tools'))!;
    assert.equal(doc.phase, 'stopped');
    assert.equal(
      doc.budgetSpent.toolCalls, 1,
      'the discarded result still cost a real side effect — the spend stands',
    );
  });

  it('refuses the next turn once the spend budget is crossed, before any provider call', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-budget-spend', 'hello');
    // Just under a one-cent cap. No cost is reported by this provider, so the
    // configured pricing is what has to move `usage.cost` past the line.
    await AgentSessions.updateAsync('s-budget-spend', {
      $set: { 'usage.cost': 0.009 },
    } as any);

    let calls = 0;
    const spender: Provider = {
      async *stream() {
        calls += 1;
        yield { kind: 'text', chunk: 'spending' };
        yield { kind: 'done', usage: { input: 2000, output: 0 } };
      },
    };
    const config = {
      model: 'mock', system: '', tools: [], provider: spender,
      pricing: { input: 1, output: 1 },
      budget: { spend: 0.01 },
    };

    await runTurn('s-budget-spend', config);
    assert.equal(
      calls, 1,
      'the check is before the spend, so the turn that CROSSES the cap still runs',
    );
    let doc = (await AgentSessions.findOneAsync('s-budget-spend'))!;
    assert.closeTo(doc.usage.cost, 0.011, 1e-9, 'cost must accrue through the commit $inc');
    assert.equal(doc.phase, 'idle', 'crossing is not tripping');
    assert.equal(
      await AgentMessages
        .find({ sessionId: 's-budget-spend', role: 'note' } as any).countAsync(), 0,
    );

    await runTurn('s-budget-spend', config);
    assert.equal(calls, 1, 'the next turn must refuse BEFORE it calls the provider');
    const note = await AgentMessages.findOneAsync({
      sessionId: 's-budget-spend', role: 'note', kind: 'budget',
    } as any) as any;
    assert.isDefined(note, 'the refusal must be visible in the transcript');
    assert.equal(note.budget, 'spend');
    assert.deepEqual(note.error, { error: 'budget-exhausted', reason: 'Spend budget reached.' });
    doc = (await AgentSessions.findOneAsync('s-budget-spend'))!;
    assert.equal(doc.phase, 'stopped');
    assert.lengthOf(
      await AgentMessages
        .find({ sessionId: 's-budget-spend', role: 'assistant' }).fetchAsync(), 1,
      'the refused turn commits nothing of its own',
    );
  });

  it('prefers a provider-reported cost over the pricing computation', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-cost-reported', 'hello');
    // pi-ai computes its own cost and reports it on the done event, including
    // the cacheRead/cacheWrite tokens a two-rate input/output table cannot
    // see. Where the provider has priced the call, its number wins.
    const reporting: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'x' };
        yield { kind: 'done', usage: { input: 1000, output: 1000, cost: 0.05 } };
      },
    };

    await runTurn('s-cost-reported', {
      model: 'mock', system: '', tools: [], provider: reporting,
      pricing: { input: 1, output: 1 },   // would compute 0.002
    });

    const doc = (await AgentSessions.findOneAsync('s-cost-reported'))!;
    assert.closeTo(
      doc.usage.cost, 0.05, 1e-9,
      'the provider knows what it charged better than a two-rate table does',
    );
  });

  it('computes cost from pricing when none is reported, and accrues zero with neither', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // mockProvider is deliberately cost-free, which is what makes it the
    // fixture for the fallback path.
    await seed('s-cost-priced', 'hello');
    await runTurn('s-cost-priced', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'hi', usage: { input: 1000, output: 2000 } })),
      pricing: { input: 3, output: 15 },   // $ per million tokens
    });
    const priced = (await AgentSessions.findOneAsync('s-cost-priced'))!;
    assert.closeTo(priced.usage.cost, 0.033, 1e-9, '(1000*3 + 2000*15) / 1e6');
    assert.equal(priced.usage.input, 1000);
    assert.equal(priced.usage.output, 2000);

    await seed('s-cost-free', 'hello');
    await runTurn('s-cost-free', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'hi', usage: { input: 1000, output: 2000 } })),
    });
    assert.equal(
      (await AgentSessions.findOneAsync('s-cost-free'))!.usage.cost, 0,
      'no reported cost and no pricing accrues nothing — never a guess',
    );
  });
});

describe('parseSpend()', () => {
  it('accepts a dollar string or a plain number and rejects anything else', async () => {
    const { parseSpend } = await import('../server/registry');
    assert.equal(parseSpend('$1.50'), 1.5);
    assert.equal(parseSpend(2), 2);
    assert.equal(parseSpend('0.25'), 0.25);
    assert.equal(parseSpend('$0'), 0);
    assert.throws(() => parseSpend('a dollar fifty'), /spend/);
    assert.throws(() => parseSpend('$'), /spend/);
    assert.throws(() => parseSpend('1.5 USD'), /spend/);
    assert.throws(() => parseSpend(Number.NaN), /spend/);
    assert.throws(() => parseSpend(-1), /spend/);
  });

  it('rejects a malformed spend at define() time, not mid-turn', async () => {
    const { Agent } = await import('../server/agent');
    // A config error is a STARTUP error. Deferring it to the first turn means
    // the app boots green and the only brake on loop-initiated work fails
    // open, in production, under load.
    assert.throws(
      () => new Agent('budget-malformed', {
        model: 'mock', instructions: '', tools: [], budget: { spend: 'lots' },
      } as any),
      /spend/,
    );
  });
});

describe('classifyProviderError()', () => {
  it('lets an adapter hint outrank the status, and defaults to retryable', async () => {
    const { classifyProviderError } = await import('../server/loop');
    // An adapter that classified the error itself (pi-ai's own transient
    // taxonomy) knows more than the status line, in BOTH directions.
    assert.equal(classifyProviderError({ retryable: false, status: 503 }), 'fatal');
    assert.equal(classifyProviderError({ retryable: true, status: 401 }), 'retryable');
    // 408 is a request timeout — the server never got a complete request, so
    // re-issuing it is exactly what every provider's own client library does
    // (Anthropic and OpenAI both retry 408 alongside 429 and 5xx). It is the
    // one 4xx that is transient by definition.
    assert.equal(classifyProviderError({ status: 408 }), 'retryable');
    // Unclassifiable (a socket hang-up, a DNS blip) retries — bounded anyway.
    assert.equal(classifyProviderError({}), 'retryable');
  });

  it('classifies an abort as abandon, by hint or by error name', async () => {
    const { classifyProviderError } = await import('../server/loop');
    // The adapter's own mapping (pi-ai's `reason: 'aborted'` error event).
    assert.equal(classifyProviderError({ retryable: 'abandon' }), 'abandon');
    // A raw aborted fetch, which carries no status at all and would otherwise
    // fall through to the retryable default — re-issuing the request the user
    // just cancelled.
    assert.equal(classifyProviderError({ name: 'AbortError' }), 'abandon');
    // The hint outranks a status that would otherwise read as retryable.
    assert.equal(classifyProviderError({ retryable: 'abandon', status: 503 }), 'abandon');
  });
});

describe('backoffDelay()', () => {
  it('is full jitter: every sample lands in [0, cap] and the cap is maxDelayMs', async () => {
    const { backoffDelay } = await import('../server/loop');
    // cap = min(maxDelayMs 10, baseMs 4 * 2^3 = 32) = 10.
    const capped = Array.from({ length: 20 }, () => backoffDelay(3, 4, 10));
    capped.forEach((d) => {
      assert.isAtLeast(d, 0, 'a negative delay is not a delay');
      assert.isAtMost(d, 10, 'maxDelayMs caps the exponential, always');
    });
    assert.isAbove(
      new Set(capped).size, 1,
      'full jitter must actually vary — a fixed delay resynchronizes every '
      + 'client that failed together, which is what jitter exists to prevent',
    );
    // Below the cap the exponent still governs: 2 * 2^2 = 8.
    Array.from({ length: 20 }, () => backoffDelay(2, 2, 100))
      .forEach((d) => assert.isAtMost(d, 8));
  });
});

describe('compaction (§9)', () => {
  const seedLong = async (sessionId: string) => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 5, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const pad = 'x'.repeat(80);
    const rows: Array<[number, string, string]> = [
      [0, 'user', `OLD-1 ${pad}`], [1, 'assistant', `OLD-2 ${pad}`],
      [2, 'user', `OLD-3 ${pad}`], [3, 'assistant', `OLD-4 ${pad}`],
      [4, 'user', 'ask now'],
    ];
    for (const [seq, role, content] of rows) {
      await AgentMessages.insertAsync({
        _id: `m${seq}`, sessionId, seq, role, content, createdAt: new Date(),
      } as any);
    }
  };

  it('compacts before the call that would overflow, and the model sees the summary', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seedLong('s-compact');
    const requests: any[] = [];
    const scripted: Provider = {
      async *stream(req) {
        requests.push(req);
        const isCompaction = req.system.includes('compact');
        for (const ch of (isCompaction ? 'SUMMARY-BRIEF' : 'final answer')) {
          yield { kind: 'text', chunk: ch };
        }
        yield { kind: 'done', usage: { input: 7, output: 3 } };
      },
    };
    await runTurn('s-compact', {
      model: 'mock', system: 'be helpful', tools: [], provider: scripted,
      context: { window: 100, compactAt: 0.5, keep: 2 },
    });

    const note = await AgentMessages.findOneAsync(
      { sessionId: 's-compact', role: 'note', kind: 'compaction' } as any,
    );
    assert.isDefined(note, 'a compaction note must be committed');
    assert.equal((note as any).summary, 'SUMMARY-BRIEF');
    assert.equal((note as any).upto, 2, 'keep=2 keeps OLD-4 and "ask now"');

    // Two provider calls: the compaction, then the think against the view.
    assert.lengthOf(requests, 2);
    const think = requests[1];
    assert.include(think.messages[0].content, '[Earlier conversation, compacted]');
    assert.include(think.messages[0].content, 'SUMMARY-BRIEF');
    const flat = JSON.stringify(think.messages);
    assert.notInclude(flat, 'OLD-2', 'compacted messages must not reach the model');
    assert.include(flat, 'OLD-4', 'kept messages must');

    // The TRANSCRIPT keeps everything: 5 seeded + note + assistant reply.
    assert.equal(await AgentMessages.find({ sessionId: 's-compact' }).countAsync(), 7);
    const reply = await AgentMessages.findOneAsync(
      { sessionId: 's-compact', role: 'assistant', content: 'final answer' } as any,
    );
    assert.isDefined(reply, 'the turn must complete after compacting');
  });

  it('a failed compaction degrades to an uncompacted turn, never an error', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seedLong('s-compact-fail');
    const failing: Provider = {
      async *stream(req) {
        if (req.system.includes('compact')) {
          const e: any = new Error('summarizer down'); e.status = 503; throw e;
        }
        yield { kind: 'text', chunk: 'answered anyway' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };
    await runTurn('s-compact-fail', {
      model: 'mock', system: '', tools: [], provider: failing,
      context: { window: 100, compactAt: 0.5, keep: 2 },
    });

    assert.equal(
      await AgentMessages.find(
        { sessionId: 's-compact-fail', role: 'note' } as any,
      ).countAsync(),
      0, 'no compaction note and no error note — compaction failure is silent degradation',
    );
    // The seeded transcript already contains assistants; the reply is the
    // NEWEST assistant row, not the first match.
    const reply = await AgentMessages.findOneAsync(
      { sessionId: 's-compact-fail', role: 'assistant' } as any,
      { sort: { seq: -1 } } as any,
    );
    assert.equal((reply as any).content, 'answered anyway');
    assert.equal((await AgentSessions.findOneAsync('s-compact-fail'))!.phase, 'idle');
  });

  it('repair still works with a compaction note standing', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { mockProvider } = await import('../server/providers/mock');

    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: 's-compact-repair', agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 3, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'r0', sessionId: 's-compact-repair', seq: 0, role: 'user',
      content: 'hello', createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'r1', sessionId: 's-compact-repair', seq: 1, role: 'note', kind: 'compaction',
      summary: 'earlier stuff', upto: 0, createdAt: new Date(),
    } as any);
    // A crash-stranded assistant AFTER the note: unanswered tool_use.
    await AgentMessages.insertAsync({
      _id: 'r2', sessionId: 's-compact-repair', seq: 2, role: 'assistant',
      content: '', toolCalls: [{ id: 'dead1', name: 'gone', args: {} }],
      createdAt: new Date(),
    } as any);

    await runTurn('s-compact-repair', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages
      .find({ sessionId: 's-compact-repair' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the stranded turn must be repaired');
    assert.isDefined(msgs.find((m) => m.role === 'assistant' && m.content === 'recovered'));
    const note = msgs.find((m) => (m as any).kind === 'compaction');
    assert.isDefined(note, 'the compaction note is history and must survive repair');
  });
});

describe('compaction pure functions', () => {
  const msg = (seq: number, role: string, extra: any = {}) => ({
    _id: `p${seq}`, sessionId: 's', seq, role, createdAt: new Date(0), ...extra,
  });

  it('findCompactionCut keeps the last `keep` and never splits a batch', async () => {
    const { findCompactionCut } = await import('../server/loop');
    const msgs: any[] = [
      msg(0, 'user', { content: 'a' }),
      msg(1, 'assistant', { toolCalls: [{ id: 't1', name: 'x', args: {} }] }),
      msg(2, 'tool', { toolCallId: 't1', content: '{}' }),
      msg(3, 'user', { content: 'b' }),
      msg(4, 'assistant', { content: 'c' }),
      msg(5, 'user', { content: 'd' }),
    ];
    // keep=3: cut lands on a non-tool row — plain boundary.
    assert.equal(findCompactionCut(msgs, 3), 2);
    // keep=4: the naive cut lands ON the tool row; walking back keeps the
    // whole batch (assistant AND its result) in the tail.
    assert.equal(findCompactionCut(msgs, 4), 0);
    // keep >= eligible: nothing to compact.
    assert.isNull(findCompactionCut(msgs, 6));
    // Walking back to the start: nothing summarizable without splitting.
    assert.isNull(findCompactionCut([
      msg(0, 'assistant', { toolCalls: [{ id: 't1', name: 'x', args: {} }] }),
      msg(1, 'tool', { toolCallId: 't1', content: '{}' }),
    ] as any, 1));
  });

  it('findCompactionCut starts after the previous compaction', async () => {
    const { findCompactionCut } = await import('../server/loop');
    const msgs: any[] = [
      msg(0, 'user', { content: 'old' }),
      msg(1, 'note', { kind: 'compaction', summary: 's', upto: 0 }),
      msg(2, 'user', { content: 'a' }), msg(3, 'assistant', { content: 'b' }),
      msg(4, 'user', { content: 'c' }),
    ];
    // eligible = seqs 2,3,4; keep=1 -> cut before seq 4 -> upto 3.
    assert.equal(findCompactionCut(msgs, 1), 3);
  });

  it('assembleContext swaps compacted history for the summary', async () => {
    const { assembleContext } = await import('../server/loop');
    const msgs: any[] = [
      msg(0, 'user', { content: 'old question' }),
      msg(1, 'assistant', { content: 'old answer' }),
      msg(2, 'note', { kind: 'compaction', summary: 'THE-BRIEF', upto: 1 }),
      msg(3, 'user', { content: 'new question' }),
    ];
    const out = assembleContext(msgs);
    assert.lengthOf(out, 2);
    assert.include(out[0].content, 'THE-BRIEF');
    assert.equal(out[1].content, 'new question');
  });

  it('estimateContext takes the max of reported input and chars/4', async () => {
    const { estimateContext } = await import('../server/loop');
    const small = [{ role: 'user' as const, content: 'hi' }];
    assert.equal(estimateContext(small, 999), 999);
    const noReport = estimateContext(small);
    assert.isAbove(noReport, 0);
    assert.isBelow(noReport, 50);
  });
});

describe('compaction hardening (final-review fixes)', () => {
  const seedRows = async (sessionId: string, rows: Array<Record<string, any>>, nextSeq: number) => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    for (const r of rows) {
      await AgentMessages.insertAsync({
        _id: `x${r.seq}`, sessionId, createdAt: new Date(), ...r,
      } as any);
    }
  };

  it('the cut never splits a batch even when a user message interjects inside it', async () => {
    // A send queued while the session was `awaiting` lands BETWEEN an
    // assistant's toolCalls and its tool results. Row-adjacency walking would
    // cut inside the batch; the window-based cut must not.
    const { findCompactionCut } = await import('../server/loop');
    const pad = 'x'.repeat(40);
    const msgs: any[] = [
      { seq: 0, role: 'user', content: `u0 ${pad}` },
      { seq: 1, role: 'assistant', toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }] },
      { seq: 2, role: 'user', content: `interjected ${pad}` },
      { seq: 3, role: 'tool', toolCallId: 't1', content: '{}' },
      { seq: 4, role: 'tool', toolCallId: 't2', content: '{}' },
      { seq: 5, role: 'user', content: `u5 ${pad}` },
      { seq: 6, role: 'assistant', content: 'a6' },
      { seq: 7, role: 'user', content: `u7 ${pad}` },
    ].map((r, i) => ({ _id: `p${i}`, sessionId: 's', createdAt: new Date(0), ...r }));
    // keep=4: the naive boundary lands between t3 and t4 — inside the batch.
    // The window walk must pull the cut back to before the assistant.
    assert.equal(findCompactionCut(msgs, 4), 0, 'the whole batch must stay in the tail');
    // keep=2: boundary after the batch — everything up to u5 summarizes fine.
    assert.equal(findCompactionCut(msgs, 2), 5);
  });

  it('the compaction request carries the agent tool schemas', async function () {
    this.timeout(30000);
    const { runTurn } = await import('../server/loop');
    const { AgentMessages } = await import('../common/collections');
    // The head keeps tool_use/tool_result blocks; Anthropic rejects those
    // with no `tools` parameter — so the schemas must ride along.
    const pad = 'x'.repeat(80);
    await seedRows('s-comp-tools', [
      { seq: 0, role: 'user', content: `q ${pad}` },
      { seq: 1, role: 'assistant', toolCalls: [{ id: 't1', name: 'look', args: {} }] },
      { seq: 2, role: 'tool', toolCallId: 't1', content: `{"r":"${pad}"}` },
      { seq: 3, role: 'assistant', content: `a ${pad}` },
      { seq: 4, role: 'user', content: 'now' },
    ], 5);

    const requests: any[] = [];
    const scripted: Provider = {
      async *stream(req) {
        requests.push(req);
        const isCompaction = req.system.includes('compact');
        for (const ch of (isCompaction ? 'BRIEF' : 'done')) yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    await runTurn('s-comp-tools', {
      model: 'mock', system: 'help', provider: scripted,
      tools: [{
        name: 'look', description: 'looks', args: { type: 'object', properties: {} },
        run: async () => 'ok',
      }],
      context: { window: 60, compactAt: 0.5, keep: 2 },
    });

    assert.isAbove(requests.length, 1);
    const compactionReq = requests[0];
    assert.include(compactionReq.system, 'compact');
    assert.lengthOf(compactionReq.tools, 1, 'tool schemas must ride along with tool blocks');
    assert.equal(compactionReq.tools[0].name, 'look');
    const note = await AgentMessages.findOneAsync(
      { sessionId: 's-comp-tools', role: 'note', kind: 'compaction' } as any,
    );
    assert.isDefined(note);
  });

  it('an interrupt during compaction stops the turn instead of being erased', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const pad = 'x'.repeat(120);
    await seedRows('s-comp-int', [
      { seq: 0, role: 'user', content: `q1 ${pad}` },
      { seq: 1, role: 'assistant', content: `a1 ${pad}` },
      { seq: 2, role: 'user', content: `q2 ${pad}` },
      { seq: 3, role: 'assistant', content: `a2 ${pad}` },
      { seq: 4, role: 'user', content: 'now' },
    ], 5);

    const requests: any[] = [];
    const stallingCompaction: Provider = {
      async *stream(req) {
        requests.push(req);
        // Only ever called for the compaction: the interrupt must prevent the
        // think call entirely.
        yield { kind: 'text', chunk: 'S' };
        await AgentSessions.updateAsync('s-comp-int', {
          $set: { phase: 'stopped', updatedAt: new Date() },
        } as any);
        // Wait for the compaction's own poll to notice and abort the signal,
        // then do what a real transport does: reject with AbortError.
        const deadline = Date.now() + 5000;
        while (!req.signal?.aborted && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const e: any = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
    };
    await runTurn('s-comp-int', {
      model: 'mock', system: 'help', tools: [], provider: stallingCompaction,
      context: { window: 60, compactAt: 0.5, keep: 2 },
      interruptCheckMs: 10,
    });

    assert.lengthOf(requests, 1, 'the think call must never fire after the stop');
    assert.isTrue(requests[0].signal?.aborted === true || requests[0].signal === undefined
      ? requests[0].signal?.aborted === true : false,
    'the compaction request must actually be aborted');
    assert.equal((await AgentSessions.findOneAsync('s-comp-int'))!.phase, 'stopped');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-comp-int', role: 'note' } as any).countAsync(), 0,
      'no compaction note and no error note',
    );
    assert.equal(
      await AgentMessages.find({ sessionId: 's-comp-int', role: 'assistant', content: 'done' } as any).countAsync(), 0,
    );
  });
});

describe('canUse backstop and maxResultChars (§5.2/§7)', () => {
  it('a forbidden tool never runs, never parks, and the model sees not-allowed', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { mockProvider } = await import('../server/providers/mock');
    await seed('s-canuse', 'do both');
    let allowedRan = false;
    let forbiddenRan = false;
    let call = 0;
    await runTurn('s-canuse', {
      model: 'mock', system: '',
      tools: [
        { name: 'allowed', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { allowedRan = true; return 'ok'; } },
        { name: 'forbidden', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { forbiddenRan = true; return 'never'; } },
      ],
      canUse: async (tool) => tool !== 'forbidden',
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [
              { id: 'c1', name: 'forbidden', args: {} },
              { id: 'c2', name: 'allowed', args: {} },
            ] }
          : { text: 'finished' };
      }),
    });

    assert.isFalse(forbiddenRan);
    assert.isTrue(allowedRan);
    const doc = (await AgentSessions.findOneAsync('s-canuse'))!;
    assert.notEqual(doc.phase, 'awaiting', 'a forbidden ask-gated tool must NOT park');
    const rows = await AgentMessages
      .find({ sessionId: 's-canuse', role: 'tool' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(rows, 2);
    const forbiddenRow = rows.find((m) => m.toolCallId === 'c1')!;
    assert.equal(forbiddenRow.error!.error, 'not-allowed');
    const final = await AgentMessages.findOneAsync(
      { sessionId: 's-canuse', role: 'assistant', content: 'finished' } as any,
    );
    assert.isDefined(final, 'the turn completes; the model routes around the refusal');
  });

  it('oversized tool results are truncated with an explicit marker', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { mockProvider } = await import('../server/providers/mock');
    await seed('s-trunc', 'fetch it');
    let call = 0;
    await runTurn('s-trunc', {
      model: 'mock', system: '',
      tools: [{
        name: 'big', description: 'x', args: { type: 'object', properties: {} },
        run: async () => 'y'.repeat(500),
      }],
      maxResultChars: 40,
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: 'b1', name: 'big', args: {} }] }
          : { text: 'ok' };
      }),
    });
    const row = (await AgentMessages.findOneAsync(
      { sessionId: 's-trunc', role: 'tool' } as any,
    ))!;
    assert.isBelow(row.content!.length, 120, 'content must be truncated');
    assert.include(row.content!, 'truncated');
  });
});
