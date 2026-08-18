import type { ProviderRequest } from './providers/types';
import type { ToolResult } from './tools';

/**
 * THE EXTENSION SURFACE.
 *
 * Pi's extension API has no Meteor analogue — an extension there is a module a
 * host process registers against a running agent, and here the "host process"
 * is the Meteor server itself. So the whole surface is two named seams a host
 * registers plain functions against, chosen because they are the only two
 * points where an app can change what the harness does without reimplementing
 * it: what goes OUT to the provider, and what comes BACK from a tool.
 *
 * Registration is GLOBAL (package-level), not per agent. That matches Pi's
 * extension model — an extension is installed into the process, not into one
 * assistant — and it keeps `RunConfig` out of it entirely: the loop imports
 * these runners directly rather than threading a hook list through four call
 * paths that would each have to remember it. Per-agent hooks are a v3
 * candidate; the ctx every hook receives carries the agent's name, so a hook
 * that wants to be per-agent is one `if` away, and an app can build the map
 * itself.
 *
 * Three rules hold for both seams:
 *  - hooks run in REGISTRATION ORDER, each seeing the previous one's output;
 *  - returning `undefined` keeps the current value — a hook that only observes
 *    needs no return statement at all;
 *  - a hook that THROWS, or that returns something of the wrong shape, is
 *    SKIPPED with one warning and the value it was given stands. A broken
 *    extension must not kill turns: the harness's own contract with the user
 *    (an answer, or a recorded failure) outranks an app's decoration of it.
 */

export type HookPurpose = 'think' | 'compaction';

export interface ProviderRequestHookContext {
  /** The registry name of the agent whose session this is — a CHILD session
   *  reports the child agent, which is what a per-agent hook needs. */
  agent: string;
  sessionId: string;
  /**
   * WHICH request this is. `'think'` is the turn's own call; `'compaction'` is
   * the summarization call §9 makes on its own initiative.
   *
   * This is what makes the M3-candidate "custom summarizer hook" fall out for
   * free: a host that wants its own summarizer replaces the request wholesale
   * when `purpose === 'compaction'` — different system prompt, different model,
   * fewer messages — with no bespoke config option to design, document and
   * keep in step with the compaction code.
   */
  purpose: HookPurpose;
}

export interface ToolResultHookContext {
  agent: string;
  sessionId: string;
  /** The session's owner, as every tool's `ctx.userId` sees it. A redaction
   *  hook usually wants it: what may be shown to a signed-in owner is not what
   *  may be shown to an anonymous capability-URL session. */
  userId: string | null;
}

/** The call a result answers, exactly as the model asked for it. */
export interface HookToolCall { id: string; name: string; args: unknown }

export type BeforeProviderRequestHook = (
  req: ProviderRequest, ctx: ProviderRequestHookContext,
) => ProviderRequest | void | Promise<ProviderRequest | void>;

export type AfterToolResultHook = (
  result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext,
) => ToolResult | void | Promise<ToolResult | void>;

export interface HookMap {
  beforeProviderRequest: BeforeProviderRequestHook;
  afterToolResult: AfterToolResultHook;
}

export type HookName = keyof HookMap;

const HOOK_NAMES: HookName[] = ['beforeProviderRequest', 'afterToolResult'];

const registered: {
  beforeProviderRequest: BeforeProviderRequestHook[];
  afterToolResult: AfterToolResultHook[];
} = { beforeProviderRequest: [], afterToolResult: [] };

/**
 * One warn per DISTINCT FAILURE KIND, keyed `<hook name>:<what went wrong>`.
 *
 * The same latch pattern (and the same reasoning) as the validator's and MCP's:
 * a hook runs on every provider request and every tool result, so an unlatched
 * warning from a broken extension would be one log line per model call
 * forever — and the operator who needs to see it would see it least. Keyed per
 * kind rather than once ever, so "a hook threw" cannot permanently suppress "a
 * hook returned a malformed request".
 */
const warned = new Set<string>();

function warnHook(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[10thfloor:agent] ${message}`);
}

/**
 * Register a hook. Throws on an unknown name — a typo'd hook is a hook that
 * silently never runs, and the app that registered it would be told nothing
 * until it noticed its redaction had not happened.
 */
export function registerHook<N extends HookName>(name: N, fn: HookMap[N]): void {
  if (!HOOK_NAMES.includes(name)) {
    throw new Error(
      `[10thfloor:agent] Unknown hook "${String(name)}". The hooks are: `
      + `${HOOK_NAMES.join(', ')}.`,
    );
  }
  if (typeof fn !== 'function') {
    throw new Error(`[10thfloor:agent] Agent.hook('${name}', fn) needs a function.`);
  }
  (registered[name] as unknown[]).push(fn);
}

/**
 * Drop every registered hook. A TEST SEAM, and documented as one: hooks are
 * global and permanent by design (an app registers them at startup and never
 * unregisters), so the only caller with a reason to remove them is a test that
 * must not leak one into the next test's turn. Also resets the warn latches, so
 * each test can observe the warning it expects.
 */
export function clearHooks(): void {
  registered.beforeProviderRequest = [];
  registered.afterToolResult = [];
  warned.clear();
}

/** Minimal shape check for a REPLACEMENT request. Not a schema: the point is
 *  only that the loop can still stream it. A hook that returns something else
 *  (a promise it forgot to await, a boolean from a `&&` chain, the ctx it was
 *  handed) must not take the turn down with a TypeError deep inside a
 *  provider. */
function isProviderRequest(value: unknown): value is ProviderRequest {
  const v = value as any;
  return !!v && typeof v === 'object'
    && typeof v.model === 'string'
    // `system` is not optional on `ProviderRequest`, and a hook that rebuilt the
    // request from scratch and forgot it would silently send the model NO system
    // prompt at all: no instructions, no skills listing, no §7 tool guidance —
    // an agent that answers as a bare chat model. Adapters differ on what they
    // do with `undefined` there (pi-ai stringifies it), so the harness will not
    // find out from the provider either. A missing `system` is a malformed
    // replacement, and the request the harness built stands.
    && typeof v.system === 'string'
    && Array.isArray(v.messages);
}

/** The same minimum for a replacement tool result: `ok` is what every consumer
 *  branches on, and an undefined `ok` would write a row that claims success and
 *  carries an error object. */
function isToolResult(value: unknown): value is ToolResult {
  const v = value as any;
  return !!v && typeof v === 'object' && typeof v.ok === 'boolean';
}

/**
 * Run the `beforeProviderRequest` chain and return the request to send.
 *
 * Called for EVERY provider request the harness makes — the turn's own call and
 * compaction's summarization alike, distinguished by `ctx.purpose` — and once
 * per ATTEMPT, so a retry re-runs the chain rather than resending a request
 * built minutes ago (a hook injecting the current time is the obvious case).
 *
 * The caller re-stamps `signal` onto whatever comes back: cancellation belongs
 * to the harness, and a hook that rebuilt the request must not be able to
 * silently disable the interrupt.
 */
export async function runBeforeProviderRequest(
  req: ProviderRequest, ctx: ProviderRequestHookContext,
): Promise<ProviderRequest> {
  let current = req;
  // Snapshot: a hook that registers another hook must not extend the list it
  // is being iterated from.
  for (const fn of [...registered.beforeProviderRequest]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const next = await fn(current, ctx);
      if (next === undefined || next === null) continue;   // observed only
      if (!isProviderRequest(next)) {
        warnHook(
          'beforeProviderRequest:shape',
          'a beforeProviderRequest hook returned something that is not a provider request '
          + '(it needs `model`, `system` and `messages`); the hook was skipped and the '
          + 'request stands',
        );
        continue;
      }
      current = next;
    } catch (e) {
      warnHook(
        'beforeProviderRequest:threw',
        'a beforeProviderRequest hook threw and was skipped; the request stands: '
        + `${(e as Error)?.message}`,
      );
    }
  }
  return current;
}

/**
 * Run the `afterToolResult` chain and return the result to record.
 *
 * Called for every tool ROW a turn writes — inline, adopted, subagent and MCP
 * dispatches, and also the structured refusals (`not-allowed`, `unknown-tool`,
 * a denied approval) that never reached a tool body. The stronger invariant is
 * deliberate: the seam's job is "nothing enters the transcript unseen", and a
 * redaction hook that covered only three of the five ways a row can be written
 * would be a footgun rather than a guarantee.
 *
 * It runs BEFORE `maxResultChars` truncation and before the row is written, so
 * a hook sees the whole result and its replacement is what gets truncated,
 * stored, published and sent to the model.
 */
export async function runAfterToolResult(
  result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext,
): Promise<ToolResult> {
  let current = result;
  for (const fn of [...registered.afterToolResult]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const next = await fn(current, call, ctx);
      if (next === undefined || next === null) continue;
      if (!isToolResult(next)) {
        warnHook(
          'afterToolResult:shape',
          'an afterToolResult hook returned something that is not a tool result '
          + '(it needs a boolean `ok`); the hook was skipped and the result stands',
        );
        continue;
      }
      current = next;
    } catch (e) {
      warnHook(
        'afterToolResult:threw',
        'an afterToolResult hook threw and was skipped; the result stands: '
        + `${(e as Error)?.message}`,
      );
    }
  }
  return current;
}
