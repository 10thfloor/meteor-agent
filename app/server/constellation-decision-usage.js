import {
  DECISION_MISSION_USAGE_COLLECTION, summarizeDecisionRuns,
} from '../imports/constellation/decision-costs';

const usageFields = Object.freeze({
  status: 1, attempts: 1, model: 1, usage: 1, costEstimate: 1,
});

/** A selected mission's aggregate is independent of the capped recent-history
 * publication. Observe only accounting fields; never send inputs or answers. */
export async function publishDecisionMissionUsage(publication, service, runs, missionId) {
  let stopped = false; let observer; let published = false;
  const documents = new Map();
  publication.onStop(() => {
    stopped = true;
    observer?.stop();
    documents.clear();
  });
  if (!publication.userId) { if (!stopped) publication.ready(); return; }
  await service.authorizeMissionUsage(publication.userId, missionId);
  if (stopped) return;
  const changed = () => {
    if (published && !stopped) publication.changed(
      DECISION_MISSION_USAGE_COLLECTION, missionId, summarizeDecisionRuns(documents.values()),
    );
  };
  observer = await runs.find({ userId: publication.userId, missionId }, { fields: usageFields })
    .observeChangesAsync({
      added(id, fields) { if (stopped) return; documents.set(id, fields); changed(); },
      changed(id, fields) {
        if (stopped) return;
        const document = { ...documents.get(id) };
        for (const [field, value] of Object.entries(fields)) {
          if (value === undefined) delete document[field];
          else document[field] = value;
        }
        documents.set(id, document); changed();
      },
      removed(id) { if (stopped) return; documents.delete(id); changed(); },
    });
  // Unsubscribe may win while the asynchronous observer is initializing.
  if (stopped) { await observer.stop(); return; }
  publication.added(DECISION_MISSION_USAGE_COLLECTION, missionId, summarizeDecisionRuns(documents.values()));
  published = true;
  publication.ready();
}
