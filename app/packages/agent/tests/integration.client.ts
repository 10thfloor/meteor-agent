import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Agent } from '../client/agent';

const AGENT = 'itest';

const waitFor = (
  label: string, ms: number, predicate: () => boolean,
): Promise<void> => new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + ms;
  const poll = setInterval(() => {
    let ok = false;
    try { ok = predicate(); } catch (e) { clearInterval(poll); reject(e); return; }
    if (ok) { clearInterval(poll); resolve(); }
    else if (Date.now() > deadline) {
      clearInterval(poll);
      reject(new Error(`timed out waiting for ${label}`));
    }
  }, 50);
});

/**
 * The only test in this suite that crosses the wire. Everything else proves a
 * server function or a pure function; this proves the whole path:
 * method call -> turn loop -> capped-collection deltas -> publication -> DDP ->
 * minimongo -> client-side merge -> reactive cursor.
 */
describe('live DDP round trip', () => {
  it('delivers a streamed reply into the merged cursor', async function () {
    this.timeout(60000);
    await Meteor.callAsync('itest.reset');

    const support = new Agent(AGENT);
    const sessionId: string = await support.start({ title: 'itest' });
    const handle = support.subscribe(sessionId);

    await waitFor('the subscription to become ready', 20000, () => handle.ready());

    await support.send(sessionId, 'hello');

    // The in-flight row exists only while the turn is still streaming, so it
    // has to be captured as it goes by. Its arrival is what proves the capped
    // deltas were published, that they carried `msgSeq`, and that the autorun
    // recomputed on a DELTA arriving rather than only on a committed message.
    let streamed: any = null;
    const capture = setInterval(() => {
      const row = support.messages(sessionId).fetch()
        .find((m: any) => m.role === 'assistant' && m.streaming);
      if (row && (!streamed || (row.content ?? '').length > streamed.content.length)) {
        streamed = { seq: row.seq, content: row.content ?? '' };
      }
    }, 50);

    try {
      await waitFor('the committed assistant message', 30000, () =>
        support.messages(sessionId).fetch()
          .some((m: any) => m.role === 'assistant' && !m.streaming));
    } finally {
      clearInterval(capture);
    }

    const rows = support.messages(sessionId).fetch();
    const assistant = rows.find((m: any) => m.role === 'assistant' && !m.streaming);

    assert.equal(assistant.content, 'live streamed reply');
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].content, 'hello');
    assert.isTrue(rows.every((m: any) => typeof m.seq === 'number'));

    assert.isNotNull(streamed, 'no in-flight row was ever observed — deltas never crossed DDP');
    assert.equal(streamed.seq, assistant.seq, 'the in-flight row must carry the future msgSeq');
    // Non-empty first: `startsWith('')` is vacuously true, so an in-flight row
    // that never carried any text would otherwise pass the prefix check.
    assert.isAbove(streamed.content.length, 0, 'in-flight row never carried any text');
    assert.isTrue(
      'live streamed reply'.startsWith(streamed.content),
      `in-flight text must be a prefix of the committed text, got "${streamed.content}"`,
    );
  });
});
