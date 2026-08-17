import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

/** Nothing at all may survive an `ask` — not the session, not its transcript,
 *  not a stray delta. Counted across ALL three collections rather than by
 *  session id, because the whole point is that the throwaway leaves no id
 *  behind to look for. */
const leftovers = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  return {
    sessions: await AgentSessions.find({}).countAsync(),
    messages: await AgentMessages.find({}).countAsync(),
    deltas: await AgentDeltas.find({}).countAsync(),
  };
};

const clean = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
};

/** Assert `fn` rejects with a specific `Meteor.Error` code, and hand the error
 *  back so the caller can check its reason. `assert.fail` on success, because a
 *  silently-succeeding `ask` is the exact failure mode these tests exist for. */
const rejectsWith = async (fn: () => Promise<unknown>, code: string): Promise<any> => {
  try {
    await fn();
  } catch (e: any) {
    assert.equal(e.error, code, `expected ${code}, got ${e.error}: ${e.reason ?? e.message}`);
    return e;
  }
  return assert.fail(`expected ${code}, but ask() resolved`);
};

describe('Agent.ask', () => {
  it('returns the assistant reply and deletes the throwaway session', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');

    await clean();
    const oneshot = new Agent('ask-basic', {
      model: 'mock',
      instructions: 'You are a test.',
      tools: [],
      provider: mockProvider(() => ({ text: 'the answer' })),
    });

    const answer = await oneshot.ask('the question', { userId: 'u1' });
    assert.equal(answer, 'the answer');

    // Session, messages AND deltas: the transcript is as much of a leak as the
    // session document, and a streamed turn writes deltas the commit is
    // supposed to have already swept.
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('threads userId into the instructions and the tool context', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');

    await clean();
    let sawSystem = '';
    let sawToolUserId: string | null | undefined;
    // Branch on the HISTORY, not on a call counter: this provider serves two
    // separate asks below, and a counter would make the second one skip the
    // tool call and silently re-assert the first ask's captured values.
    const provider: Provider = {
      async *stream(req) {
        sawSystem = req.system;
        if (!req.messages.some((m) => m.role === 'tool')) {
          yield { kind: 'done', toolCalls: [{ id: `t${req.messages.length}`, name: 'whoami', args: {} }] };
          return;
        }
        for (const ch of 'done') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 4 } };
      },
    };

    const who = new Agent('ask-ctx', {
      model: 'mock',
      instructions: ({ userId }) => `caller is ${userId}`,
      tools: [{
        name: 'whoami',
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async (_args: unknown, ctx: any) => { sawToolUserId = ctx.userId; return { ok: true }; },
      }],
      provider,
    });

    assert.equal(await who.ask('who am I', { userId: 'u-42' }), 'done');
    assert.equal(sawSystem, 'caller is u-42', 'instructions must be built with the ask userId');
    assert.equal(sawToolUserId, 'u-42', 'tools must see the ask userId');

    // Default owner is anonymous — the same null a capability-URL session has.
    sawToolUserId = undefined;
    await who.ask('again');
    assert.equal(sawSystem, 'caller is null');
    assert.isNull(sawToolUserId);
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('composes: one agent\'s ask is another agent\'s tool', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');

    await clean();

    // A — the specialist. Answers a lookup and nothing else.
    const specialist = new Agent('ask-inner', {
      model: 'mock',
      instructions: 'You look things up.',
      tools: [],
      provider: mockProvider(() => ({ text: 'Ottawa' })),
    });

    // B — the caller. Its inline tool body is literally `A.ask(...)`, which is
    // the composition this API exists to make possible: B inherits A's registry
    // config, tool loop and budgets instead of hand-rolling a second client.
    let asked = '';
    let toolAnswer: unknown;
    let bCalls = 0;
    const composer = new Agent('ask-outer', {
      model: 'mock',
      instructions: 'You delegate.',
      tools: [{
        name: 'lookup',
        description: 'Ask the specialist',
        args: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        run: async ({ q }: { q: string }, ctx: any) => {
          asked = q;
          toolAnswer = await specialist.ask(q, { userId: ctx.userId });
          return { answer: toolAnswer };
        },
      }],
      provider: mockProvider((req) => {
        bCalls += 1;
        if (bCalls === 1) {
          return { toolCalls: [{ id: 'c1', name: 'lookup', args: { q: 'capital of Canada' } }] };
        }
        // Second iteration: the tool result is in B's history, so B's reply
        // embeds A's answer — proving the inner ask's string actually made the
        // round trip through the tool row rather than being asserted in
        // isolation.
        const toolRow = req.messages.find((m: any) => m.role === 'tool');
        const seen = JSON.stringify(toolRow ?? {}).includes('Ottawa') ? 'Ottawa' : '???';
        return { text: `The specialist says: ${seen}` };
      }),
    });

    const reply = await composer.ask('what is the capital of Canada?', { userId: 'u-c' });

    assert.equal(asked, 'capital of Canada');
    assert.equal(toolAnswer, 'Ottawa', 'the inner ask must return the specialist\'s reply');
    assert.equal(reply, 'The specialist says: Ottawa');

    // BOTH throwaways are gone: the nested ask cleans up inside the outer
    // turn's tool call, and the outer one cleans up after it.
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('rejects ask-parked when the turn hits a gate, and still cleans up', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');

    await clean();
    let toolRan = false;
    const gated = new Agent('ask-gate', {
      model: 'mock',
      instructions: '',
      tools: [{
        name: 'refund',
        description: 'x',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { toolRan = true; return { did: 'refund' }; },
      }],
      provider: mockProvider(() => ({
        toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }],
      })),
    });

    const err = await rejectsWith(() => gated.ask('refund please'), 'ask-parked');
    assert.include(err.reason, 'refund', 'the reason must name the tool nobody can approve');
    assert.isFalse(toolRan, 'a gated tool must not run headless');

    // A park is the case most likely to leak: the loop leaves the session
    // ALIVE on purpose (phase 'awaiting', `pending` standing) for a human to
    // come back to. There is no human here, so the finally must delete it
    // anyway — otherwise every headless call to a gated agent strands a
    // session the watcher will later sweep.
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('rejects ask-failed on a fatal provider error, and still cleans up', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');

    await clean();
    const broken: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        const e: any = new Error('invalid x-api-key sk-SECRET');
        e.status = 401;
        throw e;
      },
    };
    const doomed = new Agent('ask-fatal', {
      model: 'mock', instructions: '', tools: [], provider: broken, retry: { attempts: 1 },
    });

    const err = await rejectsWith(() => doomed.ask('hello'), 'ask-failed');
    assert.equal(err.reason, 'The model request failed.');
    // The sanitized note's reason travels out on the error, never the raw
    // provider message — the transcript that scrubbed it is about to be
    // deleted, so this is the only copy the caller sees.
    assert.notInclude(JSON.stringify(err), 'SECRET');
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('rejects ask-failed with the budget reason when a budget stops the run', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');

    await clean();
    // A tool-call budget of 1 with a provider that asks for a second call: the
    // loop commits a `kind: 'budget'` note and stops. `ask` must surface WHICH
    // limit tripped, not a generic failure — an operator raises a named limit.
    let providerCalls = 0;
    const greedy = new Agent('ask-budget', {
      model: 'mock',
      instructions: '',
      budget: { toolCalls: 1 },
      tools: [{
        name: 'work',
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async () => ({ ok: true }),
      }],
      provider: mockProvider(() => {
        providerCalls += 1;
        return { toolCalls: [{ id: `c${providerCalls}`, name: 'work', args: {} }] };
      }),
    });

    const err = await rejectsWith(() => greedy.ask('do it'), 'ask-failed');
    assert.equal(err.reason, 'Tool-call budget reached.');
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });

  it('rejects no-agent for a name that was never defined', async function () {
    this.timeout(20000);
    const { Agent } = await import('../server/agent');
    await clean();
    // Constructed WITHOUT a config, so nothing is in the registry: `ask` reads
    // the config the same way `deferTurn`'s callers do, and must refuse rather
    // than insert a session it can never run.
    await rejectsWith(() => new Agent('ask-undefined').ask('hi'), 'no-agent');
    assert.deepEqual(await leftovers(), { sessions: 0, messages: 0, deltas: 0 });
  });
});
