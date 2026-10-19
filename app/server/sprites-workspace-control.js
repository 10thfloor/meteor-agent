const LIMIT = 5_000_000;
const ACTIONS = new Set(['createFolder', 'write', 'upload', 'rename', 'move', 'copy', 'delete', 'read', 'list']);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

/** Lexical app guard, not a guest filesystem sandbox. Native Sprites filesystem
 * requests have no documented atomic no-follow or compare-and-swap contract. */
export function workspaceFilePath(value, { read = false, root = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f\\]/.test(value)) fail('invalid-path');
  if (root && value === '/workspace') return value;
  const parts = value.split('/');
  if (!value.startsWith('/workspace/') || parts.length > 34 || parts.slice(1).some((part) => !part || part === '.' || part === '..' || part.startsWith('.constellation'))
    || (!read && ['runs', 'inputs', 'attachments'].includes(parts[2]))) fail('invalid-path');
  return value;
}

export function normalizeWorkspaceMutation(input, { maxBytes = LIMIT } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) fail('invalid-action');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('response-limit');
  const result = { action: input.action, maxBytes: Math.min(LIMIT, maxBytes), maxEntries: 1000,
    path: workspaceFilePath(input.path ?? (input.action === 'list' ? '/workspace' : undefined), { read: ['read', 'list', 'copy'].includes(input.action), root: input.action === 'list' }) };
  if (['rename', 'move', 'copy'].includes(input.action)) result.destination = workspaceFilePath(input.destination);
  if (input.action === 'delete') {
    if (input.confirm !== true) fail('file-confirm-required');
    result.confirm = true;
  }
  if (['write', 'upload'].includes(input.action)) {
    if ([input.text, input.content, input.base64].filter((value) => value !== undefined).length !== 1) fail('invalid-content');
    if (typeof input.text === 'string') {
      if (Buffer.byteLength(input.text, 'utf8') > result.maxBytes) fail('response-limit');
      result.base64 = Buffer.from(input.text, 'utf8').toString('base64');
    } else {
      const encoded = input.content ?? input.base64;
      if (typeof encoded !== 'string') fail('invalid-content');
      if (encoded.length > Math.ceil(result.maxBytes / 3) * 4) fail('response-limit');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('invalid-content');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > result.maxBytes) fail('response-limit');
      if (bytes.toString('base64') !== encoded) fail('invalid-content');
      result.base64 = encoded;
    }
    if (input.expectedHash !== undefined) {
      if (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expectedHash)) fail('file-changed');
      result.expectedHash = input.expectedHash.toLowerCase();
    }
  }
  return result;
}
