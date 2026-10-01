// Wire-format tests for workspace-server.mjs. The server is hand-written
// against the protocol, so these speak the protocol to it directly — raw
// JSON-RPC lines over a real subprocess's stdio, with no client library in
// between to paper over a mistake.
//
//   meteor npm run test:mcp-server        (from app/)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const SERVER = fileURLToPath(new URL('./workspace-server.mjs', import.meta.url));

/** One running server, with its stdout split into parsed lines. */
function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      lines.push(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
    }
    for (const wake of waiting.splice(0)) wake();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let nextId = 1;
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  /** The response carrying `id`, or a failure once the deadline passes. */
  const response = async (id, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = lines.map((line) => JSON.parse(line)).find((message) => message.id === id);
      if (found) return found;
      const left = deadline - Date.now();
      assert.ok(left > 0, `no response to request ${id}; stderr: ${stderr}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100));
        waiting.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  };
  const request = async (method, params) => {
    const id = nextId;
    nextId += 1;
    write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return response(id);
  };
  const call = async (name, args) => (await request('tools/call', {
    name, ...(args === undefined ? {} : { arguments: args }),
  })).result;
  /** stderr is a second pipe with its own timing, so its text is waited for, never sampled. */
  const stderrMatching = async (pattern, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(stderr)) {
      assert.ok(Date.now() < deadline, `stderr never matched ${pattern}; it holds: ${stderr}`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  };
  return {
    child, lines, write, request, call, stderrMatching,
    raw: (line) => child.stdin.write(`${line}\n`),
  };
}

const textOf = (result) => result.content.map((block) => block.text).join('');

describe('workspace MCP server', () => {
  let server;
  before(() => { server = start(); });
  after(() => { server.child.kill(); });

  it('negotiates the protocol revision the client asks for', async () => {
    const { result } = await server.request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    assert.deepEqual(result, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'constellation-workspace', version: '0.1.0' },
    });
    server.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  it('answers a revision it does not know with the newest one it does', async () => {
    const { result } = await server.request('initialize', {
      protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(result.protocolVersion, '2025-11-25');
  });

  it('lists both tools as plain definitions', async () => {
    const { result } = await server.request('tools/list');
    assert.deepEqual(result.tools.map((tool) => tool.name), ['runtime_status', 'format_checklist']);
    for (const tool of result.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      // The handler lives on the same object in the server; it must not ship.
      assert.deepEqual(Object.keys(tool).sort(), ['annotations', 'description', 'inputSchema', 'name']);
    }
    assert.deepEqual(result.tools[1].inputSchema.required, ['title', 'items']);
    assert.equal(result.nextCursor, undefined, 'one page, so no cursor');
  });

  it('reports the runtime status with or without arguments', async () => {
    const expected = 'Constellation MCP is ready. Transport: local stdio. Access: read-only.';
    assert.equal(textOf(await server.call('runtime_status')), expected);
    assert.equal(textOf(await server.call('runtime_status', {})), expected);
  });

  it('formats a checklist, trimming what it is given and ignoring what it was not asked for', async () => {
    const result = await server.call('format_checklist', {
      title: '  Launch  ', items: [' draft the note ', 'ship'], extra: true,
    });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), '### Launch\n\n- [ ] draft the note\n- [ ] ship');
  });

  it('answers bad arguments as a tool error the model can read, not a protocol error', async () => {
    const long = (n) => 'x'.repeat(n);
    const cases = [
      [{ title: '', items: ['a'] }, 'title must be 1 to 80 characters.'],
      [{ title: '   ', items: ['a'] }, 'title must be 1 to 80 characters.'],
      [{ title: long(81), items: ['a'] }, 'title must be 1 to 80 characters.'],
      [{ title: 7, items: ['a'] }, 'title must be a string.'],
      [{ items: ['a'] }, 'title must be a string.'],
      [{ title: 'T' }, 'items must be a list of 1 to 12 strings.'],
      [{ title: 'T', items: [] }, 'items must be a list of 1 to 12 strings.'],
      [{ title: 'T', items: Array.from({ length: 13 }, () => 'a') }, 'items must be a list of 1 to 12 strings.'],
      [{ title: 'T', items: 'a' }, 'items must be a list of 1 to 12 strings.'],
      [{ title: 'T', items: ['ok', 7] }, 'items[1] must be a string.'],
      [{ title: 'T', items: ['ok', long(161)] }, 'items[1] must be 1 to 160 characters.'],
      [['not', 'an', 'object'], 'arguments must be an object.'],
    ];
    for (const [args, reason] of cases) {
      const result = await server.call('format_checklist', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(textOf(result), `Invalid arguments for format_checklist: ${reason}`);
    }
    // The boundaries themselves are accepted.
    assert.equal((await server.call('format_checklist', {
      title: long(80), items: Array.from({ length: 12 }, () => long(160)),
    })).isError, undefined);
  });

  it('answers an unknown tool as a tool error too', async () => {
    const result = await server.call('no_such_tool', {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Unknown tool: no_such_tool');
  });

  it('answers ping, and refuses a method it does not implement', async () => {
    assert.deepEqual((await server.request('ping')).result, {});
    const refused = await server.request('resources/list');
    assert.equal(refused.result, undefined);
    assert.deepEqual(refused.error, { code: -32601, message: 'Method not found' });
  });

  it('stays silent for notifications and survives a line that is not JSON', async () => {
    const before = server.lines.length;
    server.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
    server.raw('this is not json');
    // The ping is answered AFTER both, so if either had produced output it
    // would be sitting in front of this response.
    assert.deepEqual((await server.request('ping')).result, {});
    assert.equal(server.lines.length, before + 1, 'exactly one line: the ping response');
    await server.stderrMatching(/ignored a line that is not JSON/);
  });

  it('writes nothing but JSON-RPC to stdout, and announces itself on stderr', async () => {
    for (const line of server.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    await server.stderrMatching(/Constellation app MCP ready on stdio\./);
  });
});

describe('workspace MCP server shutdown', () => {
  it('exits cleanly when the client closes stdin, after answering what it was asked', async () => {
    const server = start();
    const answered = server.request('ping');
    server.child.stdin.end();
    assert.deepEqual((await answered).result, {});
    const [code, signal] = await once(server.child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0);
  });

  it('stops rather than buffer a request line without end', async () => {
    const server = start();
    server.child.stdin.on('error', () => { /* the server hangs up mid-write, by design */ });
    const chunk = 'x'.repeat(64 * 1024);
    const exited = once(server.child, 'exit');
    for (let sent = 0; sent <= 1024 * 1024 + chunk.length && server.child.exitCode === null; sent += chunk.length) {
      if (!server.child.stdin.write(chunk)) await once(server.child.stdin, 'drain').catch(() => {});
    }
    const [code] = await exited;
    assert.equal(code, 1);
    await server.stderrMatching(/exceeded its size limit/);
  });
});
