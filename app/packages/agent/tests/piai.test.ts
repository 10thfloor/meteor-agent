import { assert } from 'chai';
import { loadPiAi } from '../server/providers/loader';
import {
  createPiAiProvider, piAiProvider, toPiAiRequest, translateEvent,
} from '../server/providers/piai';
import type { ProviderChunk, ProviderRequest } from '../server/providers/types';

const req: ProviderRequest = {
  model: 'anthropic/claude-sonnet-5',
  system: 'be terse',
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant', content: 'hello',
      toolCalls: [{ id: 't1', name: 'look', args: { q: 1 } }],
    },
    { role: 'tool', toolCallId: 't1', content: '{"found":true}' },
  ],
  tools: [{ name: 'look', description: 'd', parameters: { type: 'object', properties: {} } }],
};

describe('pi-ai adapter mapping', () => {
  // Field names below are the ones the Step 1 probe found in pi-ai 0.84.2's
  // `dist/types.d.ts`: `Context { systemPrompt, messages, tools }`, message
  // roles `user` / `assistant` / `toolResult`, tool-call blocks
  // `{ type: 'toolCall', id, name, arguments }`.

  it('splits "<provider>/<model-id>" and maps the system prompt', () => {
    const out = toPiAiRequest(req, 0);
    assert.equal(out.provider, 'anthropic');
    assert.equal(out.modelId, 'claude-sonnet-5');
    assert.equal(out.context.systemPrompt, 'be terse');
  });

  it('splits on the FIRST slash only, so nested model ids survive', () => {
    const out = toPiAiRequest({ ...req, model: 'openrouter/moonshotai/kimi-k2' }, 0);
    assert.equal(out.provider, 'openrouter');
    assert.equal(out.modelId, 'moonshotai/kimi-k2');
  });

  it('rejects a model string with no provider prefix', () => {
    assert.throws(() => toPiAiRequest({ ...req, model: 'claude-sonnet-5' }, 0), /provider/);
  });

  it('maps message roles onto pi-ai\'s Message union', () => {
    const { messages } = toPiAiRequest(req, 0).context;
    assert.deepEqual(messages.map((m: any) => m.role), ['user', 'assistant', 'toolResult']);
    assert.equal((messages[0] as any).content, 'hi');
    assert.deepEqual((messages[1] as any).content, [
      { type: 'text', text: 'hello' },
      { type: 'toolCall', id: 't1', name: 'look', arguments: { q: 1 } },
    ]);
    assert.deepEqual((messages[2] as any).content, [{ type: 'text', text: '{"found":true}' }]);
    assert.equal((messages[2] as any).toolCallId, 't1');
    assert.equal((messages[2] as any).isError, false);
  });

  it('round-trips isError onto pi-ai\'s ToolResultMessage', () => {
    // The transcript's `error` field becomes `ProviderMessage.isError` in the
    // loop's toProviderMessages, and lands here. A tool result the model is not
    // told failed is one it has to infer failure from.
    const { messages } = toPiAiRequest({
      ...req,
      messages: [
        ...req.messages.slice(0, 2),
        { role: 'tool', toolCallId: 't1', content: '{"error":"denied"}', isError: true },
      ],
    }, 0).context;
    assert.equal((messages[2] as any).isError, true);
    // Absent stays false, not undefined: pi-ai's ToolResultMessage requires it.
    assert.equal((toPiAiRequest(req, 0).context.messages[2] as any).isError, false);
  });

  it('recovers toolName for a tool result from the call that produced it', () => {
    // pi-ai's ToolResultMessage requires `toolName`; ProviderMessage has no such
    // field, so it is resolved from the preceding assistant's toolCalls by id.
    const { messages } = toPiAiRequest(req, 0).context;
    assert.equal((messages[2] as any).toolName, 'look');
  });

  it('drops an assistant text block that is empty rather than sending ""', () => {
    const { messages } = toPiAiRequest({
      ...req,
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'look', args: {} }] }],
    }, 0).context;
    assert.deepEqual((messages[0] as any).content, [
      { type: 'toolCall', id: 't1', name: 'look', arguments: {} },
    ]);
  });

  it('maps tool schemas through as { name, description, parameters }', () => {
    const { tools } = toPiAiRequest(req, 0).context;
    assert.deepEqual(tools, [
      { name: 'look', description: 'd', parameters: { type: 'object', properties: {} } },
    ]);
  });

  it('translates text, thinking and tool-argument deltas', () => {
    assert.deepEqual(
      translateEvent({ type: 'text_delta', contentIndex: 0, delta: 'hel' }),
      [{ kind: 'text', chunk: 'hel' }],
    );
    assert.deepEqual(
      translateEvent({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' }),
      [{ kind: 'thinking', chunk: 'hm' }],
    );
    assert.deepEqual(
      translateEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"q":' }),
      [{ kind: 'tool_args', chunk: '{"q":' }],
    );
  });

  it('reads tool calls and usage off the terminal `done` event', () => {
    // Probe finding: the final AssistantMessage carries every content block AND
    // `usage`, so the translator needs no accumulator state of its own.
    const out = translateEvent({
      type: 'done',
      reason: 'toolUse',
      message: {
        content: [
          { type: 'text', text: 'hello there' },
          { type: 'toolCall', id: 't1', name: 'look', arguments: { q: 1 } },
        ],
        usage: {
          input: 29, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 36,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    assert.deepEqual(out, [{
      kind: 'done',
      toolCalls: [{ id: 't1', name: 'look', args: { q: 1 } }],
      usage: { input: 29, output: 7 },
    }]);
  });

  it('emits done with no toolCalls when the message carried none', () => {
    const out: any = translateEvent({
      type: 'done', reason: 'stop',
      message: { content: [{ type: 'text', text: 'hi' }], usage: { input: 1, output: 2 } },
    });
    assert.equal(out[0].kind, 'done');
    assert.isUndefined(out[0].toolCalls);
    assert.deepEqual(out[0].usage, { input: 1, output: 2 });
  });

  it('never emits a chunk kind outside the ProviderChunk union', () => {
    const kinds = new Set(['text', 'thinking', 'tool_args', 'done']);
    const events = [
      { type: 'start' }, { type: 'text_start' }, { type: 'text_end' },
      { type: 'thinking_start' }, { type: 'thinking_end' },
      { type: 'toolcall_start' },
      { type: 'toolcall_end', toolCall: { type: 'toolCall', id: 't1', name: 'look', arguments: {} } },
      { type: 'text_delta', delta: 'x' },
      { type: 'unknown_future_event' },
      {}, null, undefined,
    ];
    for (const ev of events) {
      for (const c of translateEvent(ev as any)) assert.isTrue(kinds.has(c.kind));
    }
  });

  it('maps every non-delta event to zero chunks', () => {
    for (const t of ['start', 'text_start', 'text_end', 'thinking_start',
      'thinking_end', 'toolcall_start', 'toolcall_end', 'error', 'not_a_type']) {
      assert.lengthOf(translateEvent({ type: t } as any), 0, t);
    }
  });
});

describe('pi-ai adapter stream (pi-ai\'s own faux provider, no network)', () => {
  async function fauxModels(script: (piai: any) => unknown[]) {
    const piai: any = await loadPiAi();
    const faux = piai.fauxProvider({
      provider: 'faux', api: 'faux-api', models: [{ id: 'm1' }],
    });
    const models = piai.createModels();
    models.setProvider(faux.provider);
    faux.setResponses(script(piai));
    return models;
  }

  const streamReq: ProviderRequest = {
    model: 'faux/m1', system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }], tools: [],
  };

  it('streams text, thinking, tool args and a terminal done chunk', async function () {
    this.timeout(20000);
    const models = await fauxModels((piai) => [
      piai.fauxAssistantMessage(
        [piai.fauxThinking('hmm'), piai.fauxText('hello there'),
          piai.fauxToolCall('look', { q: 1 }, { id: 't1' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const provider = createPiAiProvider(async () => models as any);
    const chunks: ProviderChunk[] = [];
    for await (const c of provider.stream(streamReq)) chunks.push(c);

    const kinds = chunks.map((c) => c.kind);
    assert.include(kinds, 'thinking');
    assert.include(kinds, 'text');
    assert.include(kinds, 'tool_args');
    assert.equal(kinds[kinds.length - 1], 'done');
    assert.equal(
      chunks.filter((c) => c.kind === 'text').map((c: any) => c.chunk).join(''),
      'hello there',
    );
    const done: any = chunks[chunks.length - 1];
    assert.deepEqual(done.toolCalls, [{ id: 't1', name: 'look', args: { q: 1 } }]);
    assert.isAbove(done.usage.input, 0);
  });

  it('throws on an unknown provider/model instead of streaming nothing', async function () {
    this.timeout(20000);
    const models = await fauxModels((piai) => [piai.fauxAssistantMessage('x')]);
    const provider = createPiAiProvider(async () => models as any);
    let threw: any = null;
    try {
      for await (const _c of provider.stream({ ...streamReq, model: 'faux/nope' })) { /* none */ }
    } catch (e) { threw = e; }
    assert.instanceOf(threw, Error);
    assert.include(String(threw.message), 'faux/nope');
  });

  it('throws when the stream terminates with an error event', async function () {
    this.timeout(20000);
    const models = await fauxModels((piai) => [
      piai.fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'boom' }),
    ]);
    const provider = createPiAiProvider(async () => models as any);
    let threw: any = null;
    try {
      for await (const _c of provider.stream(streamReq)) { /* drain */ }
    } catch (e) { threw = e; }
    assert.instanceOf(threw, Error);
    assert.include(String(threw.message), 'boom');
  });

  it('passes the request signal through to streamSimple\'s options', async function () {
    this.timeout(20000);
    // Probe finding (pi-ai 0.84.2): `Models.streamSimple(model, context,
    // options?: ModelsSimpleStreamOptions)`, and
    // `ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms`
    // -> `SimpleStreamOptions extends StreamOptions`
    // -> `StreamOptions extends ProviderRequestOptions<Model<Api>>`, which
    // declares `signal?: AbortSignal`. That third argument is the ONLY thing
    // that reaches the HTTP request, so an interrupt that does not arrive here
    // cancels nothing.
    const seen: any[] = [];
    const fakeModels = {
      getModel: () => ({ id: 'm1', provider: 'faux', api: 'faux-api' }),
      async *streamSimple(_model: any, _context: any, options: any) {
        seen.push(options);
        yield { type: 'done', reason: 'stop', message: { content: [], usage: { input: 1, output: 1 } } };
      },
    };
    const controller = new AbortController();
    const provider = createPiAiProvider(async () => fakeModels as any);
    for await (const _c of provider.stream({ ...streamReq, signal: controller.signal })) {
      /* drain */
    }
    assert.strictEqual(seen[0]?.signal, controller.signal,
      'the loop\'s per-attempt signal must reach pi-ai, or an abort stops only the reading');
  });

  it('maps pi-ai\'s `aborted` stream error to the abandon hint, not a fatal', async function () {
    this.timeout(20000);
    // An abort is neither transient (retrying re-issues the cancelled request)
    // nor a failure to report at the user (they cancelled it). The loop's
    // 'abandon' classification is the interrupt path, and this hint is what
    // routes an adapter-level abort onto it.
    const fakeModels = {
      getModel: () => ({ id: 'm1', provider: 'faux', api: 'faux-api' }),
      async *streamSimple() {
        yield { type: 'error', reason: 'aborted', error: { errorMessage: 'request aborted' } };
      },
    };
    const provider = createPiAiProvider(async () => fakeModels as any);
    let threw: any = null;
    try {
      for await (const _c of provider.stream(streamReq)) { /* drain */ }
    } catch (e) { threw = e; }
    assert.instanceOf(threw, Error);
    assert.strictEqual(threw.retryable, 'abandon');
  });

  it('marks a transient provider error event retryable via isRetryableAssistantError', async function () {
    this.timeout(20000);
    // '503 Service Unavailable' matches pi-ai's own RETRYABLE_PROVIDER_ERROR_PATTERN
    // (§10's own error taxonomy, reused rather than re-implemented here).
    const models = await fauxModels((piai) => [
      piai.fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 Service Unavailable' }),
    ]);
    const provider = createPiAiProvider(async () => models as any);
    let threw: any = null;
    try {
      for await (const _c of provider.stream(streamReq)) { /* drain */ }
    } catch (e) { threw = e; }
    assert.instanceOf(threw, Error);
    assert.strictEqual(threw.retryable, true, 'a 503 should carry an explicit retryable hint');
  });
});

describe('piAiProvider()', () => {
  it('is a lazy singleton exposing the Provider seam', () => {
    const a = piAiProvider();
    assert.strictEqual(a, piAiProvider());
    assert.isFunction(a.stream);
  });

  it('reaches pi-ai\'s built-in catalog through the loader subpath', async function () {
    this.timeout(20000);
    const all: any = await loadPiAi('providers/all');
    const models = all.builtinModels();
    const model = models.getModel('anthropic', 'claude-sonnet-5');
    assert.isDefined(model);
    assert.equal(model.provider, 'anthropic');
    assert.equal(model.api, 'anthropic-messages');
  });

  it('stamps replayed assistant messages with the live model identity', async () => {
    // pi-ai's transform-messages compares provider/api/model on replayed
    // history against the live model (isSameModel); unstamped, every replayed
    // message looks like it came from a FOREIGN model, and OpenAI Responses
    // rewrites tool-call ids for foreign messages. User and toolResult
    // messages carry no such identity and must stay unstamped.
    const seen: any[] = [];
    const fakeModels = {
      getModel: () => ({ id: 'claude-sonnet-5', provider: 'anthropic', api: 'anthropic-messages' }),
      async *streamSimple(_model: any, context: any) {
        seen.push(context);
        yield {
          type: 'done', reason: 'stop',
          message: { content: [], usage: { input: 1, output: 1 } },
        };
      },
    };
    const provider = createPiAiProvider(async () => fakeModels as any);
    for await (const _c of provider.stream({
      model: 'anthropic/claude-sonnet-5', system: '',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', toolCalls: [{ id: 't1', name: 'x', args: {} }] },
        { role: 'tool', toolCallId: 't1', content: '{}' },
      ],
      tools: [],
    })) { /* drain */ }

    const ctx = seen[0];
    const assistant = ctx.messages.find((m: any) => m.role === 'assistant');
    assert.equal(assistant.provider, 'anthropic');
    assert.equal(assistant.model, 'claude-sonnet-5');
    assert.equal(assistant.api, 'anthropic-messages');
    const user = ctx.messages.find((m: any) => m.role === 'user');
    assert.isUndefined(user.provider, 'only assistant messages are stamped');
    const tool = ctx.messages.find((m: any) => m.role === 'toolResult');
    assert.isUndefined(tool.provider, 'only assistant messages are stamped');
  });
});

// Live smoke: real network, real key. Skipped in CI and in every local run
// without ANTHROPIC_API_KEY, which is the default.
(process.env.ANTHROPIC_API_KEY ? describe : describe.skip)('pi-ai live smoke', () => {
  it('streams one short completion end to end', async function () {
    this.timeout(60000);
    const chunks: any[] = [];
    for await (const c of piAiProvider().stream({
      model: 'anthropic/claude-haiku-4-5', system: 'Answer with one word.',
      messages: [{ role: 'user', content: 'Say hello.' }], tools: [],
    })) chunks.push(c);
    assert.isAbove(chunks.filter((c) => c.kind === 'text').length, 0);
    assert.equal(chunks[chunks.length - 1].kind, 'done');
  });
});
