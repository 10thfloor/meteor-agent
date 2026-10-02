import { assert } from 'chai';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { destroyMongoStorage, DurableEntries, DurableRevisions, openMongoStorage } from 'meteor/10thfloor:durable';
import { loadPackage } from '../server/loader';
import { loadPieces } from './support';

// Pi Durable lets clients attach to the one process that owns a storage.
// On Meteor the storage is Mongo, so any server instance can watch the rows
// themselves. That only works if Meteor's observers see writes made inside
// transactions, which is how every Pi Durable commit is made. This suite
// checks exactly that, on ordinary cursors over the storage's collections,
// while a harness streams an answer.

const PI_AI = '@earendil-works/pi-ai';

/** Which of Meteor's observe drivers serves this handle. */
function driverOf(handle: any): 'changeStreams' | 'oplog' | 'polling' | 'unknown' {
  const driver = handle?._multiplexer?._observeDriver;
  if (driver?.constructor?.name === 'ChangeStreamObserveDriver') return 'changeStreams';
  if (driver?._usesOplog === true) return 'oplog';
  if (driver?.constructor?.name === 'PollingObserveDriver') return 'polling';
  return 'unknown';
}

describe('Meteor reactivity over Pi Durable commits', function () {
  this.timeout(120_000);

  it('shows a streamed answer growing, row by row, to a plain cursor observer', async function () {
    const { durable, context, apply } = await loadPieces();
    const createModels = (await loadPackage(PI_AI, 'models') as any).createModels;
    const faux = await loadPackage(PI_AI, 'providers/faux') as any;

    const key = `reactive-${Random.id()}`;
    // About two seconds of streaming; the harness commits the partial answer at most every 100 ms.
    const provider = faux.fauxProvider({ tokensPerSecond: 60 });
    const models = createModels();
    models.setProvider(provider.provider);
    const essay = Array.from({ length: 90 }, (_, index) => `word${index}`).join(' ');
    provider.setResponses([faux.fauxAssistantMessage(essay)]);

    const harness = await durable.Harness.open(await openMongoStorage(key), { models, registry: durable.createRegistry() }, context);
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });

    // What a publication does, and what a second server instance could do: watch the rows, with no access to the
    // harness. This is the selector `durable.conversation` uses for a conversation's documents.
    const events: { what: string; at: number; text?: string }[] = [];
    let value: any;
    const partial = () => {
      const message = value?.generation?.message;
      return (message?.content ?? []).flatMap((part: any) => (part.type === 'text' ? [part.text] : [])).join('');
    };
    const live = JSON.stringify('pi.live');
    const revisions = await (DurableRevisions.find({ s: key, sk: 'conversation', o: root.id, cur: true, k: live }) as any)
      .observeChangesAsync({
        added(_id: string, row: any) {
          // A base replaces the value; a delta is Chord operations on it. Rows arrive in commit order.
          value = row.t === 'base' ? JSON.parse(row.c) : apply(value, JSON.parse(row.c));
          events.push({ what: `revision:${row.t}`, at: Date.now(), text: partial() });
        },
      });
    const entries = await (DurableEntries.find({ s: key, c: root.id }) as any).observeChangesAsync({
      added(_id: string, row: any) {
        events.push({ what: `entry:${JSON.parse(row.k)}`, at: Date.now() });
      },
    });

    try {
      // Meteor 3.5 tries change streams, then the oplog, then polling. Polling would pass this test only by luck,
      // ten seconds late; the other two are fed by the database as it commits.
      for (const handle of [revisions, entries]) {
        assert.include(['changeStreams', 'oplog'], driverOf(handle), 'observer is fed by the database, not by polling');
      }

      const committed: number[] = [];
      harness.subscribeCommits(() => { committed.push(Date.now()); });
      const settled = await (await root.submit({ type: 'input', content: 'Write an essay.' }, context)).wait(context);
      assert.strictEqual(settled.status, 'done');
      const finished = Date.now();

      // The observers are fed a moment behind the commits.
      const deadline = Date.now() + 5000;
      while (!events.some((event) => event.what === 'entry:pi.assistant') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const answer = events.find((event) => event.what === 'entry:pi.assistant');
      assert.isOk(answer, 'the answer entry reached the observer');
      assert.isBelow(answer!.at - finished, 1000, 'within a second of the run settling');

      // While the model was still answering, the observer saw the partial text grow, several times.
      const growing = events
        .filter((event) => event.what === 'revision:delta' && event.at < answer!.at && (event.text ?? '').length > 0)
        .map((event) => event.text!);
      const distinct = [...new Set(growing)];
      assert.isAtLeast(distinct.length, 5, `saw ${distinct.length} distinct partial answers`);
      for (let index = 1; index < distinct.length; index += 1) {
        assert.isTrue(distinct[index].startsWith(distinct[index - 1]), 'each partial extends the one before');
      }
      assert.isTrue(essay.startsWith(distinct[distinct.length - 1]), 'and all of them are prefixes of the answer');
      assert.deepEqual(
        events.filter((event) => event.what.startsWith('entry:')).map((event) => event.what),
        ['entry:pi.user', 'entry:pi.assistant'],
      );
      // Idle again: the live document is a base with no generation in it.
      assert.isUndefined(value?.generation);
      assert.isAtLeast(committed.length, 10);
      // And that base is its only row: a current-only document keeps nothing older.
      const db = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo.db;
      assert.strictEqual(await db.collection('pi_durable_revisions').countDocuments({ s: key, k: live }), 1);
      console.log(
        `[10thfloor:durable] ${driverOf(revisions)} observer: ${distinct.length} partial answers seen while streaming, ` +
        `answer entry ${answer!.at - finished} ms after the run settled`,
      );
    } finally {
      await revisions.stop();
      await entries.stop();
      await harness.close(context);
      await destroyMongoStorage(key);
    }
  });
});
