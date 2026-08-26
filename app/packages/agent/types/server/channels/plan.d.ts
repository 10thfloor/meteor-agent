import type { AgentMessage, AgentSession } from '../../common/types';
import { type ChannelProfile, type DeliveryItem } from '../../common/channel-contract';
export interface PlanOptions {
    /** Which note kinds to deliver as `status` items. */
    statuses?: ReadonlyArray<NonNullable<AgentMessage['kind']>>;
    profile: ChannelProfile;
    /** Session web URL for overflow links (§8.5). Absent = no link. */
    overflowUrl?: string;
}
/** One planned row: the message and its delivery item, or null (advance past). */
export interface PlannedRow {
    message: AgentMessage;
    item: DeliveryItem | null;
}
/** Plan the tail of a transcript for one surface. */
export declare function planItems(messages: AgentMessage[], opts: PlanOptions): PlannedRow[];
/** Build the `prompt` item from a parked approval. Menu choices get
 *  match words here; link choices get URLs at delivery time (I/O). */
export declare function promptItem(session: AgentSession, profile: ChannelProfile): Extract<DeliveryItem, {
    item: 'prompt';
}> | null;
//# sourceMappingURL=plan.d.ts.map