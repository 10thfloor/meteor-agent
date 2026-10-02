import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
// By path, as the agent package's client tests do: outside Meteor's build, the package id resolves to the server entry.
import { DurableConversation, DurableEntries, DurableRevisions } from '../client/index';

/**
 * Browser half of the live round trip: a real DDP connection to the fixture
 * in `integration.server.ts`. Everything is observed through
 * `DurableConversation`, the way an app's UI would, with bounded polls and no
 * fake timers.
 */

const HOST = 'itest';

const waitFor = (label: string, ms: number, predicate: () => boolean): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = setInterval(() => {
      let ok = false;
      try { ok = predicate(); } catch (error) { clearInterval(poll); reject(error); return; }
      if (ok) { clearInterval(poll); resolve(); }
      else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 25);
  });

const rejection = (work: Promise<unknown>): Promise<any> => work.then(() => undefined, (error) => error);

const text = (entry: any): string => {
  const message = entry?.model?.[0];
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part: any) => (part.type === 'text' ? [part.text] : [])).join('');
};
const lines = (chat: DurableConversation) => chat.entries().map((entry) => `${entry.kind}:${text(entry)}`);

/** Record every distinct partial answer the view shows, as an autorun in a UI would see them. */
function watchStreaming(chat: DurableConversation) {
  const seen: string[] = [];
  const computation = Tracker.autorun(() => {
    const partial = chat.streamingText();
    if (partial !== '' && seen[seen.length - 1] !== partial) seen.push(partial);
  });
  return { seen, stop: () => computation.stop() };
}

describe('DurableConversation, over a real DDP connection', function () {
  this.timeout(60_000);

  const open: DurableConversation[] = [];
  const watch = (key: string, conversationId?: number) => {
    const chat = new DurableConversation({ host: HOST, key, ...(conversationId === undefined ? {} : { conversationId }) });
    open.push(chat);
    return chat;
  };

  afterEach(function () {
    for (const chat of open.splice(0)) chat.stop();
  });

  it('watches an answer arrive word by word, and ends with the transcript', async function () {
    const key = `open-${Random.id()}`;
    assert.strictEqual(await DurableConversation.root(HOST, key), 1);
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());
    assert.deepEqual(lines(chat), []);
    assert.isFalse(chat.busy());

    const streaming = watchStreaming(chat);
    const { submissionId } = await chat.submit('essay, please');
    assert.isNumber(submissionId);
    await waitFor('the answer', 20_000, () => chat.entries().some((entry) => entry.kind === 'pi.assistant'));
    await waitFor('the run to end', 5000, () => !chat.busy());
    streaming.stop();

    // The partial answer grew while it was generated: many states, each extending the one before.
    const answer = text(chat.entries().find((entry) => entry.kind === 'pi.assistant'));
    assert.isAtLeast(streaming.seen.length, 8, `saw ${streaming.seen.length} partial answers`);
    for (let index = 1; index < streaming.seen.length; index += 1) {
      assert.isTrue(streaming.seen[index].startsWith(streaming.seen[index - 1]), 'a partial extends the one before it');
    }
    assert.isTrue(answer.startsWith(streaming.seen[streaming.seen.length - 1]));
    assert.match(answer, /^word0 word1 .* word79$/);

    // Settled: nothing is being generated, the transcript is the two entries, and the spend is recorded.
    assert.strictEqual(chat.streamingText(), '');
    assert.deepEqual(chat.entries().map((entry) => entry.kind), ['pi.user', 'pi.assistant']);
    assert.strictEqual(lines(chat)[0], 'pi.user:essay, please');
    assert.hasAllKeys(chat.usage().models, ['faux/faux-1']);
    assert.deepEqual(chat.inbox(), { items: [] });
    // The live document is one row again: its deltas went when the run ended.
    assert.strictEqual(DurableRevisions.find({ k: JSON.stringify('pi.live'), o: 1, s: `${HOST}/${key}` }).count(), 1);
  });

  it('shows a tool call while it runs, then its result', async function () {
    const key = `open-${Random.id()}`;
    await DurableConversation.root(HOST, key);
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());

    await chat.submit('work on the report');
    await waitFor('the tool to be running', 10_000, () => chat.tools().some((tool) => tool.name === 'slow' && tool.status === 'running'));
    assert.isTrue(chat.busy());
    await waitFor('the final answer', 15_000, () => !chat.busy() && chat.entries().length === 4);
    assert.deepEqual(lines(chat), [
      'pi.user:work on the report',
      'pi.assistant:',
      'pi.tool-result:done work on the report',
      'pi.assistant:tool said: done work on the report',
    ]);
    assert.deepEqual(chat.tools(), []);
  });

  it('queues input sent while it is busy, and admits a retried request once', async function () {
    const key = `open-${Random.id()}`;
    await DurableConversation.root(HOST, key);
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());

    await chat.submit('essay one');
    await waitFor('the run', 5000, () => chat.busy());
    // A follow-up waits in the inbox for the answer in progress; the same request sent again is the same submission.
    const first = await chat.submit('and then this', { requestId: 'follow-1' });
    const again = await chat.submit('and then this', { requestId: 'follow-1' });
    assert.strictEqual(again.submissionId, first.submissionId);
    await waitFor('the inbox', 5000, () => chat.inbox()?.items.length === 1);
    assert.deepInclude(chat.inbox().items[0], { id: first.submissionId, mode: 'followUp', content: 'and then this' });

    await waitFor('both answers', 30_000, () => !chat.busy() && chat.entries().filter((entry) => entry.kind === 'pi.assistant').length === 2);
    assert.deepEqual(chat.entries().map((entry) => entry.kind), ['pi.user', 'pi.assistant', 'pi.user', 'pi.assistant']);
    assert.strictEqual(lines(chat)[3], 'pi.assistant:echo: and then this');
    assert.deepEqual(chat.inbox(), { items: [] });

    // `reject` refuses instead of queueing, with a name a UI can act on.
    await chat.submit('essay two');
    await waitFor('the run', 5000, () => chat.busy());
    const refused = await rejection(chat.submit('not now', { whenBusy: 'reject' }));
    assert.strictEqual(refused?.error, 'conversation-busy');
    assert.deepEqual(await chat.abort(), { idle: true });
  });

  it('stops work in progress when asked to', async function () {
    const key = `open-${Random.id()}`;
    await DurableConversation.root(HOST, key);
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());

    await chat.submit('work forever');
    await waitFor('the tool to be running', 10_000, () => chat.tools().some((tool) => tool.status === 'running'));
    assert.deepEqual(await chat.abort(), { idle: true });
    await waitFor('the view to settle', 5000, () => !chat.busy());
    assert.deepEqual(chat.tools(), []);
    // The conversation is usable afterwards.
    await chat.submit('still there?');
    await waitFor('the next answer', 10_000, () => lines(chat).includes('pi.assistant:echo: still there?'));
  });

  it('forks a conversation, which sees its parent up to the fork and nothing after', async function () {
    const key = `open-${Random.id()}`;
    await DurableConversation.root(HOST, key);
    const parent = watch(key);
    await waitFor('the subscription', 5000, () => parent.ready());
    await parent.submit('one');
    await waitFor('the first answer', 10_000, () => !parent.busy() && parent.entries().length === 2);
    const at = parent.entries()[1].id;
    await parent.submit('two');
    await waitFor('the second answer', 10_000, () => !parent.busy() && parent.entries().length === 4);

    const forkId = await parent.fork(at);
    const fork = watch(key, forkId);
    await waitFor('the fork', 5000, () => fork.ready() && fork.entries().length === 2);
    assert.deepEqual(lines(fork), ['pi.user:one', 'pi.assistant:echo: one']);
    await fork.submit('three');
    await waitFor('the fork\'s answer', 10_000, () => !fork.busy() && fork.entries().length === 4);
    assert.deepEqual(lines(fork), ['pi.user:one', 'pi.assistant:echo: one', 'pi.user:three', 'pi.assistant:echo: three']);
    // Both are open in the same Minimongo, and each still shows only its own view.
    assert.deepEqual(lines(parent), ['pi.user:one', 'pi.assistant:echo: one', 'pi.user:two', 'pi.assistant:echo: two']);
  });

  it('is given nothing of a conversation it may not watch, and none of its methods', async function () {
    const key = `closed-${Random.id()}`;
    assert.strictEqual((await rejection(DurableConversation.root(HOST, key)))?.error, 'not-authorized');
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());
    assert.deepEqual(chat.entries(), []);
    assert.isUndefined(chat.live());
    assert.strictEqual((await rejection(chat.submit('let me in')))?.error, 'not-authorized');
    assert.strictEqual((await rejection(chat.abort()))?.error, 'not-authorized');
    // The collections are caches of what was published; writing to them from here is refused by the server.
    const denied = await rejection(DurableEntries.insertAsync({ s: `${HOST}/${key}`, id: 2, c: 1, k: '"pi.user"', r: '{}' }));
    assert.isOk(denied, 'a client-side insert is denied');
  });

  it('watches and speaks through a server instance that does not host the storage', async function () {
    const key = `away-${Random.id()}`;
    // Another instance opens the storage and keeps it. The one this browser is connected to never does.
    const { owner } = await Meteor.callAsync('durableTest.hostElsewhere', key);
    const chat = watch(key);
    await waitFor('the subscription', 5000, () => chat.ready());

    const streaming = watchStreaming(chat);
    await chat.submit('essay, from afar');
    await waitFor('the answer', 20_000, () => !chat.busy() && chat.entries().some((entry) => entry.kind === 'pi.assistant'));
    streaming.stop();
    assert.isAtLeast(streaming.seen.length, 8, `saw ${streaming.seen.length} partial answers`);
    assert.deepEqual(chat.entries().map((entry) => entry.kind), ['pi.user', 'pi.assistant']);

    const where = await Meteor.callAsync('durableTest.where', key);
    assert.strictEqual(where.owner, owner);
    assert.notStrictEqual(where.owner, where.thisInstance);
    assert.isFalse(where.hostedHere);
  });
});
