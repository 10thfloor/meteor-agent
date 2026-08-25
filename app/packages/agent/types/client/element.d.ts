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