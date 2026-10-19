import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  DECISION_COST_SOURCE, DECISION_COST_RATE_VERSION, DECISION_MISSION_USAGE_COLLECTION,
  estimateDecisionCost, summarizeDecisionRuns,
} from '../imports/constellation/decision-costs';

const usage = (input = 1_000, output = 30) => ({ input_tokens: input, output_tokens: output });
const response = (model = 'jev-1.13.0') => ({ model, usage: usage(), answers: { accept: { type: 'noul', noul: 0.8 } } });
const completed = (fields = {}) => ({ status: 'completed', attempts: 1, ...response(), ...fields });

describe('Constellation Jev cost estimates', function () {
  it('prices only reported input tokens at the exact resolved model rate', () => {
    const estimate = estimateDecisionCost({ model: 'jev-1.13.0', usage: usage(1_000_000, 9_000_000) });
    assert.equal(estimate.costUsd, 0.042);
    assert.equal(estimate.inputUsdPerMillion, 0.042);
    assert.equal(estimate.outputUsdPerMillion, 0);
    assert.equal(estimate.status, 'priced');
    assert.equal(estimate.kind, 'estimate');
    assert.equal(estimate.currency, 'USD');
    assert.equal(estimate.source, DECISION_COST_SOURCE);
    assert.equal(estimate.rateVersion, DECISION_COST_RATE_VERSION);
    assert.closeTo(estimateDecisionCost({ model: 'jev-1.13.0', usage: usage(1, 0) }).costUsd, 0.000000042, 1e-20);
  });

  it('does not guess alias, future-version, requested-model, or invalid-usage prices', () => {
    for (const model of ['jev-latest', 'jev-preview', 'jev-1.14.0', 'jev-1.13.1', 'jev-1.13', undefined]) {
      const estimate = estimateDecisionCost({ model, usage: usage(), definition: { model: 'jev-1.13.0' } });
      assert.equal(estimate.status, 'unpriced');
      assert.isNull(estimate.costUsd);
    }
    for (const tokens of [-1, 1.5, NaN, Infinity, '10']) {
      assert.isNull(estimateDecisionCost({ model: 'jev-1.13.0', usage: usage(tokens) }));
    }
    assert.isNull(estimateDecisionCost({ model: 'jev-1.13.0', reservedTokens: 30_000 }));
  });

  it('sums valid responses even when a later policy check failed', () => {
    const summary = summarizeDecisionRuns([completed(), completed({ status: 'failed', uncertainUsage: false })]);
    assert.closeTo(summary.costUsd, 0.000084, 1e-15);
    assert.equal(summary.inputTokens, 2_000);
    assert.equal(summary.outputTokens, 60);
    assert.equal(summary.pricedEvaluations, 2);
    assert.equal(summary.uncertainEvaluations, 0);
  });

  it('keeps pending, unpriced, uncertain and never-sent evaluations distinct', () => {
    const summary = summarizeDecisionRuns([
      completed(), completed({ model: 'jev-next' }),
      { status: 'running', attempts: 0 }, { status: 'running', attempts: 1 },
      { status: 'failed', attempts: 1, uncertainUsage: true, reservedTokens: 500_000 },
      { status: 'failed', attempts: 0, uncertainUsage: true, reservedTokens: 500_000 },
    ]);
    assert.deepEqual(summary, { costUsd: 0.000042, inputTokens: 2_000, outputTokens: 60,
      evaluations: 6, pricedEvaluations: 1, pendingEvaluations: 2, unpricedEvaluations: 1,
      uncertainEvaluations: 1, notSentEvaluations: 1 });
  });

  it('uses saved historical rate snapshots and calculates known-version legacy estimates', () => {
    const costEstimate = Object.freeze({ ...estimateDecisionCost(response()), inputUsdPerMillion: 0.1,
      costUsd: 0.0001, rateVersion: 'historical-rate' });
    assert.closeTo(summarizeDecisionRuns([completed({ costEstimate }), completed()]).costUsd, 0.000142, 1e-15);
    assert.equal(costEstimate.costUsd, 0.0001);
    assert.equal(summarizeDecisionRuns([completed({ model: 'jev-next', definition: { model: 'jev-1.13.0' } })]).unpricedEvaluations, 1);
  });

  it('does not trust malformed cost snapshots or conservative token reservations', () => {
    const malformed = { ...estimateDecisionCost(response()), costUsd: 900_000 };
    assert.equal(summarizeDecisionRuns([completed({ costEstimate: malformed, reservedTokens: 900_000 })]).costUsd, 0.000042);
    const unknown = { ...estimateDecisionCost(response()), model: 'jev-next' };
    assert.equal(summarizeDecisionRuns([completed({ model: 'jev-next', costEstimate: unknown })]).costUsd, 0);
    const summary = summarizeDecisionRuns([{ status: 'failed', attempts: 2, uncertainUsage: true, reservedTokens: 900_000 }]);
    assert.equal(summary.inputTokens, 0);
    assert.equal(summary.costUsd, 0);
    assert.equal(summary.uncertainEvaluations, 1);
  });

  it('returns a valid all-zero summary for an empty mission', () => {
    assert.deepEqual(summarizeDecisionRuns(), { costUsd: 0, inputTokens: 0, outputTokens: 0, evaluations: 0,
      pricedEvaluations: 0, pendingEvaluations: 0, unpricedEvaluations: 0, uncertainEvaluations: 0, notSentEvaluations: 0 });
  });
});

if (Meteor.isServer) describe('Constellation Jev mission accounting', function () {
  this.timeout(20_000);
  let decisionsModule; let publishUsage; let service; let owner; let root; let child; let active; let provider;
  let stops;
  const rejects = async (work, code) => {
    let error; try { await work; } catch (caught) { error = caught; }
    assert.equal(error?.error, code);
  };
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Usage publication did not update.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const publication = (userId = owner) => {
    const events = []; let stop; let ready = 0;
    const value = { userId, events, get readyCount() { return ready; },
      get current() { return events.at(-1)?.fields; },
      onStop(callback) { stop = callback; },
      added(collection, id, fields) { events.push({ kind: 'added', collection, id, fields }); },
      changed(collection, id, fields) { events.push({ kind: 'changed', collection, id, fields }); },
      ready() { ready += 1; }, stop() { stop?.(); } };
    stops.push(() => value.stop());
    return value;
  };
  before(async () => {
    decisionsModule = await import('../server/constellation-decisions');
    ({ publishDecisionMissionUsage: publishUsage } = await import('../server/constellation-decision-usage'));
  });
  beforeEach(async () => {
    owner = `jev-cost-owner-${Random.id()}`; root = `jev-cost-mission-${Random.id()}`;
    child = `jev-cost-child-${Random.id()}`; active = true; stops = []; provider = async () => response();
    const rootRow = { _id: root, userId: owner, agent: 'orchestrator', phase: 'idle' };
    service = decisionsModule.createConstellationDecisionService({
      requireUser: async (userId) => { if (userId !== owner) throw new Meteor.Error('not-authorized', 'Owner required.'); },
      CrewConfigs: { find: () => ({ fetchAsync: async () => [] }) },
      rootMissionSession: async (id) => [root, child].includes(id) ? rootRow : null,
      requireActiveMissionExecution: async () => { if (!active) throw new Meteor.Error('mission-inactive', 'Paused.'); },
      canStoreSecret: () => true, encryptSecret: async () => ({ testing: true }), decryptSecret: async () => 'not-sent',
    }, { adapter: async (request) => { await request.beforeAttempt(); return provider(); } });
    await service.saveSettings(owner, { enabled: true, apiKey: 'test-key-never-sent' });
  });
  afterEach(async () => {
    for (const stop of stops) stop();
    for (const collection of [decisionsModule.DecisionNodes, decisionsModule.DecisionVersions, decisionsModule.DecisionRuns,
      decisionsModule.DecisionSettings, decisionsModule.DecisionSecrets, decisionsModule.DecisionBudgets]) {
      await collection.removeAsync({ userId: { $in: [owner, `${owner}-foreign`] } });
    }
  });
  const makeNode = () => service.save(owner, { input: { name: 'Cost test', description: 'Deterministic mock only',
    scope: 'mission', missionId: root, agentIds: [],
    definition: { model: 'jev-latest', questions: { accept: { type: 'noul', instructions: 'Accept `context`?' } } } } });

  it('persists a rate snapshot using the resolved model and records a child evaluation on its root mission', async () => {
    const node = await makeNode();
    const run = await service.evaluate({ userId: owner, sessionId: child }, { nodeId: node._id, revision: 1, state: 'test' });
    assert.equal(run.missionId, root);
    assert.equal(run.sessionId, child);
    assert.equal(run.definition.model, 'jev-latest');
    assert.equal(run.model, 'jev-1.13.0');
    assert.deepEqual(run.costEstimate, estimateDecisionCost(response()));
  });

  it('retains received usage and its cost when authorization is revoked after the response', async () => {
    const node = await makeNode();
    provider = async () => { active = false; return response(); };
    await rejects(service.evaluate({ userId: owner, sessionId: root },
      { nodeId: node._id, revision: 1, state: 'test' }), 'mission-inactive');
    const run = await decisionsModule.DecisionRuns.findOneAsync({ userId: owner });
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.costEstimate, estimateDecisionCost(response()));
    assert.equal(summarizeDecisionRuns([run]).pricedEvaluations, 1);
  });

  it('records unknown resolved model usage without inventing a cost', async () => {
    const node = await makeNode();
    provider = async () => response('jev-2.0.0');
    const run = await service.evaluate({ userId: owner, sessionId: root }, { nodeId: node._id, revision: 1, state: 'test' });
    assert.equal(run.costEstimate.status, 'unpriced');
    assert.isNull(run.costEstimate.costUsd);
    assert.equal(summarizeDecisionRuns([run]).unpricedEvaluations, 1);
  });

  it('authorizes only owner-scoped root missions before observing accounting rows', async () => {
    let queried = false;
    const runs = { find() { queried = true; throw new Error('Must not query.'); } };
    await rejects(publishUsage(publication(`${owner}-foreign`), service, runs, root), 'not-authorized');
    await rejects(publishUsage(publication(), service, runs, 'missing-mission'), 'decision-mission-unavailable');
    await rejects(publishUsage(publication(), service, runs, child), 'decision-mission-unavailable');
    await rejects(publishUsage(publication(), service, runs, ''), 'invalid-decision');
    const anonymous = publication(null);
    await publishUsage(anonymous, service, runs, root);
    assert.equal(anonymous.readyCount, 1);
    assert.isEmpty(anonymous.events);
    assert.isFalse(queried);
    const installed = Meteor.server.publish_handlers['constellation.decisions.missionUsage'];
    assert.isFunction(installed);
    await rejects(installed.call(publication(), root), 'not-authorized', 'Installed service checks the actual workspace owner.');
  });

  it('reactively aggregates more than 100 root and child runs while excluding other missions and owners', async () => {
    const rows = Array.from({ length: 125 }, (_, index) => ({ _id: `${owner}:${index}`, userId: owner,
      missionId: root, sessionId: index % 2 ? child : root, ...completed(), state: { secret: 'never published' } }));
    rows.push({ _id: `${owner}:other-mission`, userId: owner, missionId: 'elsewhere', ...completed() });
    rows.push({ _id: `${owner}:foreign`, userId: `${owner}-foreign`, missionId: root, ...completed() });
    await decisionsModule.DecisionRuns.rawCollection().insertMany(rows);
    const pub = publication();
    await publishUsage(pub, service, decisionsModule.DecisionRuns, root);
    assert.equal(pub.readyCount, 1);
    assert.equal(pub.current.evaluations, 125);
    assert.equal(pub.current.inputTokens, 125_000);
    assert.closeTo(pub.current.costUsd, 125 * 0.000042, 1e-12);
    assert.equal(pub.events[0].collection, DECISION_MISSION_USAGE_COLLECTION);
    assert.equal(pub.events[0].id, root);
    assert.notProperty(pub.current, 'state');
    assert.notProperty(pub.current, 'answers');
    const added = await decisionsModule.DecisionRuns.insertAsync({ userId: owner, missionId: root, status: 'running', attempts: 1 });
    await waitUntil(() => pub.current.pendingEvaluations === 1);
    await decisionsModule.DecisionRuns.updateAsync(added, { $set: completed() });
    await waitUntil(() => pub.current.pricedEvaluations === 126);
    await decisionsModule.DecisionRuns.updateAsync(added, { $unset: { usage: '', model: '' },
      $set: { status: 'failed', uncertainUsage: true } });
    await waitUntil(() => pub.current.uncertainEvaluations === 1);
    assert.equal(pub.current.inputTokens, 125_000);
    await decisionsModule.DecisionRuns.removeAsync(added);
    await waitUntil(() => pub.current.evaluations === 125);
    pub.stop();
    const eventCount = pub.events.length;
    await decisionsModule.DecisionRuns.removeAsync({ _id: `${owner}:0` });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.lengthOf(pub.events, eventCount, 'Unsubscribed observers do not emit more updates.');
  });

  it('publishes an empty mission once and watches only minimal fields without a history cap', async () => {
    const pub = publication(); let stopped = 0;
    const runs = { find(selector, options) {
      assert.deepEqual(selector, { userId: owner, missionId: root });
      assert.notProperty(options, 'limit');
      assert.sameMembers(Object.keys(options.fields), ['status', 'attempts', 'model', 'usage', 'costEstimate']);
      return { observeChangesAsync: async () => ({ stop() { stopped += 1; } }) };
    } };
    await publishUsage(pub, service, runs, root);
    assert.deepEqual(pub.current, summarizeDecisionRuns());
    assert.lengthOf(pub.events, 1);
    pub.stop();
    assert.equal(stopped, 1);
  });

  it('cleans up an observer when unsubscribe wins during asynchronous initialization', async () => {
    const pub = publication(); let release; let observing; let stopped = 0;
    const entered = new Promise((resolve) => { observing = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const runs = { find: () => ({ observeChangesAsync: async (callbacks) => {
      callbacks.added('one', completed()); observing(); await barrier;
      return { stop() { stopped += 1; } };
    } }) };
    const work = publishUsage(pub, service, runs, root);
    await entered;
    pub.stop(); release(); await work;
    assert.equal(stopped, 1);
    assert.isEmpty(pub.events);
    assert.equal(pub.readyCount, 0);
  });
});
