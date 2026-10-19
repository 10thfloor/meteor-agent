import type { Operation } from "./host";
/** A conversation's agent choices as they are stored: extensions and tools by name. */
export type AgentChoices = {
    model?: {
        provider: string;
        modelId: string;
    } | null;
    thinkingLevel?: string | null;
    /** An array selects exactly these extensions; an object edits the host's default selection. */
    extensions?: string[] | {
        add?: string[];
        remove?: string[];
    } | null;
    /** An array offers exactly these tools; `{ remove }` drops some. */
    tools?: string[] | {
        remove: string[];
    } | null;
    instructions?: string | null;
    cwd?: string | null;
};
/** No conversation with that ID in the storage. */
export declare class ConversationNotFound extends Error {
    constructor(key: string, id: unknown);
}
export declare const OPERATIONS: Readonly<Record<string, Operation>>;
//# sourceMappingURL=operations.d.ts.map