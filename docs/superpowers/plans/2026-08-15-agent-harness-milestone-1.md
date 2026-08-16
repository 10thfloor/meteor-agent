# Meteor Agent Harness — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Meteor 3.5 Atmosphere package where an app can define an agent, send it a message, and watch assistant tokens stream into a reactive minimongo cursor — surviving a mid-turn server restart.

**Architecture:** The transcript is a Mongo collection; in-flight tokens are a capped collection; tools are Meteor methods invoked through a real `DDPCommon.MethodInvocation`; provider access is `@earendil-works/pi-ai` behind a runtime loader. A lease on the session document makes exactly one app server drive a run, and makes an orphaned run recoverable by any other.

**Tech Stack:** Meteor 3.5, TypeScript, MongoDB (change streams), `@earendil-works/pi-ai` (app peer dependency), `typebox` for tool schemas, `meteortesting:mocha` + `chai` for tests.

**Source of truth:** `docs/superpowers/specs/2026-08-15-meteor-agent-harness-design.md`. Spike findings S1–S5 are folded in below; reference implementations live in `spike/`.

## Global Constraints

- Meteor release: `METEOR@3.5` exactly or newer. Node 24.15.
- Package name: `10thfloor:agent`. Version starts at `0.1.0`.
- Package dependencies only: `ecmascript`, `typescript`, `mongo`, `ddp`, `check`, `random`, `tracker`, and `ddp-common` (server only). **No `durable:*` packages. No `accounts-base` dependency** — read userId through `DDP._CurrentMethodInvocation`, never assume `Meteor.userId` exists (S2).
- **Tests are split by architecture.** `Package.onTest` declares
  `api.mainModule('tests/server.ts', 'server')` and
  `api.mainModule('tests/client.ts', 'client')`. Server-side test files are
  reached only from `tests/server.ts` and contain **no `if (Meteor.isServer)`
  wrapper** — they already build server-only. A single dual-architecture test
  entry would drag `server/tools.ts` (which imports the server-only
  `ddp-common`) into the client bundle and fail the build.
- `@earendil-works/pi-ai` is an **app-level peer dependency**, never `Npm.depends`. It is reached **only** through `server/providers/loader.ts` (S1). No other file may reference it.
- All MongoDB access uses Meteor 3 async APIs: `insertAsync`, `updateAsync`, `findOneAsync`, `removeAsync`, `countAsync`, `observeChangesAsync`. Never the sync forms.
- Tool dispatch **must** use `new DDPCommon.MethodInvocation(...)`. A plain object is not sufficient — handlers calling `this.unblock()` throw (S2b).
- Every commit to `AgentMessages` or `AgentSessions` during a turn is **conditional on lease ownership** (S4).
- Delta documents carry `msgSeq`; the merge renders the contiguous **tail** (S5).
- Test command, run from `app/`: `meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent`

---

### Task 1: Repo skeleton, package scaffold, shared types

Creates the app that hosts the package, the package manifest, and the type
definitions every later task imports.

**Files:**
- Create: `app/` (via `meteor create`)
- Create: `app/packages/agent/package.js`
- Create: `app/packages/agent/common/types.ts`
- Create: `app/packages/agent/common/names.ts`
- Create: `app/packages/agent/server/index.ts`
- Create: `app/packages/agent/client/index.ts`
- Create: `app/packages/agent/tests/server.ts`
- Create: `app/packages/agent/tests/client.ts`
- Create: `app/packages/agent/tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentSession`, `AgentMessage`, `AgentDelta`, `Phase`, `Usage` types from `common/types.ts`; `NAMES` constants from `common/names.ts`.

- [ ] **Step 1: Create the host app**

```bash
cd /Users/mk/Desktop/meteor-agent
meteor create app --minimal --release METEOR@3.5
cd app
meteor add mongo ddp ddp-common check random
meteor add meteortesting:mocha
meteor npm install --save-dev chai
meteor npm install --save @earendil-works/pi-ai
mkdir -p packages/agent/{common,server,client,tests}
```

- [ ] **Step 2: Write the package manifest**

Create `app/packages/agent/package.js`:

```js
Package.describe({
  name: '10thfloor:agent',
  version: '0.1.0',
  summary: 'A Pi-based agent harness for Meteor 3.5+',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript', 'mongo', 'ddp', 'check', 'random', 'tracker']);
  api.use(['ddp-common'], 'server');
  api.mainModule('server/index.ts', 'server');
  api.mainModule('client/index.ts', 'client');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'typescript', 'mongo', 'ddp', 'check', 'random', 'tracker']);
  api.use(['ddp-common'], 'server');
  api.use('meteortesting:mocha');
  api.use('10thfloor:agent');
  // Split by architecture: server tests must never reach the client bundle.
  api.mainModule('tests/server.ts', 'server');
  api.mainModule('tests/client.ts', 'client');
});
```

- [ ] **Step 3: Write the shared types**

Create `app/packages/agent/common/types.ts`:

```ts
export type Phase =
  | 'idle' | 'streaming' | 'calling' | 'awaiting'
  | 'compacting' | 'retrying' | 'stopped' | 'error';

export interface Usage { input: number; output: number; cost: number }

export interface AgentSession {
  _id: string;
  agent: string;
  userId: string | null;
  title?: string;
  phase: Phase;
  model: string;
  usage: Usage;
  nextSeq: number;
  pending?: { toolCallId: string; name: string; args: unknown };
  lease?: { serverId: string; until: Date };
  budgetSpent: { turns: number; toolCalls: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentToolCall { id: string; name: string; args: unknown }

export interface AgentMessage {
  _id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'note';
  content?: string;
  thinking?: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  error?: { error: string; reason?: string };
  kind?: 'compaction' | 'error' | 'budget' | 'interrupted' | 'approval';
  usage?: { input: number; output: number };
  createdAt: Date;
}

export type DeltaKind = 'text' | 'thinking' | 'tool_args' | 'tool_output';

export interface AgentDelta {
  _id: string;
  sessionId: string;
  messageId: string;
  msgSeq: number;
  seq: number;
  kind: DeltaKind;
  chunk: string;
  at: Date;
}

/** A merged row: either a committed message or an in-flight reconstruction. */
export interface ViewMessage extends Omit<AgentMessage, 'createdAt'> {
  streaming: boolean;
  truncatedHead?: boolean;
  deltaCount?: number;
  createdAt?: Date;
}
```

- [ ] **Step 4: Write the shared name constants**

Create `app/packages/agent/common/names.ts`:

```ts
export const NAMES = {
  sessions: 'agent_sessions',
  messages: 'agent_messages',
  deltas: 'agent_deltas',
  pubSession: 'agent.session',
  pubSessions: 'agent.sessions',
  mStart: 'agent.start',
  mSend: 'agent.send',
  mInterrupt: 'agent.interrupt',
} as const;

/** Capped collection size in bytes. Sized for ~200 concurrent streaming turns. */
export const DELTA_CAP_BYTES = 32 * 1024 * 1024;
```

- [ ] **Step 5: Write placeholder entry points**

Create `app/packages/agent/server/index.ts`:

```ts
export * from '../common/types';
export { NAMES } from '../common/names';
```

Create `app/packages/agent/client/index.ts`:

```ts
export * from '../common/types';
export { NAMES } from '../common/names';
```

- [ ] **Step 6: Write the smoke test**

Create `app/packages/agent/tests/smoke.test.ts`:

```ts
import { assert } from 'chai';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

describe('10thfloor:agent scaffold', () => {
  it('exposes stable collection names', () => {
    assert.equal(NAMES.sessions, 'agent_sessions');
    assert.equal(NAMES.messages, 'agent_messages');
    assert.equal(NAMES.deltas, 'agent_deltas');
  });

  it('sizes the delta cap in bytes', () => {
    assert.isAbove(DELTA_CAP_BYTES, 1024 * 1024);
  });
});
```

Create `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
```

Create `app/packages/agent/tests/client.ts`:

```ts
// Client-side tests. Empty until Task 8's live DDP round trip. Keeping every
// other test server-only is what stops server modules reaching the client
// bundle, and keeps the reported test counts in this plan meaningful.
export {};
```

- [ ] **Step 7: Run the tests — expect PASS**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: `2 passing`, exit code 0.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent app/.meteor app/package.json
git commit -m "feat(agent): package scaffold, shared types, name constants"
```

---

### Task 2: The merge function (port S5)

Ports the spike-validated merge into the package with its full adversarial
suite. This is pure and isomorphic, so it needs no database.

**Files:**
- Create: `app/packages/agent/common/merge.ts`
- Create: `app/packages/agent/tests/merge.test.ts`
- Modify: `app/packages/agent/tests/server.ts`
- Reference: `spike/imports/merge.js`, `spike/server/s5.js`

**Interfaces:**
- Consumes: `AgentMessage`, `AgentDelta`, `ViewMessage` from `common/types.ts`.
- Produces: `mergeView(committed: AgentMessage[], deltas: AgentDelta[]): ViewMessage[]`.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/agent/tests/merge.test.ts`:

```ts
import { assert } from 'chai';
import { mergeView } from '../common/merge';
import type { AgentDelta, AgentMessage, ViewMessage } from '../common/types';

const delta = (
  messageId: string, seq: number, chunk: string,
  opts: { msgSeq?: number; kind?: AgentDelta['kind'] } = {},
): AgentDelta => ({
  _id: `${messageId}:${seq}`,
  sessionId: 's1',
  messageId,
  msgSeq: opts.msgSeq ?? 10,
  seq,
  kind: opts.kind ?? 'text',
  chunk,
  at: new Date(0),
});

const streamOf = (messageId: string, text: string, opts = {}) =>
  text.split('').map((c, i) => delta(messageId, i, c, opts));

const render = (view: ViewMessage[]) =>
  view.map((m) => (m.truncatedHead ? `…${m.content}` : m.content)).join('|');

function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const committed: AgentMessage[] = [{
  _id: 'm1', sessionId: 's1', seq: 10, role: 'assistant',
  content: 'hello world', createdAt: new Date(0),
}];

describe('mergeView', () => {
  it('renders an in-order stream', () => {
    assert.equal(render(mergeView([], streamOf('m1', 'hello'))), 'hello');
  });

  it('is order-independent across 50 shuffles', () => {
    const src = streamOf('m1', 'hello world');
    for (let s = 1; s <= 50; s += 1) {
      assert.equal(render(mergeView([], shuffle(src, s))), 'hello world', `seed ${s}`);
    }
  });

  it('dedupes duplicate delivery', () => {
    const src = streamOf('m1', 'hello world');
    assert.equal(render(mergeView([], [...src, ...src])), 'hello world');
  });

  it('lets a committed message supersede its deltas', () => {
    assert.equal(render(mergeView(committed, streamOf('m1', 'hello world'))), 'hello world');
    assert.lengthOf(mergeView(committed, streamOf('m1', 'hello world')), 1);
  });

  it('renders the contiguous TAIL when the head is evicted', () => {
    const evicted = streamOf('m1', 'hello world').filter((d) => d.seq >= 6);
    assert.equal(render(mergeView([], evicted)), '…world');
  });

  it('renders the contiguous tail across a mid gap', () => {
    const gap = streamOf('m1', 'abcdefghij').filter((d) => d.seq <= 2 || d.seq >= 7);
    assert.equal(render(mergeView([], gap)), '…hij');
  });

  it('ignores deltas arriving after commit', () => {
    const late = [...streamOf('m1', 'hello world'), delta('m1', 99, 'X')];
    assert.equal(render(mergeView(committed, late)), 'hello world');
  });

  it('orders interleaved in-flight messages by msgSeq', () => {
    const two = shuffle([
      ...streamOf('mA', 'AAA', { msgSeq: 11 }),
      ...streamOf('mB', 'BBB', { msgSeq: 12 }),
    ], 7);
    assert.equal(render(mergeView([], two)), 'AAA|BBB');
  });

  it('interleaves committed and in-flight by seq', () => {
    const view = mergeView(
      [{ _id: 'm0', sessionId: 's1', seq: 9, role: 'user', content: 'Q', createdAt: new Date(0) }],
      streamOf('m1', 'A', { msgSeq: 10 }),
    );
    assert.equal(render(view), 'Q|A');
  });

  it('keeps non-text kinds out of content', () => {
    const withThinking = [...streamOf('m1', 'hi'), delta('m1', 2, 'ponder', { kind: 'thinking' })];
    const view = mergeView([], withThinking);
    assert.equal(view[0].content, 'hi');
    assert.equal(view[0].thinking, 'ponder');
  });

  it('handles degenerate inputs', () => {
    assert.deepEqual(mergeView([], []), []);
    assert.equal(render(mergeView(committed, [])), 'hello world');
  });

  it('renders a single delta whose head is gone', () => {
    assert.equal(render(mergeView([], [delta('m1', 7, 'z')])), '…z');
  });

  it('marks in-flight rows as streaming', () => {
    const view = mergeView([], streamOf('m1', 'hi'));
    assert.isTrue(view[0].streaming);
    assert.isFalse(mergeView(committed, [])[0].streaming);
  });
});
```

- [ ] **Step 2: Register the test file**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: FAIL — `Cannot find module '../common/merge'`.

- [ ] **Step 4: Write the implementation**

Create `app/packages/agent/common/merge.ts`:

```ts
import type { AgentDelta, AgentMessage, ViewMessage } from './types';

/**
 * Merge committed messages with in-flight deltas into one ordered view.
 *
 * A capped collection evicts the OLDEST documents, so a gap in delta `seq` is
 * always a missing HEAD. Walking forward from seq 0 would render an empty
 * string for any message whose start had aged out — the routine case. We walk
 * back from the highest seq instead and flag `truncatedHead`.
 */
export function mergeView(
  committedMessages: AgentMessage[],
  deltaDocs: AgentDelta[],
): ViewMessage[] {
  const committed: ViewMessage[] = committedMessages.map((m) => ({ ...m, streaming: false }));
  const committedIds = new Set(committed.map((m) => m._id));

  const seen = new Set<string>();
  const byMessage = new Map<string, AgentDelta[]>();
  for (const d of deltaDocs) {
    if (seen.has(d._id)) continue;
    seen.add(d._id);
    if (committedIds.has(d.messageId)) continue;   // commit always wins
    const bucket = byMessage.get(d.messageId);
    if (bucket) bucket.push(d);
    else byMessage.set(d.messageId, [d]);
  }

  const inFlight: ViewMessage[] = [];
  for (const [messageId, ds] of byMessage) {
    ds.sort((a, b) => a.seq - b.seq);

    let cut = ds.length - 1;
    while (cut > 0 && ds[cut].seq - ds[cut - 1].seq === 1) cut -= 1;
    const tail = ds.slice(cut);

    const join = (kind: AgentDelta['kind']) =>
      tail.filter((d) => d.kind === kind).map((d) => d.chunk).join('');

    const thinking = join('thinking');
    inFlight.push({
      _id: messageId,
      sessionId: ds[0].sessionId,
      seq: ds[0].msgSeq,
      role: 'assistant',
      content: join('text'),
      thinking: thinking || undefined,
      streaming: true,
      truncatedHead: tail[0].seq !== 0,
      deltaCount: tail.length,
    });
  }

  return [...committed, ...inFlight].sort((a, b) =>
    a.seq !== b.seq ? a.seq - b.seq : (a._id < b._id ? -1 : 1));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: `15 passing`.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): merge committed messages with in-flight deltas (S5)"
```

---

### Task 3: The hedged pi-ai loader and provider seam

The only file in the package permitted to know pi-ai exists. Per S1, a plain
`import` cannot work: Meteor resolves pi-ai but not its transitive dependency
`typebox`, which declares no `main`.

**Files:**
- Create: `app/packages/agent/server/providers/types.ts`
- Create: `app/packages/agent/server/providers/loader.ts`
- Create: `app/packages/agent/server/providers/mock.ts`
- Create: `app/packages/agent/tests/loader.test.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Provider`, `ProviderRequest`, `ProviderChunk`, `ToolSchema` from `providers/types.ts`; `loadPiAi(): Promise<any>` from `providers/loader.ts`; `mockProvider(script): Provider` from `providers/mock.ts`.

- [ ] **Step 1: Write the provider contract**

Create `app/packages/agent/server/providers/types.ts`:

```ts
export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;          // JSON Schema, produced by TypeBox
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolSchema[];
}

export type ProviderChunk =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_args'; chunk: string }
  | { kind: 'done';
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
      usage?: { input: number; output: number } };

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}
```

- [ ] **Step 2: Write the failing loader test**

Create `app/packages/agent/tests/loader.test.ts`:

```ts
import { assert } from 'chai';
import { loadPiAi } from '../server/providers/loader';

describe('pi-ai loader', () => {
  it('loads the pi-ai namespace despite the typebox exports map', async function () {
    this.timeout(20000);
    const piai: any = await loadPiAi();
    assert.isObject(piai);
    assert.isAbove(Object.keys(piai).length, 10);
  });

  it('exposes a usable TypeBox Type through pi-ai', async function () {
    this.timeout(20000);
    const piai: any = await loadPiAi();
    const schema = piai.Type.Object({ orderId: piai.Type.String() });
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['orderId']);
  });

  it('caches the namespace across calls', async function () {
    this.timeout(20000);
    const a = await loadPiAi();
    const b = await loadPiAi();
    assert.strictEqual(a, b);
  });
});
```

- [ ] **Step 3: Register it**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
```

- [ ] **Step 4: Run to verify failure**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: FAIL — `Cannot find module '../server/providers/loader'`.

- [ ] **Step 5: Write the loader**

Create `app/packages/agent/server/providers/loader.ts`:

```ts
import path from 'path';
import fs from 'fs';

const PKG = '@earendil-works/pi-ai';

/**
 * Meteor cannot resolve pi-ai's transitive dep `typebox` (no `main`, exports
 * map only). We reach Node's own resolver through a one-line ESM shim: a real
 * ESM module HAS a dynamic-import callback, which Meteor's CJS server bundle
 * does not.
 *
 * Dev places app npm deps in `node_modules`; a production `meteor build` places
 * them in `npm/node_modules`. Both are searched.
 */
const CANDIDATE_DIRS = ['node_modules', path.join('npm', 'node_modules')];

let cached: unknown = null;

function findNodeModulesBase(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      if (fs.existsSync(path.join(dir, c, ...PKG.split('/')))) return path.join(dir, c);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function shimLoad(specifier: string): Promise<unknown> {
  const base = findNodeModulesBase();
  if (!base) {
    throw new Error(
      `[10thfloor:agent] ${PKG} not found. Install it in your app: ` +
      `meteor npm install --save ${PKG}`,
    );
  }
  const shimDir = path.join(base, '.agent-loader');
  const shimPath = path.join(shimDir, 'loader.mjs');
  if (!fs.existsSync(shimPath)) {
    fs.mkdirSync(shimDir, { recursive: true });
    // Fixed literal. The specifier is always a package-controlled constant and
    // must never come from user input or model output.
    fs.writeFileSync(shimPath, 'export const load = (s) => import(s);\n');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const shim = createRequire(shimPath)(shimPath);
  return shim.load(specifier);
}

/** Hedged: plain import first, so the shim disappears once Meteor ships
 *  `exports` support (PR #13520). Falls back to the shim on any failure. */
export async function loadPiAi(): Promise<unknown> {
  if (cached) return cached;
  try {
    cached = await import(PKG);
  } catch {
    cached = await shimLoad(PKG);
  }
  return cached;
}
```

- [ ] **Step 6: Run to verify pass**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: `18 passing`. If the build prints `Cannot find module 'typebox'` warnings, that is expected — the throw is caught at runtime.

- [ ] **Step 7: Write the mock provider**

Create `app/packages/agent/server/providers/mock.ts`:

```ts
import type { Provider, ProviderChunk, ProviderRequest } from './types';

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: { input: number; output: number };
}

export type MockScript = (req: ProviderRequest) => MockTurn;

/** Deterministic scripted provider — no API key, no network. Text is emitted
 *  one character per chunk so tests can assert on partial streams. */
export function mockProvider(script: MockScript): Provider {
  return {
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const turn = script(req);
      for (const ch of (turn.text ?? '')) {
        yield { kind: 'text', chunk: ch };
      }
      yield {
        kind: 'done',
        toolCalls: turn.toolCalls,
        usage: turn.usage ?? { input: 10, output: (turn.text ?? '').length },
      };
    },
  };
}
```

- [ ] **Step 8: Test the mock provider**

Append to `app/packages/agent/tests/loader.test.ts`:

```ts
import { mockProvider } from '../server/providers/mock';
import type { ProviderChunk } from '../server/providers/types';

describe('mockProvider', () => {
  it('streams text one chunk at a time then a done chunk', async () => {
    const p = mockProvider(() => ({ text: 'hi' }));
    const chunks: ProviderChunk[] = [];
    for await (const c of p.stream({ model: 'm', system: '', messages: [], tools: [] })) {
      chunks.push(c);
    }
    assert.deepEqual(chunks.map((c) => c.kind), ['text', 'text', 'done']);
    assert.equal(
      chunks.filter((c) => c.kind === 'text').map((c: any) => c.chunk).join(''),
      'hi',
    );
  });

  it('passes tool calls through the done chunk', async () => {
    const p = mockProvider(() => ({ toolCalls: [{ id: 't1', name: 'lookup', args: { q: 1 } }] }));
    const out: ProviderChunk[] = [];
    for await (const c of p.stream({ model: 'm', system: '', messages: [], tools: [] })) out.push(c);
    const done: any = out[out.length - 1];
    assert.equal(done.toolCalls[0].name, 'lookup');
  });
});
```

Note: the `import` lines go at the top of the file alongside the existing ones,
not mid-file.

- [ ] **Step 9: Run to verify pass**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected: `20 passing`.

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): hedged pi-ai loader, provider seam, mock provider (S1)"
```

---

### Task 4: Collections, capped delta store, publications

**Files:**
- Create: `app/packages/agent/common/collections.ts`
- Create: `app/packages/agent/server/capped.ts`
- Create: `app/packages/agent/server/publications.ts`
- Create: `app/packages/agent/tests/capped.test.ts`
- Modify: `app/packages/agent/server/index.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: `NAMES`, `DELTA_CAP_BYTES`, the types from Task 1.
- Produces: `AgentSessions`, `AgentMessages`, `AgentDeltas` collections from `common/collections.ts`; `ensureCapped(): Promise<void>` from `server/capped.ts`.

- [ ] **Step 1: Write the collections**

Create `app/packages/agent/common/collections.ts`:

```ts
import { Mongo } from 'meteor/mongo';
import { NAMES } from './names';
import type { AgentDelta, AgentMessage, AgentSession } from './types';

export const AgentSessions = new Mongo.Collection<AgentSession>(NAMES.sessions);
export const AgentMessages = new Mongo.Collection<AgentMessage>(NAMES.messages);
export const AgentDeltas = new Mongo.Collection<AgentDelta>(NAMES.deltas);
```

- [ ] **Step 2: Write the failing capped test**

Create `app/packages/agent/tests/capped.test.ts`. **Drop the
`if (Meteor.isServer) { … }` wrapper shown below and de-indent its body** — per
Global Constraints this file is reached only from `tests/server.ts` and is
already server-only, so the guard is dead code:

```ts
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';

if (Meteor.isServer) {
  describe('capped delta collection', () => {
    it('creates agent_deltas as capped and is idempotent', async function () {
      this.timeout(20000);
      const { ensureCapped } = await import('../server/capped');
      await ensureCapped();
      await ensureCapped();   // must not throw on second call

      const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
      const stats = await db.command({ collStats: 'agent_deltas' });
      assert.isTrue(stats.capped);
      assert.isAbove(stats.maxSize, 1024 * 1024);
    });

    it('evicts oldest documents when the cap is exceeded', async function () {
      this.timeout(30000);
      const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
      try { await db.collection('agent_deltas_probe').drop(); } catch { /* absent */ }
      await db.createCollection('agent_deltas_probe', { capped: true, size: 4096 });

      const coll = db.collection('agent_deltas_probe');
      const chunk = 'x'.repeat(200);
      for (let i = 0; i < 120; i += 1) {
        await coll.insertOne({ seq: i, chunk });
      }
      const surviving = await coll.countDocuments();
      assert.isBelow(surviving, 120, 'eviction should have occurred');

      const remaining = await coll.find({}).toArray();
      const seqs = remaining.map((d: any) => d.seq).sort((a: number, b: number) => a - b);
      assert.equal(seqs[seqs.length - 1], 119, 'the newest document must survive');
      assert.isAbove(seqs[0], 0, 'the head must be what was evicted');
    });
  });
}
```

- [ ] **Step 3: Register it**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
import './capped.test';
```

- [ ] **Step 4: Run to verify failure**

Expected: FAIL — `Cannot find module '../server/capped'`.

- [ ] **Step 5: Write the capped-collection bootstrap**

Create `app/packages/agent/server/capped.ts`:

```ts
import { MongoInternals } from 'meteor/mongo';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

/** Create the delta collection as capped. Idempotent: a NamespaceExists error
 *  (code 48) means another server or an earlier boot already made it. */
export async function ensureCapped(): Promise<void> {
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
  try {
    await db.createCollection(NAMES.deltas, { capped: true, size: DELTA_CAP_BYTES });
  } catch (e: any) {
    if (e?.code !== 48 && !/already exists/i.test(e?.message ?? '')) throw e;
  }
}
```

- [ ] **Step 6: Run to verify pass**

Expected: `22 passing`.

- [ ] **Step 7: Write the publications**

Create `app/packages/agent/server/publications.ts`:

```ts
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { NAMES } from '../common/names';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';

export function registerPublications(): void {
  Meteor.publish(NAMES.pubSession, function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    const selector = { _id: sessionId, agent, userId: this.userId ?? null };
    return [
      AgentSessions.find(selector),
      AgentMessages.find({ sessionId }, { sort: { seq: 1 } }),
      AgentDeltas.find({ sessionId }),
    ];
  });

  Meteor.publish(NAMES.pubSessions, function (agent: string) {
    check(agent, String);
    return AgentSessions.find(
      { agent, userId: this.userId ?? null },
      { sort: { updatedAt: -1 }, limit: 100 },
    );
  });
}
```

- [ ] **Step 8: Wire startup**

Replace `app/packages/agent/server/index.ts`:

```ts
import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
});
```

- [ ] **Step 9: Add a publication authorization test**

Append to `app/packages/agent/tests/capped.test.ts` — again **without the
`if (Meteor.isServer) { … }` wrapper**, de-indented, with any imports hoisted to
the top of the file:

```ts
if (Meteor.isServer) {
  describe('publications', () => {
    it('registers both publication names', async () => {
      const { registerPublications } = await import('../server/publications');
      registerPublications();
      const handlers = (Meteor.server as any).publish_handlers;
      assert.isFunction(handlers['agent.session']);
      assert.isFunction(handlers['agent.sessions']);
    });

    it('scopes agent.sessions to the calling user', async () => {
      const { AgentSessions } = await import('../common/collections');
      await AgentSessions.removeAsync({});
      const base = {
        agent: 'support', phase: 'idle' as const, model: 'mock', nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      };
      await AgentSessions.insertAsync({ ...base, _id: 'mine', userId: 'u1' } as any);
      await AgentSessions.insertAsync({ ...base, _id: 'theirs', userId: 'u2' } as any);

      const handler = (Meteor.server as any).publish_handlers['agent.sessions'];
      const cursor = handler.call({ userId: 'u1' }, 'support');
      const ids = (await cursor.fetchAsync()).map((d: any) => d._id);
      assert.deepEqual(ids, ['mine']);
    });
  });
}
```

- [ ] **Step 10: Run to verify pass, then commit**

Expected: `24 passing`.

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): collections, capped delta store, publications"
```

---

### Task 5: Tool registry and dispatch through a real MethodInvocation

Per S2b this **must** construct `DDPCommon.MethodInvocation`. A plain object
breaks any handler calling `this.unblock()`.

**Files:**
- Create: `app/packages/agent/server/tools.ts`
- Create: `app/packages/agent/tests/tools.test.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: `ToolSchema` from `providers/types.ts`.
- Produces: `ToolSpec`, `ToolContext`, `resolveTools(specs): ResolvedTool[]`, `runTool(tool, args, ctx): Promise<ToolResult>`, `withInvocation(userId, fn)` — all from `server/tools.ts`.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/agent/tests/tools.test.ts`. **Drop the
`if (Meteor.isServer) { … }` wrapper shown below and de-indent its body** — per
Global Constraints this file is reached only from `tests/server.ts` and is
already server-only, so the guard is dead code. The `Meteor.methods({…})`
registration stays, at top level:

```ts
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) {
  Meteor.methods({
    'test.usesUnblock'(this: any) {
      this.unblock();
      return `unblocked:${this.userId}`;
    },
    'test.echo'(this: any, args: { q: string }) {
      return `${args.q}:${this.userId}`;
    },
  });

  describe('tool dispatch', () => {
    it('gives an adopted method a real MethodInvocation, so this.unblock works', async () => {
      const { resolveTools, runTool } = await import('../server/tools');
      const [tool] = resolveTools([
        { method: 'test.usesUnblock', description: 'x', args: { type: 'object', properties: {} } },
      ]);
      const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
      assert.isTrue(r.ok);
      assert.equal(r.value, 'unblocked:u1');
    });

    it('propagates userId into adopted methods', async () => {
      const { resolveTools, runTool } = await import('../server/tools');
      const [tool] = resolveTools([
        { method: 'test.echo', description: 'x', args: { type: 'object', properties: {} } },
      ]);
      const r = await runTool(tool, { q: 'hi' }, { userId: 'u7', sessionId: 's1' });
      assert.equal(r.value, 'hi:u7');
    });

    it('runs inline tools with the invocation as this', async () => {
      const { resolveTools, runTool } = await import('../server/tools');
      const [tool] = resolveTools([{
        name: 'inline',
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async (args: any, ctx: any) => `${args.n}:${ctx.userId}`,
      }]);
      const r = await runTool(tool, { n: 5 }, { userId: 'u2', sessionId: 's1' });
      assert.equal(r.value, '5:u2');
    });

    it('converts a Meteor.Error into a structured tool error, not a throw', async () => {
      const { resolveTools, runTool } = await import('../server/tools');
      const [tool] = resolveTools([{
        name: 'boom', description: 'x', args: { type: 'object', properties: {} },
        run: async () => { throw new Meteor.Error('nope', 'not allowed'); },
      }]);
      const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
      assert.isFalse(r.ok);
      assert.equal(r.error!.error, 'nope');
      assert.equal(r.error!.reason, 'not allowed');
    });

    it('sanitizes non-Meteor errors so stacks never reach the transcript', async () => {
      const { resolveTools, runTool } = await import('../server/tools');
      const [tool] = resolveTools([{
        name: 'raw', description: 'x', args: { type: 'object', properties: {} },
        run: async () => { throw new Error('SECRET internal detail'); },
      }]);
      const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
      assert.isFalse(r.ok);
      assert.equal(r.error!.error, 'tool-failed');
      assert.notInclude(JSON.stringify(r.error), 'SECRET');
    });

    it('produces provider tool schemas', async () => {
      const { resolveTools, toolSchemas } = await import('../server/tools');
      const tools = resolveTools([{
        name: 'search', description: 'Find things',
        args: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        run: async () => 'ok',
      }]);
      const [schema] = toolSchemas(tools);
      assert.equal(schema.name, 'search');
      assert.equal(schema.description, 'Find things');
      assert.deepEqual((schema.parameters as any).required, ['q']);
    });
  });
}
```

- [ ] **Step 2: Register it**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
import './capped.test';
import './tools.test';
```

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — `Cannot find module '../server/tools'`.

- [ ] **Step 4: Write the implementation**

Create `app/packages/agent/server/tools.ts`:

```ts
import { Meteor } from 'meteor/meteor';
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

/**
 * Make a REAL MethodInvocation ambient. S2b: a plain object is enough to carry
 * userId, but a handler invoked with one dies on `this.unblock is not a
 * function`, and real method bodies call it.
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
    if ('method' in spec) {
      return {
        name: spec.name ?? spec.method,
        description: spec.description,
        args: spec.args,
        gate: spec.gate ?? 'auto',
        kind: 'adopted' as const,
        method: spec.method,
      };
    }
    return {
      name: spec.name,
      description: spec.description,
      args: spec.args,
      gate: spec.gate ?? 'auto',
      kind: 'inline' as const,
      run: spec.run,
    };
  });
}

export function toolSchemas(tools: ResolvedTool[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name, description: t.description, parameters: t.args,
  }));
}

export async function runTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext,
): Promise<ToolResult> {
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
```

- [ ] **Step 5: Run to verify pass**

Expected: `30 passing`.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): tool registry and dispatch via DDPCommon.MethodInvocation (S2b)"
```

---

### Task 6: Lease claim, heartbeat, and guarded commits

**Files:**
- Create: `app/packages/agent/server/lease.ts`
- Create: `app/packages/agent/tests/lease.test.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: `AgentSessions` from `common/collections.ts`.
- Produces: `SERVER_ID`, `LEASE_MS`, `claimLease`, `heartbeat`, `releaseLease`, `holdsLease`, `guardedUpdate` — all from `server/lease.ts`.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/agent/tests/lease.test.ts`. **Drop the
`if (Meteor.isServer) { … }` wrapper shown below and de-indent its body** — per
Global Constraints this file is reached only from `tests/server.ts` and is
already server-only, so the guard is dead code:

```ts
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) {
  const base = {
    agent: 'support', userId: 'u1', phase: 'idle' as const, model: 'mock', nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  };

  describe('lease', () => {
    it('lets exactly one of two racing servers claim an orphaned run', async function () {
      this.timeout(60000);
      const { AgentSessions } = await import('../common/collections');
      const { claimLease } = await import('../server/lease');
      await AgentSessions.removeAsync({});

      let doubleClaims = 0;
      let zeroClaims = 0;
      for (let i = 0; i < 100; i += 1) {
        const _id = `s${i}`;
        await AgentSessions.insertAsync({
          ...base, _id,
          lease: { serverId: 'dead', until: new Date(Date.now() - 60000) },
        } as any);
        const [a, b] = await Promise.all([claimLease(_id, 'A'), claimLease(_id, 'B')]);
        const winners = [a, b].filter(Boolean).length;
        if (winners > 1) doubleClaims += 1;
        if (winners === 0) zeroClaims += 1;
      }
      assert.equal(doubleClaims, 0, 'two servers claimed the same run');
      assert.equal(zeroClaims, 0, 'nobody claimed an orphaned run');
    });

    it('refuses a claim on a live lease held by someone else', async () => {
      const { AgentSessions } = await import('../common/collections');
      const { claimLease } = await import('../server/lease');
      await AgentSessions.removeAsync({});
      await AgentSessions.insertAsync({
        ...base, _id: 'live',
        lease: { serverId: 'A', until: new Date(Date.now() + 30000) },
      } as any);
      assert.isFalse(await claimLease('live', 'B'));
      assert.isTrue(await claimLease('live', 'A'), 'the holder may renew');
    });

    it('rejects a guarded update from a server that lost the lease', async () => {
      const { AgentSessions } = await import('../common/collections');
      const { claimLease, guardedUpdate } = await import('../server/lease');
      await AgentSessions.removeAsync({});
      await AgentSessions.insertAsync({ ...base, _id: 'g1' } as any);

      assert.isTrue(await claimLease('g1', 'A'));
      assert.isTrue(await guardedUpdate('g1', 'A', { $set: { phase: 'streaming' } }));
      assert.isFalse(await guardedUpdate('g1', 'B', { $set: { phase: 'error' } }));

      const doc = await AgentSessions.findOneAsync('g1');
      assert.equal(doc!.phase, 'streaming');
    });

    it('releases a lease so another server can take it', async () => {
      const { AgentSessions } = await import('../common/collections');
      const { claimLease, releaseLease } = await import('../server/lease');
      await AgentSessions.removeAsync({});
      await AgentSessions.insertAsync({ ...base, _id: 'r1' } as any);
      await claimLease('r1', 'A');
      await releaseLease('r1', 'A');
      assert.isTrue(await claimLease('r1', 'B'));
    });
  });
}
```

- [ ] **Step 2: Register it**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
import './capped.test';
import './tools.test';
import './lease.test';
```

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — `Cannot find module '../server/lease'`.

- [ ] **Step 4: Write the implementation**

Create `app/packages/agent/server/lease.ts`:

```ts
import { Random } from 'meteor/random';
import { AgentSessions } from '../common/collections';

/** Identity of this app server process, regenerated on every boot. */
export const SERVER_ID: string = Random.id();

export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

/** Claim a run. Succeeds if unleased, expired, or already ours. Atomic on a
 *  single document, so exactly one racing server wins. */
export async function claimLease(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const now = new Date();
  const n = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      $or: [
        { lease: { $exists: false } },
        { lease: null },
        { 'lease.until': { $lt: now } },
        { 'lease.serverId': serverId },
      ],
    } as any,
    { $set: { lease: { serverId, until: new Date(now.getTime() + LEASE_MS) } } },
  );
  return n === 1;
}

export async function heartbeat(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    { $set: { 'lease.until': new Date(Date.now() + LEASE_MS) } },
  );
  return n === 1;
}

export async function releaseLease(sessionId: string, serverId = SERVER_ID): Promise<void> {
  await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    { $unset: { lease: 1 } },
  );
}

export async function holdsLease(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const doc = await AgentSessions.findOneAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
  );
  return !!doc;
}

/** Every write during a turn goes through this. A server that lost the lease
 *  fails the guard and must abandon rather than write. */
export async function guardedUpdate(
  sessionId: string, serverId: string, modifier: Record<string, unknown>,
): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    modifier as any,
  );
  return n === 1;
}
```

- [ ] **Step 5: Run to verify pass**

Expected: `34 passing`.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): lease claim, heartbeat, and guarded commits (S4)"
```

---

### Task 7: The turn loop

Streams from a provider into the capped collection, commits at message
boundaries, dispatches tool calls, and loops until the model stops asking.

**Files:**
- Create: `app/packages/agent/server/loop.ts`
- Create: `app/packages/agent/tests/loop.test.ts`
- Modify: `app/packages/agent/tests/server.ts`

**Interfaces:**
- Consumes: `runTool`, `resolveTools`, `toolSchemas` (Task 5); `claimLease`, `releaseLease`, `guardedUpdate`, `holdsLease`, `SERVER_ID` (Task 6); `Provider` (Task 3); collections (Task 4).
- Produces: `RunConfig`, `runTurn(sessionId, config): Promise<void>` from `server/loop.ts`.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/agent/tests/loop.test.ts`. **Drop the
`if (Meteor.isServer) { … }` wrapper shown below and de-indent its body** — per
Global Constraints this file is reached only from `tests/server.ts` and is
already server-only, so the guard is dead code:

```ts
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) {
  const seed = async (sessionId: string, text: string) => {
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'u-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
    } as any);
  };

  describe('turn loop', () => {
    it('streams deltas then commits one assistant message', async function () {
      this.timeout(30000);
      const { AgentMessages, AgentDeltas } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      await seed('s1', 'hello');
      await runTurn('s1', {
        model: 'mock', system: 'You are a test.', tools: [],
        provider: mockProvider(() => ({ text: 'hi there' })),
      });

      const msgs = await AgentMessages.find({ sessionId: 's1' }, { sort: { seq: 1 } }).fetchAsync();
      assert.lengthOf(msgs, 2);
      assert.equal(msgs[1].role, 'assistant');
      assert.equal(msgs[1].content, 'hi there');

      const deltas = await AgentDeltas.find({ sessionId: 's1' }).fetchAsync();
      assert.isAbove(deltas.length, 0, 'tokens should have streamed');
      assert.equal(deltas[0].msgSeq, msgs[1].seq, 'deltas must carry the future seq');
    });

    it('reconstructs the same text from deltas as it commits', async function () {
      this.timeout(30000);
      const { AgentMessages, AgentDeltas } = await import('../common/collections');
      const { mergeView } = await import('../common/merge');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      await seed('s2', 'hello');
      await runTurn('s2', {
        model: 'mock', system: '', tools: [],
        provider: mockProvider(() => ({ text: 'streamed answer' })),
      });

      const deltas = await AgentDeltas.find({ sessionId: 's2' }).fetchAsync();
      const fromDeltas = mergeView([], deltas).map((m) => m.content).join('');
      const committed = await AgentMessages.findOneAsync({ sessionId: 's2', role: 'assistant' });
      assert.equal(fromDeltas, committed!.content);
    });

    it('runs a tool call and feeds the result back', async function () {
      this.timeout(30000);
      const { AgentMessages } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      await seed('s3', 'look it up');
      let call = 0;
      await runTurn('s3', {
        model: 'mock', system: '',
        tools: [{
          name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
          run: async () => ({ found: 42 }),
        }],
        provider: mockProvider(() => {
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 't1', name: 'lookup', args: {} }] }
            : { text: 'it is 42' };
        }),
      });

      const msgs = await AgentMessages.find({ sessionId: 's3' }, { sort: { seq: 1 } }).fetchAsync();
      const roles = msgs.map((m) => m.role);
      assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
      assert.equal(msgs[3].content, 'it is 42');
      assert.equal(msgs[2].content, JSON.stringify({ found: 42 }));
    });

    it('leaves the transcript resumable after an abandoned turn', async function () {
      this.timeout(30000);
      const { AgentMessages, AgentSessions } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      await seed('s4', 'hello');
      // Another server steals the lease mid-turn.
      await AgentSessions.updateAsync('s4', {
        $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
      } as any);

      await runTurn('s4', {
        model: 'mock', system: '', tools: [],
        provider: mockProvider(() => ({ text: 'should not commit' })),
      });

      const msgs = await AgentMessages.find({ sessionId: 's4' }, { sort: { seq: 1 } }).fetchAsync();
      const last = msgs[msgs.length - 1];
      assert.equal(last.role, 'user', 'transcript must end in user or tool to be resumable');
    });

    it('sets phase back to idle and releases the lease when done', async function () {
      this.timeout(30000);
      const { AgentSessions } = await import('../common/collections');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      await seed('s5', 'hello');
      await runTurn('s5', {
        model: 'mock', system: '', tools: [],
        provider: mockProvider(() => ({ text: 'done' })),
      });

      const doc = await AgentSessions.findOneAsync('s5');
      assert.equal(doc!.phase, 'idle');
      assert.isUndefined(doc!.lease);
    });
  });
}
```

- [ ] **Step 2: Register it**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
import './capped.test';
import './tools.test';
import './lease.test';
import './loop.test';
```

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — `Cannot find module '../server/loop'`.

- [ ] **Step 4: Write the implementation**

Create `app/packages/agent/server/loop.ts`:

```ts
import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import type { Provider, ProviderMessage } from './providers/types';
import { claimLease, guardedUpdate, releaseLease, SERVER_ID } from './lease';
import { resolveTools, runTool, toolSchemas, type ToolSpec } from './tools';

export interface RunConfig {
  model: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  maxIterations?: number;
  flushMs?: number;
}

/** Buffers deltas and flushes on an interval so a long response is O(chunk)
 *  on the wire rather than O(n²). */
class DeltaWriter {
  private buf: Array<{ kind: string; chunk: string }> = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionId: string,
    private messageId: string,
    private msgSeq: number,
    flushMs: number,
  ) {
    this.timer = setInterval(() => { void this.flush(); }, flushMs);
  }

  push(kind: string, chunk: string) { this.buf.push({ kind, chunk }); }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    for (const item of batch) {
      await AgentDeltas.insertAsync({
        _id: Random.id(),
        sessionId: this.sessionId,
        messageId: this.messageId,
        msgSeq: this.msgSeq,
        seq: this.seq++,
        kind: item.kind as any,
        chunk: item.chunk,
        at: new Date(),
      } as any);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }
}

function toProviderMessages(msgs: AgentMessage[]): ProviderMessage[] {
  return msgs
    .filter((m) => m.role !== 'note')
    .map((m) => ({
      role: m.role as ProviderMessage['role'],
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    }));
}

/**
 * Run one turn to completion. Assistant messages commit only at boundaries, so
 * an abandoned turn always leaves the transcript ending in `user` or `tool` —
 * the two states a turn can legally start from. Recovery is therefore just
 * calling this again.
 */
export async function runTurn(sessionId: string, config: RunConfig): Promise<void> {
  const maxIterations = config.maxIterations ?? 10;
  const flushMs = config.flushMs ?? 60;
  const tools = resolveTools(config.tools);
  const schemas = toolSchemas(tools);

  if (!(await claimLease(sessionId))) return;   // another server owns this run

  try {
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const session = await AgentSessions.findOneAsync(sessionId);
      if (!session) return;

      const history = await AgentMessages
        .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

      const messageId = Random.id();
      const msgSeq = session.nextSeq;
      if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'streaming' } }))) return;

      const writer = new DeltaWriter(sessionId, messageId, msgSeq, flushMs);
      let text = '';
      let thinking = '';
      let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
      let usage = { input: 0, output: 0 };

      try {
        for await (const chunk of config.provider.stream({
          model: config.model, system: config.system,
          messages: toProviderMessages(history), tools: schemas,
        })) {
          if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
          else if (chunk.kind === 'thinking') {
            thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
          } else if (chunk.kind === 'done') {
            toolCalls = chunk.toolCalls;
            usage = chunk.usage ?? usage;
          }
        }
      } finally {
        await writer.stop();
      }

      // Commit is conditional on still owning the lease. Losing it means
      // another server is redoing this turn; abandon without writing.
      const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
        $inc: {
          nextSeq: 1,
          'usage.input': usage.input,
          'usage.output': usage.output,
        },
        $set: { updatedAt: new Date() },
      });
      if (!stillOurs) return;

      await AgentMessages.insertAsync({
        _id: messageId, sessionId, seq: msgSeq, role: 'assistant',
        content: text, thinking: thinking || undefined,
        toolCalls, usage, createdAt: new Date(),
      } as any);

      if (!toolCalls || toolCalls.length === 0) return;

      await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'calling' } });

      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        const result = tool
          ? await runTool(tool, call.args, { userId: session.userId, sessionId })
          : { ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` } };

        const after = await AgentSessions.findOneAsync(sessionId);
        if (!after) return;
        if (!(await guardedUpdate(sessionId, SERVER_ID, {
          $inc: { nextSeq: 1, 'budgetSpent.toolCalls': 1 },
        }))) return;

        await AgentMessages.insertAsync({
          _id: Random.id(), sessionId, seq: after.nextSeq, role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result.ok ? result.value : result.error),
          error: result.ok ? undefined : result.error,
          createdAt: new Date(),
        } as any);
      }
    }
  } finally {
    await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
    await releaseLease(sessionId);
  }
}
```

- [ ] **Step 5: Run to verify pass**

Expected: `39 passing`.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): streaming turn loop with guarded commits and tool dispatch"
```

---

### Task 8: Public API, methods, client view — and the live DDP integration test

Closes the gap S5 deliberately left: the merge is proven pure, but never across
a real DDP connection.

**Files:**
- Create: `app/packages/agent/server/registry.ts`
- Create: `app/packages/agent/server/methods.ts`
- Create: `app/packages/agent/server/agent.ts`
- Create: `app/packages/agent/client/agent.ts`
- Create: `app/packages/agent/tests/integration.server.ts`
- Create: `app/packages/agent/tests/integration.client.ts`
- Create: `app/packages/agent/README.md`
- Modify: `app/packages/agent/server/index.ts`, `client/index.ts`, `tests/server.ts`, `tests/client.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `Agent` class (both sides), `AgentConfig`, methods `agent.start` / `agent.send` / `agent.interrupt`.

- [ ] **Step 1: Write the agent registry**

Create `app/packages/agent/server/registry.ts`:

```ts
import type { Provider } from './providers/types';
import type { ToolSpec } from './tools';

export interface AgentConfig {
  model: string;
  instructions: string | string[] | ((ctx: { userId: string | null }) => string);
  tools?: ToolSpec[];
  /** Required in Milestone 1. The pi-ai adapter that would default this is
   *  Milestone 2; until then every agent supplies its provider explicitly. */
  provider: Provider;
  maxIterations?: number;
}

const registry = new Map<string, AgentConfig>();

export function defineAgent(name: string, config: AgentConfig): void {
  registry.set(name, config);
}

export function getAgent(name: string): AgentConfig | undefined {
  return registry.get(name);
}

export function buildSystemPrompt(
  config: AgentConfig, ctx: { userId: string | null },
): string {
  const i = config.instructions;
  if (typeof i === 'function') return i(ctx);
  if (Array.isArray(i)) return i.join('\n\n');
  return i;
}
```

- [ ] **Step 2: Write the methods**

Create `app/packages/agent/server/methods.ts`:

```ts
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentMessages, AgentSessions } from '../common/collections';
import { getAgent, buildSystemPrompt } from './registry';
import { runTurn } from './loop';

async function requireSession(sessionId: string, userId: string | null) {
  const session = await AgentSessions.findOneAsync({ _id: sessionId, userId } as any);
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

export function registerMethods(): void {
  Meteor.methods({
    async [NAMES.mStart](this: any, agent: string, opts?: { title?: string }) {
      check(agent, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const _id = Random.id();
      await AgentSessions.insertAsync({
        _id, agent, userId: this.userId ?? null, title: opts?.title,
        phase: 'idle', model: config.model, nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
      return _id;
    },

    async [NAMES.mSend](this: any, agent: string, sessionId: string, text: string) {
      check(agent, String);
      check(sessionId, String);
      check(text, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const session = await requireSession(sessionId, this.userId ?? null);

      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: session.nextSeq, role: 'user',
        content: text, createdAt: new Date(),
      } as any);
      await AgentSessions.updateAsync(sessionId, {
        $inc: { nextSeq: 1, 'budgetSpent.turns': 1 },
        $set: { updatedAt: new Date() },
      } as any);

      const userId = this.userId ?? null;
      // Return immediately; the client watches the subscription for output.
      Meteor.defer(() => {
        void runTurn(sessionId, {
          model: config.model,
          system: buildSystemPrompt(config, { userId }),
          tools: config.tools ?? [],
          provider: config.provider,
          maxIterations: config.maxIterations,
        });
      });
      return sessionId;
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(sessionId, this.userId ?? null);
      await AgentSessions.updateAsync(sessionId, {
        $set: { phase: 'stopped', updatedAt: new Date() },
      } as any);
    },
  });
}
```

- [ ] **Step 3: Write the server-side Agent class**

Create `app/packages/agent/server/agent.ts`:

```ts
import { defineAgent, type AgentConfig } from './registry';

export class Agent {
  constructor(public readonly name: string, config?: AgentConfig) {
    if (config) this.define(config);
  }

  define(config: AgentConfig): this {
    defineAgent(this.name, config);
    return this;
  }
}

export type { AgentConfig };
```

- [ ] **Step 4: Write the client-side Agent class**

Create `app/packages/agent/client/agent.ts`:

```ts
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { NAMES } from '../common/names';
import { mergeView } from '../common/merge';
import type { Phase, ViewMessage } from '../common/types';

const Sessions = new Mongo.Collection(NAMES.sessions);
const Messages = new Mongo.Collection(NAMES.messages);
const Deltas = new Mongo.Collection(NAMES.deltas);

export class Agent {
  /** Client-only collection holding the merged view. */
  private view = new Mongo.Collection<ViewMessage>(null);
  private computation: Tracker.Computation | null = null;

  constructor(public readonly name: string) {}

  subscribe(sessionId: string) {
    const handle = Meteor.subscribe(NAMES.pubSession, this.name, sessionId);
    this.startMerging(sessionId);
    return handle;
  }

  private startMerging(sessionId: string) {
    if (this.computation) this.computation.stop();
    this.computation = Tracker.autorun(() => {
      const committed = Messages.find({ sessionId }, { sort: { seq: 1 } }).fetch() as any[];
      const deltas = Deltas.find({ sessionId }).fetch() as any[];
      const merged = mergeView(committed, deltas);

      const keep = new Set(merged.map((m) => m._id));
      this.view.find({}).forEach((doc) => {
        if (!keep.has(doc._id)) this.view.remove(doc._id);
      });
      for (const m of merged) {
        this.view.upsert(m._id, { $set: m as any });
      }
    });
  }

  messages(sessionId: string) {
    return this.view.find({ sessionId }, { sort: { seq: 1 } });
  }

  session(sessionId: string) {
    return Sessions.findOne(sessionId);
  }

  status(sessionId: string): Phase {
    return (this.session(sessionId) as any)?.phase ?? 'idle';
  }

  usage(sessionId: string) {
    return (this.session(sessionId) as any)?.usage ?? { input: 0, output: 0, cost: 0 };
  }

  /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name). */
  subscribeSessions() {
    return Meteor.subscribe(NAMES.pubSessions, this.name);
  }

  sessions(selector: Record<string, unknown> = {}) {
    return Sessions.find({ ...selector, agent: this.name }, { sort: { updatedAt: -1 } });
  }

  start(opts?: { title?: string }): Promise<string> {
    return Meteor.callAsync(NAMES.mStart, this.name, opts);
  }

  send(sessionId: string, text: string): Promise<string> {
    return Meteor.callAsync(NAMES.mSend, this.name, sessionId, text);
  }

  interrupt(sessionId: string): Promise<void> {
    return Meteor.callAsync(NAMES.mInterrupt, this.name, sessionId);
  }
}
```

- [ ] **Step 5: Wire both entry points**

Replace `app/packages/agent/server/index.ts`:

```ts
import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';
import { registerMethods } from './methods';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig } from './agent';
export { mockProvider } from './providers/mock';
export type { Provider, ProviderChunk, ProviderRequest } from './providers/types';

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
  registerMethods();
});
```

Replace `app/packages/agent/client/index.ts`:

```ts
export * from '../common/types';
export { NAMES } from '../common/names';
export { mergeView } from '../common/merge';
export { Agent } from './agent';
```

- [ ] **Step 6: Write the live DDP integration test**

Two files, because the halves build for different architectures.

Create `app/packages/agent/tests/integration.server.ts` — no tests, just the
fixture the client half talks to:

```ts
import { Meteor } from 'meteor/meteor';
import { Agent } from '../server/agent';
import { mockProvider } from '../server/providers/mock';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';

export const AGENT = 'itest';

new Agent(AGENT, {
  model: 'mock',
  instructions: 'You are a test agent.',
  tools: [],
  provider: mockProvider(() => ({ text: 'live streamed reply' })),
});

Meteor.methods({
  async 'itest.reset'() {
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
  },
});
```

Create `app/packages/agent/tests/integration.client.ts`:

```ts
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Agent } from '../client/agent';

const AGENT = 'itest';

{
  describe('live DDP round trip', () => {
    it('delivers a streamed reply into the merged cursor', async function () {
      this.timeout(30000);
      await Meteor.callAsync('itest.reset');

      const support = new Agent(AGENT);
      const sessionId: string = await support.start({ title: 'itest' });
      const handle = support.subscribe(sessionId);

      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (handle.ready()) { clearInterval(poll); resolve(); }
        }, 50);
      });

      await support.send(sessionId, 'hello');

      // Wait for the committed assistant message to arrive over DDP.
      const finalText = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const poll = setInterval(() => {
          const rows = support.messages(sessionId).fetch();
          const assistant = rows.find((m: any) => m.role === 'assistant' && !m.streaming);
          if (assistant) { clearInterval(poll); resolve(assistant.content); }
          else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error(`timed out; rows=${JSON.stringify(rows)}`));
          }
        }, 100);
      });

      assert.equal(finalText, 'live streamed reply');

      const rows = support.messages(sessionId).fetch();
      assert.equal(rows[0].role, 'user');
      assert.equal(rows[0].content, 'hello');
      assert.isTrue(rows.every((m: any) => typeof m.seq === 'number'));
    });
  });
}
```

- [ ] **Step 7: Register both halves**

Replace `app/packages/agent/tests/server.ts`:

```ts
import './smoke.test';
import './merge.test';
import './loader.test';
import './capped.test';
import './tools.test';
import './lease.test';
import './loop.test';
import './integration.server';
```

Replace `app/packages/agent/tests/client.ts`:

```ts
import './integration.client';
```

- [ ] **Step 8: Run to verify failure, then pass**

```bash
cd /Users/mk/Desktop/meteor-agent/app && meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent
```

Expected first run: FAIL on missing modules. After Steps 1–5 are in place:
`40 passing` including the browser-side round trip.

If the client test times out, check in this order: (1) the publication returned
all three cursors, (2) delta documents carry `msgSeq`, (3) `Tracker.autorun` is
re-running — log `Deltas.find().count()` inside it.

- [ ] **Step 9: Write the README**

Create `app/packages/agent/README.md`:

```markdown
# 10thfloor:agent

A Pi-based agent harness for Meteor 3.5+. The transcript is a Mongo collection,
streaming tokens are a capped collection, and tools are Meteor methods.

## Install

```bash
meteor add 10thfloor:agent
meteor npm install --save @earendil-works/pi-ai
```

## Define an agent

```ts
// imports/agents.ts — isomorphic
import { Agent } from 'meteor/10thfloor:agent';
export const Support = new Agent('support');

// server/agents.ts — server only
import { Support } from '/imports/agents';
Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId}.`,
  tools: ['orders.lookup'],
});
```

## Use it from the client

```ts
const sessionId = await Support.start();
Support.subscribe(sessionId);
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();   // reactive, includes in-flight tokens
Support.status(sessionId);             // 'idle' | 'streaming' | 'calling' | …
```

## Testing without an API key

```ts
import { mockProvider } from 'meteor/10thfloor:agent';
Support.define({ model: 'mock', instructions: '…', provider: mockProvider(() => ({ text: 'hi' })) });
```

See `docs/superpowers/specs/` for the full design.
```

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Desktop/meteor-agent
git add app/packages/agent
git commit -m "feat(agent): public API, methods, client merge view, live DDP integration test"
```

---

## Milestone 1 done — what works

Define an agent, start a session, send a message, and watch tokens arrive in a
reactive minimongo cursor. Tool calls dispatch through real Meteor method
invocations. A turn abandoned by a server restart or a stolen lease leaves a
resumable transcript.

## Milestone 2 (separate plan)

Approval gates and park-by-exiting (§4.3, §7); budgets and cost accounting
(§9); compaction (§9); the orphan-claim watcher using `observeChangesAsync`
(§4.3) — Milestone 1 recovers on the next `send`, not automatically; the real
pi-ai provider adapter wired to `loadPiAi()`; **provider retry and backoff with
`phase: 'retrying'`, and the 401/400 no-retry path (§10)** — Milestone 1 lets a
provider error propagate out of `runTurn`; `Agent.method()` co-registration and
TypeBox-typed tool arguments (§6); `Agent.ask()` headless one-shot;
`DDPRateLimiter` rules on `agent.send` (§7); the remaining client readers
`pending()`, `approve()`, `deny()`, `compact()`, which all depend on gates and
compaction existing.

## Deferred to v2 (per spec §3)

Subagents, Agent Skills / resource loading, MCP, session forking and branching,
an extension API, RPC and print modes, bundled UI components.
