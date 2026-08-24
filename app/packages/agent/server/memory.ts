import { Random } from 'meteor/random';
import { AgentMemories } from '../common/collections';
import {
  MEMORY_TEXT_MAX,
  type AgentMemory, type MemoryScope, type ResolvedMemory,
} from '../common/types';

/**
 * The memory store's core: every rule about who may remember what, how much,
 * and how it is found. A LEAF module — collections and types only — so the
 * loop, the tools, the DDP methods and `Agent.memory` can all call in without
 * a cycle.
 *
 * BOTH surfaces funnel here (memory spec decision 7). The model reaches these
 * functions through per-agent inline tools that close over the resolved config
 * and the running model's participant id; the UI reaches them through three
 * global DDP methods whose bodies apply a NARROWER policy first (decision 7a:
 * gates only run on the loop's dispatch path, so the DDP surface must refuse
 * app-scope writes itself rather than trust a gate that will never fire).
 *
 * The split matters because an adopted Meteor method body receives only the
 * invocation and its args — no session, no agent name, no config — which is
 * why "co-registered method" could not carry memory and this core exists.
 */

/* ---------------------------------------------------------------------------
 * Scoping
 * ------------------------------------------------------------------------ */

/** The selector for one scope's rows.
 *
 *  `'app'` rows carry NO `userId` — the absence IS the sharing (spec §4), so
 *  the app clause must not mention the field at all: `{ userId: undefined }`
 *  would serialize to a match on missing-or-null and quietly pull anonymous
 *  rows if any ever existed. */
function scopeClause(
  scope: MemoryScope, userId: string | null, agent: string,
): Record<string, unknown> | null {
  if (scope === 'app') return { scope: 'app' };
  // Person and agent memory need a real account. An anonymous session has no
  // person store at all (spec decision 13) — not an empty one, and never a
  // store keyed by null that every anonymous holder would share.
  if (userId === null) return null;
  if (scope === 'agent') return { scope: 'agent', userId, agent };
  return { scope: 'user', userId };
}

/** The `$or` over every scope this agent may read. Null when nothing is
 *  readable (an anonymous session whose config lists only person scopes). */
export function readSelector(
  scopes: MemoryScope[], userId: string | null, agent: string,
): { $or: Array<Record<string, unknown>> } | null {
  const clauses = scopes
    .map((s) => scopeClause(s, userId, agent))
    .filter((c): c is Record<string, unknown> => c !== null);
  return clauses.length > 0 ? { $or: clauses } : null;
}

/** Is this row one the caller may actually see? The predicate form of
 *  `readSelector`, for filtering rows this module did not fetch itself. */
export function inScope(
  row: AgentMemory, scopes: MemoryScope[], userId: string | null, agent: string,
): boolean {
  if (row.scope === 'app') return scopes.includes('app');
  if (userId === null || row.userId !== userId) return false;
  if (row.scope === 'agent') return scopes.includes('agent') && row.agent === agent;
  return scopes.includes('user');
}

/* ---------------------------------------------------------------------------
 * Reads — the standing block
 * ------------------------------------------------------------------------ */

export interface ListedMemories {
  person: AgentMemory[];
  work: AgentMemory[];
  personTotal: number;
  workTotal: number;
}

/**
 * The standing block's read (spec §6): pinned first, then most-recent, split
 * into the person and work sections so neither can crowd the other out.
 *
 * A DIRECT `findAsync`, never the search ladder — that is what makes a fact
 * saved this turn visible in the next iteration's block and in a colleague's
 * next turn, without waiting on mongot's change stream to index it.
 *
 * Overflow pinned rows do NOT consume recent slots: the caps are per-section
 * and the totals below tell the model more exist.
 */
export async function listForBlock(
  userId: string | null, agent: string, config: ResolvedMemory,
): Promise<ListedMemories> {
  const { pinned, recent } = config.index;
  const section = async (scopes: MemoryScope[]) => {
    const sel = readSelector(scopes, userId, agent);
    if (!sel) return { rows: [] as AgentMemory[], total: 0 };
    const total = await AgentMemories.find(sel as any).countAsync();
    if (total === 0) return { rows: [] as AgentMemory[], total };
    const pins = await AgentMemories.find(
      { ...sel, pinned: true } as any, { sort: { at: -1 }, limit: pinned },
    ).fetchAsync();
    // The recent section excludes EVERY pinned row, not just the `pinned` of
    // them that made the cut. Excluding only the shown ones let overflow pins
    // fall into the recent fetch and eat its slots — the precise behavior §6
    // forbids, and with more pins than `recent` the unpinned rows vanished
    // from the block entirely.
    const rest = await AgentMemories.find(
      { ...sel, pinned: { $ne: true } } as any, { sort: { at: -1 }, limit: recent },
    ).fetchAsync();
    return { rows: [...pins, ...rest], total };
  };

  const personScopes = config.scopes.filter((s) => s !== 'app');
  const workScopes = config.scopes.filter((s) => s === 'app');
  const [p, w] = await Promise.all([section(personScopes), section(workScopes)]);
  return { person: p.rows, work: w.rows, personTotal: p.total, workTotal: w.total };
}

/* ---------------------------------------------------------------------------
 * The search ladder
 * ------------------------------------------------------------------------ */

export type SearchRung = 'installed' | 'vector' | 'text' | 'regex';

/** Which rung answered last — read by tests and by the one-time warning. */
let activeRung: SearchRung | null = null;
/**
 * Why the vector rung is or is not usable here. `null` = not yet probed;
 * cached in module state (the `SERVER_ID` idiom) because it is a property of
 * the DEPLOYMENT, not of a call.
 *
 * This is a PROBE, not error-message archaeology, and that distinction was
 * bought the hard way: smoked against a real MongoDB 8.2 + mongot, the three
 * failure modes we care about produce (a) `SearchNotEnabled` — "requires
 * additional configuration" — when there is no search node, (b) "while in
 * state FAILED" when the index exists but never built, and, worst,
 * (c) **no error at all** when the index simply does not exist: `$vectorSearch`
 * against an unknown index name returns an EMPTY RESULT SET. A ladder that
 * waits to be thrown at therefore never engages — it reports the vector rung
 * working and returns nothing, forever, silently.
 */
type VectorReadiness = 'ready' | 'no-search-node' | 'missing-index' | 'index-not-queryable';
let vectorReadiness: VectorReadiness | null = null;
let textAvailable: boolean | null = null;

/** The index name the pipeline queries and the probe checks for. */
const VECTOR_INDEX = 'agent_memories_vector';

/**
 * Ask the deployment directly whether the vector rung can work, once.
 *
 * `$listSearchIndexes` answers all three questions in one call: it throws when
 * there is no search node at all, returns nothing when the index was never
 * created, and reports `queryable` when it exists — so no failure mode has to
 * be inferred from the wording of an error.
 */
async function probeVector(): Promise<VectorReadiness> {
  try {
    const found = await (AgentMemories as any).rawCollection()
      .aggregate([{ $listSearchIndexes: { name: VECTOR_INDEX } }]).toArray();
    if (!Array.isArray(found) || found.length === 0) return 'missing-index';
    return found[0]?.queryable === true ? 'ready' : 'index-not-queryable';
  } catch {
    return 'no-search-node';
  }
}

/** The remedy for each answer, named rather than left to the operator. */
const READINESS_NOTE: Record<Exclude<VectorReadiness, 'ready'>, string> = {
  'no-search-node':
    'this deployment has no search node, so $vectorSearch is unavailable and memory '
    + 'recall is running on the text/regex rung — semantic matches will be missed. '
    + 'Run MongoDB 8.2+ with mongot (or Atlas) to enable it; see the README.',
  'missing-index':
    `the memory vector index "${VECTOR_INDEX}" does not exist, so semantic recall is `
    + 'running on the text/regex rung. NOTE: an absent index does not error — '
    + '$vectorSearch simply returns nothing — so this would otherwise look like an '
    + 'empty memory rather than a missing index. Create it with the createSearchIndex '
    + 'definition in the README.',
  'index-not-queryable':
    `the memory vector index "${VECTOR_INDEX}" exists but is not queryable (it is `
    + 'still building, or its build FAILED). A FAILED build most often means automated '
    + 'embedding could not reach its embedding model — a deployment using '
    + 'automated embedding needs a Voyage API key configured. Recall is on the '
    + 'text/regex rung until the index reports queryable; check its status with '
    + 'db.agent_memories.getSearchIndexes().',
};

const warnedKinds = new Set<string>();
/** One warn per distinct message kind, keyed on a stable prefix — the
 *  `warnedGateKinds` latch, verbatim in shape. A degraded rung recurs on
 *  every turn, and one line per search would bury the notice. */
function warnMemory(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedKinds.has(kind)) return;
  warnedKinds.add(kind);
  console.warn(`[10thfloor:agent] ${message}`);
}

/** Whether mongot rejected the stage because the index cannot serve the
 *  `filter` it was given — a configuration answer with a specific remedy,
 *  distinct from "this server has no vector search at all". */
function isFilterPathError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? '').toLowerCase();
  return msg.includes('filter')
    && (msg.includes('path') || msg.includes('not indexed') || msg.includes('must be indexed'));
}

/** Mongo's duplicate-key signal, however the driver phrases it. */
function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  if (err?.code === 11000 || err?.code === 11001) return true;
  return String(err?.message ?? '').includes('E11000');
}

/** Regex metacharacters, escaped. The package has no such helper, and the
 *  hint path feeds it RAW human text: `order #8812 (dispute` compiles to a
 *  SyntaxError, which inside the per-iteration assembly would take the turn
 *  down — precisely what "the ladder never fails a turn" forbids. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** TEST SEAM, not public API: replaces the vector rung so a suite can drive
 *  the ladder without a mongot. Returns a restore fn, and resets the probe
 *  cache and the warn latch — `tests/server.ts` runs every suite in one
 *  process, so a latch armed by one test would silence the next. */
export function _setMemorySearch(
  fn: ((sel: Record<string, unknown>, query: string, limit: number)
    => Promise<AgentMemory[]>) | null,
): () => void {
  const prevVector = vectorSearchImpl;
  const prevReadiness = vectorReadiness;
  const prevText = textAvailable;
  vectorSearchImpl = fn;
  // An installed stub IS the rung, so declare it ready and skip the probe;
  // clearing it returns the module to unprobed.
  vectorReadiness = fn ? 'ready' : null;
  textAvailable = null;
  activeRung = null;
  warnedKinds.clear();
  return () => {
    vectorSearchImpl = prevVector;
    vectorReadiness = prevReadiness;
    textAvailable = prevText;
    activeRung = null;
    warnedKinds.clear();
  };
}

/** The active rung, for tests and diagnostics. */
export function _activeRung(): SearchRung | null { return activeRung; }

/** TEST SEAM, not public API: force the FLOOR rung by declaring the two rungs
 *  above it unavailable. Without this a suite cannot reach `regexSearch` at
 *  all — the text index exists in the test database, so the text rung answers
 *  first and the escaping the hint path depends on goes unexercised. Returns
 *  a restore fn. */
export function _forceRegexRung(): () => void {
  const prevReadiness = vectorReadiness;
  const prevText = textAvailable;
  vectorReadiness = 'no-search-node';
  textAvailable = false;
  return () => { vectorReadiness = prevReadiness; textAvailable = prevText; };
}

let vectorSearchImpl:
  | ((sel: Record<string, unknown>, query: string, limit: number) => Promise<AgentMemory[]>)
  | null = null;

/**
 * `$vectorSearch` with automated embedding (mongot). The query STRING goes to
 * the pipeline — mongot embeds it at search time — so there is no embedding
 * call of our own to make, no key to hold, and nothing to keep in sync.
 *
 * A deployment without mongot errors on the unknown stage. That is a
 * capability answer, not a transient one: probe once, cache, and fall down the
 * ladder for the life of the process.
 */
async function vectorSearch(
  sel: Record<string, unknown>, query: string, limit: number,
): Promise<AgentMemory[]> {
  if (vectorSearchImpl) return vectorSearchImpl(sel, query, limit);
  // `filter` runs INSIDE the vector stage, before its limit. Post-filtering a
  // global top-N with `$match` was the original shape and it is wrong at any
  // real scale: with thousands of rows across hundreds of accounts, the top
  // `limit` nearest neighbours are mostly other people's, so a scoped search
  // returned a handful of rows or none — recall silently emptying as the
  // deployment grew. The `$match` stays as a BELT: `filter` depends on the
  // index declaring those paths, and a misconfigured index must not leak.
  const cursor = await (AgentMemories as any).rawCollection().aggregate([
    {
      $vectorSearch: {
        index: 'agent_memories_vector',
        path: 'text',
        query,
        filter: sel,
        numCandidates: Math.max(limit * 20, 100),
        limit,
      },
    },
    { $match: sel },
    // Surface the relevance score so the hint can threshold on it. Without
    // this the rung returns rows with no score and `minScore` has nothing to
    // gate — configured, validated, and inert.
    { $addFields: { score: { $meta: 'vectorSearchScore' } } },
  ]);
  return cursor.toArray() as Promise<AgentMemory[]>;
}

async function textSearch(
  sel: Record<string, unknown>, query: string, limit: number,
): Promise<AgentMemory[]> {
  return AgentMemories.find(
    { ...sel, $text: { $search: query } } as any, { limit },
  ).fetchAsync();
}

/** The floor. Always works, on any mongod, with no index at all — which is
 *  what makes the ladder's promise ("search narrows, never disappears") true
 *  even on a stock dev database. */
async function regexSearch(
  sel: Record<string, unknown>, query: string, limit: number,
): Promise<AgentMemory[]> {
  const tokens = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 8);
  if (tokens.length === 0) {
    return AgentMemories.find(sel as any, { sort: { at: -1 }, limit }).fetchAsync();
  }
  return AgentMemories.find(
    {
      $and: [
        sel,
        { $or: tokens.map((t) => ({ text: { $regex: escapeRegExp(t), $options: 'i' } })) },
      ],
    } as any,
    { sort: { at: -1 }, limit },
  ).fetchAsync();
}

/**
 * Recall, down the ladder: installed fn → `$vectorSearch` → `$text` → regex.
 *
 * Every rung failure DEGRADES rather than throws. A search that takes the turn
 * down is worse than a search that returns less: the model can route around a
 * thin answer, but a thrown error inside the hint path kills a conversation
 * over a database capability nobody chose.
 */
export async function searchMemory(
  query: string,
  opts: {
    userId: string | null; agent: string; config: ResolvedMemory; limit?: number;
  },
): Promise<AgentMemory[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 25));
  const q = String(query ?? '').trim();
  if (!q) return [];
  const sel = readSelector(opts.config.scopes, opts.userId, opts.agent);
  if (!sel) return [];

  if (opts.config.search) {
    activeRung = 'installed';
    try {
      const rows = await opts.config.search(q, {
        userId: opts.userId, agent: opts.agent, scopes: opts.config.scopes, limit,
      });
      // The app's rows are re-scoped here, not trusted. An installed fn is a
      // retrieval strategy, not an authorization decision: the obvious first
      // draft (`AgentMemories.find({ $text: … })`, since the collection is
      // exported) has no scope clause at all, and without this belt it would
      // serve one account's memories to another.
      return Array.isArray(rows)
        ? rows.filter((r) => inScope(r, opts.config.scopes, opts.userId, opts.agent))
          .slice(0, limit)
        : [];
    } catch (e) {
      // An app's own search throwing is the app's bug, but it must not be the
      // conversation's death. Warn and fall through to the built-in rungs.
      warnMemory(`the installed memory search fn threw; falling back to the built-in `
        + `ladder: ${(e as Error)?.message}`);
    }
  }

  // Probe once, then trust the answer. Anything but `ready` warns with its own
  // remedy and skips the rung — including `missing-index`, which is the case
  // that cannot be caught by trying, because it succeeds and returns nothing.
  if (vectorReadiness === null) {
    vectorReadiness = await probeVector();
    if (vectorReadiness !== 'ready') warnMemory(READINESS_NOTE[vectorReadiness]);
  }

  if (vectorReadiness === 'ready') {
    try {
      const rows = await vectorSearch(sel as any, q, limit);
      activeRung = 'vector';
      return rows;
    } catch (e) {
      // The index was queryable at probe time, so a throw now is either a
      // definition mismatch or a transient blip. The filter-path case is the
      // one worth naming — verified against a live mongot, which phrases it
      // "Path 'agent' needs to be indexed as filter" — and it is a definition
      // problem the operator must fix rather than something that will pass.
      if (isFilterPathError(e)) {
        warnMemory('the memory vector index does not declare the filter paths this '
          + 'package needs (scope, userId, agent), so every semantic search is being '
          + `rejected and recall has fallen back to the text/regex rung. Run `
          + `updateSearchIndex on "${VECTOR_INDEX}" with the definition in the `
          + 'README\'s mongot notes.');
      }
      // Anything else: degrade this ONE call and try again next time — a
      // mongot that restarted under us should not cost the process its rung.
    }
  }

  if (textAvailable !== false) {
    try {
      const rows = await textSearch(sel as any, q, limit);
      textAvailable = true;
      activeRung = 'text';
      return rows;
    } catch {
      if (textAvailable === null) {
        textAvailable = false;
        warnMemory('the memory text index is unavailable, so recall is running on the '
          + 'regex rung — matching is literal and unranked.');
      }
    }
  }

  activeRung = 'regex';
  return regexSearch(sel as any, q, limit);
}

/* ---------------------------------------------------------------------------
 * Writes
 * ------------------------------------------------------------------------ */

export interface SaveArgs {
  text: string;
  scope?: MemoryScope;
  key?: string;
  pinned?: boolean;
}

export type SaveResult =
  | { ok: true; id: string; updated: boolean }
  | { ok: false; error: string; reason: string };

/**
 * Remember one fact.
 *
 * Structured refusals rather than throws for every rule the MODEL can trip
 * (too long, unknown scope, scope not enabled, no account, pool full): a
 * refusal the model can read is a refusal it can route around, where a throw
 * spends a turn on an error note.
 *
 * `key` is the deliberate-upsert identity: two saves with the same key over
 * the same scope resolve to ONE row. That is what makes a crash-recovery
 * re-run of the tool idempotent — the participants spec's thread-key lesson,
 * applied to a store the model writes.
 */
export async function saveMemory(
  args: SaveArgs,
  opts: {
    by: string; userId: string | null; agent: string; config: ResolvedMemory;
  },
): Promise<SaveResult> {
  const text = String(args?.text ?? '').trim();
  if (!text) {
    return { ok: false, error: 'invalid-args', reason: 'A memory needs non-empty "text".' };
  }
  if (text.length > MEMORY_TEXT_MAX) {
    return {
      ok: false,
      error: 'too-long',
      reason: `A memory is a fact, not a document: "text" must be at most `
        + `${MEMORY_TEXT_MAX} characters (got ${text.length}). Save the fact, not the transcript.`,
    };
  }

  const scope = (args?.scope ?? 'user') as MemoryScope;
  if (!opts.config.scopes.includes(scope)) {
    return {
      ok: false,
      error: 'scope-unavailable',
      reason: `This agent's memory does not include the "${scope}" scope; `
        + `available scopes: ${opts.config.scopes.join(', ')}.`,
    };
  }
  if (opts.userId === null) {
    // The gate is NOT the guard here. `config.approve` is optional, and with
    // none configured the approval check is skipped entirely — so an anonymous
    // capability-URL holder could propose an app-scope save and then approve
    // it themselves, writing the pool every session's system prompt reads.
    // The core refuses instead, for both scopes and for the same reason:
    // there is nobody to attribute the write to.
    return {
      ok: false,
      error: 'no-account',
      reason: scope === 'app'
        ? 'Shared work memory cannot be written from a session with no signed-in '
          + 'account.'
        : 'This conversation has no signed-in account, so there is no personal '
          + 'memory to save to.',
    };
  }

  const clause = scopeClause(scope, opts.userId, opts.agent);
  if (!clause) {
    return { ok: false, error: 'no-account', reason: 'No memory store for this session.' };
  }

  // Deliberate upsert. Checked BEFORE the cap so that updating an existing
  // fact in a full store still works — a full store must not freeze the
  // corrections the model is most likely to want to make.
  if (args.key) {
    const existing = await AgentMemories.findOneAsync({ ...clause, key: args.key } as any);
    if (existing) {
      // `pinned` is TRI-STATE on this path: absent leaves the flag alone,
      // `true` sets it, `false` CLEARS it. Treating false as absent made the
      // unpin button on a memory page a silent no-op that still answered
      // `{ ok: true }` — the user unpins, the UI congratulates them, the row
      // stays pinned forever.
      await AgentMemories.updateAsync(
        existing._id,
        {
          $set: {
            text,
            by: opts.by,
            at: new Date(),
            ...(args.pinned === true ? { pinned: true as const } : {}),
          },
          ...(args.pinned === false ? { $unset: { pinned: 1 as const } } : {}),
        },
      );
      return { ok: true, id: existing._id, updated: true };
    }
  }

  const max = scope === 'app' ? opts.config.maxApp : opts.config.max;
  const count = await AgentMemories.find(clause as any).countAsync();
  if (count >= max) {
    return {
      ok: false,
      error: 'memory-full',
      reason: `The "${scope}" memory store already holds its maximum of ${max} entries. `
        + 'Forget something first, or save with the "key" of the entry this replaces.',
    };
  }

  const row: AgentMemory = {
    _id: Random.id(),
    scope,
    text,
    by: opts.by,
    at: new Date(),
    ...(scope === 'app' ? {} : { userId: opts.userId as string }),
    ...(scope === 'agent' ? { agent: opts.agent } : {}),
    ...(args.key ? { key: args.key } : {}),
    ...(args.pinned ? { pinned: true as const } : {}),
  };
  try {
    await AgentMemories.insertAsync(row);
  } catch (e) {
    // The partial unique index on (scope, userId, agent, key) rejected us: a
    // racer inserted the same key between our lookup and this write. Losing
    // that race means the row now EXISTS, so do what the key asked for in the
    // first place and update it. Adopt-on-collision, the insertOrLose idiom.
    if (args.key && isDuplicateKey(e)) {
      const winner = await AgentMemories.findOneAsync({ ...clause, key: args.key } as any);
      if (winner) {
        await AgentMemories.updateAsync(winner._id, {
          $set: {
            text, by: opts.by, at: new Date(),
            ...(args.pinned === true ? { pinned: true as const } : {}),
          },
          ...(args.pinned === false ? { $unset: { pinned: 1 as const } } : {}),
        });
        return { ok: true, id: winner._id, updated: true };
      }
    }
    throw e;
  }
  return { ok: true, id: row._id, updated: false };
}

export type ForgetResult =
  | { ok: true; forgotten: boolean }
  | { ok: false; error: string; reason: string };

/**
 * Forget one fact, by id.
 *
 * `allowApp` is the decision-7a knob: the DDP surface passes `false`, because
 * shared work knowledge arrived through an approval and must not be deletable
 * by any signed-in client. The model's tool passes `true` — its call went
 * through the same gate its save did.
 */
export async function forgetMemory(
  id: string,
  opts: { userId: string | null; agent: string; allowApp: boolean },
): Promise<ForgetResult> {
  const row = await AgentMemories.findOneAsync(String(id ?? ''));
  if (!row) return { ok: true, forgotten: false };

  if (row.scope === 'app') {
    // The unfinished half of the write-side guard. Writes to the shared pool
    // are accountable to a signed-in account; deletions from it must be too,
    // or the same self-propose-then-self-approve chain that was closed on the
    // write side stays open on the destructive one — and destroying approved
    // knowledge needs no injection payload at all.
    if (opts.userId === null) {
      return {
        ok: false,
        error: 'no-account',
        reason: 'Shared work memory cannot be deleted from a session with no '
          + 'signed-in account: there is nobody to hold accountable for it.',
      };
    }
    if (!opts.allowApp) {
      return {
        ok: false,
        error: 'denied-scope',
        reason: 'Shared work memory cannot be deleted from a client; it is removed by '
          + 'an approved agent action or server-side.',
      };
    }
  } else if (opts.userId === null || row.userId !== opts.userId) {
    // Not "not found": a row that exists but belongs to someone else must not
    // be distinguishable from one that never existed.
    return { ok: true, forgotten: false };
  }

  const n = await AgentMemories.removeAsync(row._id);
  return { ok: true, forgotten: n === 1 };
}

/* ---------------------------------------------------------------------------
 * The standing block (spec §6)
 * ------------------------------------------------------------------------ */

/** One row as the block shows it: the fact, trimmed to a title. The block is
 *  an INDEX, not the content — details come through `memory_search`, which is
 *  the whole reason the block is affordable on every iteration. */
function title(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

/**
 * The hint's search (spec §10): mechanical, harness-run, never a model call.
 *
 * Returns TITLES ONLY. Content never enters context this way — the model must
 * still call `memory_search` — so a bad match costs one line, not a poisoned
 * turn. Threshold-gated by `minScore` where the rung reports one; the regex
 * and text rungs have no comparable score, so they contribute their top hits
 * and the cap does the limiting.
 */
export async function memoryHint(
  query: string,
  opts: { userId: string | null; agent: string; config: ResolvedMemory },
): Promise<string[]> {
  if (!opts.config.hints) return [];
  const { minScore } = opts.config.hints;
  try {
    const rows = await searchMemory(query, { ...opts, limit: 3 });
    // THRESHOLD-GATED, which is the difference between a hint and noise. The
    // rungs that report a relevance score (mongot's `$vectorSearch`, surfaced
    // as `score`) are held to `minScore`; the text and regex rungs have no
    // comparable number, so for them a match IS the signal and the limit does
    // the bounding. Without this the block appended three arbitrary titles to
    // every message, including "thanks, that's all" — the exact noise
    // `minScore` was configured to prevent.
    const scored = rows.filter((r) => {
      const score = (r as { score?: unknown }).score;
      return typeof score === 'number' ? score >= minScore : true;
    });
    return scored.map((r) => `${title(r.text)}${r.scope === 'app' ? ' (work)' : ''}`);
  } catch {
    // The hint is an optimization. A failure here must never reach the turn:
    // the block still renders, the tool still works, the model just is not
    // nudged. "Never fails a turn" is the ladder's promise and this is its
    // last line of defense.
    return [];
  }
}

/**
 * Render the memory block appended to the system prompt.
 *
 * Returns `''` when there is nothing to say — an empty block is a section
 * header the model must read on every call that can only ever mean "no".
 */
export async function memoryBlock(opts: {
  userId: string | null;
  agent: string;
  config: ResolvedMemory;
  /** Titles from the turn's cached hint, already computed. */
  hint?: string[];
}): Promise<string> {
  // Guarded like the hint, and for the same reason: this runs inside the
  // attempt's try/catch, so an unguarded rejection (a replica-set step-down
  // mid-count) would be classified as a PROVIDER failure and retried with
  // backoff — a database blip mis-reported as the model being down. A turn
  // without its memory listing is a turn; a turn that dies is not.
  let listed: ListedMemories;
  try {
    listed = await listForBlock(opts.userId, opts.agent, opts.config);
  } catch {
    return '';
  }
  const lines: string[] = [];

  if (opts.userId === null) {
    // Anonymous: no person store exists, and saying so is better than the
    // model discovering it through a refused save.
    if (listed.work.length === 0) return '';
  } else if (listed.person.length > 0) {
    lines.push(`About this person (${listed.personTotal} remembered):`);
    for (const r of listed.person) {
      lines.push(`- ${title(r.text)}${r.pinned ? ' [pinned]' : ''}`);
    }
  }

  if (listed.work.length > 0) {
    lines.push(`About this work (${listed.workTotal} remembered):`);
    for (const r of listed.work) {
      // Provenance is visible here on purpose: a colleague's approved fact
      // reads as theirs, which is what makes shared knowledge legible.
      lines.push(`- ${title(r.text)} [learned by ${r.by}]`);
    }
  }

  if (opts.hint && opts.hint.length > 0) {
    lines.push(`Possibly relevant to the latest message: ${opts.hint.join('; ')}`);
  }

  if (lines.length === 0 && opts.userId !== null) return '';

  const foot = opts.userId === null
    ? 'This conversation has no signed-in account, so there is no personal memory; '
      + 'shared work notes above still apply.'
    : 'Use memory_search to recall details, memory_save to remember something new.';

  return `\n\n## Memory\n${lines.join('\n')}\n${foot}`;
}
