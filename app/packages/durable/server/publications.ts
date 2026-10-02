import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DEFAULT_HISTORY, indexed, NAMES } from '../common/names';
import { DurableConversations, DurableEntries, DurableRevisions } from './collections';
import { CHORD, definitionNamed } from './durable';
import { loadPackage } from './loader';

// A conversation, to anyone the definition lets watch it.
//
// Pi Durable shows a conversation to clients attached to the process that
// owns its storage. Here the storage is Mongo, so this publication is three
// ordinary cursors over its rows and never touches a harness: it works on
// every server instance, whichever one hosts the storage, and keeps working
// while the storage changes hands.
//
// What a viewer gets:
// - the conversation's own row and its fork ancestors' rows;
// - the entries visible to it, through those ancestors, from a starting point
//   that holds its newest `history` entries;
// - the rows that make up the present value of its documents: the newest base
//   of each and the deltas after it. A streamed answer arrives as delta rows
//   of `pi.live`, each a few Chord operations.

/** How often a live subscription's right to watch is asked again. */
let RECHECK_MS = 30_000;

/** Test seam: shorten the re-check. Returns the previous value. */
export function _setViewRecheckMs(ms: number): number {
  const previous = RECHECK_MS;
  RECHECK_MS = ms;
  return previous;
}

const MAX_HISTORY = 5000;

export function registerPublications(): void {
  Meteor.publish(NAMES.pubConversation, async function (params: {
    host: string; key: string; conversationId: number; history?: number;
  }) {
    check(params, {
      host: String,
      key: String,
      conversationId: Match.Integer,
      history: Match.Maybe(Match.Integer),
    });
    const { key, conversationId } = params;
    const userId = this.userId ?? null;
    const definition = definitionNamed(params.host);
    // An unknown definition and a refused viewer look the same: nothing, and ready.
    if (definition === undefined || !(await definition.allows(userId, 'view', { key, conversationId }))) return [];

    const context = (await loadPackage(CHORD, 'context') as any).BACKGROUND_CONTEXT;
    const storage = definition.storage(key);
    const reader = await definition.reader(key);

    // The fork ancestry, nearest first. Conversation records never change, so it is read once. Each ancestor
    // contributes its entries up to the point where the next conversation down forked from it.
    const chain: { id: number; upTo?: number }[] = [];
    let upTo: number | undefined;
    for (let id: number | undefined = conversationId; id !== undefined;) {
      const record: any = await reader.conversation(id as never, context);
      if (record === undefined) break;
      chain.push(upTo === undefined ? { id } : { id, upTo });
      if (record.parent === undefined) break;
      upTo = upTo === undefined ? record.parent.at : Math.min(upTo, record.parent.at);
      id = record.parent.conversationId;
    }
    // Not created yet, or erased. A client subscribes again once it has made the conversation.
    if (chain.length === 0) return [];

    // A lower bound, not a limit: Meteor's change-stream observer cannot serve a cursor with a limit, and a
    // conversation only grows upward from here.
    const history = Math.min(Math.max(params.history ?? DEFAULT_HISTORY, 1), MAX_HISTORY);
    const newest = await reader.scanEntries({ conversationId: conversationId as never }, history, undefined, context);
    const from = newest.next === undefined ? 0 : newest.items[newest.items.length - 1]!.id;

    // The right to watch is the definition's to take back. Ask again while the subscription lives.
    if (RECHECK_MS > 0 && typeof this.onStop === 'function') {
      const timer = Meteor.setInterval(async () => {
        try {
          if (!(await definition.allows(userId, 'view', { key, conversationId }))) this.stop();
        } catch {
          // A rule that cannot be evaluated does not leave a transcript streaming.
          this.stop();
        }
      }, RECHECK_MS);
      this.onStop(() => Meteor.clearInterval(timer));
    }

    return [
      DurableConversations.find(
        { _id: { $in: chain.map(({ id }) => `${storage}:${id}`) } },
        { fields: { s: 1, id: 1, r: 1 } },
      ),
      DurableEntries.find(
        {
          s: storage,
          $or: chain.map((link) => ({
            c: link.id,
            id: { $gte: from, ...(link.upTo === undefined ? {} : { $lte: link.upTo }) },
          })),
          ...(definition.hiddenEntries.length === 0 ? {} : { k: { $nin: definition.hiddenEntries.map(indexed) } }),
        },
        { fields: { s: 1, id: 1, c: 1, k: 1, h: 1, r: 1 } },
      ),
      DurableRevisions.find(
        { s: storage, sk: 'conversation', o: conversationId, cur: true, k: { $in: definition.documents.map(indexed) } },
        { fields: { s: 1, o: 1, d: 1, q: 1, t: 1, k: 1, kv: 1, c: 1 } },
      ),
    ];
  });
}
