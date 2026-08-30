export type ComposerMode = 'ask' | 'note';
/** Something a message can name with `@`. Model participants are resolved
 *  automatically; app-specific subjects (via `mentionables`) autocomplete
 *  and render but schedule nothing. */
export interface Mentionable {
    handle: string;
    /** Shown in the chip and the typeahead. Defaults to `handle`. */
    label?: string;
    /** Free-form; becomes a `part` token, so `::part(mention ticket)` works. */
    kind?: string;
    /** A second line in the typeahead — an address, a role, a price, a date. */
    detail?: string;
}
/** A field name or a function derived from the record. */
type Field<T> = string | ((record: never) => T | undefined);
/** Structural — any object with a reactive `find().fetch()`. */
export interface MentionCollection {
    find(selector: unknown, options: unknown): {
        fetch(): unknown[];
    };
}
interface MentionShape {
    /** The `part` token every entry from this source carries. */
    kind?: string;
    /** What follows the symbol. Required — nothing else identifies the record. */
    handle: Field<string>;
    /** Defaults to the handle. */
    label?: Field<string>;
    detail?: Field<string>;
    /** How many the typeahead offers at once. Default 8. */
    limit?: number;
    /** Ceiling on records pulled from a collection in one read. Default 1000 —
     *  a guard against an unbounded publication, not a page size. */
    max?: number;
}
/** Three forms: a reactive collection, a plain list, or raw search/resolve
 *  functions. Collection reads run inside the element's Tracker.autorun. */
export type MentionSource = (MentionShape & {
    collection: MentionCollection;
    list?: never;
}) | (MentionShape & {
    list: unknown[] | (() => unknown[]);
    collection?: never;
}) | {
    kind?: string;
    /** Everything matching what has been typed so far. `''` means "the symbol
     *  was just typed" — answer with a sensible opening set, not everything. */
    search(query: string): Mentionable[];
    /** One exact handle, for rendering a chip in text already written. Omit it
     *  and `search(handle)` is used, which is correct but does more work. */
    lookup?(handle: string): Mentionable | null | undefined;
};
/** True only when the whole assistant message is a machine-shaped payload.
 * Prose that happens to contain braces remains prose. An explicit JSON/JSONC
 * fence is machine-shaped even if the provider emitted malformed JSON inside. */
export declare function isStructuredAssistantContent(value: string): boolean;
/** Clean-mode assistant prose transform. It decodes embedded JSON string
 * serialization (including a truncated final string), removes embedded raw
 * object/array records, and deliberately leaves ordinary quotes/placeholders
 * alone. Debug rendering never calls this helper. */
export declare function sanitizeCleanAssistantContent(value: string, streaming?: boolean): string;
/** Register `<agent-chat>` (or a custom tag) and return its constructor.
 *  Idempotent per tag; a different name registers a fresh class. */
export declare function defineAgentChat(tagName?: string): CustomElementConstructor;
export {};
//# sourceMappingURL=element.d.ts.map