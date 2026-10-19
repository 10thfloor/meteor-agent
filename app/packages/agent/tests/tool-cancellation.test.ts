import { assert } from 'chai';
import { AgentMessages, AgentSessions } from '../common/collections';
import { beginToolCancellation } from '../server/tool-cancellation';
import { SERVER_ID } from '../server/lease';
import { dispatchCalls, resumeParkedTurn } from '../server/dispatch';
import { runTool, type ResolvedTool } from '../server/tools';

let nextId = 0;
const ids: string[] = [];
async function seed(parentId?: string): Promise<string> {
  const id = `tool-cancellation-${nextId++}`;
  ids.push(id);
  await AgentSessions.insertAsync({ _id: id, agent: 'cancellation-agent', userId: 'cancellation-owner',
    phase: 'calling', model: 'mock', nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 }, lease: { serverId: SERVER_ID, until: new Date(Date.now() + 30_000) },
    ...(parentId ? { parent: { sessionId: parentId, toolCallId: 'parent-call' } } : {}),
    createdAt: new Date(), updatedAt: new Date() } as any);
  return id;
}
async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const done = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); reject(new Error('Cancellation did not arrive.')); }, 2000);
    signal.addEventListener('abort', done, { once: true });
  });
}

describe('inline tool execution cancellation', () => {
  afterEach(async () => {
    await AgentMessages.removeAsync({ sessionId: { $in: ids } });
    await AgentSessions.removeAsync({ _id: { $in: ids } });
    ids.length = 0;
  });

  for (const [label, update] of [
    ['Stop', { $set: { phase: 'stopped' } }],
    ['erasure', { $set: { erasingAt: new Date() } }],
    ['purge', { $set: { purgingAt: new Date() } }],
    ['lease loss', { $set: { 'lease.serverId': 'another-worker' } }],
    ['lease expiry', { $set: { 'lease.until': new Date(0) } }],
    ['lease removal', { $unset: { lease: 1 } }],
  ] as const) {
    it(`aborts running work after ${label}`, async () => {
      const id = await seed();
      const cancellation = await beginToolCancellation(id, 5);
      try {
        assert.isFalse(cancellation.signal.aborted);
        await AgentSessions.updateAsync(id, update as any);
        await waitForAbort(cancellation.signal);
      } finally { await cancellation.close(); }
    });
  }

  it('cancels on root erasure before a descendant is fenced', async () => {
    const rootId = await seed();
    const childId = await seed(rootId);
    const cancellation = await beginToolCancellation(childId, 5);
    try {
      await AgentSessions.updateAsync(rootId, { $set: { erasingAt: new Date() } });
      await waitForAbort(cancellation.signal);
      assert.isUndefined((await AgentSessions.findOneAsync(childId))?.erasingAt);
    } finally { await cancellation.close(); }
  });

  it('cancels when the session disappears during work', async () => {
    const id = await seed();
    const cancellation = await beginToolCancellation(id, 5);
    try {
      await AgentSessions.removeAsync(id);
      await waitForAbort(cancellation.signal);
    } finally { await cancellation.close(); }
  });

  it('cancels when a lease expires without another database update', async () => {
    const id = await seed();
    await AgentSessions.updateAsync(id, { $set: { 'lease.until': new Date(Date.now() + 40) } });
    const cancellation = await beginToolCancellation(id, 5);
    try { await waitForAbort(cancellation.signal); }
    finally { await cancellation.close(); }
  });

  it('fails closed if ongoing authority cannot be read', async () => {
    const id = await seed();
    const cancellation = await beginToolCancellation(id, 5);
    const find = AgentSessions.find;
    try {
      (AgentSessions as any).find = () => { throw new Error('Injected authority read failure.'); };
      await waitForAbort(cancellation.signal);
    } finally {
      (AgentSessions as any).find = find;
      await cancellation.close();
    }
  });

  it('remembers Stop even if another request already changed the phase', async () => {
    const id = await seed();
    const cancellation = await beginToolCancellation(id, 5);
    try {
      await AgentSessions.updateAsync(id, { $set: { stoppedAt: new Date(), phase: 'calling' } });
      await waitForAbort(cancellation.signal);
    } finally { await cancellation.close(); }
  });

  it('starts already aborted for a missing or already stopped session', async () => {
    const id = await seed();
    await AgentSessions.updateAsync(id, { $set: { phase: 'stopped' } });
    for (const target of [id, 'tool-cancellation-missing']) {
      const cancellation = await beginToolCancellation(target, 5);
      assert.isTrue(cancellation.signal.aborted);
      await cancellation.close();
    }
  });

  it('stops monitoring when the tool finishes', async () => {
    const id = await seed();
    const cancellation = await beginToolCancellation(id, 5);
    await cancellation.close();
    await AgentSessions.updateAsync(id, { $set: { phase: 'stopped' } });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.isFalse(cancellation.signal.aborted);
  });

  it('refuses an already aborted direct inline call', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const result = await runTool({ kind: 'inline', name: 'work', description: 'Work.', args: {}, gate: 'auto',
      async run() { ran = true; } }, {}, { sessionId: 'unused', userId: null, signal: controller.signal });
    assert.isFalse(result.ok);
    assert.isFalse(ran);
  });

  for (const resumed of [false, true]) {
    it(`passes cancellation through ${resumed ? 'approved-resume' : 'ordinary'} dispatch`, async function () {
      this.timeout(5000);
      const id = await seed();
      const call = { id: 'work-call', name: 'work', args: {} };
      const messageId = `${id}:assistant`;
      await AgentMessages.insertAsync({ _id: messageId, sessionId: id, seq: 0, role: 'assistant', content: '',
        toolCalls: [call], createdAt: new Date() });
      let received: AbortSignal | undefined;
      const tool: ResolvedTool = { kind: 'inline', name: 'work', description: 'Work.', args: {}, gate: 'auto',
        async run(_args, context) {
          received = context.signal;
          assert.isDefined(received);
          await AgentSessions.updateAsync(id, { $set: { phase: 'stopped', stoppedAt: new Date() } });
          await waitForAbort(received!);
          return 'cancelled';
        } };
      const limits = { maxResultChars: 1000 };
      if (resumed) {
        await resumeParkedTurn(id, { toolCallId: call.id, name: call.name, args: {}, verdict: 'approved' } as any,
          [tool], 'cancellation-owner', 'cancellation-agent', undefined, limits, async () => {});
      } else {
        await dispatchCalls(id, [call], [tool], { userId: 'cancellation-owner', agent: 'cancellation-agent',
          messageId, assistantSeq: 0, batchIds: [call.id] }, undefined, limits, async () => {});
      }
      assert.isTrue(received?.aborted);
      assert.equal((await AgentSessions.findOneAsync(id))?.phase, 'stopped');
    });
  }
});
