import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

// Remote calls are deliberately deferred fakes. These tests never contact
// Sprites or run guest code, and every row belongs to a unique fixture owner.
if (Meteor.isServer) describe('Retained environment lifecycle races', function () {
  this.timeout(15000);
  let environmentModule; let hash; let service; let userId; let missionId; let environments;
  let barriers; let pending; let remote; let creates; let deletes; let adapter; let missionExists;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const waitFor = async (check) => {
    const deadline = Date.now() + 3000;
    while (!await check()) { if (Date.now() > deadline) assert.fail('Expected lifecycle transition did not arrive'); await tick(); }
  };
  const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
  const barrier = () => {
    let resolve; const promise = new Promise((done) => { resolve = done; });
    const result = { promise, resolve }; barriers.push(result); return result;
  };
  const track = (promise) => { pending.push(promise); return promise; };
  const row = () => environments.findOneAsync({ userId, missionId });
  const preferences = (retention = 'keep') => ({ missionId, keepFiles: true, allowedAgents: ['atlas'], retention });
  const acquire = (jobId) => service.acquireRun({ userId, missionId, agent: 'atlas', jobId,
    token: 'fixture-token', domains: [], assertActive: async () => {
      if (!missionExists) fail('mission-erased', 'The fixture mission was erased.');
    } });

  before(async () => {
    environmentModule = await import('../server/constellation-environments');
    const { createHash } = await import('node:crypto');
    hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    environments = environmentModule.ExecutionEnvironments;
  });
  beforeEach(async () => {
    userId = `environment-race-${Random.id()}`; missionId = `mission-${Random.id()}`;
    barriers = []; pending = []; remote = new Map(); creates = []; deletes = []; missionExists = true;
    const locks = new Map();
    const locked = async (key, work) => {
      const previous = locks.get(key) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work); locks.set(key, next);
      try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
    };
    adapter = {
      createWorkspace: async ({ workspaceId }) => { creates.push(workspaceId); remote.set(workspaceId, creates.length); },
      destroyWorkspace: async ({ workspaceId }) => { deletes.push(workspaceId); remote.delete(workspaceId); },
      applyPolicies: async () => {},
    };
    const owner = async (id) => { if (id !== userId) fail('not-authorized', 'Not the fixture owner.'); };
    service = environmentModule.createExecutionEnvironmentService({
      CrewConfigs: { findOneAsync: async ({ userId: id, agent }) => id === userId && agent === 'atlas' ? { agent, enabled: true } : null },
      missionAllowsAgent: async () => missionExists,
    }, {
      adapter, owner, rootMission: async (id, target) => {
        await owner(id); if (!missionExists || target !== missionId) fail('mission-erased', 'The fixture mission was erased.');
        return { _id: missionId, userId };
      },
      tokenFor: async () => 'fixture-token', getSettings: async () => ({ domains: [], limits: { maxArtifactBytes: 5000000 } }),
      locked, digest: hash, fail,
    });
    await service.saveEnvironment(userId, preferences());
  });
  afterEach(async () => {
    for (const gate of barriers) gate.resolve();
    await Promise.allSettled(pending);
    await environments.removeAsync({ userId });
  });

  it('does not destroy a run acquired after completion first observed an idle environment', async () => {
    const first = await acquire('initial-run'); await service.release(first);
    await service.saveEnvironment(userId, preferences('delete-on-completion'));
    const read = barrier(); const resume = barrier(); const original = environments.findOneAsync;
    let intercepted = false; let lease;
    environments.findOneAsync = async function (selector, ...args) {
      const value = await original.call(this, selector, ...args);
      if (!intercepted && selector?.userId === userId && selector?.missionId === missionId && selector?.retention === 'delete-on-completion') {
        intercepted = true; read.resolve(); await resume.promise;
      }
      return value;
    };
    try {
      const completion = track(service.onMissionCompleted(userId, missionId));
      await read.promise;
      lease = await acquire('racing-run'); resume.resolve(); await completion;
      assert.lengthOf(deletes, 0, 'completion cannot delete an environment held by a live run');
      assert.ok((await row()).deletionRequestedAt, 'completion records deferred deletion');
      await service.release(lease); lease = null;
      assert.lengthOf(deletes, 1); assert.strictEqual(remote.size, 0);
    } finally {
      resume.resolve(); environments.findOneAsync = original;
      if (lease) await service.release(lease);
    }
  });

  it('observes completion intent written after release read its lease snapshot', async () => {
    await service.saveEnvironment(userId, preferences('delete-on-completion'));
    const lease = await acquire('finishing-run');
    const read = barrier(); const resume = barrier(); const original = environments.findOneAsync; let intercepted = false;
    environments.findOneAsync = async function (selector, ...args) {
      const value = await original.call(this, selector, ...args);
      if (!intercepted && selector?._id === lease.environmentId && selector?.operationId === lease.operationId) {
        intercepted = true; read.resolve(); await resume.promise;
      }
      return value;
    };
    try {
      const releasing = track(service.release(lease)); await read.promise;
      await service.onMissionCompleted(userId, missionId);
      assert.lengthOf(deletes, 0, 'the active holder owns the deferred deletion');
      resume.resolve(); await releasing;
      assert.lengthOf(deletes, 1, 'release must re-read deletion intent before returning');
      assert.strictEqual(remote.size, 0); assert.strictEqual((await row()).status, 'not-created');
    } finally { resume.resolve(); environments.findOneAsync = original; }
  });

  it('keeps overlapping cleanup requests from deleting a newly recreated environment', async () => {
    const lease = await acquire('first-run');
    await environments.updateAsync(lease.environmentId, { $set: { deletionRequestedAt: new Date() } });
    const firstDelete = barrier(); const laterDelete = barrier();
    adapter.destroyWorkspace = async ({ workspaceId }) => {
      const number = deletes.push(workspaceId);
      await (number === 1 ? firstDelete.promise : laterDelete.promise);
      remote.delete(workspaceId);
    };
    const releasing = track(service.release(lease)); await waitFor(() => deletes.length === 1);
    // A second request may reject as busy or join the in-flight operation. It
    // must not dispatch an independent late DELETE against the same Sprite.
    const manual = track(service.deleteEnvironment(userId, { missionId, confirm: true }).then((value) => value, (error) => error));
    await tick(); await tick(); firstDelete.resolve(); await releasing;
    await service.saveEnvironment(userId, preferences());
    const next = await acquire('replacement-run');
    assert.strictEqual(remote.get(next.workspaceId), 2, 'the replacement exists before delayed cleanup settles');
    laterDelete.resolve(); await manual;
    assert.lengthOf(deletes, 1, 'only one remote delete is dispatched for the original environment');
    assert.strictEqual(remote.get(next.workspaceId), 2, 'old cleanup cannot erase new retained files');
    assert.strictEqual((await row()).workspaceId, next.workspaceId);
    await service.release(next);
  });

  it('retains cleanup ownership when mission erasure precedes a delayed create response', async () => {
    const provisioning = barrier(); const finishCreate = barrier();
    adapter.createWorkspace = async ({ workspaceId }) => {
      creates.push(workspaceId); provisioning.resolve(); await finishCreate.promise;
      // A provider can finish creation even after the client cancels. A prior
      // DELETE404 cannot prove this late resource will never exist.
      remote.set(workspaceId, 1);
    };
    const acquiring = track(acquire('creating-run').then((value) => value, (error) => error));
    await provisioning.promise; missionExists = false;
    await service.scrubMission(missionId);
    const erased = await row();
    assert.ok(erased?.erasedAt, 'erasure keeps a durable cleanup owner while creation is in flight');
    assert.ok(erased?.deletionRequestedAt);
    finishCreate.resolve(); const result = await acquiring;
    assert.ok(result instanceof Error, 'the erased mission never receives an execution lease');
    const receipt = await row();
    assert.isTrue(remote.size === 0 || (!!receipt?.erasedAt && !!receipt?.deletionRequestedAt && remote.has(receipt.workspaceId)),
      'a late-created Sprite is either deleted or still represented by its erased cleanup receipt');
    if (receipt) {
      assert.isFalse(receipt.keepFiles); assert.deepEqual(receipt.allowedAgents, []); assert.deepEqual(receipt.savePoints, []);
      assert.isFalse(['ready', 'busy'].includes(receipt.status), 'erasure never restores an executable environment');
    }
  });

  it('uses a fresh remote identity so a timed-out old DELETE cannot remove replacement files', async () => {
    const first = await acquire('original-run'); await service.release(first);
    const lateDelete = barrier(); let delayedEffect;
    adapter.destroyWorkspace = async ({ workspaceId }) => {
      deletes.push(workspaceId);
      if (deletes.length === 1) {
        // The client deadline expires, but the provider may still apply this
        // exact old-name DELETE after a subsequent cleanup already succeeded.
        delayedEffect = track(lateDelete.promise.then(() => remote.delete(workspaceId)));
        throw new Error('Provider confirmation timed out');
      }
      remote.delete(workspaceId);
    };
    const uncertain = await service.deleteEnvironment(userId, { missionId, confirm: true });
    assert.strictEqual(uncertain.status, 'needs-attention');
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    assert.strictEqual(remote.size, 0, 'the cleanup retry confirms removal of the original Sprite');
    await service.saveEnvironment(userId, preferences());
    const replacement = await acquire('replacement-run');
    assert.notStrictEqual(replacement.workspaceId, first.workspaceId, 'each provisioned generation needs its own remote name');
    lateDelete.resolve(); await delayedEffect;
    assert.strictEqual(remote.get(replacement.workspaceId), 2, 'a delayed old-generation DELETE cannot touch replacement files');
    assert.strictEqual((await row()).workspaceId, replacement.workspaceId);
    await service.release(replacement);
  });
});
