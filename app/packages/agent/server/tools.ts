import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import type { ToolSchema } from './providers/types';

export interface ToolContext { userId: string | null; sessionId: string }

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

export type ToolSpec = InlineTool | AdoptedTool | string;

export interface ResolvedTool {
  name: string;
  description: string;
  args: unknown;
  gate: 'auto' | 'ask';
  kind: 'inline' | 'adopted';
  method?: string;
  run?: (args: any, ctx: ToolContext) => Promise<unknown>;
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
 * pi-ai's root namespace re-exports from typebox only `Type` (value) and
 * `Static`/`TSchema` (types) — `dist/index.d.ts` line 1-2. Neither `Value` nor
 * `Compile` is re-exported at the root or on any subpath. What IS reachable is
 * `validateToolArguments(tool, toolCall)` (`dist/utils/validation.js`, exported
 * via `export * from "./utils/validation.ts"`), which imports `Compile` from
 * `typebox/compile` and `Value` from `typebox/value` internally. It is not
 * usable here for two reasons: it COERCES and mutates the arguments rather than
 * only checking them, and its thrown message ends with
 * `Received arguments:\n${JSON.stringify(toolCall.arguments)}` — the raw
 * user/model data this package must never put into a published transcript.
 * Reaching `typebox/value` directly would mean importing a transitive
 * dependency of pi-ai, which the loader deliberately does not do.
 *
 * So the shipped default is the minimal structural checker below, and the
 * validator is a SEAM: a host that wants full JSON Schema hands its own
 * validator to `setToolArgsValidator`.
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
 * never arguments a fuller validator would have allowed. A tool whose schema
 * needs more than this should keep its own `check()` (adopt it as a Meteor
 * method) or the app should inject a real validator via
 * `setToolArgsValidator`.
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

let validator: ArgsValidator | null = structuralValidator;
let warnedUnavailable = false;

/**
 * Replace the argument checker for the whole package — both the loop's inline
 * dispatch and every method `Agent.method` registers, so one schema keeps
 * meaning one thing to both callers.
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

function warnUnavailable(message: string): void {
  if (warnedUnavailable) return;
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
    if (hasMethod && hasRun) {
      const label = (spec as any).name ?? (spec as any).method ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has both "method" and "run" — pick one: ${label}`,
      );
    }
    if (!hasMethod && !hasRun) {
      const label = (spec as any).name ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has neither "method" nor "run" — pick one: ${label}`,
      );
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
  if (validator === structuralValidator) {
    const kw = unenforceableKeyword(options.args);
    if (kw) {
      throw new Error(
        `[10thfloor:agent] Agent.method('${name}') uses schema keyword "${kw}", `
        + 'which the built-in minimal checker does not enforce — on a DDP '
        + 'endpoint that means an unguarded argument. Simplify the schema to '
        + 'type/properties/required/items, or install a full validator with '
        + 'setToolArgsValidator() before registering methods.',
      );
    }
  }
  Meteor.methods({
    async [name](this: any, args: unknown) {
      // The schema below is the real guard. This satisfies
      // `audit-argument-checks`, which knows only about `check()` and would
      // otherwise fail every call to a method it cannot see validating its
      // arguments — a confusing failure in an app that enables the audit.
      check(args, Match.Any);
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
