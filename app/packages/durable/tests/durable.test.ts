import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { applyRateLimits, Durable, NAMES } from 'meteor/10thfloor:durable';
import { _setViewRecheckMs } from '../server/publications';
import { AGENT, harnessOptions, loadPieces, type Pieces, textOf, until } from './support';

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
});
