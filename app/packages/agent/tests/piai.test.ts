import { assert } from 'chai';
import { loadPiAi } from '../server/providers/loader';
import {
  createPiAiProvider, piAiOptionsFromEnv, piAiProvider, toPiAiRequest, translateEvent,
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
    // tool_args alone carries the attribution: text and thinking are one
    // stream each, tool calls are not.
    assert.deepEqual(
      translateEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"q":' }),
      [{ kind: 'tool_args', chunk: '{"q":', contentIndex: 0 }],
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

  it('threads toolcall_delta contentIndex through, and omits it when absent', () => {
    // pi-ai's types.d.ts:426-429 declares contentIndex on every toolcall_*
    // event. It is the only attribution parallel calls have.
    assert.deepEqual(
      translateEvent({ type: 'toolcall_delta', delta: '{"a":1}', contentIndex: 2 }),
      [{ kind: 'tool_args', chunk: '{"a":1}', contentIndex: 2 }],
    );
    assert.deepEqual(
      translateEvent({ type: 'toolcall_delta', delta: '{"a":1}', contentIndex: 0 }),
      [{ kind: 'tool_args', chunk: '{"a":1}', contentIndex: 0 }],
      'index 0 is a real index, not a missing one',
    );
    // A release that drops the field must yield NO index rather than a made-up
    // 0, which would merge parallel calls back together downstream.
    assert.deepEqual(
      translateEvent({ type: 'toolcall_delta', delta: 'x' }),
      [{ kind: 'tool_args', chunk: 'x' }],
    );
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
    const stale = new AbortController();
    // The options seam merges UNDER the signal: cancellation belongs to the
    // loop's per-attempt controller and no configured option may displace it.
    const provider = createPiAiProvider(
      async () => fakeModels as any,
      { ...piAiOptionsFromEnv({ PROVIDER_API_KEY: 'k' }), signal: stale.signal },
    );
    for await (const _c of provider.stream({ ...streamReq, signal: controller.signal })) {
      /* drain */
    }
    assert.strictEqual(seen[0]?.signal, controller.signal,
      'the loop\'s per-attempt signal must reach pi-ai, or an abort stops only the reading');
    assert.equal(seen[0]?.apiKey, 'k', 'configured options must reach streamSimple');
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
    assert.strictEqual((threw as any).retryable, 'abandon');
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
    assert.strictEqual((threw as any).retryable, true, 'a 503 should carry an explicit retryable hint');
  });
});

describe('Anthropic converter request body (injected fetch, no network)', () => {
  // The mapping tests above stop at pi-ai's `Context`. Everything after that —
  // `tool_result` blocks, `is_error`, `input_schema`, the system block — is
  // pi-ai's own Anthropic converter, and a mistake there is invisible until a
  // real request is rejected. `ProviderRequestOptions` (dist/types.d.ts:49-59)
  // makes that reachable offline:
  //
  //     export interface ProviderRequestOptions<TModel = Model<Api>> {
  //         signal?: AbortSignal;
  //         ...
  //         apiKey?: string;
  //         /**
  //          * Optional fetch implementation for provider HTTP requests.
  //          * Defaults to `globalThis.fetch`. ...
  //          */
  //         fetch?: FetchFunction;
  //
  // `ModelsSimpleStreamOptions` extends it (models.d.ts:46), and the Anthropic
  // adapter hands the option straight to the SDK client it constructs
  // (api/anthropic-messages.js:371 -> createClient(..., options?.fetch, ...)),
  // so the injected fetch sees the finished HTTP request. `createPiAiProvider`
  // grew a second `options` argument for exactly this — the loop still passes
  // none.
  //
  // RESPONSE SHAPE: the fake fetch replies 400 with Anthropic's own error JSON.
  // The stream therefore terminates immediately with an `error` event, which
  // the adapter turns into a throw — by design. The assertions are about the
  // captured REQUEST; a hand-rolled SSE success body would add a second thing
  // to get wrong and prove nothing extra. 400 (not 429/5xx) so the SDK's own
  // retry policy does not re-issue the request.

  async function captureBody(request: ProviderRequest) {
    const all: any = await loadPiAi('providers/all');
    const models = all.builtinModels();
    const bodies: any[] = [];
    const fakeFetch = async (_url: any, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'captured by test fetch' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = createPiAiProvider(
      async () => models as any,
      { apiKey: 'test-key', fetch: fakeFetch },
    );
    let threw: any = null;
    try {
      for await (const _c of provider.stream(request)) { /* drain */ }
    } catch (e) { threw = e; }
    return { body: bodies[0], calls: bodies.length, threw };
  }

  const errorTurn: ProviderRequest = {
    model: 'anthropic/claude-sonnet-5',
    system: 'be terse',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 't1', name: 'look', args: { q: 1 } }] },
      { role: 'tool', toolCallId: 't1', content: '{"error":"denied"}', isError: true },
    ],
    tools: [{
      name: 'look',
      description: 'Look something up',
      parameters: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] },
    }],
  };

  it('sends system, an is_error tool_result, and input_schema-shaped tools', async function () {
    this.timeout(30000);
    const { body, calls, threw } = await captureBody(errorTurn);
    assert.equal(calls, 1, 'exactly one HTTP request, not a retry storm');
    assert.instanceOf(threw, Error, 'the 400 terminates the stream as a throw');
    assert.isObject(body, 'no request body was captured');

    assert.equal(body.model, 'claude-sonnet-5');
    assert.isTrue(body.stream);

    // `system` is present and carries the prompt. Anthropic accepts either a
    // string or a block array; pi-ai sends blocks (so it can cache-control it),
    // so assert on the text rather than the container.
    assert.isDefined(body.system, 'system prompt dropped on the floor');
    const systemText = typeof body.system === 'string'
      ? body.system
      : body.system.map((b: any) => b.text).join('');
    assert.equal(systemText, 'be terse');

    // The assistant's tool call becomes a tool_use block...
    assert.deepEqual(body.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    const toolUse = body.messages[1].content.find((b: any) => b.type === 'tool_use');
    assert.deepEqual(
      { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      { id: 't1', name: 'look', input: { q: 1 } },
    );

    // ...and the failed result comes back as a USER-role tool_result block with
    // is_error: true. This is the whole point of threading `isError` through
    // the loop: without it Anthropic is told the tool succeeded and the model
    // has to infer failure from the payload's prose.
    const toolResult = body.messages[2].content.find((b: any) => b.type === 'tool_result');
    assert.isDefined(toolResult, 'no tool_result block in the request');
    assert.equal(toolResult.tool_use_id, 't1');
    assert.isTrue(toolResult.is_error, 'a failed tool result must be flagged is_error');
    assert.include(JSON.stringify(toolResult.content), 'denied');

    // Tools use Anthropic's `name` / `input_schema` spelling, not pi-ai's
    // `name` / `parameters`.
    assert.lengthOf(body.tools, 1);
    assert.equal(body.tools[0].name, 'look');
    assert.equal(body.tools[0].description, 'Look something up');
    assert.isUndefined(body.tools[0].parameters, 'pi-ai\'s spelling must not leak to the wire');
    assert.deepEqual(body.tools[0].input_schema, {
      type: 'object', properties: { q: { type: 'number' } }, required: ['q'],
    });
  });

  it('marks a successful tool result WITHOUT is_error', async function () {
    this.timeout(30000);
    const { body } = await captureBody({
      ...errorTurn,
      messages: [
        ...errorTurn.messages.slice(0, 2),
        { role: 'tool', toolCallId: 't1', content: '{"found":true}' },
      ],
    });
    const toolResult = body.messages[2].content.find((b: any) => b.type === 'tool_result');
    assert.notEqual(toolResult.is_error, true, 'a successful result must not claim failure');
  });

  it('builds a request at all when history contains a replayed assistant message', async function () {
    this.timeout(30000);
    // Regression. pi-ai's `Usage` is REQUIRED on an AssistantMessage and its
    // context estimator dereferences it unguarded (utils/estimate.js:4, reached
    // from api/simple-options.js:6 on the way into every request). A replayed
    // assistant row without one threw
    // "Cannot read properties of undefined (reading 'totalTokens')" before any
    // HTTP call — so every turn after the first died on the real Anthropic
    // path, while the faux-provider tests, which never build request options,
    // stayed green. `toPiAiRequest` now stamps a zero usage.
    const { body, threw } = await captureBody(errorTurn);
    assert.isObject(body, `no request was built: ${threw && threw.message}`);
    assert.notInclude(String(threw && threw.message), 'totalTokens');
    // Zero rather than fabricated: pi-ai ignores a zero-token usage and falls
    // back to its own character estimate, so max_tokens is clamped against an
    // estimate, not against a number this adapter invented.
    const replayed = toPiAiRequest(errorTurn, 0).context.messages[1] as any;
    assert.deepEqual(replayed.usage, {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    assert.isAbove(body.max_tokens, 0);
  });
});

describe('piAiProvider()', () => {
  it('maps PROVIDER_API_KEY to pi-ai\'s explicit apiKey option', () => {
    assert.deepEqual(
      piAiOptionsFromEnv({ PROVIDER_API_KEY: 'one-provider-key' }),
      { apiKey: 'one-provider-key' },
    );
    assert.deepEqual(piAiOptionsFromEnv({}), {});
    assert.deepEqual(piAiOptionsFromEnv({ PROVIDER_API_KEY: '' }), {});
  });

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

describe('parallel tool-call attribution, end to end (faux provider, no network)', () => {
  // M4 Task 1, the half the validator work does not touch: two tool calls
  // streaming at once must reach a consumer as two argument strings, not one
  // interleaved ruin. The chain under test is adapter -> ProviderChunk ->
  // DeltaWriter -> delta document -> mergeView, driven by pi-ai's own faux
  // provider so the contentIndex values are pi-ai's, not the test's.

  async function seedDeltaAuthority(sessionId: string): Promise<void> {
    const { AgentDeltas, AgentSessions } = await import('../common/collections');
    const { claimLease } = await import('../server/lease');
    await AgentDeltas.removeAsync({ sessionId } as any);
    await AgentSessions.removeAsync({ _id: sessionId } as any);
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'piai-delta-test', userId: 'u1', phase: 'streaming', model: 'mock',
      nextSeq: 4, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    assert.isTrue(await claimLease(sessionId));
  }

  async function streamTwoCalls(): Promise<ProviderChunk[]> {
    const piai: any = await loadPiAi();
    // Faux defaults: how many deltas each call's arguments are cut into is the
    // provider's business and varies run to run, which is precisely why the
    // assertions below key on contentIndex rather than on fragment counts.
    const faux = piai.fauxProvider({
      provider: 'faux', api: 'faux-api', models: [{ id: 'm1' }],
    });
    const models = piai.createModels();
    models.setProvider(faux.provider);
    faux.setResponses([piai.fauxAssistantMessage([
      piai.fauxToolCall('weather', { city: 'Paris' }, { id: 't1' }),
      piai.fauxToolCall('quote', { stock: 'ACME' }, { id: 't2' }),
    ], { stopReason: 'toolUse' })]);
    const provider = createPiAiProvider(async () => models as any);
    const chunks: ProviderChunk[] = [];
    for await (const c of provider.stream({
      model: 'faux/m1', system: 'be terse',
      messages: [{ role: 'user', content: 'both please' }], tools: [],
    })) chunks.push(c);
    return chunks;
  }

  it('tags each tool_args chunk with the calls\'s own contentIndex', async function () {
    this.timeout(20000);
    const chunks = await streamTwoCalls();
    const args = chunks.filter((c) => c.kind === 'tool_args') as any[];
    assert.isAtLeast(args.length, 2, 'both calls must have streamed their arguments');
    const indexes = new Set(args.map((c) => c.contentIndex));
    assert.deepEqual([...indexes].sort(), [0, 1], 'two calls, two indexes');
    // Reassembling by index recovers both calls' arguments verbatim.
    const byIndex: Record<number, string> = {};
    for (const c of args) byIndex[c.contentIndex] = (byIndex[c.contentIndex] ?? '') + c.chunk;
    assert.deepEqual(JSON.parse(byIndex[0]), { city: 'Paris' });
    assert.deepEqual(JSON.parse(byIndex[1]), { stock: 'ACME' });
    // And the terminal done chunk still carries both parsed calls.
    const done: any = chunks[chunks.length - 1];
    assert.deepEqual(done.toolCalls.map((t: any) => t.id), ['t1', 't2']);
  });

  it('survives DeltaWriter and mergeView as two separate argument streams', async function () {
    this.timeout(20000);
    const { DeltaWriter } = await import('../server/loop');
    const { AgentDeltas } = await import('../common/collections');
    const { mergeView } = await import('../common/merge');
    const sessionId = 's-attribution';
    const messageId = 'm-attribution';
    await seedDeltaAuthority(sessionId);

    const chunks = await streamTwoCalls();
    const writer = new DeltaWriter(sessionId, messageId, 3, 10_000);
    // INTERLEAVED on purpose: a real provider alternates between the two
    // blocks, and the faux one emits them in order. Feeding them alternately
    // is what proves the coalescing key includes contentIndex rather than
    // relying on arrival order.
    const args = chunks.filter((c) => c.kind === 'tool_args') as any[];
    const first = args.filter((c) => c.contentIndex === 0);
    const second = args.filter((c) => c.contentIndex === 1);
    for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
      if (first[i]) writer.push('tool_args', first[i].chunk, first[i].contentIndex);
      if (second[i]) writer.push('tool_args', second[i].chunk, second[i].contentIndex);
    }
    await writer.stop();

    const docs = await AgentDeltas.find({ sessionId } as any).fetchAsync();
    assert.isAtLeast(docs.length, 2, 'the two calls must occupy at least one run each');
    for (const d of docs) assert.isNumber((d as any).contentIndex, 'the doc must record the index');
    // No document may mix the two calls: that is the corruption this whole
    // chain exists to prevent, and it survives every fragment layout the faux
    // provider happens to choose.
    assert.deepEqual(
      [...new Set(docs.map((d: any) => d.contentIndex))].sort(), [0, 1],
    );
    // Contiguous seq from 0 — mergeView's backward walk depends on it.
    const seqs = docs.map((d) => d.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i));

    const view = mergeView([], docs as any);
    assert.lengthOf(view, 1);
    assert.deepEqual(JSON.parse(view[0].toolArgs![0]), { city: 'Paris' });
    assert.deepEqual(JSON.parse(view[0].toolArgs![1]), { stock: 'ACME' });
    await AgentDeltas.removeAsync({ sessionId } as any);
  });

  it('coalesces a tool_args run only within one contentIndex', async function () {
    this.timeout(20000);
    const { DeltaWriter } = await import('../server/loop');
    const { AgentDeltas } = await import('../common/collections');
    const sessionId = 's-coalesce';
    await seedDeltaAuthority(sessionId);

    const writer = new DeltaWriter(sessionId, 'm-coalesce', 0, 10_000);
    writer.push('tool_args', '{"a":', 0);
    writer.push('tool_args', '1}', 0);       // same index: coalesces
    writer.push('tool_args', '{"b":', 1);    // different index: new run
    writer.push('tool_args', '2}', 1);
    writer.push('tool_args', '{"c":', 0);    // back to 0: new run, not a merge
    // A different kind never coalesces — and a contentIndex on a non-tool_args
    // chunk is DROPPED: the field is meaningful only where `mergeView`
    // accumulates per index, and a stray one (a third-party provider stamping
    // it on text) would split one text run into two coalescing buckets for no
    // reader's benefit.
    writer.push('text', 'and', 0);
    await writer.stop();

    const docs = (await AgentDeltas.find({ sessionId } as any).fetchAsync())
      .sort((a, b) => a.seq - b.seq) as any[];
    assert.deepEqual(
      docs.map((d) => [d.kind, d.contentIndex, d.chunk]),
      [
        ['tool_args', 0, '{"a":1}'],
        ['tool_args', 1, '{"b":2}'],
        ['tool_args', 0, '{"c":'],
        ['text', undefined, 'and'],
      ],
    );
    assert.deepEqual(docs.map((d) => d.seq), [0, 1, 2, 3], 'seq stays contiguous');
    await AgentDeltas.removeAsync({ sessionId } as any);
  });
});
