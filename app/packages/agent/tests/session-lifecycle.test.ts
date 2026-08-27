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
import { beginSessionOperation } from '../server/session-operations';
import { resumeSessionErasures } from '../server/session-lifecycle';
import { UserMessageReservations } from '../server/transcript';

const ids = {
  root: 'erase-root', child: 'erase-child', grandchild: 'erase-grandchild',
  fork: 'erase-fork', binding: 'erase-binding', identity: 'erase-identity',
  memory: 'erase-memory', attachment: 'erase-attachment', download: 'erase-download',
  verdict: 'erase-verdict', receipt: 'erase-receipt', legacyReceipt: 'erase-legacy-receipt',
  reservation: 'erase-reservation',
};

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
  await AgentSessions.removeAsync({ _id: { $in: sessionIds } });
}

describe('Agent.erase — server-side Session lifecycle', () => {
  beforeEach(clean);
  afterEach(clean);

  it('recursively erases Session-owned state while preserving forks, Memory, and identity', async () => {
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
