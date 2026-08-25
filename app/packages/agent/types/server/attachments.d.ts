import { prettySize } from '../common/format';
import type { Fields, TypedCollection } from '../common/db';
import type { AgentMessage, AttachmentRef } from '../common/types';
import type { ChannelAttachment } from '../common/channel-contract';
import type { InlineTool } from './tools';
/**
 * The attachment store (email v2 spec §5): file BYTES in one side collection,
 * REFS on message rows. Transcript rows are read constantly — by the loop, the
 * publication, the planner's tail scan — and a 5 MB base64 string on a row
 * would ride every one of those reads; here it is read exactly twice, once at
 * admission/creation and once at delivery (or through `read_attachment`).
 *
 * Bytes are base64 STRINGS end to end: providers emit and demand base64, the
 * channel contract stays isomorphic, and one Mongo document holds a 6.7 MB
 * string without ceremony (16 MB ceiling). The store is a seam — swapping it
 * for GridFS or S3 later changes `createAttachment`/`hydrateRefs`, not the
 * contract.
 *
 * SERVER-ONLY, like the channel collections: no client ever subscribes to
 * bytes, and the blanket client-write deny in server/index.ts covers it. No
 * download route exists either — bytes leave the store only inside an outbound
 * payload to a destination the binding or a recipients policy chose (§12).
 */
export interface AgentAttachment {
    /** Random for inbound files; DERIVED (`session + toolCallId + name`) for
     *  tool-created rows, so a crash-recovery re-run collides and adopts. */
    _id: string;
    /** The scope — every read and every hydration checks it. A ref is a
     *  capability only inside its own conversation. */
    sessionId: string;
    /** A display string, never a path (§12): control characters stripped,
     *  length-capped at write. The store is a collection, not a filesystem, so
     *  `../` has nothing to traverse — the sanitizing is about log/UI hygiene. */
    name: string;
    contentType: string;
    /** DECODED byte count — computed from the actual bytes at write time, never
     *  trusted from a provider's declared length. */
    size: number;
    /** The bytes, base64. Checked at the door: decode-validity is verified so
     *  garbage cannot occupy the store under a small declared size. */
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
/**
 * Write-time caps, per MESSAGE (email v2 spec §5). Defaults chosen under
 * Postmark's outbound ceiling — 10 MB total per send INCLUDING base64, which
 * inflates 4/3: one 5 MB file is ~6.7 MB encoded, and a full 6 MB message is
 * ~8 MB encoded plus bodies, both clear of the wire cap with headroom. Inbound,
 * Postmark itself allows 35 MB cumulative — we accept less, on purpose.
 */
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
/** Display-string discipline (§12): control characters stripped, length-capped,
 *  never empty. Names land in transcripts, logs, admission notes and provider
 *  payloads — all places a raw header value has no business steering. */
export declare function sanitizeAttachmentName(raw: string): string;
/** Base64 checked at the door (§12): shape first (Node's decoder silently
 *  skips invalid characters, so a regex does the refusing), then the DECODED
 *  size — the number every cap and every size line uses. Null = not base64. */
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
    /**
     * Idempotency. With it, the `_id` DERIVES from session + toolCallId + name:
     * tool dispatch re-runs on crash recovery (the dispatch comment calls that
     * window irreducible), and a re-run's `create` collides on the derived key
     * and ADOPTS the existing row instead of duplicating it — re-staging it when
     * `attach` asks, so the recovered turn's reply still carries the file.
     */
    toolCallId?: string;
    /** Override the default write caps — admission callers pass the channel's. */
    caps?: AttachmentCaps;
}
/**
 * Insert one file into the store and return its REF. The API for tool bodies
 * (`Agent.attachments.create`) and for inbound admission — never a model
 * surface: the model handles refs and prose only; content exists because
 * trusted code wrote it.
 *
 * Enforces the per-file cap always, and — when staging — the per-message
 * count and total caps against the session's currently staged set. Refusals
 * are `Meteor.Error`s a tool body can let propagate: the dispatch layer turns
 * them into a structured failed result the model routes around.
 */
export declare function createAttachment(opts: CreateAttachmentOptions): Promise<AttachmentRef>;
/**
 * Claim every staged ref of a session — one atomic unstage per row, the
 * single-winner shape: of two racing claimants each row goes to exactly one.
 * Called by the loop when it commits the turn-final assistant row; the claimed
 * refs become that row's `attachments`. A crash between claim and commit
 * strands the rows unstaged and undelivered — the files survive in the store,
 * and the re-run turn's `create` re-stages them idempotently (above).
 */
export declare function claimStagedRefs(sessionId: string): Promise<AttachmentRef[]>;
/**
 * Refs → hydrated `ChannelAttachment[]`, session-checked. Runs only on
 * `deliverOnce`'s POST path (a settled receipt or a backoff window loads
 * nothing). A ref that no longer hydrates — pruned by the retention TTL — is
 * returned in `missing` so the caller can note it in the text: the courier
 * never claims to have delivered a file it didn't, and never wedges the
 * conversation over one.
 */
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
/**
 * Apply the caps in order — count, then per-file, then running total — keep
 * what passes, and say what was dropped. Sizes are recomputed from the actual
 * base64 (a declared length is advisory); content that does not decode is
 * dropped with its own note rather than occupying the store as garbage.
 */
export declare function admitInboundAttachments(sessionId: string, incoming: ChannelAttachment[], caps?: AttachmentCaps): Promise<AdmittedAttachments>;
/**
 * Attach image bytes to an ASSEMBLED provider request — the separate async
 * step the loop runs immediately before the provider call, AFTER the
 * compaction estimate (base64 in the estimator would read as megatokens and
 * wedge compaction forever) and never on the summarizer path. Correlated by
 * `toolCallId`: the read stamped image refs onto its committed `tool` row,
 * and this loads their bytes onto the matching assembled message. Rows the
 * compaction cut removed simply have no assembled twin and cost nothing;
 * refs whose bytes the retention TTL reaped hydrate to nothing and the text
 * result stands alone. Returns whether any image rode the request — the
 * strip-and-degrade retry keys on it.
 */
export declare function hydrateImageRefs(sessionId: string, rows: Array<Pick<AgentMessage, 'role' | 'toolCallId' | 'attachments' | 'kind' | 'seq' | 'upto'>>, messages: import('./providers/types').ProviderMessage[]): Promise<boolean>;
/**
 * The mechanical suffix a ref-carrying row gains in the PROVIDER REQUEST —
 * request-view only; the committed row's `content` stays exactly what was
 * written. No model call, no parsing, no summaries — the same "mechanical,
 * derived at delivery time" rule the planner lives by.
 */
export declare function attachmentSuffix(refs: AttachmentRef[]): string;
/** The most text `read_attachment` returns in one call. */
export declare const READ_TEXT_CAP: number;
/** The provider-bound ceiling on ONE attached image, decoded — matches the
 *  strictest common per-image limit (Anthropic's 5 MB). Store caps usually
 *  bound this already; the check is for deployments that raised them, and
 *  pixel-dimension caps a byte gate cannot see are handled by the loop's
 *  strip-and-degrade retry. */
export declare const READ_IMAGE_CAP: number;
/**
 * The one tool the core ships for attachments — a SPEC the app lists in
 * `tools` like any inline spec (nothing auto-registers, §7's idiom):
 *
 *   tools: [Agent.attachments.readTool, …]
 *
 * Scope: the row must match `ctx.sessionId` — a ref from another session
 * reads as not-found; the id is a capability only inside its own conversation.
 * Text-like content returns as UTF-8, capped. An IMAGE, when the running
 * model's provider declared vision (participants spec §9), is ATTACHED: the
 * ref stamps this call's tool row through the collector, and request-time
 * hydration carries the bytes — the one way an image ever enters context,
 * by the model's own choice. Otherwise binary returns a structured refusal
 * the model can route around, with the reason.
 */
export declare const readTool: InlineTool;
//# sourceMappingURL=attachments.d.ts.map