# Meteor Agent Harness — Milestone 4 Implementation Plan (v2 features)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The v2 backlog: subagents, session forking, MCP-client tools, skills, hooks, a framework-agnostic chat element, full-schema validation, and the small candidates the reviews accumulated — completing Tier 2 and the remaining Tier 3 items.

**Architecture:** still no new collections. Subagents and forks are ordinary sessions with lineage fields; MCP servers and skills surface as tools; hooks are a registration seam in the loop; the chat element packages the demo's vanilla renderer.

**Sources of truth:** spec §3's v2 list, the M3 final review's v2 candidates, the ledger's accepted-debt table, and the working demo in `app/client` (the chat element's reference implementation).

## Global Constraints

Everything from M1–M3 binds unchanged (deps, seam discipline, lease/atomic writes, `$`-modifiers, published-transcript hygiene, async Mongo APIs, split test entries, network-free tests, probe-before-believing for any npm surface). Suite starts at **185 server (+1 pending) + 1 client**; the test command, port and timing notes are unchanged. New npm dependencies follow the pi-ai pattern: app-level peer, reached through a loader seam, never `Npm.depends`.

**Scope honesty rule:** Pi's RPC and print modes do not map onto a server library whose RPC layer IS DDP and whose print mode IS `Agent.ask()`. They are satisfied by documentation, not code — the README's Scope section says so explicitly rather than leaving the v2 list looking unfinished.

---

### Task 1: Full-schema validation and streaming attribution (Tier 3 close-out)

1. **Probe** whether typebox's `Value` module is reachable through pi-ai (`loadPiAi('...')` against pi-ai's exports, or typebox's own exports via the same wildcard loader — `typebox` is already in the app's tree as pi-ai's dependency). If reachable: the DEFAULT validator upgrades to full JSON-Schema checking through it (lazy, server-only, graceful degrade to the structural checker with one warn if the import shape changes). `Agent.method`'s fail-closed rejection of rich schemas then only fires when NO full validator is available — from either the probe or `setToolArgsValidator`.
2. **`toolcall_delta` attribution:** `ProviderChunk` tool_args gains `contentIndex?: number`; the adapter threads pi-ai's value through; `DeltaWriter` coalesces tool_args runs per contentIndex (kind stays `tool_args`; the delta doc gains `contentIndex?`); `mergeView` keys tool_args accumulation by contentIndex so parallel calls no longer interleave. Client renders nothing new — this is fidelity for consumers who do.
3. Tests: validator upgrade path (rich schema accepted when probe succeeds, structural degrade when forced), attribution round trip through the faux provider with two parallel tool calls.

Commit: `feat(agent): full-schema validation via typebox when reachable; parallel tool-arg attribution`

---

### Task 2: Subagents

`kind: 'subagent'` tool spec: `{ subagent: 'researcher', description, args? }` — the named agent runs a CHILD session per call.

- Child sessions are real sessions: `parent: { sessionId, toolCallId }` on the child; `agent` = the child agent's name; `userId` inherited. The parent's tool result is the child's final assistant text (the `ask()` contract), but the child transcript PERSISTS (unlike `ask()`) and streams live — a client holding the parent can follow `child.sessionId` from the tool-call row (the parent's tool row records it) and subscribe.
- Budgets compose: the parent's `toolCalls` counts the call; the child enforces its own config. A child that parks on an ask-gate parks THE CHILD; the parent's tool call rejects with `subagent-parked` (same reasoning as `ask-parked` — the parent turn must not hang). Document: give subagents no ask-gates, or handle the rejection.
- Depth guard: a `depth` field inherited parent→child, refused past 3 — agents composing agents must not fork-bomb.
- Publication: `agent.session` already authorizes by userId; a child inherits the parent's userId so the same subscription rules hold. `agent.sessions` excludes children (`parent: { $exists: false }`) so session lists stay conversation-level.
- Tests: child transcript exists and streams; parent tool row carries the child sessionId; budgets on both sides; depth refusal; child park → parent `subagent-parked`; the composition demo in the README updates from the `ask()` pattern to this.

Commit: `feat(agent): subagents — child sessions with live transcripts behind a tool call`

---

### Task 3: Session forking

`agent.fork(agent, sessionId, atSeq?)` method + `Agent.fork(sessionId, atSeq?)` client/server API: copy messages with `seq <= atSeq` (default: all) into a new session carrying `forkedFrom: { sessionId, seq }`. Fork points are LEGAL CUT POINTS only — reuse `findCompactionCut`'s batch-safety walk so a fork never strands a tool_use. The fork copies `usage` as zeros (a fork costs nothing until it runs) and inherits the agent + userId. Authorization: `requireSession` on the source. Tests: fork mid-conversation diverges independently; batch-safe adjustment of an in-batch `atSeq`; fork of a fork; publication scoping.

Commit: `feat(agent): session forking at batch-safe cut points`

---

### Task 4: MCP-client tools

`{ mcp: { server: 'docs', tool: 'search' }, description?, args? }` tool spec, backed by an app-level `@modelcontextprotocol/sdk` peer dep behind a NEW loader seam (`server/mcp/loader.ts`, same hedge shape as pi-ai's).

- `Agent.mcpServer('docs', { command, args, env? })` registers a server; connections are lazy, per-process, stdio transport; `tools/list` discovers schemas at first use and caches; a spec naming just `{ mcp: { server: 'docs' } }` (no tool) expands to ALL that server's tools.
- MCP tool results map to tool rows (text content concatenated; non-text content noted, not embedded); MCP errors sanitize like every other tool error. Gates and `canUse` apply to MCP tools exactly as to inline ones.
- Tests are network-free: a scripted in-process fake speaking the SDK's client interface (probe the SDK's `.d.ts` first — the probe rule applies), covering discovery, call round trip, expansion, error sanitization, and the loader seam. One optional live test against `npx @modelcontextprotocol/server-everything` runs only when explicitly enabled by env var.

Commit: `feat(agent): MCP servers as tool sources behind a loader seam`

---

### Task 5: Skills and hooks

- **Skills** (Pi's shape, Meteor-sized): `skills: [{ name, description, content }]` on config. Descriptions are ALWAYS in the system prompt (a listing section); content loads on demand through a built-in `skill` tool the loop provides when skills exist. Token-cheap by construction.
- **Hooks:** `Agent.hook(name, fn)` with exactly two seams for now — `beforeProviderRequest(req, ctx) => req` (patch model/system/messages before each call; compaction summarization requests included, flagged `ctx.purpose`) and `afterToolResult(result, call, ctx) => result` (post-process tool output). Hooks run in registration order, errors sanitize and SKIP the hook (a broken extension must not kill turns), and both are documented as the extension surface replacing Pi's extension API. The M3-candidate `summarizer hook` falls out of `beforeProviderRequest` + `ctx.purpose === 'compaction'` for free — document that instead of a bespoke option.
- Tests: skill listing in system prompt, skill tool loads content, hook patch visible in the provider request, hook error skipped with warn, ordering.

Commit: `feat(agent): skills with on-demand loading; the two-seam hook surface`

---

### Task 6: `<agent-chat>` element

A custom element (`client/element.ts`, registered via exported `defineAgentChat()` — never auto-registered) wrapping the demo renderer: attributes `agent` and `session-id` (or auto-start), renders transcript/phases/approval bar/composer with parts and CSS custom properties for theming, tears down via `disconnectedCallback` → `stop()`. The demo app becomes its first consumer (replacing most of `client/main.js`, which shrinks to `defineAgentChat()` + one tag — and stays the proof the cursor API needs no framework). Browser-side tests: element mounts, streams, approval flow — in the client half of the suite; the live DDP integration test gains an element variant.

Commit: `feat(agent): <agent-chat> — the packaged UI, one tag`

---

### Task 7: Small candidates + docs close-out

`Agent.provider(name, impl)` global registry (config `provider: 'name'` strings resolve through it); manual `Agent.compact(sessionId)` (method + client, runs the §9 step immediately, guarded like a turn); `runAs` on tool specs (fixed userId for service tools, documented loudly next to the anonymous-session caveats); `rateLimit.approvals` covering approve+deny. README: all of M4, the RPC/print scope-honesty note, and the Scope section rewritten as "what v2 means now". CONTRIBUTING: the MCP SDK joins the pi-ai dependency policy. Final whole-branch review of the milestone, must-fixes applied, merge to main.

Commit: `feat(agent): provider registry, manual compact, runAs, approval rate limits; v2 docs`

---

## Done means

Spec §3's v2 list is either shipped (subagents, forking, MCP client, skills, extension surface, UI component, small candidates) or explicitly retired in writing (RPC/print modes). The tiers announced after M3 are complete, minus the two items only the user can unblock (live smoke key, Atmosphere login).
