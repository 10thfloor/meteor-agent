import { MongoInternals } from 'meteor/mongo';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

/** Create the delta collection as capped. Idempotent: a NamespaceExists error
 *  (code 48) means another server or an earlier boot already made it. */
export async function ensureCapped(): Promise<void> {
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
  try {
    await db.createCollection(NAMES.deltas, { capped: true, size: DELTA_CAP_BYTES });
  } catch (e: any) {
    if (e?.code !== 48 && !/already exists/i.test(e?.message ?? '')) throw e;
  }
}
