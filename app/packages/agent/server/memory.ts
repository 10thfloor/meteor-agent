import { Random } from 'meteor/random';
import { AgentMemories } from '../common/collections';
import {
  MEMORY_TEXT_MAX,
  type AgentMemory, type MemoryScope, type ResolvedMemory,
} from '../common/types';

/** Core memory store — leaf module (no cycles). Both the tool and DDP
 *  surfaces funnel here; DDP applies its own narrower policy first. */

/* ---------------------------------------------------------------------------
 * Scoping
 * ------------------------------------------------------------------------ */

/** Selector for one scope's rows. App rows carry no `userId` — the absence
 *  is the sharing, so the clause must not mention the field at all. */
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

/** Standing block read: pinned first, then most-recent, split into person
 *  and work sections. Direct `findAsync` (not the search ladder) so saves
 *  are visible immediately. Overflow pins do not consume recent slots. */
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
    // Exclude ALL pinned rows, not just the shown ones — overflow pins must
    // not fall into the recent fetch and eat its slots.
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
/** `null` = unprobed. Must probe explicitly — a missing index returns empty,
 *  not an error, so passive discovery silently returns nothing forever. */
type VectorReadiness = 'ready' | 'no-search-node' | 'missing-index' | 'index-not-queryable';
let vectorReadiness: VectorReadiness | null = null;
let textAvailable: boolean | null = null;

/** The index name the pipeline queries and the probe checks for. */
const VECTOR_INDEX = 'agent_memories_vector';

/** Probe whether the vector rung can work. `$listSearchIndexes` covers all
 *  three failure modes in one call without error-message inference. */
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

/** Escape regex metacharacters — raw user text would otherwise SyntaxError. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** TEST SEAM: replaces the vector rung. Returns a restore fn; resets probe
 *  cache and warn latch so suites sharing one process stay independent. */
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

/** TEST SEAM: force the regex rung by disabling vector and text.
 *  Returns a restore fn. */
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

/** `$vectorSearch` via mongot's automated embedding — the query string goes
 *  to the pipeline, no embedding call of our own. A deployment without mongot
 *  errors once; the probe caches the answer and falls down the ladder. */
async function vectorSearch(
  sel: Record<string, unknown>, query: string, limit: number,
): Promise<AgentMemory[]> {
  if (vectorSearchImpl) return vectorSearchImpl(sel, query, limit);
  // `filter` scopes inside the vector stage (pre-limit). The `$match` stays
  // as a belt in case the index lacks the declared filter paths.
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

/** Recall down the ladder: installed fn -> $vectorSearch -> $text -> regex.
 *  Every rung failure degrades rather than throws — a thin answer beats
 *  killing the turn over a database capability nobody chose. */
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
      // Re-scope the app's rows — an installed fn is a retrieval strategy,
      // not an authorization decision, so its results must be filtered.
      return Array.isArray(rows)
        ? rows.filter((r) => inScope(r, opts.config.scopes, opts.userId, opts.agent))
          .slice(0, limit)
        : [];
    } catch {
      // An app's own search throwing is the app's bug, but it must not be the
      // conversation's death. Warn and fall through to the built-in rungs.
      warnMemory('the installed memory search fn threw; falling back to the built-in ladder');
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
      // A filter-path error is a definition problem the operator must fix;
      // anything else is transient — degrade this call, retry next time.
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

/** Save one fact. Returns structured refusals (not throws) so the model can
 *  route around rule violations. `key` is the upsert identity — same key +
 *  scope = one row, making crash-recovery re-runs idempotent. */
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
    // The gate is not the guard — `config.approve` is optional, so the core
    // refuses directly: there is nobody to attribute the write to.
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
      // `pinned` is tri-state: absent = leave alone, true = set, false = clear.
      // Treating false as absent made unpin a silent no-op.
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
    // Race: another insert won. The row exists, so upsert it instead.
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

/** Forget one fact by id. `allowApp` gates shared-pool deletion: DDP passes
 *  false (approval-guarded knowledge), the model's tool passes true. */
export async function forgetMemory(
  id: string,
  opts: { userId: string | null; agent: string; allowApp: boolean },
): Promise<ForgetResult> {
  const row = await AgentMemories.findOneAsync(String(id ?? ''));
  if (!row) return { ok: true, forgotten: false };

  if (row.scope === 'app') {
    // Deletions from the shared pool require a signed-in account, same as writes.
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
  } else if (opts.userId === null || row.userId !== opts.userId
    || (row.scope === 'agent' && row.agent !== opts.agent)) {
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

/** Harness-run hint search — returns titles only so a bad match costs one
 *  line, not a poisoned turn. Threshold-gated by `minScore` where the rung
 *  reports one; text/regex rungs contribute top hits ungated. */
export async function memoryHint(
  query: string,
  opts: { userId: string | null; agent: string; config: ResolvedMemory },
): Promise<string[]> {
  return (await memoryHintSnapshot(query, opts)).titles;
}

export interface MemoryHintSnapshot {
  titles: string[];
  /** Exact source rows represented by the titles. A Memory Frame records
   * these alongside standing-block rows so hint evidence is not invisible. */
  rows: AgentMemory[];
}

/** Hint text and its evidence in one read. The legacy `memoryHint` Interface
 * remains a title-only convenience wrapper. */
export async function memoryHintSnapshot(
  query: string,
  opts: { userId: string | null; agent: string; config: ResolvedMemory },
): Promise<MemoryHintSnapshot> {
  if (!opts.config.hints) return { titles: [], rows: [] };
  const { minScore } = opts.config.hints;
  try {
    const rows = await searchMemory(query, { ...opts, limit: 3 });
    // Threshold-gate: vector scores below `minScore` are noise. Text/regex
    // have no comparable score, so any match passes and the limit bounds.
    const scored = rows.filter((r) => {
      const score = (r as { score?: unknown }).score;
      return typeof score === 'number' ? score >= minScore : true;
    });
    return {
      titles: scored.map((r) => `${title(r.text)}${r.scope === 'app' ? ' (work)' : ''}`),
      rows: scored,
    };
  } catch {
    // Hints are best-effort — a failure here must never reach the turn.
    return { titles: [], rows: [] };
  }
}

export interface MemoryBlockSnapshot {
  /** Exact frozen Fact Memory prompt fragment. */
  text: string;
  /** Exact rows represented by the standing listing. Hint-only search hits are
   * intentionally not included because the hint carries titles, not row ids. */
  rows: AgentMemory[];
}

function renderMemoryBlock(
  opts: { userId: string | null; hint?: string[] },
  listed: ListedMemories,
): string {
  const lines: string[] = [];

  if (opts.userId === null) {
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

/** Read and render Fact Memory once so an Agent Experience Memory Frame can
 * freeze both the prompt bytes and their durable evidence ids for a Turn. */
export async function memoryBlockSnapshot(opts: {
  userId: string | null;
  agent: string;
  config: ResolvedMemory;
  /** Titles from the turn's cached hint, already computed. */
  hint?: string[];
}): Promise<MemoryBlockSnapshot> {
  // Guarded: an unguarded rejection here would be mis-classified as a
  // provider failure and retried with backoff.
  let listed: ListedMemories;
  try {
    listed = await listForBlock(opts.userId, opts.agent, opts.config);
  } catch {
    return { text: '', rows: [] };
  }
  return {
    text: renderMemoryBlock(opts, listed),
    rows: [...listed.person, ...listed.work],
  };
}

/** Render the memory block for the system prompt. Returns `''` when empty. */
export async function memoryBlock(opts: {
  userId: string | null;
  agent: string;
  config: ResolvedMemory;
  hint?: string[];
}): Promise<string> {
  return (await memoryBlockSnapshot(opts)).text;
}
