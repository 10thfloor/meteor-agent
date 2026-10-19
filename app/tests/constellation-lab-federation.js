import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Agent, AgentSessions } from 'meteor/10thfloor:agent';

async function waitUntil(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

if (Meteor.isServer) describe('Evaluation Lab and local federation integration', function () {
  this.timeout(45_000);
  let runtime;
  let lab;
  let federation;
  let ownerId;
  let originalFederationConfig = null;
  let temporaryWorkspace = false;
  let temporaryCrewId = null;
  const datasetIds = new Set();
  const experimentIds = new Set();

  before(async () => {
    runtime = await import('../server/main.js');
    lab = await import('../server/constellation-lab.js');
    federation = await import('../server/constellation-federation.js');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    if (!workspace) {
      temporaryWorkspace = true;
      workspace = {
        _id: 'local', ownerUserId: `lab-owner-${Random.id()}`, createdAt: new Date(),
      };
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    ownerId = workspace.ownerUserId;
    originalFederationConfig = await federation.FederationConfigs.findOneAsync('current');
  });

  after(async () => {
    for (const experimentId of experimentIds) {
      await lab.EvaluationResults.removeAsync({ experimentId });
      await lab.EvaluationExperiments.removeAsync(experimentId);
    }
    for (const datasetId of datasetIds) {
      await lab.EvaluationScenarios.removeAsync({ datasetId });
      await lab.EvaluationScenarioVersions.removeAsync({ datasetId });
      await lab.EvaluationDatasetVersions.removeAsync({ datasetId });
      await lab.EvaluationDatasets.removeAsync(datasetId);
    }
    if (temporaryCrewId) await runtime.CrewConfigs.removeAsync(temporaryCrewId);
    if (originalFederationConfig) {
      await federation.FederationConfigs.rawCollection().replaceOne(
        { _id: 'current' }, originalFederationConfig, { upsert: true },
      );
    } else {
      await federation.FederationConfigs.removeAsync({ _id: 'current', userId: ownerId });
    }
    if (temporaryWorkspace) {
      await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
    }
  });

  const invoke = (name, args, userId = ownerId) => {
    const handler = Meteor.server.method_handlers[name];
    assert.isFunction(handler, `${name} must be installed`);
    return handler.call({ userId, connection: null }, args);
  };

  async function rejected(work, code) {
    let failure;
    try { await work; } catch (error) { failure = error; }
    assert.isDefined(failure, `expected ${code}`);
    assert.equal(failure.error, code);
  }

  async function evaluationCrew() {
    let row = await runtime.CrewConfigs.findOneAsync({
      userId: ownerId,
      agent: 'researcher',
      enabled: true,
      status: { $ne: 'archived' },
    });
    if (row) return row;
    temporaryCrewId = `lab-crew-${Random.id()}`;
    const now = new Date();
    await runtime.CrewConfigs.insertAsync({
      _id: temporaryCrewId,
      userId: ownerId,
      agent: 'researcher',
      displayName: 'Evaluation researcher',
      role: 'Research',
      enabled: true,
      status: 'available',
      model: 'default',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    row = await runtime.CrewConfigs.findOneAsync(temporaryCrewId);
    return row;
  }

  async function learningCounts(agentConfigId, agent) {
    const [identities, constitutions, experiences, practices, frames, ephemeralSessions] =
      await Promise.all([
        Agent.learning.read.identities([agentConfigId]).countAsync(),
        Agent.learning.read.constitutions([agentConfigId]).countAsync(),
        Agent.learning.read.experiences([agentConfigId]).countAsync(),
        Agent.learning.read.practices([agentConfigId]).countAsync(),
        Agent.learning.read.frames([agentConfigId]).countAsync(),
        AgentSessions.find({ agent, userId: null }).countAsync(),
      ]);
    return { identities, constitutions, experiences, practices, frames, ephemeralSessions };
  }

  it('requires the local workspace owner for Lab and federation controls', async () => {
    await rejected(
      invoke('constellation.evalDatasetCreate', { name: 'Denied', description: '' }, null),
      'not-authorized',
    );
    await rejected(
      invoke(
        'constellation.evalDatasetCreate',
        { name: 'Denied', description: '' },
        `other-${Random.id()}`,
      ),
      'workspace-owned',
    );
    await rejected(
      invoke(
        'constellation.federationConfigure',
        { enabled: false, agentIds: [], missionIds: [] },
        `other-${Random.id()}`,
      ),
      'workspace-owned',
    );
  });

  it('mounts a scoped loopback MCP endpoint and revokes its bearer immediately', async () => {
    const crew = await evaluationCrew();
    let issued;
    const post = async (endpoint, token, request) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(request),
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      issued = await invoke('constellation.federationRotateToken');
      const tokenRow = await federation.FederationConfigs.findOneAsync('current');
      await rejected(invoke('constellation.federationConfigure', {
        enabled: false,
        agentIds: [crew.agent],
        missionIds: [],
        expectedRevision: tokenRow.revision - 1,
      }), 'stale-federation');
      await invoke('constellation.federationConfigure', {
        enabled: true,
        agentIds: [crew.agent],
        missionIds: [],
        expectedRevision: tokenRow.revision,
      });

      const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      assert.equal((await post(issued.endpoint, '', request)).status, 401);
      assert.equal((await post(issued.endpoint, 'a'.repeat(43), request)).status, 401);
      const listed = await post(issued.endpoint, issued.token, request);
      assert.equal(listed.status, 200);
      assert.lengthOf(listed.body.result.tools, 1);
      assert.match(listed.body.result.tools[0].name, /^ask_researcher_/);

      const publication = Meteor.server.publish_handlers['constellation.federation'];
      const publishedCursor = await publication.call({ userId: ownerId, ready() {} });
      const published = await publishedCursor.fetchAsync();
      assert.lengthOf(published, 1);
      assert.notProperty(published[0], 'tokenHash');

      await invoke('constellation.federationRevoke');
      const revoked = await post(issued.endpoint, issued.token, {
        jsonrpc: '2.0', id: 2, method: 'ping',
      });
      assert.equal(revoked.status, 401);
      const stored = await federation.FederationConfigs.findOneAsync('current');
      assert.isFalse(stored.enabled);
      assert.isNull(stored.tokenHash);
    } finally {
      if (issued) await invoke('constellation.federationRevoke').catch(() => {});
    }
  });

  it('cancels a running evaluation idempotently and owner-scoped', async () => {
    const experimentId = `lab-cancel-${Random.id()}`;
    experimentIds.add(experimentId);
    const now = new Date();
    await lab.EvaluationExperiments.insertAsync({
      _id: experimentId,
      userId: ownerId,
      status: 'running',
      progress: { completed: 0, total: 1 },
      createdAt: now,
      updatedAt: now,
    });
    await rejected(
      invoke(
        'constellation.evalCancel',
        { experimentId },
        `other-${Random.id()}`,
      ),
      'workspace-owned',
    );
    assert.isTrue(await invoke('constellation.evalCancel', { experimentId }));
    assert.isTrue(await invoke('constellation.evalCancel', { experimentId }));
    assert.equal(
      (await lab.EvaluationExperiments.findOneAsync(experimentId)).status,
      'cancelled',
    );
  });

  it('publishes new runs reactively, pins versions, and leaves live learning untouched', async () => {
    const crew = await evaluationCrew();
    const before = await learningCounts(crew._id, crew.agent);
    const publication = Meteor.server.publish_handlers['constellation.evaluations'];
    assert.isFunction(publication);
    const cursors = await publication.call({ userId: ownerId, ready() {} });
    assert.lengthOf(cursors, 4);

    const dataset = await invoke('constellation.evalDatasetCreate', {
      name: `Regression ${Random.id()}`,
      description: 'Version and isolation regression.',
    });
    datasetIds.add(dataset._id);
    const scenario = await invoke('constellation.evalScenarioCreate', {
      datasetId: dataset._id,
      name: 'Safe baseline',
      prompt: 'Return a short project status.',
      expected: { contains: [], avoids: [`never-${Random.id()}`] },
      fixtures: {
        facts: ['This synthetic fact exists only in the evaluation.'],
        practices: ['Keep the response concise.'],
      },
    });
    assert.deepInclude(scenario.fixtures, {
      facts: ['This synthetic fact exists only in the evaluation.'],
    });

    const cleared = await invoke('constellation.evalScenarioUpdate', {
      scenarioId: scenario._id,
      expectedRevision: scenario.revision,
      patch: { fixtures: {} },
    });
    assert.notProperty(cleared, 'fixtures');
    assert.notProperty(await lab.EvaluationScenarios.findOneAsync(scenario._id), 'fixtures');
    await rejected(invoke('constellation.evalScenarioUpdate', {
      scenarioId: scenario._id,
      expectedRevision: 1,
      patch: { prompt: 'A stale update.' },
    }), 'stale-evaluation-scenario');
    await rejected(invoke('constellation.evalDatasetUpdate', {
      datasetId: dataset._id,
      expectedRevision: 1,
      patch: { name: 'A stale update.' },
    }), 'stale-evaluation-dataset');

    const datasetAtRun = await lab.EvaluationDatasets.findOneAsync(dataset._id);
    const started = await invoke('constellation.evalRun', {
      datasetId: dataset._id,
      agentIds: [crew.agent],
    });
    experimentIds.add(started.experimentId);
    const experiment = await waitUntil(async () => {
      const row = await lab.EvaluationExperiments.findOneAsync(started.experimentId);
      return row?.status !== 'running' ? row : null;
    }, 'evaluation did not finish');
    assert.equal(experiment.status, 'completed', experiment.error?.reason);
    assert.equal(experiment.datasetRevision, datasetAtRun.revision);
    assert.deepEqual(experiment.scenarioVersions, [{ scenarioId: scenario._id, revision: 2 }]);
    assert.deepInclude(experiment.agentSnapshots[0], {
      agentId: crew.agent,
      configId: crew._id,
      revision: crew.revision,
      model: crew.model,
    });

    const result = await lab.EvaluationResults.findOneAsync({
      experimentId: started.experimentId,
      scenarioId: scenario._id,
      agentId: crew.agent,
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.scenarioRevision, 2);
    assert.equal(result.agentConfigRevision, crew.revision);
    assert.equal(result.configuredModel, crew.model);
    assert.isString(result.model);
    assert.notInclude(JSON.stringify(result), 'synthetic fact');
    assert.notProperty(result, 'args');

    const publishedExperiments = await cursors[2].fetchAsync();
    const publishedResults = await cursors[3].fetchAsync();
    assert.include(publishedExperiments.map((row) => row._id), started.experimentId);
    assert.include(publishedResults.map((row) => row._id), result._id);
    assert.notProperty(publishedExperiments.find((row) => row._id === started.experimentId), 'snapshots');

    const changed = await invoke('constellation.evalScenarioUpdate', {
      scenarioId: scenario._id,
      expectedRevision: 2,
      patch: { prompt: 'A later scenario version.' },
    });
    assert.equal(changed.revision, 3);
    assert.deepEqual(
      (await lab.EvaluationExperiments.findOneAsync(started.experimentId)).scenarioVersions,
      [{ scenarioId: scenario._id, revision: 2 }],
    );
    assert.equal(
      (await lab.EvaluationResults.findOneAsync(result._id)).scenarioRevision,
      2,
    );

    const after = await learningCounts(crew._id, crew.agent);
    assert.deepEqual(after, before, 'evaluation must not mutate live identity or learning stores');

    await invoke('constellation.evalScenarioRemove', {
      scenarioId: scenario._id,
      expectedRevision: changed.revision,
    });
    const latestDataset = await lab.EvaluationDatasets.findOneAsync(dataset._id);
    await invoke('constellation.evalDatasetRemove', {
      datasetId: dataset._id,
      expectedRevision: latestDataset.revision,
    });
  });
});
