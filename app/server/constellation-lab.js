import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import {
  EVALUATION_ASSERTION_MAX,
  EVALUATION_TEXT_MAX,
  evaluateAgentRun,
  evaluationScorerRegistry,
  runIsolatedAgentEvaluation,
} from 'meteor/10thfloor:agent';

export const EvaluationDatasets = new Mongo.Collection('constellation_eval_datasets');
export const EvaluationDatasetVersions = new Mongo.Collection(
  'constellation_eval_dataset_versions',
  { _preventAutopublish: true },
);
export const EvaluationScenarios = new Mongo.Collection('constellation_eval_scenarios');
export const EvaluationScenarioVersions = new Mongo.Collection(
  'constellation_eval_scenario_versions',
  { _preventAutopublish: true },
);
export const EvaluationExperiments = new Mongo.Collection('constellation_eval_experiments');
export const EvaluationResults = new Mongo.Collection('constellation_eval_results');

const DATASET_LIMIT = 24;
const SCENARIO_LIMIT = 100;
const AGENT_LIMIT = 8;
const RUN_CELL_LIMIT = 100;
const CONCURRENT_EXPERIMENT_LIMIT = 2;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1_000;
const TOOL_NAME_MAX = 160;

const collections = [
  EvaluationDatasets,
  EvaluationDatasetVersions,
  EvaluationScenarios,
  EvaluationScenarioVersions,
  EvaluationExperiments,
  EvaluationResults,
];

for (const collection of collections) {
  collection.deny({ insert: () => true, update: () => true, remove: () => true });
}

function invalid(reason) {
  throw new Meteor.Error('invalid-evaluation', reason);
}

function cleanText(value, label, max, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean && !optional) invalid(`${label} is required.`);
  if (clean.length > max) invalid(`${label} is too long.`);
  return clean;
}

function cleanRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid('Expected revision must be a positive integer.');
  }
  return value;
}

function cleanAssertions(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > EVALUATION_ASSERTION_MAX) {
    invalid(`${label} must contain at most ${EVALUATION_ASSERTION_MAX} items.`);
  }
  const clean = value.map((item) => cleanText(item, label, 500));
  return [...new Set(clean)];
}

function cleanExpected(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Expected output rules must be an object.');
  }
  const requiredTool = value.requiredTool === undefined || value.requiredTool === ''
    ? undefined
    : cleanText(value.requiredTool, 'Required tool', TOOL_NAME_MAX);
  return {
    contains: cleanAssertions(value.contains, 'Required phrases'),
    avoids: cleanAssertions(value.avoids, 'Disallowed phrases'),
    ...(requiredTool ? { requiredTool } : {}),
  };
}

function cleanFixtureList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) invalid(`${label} fixture is invalid.`);
  return [...new Set(value.map((item) => cleanText(item, label, 2_000)))];
}

function cleanFixtures(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Evaluation fixtures must be an object.');
  }
  const allowed = new Set(['facts', 'experiences', 'practices', 'constitution']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('Evaluation fixtures contain unknown fields.');
  const facts = cleanFixtureList(value.facts, 'Fact');
  const experiences = cleanFixtureList(value.experiences, 'Experience');
  const practices = cleanFixtureList(value.practices, 'Practice');
  const constitution = value.constitution === undefined
    ? undefined : cleanText(value.constitution, 'Constitution', 2_000, { optional: true });
  const fixtures = {
    ...(facts?.length ? { facts } : {}),
    ...(experiences?.length ? { experiences } : {}),
    ...(practices?.length ? { practices } : {}),
    ...(constitution ? { constitution } : {}),
  };
  return Object.keys(fixtures).length ? fixtures : undefined;
}

function cleanScorerIds(value, scorerRegistry) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) invalid('Scorer selection is invalid.');
  const ids = [...new Set(value.map((id) => cleanText(id, 'Scorer', 80)))];
  const unknown = ids.find((id) => !scorerRegistry.has(id));
  if (unknown) invalid('A selected scorer is unavailable.');
  return ids;
}

function cleanDatasetInput(value, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Dataset is invalid.');
  const allowed = new Set(['name', 'description']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('Dataset contains unknown fields.');
  return {
    name: cleanText(value.name ?? previous.name, 'Dataset name', NAME_MAX),
    description: cleanText(
      value.description ?? previous.description ?? '', 'Dataset description', DESCRIPTION_MAX,
      { optional: true },
    ) ?? '',
  };
}

function cleanScenarioInput(value, scorerRegistry, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Scenario is invalid.');
  const allowed = new Set(['name', 'prompt', 'expected', 'scorerIds', 'fixtures']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('Scenario contains unknown fields.');
  return {
    name: cleanText(value.name ?? previous.name, 'Scenario name', NAME_MAX),
    prompt: cleanText(value.prompt ?? previous.prompt, 'Prompt', EVALUATION_TEXT_MAX),
    expected: cleanExpected(value.expected === undefined
      ? previous.expected
      : { ...(previous.expected ?? {}), ...value.expected }),
    scorerIds: cleanScorerIds(value.scorerIds ?? previous.scorerIds, scorerRegistry),
    // Preserve an explicit undefined marker internally. Update callers turn it
    // into $unset, so saving an empty fixture object really clears old context.
    fixtures: cleanFixtures(value.fixtures === undefined ? previous.fixtures : value.fixtures),
  };
}

function datasetVersionId(datasetId, revision) {
  return `${datasetId}:v${revision}`;
}

function scenarioVersionId(scenarioId, revision) {
  return `${scenarioId}:v${revision}`;
}

function scenarioSnapshot(row) {
  return {
    scenarioId: row._id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    expected: row.expected,
    scorerIds: row.scorerIds ?? [],
    ...(row.fixtures ? { fixtures: row.fixtures } : {}),
  };
}

async function writeScenarioVersion(row, archived = false) {
  const snapshot = { ...scenarioSnapshot(row), ...(archived ? { archived: true } : {}) };
  await EvaluationScenarioVersions.upsertAsync(
    { _id: scenarioVersionId(row._id, row.revision) },
    { $setOnInsert: {
      userId: row.userId,
      scenarioId: row._id,
      datasetId: row.datasetId,
      revision: row.revision,
      snapshot,
      createdAt: new Date(),
    } },
  );
}

async function writeDatasetVersion(row) {
  const scenarios = await EvaluationScenarios.find(
    { userId: row.userId, datasetId: row._id },
    { fields: { _id: 1, revision: 1 }, sort: { createdAt: 1, _id: 1 } },
  ).fetchAsync();
  await EvaluationDatasetVersions.upsertAsync(
    { _id: datasetVersionId(row._id, row.revision) },
    { $setOnInsert: {
      userId: row.userId,
      datasetId: row._id,
      revision: row.revision,
      snapshot: {
        name: row.name,
        description: row.description,
        scenarioVersions: scenarios.map((scenario) => ({
          scenarioId: scenario._id, revision: scenario.revision,
        })),
      },
      createdAt: new Date(),
    } },
  );
}

const datasetQueues = new Map();
const experimentQueues = new Map();

async function inDatasetQueue(userId, datasetId, work) {
  const key = `${userId}:${datasetId}`;
  const previous = datasetQueues.get(key) ?? Promise.resolve();
  const running = previous.catch(() => {}).then(work);
  datasetQueues.set(key, running);
  try {
    return await running;
  } finally {
    if (datasetQueues.get(key) === running) datasetQueues.delete(key);
  }
}

async function inExperimentQueue(userId, work) {
  const previous = experimentQueues.get(userId) ?? Promise.resolve();
  const running = previous.catch(() => {}).then(work);
  experimentQueues.set(userId, running);
  try {
    return await running;
  } finally {
    if (experimentQueues.get(userId) === running) experimentQueues.delete(userId);
  }
}

async function bumpDataset(userId, datasetId) {
  const current = await EvaluationDatasets.findOneAsync({ _id: datasetId, userId });
  if (!current) throw new Meteor.Error('no-evaluation-dataset', 'Dataset not found.');
  const at = new Date();
  const changed = await EvaluationDatasets.updateAsync(
    { _id: datasetId, userId, revision: current.revision },
    { $inc: { revision: 1 }, $set: { updatedAt: at } },
  );
  if (changed !== 1) {
    throw new Meteor.Error('stale-evaluation-dataset', 'Dataset changed in another window.');
  }
  const updated = { ...current, revision: current.revision + 1, updatedAt: at };
  await writeDatasetVersion(updated);
  return updated;
}

function publicDataset(row) {
  const { userId: _userId, ...publicRow } = row;
  return publicRow;
}

async function selectedAgents(CrewConfigs, userId, agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > AGENT_LIMIT) {
    invalid(`Choose 1–${AGENT_LIMIT} Agents.`);
  }
  const ids = [...new Set(agentIds.map((id) => cleanText(id, 'Agent', 128)))];
  const rows = await CrewConfigs.find({
    userId,
    agent: { $in: ids },
    enabled: true,
    status: { $ne: 'archived' },
  }, { fields: { agent: 1, revision: 1, model: 1 } }).fetchAsync();
  const available = new Map(rows.map((row) => [row.agent, row]));
  if (ids.some((id) => !available.has(id))) {
    throw new Meteor.Error('evaluation-agent-unavailable', 'A selected Agent is unavailable.');
  }
  return ids.map((agentId) => {
    const row = available.get(agentId);
    return {
      agentId,
      configId: row._id,
      revision: Number.isSafeInteger(row.revision) ? row.revision : 0,
      model: typeof row.model === 'string' ? row.model : 'default',
    };
  });
}

async function currentAgentConfig(CrewConfigs, userId, snapshot) {
  const row = await CrewConfigs.findOneAsync({
    _id: snapshot.configId,
    userId,
    agent: snapshot.agentId,
    enabled: true,
    status: { $ne: 'archived' },
  }, { fields: { revision: 1, model: 1 } });
  if (!row) return false;
  const revision = Number.isSafeInteger(row.revision) ? row.revision : 0;
  const model = typeof row.model === 'string' ? row.model : 'default';
  return revision === snapshot.revision && model === snapshot.model;
}

async function runExperiment({
  experimentId, userId, snapshots, agentSnapshots, CrewConfigs, runAgent, scorerRegistry,
}) {
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let completed = 0;
  try {
    for (const scenario of snapshots) {
      for (const agentSnapshot of agentSnapshots) {
        const { agentId } = agentSnapshot;
        // Cancellation is cooperative. Check both before expensive provider work
        // and again before persisting its result so a cancelled experiment
        // cannot spring back to life after the current await resolves.
        // eslint-disable-next-line no-await-in-loop
        const active = await EvaluationExperiments.findOneAsync({
          _id: experimentId, userId, status: 'running',
        }, { fields: { _id: 1 } });
        if (!active) return;
        let evaluated;
        // eslint-disable-next-line no-await-in-loop
        const pinnedBeforeRun = await currentAgentConfig(
          CrewConfigs, userId, agentSnapshot,
        );
        if (!pinnedBeforeRun) {
          evaluated = {
            output: '', toolCalls: [], durationMs: 0, scores: [], status: 'error',
            model: agentSnapshot.model,
            error: {
              code: 'evaluation-agent-changed',
              reason: 'The Agent configuration changed during this experiment. Run it again.',
            },
          };
        } else try {
          // Deliberately serial: local models and model scorers commonly share
          // one constrained runtime, and experiment ordering is versioned.
          // eslint-disable-next-line no-await-in-loop
          const run = await runAgent(agentId, scenario.prompt, {
            instructionUserId: userId,
            ...(scenario.fixtures ? { fixtures: scenario.fixtures } : {}),
          });
          // eslint-disable-next-line no-await-in-loop
          const pinnedAfterRun = await currentAgentConfig(
            CrewConfigs, userId, agentSnapshot,
          );
          if (!pinnedAfterRun) {
            evaluated = {
              output: '', toolCalls: [], durationMs: run.durationMs, scores: [], status: 'error',
              model: agentSnapshot.model,
              error: {
                code: 'evaluation-agent-changed',
                reason: 'The Agent configuration changed during this experiment. Run it again.',
              },
            };
          } else {
            // eslint-disable-next-line no-await-in-loop
            evaluated = await evaluateAgentRun(
              { userId, agentId, scenario, run }, scorerRegistry,
            );
          }
        } catch {
          evaluated = {
            output: '', toolCalls: [], durationMs: 0, scores: [], status: 'error',
            error: { code: 'evaluation-failed', reason: 'The evaluation could not complete.' },
          };
        }
        // eslint-disable-next-line no-await-in-loop
        const stillActive = await EvaluationExperiments.findOneAsync({
          _id: experimentId, userId, status: 'running',
        }, { fields: { _id: 1 } });
        if (!stillActive) return;
        if (evaluated.status === 'passed') passed += 1;
        else if (evaluated.status === 'failed') failed += 1;
        else errors += 1;
        completed += 1;
        // eslint-disable-next-line no-await-in-loop
        await EvaluationResults.insertAsync({
          userId,
          experimentId,
          scenarioId: scenario.scenarioId,
          scenarioRevision: scenario.revision,
          scenarioName: scenario.name,
          agentId,
          agentConfigId: agentSnapshot.configId,
          agentConfigRevision: agentSnapshot.revision,
          configuredModel: agentSnapshot.model,
          ...evaluated,
          createdAt: new Date(),
        });
        // eslint-disable-next-line no-await-in-loop
        await EvaluationExperiments.updateAsync(
          { _id: experimentId, userId, status: 'running' },
          { $set: { progress: { completed, total: snapshots.length * agentSnapshots.length } } },
        );
      }
    }
    const at = new Date();
    await EvaluationExperiments.updateAsync(
      { _id: experimentId, userId, status: 'running' },
      { $set: {
        status: 'completed',
        progress: { completed, total: snapshots.length * agentSnapshots.length },
        summary: {
          passed, failed, errors,
          total: completed,
          passRate: completed ? passed / completed : 0,
        },
        completedAt: at,
        updatedAt: at,
      } },
    );
  } catch {
    await EvaluationExperiments.updateAsync(
      { _id: experimentId, userId, status: 'running' },
      { $set: {
        status: 'failed',
        error: { code: 'experiment-failed', reason: 'The experiment could not complete.' },
        updatedAt: new Date(),
      } },
    );
  }
}

let installed = false;
let recoveryReady = Promise.resolve();

/** Install the Constellation Evaluation Lab. Application code supplies the
 * workspace authority and Crew collection; the package owns isolated execution
 * and scoring. Safe to call once after the app's Agent definitions exist. */
export function installConstellationLab({
  requireUser,
  CrewConfigs,
  scorers = [],
  runAgent = runIsolatedAgentEvaluation,
  defer = (work) => Meteor.defer(work),
}) {
  if (installed) return;
  if (typeof requireUser !== 'function' || !CrewConfigs || typeof runAgent !== 'function') {
    throw new Error('[constellation] Evaluation Lab installer is incomplete.');
  }
  const scorerRegistry = evaluationScorerRegistry(scorers);
  installed = true;

  // A process cannot resume provider calls that were in flight before a
  // restart. Close those records explicitly, and make new runs wait for this
  // one-time recovery so they cannot be mistaken for interrupted work.
  const recoveredAt = new Date();
  recoveryReady = EvaluationExperiments.updateAsync(
    { status: 'running' },
    { $set: {
      status: 'failed',
      error: {
        code: 'experiment-interrupted',
        reason: 'The app restarted before this evaluation finished. Run it again.',
      },
      completedAt: recoveredAt,
      updatedAt: recoveredAt,
    } },
    { multi: true },
  ).catch((error) => {
    console.warn('[constellation] Evaluation recovery failed.', error);
  });

  Meteor.publish('constellation.evaluations', async function publishEvaluations() {
    if (!this.userId) return this.ready();
    await requireUser(this.userId);
    return [
      EvaluationDatasets.find(
        { userId: this.userId, archivedAt: { $exists: false } },
        { fields: { userId: 0 }, sort: { updatedAt: -1 } },
      ),
      EvaluationScenarios.find(
        { userId: this.userId },
        { fields: { userId: 0 }, sort: { createdAt: 1 } },
      ),
      EvaluationExperiments.find(
        { userId: this.userId },
        { fields: { userId: 0, snapshots: 0 }, sort: { createdAt: -1 }, limit: 25 },
      ),
      EvaluationResults.find(
        { userId: this.userId },
        { fields: { userId: 0 }, sort: { createdAt: -1 }, limit: 1_000 },
      ),
    ];
  });

  Meteor.methods({
    async 'constellation.evalDatasetCreate'(input) {
      check(input, Object);
      await requireUser(this.userId);
      const count = await EvaluationDatasets.find({
        userId: this.userId, archivedAt: { $exists: false },
      }).countAsync();
      if (count >= DATASET_LIMIT) invalid('Dataset limit reached.');
      const clean = cleanDatasetInput(input);
      const at = new Date();
      const id = await EvaluationDatasets.insertAsync({
        userId: this.userId, ...clean, revision: 1, createdAt: at, updatedAt: at,
      });
      const row = await EvaluationDatasets.findOneAsync({ _id: id, userId: this.userId });
      await writeDatasetVersion(row);
      return publicDataset(row);
    },

    async 'constellation.evalDatasetUpdate'({ datasetId, expectedRevision, patch }) {
      check(datasetId, String);
      check(patch, Object);
      await requireUser(this.userId);
      cleanRevision(expectedRevision);
      return inDatasetQueue(this.userId, datasetId, async () => {
        const current = await EvaluationDatasets.findOneAsync({
          _id: datasetId, userId: this.userId, archivedAt: { $exists: false },
        });
        if (!current) throw new Meteor.Error('no-evaluation-dataset', 'Dataset not found.');
        if (current.revision !== expectedRevision) {
          throw new Meteor.Error(
            'stale-evaluation-dataset', 'Dataset changed in another window.',
          );
        }
        const next = cleanDatasetInput(patch, current);
        const at = new Date();
        const changed = await EvaluationDatasets.updateAsync(
          { _id: datasetId, userId: this.userId, revision: expectedRevision },
          { $set: { ...next, updatedAt: at }, $inc: { revision: 1 } },
        );
        if (changed !== 1) {
          throw new Meteor.Error(
            'stale-evaluation-dataset', 'Dataset changed in another window.',
          );
        }
        const updated = { ...current, ...next, revision: expectedRevision + 1, updatedAt: at };
        await writeDatasetVersion(updated);
        return publicDataset(updated);
      });
    },

    async 'constellation.evalDatasetRemove'({ datasetId, expectedRevision }) {
      check(datasetId, String);
      await requireUser(this.userId);
      cleanRevision(expectedRevision);
      return inDatasetQueue(this.userId, datasetId, async () => {
        const at = new Date();
        const changed = await EvaluationDatasets.updateAsync(
          {
            _id: datasetId, userId: this.userId, revision: expectedRevision,
            archivedAt: { $exists: false },
          },
          { $set: { archivedAt: at, updatedAt: at }, $inc: { revision: 1 } },
        );
        if (changed !== 1) {
          throw new Meteor.Error(
            'stale-evaluation-dataset', 'Dataset changed or no longer exists.',
          );
        }
        await EvaluationScenarios.removeAsync({ userId: this.userId, datasetId });
        const current = await EvaluationDatasets.findOneAsync({ _id: datasetId, userId: this.userId });
        await writeDatasetVersion(current);
        return true;
      });
    },

    async 'constellation.evalScenarioCreate'(input) {
      check(input, Object);
      await requireUser(this.userId);
      const datasetId = cleanText(input.datasetId, 'Dataset', 64);
      return inDatasetQueue(this.userId, datasetId, async () => {
        const dataset = await EvaluationDatasets.findOneAsync({
          _id: datasetId, userId: this.userId, archivedAt: { $exists: false },
        });
        if (!dataset) throw new Meteor.Error('no-evaluation-dataset', 'Dataset not found.');
        const count = await EvaluationScenarios.find({ userId: this.userId, datasetId }).countAsync();
        if (count >= SCENARIO_LIMIT) invalid('Scenario limit reached.');
        const { datasetId: _datasetId, ...scenarioInput } = input;
        const cleaned = cleanScenarioInput(scenarioInput, scorerRegistry);
        const { fixtures, ...clean } = cleaned;
        const at = new Date();
        const id = await EvaluationScenarios.insertAsync({
          userId: this.userId,
          datasetId,
          ...clean,
          ...(fixtures ? { fixtures } : {}),
          revision: 1,
          createdAt: at,
          updatedAt: at,
        });
        const row = await EvaluationScenarios.findOneAsync({ _id: id, userId: this.userId });
        await writeScenarioVersion(row);
        await bumpDataset(this.userId, datasetId);
        return publicDataset(row);
      });
    },

    async 'constellation.evalScenarioUpdate'({ scenarioId, expectedRevision, patch }) {
      check(scenarioId, String);
      check(patch, Object);
      await requireUser(this.userId);
      cleanRevision(expectedRevision);
      const initial = await EvaluationScenarios.findOneAsync({
        _id: scenarioId, userId: this.userId,
      });
      if (!initial) throw new Meteor.Error('no-evaluation-scenario', 'Scenario not found.');
      return inDatasetQueue(this.userId, initial.datasetId, async () => {
        const current = await EvaluationScenarios.findOneAsync({
          _id: scenarioId, userId: this.userId,
        });
        if (!current || current.revision !== expectedRevision) {
          throw new Meteor.Error('stale-evaluation-scenario', 'Scenario changed in another window.');
        }
        const cleaned = cleanScenarioInput(patch, scorerRegistry, current);
        const { fixtures, ...next } = cleaned;
        const at = new Date();
        const changed = await EvaluationScenarios.updateAsync(
          { _id: scenarioId, userId: this.userId, revision: expectedRevision },
          {
            $set: { ...next, ...(fixtures ? { fixtures } : {}), updatedAt: at },
            ...(!fixtures ? { $unset: { fixtures: '' } } : {}),
            $inc: { revision: 1 },
          },
        );
        if (changed !== 1) {
          throw new Meteor.Error('stale-evaluation-scenario', 'Scenario changed in another window.');
        }
        const updated = {
          ...current, ...next, ...(fixtures ? { fixtures } : {}),
          revision: expectedRevision + 1, updatedAt: at,
        };
        if (!fixtures) delete updated.fixtures;
        await writeScenarioVersion(updated);
        await bumpDataset(this.userId, current.datasetId);
        return publicDataset(updated);
      });
    },

    async 'constellation.evalScenarioRemove'({ scenarioId, expectedRevision }) {
      check(scenarioId, String);
      await requireUser(this.userId);
      cleanRevision(expectedRevision);
      const initial = await EvaluationScenarios.findOneAsync({
        _id: scenarioId, userId: this.userId,
      });
      if (!initial) throw new Meteor.Error('no-evaluation-scenario', 'Scenario not found.');
      return inDatasetQueue(this.userId, initial.datasetId, async () => {
        const current = await EvaluationScenarios.findOneAsync({
          _id: scenarioId, userId: this.userId, revision: expectedRevision,
        });
        if (!current) {
          throw new Meteor.Error(
            'stale-evaluation-scenario', 'Scenario changed or no longer exists.',
          );
        }
        await writeScenarioVersion({ ...current, revision: expectedRevision + 1 }, true);
        const removed = await EvaluationScenarios.removeAsync({
          _id: scenarioId, userId: this.userId, revision: expectedRevision,
        });
        if (removed !== 1) {
          throw new Meteor.Error(
            'stale-evaluation-scenario', 'Scenario changed or no longer exists.',
          );
        }
        await bumpDataset(this.userId, current.datasetId);
        return true;
      });
    },

    async 'constellation.evalRun'({ datasetId, agentIds }) {
      check(datasetId, String);
      check(agentIds, [String]);
      await requireUser(this.userId);
      await recoveryReady;
      const ownerId = this.userId;
      return inExperimentQueue(ownerId, async () => {
        const activeRuns = await EvaluationExperiments.find({
          userId: ownerId, status: 'running',
        }).countAsync();
        if (activeRuns >= CONCURRENT_EXPERIMENT_LIMIT) {
          invalid(`Finish or cancel a running evaluation before starting another.`);
        }
        const agentSnapshots = await selectedAgents(CrewConfigs, ownerId, agentIds);
        const dataset = await EvaluationDatasets.findOneAsync({
          _id: datasetId, userId: ownerId, archivedAt: { $exists: false },
        });
        if (!dataset) throw new Meteor.Error('no-evaluation-dataset', 'Dataset not found.');
        const rows = await EvaluationScenarios.find(
          { userId: ownerId, datasetId }, { sort: { createdAt: 1, _id: 1 } },
        ).fetchAsync();
        if (rows.length === 0) invalid('Add a scenario before running this dataset.');
        if (rows.length * agentSnapshots.length > RUN_CELL_LIMIT) {
          invalid(`This run exceeds the ${RUN_CELL_LIMIT}-result limit.`);
        }
        const snapshots = rows.map(scenarioSnapshot);
        const at = new Date();
        const experimentId = await EvaluationExperiments.insertAsync({
          userId: ownerId,
          datasetId,
          datasetRevision: dataset.revision,
          datasetName: dataset.name,
          scenarioVersions: snapshots.map(({ scenarioId, revision }) => ({ scenarioId, revision })),
          snapshots,
          agentIds: agentSnapshots.map(({ agentId }) => agentId),
          agentSnapshots,
          status: 'running',
          progress: { completed: 0, total: snapshots.length * agentSnapshots.length },
          createdAt: at,
          updatedAt: at,
        });
        defer(() => runExperiment({
          experimentId,
          userId: ownerId,
          snapshots,
          agentSnapshots,
          CrewConfigs,
          runAgent,
          scorerRegistry,
        }));
        return { experimentId };
      });
    },

    async 'constellation.evalCancel'({ experimentId }) {
      check(experimentId, String);
      await requireUser(this.userId);
      const at = new Date();
      const changed = await EvaluationExperiments.updateAsync(
        { _id: experimentId, userId: this.userId, status: 'running' },
        { $set: { status: 'cancelled', completedAt: at, updatedAt: at } },
      );
      if (changed === 1) return true;
      const existing = await EvaluationExperiments.findOneAsync({
        _id: experimentId, userId: this.userId,
      }, { fields: { status: 1 } });
      if (!existing) throw new Meteor.Error('no-evaluation-experiment', 'Evaluation run not found.');
      return existing.status === 'cancelled';
    },
  });
}
