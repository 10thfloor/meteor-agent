import { assert } from 'chai';
import { AgentDeltas, AgentMemories, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentSession } from '../common/types';
import { Agent } from '../server/agent';
import { AgentAttachments } from '../server/attachments';
import {
  ChannelBindings, ChannelIdentities, ChannelVerdictTokens, DeliveryReceipts,
} from '../server/channels/collections';
import {
  AttachmentDownloadTokens, mountDownloadRoute, redeemAttachmentToken,
} from '../server/downloads';
import { _setLeaseTimings, claimLease } from '../server/lease';
import { deliverOnce } from '../server/channels/egress';
import {
  AgentConstitutions, AgentExperiences, AgentIdentities, AgentMemoryFrames,
  AgentPractices,
} from '../server/learning-collections';
import { beginSessionOperation } from '../server/session-operations';
import {
  abandonPendingAgentTurns, resumeSessionErasures,
} from '../server/session-lifecycle';
import { UserMessageReservations } from '../server/transcript';

const ids = {
  root: 'erase-root', child: 'erase-child', grandchild: 'erase-grandchild',
  fork: 'erase-fork', binding: 'erase-binding', identity: 'erase-identity',
  memory: 'erase-memory', attachment: 'erase-attachment', download: 'erase-download',
  verdict: 'erase-verdict', receipt: 'erase-receipt', legacyReceipt: 'erase-legacy-receipt',
  reservation: 'erase-reservation',
  constitution: 'erase-constitution', experience: 'erase-experience',
  practice: 'erase-practice',
  sessionExperience: 'erase-session-experience',
  childExperience: 'erase-child-experience',
  unrelatedExperience: 'erase-unrelated-experience',
  identityExperience: 'erase-identity-experience',
};

const frameId = (sessionId: string): string => `erase-frame-${sessionId}`;

function session(
  _id: string, agent: string, parent?: { sessionId: string; toolCallId: string },
): AgentSession {
  return {
    _id, agent, userId: 'erase-owner', phase: 'idle', model: 'mock', nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    ...(parent ? { parent } : {}),
    createdAt: new Date(), updatedAt: new Date(),
  };
}

async function clean(): Promise<void> {
  const sessionIds = [ids.root, ids.child, ids.grandchild, ids.fork];
  await DeliveryReceipts.removeAsync(ids.receipt);
  await DeliveryReceipts.removeAsync(ids.legacyReceipt);
  await ChannelVerdictTokens.removeAsync(ids.verdict);
  await AttachmentDownloadTokens.removeAsync(ids.download);
  await ChannelBindings.removeAsync(ids.binding);
  await ChannelIdentities.removeAsync(ids.identity);
  await AgentAttachments.removeAsync(ids.attachment);
  await UserMessageReservations.removeAsync(ids.reservation);
  await AgentDeltas.removeAsync({ sessionId: { $in: sessionIds } });
  await AgentMessages.removeAsync({ sessionId: { $in: sessionIds } });
  await AgentMemories.removeAsync(ids.memory);
  await AgentMemoryFrames.removeAsync({ _id: { $in: [
    frameId(ids.root), frameId(ids.child), frameId(ids.grandchild), frameId(ids.fork),
  ] } });
  await AgentPractices.removeAsync(ids.practice);
  await AgentExperiences.removeAsync({ _id: { $in: [
    ids.experience, ids.sessionExperience, ids.childExperience,
    ids.unrelatedExperience, ids.identityExperience,
  ] } });
  await AgentConstitutions.removeAsync(ids.constitution);
  await AgentIdentities.removeAsync('erase-agent');
  await AgentSessions.removeAsync({ _id: { $in: sessionIds } });
}

async function insertFrame(sessionId: string): Promise<void> {
  await AgentMemoryFrames.insertAsync({
    _id: frameId(sessionId), sessionId, agentId: 'erase-agent', triggerSeq: 0,
    context: 'Session erasure test', practices: [], experiences: [],
    audience: { scope: 'session', key: sessionId },
    factMemory: { evidence: [], promptDigest: `fact-${sessionId}` },
    protectedPromptDigest: `prompt-${sessionId}`, digest: `frame-${sessionId}`,
    createdAt: new Date(),
  });
}

async function insertAgentLearning(): Promise<void> {
  const now = new Date();
  await AgentIdentities.insertAsync({
    _id: 'erase-agent', generation: 1, experienceSeq: 1,
    currentName: 'erase-agent', aliases: [], displayName: 'Erase agent',
    lifecycle: 'active', constitutionVersionId: ids.constitution,
    flexibility: { capacity: 3, available: 3 }, createdAt: now, updatedAt: now,
  });
  await AgentConstitutions.insertAsync({
    _id: ids.constitution, agentId: 'erase-agent', revision: 1,
    content: 'Preserve identity across Session erasure.', reason: 'Test seed',
    digest: 'constitution-digest', source: { kind: 'app', key: 'erase-seed' },
    createdAt: now,
  });
  await AgentExperiences.insertAsync({
    _id: ids.experience, agentId: 'erase-agent', sequence: 1,
    expectationBasis: 'explicit',
    expected: 'Session remains', observed: 'Session was erased',
    difference: 'The Session lifecycle changed',
    lesson: 'Experience belongs to the Agent, not its source Session.',
    context: 'session-lifecycle', confidence: 1, status: 'active',
    // Identity audience: only session-audience rows follow their Session
    // (erasure symmetry); Agent-owned learning survives on provenance alone.
    audience: { scope: 'identity', key: 'erase-agent' },
    source: {
      kind: 'model', key: 'experience-propose:erase-call',
      sessionId: ids.root, triggerSeq: 0, toolCallId: 'erase-call',
      assistantMessageId: 'erase-assistant-message',
    },
    frameId: frameId(ids.root), digest: 'experience-digest', createdAt: now,
  });
  await AgentPractices.insertAsync({
    _id: ids.practice, practiceId: 'erase-practice-family', agentId: 'erase-agent',
    key: 'preserve-agent-learning', revision: 1,
    trigger: 'When erasing a Session',
    guidance: 'Remove Session Frames but preserve Agent-owned learning.',
    context: 'session-lifecycle', evidenceIds: [ids.experience],
    source: { kind: 'app', key: 'erase-practice-seed' }, digest: 'practice-digest',
    status: 'candidate', createdAt: now, updatedAt: now,
  });
}

async function insertAudienceExperience(
  _id: string, audience: { scope: 'identity' | 'session'; key: string }, sequence: number,
): Promise<void> {
  await AgentExperiences.insertAsync({
    _id, agentId: 'erase-agent', sequence,
    expectationBasis: 'explicit',
    expected: 'The row outlives erasure', observed: 'Erasure follows the audience',
    difference: 'Only the exposure partition decides',
    lesson: 'Session-audience Experiences follow their Session.',
    context: 'session-lifecycle', confidence: 1, status: 'active',
    audience,
    source: {
      kind: 'app', key: `erase-audience-${_id}`,
      sessionId: 'erase-source-session', triggerSeq: sequence,
    },
    digest: `digest-${_id}`, createdAt: new Date(),
  });
}

describe('Agent.erase — server-side Session lifecycle', () => {
  beforeEach(clean);
  afterEach(clean);

  it('erases descendant Frames while preserving forks, Fact Memory, and Agent learning', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    await AgentSessions.insertAsync(session(
      ids.child, 'specialist', { sessionId: ids.root, toolCallId: 'call-1' },
    ));
    await AgentSessions.insertAsync(session(
      ids.grandchild, 'researcher', { sessionId: ids.child, toolCallId: 'call-2' },
    ));
    await AgentSessions.insertAsync({
      ...session(ids.fork, 'erase-agent'),
      forkedFrom: { sessionId: ids.root, seq: 0 },
    });

    for (const sessionId of [ids.root, ids.child, ids.grandchild]) {
      // eslint-disable-next-line no-await-in-loop
      await AgentMessages.insertAsync({
        _id: `message-${sessionId}`, sessionId, seq: 0, role: 'user',
        content: 'private', createdAt: new Date(),
      });
      // eslint-disable-next-line no-await-in-loop
      await AgentDeltas.insertAsync({
        _id: `delta-${sessionId}`, sessionId, messageId: `message-${sessionId}`,
        seq: 1, text: 'partial', at: new Date(),
      } as any);
    }
    await AgentAttachments.insertAsync({
      _id: ids.attachment, sessionId: ids.root, name: 'private.txt',
      contentType: 'text/plain', size: 7, content: 'cHJpdmF0ZQ==',
      origin: 'inbound', createdAt: new Date(),
    });
    await AttachmentDownloadTokens.insertAsync({
      _id: ids.download, sessionId: ids.root, attachmentId: ids.attachment,
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    await ChannelBindings.insertAsync({
      _id: ids.binding, kind: 'test', conversationRef: 'erase-conversation',
      destination: {}, audience: 'direct', agent: 'erase-agent',
      sessionId: ids.root, userId: 'erase-owner', deliveredSeq: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await DeliveryReceipts.insertAsync({
      _id: ids.receipt, bindingId: 'synthetic-binding-not-stored', sessionId: ids.root,
      state: 'sent', attempts: 1, at: new Date(),
    });
    await DeliveryReceipts.insertAsync({
      _id: ids.legacyReceipt, bindingId: ids.binding,
      state: 'sent', attempts: 1, at: new Date(),
    } as any);
    await ChannelVerdictTokens.insertAsync({
      _id: ids.verdict, agent: 'erase-agent', sessionId: ids.root,
      toolCallId: 'call-1', verdict: 'approved',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    await ChannelIdentities.insertAsync({
      _id: ids.identity, kind: 'test', externalUserId: 'external-owner',
      userId: 'erase-owner', assurance: 'link', linkedAt: new Date(),
    });
    await AgentMemories.insertAsync({
      _id: ids.memory, userId: 'erase-owner', scope: 'user', text: 'keep me',
      by: 'app', at: new Date(),
    });
    await UserMessageReservations.insertAsync({
      _id: ids.reservation, sessionId: ids.child,
      draft: { content: 'reserved private input' }, resetRelay: true,
      createdAt: new Date(),
    });
    await Promise.all([
      insertFrame(ids.root), insertFrame(ids.child), insertFrame(ids.grandchild),
      insertFrame(ids.fork),
    ]);
    await insertAgentLearning();

    const result = await new Agent('erase-agent').erase(ids.root, { userId: 'erase-owner' });

    assert.equal(result, 'erased');
    assert.isUndefined(await AgentSessions.findOneAsync(ids.root));
    assert.isUndefined(await AgentSessions.findOneAsync(ids.child));
    assert.isUndefined(await AgentSessions.findOneAsync(ids.grandchild));
    assert.isDefined(await AgentSessions.findOneAsync(ids.fork), 'a fork is an independent root');
    assert.lengthOf(await AgentMessages.find({
      sessionId: { $in: [ids.root, ids.child, ids.grandchild] },
    }).fetchAsync(), 0);
    assert.isUndefined(await AgentAttachments.findOneAsync(ids.attachment));
    assert.isUndefined(await AttachmentDownloadTokens.findOneAsync(ids.download));
    assert.isUndefined(await ChannelBindings.findOneAsync(ids.binding));
    assert.isUndefined(await DeliveryReceipts.findOneAsync(ids.receipt));
    assert.isUndefined(
      await DeliveryReceipts.findOneAsync(ids.legacyReceipt),
      'binding cleanup remains for legacy receipts without sessionId',
    );
    assert.isUndefined(await ChannelVerdictTokens.findOneAsync(ids.verdict));
    assert.isUndefined(await UserMessageReservations.findOneAsync(ids.reservation));
    assert.isDefined(await ChannelIdentities.findOneAsync(ids.identity));
    assert.isDefined(await AgentMemories.findOneAsync(ids.memory));
    assert.isUndefined(await AgentMemoryFrames.findOneAsync(frameId(ids.root)));
    assert.isUndefined(await AgentMemoryFrames.findOneAsync(frameId(ids.child)));
    assert.isUndefined(await AgentMemoryFrames.findOneAsync(frameId(ids.grandchild)));
    assert.isDefined(
      await AgentMemoryFrames.findOneAsync(frameId(ids.fork)),
      'an independent fork keeps its own Memory Frame',
    );
    assert.isDefined(await AgentIdentities.findOneAsync('erase-agent'));
    assert.isDefined(await AgentConstitutions.findOneAsync(ids.constitution));
    assert.isDefined(await AgentExperiences.findOneAsync(ids.experience));
    assert.isDefined(await AgentPractices.findOneAsync(ids.practice));
  });

  it('erases session-audience Experiences with their Sessions, never other audiences', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    await AgentSessions.insertAsync(session(
      ids.child, 'specialist', { sessionId: ids.root, toolCallId: 'call-1' },
    ));
    await insertAudienceExperience(
      ids.sessionExperience, { scope: 'session', key: ids.root }, 1,
    );
    await insertAudienceExperience(
      ids.childExperience, { scope: 'session', key: ids.child }, 2,
    );
    await insertAudienceExperience(
      ids.unrelatedExperience, { scope: 'session', key: 'erase-unrelated-session' }, 3,
    );
    await insertAudienceExperience(
      ids.identityExperience, { scope: 'identity', key: 'erase-agent' }, 4,
    );

    const result = await new Agent('erase-agent').erase(ids.root, { userId: 'erase-owner' });

    assert.equal(result, 'erased');
    assert.isUndefined(
      await AgentExperiences.findOneAsync(ids.sessionExperience),
      'a session-audience Experience keyed to the erased root follows it',
    );
    assert.isUndefined(
      await AgentExperiences.findOneAsync(ids.childExperience),
      'descendant session audiences erase with the tree',
    );
    assert.isDefined(
      await AgentExperiences.findOneAsync(ids.unrelatedExperience),
      'a session audience keyed to an unrelated Session is untouched',
    );
    assert.isDefined(
      await AgentExperiences.findOneAsync(ids.identityExperience),
      'Agent-owned identity learning survives Session erasure',
    );
  });

  it('does not disclose or mutate a wrong-owner, wrong-agent, or child Session', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    await AgentSessions.insertAsync(session(
      ids.child, 'specialist', { sessionId: ids.root, toolCallId: 'call-1' },
    ));
    const agent = new Agent('erase-agent');

    assert.equal(await agent.erase(ids.root, { userId: 'someone-else' }), 'absent');
    assert.equal(await new Agent('other-agent').erase(
      ids.root, { userId: 'erase-owner' },
    ), 'absent');
    assert.equal(await new Agent('specialist').erase(
      ids.child, { userId: 'erase-owner' },
    ), 'absent');
    assert.isDefined(await AgentSessions.findOneAsync(ids.root));
    assert.isDefined(await AgentSessions.findOneAsync(ids.child));
  });

  it('fences immediately, then waits for a dead server Lease to expire', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    const previous = _setLeaseTimings({ leaseMs: 60 });
    try {
      assert.isTrue(await claimLease(ids.root, 'dead-server'));
      const erasing = new Agent('erase-agent').erase(ids.root, { userId: 'erase-owner' });

      // The owner claim is synchronous up to its first awaited storage call;
      // let it land, then prove no fresh Turn may claim the fenced Session.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.isFalse(await claimLease(ids.root, 'new-server'));
      assert.equal(await erasing, 'erased');
      assert.isUndefined(await AgentSessions.findOneAsync(ids.root));
    } finally {
      _setLeaseTimings(previous);
    }
  });

  it('waits for an external delivery operation before completing erasure', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    const binding = {
      _id: ids.binding, kind: 'test', conversationRef: 'erase-conversation',
      destination: {}, audience: 'direct' as const, agent: 'erase-agent',
      sessionId: ids.root, userId: 'erase-owner', deliveredSeq: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };
    await ChannelBindings.insertAsync(binding);

    let releasePost!: () => void;
    let enteredPost!: () => void;
    const entered = new Promise<void>((resolve) => { enteredPost = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePost = resolve; });
    const delivery = deliverOnce(
      binding, { item: 'reply', text: 'private' }, 'blocked',
      {
        def: {
          lens: { out: () => ({ text: 'private' }) } as any,
          transport: {
            async post() { enteredPost(); await blocked; return {}; },
          } as any,
        },
      },
    );
    await entered;

    let erased = false;
    const erasing = new Agent('erase-agent')
      .erase(ids.root, { userId: 'erase-owner' })
      .then((result) => { erased = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.isFalse(erased, 'erase must not return while transport.post holds private content');
    assert.isDefined((await AgentSessions.findOneAsync(ids.root))?.erasingAt);

    releasePost();
    assert.equal(await delivery, 'delivered');
    assert.equal(await erasing, 'erased');
    assert.isUndefined(await DeliveryReceipts.findOneAsync('deliver:erase-binding:blocked'));
  });

  it('rejects a download capability as soon as the Session is fenced', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    await AgentAttachments.insertAsync({
      _id: ids.attachment, sessionId: ids.root, name: 'private.txt',
      contentType: 'text/plain', size: 7, content: 'cHJpdmF0ZQ==',
      origin: 'inbound', createdAt: new Date(),
    });
    await AttachmentDownloadTokens.insertAsync({
      _id: ids.download, sessionId: ids.root, attachmentId: ids.attachment,
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    const holding = await beginSessionOperation(ids.root);
    assert.isNotNull(holding);
    const erasing = new Agent('erase-agent').erase(ids.root, { userId: 'erase-owner' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.isNull(await redeemAttachmentToken(ids.download));
    await holding!.close();
    assert.equal(await erasing, 'erased');
  });

  it('recovers a root-only crash fence before descendants can resume', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'), phase: 'stopped', erasingAt: new Date(),
    });
    await AgentSessions.insertAsync(session(
      ids.child, 'specialist', { sessionId: ids.root, toolCallId: 'call-1' },
    ));
    await ChannelBindings.insertAsync({
      _id: ids.binding, kind: 'test', conversationRef: 'erase-conversation',
      destination: {}, audience: 'direct', agent: 'specialist',
      sessionId: ids.child, userId: 'erase-owner', deliveredSeq: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });

    await resumeSessionErasures();

    assert.isUndefined(await AgentSessions.findOneAsync(ids.root));
    assert.isUndefined(await AgentSessions.findOneAsync(ids.child));
    assert.isUndefined(await ChannelBindings.findOneAsync(ids.binding));
  });

  it('replays Frame cleanup after a crash before Session row deletion', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'), phase: 'stopped', erasingAt: new Date(),
    });
    await AgentSessions.insertAsync(session(
      ids.child, 'specialist', { sessionId: ids.root, toolCallId: 'call-1' },
    ));
    await Promise.all([insertFrame(ids.root), insertFrame(ids.child)]);
    await insertAgentLearning();

    const removeSession = AgentSessions.removeAsync;
    let crashed = false;
    (AgentSessions as any).removeAsync = async (selector: unknown): Promise<number> => {
      if (!crashed && typeof selector === 'object') {
        crashed = true;
        throw new Error('injected crash after dependent purge');
      }
      return removeSession.call(AgentSessions, selector as any);
    };
    try {
      await resumeSessionErasures();
    } finally {
      (AgentSessions as any).removeAsync = removeSession;
    }

    assert.isTrue(crashed);
    assert.isDefined(
      await AgentSessions.findOneAsync(ids.root),
      'the durable root fence survives an interrupted purge',
    );
    assert.isUndefined(await AgentMemoryFrames.findOneAsync(frameId(ids.root)));
    assert.isUndefined(await AgentMemoryFrames.findOneAsync(frameId(ids.child)));

    await resumeSessionErasures();

    assert.isUndefined(await AgentSessions.findOneAsync(ids.root));
    assert.isUndefined(await AgentSessions.findOneAsync(ids.child));
    assert.isDefined(await AgentIdentities.findOneAsync('erase-agent'));
    assert.isDefined(await AgentConstitutions.findOneAsync(ids.constitution));
    assert.isDefined(await AgentExperiences.findOneAsync(ids.experience));
    assert.isDefined(await AgentPractices.findOneAsync(ids.practice));
  });

  it('keeps periodic recovery best-effort when one fenced root is malformed', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'),
      phase: 'stopped',
      erasingAt: new Date(),
      // A corrupt legacy row makes this root's recovery throw while reading
      // lease expiry. Periodic recovery must still advance independent roots.
      lease: { serverId: 'broken-server', until: 'not-a-date' },
    } as any);
    await AgentSessions.insertAsync({
      ...session(ids.fork, 'erase-agent'), phase: 'stopped', erasingAt: new Date(),
    });

    await resumeSessionErasures();

    assert.isDefined(await AgentSessions.findOneAsync(ids.root));
    assert.isUndefined(
      await AgentSessions.findOneAsync(ids.fork),
      'a malformed root must not strand independent periodic cleanup',
    );
  });

  it('propagates per-root recovery failure through the strict startup barrier', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'),
      phase: 'stopped',
      erasingAt: new Date(),
      lease: { serverId: 'broken-server', until: 'not-a-date' },
    } as any);

    let failure: unknown;
    try {
      await resumeSessionErasures({ strict: true });
    } catch (error) {
      failure = error;
    }

    assert.instanceOf(failure, TypeError);
    assert.isDefined(await AgentSessions.findOneAsync(ids.root));
  });

  it('keeps startup closed while a fenced Session still has live work', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'),
      phase: 'stopped',
      erasingAt: new Date(),
      operations: [{ id: 'still-live', until: new Date(Date.now() + 60_000) }],
    });

    await resumeSessionErasures();
    assert.isDefined(
      await AgentSessions.findOneAsync(ids.root),
      'a periodic sweep leaves live work for its next pass',
    );

    let failure: unknown;
    try {
      await resumeSessionErasures({ strict: true });
    } catch (error) {
      failure = error;
    }
    assert.match(String((failure as Error)?.message), /not yet quiescent/);
    assert.isDefined(await AgentSessions.findOneAsync(ids.root));
  });

  it('holds erasure through attachment HTTP response completion', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    await AgentAttachments.insertAsync({
      _id: ids.attachment, sessionId: ids.root, name: 'private.txt',
      contentType: 'text/plain', size: 7, content: 'cHJpdmF0ZQ==',
      origin: 'inbound', createdAt: new Date(),
    });
    await AttachmentDownloadTokens.insertAsync({
      _id: ids.download, sessionId: ids.root, attachmentId: ids.attachment,
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });

    let route!: (req: any, res: any, next: () => void) => void;
    mountDownloadRoute({ use(_path, fn) { route = fn; } });
    let finishResponse!: () => void;
    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => { responseStarted = resolve; });
    route(
      { method: 'GET', url: `/${ids.download}` },
      {
        writeHead() {},
        end(_body: unknown, done: () => void) {
          finishResponse = done;
          responseStarted();
        },
      },
      () => { throw new Error('download route unexpectedly fell through'); },
    );
    await started;

    let erased = false;
    const erasing = new Agent('erase-agent')
      .erase(ids.root, { userId: 'erase-owner' })
      .then((result) => { erased = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.isFalse(erased, 'private bytes have not finished leaving the server');

    finishResponse();
    assert.equal(await erasing, 'erased');
  });

  it('prunes expired operation remnants on the next acquisition', async () => {
    await AgentSessions.insertAsync({
      ...session(ids.root, 'erase-agent'),
      operations: [{ id: 'expired-operation', until: new Date(Date.now() - 1_000) }],
    });
    const operation = await beginSessionOperation(ids.root);
    assert.isNotNull(operation);
    const active = (await AgentSessions.findOneAsync(ids.root))!.operations ?? [];
    assert.lengthOf(active, 1);
    assert.notEqual(active[0].id, 'expired-operation');
    await operation!.close();
  });

  it('revokes work that can no longer renew its durable operation', async () => {
    await AgentSessions.insertAsync(session(ids.root, 'erase-agent'));
    const operation = await beginSessionOperation(ids.root, 30);
    assert.isNotNull(operation);

    await AgentSessions.rawCollection().updateOne(
      { _id: ids.root },
      {
        $set: {
          'operations.0.until': new Date(Date.now() - 1),
          purgingAt: new Date(),
        },
      },
    );

    let failure: unknown;
    try {
      await operation!.assertActive();
    } catch (error) {
      failure = error;
    }
    assert.equal((failure as Error)?.name, 'SessionOperationRevokedError');
    assert.isTrue(operation!.signal.aborted);
    await operation!.close();
  });
});

describe('Agent participant lifecycle — parked turn cancellation', () => {
  const parkedSession = 'archive-parked-session';
  const otherSession = 'archive-other-session';
  const callingSession = 'archive-calling-session';
  const sessions = [parkedSession, otherSession, callingSession];

  beforeEach(async () => {
    await AgentDeltas.removeAsync({ sessionId: { $in: sessions } });
    await AgentMessages.removeAsync({ sessionId: { $in: sessions } });
    await AgentSessions.removeAsync({ _id: { $in: sessions } });
  });
  afterEach(async () => {
    await AgentDeltas.removeAsync({ sessionId: { $in: sessions } });
    await AgentMessages.removeAsync({ sessionId: { $in: sessions } });
    await AgentSessions.removeAsync({ _id: { $in: sessions } });
  });

  it('revokes only the archived Agent park and removes its incomplete batch', async () => {
    const now = new Date();
    const parked = {
      toolCallId: 'archive-call', name: 'dangerous', args: {}, agent: 'archived-specialist',
      requestedAt: now,
    };
    await AgentSessions.insertAsync({
      ...session(parkedSession, 'orchestrator'), phase: 'awaiting', pending: parked,
      lease: { serverId: 'resume-server', until: new Date(Date.now() + 60_000) },
    });
    await AgentSessions.insertAsync({
      ...session(otherSession, 'orchestrator'), phase: 'awaiting',
      pending: { ...parked, toolCallId: 'other-call', agent: 'other-specialist' },
    });
    await AgentMessages.insertAsync({
      _id: 'archive-assistant', sessionId: parkedSession, seq: 0, role: 'assistant',
      content: '', toolCalls: [{ id: 'archive-call', name: 'dangerous', args: {} }],
      createdAt: now,
    });
    await AgentDeltas.insertAsync({
      _id: 'archive-delta', sessionId: parkedSession,
      messageId: 'archive-assistant', msgSeq: 0, seq: 0,
      kind: 'tool_args', text: '{}', at: now,
    } as any);

    const result = await abandonPendingAgentTurns('archived-specialist', 'erase-owner');

    assert.deepEqual(result, { sessions: 1, toolCalls: ['archive-call'] });
    const released = await AgentSessions.findOneAsync(parkedSession);
    assert.equal(released?.phase, 'idle');
    assert.isUndefined(released?.pending);
    assert.isUndefined(released?.lease);
    assert.isUndefined(await AgentMessages.findOneAsync('archive-assistant'));
    assert.isUndefined(await AgentDeltas.findOneAsync('archive-delta'));
    assert.equal((await AgentSessions.findOneAsync(otherSession))?.phase, 'awaiting');
  });

  it('waits out a mid-execution approved call, then fences its re-park', async function () {
    this.timeout(30000);
    const now = new Date();
    const executing = {
      toolCallId: 'calling-call', name: 'dangerous', args: {},
      agent: 'archived-specialist', requestedAt: now,
    };
    await AgentSessions.insertAsync({
      ...session(callingSession, 'orchestrator'), phase: 'calling', pending: executing,
      lease: { serverId: 'executing-server', until: new Date(Date.now() + 60_000) },
    });
    await AgentMessages.insertAsync({
      _id: 'calling-assistant', sessionId: callingSession, seq: 0, role: 'assistant',
      content: '', toolCalls: [{ id: 'calling-call', name: 'dangerous', args: {} }],
      createdAt: now,
    });

    const sweeping = abandonPendingAgentTurns('archived-specialist', 'erase-owner');
    // Phase 'calling' with a LIVE lease is skipped, so however many passes
    // have run by now, the executing call must remain untouched.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const untouched = await AgentSessions.findOneAsync(callingSession);
    assert.equal(untouched?.phase, 'calling', 'an executing approved call is not fenced');
    assert.isDefined(untouched?.pending, 'the pending marker survives mid-execution');
    assert.isDefined(untouched?.lease, 'the executing Lease is not stripped');
    assert.isDefined(await AgentMessages.findOneAsync('calling-assistant'));

    // The call re-parks (phase leaves 'calling'); the bounded sweep now
    // fences it within its remaining pass budget.
    await AgentSessions.updateAsync(callingSession, {
      $set: { phase: 'awaiting', updatedAt: new Date() },
    } as any);
    assert.deepEqual(await sweeping, { sessions: 1, toolCalls: ['calling-call'] });
    const released = await AgentSessions.findOneAsync(callingSession);
    assert.equal(released?.phase, 'idle');
    assert.isUndefined(released?.pending);
    assert.isUndefined(released?.lease);
    assert.isUndefined(await AgentMessages.findOneAsync('calling-assistant'));
  });

  it('fences a dead worker\'s mid-call park without waiting', async function () {
    this.timeout(30000);
    const now = new Date();
    await AgentSessions.insertAsync({
      ...session(callingSession, 'orchestrator'),
      phase: 'calling',
      pending: {
        toolCallId: 'dead-call', name: 'dangerous', args: {},
        agent: 'archived-specialist', requestedAt: now,
      },
      // An expired lease: the worker died mid-call, its commit is already
      // impossible, so the sweep must not wait on it.
      lease: { serverId: 'dead-server', until: new Date(Date.now() - 5_000) },
    });
    await AgentMessages.insertAsync({
      _id: 'dead-call-assistant', sessionId: callingSession, seq: 0, role: 'assistant',
      content: '', toolCalls: [{ id: 'dead-call', name: 'dangerous', args: {} }],
      createdAt: now,
    });
    assert.deepEqual(
      await abandonPendingAgentTurns('archived-specialist', 'erase-owner'),
      { sessions: 1, toolCalls: ['dead-call'] },
    );
    assert.isUndefined((await AgentSessions.findOneAsync(callingSession))?.pending);
  });
});
