#!/usr/bin/env node

// Constellation's app-managed MCP server: two read-only tools over stdio.
//
// Written against the protocol directly, with no server library. A stdio MCP
// server is newline-delimited JSON-RPC 2.0 and this one answers four methods
// of it; the official SDK would be the larger half of the file and brings an
// HTTP stack (express, hono) that a stdio process never touches.
// `workspace-server.test.mjs` holds this file to the wire format.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'constellation-workspace', version: '0.1.0' };
/** No request this server accepts comes close; a longer line is not a client. */
const MAX_LINE_CHARS = 1024 * 1024;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A caller's mistake, answered as a tool error rather than a protocol one. */
class InvalidArguments extends Error {}

const text = (value) => ({ content: [{ type: 'text', text: value }] });

function boundedString(value, label, max) {
  if (typeof value !== 'string') throw new InvalidArguments(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new InvalidArguments(`${label} must be 1 to ${max} characters.`);
  }
  return trimmed;
}

const TOOLS = [
  {
    name: 'runtime_status',
    description: 'Check that the app-managed Constellation MCP bridge is available.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
    run: () => text('Constellation MCP is ready. Transport: local stdio. Access: read-only.'),
  },
  {
    name: 'format_checklist',
    description: 'Format a short list of work items as a concise Markdown checklist.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80, description: 'Checklist title' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: { type: 'string', minLength: 1, maxLength: 160 },
          description: 'One to twelve checklist items',
        },
      },
      required: ['title', 'items'],
    },
    annotations: READ_ONLY,
    run: (args) => {
      const title = boundedString(args.title, 'title', 80);
      if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 12) {
        throw new InvalidArguments('items must be a list of 1 to 12 strings.');
      }
      const items = args.items.map((item, index) => boundedString(item, `items[${index}]`, 160));
      return text([`### ${title}`, '', ...items.map((item) => `- [ ] ${item}`)].join('\n'));
    },
  },
];

function callTool(params) {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  // A wrong name or wrong arguments is the caller's to correct, so both come
  // back as a tool result the model can read, not as a JSON-RPC error.
  if (!tool) return { ...text(`Unknown tool: ${String(params?.name).slice(0, 80)}`), isError: true };
  try {
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new InvalidArguments('arguments must be an object.');
    }
    return tool.run(args);
  } catch (error) {
    if (!(error instanceof InvalidArguments)) throw error;
    return { ...text(`Invalid arguments for ${tool.name}: ${error.message}`), isError: true };
  }
}

const METHODS = {
  // A client asking for a revision this server does not know gets the newest
  // one it does, and decides for itself whether to carry on.
  initialize: (params) => ({
    protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
      ? params.protocolVersion : PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: TOOLS.map(({ run, ...definition }) => definition) }),
  'tools/call': callTool,
};

// stdout carries protocol messages and nothing else; everything human goes to stderr.
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

function receive(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error('Constellation app MCP ignored a line that is not JSON.');
    return;
  }
  // Notifications (no id) need no answer, and this server acts on none of them.
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string'
    || (typeof message.id !== 'string' && typeof message.id !== 'number')) return;
  const { id } = message;
  const method = Object.hasOwn(METHODS, message.method) ? METHODS[message.method] : null;
  if (!method) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    send({ jsonrpc: '2.0', id, result: method(message.params) });
  } catch {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
  }
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf('\n');
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) receive(line);
    newline = buffered.indexOf('\n');
  }
  if (buffered.length > MAX_LINE_CHARS) {
    console.error('Constellation app MCP stopped: a request line exceeded its size limit.');
    process.exit(1);
  }
});
// The client closing stdin is the shutdown signal. Nothing else holds the event
// loop open, so the process ends by itself once pending output has drained.
// A client that vanished mid-write is the same event seen from the other pipe.
process.stdout.on('error', () => process.exit(0));

console.error('Constellation app MCP ready on stdio.');
