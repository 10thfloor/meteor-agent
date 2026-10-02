/** Collection name prefix of everything this package stores. */
export declare const PREFIX = "pi_durable_";
export declare const NAMES: {
    readonly conversations: "pi_durable_conversations";
    readonly entries: "pi_durable_entries";
    readonly revisions: "pi_durable_revisions";
    readonly pubConversation: 'durable.conversation';
    readonly mRoot: 'durable.root';
    readonly mCreate: 'durable.create';
    readonly mFork: 'durable.fork';
    readonly mSubmit: 'durable.submit';
    readonly mAbort: 'durable.abort';
    readonly mWithdraw: 'durable.withdraw';
    readonly mReset: 'durable.reset';
    readonly mCompact: 'durable.compact';
};
/** Document kinds a viewer receives unless the definition says otherwise. `pi.agent` holds a conversation's
 *  instructions and is left out. */
export declare const DEFAULT_DOCUMENTS: readonly string[];
/** Entry kinds a viewer does not receive unless the definition says otherwise: the system prompt and tool
 *  declarations. */
export declare const DEFAULT_HIDDEN_ENTRIES: readonly string[];
/** How many of a conversation's newest entries a viewer receives by default. */
export declare const DEFAULT_HISTORY = 200;
/** The root conversation of every storage. */
export declare const ROOT_CONVERSATION_ID = 1;
export declare function assertDefinitionName(name: unknown): asserts name is string;
/** The storage key of the app's `key` under the definition `name`. One namespace per definition. */
export declare function storageKey(name: string, key: string): string;
/** The definition a storage key belongs to. */
export declare function definitionOf(storage: string): string;
/** A row's indexed copy of a kind or request ID: JSON text, so no string is lost to BSON. */
export declare function indexed(value: string): string;
//# sourceMappingURL=names.d.ts.map