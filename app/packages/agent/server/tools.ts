import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import type { ToolSchema } from './providers/types';
import { loadTypebox, typeboxValueResolvable } from './providers/loader';
import {
  callMcpTool, discoverMcpTools, warnMcp, type McpToolInfo,
} from './mcp/client';

export interface ToolContext {
  userId: string | null;
  sessionId: string;
  /** The id of the tool call currently being dispatched. Set by every loop
   *  dispatch path; optional only because a direct `runTool` caller (a test,
   *  a host driving one tool) has no call to name. A subagent needs it: it is
   *  half of the child's `parent` lineage. */
  toolCallId?: string;
}

export type InlineTool = {
  name: string;
  description: string;
  args: unknown;
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
  gate?: 'auto' | 'ask';
};

export type AdoptedTool = {
  method: string;
  description: string;
  args: unknown;
  name?: string;
  gate?: 'auto' | 'ask';
};

/**
 * A named agent behind a tool call. Calling it runs a CHILD SESSION of the
 * named agent — a real session with its own transcript, its own budgets and its
 * own live stream — and answers the parent's tool call with the child's final
 * assistant text (the `Agent.ask` contract). Unlike `ask`, the child persists:
 * the parent's tool row records `childSessionId`, and a client can subscribe to
 * it and watch.
 *
 * `name` defaults to the agent's own name — a tool called `researcher` calling
 * the agent `researcher` is the shape that reads best in a transcript. Override
 * it when one agent is behind two differently-described tools.
 */
export type SubagentTool = {
  subagent: string;
  description: string;
  /** Defaults to `SUBAGENT_ARGS`. A custom schema is legal; see
   *  `subagentPrompt` in server/subagent.ts for how its arguments become the
   *  child's first user message. */
  args?: unknown;
  name?: string;
  gate?: 'auto' | 'ask';
};

/** The default subagent argument schema: one string, the child's first user
 *  message. Deliberately minimal — a subagent is given a task in prose, and
 *  every additional field is one more thing the parent model can get wrong. */
export const SUBAGENT_ARGS = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
} as const;

/**
 * A tool on an MCP server registered with `Agent.mcpServer`.
 *
 * Two forms:
 *   `{ mcp: { server: 'docs', tool: 'search' } }` — ONE tool. Its description
 *      and `args` come from the server's own `tools/list` metadata; supplying
 *      either here overrides the discovered value.
 *   `{ mcp: { server: 'docs' } }` — ALL of that server's tools, each with its
 *      discovered name, description and schema. `gate` (and `description`, if
 *      you insist) apply to every one of them; `name` and `args` are refused,
 *      because one of each cannot describe many tools.
 *
 * Discovery is async and `resolveTools` is not, so the metadata is filled in by
 * `expandMcpTools` — see there.
 */
export type McpTool = {
  mcp: { server: string; tool?: string };
  description?: string;
  args?: unknown;
  /** Single-tool form only: expose it to the model under a different name. */
  name?: string;
  gate?: 'auto' | 'ask';
};

export type ToolSpec = InlineTool | AdoptedTool | SubagentTool | McpTool | string;

export interface ResolvedTool {
  name: string;
  description: string;
  args: unknown;
  gate: 'auto' | 'ask';
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

/* ------------------------------------------------------------------ *
 * Argument validation
 *
 * PROBE (pi-ai 0.84.2, typebox 1.3.7, both read off the installed files):
 *
 *  - pi-ai's root namespace re-exports from typebox only `Type` (value) and
 *    `Static`/`TSchema` (types) — `dist/index.d.ts` lines 1-2. `Value` is NOT
 *    re-exported at the root or on any subpath (46 root exports, none named
 *    `Value`). So there is no pi-ai route to a `Check`-style API.
 *  - pi-ai DOES export `validateToolArguments(tool, toolCall)`
 *    (`dist/utils/validation.js`), which imports `Compile` from
 *    `typebox/compile` and `Value` from `typebox/value` internally. Still not
 *    usable here: it COERCES and mutates the arguments rather than only
 *    checking them, and its thrown message ends with
 *    `Received arguments:\n${JSON.stringify(toolCall.arguments)}` — the raw
 *    model data this package must never put into a published transcript.
 *  - typebox's OWN package exposes it: `package.json` `exports["./value"]` →
 *    `./build/value/index.mjs`, whose namespace includes `Check` and `Errors`
 *    both directly and under a `Value` object. That is the route taken, via
 *    `loadTypebox('value')` — the same loader seam pi-ai goes through, for the
 *    same reason (typebox is `type: module`, has NO `main`, and is reachable
 *    only through its exports map, which Meteor cannot follow).
 *
 * typebox 1.x's `Value.Check` accepts PLAIN JSON Schema, not just `TSchema`.
 * Verified against a `$ref`-free rich schema: `enum`, `const`, `minimum`/
 * `maximum`, `minLength`/`maxLength`, `pattern`, `minItems`/`maxItems`,
 * `oneOf`, `anyOf`, `format`, `additionalProperties: false`, `integer` and
 * nested `properties`/`items`/`required` all REJECT bad values and ACCEPT good
 * ones; internal `$ref`/`$defs` resolve too; unknown keywords are tolerated.
 * `Value.Errors` returns ajv-shaped
 * `{ keyword, schemaPath, instancePath, params, message }` records whose
 * messages are derived from the SCHEMA and never echo the instance value —
 * which is what makes them safe to put in a published `reason`.
 *
 * So the shipped default is now full JSON-Schema checking when typebox is
 * reachable, and the minimal structural checker below when it is not. The
 * validator remains a SEAM on top of both: `setToolArgsValidator` wins over
 * either.
 * ------------------------------------------------------------------ */

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

/**
 * The MINIMAL structural check, and deliberately not a JSON Schema
 * implementation. It understands exactly three things: `type` (including a
 * type array), object `properties` + `required`, and array `items`. It IGNORES
 * `$ref`, `oneOf`/`anyOf`/`allOf`, `enum`, `const`, `format`, `pattern`,
 * numeric bounds and `additionalProperties`.
 *
 * The bias is one-directional on purpose: anything it does not understand it
 * accepts. It can therefore reject only arguments that are structurally wrong —
 * never arguments a fuller validator would have allowed.
 *
 * As of M4 this is the FALLBACK, not the default: `defaultValidator` uses
 * typebox's `Value.Check` when it is reachable and drops to this only when it
 * is not. It still stands alone in a tree without typebox, and an app can
 * always inject its own validator via `setToolArgsValidator`.
 *
 * Returns a reason, or null when nothing is wrong. The reason names the field
 * and NEVER the value.
 */
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

const structuralValidator: ArgsValidator = (schema, args) => {
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

/**
 * One typebox error -> the package's reason vocabulary. Names the offending
 * FIELD and never the value: typebox's own `message` describes the schema
 * constraint ("must be string", "must be <= 10"), and the only data-derived
 * strings in `params` are property NAMES, which the structural checker already
 * reports.
 */
/** Property names in reasons are instance-derived where the instance supplied
 *  the key (`additionalProperties`, `propertyNames`), and a model can emit an
 *  arbitrarily long key that would land verbatim in a published transcript.
 *  Clamp what we interpolate; the schema still rejects the argument either
 *  way, the reason just refuses to be a megaphone. */
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

function fullCheck(V: TypeboxValue, schema: unknown, args: unknown): ValidationResult {
  // `Value.Check` throws on a non-object schema (`Cannot use 'in' operator`).
  // Nothing to enforce there anyway — the structural checker accepts it too.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true };
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

/**
 * Replace (or, with `null`, remove) the route to the full checker.
 *
 * The escape hatch for a host that must pin validation to the structural
 * checker, and the seam the degrade-path test uses — forcing a rejecting
 * loader is the only way to exercise "typebox went missing at runtime" without
 * uninstalling a package. Returns a restore function; the cached module, the
 * degrade latch and the warn-once latch all reset on every call so a test can
 * observe the warning it expects.
 */
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
      .catch((e) => {
        degraded = true;
        warnUnavailable(
          'the full JSON-Schema checker (typebox) could not be loaded; falling back to the '
          + `minimal structural checker, which does not enforce enum/bounds/oneOf/…: ${(e as Error)?.message}`,
        );
        return null;
      })
      // Never leave a settled promise that could re-warn: the result is cached
      // in `valueModule`/`degraded` above.
      .finally(() => { valuePromise = null; });
  }
  return valuePromise;
}

/**
 * SYNCHRONOUS: is a full JSON-Schema validator available to this process?
 *
 * True when the app installed one with `setToolArgsValidator`, when the full
 * checker is already loaded, or when typebox's `value` export resolves on
 * disk. `Agent.method` asks this at registration time, where awaiting an
 * import is not an option — see the fail-closed guard there.
 */
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

/**
 * The shipped default: full JSON Schema when typebox is reachable, the minimal
 * structural check when it is not. Falling back rather than throwing is the
 * whole point — a checker that cannot load must narrow what is enforced, never
 * take every tool call down with it.
 */
const defaultValidator: ArgsValidator = async (schema, args) => {
  const V = await fullChecker();
  if (!V) return structuralValidator(schema, args);
  try {
    return fullCheck(V, schema, args);
  } catch (e) {
    // A schema typebox itself chokes on. Degrade THIS call rather than the
    // process: the structural checker still catches the shape errors.
    warnUnavailable(
      `the full JSON-Schema checker threw on a tool schema; falling back to the minimal `
      + `structural checker for it: ${(e as Error)?.message}`,
    );
    return structuralValidator(schema, args);
  }
};

let validator: ArgsValidator | null = defaultValidator;
let warnedUnavailable = false;

/**
 * Replace the argument checker for the whole package — both the loop's inline
 * dispatch and every method `Agent.method` registers, so one schema keeps
 * meaning one thing to both callers. An installed validator wins over the
 * built-in default, typebox-backed or not.
 *
 * Pass `null` to DISABLE validation: arguments then pass through unchecked and
 * a single warning is logged (repeating it once per tool call would drown the
 * log of an agent that runs a tool per iteration).
 *
 * Returns a restore function; the warn-once latch resets on every call, so a
 * test can observe the warning it expects.
 */
export function setToolArgsValidator(next: ArgsValidator | null): () => void {
  const previous = validator;
  const previouslyWarned = warnedUnavailable;
  validator = next;
  warnedUnavailable = false;
  warnedKinds.clear();
  return () => { validator = previous; warnedUnavailable = previouslyWarned; };
}

/**
 * Check `args` against a tool's `args` schema.
 *
 * Async because the validator is a seam and a replacement may need to load
 * something (the default checker is synchronous and resolves immediately).
 *
 * DEGRADES rather than fails: no validator, or a validator that throws, means
 * the arguments are treated as valid after one warning. Validation is a guard
 * on top of whatever the tool itself does, and a broken guard must not take
 * every tool call down with it.
 */
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
  } catch (e) {
    // The message goes to the SERVER log only. It is the validator's own
    // failure, not a verdict, and never reaches the transcript.
    warnUnavailable(
      `the tool-argument validator threw; arguments are passed through unchecked: ${(e as Error)?.message}`,
    );
    return { ok: true };
  }
}

/** One warn PER DISTINCT MESSAGE KIND, not one warn ever: "typebox could not
 *  load" must not permanently suppress the far more serious "the validator
 *  threw; arguments are passed through unchecked". Keyed on the message's
 *  stable prefix so a variable error suffix does not defeat the latch. */
const warnedKinds = new Set<string>();
function warnUnavailable(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedKinds.has(kind)) return;
  warnedKinds.add(kind);
  warnedUnavailable = true;
  console.warn(`[10thfloor:agent] ${message}`);
}

/**
 * Make a REAL MethodInvocation ambient. S2b: a plain object is enough to carry
 * userId, but a handler invoked with one dies on `this.unblock is not a
 * function`, and real method bodies call it.
 *
 * Nuance: the adopted-tool path in `runTool` goes through `Meteor.callAsync`,
 * which builds its OWN invocation for the handler's `this` and only reads
 * `.userId`/`.connection` off the ambient one — so that path alone would
 * tolerate a plain object here. The ambient invocation still has to be real
 * because nothing guarantees every future caller reaches a handler via
 * `callAsync`; code that invokes a handler directly with the ambient
 * invocation as `this` (as `Meteor.server.method_handlers` allows) needs
 * `this.unblock`/`this.setUserId` to exist.
 */
export function withInvocation<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  const invocation = new (DDPCommon as any).MethodInvocation({
    isSimulation: false,
    userId,
    connection: null,
    randomSeed: null,
  });
  return (DDP as any)._CurrentMethodInvocation.withValue(invocation, fn);
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
    const hasSubagent = 'subagent' in spec && (spec as any).subagent !== undefined;
    const hasMcp = 'mcp' in spec && (spec as any).mcp !== undefined;
    const chosen = [hasMethod, hasRun, hasSubagent, hasMcp].filter(Boolean).length;
    if (chosen > 1) {
      const label = (spec as any).name ?? (spec as any).method
        ?? (spec as any).subagent ?? (spec as any).mcp?.server ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has more than one of "method", "run", `
        + `"subagent" and "mcp" — pick one: ${label}`,
      );
    }
    if (chosen === 0) {
      const label = (spec as any).name ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has none of "method", "run", "subagent" and `
        + `"mcp" — pick one: ${label}`,
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
      // The server is NOT connected here, deliberately, and neither is its
      // catalog read: `resolveTools` is synchronous and runs on every turn,
      // while connecting spawns a subprocess. Discovery happens once per
      // process in `expandMcpTools`, which is awaited before the schemas are
      // built — and a server that is down is a structured `mcp-unavailable`
      // result the model routes around, never a thrown turn.
      return {
        // A placeholder for the whole-server form; `expandMcpTools` replaces
        // the entry entirely, so this name never reaches a provider.
        name: m.name ?? toolName ?? `mcp:${server}`,
        description: m.description ?? '',
        args: m.args ?? { type: 'object', properties: {} },
        gate: m.gate ?? 'auto',
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
      // The NAME is not resolved to a config here, deliberately. Agents
      // register in whatever order their server files load, and a writer that
      // lists `{ subagent: 'researcher' }` is routinely defined before the
      // researcher is — validating here would make correctness depend on file
      // order, which is exactly the kind of startup failure nobody can
      // reproduce. The lookup happens at DISPATCH (server/subagent.ts), where a
      // missing agent is a structured `unknown-agent` tool result the model
      // reads and routes around, not a thrown turn.
      return {
        name: sub.name ?? sub.subagent,
        description: sub.description,
        args: sub.args ?? SUBAGENT_ARGS,
        gate: sub.gate ?? 'auto',
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
        gate: adopted.gate ?? 'auto',
        kind: 'adopted' as const,
        method: adopted.method,
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
      gate: inline.gate ?? 'auto',
      kind: 'inline' as const,
      run: inline.run,
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
      : (info?.inputSchema ?? { type: 'object', properties: {} }),
  };
}

/**
 * Fill in every `kind: 'mcp'` tool from its server's discovered catalog, and
 * expand a whole-server spec into one tool per discovered tool.
 *
 * WHY HERE, and not in `resolveTools`: discovery is asynchronous (it connects,
 * spawning a subprocess) and `resolveTools`/`toolSchemas` are synchronous and
 * used by tests and callers that must stay that way. `runTurn` is already
 * async and already calls both, once, before the think loop — so ONE awaited
 * line there is the whole integration:
 *
 *     const tools = await expandMcpTools(resolveTools(config.tools));
 *
 * Everything downstream (schema building, gate checks, `canUse`, dispatch)
 * sees an ordinary `ResolvedTool[]` and needs no knowledge of MCP at all.
 * Connections and catalogs are cached per process, so from the second turn on
 * this is a Map lookup.
 *
 * A server that cannot be reached does NOT fail the turn:
 *  - a NAMED tool survives as a callable entry with a fallback description;
 *    calling it answers `mcp-unavailable`, which the model reads and routes
 *    around, and the next turn retries the connection (nothing is cached);
 *  - a WHOLE-SERVER spec contributes no tools this turn and warns on the
 *    server log — there is nothing to name, and inventing a name for a tool
 *    nobody has described would be worse than being briefly absent.
 *
 * Name collisions: first definition wins and the loser is dropped with one
 * warning. Providers reject a tool list with duplicate names outright, so
 * shipping the collision would break the whole turn rather than one tool.
 *
 * Servers are discovered CONCURRENTLY. Every discovery has its own deadline
 * (`MCP_DISCOVERY_TIMEOUT_MS`), and awaiting them one after another made the
 * worst case the SUM of those deadlines — four dead servers meant a minute of
 * silence before the model was called. `Promise.all` makes it the MAX. Ordering
 * is unaffected: the results are collected first and the tool list is assembled
 * from them in spec order afterwards, so the model sees the same list either
 * way.
 */
export async function expandMcpTools(tools: ResolvedTool[]): Promise<ResolvedTool[]> {
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
      if (named) push(withMcpMetadata(tool, undefined));
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
        // The server ANSWERED and this tool is not in its catalog — a rename or
        // a removal on the server's side, not an outage. The entry is still
        // offered (with the fallback description) because refusing to expose it
        // would silently shrink the model's tool list; but a call will fail, so
        // say which server and which tool rather than leaving an operator to
        // work it out from an `mcp-tool-failed` in a transcript. Server and tool
        // lead the message so `warnMcp`'s 40-character latch key distinguishes
        // one pair from another.
        warnMcp(
          `MCP server "${server}" has no tool named "${named}" in its catalog; the tool is `
          + 'still offered to the model, but calling it will fail. Check the spec\'s '
          + '"mcp.tool" against the server\'s tools/list.',
        );
      }
      push(withMcpMetadata(tool, info));
      continue;
    }
    for (const info of found.tools) {
      push(withMcpMetadata(
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

/**
 * A named block of instructions the model loads ON DEMAND.
 *
 * The token economy is the whole point: `name` and `description` are always in
 * the system prompt (a listing — see `buildSystemPrompt`), and `content` is
 * NEVER there. A model that decides a skill's description matches the task
 * calls the built-in `skill` tool and gets the body as a tool result. Ten
 * skills therefore cost ten lines of prompt on every call instead of ten
 * documents.
 */
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

/**
 * Validate `skills` at DEFINE time, so a bad skill is a startup error.
 *
 * The failure mode this prevents is quiet: a skill whose `content` is missing
 * lists perfectly well in the prompt, and only fails when a model that trusted
 * the listing calls for a body that is not there — inside a turn, as a tool
 * error, blamed on the model. Duplicate names are the same story with a worse
 * ending: the listing shows two, the loader can only ever return one.
 */
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
        + `got ${JSON.stringify((s as any)?.name)}`,
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

/**
 * The built-in loader, as an inline tool built at RUN time from the agent's
 * skills. It exists only for an agent that has skills — an empty `skill` tool
 * is a name in every prompt that can only ever answer "no".
 *
 * An unknown name answers a structured `unknown-skill` (through `Meteor.Error`,
 * which `runTool` turns into `{ ok: false, error: { error, reason } }` like any
 * other tool failure) listing the available NAMES only: their descriptions are
 * already in the system prompt, and repeating them into a tool result would
 * spend the tokens the design exists to save.
 *
 * Loading is idempotent and unlimited: calling it twice returns the same body,
 * and a model may load several skills in one turn. Each load costs one
 * `budget.toolCalls`, exactly like any other tool call.
 */
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

/**
 * Append the built-in `skill` tool to an agent's expanded tool list.
 *
 * Called AFTER `expandMcpTools`, which is what makes the collision rule
 * decidable at all: a whole-server MCP spec's tool names are not known until
 * discovery has run, so appending earlier could let a discovered `skill` shadow
 * the built-in silently — two entries with one name, and a provider rejects a
 * duplicate tool list outright.
 *
 * COLLISION POLICY: the app's tool wins and the built-in is skipped, with one
 * warning. An app tool named `skill` is something the app deliberately defined
 * and may already be calling from a UI; the built-in is a harness convenience.
 * Silently overriding an app's own tool would be the worse surprise. The cost
 * is that the prompt's Skills listing then points at a loader that is not ours
 * — hence the warning naming exactly that.
 */
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
  gate?: 'auto' | 'ask';
}

/**
 * §6. Define a tool ONCE and get both callers: a real `Meteor.method` your UI
 * can `callAsync`, and a `ToolSpec` handle an agent can list.
 *
 * The point is the shared schema. A tool defined this way is validated with the
 * same `validateToolArgs` no matter who called it — a DDP client gets
 * `Meteor.Error('invalid-args', reason)`, the model gets the structured
 * `invalid-args` tool result `runTool` produces — so there is no second
 * definition to drift.
 *
 * Returns an ADOPTED spec, not an inline one: dispatch goes through
 * `Meteor.callAsync`, which is what makes the model's path and the UI's path
 * the same path. Agents may list the returned handle or just the method name.
 *
 * Registration is global and permanent, exactly as `Meteor.methods` is —
 * calling this twice for one name throws Meteor's own duplicate-method error.
 */
const UNENFORCED_KEYWORDS = [
  '$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'enum', 'const', 'pattern',
  'format', 'additionalProperties', 'patternProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
  'multipleOf', 'if', 'then', 'else', 'dependencies', 'dependentRequired',
  'dependentSchemas',
] as const;

/** First keyword in `schema` (walking properties/items) that the built-in
 *  minimal checker silently does NOT enforce, or null. */
export function unenforceableKeyword(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  for (const k of UNENFORCED_KEYWORDS) if (k in s) return k;
  if (s.properties && typeof s.properties === 'object') {
    for (const sub of Object.values(s.properties as Record<string, unknown>)) {
      const found = unenforceableKeyword(sub);
      if (found) return found;
    }
  }
  if (s.items) return unenforceableKeyword(s.items);
  return null;
}

export function defineAgentMethod(name: string, options: AgentMethodOptions): AdoptedTool {
  // FAIL CLOSED at registration, not silently at call time. "Accept what I
  // cannot check" is the right bias for the MODEL path (the model retries);
  // it is the wrong bias for a public DDP endpoint whose selling point is
  // that you no longer write check() yourself. A schema leaning on keywords
  // the minimal checker ignores would ship an unguarded argument to every
  // DDP client — the classic selector-injection surface, reintroduced by the
  // feature that promised to close it. Skipped when the app installed its
  // own validator (do that BEFORE registering methods).
  //
  // M4: the guard now fires only when NO full validator is available — neither
  // the built-in typebox route nor one the app installed. A rich schema is
  // perfectly safe once something actually enforces it, and refusing it then
  // would be the fail-closed reflex outliving its reason.
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
  // Captured at registration for the runtime guard below: the boot-time check
  // above trusts a RESOLVE (sync fs probe); if the later import fails, the
  // validator silently degrades to structural and this endpoint's rich
  // keywords would go unenforced — announced only by a warn. Fail closed at
  // call time too: `fullValidationAvailable()` reflects the degrade once it
  // has happened, so the window between prediction and reality stays shut.
  const richKeyword = unenforceableKeyword(options.args);
  Meteor.methods({
    async [name](this: any, args: unknown) {
      // The schema below is the real guard. This satisfies
      // `audit-argument-checks`, which knows only about `check()` and would
      // otherwise fail every call to a method it cannot see validating its
      // arguments — a confusing failure in an app that enables the audit.
      check(args, Match.Any);
      if (richKeyword && !fullValidationAvailable()) {
        throw new Meteor.Error(
          'validation-unavailable',
          `The schema for '${name}' needs full validation, which failed to load`,
        );
      }
      const verdict = await validateToolArgs(options.args, args);
      if (!verdict.ok) throw new Meteor.Error('invalid-args', verdict.reason);
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
): Promise<ToolResult> {
  // Model-supplied arguments are checked BEFORE the tool is dispatched, and the
  // check lives here rather than at the loop's two dispatch sites so that every
  // path into a tool — a streamed batch, an approved park's resume, whatever
  // comes next — is covered by one guard that cannot be forgotten at a third.
  //
  // INLINE tools only. An adopted tool has a DDP handler between the model and
  // its body, and that handler validates its own arguments — its hand-written
  // `check()`, or this same `validateToolArgs` when `defineAgentMethod`
  // registered it. Re-checking here would apply the harness's minimal checker
  // to a schema the method itself describes more precisely.
  //
  // A failure is a RESULT, never a throw: the model reads `invalid-args`, sees
  // which field it got wrong, and usually corrects on the next call. Throwing
  // would abandon a turn over a typo.
  //
  // SUBAGENTS are not dispatched here at all. A subagent is not a tool body: it
  // is a nested TURN, and running one needs `runTurn`, which lives in the loop
  // that imports this module. Routing it from here would mean an import cycle
  // (tools -> subagent -> loop -> tools), so the loop's own `dispatchTool`
  // routes `kind: 'subagent'` to `runSubagent` before ever reaching this
  // function. Anything landing here with one is a caller that bypassed the
  // loop; say so rather than falling into `tool.run!` and reporting the
  // resulting TypeError as a tool failure.
  if (tool.kind === 'subagent') {
    return {
      ok: false,
      error: {
        error: 'tool-failed',
        reason: 'A subagent runs as a child session and must be dispatched by the turn loop.',
      },
    };
  }
  // MCP tools DO route through here, unlike subagents: a `tools/call` is an
  // ordinary tool body that happens to run in another process, and it needs
  // nothing from `runTurn`. Routing it here rather than from the loop is what
  // makes gates, `canUse`, budget accounting, result truncation and the tool
  // row identical to an inline tool's — by construction, not by a second
  // implementation that has to be kept in step.
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
    // Checked against the DISCOVERED schema (or the spec's override), for the
    // same reason an inline tool's arguments are: the model gets `invalid-args`
    // naming the field, and usually fixes it — cheaper and clearer than a round
    // trip to a subprocess that answers with prose.
    const verdict = await validateToolArgs(tool.args, args);
    if (!verdict.ok) {
      return { ok: false, error: { error: 'invalid-args', reason: verdict.reason } };
    }
    // No `withInvocation`: there is no Meteor method here and no `this` for a
    // handler to read. `ctx.userId` still governs the call through `canUse` and
    // the gate, which run before dispatch.
    return callMcpTool(server, name, args);
  }
  if (tool.kind === 'inline') {
    const verdict = await validateToolArgs(tool.args, args);
    if (!verdict.ok) {
      return { ok: false, error: { error: 'invalid-args', reason: verdict.reason } };
    }
  }
  try {
    const value = await withInvocation(ctx.userId, async () => {
      if (tool.kind === 'adopted') {
        // Meteor derives its own MethodInvocation here, inheriting userId from
        // the ambient one, and the method's own check() calls run as written.
        return Meteor.callAsync(tool.method!, args);
      }
      return tool.run!(args, ctx);
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
