import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSchema } from './providers/types';
import type { FromSchema } from '../common/schema';
import { loadTypebox, typeboxValueResolvable } from './providers/loader';
import {
  callMcpTool, discoverMcpTools, sanitizeMcpReason, warnMcp, type McpToolInfo,
} from './mcp/client';

/* GATES (§7): auto/ask/predicate. Predicate ctx.userId is the CALLER's, never
 * runAs. Verdicts: true=run, false=denied result, 'ask'=park. Fails closed. */

/** What a predicate gate is handed. The CALLER's identity, never `runAs`. */
export interface GateContext {
  /** The session's owner — the human (or `null`, an anonymous capability-URL
   *  holder) on whose behalf the model is asking. */
  userId: string | null;
  sessionId: string;
  /** The tool's name as the model called it. */
  name: string;
  /** The model's arguments, unvalidated: a gate runs BEFORE dispatch, so this
   *  is exactly what the model emitted. Treat it as untrusted input. */
  args: unknown;
}

export type GatePredicate =
  (ctx: GateContext) => boolean | 'ask' | Promise<boolean | 'ask'>;

/** `'auto'` | `'ask'` | a predicate — see the GATES note above. */
export type Gate = 'auto' | 'ask' | GatePredicate;

export interface ToolContext {
  /** Who this tool runs AS. Normally the session's owner; a spec with `runAs`
   *  replaces it for that one tool — see `RUNAS_NOTE` and `runTool`. */
  userId: string | null;
  sessionId: string;
  /** Set by loop dispatch; optional for direct `runTool` callers. */
  toolCallId?: string;
  /** Committed assistant Message that contains this Tool call. Set by loop
   * dispatch so built-in provenance never depends on model arguments. */
  assistantMessageId?: string;
  // Set by loop dispatch; optional for direct callers.
  agent?: string;
  /** Stable Agent Identity and its frozen Turn frame. Built-in learning Tools
   * require both and never accept either from model arguments. */
  agentId?: string;
  memoryFrameId?: string;
  /** Present only when `runAs` replaced `userId`; the real caller. */
  callerUserId?: string | null;
  /** Whether the provider supports image input (§9); `read_attachment` gates on it. */
  imageInput?: boolean;
  /** Stamp an attachment ref onto this call's tool row (§9). Set by dispatch. */
  attachToResult?: (ref: import('../common/types').AttachmentRef) => void;
}

/* RUNAS_NOTE: privilege escalation by construction — gate or fence every
 * `runAs` tool. `null` = anonymous service context, omit = inherit session's
 * user. Only inline and adopted specs; subagent/MCP are refused. */

export type InlineTool = {
  name: string;
  description: string;
  args: unknown;
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
  gate?: Gate;
  /** Run this tool as a FIXED user instead of the session's owner (`null` =
   *  anonymous service context). Privilege escalation by construction —
   *  read THE `runAs` NOTE above before using it. */
  runAs?: string | null;
  /** Human-readable one-liner for the approval bar (§8). Advisory; a throw just means no display. */
  describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) =>
    string | Promise<string>;
};

export type AdoptedTool = {
  method: string;
  description: string;
  args: unknown;
  name?: string;
  gate?: Gate;
  /** The method's `this.userId` for calls the MODEL makes through this listing
   *  (your UI's own `Meteor.callAsync` is unaffected). Privilege escalation by
   *  construction — read `RUNAS_NOTE` above before using it. */
  runAs?: string | null;
  /** See `InlineTool.describe` — the same park-time legibility seam. */
  describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) =>
    string | Promise<string>;
};

/** A tool that runs a CHILD SESSION of the named agent and returns its final
 *  text. `name` defaults to the agent's own name. */
export type SubagentTool = {
  subagent: string;
  description: string;
  /** Defaults to `SUBAGENT_ARGS`. A custom schema is legal; see
   *  `subagentPrompt` in server/subagent.ts for how its arguments become the
   *  child's first user message. */
  args?: unknown;
  name?: string;
  gate?: Gate;
};

/** The default subagent argument schema: one string, the child's first user
 *  message. Deliberately minimal — a subagent is given a task in prose, and
 *  every additional field is one more thing the parent model can get wrong. */
export const SUBAGENT_ARGS = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
} as const;

/** A tool on an MCP server. Single-tool form names `mcp.tool`; omit it
 *  to expose the whole server. Metadata filled by `expandMcpTools`. */
export type McpTool = {
  mcp: { server: string; tool?: string };
  description?: string;
  args?: unknown;
  /** Single-tool form only: expose it to the model under a different name. */
  name?: string;
  gate?: Gate;
};

export type ToolSpec = InlineTool | AdoptedTool | SubagentTool | McpTool | string;

/* Typed argument wrappers: `tool()` and `methodTool()` infer `run`/`describe`
 * arg types from the schema. Existing untyped specs compile unchanged. */

// `InlineTool` with `args` preserved so `run` and `describe` get typed arguments.
export type TypedInlineTool<S> = {
  name: string;
  description: string;
  args: S;
  run: (args: FromSchema<S>, ctx: ToolContext) => Promise<unknown>;
  gate?: Gate;
  // See `runAs` note above.
  runAs?: string | null;
  describe?: (args: FromSchema<S>, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) =>
    string | Promise<string>;
};

// Same for `AdoptedTool`.
export type TypedAdoptedTool<S> = {
  method: string;
  description: string;
  args: S;
  name?: string;
  gate?: Gate;
  runAs?: string | null;
  describe?: (args: FromSchema<S>, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) =>
    string | Promise<string>;
};

// Wrap a tool spec so `run` and `describe` get typed arguments from the schema.
// Returns the spec unchanged at run time — the `const` type parameter preserves
// literal types so inference works.
export function tool<const S>(spec: TypedInlineTool<S>): InlineTool {
  return spec as unknown as InlineTool;
}

// `tool()` for an adopted Meteor method.
export function methodTool<const S>(spec: TypedAdoptedTool<S>): AdoptedTool {
  return spec as unknown as AdoptedTool;
}

export interface ResolvedTool {
  name: string;
  description: string;
  args: unknown;
  /** Never undefined here: `resolveTools` defaults a missing gate to `'auto'`
   *  and refuses anything that is not a literal or a function. */
  gate: Gate;
  kind: 'inline' | 'adopted' | 'subagent' | 'mcp';
  method?: string;
  run?: (args: any, ctx: ToolContext) => Promise<unknown>;
  /** `kind: 'subagent'` only: the REGISTRY NAME of the agent to run. Resolved
   *  to a config at dispatch, never here — see `resolveTools`. */
  subagent?: string;
  /** `kind: 'mcp'` only. `tool` absent means the WHOLE SERVER: a placeholder
   *  that `expandMcpTools` replaces with one entry per discovered tool, and
   *  that never reaches dispatch. */
  mcp?: { server: string; tool?: string };
  /** `kind: 'mcp'` only: which metadata the SPEC set, so discovery fills in
   *  only the rest. */
  mcpExplicit?: { description: boolean; args: boolean };
  /** `inline`/`adopted` only. `null` = anonymous; check `!== undefined`. */
  runAs?: string | null;
  /** Park-time legibility hook (§8); must survive projection to dispatch. */
  describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) =>
    string | Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: { error: string; reason?: string };
}

/** The verdict shape. `reason` names the offending FIELD and never echoes its
 *  value: it is fed back to the model and, through the tool row, published. */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** A pluggable argument checker. May be async — a host injecting a validator
 *  that has to load a library lazily returns a promise. */
export type ArgsValidator =
  (schema: unknown, args: unknown) => ValidationResult | Promise<ValidationResult>;

/* Argument validation — degrade ladder: (1) app validator, (2) compiled
 * typebox, (3) interpreted typebox, (4) minimal structural checker. */

type Schema = Record<string, any>;

const ARTICLE: Record<string, string> = {
  object: 'an object', array: 'an array', string: 'a string',
  number: 'a number', integer: 'an integer', boolean: 'a boolean', null: 'null',
};

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const label = (path: string) => (path ? `field "${path}"` : 'arguments');

function typeNames(schema: Schema): string[] {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    // A type keyword we do not model is ACCEPTED — see the checker's contract.
    default: return true;
  }
}

const describeTypes = (types: string[]) =>
  types.map((t) => ARTICLE[t] ?? `of type ${t}`).join(' or ');

/** Minimal structural check: type, properties+required, items only.
 *  Accepts anything it does not understand; never rejects valid args. */
function checkStructure(schema: unknown, value: unknown, path: string): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Schema;

  const types = typeNames(s);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return `${label(path)} must be ${describeTypes(types)}`;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key !== 'string') continue;
        // `undefined` counts as absent: it is what a present-but-empty key
        // deserializes to, and no schema can be satisfied by it.
        if (!(key in obj) || obj[key] === undefined) {
          return `missing required field "${join(path, key)}"`;
        }
      }
    }
    if (s.properties && typeof s.properties === 'object') {
      for (const [key, sub] of Object.entries(s.properties as Schema)) {
        if (!(key in obj) || obj[key] === undefined) continue;   // optional, absent
        const reason = checkStructure(sub, obj[key], join(path, key));
        if (reason) return reason;
      }
    }
  }

  // Tuple `items` (an array of schemas) is not modelled — see the contract.
  if (Array.isArray(value) && s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
    for (let i = 0; i < value.length; i += 1) {
      const reason = checkStructure(s.items, value[i], `${path}[${i}]`);
      if (reason) return reason;
    }
  }

  return null;
}

const structuralValidator = (schema: unknown, args: unknown): ValidationResult => {
  const reason = checkStructure(schema, args, '');
  return reason === null ? { ok: true } : { ok: false, reason };
};

/* ---------------- the full checker (typebox `Value`) ---------------- */

/** The slice of typebox's `value` namespace this package uses. */
export interface TypeboxValue {
  Check(schema: unknown, value: unknown): boolean;
  Errors(schema: unknown, value: unknown): Iterable<TypeboxError>;
}

interface TypeboxError {
  keyword?: string;
  instancePath?: string;
  params?: Record<string, any>;
  message?: string;
}

/** `/customer/id` -> `customer.id`; `/ids/1` -> `ids[1]`; `` -> ``. The dotted
 *  form the structural checker already reports, so one reason vocabulary
 *  serves both checkers. */
function dottedPath(instancePath: string | undefined): string {
  if (!instancePath) return '';
  let out = '';
  for (const raw of instancePath.split('/')) {
    if (raw === '') continue;
    // JSON Pointer escapes; `~1` is `/` and `~0` is `~`, in that order.
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (/^\d+$/.test(seg)) out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** One typebox error to a reason string. Names the field, never the value. */
/** Clamp instance-derived property names so a long key cannot ride the reason. */
function clampName(name: string): string {
  return name.length > 64 ? `${name.slice(0, 61)}…` : name;
}

function reasonFor(err: TypeboxError): string {
  const path = dottedPath(err.instancePath);
  if (err.keyword === 'required') {
    const missing = (err.params?.requiredProperties ?? [])[0];
    if (typeof missing === 'string') {
      return `missing required field "${join(path, clampName(missing))}"`;
    }
  }
  if (err.keyword === 'additionalProperties') {
    const extra = (err.params?.additionalProperties ?? [])[0];
    if (typeof extra === 'string') {
      return `unexpected field "${join(path, clampName(extra))}" is not allowed by the schema`;
    }
  }
  if (err.keyword === 'propertyNames') {
    // typebox's own message interpolates the offending (instance-derived)
    // names; ours names only the location.
    return `${label(path)} contains a property whose name is not allowed by the schema`;
  }
  return `${label(path)} ${err.message ?? 'does not match the schema'}`;
}

/* ------------- the compiled-schema cache (typebox `Compile`) ------------- */

/** What `Compile(schema)` returns, narrowed to what this package calls.
 *  `Errors` is optional ON PURPOSE: 1.3.7 has it (probed), and a release that
 *  drops it must degrade to `Value.Errors` rather than crash a tool call. */
export interface TypeboxValidator {
  Check(value: unknown): boolean;
  Errors?(value: unknown): Iterable<TypeboxError>;
}

/** The slice of typebox's `compile` namespace this package uses. */
export interface TypeboxCompile {
  Compile(schema: unknown): TypeboxValidator;
}

type CompileLoader = () => Promise<TypeboxCompile>;

/** Default: typebox's `Compile` through the same loader seam `Value` uses. */
async function defaultCompileLoader(): Promise<TypeboxCompile> {
  const ns: any = await loadTypebox('compile');
  // 1.3.7 exports `Compile` by name and as `default`. Prefer the name.
  const Compile = typeof ns?.Compile === 'function'
    ? ns.Compile
    : (typeof ns?.default === 'function' ? ns.default : null);
  if (!Compile) throw new Error('typebox/compile exposes no Compile');
  return { Compile: (schema: unknown) => Compile(schema) };
}

let compileLoader: CompileLoader | null = defaultCompileLoader;
let compileModule: TypeboxCompile | null = null;
let compilePromise: Promise<TypeboxCompile | null> | null = null;
/** `Compile` was tried and failed; rung 3 (`Value.Check`) stands in. */
let compileDegraded = false;

/** Weak so MCP rediscovery doesn't pin stale schemas. `null` = negative cache. */
let compiledCache = new WeakMap<object, TypeboxValidator | null>();

/** The compile module, or null once it is known to be unreachable. Same lazy/
 *  cached/latched shape as `fullChecker` — see the note there about `finally`. */
async function compileChecker(): Promise<TypeboxCompile | null> {
  if (compileModule) return compileModule;
  if (compileDegraded || !compileLoader) return null;
  if (!compilePromise) {
    const loader = compileLoader;
    compilePromise = loader()
      .then((C) => { compileModule = C; return C; })
      .catch(() => {
        compileDegraded = true;
        warnUnavailable(
          'the compiled JSON-Schema checker (typebox/compile) could not be loaded; validation '
          + 'still runs, interpreted, through Value.Check',
        );
        return null;
      })
      .finally(() => { compilePromise = null; });
  }
  return compilePromise;
}

/** Compiled checker for one schema, or null. Never throws. */
async function compiledFor(schema: object): Promise<TypeboxValidator | null> {
  const hit = compiledCache.get(schema);
  if (hit !== undefined) return hit;
  const C = await compileChecker();
  if (!C) return null;
  try {
    const compiled = C.Compile(schema);
    if (typeof compiled?.Check !== 'function') {
      throw new Error('Compile returned no Check');
    }
    compiledCache.set(schema, compiled);
    return compiled;
  } catch {
    // THIS schema, not the process: a compiler that chokes on one tool's
    // schema leaves every other tool compiled. Negative-cached so the throw
    // costs one attempt rather than one per call.
    compiledCache.set(schema, null);
    warnUnavailable(
      'a tool schema could not be compiled; the interpreted checker (Value.Check) stands in '
      + 'for it',
    );
    return null;
  }
}

/** Test seam: replace the compiled-checker loader. Returns a restore fn. */
export function setTypeboxCompileLoader(next: CompileLoader | null): () => void {
  const previous = compileLoader;
  const previousModule = compileModule;
  const previousDegraded = compileDegraded;
  const previouslyWarned = warnedUnavailable;
  compileLoader = next;
  compileModule = null;
  compilePromise = null;
  compileDegraded = false;
  compiledCache = new WeakMap();
  warnedUnavailable = false;
  warnedKinds.clear();
  return () => {
    compileLoader = previous;
    compileModule = previousModule;
    compilePromise = null;
    compileDegraded = previousDegraded;
    compiledCache = new WeakMap();
    warnedUnavailable = previouslyWarned;
  };
}

/** TEST SEAM: is `schema` already compiled in this process? The compile-once
 *  claim is otherwise unobservable — a cache hit and a miss return the same
 *  verdict, which is the point. */
export function _isSchemaCompiled(schema: object): boolean {
  return compiledCache.get(schema) != null;
}

async function fullCheck(
  V: TypeboxValue, schema: unknown, args: unknown,
): Promise<ValidationResult> {
  // Boolean schemas are valid JSON Schema. Avoid handing them to a checker
  // version that only accepts objects, while preserving their exact meaning.
  if (schema === false) return { ok: false, reason: 'arguments do not match the tool schema' };
  if (schema === true) return { ok: true };
  // Other non-object values are not schemas and historically constrain
  // nothing on this extension seam.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true };

  const compiled = await compiledFor(schema as object);
  if (compiled) {
    if (compiled.Check(args)) return { ok: true };
    // Prefer compiled Errors; fall back to interpreted if absent.
    if (typeof compiled.Errors === 'function') {
      for (const err of compiled.Errors(args)) return { ok: false, reason: reasonFor(err) };
    }
    for (const err of V.Errors(schema, args)) return { ok: false, reason: reasonFor(err) };
    return { ok: false, reason: 'arguments do not match the tool schema' };
  }

  if (V.Check(schema, args)) return { ok: true };
  for (const err of V.Errors(schema, args)) return { ok: false, reason: reasonFor(err) };
  // Check said no and Errors said nothing — report the disagreement rather
  // than silently passing arguments the checker just rejected.
  return { ok: false, reason: 'arguments do not match the tool schema' };
}

/** Default: typebox's `Value` through the loader seam. Replaceable so a test
 *  can force the degrade path without uninstalling a package. */
async function defaultValueLoader(): Promise<TypeboxValue> {
  const ns: any = await loadTypebox('value');
  // 1.3.7 exposes `Check`/`Errors` both at the top level and under `Value`.
  // Prefer the namespaced object: it is the documented surface, and a future
  // release that stops spreading the members keeps working.
  const V = (ns?.Value && typeof ns.Value.Check === 'function') ? ns.Value : ns;
  if (typeof V?.Check !== 'function' || typeof V?.Errors !== 'function') {
    throw new Error('typebox/value exposes no Check/Errors');
  }
  return V as TypeboxValue;
}

type ValueLoader = () => Promise<TypeboxValue>;

let valueLoader: ValueLoader | null = defaultValueLoader;
let valueModule: TypeboxValue | null = null;
let valuePromise: Promise<TypeboxValue | null> | null = null;
/** The full checker was tried and failed; the structural one stands in. */
let degraded = false;

/** Test seam: replace the full (typebox) checker loader. Returns a restore fn. */
export function setTypeboxValueLoader(next: ValueLoader | null): () => void {
  const previous = valueLoader;
  const previousModule = valueModule;
  const previousDegraded = degraded;
  const previouslyWarned = warnedUnavailable;
  valueLoader = next;
  valueModule = null;
  valuePromise = null;
  degraded = false;
  warnedUnavailable = false;
  warnedKinds.clear();
  return () => {
    valueLoader = previous;
    valueModule = previousModule;
    valuePromise = null;
    degraded = previousDegraded;
    warnedUnavailable = previouslyWarned;
  };
}

/** The full checker, or null once it is known to be unreachable. Lazy (nothing
 *  loads until the first tool call) and cached (one import per process). */
async function fullChecker(): Promise<TypeboxValue | null> {
  if (valueModule) return valueModule;
  if (degraded || !valueLoader) return null;
  if (!valuePromise) {
    const loader = valueLoader;
    valuePromise = loader()
      .then((V) => { valueModule = V; return V; })
      .catch(() => {
        degraded = true;
        warnUnavailable(
          'the full JSON-Schema checker (typebox) could not be loaded; falling back to the '
          + 'safe structural checker where the schema permits it',
        );
        return null;
      })
      // Never leave a settled promise that could re-warn: the result is cached
      // in `valueModule`/`degraded` above.
      .finally(() => { valuePromise = null; });
  }
  return valuePromise;
}

/** Sync probe: is a full validator available? Used by `Agent.method` at registration. */
export function fullValidationAvailable(): boolean {
  if (validator !== defaultValidator) return validator !== null;
  if (valueModule) return true;
  if (degraded || !valueLoader) return false;
  // An injected loader is trusted; only the built-in one is probed on disk.
  if (valueLoader !== defaultValueLoader) return true;
  try {
    return typeboxValueResolvable() === true;
  } catch {
    return false;
  }
}

/** Use the structural checker only when it can enforce the entire schema.
 *  A rich schema accepted after the full checker disappears is not degraded
 *  validation; it is a bypass. */
function safeStructuralFallback(schema: unknown, args: unknown): ValidationResult {
  const keyword = unenforceableKeyword(schema);
  if (keyword) {
    return {
      ok: false,
      reason: `tool-argument validation is unavailable for schema keyword "${keyword}"`,
    };
  }
  return structuralValidator(schema, args);
}

/** Default validator: compiled typebox -> interpreted -> safe structural fallback. */
const defaultValidator: ArgsValidator = async (schema, args) => {
  const V = await fullChecker();
  if (!V) return safeStructuralFallback(schema, args);
  try {
    return await fullCheck(V, schema, args);
  } catch {
    // A schema typebox itself chokes on. A plain structural schema can still
    // be checked safely; a rich one must be refused rather than passed through.
    warnUnavailable(
      'the full JSON-Schema checker threw on a tool schema; using the safe '
      + 'structural fallback where possible',
    );
    return safeStructuralFallback(schema, args);
  }
};

let validator: ArgsValidator | null = defaultValidator;
let warnedUnavailable = false;

/** Replace the argument checker for inline dispatch and `Agent.method`.
 *  `null` disables validation. Returns a restore fn. */
export function setToolArgsValidator(next: ArgsValidator | null): () => void {
  const previous = validator;
  const previouslyWarned = warnedUnavailable;
  validator = next;
  warnedUnavailable = false;
  warnedKinds.clear();
  return () => { validator = previous; warnedUnavailable = previouslyWarned; };
}

/** Check `args` against a tool schema. Validator failures fail closed. */
export async function validateToolArgs(
  schema: unknown, args: unknown,
): Promise<ValidationResult> {
  const current = validator;
  if (!current) {
    warnUnavailable('tool-argument validation is disabled; arguments are passed through unchecked');
    return { ok: true };
  }
  try {
    return await current(schema, args);
  } catch {
    // Do not interpolate the exception: a host validator may include argument
    // or provider content in it, and server logs are a separate trust surface.
    warnUnavailable(
      'the tool-argument validator threw; the tool call is refused',
    );
    return { ok: false, reason: 'tool-argument validation is unavailable' };
  }
}

/** One warn per distinct message kind, keyed on the message's first 40 chars. */
const warnedKinds = new Set<string>();
function warnUnavailable(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedKinds.has(kind)) return;
  warnedKinds.add(kind);
  warnedUnavailable = true;
  console.warn(`[10thfloor:agent] ${message}`);
}

/** Run `fn` inside a real MethodInvocation so `this.unblock()` etc. work. */
export function withInvocation<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  const invocation = new DDPCommon.MethodInvocation({
    isSimulation: false,
    userId,
    connection: null,
    randomSeed: null,
  });
  return (DDP as any)._CurrentMethodInvocation.withValue(invocation, fn);
}

/** Carries the host's live tool entitlement into co-registered Agent.method
 * handlers. Plain UI/DDP calls have no store and keep their normal behavior. */
const adoptedToolAuthorization = new AsyncLocalStorage<
  () => boolean | Promise<boolean>
>();

/** Default and type-check a gate. A typo discovered at dispatch would silently
 *  ungate the tool, so refuse invalid gates here at resolve time. */
function normalizeGate(gate: unknown, label: string): Gate {
  if (gate === undefined) return 'auto';
  if (gate === 'auto' || gate === 'ask') return gate;
  if (typeof gate === 'function') return gate as GatePredicate;
  throw new Error(
    `[10thfloor:agent] Tool "${label}" has an invalid "gate": it must be 'auto', 'ask', or a `
    + `function (ctx) => boolean | 'ask'; got ${typeof gate === 'string' ? JSON.stringify(gate) : typeof gate}.`,
  );
}

/** What a gate decided for one call. `'run'` covers both `'auto'` and a
 *  predicate that returned `true` — the dispatch site should not have to care
 *  which said so. */
export type GateDecision = 'run' | 'ask' | 'denied';

/** Structured denial result a `false` predicate produces. */
export function gateDeniedResult(name: string): ToolResult {
  return {
    ok: false,
    error: {
      error: 'denied-by-gate',
      reason: `The "${name}" tool refused this call.`,
    },
  };
}

/** One warn per FAILURE KIND (`threw` / `shape`), the same latch and the same
 *  reasoning as the validator's and hooks': a broken gate is broken on every
 *  call, and a line per tool call would bury the notice that matters. */
const warnedGateKinds = new Set<string>();

function warnGate(kind: string, message: string): void {
  if (warnedGateKinds.has(kind)) return;
  warnedGateKinds.add(kind);
  console.warn(`[10thfloor:agent] ${message}`);
}

/** TEST SEAM, not public API: the latch above is per process, so a test that
 *  asserts on a gate warning has to be able to arm it. Not re-exported from
 *  server/index.ts. */
export function _resetGateWarnings(): void {
  warnedGateKinds.clear();
}

/** Decide one call's gate. Fails closed: a broken predicate denies. */
export async function evaluateGate(
  tool: ResolvedTool | undefined, ctx: GateContext,
): Promise<GateDecision> {
  const gate = tool?.gate ?? 'auto';
  if (gate === 'ask') return 'ask';
  if (typeof gate !== 'function') return 'run';
  let verdict: unknown;
  try {
    verdict = await gate(ctx);
  } catch {
    warnGate(
      'threw',
      `a gate predicate threw and the call was DENIED (a broken gate must not run the tool): `
      + `tool "${ctx.name}"`,
    );
    return 'denied';
  }
  if (verdict === true) return 'run';
  if (verdict === false) return 'denied';
  if (verdict === 'ask') return 'ask';
  warnGate(
    'shape',
    `a gate predicate returned ${typeof verdict === 'string' ? JSON.stringify(verdict) : typeof verdict}`
    + `, which is not true, false or 'ask'; the call was DENIED: tool "${ctx.name}"`,
  );
  return 'denied';
}

export function resolveTools(specs: ToolSpec[]): ResolvedTool[] {
  return specs.map((spec) => {
    if (typeof spec === 'string') {
      return {
        name: spec, description: '', args: { type: 'object', properties: {} },
        gate: 'auto' as const, kind: 'adopted' as const, method: spec,
      };
    }
    const hasMethod = 'method' in spec && spec.method !== undefined;
    const hasRun = 'run' in spec && spec.run !== undefined;
    const hasSubagent = 'subagent' in spec && spec.subagent !== undefined;
    const hasMcp = 'mcp' in spec && spec.mcp !== undefined;
    // `in`, not truthiness: `runAs: null` is a real value (anonymous context).
    const hasRunAs = 'runAs' in spec;
    const chosen = [hasMethod, hasRun, hasSubagent, hasMcp].filter(Boolean).length;
    if (chosen > 1) {
      const label = ('name' in spec ? spec.name : undefined)
        ?? ('method' in spec ? spec.method : undefined)
        ?? ('subagent' in spec ? spec.subagent : undefined)
        ?? ('mcp' in spec ? spec.mcp?.server : undefined)
        ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has more than one of "method", "run", `
        + `"subagent" and "mcp" — pick one: ${label}`,
      );
    }
    if (chosen === 0) {
      const label = ('name' in spec ? spec.name : undefined) ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has none of "method", "run", "subagent" and `
        + `"mcp" — pick one: ${label}`,
      );
    }
    if (hasRunAs && (hasSubagent || hasMcp)) {
      throw new Error(
        `[10thfloor:agent] "runAs" is not supported on ${hasSubagent ? 'subagent' : 'MCP'} `
        + "tool specs: a subagent's child session owns its identity (it inherits the "
        + "session's user and its own tools decide from there), and an MCP call runs in "
        + 'another process with no Meteor invocation to carry a userId. Put "runAs" on the '
        + `inline or adopted tool that needs it: ${JSON.stringify(spec)}`,
      );
    }
    if (hasMcp) {
      const m = spec as McpTool;
      const server = m.mcp?.server;
      if (typeof server !== 'string' || server === '') {
        throw new Error(
          `[10thfloor:agent] Tool spec's "mcp.server" must be a registered MCP server `
          + `name: ${JSON.stringify(spec)}`,
        );
      }
      const toolName = m.mcp.tool;
      if (toolName !== undefined && (typeof toolName !== 'string' || toolName === '')) {
        throw new Error(
          `[10thfloor:agent] Tool spec's "mcp.tool" must be a non-empty string (omit it `
          + `to expose the whole server): ${JSON.stringify(spec)}`,
        );
      }
      if (toolName === undefined && (m.name !== undefined || m.args !== undefined)) {
        throw new Error(
          `[10thfloor:agent] A whole-server MCP spec ({ mcp: { server: '${server}' } }) `
          + 'exposes many tools, so it cannot take a single "name" or "args" — those come '
          + 'from discovery. Name a "tool" to override them for one.',
        );
      }
      // Connection deferred to `expandMcpTools` (async); resolveTools is sync.
      return {
        // A placeholder for the whole-server form; `expandMcpTools` replaces
        // the entry entirely, so this name never reaches a provider.
        name: m.name ?? toolName ?? `mcp:${server}`,
        description: m.description ?? '',
        args: m.args ?? { type: 'object', properties: {} },
        gate: normalizeGate(m.gate, m.name ?? toolName ?? `mcp:${server}`),
        kind: 'mcp' as const,
        mcp: { server, tool: toolName },
        mcpExplicit: { description: m.description !== undefined, args: m.args !== undefined },
      };
    }
    if (hasSubagent) {
      const sub = spec as SubagentTool;
      if (typeof sub.subagent !== 'string' || sub.subagent === '') {
        throw new Error(
          `[10thfloor:agent] Tool spec's "subagent" must be an agent name: `
          + `${JSON.stringify(spec)}`,
        );
      }
      // Resolved at dispatch, not here: agent load order is unpredictable.
      return {
        name: sub.name ?? sub.subagent,
        description: sub.description,
        args: sub.args ?? SUBAGENT_ARGS,
        gate: normalizeGate(sub.gate, sub.name ?? sub.subagent),
        kind: 'subagent' as const,
        subagent: sub.subagent,
      };
    }
    if (hasMethod) {
      const adopted = spec as AdoptedTool;
      const name = adopted.name ?? adopted.method;
      if (!name) {
        throw new Error(
          `[10thfloor:agent] Tool spec has no usable name: ${JSON.stringify(spec)}`,
        );
      }
      return {
        name,
        description: adopted.description,
        args: adopted.args,
        gate: normalizeGate(adopted.gate, name),
        kind: 'adopted' as const,
        method: adopted.method,
        // Spread keeps the key absent when unset; undefined resolves to null
        // (fail-safe: anonymous beats silently inheriting the session's user).
        ...(hasRunAs ? { runAs: adopted.runAs ?? null } : {}),
        ...(typeof adopted.describe === 'function' ? { describe: adopted.describe } : {}),
      };
    }
    const inline = spec as InlineTool;
    if (!inline.name) {
      throw new Error(
        `[10thfloor:agent] Tool spec is missing "name": ${JSON.stringify(spec)}`,
      );
    }
    return {
      name: inline.name,
      description: inline.description,
      args: inline.args,
      gate: normalizeGate(inline.gate, inline.name),
      kind: 'inline' as const,
      run: inline.run,
      // See the adopted branch above for why this is a spread and why an
      // undefined value resolves to `null`.
      ...(hasRunAs ? { runAs: inline.runAs ?? null } : {}),
      ...(typeof inline.describe === 'function' ? { describe: inline.describe } : {}),
    };
  });
}

/** What a tool the server would not describe is shown as. Enough for the model
 *  to decide whether to try it; the try answers `mcp-unavailable` if the server
 *  is still down. */
function mcpFallbackDescription(server: string, tool: string): string {
  return `The "${tool}" tool on the MCP server "${server}". Its description could not be `
    + 'loaded, so call it only if its name clearly fits.';
}

/** Strip regex-bearing keywords (pattern/format/patternProperties) from
 *  discovered MCP schemas to prevent ReDoS from untrusted servers. */
const SCHEMA_SUBMAPS = new Set(['properties', '$defs', 'definitions']);
function stripUntrustedSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUntrustedSchemaKeywords);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    // Regex-bearing keywords, dropped at keyword position. `patternProperties`
    // goes wholesale because its own KEYS are the regexes.
    if (k === 'pattern' || k === 'format' || k === 'patternProperties') continue;
    if (SCHEMA_SUBMAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      // A map of {propertyName: subschema}: recurse the VALUES, keep the NAMES.
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        map[name] = stripUntrustedSchemaKeywords(sub);
      }
      out[k] = map;
    } else {
      out[k] = stripUntrustedSchemaKeywords(v);
    }
  }
  return out;
}

/** Discovered metadata folded into a resolved MCP tool. An EXPLICIT value from
 *  the spec always wins — that is the whole contract of the override. */
function withMcpMetadata(tool: ResolvedTool, info: McpToolInfo | undefined): ResolvedTool {
  const explicit = tool.mcpExplicit ?? { description: false, args: false };
  const { server, tool: name } = tool.mcp!;
  return {
    ...tool,
    description: explicit.description
      ? tool.description
      : (info?.description ?? mcpFallbackDescription(server, name ?? tool.name)),
    args: explicit.args
      ? tool.args
      // The discovered schema is third-party; strip its regex-bearing keywords
      // before it is ever run against model arguments. See the function above.
      : (info?.inputSchema
        ? stripUntrustedSchemaKeywords(info.inputSchema)
        : { type: 'object', properties: {} }),
  };
}

/** Discover MCP catalogs (concurrent) and expand whole-server specs.
 *  App-authored names always win over discovered MCP names. */
export async function expandMcpTools(
  tools: ResolvedTool[], reservedNames: readonly string[] = [],
): Promise<ResolvedTool[]> {
  if (!tools.some((t) => t.kind === 'mcp')) return tools;

  const out: ResolvedTool[] = [];
  const taken = new Set<string>();
  const push = (tool: ResolvedTool): void => {
    if (taken.has(tool.name)) {
      warnMcp(
        `two tools are named "${tool.name}"; the first definition wins and the other is `
        + 'dropped (a provider rejects a duplicate tool name outright). Give the MCP tool '
        + 'an explicit "name".',
      );
      return;
    }
    taken.add(tool.name);
    out.push(tool);
  };

  // App-authored names precomputed so MCP collisions lose regardless of order.
  const appNames = new Set(
    tools.filter((t) => t.kind !== 'mcp').map((t) => t.name),
  );
  const reserved = new Set([SKILL_TOOL_NAME, ...reservedNames]);
  const pushMcp = (tool: ResolvedTool): void => {
    if (appNames.has(tool.name) || reserved.has(tool.name)) {
      // LOUD, not the latched `warnMcp`: an MCP server quietly shadowing an app
      // tool (or a reserved built-in) is a security-relevant event an operator
      // must see every time it happens, not once per process.
      console.warn(
        `[10thfloor:agent] a discovered MCP tool named "${tool.name}" collides with `
        + `${appNames.has(tool.name) ? 'an app-defined tool'
          : `the reserved built-in "${tool.name}" tool`} and was DROPPED — the local `
        + 'tool keeps the name and its '
        + 'gate. Give the MCP tool an explicit "name" if you need both.',
      );
      return;
    }
    push(tool);
  };

  // One connect per SERVER per process even when several specs name the same
  // one: dedupe first, then discover every distinct server at once.
  const names = [...new Set(
    tools.filter((t) => t.kind === 'mcp').map((t) => t.mcp!.server),
  )];
  const discovered = new Map(await Promise.all(
    names.map(async (server) => [server, await discoverMcpTools(server)] as const),
  ));

  for (const tool of tools) {
    if (tool.kind !== 'mcp') { push(tool); continue; }
    const { server, tool: named } = tool.mcp!;
    const found = discovered.get(server)!;
    if (!found.ok) {
      if (named) pushMcp(withMcpMetadata(tool, undefined));
      else {
        warnMcp(
          `the MCP server "${server}" could not be listed, so none of its tools are `
          + `available this turn (it is retried once its cooldown expires): ${found.reason}`,
        );
      }
      continue;
    }
    if (named) {
      const info = found.tools.find((t) => t.name === named);
      if (!info) {
        // Tool missing from catalog (renamed/removed); still offered so the
        // model's tool list doesn't silently shrink.
        warnMcp(
          `MCP server "${server}" has no tool named "${named}" in its catalog; the tool is `
          + 'still offered to the model, but calling it will fail. Check the spec\'s '
          + '"mcp.tool" against the server\'s tools/list.',
        );
      }
      pushMcp(withMcpMetadata(tool, info));
      continue;
    }
    for (const info of found.tools) {
      pushMcp(withMcpMetadata(
        { ...tool, name: info.name, mcp: { server, tool: info.name } },
        info,
      ));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

/** On-demand instructions: listed in the prompt, loaded via the `skill` tool. */
export interface Skill {
  /** Letters, digits and hyphens, 1-64 characters. It is what the model passes
   *  to the `skill` tool, so it has to be typo-resistant and stable. */
  name: string;
  /** ONE line. It is in the prompt on every single call, and it is the only
   *  thing the model has to decide with. */
  description: string;
  /** The instructions themselves, delivered only when asked for. */
  content: string;
}

/** The name of the built-in loader tool. Not configurable: it is named in the
 *  system prompt's own instruction sentence, and a rename would have to travel
 *  with it. */
export const SKILL_TOOL_NAME = 'skill';

const SKILL_NAME = /^[a-z0-9-]{1,64}$/i;

/** Validate skills at define time so a missing body or duplicate name is a startup error. */
export function validateSkills(skills: unknown): void {
  if (skills === undefined) return;
  if (!Array.isArray(skills)) {
    throw new Error('[10thfloor:agent] skills must be an array of { name, description, content }.');
  }
  const seen = new Set<string>();
  for (const skill of skills) {
    const s = skill as Partial<Skill>;
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !SKILL_NAME.test(s.name)) {
      throw new Error(
        '[10thfloor:agent] A skill\'s "name" must be 1-64 letters, digits or hyphens; '
        + `got ${JSON.stringify(s?.name)}`,
      );
    }
    for (const field of ['description', 'content'] as const) {
      if (typeof s[field] !== 'string' || s[field]!.trim() === '') {
        throw new Error(
          `[10thfloor:agent] Skill "${s.name}" needs a non-empty "${field}" string`
          + `${field === 'content' ? ' — the instructions the skill tool delivers' : ''}.`,
        );
      }
    }
    if (seen.has(s.name)) {
      throw new Error(
        `[10thfloor:agent] Two skills are named "${s.name}"; the listing would show both `
        + 'and the loader could only ever return one.',
      );
    }
    seen.add(s.name);
  }
}

/** Built-in skill loader tool. Unknown names get a structured error listing available skills. */
export function skillTool(skills: Skill[]): ResolvedTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const available = skills.map((s) => s.name).join(', ');
  return {
    name: SKILL_TOOL_NAME,
    description:
      'Load the full instructions for one of the skills listed in the system prompt. '
      + `Available skills: ${available}.`,
    args: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    gate: 'auto',
    kind: 'inline',
    run: async (args: { name?: string }) => {
      const found = byName.get(String(args?.name));
      if (!found) {
        throw new Meteor.Error(
          'unknown-skill',
          `No skill named "${String(args?.name)}". Available skills: ${available}.`,
        );
      }
      return found.content;
    },
  };
}

/** One warn per distinct message, same latch (and same reason) as `warnMcp`'s:
 *  a collision recurs on every turn, and one line per model call would bury
 *  the notice that matters. */
const warnedSkillKinds = new Set<string>();

export function warnSkill(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedSkillKinds.has(kind)) return;
  warnedSkillKinds.add(kind);
  console.warn(`[10thfloor:agent] ${message}`);
}

/** TEST SEAM, not public API: the warn latch above is per process, so a test
 *  that asserts on the collision warning has to be able to arm it. Not
 *  re-exported from server/index.ts. */
export function _resetSkillWarnings(): void {
  warnedSkillKinds.clear();
}

/** Append the built-in `skill` tool after MCP expansion.
 *  An app tool named `skill` wins; the built-in is skipped with a warning. */
export function withSkillTool(tools: ResolvedTool[], skills?: Skill[]): ResolvedTool[] {
  if (!skills || skills.length === 0) return tools;
  if (tools.some((t) => t.name === SKILL_TOOL_NAME)) {
    warnSkill(
      `this agent defines its own tool named "${SKILL_TOOL_NAME}", so the built-in skill `
      + 'loader is not added — the Skills listing in the system prompt will be served by '
      + 'your tool, or not at all. Rename one of them.',
    );
    return tools;
  }
  return [...tools, skillTool(skills)];
}

export function toolSchemas(tools: ResolvedTool[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name, description: t.description, parameters: t.args,
  }));
}

export interface AgentMethodOptions {
  description: string;
  /** JSON Schema. One schema, both callers: the DDP handler and the model's
   *  dispatch are checked against this same object. */
  args: unknown;
  /** Runs with the Meteor method invocation as `this`, so `this.userId` and
   *  `this.unblock()` behave exactly as they do in a hand-written method —
   *  including for a UI caller that never touches an agent. */
  run: (this: any, args: any) => unknown | Promise<unknown>;
  gate?: Gate;
}

/** §6. One definition, two callers: a Meteor method for the UI and an adopted
 *  tool spec for the agent, sharing one validated schema. */
const UNENFORCED_KEYWORDS = [
  '$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'enum', 'const', 'pattern',
  'format', 'additionalProperties', 'patternProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
  'multipleOf', 'if', 'then', 'else', 'dependencies', 'dependentRequired',
  'dependentSchemas', 'minProperties', 'maxProperties', 'propertyNames',
  'contains', 'minContains', 'maxContains', 'prefixItems', 'additionalItems',
  'unevaluatedProperties', 'unevaluatedItems',
] as const;

const STRUCTURAL_TYPES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

/** First keyword in `schema` (walking properties/items) that the built-in
 *  minimal checker silently does NOT enforce, or null. */
export function unenforceableKeyword(schema: unknown): string | null {
  if (schema === false) return 'false schema';
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  for (const k of UNENFORCED_KEYWORDS) if (k in s) return k;
  const types = typeof s.type === 'string'
    ? [s.type]
    : (Array.isArray(s.type) ? s.type : []);
  if (types.some((type) => typeof type !== 'string' || !STRUCTURAL_TYPES.has(type))) return 'type';
  if (s.properties && typeof s.properties === 'object') {
    for (const sub of Object.values(s.properties as Record<string, unknown>)) {
      const found = unenforceableKeyword(sub);
      if (found) return found;
    }
  }
  if (Array.isArray(s.items)) return 'items';
  if (s.items) return unenforceableKeyword(s.items);
  return null;
}

export function defineAgentMethod(name: string, options: AgentMethodOptions): AdoptedTool {
  // Fail closed: reject rich schema keywords on a DDP endpoint when no full
  // validator can enforce them (a rich schema + structural-only = unguarded).
  if (!fullValidationAvailable()) {
    const kw = unenforceableKeyword(options.args);
    if (kw) {
      throw new Error(
        `[10thfloor:agent] Agent.method('${name}') uses schema keyword "${kw}", `
        + 'which the built-in structural checker does not enforce, and no full '
        + 'validator is available — on a DDP endpoint that means an unguarded '
        + 'argument. Fix it one of three ways: install typebox in your app '
        + '(`meteor npm install --save typebox`, already a dependency of '
        + '@earendil-works/pi-ai) so the harness can enforce the whole schema; '
        + 'install your own validator with setToolArgsValidator() BEFORE '
        + 'registering methods; or simplify the schema to '
        + 'type/properties/required/items.',
      );
    }
  }
  // Re-checked at call time in case the import that passed the probe fails.
  const richKeyword = unenforceableKeyword(options.args);
  Meteor.methods({
    async [name](this: any, args: unknown) {
      // Satisfies `audit-argument-checks`; the schema below is the real guard.
      check(args, Match.Any);
      if (richKeyword && !fullValidationAvailable()) {
        throw new Meteor.Error(
          'validation-unavailable',
          `The schema for '${name}' needs full validation, which failed to load`,
        );
      }
      const verdict = await validateToolArgs(options.args, args);
      if (!verdict.ok) throw new Meteor.Error('invalid-args', verdict.reason);
      // An agent-initiated call carries its host authorization across
      // Meteor.callAsync. Re-read it after this handler's own awaited
      // validation and immediately before the co-registered body. Direct UI
      // callers have no ambient callback and retain their normal method path.
      const authorize = adoptedToolAuthorization.getStore();
      if (authorize) {
        let allowed = false;
        try { allowed = (await authorize()) === true; } catch { /* fail closed */ }
        if (!allowed) {
          throw new Meteor.Error('not-allowed', `This agent may not use ${name}.`);
        }
      }
      return options.run.call(this, args);
    },
  });
  return {
    method: name,
    name,
    description: options.description,
    args: options.args,
    gate: options.gate,
  };
}

export async function runTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext,
  authorize?: () => boolean | Promise<boolean>,
): Promise<ToolResult> {
  const authorized = async (): Promise<boolean> => {
    if (!authorize) return true;
    try { return (await authorize()) === true; } catch { return false; }
  };
  const denied = (): ToolResult => ({
    ok: false,
    error: { error: 'not-allowed', reason: `This agent may not use ${tool.name}.` },
  });
  // Validate inline and adopted args here (one pre-dispatch guard for both
  // paths). An adopted method still validates in its own DDP handler, but that
  // handler may await a lazily loaded checker. Doing the same validation here
  // lets authorization be re-read after that setup and before callAsync starts.
  // Subagents route through the loop, not here.
  if (tool.kind === 'subagent') {
    return {
      ok: false,
      error: {
        error: 'tool-failed',
        reason: 'A subagent runs as a child session and must be dispatched by the turn loop.',
      },
    };
  }
  // MCP routes through here so gates/budget/rows are identical to inline tools.
  if (tool.kind === 'mcp') {
    const server = tool.mcp?.server;
    const name = tool.mcp?.tool;
    if (!server || !name) {
      // A whole-server placeholder that never went through `expandMcpTools`.
      // Only reachable by a caller that assembled tools itself; say so rather
      // than calling a tool named `undefined`.
      return {
        ok: false,
        error: {
          error: 'tool-failed',
          reason: 'An MCP server tool group must be expanded before it can be dispatched.',
        },
      };
    }
    // Validate against the discovered schema. Reason is sanitized because
    // MCP schemas are third-party and the reason is published.
    const verdict = await validateToolArgs(tool.args, args);
    if (!verdict.ok) {
      return {
        ok: false,
        error: {
          error: 'invalid-args',
          reason: sanitizeMcpReason(verdict.reason, 'the arguments do not match the tool schema'),
        },
      };
    }
    // Argument validation may load or compile a checker asynchronously. The
    // host entitlement is re-read after that await, at the last boundary
    // before the external MCP side effect starts.
    if (!(await authorized())) return denied();
    // No `withInvocation`: there is no Meteor method here and no `this` for a
    // handler to read. `ctx.userId` still governs the call through `canUse` and
    // the gate, which run before dispatch.
    return callMcpTool(server, name, args, authorize, tool.name);
  }
  if (tool.kind === 'inline' || tool.kind === 'adopted') {
    const verdict = await validateToolArgs(tool.args, args);
    if (!verdict.ok) {
      return { ok: false, error: { error: 'invalid-args', reason: verdict.reason } };
    }
  }
  // Inline and adopted Tools share this final authorization boundary. For an
  // adopted Tool it precedes Meteor.callAsync (after its host-side validation);
  // for an inline Tool it precedes the implementation body. A call already
  // beyond this boundary may finish.
  if (!(await authorized())) return denied();
  // `runAs` replaces userId for this tool; authorization already ran against
  // the real owner. `callerUserId` carries the real owner for the tool body.
  const escalated = tool.runAs !== undefined;
  const effectiveUserId: string | null = escalated ? (tool.runAs ?? null) : ctx.userId;
  const toolCtx: ToolContext = escalated
    ? { ...ctx, userId: effectiveUserId, callerUserId: ctx.userId }
    : ctx;
  try {
    const value = await withInvocation(effectiveUserId, async () => {
      if (tool.kind === 'adopted') {
        // Meteor derives its own MethodInvocation here, inheriting userId from
        // the ambient one, and the method's own check() calls run as written.
        return authorize
          ? adoptedToolAuthorization.run(authorize, () => Meteor.callAsync(tool.method!, args))
          : Meteor.callAsync(tool.method!, args);
      }
      return tool.run!(args, toolCtx);
    });
    return { ok: true, value };
  } catch (e: any) {
    if (e instanceof Meteor.Error) {
      return { ok: false, error: { error: String(e.error), reason: e.reason } };
    }
    // Never let a raw stack or message into the transcript — it is published.
    return { ok: false, error: { error: 'tool-failed', reason: 'The tool failed to run.' } };
  }
}

/* ---------------------------------------------------------------------------
 * Memory tools (memory spec §5)
 * ------------------------------------------------------------------------ */

/** Underscored (not dotted) because provider tool-name grammars reject dots. */
export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_search', 'memory_forget'] as const;

/** Reserve the three names against an agent's OWN tools at define() time, the
 *  way `SKILL_TOOL_NAME` is reserved — a named startup error beats a silent
 *  shadow discovered when the model's save goes somewhere unexpected. */
export function assertMemoryNamesFree(tools?: ToolSpec[]): void {
  if (!tools) return;
  for (const spec of tools) {
    // MCP names are untrusted discoveries, not authored definitions. The
    // Prepared Tool Runtime reserves and drops those collisions at discovery.
    if (typeof spec !== 'string' && 'mcp' in spec) continue;
    const name = typeof spec === 'string'
      ? spec
      : (spec as any).name ?? (spec as any).method;
    if (typeof name === 'string' && (MEMORY_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `[10thfloor:agent] this agent declares memory and also a tool named "${name}", `
        + 'which is one of the reserved memory tool names '
        + `(${MEMORY_TOOL_NAMES.join(', ')}). Rename your tool.`,
      );
    }
  }
}
