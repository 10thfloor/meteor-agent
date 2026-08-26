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
    /** Free-form; becomes a `part` token, so `::part(mention guest)` works. */
    kind?: string;
    /** A second line in the typeahead — an email, a role, a last-seen date. */
    detail?: string;
    /**
     * The symbol that summons it. Defaults to `@`.
     *
     * A second symbol is worth having when the things being named are of a
     * different ORDER, not merely a different type: `@` reaches people (and, for
     * model participants, actually routes the turn), while something like `#`
     * points at an item in a catalogue that could never take a turn. One symbol
     * for both makes the composer offer a product where a person belongs.
     *
     * Only `@` is ever parsed as an addressee — see `resolveAddressee` — so a
     * mentionable under any other symbol is inert by construction, whatever kind
     * it claims.
     */
    prefix?: string;
}
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
//# sourceMappingURL=element.d.ts.map