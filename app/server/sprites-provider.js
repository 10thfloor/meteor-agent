import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { inspectSpritesConnections } from './sprites-connections.js';
import { normalizeWorkspaceMutation } from './sprites-workspace-control.js';
import { attachmentStoragePath } from './sprite-attachment-path.js';

// Let Node 24 load the SDK's native ESM. Meteor's CJS bundler cannot rewrite
// its import.meta/createRequire module safely. Never bundle it into the client.
export async function loadSpritesClient() {
  for (const base of ['.', 'npm']) {
    const nativeRequire = createRequire(resolve(process.cwd(), base, 'sprites-loader.cjs'));
    try {
      const entry = nativeRequire.resolve('@fly/sprites');
      const shim = Assets.absoluteFilePath('sprites-loader.mjs');
      const { load } = createRequire(shim)(shim);
      return (await load(pathToFileURL(entry).href)).SpritesClient;
    }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('The Sprites SDK is unavailable. Reinstall app dependencies.');
}

const API = 'https://api.sprites.dev/v1';
const WORKSPACE = '/workspace';
// Fixed control program, never supplied by an agent. Isolated Python ignores
// PYTHONPATH and cwd imports. Directory FDs + O_NOFOLLOW prevent a guest symlink
// from turning historical file recovery into a read of the current filesystem.
const CHECKPOINT_CONTROL = `import os,sys,json,stat,base64,socket,http.client
q=json.load(sys.stdin)
try:
 if q['action']=='delete':
  class Local(http.client.HTTPConnection):
   def connect(self):
    self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(20);self.sock.connect('/.sprite/api.sock')
  c=Local('sprite',timeout=20);c.request('DELETE','/v1/checkpoints/'+q['id']);r=c.getresponse();status=r.status;r.read(65537);c.close();print(json.dumps({'status':status}));sys.exit(0)
 flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
 fd=os.open('/',flags)
 try:
  for part in ['.sprite','checkpoints',q['id']]:
   nxt=os.open(part,flags,dir_fd=fd);os.close(fd);fd=nxt
  if not os.fstatvfs(fd).f_flag & os.ST_RDONLY: raise RuntimeError('checkpoint-unavailable')
 except OSError: raise RuntimeError('checkpoint-unavailable')
 parts=q['path'].strip('/').split('/')
 for part in parts if q['action']=='list' else parts[:-1]:
  nxt=os.open(part,flags,dir_fd=fd);os.close(fd);fd=nxt
 if q['action']=='list':
  rows=[]
  with os.scandir(fd) as entries:
   for e in entries:
    s=e.stat(follow_symlinks=False)
    if not stat.S_ISREG(s.st_mode) and not stat.S_ISDIR(s.st_mode): continue
    rows.append({'name':e.name,'path':q['path']+'/'+e.name,'type':'directory' if stat.S_ISDIR(s.st_mode) else 'file','size':s.st_size})
    if len(rows)>1000: raise RuntimeError('response-limit')
  print(json.dumps({'entries':rows}))
 else:
  f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  with os.fdopen(f,'rb') as stream:
   s=os.fstat(stream.fileno())
   if not stat.S_ISREG(s.st_mode): raise RuntimeError('invalid-path')
   if s.st_size>q['maxBytes']: raise RuntimeError('response-limit')
   data=stream.read(q['maxBytes']+1)
   if len(data)>q['maxBytes']: raise RuntimeError('response-limit')
  print(json.dumps({'base64':base64.b64encode(data).decode('ascii')}))
 os.close(fd)
except RuntimeError as e: print(json.dumps({'error':str(e)}))
except OSError: print(json.dumps({'error':'invalid-path'}))
`;
const safeCodes = {
  'key-rejected': 'Sprites rejected this token. Update it in Code settings.',
  'provider-busy': 'Sprites is busy. Try again later.',
  'provider-error': 'Sprites could not complete this request.',
  'network-error': 'The connection to Sprites was interrupted. This run was not retried.',
  'cancelled': 'This code run was stopped.',
  'response-limit': 'Sprites returned more data than this run allows.',
  'invalid-response': 'Sprites returned an unexpected response.',
  'cleanup-unconfirmed': 'Remote cleanup could not be confirmed. Retry cleanup; Sprites charges may continue.',
  'stop-unconfirmed': 'The remote process could not be confirmed stopped. This environment needs attention before another run.',
  'checkpoint-unconfirmed': 'Checkpoint creation could not be confirmed. Check the environment before trying again.',
  'checkpoint-unhealthy': 'Sprites marked this save point unhealthy. Choose another save point.',
  'checkpoint-unavailable': 'This save point is not mounted by its ID for file recovery. Choose another save point; the newest one may not be available yet.',
  'checkpoint-delete-unconfirmed': 'Save point deletion could not be confirmed. Refresh the list before trying again.',
  'checkpoint-delete-unsupported': 'This Sprite does not support deleting individual save points. The save point has not been deleted.',
  'checkpoint-current': 'The current save point cannot be deleted. Restore another save point first.',
  'restore-unconfirmed': 'Checkpoint restore could not be confirmed. This environment needs attention before another run.',
  'policy-unconfirmed': 'The environment’s access limits could not be verified. No code was started.',
  'invalid-service': 'Choose a valid preview service and a workspace directory.',
  'service-unconfirmed': 'The service change could not be confirmed. Refresh its status before trying again.',
  'private-preview-unavailable': 'A private preview is unavailable. Check the service and Sprite URL privacy settings.',
  'invalid-checkpoint': 'Choose a saved checkpoint for this environment.',
  'invalid-workspace': 'This workspace is not managed by Constellation.',
  'invalid-path': 'Choose a file inside this run’s workspace.',
  'invalid-policy': 'Enter complete website domains, one per line.',
  'file-exists': 'A file or folder already exists at that destination. Choose another name.',
  'file-changed': 'This file changed after you opened it. Reload it before saving.',
  'file-not-found': 'This file or folder is no longer available. Refresh the file list.',
  'trash-not-found': 'This item is no longer in the environment trash.',
  'invalid-content': 'Provide valid file content within the upload limit.',
  'invalid-action': 'Choose a supported file action.',
  'file-operation-unconfirmed': 'This file change could not be confirmed. Inspect the environment before trying again.',
};
export class SpritesProviderError extends Error {
  constructor(code) { super(safeCodes[code] ?? safeCodes['provider-error']); this.code = code; this.reason = this.message; }
}
const failure = (code) => new SpritesProviderError(code);
const checkAbort = (signal) => { if (signal?.aborted) throw failure('cancelled'); };
function workspacePath(name) {
  if (typeof name !== 'string' || !/^constellation-[a-z0-9-]{8,64}$/.test(name)) throw failure('invalid-workspace');
  return `/sprites/${encodeURIComponent(name)}`;
}
function checkedPath(path, outputsOnly = false, allowRoot = false) {
  if (allowRoot && path === WORKSPACE) return path;
  const prefix = outputsOnly ? `${WORKSPACE}/outputs/` : `${WORKSPACE}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || /[\x00-\x1f\x7f\\]/.test(path)
    || path.slice(1).split('/').some((part) => !part || part === '..' || part === '.')
    || path.length > 1024 || path.split('/').length > 34) throw failure('invalid-path');
  return path;
}
function checkedRemoteId(id, code = 'invalid-response') {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw failure(code);
  return id;
}
function terminalEvent(events, types, { advisoryErrors = false } = {}) {
  if (!Array.isArray(events) || !events.length || events.length > 1000
    || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)
      || !types.includes(event.type) || (!advisoryErrors && (event.type === 'error' || event.error)))
    || events.filter((event) => event.type === 'complete').length !== 1
    || events.at(-1).type !== 'complete' || events.at(-1).error) throw failure('invalid-response');
  return events.at(-1);
}

/** An empty Sprites rules array is unrestricted, NOT offline. Never use presets. */
export function spritesNetworkPolicy(domains = []) {
  if (!Array.isArray(domains) || domains.length > 50) throw failure('invalid-policy');
  const clean = [...new Set(domains.map((domain) => {
    if (typeof domain !== 'string' || domain.length > 253 || domain !== domain.toLowerCase()
      || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw failure('invalid-policy');
    return domain;
  }))];
  return { rules: [{ domain: '*', action: 'deny' }, ...clean.map((domain) => ({ domain, action: 'allow' }))] };
}

async function boundedBytes(response, maxBytes) {
  const length = response.headers?.get('content-length');
  if (length && Number(length) > maxBytes) { await response.body?.cancel(); throw failure('response-limit'); }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw failure('response-limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = []; let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > maxBytes) { await reader.cancel(); throw failure('response-limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, count);
}

/** REST management is bounded and does not follow redirects or retry writes.
 * Disposable execution uses Fly's SDK. Persistent execution uses the documented
 * WebSocket framing because SDK 0.2.3 drops non-TTY text session_info messages.
 * HTTP exec cannot safely reconstruct arbitrary transport chunks. Tokens never
 * enter guest env/files. */
export function createSpritesAdapter({ fetchImpl = globalThis.fetch,
  webSocketFactory = (url, options) => new WebSocket(url, options),
  clientFactory = async (token) => {
    const SpritesClient = await loadSpritesClient();
    return new SpritesClient(token, { timeout: 30_000 });
  }, requestTimeoutMs = 30_000 } = {}) {
  async function api(token, path, { method = 'GET', body, signal, timeoutMs = requestTimeoutMs,
    binary = false, ndjson = false, maxBytes = 64_000, acceptMissing = false } = {}) {
    checkAbort(signal);
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw failure('key-rejected');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
        ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
      });
      if (acceptMissing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw failure([401, 403].includes(response.status) ? 'key-rejected' : response.status === 429 ? 'provider-busy' : 'provider-error');
      }
      if (response.status === 204) return null;
      const bytes = await boundedBytes(response, maxBytes);
      if (binary) return bytes;
      if (!bytes.length) return null;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return ndjson ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : JSON.parse(text);
      } catch { throw failure('invalid-response'); }
    } catch (error) {
      if (error instanceof SpritesProviderError) throw error;
      throw failure(signal?.aborted ? 'cancelled' : 'network-error');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  const testConnection = async ({ token }) => {
    // Read-only authentication check. No computer is created or woken.
    await api(token, '/sprites?max_results=1');
    return { ok: true };
  };
  const destroyWorkspace = async ({ token, workspaceId }) => {
    const path = workspacePath(workspaceId);
    try { await api(token, path, { method: 'DELETE', acceptMissing: true }); }
    catch { throw failure('cleanup-unconfirmed'); }
  };
  const applyPolicies = async ({ token, workspaceId, domains = [], signal }) => {
    const path = workspacePath(workspaceId); const policy = spritesNetworkPolicy(domains);
    await api(token, `${path}/policy/network`, { method: 'POST', signal, body: policy });
    await api(token, `${path}/policy/resources`, { method: 'POST', signal, body: { memory: { limit_mb: 1024, autoscale: false } } });
    await api(token, `${path}/policy/privileges`, { method: 'POST', signal, body: { profile: 'standard', noNewPrivileges: true } });
    // POST replaces each document. Never treat acknowledgement alone as proof
    // that the host is enforcing our complete intended restrictions.
    const [network, resources, privileges] = await Promise.all(['network', 'resources', 'privileges']
      .map((kind) => api(token, `${path}/policy/${kind}`, { signal })));
    const rules = network?.rules;
    const normalizeRules = (rows) => rows.map((rule) => `${rule.domain}:${rule.action}`).sort();
    if (!Array.isArray(rules) || rules.length !== policy.rules.length
      || rules.some((rule) => !rule || typeof rule.domain !== 'string' || !['allow', 'deny'].includes(rule.action)
        || (rule.include !== undefined && rule.include !== ''))
      || JSON.stringify(normalizeRules(rules)) !== JSON.stringify(normalizeRules(policy.rules))
      || resources?.memory?.limit_mb !== 1024 || resources.memory.autoscale !== false
      || privileges?.profile !== 'standard' || privileges.noNewPrivileges !== true) throw failure('policy-unconfirmed');
  };
  const createWorkspace = async ({ token, workspaceId, domains = [], signal }) => {
    workspacePath(workspaceId); spritesNetworkPolicy(domains);
    try {
      await api(token, '/sprites', { method: 'POST', signal, timeoutMs: 120_000,
        body: { name: workspaceId, url_settings: { auth: 'sprite', private_access: 'admins' },
          config: { ram_mb: 1024, cpus: 1 }, labels: ['constellation-scratch'] } });
    } catch (error) {
      // A lost response does not prove creation failed. An immediate DELETE404
      // can race delayed provisioning; the durable job must retain a cleanup task.
      if (['network-error', 'cancelled'].includes(error.code)) error.creationUncertain = true;
      throw error;
    }
    // Do not execute any guest command before all host-enforced policies exist.
    await applyPolicies({ token, workspaceId, domains, signal });
    await writeFile({ token, workspaceId, path: `${WORKSPACE}/outputs/.constellation`, content: new Uint8Array(), signal });
    return { workspaceId };
  };
  const writeFile = async ({ token, workspaceId, path, content, signal }) => {
    const base = workspacePath(workspaceId); checkedPath(path);
    if (!(content instanceof Uint8Array) || content.byteLength > 10_000_000) throw failure('response-limit');
    const query = new URLSearchParams({ path, workingDir: WORKSPACE, mkdirParents: 'true', mode: '0600' });
    await api(token, `${base}/fs/write?${query}`, { method: 'PUT', body: content, binary: true, signal });
  };
  const readFile = async ({ token, workspaceId, path, maxBytes = 5_000_000, signal }) => {
    const base = workspacePath(workspaceId); checkedPath(path, true);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw failure('response-limit');
    const query = new URLSearchParams({ path, workingDir: WORKSPACE });
    return api(token, `${base}/fs/read?${query}`, { binary: true, maxBytes, signal });
  };
  // The API has no documented atomic no-follow flag. Walk ancestor metadata and
  // reject symlinks; callers must also serialize these operations against runs.
  // This is a guest file boundary, not a claim of race-proof hostile-guest jail.
  const directoryEntries = async ({ token, workspaceId, path, signal }) => {
    const base = workspacePath(workspaceId);
    const query = new URLSearchParams({ path, workingDir: WORKSPACE });
    const data = await api(token, `${base}/fs/list?${query}`, { signal, maxBytes: 256_000 });
    if (!data || !Array.isArray(data.entries) || data.entries.length > 1000
      || (data.path !== undefined && data.path !== path)) throw failure('invalid-response');
    const names = new Set();
    return data.entries.map((entry) => {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255
        || /[\x00-\x1f\x7f/\\]/.test(entry.name) || ['.', '..'].includes(entry.name)
        || names.has(entry.name)) throw failure('invalid-response');
      names.add(entry.name);
      const entryPath = `${path === '/' ? '' : path}/${entry.name}`;
      if (entry.path !== entryPath || !['file', 'directory', 'symlink'].includes(entry.type)
        || !Number.isSafeInteger(entry.size) || entry.size < 0
        || (entry.isDir !== undefined && entry.isDir !== (entry.type === 'directory'))) throw failure('invalid-response');
      return { name: entry.name, path: entryPath, type: entry.type, size: entry.size };
    });
  };
  const checkedEntry = async ({ token, workspaceId, path, signal, missing = false }) => {
    checkedPath(path, false, true);
    let parent = '/'; let entry;
    const parts = path.slice(1).split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const entries = await directoryEntries({ token, workspaceId, path: parent, signal });
      entry = entries.find((item) => item.name === parts[index]);
      if (!entry) { if (missing) return null; throw failure('invalid-path'); }
      if (entry.type === 'symlink' || (index < parts.length - 1 && entry.type !== 'directory')) throw failure('invalid-path');
      parent = entry.path;
    }
    return entry;
  };
  const listFiles = async ({ token, workspaceId, path = WORKSPACE, signal }) => {
    const entry = await checkedEntry({ token, workspaceId, path, signal });
    if (entry.type !== 'directory') throw failure('invalid-path');
    const entries = await directoryEntries({ token, workspaceId, path, signal });
    // Symlinks are deliberately not navigable or downloadable in this browser.
    return entries.filter((item) => item.type !== 'symlink').map((item) => {
      checkedPath(item.path); return item;
    });
  };
  const readWorkspaceFile = async ({ token, workspaceId, path, maxBytes = 5_000_000, signal }) => {
    checkedPath(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw failure('response-limit');
    const entry = await checkedEntry({ token, workspaceId, path, signal });
    if (entry.type !== 'file') throw failure('invalid-path');
    if (entry.size > maxBytes) throw failure('response-limit');
    const query = new URLSearchParams({ path, workingDir: WORKSPACE });
    return api(token, `${workspacePath(workspaceId)}/fs/read?${query}`, { binary: true, maxBytes, signal });
  };
  const clearOutputFiles = async ({ token, workspaceId, paths, signal }) => {
    const base = workspacePath(workspaceId);
    if (!Array.isArray(paths) || paths.length > 20) throw failure('invalid-path');
    const targets = [...new Set(paths.map((path) => checkedPath(typeof path === 'string' && !path.startsWith('/')
      ? `${WORKSPACE}/outputs/${path}` : path, true)))];
    for (const path of targets) {
      const entry = await checkedEntry({ token, workspaceId, path, signal, missing: true });
      if (!entry) continue;
      if (entry.type !== 'file') throw failure('invalid-path');
      const query = new URLSearchParams({ path, workingDir: WORKSPACE, recursive: 'false' });
      await api(token, `${base}/fs/delete?${query}`, { method: 'DELETE', signal, acceptMissing: true });
    }
  };
  const stopExecution = async ({ token, workspaceId, executionId, sessionId }) => {
    const base = workspacePath(workspaceId);
    // Never guess a session from command text or "latest", including recovery.
    const id = checkedRemoteId(executionId ?? sessionId, 'stop-unconfirmed');
    try {
      const events = await api(token, `${base}/exec/${encodeURIComponent(id)}/kill?signal=SIGTERM&timeout=10s`, {
        method: 'POST', ndjson: true, timeoutMs: 30_000,
      });
      const complete = terminalEvent(events, ['signal', 'timeout', 'exited', 'killed', 'error', 'complete']);
      if (!Number.isInteger(complete.exit_code)) throw failure('invalid-response');
      // This endpoint confirms the exec process group, NOT escaped processes,
      // daemonized children or Sprite-managed services elsewhere in the VM.
      return { stopped: true, executionId: id };
    } catch { throw failure('stop-unconfirmed'); }
  };
  const checkpointInfo = (data) => {
    const id = checkedRemoteId(data?.id, 'invalid-response');
    if (id === 'Current') throw failure('invalid-response');
    const createdAt = data.create_time ? new Date(data.create_time) : undefined;
    if (createdAt && !Number.isFinite(createdAt.getTime())) throw failure('invalid-response');
    if (data.health !== undefined && (typeof data.health !== 'string' || data.health.length > 200)) throw failure('invalid-response');
    return { id, ...(createdAt ? { createdAt } : {}), health: data.health ?? '',
      comment: typeof data.comment === 'string' ? data.comment.slice(0, 500) : '' };
  };
  const getCheckpoint = async ({ token, workspaceId, checkpointId, signal }) => {
    const id = checkedRemoteId(checkpointId, 'invalid-checkpoint');
    if (id === 'Current') throw failure('invalid-checkpoint');
    const info = checkpointInfo(await api(token, `${workspacePath(workspaceId)}/checkpoints/${encodeURIComponent(id)}`, { signal }));
    if (info.id !== id) throw failure('invalid-response');
    return info;
  };
  const createCheckpoint = async ({ token, workspaceId, comment = '', signal }) => {
    const base = workspacePath(workspaceId); checkAbort(signal);
    if (typeof comment !== 'string' || comment.length > 500 || /[\x00-\x1f\x7f]/.test(comment)) throw failure('invalid-checkpoint');
    try {
      const events = await api(token, `${base}/checkpoint`, { method: 'POST', body: { comment }, signal, ndjson: true, timeoutMs: 120_000 });
      const complete = terminalEvent(events, ['info', 'stdout', 'stderr', 'keepalive', 'error', 'complete'], { advisoryErrors: true });
      // Current API provides its ID in this documented terminal message, not a
      // structured field. Never infer a checkpoint from the newest list entry.
      const id = /^Checkpoint (v\d+) created(?: successfully)?[.!]?$/.exec(complete.data)?.[1];
      if (!id) throw failure('invalid-response');
      const info = await getCheckpoint({ token, workspaceId, checkpointId: id, signal });
      if (info.health) throw failure('checkpoint-unhealthy');
      return info;
    } catch (error) { if (error.code === 'checkpoint-unhealthy') throw error; throw failure('checkpoint-unconfirmed'); }
  };
  const listCheckpoints = async ({ token, workspaceId, signal }) => {
    const rows = await api(token, `${workspacePath(workspaceId)}/checkpoints`, { signal, maxBytes: 256_000 });
    if (!Array.isArray(rows) || rows.length > 1000) throw failure('invalid-response');
    return rows.filter((row) => row?.id !== 'Current').map(checkpointInfo);
  };
  const restoreCheckpoint = async ({ token, workspaceId, checkpointId, signal }) => {
    const base = workspacePath(workspaceId); const id = checkedRemoteId(checkpointId, 'invalid-checkpoint');
    if (id === 'Current') throw failure('invalid-checkpoint');
    checkAbort(signal);
    try {
      const events = await api(token, `${base}/checkpoints/${encodeURIComponent(id)}/restore`, {
        method: 'POST', signal, ndjson: true, timeoutMs: 120_000,
      });
      terminalEvent(events, ['info', 'stdout', 'stderr', 'keepalive', 'error', 'complete'], { advisoryErrors: true });
      return { restored: true, id };
    } catch { throw failure('restore-unconfirmed'); }
  };
  // This helper creates a short-lived exec session, not a user-code run. No
  // host secret enters its argv, stdin, environment, or returned result.
  const checkpointControl = async ({ token, workspaceId, signal, onSession = async () => {}, onSessionFinished = async () => {} }, input, maxOutputBytes = 256_000, program = CHECKPOINT_CONTROL) => {
    checkAbort(signal); workspacePath(workspaceId);
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(requestTimeoutMs, 30_000));
    let stdout = ''; let bytes = 0; let overflow = false; let executionId; let finishAttempted = false;
    const markFinished = async () => {
      if (!executionId || finishAttempted) return;
      finishAttempted = true; await onSessionFinished(executionId);
    };
    try {
      const result = await runPersistent({ token, cwd: '/', trustedControl: true, onSession: async (id) => {
        executionId = id; await onSession(id);
      } }, {
        workspaceId, command: ['/usr/bin/python3', '-I', '-c', program], stdin: JSON.stringify(input),
      }, { signal: controller.signal, onOutput: (chunk) => {
        bytes += Buffer.byteLength(chunk.text);
        if (bytes > maxOutputBytes) { overflow = true; controller.abort(); throw failure('response-limit'); }
        if (chunk.stream === 'stdout') stdout += chunk.text;
      } });
      // Clear only this exact helper receipt before parsing or subsequent HTTP
      // readback can fail; a verified exit must not later be mistaken for a run.
      await markFinished();
      if (overflow) throw failure('response-limit');
      if (result.exitCode !== 0) throw failure('provider-error');
      let value; try { value = JSON.parse(stdout); } catch { throw failure('invalid-response'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid-response');
      if (value.error) throw failure(['invalid-path', 'checkpoint-unavailable', 'response-limit', 'file-exists', 'file-changed', 'file-not-found', 'trash-not-found', 'invalid-content', 'invalid-action', 'file-operation-unconfirmed'].includes(value.error) ? value.error : 'provider-error');
      return value;
    } catch (error) {
      if (error.code === 'stop-unconfirmed') throw error;
      // runPersistent only rejects a known session with another code after its
      // process-group stop was confirmed. Never clear an uncertain receipt.
      await markFinished();
      if (overflow) throw failure('response-limit');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const workingRequest = (args, input = args) => {
    try { return normalizeWorkspaceMutation(input, { maxBytes: args.maxBytes ?? 5_000_000 }); }
    catch (error) { throw failure(error.code ?? 'invalid-path'); }
  };
  const fileHash = (content) => createHash('sha256').update(content).digest('hex');
  const workingEntry = async (args, path, { missing = false } = {}) => {
    const entry = await checkedEntry({ ...args, path, missing: true });
    if (!entry && !missing) throw failure('file-not-found');
    return entry;
  };
  const workingBytes = async (args, path, maxBytes) => {
    const entry = await workingEntry(args, path);
    if (entry.type !== 'file') throw failure('invalid-path');
    if (entry.size > maxBytes) throw failure('response-limit');
    const query = new URLSearchParams({ path, workingDir: WORKSPACE });
    return api(args.token, `${workspacePath(args.workspaceId)}/fs/read?${query}`, { binary: true, maxBytes, signal: args.signal });
  };
  const listWorkingFiles = async (args) => {
    const request = workingRequest(args, { action: 'list', path: args.path ?? WORKSPACE });
    const entry = await workingEntry(args, request.path);
    if (entry.type !== 'directory') throw failure('invalid-path');
    return (await directoryEntries({ ...args, path: request.path }))
      .filter((item) => item.type !== 'symlink' && !item.name.startsWith('.constellation'))
      .sort((a, b) => (a.type !== 'directory') - (b.type !== 'directory') || a.name.localeCompare(b.name));
  };
  const readWorkingFile = async (args) => {
    const request = workingRequest(args, { action: 'read', path: args.path });
    const content = await workingBytes(args, request.path, request.maxBytes);
    return { content, hash: fileHash(content) };
  };
  // Managed snapshots have a separate read ceiling. Do not relax the smaller
  // working-file editing/upload limit or permit arbitrary paths through here.
  const readAttachmentBytes = async (args) => {
    const maxBytes = args.maxBytes ?? 10_000_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw failure('response-limit');
    const parts = typeof args.path === 'string'
      ? /^\/workspace\/attachments\/([A-Za-z0-9_-]{1,160})\/([a-f0-9]{64})-(.+)$/.exec(args.path) : null;
    if (!parts) throw failure('invalid-path');
    let canonical;
    try { canonical = attachmentStoragePath({ attachmentId: parts[1], sha256: parts[2], name: parts[3] }); }
    catch { throw failure('invalid-path'); }
    if (canonical !== args.path) throw failure('invalid-path');
    return { content: await workingBytes(args, args.path, maxBytes) };
  };
  // Native Sprite FS operations have no documented atomic no-clobber, CAS or
  // no-follow options. These metadata/hash checks catch ordinary conflicts in a
  // trusted mission environment; a guest can still change files between REST
  // calls. App leases serialize app operations, not every process in the VM.
  const mutateWorkspaceFile = async (args) => {
    if (!['createFolder', 'write', 'upload', 'rename', 'move', 'copy', 'delete'].includes(args.action)
      || (args.action === 'delete' && args.confirm !== true)) throw failure('invalid-action');
    const request = workingRequest(args); const base = workspacePath(args.workspaceId);
    const { action, path, destination, maxBytes } = request;
    const parentOf = (value) => value.slice(0, value.lastIndexOf('/'));
    const requireParent = async (value) => {
      const entry = await workingEntry(args, parentOf(value));
      if (entry.type !== 'directory') throw failure('invalid-path');
    };
    const absent = async (value) => {
      await requireParent(value);
      if (await workingEntry(args, value, { missing: true })) throw failure('file-exists');
    };
    // Inspect every descendant before moving, copying or deleting a directory:
    // a parent operation must not bypass managed-file or symlink restrictions.
    const inspectTree = async (entry, budget = { entries: 0, bytes: 0 }) => {
      workingRequest(args, { action: action === 'copy' ? 'read' : 'createFolder', path: entry.path });
      if (entry.type === 'symlink') throw failure('invalid-path');
      budget.entries += 1;
      if (budget.entries > 1000) throw failure('response-limit');
      if (entry.type === 'file') {
        budget.bytes += entry.size;
        if (action === 'copy' && budget.bytes > maxBytes) throw failure('response-limit');
      } else {
        for (const child of await directoryEntries({ ...args, path: entry.path })) await inspectTree(child, budget);
      }
    };
    let started = false;
    const mutate = async (route, options) => {
      // Do not move this authorization hook above preflight or after dispatch.
      // Folder creation invokes it independently for marker creation/removal.
      await args.onMutationStart?.(); checkAbort(args.signal); started = true;
      return api(args.token, `${base}/fs/${route}`, { ...options, signal: args.signal });
    };
    try {
      const result = { action, path };
      if (action === 'createFolder') {
        await absent(path);
        // The installed SDK implements mkdir via a temporary file. Use a unique
        // marker, never its fixed .keep name, and remove only that exact marker.
        const marker = `${path}/.mkdir-${randomUUID()}.tmp`;
        const writeQuery = new URLSearchParams({ path: marker, workingDir: WORKSPACE, mkdirParents: 'true', mode: '0600' });
        await mutate(`write?${writeQuery}`, { method: 'PUT', binary: true, body: new Uint8Array() });
        const markerEntry = await workingEntry(args, marker);
        if (markerEntry.type !== 'file' || markerEntry.size !== 0
          || (await workingBytes(args, marker, 1)).byteLength !== 0) throw failure('file-operation-unconfirmed');
        const deleteQuery = new URLSearchParams({ path: marker, workingDir: WORKSPACE, recursive: 'false' });
        await mutate(`delete?${deleteQuery}`, { method: 'DELETE' });
        if (await workingEntry(args, marker, { missing: true })) throw failure('file-operation-unconfirmed');
        result.entry = await workingEntry(args, path);
        if (result.entry.type !== 'directory') throw failure('file-operation-unconfirmed');
      } else if (action === 'write' || action === 'upload') {
        await requireParent(path);
        const existing = await workingEntry(args, path, { missing: true });
        if (request.expectedHash === undefined) {
          if (existing) throw failure('file-exists');
        } else {
          if (!existing) throw failure('file-changed');
          if (existing.type !== 'file') throw failure('invalid-path');
          if (fileHash(await workingBytes(args, path, maxBytes)) !== request.expectedHash) throw failure('file-changed');
        }
        const content = Buffer.from(request.base64, 'base64');
        const query = new URLSearchParams({ path, workingDir: WORKSPACE, mkdirParents: 'false', mode: '0600' });
        await mutate(`write?${query}`, { method: 'PUT', binary: true, body: content });
        result.hash = fileHash(content);
        if (fileHash(await workingBytes(args, path, maxBytes)) !== result.hash) throw failure('file-operation-unconfirmed');
        result.entry = await workingEntry(args, path);
      } else {
        const source = await workingEntry(args, path);
        if (destination === path || destination?.startsWith(`${path}/`)) throw failure('invalid-path');
        await inspectTree(source);
        if (action === 'delete') {
          const query = new URLSearchParams({ path, workingDir: WORKSPACE, recursive: String(source.type === 'directory') });
          await mutate(`delete?${query}`, { method: 'DELETE' });
          if (await workingEntry(args, path, { missing: true })) throw failure('file-operation-unconfirmed');
          result.deleted = true;
        } else {
          await absent(destination);
          const route = action === 'copy' ? 'copy' : 'rename';
          await mutate(route, { method: 'POST', body: { source: path, dest: destination, workingDir: WORKSPACE,
            ...(action === 'copy' ? { recursive: source.type === 'directory' } : {}) } });
          result.destination = destination; result.entry = await workingEntry(args, destination);
          if (result.entry.type !== source.type || (source.type === 'file' && result.entry.size !== source.size)
            || (action !== 'copy' && await workingEntry(args, path, { missing: true }))) throw failure('file-operation-unconfirmed');
        }
      }
      return result;
    } catch (error) {
      // Once a write was dispatched, even a later read/auth failure leaves an
      // uncertain operation. Never report a safe conflict or replay it blindly.
      if (started) throw failure('file-operation-unconfirmed');
      throw error;
    }
  };
  const checkpointTarget = async (args, allowRoot) => {
    const path = args.path ?? WORKSPACE; checkedPath(path, false, allowRoot);
    const info = await getCheckpoint(args);
    if (info.health) throw failure('checkpoint-unhealthy');
    return { id: info.id, path };
  };
  const listCheckpointFiles = async (args) => {
    const target = await checkpointTarget(args, true);
    const result = await checkpointControl(args, { ...target, action: 'list' });
    if (!Array.isArray(result.entries) || result.entries.length > 1000) throw failure('invalid-response');
    const names = new Set();
    return result.entries.map((entry) => {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255
        || /[\x00-\x1f\x7f/\\]/.test(entry.name) || ['.', '..'].includes(entry.name) || names.has(entry.name)
        || entry.path !== `${target.path}/${entry.name}` || !['file', 'directory'].includes(entry.type)
        || !Number.isSafeInteger(entry.size) || entry.size < 0) throw failure('invalid-response');
      names.add(entry.name); checkedPath(entry.path);
      return { name: entry.name, path: entry.path, type: entry.type, size: entry.size };
    });
  };
  const readCheckpointFile = async (args) => {
    const maxBytes = args.maxBytes ?? 5_000_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw failure('response-limit');
    const target = await checkpointTarget(args, false);
    const result = await checkpointControl(args, { ...target, action: 'read', maxBytes }, Math.ceil(maxBytes / 3) * 4 + 2048);
    if (typeof result.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64)) throw failure('invalid-response');
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.length > maxBytes) throw failure('response-limit');
    return bytes;
  };
  const deleteCheckpoint = async ({ token, workspaceId, checkpointId, signal, onSession, onSessionFinished }) => {
    const id = checkedRemoteId(checkpointId, 'invalid-checkpoint');
    if (id === 'Current') throw failure('checkpoint-current');
    try {
      if (!(await listCheckpoints({ token, workspaceId, signal })).some((row) => row.id === id)) return { deleted: true, id };
      // The documented local socket exposes DELETE; the pinned SDK has no
      // remote delete method. Use that exact route, then independently read back.
      const result = await checkpointControl({ token, workspaceId, signal, onSession, onSessionFinished }, { action: 'delete', id });
      if ([400, 409].includes(result.status)) throw failure('checkpoint-current');
      if (!(Number.isInteger(result.status) && ((result.status >= 200 && result.status < 300) || [404, 405].includes(result.status)))) throw failure('checkpoint-delete-unconfirmed');
      // Some released Sprite runtimes lack this documented local route. A 404
      // alone is ambiguous; only a successful independent inventory can prove
      // that the save point remains and classify the response as unsupported.
      if ((await listCheckpoints({ token, workspaceId, signal })).some((row) => row.id === id)) {
        throw failure([404, 405].includes(result.status) ? 'checkpoint-delete-unsupported' : 'checkpoint-delete-unconfirmed');
      }
      return { deleted: true, id };
    } catch (error) {
      if (['stop-unconfirmed', 'checkpoint-current', 'checkpoint-delete-unsupported'].includes(error.code)) throw error;
      throw failure('checkpoint-delete-unconfirmed');
    }
  };
  const serviceName = (name) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw failure('invalid-service');
    return name;
  };
  const serviceInfo = (data, token) => {
    const name = serviceName(data?.name);
    const clean = (value, length) => {
      if (typeof value !== 'string' || value.length > length || /[\x00-\x1f\x7f]/.test(value)) throw failure('invalid-response');
      return token ? value.split(token).join('[redacted]') : value;
    };
    const args = data.args ?? [];
    if (!Array.isArray(args) || args.length > 100) throw failure('invalid-response');
    const status = data.state?.status ?? 'unknown';
    if (!['unknown', 'stopped', 'starting', 'running', 'stopping', 'failed'].includes(status)) throw failure('invalid-response');
    if (data.http_port != null && (!Number.isInteger(data.http_port) || data.http_port < 1 || data.http_port > 65535)) throw failure('invalid-response');
    return { name, command: clean(data.cmd, 2048), args: args.map((arg) => clean(arg, 4096)), status,
      ...(typeof data.dir === 'string' ? { directory: clean(data.dir, 1024) } : {}),
      ...(data.http_port != null ? { httpPort: data.http_port } : {}),
      ...(Number.isSafeInteger(data.state?.pid) && data.state.pid > 0 ? { pid: data.state.pid } : {}),
      ...(typeof data.state?.started_at === 'string' && Number.isFinite(Date.parse(data.state.started_at))
        ? { startedAt: new Date(data.state.started_at) } : {}) };
  };
  const listServices = async ({ token, workspaceId, signal }) => {
    const data = await api(token, `${workspacePath(workspaceId)}/services`, { signal, maxBytes: 256_000 });
    const rows = Array.isArray(data) ? data : data?.services;
    if (!Array.isArray(rows) || rows.length > 100) throw failure('invalid-response');
    const result = rows.map((row) => serviceInfo(row, token));
    if (new Set(result.map((row) => row.name)).size !== result.length) throw failure('invalid-response');
    return result;
  };
  const getService = async ({ token, workspaceId, name, signal }) => {
    serviceName(name);
    const row = serviceInfo(await api(token, `${workspacePath(workspaceId)}/services/${encodeURIComponent(name)}`, { signal }), token);
    if (row.name !== name) throw failure('invalid-response');
    return row;
  };
  const privateSprite = async ({ token, workspaceId, signal }) => {
    const data = await api(token, workspacePath(workspaceId), { signal });
    if (data?.name !== workspaceId || data.url_settings?.auth !== 'sprite'
      || data.url_settings.private_access !== 'admins' || typeof data.url !== 'string') throw failure('private-preview-unavailable');
    let url; try { url = new URL(data.url); } catch { throw failure('private-preview-unavailable'); }
    if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.sprites\.app$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw failure('private-preview-unavailable');
    return { url: url.href, auth: 'sprite', privateAccess: 'admins' };
  };
  const getPrivatePreview = async (args) => {
    const [preview, service] = await Promise.all([privateSprite(args), getService(args)]);
    if (!service.httpPort) throw failure('private-preview-unavailable');
    return preview;
  };
  const serviceMutation = async (args, action, body) => {
    const { token, workspaceId, name, signal } = args; serviceName(name);
    try {
      if (action !== 'stop') await privateSprite(args);
      const suffix = action === 'save' ? '?duration=1s' : `/${action}?${action === 'stop' ? 'timeout=10s' : 'duration=1s'}`;
      const events = await api(token, `${workspacePath(workspaceId)}/services/${encodeURIComponent(name)}${suffix}`, {
        method: action === 'save' ? 'PUT' : 'POST', body, signal, ndjson: true, timeoutMs: 30_000,
      });
      terminalEvent(events, ['stdout', 'stderr', 'exit', 'error', 'complete', 'started', 'stopping', 'stopped']);
      const service = await getService(args);
      if (action === 'stop' && !['stopped', 'failed'].includes(service.status)) throw failure('service-unconfirmed');
      return service;
    } catch (error) {
      if (error.code === 'private-preview-unavailable') throw error;
      throw failure('service-unconfirmed');
    }
  };
  const saveService = async ({ command, args = [], directory = WORKSPACE, httpPort = 8080, ...options }) => {
    serviceName(options.name); checkedPath(directory, false, true);
    if (typeof command !== 'string' || !command || command.length > 2048 || /[\x00-\x1f\x7f]/.test(command)
      || !Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))
      || Buffer.byteLength(JSON.stringify(args)) > 16_000 || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw failure('invalid-service');
    // Deliberately no env, dependency chain, URL-auth mutation, or arbitrary
    // host paths. PUT starts the service; callers must make that explicit.
    return serviceMutation(options, 'save', { cmd: command, args, dir: directory, http_port: httpPort, needs: [] });
  };
  const startService = (args) => serviceMutation(args, 'start');
  const stopService = (args) => serviceMutation(args, 'stop');
  const deleteService = async ({ token, workspaceId, name, signal }) => {
    serviceName(name);
    try {
      await api(token, `${workspacePath(workspaceId)}/services/${encodeURIComponent(name)}`, { method: 'DELETE', signal, acceptMissing: true });
      if ((await listServices({ token, workspaceId, signal })).some((row) => row.name === name)) throw failure('service-unconfirmed');
      return { deleted: true, name };
    } catch { throw failure('service-unconfirmed'); }
  };
  const runPersistent = async ({ token, cwd, onSession, trustedControl = false }, request, { signal, onOutput }) => {
    const { workspaceId, command, stdin } = request;
    const base = workspacePath(workspaceId);
    if (!(trustedControl && cwd === '/')) checkedPath(cwd, false, true);
    checkAbort(signal);
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw failure('key-rejected');
    if (typeof onSession !== 'function' || !Array.isArray(command) || !command.length
      || command.some((part) => typeof part !== 'string' || part.includes('\0'))
      || (stdin !== undefined && typeof stdin !== 'string')) throw failure('invalid-response');
    const gate = 'IFS= read -r gate || exit 125; [ "$gate" = "constellation-ready" ] || exit 125; exec "$@"';
    const query = new URLSearchParams({ path: '/bin/sh', dir: cwd, tty: 'false', stdin: 'true', max_run_after_disconnect: '1s' });
    for (const arg of ['/bin/sh', '-c', gate, 'constellation-gate', ...command]) query.append('cmd', arg);
    for (const env of ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/sprite', 'LANG=C.UTF-8', 'PYTHONUNBUFFERED=1']) query.append('env', env);
    return new Promise((resolveRun, rejectRun) => {
      let socket; let ending = false; let executionId; let persisted = false; let persistPromise; let exitCode;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const release = () => {
        clearTimeout(handshakeTimer); signal?.removeEventListener('abort', stop);
        socket?.removeEventListener('message', message); socket?.removeEventListener('close', close);
        socket?.removeEventListener('error', transportError);
        try { socket?.close(); } catch { /* A closed transport says nothing about guest state. */ }
      };
      const terminate = async (error) => {
        if (ending) return; ending = true; release();
        // Persistent files must never be destroyed to implement Stop. Missing
        // identity or failed termination quarantines the environment instead.
        try { await stopExecution({ token, workspaceId, executionId }); rejectRun(error); }
        catch { rejectRun(failure('stop-unconfirmed')); }
      };
      const stop = () => { void terminate(failure('cancelled')); };
      const transportError = () => { void terminate(failure('network-error')); };
      const close = () => { if (exitCode === undefined) transportError(); };
      const finish = async (code) => {
        if (ending || exitCode !== undefined) return;
        if (!Number.isInteger(code) || code < 0 || !executionId) { transportError(); return; }
        exitCode = code;
        try {
          await persistPromise;
          if (ending) return;
          if (!persisted) throw failure('invalid-response');
          for (const [stream, decoder] of Object.entries(decoders)) {
            const text = decoder.end(); if (text) onOutput({ stream, text });
          }
          if (ending) return;
          ending = true; release(); resolveRun({ exitCode: code, executionId });
        } catch { void terminate(failure('provider-error')); }
      };
      const message = (event) => {
        if (ending) return;
        try {
          if (typeof event.data === 'string') {
            if (Buffer.byteLength(event.data) > 16_000) throw failure('response-limit');
            const data = JSON.parse(event.data);
            if (data.type === 'session_info') {
              const id = checkedRemoteId(data.session_id);
              if (executionId && executionId !== id) throw failure('invalid-response');
              if (executionId) return;
              // A newly created non-TTY session reports is_owner:false. That
              // attachment/terminal flag is not an authorization receipt; the
              // official non-PTY client keys execution on session_id as well.
              // This connection only creates new execs, never attaches by ID.
              if (data.tty === true) throw failure('invalid-response');
              executionId = id;
              persistPromise = Promise.resolve().then(() => onSession(id)).then(() => {
                if (ending) return;
                persisted = true; clearTimeout(handshakeTimer);
                // No user program starts until the remote ID is durable. stdin
                // is sent separately, preserving binary/text contents after read.
                socket.send(Buffer.concat([Buffer.from([0]), Buffer.from('constellation-ready\n')]));
                const input = Buffer.from(stdin ?? '');
                for (let offset = 0; offset < input.length; offset += 64_000) {
                  socket.send(Buffer.concat([Buffer.from([0]), input.subarray(offset, offset + 64_000)]));
                }
                socket.send(Buffer.from([4]));
              });
              void persistPromise.catch(() => terminate(failure('provider-error')));
            } else if (data.type === 'exit') void finish(data.exit_code);
            // Sprites emits bounded diagnostic JSON before session_info as well
            // as during execution. It is not guest stdout or a session receipt.
            else if (!['debug', 'port_opened', 'port_closed'].includes(data.type)) throw failure('invalid-response');
            return;
          }
          const frame = Buffer.from(event.data);
          if (frame[0] === 3 && frame.length === 2) { void finish(frame[1]); return; }
          const stream = frame[0] === 1 ? 'stdout' : frame[0] === 2 ? 'stderr' : null;
          if (!stream) throw failure('invalid-response');
          const text = decoders[stream].write(frame.subarray(1));
          if (text) onOutput({ stream, text });
        } catch { void terminate(failure('invalid-response')); }
      };
      const handshakeTimer = setTimeout(() => { void terminate(failure('network-error')); }, requestTimeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) { clearTimeout(handshakeTimer); signal.removeEventListener('abort', stop); rejectRun(failure('cancelled')); return; }
      try {
        socket = webSocketFactory(`wss://api.sprites.dev/v1${base}/exec?${query}`, { headers: { Authorization: `Bearer ${token}` } });
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('message', message); socket.addEventListener('close', close); socket.addEventListener('error', transportError);
      } catch { void terminate(failure('network-error')); }
    });
  };
  const createSpritesProvider = ({ token, persistent = false, onSession, cwd = WORKSPACE }) => ({
    async run(request, { signal, onOutput }) {
      if (persistent) return runPersistent({ token, cwd, onSession }, request, { signal, onOutput });
      const { workspaceId, command, stdin } = request;
      workspacePath(workspaceId); checkAbort(signal);
      const client = await clientFactory(token); checkAbort(signal);
      return new Promise((resolve, reject) => {
        let cmd; let ending = false;
        const stdout = new StringDecoder('utf8'); const stderr = new StringDecoder('utf8');
        const release = () => { signal?.removeEventListener('abort', stop); cmd?.close?.(); };
        const terminate = async (error) => {
          if (ending) return; ending = true;
          release();
          // Disconnect is not cancellation: destroy the isolated run, including
          // detached children. Do not report success until deletion is confirmed.
          try { await destroyWorkspace({ token, workspaceId }); reject(error); }
          catch (cleanupError) { reject(cleanupError); }
        };
        const stop = () => { void terminate(failure('cancelled')); };
        const emit = (stream, bytes) => {
          if (ending) return;
          try { const text = (stream === 'stdout' ? stdout : stderr).write(bytes); if (text) onOutput({ stream, text }); }
          catch { void terminate(failure('provider-error')); }
        };
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) { stop(); return; }
        try {
          cmd = client.sprite(workspaceId).spawn(command[0], command.slice(1), {
            cwd: WORKSPACE, tty: false, detachable: false, maxRunAfterDisconnect: '1s',
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/sprite', LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1' },
          });
          cmd.on('error', () => { void terminate(failure('network-error')); });
          cmd.stdout.on('data', (chunk) => emit('stdout', chunk));
          cmd.stderr.on('data', (chunk) => emit('stderr', chunk));
          cmd.on('spawn', () => { if (!ending) cmd.stdin.end(stdin ?? ''); });
          cmd.on('exit', (exitCode) => {
            if (ending) return;
            if (!Number.isInteger(exitCode) || exitCode < 0) { void terminate(failure('network-error')); return; }
            try {
              for (const [stream, decoder] of [['stdout', stdout], ['stderr', stderr]]) {
                const text = decoder.end(); if (text) onOutput({ stream, text });
              }
            } catch { void terminate(failure('provider-error')); return; }
            if (ending) return;
            ending = true; release(); resolve({ exitCode });
          });
        } catch { void terminate(failure('provider-error')); }
      });
    },
  });
  return { testConnection, inspectConnections: (args) => inspectSpritesConnections({ ...args, fetchImpl }),
    createWorkspace, applyPolicies, writeFile, readFile, listFiles, readWorkspaceFile, listWorkingFiles, readWorkingFile, readAttachmentBytes, mutateWorkspaceFile,
    clearOutputFiles, createCheckpoint, getCheckpoint, listCheckpoints, restoreCheckpoint, deleteCheckpoint,
    listCheckpointFiles, checkpointFiles: listCheckpointFiles, readCheckpointFile,
    listServices, getService, saveService, startService, stopService, deleteService, getPrivatePreview,
    stopExecution, destroyWorkspace, createSpritesProvider };
}

export const spritesAdapter = createSpritesAdapter();
export const { testConnection, inspectConnections, createWorkspace, applyPolicies, writeFile, readFile, listFiles, readWorkspaceFile, listWorkingFiles, readWorkingFile, readAttachmentBytes, mutateWorkspaceFile,
  clearOutputFiles, createCheckpoint, getCheckpoint, listCheckpoints, restoreCheckpoint, deleteCheckpoint,
  listCheckpointFiles, checkpointFiles, readCheckpointFile,
  listServices, getService, saveService, startService, stopService, deleteService, getPrivatePreview,
  stopExecution, destroyWorkspace, createSpritesProvider } = spritesAdapter;
