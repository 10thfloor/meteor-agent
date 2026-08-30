#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'constellation-workspace',
  version: '0.1.0',
});

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

server.registerTool('runtime_status', {
  description: 'Check that the app-managed Constellation MCP bridge is available.',
  annotations: readOnly,
}, async () => ({
  content: [{
    type: 'text',
    text: 'Constellation MCP is ready. Transport: local stdio. Access: read-only.',
  }],
}));

server.registerTool('format_checklist', {
  description: 'Format a short list of work items as a concise Markdown checklist.',
  inputSchema: {
    title: z.string().trim().min(1).max(80).describe('Checklist title'),
    items: z.array(z.string().trim().min(1).max(160)).min(1).max(12)
      .describe('One to twelve checklist items'),
  },
  annotations: readOnly,
}, async ({ title, items }) => ({
  content: [{
    type: 'text',
    text: [`### ${title}`, '', ...items.map((item) => `- [ ] ${item}`)].join('\n'),
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Constellation app MCP ready on stdio.');
