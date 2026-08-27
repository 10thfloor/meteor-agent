import { prettySize } from '../common/format';
import type { Fields, TypedCollection } from '../common/db';
import type { AgentMessage, AttachmentRef } from '../common/types';
import type { ChannelAttachment } from '../common/channel-contract';
import type { InlineTool } from './tools';
export interface AgentAttachment {
    /** Random for inbound; derived for tool-created (crash-recovery idempotent). */
    _id: string;
    /** Scoping key — a ref is a capability only inside its own session. */
    sessionId: string;
    /** Display string, never a path — control chars stripped, length-capped. */
    name: string;
    contentType: string;
    /** Decoded byte count, computed at write time (never trusted from provider). */
    size: number;
    /** The bytes, base64. Decode-validity verified at write time. */
    content: string;
    origin: 'inbound' | 'tool';
    /** Present only while awaiting the turn-final flush: `attach: true` marks
     *  the row staged; the loop's commit claims it (an atomic unstage per row —
     *  the single-winner shape) and embeds the ref on the assistant row. */
    staged?: true;
    createdAt: Date;
}
export type AttachmentQuery = Fields<AgentAttachment> & {
    $or?: AttachmentQuery[];
    $and?: AttachmentQuery[];
    $nor?: AttachmentQuery[];
};
export interface AttachmentModifier {
    $set?: {
        [K in keyof AgentAttachment]?: AgentAttachment[K];
    };
    $unset?: {
        [K in keyof AgentAttachment]?: 1 | true;
    };
}
export declare const AgentAttachments: TypedCollection<AgentAttachment, string | AttachmentQuery, AttachmentModifier>;
/** Write-time caps per message (§5). Defaults sit under Postmark's outbound
 *  ceiling after base64 inflation (4/3). */
export interface AttachmentCaps {
    /** Per file, decoded bytes. Default 5 MB — also keeps every Mongo document
     *  comfortably under the 16 MB ceiling. */
    maxFileBytes?: number;
    /** Per message. Default 5 — a mail, not a filesystem sync. */
    maxFiles?: number;
    /** Per message, decoded bytes, summed. Default 6 MB. */
    maxTotalBytes?: number;
}
export declare const DEFAULT_ATTACHMENT_CAPS: Required<AttachmentCaps>;
/** Control chars stripped, length-capped, never empty. */
export declare function sanitizeAttachmentName(raw: string): string;
/** Validate base64 shape (Node silently skips invalid chars) and return
 *  decoded size. Null = not valid base64. */
export declare function decodedBase64Size(content: string): number | null;
export { prettySize };
export interface CreateAttachmentOptions {
    sessionId: string;
    name: string;
    contentType: string;
    /** A UTF-8 string (encoded here), or `{ base64 }` for binary. */
    content: string | {
        base64: string;
    };
    /** Stage the file for the turn's reply: the loop claims every staged ref at
     *  the turn-final commit and embeds them on the assistant row. */
    attach?: boolean;
    /** Idempotency: derives the `_id` so a crash-recovery re-run adopts. */
    toolCallId?: string;
    /** Override the default write caps — admission callers pass the channel's. */
    caps?: AttachmentCaps;
}
/** Insert one file and return its ref. Enforces per-file cap always, and
 *  per-message count/total caps when staging. Refusals are `Meteor.Error`s.
 *  The Session must exist and not be undergoing erasure. */
export declare function createAttachment(opts: CreateAttachmentOptions): Promise<AttachmentRef>;
/** Claim staged refs for the turn-final assistant row. Single-winner per row;
 *  crash-recovery re-stages idempotently via `createAttachment`. */
export declare function claimStagedRefs(sessionId: string): Promise<AttachmentRef[]>;
/** Refs to hydrated attachments, session-checked. Missing refs (expired by
 *  retention TTL) are returned separately so the caller can note them. */
export declare function hydrateRefs(sessionId: string, refs: AttachmentRef[]): Promise<{
    attachments: ChannelAttachment[];
    missing: AttachmentRef[];
}>;
export interface AdmittedAttachments {
    /** Kept files, inserted into the store — these refs ride the user row. */
    refs: AttachmentRef[];
    /** One mechanical bracket line per REJECTED file — appended to the user
     *  row's content so the model and the web transcript both see exactly what
     *  the agent actually has. Fail closed, never silently. */
    notes: string[];
}
/** Apply caps (count, per-file, total) in order; sizes recomputed from actual
 *  base64. Returns kept refs and notes for each rejected file. */
export declare function admitInboundAttachments(sessionId: string, incoming: ChannelAttachment[], caps?: AttachmentCaps): Promise<AdmittedAttachments>;
/** Attach image bytes to assembled provider messages, correlated by toolCallId.
 *  Runs after compaction estimate, never on the summarizer path. */
export declare function hydrateImageRefs(sessionId: string, rows: Array<Pick<AgentMessage, 'role' | 'toolCallId' | 'attachments' | 'kind' | 'seq' | 'upto'>>, messages: import('./providers/types').ProviderMessage[]): Promise<boolean>;
/** Mechanical suffix for ref-carrying rows in the provider request.
 *  Request-view only; the committed row's content is unchanged. */
export declare function attachmentSuffix(refs: AttachmentRef[]): string;
/** The most text `read_attachment` returns in one call. */
export declare const READ_TEXT_CAP: number;
/** Per-image ceiling, decoded — matches the strictest provider limit (5 MB). */
export declare const READ_IMAGE_CAP: number;
/** The shipped read_attachment tool spec. Session-scoped; text returns as
 *  UTF-8, images attach via the collector, binary gets a structured refusal. */
export declare const readTool: InlineTool;
//# sourceMappingURL=attachments.d.ts.map