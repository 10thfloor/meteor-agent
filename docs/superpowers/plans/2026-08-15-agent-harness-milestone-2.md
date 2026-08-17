# Meteor Agent Harness — Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `10thfloor:agent` safe to point at a real model and real users: a production pi-ai provider adapter, retry/backoff and error surfacing, approval gates that actually park, enforced budgets with cost accounting, DDP rate limits, and the hardening debt the Milestone 1 reviews filed.

**Architecture:** unchanged from Milestone 1 — transcript in `agent_messages`, streaming tokens in the capped `agent_deltas`, lease + heartbeat + atomic seq allocation for exactly-once writes, repair-on-entry for crash recovery. M2 adds no new collections; gates and budgets are fields on the session document plus note messages in the transcript, exactly as the spec (§7, §9, §10) describes.

**Tech Stack:** as M1. `@earendil-works/pi-ai@^0.84.x` (already an app dependency) becomes live via the loader.

**Source of truth:** `docs/superpowers/specs/2026-08-15-meteor-agent-harness-design.md` (§7 gates, §9 budgets, §10 errors), plus the M2 backlog recorded at the end of `.superpowers/sdd/progress.md`.

## Global Constraints

- Everything in the Milestone 1 plan's Global Constraints still binds: Meteor `3.5`+, package `10thfloor:agent`, package deps limited to `ecmascript, typescript, mongo, ddp, check, random, tracker` + `ddp-common` (server), pi-ai only ever reached through `server/providers/loader.ts`, Meteor 3 async Mongo APIs on the server, no `if (Meteor.isServer)` wrappers in test files, tests split `tests/server.ts` / `tests/client.ts`.
- Test command, from `app/` (port 3000 is typically held by an unrelated aerolite process on this machine; a blocked port hangs silently for >10 min):
  `TEST_BROWSER_DRIVER=playwright meteor test-packages --once --port 3200 --driver-package meteortesting:mocha ./packages/agent`
- Suite starts at **62 server + 1 client passing**. Every task reports the ACTUAL count after its change; the counts printed below are expectations, not gospel.
- **Every write during a turn stays lease-guarded or atomically allocated** (`guardedUpdate` with `$`-operator modifiers, or `allocateSeq`). New loop code paths added by gates/budgets/retry must follow the same rule; a reviewer should be able to enumerate the writes and find no exception.
- **The transcript is published to clients.** No new code path may write a raw error message, stack, or provider payload into `AgentMessages`. Error notes carry structured `{ error, reason }` only.
- **Network-free tests.** No task's tests may call a real LLM provider. The pi-ai adapter's unit tests exercise request/chunk mapping against stubs; one optional smoke test may run live but MUST be skipped when `ANTHROPIC_API_KEY` is unset (`it.skip` semantics, not failure).
- The loop's repair-on-entry invariants (full-transcript scan, per-turn-window answer detection, discard toward the repairable state, `awaiting`/`pending` guard) are settled behavior with tests. Gate work builds ON the `awaiting` guard; it must not weaken any of them.

---

### Task 1: Loader v2 — stop writing into `node_modules`

The M1 loader materializes a `.mjs` shim inside `node_modules/.agent-loader/` at runtime. On a read-only container filesystem (every serious production deploy) that `mkdir` throws and the fallback path is dead. Replace the mechanism: resolve pi-ai's entry file with Node's own resolver (`createRequire` — which understands `exports` maps), then dynamic-import the **absolute `file://` URL**. When a shim is still needed (if Meteor's runtime intercepts even URL imports), write it to the OS temp dir — always writable — and hand it the resolved URL rather than a bare specifier, so its location no longer matters for resolution.

**Files:**
- Modify: `app/packages/agent/server/providers/loader.ts`
- Modify: `app/packages/agent/tests/loader.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadPiAi(): Promise<unknown>` (unchanged signature), `resolvePiAiEntry(): string` (exported test seam replacing `shimLoad`'s role), `shimLoad(urlHref: string): Promise<unknown>` (now takes a `file://` href, temp-dir shim).

- [ ] **Step 1: Write the failing tests**

Replace the `pi-ai loader shim fallback` describe block in `tests/loader.test.ts` (keep the three `pi-ai loader` and two `mockProvider` blocks untouched):

```ts
describe('pi-ai loader v2 (no node_modules writes)', () => {
  it('resolves the pi-ai entry to an absolute file path', async function () {
    this.timeout(20000);
    const { resolvePiAiEntry } = await import('../server/providers/loader');
    const entry = resolvePiAiEntry();
    assert.isTrue(entry.startsWith('/'), `expected absolute path, got ${entry}`);
    assert.include(entry, '@earendil-works');
  });

  it('shimLoad imports a resolved file URL and yields a usable namespace', async function () {
    this.timeout(20000);
    const { resolvePiAiEntry, shimLoad } = await import('../server/providers/loader');
    const { pathToFileURL } = await import('url');
    const ns: any = await shimLoad(pathToFileURL(resolvePiAiEntry()).href);
    const schema = ns.Type.Object({ x: ns.Type.String() });
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['x']);
  });

  it('never writes inside node_modules', async function () {
    this.timeout(20000);
    const fs = await import('fs');
    const path = await import('path');
    const { loadPiAi, resolvePiAiEntry, shimLoad } = await import('../server/providers/loader');
    const { pathToFileURL } = await import('url');
    // Exercise every load path, then assert the M1 shim dir does not exist.
    await loadPiAi();
    await shimLoad(pathToFileURL(resolvePiAiEntry()).href);
    let dir = process.cwd();
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, 'node_modules', '.agent-loader');
      assert.isFalse(fs.existsSync(candidate), `stale shim dir at ${candidate}`);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  });

  it('rejects on an unresolvable entry', async function () {
    this.timeout(20000);
    const { shimLoad } = await import('../server/providers/loader');
    let threw = false;
    try { await shimLoad('file:///nonexistent/definitely-not-real.mjs'); }
    catch { threw = true; }
    assert.isTrue(threw);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `resolvePiAiEntry` is not exported; expect module-shape failures, not unrelated errors. Also delete any `node_modules/.agent-loader` left by M1 runs before the run (`rm -rf app/node_modules/.agent-loader`).

- [ ] **Step 3: Rewrite the loader**

Replace the body of `server/providers/loader.ts` below the `PKG` constant (keep `PKG`, `CANDIDATE_DIRS`, `findNodeModulesBase`, and the cache variable):

```ts
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import os from 'os';

/**
 * Resolve pi-ai's entry file with Node's OWN resolver, which understands
 * `exports` maps (Meteor's does not — the whole reason this file exists).
 * Anchoring createRequire at <base>/_resolver.js makes bare specifiers
 * resolve against the app's node_modules; the anchor file need not exist.
 * Exported as a test seam.
 */
export function resolvePiAiEntry(): string {
  const base = findNodeModulesBase();
  if (!base) {
    throw new Error(
      `[10thfloor:agent] ${PKG} not found. Install it in your app: ` +
      `meteor npm install --save ${PKG}`,
    );
  }
  return createRequire(path.join(base, '_resolver.js')).resolve(PKG);
}

/**
 * Import an absolute file:// URL through a genuine ESM module. The shim lives
 * in the OS temp dir — always writable, unlike node_modules on a read-only
 * container filesystem (the M1 shim's fatal flaw). Because it receives a
 * RESOLVED URL rather than a bare specifier, the shim's own location has no
 * bearing on resolution, which is what makes the temp dir usable at all.
 */
export async function shimLoad(urlHref: string): Promise<unknown> {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loader-'));
  const shimPath = path.join(shimDir, 'loader.mjs');
  fs.writeFileSync(shimPath, 'export const load = (u) => import(u);\n');
  try {
    const shim = createRequire(shimPath)(shimPath);
    return await shim.load(urlHref);
  } finally {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/**
 * Hedged, in order of preference:
 *  1. plain dynamic import of the bare specifier — becomes the only path the
 *     day Meteor ships `exports` support (PR #13520);
 *  2. dynamic import of the resolved file:// URL — works today in dev, no
 *     writes anywhere;
 *  3. temp-dir shim around the same URL — for a runtime whose import() is
 *     intercepted.
 * Returns the module namespace AS-IS (live bindings preserved); callers must
 * not mutate it.
 */
export async function loadPiAi(): Promise<unknown> {
  if (cached) return cached;
  try {
    cached = await import(PKG);
  } catch {
    const href = pathToFileURL(resolvePiAiEntry()).href;
    try {
      cached = await import(href);
    } catch {
      cached = await shimLoad(href);
    }
  }
  return cached;
}
```

Adjust the existing imports at the top of the file (`fs`, `path` already imported; add `createRequire`, `pathToFileURL`, `os`). Delete the M1 `shimLoad(specifier)` implementation and the `.agent-loader` constant.

- [ ] **Step 4: Run to verify pass** — expect **63 server** (62, minus the 3 removed shim-fallback tests, plus these 4) **+ 1 client**. Report the actual count.

- [ ] **Step 5: Commit**

```bash
git add app/packages/agent && git commit -m "fix(agent): loader v2 — resolve via createRequire, no node_modules writes"
```

---

### Task 2: The pi-ai provider adapter

The seam (`Provider` interface) exists; this task fills it. One caveat is structural: **pi-ai is pre-1.0 and its exact streaming API must be verified at runtime, not assumed.** The task therefore starts with a probe step whose findings go in the report, and the adapter code below is written against pi-ai's documented surface (`streamSimple`-style streaming with typed events); adapt the mapping layer — and ONLY the mapping layer — to what the probe shows.

**Files:**
- Create: `app/packages/agent/server/providers/piai.ts`
- Modify: `app/packages/agent/server/registry.ts` (provider becomes optional, defaulted from the model string)
- Modify: `app/packages/agent/server/index.ts` (export `piAiProvider`)
- Create: `app/packages/agent/tests/piai.test.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: `loadPiAi()` (Task 1), `Provider`, `ProviderRequest`, `ProviderChunk` from `providers/types.ts`.
- Produces: `piAiProvider(): Provider` — lazy singleton; `AgentConfig.provider` becomes optional, defaulting to `piAiProvider()`; `AgentConfig.pricing?: { input: number; output: number }` ($/Mtok, consumed by Task 5).

- [ ] **Step 1: Probe the real API surface**

Write a scratch server test (or use `meteor shell` against the running test app) that calls `loadPiAi()` and records: the exported function used to stream a completion, its parameter shape (model id form, message roles, tool schema field names), the event/chunk types it yields, and where usage tokens appear. Paste the findings verbatim into your report. Do not guess any of these.

- [ ] **Step 2: Write the failing mapping tests**

The adapter's testable core is two pure functions — `toPiAiRequest` and a chunk translator — which must be exported for tests. Create `tests/piai.test.ts`:

```ts
import { assert } from 'chai';
import { toPiAiRequest, translateEvent } from '../server/providers/piai';

describe('pi-ai adapter mapping', () => {
  const req = {
    model: 'anthropic/claude-sonnet-5',
    system: 'be terse',
    messages: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello', toolCalls: [{ id: 't1', name: 'look', args: { q: 1 } }] },
      { role: 'tool' as const, toolCallId: 't1', content: '{"found":true}' },
    ],
    tools: [{ name: 'look', description: 'd', parameters: { type: 'object', properties: {} } }],
  };

  it('maps provider/model, system, and message roles', () => {
    const out: any = toPiAiRequest(req);
    // Field names here MUST match what the Step 1 probe found — adjust the
    // assertions with the implementation, they pin the mapping either way.
    assert.isDefined(out.model);
    assert.include(JSON.stringify(out), 'be terse');
    assert.include(JSON.stringify(out), 'found');
  });

  it('maps tool schemas through', () => {
    const out: any = toPiAiRequest(req);
    assert.include(JSON.stringify(out), '"look"');
  });

  it('translates text deltas, tool calls, and usage', () => {
    // Shape the fake events like the probe's findings; these three cases must
    // cover: a text delta -> {kind:'text'}, a completed tool call ->
    // done.toolCalls, and usage -> done.usage.
    const text = translateEvent({ type: 'text_delta', delta: 'hel' } as any);
    assert.deepEqual(text, [{ kind: 'text', chunk: 'hel' }]);
  });

  it('never emits a chunk kind outside the ProviderChunk union', () => {
    const kinds = new Set(['text', 'thinking', 'tool_args', 'done']);
    for (const ev of [{ type: 'text_delta', delta: 'x' }, { type: 'unknown_future_event' }]) {
      for (const c of translateEvent(ev as any)) assert.isTrue(kinds.has(c.kind));
    }
  });
});
```

- [ ] **Step 3: Run to verify failure** (missing module).

- [ ] **Step 4: Implement the adapter**

Create `server/providers/piai.ts`. The mapping functions are pure and exported; the `Provider` wraps them around `loadPiAi()`:

```ts
import { loadPiAi } from './loader';
import type { Provider, ProviderChunk, ProviderRequest } from './types';

/** ProviderRequest -> pi-ai request. PURE; adjust to the probed API and keep
 *  the tests' assertions in lockstep. */
export function toPiAiRequest(req: ProviderRequest): unknown {
  return {
    model: req.model,                       // pi-ai model id form per probe
    system: req.system,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    })),
    tools: req.tools.map((t) => ({
      name: t.name, description: t.description, parameters: t.parameters,
    })),
  };
}

/** One pi-ai stream event -> zero or more ProviderChunks. PURE. Unknown event
 *  types map to [] — a future pi-ai event must never crash a turn. */
export function translateEvent(ev: any): ProviderChunk[] {
  switch (ev?.type) {
    case 'text_delta': return [{ kind: 'text', chunk: ev.delta }];
    case 'thinking_delta': return [{ kind: 'thinking', chunk: ev.delta }];
    // tool-call argument streaming, final tool calls and usage: fill in from
    // the probe; the terminal event must produce
    // [{ kind: 'done', toolCalls, usage: { input, output } }].
    default: return [];
  }
}

let singleton: Provider | null = null;

/** Lazy: pi-ai is only loaded the first time a turn actually streams. API keys
 *  come from the environment / Meteor.settings exactly as pi-ai itself reads
 *  them; this package adds no key plumbing of its own in M2. */
export function piAiProvider(): Provider {
  if (singleton) return singleton;
  singleton = {
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const piai: any = await loadPiAi();
      // Call the streaming entry point found by the Step 1 probe here, e.g.:
      //   const events = piai.streamSimple(toPiAiRequest(req));
      const events = piai.streamSimple(toPiAiRequest(req));
      for await (const ev of events) {
        for (const chunk of translateEvent(ev)) yield chunk;
      }
    },
  };
  return singleton;
}
```

- [ ] **Step 5: Default the provider in the registry**

In `server/registry.ts`, change `AgentConfig.provider` to optional, add `pricing?: { input: number; output: number }`, and resolve the default where the config is read (`getAgent` callers in `methods.ts` pass `config.provider` — change those sites to `config.provider ?? piAiProvider()`). Update the README's "provider is required" sentence: it is now required only when you want a mock or custom provider.

- [ ] **Step 6: Optional live smoke test**

At the bottom of `tests/piai.test.ts`:

```ts
(process.env.ANTHROPIC_API_KEY ? describe : describe.skip)('pi-ai live smoke', () => {
  it('streams one short completion end to end', async function () {
    this.timeout(60000);
    const { piAiProvider } = await import('../server/providers/piai');
    const chunks: any[] = [];
    for await (const c of piAiProvider().stream({
      model: 'anthropic/claude-haiku-4-5', system: 'Answer with one word.',
      messages: [{ role: 'user', content: 'Say hello.' }], tools: [],
    })) chunks.push(c);
    assert.isAbove(chunks.filter((c) => c.kind === 'text').length, 0);
    assert.equal(chunks[chunks.length - 1].kind, 'done');
  });
});
```

- [ ] **Step 7: Run (expect +4 server tests, live smoke skipped), commit**

```bash
git add app/packages/agent && git commit -m "feat(agent): pi-ai provider adapter with pure mapping layer, default provider"
```

---

### Task 3: Provider retry, backoff, and error notes (§10)

Milestone 1 lets a provider throw propagate to `mSend`'s `.catch` — the turn dies silently from the user's perspective. Implement §10's table: 429/5xx/network retry with backoff under `phase: 'retrying'`; 400/401/403 fail immediately; either terminal failure commits a `role:'note', kind:'error'` message and sets `phase: 'error'`.

**Files:**
- Modify: `app/packages/agent/server/loop.ts`
- Modify: `app/packages/agent/tests/loop.test.ts`

**Interfaces:**
- Consumes: existing loop internals (`DeltaWriter`, `allocateSeq`, `discardTurn`).
- Produces: `RunConfig.retry?: { attempts?: number; baseMs?: number }` (defaults 3 / 500); a `classifyProviderError(e): 'retryable' | 'fatal'` export (test seam).

- [ ] **Step 1: Failing tests** — three, using saboteur providers in the established style:

```ts
it('retries a retryable provider failure and then succeeds', async function () {
  this.timeout(30000);
  const { AgentMessages, AgentSessions } = await import('../common/collections');
  const { runTurn } = await import('../server/loop');
  await seed('s-retry', 'hello');
  let attempts = 0;
  const flaky: Provider = {
    async *stream() {
      attempts += 1;
      if (attempts < 3) { const e: any = new Error('rate limited'); e.status = 429; throw e; }
      yield { kind: 'text', chunk: 'recovered' };
      yield { kind: 'done', usage: { input: 1, output: 1 } };
    },
  };
  await runTurn('s-retry', { model: 'mock', system: '', tools: [], provider: flaky, retry: { attempts: 3, baseMs: 10 } });
  assert.equal(attempts, 3);
  const committed = await AgentMessages.findOneAsync({ sessionId: 's-retry', role: 'assistant' });
  assert.equal(committed!.content, 'recovered');
  assert.equal((await AgentSessions.findOneAsync('s-retry'))!.phase, 'idle');
});

it('does not retry a fatal provider error and surfaces a sanitized note', async function () {
  this.timeout(30000);
  const { AgentMessages, AgentSessions } = await import('../common/collections');
  const { runTurn } = await import('../server/loop');
  await seed('s-fatal', 'hello');
  let attempts = 0;
  const broken: Provider = {
    // eslint-disable-next-line require-yield
    async *stream() { attempts += 1; const e: any = new Error('invalid x-api-key sk-SECRET'); e.status = 401; throw e; },
  };
  await runTurn('s-fatal', { model: 'mock', system: '', tools: [], provider: broken, retry: { attempts: 3, baseMs: 10 } });
  assert.equal(attempts, 1, 'a 401 must not be retried');
  const note = await AgentMessages.findOneAsync({ sessionId: 's-fatal', role: 'note', kind: 'error' } as any);
  assert.isDefined(note);
  assert.notInclude(JSON.stringify(note), 'SECRET', 'raw provider messages must never reach the transcript');
  assert.equal((await AgentSessions.findOneAsync('s-fatal'))!.phase, 'error');
});

it('exhausted retries also produce an error note, and no partial commit', async function () {
  this.timeout(30000);
  const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
  const { runTurn } = await import('../server/loop');
  await seed('s-exhaust', 'hello');
  const alwaysDown: Provider = {
    async *stream() { yield { kind: 'text', chunk: 'par' }; const e: any = new Error('boom'); e.status = 503; throw e; },
  };
  await runTurn('s-exhaust', { model: 'mock', system: '', tools: [], provider: alwaysDown, retry: { attempts: 2, baseMs: 10 } });
  assert.equal(await AgentMessages.find({ sessionId: 's-exhaust', role: 'assistant' }).countAsync(), 0);
  assert.equal(await AgentDeltas.find({ sessionId: 's-exhaust' }).countAsync(), 0, 'partial deltas cleaned per attempt');
  assert.isDefined(await AgentMessages.findOneAsync({ sessionId: 's-exhaust', role: 'note', kind: 'error' } as any));
  assert.equal((await AgentSessions.findOneAsync('s-exhaust'))!.phase, 'error');
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

In `loop.ts`:

```ts
/** §10: 429, 5xx and network-ish errors retry; 4xx auth/request errors do
 *  not. Anything unclassifiable is treated as retryable — a transient blip
 *  should not permanently kill a session, and retries are bounded anyway. */
export function classifyProviderError(e: any): 'retryable' | 'fatal' {
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return 'retryable';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'fatal';
  return 'retryable';
}
```

Wrap the stream-consumption block (the `try { for await … } finally { writer.stop() }` section plus the DeltaWriter construction) in an attempt loop: on a throw, stop the writer, `AgentDeltas.removeAsync({ messageId })`, and classify. Retryable with attempts remaining → `guardedUpdate` `phase: 'retrying'`, `await sleep(baseMs * 2 ** attemptIndex)`, allocate a FRESH `messageId` (the old deltas are gone; a fresh id keeps any straggler flush inert), retry. Fatal or exhausted → commit the error note through the normal atomic path:

```ts
const noteSeq = await allocateSeq(sessionId);
if (noteSeq !== null) {
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'error',
    error: { error: 'provider-failed', reason: 'The model request failed.' },
    createdAt: new Date(),
  } as any);
  await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'error' } });
}
return;
```

The `finally` that idles the phase must learn one more terminal state: preserve `'error'` exactly as it preserves `'stopped'`. And `mSend`'s stopped→idle reset extends to `phase: { $in: ['stopped', 'error'] }` — a new message is the retry signal after a failure, matching §10's "the model usually recovers" philosophy.

Note the interaction with the mid-stream interrupt check and `toProviderMessages` (`role: 'note'` is already filtered from provider context — verify, don't re-implement).

- [ ] **Step 4: Run (expect +3), commit**

```bash
git add app/packages/agent && git commit -m "feat(agent): provider retry with backoff, sanitized error notes, phase error"
```

---

### Task 4: Approval gates — park, approve, deny, resume (§4.3, §7)

`gate: 'ask'` is currently parsed and silently ignored — a declared safety control that does nothing. Implement park-by-exiting: the loop writes `pending`, releases the lease, and exits; `approve`/`deny` record a verdict and wake the run; the resumed loop executes (or error-results) the parked call and continues. The repair-on-entry `awaiting` guard already protects the parked shape from being discarded — that was built in M1 precisely for this.

**Files:**
- Modify: `app/packages/agent/server/loop.ts`
- Modify: `app/packages/agent/server/methods.ts`
- Modify: `app/packages/agent/common/names.ts` (add `mApprove: 'agent.approve'`, `mDeny: 'agent.deny'`)
- Modify: `app/packages/agent/common/types.ts` (extend `pending` with `verdict?: 'approved' | 'denied'; by?: string | null; reason?: string`)
- Modify: `app/packages/agent/client/agent.ts` (add `approve`, `deny`, `pending`)
- Modify: `app/packages/agent/tests/loop.test.ts`
- Modify: `app/packages/agent/tests/capped.test.ts` (method auth for approve/deny)

**Interfaces:**
- Consumes: `ResolvedTool.gate` (exists), `session.pending` / `phase: 'awaiting'` (exist in types), repair guard (exists).
- Produces: methods `agent.approve(agent, sessionId)` / `agent.deny(agent, sessionId, reason?)`; client `Agent.approve/deny/pending`; `AgentConfig.approve?: (ctx: { userId: string | null }) => boolean | Promise<boolean>` (who may approve; default: the session's owner).

- [ ] **Step 1: Failing tests** — four server tests:

```ts
it('parks on an ask-gated tool: pending set, lease released, nothing dispatched', async function () {
  this.timeout(30000);
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const { runTurn } = await import('../server/loop');
  const { mockProvider } = await import('../server/providers/mock');
  await seed('s-gate', 'refund please');
  let toolRan = false;
  await runTurn('s-gate', {
    model: 'mock', system: '',
    tools: [{ name: 'refund', description: 'x', gate: 'ask',
      args: { type: 'object', properties: {} },
      run: async () => { toolRan = true; return 'refunded'; } }],
    provider: mockProvider(() => ({ toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] })),
  });
  assert.isFalse(toolRan);
  const doc = (await AgentSessions.findOneAsync('s-gate'))!;
  assert.equal(doc.phase, 'awaiting');
  assert.deepInclude(doc.pending as any, { toolCallId: 'g1', name: 'refund' });
  assert.isUndefined(doc.lease, 'a parked run holds no lease');
  // The assistant with the tool_use is COMMITTED (it is legitimate history).
  const assistant = await AgentMessages.findOneAsync({ sessionId: 's-gate', role: 'assistant' });
  assert.isDefined(assistant!.toolCalls);
});

it('approve wakes the run, executes the parked tool, and continues the turn', async function () {
  // Seed the PARKED state directly (previous test's shape), then drive the
  // approve method handler as the owner and await the deferred resume by
  // polling the session phase back to idle. Assert: tool result committed
  // with toolCallId g1, an approval note (kind:'approval', approved) exists,
  // pending cleared, and a follow-up assistant reply committed (script the
  // mock's second call to return text).
});

it('deny writes a denied tool result the model can see, and continues', async function () {
  // Same shape; assert the g1 tool row carries error {error:'denied'} and the
  // reason string, an approval note with denied:true exists, and the run
  // continued to a final assistant message rather than wedging.
});

it('a parked run survives repair-on-entry untouched', async function () {
  // Park (as above), then call runTurn again directly with the same config —
  // the awaiting/pending guard must return without discarding: the assistant
  // with the unanswered tool_use must still exist afterwards, pending intact.
});
```

Write these fully (the comments above describe intent; the test bodies must be complete code in the same idiom as the existing suite — seed helpers, direct method-handler invocation via `(Meteor.server as any).method_handlers`, bounded polling loops).

Plus method-auth cases appended to the existing authorization test: approve/deny as a non-owner and as anonymous both throw `no-session`; approve when nothing is pending throws `no-pending`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the park**

In the loop's tool-dispatch loop, after the phase/holdsLease pre-flights and BEFORE `runTool`:

```ts
const gate = tool?.gate ?? 'auto';
if (gate === 'ask') {
  // Park by exiting: no process waits, no timer runs. The committed
  // assistant + pending marker ARE the parked state; approve/deny wake it by
  // deferring a fresh runTurn. The repair guard (awaiting/pending) is what
  // keeps this shape from being discarded as an abandoned turn.
  const parked = await guardedUpdate(sessionId, SERVER_ID, {
    $set: {
      phase: 'awaiting',
      pending: { toolCallId: call.id, name: call.name, args: call.args, requestedAt: new Date() },
    },
  });
  if (!parked) { await discardTurn(sessionId, messageId, commitSeq, callIds); }
  return; // finally releases the lease; 'awaiting' must be preserved like 'stopped'
}
```

Extend the `finally`'s phase preservation to `['stopped', 'error', 'awaiting']`.

- [ ] **Step 4: Implement approve/deny methods**

In `methods.ts` (registered alongside the others; both authorize via `requireSession` first):

```ts
async [NAMES.mApprove](this: any, agent: string, sessionId: string) { /* … */ },
async [NAMES.mDeny](this: any, agent: string, sessionId: string, reason?: string) { /* … */ },
```

Shared behavior, written once and parameterized: require `phase === 'awaiting'` and `pending` with no verdict (else `Meteor.Error('no-pending')`); if `config.approve` is set, await it with `{ userId }` and throw `not-allowed` on false; write the verdict conditionally —
`updateAsync({ _id: sessionId, phase: 'awaiting', 'pending.verdict': { $exists: false } }, { $set: { 'pending.verdict': …, 'pending.by': this.userId ?? null, 'pending.reason': reason, phase: 'idle' } })` — and treat a 0-match as a lost race (`no-pending`), so two approvers cannot both win. Insert the approval note (`role:'note', kind:'approval'`, `content` unset, structured fields only) via an atomic seq allocation — note `allocateSeq` guards on the lease, which a parked run does not hold; use a direct `findOneAndUpdate` on `{ _id: sessionId }` for the note's seq instead, mirroring `mSend`. Then `Meteor.defer` a `runTurn` with the registry config (same shape as `mSend`'s defer, same `.catch`).

- [ ] **Step 5: Implement the resume**

In `runTurn`, after `repairUnansweredToolUse` and before the iteration loop: if the session carries `pending.verdict`, locate the assistant containing `pending.toolCallId`; for `approved`, `runTool` it and commit the result; for `denied`, commit a tool row with `error: { error: 'denied', reason }`. Clear `pending` (`$unset`) under `guardedUpdate`. Then fall through to the iteration loop — whose next history read now ends in a `tool` row and proceeds normally. Remaining unanswered calls from the same assistant park again on their own gates as the loop re-dispatches them; simplest correct shape: the resume executes ONLY the verdict call, then lets `repairUnansweredToolUse`'s window logic… **no** — remaining unanswered calls would look stranded. Handle it explicitly: after resolving the verdict call, re-enter the tool-dispatch loop for the REMAINING unanswered calls of that assistant (reusing the same dispatch code — factor the per-call body into a helper if needed) so each one runs or parks by its own gate. Only then fall into the think loop.

- [ ] **Step 6: Client surface**

`client/agent.ts`: `approve(sessionId)` / `deny(sessionId, reason?)` call the methods; `pending(sessionId)` returns `(this.session(sessionId) as any)?.pending`.

- [ ] **Step 7: Run (expect +5 or so), commit**

```bash
git add app/packages/agent && git commit -m "feat(agent): ask-gates park by exiting; approve/deny wake and resume the run"
```

---

### Task 5: Budgets and cost accounting (§9)

Milestone 1 established that nothing outside the harness limits loop-initiated work — budgets are the only brake. Enforce `budget.turns`, `budget.toolCalls`, and `budget.spend` (against `pricing`), committing a `kind:'budget'` note and `phase:'stopped'` when one trips.

**Files:**
- Modify: `app/packages/agent/server/registry.ts` (add `budget?: { turns?: number; toolCalls?: number; spend?: number | string }`)
- Modify: `app/packages/agent/server/loop.ts`
- Modify: `app/packages/agent/server/methods.ts` (`mSend` refuses when the turn budget is already exhausted)
- Modify: `app/packages/agent/tests/loop.test.ts`

**Interfaces:**
- Consumes: `session.budgetSpent` (maintained since M1), `AgentConfig.pricing` (Task 2), `allocateSeq`.
- Produces: `parseSpend('$1.00' | 1.0): number` export (test seam); `RunConfig.budget` / `RunConfig.pricing` threaded from the registry by `mSend`.

- [ ] **Step 1: Failing tests** — turns budget refuses the (N+1)th send with `Meteor.Error('budget-exhausted')`; toolCalls budget stops mid-turn with a `kind:'budget'` note and no stranded tool_use (the in-flight assistant's remaining calls are discarded via `discardTurn`, same as an interrupt); spend budget: seed `usage.cost` just under the cap with pricing set, run a turn whose usage pushes past it, assert the NEXT think is refused with the note. Also `parseSpend('$1.50') === 1.5`, `parseSpend(2) === 2`, and a malformed string throws at `define()` time.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** `parseSpend` validates at `defineAgent` time. In the loop: before each iteration's provider call, check turns/spend; before each tool dispatch, check toolCalls. Cost accrues in the commit's `allocateSeq` `$inc` as `'usage.cost': (usage.input * pricing.input + usage.output * pricing.output) / 1e6` — computed before the call, passed into the existing `$inc` object (no new write). A tripped budget commits its note through `allocateSeq` and sets `phase: 'stopped'` (reusing the interrupt semantics: durable until the next send — which for `turns`/`spend` will refuse anyway in `mSend`, closing the loop).

- [ ] **Step 4: Run (expect +5), commit**

```bash
git add app/packages/agent && git commit -m "feat(agent): enforce turn, tool-call and spend budgets with transcript notes"
```

---

### Task 6: Rate limiting and wire hygiene

**Files:**
- Modify: `app/packages/agent/server/index.ts` (rate-limit rules from settings at startup)
- Modify: `app/packages/agent/server/publications.ts` (omit `lease` from published session docs)
- Modify: `app/packages/agent/package.js` (add `ddp-rate-limiter` to the server `api.use`)
- Modify: `app/packages/agent/tests/capped.test.ts`

**Interfaces:**
- Consumes: `Meteor.settings.packages['10thfloor:agent'].rateLimit` — `{ sends?: { count: number; intervalMs: number }, starts?: { count: number; intervalMs: number } }`.
- Produces: nothing new in code; behavior only.

- [ ] **Step 1: Failing tests.** Publications: the `agent.session` owner-path test gains an assertion that the fetched session doc has no `lease` field. Rate limiting: register the rules via an exported `applyRateLimits(settings)` (test seam — startup calls it with real settings, the test with fixtures) and assert via `DDPRateLimiter._findMatchingRule`-style introspection OR by invoking the limiter's increment/check API directly that the rule matches `{ type: 'method', name: 'agent.send' }` for a given userId. Keep it to what Meteor's public-ish API allows; if only registration can be asserted cleanly, assert registration and say so in the report.

- [ ] **Step 2–3: Implement.** `applyRateLimits` adds one `DDPRateLimiter.addRule` per configured entry (per-`userId` scoping, method-name match). Publications: `AgentSessions.find({ _id: sessionId }, { fields: { lease: 0 } })` in `agent.session`, and the same projection in `agent.sessions`. Verify the client (`status()`, `usage()`, `pending()`) reads none of `lease` — it does not.

- [ ] **Step 4: Run (expect +2), commit**

```bash
git add app/packages/agent && git commit -m "feat(agent): settings-driven DDP rate limits; stop publishing lease internals"
```

---

### Task 7: Hardening debt from the M1 reviews

Three items the final review rated SHOULD-FIX, each defended today only by comments.

**Files:**
- Modify: `app/packages/agent/server/loop.ts` (DeltaWriter drain remainder; lease-timing test seam)
- Modify: `app/packages/agent/server/lease.ts` (timings become module state with a test-only setter)
- Modify: `app/packages/agent/tests/loop.test.ts`, `app/packages/agent/tests/lease.test.ts`

- [ ] **Step 1: DeltaWriter remainder.** In `drain()`, wrap the per-item insert so a mid-batch throw splices the unwritten remainder back onto `this.buf` (order-preserving: `this.buf = [...remainder, ...this.buf]`) before rethrowing to the (already-swallowing) caller — closing the seq-gap-truncates-render hole. Test: monkey-patch `AgentDeltas.insertAsync` to fail once mid-batch (the suite's established own-property-descriptor technique, restored in `finally`), stream a message, assert the committed content and the mid-stream-captured delta seqs are complete and contiguous.

- [ ] **Step 2: Heartbeat under test.** In `lease.ts`, convert `LEASE_MS`/`HEARTBEAT_MS` to `let` with a test-only exported `_setLeaseTimings({ leaseMs, heartbeatMs })` (comment: test seam, not API; loop reads them at call time). Test: shrink to `{ leaseMs: 300, heartbeatMs: 80 }`, run a paced turn lasting ~1s, assert mid-turn that `lease.until` advances beyond its initial value (the heartbeat is what did that) and the turn commits normally — then restore timings in `finally`. This test fails if the heartbeat interval is never started or the constants are inverted.

- [ ] **Step 3: discardTurn order failure-injection.** Monkey-patch `AgentMessages.removeAsync` to throw exactly once when the selector targets `_id` (the assistant-row removal — the LAST step), drive the lease-stolen-mid-tool scenario, and assert the resulting state is the REPAIRABLE one: the assistant row survives with unanswered calls, and a subsequent `runTurn` repairs it (final transcript has no unanswered tool_use). This is the test that makes the delete-order load-bearing instead of comment-defended.

- [ ] **Step 4: Run (expect +3), commit**

```bash
git add app/packages/agent && git commit -m "test(agent): heartbeat, discard-order and delta-remainder now enforced by tests"
```

---

## Milestone 2 done — what works

An agent defined with just `model` and `instructions` streams from a real
provider through pi-ai, retries transient failures, surfaces terminal ones as
transcript notes, refuses to exceed its budgets, parks on `ask`-gated tools
until a human approves or denies from the client API, and is rate-limited at
the DDP boundary — on a deployment whose filesystem the package never writes
into.

## Milestone 3 (separate plan)

Compaction (§9); the `observeChangesAsync` orphan-claim watcher (§4.3);
`Agent.method()` co-registration and TypeBox validation of inline tool args
(§6); `Agent.ask()` headless one-shot; client teardown (`Agent.stop()`);
`tool_args` delta streaming; approval timeout (`budget.approval`) — deferred
here because it needs the watcher (a parked run has no process to time it out).

## Deferred to v2 (per spec §3, unplanned)

Subagents, Agent Skills / resource loading, MCP, session forking, extension
API, RPC/print modes, bundled UI components.
