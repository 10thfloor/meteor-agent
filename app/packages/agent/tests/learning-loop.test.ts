import { assert } from 'chai';
import type { AgentMessage, AgentSession } from '../common/types';
import type { Provider, ProviderRequest } from '../server/providers/types';

const count = (source: string, needle: string): number => source.split(needle).length - 1;

const waitFor = async (
  condition: () => Promise<boolean>, label: string, timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
};

async function expectError(work: Promise<unknown>, fragment: string): Promise<void> {
  try {
    await work;
    assert.fail(`expected error containing ${fragment}`);
  } catch (error) {
    assert.include(String((error as Error).message), fragment);
  }
}

async function resetState(): Promise<void> {
  const {
    AgentDeltas, AgentMemories, AgentMessages, AgentSessions,
  } = await import('../common/collections');
  const {
    AgentConstitutions, AgentExperiences, AgentIdentities, AgentLearningEvents,
    AgentMemoryFrames, AgentPractices,
  } = await import('../server/learning-collections');
  await Promise.all([
    AgentDeltas.removeAsync({}),
    AgentMemories.removeAsync({}),
    AgentMessages.removeAsync({}),
    AgentSessions.removeAsync({}),
    AgentLearningEvents.removeAsync({}),
    AgentMemoryFrames.removeAsync({}),
    AgentPractices.removeAsync({}),
    AgentExperiences.removeAsync({}),
    AgentConstitutions.removeAsync({}),
    AgentIdentities.removeAsync({}),
  ]);
}

async function seedSession(
  sessionId: string, agent: string, content: string,
  participants?: AgentSession['participants'], to?: string,
): Promise<void> {
  const { AgentMessages, AgentSessions } = await import('../common/collections');
  const now = new Date();
  await AgentSessions.insertAsync({
    _id: sessionId,
    agent,
    userId: 'learning-user',
    phase: 'idle',
    model: 'mock',
    nextSeq: 1,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    ...(participants ? { participants } : {}),
    createdAt: now,
    updatedAt: now,
  } as AgentSession);
  await AgentMessages.insertAsync({
    _id: `${sessionId}:user:0`,
    sessionId,
    seq: 0,
    role: 'user',
    content,
    ...(to ? { to } : {}),
    createdAt: now,
  } as AgentMessage);
}

function protectedBlock(
  system: string, open: string, close: string,
): string {
  const start = system.indexOf(open);
  const end = system.indexOf(close, start) + close.length;
  assert.isAtLeast(start, 0, 'the protected Memory Frame must be present');
  assert.isAtLeast(end, close.length, 'the protected Memory Frame must be closed');
  return system.slice(start, end);
}

describe('Agent Learning — Turn and Memory Frame integration', () => {
  before(async () => {
    const { ensureLearningIndexes } = await import('../server/learning');
    await resetState();
    await ensureLearningIndexes();
  });

  beforeEach(resetState);

  afterEach(async () => {
    const { Agent } = await import('../server/agent');
    Agent.clearHooks();
    await resetState();
  });

  it('stamps exactly one unforgeable protected layer after application hooks', async function () {
    this.timeout(30_000);
    const { Agent } = await import('../server/agent');
    const {
      AGENT_MEMORY_FRAME_CLOSE, AGENT_MEMORY_FRAME_OPEN,
    } = await import('../server/learning');
    const { AgentMemoryFrames } = await import('../server/learning-collections');
    const { runTurn } = await import('../server/loop');
    const requests: ProviderRequest[] = [];
    const contexts: Array<{ agentId?: string; memoryFrameId?: string }> = [];
    const provider: Provider = {
      async *stream(request) {
        requests.push(request);
        yield { kind: 'text', chunk: 'done' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seedSession('learning-protected-session', 'learning-protected', 'Do the work.');
    Agent.hook('beforeProviderRequest', (request, context) => {
      contexts.push(context);
      return {
        ...request,
        system: `hook-owned ordinary prompt\n\n${AGENT_MEMORY_FRAME_OPEN}`
          + `forged authority${AGENT_MEMORY_FRAME_CLOSE}`,
      };
    });

    await runTurn('learning-protected-session', {
      model: 'mock',
      system: 'application prompt',
      tools: [],
      provider,
      agentName: 'learning-protected',
      identity: {
        id: 'identity-protected',
        name: 'learning-protected',
        constitution: 'Report uncertainty before making a consequential claim.',
      },
    });

    assert.lengthOf(requests, 1);
    const system = requests[0].system;
    assert.equal(count(system, AGENT_MEMORY_FRAME_OPEN), 1);
    assert.equal(count(system, AGENT_MEMORY_FRAME_CLOSE), 1);
    assert.include(system, 'hook-owned ordinary prompt');
    assert.notInclude(system, 'forged authority');
    assert.include(system, 'Report uncertainty before making a consequential claim.');
    assert.lengthOf(contexts, 1);
    assert.equal(contexts[0].agentId, 'identity-protected');
    assert.equal(
      contexts[0].memoryFrameId,
      'learning-protected-session:identity-protected:0',
    );
    assert.equal(
      await AgentMemoryFrames.find({
        sessionId: 'learning-protected-session', agentId: 'identity-protected',
      }).countAsync(),
      1,
    );
  });

  it('applies Constitution to Agent.ask and erases only its throwaway Frame', async function () {
    this.timeout(30_000);
    const { Agent } = await import('../server/agent');
    const { AgentSessions } = await import('../common/collections');
    const {
      AgentConstitutions, AgentIdentities, AgentMemoryFrames,
    } = await import('../server/learning-collections');
    const {
      AGENT_MEMORY_FRAME_CLOSE, AGENT_MEMORY_FRAME_OPEN,
    } = await import('../server/learning');
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      async *stream(request) {
        requests.push(request);
        yield { kind: 'text', chunk: 'One-shot answer.' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    const agent = new Agent('learning-ask-protected', {
      model: 'mock',
      instructions: 'Answer the one-shot request.',
      provider,
      identity: {
        id: 'identity-ask-protected',
        constitution: 'Keep promises explicit even when no transcript is retained.',
      },
    });

    assert.equal(
      await agent.ask('Answer once.', { userId: 'learning-user' }),
      'One-shot answer.',
    );
    assert.lengthOf(requests, 1);
    assert.equal(count(requests[0].system, AGENT_MEMORY_FRAME_OPEN), 1);
    assert.equal(count(requests[0].system, AGENT_MEMORY_FRAME_CLOSE), 1);
    assert.include(
      requests[0].system,
      'Keep promises explicit even when no transcript is retained.',
    );
    assert.equal(await AgentSessions.find({ agent: 'learning-ask-protected' }).countAsync(), 0);
    assert.equal(
      await AgentMemoryFrames.find({ agentId: 'identity-ask-protected' }).countAsync(), 0,
      'the throwaway Session owns and erases its Memory Frame',
    );
    assert.exists(await AgentIdentities.findOneAsync('identity-ask-protected'));
    assert.equal(
      await AgentConstitutions.find({ agentId: 'identity-ask-protected' }).countAsync(), 1,
      'Agent-owned Identity and Constitution survive the one-shot Session',
    );
  });

  it('refuses Agent.ask after its durable Identity is archived', async function () {
    this.timeout(30_000);
    const { Agent } = await import('../server/agent');
    const {
      ensureAgentIdentity, setIdentityLifecycle,
    } = await import('../server/learning');
    let providerCalls = 0;
    const agent = new Agent('learning-ask-archived', {
      model: 'mock', instructions: 'Do not run after archival.',
      provider: {
        async *stream() {
          providerCalls += 1;
          yield { kind: 'text', chunk: 'must not run' } as const;
          yield { kind: 'done', usage: { input: 1, output: 1 } } as const;
        },
      },
      identity: { id: 'identity-ask-archived' },
    });
    const identity = await ensureAgentIdentity({
      id: 'identity-ask-archived', name: 'learning-ask-archived',
    });
    await setIdentityLifecycle(
      identity.value._id, identity.value.generation, 'archived',
      { kind: 'app', key: 'archive-before-ask' },
    );

    let failure: unknown;
    try {
      await agent.ask('This must not reach the provider.', { userId: 'learning-user' });
    } catch (error) {
      failure = error;
    }
    assert.exists(failure);
    assert.include(String((failure as Error).message), 'Agent identity and learning frame');
    assert.equal(providerCalls, 0);
  });

  it('reuses one frozen Frame across a Provider retry and a Tool iteration', async function () {
    this.timeout(30_000);
    const { Agent } = await import('../server/agent');
    const {
      AGENT_MEMORY_FRAME_CLOSE, AGENT_MEMORY_FRAME_OPEN,
    } = await import('../server/learning');
    const {
      AgentLearningEvents, AgentMemoryFrames,
    } = await import('../server/learning-collections');
    const { runTurn } = await import('../server/loop');
    let providerCall = 0;
    let toolCalls = 0;
    const systems: string[] = [];
    const frameIds: Array<string | undefined> = [];
    const provider: Provider = {
      async *stream(request) {
        providerCall += 1;
        systems.push(request.system);
        if (providerCall === 1) {
          const failure = Object.assign(new Error('temporary outage'), { status: 503 });
          throw failure;
        }
        if (providerCall === 2) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'inspect-once', name: 'inspect', args: {} }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        yield { kind: 'text', chunk: 'finished' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    await seedSession('learning-retry-session', 'learning-retry', 'Inspect it.');
    Agent.hook('beforeProviderRequest', (_request, context) => {
      frameIds.push(context.memoryFrameId);
    });
    await runTurn('learning-retry-session', {
      model: 'mock',
      system: 'application prompt',
      tools: [{
        name: 'inspect',
        description: 'Inspect once.',
        args: { type: 'object', properties: {}, additionalProperties: false },
        gate: 'auto',
        run: async () => { toolCalls += 1; return { inspected: true }; },
      }],
      provider,
      agentName: 'learning-retry',
      identity: {
        id: 'identity-retry',
        name: 'learning-retry',
        constitution: 'Distinguish evidence from inference.',
      },
      retry: { attempts: 2, baseMs: 0, maxDelayMs: 0 },
    });

    assert.equal(providerCall, 3, 'one failed attempt, its retry, and one Tool iteration');
    assert.equal(toolCalls, 1);
    assert.deepEqual(frameIds, [
      'learning-retry-session:identity-retry:0',
      'learning-retry-session:identity-retry:0',
      'learning-retry-session:identity-retry:0',
    ]);
    const blocks = systems.map((system) => protectedBlock(
      system, AGENT_MEMORY_FRAME_OPEN, AGENT_MEMORY_FRAME_CLOSE,
    ));
    assert.equal(new Set(blocks).size, 1, 'every attempt adopts byte-identical authority');
    systems.forEach((system) => {
      assert.equal(count(system, AGENT_MEMORY_FRAME_OPEN), 1);
      assert.equal(count(system, AGENT_MEMORY_FRAME_CLOSE), 1);
    });
    assert.equal(
      await AgentMemoryFrames.find({
        sessionId: 'learning-retry-session', agentId: 'identity-retry',
      }).countAsync(),
      1,
    );
    assert.equal(
      await AgentLearningEvents.find({
        agentId: 'identity-retry', kind: 'provider-requested',
      }).countAsync(),
      3,
      'each effective outbound request is digest-audited against the same Frame',
    );
  });

  it('fails closed when a concurrent Frame winner froze different Fact bytes',
    async function () {
      this.timeout(30_000);
      const { AgentMemories, AgentSessions } = await import('../common/collections');
      const {
        canonicalDigest, freezeMemoryFrame,
      } = await import('../server/learning');
      const { prepareTurnLearning } = await import('../server/learning-runtime');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const { memoryBlockSnapshot } = await import('../server/memory');
      const { resolveMemory } = await import('../server/registry');
      const sessionId = 'learning-concurrent-frame-session';
      const agentName = 'learning-concurrent-frame';
      const agentId = 'identity-concurrent-frame';
      const frameId = `${sessionId}:${agentId}:0`;
      const factMemory = resolveMemory({
        hints: false,
        scopes: ['user'],
        index: { pinned: 1, recent: 2 },
      })!;
      await seedSession(sessionId, agentName, 'Use the standing Fact Memory.');
      await AgentMemories.insertAsync({
        _id: 'locally-rendered-fact',
        scope: 'user',
        userId: 'learning-user',
        text: 'The local renderer saw this fact.',
        by: 'test',
        at: new Date(),
      });
      const local = await memoryBlockSnapshot({
        userId: 'learning-user', agent: agentName, config: factMemory,
      });
      assert.include(local.text, 'The local renderer saw this fact.');

      const collection = AgentMemoryFrames as any;
      const originalFindOneAsync = collection.findOneAsync;
      let exactTupleReads = 0;
      let winnerPromptDigest = '';
      let patchedFindOneAsync: (...args: any[]) => Promise<any>;
      patchedFindOneAsync = async function concurrentWinner(
        selector: unknown, options?: unknown,
      ): Promise<any> {
        if (selector === frameId) {
          exactTupleReads += 1;
          // First exact read is prepareTurnLearning's optimistic check. On
          // the second, freezeMemoryFrame is entering its adoption check and
          // another renderer wins the tuple with different Fact bytes.
          if (exactTupleReads === 2) {
            collection.findOneAsync = originalFindOneAsync;
            try {
              const winner = await freezeMemoryFrame({
                sessionId,
                agentId,
                triggerSeq: 0,
                context: 'The concurrent renderer won this trigger.',
                factMemory: {
                  text: 'concurrent winner prompt bytes',
                  rows: [{
                    _id: 'concurrent-winner-fact',
                    scope: 'user',
                    text: 'The concurrent renderer saw another fact.',
                  }],
                },
              });
              winnerPromptDigest = winner.value.factMemory.promptDigest;
              return winner.value;
            } finally {
              collection.findOneAsync = patchedFindOneAsync;
            }
          }
        }
        return originalFindOneAsync.call(AgentMemoryFrames, selector, options);
      };
      collection.findOneAsync = patchedFindOneAsync;

      let failure: unknown;
      try {
        const session = (await AgentSessions.findOneAsync(sessionId))!;
        await prepareTurnLearning({
          session,
          agentName,
          identity: { id: agentId, name: agentName },
          factMemory,
        });
      } catch (error) {
        failure = error;
      } finally {
        collection.findOneAsync = originalFindOneAsync;
      }

      assert.equal(exactTupleReads, 2, 'the test must exercise freeze-time adoption');
      assert.include(String((failure as Error | undefined)?.message),
        'stopped rather than mixing causal snapshots');
      assert.equal(
        winnerPromptDigest,
        canonicalDigest('concurrent winner prompt bytes'),
      );
      assert.notEqual(winnerPromptDigest, canonicalDigest(local.text));
      const standing = await AgentMemoryFrames.findOneAsync(frameId);
      assert.deepEqual(standing?.factMemory.evidence.map((row) => row.id), [
        'concurrent-winner-fact',
      ]);
    });

  it('derives owner audiences from Session ownership with anonymous Session fallback',
    async () => {
      const { AgentSessions } = await import('../common/collections');
      const { prepareTurnLearning } = await import('../server/learning-runtime');
      const agentName = 'learning-audience-runtime';
      const identity = { id: 'identity-audience-runtime', name: agentName };
      for (const sessionId of ['owner-a-one', 'owner-a-two', 'owner-b', 'anon-a', 'anon-b']) {
        await seedSession(sessionId, agentName, `Trigger ${sessionId}`);
      }
      await AgentSessions.updateAsync('owner-b', { $set: { userId: 'other-owner' } });
      await AgentSessions.updateAsync({ _id: { $in: ['anon-a', 'anon-b'] } }, {
        $set: { userId: null },
      }, { multi: true });

      const frames = new Map<string, NonNullable<Awaited<ReturnType<
        typeof prepareTurnLearning
      >>>>();
      for (const sessionId of ['owner-a-one', 'owner-a-two', 'owner-b', 'anon-a', 'anon-b']) {
        const session = (await AgentSessions.findOneAsync(sessionId))!;
        const snapshot = await prepareTurnLearning({
          session, agentName, identity,
          experience: { record: true, recall: false, scope: 'owner' },
        });
        assert.exists(snapshot);
        frames.set(sessionId, snapshot!);
      }

      assert.deepEqual(frames.get('owner-a-one')!.frame.audience, {
        scope: 'owner', key: 'learning-user',
      });
      assert.deepEqual(frames.get('owner-a-two')!.frame.audience, {
        scope: 'owner', key: 'learning-user',
      });
      assert.deepEqual(frames.get('owner-b')!.frame.audience, {
        scope: 'owner', key: 'other-owner',
      });
      assert.deepEqual(frames.get('anon-a')!.frame.audience, {
        scope: 'session', key: 'anon-a',
      });
      assert.deepEqual(frames.get('anon-b')!.frame.audience, {
        scope: 'session', key: 'anon-b',
      });
    });

  it('cancels a parked batch when frozen Fact bytes cannot be recovered',
    async function () {
      this.timeout(30_000);
      const {
        AgentMemories, AgentMessages, AgentSessions,
      } = await import('../common/collections');
      const { prepareTurnLearning } = await import('../server/learning-runtime');
      const { runTurn } = await import('../server/loop');
      const { resolveMemory } = await import('../server/registry');
      const sessionId = 'learning-stale-park-session';
      const agentName = 'learning-stale-park';
      const agentId = 'identity-stale-park';
      const factMemory = resolveMemory({
        hints: false, scopes: ['user'], index: { pinned: 1, recent: 2 },
      })!;
      await seedSession(sessionId, agentName, 'Use the current fact.');
      await AgentMemories.insertAsync({
        _id: 'stale-park-fact', scope: 'user', userId: 'learning-user',
        text: 'Original fact bytes.', by: 'test', at: new Date(),
      });
      const initial = (await AgentSessions.findOneAsync(sessionId))!;
      await prepareTurnLearning({
        session: initial,
        agentName,
        identity: { id: agentId, name: agentName },
        factMemory,
      });
      await AgentMessages.insertAsync({
        _id: 'stale-park-assistant', sessionId, seq: 1, role: 'assistant',
        content: '',
        toolCalls: [{ id: 'stale-park-call', name: 'approved-work', args: {} }],
        createdAt: new Date(),
      });
      await AgentSessions.updateAsync(sessionId, {
        $set: {
          phase: 'awaiting',
          nextSeq: 2,
          pending: {
            toolCallId: 'stale-park-call', name: 'approved-work', args: {},
            agent: agentName, verdict: 'approved', requestedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      });
      await AgentMemories.updateAsync('stale-park-fact', {
        $set: { text: 'Fact bytes changed while approval was parked.', at: new Date() },
      });
      let providerStarts = 0;
      const provider: Provider = {
        async *stream() {
          providerStarts += 1;
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };

      await runTurn(sessionId, {
        model: 'mock', system: 'application prompt', tools: [], provider,
        agentName,
        identity: { id: agentId, name: agentName },
        memory: factMemory,
      });

      const released = await AgentSessions.findOneAsync(sessionId);
      assert.equal(released?.phase, 'error');
      assert.isUndefined(released?.pending, 'the unrecoverable approval must not remain parked');
      assert.equal(providerStarts, 0);
      assert.isUndefined(await AgentMessages.findOneAsync('stale-park-assistant'));
      const note = await AgentMessages.findOneAsync({
        sessionId, role: 'note', kind: 'error', 'error.error': 'learning-unavailable',
      } as any);
      assert.include(note?.error?.reason ?? '', 'restart with current memory');
    });

  it('a turn that saves a fact and then parks still resumes after approval',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMemories, AgentMessages, AgentSessions } = await import('../common/collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      let toolRan = false;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1) {
            // The deterministic approval-evaporation shape: an auto-gated
            // save lands, then the ask-gated call parks the same batch.
            yield {
              kind: 'done',
              toolCalls: [
                {
                  id: 'sp-save', name: 'memory_save',
                  args: { text: 'New fact learned mid-turn.', scope: 'user' },
                },
                { id: 'sp-publish', name: 'publish_brief', args: {} },
              ],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Published.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-save-park', {
        model: 'mock',
        instructions: 'Save then publish.',
        provider,
        tools: [{
          name: 'publish_brief', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { toolRan = true; return 'published'; },
        }],
        memory: { hints: false, scopes: ['user'], index: { pinned: 1, recent: 4 } },
        identity: { id: 'identity-save-park' },
      });
      await seedSession('save-park-session', 'learning-save-park', 'Save and publish.');
      await runTurn('save-park-session', buildRunConfig(getAgent('learning-save-park')!, 'learning-user'));

      const parked = await AgentSessions.findOneAsync('save-park-session');
      assert.equal(parked?.phase, 'awaiting');
      assert.equal(parked?.pending?.name, 'publish_brief');
      assert.equal(parked?.pending?.memoryFrameId, 'save-park-session:identity-save-park:0',
        'the park carries its causal Frame anchor');
      assert.isDefined(await AgentMemories.findOneAsync({ text: 'New fact learned mid-turn.' } as any),
        'the auto-gated save landed before the park');

      await agent.approve('save-park-session', {
        userId: 'learning-user', expectedToolCallId: 'sp-publish',
      });
      await waitFor(
        async () => toolRan
          && (await AgentSessions.findOneAsync('save-park-session'))?.phase === 'idle',
        'the approved tool to run despite the turn\'s own save',
      );
      assert.isUndefined((await AgentSessions.findOneAsync('save-park-session'))?.pending);
      assert.isUndefined(await AgentMessages.findOneAsync({
        sessionId: 'save-park-session', role: 'note', kind: 'error',
        'error.error': 'learning-unavailable',
      } as any), 'the turn\'s own save must not void the human\'s approval');
    });

  it('a fact saved by another session while parked does not void the approval',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMemories, AgentMessages, AgentSessions } = await import('../common/collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      let toolRan = false;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{ id: 'cs-publish', name: 'publish_brief', args: {} }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Published.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-concurrent-save', {
        model: 'mock',
        instructions: 'Publish.',
        provider,
        tools: [{
          name: 'publish_brief', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { toolRan = true; return 'published'; },
        }],
        memory: { hints: false, scopes: ['user'], index: { pinned: 1, recent: 4 } },
        identity: { id: 'identity-concurrent-save' },
      });
      await seedSession('concurrent-save-session', 'learning-concurrent-save', 'Publish it.');
      await AgentMemories.insertAsync({
        _id: 'cs-frozen-fact', scope: 'user', userId: 'learning-user',
        text: 'A fact the frame froze.', by: 'test', at: new Date(),
      });
      await runTurn(
        'concurrent-save-session',
        buildRunConfig(getAgent('learning-concurrent-save')!, 'learning-user'),
      );
      assert.equal((await AgentSessions.findOneAsync('concurrent-save-session'))?.phase, 'awaiting');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const frozen = await AgentMemoryFrames.findOneAsync(
        'concurrent-save-session:identity-concurrent-save:0',
      );
      assert.isTrue(
        frozen?.factMemory.evidence.some((item) => item.id === 'cs-frozen-fact'),
        'the fixture fact must be frozen evidence, or this test discriminates nothing',
      );

      // Another session of the same user saves while the approval waits. The
      // frozen row is untouched — only an addition — so recovery must adopt.
      await AgentMemories.insertAsync({
        _id: 'cs-new-fact', scope: 'user', userId: 'learning-user',
        text: 'Saved elsewhere while parked.', by: 'test', at: new Date(),
      });
      await agent.approve('concurrent-save-session', {
        userId: 'learning-user', expectedToolCallId: 'cs-publish',
      });
      await waitFor(
        async () => toolRan
          && (await AgentSessions.findOneAsync('concurrent-save-session'))?.phase === 'idle',
        'the approval to survive a concurrent unrelated save',
      );
      assert.isUndefined(await AgentMessages.findOneAsync({
        sessionId: 'concurrent-save-session', role: 'note', kind: 'error',
        'error.error': 'learning-unavailable',
      } as any));
    });

  it('a user message landing while parked does not move the approved call to a new Frame',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      let toolRan = false;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{ id: 'mv-publish', name: 'publish_brief', args: {} }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Published.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-anchored-park', {
        model: 'mock',
        instructions: 'Publish.',
        provider,
        tools: [{
          name: 'publish_brief', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { toolRan = true; return 'published'; },
        }],
        identity: { id: 'identity-anchored-park' },
        experience: { record: true, recall: false, scope: 'owner' },
      });
      await seedSession('anchored-park-session', 'learning-anchored-park', 'Publish it.');
      await runTurn(
        'anchored-park-session',
        buildRunConfig(getAgent('learning-anchored-park')!, 'learning-user'),
      );
      const parked = await AgentSessions.findOneAsync('anchored-park-session');
      assert.equal(parked?.phase, 'awaiting');

      // A user row lands while parked. Without the anchor, resume would
      // re-derive this newer row as the trigger and freeze a fresh Frame.
      const interjectSeq = parked!.nextSeq;
      await AgentMessages.insertAsync({
        _id: 'anchored-park-interject', sessionId: 'anchored-park-session',
        seq: interjectSeq, role: 'user', content: 'Also, one more thing.',
        createdAt: new Date(),
      } as AgentMessage);
      await AgentSessions.updateAsync('anchored-park-session', { $inc: { nextSeq: 1 } });

      await agent.approve('anchored-park-session', {
        userId: 'learning-user', expectedToolCallId: 'mv-publish',
      });
      await waitFor(
        async () => toolRan
          && (await AgentSessions.findOneAsync('anchored-park-session'))?.phase === 'idle',
        'the anchored approval to resume',
      );
      const frames = await AgentMemoryFrames.find(
        { sessionId: 'anchored-park-session' },
      ).fetchAsync();
      // A revert of the anchor re-derives the interjected row as the trigger
      // and freezes a SECOND frame during the resume — one frame at
      // triggerSeq 0 is the whole proof of adoption.
      assert.lengthOf(frames, 1, 'the approved call resumed under its original Frame');
      assert.equal(frames[0].triggerSeq, 0);
    });

  it('a crew note is never a Memory Frame trigger', async function () {
    this.timeout(30_000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { prepareTurnLearning } = await import('../server/learning-runtime');
    const sessionId = 'crew-note-trigger-session';
    await seedSession(sessionId, 'crew-note-agent', 'Real trigger.');
    const first = await prepareTurnLearning({
      session: (await AgentSessions.findOneAsync(sessionId))!,
      agentName: 'crew-note-agent',
      identity: { id: 'identity-crew-note', name: 'crew-note-agent' },
    });
    assert.equal(first?.triggerSeq, 0);

    // Crew notes promise "no model work" — one must not become the trigger.
    await AgentMessages.insertAsync({
      _id: 'crew-note-row', sessionId, seq: 1, role: 'user', kind: 'crew-note',
      content: 'FYI from the crew.', createdAt: new Date(),
    } as AgentMessage);
    await AgentSessions.updateAsync(sessionId, { $inc: { nextSeq: 1 } });
    const second = await prepareTurnLearning({
      session: (await AgentSessions.findOneAsync(sessionId))!,
      agentName: 'crew-note-agent',
      identity: { id: 'identity-crew-note', name: 'crew-note-agent' },
    });
    assert.equal(second?.triggerSeq, 0, 'the crew note must not displace the trigger');
    assert.equal(second?.memoryFrameId, first?.memoryFrameId);
  });

  it('a store read failure during recovery leaves the park and verdict intact',
    async function () {
      this.timeout(40_000);
      const { Agent } = await import('../server/agent');
      const { AgentMemories, AgentMessages, AgentSessions } = await import('../common/collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      let toolRan = false;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{ id: 'out-publish', name: 'publish_brief', args: {} }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Published.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-outage', {
        model: 'mock',
        instructions: 'Publish.',
        provider,
        tools: [{
          name: 'publish_brief', description: 'x', gate: 'ask',
          args: { type: 'object', properties: {} },
          run: async () => { toolRan = true; return 'published'; },
        }],
        memory: { hints: false, scopes: ['user'], index: { pinned: 1, recent: 4 } },
        identity: { id: 'identity-outage' },
      });
      await seedSession('outage-session', 'learning-outage', 'Publish it.');
      await AgentMemories.insertAsync({
        _id: 'outage-frozen-fact', scope: 'user', userId: 'learning-user',
        text: 'A fact the frame froze.', by: 'test', at: new Date(),
      });
      await runTurn(
        'outage-session', buildRunConfig(getAgent('learning-outage')!, 'learning-user'),
      );
      assert.equal((await AgentSessions.findOneAsync('outage-session'))?.phase, 'awaiting');

      // One injected read failure on the frozen-evidence fetch: the first
      // resume attempt must PRESERVE the park (no discard, no
      // learning-unavailable note) and the retry must then complete it.
      const originalFind = AgentMemories.find.bind(AgentMemories);
      let injected = false;
      (AgentMemories as { find: unknown }).find = (selector?: unknown, options?: unknown) => {
        const byIds = (selector as { _id?: { $in?: unknown[] } } | undefined)?._id?.$in;
        if (!injected && Array.isArray(byIds)) {
          injected = true;
          throw new Error('injected store outage');
        }
        return originalFind(selector as any, options as any);
      };
      try {
        await agent.approve('outage-session', {
          userId: 'learning-user', expectedToolCallId: 'out-publish',
        });
        // The failed attempt must settle back to the REPAIRABLE state: park
        // and verdict intact, nothing discarded, no error note.
        await waitFor(
          async () => {
            if (!injected) return false;
            const settled = await AgentSessions.findOneAsync('outage-session');
            return settled?.phase === 'idle' && settled.pending?.verdict === 'approved';
          },
          'the failed attempt to leave the park and verdict standing',
          20_000,
        );
        assert.isFalse(toolRan, 'the outage attempt must not have run the tool');
        assert.isUndefined(await AgentMessages.findOneAsync({
          sessionId: 'outage-session', role: 'note', kind: 'error',
          'error.error': 'learning-unavailable',
        } as any), 'a read failure is not changed causes; the park must not be destroyed');

        // Unchanged causes are latched per drain; in production the watcher
        // sweep (or any later session activity) opens the next drain. Tests
        // run watcherless, so nudge per poll — a nudge landing inside a
        // still-winding-down drain is consumed by its latch, exactly like a
        // single sweep tick; the next one opens a fresh drain.
        const { activate } = await import('../server/activation');
        await waitFor(
          async () => {
            activate('outage-session');
            return toolRan
              && (await AgentSessions.findOneAsync('outage-session'))?.phase === 'idle';
          },
          'the retry to complete the approved call',
          20_000,
        );
      } finally {
        (AgentMemories as { find: unknown }).find = originalFind;
      }
      assert.isUndefined(
        (await AgentSessions.findOneAsync('outage-session'))?.pending,
        'the retry consumed the verdict normally',
      );
    });

  it('clamps an astral-heavy trigger context without bricking the frame',
    async function () {
      this.timeout(30_000);
      const { AgentSessions } = await import('../common/collections');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const { prepareTurnLearning } = await import('../server/learning-runtime');
      const sessionId = 'clamp-trigger-session';
      // 254 ASCII chars put the astral pair straddling the clamp boundary —
      // the naive slice split it and BSON round-tripped U+FFFD, bricking the
      // frozen digest on first re-read.
      const long = `${'x'.repeat(254)}😀😀 and more text beyond the clamp`;
      await seedSession(sessionId, 'clamp-agent', long);
      const snapshot = await prepareTurnLearning({
        session: (await AgentSessions.findOneAsync(sessionId))!,
        agentName: 'clamp-agent',
        identity: { id: 'identity-clamp', name: 'clamp-agent' },
      });
      assert.exists(snapshot);
      assert.isAtMost(snapshot!.frame.context.length, 256);
      assert.notInclude(snapshot!.frame.context, '�');
      const stored = await AgentMemoryFrames.findOneAsync(snapshot!.memoryFrameId);
      assert.equal(
        stored?.context, snapshot!.frame.context,
        'the BSON round trip must not mutate the clamped context',
      );
    });

  it('records a model-authored Experience exactly once, and only after approval',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { EXPERIENCE_PROPOSE_TOOL_NAME } = await import('../server/learning-tools');
      const {
        AgentExperiences, AgentLearningEvents,
      } = await import('../server/learning-collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      const provider: Provider = {
        async *stream(request) {
          providerCall += 1;
          assert.isTrue(
            request.tools.some((tool) => tool.name === EXPERIENCE_PROPOSE_TOOL_NAME),
            'an Experience-enabled Agent exposes the reserved proposal Tool',
          );
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{
                id: 'experience-call-approved',
                name: EXPERIENCE_PROPOSE_TOOL_NAME,
                args: {
                  expectationBasis: 'explicit',
                  expected: 'The cache contains the object.',
                  observed: 'The cache missed.',
                  difference: 'The expected object was absent.',
                  lesson: 'Check cache presence before relying on cached state.',
                  context: 'cache-read',
                  confidence: 0.9,
                },
              }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Learning recorded.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-approved', {
        model: 'mock',
        instructions: 'Investigate cache behavior.',
        provider,
        tools: [],
        identity: {
          id: 'identity-approved',
          constitution: 'Never conceal uncertainty.',
        },
        experience: { record: true, recall: false, scope: 'owner' },
      });
      await seedSession('learning-approved-session', 'learning-approved', 'Check the cache.');
      const config = getAgent('learning-approved')!;

      await runTurn(
        'learning-approved-session', buildRunConfig(config, 'learning-user'),
      );

      const parked = await AgentSessions.findOneAsync('learning-approved-session');
      assert.equal(parked?.phase, 'awaiting');
      assert.equal(parked?.pending?.name, EXPERIENCE_PROPOSE_TOOL_NAME);
      assert.equal(
        await AgentExperiences.find({ agentId: 'identity-approved' }).countAsync(),
        0,
        'the proposal is not evidence until a human approves it',
      );

      await agent.approve('learning-approved-session', {
        userId: 'learning-user', expectedToolCallId: 'experience-call-approved',
      });
      await waitFor(
        async () => providerCall === 2
          && (await AgentSessions.findOneAsync('learning-approved-session'))?.phase === 'idle',
        'the approved Experience Tool to resume and finish',
      );

      const rows = await AgentExperiences.find({ agentId: 'identity-approved' }).fetchAsync();
      const transcript = await AgentMessages.find(
        { sessionId: 'learning-approved-session' }, { sort: { seq: 1 } },
      ).fetchAsync();
      const proposalMessage = transcript.find((message) => message.role === 'assistant'
        && message.toolCalls?.some((call) => call.id === 'experience-call-approved'));
      const proposalResult = transcript.find((message) => message.role === 'tool'
        && message.toolCallId === 'experience-call-approved');
      assert.lengthOf(rows, 1);
      assert.isDefined(proposalMessage);
      assert.equal(
        proposalResult?.content,
        JSON.stringify('Experience recorded.'),
        'the narrow receipt follows the package-wide JSON Tool-result wire format',
      );
      assert.notInclude(proposalResult?.content ?? '', 'learning-user');
      assert.notInclude(proposalResult?.content ?? '', 'audience');
      assert.notInclude(proposalResult?.content ?? '', 'assistantMessageId');
      assert.equal(rows[0].expectationBasis, 'explicit');
      assert.equal(rows[0].admission, 'reviewed');
      assert.deepEqual(rows[0].audience, { scope: 'owner', key: 'learning-user' });
      assert.equal(rows[0].source.kind, 'model');
      assert.equal(rows[0].source.sessionId, 'learning-approved-session');
      assert.equal(rows[0].source.triggerSeq, 0);
      assert.equal(rows[0].source.toolCallId, 'experience-call-approved');
      assert.equal(rows[0].source.assistantMessageId, proposalMessage!._id);
      assert.equal(rows[0].frameId, 'learning-approved-session:identity-approved:0');
      const providerEvents = await AgentLearningEvents.find({
        agentId: 'identity-approved', kind: 'provider-requested',
      }).fetchAsync();
      assert.lengthOf(
        providerEvents,
        2,
        'the request that parked and its post-approval continuation are audited separately',
      );
      assert.equal(
        new Set(providerEvents.map((event) => event.source.key)).size,
        2,
        'approval resume uses a new durable transcript slot rather than resetting a loop ordinal',
      );
    });

  it('records automatic Experience without parking and preserves its admission route',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { recordExperience } = await import('../server/learning');
      const { EXPERIENCE_PROPOSE_TOOL_NAME } = await import('../server/learning-tools');
      const {
        AgentExperiences, AgentLearningEvents, AgentMemoryFrames,
      } = await import('../server/learning-collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      const provider: Provider = {
        async *stream(request) {
          providerCall += 1;
          assert.isTrue(request.tools.some(
            (tool) => tool.name === EXPERIENCE_PROPOSE_TOOL_NAME,
          ));
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{
                id: 'experience-call-automatic',
                name: EXPERIENCE_PROPOSE_TOOL_NAME,
                args: {
                  expectationBasis: 'explicit',
                  expected: 'The cache contains the object.',
                  observed: 'The cache missed.',
                  difference: 'The expected object was absent.',
                  lesson: 'Check cache presence before relying on cached state.',
                  context: 'automatic-cache-read',
                  confidence: 0.9,
                },
              }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Learning recorded automatically.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      // Registry construction exercises the public per-Agent policy surface.
      // eslint-disable-next-line no-new
      new Agent('learning-automatic', {
        model: 'mock',
        instructions: 'Investigate cache behavior.',
        provider,
        tools: [],
        identity: { id: 'identity-automatic' },
        experience: {
          record: true, recall: false, scope: 'owner', approval: 'auto',
        },
      });
      await seedSession(
        'learning-automatic-session', 'learning-automatic', 'Check the cache.',
      );
      const config = getAgent('learning-automatic')!;

      await runTurn(
        'learning-automatic-session', buildRunConfig(config, 'learning-user'),
      );

      const session = await AgentSessions.findOneAsync('learning-automatic-session');
      assert.equal(providerCall, 2);
      assert.equal(session?.phase, 'idle');
      assert.isUndefined(session?.pending, 'automatic admission must not create an approval park');
      assert.equal(session?.budgetSpent?.toolCalls, 1);
      const rows = await AgentExperiences.find({ agentId: 'identity-automatic' }).fetchAsync();
      assert.lengthOf(rows, 1);
      const [experience] = rows;
      assert.equal(experience.admission, 'automatic');
      assert.isUndefined(experience.review);
      assert.deepEqual(experience.audience, { scope: 'owner', key: 'learning-user' });
      assert.equal(experience.source.kind, 'model');
      assert.equal(experience.source.toolCallId, 'experience-call-automatic');
      assert.equal(experience.frameId, 'learning-automatic-session:identity-automatic:0');
      const frame = await AgentMemoryFrames.findOneAsync(experience.frameId!);
      assert.equal(frame?.learningPolicy?.experienceAdmission, 'automatic');
      assert.equal(frame?.learningPolicy?.experienceRecording, true);
      assert.equal(await AgentMessages.find({
        sessionId: 'learning-automatic-session', role: 'note', kind: 'approval',
      } as any).countAsync(), 0, 'automatic admission must not fabricate a human receipt');
      const result = await AgentMessages.findOneAsync({
        sessionId: 'learning-automatic-session', role: 'tool',
        toolCallId: 'experience-call-automatic',
      });
      assert.equal(result?.content, JSON.stringify('Experience recorded.'));
      const event = await AgentLearningEvents.findOneAsync({
        agentId: 'identity-automatic', kind: 'experience-recorded',
        targetId: experience._id,
      });
      assert.equal(event?.details?.admission, 'automatic');

      await expectError(recordExperience({
        agentId: experience.agentId,
        expectationBasis: experience.expectationBasis,
        expected: experience.expected,
        observed: experience.observed,
        difference: experience.difference,
        lesson: experience.lesson,
        context: experience.context,
        confidence: experience.confidence,
        source: experience.source,
        frameId: experience.frameId,
        admission: 'reviewed',
      }), 'Experience admission does not match standing record');
      assert.equal(
        (await AgentExperiences.findOneAsync(experience._id))?.admission,
        'automatic',
      );
    });

  it('separates a reused Provider Tool-call id by committed assistant Message',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { recordExperience } = await import('../server/learning');
      const { EXPERIENCE_PROPOSE_TOOL_NAME } = await import('../server/learning-tools');
      const { AgentExperiences } = await import('../server/learning-collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      const { isRunning } = await import('../server/turn-state');
      const args = {
        expectationBasis: 'explicit',
        expected: 'The lookup returns one row.',
        observed: 'The lookup returned no rows.',
        difference: 'The expected row was absent.',
        lesson: 'Verify lookup results before relying on the row.',
        context: 'lookup-result',
        confidence: 0.85,
      } as const;
      let providerCall = 0;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1 || providerCall === 3) {
            yield {
              kind: 'done',
              toolCalls: [{
                // A Provider may reuse this id on a later assistant Message.
                id: 'provider-reused-call-id',
                name: EXPERIENCE_PROPOSE_TOOL_NAME,
                args,
              }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Proposal resolved.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-reused-call', {
        model: 'mock',
        instructions: 'Check lookup results.',
        provider,
        identity: { id: 'identity-reused-call' },
        experience: { record: true, recall: false },
      });
      await seedSession(
        'learning-reused-call-session', 'learning-reused-call', 'Run the first lookup.',
      );
      const config = getAgent('learning-reused-call')!;

      await runTurn(
        'learning-reused-call-session', buildRunConfig(config, 'learning-user'),
      );
      await agent.approve('learning-reused-call-session', {
        userId: 'learning-user', expectedToolCallId: 'provider-reused-call-id',
      });
      await waitFor(
        async () => providerCall === 2
          && !isRunning('learning-reused-call-session')
          && (await AgentSessions.findOneAsync('learning-reused-call-session'))?.phase === 'idle',
        'the first reused-id proposal to finish',
      );

      const standing = (await AgentSessions.findOneAsync('learning-reused-call-session'))!;
      const secondTriggerSeq = standing.nextSeq;
      await AgentMessages.insertAsync({
        _id: 'learning-reused-call-session:second-user',
        sessionId: 'learning-reused-call-session',
        seq: secondTriggerSeq,
        role: 'user',
        content: 'Run the later lookup.',
        createdAt: new Date(),
      } as AgentMessage);
      await AgentSessions.updateAsync('learning-reused-call-session', {
        $set: { nextSeq: secondTriggerSeq + 1, updatedAt: new Date() },
      } as any);
      await runTurn(
        'learning-reused-call-session', buildRunConfig(config, 'learning-user'),
      );
      assert.equal(
        (await AgentSessions.findOneAsync('learning-reused-call-session'))?.phase,
        'awaiting',
      );
      await agent.approve('learning-reused-call-session', {
        userId: 'learning-user', expectedToolCallId: 'provider-reused-call-id',
      });
      await waitFor(
        async () => providerCall === 4
          && !isRunning('learning-reused-call-session')
          && (await AgentSessions.findOneAsync('learning-reused-call-session'))?.phase === 'idle',
        'the later reused-id proposal to finish',
      );

      const experiences = await AgentExperiences.find(
        { agentId: 'identity-reused-call' }, { sort: { sequence: 1 } },
      ).fetchAsync();
      const proposingMessages = (await AgentMessages.find(
        { sessionId: 'learning-reused-call-session', role: 'assistant' },
        { sort: { seq: 1 } },
      ).fetchAsync()).filter((message) => message.toolCalls?.some(
        (call) => call.id === 'provider-reused-call-id',
      ));
      assert.lengthOf(experiences, 2);
      assert.lengthOf(proposingMessages, 2);
      assert.deepEqual(
        experiences.map((row) => row.source.toolCallId),
        ['provider-reused-call-id', 'provider-reused-call-id'],
      );
      assert.deepEqual(
        experiences.map((row) => row.source.assistantMessageId),
        proposingMessages.map((message) => message._id),
      );
      assert.notEqual(experiences[0]._id, experiences[1]._id);
      assert.notEqual(
        experiences[0].source.assistantMessageId,
        experiences[1].source.assistantMessageId,
      );

      const later = experiences[1];
      const replay = await recordExperience({
        agentId: later.agentId,
        expectationBasis: later.expectationBasis,
        expected: later.expected,
        observed: later.observed,
        difference: later.difference,
        lesson: later.lesson,
        context: later.context,
        confidence: later.confidence,
        source: later.source,
        frameId: later.frameId,
      });
      assert.isTrue(replay.replayed);
      assert.equal(replay.value._id, later._id);
      assert.equal(
        await AgentExperiences.find({ agentId: 'identity-reused-call' }).countAsync(),
        2,
      );
    });

  it('creates no Experience when the human denies the model-authored proposal',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentSessions } = await import('../common/collections');
      const { EXPERIENCE_PROPOSE_TOOL_NAME } = await import('../server/learning-tools');
      const { AgentExperiences } = await import('../server/learning-collections');
      const { buildRunConfig, getAgent } = await import('../server/registry');
      const { runTurn } = await import('../server/loop');
      let providerCall = 0;
      const provider: Provider = {
        async *stream() {
          providerCall += 1;
          if (providerCall === 1) {
            yield {
              kind: 'done',
              toolCalls: [{
                id: 'experience-call-denied',
                name: EXPERIENCE_PROPOSE_TOOL_NAME,
                args: {
                  expectationBasis: 'retrospective',
                  expected: 'The action would succeed.',
                  observed: 'The action failed.',
                  difference: 'The outcome did not match the reconstructed expectation.',
                  lesson: 'Do not record this ungrounded reconstruction.',
                  context: 'weak-evidence',
                  confidence: 0.2,
                },
              }],
              usage: { input: 1, output: 1 },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Proposal declined.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      const agent = new Agent('learning-denied', {
        model: 'mock',
        instructions: 'Investigate carefully.',
        provider,
        identity: { id: 'identity-denied' },
        experience: { record: true, recall: false },
      });
      await seedSession('learning-denied-session', 'learning-denied', 'Review this outcome.');
      const config = getAgent('learning-denied')!;

      await runTurn('learning-denied-session', buildRunConfig(config, 'learning-user'));
      assert.equal(
        await AgentExperiences.find({ agentId: 'identity-denied' }).countAsync(), 0,
      );
      await agent.deny('learning-denied-session', 'The expectation was reconstructed.', {
        userId: 'learning-user', expectedToolCallId: 'experience-call-denied',
      });
      await waitFor(
        async () => providerCall === 2
          && (await AgentSessions.findOneAsync('learning-denied-session'))?.phase === 'idle',
        'the denied proposal to resume without recording Experience',
      );
      assert.equal(
        await AgentExperiences.find({ agentId: 'identity-denied' }).countAsync(),
        0,
      );
    });

  it('attributes an unaddressed roster trigger to the primary Session Agent',
    async function () {
      this.timeout(30_000);
      const { modelParticipantId } = await import('../common/participants');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const { runTurn } = await import('../server/loop');
      const now = new Date();
      const participants: NonNullable<AgentSession['participants']> = [{
        id: 'h:learning-user', kind: 'human', role: 'owner', userId: 'learning-user',
        displayName: 'Operator', joinedAt: now,
      }, {
        id: modelParticipantId('learning-roster-primary'), kind: 'model', role: 'member',
        agent: 'learning-roster-primary', displayName: 'Primary', joinedAt: now,
      }, {
        id: modelParticipantId('learning-roster-colleague'), kind: 'model', role: 'member',
        agent: 'learning-roster-colleague', displayName: 'Colleague', joinedAt: now,
      }];
      let providerCalls = 0;
      const provider: Provider = {
        async *stream() {
          providerCalls += 1;
          yield { kind: 'text', chunk: 'Primary reply.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };

      await seedSession(
        'learning-roster-default-session',
        'learning-roster-primary',
        'Please review the latest result.',
        participants,
      );
      await runTurn('learning-roster-default-session', {
        model: 'mock', system: '', tools: [], provider,
        agentName: 'learning-roster-primary',
        identity: { id: 'identity-roster-primary', name: 'learning-roster-primary' },
      });

      assert.equal(providerCalls, 1);
      const frames = await AgentMemoryFrames.find({
        sessionId: 'learning-roster-default-session',
      }).fetchAsync();
      assert.deepEqual(frames.map((frame) => ({
        id: frame._id, agentId: frame.agentId, triggerSeq: frame.triggerSeq,
      })), [{
        id: 'learning-roster-default-session:identity-roster-primary:0',
        agentId: 'identity-roster-primary',
        triggerSeq: 0,
      }]);
      assert.equal(
        await AgentMemoryFrames.find({ agentId: 'identity-roster-colleague' }).countAsync(),
        0,
        'an unaddressed trigger must not be attributed to another rostered Agent',
      );
    });

  it('freezes distinct Agent-scoped Frames for addressed Agents in one Session',
    async function () {
      this.timeout(30_000);
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { modelParticipantId } = await import('../common/participants');
      const { AgentMemoryFrames } = await import('../server/learning-collections');
      const { runTurn } = await import('../server/loop');
      const now = new Date();
      const participants: NonNullable<AgentSession['participants']> = [{
        id: 'h:learning-user', kind: 'human', role: 'owner', userId: 'learning-user',
        displayName: 'Operator', joinedAt: now,
      }, {
        id: modelParticipantId('learning-alpha'), kind: 'model', role: 'member',
        agent: 'learning-alpha', displayName: 'Alpha', joinedAt: now,
      }, {
        id: modelParticipantId('learning-beta'), kind: 'model', role: 'member',
        agent: 'learning-beta', displayName: 'Beta', joinedAt: now,
      }];
      const provider: Provider = {
        async *stream() {
          yield { kind: 'text', chunk: 'Addressed reply.' };
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };

      await seedSession(
        'learning-addressed-session', 'learning-alpha', 'Beta, inspect this.',
        participants, modelParticipantId('learning-beta'),
      );
      await runTurn('learning-addressed-session', {
        model: 'mock', system: '', tools: [], provider,
        agentName: 'learning-beta',
        identity: { id: 'identity-beta', name: 'learning-beta' },
      });

      await AgentMessages.insertAsync({
        _id: 'learning-addressed-session:user:2',
        sessionId: 'learning-addressed-session',
        seq: 2,
        role: 'user',
        content: 'Alpha, synthesize this.',
        to: modelParticipantId('learning-alpha'),
        createdAt: new Date(),
      } as AgentMessage);
      await AgentSessions.updateAsync('learning-addressed-session', {
        $set: { nextSeq: 3, updatedAt: new Date() },
      } as any);
      await runTurn('learning-addressed-session', {
        model: 'mock', system: '', tools: [], provider,
        agentName: 'learning-alpha',
        identity: { id: 'identity-alpha', name: 'learning-alpha' },
      });

      const frames = await AgentMemoryFrames.find(
        { sessionId: 'learning-addressed-session' }, { sort: { triggerSeq: 1 } },
      ).fetchAsync();
      assert.lengthOf(frames, 2);
      assert.deepEqual(frames.map((frame) => ({
        id: frame._id, agentId: frame.agentId, triggerSeq: frame.triggerSeq,
      })), [{
        id: 'learning-addressed-session:identity-beta:0',
        agentId: 'identity-beta',
        triggerSeq: 0,
      }, {
        id: 'learning-addressed-session:identity-alpha:2',
        agentId: 'identity-alpha',
        triggerSeq: 2,
      }]);
      assert.notEqual(frames[0].digest, frames[1].digest);
    });

  it('keeps a targeted system Turn on one Frame across an approval resume',
    async function () {
      this.timeout(30_000);
      const { Agent } = await import('../server/agent');
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { modelParticipantId } = await import('../common/participants');
      const {
        AgentLearningEvents, AgentMemoryFrames,
      } = await import('../server/learning-collections');
      const now = new Date();
      const primaryName = 'learning-system-primary';
      const targetName = 'learning-system-target';
      const targetId = 'identity-system-target';
      const sessionId = 'learning-targeted-system-session';
      const targetParticipant = modelParticipantId(targetName);
      const participants: NonNullable<AgentSession['participants']> = [{
        id: 'h:learning-user', kind: 'human', role: 'owner', userId: 'learning-user',
        displayName: 'Operator', joinedAt: now,
      }, {
        id: modelParticipantId(primaryName), kind: 'model', role: 'member',
        agent: primaryName, displayName: 'Primary', joinedAt: now,
      }, {
        id: targetParticipant, kind: 'model', role: 'member',
        agent: targetName, displayName: 'Target', joinedAt: now,
      }];
      let primaryCalls = 0;
      const primary = new Agent(primaryName, {
        model: 'mock', instructions: '', tools: [],
        provider: {
          async *stream() {
            primaryCalls += 1;
            yield { kind: 'text', chunk: 'wrong agent' } as const;
            yield { kind: 'done', usage: { input: 1, output: 1 } } as const;
          },
        },
      });
      let targetCalls = 0;
      let approvedRuns = 0;
      // eslint-disable-next-line no-new
      new Agent(targetName, {
        model: 'mock',
        instructions: '',
        identity: { id: targetId },
        tools: [{
          name: 'review_targeted_system_work',
          description: 'Review the targeted system work.',
          args: { type: 'object', properties: {}, additionalProperties: false },
          gate: 'ask',
          run: async () => { approvedRuns += 1; return { reviewed: true }; },
        }],
        provider: {
          async *stream() {
            targetCalls += 1;
            if (targetCalls === 1) {
              yield {
                kind: 'done',
                toolCalls: [{
                  id: 'targeted-system-approval',
                  name: 'review_targeted_system_work',
                  args: {},
                }],
                usage: { input: 1, output: 1 },
              } as const;
              return;
            }
            yield { kind: 'text', chunk: 'Targeted review complete.' } as const;
            yield { kind: 'done', usage: { input: 1, output: 1 } } as const;
          },
        },
      });

      // An older trigger for the same target is what exposed the bug: after the
      // current intent marker was consumed, recovery selected this row instead.
      await seedSession(
        sessionId, primaryName, 'Older target request.', participants, targetParticipant,
      );
      await AgentMessages.insertAsync({
        _id: `${sessionId}:assistant:1`, sessionId, seq: 1, role: 'assistant',
        content: 'Older target answer.',
        from: { participant: targetParticipant, name: targetName },
        createdAt: now,
      } as AgentMessage);
      await AgentSessions.updateAsync(sessionId, {
        $set: { nextSeq: 2, updatedAt: new Date() },
      } as any);

      const started = await primary.systemTurn(sessionId, 'Run the current targeted review.', {
        agent: targetName, source: 'test-scheduler', key: 'targeted-system-review',
      });
      assert.deepEqual(started, { ok: true, ran: true });
      await waitFor(
        async () => (await AgentSessions.findOneAsync(sessionId))?.phase === 'awaiting',
        'the targeted system Turn to park for approval',
      );
      const parked = (await AgentSessions.findOneAsync(sessionId))!;
      assert.isUndefined(parked.pendingSystem, 'the first commit consumes the intent marker');
      const systemRow = (await AgentMessages.findOneAsync({
        sessionId, role: 'system',
      } as any))!;
      assert.equal(systemRow.seq, 2);
      assert.equal(systemRow.to, targetParticipant, 'the durable trigger retains its target');

      await primary.approve(sessionId, {
        userId: 'learning-user', expectedToolCallId: 'targeted-system-approval',
      });
      await waitFor(
        async () => targetCalls === 2
          && (await AgentSessions.findOneAsync(sessionId))?.phase === 'idle',
        'the targeted system approval to resume and finish',
      );

      const expectedFrameId = `${sessionId}:${targetId}:2`;
      assert.equal(primaryCalls, 0);
      assert.equal(approvedRuns, 1);
      assert.deepEqual(
        (await AgentMemoryFrames.find({ sessionId, agentId: targetId }).fetchAsync())
          .map((frame) => frame._id),
        [expectedFrameId],
        'resume must not create or adopt a Frame for the older target trigger',
      );
      const providerEvents = await AgentLearningEvents.find({
        agentId: targetId, kind: 'provider-requested',
      }).fetchAsync();
      assert.lengthOf(providerEvents, 2);
      assert.deepEqual(
        [...new Set(providerEvents.map((event) => event.targetId))],
        [expectedFrameId],
        'the parked request and continuation stay causally bound to one Frame',
      );
    });
});
