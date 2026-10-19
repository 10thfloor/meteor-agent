import { Mongo } from 'meteor/mongo';
import { NAMES } from '../common/names';

// The storage writes these collections through the driver, inside
// transactions. They are declared to Meteor only so a publication can hand
// their rows to a viewer. `_preventAutopublish` keeps `autopublish`, which
// every new app ships with, from pushing transcripts to every client.
const options = { _preventAutopublish: true } as any;

/** One row per conversation of every storage: its fork parent and owner. */
export const DurableConversations = new Mongo.Collection<any>(NAMES.conversations, options);
/** One row per transcript entry. `r` is the entry record as JSON text. */
export const DurableEntries = new Mongo.Collection<any>(NAMES.entries, options);
/** Bases and deltas of documents. The rows marked `cur` are their present values. */
export const DurableRevisions = new Mongo.Collection<any>(NAMES.revisions, options);

/** Blanket deny, so Meteor's `insecure` package can never grant a client write access to a transcript. */
export function denyAllClientWrites(): void {
  const deny = { insert: () => true, update: () => true, remove: () => true };
  for (const collection of [DurableConversations, DurableEntries, DurableRevisions]) {
    (collection as any).deny(deny);
  }
}
