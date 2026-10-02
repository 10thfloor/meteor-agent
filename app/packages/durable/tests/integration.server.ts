import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Durable, DurableHost, instanceId, storageKey } from 'meteor/10thfloor:durable';
import { AGENT, hang, harnessOptions, loadPieces, type Slow } from './support';

/**
 * Server half of the live DDP round trip. No describe/it blocks: this file is
 * the FIXTURE the browser-side tests in `integration.client.ts` talk to. It
 * registers a definition backed by pi-ai's faux provider (no API key, no
 * network) and a few methods that let the browser arrange what it then watches.
 */
const NAME = 'itest';

/** Paced, so a browser sees an answer arrive: about 40 tokens a second, and a tool that takes a moment. */
const slow: Slow = async (job, signal) => {
  // "work forever" never finishes by itself; it ends when the conversation is aborted.
  if (job.includes('forever')) return hang(signal);
  await new Promise((resolve) => setTimeout(resolve, 700));
  return `done ${job}`;
};

/** An application document: a list the server adds to and every viewer of the conversation sees. */
const todos = (async () => (await loadPieces()).durable.defineDoc({
  kind: 'itest.todos', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ items: [] }),
}))();

const Itest = new Durable(NAME, {
  harness: async () => harnessOptions(await loadPieces(), { tokensPerSecond: 40, slow }),
  agent: () => AGENT,
  // In this fixture the key is the capability: `open-` and `away-` storages are anyone's, every other is nobody's.
  allow: (_userId, _action, { key }) => key.startsWith('open-') || key.startsWith('away-'),
  documents: ['pi.live', 'pi.inbox', 'pi.usage', 'itest.todos'],
  operations: {
    async addTodo({ item }, { harness, context }) {
      const Todos = await todos;
      const root = await harness.root(context);
      await root.commit(async (tx: any) => { (await tx.doc(Todos, root.id)).items.push(item); }, context);
      return harness.snapshot(Todos, root.id, context);
    },
  },
});

/**
 * A second server instance, as far as a storage can tell: its own host, its
 * own lease name, the same Mongo. It hosts the `away-` storages, so the
 * instance the browser is connected to does not.
 */
let other: Promise<DurableHost> | undefined;
function elsewhere(): Promise<DurableHost> {
  other ??= (async () => {
    const pieces = await loadPieces();
    const { client, db } = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo;
    const host = new DurableHost({
      client,
      db,
      runtime: { apply: pieces.apply, StorageRejected: pieces.durable.StorageRejected },
      Harness: pieces.durable.Harness,
      context: pieces.context,
      instanceId: `itest-other-${Random.id(6)}`,
      accepts: (key) => key.startsWith(`${NAME}/away-`),
      harness: () => harnessOptions(pieces, { tokensPerSecond: 40, slow }) as any,
      // The definition's operations, as a real second instance of this app would have them.
      operations: () => Itest.operations,
      // Long enough that the storage stays with it for the whole suite.
      idleMs: 600_000,
    });
    await host.start();
    return host;
  })();
  return other;
}

Meteor.methods({
  /** Have the other instance open a storage and hold it. */
  async 'durableTest.hostElsewhere'(key: string) {
    const host = await elsewhere();
    await host.call(storageKey(NAME, key), 'root', { agent: AGENT });
    return { owner: host.instanceId };
  },

  /** Server code changing application state: an operation of the definition's own, run wherever the storage is. */
  async 'durableTest.addTodo'(key: string, item: string) {
    return Itest.call(key, 'addTodo', { item });
  },

  /** Who holds a storage's lease, and whether that is the instance answering this call. */
  async 'durableTest.where'(key: string) {
    return {
      owner: await Itest.owner(key),
      thisInstance: instanceId(),
      hostedHere: (await Itest.hosted()).includes(key),
    };
  },
});
