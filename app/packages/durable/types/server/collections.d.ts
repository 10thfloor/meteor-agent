import { Mongo } from 'meteor/mongo';
/** One row per conversation of every storage: its fork parent and owner. */
export declare const DurableConversations: Mongo.Collection<any, any>;
/** One row per transcript entry. `r` is the entry record as JSON text. */
export declare const DurableEntries: Mongo.Collection<any, any>;
/** Bases and deltas of documents. The rows marked `cur` are their present values. */
export declare const DurableRevisions: Mongo.Collection<any, any>;
/** Blanket deny, so Meteor's `insecure` package can never grant a client write access to a transcript. */
export declare function denyAllClientWrites(): void;
//# sourceMappingURL=collections.d.ts.map