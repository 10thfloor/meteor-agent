import { assert } from 'chai';
import { Random } from 'meteor/random';
import type { DeliveryItem } from '../common/channel-contract';
import type { ToolContext } from '../server/tools';

/**
 * Attachments (email v2 spec): the store's caps and idempotency, the staged
 * claim's single-winner shape, session-scoped hydration and reads, inbound
 * admission with its fail-closed notes, and the lens law's naming clause.
 */

/** A code off a Meteor.Error, or null when the call resolved. */
async function refusalOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e: any) {
    return String(e?.error ?? e?.message ?? 'unknown');
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const rawAttachmentInsertPrototype = async (): Promise<object> => {
  const { AgentAttachments } = await import('../server/attachments');
  let holder = Object.getPrototypeOf(AgentAttachments.rawCollection());
  while (holder && !Object.prototype.hasOwnProperty.call(holder, 'insertOne')) {
    holder = Object.getPrototypeOf(holder);
  }
  if (!holder) throw new Error('Mongo raw Collection has no insertOne implementation');
  return holder;
};

async function seedAttachmentSessions(...ids: string[]): Promise<void> {
  const { AgentSessions } = await import('../common/collections');
  for (const _id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (await AgentSessions.findOneAsync(_id)) continue;
    // eslint-disable-next-line no-await-in-loop
    await AgentSessions.insertAsync({
      _id, agent: 'attachment-test', userId: null,
      phase: 'idle', model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
}

describe('attachments', () => {
  // ---- The law's naming clause (§10) ---------------------------------------

  describe('the naming clause', () => {
    it('the default corpus carries a file-bearing reply', async () => {
      const { exemplarItems } = await import('../common/channel-contract');
      const withFiles = exemplarItems().filter(
        (i) => (i.item === 'reply' || i.item === 'overflow') && i.attachments?.length,
      );
      assert.isAtLeast(withFiles.length, 1, 'the exemplar corpus must meet a file');
    });

    it('passes a lens that names files and rejects one that vanishes them', async () => {
      const {
        assertLensRoundTrip, attachmentNotice, promptDisplay,
      } = await import('../common/channel-contract');
      // A minimal MENU lens: prompts render their reply words (the grammar
      // reads back through `matchExpectation`) and the tool's own account of
      // the call (the display clause), and file-bearing items append the
      // naming line.
      const naming = {
        out: (item: DeliveryItem): unknown => {
          if (item.item === 'reply') return { text: `${item.text}${attachmentNotice(item.attachments)}` };
          if (item.item === 'overflow') return { text: `${item.head}${attachmentNotice(item.attachments)}` };
          if (item.item === 'prompt') {
            return {
              text: `${promptDisplay(item.display)} ${item.choices.map((c) => c.match ?? c.token).join(' ')}`,
            };
          }
          return { text: item.kind };
        },
        in: (event: any) => ({ intent: { kind: 'message' as const, text: String(event?.text ?? '') } }),
      };
      assertLensRoundTrip(naming, { interact: 'menu' }, {
        synthesize: (choice) => ({ text: choice.match ?? '' }),
        message: (text) => ({ text }),
      });

      // The same lens with the notice dropped: the file silently vanishes,
      // which is exactly what the clause forbids.
      const vanishing = {
        ...naming,
        out: (item: DeliveryItem): unknown => (item.item === 'reply'
          ? { text: item.text }
          : naming.out(item)),
      };
      let message = '';
      try {
        assertLensRoundTrip(vanishing, { interact: 'menu' }, {
          synthesize: (choice) => ({ text: choice.match ?? '' }),
        });
      } catch (e: any) {
        message = String(e?.message ?? '');
      }
      assert.match(message, /naming clause|name does not appear/i);
    });

    it('attachmentNotice names every file and applies the surface escape', async () => {
      const { attachmentNotice } = await import('../common/channel-contract');
      assert.equal(attachmentNotice(undefined), '');
      assert.equal(attachmentNotice([]), '');
      const files = [
        { name: 'a.csv', contentType: 'text/csv', size: 1, content: 'QQ==' },
        { name: 'b&c.txt', contentType: 'text/plain', size: 1, content: 'QQ==' },
      ];
      assert.equal(
        attachmentNotice(files),
        '\n[file attached: a.csv]\n[file attached: b&c.txt]',
      );
      assert.include(
        attachmentNotice(files, (n) => n.replace(/&/g, '&amp;')),
        'b&amp;c.txt',
      );
    });
  });

  // ---- The store (§5/§8) ----------------------------------------------------

  describe('createAttachment', () => {
    it('encodes UTF-8 content, computes the decoded size, and returns a ref', async () => {
      const { createAttachment, AgentAttachments } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const ref = await createAttachment({
        sessionId, name: 'summary.csv', contentType: 'text/csv', content: 'id,total\n1,200\n',
      });
      assert.equal(ref.name, 'summary.csv');
      assert.equal(ref.size, 15);
      const row = (await AgentAttachments.findOneAsync({ _id: ref.id, sessionId }))!;
      assert.equal(Buffer.from(row.content!, 'base64').toString('utf8'), 'id,total\n1,200\n');
      assert.equal(row.origin, 'inbound');
      assert.isUndefined(row.staged);
    });

    it('rolls byte insertion back when the guarded transaction fails', async function () {
      this.timeout(20000);
      const { createAttachment, AgentAttachments } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const rawPrototype = await rawAttachmentInsertPrototype() as any;
      const descriptor = Object.getOwnPropertyDescriptor(rawPrototype, 'insertOne')!;
      const original = descriptor.value;
      Object.defineProperty(rawPrototype, 'insertOne', {
        ...descriptor,
        value: async function failAfterInsert(doc: any, ...rest: any[]) {
          const result = await original.call(this, doc, ...rest);
          if (doc.sessionId === sessionId) throw new Error('injected attachment transaction failure');
          return result;
        },
      });
      try {
        let failure: unknown;
        try {
          await createAttachment({
            sessionId, name: 'private.txt', contentType: 'text/plain', content: 'private',
          });
        } catch (error) {
          failure = error;
        }
        assert.match(String((failure as Error)?.message), /injected attachment/);
        assert.isUndefined(
          await AgentAttachments.findOneAsync({ sessionId }),
          'the bytes and operation-guard renewal roll back together',
        );
      } finally {
        Object.defineProperty(rawPrototype, 'insertOne', descriptor);
      }
    });

    it('refuses a child attachment when its lifecycle root is fenced', async () => {
      const { createAttachment, AgentAttachments } = await import('../server/attachments');
      const { AgentSessions } = await import('../common/collections');
      const rootId = Random.id();
      const childId = Random.id();
      await seedAttachmentSessions(rootId, childId);
      await AgentSessions.updateAsync(childId, {
        $set: { parent: { sessionId: rootId, toolCallId: 'attachment-root-fence' } },
      });
      await AgentSessions.updateAsync(rootId, { $set: { erasingAt: new Date() } });

      assert.equal(await refusalOf(createAttachment({
        sessionId: childId, name: 'private.txt', contentType: 'text/plain', content: 'private',
      })), 'no-session');
      assert.isUndefined(await AgentAttachments.findOneAsync({ sessionId: childId }));
    });

    it('refuses invalid base64 and oversize files, with codes a tool result can carry', async () => {
      const { createAttachment } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      assert.equal(await refusalOf(createAttachment({
        sessionId, name: 'x.bin', contentType: 'application/octet-stream',
        content: { base64: 'not*base64!' },
      })), 'attachment-invalid');
      assert.equal(await refusalOf(createAttachment({
        sessionId, name: 'big.bin', contentType: 'application/octet-stream',
        content: 'AAAA', caps: { maxFileBytes: 2 },
      })), 'attachment-too-large');
    });

    it('enforces the staged-set caps: count, then total bytes', async () => {
      const { createAttachment } = await import('../server/attachments');
      const sessionId = Random.id();
      const sessionB = Random.id();
      await seedAttachmentSessions(sessionId, sessionB);
      const caps = { maxFiles: 2, maxTotalBytes: 10 };
      await createAttachment({ sessionId, name: 'a', contentType: 'text/plain', content: 'aaaa', attach: true, caps });
      await createAttachment({ sessionId, name: 'b', contentType: 'text/plain', content: 'bbbb', attach: true, caps });
      assert.equal(await refusalOf(createAttachment({
        sessionId, name: 'c', contentType: 'text/plain', content: 'c', attach: true, caps,
      })), 'attachment-limit');
      const total = { maxFiles: 5, maxTotalBytes: 10 };
      await createAttachment({ sessionId: sessionB, name: 'a', contentType: 'text/plain', content: 'aaaaaaaa', attach: true, caps: total });
      assert.equal(await refusalOf(createAttachment({
        sessionId: sessionB, name: 'b', contentType: 'text/plain', content: 'bbbb', attach: true, caps: total,
      })), 'attachment-limit');
      // An UNSTAGED create is bounded per file only — no message to cap.
      assert.isNull(await refusalOf(createAttachment({
        sessionId: sessionB, name: 'c', contentType: 'text/plain', content: 'cccccccc', caps: total,
      })));
    });

    it('derives the id from session + toolCallId + name: a re-run adopts, and re-stages after a claim', async () => {
      const { createAttachment, claimStagedRefs, AgentAttachments } = await import('../server/attachments');
      const sessionId = Random.id();
      const otherSessionId = Random.id();
      await seedAttachmentSessions(sessionId, otherSessionId);
      const make = () => createAttachment({
        sessionId, name: 'report.csv', contentType: 'text/csv',
        content: 'x,y\n1,2\n', attach: true, toolCallId: 'tc1',
      });
      const first = await make();
      const second = await make();
      assert.equal(first.id, second.id, 'the derived key collides on purpose');
      assert.equal(await AgentAttachments.find({ sessionId }).countAsync(), 1, 'one row, not two');
      assert.equal((await AgentAttachments.findOneAsync(first.id))!.origin, 'tool');

      // The crash window: a commit claimed the ref, then died before its
      // insert. The recovered turn re-runs the tool; its create re-stages.
      const claimed = await claimStagedRefs(sessionId);
      assert.deepEqual(claimed.map((r) => r.id), [first.id]);
      assert.isUndefined((await AgentAttachments.findOneAsync(first.id))!.staged);
      await make();
      assert.equal((await AgentAttachments.findOneAsync(first.id))!.staged, true, 're-staged for the recovered reply');

      // A DIFFERENT session with the same toolCallId and name (the mock
      // provider reuses `t1` every turn) must not collide.
      const other = await createAttachment({
        sessionId: otherSessionId, name: 'report.csv', contentType: 'text/csv',
        content: 'x,y\n1,2\n', toolCallId: 'tc1',
      });
      assert.notEqual(other.id, first.id);
    });

    it('sanitizes names: control characters stripped, length capped, never empty', async () => {
      const { sanitizeAttachmentName } = await import('../server/attachments');
      assert.equal(sanitizeAttachmentName('re\x00po\x1frt.csv'), 'report.csv');
      assert.equal(sanitizeAttachmentName('  \x07 '), 'file');
      assert.equal(sanitizeAttachmentName('x'.repeat(200)).length, 160);
      assert.equal(sanitizeAttachmentName('../../etc/passwd'), '../../etc/passwd', 'a path is inert in a collection — display hygiene only');
    });
  });

  describe('claimStagedRefs', () => {
    it('claims each staged row exactly once — the single-winner shape', async () => {
      const { createAttachment, claimStagedRefs } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      await createAttachment({ sessionId, name: 'a.txt', contentType: 'text/plain', content: 'a', attach: true });
      await createAttachment({ sessionId, name: 'b.txt', contentType: 'text/plain', content: 'b', attach: true });
      await createAttachment({ sessionId, name: 'loose.txt', contentType: 'text/plain', content: 'c' });
      const first = await claimStagedRefs(sessionId);
      assert.deepEqual(first.map((r) => r.name).sort(), ['a.txt', 'b.txt'], 'staged rows only');
      const second = await claimStagedRefs(sessionId);
      assert.deepEqual(second, [], 'a second claimant gets nothing');
    });
  });

  describe('hydrateRefs', () => {
    it('hydrates session-scoped and reports what no longer exists', async () => {
      const { createAttachment, hydrateRefs } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const ref = await createAttachment({
        sessionId, name: 'data.json', contentType: 'application/json', content: '{"a":1}',
      });
      const gone = { id: 'attmissing', name: 'expired.csv', contentType: 'text/csv', size: 9 };
      const out = await hydrateRefs(sessionId, [ref, gone]);
      assert.equal(out.attachments.length, 1);
      assert.equal(out.attachments[0].name, 'data.json');
      assert.equal(Buffer.from(out.attachments[0].content, 'base64').toString('utf8'), '{"a":1}');
      assert.deepEqual(out.missing.map((r) => r.name), ['expired.csv']);
      // Another session's ref is MISSING here, not readable: the id is a
      // capability only inside its own conversation.
      const foreign = await hydrateRefs(Random.id(), [ref]);
      assert.equal(foreign.attachments.length, 0);
      assert.equal(foreign.missing.length, 1);
    });
  });

  // ---- Inbound admission (§6) ----------------------------------------------

  describe('admitInboundAttachments', () => {
    it('applies the caps in order — count, per-file, total — and says what it dropped', async () => {
      const { admitInboundAttachments, AgentAttachments } = await import('../server/attachments');
      const { AgentSessions } = await import('../common/collections');
      const sessionId = Random.id();
      await AgentSessions.insertAsync({
        _id: sessionId, agent: 'attachment-test', userId: null,
        phase: 'idle', model: 'mock', nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      });
      const file = (name: string, text: string) => ({
        name, contentType: 'text/plain', size: text.length, content: b64(text),
      });
      try {
        const out = await admitInboundAttachments(sessionId, [
          file('keep-1.txt', 'aaaa'),
          { name: 'garbage.bin', contentType: 'application/octet-stream', size: 4, content: '!!invalid!!' },
          file('too-big.txt', 'x'.repeat(20)),
          file('over-total.txt', 'ccccc'),   // 4 kept + 5 = 9 > the 8-byte total
          file('keep-2.txt', 'bb'),          // 4 + 2 = 6 still fits
          file('over-count.txt', 'd'),       // two already kept — the count cap
        ], { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 8 });
        assert.deepEqual(out.refs.map((r) => r.name), ['keep-1.txt', 'keep-2.txt'], 'kept exactly what passed');
        assert.equal(out.notes.length, 4, 'one note per rejected file');
        assert.match(out.notes[0], /"garbage\.bin".*did not decode/);
        assert.match(out.notes[1], /"too-big\.txt" \(20 bytes\) exceeded the 10 bytes limit/);
        assert.match(out.notes[2], /"over-total\.txt".*total limit/);
        assert.match(out.notes[3], /"over-count\.txt".*already carries 2 files/);
      } finally {
        await AgentAttachments.removeAsync({ sessionId });
        await AgentSessions.removeAsync(sessionId);
      }
    });
  });

  // ---- The model's view + the shipped read tool (§6/§7) ---------------------

  describe('attachmentSuffix', () => {
    it('is mechanical: count, name, type, size, id — nothing else', async () => {
      const { attachmentSuffix } = await import('../server/attachments');
      const suffix = attachmentSuffix([
        { id: 'attX7', name: 'report.csv', contentType: 'text/csv', size: 18432 },
        { id: 'attK2', name: 'photo.jpg', contentType: 'image/jpeg', size: 2097152 },
      ]);
      assert.equal(
        suffix,
        '[2 files attached — read one with the read_attachment tool:\n'
        + '- report.csv (text/csv, 18432 bytes) id=attX7\n'
        + '- photo.jpg (image/jpeg, 2097152 bytes) id=attK2]',
      );
      assert.match(attachmentSuffix([{ id: 'a', name: 'n', contentType: 't', size: 1 }]), /^\[1 file attached/);
    });
  });

  describe('read_attachment', () => {
    const ctx = (sessionId: string): ToolContext => ({ userId: null, sessionId });

    it('returns text for text-like content, session-scoped', async () => {
      const { createAttachment, readTool } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const ref = await createAttachment({
        sessionId, name: 'notes.md', contentType: 'text/markdown', content: '# hello',
      });
      const out: any = await readTool.run({ id: ref.id }, ctx(sessionId));
      assert.equal(out.text, '# hello');
      assert.equal(out.name, 'notes.md');
      const foreign: any = await readTool.run({ id: ref.id }, ctx(Random.id()));
      assert.isTrue(foreign.notFound, 'a ref from another session reads as not-found');
    });

    it('refuses binary with a structured result the model can route around', async () => {
      const { createAttachment, readTool } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const ref = await createAttachment({
        sessionId, name: 'photo.jpg', contentType: 'image/jpeg', content: { base64: b64('notreallyajpeg') },
      });
      const out: any = await readTool.run({ id: ref.id }, ctx(sessionId));
      assert.isTrue(out.binary);
      assert.equal(out.name, 'photo.jpg');
      assert.equal(out.size, 14);
      assert.isUndefined(out.text);
    });

    it('truncates past the cap and names the full size', async () => {
      const { createAttachment, readTool, READ_TEXT_CAP } = await import('../server/attachments');
      const sessionId = Random.id();
      await seedAttachmentSessions(sessionId);
      const ref = await createAttachment({
        sessionId, name: 'big.txt', contentType: 'text/plain', content: 'x'.repeat(READ_TEXT_CAP + 100),
      });
      const out: any = await readTool.run({ id: ref.id }, ctx(sessionId));
      assert.isTrue(out.truncated);
      assert.match(out.text, /\[truncated — the full file is 64 KB\]$/);
      assert.isAtMost(out.text.length, READ_TEXT_CAP + 100);
    });

    it('answers junk ids as not-found rather than throwing', async () => {
      const { readTool } = await import('../server/attachments');
      const out: any = await readTool.run({ id: 42 as any }, ctx(Random.id()));
      assert.isTrue(out.notFound);
    });
  });

  // ---- Staging → the turn-final reply (§8) ---------------------------------

  describe('staging through the loop', () => {
    it('a tool-created attach:true file rides the turn-final assistant row, claimed from the store', async function () {
      this.timeout(30000);
      const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
      const { AgentAttachments, createAttachment } = await import('../server/attachments');
      const { mockProvider } = await import('../server/providers/mock');
      const { runTurn } = await import('../server/loop');

      const sessionId = 's-attach-loop';
      await AgentSessions.removeAsync({});
      await AgentMessages.removeAsync({});
      await AgentDeltas.removeAsync({});
      await AgentAttachments.removeAsync({});
      await AgentSessions.insertAsync({
        _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
        nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
      await AgentMessages.insertAsync({
        _id: 'u-msg', sessionId, seq: 0, role: 'user', content: 'build the report', createdAt: new Date(),
      } as any);

      let call = 0;
      await runTurn(sessionId, {
        model: 'mock', system: '',
        tools: [{
          name: 'buildReport', description: 'x', args: { type: 'object', properties: {} },
          run: async (_args: unknown, ctx) => {
            const ref = await createAttachment({
              sessionId: ctx.sessionId, name: 'summary.csv', contentType: 'text/csv',
              content: 'a,b\n1,2\n', attach: true, toolCallId: ctx.toolCallId,
            });
            return { ref };
          },
        }],
        provider: mockProvider(() => {
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 't1', name: 'buildReport', args: {} }] }
            : { text: 'the report is attached' };
        }),
      });

      const final = (await AgentMessages.findOneAsync({
        sessionId, role: 'assistant', content: 'the report is attached',
      }))!;
      assert.equal(final.attachments!.length, 1, 'the staged ref was claimed into the reply');
      assert.equal(final.attachments![0].name, 'summary.csv');
      const stored = (await AgentAttachments.findOneAsync(final.attachments![0].id))!;
      assert.isUndefined(stored.staged, 'the claim unstaged the store row');
      assert.equal(stored.origin, 'tool');
      const planning = (await AgentMessages.findOneAsync({
        sessionId, role: 'assistant', toolCalls: { $exists: true },
      }))!;
      assert.isUndefined(planning.attachments, 'intermediate rows carry nothing');
    });
  });

  // ---- The planner's rule (§8) ---------------------------------------------

  describe('planItems with attachments', () => {
    it('posts a file-bearing reply even with empty text; a bare empty reply still posts nothing', async () => {
      const { planItems } = await import('../server/channels/plan');
      const row = (over: object) => ({
        _id: 'm1', sessionId: 's', seq: 1, role: 'assistant' as const,
        createdAt: new Date(), ...over,
      });
      const refs = [{ id: 'a1', name: 'f.csv', contentType: 'text/csv', size: 4 }];
      const withFile = planItems([row({ content: '', attachments: refs }) as any], { profile: { interact: 'menu' } });
      assert.deepEqual(withFile[0].item, { item: 'reply', text: '' }, 'a file with no cover note is still a message');
      const bare = planItems([row({ content: '' }) as any], { profile: { interact: 'menu' } });
      assert.isNull(bare[0].item, 'nothing to say and nothing to send stays silent');
    });
  });

  // ---- The model's request view (§6) ---------------------------------------

  describe('toProviderMessages', () => {
    it('suffixes ref-carrying USER rows in the request view only; assistant refs stay silent', async () => {
      const { toProviderMessages } = await import('../server/transcript');
      const refs = [{ id: 'attX7', name: 'report.csv', contentType: 'text/csv', size: 18432 }];
      const base = { _id: 'm', sessionId: 's', createdAt: new Date() };
      const out = toProviderMessages([
        { ...base, _id: 'm1', seq: 1, role: 'user', content: 'see the file', attachments: refs },
        { ...base, _id: 'm2', seq: 2, role: 'user', content: '', attachments: refs },
        { ...base, _id: 'm3', seq: 3, role: 'assistant', content: 'done', attachments: refs },
        { ...base, _id: 'm4', seq: 4, role: 'user', content: 'no files here' },
      ]);
      assert.equal(
        out[0].content,
        'see the file\n\n[1 file attached — read one with the read_attachment tool:\n'
        + '- report.csv (text/csv, 18432 bytes) id=attX7]',
      );
      assert.match(out[1].content!, /^\[1 file attached/, 'an attachment-only row is just the suffix');
      assert.equal(out[2].content, 'done', 'assistant rows are never suffixed');
      assert.equal(out[3].content, 'no files here');
    });
  });

  // ---- prettySize (the notes' vocabulary) -----------------------------------

  it('prettySize speaks bytes, KB and MB', async () => {
    const { prettySize } = await import('../server/attachments');
    assert.equal(prettySize(18), '18 bytes');
    assert.equal(prettySize(18432), '18 KB');
    assert.equal(prettySize(5 * 1024 * 1024), '5 MB');
    assert.equal(prettySize(12 * 1024 * 1024), '12 MB');
  });
});

describe('external attachment storage', function () {
  this.timeout(20000);
  let store: typeof import('../server/attachments');
  let sessionId: string;
  let foreignSessionId: string;
  let calls: Array<{ kind: string; input: any }>;
  let remote: Map<string, string>;
  let adapter: import('../server/attachments').AttachmentStorageAdapter;
  const create = (patch: Partial<import('../server/attachments').CreateAttachmentOptions> = {}) => store.createAttachment({
    sessionId, name: 'private.txt', contentType: 'text/plain', content: 'remote bytes only', ...patch,
  });
  before(async () => { store = await import('../server/attachments'); });
  beforeEach(async () => {
    sessionId = Random.id(); foreignSessionId = Random.id(); calls = []; remote = new Map();
    await seedAttachmentSessions(sessionId, foreignSessionId);
    adapter = {
      name: 'fixture-storage',
      async write(input, context) {
        await context.assertActive(); calls.push({ kind: 'write', input });
        const key = `${input.sessionId}:${input.id}:${input.sha256}`;
        remote.set(key, input.content); return { key, sha256: input.sha256 };
      },
      async read(input, context) {
        await context.assertActive(); calls.push({ kind: 'read', input });
        const content = remote.get(String(input.storageReference.key));
        if (content === undefined) throw new Error('remote file missing'); return content;
      },
    };
    store.configureAttachmentStorage(adapter);
  });
  afterEach(async () => {
    store.configureAttachmentStorage(null);
    await store.AgentAttachments.removeAsync({ sessionId: { $in: [sessionId, foreignSessionId] } });
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({ _id: { $in: [sessionId, foreignSessionId] } });
  });

  it('writes verified external bytes and retains only non-secret metadata in Mongo', async () => {
    const ref = await create(); const row = (await store.AgentAttachments.findOneAsync(ref.id))!;
    assert.notProperty(row, 'content'); assert.equal(row.storageProvider, 'fixture-storage');
    assert.match(row.contentSha256!, /^[a-f0-9]{64}$/); assert.deepEqual(calls.map((call) => call.kind), ['write', 'read']);
    assert.notInclude(JSON.stringify(row), b64('remote bytes only'));
    assert.equal(await store.readAttachmentContent(row), b64('remote bytes only'));
    const { Agent } = await import('../server/agent');
    assert.equal(await Agent.attachments.readContent(row), b64('remote bytes only'));
    assert.isFunction(Agent.attachments.configureStorage); assert.isFunction(Agent.attachments.migrateContent);
  });
  it('retains the default Mongo store when no external adapter is configured', async () => {
    store.configureAttachmentStorage(null); const ref = await create(); const row = (await store.AgentAttachments.findOneAsync(ref.id))!;
    assert.equal(row.content, b64('remote bytes only')); assert.notProperty(row, 'storageReference'); assert.isEmpty(calls);
    assert.equal(await store.readAttachmentContent(row), row.content);
  });
  it('adopts tool retries without a second upload and re-stages the original ref', async () => {
    const first = await create({ toolCallId: 'same', attach: true }); await store.claimStagedRefs(sessionId);
    const second = await create({ toolCallId: 'same', attach: true, content: 'different retry payload' });
    assert.equal(first.id, second.id); assert.equal(calls.filter((call) => call.kind === 'write').length, 1);
    const row = (await store.AgentAttachments.findOneAsync(first.id))!; assert.isTrue(row.staged);
    assert.equal(await store.readAttachmentContent(row), b64('remote bytes only'));
  });
  it('does not fall back to Mongo when external upload or verification fails', async () => {
    for (const failure of ['write', 'verify']) {
      store.configureAttachmentStorage({ ...adapter,
        ...(failure === 'write' ? { write: async () => { throw new Error('secret provider token'); } }
          : { read: async () => b64('incorrect content') }),
      });
      assert.equal(await refusalOf(create()), 'attachment-storage-write-failed');
      assert.equal(await store.AgentAttachments.find({ sessionId }).countAsync(), 0);
    }
  });
  it('provides a fixed storage-required hint without exposing adapter diagnostics', async () => {
    const { Meteor } = await import('meteor/meteor');
    for (const code of ['attachment-storage-required', 'attachment-storage-invalid', 'provider-error']) {
      store.configureAttachmentStorage({ ...adapter, write: async () => { throw new Meteor.Error(code, 'secret token', 'private diagnostics'); } });
      let error: any;
      try { await create(); } catch (caught) { error = caught; }
      assert.equal(error?.error, code === 'attachment-storage-required' ? code : 'attachment-storage-write-failed');
      if (code === 'attachment-storage-required') assert.equal(error.reason, 'Enable file storage for this conversation before saving attachments.');
      assert.notInclude(JSON.stringify(error), 'secret token'); assert.notInclude(JSON.stringify(error), 'private diagnostics');
      assert.equal(await store.AgentAttachments.find({ sessionId }).countAsync(), 0);
    }
  });
  it('rejects secret-bearing, URL or byte-bearing adapter references', async () => {
    for (const reference of [{ token: 'private' }, { url: 'https://signed.example/file?secret=1' }, { content: b64('bytes') }, { nested: { secret: 'private' } }, { key: 'x'.repeat(1025) }]) {
      store.configureAttachmentStorage({ ...adapter, write: async () => reference as any });
      assert.equal(await refusalOf(create()), 'attachment-storage-invalid');
      assert.equal(await store.AgentAttachments.find({ sessionId }).countAsync(), 0);
    }
  });
  it('reloads authoritative metadata and refuses foreign-session or forged locators', async () => {
    const ref = await create(); const row = (await store.AgentAttachments.findOneAsync(ref.id))!;
    assert.equal(await store.readAttachmentContent({ ...row, storageReference: { key: 'forged' }, content: b64('forged') } as any), b64('remote bytes only'));
    const before = calls.length;
    assert.equal(await refusalOf(store.readAttachmentContent({ _id: row._id, sessionId: foreignSessionId })), 'attachment-unavailable');
    assert.equal(calls.length, before);
    const hydrated = await store.hydrateRefs(foreignSessionId, [ref]); assert.deepEqual(hydrated.attachments, []); assert.deepEqual(hydrated.missing, [ref]);
  });
  it('hydrates delivery bytes and model text through the adapter', async () => {
    const ref = await create(); const hydrated = await store.hydrateRefs(sessionId, [ref]);
    assert.equal(hydrated.attachments[0].content, b64('remote bytes only')); assert.isEmpty(hydrated.missing);
    const result: any = await store.readTool.run({ id: ref.id }, { userId: null, sessionId });
    assert.equal(result.text, 'remote bytes only'); assert.notProperty(result, 'content');
  });
  it('hydrates request images through the adapter and omits unavailable external images', async () => {
    const ref = await create({ name: 'image.png', contentType: 'image/png', content: { base64: b64('image fixture') } });
    const rows = [{ role: 'tool' as const, seq: 1, toolCallId: 'image-call', attachments: [ref] }];
    const messages: import('../server/providers/types').ProviderMessage[] = [{ role: 'tool', toolCallId: 'image-call', content: 'Image' }];
    assert.isTrue(await store.hydrateImageRefs(sessionId, rows, messages)); assert.equal(messages[0].images![0].data, b64('image fixture'));
    remote.clear(); const unavailable: import('../server/providers/types').ProviderMessage[] = [{ role: 'tool', toolCallId: 'image-call', content: 'Image' }];
    assert.isFalse(await store.hydrateImageRefs(sessionId, rows, unavailable)); assert.isUndefined(unavailable[0].images);
    const result: any = await store.readTool.run({ id: ref.id }, { userId: null, sessionId, imageInput: true, attachToResult: () => { assert.fail('Missing image must not be attached'); } });
    assert.isTrue(result.unavailable); assert.equal(result.reason, 'storage-unavailable');
  });
  it('reports missing external bytes without falling back to a stale Mongo content field', async () => {
    const ref = await create(); await store.AgentAttachments.updateAsync(ref.id, { $set: { content: b64('stale Mongo content') } });
    remote.clear(); const row = (await store.AgentAttachments.findOneAsync(ref.id))!;
    assert.equal(await refusalOf(store.readAttachmentContent(row)), 'attachment-storage-unavailable');
    const hydrated = await store.hydrateRefs(sessionId, [ref]); assert.isEmpty(hydrated.attachments); assert.deepEqual(hydrated.missing, [ref]);
    const result: any = await store.readTool.run({ id: ref.id }, { userId: null, sessionId }); assert.isTrue(result.unavailable);
    store.configureAttachmentStorage(null);
    assert.equal(await refusalOf(store.readAttachmentContent(row)), 'attachment-storage-unavailable');
  });
  it('rejects changed external bytes even when the decoded size still matches', async () => {
    const ref = await create(); const row = (await store.AgentAttachments.findOneAsync(ref.id))!;
    remote.set(String(row.storageReference!.key), b64('REMOTE BYTES ONLY'));
    assert.equal(await refusalOf(store.readAttachmentContent(row)), 'attachment-storage-unavailable');
  });
  it('uses external storage for web downloads and inbound admission', async () => {
    const inbound = await store.admitInboundAttachments(sessionId, [{ name: 'incoming.txt', contentType: 'text/plain', size: 5, content: b64('hello') }]);
    assert.lengthOf(inbound.refs, 1); const row = (await store.AgentAttachments.findOneAsync(inbound.refs[0].id))!; assert.notProperty(row, 'content');
    const { issueAttachmentToken, redeemAttachmentToken } = await import('../server/downloads');
    const token = await issueAttachmentToken(sessionId, row._id); assert.isString(token);
    const download = await redeemAttachmentToken(token!); assert.equal(download!.content.toString(), 'hello');
  });
  it('returns not-found rather than a public exception when download storage is unavailable', async () => {
    const ref = await create(); const { issueAttachmentToken, redeemAttachmentToken, handleDownload } = await import('../server/downloads');
    const token = await issueAttachmentToken(sessionId, ref.id); remote.clear();
    assert.isNull(await redeemAttachmentToken(token!));
    const secondToken = await issueAttachmentToken(sessionId, ref.id); assert.equal((await handleDownload(secondToken!)).status, 404);
    const { AgentSessions } = await import('../common/collections'); assert.isEmpty((await AgentSessions.findOneAsync(sessionId))!.operations ?? []);
  });
  it('migrates legacy bytes only after the remote copy is verified', async () => {
    store.configureAttachmentStorage(null); const ref = await create(); const before = (await store.AgentAttachments.findOneAsync(ref.id))!;
    let checkedBeforeRemoval = false;
    store.configureAttachmentStorage({ ...adapter, read: async (input, context) => {
      assert.equal((await store.AgentAttachments.findOneAsync(ref.id))!.content, before.content); checkedBeforeRemoval = true;
      return adapter.read(input, context);
    } });
    const migrated = await store.migrateAttachmentContent({ id: ref.id, sessionId }); assert.equal(migrated.id, ref.id); assert.isTrue(checkedBeforeRemoval);
    const after = (await store.AgentAttachments.findOneAsync(ref.id))!; assert.notProperty(after, 'content'); assert.equal(after.storageProvider, 'fixture-storage');
    assert.equal(after.size, before.size); assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
    store.configureAttachmentStorage(adapter); const writes = calls.filter((call) => call.kind === 'write').length;
    await store.migrateAttachmentContent({ id: ref.id, sessionId }); assert.equal(calls.filter((call) => call.kind === 'write').length, writes);
    assert.equal(await store.readAttachmentContent(after), before.content);
  });
  it('retains original Mongo bytes when migration write or verification fails', async () => {
    store.configureAttachmentStorage(null); const ref = await create(); const before = (await store.AgentAttachments.findOneAsync(ref.id))!;
    for (const failure of ['write', 'verify']) {
      store.configureAttachmentStorage({ ...adapter, ...(failure === 'write' ? { write: async () => { throw new Error('offline'); } } : { read: async () => b64('wrong') }) });
      assert.equal(await refusalOf(store.migrateAttachmentContent({ id: ref.id, sessionId })), 'attachment-storage-write-failed');
      assert.deepEqual(await store.AgentAttachments.findOneAsync(ref.id), before);
    }
  });
  it('preserves a concurrent legacy edit instead of unsetting its new bytes during migration', async () => {
    store.configureAttachmentStorage(null); const ref = await create();
    store.configureAttachmentStorage({ ...adapter, read: async (input, context) => {
      const content = await adapter.read(input, context);
      await store.AgentAttachments.updateAsync(ref.id, { $set: { content: b64('concurrent edit'), size: 15 } }); return content;
    } });
    assert.equal(await refusalOf(store.migrateAttachmentContent({ id: ref.id, sessionId })), 'attachment-storage-conflict');
    const row = (await store.AgentAttachments.findOneAsync(ref.id))!; assert.equal(row.content, b64('concurrent edit')); assert.notProperty(row, 'storageReference');
  });
  it('refuses external writes for fenced sessions and cannot commit metadata after an erasure fence', async () => {
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.updateAsync(sessionId, { $set: { erasingAt: new Date() } });
    assert.equal(await refusalOf(create()), 'no-session'); assert.isEmpty(calls);
    await AgentSessions.updateAsync(sessionId, { $unset: { erasingAt: 1 } });
    store.configureAttachmentStorage({ ...adapter, write: async (input, context) => {
      const reference = await adapter.write(input, context); await AgentSessions.updateAsync(sessionId, { $set: { erasingAt: new Date() } }); return reference;
    } });
    assert.isNotNull(await refusalOf(create())); assert.equal(await store.AgentAttachments.find({ sessionId }).countAsync(), 0);
  });
});
