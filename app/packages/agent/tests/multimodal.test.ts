import { assert } from 'chai';
import type { Provider, ProviderRequest } from '../server/providers/types';

/**
 * Multimodal reads (participants spec §9): the capability gate (fail closed),
 * the read-stamps-collector-hydrates pipeline, the hook's power to drop, and
 * the strip-and-degrade retry.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_B64 = PNG.toString('base64');

const waitFor = async (cond: () => Promise<boolean>, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

const clean = async () => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  const { AgentAttachments } = await import('../server/attachments');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentAttachments.removeAsync({});
};

const seedWithImage = async (sessionId: string, agent: string) => {
  const { AgentSessions } = await import('../common/collections');
  const { AgentAttachments } = await import('../server/attachments');
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  });
  await AgentAttachments.insertAsync({
    _id: 'attImg1', sessionId, name: 'chart.png', contentType: 'image/png',
    size: PNG.length, content: PNG_B64, origin: 'inbound', createdAt: new Date(),
  });
};

describe('multimodal reads', () => {
  it('read_attachment gates on the declared capability, attaches through the collector', async function () {
    this.timeout(20000);
    await clean();
    await seedWithImage('mm0', 'mm-agent');
    const { readTool } = await import('../server/attachments');

    // NO capability (absent or false): the structured refusal, with the reason.
    const refused: any = await readTool.run({ id: 'attImg1' }, {
      userId: 'u1', sessionId: 'mm0',
    } as any);
    assert.isTrue(refused.binary);
    assert.equal(refused.reason, 'unsupported-model', 'the gate fails closed');

    // Capability + collector: attached, and the ref lands in the collector.
    const collected: any[] = [];
    const ok: any = await readTool.run({ id: 'attImg1' }, {
      userId: 'u1', sessionId: 'mm0', imageInput: true,
      attachToResult: (ref: any) => collected.push(ref),
    } as any);
    assert.isTrue(ok.image);
    assert.equal(ok.name, 'chart.png');
    assert.deepEqual(collected, [{
      id: 'attImg1', name: 'chart.png', contentType: 'image/png', size: PNG.length,
    }]);

    // Over the provider ceiling: refused with its own reason.
    const { AgentAttachments } = await import('../server/attachments');
    await AgentAttachments.insertAsync({
      _id: 'attHuge', sessionId: 'mm0', name: 'huge.png', contentType: 'image/png',
      size: 6 * 1024 * 1024, content: PNG_B64, origin: 'inbound', createdAt: new Date(),
    });
    const huge: any = await readTool.run({ id: 'attHuge' }, {
      userId: 'u1', sessionId: 'mm0', imageInput: true, attachToResult: () => {},
    } as any);
    assert.equal(huge.reason, 'too-large');

    // A non-image binary keeps the plain refusal, no reason token.
    await AgentAttachments.insertAsync({
      _id: 'attZip', sessionId: 'mm0', name: 'x.zip', contentType: 'application/zip',
      size: 4, content: PNG_B64, origin: 'inbound', createdAt: new Date(),
    });
    const zip: any = await readTool.run({ id: 'attZip' }, {
      userId: 'u1', sessionId: 'mm0', imageInput: true, attachToResult: () => {},
    } as any);
    assert.isTrue(zip.binary);
    assert.isUndefined(zip.reason);
  });

  it('end to end: the read stamps the tool row and the NEXT request carries the bytes', async function () {
    this.timeout(30000);
    await clean();
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { readTool } = await import('../server/attachments');
    const { sendToSession } = await import('../server/methods');
    const { AgentMessages } = await import('../common/collections');

    let seenImages: any[] | undefined;
    // eslint-disable-next-line no-new
    new Agent('mm-agent', {
      model: 'mock', instructions: '',
      tools: [readTool],
      provider: mockProvider((req) => {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        if (!toolMsg) {
          return { toolCalls: [{ id: 'r1', name: 'read_attachment', args: { id: 'attImg1' } }] };
        }
        seenImages = toolMsg.images;
        return { text: 'I looked at the chart.' };
      }, { imageInput: true }),
    });
    await seedWithImage('mm1', 'mm-agent');

    await sendToSession('mm-agent', 'mm1', 'what does the chart say?', 'u1');
    await waitFor(async () => !!(await AgentMessages.findOneAsync({
      sessionId: 'mm1', role: 'assistant', content: 'I looked at the chart.',
    })), 'the vision turn completing');

    const toolRow = await AgentMessages.findOneAsync({ sessionId: 'mm1', role: 'tool' });
    assert.deepEqual(toolRow!.attachments, [{
      id: 'attImg1', name: 'chart.png', contentType: 'image/png', size: PNG.length,
    }], 'the read stamped its ref on the committed row');
    assert.include(toolRow!.content, 'image', 'the row itself carries text, never bytes');
    assert.notInclude(toolRow!.content, PNG_B64, 'no base64 on rows');

    assert.deepEqual(seenImages, [{ data: PNG_B64, mimeType: 'image/png' }],
      'request-time hydration carried the bytes to the provider');
  });

  it('an afterToolResult hook can DROP the image — nothing rides behind a redaction', async function () {
    this.timeout(30000);
    await clean();
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { readTool } = await import('../server/attachments');
    const { sendToSession } = await import('../server/methods');
    const { AgentMessages } = await import('../common/collections');

    let seenImages: any[] | undefined = [];
    const agent = new Agent('mm-redact', {
      model: 'mock', instructions: '',
      tools: [readTool],
      provider: mockProvider((req) => {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        if (!toolMsg) {
          return { toolCalls: [{ id: 'r1', name: 'read_attachment', args: { id: 'attImg1' } }] };
        }
        seenImages = toolMsg.images;
        return { text: 'done' };
      }, { imageInput: true }),
    });
    agent.hook('afterToolResult', (_result, _call, ctx: any) => {
      // The redaction: drop every collected image.
      ctx.resultAttachments?.splice(0);
    });
    try {
      await seedWithImage('mm2', 'mm-redact');
      await sendToSession('mm-redact', 'mm2', 'look', 'u1');
      await waitFor(async () => !!(await AgentMessages.findOneAsync({
        sessionId: 'mm2', role: 'assistant', content: 'done',
      })), 'the redacted turn completing');

      const toolRow = await AgentMessages.findOneAsync({ sessionId: 'mm2', role: 'tool' });
      assert.isUndefined(toolRow!.attachments, 'the dropped ref never reached the row');
      assert.isUndefined(seenImages, 'and no bytes ever reached the provider');
    } finally {
      agent.clearHooks();
    }
  });

  it('strips images and retries once when the provider rejects them fatally', async function () {
    this.timeout(30000);
    await clean();
    const { Agent } = await import('../server/agent');
    const { readTool } = await import('../server/attachments');
    const { sendToSession } = await import('../server/methods');
    const { AgentMessages } = await import('../common/collections');

    const attempts: Array<{ hadImages: boolean }> = [];
    const provider: Provider = {
      capabilities: { imageInput: () => true },
      async *stream(req: ProviderRequest) {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        if (!toolMsg) {
          yield { kind: 'done', toolCalls: [{ id: 'r1', name: 'read_attachment', args: { id: 'attImg1' } }] };
          return;
        }
        const hadImages = !!toolMsg.images?.length;
        attempts.push({ hadImages });
        if (hadImages) {
          // The pixel-cap shape: a deterministic 400 only when images ride.
          const e: any = new Error('image exceeds maximum dimensions');
          e.status = 400;
          throw e;
        }
        for (const ch of 'answered without the image') yield { kind: 'text', chunk: ch };
        yield { kind: 'done', usage: { input: 1, output: 5 } };
      },
    };
    // eslint-disable-next-line no-new
    new Agent('mm-strip', {
      model: 'mock', instructions: '', tools: [readTool], provider,
      retry: { attempts: 1 },   // no ordinary retries — the strip is its own
    });
    await seedWithImage('mm3', 'mm-strip');

    await sendToSession('mm-strip', 'mm3', 'look', 'u1');
    await waitFor(async () => !!(await AgentMessages.findOneAsync({
      sessionId: 'mm3', role: 'assistant', content: 'answered without the image',
    })), 'the degraded turn completing');

    assert.deepEqual(attempts, [{ hadImages: true }, { hadImages: false }],
      'one rejection, one stripped retry — the session never wedges');
    const errNote = await AgentMessages.findOneAsync({ sessionId: 'mm3', role: 'note', kind: 'error' });
    assert.isUndefined(errNote, 'the degrade is silent recovery, not a failure');
  });

  it('the pi-ai mapping carries image blocks on tool results', async () => {
    const { toPiAiRequest } = await import('../server/providers/piai');
    const req = toPiAiRequest({
      model: 'anthropic/claude-sonnet-5',
      system: 's',
      messages: [
        {
          role: 'assistant', content: '',
          toolCalls: [{ id: 't1', name: 'read_attachment', args: { id: 'x' } }],
        },
        {
          role: 'tool', toolCallId: 't1', content: '{"image":true}',
          images: [{ data: PNG_B64, mimeType: 'image/png' }],
        },
      ],
      tools: [],
    }, 1700000000000);
    const toolResult: any = req.context.messages.find((m: any) => m.role === 'toolResult');
    assert.deepEqual(toolResult.content, [
      { type: 'text', text: '{"image":true}' },
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ]);
  });
});
