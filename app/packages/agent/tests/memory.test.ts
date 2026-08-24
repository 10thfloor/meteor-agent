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

  it('never throws on regex metacharacters in raw human text', async () => {
    const { saveMemory, searchMemory, _setMemorySearch } = await import('../server/memory');
    const restore = _setMemorySearch(null);
    try {
      await saveMemory(
        { text: 'order 8812 dispute resolved' },
        { by: 'm:s', userId: 'u1', agent: 's', config: CONFIG },
      );
      // Unescaped, this is a SyntaxError inside the hint path.
      const rows = await searchMemory('order #8812 (dispute [unclosed', {
        userId: 'u1', agent: 's', config: CONFIG,
      });
      assert.isArray(rows);
    } finally { restore(); }
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
    assert.lengthOf(tools, 1);
    assert.equal(tools[0].description, 'the app\'s own');
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
