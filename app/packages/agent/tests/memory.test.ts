import { assert } from 'chai';
import type { AgentMemory } from '../common/types';

/**
 * Memory (memory spec): the store's rules, the search ladder, the two
 * surfaces over one core, and the standing block.
 *
 * The load-bearing invariants under test are the ones verification found:
 * app rows carry no `userId` (the absence IS the sharing); the DDP surface is
 * narrower than the model's because gates never fire on it; the ladder
 * degrades rather than throwing; and the hint escapes its input.
 */

const clean = async () => {
  const { AgentMemories } = await import('../common/collections');
  await AgentMemories.removeAsync({});
};

const CONFIG = {
  hints: { minScore: 0.6 } as const,
  max: 5,
  maxApp: 4,
  index: { pinned: 2, recent: 3 },
  scopes: ['user', 'app'] as Array<'user' | 'agent' | 'app'>,
};

const PERSON_ONLY = { ...CONFIG, scopes: ['user'] as Array<'user' | 'agent' | 'app'> };

describe('memory — the store', () => {
  beforeEach(clean);
  after(clean);

  it('saves a person fact keyed by userId, and an app fact with NO userId', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');

    const person = await saveMemory(
      { text: 'prefers email for billing' },
      { by: 'm:support', userId: 'u1', agent: 'support', config: CONFIG },
    );
    assert.isTrue(person.ok);

    const work = await saveMemory(
      { text: 'orders table soft-deletes', scope: 'app' },
      { by: 'm:analyst', userId: 'u1', agent: 'analyst', config: CONFIG },
    );
    assert.isTrue(work.ok);

    const p = await AgentMemories.findOneAsync({ scope: 'user' } as any);
    const a = await AgentMemories.findOneAsync({ scope: 'app' } as any);
    assert.equal(p?.userId, 'u1');
    // The absence is the sharing — not null, ABSENT.
    assert.isUndefined(a?.userId, 'an app row must not carry a userId at all');
    assert.equal(a?.by, 'm:analyst', 'provenance records which colleague learned it');
  });

  it('is shared across agents: what support saves, analyst reads', async () => {
    const { saveMemory, listForBlock } = await import('../server/memory');
    await saveMemory(
      { text: 'dispute #8812 was an auth hold' },
      { by: 'm:support', userId: 'u1', agent: 'support', config: CONFIG },
    );
    // A DIFFERENT agent, same owner — memory follows the human (decision 2).
    const seen = await listForBlock('u1', 'analyst', CONFIG);
    assert.lengthOf(seen.person, 1);
    assert.include(seen.person[0].text, 'auth hold');
  });

  it('refuses a person save with no account, and never keys a store on null', async () => {
    const { saveMemory } = await import('../server/memory');
    const r = await saveMemory(
      { text: 'anything' },
      { by: 'm:support', userId: null, agent: 'support', config: CONFIG },
    );
    assert.isFalse(r.ok);
    assert.equal((r as any).error, 'no-account');
  });

  it('caps each scope independently and refuses past the cap', async () => {
    const { saveMemory } = await import('../server/memory');
    for (let i = 0; i < CONFIG.max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await saveMemory(
        { text: `fact ${i}` },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      assert.isTrue(ok.ok, `save ${i} should fit`);
    }
    const over = await saveMemory(
      { text: 'one too many' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    assert.isFalse(over.ok);
    assert.equal((over as any).error, 'memory-full');

    // The APP pool has its own cap and is untouched by a full person store.
    const app = await saveMemory(
      { text: 'a work fact', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    assert.isTrue(app.ok);
  });

  it('a keyed save UPDATES rather than duplicating — and works in a FULL store', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    await saveMemory(
      { text: 'timezone PST', key: 'tz' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    // Fill to the cap.
    for (let i = 0; i < CONFIG.max - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await saveMemory(
        { text: `filler ${i}` },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
    }
    const again = await saveMemory(
      { text: 'timezone America/Vancouver', key: 'tz' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    assert.isTrue(again.ok, 'a correction must not be blocked by a full store');
    assert.isTrue((again as any).updated);
    const keyed = await AgentMemories.find({ key: 'tz' } as any).fetchAsync();
    assert.lengthOf(keyed, 1, 'the key must resolve to exactly one row');
    assert.include(keyed[0].text, 'Vancouver');
  });

  it('refuses a scope the agent did not enable, and text past the cap', async () => {
    const { saveMemory } = await import('../server/memory');
    const noApp = await saveMemory(
      { text: 'sneaking into the shared pool', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: PERSON_ONLY },
    );
    assert.isFalse(noApp.ok);
    assert.equal((noApp as any).error, 'scope-unavailable');

    const long = await saveMemory(
      { text: 'x'.repeat(2100) },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    assert.isFalse(long.ok);
    assert.equal((long as any).error, 'too-long');
  });

  it("forget cannot distinguish someone else's row from a missing one", async () => {
    const { saveMemory, forgetMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const mine = await saveMemory(
      { text: 'mine' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    const theirs = await saveMemory(
      { text: 'theirs' },
      { by: 'm:s', userId: 'u2', agent: 's', config: CONFIG },
    );
    const other = await forgetMemory((theirs as any).id, {
      userId: 'u1', agent: 's', allowApp: true,
    });
    assert.deepEqual(other, { ok: true, forgotten: false });
    const missing = await forgetMemory('nope', { userId: 'u1', agent: 's', allowApp: true });
    assert.deepEqual(missing, { ok: true, forgotten: false },
      'a foreign row and a missing row must answer identically');

    const own = await forgetMemory((mine as any).id, {
      userId: 'u1', agent: 's', allowApp: true,
    });
    assert.deepEqual(own, { ok: true, forgotten: true });
    assert.equal(await AgentMemories.find({} as any).countAsync(), 1);
  });

  it("forget cannot remove another agent's private per-user fact", async () => {
    const { saveMemory, forgetMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const agentMemory = {
      ...CONFIG,
      scopes: ['user', 'agent', 'app'] as Array<'user' | 'agent' | 'app'>,
    };
    const saved = await saveMemory(
      { text: 'private working preference', scope: 'agent' },
      { by: 'm:alpha', userId: 'u1', agent: 'alpha', config: agentMemory },
    );
    assert.isTrue(saved.ok);
    const other = await forgetMemory((saved as any).id, {
      userId: 'u1', agent: 'beta', allowApp: true,
    });
    assert.deepEqual(other, { ok: true, forgotten: false });
    assert.isDefined(await AgentMemories.findOneAsync((saved as any).id));
  });

  it('refuses to forget an app row when allowApp is false (the DDP posture)', async () => {
    const { saveMemory, forgetMemory } = await import('../server/memory');
    const app = await saveMemory(
      { text: 'shared', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    const denied = await forgetMemory((app as any).id, {
      userId: 'u1', agent: 's', allowApp: false,
    });
    assert.isFalse(denied.ok);
    assert.equal((denied as any).error, 'denied-scope');
  });
});

describe('memory — the search ladder', () => {
  beforeEach(clean);
  after(clean);

  it('falls to the regex rung and still answers when no vector rung exists', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    const restore = _setMemorySearch(null);
    try {
      await saveMemory(
        { text: 'the orders table soft-deletes' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      const rows = await searchMemory('soft-deletes', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.isAtLeast(rows.length, 1, 'the floor rung must still find it');
      assert.oneOf(_activeRung(), ['text', 'regex']);
    } finally { restore(); }
  });

  it('never throws on regex metacharacters — ON THE REGEX RUNG', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch, _forceRegexRung } =
      await import('../server/memory');
    const restore = _setMemorySearch(null);
    // Force the floor: the text index exists in the test database, so without
    // this the text rung answers and the escaping is never exercised at all.
    const restoreRung = _forceRegexRung();
    try {
      await saveMemory(
        { text: 'order 8812 dispute resolved' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      // Unescaped, this compiles to a SyntaxError inside the hint path and
      // takes the turn down.
      const rows = await searchMemory('order #8812 (dispute [unclosed', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.equal(_activeRung(), 'regex', 'the floor rung must be the one under test');
      assert.isAtLeast(rows.length, 1, 'escaped tokens must still match the row');
      assert.include(rows[0].text, '8812');
    } finally { restoreRung(); restore(); }
  });

  it('falls back to recency when every token is too short to match on', async () => {
    const { saveMemory, searchMemory, _setMemorySearch, _forceRegexRung } =
      await import('../server/memory');
    const restore = _setMemorySearch(null);
    const restoreRung = _forceRegexRung();
    try {
      await saveMemory(
        { text: 'a recent fact' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      // Tokens of <= 2 chars are dropped; the rung must still answer.
      const rows = await searchMemory('is a', { userId: 'u1', agent: 's', config: CONFIG });
      assert.isAtLeast(rows.length, 1, 'a short query must degrade to recency, not to nothing');
    } finally { restoreRung(); restore(); }
  });

  it('prefers an app-installed search fn over every built-in rung', async () => {
    const { searchMemory, _activeRung } = await import('../server/memory');
    const fake: AgentMemory[] = [{
      _id: 'x', scope: 'user', userId: 'u1', text: 'from the app', by: 'app', at: new Date(),
    }];
    const rows = await searchMemory('anything', {
      userId: 'u1',
      agent: 's',
      config: { ...CONFIG, search: () => fake },
    });
    assert.equal(_activeRung(), 'installed');
    assert.equal(rows[0].text, 'from the app');
  });

  it('degrades to the built-in ladder when the installed fn throws', async () => {
    const { saveMemory, searchMemory, _setMemorySearch } = await import('../server/memory');
    const restore = _setMemorySearch(null);
    try {
      await saveMemory(
        { text: 'still findable' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      const rows = await searchMemory('findable', {
        userId: 'u1',
        agent: 's',
        config: {
          ...CONFIG,
          search: () => { throw new Error('the app\'s search is broken'); },
        },
      });
      assert.isAtLeast(rows.length, 1, "an app's bug must not be the conversation's death");
    } finally { restore(); }
  });

  it('uses the vector rung when one is available, and scopes it', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    let sawSelector: unknown = null;
    const restore = _setMemorySearch(async (sel, _q, limit) => {
      sawSelector = sel;
      return AgentMemories.find(sel as any, { limit }).fetchAsync();
    });
    try {
      await saveMemory(
        { text: 'mine' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      await saveMemory(
        { text: 'someone else' },
        { by: 'm:s', userId: 'u2', agent: 's', config: CONFIG },
      );
      const rows = await searchMemory('anything', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.equal(_activeRung(), 'vector');
      assert.isOk(sawSelector, 'the rung must receive the scope selector');
      assert.deepEqual(rows.map((r) => r.text), ['mine'],
        'the vector rung must not leak another account\'s rows');
    } finally { restore(); }
  });
});

describe('memory — the standing block', () => {
  beforeEach(clean);
  after(clean);

  it('renders nothing at all when there is nothing to say', async () => {
    const { memoryBlock } = await import('../server/memory');
    assert.equal(await memoryBlock({ userId: 'u1', agent: 's', config: CONFIG }), '');
  });

  it('splits person and work sections, and shows work provenance', async () => {
    const { saveMemory, memoryBlock } = await import('../server/memory');
    await saveMemory(
      { text: 'prefers email' },
      { by: 'm:support', userId: 'u1', agent: 'support', config: CONFIG },
    );
    await saveMemory(
      { text: 'orders soft-delete', scope: 'app' },
      { by: 'm:analyst', userId: 'u1', agent: 'analyst', config: CONFIG },
    );
    const block = await memoryBlock({ userId: 'u1', agent: 'support', config: CONFIG });
    assert.include(block, '## Memory');
    assert.include(block, 'About this person');
    assert.include(block, 'prefers email');
    assert.include(block, 'About this work');
    assert.include(block, '[learned by m:analyst]');
    assert.include(block, 'memory_search');
  });

  it('an anonymous session gets work memory and an honest line, never a person store', async () => {
    const { saveMemory, memoryBlock } = await import('../server/memory');
    await saveMemory(
      { text: 'someone else private fact' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    await saveMemory(
      { text: 'shared work note', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    const block = await memoryBlock({ userId: null, agent: 's', config: CONFIG });
    assert.include(block, 'shared work note');
    assert.notInclude(block, 'private fact', 'anonymous must never read a person store');
    assert.include(block, 'no signed-in account');
  });

  it('pinned rows lead and do not consume recent slots', async () => {
    const { saveMemory, memoryBlock } = await import('../server/memory');
    const cfg = { ...CONFIG, max: 20, index: { pinned: 2, recent: 2 } };
    await saveMemory(
      { text: 'PINNED ONE', pinned: true },
      { by: 'm:s', userId: 'u1', agent: 's', config: cfg },
    );
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await saveMemory(
        { text: `recent ${i}` },
        { by: 'm:s', userId: 'u1', agent: 's', config: cfg },
      );
    }
    const block = await memoryBlock({ userId: 'u1', agent: 's', config: cfg });
    assert.include(block, 'PINNED ONE');
    assert.include(block, '[pinned]');
    // pinned(1) + recent(2) rows, and the total tells the model more exist.
    assert.include(block, '(5 remembered)');
    const bullets = block.split('\n').filter((l) => l.startsWith('- '));
    assert.lengthOf(bullets, 3);
  });

  it('appends the hint line only when the hint found something', async () => {
    const { memoryBlock } = await import('../server/memory');
    const withHint = await memoryBlock({
      userId: 'u1', agent: 's', config: CONFIG, hint: ['dispute #8812 (work)'],
    });
    assert.include(withHint, 'Possibly relevant to the latest message');
    assert.include(withHint, 'dispute #8812');
  });
});

describe('memory — config resolution', () => {
  it('true takes defaults, and user scope is always implied', async () => {
    const { resolveMemory } = await import('../server/registry');
    const def = resolveMemory(true)!;
    assert.equal(def.max, 200);
    assert.equal(def.maxApp, 500);
    assert.deepEqual(def.index, { pinned: 5, recent: 10 });
    assert.deepEqual(def.scopes, ['user']);
    assert.deepEqual(def.hints, { minScore: 0.6 });

    // Naming only 'app' means "also app", never "no person store".
    assert.deepEqual(resolveMemory({ scopes: ['app'] })!.scopes, ['user', 'app']);
    assert.isUndefined(resolveMemory(undefined));
    assert.isUndefined(resolveMemory(false));
  });

  it('rejects an unknown key rather than silently ignoring it', async () => {
    const { resolveMemory } = await import('../server/registry');
    assert.throws(
      () => resolveMemory({ hint: false } as any),
      /unknown key "hint"/,
    );
  });

  it('rejects bad numbers, scopes, and a non-function search at define time', async () => {
    const { resolveMemory } = await import('../server/registry');
    assert.throws(() => resolveMemory({ max: '200' } as any), /positive integer/);
    assert.throws(() => resolveMemory({ index: { pinned: 0 } } as any), /positive integer/);
    assert.throws(() => resolveMemory({ scopes: ['nope'] } as any), /unknown scope/);
    assert.throws(() => resolveMemory({ scopes: [] } as any), /non-empty array/);
    assert.throws(() => resolveMemory({ search: 'nope' } as any), /must be a function/);
    assert.throws(
      () => resolveMemory({ hints: { minScore: 2 } } as any),
      /minScore must be a finite number/,
    );
  });

  it('reserves the three tool names against an agent\'s own tools', async () => {
    const { assertMemoryNamesFree, MEMORY_TOOL_NAMES } = await import('../server/tools');
    assert.deepEqual(
      [...MEMORY_TOOL_NAMES],
      ['memory_save', 'memory_search', 'memory_forget'],
    );
    assert.doesNotThrow(() => assertMemoryNamesFree(['orders.lookup']));
    assert.throws(
      () => assertMemoryNamesFree([{ name: 'memory_save', description: 'x', args: {} } as any]),
      /reserved memory tool names/,
    );
  });
});

describe('memory — the model surface', () => {
  beforeEach(clean);
  after(clean);

  it('appends three tools, and gates ONLY the app-scope save', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const tools = withMemoryTools([], {
      config: CONFIG, by: 'm:support', agent: 'support',
    });
    assert.deepEqual(tools.map((t) => t.name),
      ['memory_save', 'memory_search', 'memory_forget']);

    const save = tools.find((t) => t.name === 'memory_save')!;
    assert.isFunction(save.gate);
    const gate = save.gate as (ctx: any) => boolean | 'ask';
    assert.equal(gate({ args: { text: 'personal' } }), true,
      'a personal note is deliberate but unprompted');
    assert.equal(gate({ args: { text: 'shared', scope: 'app' } }), 'ask',
      'promoting to shared knowledge is the consent moment');

    // search is never gated — recall is legible, not dangerous.
    assert.equal(tools.find((t) => t.name === 'memory_search')!.gate, 'auto');
  });

  it('describe shows the approver the scope and the exact text', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const [save] = withMemoryTools([], {
      config: CONFIG, by: 'm:analyst', agent: 'analyst',
    });
    const shared = await save.describe!({ text: 'orders soft-delete', scope: 'app' }, {} as any);
    assert.include(shared, 'ALL users');
    assert.include(shared, 'orders soft-delete');
    const personal = await save.describe!({ text: 'prefers email' }, {} as any);
    assert.notInclude(personal, 'ALL users');
  });

  it('yields to an app tool of the same name rather than shadowing it', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const appTool = {
      name: 'memory_save', description: 'the app\'s own', args: {}, gate: 'auto', kind: 'inline',
      run: async () => 'ok',
    } as any;
    const tools = withMemoryTools([appTool], {
      config: CONFIG, by: 'm:s', agent: 's',
    });
    // PER NAME: the app keeps memory_save, and the two that did not collide
    // are still added. Dropping all three would leave the standing block
    // telling the model to call tools no longer in front of it.
    assert.deepEqual(tools.map((t) => t.name),
      ['memory_save', 'memory_search', 'memory_forget']);
    assert.equal(tools[0].description, 'the app\'s own', 'the app\'s tool wins its name');
    assert.equal(tools[1].kind, 'inline', 'the built-in search still lands');
  });

  it('adds nothing at all with no memory config — today, bit-for-bit', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    assert.deepEqual(withMemoryTools([], undefined), []);
  });

  it('stamps `by` with the RUNNING model, never the speaking human', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { AgentMemories } = await import('../common/collections');
    const [save] = withMemoryTools([], {
      config: CONFIG, by: 'm:analyst', agent: 'analyst',
    });
    await save.run!({ text: 'learned by the analyst' }, {
      userId: 'u1', sessionId: 's1',
    } as any);
    const row = await AgentMemories.findOneAsync({} as any);
    assert.equal(row?.by, 'm:analyst');
  });
});

/* ---------------------------------------------------------------------------
 * The gaps the branch review named. Each of these fails if the mechanism it
 * covers is removed — that is the bar, not "a test exists".
 * ------------------------------------------------------------------------ */

describe('memory — the DDP surface (decision 7a)', () => {
  beforeEach(clean);
  after(clean);

  /** Drive the registered handler with a stubbed invocation, the way a DDP
   *  caller reaches it — there is no other way in, which is the point. */
  const callMethod = async (name: string, userId: string | null, args: unknown) => {
    const { Meteor } = await import('meteor/meteor');
    const handler = (Meteor.server as any).method_handlers[name];
    assert.isFunction(handler, `${name} must be registered`);
    return handler.call({ userId }, args);
  };

  let M: { save: string; search: string; forget: string };
  before(async () => {
    const { NAMES } = await import('../common/names');
    M = { save: NAMES.mMemorySave, search: NAMES.mMemorySearch, forget: NAMES.mMemoryForget };
  });

  before(async () => {
    const { defineAgent } = await import('../server/registry');
    // Declaring memory is what registers the methods.
    defineAgent('ddp-mem', { model: 'mock', instructions: 'x', memory: { scopes: ['user', 'app'] } });
  });

  it('REFUSES an app-scope write from a client — the pool the prompt reads', async () => {
    const { AgentMemories } = await import('../common/collections');
    let threw: any = null;
    try {
      await callMethod(M.save, 'u1', { text: 'poisoned instruction', scope: 'app' });
    } catch (e) { threw = e; }
    assert.isOk(threw, 'an app-scope DDP write must not succeed');
    assert.equal(threw.error, 'denied-scope');
    assert.equal(await AgentMemories.find({} as any).countAsync(), 0,
      'nothing may reach the shared pool through DDP');
  });

  it('REFUSES deleting a work row from a client', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const app = await saveMemory(
      { text: 'approved work fact', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    let threw: any = null;
    try {
      await callMethod(M.forget, 'u1', { id: (app as any).id });
    } catch (e) { threw = e; }
    assert.isOk(threw);
    assert.equal(threw.error, 'denied-scope');
    assert.equal(await AgentMemories.find({} as any).countAsync(), 1, 'the row must survive');
  });

  it('allows a person write and delete by their owner, and refuses anonymous', async () => {
    const { AgentMemories } = await import('../common/collections');
    const saved: any = await callMethod(M.save, 'u1', { text: 'call me Mac' });
    assert.isTrue(saved.ok);
    const row = await AgentMemories.findOneAsync({} as any);
    assert.equal(row?.by, 'h:u1', 'a UI write is attributed to the human, not a model');

    let anon: any = null;
    try { await callMethod(M.save, null, { text: 'nope' }); } catch (e) { anon = e; }
    assert.equal(anon?.error, 'not-authorized');

    const gone: any = await callMethod(M.forget, 'u1', { id: row!._id });
    assert.deepEqual(gone, { ok: true, forgotten: true });
  });

  it('registers ONCE — a second memory-declaring agent must not throw', async () => {
    const { defineAgent } = await import('../server/registry');
    const { _memoryMethodsRegistered } = await import('../server/memory-methods');
    assert.isTrue(_memoryMethodsRegistered());
    // Meteor.methods throws on a duplicate name; without the latch this is the
    // line that takes the server down at boot.
    assert.doesNotThrow(() => defineAgent('ddp-mem-2', {
      model: 'mock', instructions: 'x', memory: { max: 10 },
    }));
    // …and redefining the same agent (hot reload) is equally harmless.
    assert.doesNotThrow(() => defineAgent('ddp-mem', {
      model: 'mock', instructions: 'x', memory: true,
    }));
  });
});

describe('memory — the forget gate reads the ROW, not the args', () => {
  beforeEach(clean);
  after(clean);

  it('ASKS before forgetting a work row, and runs a personal one straight through', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { saveMemory } = await import('../server/memory');
    const tools = withMemoryTools([], { config: CONFIG, by: 'm:s', agent: 's' });
    const forget = tools.find((t) => t.name === 'memory_forget')!;
    const gate = forget.gate as (ctx: any) => Promise<boolean | 'ask'>;

    const app = await saveMemory(
      { text: 'shared, human-approved', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    const mine = await saveMemory(
      { text: 'personal' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );

    // The bug this pins: forget takes { id } with no scope, so a gate that
    // reads args.scope resolved 'auto' and let the model erase approved
    // shared knowledge unasked.
    assert.equal(await gate({ args: { id: (app as any).id } }), 'ask');
    assert.equal(await gate({ args: { id: (mine as any).id } }), true);
    assert.equal(await gate({ args: { id: 'missing' } }), true);
    assert.equal(await gate({ args: {} }), true);
  });

  it('describe shows the approver WHAT is being forgotten, not an opaque id', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { saveMemory } = await import('../server/memory');
    const tools = withMemoryTools([], { config: CONFIG, by: 'm:s', agent: 's' });
    const forget = tools.find((t) => t.name === 'memory_forget')!;
    const app = await saveMemory(
      { text: 'orders soft-delete', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    const shown = await forget.describe!({ id: (app as any).id }, {} as any);
    assert.include(shown, 'ALL users');
    assert.include(shown, 'orders soft-delete');
  });

  it('never asks when the agent has no app scope at all', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const tools = withMemoryTools([], { config: PERSON_ONLY, by: 'm:s', agent: 's' });
    const forget = tools.find((t) => t.name === 'memory_forget')!;
    const gate = forget.gate as (ctx: any) => Promise<boolean | 'ask'>;
    assert.equal(await gate({ args: { id: 'anything' } }), true);
  });
});

describe('memory — agent scope', () => {
  beforeEach(clean);
  after(clean);

  const AGENT_SCOPE = { ...CONFIG, scopes: ['agent'] as Array<'user' | 'agent' | 'app'> };

  it('stamps the agent, and keeps one agent notes out of another view', async () => {
    const { saveMemory, listForBlock } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const r = await saveMemory(
      { text: 'this user prefers terse answers', scope: 'agent' },
      { by: 'm:a', userId: 'u1', agent: 'a', config: AGENT_SCOPE },
    );
    assert.isTrue(r.ok);
    const row = await AgentMemories.findOneAsync({ scope: 'agent' } as any);
    assert.equal(row?.agent, 'a', 'an agent-scope row must record whose note it is');
    assert.equal(row?.userId, 'u1');

    const mine = await listForBlock('u1', 'a', AGENT_SCOPE);
    assert.lengthOf(mine.person, 1);
    const theirs = await listForBlock('u1', 'b', AGENT_SCOPE);
    assert.lengthOf(theirs.person, 0, 'agent scope is private to the agent that wrote it');
  });
});

describe('memory — the cap under concurrency', () => {
  beforeEach(clean);
  after(clean);

  it('bounds growth, and a keyed race still resolves to one row', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const cfg = { ...CONFIG, max: 4 };
    for (let i = 0; i < cfg.max - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await saveMemory(
        { text: `filler ${i}` },
        { by: 'm:s', userId: 'u1', agent: 's', config: cfg },
      );
    }
    // Two parallel tool calls in one assistant message — the real shape.
    await Promise.all([
      saveMemory({ text: 'race a' }, { by: 'm:s', userId: 'u1', agent: 's', config: cfg }),
      saveMemory({ text: 'race b' }, { by: 'm:s', userId: 'u1', agent: 's', config: cfg }),
    ]);
    const n = await AgentMemories.find({ scope: 'user' } as any).countAsync();
    // The cap is a growth bound, not a quota: count-then-insert can overshoot
    // by the number of in-flight saves. Pinned here so a change is deliberate.
    assert.isAtLeast(n, cfg.max);
    assert.isAtMost(n, cfg.max + 1, 'overshoot must stay bounded by concurrency');
  });
});

describe('memory — primary-follows threading (decision 19)', () => {
  it('an addressed colleague runs with the PRIMARY memory, not its own absence', async () => {
    const { defineAgent, getAgent, buildRunConfig, resolveMemory } =
      await import('../server/registry');
    defineAgent('mem-primary', {
      model: 'mock', instructions: 'x', memory: { max: 7 },
    });
    // The colleague declares NO memory of its own.
    defineAgent('mem-colleague', { model: 'mock', instructions: 'x' });

    const addressed = buildRunConfig(getAgent('mem-colleague')!, 'u1', {
      agentName: 'mem-colleague',
      memory: resolveMemory(getAgent('mem-primary')!.memory)!,
    });
    assert.isOk(addressed.memory, 'recall must not vanish because a colleague was @-mentioned');
    assert.equal(addressed.memory!.max, 7);

    // With no opts, an agent's own config answers — every non-addressed wake.
    assert.equal(buildRunConfig(getAgent('mem-primary')!, 'u1').memory!.max, 7);
    assert.isUndefined(buildRunConfig(getAgent('mem-colleague')!, 'u1').memory);
  });
});

describe('memory — inside a turn', () => {
  const seed = async (
    sessionId: string, agent: string, text: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(), ...extra,
    } as any);
    await AgentMessages.insertAsync({
      _id: 'u-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
    } as any);
  };

  beforeEach(clean);
  after(async () => {
    await clean();
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
  });

  it('puts the listing in the system prompt and the tools in front of the model', async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');
    const { saveMemory } = await import('../server/memory');

    let seen: any = null;
    defineAgent('mem-turn', {
      model: 'mock',
      instructions: 'You are helpful.',
      memory: { scopes: ['user', 'app'], hints: false },
      provider: {
        async *stream(req: any) {
          seen = req;
          yield { kind: 'text', chunk: 'ok' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      } as any,
    });
    await saveMemory(
      { text: 'prefers terse answers' },
      { by: 'm:mem-turn', userId: 'u1', agent: 'mem-turn', config: CONFIG },
    );
    await seed('mt-1', 'mem-turn', 'hi');
    await runTurn('mt-1', buildRunConfig(getAgent('mem-turn')!, 'u1'));

    assert.include(seen.system, 'You are helpful.');
    assert.include(seen.system, '## Memory');
    assert.include(seen.system, 'prefers terse answers');
    assert.includeMembers(
      seen.tools.map((t: any) => t.name),
      ['memory_save', 'memory_search', 'memory_forget'],
    );
  });

  it('gives a SUBAGENT CHILD no Fact Memory (decision 20)', async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');
    const { saveMemory } = await import('../server/memory');

    let seen: any = null;
    defineAgent('mem-child', {
      model: 'mock',
      instructions: 'child',
      memory: true,
      provider: {
        async *stream(req: any) {
          seen = req;
          yield { kind: 'text', chunk: 'ok' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      } as any,
    });
    await saveMemory(
      { text: 'MARKER-parent-memory' },
      { by: 'm:mem-child', userId: 'u1', agent: 'mem-child', config: CONFIG },
    );
    // A child session — its transcript folds back into the parent, which is
    // the Fact-Memory-bearing conversation.
    await seed('mt-child', 'mem-child', 'do the thing', {
      parent: { sessionId: 'p1', toolCallId: 't1', agent: 'mem-child' },
    });
    await runTurn('mt-child', buildRunConfig(getAgent('mem-child')!, 'u1'));

    assert.notInclude(seen.system, '## Memory');
    assert.notInclude(seen.system, 'MARKER-parent-memory');
    assert.notIncludeMembers(seen.tools.map((t: any) => t.name), ['memory_save'],
      'a child must not be able to write the parent memory');
  });

  it('gives an EPHEMERAL (Agent.ask) session no Fact Memory either', async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');

    let seen: any = null;
    defineAgent('mem-eph', {
      model: 'mock',
      instructions: 'throwaway',
      memory: true,
      provider: {
        async *stream(req: any) {
          seen = req;
          yield { kind: 'text', chunk: 'ok' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      } as any,
    });
    await seed('mt-eph', 'mem-eph', 'one shot', { ephemeral: true });
    await runTurn('mt-eph', buildRunConfig(getAgent('mem-eph')!, 'u1'));
    assert.notInclude(seen.system, '## Memory');
    assert.notIncludeMembers(seen.tools.map((t: any) => t.name), ['memory_save']);
  });

  it('runs the hint ONCE per turn, not once per iteration', async function () {
    this.timeout(30000);
    const { defineAgent, getAgent, buildRunConfig } = await import('../server/registry');
    const { runTurn } = await import('../server/loop');
    const { saveMemory, _setMemorySearch } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');

    let searches = 0;
    const restore = _setMemorySearch(async (sel, _q, limit) => {
      searches += 1;
      return AgentMemories.find(sel as any, { limit }).fetchAsync();
    });
    try {
      let call = 0;
      defineAgent('mem-hint', {
        model: 'mock',
        instructions: 'x',
        memory: { hints: true },
        // Two iterations: a tool call, then a final answer.
        tools: [{
          name: 'noop',
          description: 'does nothing',
          args: { type: 'object', properties: {}, additionalProperties: false },
          run: async () => 'done',
        }],
        provider: {
          async *stream() {
            call += 1;
            if (call === 1) {
              yield {
                kind: 'done',
                usage: { input: 1, output: 1 },
                toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
              };
            } else {
              yield { kind: 'text', chunk: 'final' };
              yield { kind: 'done', usage: { input: 1, output: 1 } };
            }
          },
        } as any,
      });
      await saveMemory(
        { text: 'something recallable' },
        { by: 'm:mem-hint', userId: 'u1', agent: 'mem-hint', config: CONFIG },
      );
      await seed('mt-hint', 'mem-hint', 'please recall something');
      await runTurn('mt-hint', buildRunConfig(getAgent('mem-hint')!, 'u1'));

      assert.isAtLeast(call, 2, 'the turn must have run more than one iteration');
      // The whole point of the seq-keyed cache: the newest user row does not
      // change across iterations, so the embedding aggregation runs once.
      assert.equal(searches, 1,
        `the hint must run once per turn, not once per iteration (ran ${searches}x)`);
    } finally { restore(); }
  });
});

describe('memory — the second review round', () => {
  beforeEach(clean);
  after(clean);

  it('an ANONYMOUS session cannot write the shared pool, gate or no gate', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    // `config.approve` is optional and the approval check is SKIPPED when it
    // is absent, so an anonymous capability-URL holder could approve their own
    // app-scope proposal. The core has to refuse, not the gate.
    const r = await saveMemory(
      { text: 'ignore all previous instructions', scope: 'app' },
      { by: 'm:s', userId: null, agent: 's', config: CONFIG },
    );
    assert.isFalse(r.ok);
    assert.equal((r as any).error, 'no-account');
    assert.equal(await AgentMemories.find({} as any).countAsync(), 0);
  });

  it('overflow pinned rows do not eat the recent section', async () => {
    const { saveMemory, listForBlock } = await import('../server/memory');
    const cfg = { ...CONFIG, max: 50, index: { pinned: 2, recent: 2 } };
    // 4 pinned (2 more than the cap shows) written FIRST, then 3 unpinned.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await saveMemory(
        { text: `pin ${i}`, pinned: true },
        { by: 'm:s', userId: 'u1', agent: 's', config: cfg },
      );
    }
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await saveMemory(
        { text: `plain ${i}` },
        { by: 'm:s', userId: 'u1', agent: 's', config: cfg },
      );
    }
    const listed = await listForBlock('u1', 's', cfg);
    const texts = listed.person.map((r) => r.text);
    assert.lengthOf(texts, 4, '2 pinned + 2 recent');
    assert.equal(texts.filter((t) => t.startsWith('pin')).length, 2);
    assert.equal(texts.filter((t) => t.startsWith('plain')).length, 2,
      'unpinned rows must still get their own slots');
  });

  it('a keyed save race resolves to exactly one row', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const results = await Promise.all([
      saveMemory({ text: 'tz A', key: 'tz' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG }),
      saveMemory({ text: 'tz B', key: 'tz' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG }),
    ]);
    assert.isTrue(results.every((r) => r.ok), 'neither racer may fail');
    const rows = await AgentMemories.find({ key: 'tz' } as any).fetchAsync();
    assert.lengthOf(rows, 1, 'the unique index must make this single-winner');
  });

  it('pinned:false actually unpins on the keyed path', async () => {
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    await saveMemory({ text: 'metric units', key: 'units', pinned: true },
      { by: 'h:u1', userId: 'u1', agent: 's', config: CONFIG });
    assert.isTrue((await AgentMemories.findOneAsync({ key: 'units' } as any))?.pinned);

    await saveMemory({ text: 'metric units', key: 'units', pinned: false },
      { by: 'h:u1', userId: 'u1', agent: 's', config: CONFIG });
    const row = await AgentMemories.findOneAsync({ key: 'units' } as any);
    assert.isUndefined(row?.pinned, 'an unpin button that reports success must unpin');
  });

  it('an agent without app scope cannot delete a work row', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { saveMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const app = await saveMemory(
      { text: 'approved shared fact', scope: 'app' },
      { by: 'm:analyst', userId: 'u1', agent: 'analyst', config: CONFIG },
    );
    // `support` resolves to scopes ['user'] — its forget gate short-circuits
    // to auto, so it must NOT also be handed allowApp.
    const tools = withMemoryTools([], { config: PERSON_ONLY, by: 'm:support', agent: 'support' });
    const forget = tools.find((t) => t.name === 'memory_forget')!;
    const res: any = await forget.run!({ id: (app as any).id }, { userId: 'u1' } as any);
    assert.isFalse(res.ok);
    assert.equal(res.error, 'denied-scope');
    assert.equal(await AgentMemories.find({} as any).countAsync(), 1, 'the row survives');
  });

  it('describe MARKS truncation rather than hiding what follows', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const [save] = withMemoryTools([], { config: CONFIG, by: 'm:s', agent: 's' });
    const long = `${'a'.repeat(300)}THEN-SOMETHING-ELSE`;
    const shown = await save.describe!({ text: long, scope: 'app' }, {} as any);
    assert.notInclude(shown, 'THEN-SOMETHING-ELSE');
    assert.include(shown, 'more characters',
      'a silent cut makes the approval dialog a place to hide things');
  });

  it('re-scopes rows an installed search fn returns', async () => {
    const { saveMemory, searchMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    await saveMemory({ text: 'u2 private' },
      { by: 'm:s', userId: 'u2', agent: 's', config: CONFIG });
    // The plausible first draft of an installed fn: no scope clause at all.
    const rows = await searchMemory('private', {
      userId: 'u1',
      agent: 's',
      config: {
        ...CONFIG,
        search: async () => AgentMemories.find({} as any).fetchAsync(),
      },
    });
    assert.lengthOf(rows, 0, "an app's mis-scoped search must not serve another account");
  });

  it('the DDP surface refuses agent scope — a client cannot name the agent', async () => {
    const { Meteor } = await import('meteor/meteor');
    const { NAMES } = await import('../common/names');
    const handler = (Meteor.server as any).method_handlers[NAMES.mMemorySave];
    let threw: any = null;
    try {
      await handler.call({ userId: 'u1' }, { text: 'x', scope: 'agent' });
    } catch (e) { threw = e; }
    assert.equal(threw?.error, 'denied-scope');
  });

  it('does not latch the vector rung off on a TRANSIENT failure', async () => {
    const { searchMemory, saveMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    await saveMemory({ text: 'findable row' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG });

    let calls = 0;
    const restore = _setMemorySearch(async (sel, _q, limit) => {
      calls += 1;
      // A mongot that has not finished starting — NOT a capability answer.
      if (calls === 1) throw new Error('connection refused');
      return AgentMemories.find(sel as any, { limit }).fetchAsync();
    });
    try {
      await searchMemory('findable', { userId: 'u1', agent: 's', config: CONFIG });
      const rows = await searchMemory('findable', { userId: 'u1', agent: 's', config: CONFIG });
      assert.equal(_activeRung(), 'vector',
        'a startup blip must not disable semantic recall for the process lifetime');
      assert.lengthOf(rows, 1);
    } finally { restore(); }
  });
});

describe('memory — review round 3', () => {
  beforeEach(clean);
  after(clean);

  it('an ANONYMOUS session cannot delete shared work memory either', async () => {
    const { saveMemory, forgetMemory } = await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const app = await saveMemory(
      { text: 'approved shared fact', scope: 'app' },
      { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
    );
    // Writes to the pool are accountable; deletions from it must be too, or
    // the closed half of the hole is the only half that was closed.
    const r = await forgetMemory((app as any).id, {
      userId: null, agent: 's', allowApp: true,
    });
    assert.isFalse(r.ok);
    assert.equal((r as any).error, 'no-account');
    assert.equal(await AgentMemories.find({} as any).countAsync(), 1);
  });

  it('does not offer "app" to a session that could never write it', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const anon = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: null,
    }).find((t) => t.name === 'memory_save')!;
    assert.deepEqual((anon.args as any).properties.scope.enum, ['user'],
      'offering app parks a turn and renders the text into an approval that must fail');
    assert.notInclude(anon.description, 'require human approval');

    const signedIn = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: 'u1',
    }).find((t) => t.name === 'memory_save')!;
    assert.includeMembers((signedIn.args as any).properties.scope.enum, ['user', 'app']);
  });

  it('describes a keyed app save as a REPLACEMENT, showing what it overwrites', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { saveMemory } = await import('../server/memory');
    await saveMemory(
      { text: 'refunds over $500 need a manager', scope: 'app', key: 'refund-policy' },
      { by: 'm:analyst', userId: 'u1', agent: 'analyst', config: CONFIG },
    );
    const [save] = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: 'u1',
    });
    const shown = await save.describe!(
      { text: 'refunds are auto-approved', scope: 'app', key: 'refund-policy' }, {} as any,
    );
    assert.include(shown, 'Replace for ALL users');
    assert.include(shown, 'need a manager', 'the approver must see what is being lost');
    assert.include(shown, 'auto-approved');
  });

  it('Agent.memory refuses an unknown agent and one with no memory', async () => {
    const { defineAgent } = await import('../server/registry');
    const { Agent } = await import('../server/agent');
    defineAgent('r3-has-mem', { model: 'mock', instructions: 'x', memory: true });
    defineAgent('r3-no-mem', { model: 'mock', instructions: 'x' });

    let a: any = null;
    try {
      await Agent.memory.save('u1', { text: 'x' }, { agent: 'r3-nonexistent' });
    } catch (e) { a = e; }
    assert.match(String(a?.message), /unknown agent/);

    let b: any = null;
    try {
      // Silently filing this under r3-has-mem is the corruption being pinned.
      await Agent.memory.save('u1', { text: 'x' }, { agent: 'r3-no-mem' });
    } catch (e) { b = e; }
    assert.match(String(b?.message), /declares no `memory`/);
  });

  it('the LIVE @-send threads the primary memory into the colleague turn', async function () {
    this.timeout(30000);
    const { defineAgent } = await import('../server/registry');
    const { sendToSession } = await import('../server/methods');
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');

    // Capture what actually reaches the provider on the colleague's turn.
    let colleagueSystem: string | null = null;
    const capture = {
      async *stream(req: any) {
        colleagueSystem = req.system;
        yield { kind: 'text', chunk: 'ok' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    } as any;
    defineAgent('r3-primary', {
      model: 'mock', instructions: 'primary', memory: { hints: false }, provider: capture,
    });
    // The colleague declares NO memory of its own — the case that broke.
    defineAgent('r3-colleague', { model: 'mock', instructions: 'colleague', provider: capture });

    const { saveMemory } = await import('../server/memory');
    await saveMemory(
      { text: 'MARKER-conversation-memory' },
      { by: 'm:r3-primary', userId: 'u1', agent: 'r3-primary', config: CONFIG },
    );

    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: 'r3-sid', agent: 'r3-primary', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      participants: [
        { id: 'h:u1', kind: 'human', role: 'owner', userId: 'u1', displayName: 'u', joinedAt: new Date() },
        { id: 'm:r3-primary', kind: 'model', role: 'member', agent: 'r3-primary', displayName: 'p', joinedAt: new Date() },
        { id: 'm:r3-colleague', kind: 'model', role: 'member', agent: 'r3-colleague', displayName: 'c', joinedAt: new Date() },
      ],
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    await sendToSession(
      'r3-primary', 'r3-sid', '@r3-colleague what do you know about me?', 'u1',
    );
    await waitForCond(async () => colleagueSystem !== null, 'the colleague turn to run');

    assert.include(colleagueSystem!, 'colleague', 'the addressee config ran');
    assert.include(colleagueSystem!, 'MARKER-conversation-memory',
      'recall must not vanish because a colleague was @-mentioned');
  });
});

/** Bounded wait — the addressed turn is deferred and exposes no promise. */
const waitForCond = async (cond: () => Promise<boolean>, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

describe('memory — the approval surface never leaks to an account-less session', () => {
  beforeEach(clean);
  after(clean);

  it('does not park an anonymous save, and does not echo stored work memory', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const { saveMemory } = await import('../server/memory');
    await saveMemory(
      { text: 'SECRET-work-fact', scope: 'app', key: 'k1' },
      { by: 'm:analyst', userId: 'u1', agent: 'analyst', config: CONFIG },
    );

    const [save] = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: null,
    });
    // Gates read RAW args — schema validation happens after dispatch — so a
    // fabricated out-of-enum scope reaches the gate even though the tool
    // never offered it. It must not park a turn that can only be refused.
    const gate = save.gate as (ctx: any) => boolean | 'ask';
    assert.equal(gate({ args: { text: 'x', scope: 'app' }, userId: null }), true);
    // …and describe must not echo the stored fact into that session's
    // approval surface on the way.
    const shown = await save.describe!(
      { text: 'mine', scope: 'app', key: 'k1' }, { userId: null, sessionId: 's' } as any,
    );
    assert.notInclude(shown, 'SECRET-work-fact');

    const forget = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: null,
    }).find((t) => t.name === 'memory_forget')!;
    const fgate = forget.gate as (ctx: any) => Promise<boolean | 'ask'>;
    assert.equal(await fgate({ args: { id: 'anything' }, userId: null }), true);
    const fshown = await forget.describe!(
      { id: 'anything' }, { userId: null, sessionId: 's' } as any,
    );
    assert.notInclude(fshown, 'SECRET-work-fact');
  });

  it('still asks, and still shows the text, for a signed-in session', async () => {
    const { withMemoryTools } = await import('../server/memory-tools');
    const [save] = withMemoryTools([], {
      config: CONFIG, by: 'm:s', agent: 's', userId: 'u1',
    });
    const gate = save.gate as (ctx: any) => boolean | 'ask';
    assert.equal(gate({ args: { text: 'x', scope: 'app' }, userId: 'u1' }), 'ask');
    const shown = await save.describe!(
      { text: 'a shared fact', scope: 'app' }, { userId: 'u1', sessionId: 's' } as any,
    );
    assert.include(shown, 'a shared fact');
  });
});

describe('memory — the vector readiness probe', () => {
  beforeEach(clean);
  after(clean);

  /**
   * These pin what a live MongoDB 8.2 + mongot actually does, captured by
   * smoking the real pipeline rather than reasoning about it:
   *
   *   no search node        → $listSearchIndexes throws (SearchNotEnabled)
   *   index never created   → $vectorSearch returns NOTHING and does not throw
   *   index build FAILED    → "…while in state FAILED"
   *   filter path undeclared→ "Path 'agent' needs to be indexed as filter"
   *
   * The middle one is why readiness is a PROBE: a ladder that waits to be
   * thrown at never engages for a missing index, and reports the vector rung
   * working while returning nothing forever.
   */

  it('falls through to a working rung when the vector rung is not ready', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    // Clearing the stub returns the module to UNPROBED, so the real probe runs
    // against the test database — which has no search node.
    const restore = _setMemorySearch(null);
    try {
      await saveMemory(
        { text: 'findable without a vector index' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      const rows = await searchMemory('findable', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.notEqual(_activeRung(), 'vector',
        'a deployment with no search node must not report the vector rung');
      assert.isAtLeast(rows.length, 1, 'and recall must still work');
    } finally { restore(); }
  });

  it('an installed stub IS the rung — no probe, and it answers', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    const restore = _setMemorySearch(
      async (sel, _q, limit) => AgentMemories.find(sel as any, { limit }).fetchAsync(),
    );
    try {
      await saveMemory(
        { text: 'via the stubbed vector rung' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      const rows = await searchMemory('anything', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.equal(_activeRung(), 'vector');
      assert.lengthOf(rows, 1);
    } finally { restore(); }
  });

  it('a transient throw from a READY rung costs one call, not the process', async () => {
    const { saveMemory, searchMemory, _activeRung, _setMemorySearch } =
      await import('../server/memory');
    const { AgentMemories } = await import('../common/collections');
    let n = 0;
    const restore = _setMemorySearch(async (sel, _q, limit) => {
      n += 1;
      if (n === 1) throw new Error('connection reset by peer');
      return AgentMemories.find(sel as any, { limit }).fetchAsync();
    });
    try {
      await saveMemory(
        { text: 'still here' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      await searchMemory('still', { userId: 'u1', agent: 's', config: CONFIG });
      const rows = await searchMemory('still', { userId: 'u1', agent: 's', config: CONFIG });
      assert.equal(_activeRung(), 'vector',
        'a mongot that restarted under us must not cost the process its rung');
      assert.lengthOf(rows, 1);
    } finally { restore(); }
  });

  it('recognizes the real filter-path error text from a live mongot', async () => {
    const { searchMemory, _setMemorySearch } = await import('../server/memory');
    const restore = _setMemorySearch(async () => {
      // Verbatim from MongoDB 8.2 + mongot.
      throw new Error("Path 'agent' needs to be indexed as filter");
    });
    try {
      // Degrades rather than throwing, and the warning names updateSearchIndex.
      const rows = await searchMemory('anything', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.isArray(rows, 'a definition mismatch must not fail the turn');
    } finally { restore(); }
  });
});
