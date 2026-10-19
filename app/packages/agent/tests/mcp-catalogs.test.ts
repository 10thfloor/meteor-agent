import fs from 'fs';
import os from 'os';
import path from 'path';
import { assert } from 'chai';
import { Agent } from '../server/agent';
import type { McpClient } from '../server/mcp/client';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MCP resources and prompts', () => {
  afterEach(async () => {
    const { stopMcp } = await import('../server/mcp/client');
    await stopMcp();
  });

  it('paginates and allowlists resource and prompt metadata', async () => {
    const {
      _setMcpClientFactory, discoverMcpPrompts, discoverMcpResources,
    } = await import('../server/mcp/client');
    Agent.mcpServer('catalog-pages', { command: 'never-spawned' });
    let resourcePages = 0;
    let promptPages = 0;
    let authorizations = 0;
    const client: McpClient = {
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async listResources(params) {
        resourcePages += 1;
        return params?.cursor
          ? { resources: [{ uri: 'docs://two', name: 'Two', _meta: { token: 'secret-2' } }] }
          : {
            resources: [{
              uri: 'docs://one', name: 'One', description: ' First\nresource ',
              title: 'One title', mimeType: 'text/plain', size: 12,
              _meta: { token: 'secret-1' }, annotations: { audience: ['assistant'] },
            }],
            nextCursor: 'page-2',
          };
      },
      async listPrompts(params) {
        promptPages += 1;
        return params?.cursor
          ? { prompts: [{ name: 'summarize', description: 'duplicate' }] }
          : {
            prompts: [{
              name: 'summarize', title: 'Summarize', description: ' Make a summary ',
              arguments: [{ name: 'topic', description: 'Topic', required: true }],
              _meta: { token: 'secret-3' },
            }],
            nextCursor: 'page-2',
          };
      },
      async close() {},
    };
    const restore = _setMcpClientFactory(async () => client);
    const authorize = async () => { authorizations += 1; return true; };
    try {
      const resources = await discoverMcpResources('catalog-pages', authorize);
      const prompts = await discoverMcpPrompts('catalog-pages', authorize);
      assert.deepEqual(resources, {
        ok: true,
        resources: [
          {
            uri: 'docs://one', name: 'One', title: 'One title',
            description: 'First resource', mimeType: 'text/plain', size: 12,
          },
          { uri: 'docs://two', name: 'Two' },
        ],
      });
      assert.deepEqual(prompts, {
        ok: true,
        prompts: [{
          name: 'summarize', title: 'Summarize', description: 'Make a summary',
          arguments: [{ name: 'topic', description: 'Topic', required: true }],
        }],
      });
      assert.equal(resourcePages, 2);
      assert.equal(promptPages, 2);
      assert.equal(authorizations, 4, 'authorization is checked before every page');
      assert.notInclude(JSON.stringify({ resources, prompts }), 'secret');
      assert.notInclude(JSON.stringify({ resources, prompts }), '_meta');
    } finally { restore(); }
  });

  it('rechecks authorization after a delayed connection before resource read', async () => {
    const {
      _setMcpClientFactory, readMcpResource,
    } = await import('../server/mcp/client');
    Agent.mcpServer('catalog-revoked-read', { command: 'never-spawned' });
    const started = deferred<void>();
    const ready = deferred<McpClient>();
    let allowed = true;
    let reads = 0;
    const restore = _setMcpClientFactory(async () => {
      started.resolve(undefined);
      return ready.promise;
    });
    try {
      const pending = readMcpResource('catalog-revoked-read', 'docs://private', () => allowed);
      await started.promise;
      allowed = false;
      ready.resolve({
        async listTools() { return { tools: [] }; },
        async callTool() { return { content: [] }; },
        async readResource() { reads += 1; return { contents: [] }; },
        async close() {},
      });
      assert.deepEqual(await pending, {
        ok: false, error: 'not-allowed', reason: 'MCP content access is not allowed.',
      });
      assert.equal(reads, 0);
    } finally { restore(); }
  });

  it('returns bounded text, omits binary bytes, and sanitizes prompt content', async () => {
    const {
      _setMcpClientFactory, getMcpPrompt, readMcpResource,
    } = await import('../server/mcp/client');
    Agent.mcpServer('catalog-content', { command: 'never-spawned' });
    const client: McpClient = {
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async readResource() {
        return { contents: [
          { uri: 'docs://text', mimeType: 'text/plain', text: `ok\u0000${'x'.repeat(110_000)}` },
          { uri: 'docs://binary', mimeType: 'image/png', blob: 'VERY-SECRET-BYTES' },
          { uri: 42, text: 'invalid' },
        ] };
      },
      async getPrompt() {
        return {
          description: ' Safe prompt ',
          messages: [
            { role: 'user', content: { type: 'text', text: 'Please summarize.' } },
            { role: 'assistant', content: {
              type: 'image', mimeType: 'image/png', data: 'VERY-SECRET-IMAGE',
            } },
            { role: 'system', content: { type: 'text', text: 'not a legal MCP prompt role' } },
          ],
        };
      },
      async close() {},
    };
    const restore = _setMcpClientFactory(async () => client);
    try {
      const resource = await readMcpResource('catalog-content', 'docs://text');
      assert.isTrue(resource.ok);
      if (resource.ok) {
        assert.lengthOf(resource.contents, 2);
        assert.lengthOf(resource.contents[0].text!, 100_000);
        assert.equal(resource.contents[0].text?.includes('\u0000'), false);
        assert.equal(resource.contents[1].blob, '[binary content omitted]');
      }
      const prompt = await getMcpPrompt('catalog-content', 'summarize', { topic: 'leases' });
      assert.deepEqual(prompt, {
        ok: true,
        description: 'Safe prompt',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Please summarize.' } },
          { role: 'assistant', content: { type: 'image', mimeType: 'image/png' } },
        ],
      });
      assert.notInclude(JSON.stringify({ resource, prompt }), 'VERY-SECRET');
    } finally { restore(); }
  });
});

/**
 * The same four calls through the DEFAULT factory, against a real stdio server.
 * The fakes above stand in for the client; this is the client (pi-mcp), started
 * against a script written to a temp directory and run with the suite's own
 * Node. It is the only place that would notice the factory asking pi-mcp for
 * something in the official SDK's shape, which is neither a compile error nor,
 * for `resources/list`, a thrown one.
 */
const CATALOG_SERVER = String.raw`
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const catalogs = process.env.FIXTURE_TOOLS_ONLY !== '1';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const params = request.params || {};
    const reply = (result) => send({ jsonrpc: '2.0', id: request.id, result });
    const refuse = () => send({
      jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' },
    });
    if (request.method === 'initialize') {
      reply({
        protocolVersion: params.protocolVersion,
        capabilities: catalogs ? { tools: {}, resources: {}, prompts: {} } : { tools: {} },
        serverInfo: { name: 'catalog-fixture', version: '1' },
      });
    } else if (request.method === 'tools/list') {
      reply({ tools: [] });
    } else if (!catalogs) {
      refuse();
    } else if (request.method === 'resources/list') {
      if (params.cursor === 'page-2') {
        reply({ resources: [{ uri: 'docs://two', name: 'Two' }, { uri: 42, name: 'malformed' }] });
      } else {
        reply({
          resources: [{ uri: 'docs://one', name: 'One', mimeType: 'text/plain' }],
          nextCursor: 'page-2',
        });
      }
    } else if (request.method === 'resources/read') {
      reply({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'body of ' + params.uri }] });
    } else if (request.method === 'prompts/list') {
      if (params.cursor === 'page-2') reply({ prompts: [{ name: 'second' }] });
      else reply({ prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }], nextCursor: 'page-2' });
    } else if (request.method === 'prompts/get') {
      reply({
        description: 'A greeting',
        messages: [{ role: 'user', content: { type: 'text', text: 'Hello ' + params.arguments.who } }],
      });
    } else {
      refuse();
    }
  }
});
`;

describe('MCP resources and prompts through the default factory (a real stdio server)', () => {
  let dir = '';
  let script = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-catalog-'));
    script = path.join(dir, 'server.cjs');
    fs.writeFileSync(script, CATALOG_SERVER);
  });

  after(async () => {
    const { unregisterMcpServer } = await import('../server/mcp/client');
    await Promise.all(['catalog-real', 'catalog-tools-only'].map((name) => unregisterMcpServer(name)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pages resources and prompts, reads a resource, and resolves a prompt', async function () {
    this.timeout(30000);
    const {
      discoverMcpPrompts, discoverMcpResources, getMcpPrompt, readMcpResource,
    } = await import('../server/mcp/client');
    Agent.mcpServer('catalog-real', { command: process.execPath, args: [script] });

    assert.deepEqual(await discoverMcpResources('catalog-real'), {
      ok: true,
      resources: [
        { uri: 'docs://one', name: 'One', mimeType: 'text/plain' },
        { uri: 'docs://two', name: 'Two' },
      ],
    }, 'both pages arrive, and the malformed entry on the second costs only itself');
    assert.deepEqual(await readMcpResource('catalog-real', 'docs://one'), {
      ok: true,
      contents: [{ uri: 'docs://one', mimeType: 'text/plain', text: 'body of docs://one' }],
    });
    assert.deepEqual(await discoverMcpPrompts('catalog-real'), {
      ok: true,
      prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }, { name: 'second' }],
    });
    assert.deepEqual(await getMcpPrompt('catalog-real', 'greet', { who: 'Ada' }), {
      ok: true,
      description: 'A greeting',
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }],
    });
  });

  it('reads a tools-only server as having no catalogs, and keeps its connection', async function () {
    this.timeout(30000);
    const {
      discoverMcpPrompts, discoverMcpResources, getMcpPrompt, getMcpServerStatus, readMcpResource,
    } = await import('../server/mcp/client');
    Agent.mcpServer('catalog-tools-only', {
      command: process.execPath, args: [script], env: { FIXTURE_TOOLS_ONLY: '1' },
    });

    // "Method not found" is an answer, not an outage. The client has to hand
    // the error's code through for the catalog to tell the two apart.
    assert.deepEqual(await discoverMcpResources('catalog-tools-only'), { ok: true, resources: [] });
    assert.deepEqual(await discoverMcpPrompts('catalog-tools-only'), { ok: true, prompts: [] });
    assert.deepInclude(
      await readMcpResource('catalog-tools-only', 'docs://one'), { ok: false, error: 'mcp-unsupported' },
    );
    assert.deepInclude(
      await getMcpPrompt('catalog-tools-only', 'greet', {}), { ok: false, error: 'mcp-unsupported' },
    );
    assert.equal(getMcpServerStatus('catalog-tools-only').state, 'connected',
      'and none of that is a reason to drop the server');
  });
});

