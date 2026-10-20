import { Agent } from './agent';
export type ComposerMode = 'ask' | 'note';
export interface ComposerSubmission {
    sessionId: string;
    text: string;
    mode: ComposerMode;
    /** Explicit model participant selected by the host. Crew notes omit it. */
    recipient?: string;
}
/** Optional application-owned write boundary. Throw to preserve the draft. */
export type ComposerSubmissionHandler = (submission: ComposerSubmission) => Promise<unknown>;
export interface ComposerDraftOptions {
    selectionStart?: number;
    selectionEnd?: number;
    focus?: boolean;
}
export interface ChatTimelineItem {
    id: string;
    createdAt: Date | number;
    afterMessageId?: string;
    element: HTMLElement;
}
/** Public property/method surface for typed app-owned custom elements. */
export interface AgentChatElement extends HTMLElement {
    readonly sessionId: string | null;
    readonly agentInstance: Agent | null;
    composerMode: ComposerMode;
    /** Model participant ID for asks. Undefined preserves leading-@/primary routing. */
    recipient: string | undefined;
    submissionHandler: ComposerSubmissionHandler | null;
    allowEmptySubmit: boolean;
    draftText: string;
    mentionSources: Record<string, MentionSource>;
    timelineItems: ChatTimelineItem[];
    /** Show "Reply in thread" on user and assistant rows. */
    threadable: boolean;
    /** Paint only rows with `seq >= fromSeq`; `null` paints every row. */
    fromSeq: number | null;
    setDraft(text: string, options?: ComposerDraftOptions): void;
    focusComposer(): void;
    submitDraft(): Promise<void>;
    insertMention(prefix: string, handle: string): boolean;
    openMentions(prefix: string): boolean;
    /** Reveal an already rendered, visible message without changing the session. */
    revealMessage(messageId: string): boolean;
}
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
    /** Non-@ references can open an app-owned detail view without sending. */
    actionable?: boolean;
    /** Any CSS colour. Set as `--mention-color` on the chip and the typeahead
     *  row; model participants take theirs from `agentColors`. */
    color?: string;
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
    actionable?: boolean;
    /** Visible feedback while a source is loading or has no matching entries. */
    emptyText?: string;
    /** What follows the symbol. Required — nothing else identifies the record. */
    handle: Field<string>;
    /** Defaults to the handle. */
    label?: Field<string>;
    detail?: Field<string>;
    color?: Field<string>;
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
    actionable?: boolean;
    emptyText?: string;
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