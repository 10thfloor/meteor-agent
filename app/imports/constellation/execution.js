export const EXECUTION_TOOL_NAME = 'run_code';
export const EXECUTION_DEFAULT_POLICY = Object.freeze({ run: 'disabled' });
export const EXECUTION_DEFAULT_LIMITS = Object.freeze({ timeoutSeconds: 60, maxRunsPerMission: 20, maxOutputBytes: 64000, maxArtifactBytes: 5000000 });
export const EXECUTION_ACTIVE_STATES = Object.freeze(['queued', 'preparing', 'running', 'stopping']);
export class ExecutionValidationError extends Error {
  constructor(reason) { super(reason); this.error = 'invalid-execution'; this.reason = reason; }
}
const invalid = (reason) => { throw new ExecutionValidationError(reason); };
export function executionObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected execution settings.');
  return value;
}
export function executionText(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) invalid(`${label} is required and must be ${max} characters or fewer.`);
  return value.trim();
}
export function normalizeExecutionPolicy(input = {}) {
  executionObject(input); const run = input.run ?? 'disabled';
  if (!['disabled', 'ask', 'auto'].includes(run)) invalid('Choose access off, ask each run, or allow automatically.');
  return { run };
}
export function normalizeExecutionLimits(input = {}) {
  executionObject(input); const limits = {};
  for (const [key, min, max] of [['timeoutSeconds', 1, 300], ['maxRunsPerMission', 1, 100], ['maxOutputBytes', 1024, 256000], ['maxArtifactBytes', 1024, 10000000]]) {
    const value = input[key] ?? EXECUTION_DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${key} must be between ${min} and ${max}.`);
    limits[key] = value;
  }
  return limits;
}
export function normalizeExecutionDomains(input = []) {
  if (!Array.isArray(input) || input.length > 32) invalid('Allow at most 32 domain names.');
  return [...new Set(input.map((value) => {
    const domain = executionText(value, 'Domain', 253).toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
      || /(?:^|\.)(?:localhost|local|internal|metadata|test|invalid)$/.test(domain)) invalid('Use exact public domain names, without URLs, ports, IP addresses, or wildcards.');
    return domain;
  }))];
}
export function normalizeExecutionPath(value) {
  const path = executionText(value, 'Output path', 160);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./ -]*$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || path.endsWith('/')) invalid('Output paths must be relative files inside /workspace/outputs.');
  return path;
}
export function normalizeEnvironmentPath(value = '/workspace', directory = false) {
  const input = value === '' && directory ? '/workspace' : executionText(value, 'Workspace path', 512);
  const path = input.startsWith('/') ? input : `/workspace/${input}`;
  if (directory && (path === '/workspace' || path === '/workspace/')) return '/workspace';
  if (!path.startsWith('/workspace/') || /[\x00-\x1f\\]/.test(path)
    || path.slice('/workspace/'.length).split('/').some((part) => !part || part === '.' || part === '..')) invalid('Choose a path inside /workspace.');
  return path;
}
export function normalizeExecutionInput(input) {
  executionObject(input);
  if (!['python', 'javascript', 'shell'].includes(input.language)) invalid('Choose Python, JavaScript, or shell.');
  executionText(input.code, 'Code', 32000); const code = input.code;
  if (input.inputFileIds !== undefined) invalid('Use files already in /workspace or select chat attachments as inputs.');
  const ids = input.inputAttachmentIds ?? []; const paths = input.outputPaths ?? [];
  if (!Array.isArray(ids) || ids.length > 8 || !Array.isArray(paths) || paths.length > 8) invalid('Choose at most eight input and eight output files.');
  return { language: input.language, title: executionText(input.title, 'Run title', 120), code,
    inputAttachmentIds: [...new Set(ids.map((id) => executionText(id, 'Attachment', 160)))],
    outputPaths: [...new Set(paths.map(normalizeExecutionPath))] };
}
export function executionToolAccess(crew, settings = {}) {
  const assignedAgents = crew.filter((row) => row.enabled && row.status !== 'archived' && settings.agentPolicies?.[row.agent]?.run !== 'disabled'
    && ['ask', 'auto'].includes(settings.agentPolicies?.[row.agent]?.run)).map((row) => row.agent);
  const available = settings.enabled && settings.providerConfigured && settings.connectionStatus === 'connected';
  const statusLabel = !settings.enabled ? 'Connection off' : !settings.providerConfigured ? 'Needs token'
    : settings.connectionStatus !== 'connected' ? 'Test connection' : !assignedAgents.length ? 'Access off' : 'Available';
  return { assignedAgents, agents: available ? assignedAgents : [], status: available && assignedAgents.length ? 'ready' : 'unavailable', statusLabel,
    availabilityNote: statusLabel === 'Available' ? 'Isolated runs · mission crew and approval rules apply' : statusLabel };
}
