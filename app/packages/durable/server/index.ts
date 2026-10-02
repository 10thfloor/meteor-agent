import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { PREFIX } from '../common/names';
import { denyAllClientWrites } from './collections';
import { CHORD, PI_DURABLE } from './durable';
import { loadPackage, resolvePackageEntry } from './loader';
import { applyRateLimits, registerMethods } from './methods';
import { MongoStorage, type MongoStorageRuntime } from './mongo-storage';
import { registerPublications } from './publications';

export { NAMES, ROOT_CONVERSATION_ID, storageKey } from '../common/names';
export { DurableConversations, DurableEntries, DurableRevisions } from './collections';
export { Durable, durableHost, instanceId, shutdown } from './durable';
export type { DurableAction, DurableConfig, DurableContent, DurableDraft, DurableTarget } from './durable';
export { DurableHost, HostedElsewhere, RequestExpired } from './host';
export type { DurableHostOptions, Operation, OperationScope } from './host';
export { MongoStorage, StorageOwnershipLost, MONGO_SCHEMA_VERSION } from './mongo-storage';
export type { MongoStorageOptions, MongoStorageRuntime } from './mongo-storage';
export { ConversationNotFound, OPERATIONS } from './operations';
export type { AgentChoices } from './operations';
export { applyRateLimits } from './methods';
export { CHORD, PI_DURABLE };

/** `loadPiDurable()` for the harness, `loadPiDurable('testing')` for the conformance suite. */
export function loadPiDurable(subpath?: string): Promise<unknown> {
  return loadPackage(PI_DURABLE, subpath);
}

/** `loadChord('context')` for `BACKGROUND_CONTEXT`, `loadChord('delta')` for `apply`. */
export function loadChord(subpath?: string): Promise<unknown> {
  return loadPackage(CHORD, subpath);
}

/** Synchronous check for Pi Durable and Chord on disk. Cached after first answer. */
let onDisk: boolean | null = null;
export function piDurableResolvable(): boolean {
  if (onDisk === null) {
    try {
      resolvePackageEntry(PI_DURABLE);
      resolvePackageEntry(CHORD, 'delta');
      onDisk = true;
    } catch {
      onDisk = false;
    }
  }
  return onDisk;
}

let runtime: Promise<MongoStorageRuntime> | undefined;
function storageRuntime(): Promise<MongoStorageRuntime> {
  if (runtime === undefined) {
    const loading = (async () => {
      const durable = await loadPiDurable() as any;
      const delta = await loadChord('delta') as any;
      if (typeof delta?.apply !== 'function' || typeof durable?.StorageRejected !== 'function') {
        throw new Error('[10thfloor:durable] pi-durable or chord exposes no apply/StorageRejected');
      }
      return { apply: delta.apply, StorageRejected: durable.StorageRejected };
    })();
    runtime = loading;
    loading.catch(() => { if (runtime === loading) runtime = undefined; });
  }
  return runtime;
}

/** This server's own Mongo connection: the client Meteor already holds, and its database. */
function meteorMongo(): { client: any; db: any } {
  const { client, db } = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo;
  return { client, db };
}

export type OpenMongoStorageOptions = {
  /** Collection name prefix. Default `pi_durable_`. */
  prefix?: string;
  /** What a commit waits for. Default `{ w: 'majority' }`; see `MongoStorageOptions.writeConcern`. */
  writeConcern?: Record<string, unknown>;
};

/**
 * Open a Pi Durable storage on this server's Mongo connection yourself, and
 * take its ownership from any earlier open. This is the layer under `Durable`:
 * no lease, no host, nothing that keeps two instances from taking the storage
 * from each other in turn. Use it for a storage only one process ever opens.
 */
export async function openMongoStorage(key: string, options: OpenMongoStorageOptions = {}): Promise<MongoStorage> {
  return MongoStorage.open({ ...meteorMongo(), prefix: PREFIX, key, ...options, runtime: await storageRuntime() });
}

/** Read a storage without owning it: every read of the storage contract, no commit. See `MongoStorage.reader`. */
export async function readMongoStorage(key: string, options: { prefix?: string } = {}): Promise<MongoStorage> {
  return MongoStorage.reader({ ...meteorMongo(), prefix: PREFIX, key, ...options, runtime: await storageRuntime() });
}

/** Remove every record of a storage opened with `openMongoStorage`. It must not be open anywhere. */
export function destroyMongoStorage(key: string, options: { prefix?: string } = {}): Promise<void> {
  return MongoStorage.destroy({ ...meteorMongo(), prefix: PREFIX, key, ...options });
}

/**
 * Resolves once the package has registered its methods and its publication.
 * The mocha runner does not wait for `Meteor.startup`, so suites wait on this.
 */
export const startupComplete: Promise<void> = new Promise((resolve, reject) => {
  Meteor.startup(() => {
    try {
      denyAllClientWrites();
      registerMethods();
      registerPublications();
      applyRateLimits((Meteor.settings as any)?.packages?.['10thfloor:durable']);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
startupComplete.catch((error) => Meteor._debug('[10thfloor:durable] startup:', error));
