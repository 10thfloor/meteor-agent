import { Mongo } from 'meteor/mongo';
import { NAMES } from '../common/names';

// Minimongo caches of what `durable.conversation` publishes: rows of the
// storage, as stored. `DurableConversation` turns them into records and
// document values; read these directly only for a view across conversations.

/** Conversation rows: `r` is the record (`id`, fork `parent`, `owner`) as JSON text. */
export const DurableConversations = new Mongo.Collection<any>(NAMES.conversations);
/** Entry rows: `r` is the entry record as JSON text; `id`, `c` (conversation) and `k` (kind, JSON) beside it. */
export const DurableEntries = new Mongo.Collection<any>(NAMES.entries);
/** The rows of each document's present value: `t` is `base` or `delta`, `c` the value or the operations. */
export const DurableRevisions = new Mongo.Collection<any>(NAMES.revisions);
