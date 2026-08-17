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

/** A session `runTurn` can start from, scoped to its own id. */
const seed = async (sessionId: string, text: string) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({ _id: sessionId } as any);
  await AgentMessages.removeAsync({ sessionId });
  await AgentDeltas.removeAsync({ sessionId });
  await AgentSessions.insertAsync({
    _id: sessionId, agent: 'mcp-test', userId: 'u1', phase: 'idle', model: 'mock',
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
    assert.equal(sanitizeMcpReason(undefined), 'The MCP tool reported an error.');
  });

  it('answers mcp-unavailable when the server is down, and RETRIES on the next use', async () => {
    const { _setMcpClientFactory } = await import('../server/mcp/client');
    const { runTool } = await import('../server/tools');
    Agent.mcpServer('t-flaky', { command: 'never-spawned' });
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
