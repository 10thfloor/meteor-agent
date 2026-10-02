import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { applyRateLimits, Durable, NAMES } from 'meteor/10thfloor:durable';
import { _setViewRecheckMs } from '../server/publications';
import { AGENT, hang, harnessOptions, loadPieces, type Pieces, textOf, until } from './support';

// The Meteor face of the package: a `Durable` definition, the DDP methods and
// the publication, as a server sees them. Handlers are called directly, with
// the `this` Meteor would give them; the browser suite drives the same
// surface over a real connection.

describe('Durable', function () {
  this.timeout(60_000);

  let pieces: Pieces;
  let Missions: Durable;
  /** Users this run's `allow` rule knows: `owner` may do everything, `reader` may only watch. */
  const owner = `owner-${Random.id(6)}`;
  const reader = `reader-${Random.id(6)}`;
  const revoked = new Set<string>();
  const created: string[] = [];
  const newKey = () => {
    const key = `m-${Random.id(8)}`;
    created.push(key);
    return key;
  };

  const method = (name: string, userId: string | null, params: unknown): Promise<any> =>
    (Meteor as any).server.method_handlers[name].call({ userId, unblock() {} }, params);
  const rejection = (work: Promise<unknown>): Promise<any> => work.then(() => undefined, (error) => error);

  /** Subscribe as Meteor would, and return what the publication handed back. */
  async function publish(userId: string | null, params: Record<string, unknown>) {
    const stops: (() => void)[] = [];
    const subscription = {
      userId,
      stopped: false,
      onStop(callback: () => void) { stops.push(callback); },
      stop() { this.stopped = true; for (const callback of stops.splice(0)) callback(); },
    };
    const cursors: any[] = await (Meteor as any).server.publish_handlers[NAMES.pubConversation].call(subscription, params);
    const [conversations, entries, revisions] = await Promise.all((cursors ?? []).map((cursor) => cursor.fetchAsync()));
    return {
      subscription,
      published: cursors.length,
      conversations: (conversations ?? []).map((row: any) => JSON.parse(row.r)),
      entries: (entries ?? []).sort((a: any, b: any) => a.id - b.id).map((row: any) => JSON.parse(row.r)),
      revisions: (revisions ?? []).sort((a: any, b: any) => a.q - b.q),
    };
  }

  const line = (entry: any) => `${entry.kind}:${textOf(entry.model?.[0])}`;

  before(async function () {
    pieces = await loadPieces();
    Missions = new Durable(`t${Random.id(6)}`, {
      harness: () => harnessOptions(pieces),
      agent: () => AGENT,
      allow: (userId, action) => {
        if (userId !== null && revoked.has(userId)) return false;
        return userId === owner || (userId === reader && action === 'view');
      },
    });
  });

  after(async function () {
    // Leave nothing of this run in the test database.
    for (const key of created.splice(0)) await Missions.destroy(key).catch(() => undefined);
    await Missions._remove();
  });

  it('asks a question and reads the answer, from the server', async function () {
    const key = newKey();
    const answer = await Missions.ask(key, 'hello', { agent: AGENT, timeoutMs: 8000 });
    assert.deepInclude(answer, { status: 'done', text: 'echo: hello' });
    assert.isNumber(answer.entryId);
    assert.deepEqual(await Missions.hosted(), [key]);

    // The same request ID is the same submission, and the same answer: nothing is asked twice.
    const once = await Missions.ask(key, 'only once', { requestId: 'r-1', timeoutMs: 8000 });
    const again = await Missions.ask(key, 'only once', { requestId: 'r-1', timeoutMs: 8000 });
    assert.strictEqual(again.submissionId, once.submissionId);
    assert.strictEqual(again.text, 'echo: only once');
    const page = await (await Missions.reader(key)).scanEntries({ conversationId: 1 as never }, 50, undefined, pieces.context);
    assert.lengthOf(page.items.filter((entry: any) => entry.kind === 'pi.user'), 2);
  });

  it('refuses every DDP action the definition does not allow, and says nothing about why', async function () {
    const key = newKey();
    await Missions.root(key, AGENT);
    const target = { host: Missions.name, key, conversationId: 1 };
    const calls: [string, Record<string, unknown>][] = [
      [NAMES.mRoot, { host: Missions.name, key }],
      [NAMES.mCreate, { host: Missions.name, key }],
      [NAMES.mFork, { ...target, at: 2 }],
      [NAMES.mSubmit, { ...target, content: 'hi' }],
      [NAMES.mAbort, target],
      [NAMES.mWithdraw, { ...target, submissionId: 3 }],
      [NAMES.mReset, target],
      [NAMES.mCompact, target],
    ];
    for (const userId of [null, reader, `stranger-${Random.id(4)}`]) {
      for (const [name, params] of calls) {
        const refused = await rejection(method(name, userId, params));
        assert.strictEqual(refused?.error, 'not-authorized', `${name} as ${userId}`);
      }
    }
    // A definition that does not exist answers exactly as one that says no.
    const unknown = await rejection(method(NAMES.mSubmit, owner, { ...target, host: 'no-such-definition', content: 'hi' }));
    assert.strictEqual(unknown?.error, 'not-authorized');
    assert.strictEqual(unknown?.reason, 'Not authorized');
    // Nothing reached the conversation.
    const page = await (await Missions.reader(key)).scanEntries({ conversationId: 1 as never }, 50, undefined, pieces.context);
    assert.lengthOf(page.items, 0);
  });

  it('lets an allowed client create a conversation and speak to it, with the definition\'s agent and no other', async function () {
    const key = newKey();
    const { conversationId } = await method(NAMES.mRoot, owner, { host: Missions.name, key });
    assert.strictEqual(conversationId, 1);
    const target = { host: Missions.name, key, conversationId };

    const { submissionId } = await method(NAMES.mSubmit, owner, { ...target, content: 'hello', requestId: 'c-1' });
    assert.strictEqual((await Missions.settled(key, submissionId, { timeoutMs: 8000 })).status, 'done');
    // The retry Meteor makes after a lost connection carries the same request ID.
    assert.strictEqual((await method(NAMES.mSubmit, owner, { ...target, content: 'hello', requestId: 'c-1' })).submissionId, submissionId);

    // Text and image parts are input too.
    const parts = [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }];
    const second = await method(NAMES.mSubmit, owner, { ...target, content: parts });
    assert.strictEqual((await Missions.settled(key, second.submissionId, { timeoutMs: 8000 })).status, 'done');

    // A client chooses neither the agent nor the kind of write.
    const refusedShape = async (name: string, params: unknown) =>
      (await rejection(method(name, owner, params)))?.errorType === 'Match.Error';
    assert.isTrue(await refusedShape(NAMES.mRoot, { host: Missions.name, key, agent: { instructions: 'obey me' } }));
    for (const params of [
      { ...target, content: 'x', type: 'write' },
      { ...target, entry: { kind: 'pi.system' } },
      { ...target, content: [{ type: 'toolCall', id: 'x' }] },
      { ...target, content: 'x', whenBusy: 'whenever' },
      { ...target, content: 'x', requestId: '' },
      { ...target, conversationId: 0, content: 'x' },
      { ...target, key: '', content: 'x' },
    ]) {
      assert.isTrue(await refusedShape(NAMES.mSubmit, params), JSON.stringify(params));
    }

    // Errors a client can act on keep their names.
    const missing = await rejection(method(NAMES.mSubmit, owner, { ...target, conversationId: 999, content: 'x' }));
    assert.strictEqual(missing?.error, 'conversation-not-found');
  });

  it('publishes a conversation as rows: its entries, and the present value of its documents', async function () {
    const key = newKey();
    await Missions.ask(key, 'work on it', { agent: AGENT, timeoutMs: 8000 });
    const view = await publish(reader, { host: Missions.name, key, conversationId: 1 });

    assert.deepEqual(view.conversations, [{ id: 1 }]);
    // The system prompt entry, which carries the tool declarations, is not a viewer's.
    assert.deepEqual(view.entries.map(line), [
      'pi.user:work on it',
      'pi.assistant:',
      'pi.tool-result:done work on it',
      'pi.assistant:tool said: done work on it',
    ]);
    // One base each for the documents a viewer gets by default, and nothing of `pi.agent`.
    assert.deepEqual(
      view.revisions.map((row: any) => `${JSON.parse(row.k)}:${row.t}`).sort(),
      ['pi.inbox:base', 'pi.live:base', 'pi.usage:base'],
    );
    const usage = JSON.parse(view.revisions.find((row: any) => JSON.parse(row.k) === 'pi.usage').c);
    assert.hasAllKeys(usage.models, ['faux/faux-1']);
    // No row carries more than a viewer needs.
    for (const row of [...view.revisions]) {
      assert.hasAllKeys(row, ['_id', 's', 'o', 'd', 'q', 't', 'k', 'kv', 'c']);
    }
  });

  it('publishes a fork with its ancestors\' entries up to where it left them', async function () {
    const key = newKey();
    await Missions.ask(key, 'one', { agent: AGENT, timeoutMs: 8000 });
    const before = await publish(owner, { host: Missions.name, key, conversationId: 1 });
    const forkPoint = before.entries.find((entry: any) => entry.kind === 'pi.assistant').id;
    await Missions.ask(key, 'two', { timeoutMs: 8000 });

    const { conversationId: fork } = await method(NAMES.mFork, owner, { host: Missions.name, key, conversationId: 1, at: forkPoint });
    await Missions.ask(key, 'three, in the fork', { conversationId: fork, timeoutMs: 8000 });

    const view = await publish(owner, { host: Missions.name, key, conversationId: fork });
    assert.deepEqual(view.conversations.map((record: any) => record.id).sort(), [1, fork]);
    assert.deepEqual(view.entries.map(line), [
      'pi.user:one',
      'pi.assistant:echo: one',
      'pi.user:three, in the fork',
      'pi.assistant:echo: three, in the fork',
    ]);
    // The parent goes on without it.
    const parent = await publish(owner, { host: Missions.name, key, conversationId: 1 });
    assert.deepEqual(parent.entries.map(line), [
      'pi.user:one', 'pi.assistant:echo: one', 'pi.user:two', 'pi.assistant:echo: two',
    ]);
  });

  it('publishes the newest entries a viewer asks for, from a starting point and not with a limit', async function () {
    const key = newKey();
    for (const said of ['one', 'two', 'three']) await Missions.ask(key, said, { agent: AGENT, timeoutMs: 8000 });
    const recent = await publish(owner, { host: Missions.name, key, conversationId: 1, history: 2 });
    assert.deepEqual(recent.entries.map(line), ['pi.user:three', 'pi.assistant:echo: three']);
    const all = await publish(owner, { host: Missions.name, key, conversationId: 1 });
    assert.lengthOf(all.entries, 6);
  });

  it('publishes nothing to a viewer it refuses, for a definition it does not have, or a conversation that is not there', async function () {
    const key = newKey();
    await Missions.ask(key, 'private', { agent: AGENT, timeoutMs: 8000 });
    for (const [userId, params] of [
      [null, { host: Missions.name, key, conversationId: 1 }],
      [`stranger-${Random.id(4)}`, { host: Missions.name, key, conversationId: 1 }],
      [owner, { host: 'no-such-definition', key, conversationId: 1 }],
      [owner, { host: Missions.name, key, conversationId: 99 }],
      [owner, { host: Missions.name, key: newKey(), conversationId: 1 }],
    ] as const) {
      const view = await publish(userId, params);
      assert.strictEqual(view.published, 0, JSON.stringify(params));
    }
  });

  it('ends a subscription when the right to watch is taken back', async function () {
    const key = newKey();
    await Missions.ask(key, 'for now', { agent: AGENT, timeoutMs: 8000 });
    const previous = _setViewRecheckMs(60);
    try {
      const view = await publish(reader, { host: Missions.name, key, conversationId: 1 });
      assert.strictEqual(view.published, 3);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.isFalse(view.subscription.stopped, 'still allowed, still subscribed');
      revoked.add(reader);
      await until(() => view.subscription.stopped, 2000);
    } finally {
      revoked.delete(reader);
      _setViewRecheckMs(previous);
    }
  });

  it('erases a storage, and its rows with it', async function () {
    const key = newKey();
    await Missions.ask(key, 'forget me', { agent: AGENT, timeoutMs: 8000 });
    assert.lengthOf((await publish(owner, { host: Missions.name, key, conversationId: 1 })).entries, 2);
    await Missions.destroy(key);
    assert.notInclude(await Missions.hosted(), key);
    assert.strictEqual((await publish(owner, { host: Missions.name, key, conversationId: 1 })).published, 0);
  });

  it('adds rate-limit rules only where the settings ask for them', function () {
    assert.strictEqual(applyRateLimits(undefined), 0);
    assert.strictEqual(applyRateLimits({}), 0);
    // Two rules a method; three methods create, four control.
    assert.strictEqual(applyRateLimits({ rateLimit: { submits: { count: 1000, intervalMs: 1000 } } }), 2);
    assert.strictEqual(applyRateLimits({ rateLimit: { creates: { count: 1000, intervalMs: 1000 } } }), 6);
    assert.strictEqual(applyRateLimits({ rateLimit: { controls: { count: 1000, intervalMs: 1000 } } }), 8);
    assert.throws(() => applyRateLimits({ rateLimit: { submits: { count: 0, intervalMs: 1000 } } }), /positive integer/);
  });

  // ── The rest of the surface: what each operation does to a conversation ────
  //
  // A second definition, with a tool the test can hold or deafen, a compaction
  // policy that always finds something to summarize, operations and a document
  // of its own, and nothing hidden from a viewer.

  describe('operations', function () {
    let Works: Durable;
    let Todos: any;
    const made: string[] = [];
    const workKey = () => {
      const key = `w-${Random.id(8)}`;
      made.push(key);
      return key;
    };
    /**
     * "work held …" waits here. "work patient …" waits until it is cancelled. "work deaf …" never comes back and
     * ignores its cancellation.
     */
    let held: { promise: Promise<void>; release: () => void };
    let started: () => void = () => undefined;
    const hold = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      held = { promise, release };
    };
    const toolStarted = () => new Promise<void>((resolve) => { started = resolve; });

    const entriesOf = async (key: string, conversationId = 1) => {
      const page = await (await Works.reader(key)).scanEntries({ conversationId: conversationId as never }, 200, undefined, pieces.context);
      return [...page.items].reverse();
    };
    const said = async (key: string, conversationId = 1) =>
      (await entriesOf(key, conversationId)).filter((entry: any) => entry.kind !== 'pi.system').map(line);
    const answer = async (key: string, content: string, conversationId = 1) =>
      (await Works.ask(key, content, { conversationId, timeoutMs: 8000 })).text;

    before(function () {
      hold();
      held.release();
      Todos = pieces.durable.defineDoc({
        kind: 'test.todos', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
        initial: () => ({ items: [] }),
      });
      Works = new Durable(`w${Random.id(6)}`, {
        harness: () => ({
          ...harnessOptions(pieces, {
            slow: async (job, signal) => {
              started();
              if (job.includes('deaf')) return new Promise<string>(() => undefined);
              if (job.includes('patient')) return hang(signal);
              if (job.includes('held')) await held.promise;
              return `done ${job}`;
            },
          }),
          settings: { compaction: { keepRecentTokens: 1 } },
        }),
        agent: () => AGENT,
        allow: (userId) => userId === owner,
        documents: ['pi.live', 'pi.inbox', 'pi.usage', 'test.todos'],
        hiddenEntries: [],
        operations: {
          async addTodo({ item }, { harness, context }) {
            const root = await harness.root(context);
            await root.commit(async (tx: any) => { (await tx.doc(Todos, root.id)).items.push(item); }, context);
            return harness.snapshot(Todos, root.id, context);
          },
          whoami: (_args, { key, requestId }) => ({ key, requestId }),
          fail: () => { throw Object.assign(new Error('no such luck'), { name: 'Unlucky' }); },
        },
      });
    });

    after(async function () {
      this.timeout(120_000);
      held.release();
      for (const key of made.splice(0)) await Works.destroy(key).catch(() => undefined);
      await Works._remove();
    });

    it('makes further conversations in a storage, each with its own transcript', async function () {
      const key = workKey();
      const root = await Works.root(key, AGENT);
      const second = await Works.create(key, AGENT);
      assert.strictEqual(root, 1);
      assert.notStrictEqual(second, root);
      assert.strictEqual(await answer(key, 'in the root'), 'echo: in the root');
      assert.strictEqual(await answer(key, 'in the second', second), 'echo: in the second');
      assert.deepEqual(await said(key), ['pi.user:in the root', 'pi.assistant:echo: in the root']);
      assert.deepEqual(await said(key, second), ['pi.user:in the second', 'pi.assistant:echo: in the second']);

      // A client's conversation starts with the definition's agent: it has a model, so it answers.
      const { conversationId: third } = await method(NAMES.mCreate, owner, { host: Works.name, key });
      assert.notInclude([root, second], third);
      assert.strictEqual(await answer(key, 'in the third', third), 'echo: in the third');
    });

    it('withdraws an input that is still waiting, and only that', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      const other = await Works.create(key, AGENT);
      hold();
      const running = toolStarted();
      const first = await Works.submit(key, 1, 'work held');
      await running;
      const queued = await Works.submit(key, 1, 'never mind');

      // Over DDP a withdrawal is scoped to the conversation the caller was authorized for.
      const target = { host: Works.name, key, submissionId: queued.submissionId };
      assert.deepEqual(await method(NAMES.mWithdraw, owner, { ...target, conversationId: other }), { result: 'not_found' });
      // The input a run has taken up is past withdrawing.
      assert.strictEqual(await Works.withdraw(key, first.submissionId), 'already_placed');
      assert.deepEqual(await method(NAMES.mWithdraw, owner, { ...target, conversationId: 1 }), { result: 'aborted' });
      assert.strictEqual(await Works.withdraw(key, queued.submissionId), 'settled');
      assert.strictEqual(await Works.withdraw(key, 987_654), 'not_found');

      held.release();
      assert.strictEqual((await Works.settled(key, first.submissionId, { timeoutMs: 8000 })).status, 'done');
      assert.deepInclude(await Works.settled(key, queued.submissionId, { timeoutMs: 8000 }), { status: 'unanswered', reason: 'aborted' });
      // It never reached the transcript.
      assert.deepEqual(await said(key), [
        'pi.user:work held', 'pi.assistant:', 'pi.tool-result:done work held', 'pi.assistant:tool said: done work held',
      ]);
    });

    it('starts a new context on reset, with the handoff as all the model is given of the old one', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      await answer(key, 'one');
      await answer(key, 'two');
      assert.strictEqual(await answer(key, 'count'), 'saw 3: one | two | count');

      await Works.reset(key, 1, 'carry this over');
      await until(async () => (await entriesOf(key)).some((entry: any) => entry.kind === 'pi.reset'));
      assert.strictEqual(await answer(key, 'count'), 'saw 2: carry this over | count');

      // Over DDP, and without a handoff: the model starts from nothing.
      assert.deepEqual(await method(NAMES.mReset, owner, { host: Works.name, key, conversationId: 1 }), {});
      await until(async () => (await entriesOf(key)).filter((entry: any) => entry.kind === 'pi.reset').length === 2);
      assert.strictEqual(await answer(key, 'count'), 'saw 1: count');

      // Nothing was deleted. Each reset marks where the active context begins: at itself.
      const entries = await entriesOf(key);
      assert.include(entries.map(line), 'pi.user:one');
      for (const reset of entries.filter((entry: any) => entry.kind === 'pi.reset')) assert.strictEqual(reset.head, reset.id);
    });

    it('summarizes older entries on compact, with the instructions it was given', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      for (const content of ['one', 'two', 'three']) await answer(key, content);

      const taskId = await Works.compact(key, 1, 'keep it short');
      assert.isNumber(taskId);
      await until(async () => (await entriesOf(key)).some((entry: any) => entry.kind === 'pi.compaction'));
      const compaction = (await entriesOf(key)).find((entry: any) => entry.kind === 'pi.compaction') as any;
      // The model here echoes what it is asked, so the summary shows what the request to summarize contained.
      const summary = textOf(compaction.model[0]);
      assert.include(summary, 'compacted into the following summary');
      assert.include(summary, '[User]: one');
      assert.include(summary, 'Additional focus: keep it short');
      // The active context begins before the summary, at the entries that were kept.
      assert.isBelow(compaction.head, compaction.id);
      // The model now sees the summary in place of what it covers.
      assert.match(await answer(key, 'count'), /^saw 2: The conversation history before this point was compacted/);

      const again = await method(NAMES.mCompact, owner, { host: Works.name, key, conversationId: 1 });
      assert.isNumber(again.taskId);
      assert.notStrictEqual(again.taskId, taskId);
    });

    it('changes what a conversation runs with, and the model is asked accordingly', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      const agent = () => Works.with(key, async (harness) => {
        const resolved = await (await harness.conversation(1, pieces.context)).agent(pieces.context);
        return {
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel,
          extensions: resolved.extensions.map((extension: any) => extension.name),
          tools: resolved.tools.map((tool: any) => tool.name),
          instructions: resolved.instructions,
        };
      });
      const briefed = async () => JSON.parse(await answer(key, 'describe')) as { instructions: string; tools: string[] };
      const model = { provider: 'faux', modelId: 'faux-1' };
      assert.deepEqual(await agent(), { model, thinkingLevel: 'off', extensions: ['work'], tools: ['slow'], instructions: undefined });
      assert.deepEqual((await briefed()).tools, ['slow']);

      await Works.configure(key, 1, { instructions: 'Answer in French.', thinkingLevel: 'high' });
      assert.deepInclude(await agent(), { thinkingLevel: 'high', instructions: 'Answer in French.' });
      assert.include((await briefed()).instructions, 'Answer in French.');

      // Tools and extensions go by name: that is all a conversation stores of them.
      await Works.configure(key, 1, { tools: { remove: ['slow'] } });
      assert.deepInclude(await agent(), { extensions: ['work'], tools: [] });
      assert.deepEqual((await briefed()).tools, []);
      await Works.configure(key, 1, { tools: null, extensions: [] });
      assert.deepInclude(await agent(), { extensions: [], tools: [] });
      await Works.configure(key, 1, { extensions: null, instructions: null });
      assert.deepInclude(await agent(), { extensions: ['work'], tools: ['slow'], instructions: undefined });
      await Works.configure(key, 1, { extensions: { remove: ['work'] } });
      assert.deepInclude(await agent(), { extensions: [], tools: [] });
      await Works.configure(key, 1, { extensions: { add: ['work'] } });
      assert.deepInclude(await agent(), { extensions: ['work'], tools: ['slow'] });
      const after = await briefed();
      assert.deepEqual(after.tools, ['slow']);
      assert.notInclude(after.instructions, 'Answer in French.');
    });

    it('runs an operation of the app\'s own against the storage, and publishes the document it edits', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      assert.deepEqual(await Works.call(key, 'addTodo', { item: 'write the runbook' }), { items: ['write the runbook'] });
      assert.deepEqual(await Works.call(key, 'addTodo', { item: 'rehearse it' }), { items: ['write the runbook', 'rehearse it'] });
      // An operation is told the app's key and the request's ID, which is the caller's when the caller gave one.
      assert.deepEqual(await Works.call(key, 'whoami', {}, { requestId: 'r-9' }), { key, requestId: 'r-9' });
      // Its own error comes back as it was thrown; a name that is not an operation is not looked up anywhere else.
      assert.deepInclude(await rejection(Works.call(key, 'fail')), { name: 'Unlucky', message: 'no such luck' });
      for (const name of ['nope', 'toString', 'constructor']) {
        assert.match((await rejection(Works.call(key, name)))?.message, /^Unknown operation/);
      }

      // The definition lists the document, so a viewer receives the rows of its present value: a base, then deltas.
      const view = await publish(owner, { host: Works.name, key, conversationId: 1 });
      const rows = view.revisions.filter((row: any) => JSON.parse(row.k) === 'test.todos');
      assert.isAtLeast(rows.length, 1);
      assert.strictEqual(rows[0].t, 'base');
      const value = rows.slice(1).reduce((current: any, row: any) => pieces.apply(current, JSON.parse(row.c)), JSON.parse(rows[0].c));
      assert.deepEqual(value, { items: ['write the runbook', 'rehearse it'] });

      // A definition that does not list the document publishes none of it, though its storage holds one.
      const unlisted = newKey();
      await Missions.root(unlisted, AGENT);
      await Missions.with(unlisted, async (harness) => {
        const root = await harness.root(pieces.context);
        await root.commit(async (tx: any) => { (await tx.doc(Todos, root.id)).items.push('unseen'); }, pieces.context);
      });
      const plain = await publish(owner, { host: Missions.name, key: unlisted, conversationId: 1 });
      assert.sameMembers(plain.revisions.map((row: any) => JSON.parse(row.k)), ['pi.inbox', 'pi.live', 'pi.usage']);

      // No client can name an operation: there is no method that takes one.
      const methods = Object.keys((Meteor as any).server.method_handlers).filter((name) => name.startsWith('durable.'));
      assert.sameMembers(methods, [
        NAMES.mRoot, NAMES.mCreate, NAMES.mFork, NAMES.mSubmit, NAMES.mAbort, NAMES.mWithdraw, NAMES.mReset, NAMES.mCompact,
      ]);
    });

    it('hides the entry kinds the definition names, and no others', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      await answer(key, 'hello');
      // This definition hides nothing, so the system prompt entry is a viewer's too.
      const view = await publish(owner, { host: Works.name, key, conversationId: 1 });
      assert.deepEqual(view.entries.map((entry: any) => entry.kind), ['pi.user', 'pi.system', 'pi.assistant']);
    });

    it('stops work in progress, and says so when the work did not stop in the time it was given', async function () {
      const key = workKey();
      await Works.root(key, AGENT);
      const running = toolStarted();
      const patient = await Works.submit(key, 1, 'work patient');
      await running;
      assert.deepEqual(await Works.abort(key, 1), { idle: true });
      assert.deepInclude(await Works.settled(key, patient.submissionId, { timeoutMs: 8000 }), { status: 'unanswered' });
      // The conversation is usable afterwards.
      assert.strictEqual(await answer(key, 'still there?'), 'echo: still there?');

      // A tool that ignores its cancellation does not stop. The caller is told, and is not kept waiting.
      const deaf = workKey();
      await Works.root(deaf, AGENT);
      const again = toolStarted();
      await Works.submit(deaf, 1, 'work deaf');
      await again;
      const began = Date.now();
      assert.deepEqual(await Works.abort(deaf, 1, { waitMs: 200 }), { idle: false });
      assert.isBelow(Date.now() - began, 3000);
    });

    it('refuses an operation whose name the package uses', function () {
      for (const name of ['submit', 'root', '$destroy']) {
        assert.throws(
          () => new Durable(`x${Random.id(6)}`, { harness: () => ({}), operations: { [name]: () => null } }),
          /is taken by the package/,
        );
      }
    });
  });
});
