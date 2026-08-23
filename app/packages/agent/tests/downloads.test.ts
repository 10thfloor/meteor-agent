import { assert } from 'chai';

/**
 * The web download surface (participants spec §7): minted, single-use,
 * short-lived capabilities over the session-scoped store — and the serving
 * headers that keep the store from becoming a same-origin XSS host.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const clean = async () => {
  const { AgentSessions, AgentMessages } = await import('../common/collections');
  const { AgentAttachments } = await import('../server/attachments');
  const { AttachmentDownloadTokens } = await import('../server/downloads');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentAttachments.removeAsync({});
  await (AttachmentDownloadTokens as any).removeAsync({});
};

const seed = async () => {
  const { AgentSessions } = await import('../common/collections');
  const { AgentAttachments } = await import('../server/attachments');
  const now = new Date();
  await AgentSessions.insertAsync({
    _id: 'dl1', agent: 'dl-agent', userId: 'owner-1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    participants: [
      { id: 'h:owner-1', kind: 'human', role: 'owner', userId: 'owner-1', displayName: 'owner', joinedAt: now },
      { id: 'm:dl-agent', kind: 'model', role: 'member', agent: 'dl-agent', displayName: 'dl-agent', joinedAt: now },
      { id: 'h:member-1', kind: 'human', role: 'member', userId: 'member-1', displayName: 'Dana', joinedAt: now },
    ],
    createdAt: now, updatedAt: now,
  });
  await AgentAttachments.insertAsync({
    _id: 'attD1', sessionId: 'dl1', name: 'report.csv', contentType: 'text/csv',
    size: 12, content: b64('a,b\n1,2\n3,4\n'), origin: 'tool', createdAt: now,
  });
};

describe('attachment downloads', () => {
  it('mints for a ref in the session, refuses a foreign or missing one', async function () {
    this.timeout(20000);
    await clean();
    await seed();
    const { issueAttachmentToken } = await import('../server/downloads');

    const token = await issueAttachmentToken('dl1', 'attD1');
    assert.isString(token);
    assert.isAtLeast(token!.length, 10, 'a real secret, not an id');

    assert.isNull(await issueAttachmentToken('dl1', 'att-nope'), 'no such ref');
    assert.isNull(await issueAttachmentToken('other-session', 'attD1'),
      'a ref is a capability only inside its own conversation');
  });

  it('the method authorizes like the publication: owner, roster member, nobody else', async function () {
    this.timeout(20000);
    await clean();
    await seed();
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    // eslint-disable-next-line no-new
    new Agent('dl-agent', {
      model: 'mock', instructions: '', tools: [], provider: mockProvider(() => ({ text: 'x' })),
    });
    const handler = (Meteor as any).server.method_handlers[NAMES.mAttachmentToken];
    const call = (userId: string | null) =>
      handler.call({ userId }, 'dl-agent', 'dl1', 'attD1');

    assert.isString(await call('owner-1'));
    assert.isString(await call('member-1'), 'a roster member downloads what they can read');
    try {
      await call('stranger-9');
      assert.fail('a stranger must not mint');
    } catch (e: any) {
      assert.equal(e.error, 'no-session', 'the indistinguishable refusal');
    }
    try {
      await call(null);
      assert.fail('null is the anonymous owner only — this session is owned');
    } catch (e: any) {
      assert.equal(e.error, 'no-session');
    }
  });

  it('serves once with the containment headers, then the token is dead', async function () {
    this.timeout(20000);
    await clean();
    await seed();
    const { issueAttachmentToken, handleDownload } = await import('../server/downloads');
    const token = (await issueAttachmentToken('dl1', 'attD1'))!;

    const out = await handleDownload(token);
    assert.equal(out.status, 200);
    assert.equal(out.body!.toString('utf8'), 'a,b\n1,2\n3,4\n');
    assert.equal(out.headers!['content-type'], 'text/csv');
    assert.equal(out.headers!['content-length'], '12');
    assert.include(out.headers!['content-disposition'], 'attachment');
    assert.include(out.headers!['content-disposition'], 'report.csv');
    assert.equal(out.headers!['x-content-type-options'], 'nosniff');
    assert.equal(out.headers!['cache-control'], 'no-store');

    assert.equal((await handleDownload(token)).status, 404, 'single-use: burned by the serve');
  });

  it('expired, junk, and reaped-attachment tokens are one indistinguishable 404', async function () {
    this.timeout(20000);
    await clean();
    await seed();
    const { AttachmentDownloadTokens, issueAttachmentToken, handleDownload } = await import('../server/downloads');
    const { AgentAttachments } = await import('../server/attachments');

    // Expired: the TTL index is only the janitor — redemption checks the clock.
    await (AttachmentDownloadTokens as any).insertAsync({
      _id: 'expiredtoken-123', sessionId: 'dl1', attachmentId: 'attD1',
      expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 61_000),
    });
    assert.equal((await handleDownload('expiredtoken-123')).status, 404);

    assert.equal((await handleDownload('nope-nope-nope')).status, 404);
    assert.equal((await handleDownload('')).status, 404);
    assert.equal((await handleDownload('../../../etc/passwd')).status, 404, 'shape-checked before any read');

    // A live token whose bytes were reaped (retention) serves nothing.
    const token = (await issueAttachmentToken('dl1', 'attD1'))!;
    await AgentAttachments.removeAsync({ _id: 'attD1' });
    assert.equal((await handleDownload(token)).status, 404);
  });
});
