import type { ProviderRequest } from './providers/types';
import type { ToolResult } from './tools';

/** Hook seams: beforeProviderRequest, afterToolResult (global + per-agent).
 *  A broken hook is skipped with one warning; never kills a turn. */

export type HookPurpose = 'think' | 'compaction';

export interface ProviderRequestHookContext {
  /** A child session reports the child agent, not the parent's. */
  agent: string;
  sessionId: string;
  /** `'think'` = the turn's call; `'compaction'` = the summarization call.
   *  A custom summarizer replaces the request when purpose is compaction. */
  purpose: HookPurpose;
}

export interface ToolResultHookContext {
  agent: string;
  sessionId: string;
  /** The session owner — redaction hooks need it to distinguish authed vs anonymous. */
  userId: string | null;
  /** Mutable so a redaction hook can drop attachments alongside rewritten text. */
  resultAttachments?: import('../common/types').AttachmentRef[];
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

interface HookLists {
  beforeProviderRequest: BeforeProviderRequestHook[];
  afterToolResult: AfterToolResultHook[];
}

const emptyLists = (): HookLists => ({ beforeProviderRequest: [], afterToolResult: [] });

const registered: HookLists = emptyLists();

/** Keyed by registry name; a map so hooks work before `define()` runs. */
const perAgent = new Map<string, HookLists>();

/** Global hooks first, then the agent's own, in registration order. */
function chain<N extends HookName>(name: N, agent: string): Array<HookMap[N]> {
  const mine = perAgent.get(agent);
  // Copied, never the live arrays: a hook that registers another hook must not
  // extend the list it is being iterated from.
  return [
    ...(registered[name] as Array<HookMap[N]>),
    ...((mine?.[name] ?? []) as Array<HookMap[N]>),
  ];
}

/** Latch: one warn per failure kind, so a broken hook doesn't spam the log. */
const warned = new Set<string>();

function warnHook(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[10thfloor:agent] ${message}`);
}

/** Register a global hook. Throws on an unknown name so typos fail loud. */
export function registerHook<N extends HookName>(name: N, fn: HookMap[N]): void {
  checkHook(name, fn, 'Agent.hook');
  (registered[name] as unknown[]).push(fn);
}

/** Register a per-agent hook. Runs after global hooks when `ctx.agent` matches.
 *  The agent need not be `define()`d yet — hooks are matched by name at run time. */
export function registerAgentHook<N extends HookName>(
  agent: string, name: N, fn: HookMap[N],
): void {
  checkHook(name, fn, 'agent.hook');
  let lists = perAgent.get(agent);
  if (!lists) { lists = emptyLists(); perAgent.set(agent, lists); }
  (lists[name] as unknown[]).push(fn);
}

function checkHook(name: HookName, fn: unknown, label: string): void {
  if (!HOOK_NAMES.includes(name)) {
    throw new Error(
      `[10thfloor:agent] Unknown hook "${String(name)}". The hooks are: `
      + `${HOOK_NAMES.join(', ')}.`,
    );
  }
  if (typeof fn !== 'function') {
    throw new Error(`[10thfloor:agent] ${label}('${name}', fn) needs a function.`);
  }
}

/** Test seam: drop all hooks (global + per-agent) and reset warn latches. */
export function clearHooks(): void {
  registered.beforeProviderRequest = [];
  registered.afterToolResult = [];
  perAgent.clear();
  warned.clear();
}

/** Test seam: drop one agent's hooks only. */
export function clearAgentHooks(agent: string): void {
  perAgent.delete(agent);
}

/** Minimal shape check so a broken hook return doesn't crash the provider. */
function isProviderRequest(value: unknown): value is ProviderRequest {
  const v = value as Record<string, unknown>;
  return !!v && typeof v === 'object'
    && typeof v.model === 'string'
    // Missing `system` would silently send no system prompt at all.
    && typeof v.system === 'string'
    && Array.isArray(v.messages);
}

/** Minimum check: `ok` must be present or the row's success/failure is ambiguous. */
function isToolResult(value: unknown): value is ToolResult {
  const v = value as Record<string, unknown>;
  return !!v && typeof v === 'object' && typeof v.ok === 'boolean';
}

/** Run the beforeProviderRequest chain. Runs once per attempt (retries re-run).
 *  Caller re-stamps `signal` so a hook can't silently disable cancellation. */
export async function runBeforeProviderRequest(
  req: ProviderRequest, ctx: ProviderRequestHookContext,
): Promise<ProviderRequest> {
  let current = req;
  // Global hooks first, then the agent's own.
  for (const fn of chain('beforeProviderRequest', ctx.agent)) {
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

/** Run the afterToolResult chain. Covers every tool row including refusals,
 *  so nothing enters the transcript unseen. Runs before truncation/storage. */
export async function runAfterToolResult(
  result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext,
): Promise<ToolResult> {
  let current = result;
  for (const fn of chain('afterToolResult', ctx.agent)) {
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
