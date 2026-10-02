import { Mongo } from 'meteor/mongo';
/** Conversation rows: `r` is the record (`id`, fork `parent`, `owner`) as JSON text. */
export declare const DurableConversations: Mongo.Collection<any, any>;
/** Entry rows: `r` is the entry record as JSON text; `id`, `c` (conversation) and `k` (kind, JSON) beside it. */
export declare const DurableEntries: Mongo.Collection<any, any>;
/** The rows of each document's present value: `t` is `base` or `delta`, `c` the value or the operations. */
export declare const DurableRevisions: Mongo.Collection<any, any>;
//# sourceMappingURL=collections.d.ts.map