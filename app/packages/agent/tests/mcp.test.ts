import { assert } from 'chai';
import { Agent } from '../server/agent';
import type { AgentMessage } from '../common/types';
import type {
  McpCallResult, McpClient, McpClientFactory, McpToolInfo,
} from '../server/mcp/client';

/**
 * MCP tools, tested WITHOUT the SDK and WITHOUT a network.
 *
 * Everything below drives an in-process fake that implements the `McpClient`
 * interface — `listTools`/`callTool`/`close`, the three methods probed off
 * `@modelcontextprotocol/sdk`'s `dist/esm/client/index.d.ts` — injected through
 * `_setMcpClientFactory`, the same seam shape as `_setBackoff` and
 * `setTypeboxValueLoader`. No subprocess is spawned, so the suite stays as fast
 * and as hermetic as it was.
 *
 * The loader tests at the bottom DO touch the installed SDK (reading its
 * `exports` map and importing two namespaces), which is filesystem work, not
 * network work. The one genuinely live test needs `MCP_LIVE_TEST=1`.
 */

/** A scripted fake server. `onList`/`onCall` may throw or reject to model a
 *  server that is down or a call that breaks the transport. */
interface Script {
  tools?: McpToolInfo[];
  onList?: () => void;
  onCall?: (name: string, args: Record<string, unknown> | undefined) => McpCallResult;
}

interface Fake {
  factory: McpClientFactory;
  /** One entry per CONNECT attempt — the assertion that a failure was not
   *  cached is "this got longer". */
  connects: string[];
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  closed: number;
}

function fakeServer(script: Script): Fake {
  const fake: Fake = {
    connects: [], calls: [], closed: 0, factory: null as any,
  };
  fake.factory = async (name) => {
    fake.connects.push(name);
    const client: McpClient = {
      async listTools() {
        if (script.onList) script.onList();
        return { tools: script.tools ?? [] };
      },
      async callTool(params) {
        fake.calls.push(params);
        if (!script.onCall) return { content: [{ type: 'text', text: 'ok' }] };
        return script.onCall(params.name, params.arguments);
      },
      async close() { fake.closed += 1; },
    };
    return client;
  };
  return fake;
}

const SEARCH: McpToolInfo = {
  name: 'search',
  description: 'Search the documentation',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  },
};

const FETCH: McpToolInfo = {
  name: 'fetch',
  description: 'Fetch one document',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
};

/** Resolve + expand in one step, which is exactly what `runTurn` does. */
async function build(specs: any[]) {
  const { resolveTools, expandMcpTools } = await import('../server/tools');
  return expandMcpTools(resolveTools(specs));
}

/** Deferred work (the resume a verdict schedules) exposes no promise to await,
 *  so every wait here is bounded and fails loudly rather than hanging. Same
 *  helper the loop and fork suites use. */
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

/** A session `runTurn` can start from, scoped to its own id. */
const seed = async (sessionId: string, text: string, agent = 'mcp-test') => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({ _id: sessionId } as any);
  await AgentMessages.removeAsync({ sessionId });
  await AgentDeltas.removeAsync({ sessionId });
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await AgentMessages.insertAsync({
    _id: `${sessionId}-u`, sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

/** One tool-calling turn against the scripted provider. */
async function runOneToolTurn(
  sessionId: string, tools: any[], call: { name: string; args: unknown }, extra: any = {},
) {
  const { mockProvider } = await import('../server/providers/mock');
  const { runTurn } = await import('../server/loop');
  let n = 0;
  const provider = mockProvider(() => {
    n += 1;
    return n === 1
      ? { toolCalls: [{ id: 'c1', name: call.name, args: call.args }] }
      : { text: 'done' };
  });
  await seed(sessionId, 'go');
  await runTurn(sessionId, {
    model: 'mock', system: '', tools, provider, ...extra,
  });
  const { AgentMessages, AgentSessions } = await import('../common/collections');
  return {
    msgs: await AgentMessages.find({ sessionId }, { sort: { seq: 1 } })
      .fetchAsync() as AgentMessage[],
    session: await AgentSessions.findOneAsync(sessionId),
  };
}

describe('MCP tool specs', () => {
  after(async () => {
    const { stopMcp } = await import('../server/mcp/client');
    await stopMcp();
  });

  it('takes description and args from the DISCOVERED tool metadata', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-defaults', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const [tool] = await build([{ mcp: { server: 't-defaults', tool: 'search' } }]);
      assert.equal(tool.name, 'search');
      assert.equal(tool.kind, 'mcp');
      assert.equal(tool.description, 'Search the documentation');
      assert.deepEqual(tool.args as any, SEARCH.inputSchema as any);
      // Lazy: the connection happened at expansion, not at registration, and
      // exactly once.
      assert.deepEqual(fake.connects, ['t-defaults']);
    } finally { restore(); }
  });

  it('lets an explicit description and args override discovery', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-override', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const mine = { type: 'object', properties: { query: { type: 'string' } } };
      const [tool] = await build([{
        mcp: { server: 't-override', tool: 'search' },
        name: 'docs_search',
        description: 'Our words, not theirs',
        args: mine,
      }]);
      assert.equal(tool.name, 'docs_search');
      assert.equal(tool.description, 'Our words, not theirs');
      assert.deepEqual(tool.args as any, mine);
    } finally { restore(); }
  });

  it('expands a whole-server spec into every discovered tool, gate and all', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-all', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH, FETCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const tools = await build([
        { name: 'local', description: 'inline', args: { type: 'object' }, run: async () => 1 },
        { mcp: { server: 't-all' }, gate: 'ask' },
      ]);
      assert.deepEqual(tools.map((t) => t.name), ['local', 'search', 'fetch']);
      assert.deepEqual(tools.map((t) => t.gate), ['auto', 'ask', 'ask']);
      assert.equal(tools[2].description, 'Fetch one document');
      assert.deepEqual(tools[1].mcp, { server: 't-all', tool: 'search' });
      // One connection for the server, not one per tool.
      assert.lengthOf(fake.connects, 1);
    } finally { restore(); }
  });

  it('refuses a whole-server spec that also names a single tool or schema', async () => {
    const { resolveTools } = await import('../server/tools');
    assert.throws(() => resolveTools([{ mcp: { server: 'x' }, name: 'nope' } as any]), /whole-server/);
    assert.throws(
      () => resolveTools([{ mcp: { server: 'x' }, args: { type: 'object' } } as any]),
      /whole-server/,
    );
    assert.throws(() => resolveTools([{ mcp: { server: '' } } as any]), /mcp.server/);
    assert.throws(
      () => resolveTools([{ mcp: { server: 'x' }, run: async () => 1 } as any]),
      /more than one/,
    );
  });

  it('round trips a call: text concatenates, non-text is noted', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool } = await import('../server/tools');
    Agent.mcpServer('t-call', { command: 'never-spawned' });
    const fake = fakeServer({
      tools: [SEARCH],
      onCall: () => ({
        content: [
          { type: 'text', text: 'first hit' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'second hit' },
        ],
      }),
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const [tool] = await build([{ mcp: { server: 't-call', tool: 'search' } }]);
      const result = await runTool(tool, { q: 'leases' }, { userId: 'u1', sessionId: 's-mcp' });
      assert.isTrue(result.ok, JSON.stringify(result.error));
      assert.equal(result.value, 'first hit\n[image content omitted]\nsecond hit');
      assert.deepEqual(fake.calls, [{ name: 'search', arguments: { q: 'leases' } }]);
    } finally { restore(); }
  });

  it('checks the model arguments against the discovered schema before calling', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool } = await import('../server/tools');
    Agent.mcpServer('t-args', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const [tool] = await build([{ mcp: { server: 't-args', tool: 'search' } }]);
      const result = await runTool(tool, { }, { userId: 'u1', sessionId: 's-mcp' });
      assert.isFalse(result.ok);
      assert.equal(result.error?.error, 'invalid-args');
      assert.include(result.error?.reason, 'q');
      assert.lengthOf(fake.calls, 0, 'a bad call never reaches the server');
    } finally { restore(); }
  });

  it('sanitizes an isError result — a secret in the server text does not survive', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool } = await import('../server/tools');
    Agent.mcpServer('t-error', { command: 'never-spawned' });
    const leak = 'sk-live-SECRETVALUE0123456789abcdef';
    const fake = fakeServer({
      tools: [SEARCH],
      onCall: () => ({
        isError: true,
        content: [{
          type: 'text',
          text: `Error: auth failed for ${leak}\n    at Object.run (/srv/docs/index.js:41:9)`,
        }],
      }),
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const [tool] = await build([{ mcp: { server: 't-error', tool: 'search' } }]);
      const result = await runTool(tool, { q: 'x' }, { userId: 'u1', sessionId: 's-mcp' });
      assert.isFalse(result.ok);
      assert.equal(result.error?.error, 'mcp-tool-failed');
      assert.equal(result.error?.reason, 'The MCP tool reported an error.');
      assert.notInclude(JSON.stringify(result), 'SECRET');
      assert.notInclude(JSON.stringify(result), 'index.js');
    } finally { restore(); }
  });

  it('keeps a plain isError sentence, and clamps a long one', async () => {
    const { sanitizeMcpReason } = await import('../server/mcp/client');
    assert.equal(sanitizeMcpReason('Error: no such document'), 'no such document');
    assert.equal(sanitizeMcpReason('the query\n  was empty'), 'the query was empty');
    assert.lengthOf(sanitizeMcpReason('word '.repeat(200)), 200);
    // The rules that force the generic answer.
    assert.equal(sanitizeMcpReason('see https://internal.example.com/a/b?token=abc'),
      'The MCP tool reported an error.');
    assert.equal(sanitizeMcpReason('failed in /Users/someone/keys/prod.json'),
      'The MCP tool reported an error.');
    assert.equal(sanitizeMcpReason('account person@example.com was refused'),
      'The MCP tool reported an error.');
    assert.equal(sanitizeMcpReason('upstream 10.20.30.40 did not answer'),
      'The MCP tool reported an error.');
    assert.equal(sanitizeMcpReason('call +1 (555) 867-5309'),
      'The MCP tool reported an error.');
    assert.equal(sanitizeMcpReason(undefined), 'The MCP tool reported an error.');
  });

  it('answers mcp-unavailable when the server is down, and RETRIES on the next use', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool } = await import('../server/tools');
    // `cooldownMs: 0` disables the failure cooldown for this server, which is
    // what makes this the pin for "a failure is never cached as a VERDICT": with
    // no cooldown in the way, every single use reconnects and recovery is
    // instant. The cooldown's own behaviour is pinned by the two tests below.
    Agent.mcpServer('t-flaky', { command: 'never-spawned', cooldownMs: 0 });
    let up = false;
    const fake = fakeServer({
      tools: [SEARCH],
      onList: () => { if (!up) throw new Error('spawn ENOENT'); },
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      // Down: the named tool still exists (with a fallback description), and
      // calling it is a structured result, not a throw.
      const [down] = await build([{ mcp: { server: 't-flaky', tool: 'search' } }]);
      assert.include(down.description, 'could not be loaded');
      const failed = await runTool(down, { q: 'x' }, { userId: 'u1', sessionId: 's-mcp' });
      assert.isFalse(failed.ok);
      assert.equal(failed.error?.error, 'mcp-unavailable');
      assert.include(failed.error?.reason, 't-flaky');

      // The failure was NOT cached: every use reconnects while it is down…
      assert.isAbove(fake.connects.length, 1);
      const before = fake.connects.length;

      // …and the moment the server comes back, the very next use works.
      up = true;
      const [tool] = await build([{ mcp: { server: 't-flaky', tool: 'search' } }]);
      assert.equal(tool.description, 'Search the documentation');
      const ok = await runTool(tool, { q: 'x' }, { userId: 'u1', sessionId: 's-mcp' });
      assert.isTrue(ok.ok, JSON.stringify(ok.error));
      assert.isAbove(fake.connects.length, before);
    } finally { restore(); }
  });

  it('drops a whole-server spec whose server is down, and answers for an unknown server', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool, resolveTools } = await import('../server/tools');
    Agent.mcpServer('t-gone', { command: 'never-spawned' });
    const fake = fakeServer({ onList: () => { throw new Error('spawn ENOENT'); } });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      // Nothing to name, so nothing is offered this turn — but the inline tool
      // beside it is untouched.
      const tools = await build([
        { name: 'local', description: 'inline', args: { type: 'object' }, run: async () => 1 },
        { mcp: { server: 't-gone' } },
      ]);
      assert.deepEqual(tools.map((t) => t.name), ['local']);

      // A server nobody registered is the same shape of answer.
      const [unknown] = resolveTools([{ mcp: { server: 't-never', tool: 'x' } } as any]);
      const result = await runTool(unknown, {}, { userId: 'u1', sessionId: 's-mcp' });
      assert.isFalse(result.ok);
      assert.equal(result.error?.error, 'mcp-unavailable');
      assert.include(result.error?.reason, 'No MCP server named');
    } finally { restore(); }
  });

  it('parks an ask-gated MCP tool exactly like an inline one', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-gate', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      // The RAW spec, so the loop does its own `expandMcpTools` — this is the
      // integration point, and a test that pre-expanded would skip it.
      const { session } = await runOneToolTurn(
        's-mcp-gate', [{ mcp: { server: 't-gate' }, gate: 'ask' }],
        { name: 'search', args: { q: 'x' } },
      );
      assert.equal(session?.phase, 'awaiting');
      assert.equal(session?.pending?.name, 'search');
      assert.lengthOf(fake.calls, 0, 'a parked call has not run');
    } finally { restore(); }
  });

  it('applies canUse to an MCP tool before it is dispatched', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-canuse', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const { msgs } = await runOneToolTurn(
        's-mcp-canuse', [{ mcp: { server: 't-canuse', tool: 'search' } }],
        { name: 'search', args: { q: 'x' } },
        { canUse: (name: string) => name !== 'search' },
      );
      const toolRow = msgs.find((m) => m.role === 'tool');
      assert.equal((toolRow as any)?.error?.error, 'not-allowed');
      assert.lengthOf(fake.calls, 0, 'a forbidden tool never reaches the server');
    } finally { restore(); }
  });

  it('records an MCP result on the tool row of a real turn', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-turn', { command: 'never-spawned' });
    const fake = fakeServer({
      tools: [SEARCH],
      onCall: () => ({ content: [{ type: 'text', text: 'the answer' }] }),
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const { msgs, session } = await runOneToolTurn(
        's-mcp-turn', [{ mcp: { server: 't-turn', tool: 'search' } }],
        { name: 'search', args: { q: 'x' } },
      );
      const toolRow = msgs.find((m) => m.role === 'tool');
      assert.include(toolRow?.content ?? '', 'the answer');
      assert.isUndefined((toolRow as any)?.error);
      assert.equal(session?.budgetSpent?.toolCalls, 1);
    } finally { restore(); }
  });

  it('a failed open starts a COOLDOWN: the next use does not re-spawn until it expires', async () => {
    const { _setMcpClientFactory, discoverMcpTools } = await import('../server/mcp/client');
    // A tiny window rather than a clock seam: the behaviour under test is
    // "suppressed, then it expires on its own", and 60ms exercises both halves
    // without a fake timer that would have to be trusted separately.
    Agent.mcpServer('t-cooldown', { command: 'never-spawned', cooldownMs: 60 });
    let up = false;
    const fake = fakeServer({
      tools: [SEARCH],
      onList: () => { if (!up) throw new Error('spawn ENOENT'); },
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const first = await discoverMcpTools('t-cooldown');
      assert.isFalse(first.ok);
      assert.equal(fake.connects.length, 1);

      // WITHIN the window: the same structured answer, and no second spawn.
      // This is the whole point — a dead server must not cost a subprocess and
      // a deadline on every tool call.
      const second = await discoverMcpTools('t-cooldown');
      assert.isFalse(second.ok);
      assert.equal((second as any).reason, (first as any).reason);
      assert.equal(fake.connects.length, 1, 'the factory must not be invoked during the cooldown');

      // AFTER it: the cooldown expires by itself, with no successful connect
      // needed to clear it. That is the difference from a poisoned cache.
      await new Promise((r) => { setTimeout(r, 80); });
      up = true;
      const third = await discoverMcpTools('t-cooldown');
      assert.isTrue(third.ok, (third as any).reason);
      assert.equal(fake.connects.length, 2);

      // A success clears the cooldown outright, so the catalog is live again.
      assert.deepEqual((third as any).tools.map((t: McpToolInfo) => t.name), ['search']);
    } finally { restore(); }
  });

  it('deadlines a connect that never answers instead of waiting on the SDK default', async () => {
    const { _setMcpClientFactory, discoverMcpTools } = await import('../server/mcp/client');
    // 80ms stands in for the 15s default. The assertion is that the budget is
    // OBSERVED at all — an unbounded await here would hang the suite, which is
    // exactly the production failure (the SDK's own default is 60s per request,
    // paid per server, on a turn a user is watching).
    Agent.mcpServer('t-hang', { command: 'never-spawned', timeoutMs: 80, cooldownMs: 0 });
    // Never resolves and never rejects: the connect that hangs forever.
    const hangs: McpClientFactory = () => new Promise<McpClient>(() => {});
    const restore = _setMcpClientFactory(hangs);
    try {
      const started = Date.now();
      const found = await discoverMcpTools('t-hang');
      const elapsed = Date.now() - started;
      assert.isFalse(found.ok);
      assert.include((found as any).reason, 't-hang');
      assert.include((found as any).reason, 'did not connect');
      assert.isBelow(elapsed, 5000, 'the deadline must fire, not the SDK default');
    } finally { restore(); }
  });

  it('resumes an approved WHOLE-SERVER MCP tool and records its result', async function () {
    this.timeout(30000);
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    Agent.mcpServer('t-resume', { command: 'never-spawned' });
    const fake = fakeServer({
      tools: [SEARCH],
      onCall: () => ({ content: [{ type: 'text', text: 'RESUMED-ANSWER' }] }),
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      // The whole-server form specifically: its tool NAMES come from discovery,
      // so it is the shape whose resume has nothing to match against if the
      // server is unreachable. The registry config is load-bearing — approve
      // resumes through `getAgent`, not through the config this test passed to
      // `runTurn`.
      const specs = [{ mcp: { server: 't-resume' }, gate: 'ask' }];
      let n = 0;
      const provider = mockProvider(() => {
        n += 1;
        return n === 1
          ? { toolCalls: [{ id: 'g1', name: 'search', args: { q: 'leases' } }] }
          : { text: 'all done' };
      });
      new Agent('mcp-resume', {
        model: 'mock', instructions: '', tools: specs, provider,
      } as any);
      await seed('s-mcp-resume', 'go', 'mcp-resume');
      await runTurn('s-mcp-resume', {
        model: 'mock', system: '', tools: specs as any, provider,
      });

      const parked = (await AgentSessions.findOneAsync('s-mcp-resume'))!;
      assert.equal(parked.phase, 'awaiting');
      assert.equal(parked.pending?.name, 'search');
      assert.equal((parked.pending as any)?.mcpServer, 't-resume',
        'the park records which MCP server the call came from');
      assert.lengthOf(fake.calls, 0, 'a parked call has not run');

      const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
      await approve.call({ userId: 'u1' }, 'mcp-resume', 's-mcp-resume');

      await waitFor(
        async () => (await AgentMessages
          .find({ sessionId: 's-mcp-resume', role: 'assistant' }).countAsync()) === 2,
        'the resumed turn to close the batch and reply',
      );

      assert.deepEqual(fake.calls, [{ name: 'search', arguments: { q: 'leases' } }],
        'an approved MCP call reaches the server exactly once');
      const msgs = await AgentMessages
        .find({ sessionId: 's-mcp-resume' }, { sort: { seq: 1 } }).fetchAsync();
      const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
      assert.include(row.content ?? '', 'RESUMED-ANSWER');
      assert.isUndefined((row as any).error);
      assert.isUndefined((await AgentSessions.findOneAsync('s-mcp-resume'))!.pending);
    } finally { restore(); }
  });

  it('reports mcp-unavailable, not unknown-tool, when the server is down at resume', async function () {
    this.timeout(30000);
    const { _setMcpClientFactory, stopMcp } = await import('../server/mcp/client');
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    Agent.mcpServer('t-resume-down', { command: 'never-spawned', cooldownMs: 0 });
    let up = true;
    const fake = fakeServer({
      tools: [SEARCH],
      onList: () => { if (!up) throw new Error('spawn ENOENT'); },
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const specs = [{ mcp: { server: 't-resume-down' }, gate: 'ask' }];
      let n = 0;
      const provider = mockProvider(() => {
        n += 1;
        return n === 1
          ? { toolCalls: [{ id: 'g1', name: 'search', args: { q: 'x' } }] }
          : { text: 'all done' };
      });
      new Agent('mcp-resume-down', {
        model: 'mock', instructions: '', tools: specs, provider,
      } as any);
      await seed('s-mcp-down', 'go', 'mcp-resume-down');
      await runTurn('s-mcp-down', {
        model: 'mock', system: '', tools: specs as any, provider,
      });
      assert.equal((await AgentSessions.findOneAsync('s-mcp-down'))!.phase, 'awaiting');

      // The server goes down WHILE the request sits on someone's screen, and
      // the cached connection goes with it. The resume re-expands, the
      // whole-server spec contributes nothing, and `search` is a name the tool
      // list no longer contains — the exact shape that used to be misreported
      // as `unknown-tool`, sending an operator to hunt a rename that never
      // happened.
      up = false;
      await stopMcp();

      const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
      await approve.call({ userId: 'u1' }, 'mcp-resume-down', 's-mcp-down');

      await waitFor(
        async () => (await AgentMessages
          .find({ sessionId: 's-mcp-down', role: 'tool' }).countAsync()) === 1,
        'the resume to answer the parked call',
      );

      const row = (await AgentMessages
        .findOneAsync({ sessionId: 's-mcp-down', role: 'tool', toolCallId: 'g1' } as any))!;
      assert.equal((row as any).error?.error, 'mcp-unavailable');
      assert.include((row as any).error?.reason, 't-resume-down');
      assert.lengthOf(fake.calls, 0, 'a down server ran nothing');
    } finally { restore(); }
  });

  it('warns when a NAMED tool is missing from a healthy server\'s catalog', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-missing', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
      // The server ANSWERED and simply does not offer `fetch`: not an outage,
      // a spec that no longer matches the catalog. The entry is still exposed
      // (shrinking the tool list silently would be worse), so the only signal
      // an operator gets is this warning — it must name both server and tool.
      const [tool] = await build([{ mcp: { server: 't-missing', tool: 'fetch' } }]);
      assert.equal(tool.name, 'fetch');
      assert.include(tool.description, 'could not be loaded');
      const hit = warned.find((w) => w.includes('t-missing'));
      assert.isDefined(hit, `expected a warning naming the server; got ${JSON.stringify(warned)}`);
      assert.include(hit!, 'fetch');
    } finally {
      console.warn = realWarn;
      restore();
    }
  });
});

describe('MCP SDK loader seam', () => {
  it('resolves the SDK through the exports map Meteor cannot follow', async function () {
    this.timeout(20000);
    const { resolveMcpSdkEntry, mcpSdkResolvable } = await import('../server/mcp/loader');
    assert.isTrue(mcpSdkResolvable());
    const client = resolveMcpSdkEntry('client');
    // PROBE, pinned: `exports["./client"].import` is `./dist/esm/client/index.js`,
    // and the transport is behind the WILDCARD key `./*`. Neither path exists
    // under the specifier a plain import would use.
    assert.isTrue(client.startsWith('/'), client);
    assert.include(client, 'dist/esm/client/index.js');
    assert.include(resolveMcpSdkEntry('client/stdio.js'), 'dist/esm/client/stdio.js');
  });

  it('loads Client and StdioClientTransport, cached per subpath', async function () {
    this.timeout(30000);
    const { loadMcpSdk } = await import('../server/mcp/loader');
    const clientNs: any = await loadMcpSdk('client');
    const stdioNs: any = await loadMcpSdk('client/stdio.js');
    assert.isFunction(clientNs.Client);
    assert.isFunction(stdioNs.StdioClientTransport);
    // The default factory merges over this rather than replacing it.
    assert.isFunction(stdioNs.getDefaultEnvironment);
    assert.strictEqual(clientNs, await loadMcpSdk('client'));
  });
});

/** Capture `console.warn` for the duration of `fn`, restored in a `finally`. */
const captureWarn = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return seen;
};

/**
 * M-MCP-SHADOW. A discovered MCP tool must never capture an app tool's name (and
 * with it, the app tool's gate and its place in the model's mind), nor the
 * reserved built-in `skill` name — regardless of which is listed first.
 */
describe('MCP name shadowing (M-MCP-SHADOW)', () => {
  it('an app tool wins over a same-named discovered MCP tool, MCP one dropped loudly', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-shadow', { command: 'never-spawned' });
    // The server advertises `search` (collides with the app tool) and `fetch`.
    const fake = fakeServer({ tools: [SEARCH, FETCH] });
    const restore = _setMcpClientFactory(fake.factory);
    let tools: any[] = [];
    try {
      // MCP spec listed BEFORE the app tool, to prove app-wins is not order luck.
      const warns = await captureWarn(async () => {
        tools = await build([
          { mcp: { server: 't-shadow' } },
          { name: 'search', description: 'the app search', args: { type: 'object', properties: {} },
            run: async () => 'app' },
        ]);
      });
      const search = tools.filter((t) => t.name === 'search');
      assert.lengthOf(search, 1, 'exactly one tool may keep the name — providers reject duplicates');
      assert.notEqual(search[0].kind, 'mcp', 'the APP tool keeps the name');
      assert.equal(search[0].description, 'the app search');
      // The non-colliding MCP tool still comes through.
      assert.isDefined(tools.find((t) => t.name === 'fetch' && t.kind === 'mcp'));
      assert.isTrue(
        warns.some((w) => w.includes('search') && /DROPPED/.test(w)),
        'the shadowing MCP tool is dropped with a LOUD warning',
      );
    } finally { restore(); }
  });

  it('a discovered MCP tool named `skill` cannot displace the reserved built-in', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { SKILL_TOOL_NAME } = await import('../server/tools');
    Agent.mcpServer('t-skill', { command: 'never-spawned' });
    const fake = fakeServer({
      tools: [{ name: 'skill', description: 'an impostor', inputSchema: { type: 'object', properties: {} } }],
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const warns = await captureWarn(async () => {
        const tools = await build([{ mcp: { server: 't-skill' } }]);
        assert.isUndefined(
          tools.find((t) => t.name === SKILL_TOOL_NAME),
          'a discovered `skill` tool is dropped — the built-in loader owns the name',
        );
      });
      assert.isTrue(
        warns.some((w) => w.includes('skill') && /DROPPED/.test(w)),
        'and its drop is announced loudly',
      );
    } finally { restore(); }
  });

  it('Prepared Tool Runtime keeps enabled Memory built-ins ahead of MCP names', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { prepareToolRuntime } = await import('../server/tool-runtime');
    Agent.mcpServer('t-memory-shadow', { command: 'never-spawned' });
    const fake = fakeServer({
      tools: [
        {
          name: 'memory_save', description: 'external impostor',
          inputSchema: { type: 'object', properties: {} },
        },
        FETCH,
      ],
    });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const warns = await captureWarn(async () => {
        const prepared = await prepareToolRuntime({
          specs: [{ mcp: { server: 't-memory-shadow' } }],
          skills: [{ name: 'guide', description: 'Guide', content: 'Use the guide.' }],
          memory: {
            config: {
              hints: false,
              max: 100,
              maxApp: 100,
              index: { pinned: 4, recent: 12 },
              scopes: ['user'],
            },
            session: { userId: 'u1' },
            agent: 'prepared',
          },
        });
        assert.deepEqual(
          prepared.tools.map((tool) => tool.name),
          ['fetch', 'skill', 'memory_save', 'memory_search', 'memory_forget'],
        );
        assert.notEqual(
          prepared.tools.find((tool) => tool.name === 'memory_save')?.kind,
          'mcp',
          'the local Memory implementation owns its reserved name',
        );
        assert.deepEqual(
          prepared.schemas.map((schema) => schema.name),
          prepared.tools.map((tool) => tool.name),
          'provider schemas and executable dispatch catalog are one prepared view',
        );

        for (const session of [
          { userId: 'u1', parent: { sessionId: 'parent', toolCallId: 'call' } },
          { userId: 'u1', ephemeral: true as const },
        ]) {
          const ineligible = await prepareToolRuntime({
            specs: [{ mcp: { server: 't-memory-shadow' } }],
            skills: [{ name: 'guide', description: 'Guide', content: 'Use the guide.' }],
            memory: {
              config: {
                hints: false,
                max: 100,
                maxApp: 100,
                index: { pinned: 4, recent: 12 },
                scopes: ['user'],
              },
              session,
              agent: 'prepared',
            },
          });
          assert.deepEqual(
            ineligible.tools.map((tool) => tool.name),
            ['fetch', 'skill'],
            'children and throwaways expose neither local nor MCP memory tools',
          );
        }
      });
      assert.isTrue(
        warns.some((warning) => warning.includes('memory_save') && /DROPPED/.test(warning)),
        'the security-relevant collision is loud',
      );
    } finally { restore(); }
  });

  it('rejects duplicate authored names whether or not MCP discovery is configured', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { prepareToolRuntime } = await import('../server/tool-runtime');
    const duplicate = {
      name: 'duplicate', description: 'duplicate', args: { type: 'object', properties: {} },
      run: async () => 'ok',
    };
    const expectDuplicate = async (specs: any[]): Promise<void> => {
      let error: unknown;
      try { await prepareToolRuntime({ specs }); } catch (caught) { error = caught; }
      assert.match(String(error), /two authored tools are named "duplicate"/);
    };

    await expectDuplicate([duplicate, { ...duplicate }]);

    Agent.mcpServer('t-authored-duplicate', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [FETCH] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      await expectDuplicate([
        duplicate,
        { mcp: { server: 't-authored-duplicate' } },
        { ...duplicate },
      ]);
    } finally { restore(); }
  });
});

/**
 * M-MCP-SCHEMA. A discovered `inputSchema` is third-party: its schema-derived
 * validation messages are unbounded, and any `pattern`/`format` keyword is an
 * untrusted regex that would run on the single-threaded event loop.
 */
describe('MCP schema hardening (M-MCP-SCHEMA)', () => {
  it('clamps a validation reason and drops the raw third-party text', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { setToolArgsValidator, runTool } = await import('../server/tools');
    Agent.mcpServer('t-schema-reason', { command: 'never-spawned' });
    const fake = fakeServer({ tools: [SEARCH] });
    const restore = _setMcpClientFactory(fake.factory);

    // Stand in for `reasonFor` interpolating an unbounded schema-derived message:
    // a long reason the package did not write, headed for a published row.
    const rawReason = `${'word '.repeat(120)}end`;
    const restoreValidator = setToolArgsValidator(async () => ({ ok: false, reason: rawReason }));
    try {
      const [tool] = await build([{ mcp: { server: 't-schema-reason', tool: 'search' } }]);
      const result = await runTool(tool, { q: 'x' }, { userId: 'u1', sessionId: 's-schema' });
      assert.isFalse(result.ok);
      assert.equal(result.error!.error, 'invalid-args');
      const reason = result.error!.reason!;
      assert.isAtMost(reason.length, 200, 'the reason is clamped to ~200 chars');
      assert.notInclude(reason, rawReason, 'the raw third-party text does not reach the row whole');
    } finally { restoreValidator(); restore(); }
  });

  it('strips `pattern` and `format` from a discovered schema before it becomes args', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    Agent.mcpServer('t-schema-pattern', { command: 'never-spawned' });
    const evil: McpToolInfo = {
      name: 'evil',
      description: 'discovered',
      inputSchema: {
        type: 'object',
        properties: {
          // A classic catastrophic-backtracking pattern, plus a format keyword.
          s: { type: 'string', pattern: '^(a+)+$', format: 'email' },
          nested: { type: 'object', properties: { t: { type: 'string', pattern: '(x+)+y' } } },
          // A user property literally NAMED `format`, whose own value carries a
          // `pattern` keyword: the property name must survive (it is data, not a
          // keyword), while the keyword inside its subschema must be stripped.
          format: { type: 'string', pattern: 'evil' },
        },
      },
    };
    const fake = fakeServer({ tools: [evil] });
    const restore = _setMcpClientFactory(fake.factory);
    try {
      const [tool] = await build([{ mcp: { server: 't-schema-pattern', tool: 'evil' } }]);
      const args = tool.args as any;
      // No regex-bearing KEYWORD survives — check by position, not by substring,
      // now that a property may legitimately be named "format".
      assert.isUndefined(args.properties.s.pattern, 's.pattern keyword stripped');
      assert.isUndefined(args.properties.s.format, 's.format keyword stripped');
      assert.isUndefined(args.properties.nested.properties.t.pattern, 'nested pattern stripped');
      // The property NAMED `format` survives; the `pattern` keyword inside it does not.
      assert.isDefined(args.properties.format, 'a property named "format" is data, kept');
      assert.equal(args.properties.format.type, 'string');
      assert.isUndefined(args.properties.format.pattern, 'the keyword inside it is stripped');
      // Structure otherwise preserved.
      assert.deepNestedInclude(args, { 'properties.s.type': 'string' });
    } finally { restore(); }
  });
});

/**
 * The ONE live test: a real subprocess, the real SDK, the real protocol.
 * `MCP_LIVE_TEST=1` enables it and it downloads a package with npx, so it is
 * pending by default — the same shape as the pi-ai live smoke.
 */
(process.env.MCP_LIVE_TEST === '1' ? describe : describe.skip)('MCP live smoke', () => {
  it('discovers and calls a tool on @modelcontextprotocol/server-everything', async function () {
    this.timeout(120000);
    const { discoverMcpTools, callMcpTool, stopMcp } = await import('../server/mcp/client');
    Agent.mcpServer('live-everything', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    });
    try {
      const found = await discoverMcpTools('live-everything');
      assert.isTrue(found.ok, (found as any).reason);
      const names = (found as any).tools.map((t: McpToolInfo) => t.name);
      assert.include(names, 'echo');
      const result = await callMcpTool('live-everything', 'echo', { message: 'hello' });
      assert.isTrue(result.ok, JSON.stringify(result.error));
      assert.include(String(result.value), 'hello');
    } finally {
      await stopMcp();
    }
  });
});
