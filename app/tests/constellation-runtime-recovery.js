import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Agent } from 'meteor/10thfloor:agent';

if (Meteor.isServer) describe('Constellation workspace runtime recovery', function () {
  this.timeout(20_000);
  let restore;
  before(async () => { ({ restoreWorkspaceCrewRuntime: restore } = await import('../server/main')); });
  const runLocked = async (_owner, action) => action();

  it('waits for core readiness and confirms an unowned workspace before initializing fresh-install defaults', async () => {
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    let reads = 0; let locks = 0; let restores = 0; let defaults = 0;
    const pending = restore({ ready, readWorkspace: async () => { reads += 1; return null; },
      mutate: async () => { locks += 1; }, restoreCrew: async () => { restores += 1; },
      initializeDefaults: () => { assert.equal(reads, 1); defaults += 1; } });
    await Promise.resolve();
    assert.equal(reads, 0);
    assert.equal(defaults, 0);
    release();
    assert.isFalse(await pending);
    assert.equal(reads, 1); assert.equal(locks, 0); assert.equal(restores, 0);
    assert.equal(defaults, 1);
  });

  it('restores only the persisted owner and preserves legacy and custom configuration identifiers on repeated startup', async () => {
    const owner = 'saved-owner';
    const persisted = [{ _id: 'legacy-atlas-id', agent: 'orchestrator' },
      { _id: 'legacy-specialist-id', agent: 'researcher' }, { _id: 'custom-stable-id', agent: 'crew-custom' }];
    const snapshots = [];
    const locks = [];
    let defaults = 0;
    const dependencies = { ready: Promise.resolve(), readWorkspace: async () => ({ ownerUserId: owner }),
      mutate: async (userId, action) => { locks.push(userId); return action(); },
      initializeDefaults: () => { defaults += 1; },
      restoreCrew: async (userId) => { assert.equal(userId, owner); snapshots.push(persisted.map((row) => ({ ...row }))); } };
    assert.isTrue(await restore(dependencies));
    assert.isTrue(await restore(dependencies));
    assert.deepEqual(snapshots, [persisted, persisted]);
    assert.deepEqual(locks, [owner, owner]);
    assert.equal(defaults, 0);
    assert.notInclude(JSON.stringify(snapshots), 'constellation-agent-orchestrator');
  });

  it('rechecks ownership inside the configuration lock and propagates restoration failures without fallback', async () => {
    let reads = 0; let restored = false; let defaults = 0;
    assert.isFalse(await restore({ ready: Promise.resolve(), mutate: runLocked,
      readWorkspace: async () => ({ ownerUserId: ++reads === 1 ? 'prior-owner' : 'new-owner' }),
      initializeDefaults: () => { defaults += 1; },
      restoreCrew: async () => { restored = true; } }));
    assert.isFalse(restored);
    const failure = new Error('Saved crew unavailable');
    let caught;
    try { await restore({ ready: Promise.resolve(), mutate: runLocked, readWorkspace: async () => ({ ownerUserId: 'owner' }),
      initializeDefaults: () => { defaults += 1; }, restoreCrew: async () => { throw failure; } }); }
    catch (error) { caught = error; }
    assert.strictEqual(caught, failure);
    assert.equal(defaults, 0);
  });

  it('reuses the saved learning identity and Constitution instead of creating a new alias owner', async () => {
    // All records are confined to the isolated full-app test database. Unique
    // names keep this proof independent of the concurrently booting test UI.
    const token = Random.id();
    const identity = { id: `recovery-identity-${token}`, name: `recovery-agent-${token}`,
      displayName: 'Saved specialist', constitution: 'Preserve uncertainty and check the evidence.' };
    const original = (await Agent.learning.ensureIdentity(identity)).value;
    let cloneFailure;
    try { await Agent.learning.ensureIdentity({ ...identity, id: `fallback-identity-${token}` }); }
    catch (error) { cloneFailure = error; }
    assert.include(cloneFailure?.message, 'Agent name or alias is already in use');
    const results = [];
    let defaults = 0;
    const dependencies = { ready: Promise.resolve(), mutate: runLocked,
      readWorkspace: async () => ({ ownerUserId: `owner-${token}` }),
      initializeDefaults: () => { defaults += 1; },
      restoreCrew: async () => { results.push((await Agent.learning.ensureIdentity(identity)).value); } };
    await restore(dependencies); await restore(dependencies);
    assert.equal(defaults, 0);
    for (const value of results) {
      assert.equal(value._id, original._id);
      assert.equal(value.constitutionVersionId, original.constitutionVersionId);
      assert.equal(value.generation, original.generation);
    }
    const frame = await Agent.learning.freezeFrame({ sessionId: `recovery-session-${token}`, agentId: original._id,
      triggerSeq: 0, context: 'Continue the same mission.' });
    assert.equal(frame.value.agentId, original._id);
    assert.equal(frame.value.constitution.id, original.constitutionVersionId);
    assert.include(await Agent.learning.protectedPrompt(frame.value), identity.constitution);
    assert.isEmpty(await Agent.learning.read.identities([`fallback-identity-${token}`]).fetchAsync());
  });
});
