import { MongoInternals } from 'meteor/mongo';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

/** Create the delta collection as capped. On NamespaceExists (code 48),
 *  verifies capped-ness via collStats and fails loudly if it isn't —
 *  an uncapped delta store grows without limit. */
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
