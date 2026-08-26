/**
 * Something a message can name with `@`.
 *
 * The package resolves the session's own MODEL participants into this shape for
 * free, because those are the handles that actually address a turn
 * (`resolveAddressee` in common/participants.ts parses exactly one leading
 * `@name` against them). An app adds its OWN subjects — a customer, a ticket, an
 * account — through the `mentionables` property, and those are deliberately
 * inert: they render and they autocomplete, but naming one schedules nothing,
 * because the package will not invent a routing rule for a noun it cannot see.
 *
 * `handle` is what follows the `@`, and it may not contain whitespace. Anything
 * that does not match a known handle stays plain text, which is the same rule
 * the addressee parse uses: an unmatched `@name` is speech, not markup.
 */
export interface Mentionable {
    handle: string;
    /** Shown in the chip and the typeahead. Defaults to `handle`. */
    label?: string;
    /** Free-form; becomes a `part` token, so `::part(mention ticket)` works. */
    kind?: string;
    /** A second line in the typeahead — an address, a role, a price, a date. */
    detail?: string;
}
/** A field name on the record, or a function derived from it. A function is
 *  what a stored column cannot express: a handle slugged from a display name,
 *  a label joined from two columns. */
type Field<T> = string | ((record: never) => T | undefined);
/** The shape this element needs from a live collection: a reactive `find` it
 *  can `fetch`. Structural on purpose — the package neither imports Mongo nor
 *  requires that the thing on the other side IS Mongo. */
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
/**
 * Where the things one symbol names come from.
 *
 * Three forms, because the shapes an app actually has are not all the same:
 * a live collection whose contents change under the user, a plain list that is
 * computed or static, or — when neither fits — the two functions the element
 * really needs. The first two are conveniences over the third.
 *
 * A collection is read inside the element's own `Tracker.autorun`, so chips
 * repaint when the underlying data changes with nothing to wire up.
 */
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
/**
 * Register `<agent-chat>` (or any tag name you prefer) and return its
 * constructor.
 *
 * Idempotent PER TAG: calling it twice with the same name is a no-op that
 * returns whatever is already registered — including, if the app registered
 * something else under that name first, that other element; the platform gives
 * no way to check provenance, and throwing would be worse than yielding.
 * Calling it with a DIFFERENT name registers again, from a fresh class:
 * `customElements.define` refuses to reuse one constructor for two names, so
 * the class is built per call rather than hoisted to module scope.
 */
export declare function defineAgentChat(tagName?: string): CustomElementConstructor;
export {};
//# sourceMappingURL=element.d.ts.map