import { type ChannelAttachment, type InboundAttachment } from '../../common/channel-contract';
import type { ChannelDef } from './registry';
/** Test seam: inject a fetch replacement. Pass null to restore. */
export declare function _setMediaFetch(fn: typeof fetch | null): () => void;
export interface ResolvedInbound {
    files: ChannelAttachment[];
    notes: string[];
}
/** Resolve an event's attachments: inline pass through, remote fetch
 *  under the def's recipe. Stops at maxFiles; no media recipe → noted. */
export declare function resolveInboundAttachments(incoming: InboundAttachment[], media: ChannelDef['media'], caps?: {
    maxFileBytes?: number;
    maxFiles?: number;
}, opts?: {
    timeoutMs?: number;
}): Promise<ResolvedInbound>;
//# sourceMappingURL=media.d.ts.map