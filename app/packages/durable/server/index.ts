import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { PREFIX } from '../common/names';
import { denyAllClientWrites } from './collections';
import { applyRateLimits, registerMethods } from './methods';
import { MongoStorage } from './mongo-storage';
import { piRuntime } from './pi';
import { registerPublications } from './publications';

export { NAMES, ROOT_CONVERSATION_ID, storageKey } from '../common/names';
export { DurableConversations, DurableEntries, DurableRevisions } from './collections';
export { Durable, durableHost, instanceId, shutdown } from './durable';
export type { DurableAction, DurableConfig, DurableContent, DurableDraft, DurableTarget } from './durable';
export { DurableHost, HostedElsewhere, RequestExpired } from './host';
export type { DurableHostOptions, Operation, OperationScope } from './host';
export { applyRateLimits } from './methods';
export { MongoStorage, StorageBusy, StorageOwnershipLost, MONGO_SCHEMA_VERSION } from './mongo-storage';
export type { MongoStorageOptions, MongoStorageRuntime } from './mongo-storage';
export { ConversationNotFound, OPERATIONS } from './operations';
export type { AgentChoices } from './operations';
export { CHORD, loadChord, loadPiAi, loadPiDurable, PI_AI, PI_DURABLE, piDurableResolvable, piRuntime } from './pi';
export type { PiRuntime } from './pi';

/** This server's own Mongo connection: the client Meteor already holds, and its database. */
function meteorMongo(): { client: any; db: any } {
  const { client, db } = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo;
  return { client, db };
}

async function storageRuntime() {
  const { apply, StorageRejected } = await piRuntime();
  return { apply, StorageRejected };
}

export type OpenMongoStorageOptions = {
  /** Collection name prefix. Default `pi_durable_`. */
  prefix?: string;
  /** What a commit waits for. Default `{ w: 'majority' }`; see `MongoStorageOptions.writeConcern`. */
  writeConcern?: Record<string, unknown>;
  /** How long to wait for a commit in flight before ending it. Default 2000; see `MongoStorageOptions`. */
  commitGraceMs?: number;
  /** How long to wait in all before failing with `StorageBusy`. Default 120000; see `MongoStorageOptions`. */
  busyTimeoutMs?: number;
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

/**
 * Remove every record of a storage opened with `openMongoStorage`. It must not be open anywhere; one that is loses
 * its ownership first. See `MongoStorage.destroy`.
 */
export function destroyMongoStorage(
  key: string,
  options: Pick<OpenMongoStorageOptions, 'prefix' | 'commitGraceMs' | 'busyTimeoutMs'> = {},
): Promise<void> {
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
