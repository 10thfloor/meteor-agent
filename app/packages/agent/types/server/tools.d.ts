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
    /** Set by loop dispatch; optional for direct `runTool` callers. */
    toolCallId?: string;
    /** Committed assistant Message that contains this Tool call. Set by loop
     * dispatch so built-in provenance never depends on model arguments. */
    assistantMessageId?: string;
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
export declare const SUBAGENT_ARGS: {
    readonly type: 'object';
    readonly properties: {
        readonly prompt: {
            readonly type: 'string';
        };
    };
    readonly required: readonly ['prompt'];
};
/** A tool on an MCP server. Single-tool form names `mcp.tool`; omit it
 *  to expose the whole server. Metadata filled by `expandMcpTools`. */
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
    /** `inline`/`adopted` only. `null` = anonymous; check `!== undefined`. */
    runAs?: string | null;
    /** Park-time legibility hook (§8); must survive projection to dispatch. */
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
/** Test seam: replace the compiled-checker loader. Returns a restore fn. */
export declare function setTypeboxCompileLoader(next: CompileLoader | null): () => void;
/** TEST SEAM: is `schema` already compiled in this process? The compile-once
 *  claim is otherwise unobservable — a cache hit and a miss return the same
 *  verdict, which is the point. */
export declare function _isSchemaCompiled(schema: object): boolean;
type ValueLoader = () => Promise<TypeboxValue>;
/** Test seam: replace the full (typebox) checker loader. Returns a restore fn. */
export declare function setTypeboxValueLoader(next: ValueLoader | null): () => void;
/** Sync probe: is a full validator available? Used by `Agent.method` at registration. */
export declare function fullValidationAvailable(): boolean;
/** Replace the argument checker for inline dispatch and `Agent.method`.
 *  `null` disables validation. Returns a restore fn. */
export declare function setToolArgsValidator(next: ArgsValidator | null): () => void;
/** Check `args` against a tool schema. Validator failures fail closed. */
export declare function validateToolArgs(schema: unknown, args: unknown): Promise<ValidationResult>;
/** Run `fn` inside a real MethodInvocation so `this.unblock()` etc. work. */
export declare function withInvocation<T>(userId: string | null, fn: () => Promise<T>): Promise<T>;
/** What a gate decided for one call. `'run'` covers both `'auto'` and a
 *  predicate that returned `true` — the dispatch site should not have to care
 *  which said so. */
export type GateDecision = 'run' | 'ask' | 'denied';
/** Structured denial result a `false` predicate produces. */
export declare function gateDeniedResult(name: string): ToolResult;
/** TEST SEAM, not public API: the latch above is per process, so a test that
 *  asserts on a gate warning has to be able to arm it. Not re-exported from
 *  server/index.ts. */
export declare function _resetGateWarnings(): void;
/** Decide one call's gate. Fails closed: a broken predicate denies. */
export declare function evaluateGate(tool: ResolvedTool | undefined, ctx: GateContext): Promise<GateDecision>;
export declare function resolveTools(specs: ToolSpec[]): ResolvedTool[];
/** Discover MCP catalogs (concurrent) and expand whole-server specs.
 *  App-authored names always win over discovered MCP names. */
export declare function expandMcpTools(tools: ResolvedTool[], reservedNames?: readonly string[]): Promise<ResolvedTool[]>;
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
export declare const SKILL_TOOL_NAME = "skill";
/** Validate skills at define time so a missing body or duplicate name is a startup error. */
export declare function validateSkills(skills: unknown): void;
/** Built-in skill loader tool. Unknown names get a structured error listing available skills. */
export declare function skillTool(skills: Skill[]): ResolvedTool;
export declare function warnSkill(message: string): void;
/** TEST SEAM, not public API: the warn latch above is per process, so a test
 *  that asserts on the collision warning has to be able to arm it. Not
 *  re-exported from server/index.ts. */
export declare function _resetSkillWarnings(): void;
/** Append the built-in `skill` tool after MCP expansion.
 *  An app tool named `skill` wins; the built-in is skipped with a warning. */
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
export declare function runTool(tool: ResolvedTool, args: unknown, ctx: ToolContext, authorize?: () => boolean | Promise<boolean>): Promise<ToolResult>;
/** Underscored (not dotted) because provider tool-name grammars reject dots. */
export declare const MEMORY_TOOL_NAMES: readonly ['memory_save', 'memory_search', 'memory_forget'];
/** Reserve the three names against an agent's OWN tools at define() time, the
 *  way `SKILL_TOOL_NAME` is reserved — a named startup error beats a silent
 *  shadow discovered when the model's save goes somewhere unexpected. */
export declare function assertMemoryNamesFree(tools?: ToolSpec[]): void;
export {};
//# sourceMappingURL=tools.d.ts.map