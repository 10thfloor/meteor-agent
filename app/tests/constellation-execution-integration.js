import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from 'meteor/10thfloor:agent';

if (Meteor.isServer) describe('Constellation execution entitlement wiring', function () {
  it('passes the actual context and agent to execution access after mission authorization', async () => {
    const app = await import('../server/main');
    const owner = `execution-wiring-owner-${Random.id()}`;
    const id = `execution-wiring-mission-${Random.id()}`;
    const crewId = `execution-wiring-crew-${Random.id()}`;
    const original = app.constellationExecution.toolEntitlement;
    const context = { userId: owner, sessionId: id, toolCallId: 'run-code-fixture' };
    let calls = 0;
    try {
      await AgentSessions.insertAsync({ _id: id, userId: owner, agent: 'orchestrator', phase: 'idle', createdAt: new Date() });
      await app.CrewConfigs.insertAsync({ _id: crewId, userId: owner, agent: 'orchestrator', enabled: true, status: 'active' });
      app.constellationExecution.toolEntitlement = async (received, agent) => {
        calls += 1; assert.strictEqual(received, context); assert.strictEqual(agent, 'orchestrator'); return 'ask';
      };
      assert.strictEqual(await app.configuredToolEntitlement('run_code', context, 'orchestrator'), 'ask');
      await app.CrewConfigs.updateAsync(crewId, { $set: { enabled: false } });
      assert.strictEqual(await app.configuredToolEntitlement('run_code', context, 'orchestrator'), false);
      assert.strictEqual(calls, 1);
    } finally {
      app.constellationExecution.toolEntitlement = original;
      await app.CrewConfigs.removeAsync(crewId); await AgentSessions.removeAsync(id);
    }
  });

  it('routes mission file tools through the live file authority fence', async () => {
    const app = await import('../server/main');
    const owner = `files-wiring-owner-${Random.id()}`; const id = `files-wiring-mission-${Random.id()}`;
    const crewId = `files-wiring-crew-${Random.id()}`; const original = app.constellationExecution.fileToolEntitlement;
    const context = { userId: owner, sessionId: id, toolCallId: 'files-fixture', args: { action: 'write' } }; let calls = 0;
    try {
      await AgentSessions.insertAsync({ _id: id, userId: owner, agent: 'orchestrator', phase: 'idle', createdAt: new Date() });
      await app.CrewConfigs.insertAsync({ _id: crewId, userId: owner, agent: 'orchestrator', enabled: true, status: 'active' });
      app.constellationExecution.fileToolEntitlement = async (name, received, agent) => {
        calls += 1; assert.equal(name, 'manage_mission_files'); assert.strictEqual(received, context); assert.equal(agent, 'orchestrator'); return 'ask';
      };
      assert.equal(await app.configuredToolEntitlement('manage_mission_files', context, 'orchestrator'), 'ask');
      await app.CrewConfigs.updateAsync(crewId, { $set: { enabled: false } });
      assert.isFalse(await app.configuredToolEntitlement('manage_mission_files', context, 'orchestrator'));
      assert.equal(calls, 1);
    } finally {
      app.constellationExecution.fileToolEntitlement = original;
      await app.CrewConfigs.removeAsync(crewId); await AgentSessions.removeAsync(id);
    }
  });
});
