import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { applyImmutable } from '@earendil-works/chord/dist/delta/index.js';
import { NAMES, ROOT_CONVERSATION_ID, storageKey } from '../common/names';
import { DurableConversations, DurableEntries, DurableRevisions } from './collections';

export type DurableConversationOptions = {
  /** The definition's name on the server: `new Durable(name, ...)`. */
  host: string;
  /** The storage key. */
  key: string;
  /** Default: the root conversation. */
  conversationId?: number;
  /** How many of the newest entries to receive. Default 200. */
  history?: number;
};

type Input = string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];

/** One document's present value, kept up to date as its rows arrive. */
type Materialized = {
  readonly address: string;
  /** Rows of this incarnation by commit sequence. */
  readonly rows: Map<number, { base: boolean; content: any }>;
  /** Sequence of the base `value` was built on, and of the last row applied to it. */
  base: number | undefined;
  applied: number | undefined;
  value: any;
  /** Set when rows arrived in an order the fast path does not cover; the value is rebuilt on the next read. */
  dirty: boolean;
};

const parse = (text: string): any => JSON.parse(text);

/**
 * A live view of one conversation, and the way to speak to it.
 *
 * ```ts
 * const chat = new DurableConversation({ host: 'missions', key: missionId });
 * Tracker.autorun(() => {
 *   render(chat.entries(), chat.streamingText(), chat.busy());
 * });
 * await chat.submit('Why did the deploy fail?');
 * ```
 *
 * Every read is reactive. Entries are immutable, so each is parsed once. A
 * document is rebuilt from its rows as they arrive: a base is its whole value,
 * a delta is a few Chord operations on the value before it. That is how a
 * streamed answer costs one small row per update, whatever its length.
 */
export class DurableConversation {
  readonly host: string;
  readonly key: string;
  readonly conversationId: number;
  private readonly storage: string;
  private handle: Meteor.SubscriptionHandle | null = null;
  private observer: { stop(): void } | null = null;
  private readonly records = new Map<string, any>();
  private readonly documents = new Map<number, Materialized>();
  private readonly dependencies = new Map<string, Tracker.Dependency>();
  private window: number | undefined;

  constructor(options: DurableConversationOptions) {
    this.host = options.host;
    this.key = options.key;
    this.conversationId = options.conversationId ?? ROOT_CONVERSATION_ID;
    this.storage = storageKey(options.host, options.key);
    this.window = options.history;
    this.subscribe();
    this.observe();
  }

  /** Whether everything the conversation had when the subscription began has arrived. Reactive. */
  ready(): boolean {
    return this.handle?.ready() ?? false;
  }

  /** Receive the newest `count` entries from now on; for a "show earlier" control. */
  history(count: number): void {
    this.window = count;
    this.subscribe();
  }

  /** Stop watching. Idempotent. */
  stop(): void {
    this.handle?.stop();
    this.handle = null;
    this.observer?.stop();
    this.observer = null;
    this.documents.clear();
    this.records.clear();
    for (const dependency of this.dependencies.values()) dependency.changed();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * The entries this conversation can see, oldest first, as Pi Durable
   * records: `{ id, conversationId, kind, model?, data?, head? }`. A fork sees
   * its ancestors' entries up to where it left them. Reactive.
   */
  entries(): any[] {
    const chain = this.ancestry();
    if (chain.length === 0) return [];
    const rows = DurableEntries.find(
      {
        s: this.storage,
        $or: chain.map((link) => ({ c: link.id, ...(link.upTo === undefined ? {} : { id: { $lte: link.upTo } }) })),
      },
      { sort: { id: 1 } },
    ).fetch();
    return rows.map((row: any) => {
      let record = this.records.get(row._id);
      if (record === undefined) {
        record = parse(row.r);
        this.records.set(row._id, record);
      }
      return record;
    });
  }

  /**
   * The entries of the active context: from the newest reset or compaction
   * on. Everything before it is history the model no longer sees. Reactive.
   */
  active(): any[] {
    const entries = this.entries();
    let head: number | undefined;
    for (const entry of entries) if (entry.head !== undefined) head = entry.head;
    return head === undefined ? entries : entries.filter((entry) => entry.id >= (head as number));
  }

  /**
   * The present value of one of the conversation's documents, by kind, and by
   * key for a member of a document family. Undefined until it arrives, and
   * for a kind the definition does not publish. Reactive.
   */
  document(kind: string, familyKey?: string): any {
    const address = `${JSON.stringify(kind)}\u0000${JSON.stringify(familyKey ?? '')}`;
    this.dependency(address).depend();
    let found: Materialized | undefined;
    for (const document of this.documents.values()) {
      // A retired incarnation and its replacement can overlap for a moment; the newer one is the document.
      if (document.address === address && (found === undefined || (document.base ?? -1) > (found.base ?? -1))) {
        found = document;
      }
    }
    if (found === undefined) return undefined;
    if (found.dirty) this.rebuild(found);
    return found.value;
  }

  /** `pi.live`: the run in progress, the answer being generated, and the current round of tool calls. Reactive. */
  live(): any {
    return this.document('pi.live');
  }

  /** `pi.inbox`: submissions waiting for a turn boundary. Reactive. */
  inbox(): any {
    return this.document('pi.inbox');
  }

  /** `pi.usage`: tokens and cost by model and by tool. Reactive. */
  usage(): any {
    return this.document('pi.usage');
  }

  /** Whether a run is working on an input. Reactive. */
  busy(): boolean {
    return this.live()?.run !== undefined;
  }

  /** The assistant message being generated, as far as it has been committed, or undefined. Reactive. */
  streaming(): any {
    return this.live()?.generation?.message;
  }

  /** The text of the answer being generated, or `''`. Reactive. */
  streamingText(): string {
    const content = this.streaming()?.content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((part: any) => (part?.type === 'text' ? [part.text] : [])).join('');
  }

  /** The current round of tool calls: name, status, running output. Reactive. */
  tools(): any[] {
    return this.live()?.tools ?? [];
  }

  // ── Speaking ───────────────────────────────────────────────────────────────

  /**
   * Hand input to the conversation. It resolves once the server has durably
   * admitted it. While a run is working, `whenBusy` decides what happens:
   * `followUp` (the default) queues it for after the answer, `steer` adds it
   * to the work in progress, `reject` fails with `conversation-busy`. The
   * request ID makes a retry after a lost connection admit it only once.
   */
  submit(
    content: Input,
    options: { whenBusy?: 'steer' | 'followUp' | 'reject'; requestId?: string } = {},
  ): Promise<{ submissionId: number }> {
    return Meteor.callAsync(NAMES.mSubmit, {
      ...this.target(),
      content,
      requestId: options.requestId ?? Random.id(),
      ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
    });
  }

  /** Stop the current work. `idle` is whether it had stopped when the server answered. */
  abort(): Promise<{ idle: boolean }> {
    return Meteor.callAsync(NAMES.mAbort, this.target());
  }

  /** Withdraw a queued submission. */
  async withdraw(submissionId: number): Promise<'aborted' | 'already_placed' | 'settled' | 'not_found'> {
    return (await Meteor.callAsync(NAMES.mWithdraw, { ...this.target(), submissionId })).result;
  }

  /** Start a new context, optionally from a handoff note. Older entries stay. */
  async reset(handoff?: string): Promise<void> {
    await Meteor.callAsync(NAMES.mReset, { ...this.target(), ...(handoff === undefined ? {} : { handoff }) });
  }

  /** Summarize older entries now. */
  async compact(instructions?: string): Promise<void> {
    await Meteor.callAsync(NAMES.mCompact, { ...this.target(), ...(instructions === undefined ? {} : { instructions }) });
  }

  /** Fork this conversation at an entry. Resolves with the new conversation's ID. */
  async fork(at: number): Promise<number> {
    return (await Meteor.callAsync(NAMES.mFork, { ...this.target(), at })).conversationId;
  }

  /** The root conversation of a storage, created on first use. Resolves with its ID. */
  static async root(host: string, key: string): Promise<number> {
    return (await Meteor.callAsync(NAMES.mRoot, { host, key })).conversationId;
  }

  /** A new conversation in a storage. Resolves with its ID. */
  static async create(host: string, key: string): Promise<number> {
    return (await Meteor.callAsync(NAMES.mCreate, { host, key })).conversationId;
  }

  // ── Inside ─────────────────────────────────────────────────────────────────

  private target() {
    return { host: this.host, key: this.key, conversationId: this.conversationId };
  }

  private subscribe(): void {
    const previous = this.handle;
    this.handle = Meteor.subscribe(NAMES.pubConversation, {
      ...this.target(),
      ...(this.window === undefined ? {} : { history: this.window }),
    });
    // After the new one, so rows both carry are never dropped and sent again.
    previous?.stop();
  }

  /** This conversation and its fork ancestors, nearest first, each with the last of its entries visible from here. */
  private ancestry(): { id: number; upTo?: number }[] {
    const chain: { id: number; upTo?: number }[] = [];
    let upTo: number | undefined;
    for (let id: number | undefined = this.conversationId; id !== undefined;) {
      const row: any = DurableConversations.findOne(`${this.storage}:${id}`);
      if (row === undefined) break;
      const record = parse(row.r);
      chain.push(upTo === undefined ? { id } : { id, upTo });
      if (record.parent === undefined) break;
      upTo = upTo === undefined ? record.parent.at : Math.min(upTo, record.parent.at);
      id = record.parent.conversationId;
    }
    return chain;
  }

  private dependency(address: string): Tracker.Dependency {
    let dependency = this.dependencies.get(address);
    if (dependency === undefined) {
      dependency = new Tracker.Dependency();
      this.dependencies.set(address, dependency);
    }
    return dependency;
  }

  private observe(): void {
    this.observer = DurableRevisions.find({ s: this.storage, o: this.conversationId }).observe({
      added: (row: any) => this.rowAdded(row),
      removed: (row: any) => this.rowRemoved(row),
    });
  }

  private rowAdded(row: any): void {
    let document = this.documents.get(row.d);
    if (document === undefined) {
      document = { address: `${row.k}\u0000${row.kv}`, rows: new Map(), base: undefined, applied: undefined, value: undefined, dirty: false };
      this.documents.set(row.d, document);
    }
    const base = row.t === 'base';
    const content = parse(row.c);
    document.rows.set(row.q, { base, content });
    if (!document.dirty) {
      const after = document.applied ?? -1;
      if (base && row.q > after) {
        // A new base is the whole value.
        document.value = content;
        document.base = row.q;
        document.applied = row.q;
      } else if (!base && document.base !== undefined && row.q > after) {
        // The next delta, in order: the usual case, and the cheap one.
        document.value = applyImmutable(document.value, content);
        document.applied = row.q;
      } else {
        // A row from before what has been applied, or a delta whose base has not arrived.
        document.dirty = true;
      }
    }
    this.dependency(document.address).changed();
  }

  private rowRemoved(row: any): void {
    const document = this.documents.get(row.d);
    if (document === undefined) return;
    document.rows.delete(row.q);
    if (document.rows.size > 0) return;
    // A new base replaces every row of a document: the old ones go, then the new one comes. The value stays through
    // that gap. A document whose rows do not come back was retired, and then it is gone.
    Meteor.setTimeout(() => {
      if (document.rows.size > 0 || this.documents.get(row.d) !== document) return;
      this.documents.delete(row.d);
      this.dependency(document.address).changed();
    }, 250);
  }

  /** Recompute a value from its rows: the newest base and every delta after it, in commit order. */
  private rebuild(document: Materialized): void {
    const sequences = [...document.rows.keys()].sort((a, b) => a - b);
    let start = -1;
    for (let index = sequences.length - 1; index >= 0; index--) {
      if (document.rows.get(sequences[index]!)!.base) {
        start = index;
        break;
      }
    }
    // No base among the rows yet: keep what there is until one arrives.
    if (start === -1) return;
    let value = document.rows.get(sequences[start]!)!.content;
    for (let index = start + 1; index < sequences.length; index++) {
      value = applyImmutable(value, document.rows.get(sequences[index]!)!.content);
    }
    document.value = value;
    document.base = sequences[start];
    document.applied = sequences[sequences.length - 1];
    document.dirty = false;
  }
}
