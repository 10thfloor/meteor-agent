import os from 'os';
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import {
  assertDefinitionName,
  DEFAULT_DOCUMENTS,
  DEFAULT_HIDDEN_ENTRIES,
  definitionOf,
  PREFIX,
  ROOT_CONVERSATION_ID,
  storageKey,
} from '../common/names';
import { DurableHost, type Operation } from './host';
import { loadPackage } from './loader';
import type { MongoStorage } from './mongo-storage';
import { type AgentChoices, OPERATIONS } from './operations';

export const PI_DURABLE = '@earendil-works/pi-durable';
export const CHORD = '@earendil-works/chord';

/** What a client may ask for over DDP. The server-side API is never asked. */
export type DurableAction =
  | 'view' | 'root' | 'create' | 'fork' | 'submit' | 'abort' | 'withdraw' | 'reset' | 'compact';

export type DurableTarget = { readonly key: string; readonly conversationId?: number };

/** User input as pi-ai takes it: text, or text and image parts. */
export type DurableContent = string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];

export type DurableDraft =
  | { type: 'input'; content: DurableContent; whenBusy?: 'steer' | 'followUp' | 'reject'; requestId?: string }
  | { type: 'write'; entry: Record<string, unknown>; requestId?: string };

export type DurableConfig = {
  /**
   * What a harness over the storage `key` runs with: Pi Durable's
   * `HarnessOptions` without the storage, so at least `models` and `registry`.
   * Called on whichever server instance hosts the storage, each time it opens.
   */
  harness(key: string): Record<string, any> | Promise<Record<string, any>>;
  /**
   * Who may do what over DDP. Absent, or returning anything but `true`:
   * refused. A viewer's rule is asked again while its subscription lives, so
   * a `view` that turns false ends the subscription.
   */
  allow?(userId: string | null, action: DurableAction, target: DurableTarget): boolean | Promise<boolean>;
  /**
   * The agent a conversation created over DDP starts with. A client never
   * chooses its own model, tools or instructions.
   */
  agent?(target: { key: string; userId: string | null; action: 'root' | 'create' | 'fork' }):
    AgentChoices | undefined | Promise<AgentChoices | undefined>;
  /** More that can be asked of a storage from any instance, beside the built-in operations. */
  operations?: Readonly<Record<string, Operation>>;
  /** Document kinds a viewer receives. Default `pi.live`, `pi.inbox`, `pi.usage`. */
  documents?: readonly string[];
  /** Entry kinds a viewer does not receive. Default `pi.system`. */
  hiddenEntries?: readonly string[];
};

const definitions = new Map<string, Durable>();
let core: Promise<DurableHost> | undefined;

function packageSettings(): Record<string, any> {
  return (Meteor.settings as any)?.packages?.['10thfloor:durable'] ?? {};
}

/**
 * Names this server instance among those sharing the database. It is stable
 * across restarts of the same instance, so a restarted server resumes its own
 * storages at once, and distinct between instances: the host name, plus the
 * app's URL in development (where the port changes) or its port in production.
 * `DURABLE_INSTANCE_ID`, or `instanceId` in the package settings, overrides it.
 */
export function instanceId(): string {
  const configured = process.env.DURABLE_INSTANCE_ID ?? packageSettings().instanceId;
  if (configured) return String(configured);
  const slot = Meteor.isDevelopment ? process.env.ROOT_URL : process.env.PORT;
  return `${os.hostname()}|${slot ?? process.pid}`;
}

async function createCore(): Promise<DurableHost> {
  const durable = await loadPackage(PI_DURABLE) as any;
  const delta = await loadPackage(CHORD, 'delta') as any;
  const context = (await loadPackage(CHORD, 'context') as any).BACKGROUND_CONTEXT;
  if (typeof durable?.Harness?.open !== 'function' || typeof delta?.apply !== 'function' || !context) {
    throw new Error('[10thfloor:durable] pi-durable or chord exposes no Harness/apply/BACKGROUND_CONTEXT');
  }
  const { client, db } = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo;
  const tuning = packageSettings();
  const numeric = (name: string) => (typeof tuning[name] === 'number' ? { [name]: tuning[name] } : {});
  const host = new DurableHost({
    client,
    db,
    prefix: PREFIX,
    runtime: { apply: delta.apply, StorageRejected: durable.StorageRejected },
    Harness: durable.Harness,
    context,
    instanceId: instanceId(),
    accepts: (key) => definitions.has(definitionOf(key)),
    harness: (key) => definitionFor(key).harnessOptions(key),
    operations: (key) => definitions.get(definitionOf(key))?.operations,
    onError: (error, where) => Meteor._debug(`[10thfloor:durable] ${where}:`, error),
    ...numeric('leaseMs'),
    ...numeric('heartbeatMs'),
    ...numeric('sweepMs'),
    ...numeric('idleMs'),
    ...numeric('requestMs'),
    ...(tuning.writeConcern && typeof tuning.writeConcern === 'object' ? { writeConcern: tuning.writeConcern } : {}),
  });
  await host.start();
  return host;
}

/**
 * The one host of this server process. Every definition shares it: one lease
 * heartbeat, one sweep, one request stream.
 */
export function durableHost(): Promise<DurableHost> {
  if (core === undefined) {
    const created = createCore();
    core = created;
    created.catch(() => { if (core === created) core = undefined; });
  }
  return core;
}

/** Stop hosting on this instance: close every open storage and hand over the ones with work left. */
export async function shutdown(): Promise<void> {
  const running = core;
  core = undefined;
  if (running !== undefined) await (await running).stop();
}

function definitionFor(storage: string): Durable {
  const definition = definitions.get(definitionOf(storage));
  if (definition === undefined) throw new Error(`[10thfloor:durable] no definition hosts storage ${JSON.stringify(storage)}`);
  return definition;
}

/** The definition named `name`, if this server has one. */
export function definitionNamed(name: string): Durable | undefined {
  return definitions.get(name);
}

const textOf = (message: any): string => {
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap((part: any) => (part?.type === 'text' ? [part.text] : [])).join('');
};

/**
 * A family of Pi Durable storages on this app's Mongo, hosted by whichever
 * server instance gets there first and reachable from all of them.
 *
 * ```ts
 * export const Missions = new Durable('missions', {
 *   harness: () => ({ models, registry }),
 *   allow: (userId, action, { key }) => ownsMission(userId, key),
 * });
 * const { submissionId } = await Missions.submit('m42', 1, 'Why did the deploy fail?');
 * ```
 *
 * One `key` is one storage: one Pi Durable Session, with its conversations,
 * tasks and documents, one commit line, and one owner at a time. Use a key
 * per unit that works together, such as a mission, never one for the app.
 */
export class Durable {
  readonly name: string;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly documents: readonly string[];
  readonly hiddenEntries: readonly string[];
  private readonly config: DurableConfig;

  constructor(name: string, config: DurableConfig) {
    assertDefinitionName(name);
    if (definitions.has(name)) throw new Error(`[10thfloor:durable] a definition named ${JSON.stringify(name)} exists`);
    if (typeof config?.harness !== 'function') throw new Error('[10thfloor:durable] a definition needs `harness(key)`');
    this.name = name;
    this.config = config;
    this.operations = { ...OPERATIONS, ...config.operations };
    this.documents = config.documents ?? DEFAULT_DOCUMENTS;
    this.hiddenEntries = config.hiddenEntries ?? DEFAULT_HIDDEN_ENTRIES;
    definitions.set(name, this);
    // Storages this definition left unfinished are resumed without waiting for anyone to ask.
    Meteor.startup(() => { void durableHost().catch((error) => Meteor._debug('[10thfloor:durable] start:', error)); });
  }

  /** Test seam: forget this definition. Storages it has open here are closed, and handed over if they have work. */
  async _remove(): Promise<void> {
    const host = core === undefined ? undefined : await core;
    if (host !== undefined) {
      for (const key of host.hosted()) {
        if (definitionOf(key) === this.name) await host.release(key);
      }
    }
    definitions.delete(this.name);
  }

  /** The storage key of `key`: the definition's name is its namespace. */
  storage(key: string): string {
    return storageKey(this.name, key);
  }

  /** Whether `userId` may do `action` over DDP. Server-side callers are never asked. */
  async allows(userId: string | null, action: DurableAction, target: DurableTarget): Promise<boolean> {
    if (this.config.allow === undefined) return false;
    return (await this.config.allow(userId, action, target)) === true;
  }

  /** The agent a conversation created over DDP starts with. */
  async agentFor(target: { key: string; userId: string | null; action: 'root' | 'create' | 'fork' }): Promise<AgentChoices | undefined> {
    return this.config.agent?.(target);
  }

  /** @internal What the host opens a harness with. */
  async harnessOptions(storage: string): Promise<any> {
    return this.config.harness(storage.slice(this.name.length + 1));
  }

  // ── Work, from any server instance ─────────────────────────────────────────

  /** Run an operation against the storage `key`, on whichever instance hosts it. */
  async call<T = unknown>(key: string, op: string, args?: unknown, options?: { requestId?: string }): Promise<T> {
    return (await durableHost()).call<T>(this.storage(key), op, args ?? {}, options);
  }

  /** The root conversation's ID, creating it with `agent` on first use. */
  async root(key: string, agent?: AgentChoices): Promise<number> {
    return (await this.call<{ conversationId: number }>(key, 'root', agent === undefined ? {} : { agent })).conversationId;
  }

  /** A new conversation in the storage. */
  async create(key: string, agent?: AgentChoices): Promise<number> {
    return (await this.call<{ conversationId: number }>(key, 'create', agent === undefined ? {} : { agent })).conversationId;
  }

  /** A fork of `conversationId` at the entry `at`. */
  async fork(key: string, conversationId: number, at: number, agent?: AgentChoices): Promise<number> {
    const args = { conversationId, at, ...(agent === undefined ? {} : { agent }) };
    return (await this.call<{ conversationId: number }>(key, 'fork', args)).conversationId;
  }

  /**
   * Hand user input, or a passive entry write, to a conversation. A string is
   * input. It resolves once the submission is durably admitted, not once it is
   * answered; `settled()` or `ask()` wait for the answer.
   */
  async submit(key: string, conversationId: number, draft: string | DurableDraft): Promise<{ submissionId: number }> {
    const submission = typeof draft === 'string' ? { type: 'input', content: draft } : draft;
    return this.call(key, 'submit', { conversationId, draft: submission });
  }

  /** Stop a conversation's current work. `idle` is whether it had stopped when this returned. */
  async abort(key: string, conversationId: number, options: { background?: boolean; waitMs?: number } = {}): Promise<{ idle: boolean }> {
    return this.call(key, 'abort', { conversationId, ...options });
  }

  /** Withdraw a queued submission. */
  async withdraw(key: string, submissionId: number, conversationId?: number): Promise<'aborted' | 'already_placed' | 'settled' | 'not_found'> {
    const args = { submissionId, ...(conversationId === undefined ? {} : { conversationId }) };
    return (await this.call<{ result: any }>(key, 'withdraw', args)).result;
  }

  /** Start a new context, optionally from a handoff note. */
  async reset(key: string, conversationId: number, handoff?: string): Promise<void> {
    await this.call(key, 'reset', { conversationId, ...(handoff === undefined ? {} : { handoff }) });
  }

  /** Summarize older entries now. Resolves with the compaction task's ID. */
  async compact(key: string, conversationId: number, instructions?: string): Promise<number> {
    const args = { conversationId, ...(instructions === undefined ? {} : { instructions }) };
    return (await this.call<{ taskId: number }>(key, 'compact', args)).taskId;
  }

  /** Change what a conversation runs with. */
  async configure(key: string, conversationId: number, agent: AgentChoices): Promise<void> {
    await this.call(key, 'configure', { conversationId, agent });
  }

  // ── Reading, from any server instance ──────────────────────────────────────

  /** A read-only view of the storage: every read of Pi Durable's storage contract, with no ownership. */
  async reader(key: string): Promise<MongoStorage> {
    return (await durableHost()).reader(this.storage(key));
  }

  /** Resolve with the submission's record once it is answered or has failed. */
  async settled(key: string, submissionId: number, options: { timeoutMs?: number } = {}): Promise<any> {
    return (await durableHost()).settled(this.storage(key), submissionId as never, options);
  }

  /**
   * Input, and its answer: submit to the conversation (the root by default),
   * wait for the run to end, and read what the model said last.
   */
  async ask(
    key: string,
    content: DurableContent,
    options: { conversationId?: number; requestId?: string; timeoutMs?: number; agent?: AgentChoices } = {},
  ): Promise<{ status: 'done' | 'unanswered'; text: string; submissionId: number; entryId?: number; reason?: string }> {
    const conversationId = options.conversationId ?? await this.root(key, options.agent);
    const draft: DurableDraft = { type: 'input', content, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) };
    const { submissionId } = await this.submit(key, conversationId, draft);
    const record = await this.settled(key, submissionId, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
    if (record.status !== 'done') return { status: 'unanswered', text: '', submissionId, reason: record.reason };
    const context = (await loadPackage(CHORD, 'context') as any).BACKGROUND_CONTEXT;
    const answer = await (await this.reader(key)).entry(record.answer, context);
    return { status: 'done', text: textOf(answer?.entry.model?.[0]), submissionId, entryId: record.answer };
  }

  // ── On the instance that hosts the storage ─────────────────────────────────

  /**
   * Use the storage's harness directly. It is opened here if no instance has
   * it; if another live instance does, this rejects with `HostedElsewhere`,
   * because a harness cannot be handed across processes. In a deployment of
   * several instances, put such code in an `operations` entry and `call()` it.
   */
  async with<T>(key: string, use: (harness: any) => T | Promise<T>): Promise<T> {
    return (await durableHost()).with(this.storage(key), use);
  }

  /** The instance that holds the storage's lease now, if any. */
  async owner(key: string): Promise<string | undefined> {
    return (await durableHost()).owner(this.storage(key));
  }

  /** Keys of this definition that this instance has open. */
  async hosted(): Promise<string[]> {
    const host = await durableHost();
    return host.hosted().filter((storage) => definitionOf(storage) === this.name).map((storage) => storage.slice(this.name.length + 1));
  }

  /**
   * Erase a storage: whichever instance runs it stops, and every record of it
   * is deleted. This is the unit of erasure: Pi Durable's entries are
   * immutable, and one conversation cannot be deleted from a storage.
   */
  async destroy(key: string): Promise<void> {
    await (await durableHost()).destroy(this.storage(key));
  }
}

export { ROOT_CONVERSATION_ID };
