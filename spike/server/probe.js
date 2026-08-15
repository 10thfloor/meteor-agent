// Pre-flight probe: the Milestone 1 plan calls AgentDeltas.removeAsync({}) in
// test setup (Task 7 seed(), Task 8 itest.reset). agent_deltas is CAPPED.
// Historically MongoDB forbade deletes on capped collections. Verify against
// the bundled server before dispatching implementers.
import { Mongo, MongoInternals } from 'meteor/mongo';

const Probe = new Mongo.Collection('probe_capped_delete');

export async function probeCappedDelete() {
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
  const out = {};

  const buildInfo = await db.admin().command({ buildInfo: 1 });
  out.mongoVersion = buildInfo.version;

  try { await db.collection('probe_capped_delete').drop(); } catch (e) { /* absent */ }
  await db.createCollection('probe_capped_delete', { capped: true, size: 8192 });

  await Probe.insertAsync({ n: 1, chunk: 'a' });
  await Probe.insertAsync({ n: 2, chunk: 'b' });
  out.inserted = await Probe.find({}).countAsync();

  // (a) removeAsync({}) — exactly what the plan's test helpers call.
  try {
    await Probe.removeAsync({});
    out.removeAll = { ok: true, remaining: await Probe.find({}).countAsync() };
  } catch (e) {
    out.removeAll = { ok: false, error: e.message.split('\n')[0] };
  }

  // (b) targeted single-document delete.
  try {
    await Probe.insertAsync({ _id: 'x1', n: 3 });
    await Probe.removeAsync({ _id: 'x1' });
    out.removeOne = { ok: true };
  } catch (e) {
    out.removeOne = { ok: false, error: e.message.split('\n')[0] };
  }

  // (c) drop + recreate — the fallback if deletes are forbidden.
  try {
    await db.collection('probe_capped_delete').drop();
    await db.createCollection('probe_capped_delete', { capped: true, size: 8192 });
    out.dropRecreate = { ok: true };
  } catch (e) {
    out.dropRecreate = { ok: false, error: e.message.split('\n')[0] };
  }

  return out;
}
