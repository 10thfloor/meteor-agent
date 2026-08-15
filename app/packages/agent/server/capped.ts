import { MongoInternals } from 'meteor/mongo';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

/** Create the delta collection as capped. Idempotent: a NamespaceExists error
 *  (code 48) means a collection of that name already exists — but code 48 fires
 *  whether or not that existing collection is actually capped. If it were ever
 *  created as a normal collection (a stray write, a migration, an ops action),
 *  silently swallowing the error would report success while leaving an
 *  unbounded collection in place, defeating the whole self-managing-eviction
 *  design. So on that path we verify capped-ness explicitly via collStats and
 *  fail loudly if it is not capped, rather than converting or dropping data
 *  someone may care about. */
export async function ensureCapped(): Promise<void> {
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
  try {
    await db.createCollection(NAMES.deltas, { capped: true, size: DELTA_CAP_BYTES });
  } catch (e: any) {
    if (e?.code !== 48 && !/already exists/i.test(e?.message ?? '')) throw e;

    const stats = await db.command({ collStats: NAMES.deltas });
    if (!stats.capped) {
      throw new Error(
        `Collection "${NAMES.deltas}" already exists but is not capped. ` +
          `The delta store relies on capped-collection eviction to bound its size; ` +
          `an uncapped "${NAMES.deltas}" will grow without limit. An operator must ` +
          `drop the "${NAMES.deltas}" collection so it can be recreated capped — ` +
          `this will not be done automatically because it may hold data someone cares about.`,
      );
    }
  }
}
