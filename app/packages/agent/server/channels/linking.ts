import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from '../../common/collections';
import { recordVerdict } from '../methods';
import {
  ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
  insertOrLose, type ChannelIdentity, type ChannelLinkToken, type ChannelVerdictToken,
} from './collections';

/* Account linking (§12). Two proofs: `oidc` (full OAuth) and `link`
 * (one-time token). Proof always completes from the authenticated side —
 * an inbound message can request a link but never assert one. */

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

/** Mint a single-use token bound to one external identity. The caller
 *  delivers it to that surface; presenting it from a signed-in session
 *  proves control of both sides. */
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

/** Burn token, link identity. findOneAndDelete is single-winner;
 *  indistinguishable null on any failure. */
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
    // already-linked → same indistinguishable null; token is spent either way.
    if (e instanceof Meteor.Error && e.error === 'already-linked') return null;
    throw e;
  }
}

/** Write the identity row and claim anonymous history (§12). Guarded:
 *  only null-owned rows matching this external identity are touched, so
 *  crash-recovery is idempotent. OIDC callers use this directly. */
export async function linkIdentity(
  kind: string, externalUserId: string, userId: string,
  assurance: 'link' | 'oidc',
): Promise<ChannelIdentity> {
  const _id = `${kind}:${externalUserId}`;
  const row: ChannelIdentity = {
    _id, kind, externalUserId, userId, assurance, linkedAt: new Date(),
  };
  // Effective assurance: caller's proof, or the stronger `oidc` an existing row carries.
  let effective: 'link' | 'oidc' = assurance;
  if (!(await insertOrLose(ChannelIdentities, row))) {
    const existing = await ChannelIdentities.findOneAsync(_id);
    // Different account for an already-linked identity → refuse, never re-point.
    if (existing && existing.userId !== userId) {
      throw new Meteor.Error('already-linked', 'This identity is linked to a different account.');
    }
    // Same account re-proving: keep the stronger assurance, never downgrade.
    if (existing?.assurance === 'oidc') effective = 'oidc';
    await ChannelIdentities.updateAsync(_id, {
      $set: { userId, assurance: effective, linkedAt: new Date() },
    });
  }

  // Claim history: adopt null-owned bindings this identity opened.
  // Member bindings excluded — they belong to the composing session's owner.
  const orphaned = await ChannelBindings.find({
    kind, externalUserId, userId: null, member: { $ne: true },
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

  // Roster reconciliation (§4.2): a channel-identified member who proves
  // an account gains DDP standing without changing session ownership.
  await AgentSessions.rawCollection().updateMany(
    {
      participants: {
        $elemMatch: {
          kind: 'human', 'identity.kind': kind, 'identity.externalUserId': externalUserId,
        },
      },
    },
    {
      $set: {
        'participants.$[p].userId': userId,
        'participants.$[p].assurance': effective,
        updatedAt: new Date(),
      },
    },
    {
      arrayFilters: [{
        'p.kind': 'human', 'p.identity.kind': kind, 'p.identity.externalUserId': externalUserId,
      }],
    },
  );

  const linked = await ChannelIdentities.findOneAsync(_id);
  return linked ?? row;
}

// ---- Verdict tokens — the `link` interaction grammar (§8.4) ----------------

const DEFAULT_VERDICT_TTL_MS = 24 * 60 * 60_000;

/** Mint a verdict-approval token for one choice of one delivered prompt.
 *  24h default TTL; the real staleness guard is toolCallId at redemption. */
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

/** Burn a verdict token and record the verdict. Token must name the
 *  currently parked toolCallId (staleness guard). Returns true when this
 *  redemption decided the ask; indistinguishable false otherwise. */
export async function redeemVerdictToken(token: string): Promise<boolean> {
  const doc = await ChannelVerdictTokens.rawCollection().findOneAndDelete(
    { _id: token },
  ) as unknown as ChannelVerdictToken | null;
  if (!doc || doc.expiresAt.getTime() < Date.now()) return false;

  const session = await AgentSessions.findOneAsync(doc.sessionId);
  if (!session) return false;
  if (session.pending?.toolCallId !== doc.toolCallId || session.pending.verdict) {
    return false;   // stale — different ask is parked now
  }
  try {
    await recordVerdict(
      { userId: session.userId }, doc.agent, doc.sessionId, doc.verdict,
      doc.verdict === 'denied' ? 'denied via approval link' : undefined,
    );
    return true;
  } catch (e) {
    // Meteor.Error = settled refusal (raced, not-allowed, etc.) → false.
    // Anything else propagates.
    if (e instanceof Meteor.Error) return false;
    throw e;
  }
}
