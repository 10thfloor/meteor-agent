import type { Mongo } from 'meteor/mongo';
import type {
  AgentDelta, AgentMessage, AgentSession, SessionInc,
} from './types';

/**
 * A typed data-access facade over the three collections.
 *
 * `@types/meteor` types a collection's selector as a loose `Mongo.Selector<T>`
 * and its modifier as an even looser bag — so `{ $set: { phasee: 'x' } }` (a
 * typo for `phase`) type-checks as a plain object and silently disables the
 * write, and every dotted-path selector (`'lease.serverId'`) needs an `as any`
 * to satisfy the driver at all. This module replaces both: the collections are
 * re-exported (in `collections.ts`) as `TypedCollection`s whose `find` /
 * `findOne(Async)` / `updateAsync` / `removeAsync` take these per-collection
 * `Selector`/`Modifier` types, so a field-name typo is a COMPILE error and no
 * call site needs a cast.
 *
 * How typos are still caught while dotted paths are still allowed: a query is a
 * mapped type over `keyof T` (every own field, value-checked) INTERSECTED with
 * pattern template-literal index signatures for the nested paths a query may
 * name (`` `lease.${string}` ``). A top-level typo matches neither the mapped
 * keys nor any pattern, so excess-property checking rejects it; `'lease.until'`
 * matches the pattern and is allowed. There is deliberately NO broad
 * `[k: string]` index signature — that would re-open the very hole this closes.
 *
 * The residual `as unknown as TypedCollection<…>` lives once per collection in
 * `collections.ts` and nowhere else. `insertAsync` is left as Meteor types it:
 * the collection is already `Mongo.Collection<T>`, so an insert doc is checked
 * against `T` directly (a bad `role`/`kind` literal is an excess-property or
 * union error) and never needed a cast.
 */

/** The Mongo field-level operators the package's selectors actually use. Add
 *  one here when a query needs it; the point is a closed set, not `any`. */
export interface FieldExpr<V> {
  $eq?: V;
  $ne?: V;
  $in?: readonly V[];
  $nin?: readonly V[];
  $gt?: V;
  $gte?: V;
  $lt?: V;
  $lte?: V;
  $exists?: boolean;
  /** Array-field membership queries (the participants roster). The element
   *  shape is not re-checked here — an `$elemMatch` value is a sub-selector
   *  over the element type, and the two call sites keep it honest. */
  $elemMatch?: Record<string, unknown>;
}

/** A field position in a selector: an exact value, `null` (Mongo matches a
 *  missing or null field), or an operator expression. */
export type Cond<V> = V | null | FieldExpr<V>;

/** Every own field of T as an optional condition — the value-checked core of a
 *  query, and what makes a top-level field typo a compile error. Exported for
 *  the channel collections (`server/channels/collections.ts`), which build
 *  their own facade types from the same core. */
export type Fields<T> = { [K in keyof T]?: Cond<T[K]> };

// ---- AgentSessions ---------------------------------------------------------

/**
 * A selector over a session. The mapped `Fields<AgentSession>` checks every
 * top-level field; the template-literal signatures permit the exact nested
 * paths the package queries (`'lease.serverId'`, `'lease.until'`,
 * `'parent.sessionId'`, `'pending.verdict'`, …) with an unchecked value — a
 * selector value is not the typo hazard a modifier value is. `$or`/`$and`/`$nor`
 * nest sub-selectors of the same shape.
 */
export type SessionQuery =
  & Fields<AgentSession>
  & { [k: `lease.${string}`]:unknown }
  & { [k: `pending.${string}`]:unknown }
  & { [k: `parent.${string}`]:unknown }
  & { [k: `activeChild.${string}`]:unknown }
  & { [k: `forkedFrom.${string}`]:unknown }
  & { [k: `usage.${string}`]:unknown }
  & { [k: `budgetSpent.${string}`]:unknown }
  & { [k: `channel.${string}`]:unknown }
  & { [k: `participants.${string}`]:unknown }
  & { [k: `pendingRelay.${string}`]:unknown }
  & {
    $or?: SessionQuery[];
    $and?: SessionQuery[];
    $nor?: SessionQuery[];
  };

/** A session selector: a plain `_id` string, or a query object. */
export type SessionSelector = string | SessionQuery;

/**
 * A `$set` payload for a session. Own fields are VALUE-checked (so
 * `phase: 'streamingg'` is rejected as much as `phasee: …` is); the nested
 * paths carry an unchecked value, except the numeric counters, which are
 * numbers. This is the `$set` twin of `SessionInc` — together they turn the
 * whole "`$set`/`$inc` mistyped field silently disables a write" class into a
 * compile error.
 */
export type SessionSet =
  & { [K in keyof AgentSession]?: AgentSession[K] }
  & { [k: `lease.${string}`]:unknown }
  & { [k: `pending.${string}`]:unknown }
  & { [k: `channel.${string}`]:unknown }
  & { [k: `usage.${string}`]:number }
  & { [k: `budgetSpent.${string}`]:number };

/** A `$unset` payload for a session: a known field (or nested path) set to the
 *  conventional `1`/`true`. A typo'd field name is rejected. */
type SessionUnset =
  & { [K in keyof AgentSession]?: 1 | true }
  & { [k: `lease.${string}`]:1 | true }
  & { [k: `pending.${string}`]:1 | true };

/** A session modifier: `$set`/`$unset` over known fields plus the counter-only
 *  `$inc` (`SessionInc`) and the roster's one `$push`. Every field name is
 *  checked. */
export interface SessionModifier {
  $set?: SessionSet;
  $unset?: SessionUnset;
  $inc?: SessionInc;
  /** The roster join (participants spec §4.1) — the only array push the
   *  package performs, guarded per id at its two call sites. */
  $push?: { participants?: import('./types').SessionParticipant };
  /** The roster leave — the mirror of `$push`. */
  $pull?: { participants?: { id: string } };
}

// ---- AgentMessages ---------------------------------------------------------

/** A selector over a message. Messages carry no nested query paths in the
 *  package, so this is `Fields<AgentMessage>` (operators included via `Cond`)
 *  plus the logical combinators. */
export type MessageQuery =
  & Fields<AgentMessage>
  & {
    $or?: MessageQuery[];
    $and?: MessageQuery[];
    $nor?: MessageQuery[];
  };

/** A message selector: a plain `_id` string, or a query object. */
export type MessageSelector = string | MessageQuery;

/** Messages are insert/find/remove only — no update path exists. Typed for
 *  interface completeness; a `$set` here would be a bug to surface, not to run. */
export interface MessageModifier {
  $set?: { [K in keyof AgentMessage]?: AgentMessage[K] };
  $unset?: { [K in keyof AgentMessage]?: 1 | true };
}

// ---- AgentDeltas -----------------------------------------------------------

/** A selector over a delta. */
export type DeltaQuery =
  & Fields<AgentDelta>
  & {
    $or?: DeltaQuery[];
    $and?: DeltaQuery[];
    $nor?: DeltaQuery[];
  };

/** A delta selector: a plain `_id` string, or a query object. */
export type DeltaSelector = string | DeltaQuery;

/** Deltas are insert/find/remove only. Typed for interface completeness. */
export interface DeltaModifier {
  $set?: { [K in keyof AgentDelta]?: AgentDelta[K] };
  $unset?: { [K in keyof AgentDelta]?: 1 | true };
}

// ---- The facade ------------------------------------------------------------

/** The subset of find/update options the package passes. Kept minimal on
 *  purpose — options were never the typo hazard and were never cast. */
export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  fields?: Record<string, 0 | 1>;
  projection?: Record<string, 0 | 1>;
  limit?: number;
  skip?: number;
}

export interface UpdateOptions {
  multi?: boolean;
  upsert?: boolean;
}

/**
 * A `Mongo.Collection<T>` with its selector/modifier-taking methods narrowed to
 * the collection's own `Sel`/`Mod` types. Everything else on the collection —
 * `insertAsync`, `rawCollection`, the cursor returned by `find`, its
 * `fetchAsync`/`observeChangesAsync`/`countAsync`/`mapAsync` — is inherited
 * from `Mongo.Collection<T>` unchanged, so only the selector surface changes.
 */
export interface TypedCollection<T extends { _id: string }, Sel, Mod>
  extends Omit<Mongo.Collection<T>, 'find' | 'findOne' | 'findOneAsync' | 'updateAsync' | 'removeAsync'> {
  find(selector?: Sel, options?: FindOptions): Mongo.Cursor<T>;
  findOne(selector?: Sel, options?: FindOptions): T | undefined;
  findOneAsync(selector?: Sel, options?: FindOptions): Promise<T | undefined>;
  updateAsync(selector: Sel, modifier: Mod, options?: UpdateOptions): Promise<number>;
  removeAsync(selector: Sel): Promise<number>;
}

export type SessionsCollection = TypedCollection<AgentSession, SessionSelector, SessionModifier>;
export type MessagesCollection = TypedCollection<AgentMessage, MessageSelector, MessageModifier>;
export type DeltasCollection = TypedCollection<AgentDelta, DeltaSelector, DeltaModifier>;
