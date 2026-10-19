/** A deliberately narrow migration: the admission replay window grew from
 * two days to seven days. Existing indexes must not be dropped or rebuilt.
 * https://www.mongodb.com/docs/manual/core/index-ttl/#change-the-expireafterseconds-value-for-a-ttl-index
 */
export const INBOUND_REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEGACY_REPLAY_TTL_SECONDS = 2 * 24 * 60 * 60;

interface IndexDescription {
  name?: unknown;
  key?: unknown;
  expireAfterSeconds?: unknown;
  [key: string]: unknown;
}

export interface InboundTtlCollection {
  collectionName: string;
  listIndexes(): { toArray(): Promise<IndexDescription[]> };
  createIndex(keys: { at: 1 }, options: { expireAfterSeconds: number }): Promise<unknown>;
}

export interface InboundTtlDatabase {
  command(command: Record<string, unknown>): Promise<unknown>;
}

export interface InboundTtlResult {
  status: 'created' | 'unchanged' | 'migrated';
  indexName: string;
  expireAfterSeconds: number;
}

const migrationError = (reason: string): Error => Object.assign(
  new Error(`[10thfloor:agent] ${reason}`), { codeName: 'InboundReplayTTLNeedsReview' },
);

function isReplayKey(key: unknown): boolean {
  if (!key || typeof key !== 'object' || Array.isArray(key)) return false;
  const keys = Object.entries(key);
  return keys.length === 1 && keys[0][0] === 'at' && keys[0][1] === 1;
}

function metadata(index: IndexDescription): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, stable(part)]));
    return value;
  };
  return JSON.stringify(stable(Object.fromEntries(Object.entries(index)
    .filter(([key]) => key !== 'expireAfterSeconds'))));
}

async function currentIndex(collection: InboundTtlCollection): Promise<IndexDescription | null> {
  let indexes;
  try { indexes = await collection.listIndexes().toArray(); }
  catch (error) {
    // A first boot has no collection yet. Every other read failure must be
    // visible; lack of permission or a network outage is not an empty store.
    if ((error as { code?: number })?.code === 26) return null;
    throw error;
  }
  const matches = indexes.filter((index) => isReplayKey(index.key));
  if (matches.length > 1) throw migrationError('Multiple admission indexes cover at; review replay retention manually.');
  const index = matches[0];
  if (!index) {
    if (indexes.some((row) => row.name === 'at_1')) {
      throw migrationError('The at_1 index has an unexpected key; replay retention was not changed.');
    }
    return null;
  }
  // Hidden indexes still enforce TTL; their visibility and names are retained.
  // Coverage/uniqueness changes are not part of this one known migration.
  if (typeof index.name !== 'string' || !index.name || index.unique === true || index.sparse === true
    || index.partialFilterExpression !== undefined || index.collation !== undefined) {
    throw migrationError('The admission index has custom options; replay retention was not changed.');
  }
  return index;
}

/** Injectable raw-driver adapter avoids Meteor createIndexAsync logging an
 * expected option conflict before callers can handle it. Only the known
 * 172800 -> 604800 transition is automatic; no TTL is ever shortened here.
 */
export async function ensureInboundReplayTtl(
  collection: InboundTtlCollection, database: InboundTtlDatabase,
): Promise<InboundTtlResult> {
  let index = await currentIndex(collection);
  let created = false;
  if (!index) {
    try {
      await collection.createIndex({ at: 1 }, { expireAfterSeconds: INBOUND_REPLAY_TTL_SECONDS });
      created = true;
    } catch (error) {
      // Two starting processes may observe the same absent index. Adopt a
      // compatible winner, but do not retry a write after arbitrary failures.
      if (![85, 86].includes((error as { code?: number })?.code ?? 0)) throw error;
    }
    index = await currentIndex(collection);
    if (!index) throw migrationError('The admission retention index could not be verified.');
  }
  const indexName = index.name as string;
  if (index.expireAfterSeconds === INBOUND_REPLAY_TTL_SECONDS) {
    return { status: created ? 'created' : 'unchanged', indexName, expireAfterSeconds: INBOUND_REPLAY_TTL_SECONDS };
  }
  if (index.expireAfterSeconds !== LEGACY_REPLAY_TTL_SECONDS) {
    throw migrationError('The admission retention policy is not the known two-day legacy policy; review it manually.');
  }
  const before = metadata(index);
  await database.command({ collMod: collection.collectionName,
    index: { name: indexName, expireAfterSeconds: INBOUND_REPLAY_TTL_SECONDS } });
  const verified = await currentIndex(collection);
  if (!verified || verified.expireAfterSeconds !== INBOUND_REPLAY_TTL_SECONDS || metadata(verified) !== before) {
    throw migrationError('The admission retention migration could not be verified; inspect its index metadata.');
  }
  return { status: 'migrated', indexName, expireAfterSeconds: INBOUND_REPLAY_TTL_SECONDS };
}
