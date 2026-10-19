import { assert } from 'chai';
import { Agent } from '../server/agent';
import { AgentMessages, AgentSessions } from '../common/collections';
import { runTurn } from '../server/loop';
import { mockProvider } from '../server/providers/mock';
import type { SubagentTool } from '../server/tools';
import { buildRunConfig, getAgent } from '../server/registry';

let sequence = 0;
async function runEdge(edge: Omit<SubagentTool, 'subagent' | 'description'>, options: {
  childVersion?: string; childTool?: () => Promise<unknown>; childReply?: string;
} = {}) {
  const id = `delegation-policy-${sequence++}`;
  const childName = `${id}-child`;
  let calls = 0;
  const seen: string[] = [];
  new Agent(childName, { version: options.childVersion ?? '1', model: 'mock', instructions: '',
    tools: options.childTool ? [{ name: 'work', description: 'Do work.', args: { type: 'object', properties: {} }, run: options.childTool }] : [],
    provider: mockProvider((request) => {
      calls += 1;
      seen.push(request.messages.map(({ content }) => content ?? '').join('\n'));
      return options.childTool
        ? { toolCalls: [{ id: `work-${calls}`, name: 'work', args: {} }] }
        : { text: options.childReply ?? 'Child result includes internal ticket ID 123.' };
    }) });
  const now = new Date();
  await AgentSessions.insertAsync({ _id: id, agent: 'policy-parent', userId: 'policy-owner',
    phase: 'idle', model: 'mock', nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
  await AgentMessages.insertAsync({ _id: `${id}:user`, sessionId: id, role: 'user', seq: 0,
    content: 'Parent confidential context must not be copied.', createdAt: now });
  await runTurn(id, { model: 'mock', system: '', tools: [{ subagent: childName, description: 'Delegate.', ...edge }],
    provider: mockProvider((request) => request.messages.some(({ role }) => role === 'tool')
      ? { text: 'Parent completed.' }
      : { toolCalls: [{ id: 'delegate', name: edge.name ?? childName, args: { prompt: 'Review the reference.' } }] }) });
  return { id, childName, calls, seen, child: await AgentSessions.findOneAsync({ 'parent.sessionId': id }),
    result: await AgentMessages.findOneAsync({ sessionId: id, role: 'tool' }) };
}

describe('Delegation edge policies', () => {
  it('refuses rejected and failing before hooks before creating a child', async () => {
    const denied = await runEdge({ beforeDelegate: () => false });
    assert.equal(denied.result?.error?.error, 'delegation-rejected');
    assert.isUndefined(denied.child);
    assert.equal(denied.calls, 0);
    const failed = await runEdge({ beforeDelegate: () => { throw new Error('private policy detail'); } });
    assert.equal(failed.result?.error?.error, 'delegation-policy-failed');
    assert.isUndefined(failed.child);
    assert.notInclude(JSON.stringify(failed.result), 'private policy detail');
  });

  it('passes only the delegated prompt through context and result projections', async () => {
    let contextKeys: string[] = [];
    const run = await runEdge({
      context: (context) => { contextKeys = Object.keys(context); return `Filtered task: ${context.prompt}`; },
      beforeDelegate: ({ prompt }) => ({ prompt: `${prompt}\nReturn only verified facts.` }),
      afterDelegate: ({ text }) => ({ model: text!.replace('internal ticket ID 123', 'a verified reference'),
        display: 'Reference reviewed', transcript: 'The specialist reviewed the reference.' }),
    });
    assert.notInclude(contextKeys, 'messages');
    assert.notInclude(run.seen.join('\n'), 'Parent confidential context');
    assert.include(run.seen[0], 'Filtered task: Review the reference.');
    assert.include(run.seen[0], 'Return only verified facts.');
    assert.notInclude(run.result?.content ?? '', 'internal ticket');
    assert.include(run.result?.content ?? '', 'a verified reference');
    assert.equal(run.result?.displayContent, 'Reference reviewed');
    assert.isUndefined((run.result as any)?.auditValue);
  });

  it('fails closed when an agent no longer matches the pinned version', async () => {
    const run = await runEdge({ version: '1' }, { childVersion: '2' });
    assert.equal(run.result?.error?.error, 'subagent-version-changed');
    assert.isUndefined(run.child);
    assert.equal(run.calls, 0);
  });

  it('persists child ceilings and prevents a before hook from enlarging them', async () => {
    let ran = 0;
    const run = await runEdge({ budget: { toolCalls: 1, maxIterations: 4 },
      beforeDelegate: () => ({ budget: { toolCalls: 10, maxIterations: 10 } }),
    }, { childTool: async () => { ran += 1; return 'worked'; } });
    assert.equal(ran, 1);
    assert.equal(run.child?.delegation?.budget?.toolCalls, 1);
    assert.equal(run.child?.delegation?.budget?.maxIterations, 4);
    assert.equal(run.child?.budgetSpent.toolCalls, 1);
  });

  it('refuses completion hooks that throw without exposing their raw error', async () => {
    const run = await runEdge({ afterDelegate: () => { throw new Error('private completion detail'); } });
    assert.equal(run.result?.error?.error, 'delegation-policy-failed');
    assert.notInclude(JSON.stringify(run.result), 'private completion detail');
    assert.isDefined(run.result?.childSessionId);
  });

  it('keeps the stored version pin when a completed child is resumed under a newer definition', async () => {
    const run = await runEdge({ version: '1' });
    assert.isDefined(run.child);
    let modelRan = false;
    new Agent(run.childName, { version: '2', model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => { modelRan = true; return { text: 'must not execute' }; }) });
    await runTurn(run.child!._id, buildRunConfig(getAgent(run.childName)!, 'policy-owner'));
    assert.isFalse(modelRan);
    const child = await AgentSessions.findOneAsync(run.child!._id);
    assert.equal(child?.phase, 'error');
    const note = await AgentMessages.findOneAsync({ sessionId: run.child!._id, kind: 'error' }, { sort: { seq: -1 } });
    assert.equal(note?.error?.error, 'subagent-version-changed');
  });
});
