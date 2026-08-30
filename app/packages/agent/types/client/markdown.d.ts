/**
 * Safe assistant Markdown.
 *
 * Marked is used only as a lexer. Its HTML renderer is never called. We walk
 * the token tree into a small, allowlisted DOM and write every content leaf as
 * a Text node, so raw HTML and malformed streaming output stay inert.
 */
type TextNodes = (value: string) => Node[];
export type MarkdownRenderOptions = {
    /** Allows the chat element to retain its existing mention-chip renderer. */
    textNodes?: TextNodes;
};
/** Render the supported GFM/CommonMark token set into an inert DOM subtree. */
export declare function renderAssistantMarkdown(value: string, options?: MarkdownRenderOptions): HTMLElement;
export {};
//# sourceMappingURL=markdown.d.ts.map