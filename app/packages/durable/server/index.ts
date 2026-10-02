import { MongoInternals } from 'meteor/mongo';
import { loadPackage, resolvePackageEntry } from './loader';
import { MongoStorage, type MongoStorageRuntime } from './mongo-storage';

export { MongoStorage, StorageOwnershipLost, MONGO_SCHEMA_VERSION } from './mongo-storage';
export type { MongoStorageOptions, MongoStorageRuntime } from './mongo-storage';

export const PI_DURABLE = '@earendil-works/pi-durable';
export const CHORD = '@earendil-works/chord';

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
  runtime ??= (async () => {
    const durable = await loadPiDurable() as any;
    const delta = await loadChord('delta') as any;
    if (typeof delta?.apply !== 'function' || typeof durable?.StorageRejected !== 'function') {
      throw new Error('[10thfloor:durable] pi-durable or chord exposes no apply/StorageRejected');
    }
    return { apply: delta.apply, StorageRejected: durable.StorageRejected };
  })();
  runtime.catch(() => { runtime = undefined; });
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
 * Open the Pi Durable storage named `key` on this server's Mongo connection,
 * and take its ownership from any earlier open. Commits are transactions, so
 * the deployment must be a replica set; `meteor run` starts one.
 */
export async function openMongoStorage(key: string, options: OpenMongoStorageOptions = {}): Promise<MongoStorage> {
  return MongoStorage.open({ ...meteorMongo(), key, ...options, runtime: await storageRuntime() });
}

/** Remove every record of the storage named `key`. It must not be open anywhere. */
export function destroyMongoStorage(key: string, options: { prefix?: string } = {}): Promise<void> {
  return MongoStorage.destroy({ ...meteorMongo(), key, prefix: options.prefix });
}
