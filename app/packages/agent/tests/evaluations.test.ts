import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import {
  evaluateAgentRun, runIsolatedAgentEvaluation, scoreEvaluationDeterministically,
} from '../server/evaluations';

describe('Evaluation Lab', () => {
  it('scores required, avoided, and tool-selection gates deterministically', () => {
    const scores = scoreEvaluationDeterministically({
      contains: ['READY', 'café'],
      avoids: ['secret', 'guess'],
      requiredTool: 'inspect_workspace',
    }, {
      output: 'Ready — the CAFE\u0301 report is grounded.',
      toolCalls: ['inspect_workspace'],
    });

    assert.lengthOf(scores, 5);
    assert.isTrue(scores.every((score) => score.pass));
    assert.deepEqual(scores.map((score) => score.score), [1, 1, 1, 1, 1]);
  });

  it('runs selected custom/model hooks without losing deterministic evidence', async () => {
    const evaluated = await evaluateAgentRun({
      userId: 'eval-user',
      agentId: 'eval-agent',
      scenario: {
        scenarioId: 'scenario', revision: 3, name: 'Quality', prompt: 'Answer.',
        expected: { contains: ['answer'], avoids: [] },
        scorerIds: ['judge', 'broken'],
      },
      run: { output: 'The answer.', toolCalls: [], durationMs: 4 },
    }, new Map([
      ['judge', {
        id: 'judge', name: 'Judge', kind: 'model' as const,
        evaluate: () => ({ score: 0.82, reason: 'Meets the rubric.' }),
      }],
      ['broken', {
        id: 'broken', name: 'Broken', kind: 'custom' as const,
        evaluate: () => { throw new Error('private scorer failure'); },
      }],
    ]));

    assert.equal(evaluated.status, 'failed');
    assert.deepInclude(evaluated.scores[0], { id: 'contains:0', pass: true, score: 1 });
    assert.deepInclude(evaluated.scores[1], { id: 'judge', pass: true, score: 0.82 });
    assert.deepInclude(evaluated.scores[2], {
      id: 'broken', pass: false, score: 0, reason: 'The scorer could not complete.',
    });
    assert.notInclude(JSON.stringify(evaluated), 'private scorer failure');
  });

  it('bounds a scorer hook and asks cooperative work to stop', async () => {
    let signal: AbortSignal | undefined;
    const started = Date.now();
    const evaluated = await evaluateAgentRun({
      userId: 'eval-user',
      agentId: 'eval-agent',
      scenario: {
        scenarioId: 'scenario', revision: 1, name: 'Bounded', prompt: 'Answer.',
        expected: { contains: [], avoids: [] }, scorerIds: ['slow-judge'],
      },
      run: { output: 'Answer.', toolCalls: [], durationMs: 1 },
    }, new Map([['slow-judge', {
      id: 'slow-judge', name: 'Slow judge', kind: 'model' as const, timeoutMs: 10,
      evaluate: (context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    }]]));

    assert.isBelow(Date.now() - started, 1_000);
    assert.isTrue(signal?.aborted);
    assert.deepInclude(evaluated.scores[0], {
      id: 'slow-judge', pass: false, score: 0, reason: 'The scorer could not complete.',
    });
  });

  it('records proposed tools but executes no tools or identity learning', async function () {
    this.timeout(30_000);
    const { Agent } = await import('../server/agent');
    const { AgentDeltas, AgentMessages, AgentSessions } = await import('../common/collections');
    const {
      AgentConstitutions, AgentExperiences, AgentIdentities, AgentMemoryFrames, AgentPractices,
    } = await import('../server/learning-collections');

    const agentName = 'evaluation-isolation-test';
    const identityId = 'evaluation-isolation-identity';
    await Promise.all([
      AgentSessions.removeAsync({ agent: agentName }),
      AgentIdentities.removeAsync(identityId),
      AgentConstitutions.removeAsync({ agentId: identityId }),
      AgentExperiences.removeAsync({ agentId: identityId }),
      AgentPractices.removeAsync({ agentId: identityId }),
      AgentMemoryFrames.removeAsync({ agentId: identityId }),
    ]);

    let toolRuns = 0;
    let calls = 0;
    let seenSystem = '';
    const provider: Provider = {
      async *stream(request) {
        seenSystem = request.system;
        calls += 1;
        if (calls === 1) {
          yield {
            kind: 'done',
            toolCalls: [{ id: 'danger-1', name: 'dangerous_write', args: { secret: 'omit-me' } }],
            usage: { input: 1, output: 1 },
          };
          return;
        }
        yield { kind: 'text', chunk: 'safe answer' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };
    new Agent(agentName, {
      model: 'mock',
      instructions: 'Answer safely.',
      provider,
      identity: {
        id: identityId,
        constitution: 'This would be durable in a live turn.',
      },
      experience: true,
      practice: { acquire: true },
      memory: true,
      tools: [{
        name: 'dangerous_write',
        description: 'Writes external state.',
        args: { type: 'object', properties: {} },
        run: async () => { toolRuns += 1; return 'wrote'; },
      }],
    });

    const result = await runIsolatedAgentEvaluation(agentName, 'Try the tool.', {
      instructionUserId: 'eval-user',
      fixtures: {
        facts: ['The launch date is Tuesday.'],
        experiences: ['A prior handoff failed without an explicit owner.'],
        practices: ['Name an owner for every handoff.'],
        constitution: 'State uncertainty clearly.',
      },
    });

    assert.equal(result.output, 'safe answer');
    assert.equal(result.model, 'mock');
    assert.equal(result.agentVersion, 'unversioned');
    assert.deepEqual(result.toolCalls, ['dangerous_write']);
    assert.equal(toolRuns, 0, 'evaluation tool dispatch must fail before the implementation');
    assert.notInclude(JSON.stringify(result), 'omit-me', 'tool arguments are not retained');
    assert.include(seenSystem, 'The launch date is Tuesday.');
    assert.include(seenSystem, 'Name an owner for every handoff.');
    assert.equal(await AgentSessions.find({ agent: agentName }).countAsync(), 0);
    assert.equal(await AgentMessages.find({ sessionId: { $regex: '^evaluation-isolation' } } as any).countAsync(), 0);
    assert.equal(await AgentDeltas.find({ sessionId: { $regex: '^evaluation-isolation' } } as any).countAsync(), 0);
    assert.equal(await AgentIdentities.find({ _id: identityId }).countAsync(), 0);
    assert.equal(await AgentConstitutions.find({ agentId: identityId }).countAsync(), 0);
    assert.equal(await AgentExperiences.find({ agentId: identityId }).countAsync(), 0);
    assert.equal(await AgentPractices.find({ agentId: identityId }).countAsync(), 0);
    assert.equal(await AgentMemoryFrames.find({ agentId: identityId }).countAsync(), 0);
  });
});
