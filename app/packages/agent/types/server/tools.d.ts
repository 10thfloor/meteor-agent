import type { ToolSchema } from './providers/types';
import type { FromSchema } from '../common/schema';
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
export type GatePredicate = (ctx: GateContext) => boolean | 'ask' | Promise<boolean | 'ask'>;
/** `'auto'` | `'ask'` | a predicate — see the GATES note above. */
export type Gate = 'auto' | 'ask' | GatePredicate;
export interface ToolContext {
    /** Who this tool runs AS. Normally the session's owner; a spec with `runAs`
     *  replaces it for that one tool — see `RUNAS_NOTE` and `runTool`. */
    userId: string | null;
    sessionId: string;
    /** The id of the tool call currently being dispatched. Set by every loop
     *  dispatch path; optional only because a direct `runTool` caller (a test,
     *  a host driving one tool) has no call to name. A subagent needs it: it is
     *  half of the child's `parent` lineage. */
    toolCallId?: string;
    agent?: string;
    /** The SESSION's owner, present only when `runAs` replaced `userId` for this
     *  call. It is what a `runAs` tool checks to decide what it will do on whose
     *  behalf: the escalation gives the tool an identity, and this is the only
     *  remaining record of who actually asked. */
    callerUserId?: string | null;
    /**
     * Multimodal reads (participants spec §9): whether the RUNNING turn's
     * provider declared image input for its model — resolved once per turn by
     * the loop from `Provider.capabilities.imageInput`, absent/false when it
     * could not be answered (the gate fails closed). `read_attachment` reads it
     * to decide between attaching an image and the structured refusal.
     */
    imageInput?: boolean;
    /**
     * The result-attachment collector (participants spec §9): stamp a
     * session-scoped ref onto THIS call's `tool` row — request-time hydration
     * then carries the bytes to the provider. Collected refs flow through
     * `afterToolResult` (the hook may drop them) before the row is written, so
     * a redaction hook cannot be dodged. Set by both dispatch paths; absent for
     * a direct `runTool` caller, whose result has no row to stamp.
     */
    attachToResult?: (ref: import('../common/types').AttachmentRef) => void;
}
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
    /**
     * Approval legibility (participants spec §8): a human-readable one-liner of
     * what THIS call will do, produced at PARK time into `pending.display` —
     * the approval bar and every channel prompt prefer it over raw args JSON.
     * May read (compose resolves ref ids to names and sizes); a throw or a
     * timeout just means no display, never a failed park. Advisory only: `run`
     * still re-validates everything after the verdict.
     */
    describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) => string | Promise<string>;
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
    describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) => string | Promise<string>;
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
    gate?: Gate;
};
/** The default subagent argument schema: one string, the child's first user
 *  message. Deliberately minimal — a subagent is given a task in prose, and
 *  every additional field is one more thing the parent model can get wrong. */
export declare const SUBAGENT_ARGS: {
    readonly type: 'object';
    readonly properties: {
        readonly prompt: {
            readonly type: 'string';
        };
    };
    readonly required: readonly ['prompt'];
};
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
    mcp: {
        server: string;
        tool?: string;
    };
    description?: string;
    args?: unknown;
    /** Single-tool form only: expose it to the model under a different name. */
    name?: string;
    gate?: Gate;
};
export type ToolSpec = InlineTool | AdoptedTool | SubagentTool | McpTool | string;
export type TypedInlineTool<S> = {
    name: string;
    description: string;
    args: S;
    run: (args: FromSchema<S>, ctx: ToolContext) => Promise<unknown>;
    gate?: Gate;
    runAs?: string | null;
    describe?: (args: FromSchema<S>, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) => string | Promise<string>;
};
export type TypedAdoptedTool<S> = {
    method: string;
    description: string;
    args: S;
    name?: string;
    gate?: Gate;
    runAs?: string | null;
    describe?: (args: FromSchema<S>, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) => string | Promise<string>;
};
export declare function tool<const S>(spec: TypedInlineTool<S>): InlineTool;
export declare function methodTool<const S>(spec: TypedAdoptedTool<S>): AdoptedTool;
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
    mcp?: {
        server: string;
        tool?: string;
    };
    /** `kind: 'mcp'` only: which metadata the SPEC set, so discovery fills in
     *  only the rest. */
    mcpExplicit?: {
        description: boolean;
        args: boolean;
    };
    /** `inline` and `adopted` only. PRESENT means "run as this user instead of
     *  the session's owner" — and `null` is a real value (anonymous service
     *  context), so every check on it is `!== undefined`, never truthiness. */
    runAs?: string | null;
    /** `inline` and `adopted` only: the park-time legibility hook
     *  (participants spec §8). Carried through this projection deliberately —
     *  dispatch parks off a ResolvedTool, and a field dropped here would be a
     *  hook that silently never runs. */
    describe?: (args: any, ctx: Pick<ToolContext, 'userId' | 'sessionId'>) => string | Promise<string>;
}
export interface ToolResult {
    ok: boolean;
    value?: unknown;
    error?: {
        error: string;
        reason?: string;
    };
}
/** The verdict shape. `reason` names the offending FIELD and never echoes its
 *  value: it is fed back to the model and, through the tool row, published. */
export type ValidationResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** A pluggable argument checker. May be async — a host injecting a validator
 *  that has to load a library lazily returns a promise. */
export type ArgsValidator = (schema: unknown, args: unknown) => ValidationResult | Promise<ValidationResult>;
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
/**
 * Replace (or, with `null`, remove) the route to the compiled checker.
 *
 * The seam the compiled-path tests use: forcing a rejecting loader is the only
 * way to exercise rung 3 of the ladder without uninstalling a package. The
 * compiled cache is REPLACED (a WeakMap cannot be cleared) so a test never
 * sees a checker the previous loader built.
 */
export declare function setTypeboxCompileLoader(next: CompileLoader | null): () => void;
/** TEST SEAM: is `schema` already compiled in this process? The compile-once
 *  claim is otherwise unobservable — a cache hit and a miss return the same
 *  verdict, which is the point. */
export declare function _isSchemaCompiled(schema: object): boolean;
type ValueLoader = () => Promise<TypeboxValue>;
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
export declare function setTypeboxValueLoader(next: ValueLoader | null): () => void;
/**
 * SYNCHRONOUS: is a full JSON-Schema validator available to this process?
 *
 * True when the app installed one with `setToolArgsValidator`, when the full
 * checker is already loaded, or when typebox's `value` export resolves on
 * disk. `Agent.method` asks this at registration time, where awaiting an
 * import is not an option — see the fail-closed guard there.
 */
export declare function fullValidationAvailable(): boolean;
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
export declare function setToolArgsValidator(next: ArgsValidator | null): () => void;
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
export declare function validateToolArgs(schema: unknown, args: unknown): Promise<ValidationResult>;
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
export declare function withInvocation<T>(userId: string | null, fn: () => Promise<T>): Promise<T>;
/** What a gate decided for one call. `'run'` covers both `'auto'` and a
 *  predicate that returned `true` — the dispatch site should not have to care
 *  which said so. */
export type GateDecision = 'run' | 'ask' | 'denied';
/** The result a `false` (or broken) predicate produces. Structured like every
 *  other harness-authored refusal, so the model reads it and routes around
 *  it — the row is the answer to the call, not the end of the turn. The reason
 *  names the tool and nothing else: it is published, and a gate's own logic is
 *  not something to narrate into a transcript. */
export declare function gateDeniedResult(name: string): ToolResult;
/** TEST SEAM, not public API: the latch above is per process, so a test that
 *  asserts on a gate warning has to be able to arm it. Not re-exported from
 *  server/index.ts. */
export declare function _resetGateWarnings(): void;
/**
 * Decide one call's gate.
 *
 * A missing tool (`undefined`, the unknown-tool case) is `'run'`: the dispatch
 * site answers it with `unknown-tool`, and parking or denying a name that does
 * not exist would tell the model something false about a typo.
 *
 * FAILS CLOSED. Anything the predicate does other than resolving `true`,
 * `false` or `'ask'` — throwing, rejecting, returning a number, returning a
 * promise of junk — is `'denied'` plus one warning. The alternative (treat a
 * broken gate as `'auto'`) would run the tool the gate exists to guard, and
 * treating it as `'ask'` would put a question no one can answer in front of a
 * human on every call.
 */
export declare function evaluateGate(tool: ResolvedTool | undefined, ctx: GateContext): Promise<GateDecision>;
export declare function resolveTools(specs: ToolSpec[]): ResolvedTool[];
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
 * Name collisions: an APP-AUTHORED tool (inline/adopted/subagent) always wins
 * over a discovered MCP name regardless of list order, and a colliding MCP name
 * is dropped with a LOUD warning — a discovered tool silently capturing an app
 * tool's name would inherit its gate and its place in the model's mind, which is
 * the whole shadowing hazard. The built-in `skill` tool name is reserved the
 * same way. Between two MCP tools (or two app tools) the first definition wins
 * and the loser is dropped with the latched warning. Providers reject a tool
 * list with duplicate names outright, so shipping any collision would break the
 * whole turn rather than one tool.
 *
 * Servers are discovered CONCURRENTLY. Every discovery has its own deadline
 * (`MCP_DISCOVERY_TIMEOUT_MS`), and awaiting them one after another made the
 * worst case the SUM of those deadlines — four dead servers meant a minute of
 * silence before the model was called. `Promise.all` makes it the MAX. Ordering
 * is unaffected: the results are collected first and the tool list is assembled
 * from them in spec order afterwards, so the model sees the same list either
 * way.
 */
export declare function expandMcpTools(tools: ResolvedTool[]): Promise<ResolvedTool[]>;
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
export declare const SKILL_TOOL_NAME = "skill";
/**
 * Validate `skills` at DEFINE time, so a bad skill is a startup error.
 *
 * The failure mode this prevents is quiet: a skill whose `content` is missing
 * lists perfectly well in the prompt, and only fails when a model that trusted
 * the listing calls for a body that is not there — inside a turn, as a tool
 * error, blamed on the model. Duplicate names are the same story with a worse
 * ending: the listing shows two, the loader can only ever return one.
 */
export declare function validateSkills(skills: unknown): void;
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
export declare function skillTool(skills: Skill[]): ResolvedTool;
export declare function warnSkill(message: string): void;
/** TEST SEAM, not public API: the warn latch above is per process, so a test
 *  that asserts on the collision warning has to be able to arm it. Not
 *  re-exported from server/index.ts. */
export declare function _resetSkillWarnings(): void;
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
export declare function withSkillTool(tools: ResolvedTool[], skills?: Skill[]): ResolvedTool[];
export declare function toolSchemas(tools: ResolvedTool[]): ToolSchema[];
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
/** First keyword in `schema` (walking properties/items) that the built-in
 *  minimal checker silently does NOT enforce, or null. */
export declare function unenforceableKeyword(schema: unknown): string | null;
export declare function defineAgentMethod(name: string, options: AgentMethodOptions): AdoptedTool;
export declare function runTool(tool: ResolvedTool, args: unknown, ctx: ToolContext): Promise<ToolResult>;
/**
 * The MODEL-facing names. Underscored, not dotted, and deliberately so: the
 * DDP methods are `memory.save` and friends, but provider tool-name grammars
 * are narrower than Meteor's method namespace (Anthropic's is
 * `^[a-zA-Z0-9_-]{1,64}$`), and a dotted tool name is a 400 on the first turn
 * an agent with memory takes. Two surfaces, two naming rules, one core.
 */
export declare const MEMORY_TOOL_NAMES: readonly ['memory_save', 'memory_search', 'memory_forget'];
/** Reserve the three names against an agent's OWN tools at define() time, the
 *  way `SKILL_TOOL_NAME` is reserved — a named startup error beats a silent
 *  shadow discovered when the model's save goes somewhere unexpected. */
export declare function assertMemoryNamesFree(tools?: ToolSpec[]): void;
export {};
//# sourceMappingURL=tools.d.ts.map