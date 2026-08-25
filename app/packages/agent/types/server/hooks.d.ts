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
 * Registration comes in two scopes, and NEITHER touches `RunConfig`: the loop
 * imports these runners directly rather than threading a hook list through the
 * four call paths (a send, watcher recovery, `ask`, a subagent's child run)
 * that would each have to remember to carry it — and the one that forgot would
 * silently skip an app's redaction. Both scopes are resolved from the ctx the
 * runner already has.
 *
 *  - `Agent.hook(name, fn)` — GLOBAL, the Pi extension model: installed into
 *    the process, runs for every agent.
 *  - `agentInstance.hook(name, fn)` — PER AGENT, keyed on the agent's registry
 *    name and matched against `ctx.agent`, which a CHILD session reports as the
 *    child's own agent (so a subagent's hooks are the subagent's).
 *
 * ORDER: every global hook first, in registration order, then every per-agent
 * hook, in registration order. The rationale is specificity, not privilege —
 * the same rule CSS uses. A global hook is the process's blanket policy and a
 * per-agent hook is one agent's refinement of it, so the refinement sees the
 * policy's output and gets the last word, exactly as a later global hook sees
 * (and may overrule) an earlier one. It is NOT a security boundary in either
 * direction: hooks are all app code, and a global hook could already be
 * overruled by a second global hook registered after it. A redaction that must
 * hold everywhere belongs in ONE place, not in two chains arguing.
 *
 * Three rules hold for both seams, and for both scopes:
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
    /**
     * Multimodal reads (participants spec §9): refs the tool attached to its
     * result — MUTABLE, deliberately: a redaction hook that rewrites the text
     * must also be able to drop the image (splice the array), or the bytes
     * would ride to the provider behind the redaction. Present at both
     * dispatch sites whenever the call collected any; what survives the hook
     * chain is what the tool row carries and what hydration later loads.
     */
    resultAttachments?: import('../common/types').AttachmentRef[];
}
/** The call a result answers, exactly as the model asked for it. */
export interface HookToolCall {
    id: string;
    name: string;
    args: unknown;
}
export type BeforeProviderRequestHook = (req: ProviderRequest, ctx: ProviderRequestHookContext) => ProviderRequest | void | Promise<ProviderRequest | void>;
export type AfterToolResultHook = (result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext) => ToolResult | void | Promise<ToolResult | void>;
export interface HookMap {
    beforeProviderRequest: BeforeProviderRequestHook;
    afterToolResult: AfterToolResultHook;
}
export type HookName = keyof HookMap;
/**
 * Register a hook. Throws on an unknown name — a typo'd hook is a hook that
 * silently never runs, and the app that registered it would be told nothing
 * until it noticed its redaction had not happened.
 */
export declare function registerHook<N extends HookName>(name: N, fn: HookMap[N]): void;
/**
 * Register a hook for ONE agent — the instance form, `agentInstance.hook(…)`.
 *
 * Same seams, same contract, same failure handling; the only difference is that
 * it runs when `ctx.agent` is this name, and it runs AFTER every global hook.
 * The agent need not be defined yet: hooks are matched by name at run time, and
 * requiring `define()` first would make correctness depend on the order server
 * files happen to load — the same reason a `{ subagent }` spec resolves its name
 * at dispatch rather than at resolve.
 */
export declare function registerAgentHook<N extends HookName>(agent: string, name: N, fn: HookMap[N]): void;
/**
 * Drop every registered hook, GLOBAL AND PER-AGENT. A TEST SEAM, and documented
 * as one: hooks are permanent by design (an app registers them at startup and
 * never unregisters), so the only caller with a reason to remove them is a test
 * that must not leak one into the next test's turn. Also resets the warn
 * latches, so each test can observe the warning it expects.
 *
 * It clears BOTH scopes deliberately, which keeps `Agent.clearHooks()` meaning
 * exactly what it meant before per-agent hooks existed: "no hook registered
 * anywhere survives this call". A seam that cleaned only half of them would
 * leak the half nobody remembered, which is the one bug the seam exists to
 * prevent.
 */
export declare function clearHooks(): void;
/** Drop one agent's hooks, leaving the global ones and every other agent's
 *  alone — `agentInstance.clearHooks()`. The narrow half of the test seam. */
export declare function clearAgentHooks(agent: string): void;
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
export declare function runBeforeProviderRequest(req: ProviderRequest, ctx: ProviderRequestHookContext): Promise<ProviderRequest>;
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
export declare function runAfterToolResult(result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext): Promise<ToolResult>;
//# sourceMappingURL=hooks.d.ts.map