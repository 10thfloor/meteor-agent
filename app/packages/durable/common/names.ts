/** Collection name prefix of everything this package stores. */
export const PREFIX = 'pi_durable_';

export const NAMES = {
  // The three collections a viewer is published rows from. The storage has
  // more (tasks, submissions, documents, ids, meta, leases, requests); none of
  // those ever reaches a client.
  conversations: `${PREFIX}conversations`,
  entries: `${PREFIX}entries`,
  revisions: `${PREFIX}revisions`,
  pubConversation: 'durable.conversation',
  mRoot: 'durable.root',
  mCreate: 'durable.create',
  mFork: 'durable.fork',
  mSubmit: 'durable.submit',
  mAbort: 'durable.abort',
  mWithdraw: 'durable.withdraw',
  mReset: 'durable.reset',
  mCompact: 'durable.compact',
} as const;

/** Document kinds a viewer receives unless the definition says otherwise. `pi.agent` holds a conversation's
 *  instructions and is left out. */
export const DEFAULT_DOCUMENTS: readonly string[] = ['pi.live', 'pi.inbox', 'pi.usage'];

/** Entry kinds a viewer does not receive unless the definition says otherwise: the system prompt and tool
 *  declarations. */
export const DEFAULT_HIDDEN_ENTRIES: readonly string[] = ['pi.system'];

/** How many of a conversation's newest entries a viewer receives by default. */
export const DEFAULT_HISTORY = 200;

/** The root conversation of every storage. */
export const ROOT_CONVERSATION_ID = 1;

const DEFINITION_NAME = /^[A-Za-z0-9_.-]+$/;

export function assertDefinitionName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !DEFINITION_NAME.test(name)) {
    throw new Error(
      `[10thfloor:durable] a definition name is letters, digits, "_", "." and "-" (got ${JSON.stringify(name)})`,
    );
  }
}

/** The storage key of the app's `key` under the definition `name`. One namespace per definition. */
export function storageKey(name: string, key: string): string {
  return `${name}/${key}`;
}

/** The definition a storage key belongs to. */
export function definitionOf(storage: string): string {
  const slash = storage.indexOf('/');
  return slash === -1 ? '' : storage.slice(0, slash);
}

/** A row's indexed copy of a kind or request ID: JSON text, so no string is lost to BSON. */
export function indexed(value: string): string {
  return JSON.stringify(value);
}
