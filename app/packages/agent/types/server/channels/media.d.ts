import { type ChannelAttachment, type InboundAttachment } from '../../common/channel-contract';
import type { ChannelDef } from './registry';
/** TEST SEAM, the `_setBackoff` shape: the fetcher's I/O, injectable so the
 *  whole resolution path runs network-free. Pass null to restore. */
export declare function _setMediaFetch(fn: typeof fetch | null): () => void;
export interface ResolvedInbound {
    /** Inline files passed through plus remote files fetched — what admission
     *  stores, in the event's order. */
    files: ChannelAttachment[];
    /** One bracket line per file that could not be resolved — joined into the
     *  message text beside admission's own notes. */
    notes: string[];
}
/**
 * Resolve an event's attachments — inline ones pass through untouched; remote
 * ones fetch under the def's recipe. Fetching stops once `maxFiles` files are
 * in hand (admission would drop the rest anyway — no reason to download what
 * cannot be kept); the un-fetched remainder gets admission's own over-count
 * note phrasing, so the transcript reads one way however the file was lost.
 *
 * A channel whose lens emits remote attachments but whose def carries no
 * `media` recipe notes every file as unretrievable — a miswiring made visible
 * in the transcript rather than a silent drop.
 */
export declare function resolveInboundAttachments(incoming: InboundAttachment[], media: ChannelDef['media'], caps?: {
    maxFileBytes?: number;
    maxFiles?: number;
}, opts?: {
    timeoutMs?: number;
}): Promise<ResolvedInbound>;
//# sourceMappingURL=media.d.ts.map