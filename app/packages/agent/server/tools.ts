import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import type { ToolSchema } from './providers/types';
import { loadTypebox, typeboxValueResolvable } from './providers/loader';

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

export type ToolSpec = InlineTool | AdoptedTool | SubagentTool | string;

export interface ResolvedTool {
  name: string;
  description: string;
  args: unknown;
  gate: 'auto' | 'ask';
  kind: 'inline' | 'adopted' | 'subagent';
  method?: string;
  run?: (args: any, ctx: ToolContext) => Promise<unknown>;
  /** `kind: 'subagent'` only: the REGISTRY NAME of the agent to run. Resolved
   *  to a config at dispatch, never here — see `resolveTools`. */
  subagent?: string;
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
    const chosen = [hasMethod, hasRun, hasSubagent].filter(Boolean).length;
    if (chosen > 1) {
      const label = (spec as any).name ?? (spec as any).method
        ?? (spec as any).subagent ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has more than one of "method", "run" and `
        + `"subagent" — pick one: ${label}`,
      );
    }
    if (chosen === 0) {
      const label = (spec as any).name ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has none of "method", "run" and "subagent" — `
        + `pick one: ${label}`,
      );
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
