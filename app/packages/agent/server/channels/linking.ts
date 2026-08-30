import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from '../../common/collections';
import {
  beginSessionMutationOperation, withSessionOperationTransaction,
} from '../session-operations';
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

export interface LinkTokenPreview {
  state: 'ready' | 'expired' | 'unavailable';
  channel?: string;
  expiresAt?: Date;
}

/** Inspect an account-link capability without spending it. External identity
 * ids remain private; the page only needs the Channel label and expiry. */
export async function previewLinkToken(token: string): Promise<LinkTokenPreview> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { state: 'unavailable' };
  const doc = await ChannelLinkTokens.findOneAsync(token);
  if (!doc) return { state: 'unavailable' };
  if (doc.expiresAt.getTime() < Date.now()) return { state: 'expired' };
  return {
    state: 'ready',
    channel: cleanPreviewText(doc.kind, 'Channel', 32),
    expiresAt: doc.expiresAt,
  };
}

/** Burn token, link identity. findOneAndDelete is single-winner;
 *  indistinguishable null on any failure. */
export async function redeemLinkToken(
  token: string, userId: string,
): Promise<ChannelIdentity | null> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
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
    erasingAt: { $exists: false },
  }).fetchAsync();
  for (const binding of orphaned) {
    // eslint-disable-next-line no-await-in-loop
    await ChannelBindings.updateAsync(
      { _id: binding._id, userId: null, erasingAt: { $exists: false } },
      { $set: { userId, updatedAt: new Date() } },
    );
    // eslint-disable-next-line no-await-in-loop
    await AgentSessions.updateAsync(
      { _id: binding.sessionId, userId: null, erasingAt: { $exists: false } },
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
      erasingAt: { $exists: false },
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

export interface VerdictTokenPreview {
  state: 'ready' | 'expired' | 'unavailable';
  verdict?: 'approved' | 'denied';
  missionTitle?: string;
  toolName?: string;
  requestingAgent?: string;
  runContext?: 'owner' | 'anonymous' | 'elevated';
  source?: string;
  scope?: 'one-call';
  expiresAt?: Date;
}

function cleanPreviewText(value: unknown, fallback: string, max = 96): string {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, max) || fallback;
}

/** Inspect a verdict capability without spending it. The token itself is the
 * authority to see this deliberately small summary; tool args, user ids, and
 * transcript content never leave the server. A stale/missing request is kept
 * indistinguishable from a token that was already used. */
export async function previewVerdictToken(token: string): Promise<VerdictTokenPreview> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { state: 'unavailable' };
  const doc = await ChannelVerdictTokens.findOneAsync(token);
  if (!doc) return { state: 'unavailable' };
  if (doc.expiresAt.getTime() < Date.now()) return { state: 'expired' };

  const session = await AgentSessions.findOneAsync({
    _id: doc.sessionId,
    agent: doc.agent,
    phase: 'awaiting',
    erasingAt: { $exists: false },
    purgingAt: { $exists: false },
    'pending.toolCallId': doc.toolCallId,
    'pending.verdict': { $exists: false },
  });
  const pending = session?.pending;
  if (!session || !pending) return { state: 'unavailable' };

  return {
    state: 'ready',
    verdict: doc.verdict,
    missionTitle: cleanPreviewText(session.title, 'Untitled mission'),
    toolName: cleanPreviewText(pending.name, 'Tool call'),
    requestingAgent: cleanPreviewText(pending.agent ?? session.agent, 'Agent'),
    runContext: !('runAs' in pending)
      ? 'owner'
      : (pending.runAs === null ? 'anonymous' : 'elevated'),
    source: pending.mcpServer
      ? `MCP server · ${cleanPreviewText(pending.mcpServer, 'Unknown')}`
      : 'App tool',
    scope: 'one-call',
    expiresAt: doc.expiresAt,
  };
}

/** Mint a verdict-approval token for one choice of one delivered prompt.
 *  24h default TTL; the real staleness guard is toolCallId at redemption. */
export async function issueVerdictToken(
  agent: string, sessionId: string, toolCallId: string,
  verdict: 'approved' | 'denied', opts: { ttlMs?: number } = {},
): Promise<string> {
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  try {
    const _id = Random.secret();
    let issued = false;
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      const session = await AgentSessions.rawCollection().findOne(
        {
          _id: sessionId, agent,
          erasingAt: { $exists: false }, purgingAt: { $exists: false },
        },
        { projection: { _id: 1 }, session: mongoSession },
      );
      if (!session) return;
      await ChannelVerdictTokens.rawCollection().insertOne({
        _id, agent, sessionId, toolCallId, verdict,
        expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_VERDICT_TTL_MS)),
        createdAt: new Date(),
      }, { session: mongoSession });
      issued = true;
    });
    if (!issued) throw new Meteor.Error('no-session', 'Session not found');
    return _id;
  } finally {
    await operation.close();
  }
}

/** Burn a verdict token and record the verdict. Token must name the
 *  currently parked toolCallId (staleness guard). Returns true when this
 *  redemption decided the ask; indistinguishable false otherwise. */
export async function redeemVerdictToken(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return false;
  const now = new Date();
  const claimId = Random.secret();
  const claimed = await ChannelVerdictTokens.rawCollection().findOneAndUpdate(
    {
      _id: token,
      expiresAt: { $gt: now },
      $or: [
        { claim: { $exists: false } },
        { 'claim.until': { $lte: now } },
      ],
    },
    { $set: { claim: { id: claimId, until: new Date(now.getTime() + 30_000) } } },
    { returnDocument: 'after' },
  ) as unknown as ChannelVerdictToken | { value?: ChannelVerdictToken } | null;
  const doc: ChannelVerdictToken | null = claimed && 'value' in claimed
    ? (claimed.value ?? null)
    : claimed as ChannelVerdictToken | null;
  if (!doc) return false;

  const spend = () => ChannelVerdictTokens.rawCollection().deleteOne({
    _id: token, 'claim.id': claimId,
  });
  const release = () => ChannelVerdictTokens.rawCollection().updateOne(
    { _id: token, 'claim.id': claimId }, { $unset: { claim: '' } },
  );

  const session = await AgentSessions.findOneAsync({
    _id: doc.sessionId, erasingAt: { $exists: false },
  });
  const pending = session?.pending;
  if (!session || !pending) {
    await spend();
    return false;
  }
  if (pending.toolCallId !== doc.toolCallId || pending.verdict) {
    await spend();
    return false;   // stale — different ask is parked now
  }
  try {
    await recordVerdict(
      { userId: session.userId }, doc.agent, doc.sessionId, doc.verdict,
      doc.verdict === 'denied' ? 'denied via approval link' : undefined,
      doc.toolCallId,
    );
    await spend();
    return true;
  } catch (e) {
    // Meteor.Error = settled refusal (raced, not-allowed, etc.) → spend it.
    // Infrastructure failures release the short claim so the same link can be
    // retried instead of silently losing a still-pending human decision.
    if (e instanceof Meteor.Error) {
      await spend();
      return false;
    }
    await release();
    throw e;
  }
}
