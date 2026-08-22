import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from '../../common/collections';
import { recordVerdict } from '../methods';
import {
  ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
  insertOrLose, type ChannelIdentity, type ChannelLinkToken, type ChannelVerdictToken,
} from './collections';

/**
 * Account linking (channels spec §12). An external user ID is IDENTIFICATION,
 * not authentication — turning it into an app account requires proof, and the
 * proof always completes from the AUTHENTICATED side: an unauthenticated
 * inbound message can request a link; it can never assert one.
 *
 * Two proofs, two assurance levels:
 *   `oidc` — the app ran a full OAuth round-trip (Sign in with Slack and kin)
 *            and calls `linkIdentity` directly with what it proved.
 *   `link` — a one-time token: `issueLinkToken` mints it (the channel sends it
 *            to the external identity), the signed-in web user presents it,
 *            `redeemLinkToken` burns it atomically and links.
 *
 * What is deliberately NOT here, because each is an account-takeover
 * primitive: auto-linking on a matching email address, trusting a phone number
 * for anything privileged, or trusting the external ID by itself.
 */

const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

/** The identity row for one external sender, or null — null means UNLINKED,
 *  which is a legal state (an anonymous capability-owned session), never an
 *  error. The reverse lookup is a primary-key read on the derived id. */
export async function resolveIdentity(
  kind: string, externalUserId: string,
): Promise<ChannelIdentity | null> {
  const row = await ChannelIdentities.findOneAsync(`${kind}:${externalUserId}`);
  return row ?? null;
}

/**
 * Mint a single-use, short-lived token bound to ONE external identity. The
 * caller — the pipeline answering a `link-request` intent (`route()` in
 * ingress.ts), or an app's own flow — delivers it to that identity's surface,
 * proving, when it comes back through a signed-in session, that the presenter
 * controls both sides. (A lens never calls this: lenses are pure.)
 */
export async function issueLinkToken(
  kind: string, externalUserId: string, opts: { ttlMs?: number } = {},
): Promise<string> {
  const _id = Random.secret();
  await ChannelLinkTokens.insertAsync({
    _id,
    kind,
    externalUserId,
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS)),
    createdAt: new Date(),
  });
  return _id;
}

/**
 * Burn a token and link its identity to `userId` — called from the app's own
 * authenticated surface (a method or route that already knows who the web user
 * is; that authentication is the app's, not this module's).
 *
 * `findOneAndDelete` is the single-winner point: of two racing redeems exactly
 * one gets the document, so a token is spent at most once even across
 * servers. Expiry is checked on the way out — a TTL index also reaps expired
 * rows (indexes.ts), but Mongo's TTL sweep runs on its own schedule and a
 * token must be dead the millisecond it expires, not within a minute of it.
 *
 * Returns the identity row on success, null on an unknown, spent, or expired
 * token — one indistinguishable null, deliberately, so a probe learns nothing
 * about which.
 */
export async function redeemLinkToken(
  token: string, userId: string,
): Promise<ChannelIdentity | null> {
  const doc = await ChannelLinkTokens.rawCollection().findOneAndDelete(
    { _id: token },
  ) as unknown as ChannelLinkToken | null;
  if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
  try {
    return await linkIdentity(doc.kind, doc.externalUserId, userId, 'link');
  } catch (e) {
    // `already-linked`: the identity belongs to another account. The token
    // is spent either way, and the answer is the same indistinguishable null
    // every other failure gives — a probe learns nothing about which.
    if (e instanceof Meteor.Error && e.error === 'already-linked') return null;
    throw e;
  }
}

/**
 * Write the identity row and CLAIM HISTORY (§12): sessions the external
 * identity created before linking are anonymous (`userId: null`), and the
 * moment their owner proves who they are, those sessions become theirs — the
 * alternative is silently losing a user's history the moment they sign in.
 *
 * The rewrite is GUARDED: only rows still owned by `null` and still naming
 * this exact external conversation are touched, so an already-owned session —
 * whatever owns it — is never reassigned. Bindings first, then their sessions,
 * each conditional, so a crash between the two leaves only un-claimed rows the
 * next redeem (idempotent — same derived id, same guards) finishes.
 *
 * OIDC callers use this directly with `assurance: 'oidc'` after their own
 * round-trip proved both sides.
 */
export async function linkIdentity(
  kind: string, externalUserId: string, userId: string,
  assurance: 'link' | 'oidc',
): Promise<ChannelIdentity> {
  const _id = `${kind}:${externalUserId}`;
  const row: ChannelIdentity = {
    _id, kind, externalUserId, userId, assurance, linkedAt: new Date(),
  };
  // The assurance the identity row ends up holding — the caller's proof, or
  // the stronger `oidc` an existing row already carries. Stamped on claimed
  // sessions too, so a session and its identity row never disagree.
  let effective: 'link' | 'oidc' = assurance;
  if (!(await insertOrLose(ChannelIdentities, row))) {
    const existing = await ChannelIdentities.findOneAsync(_id);
    // A DIFFERENT account presenting proof for an already-linked identity is
    // REFUSED, not re-pointed. Re-pointing would silently dispossess the
    // current owner (their conversations stay theirs while the surface's
    // messages start failing), and carrying the old `oidc` label across a
    // userId change would let a weak proof inherit a strong one — a SIM-swap
    // or a leaked token would arrive wearing OAuth's badge. Unlinking is an
    // explicit, separate act (spec §15), never a side effect of linking.
    if (existing && existing.userId !== userId) {
      throw new Meteor.Error('already-linked', 'This identity is linked to a different account.');
    }
    // The SAME account re-proving itself (a second surface session, an
    // assurance upgrade): keep the stronger proof, never downgrade — an
    // `oidc` row stays `oidc` when a later link-token flow re-proves weaker.
    if (existing?.assurance === 'oidc') effective = 'oidc';
    await ChannelIdentities.updateAsync(_id, {
      $set: { userId, assurance: effective, linkedAt: new Date() },
    });
  }

  // Claim history: every binding this external identity opened anonymously,
  // and each binding's session — guarded on the anonymous owner both times.
  // Matched on the binding's RECORDED opener, not on `conversationRef`: the
  // ref names a conversation (a Slack thread), not a person, and only for
  // person-keyed surfaces like SMS do the two coincide.
  const orphaned = await ChannelBindings.find({
    kind, externalUserId, userId: null,
  }).fetchAsync();
  for (const binding of orphaned) {
    // eslint-disable-next-line no-await-in-loop
    await ChannelBindings.updateAsync(
      { _id: binding._id, userId: null },
      { $set: { userId, updatedAt: new Date() } },
    );
    // eslint-disable-next-line no-await-in-loop
    await AgentSessions.updateAsync(
      { _id: binding.sessionId, userId: null },
      {
        $set: {
          userId,
          'channel.assurance': effective,
          updatedAt: new Date(),
        },
      },
    );
  }

  const linked = await ChannelIdentities.findOneAsync(_id);
  return linked ?? row;
}

// ---- Verdict tokens — the `link` interaction grammar (§8.4) ----------------

const DEFAULT_VERDICT_TTL_MS = 24 * 60 * 60_000;

/**
 * Mint the approval capability for ONE choice of one delivered prompt — the
 * `link` grammar's affordance. The egress worker calls this when a
 * link-interact channel delivers a prompt; the app's route hands the token to
 * `redeemVerdictToken`. Longer-lived than a linking token by default (a day,
 * not ten minutes): an email approval is read on the reader's schedule, and
 * the real staleness guard is the `toolCallId` check at redemption, not the
 * clock.
 */
export async function issueVerdictToken(
  agent: string, sessionId: string, toolCallId: string,
  verdict: 'approved' | 'denied', opts: { ttlMs?: number } = {},
): Promise<string> {
  const _id = Random.secret();
  await ChannelVerdictTokens.insertAsync({
    _id, agent, sessionId, toolCallId, verdict,
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_VERDICT_TTL_MS)),
    createdAt: new Date(),
  });
  return _id;
}

/**
 * Burn a verdict token and record its verdict. The token IS the authorization
 * — a capability addressed to the person the prompt was delivered to — so the
 * verdict is recorded AS the session's owner, exactly the identity an
 * anonymous capability-URL approval already uses. The agent's own `approve`
 * predicate is still consulted (it sees that owner), and the single-winner
 * verdict write still applies, so a racing human click and token click
 * produce exactly one verdict.
 *
 * Two staleness guards, layered: the token must name the CURRENTLY parked
 * call (`toolCallId` — a yes aimed at last week's ask cannot decide today's),
 * and beneath that the conditional verdict write remains the final authority.
 *
 * Returns true when this redemption decided the ask; false on an unknown,
 * spent, expired, or stale token — one indistinguishable false, so a probe
 * learns nothing.
 */
export async function redeemVerdictToken(token: string): Promise<boolean> {
  const doc = await ChannelVerdictTokens.rawCollection().findOneAndDelete(
    { _id: token },
  ) as unknown as ChannelVerdictToken | null;
  if (!doc || doc.expiresAt.getTime() < Date.now()) return false;

  const session = await AgentSessions.findOneAsync(doc.sessionId);
  if (!session) return false;
  if (session.pending?.toolCallId !== doc.toolCallId || session.pending.verdict) {
    return false;   // a different ask is parked now, or none — the token is stale
  }
  try {
    await recordVerdict(
      { userId: session.userId }, doc.agent, doc.sessionId, doc.verdict,
      doc.verdict === 'denied' ? 'denied via approval link' : undefined,
    );
    return true;
  } catch (e) {
    // A Meteor.Error is a SETTLED refusal — `no-pending` (someone answered
    // first), `not-allowed` (the agent's approve predicate refused the owner),
    // `no-session`/`no-agent` (the token names a session or agent that no
    // longer matches): the ask was not decided by us, and the same false every
    // other failure gives is the right answer. Anything else (a failed write, a
    // bug) is not a verdict on the token and propagates — the same split
    // `redeemLinkToken` above and ingress.ts `route()` apply.
    if (e instanceof Meteor.Error) return false;
    throw e;
  }
}
