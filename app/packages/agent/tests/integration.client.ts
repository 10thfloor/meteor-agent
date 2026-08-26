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
 *
 * BUDGET NOTE — this test runs inside the server's live rate limits.
 * `capped.test.ts`'s `applyRateLimits` suite registers REAL `DDPRateLimiter`
 * rules against `agent.start`, `agent.send`, `agent.fork` and
 * `agent.interrupt`, and DDPRateLimiter offers no supported way to remove a
 * rule or reset its counters — so those rules are live for the rest of the
 * process, and the browser half (this file and `element.client.ts`) is the
 * only place whose calls actually pass through them, over one shared DDP
 * connection and therefore one shared counter. Those fixtures now register a
 * deliberate `HEADROOM` count rather than the realistic `1`s and `5`s they
 * once used, exactly so the browser half can make the calls its assertions
 * need; see the comment above that constant. If the client suite ever grows
 * past it, raise `HEADROOM` — do not ration calls here.
 */
describe('live DDP round trip', () => {
  it('retracts a live anonymous transcript as soon as the session is claimed', async function () {
    this.timeout(30000);
    await Meteor.callAsync('itest.reset');

    const support = new Agent(AGENT);
    const sessionId: string = await support.start({ title: 'claim-revocation' });
    const handle = support.subscribe(sessionId);
    try {
      await waitFor('the anonymous subscription to become ready', 20000, () => handle.ready());
      await support.send(sessionId, 'private before claim');
      await waitFor('the transcript before claim', 20000, () =>
        support.messages(sessionId).fetch().some((m: any) => m.role === 'user'));

      assert.equal(await Meteor.callAsync('itest.claimAnonymous', sessionId), 1);
      await waitFor('the revoked transcript to be retracted', 20000, () =>
        support.messages(sessionId).fetch().length === 0
        && support.session(sessionId) === undefined);
    } finally {
      support.stop();
    }
  });

  it('retracts a live transcript as soon as its human participant is removed', async function () {
    this.timeout(30000);
    await Meteor.callAsync('itest.reset');
    await Meteor.callAsync('itest.setUserId', 'live-member');

    const support = new Agent(AGENT);
    try {
      const sessionId: string = await support.start({ title: 'participant-revocation' });
      assert.equal(await Meteor.callAsync('itest.makeCurrentUserParticipant', sessionId), 1);

      const handle = support.subscribe(sessionId);
      await waitFor('the participant subscription to become ready', 20000, () => handle.ready());
      await support.send(sessionId, 'private participant message');
      await waitFor('the participant transcript', 20000, () =>
        support.messages(sessionId).fetch().some((m: any) => m.role === 'user'));

      assert.equal(await Meteor.callAsync('itest.removeCurrentParticipant', sessionId), 1);
      await waitFor('the removed participant transcript to be retracted', 20000, () =>
        support.messages(sessionId).fetch().length === 0
        && support.session(sessionId) === undefined);
    } finally {
      support.stop();
      await Meteor.callAsync('itest.setUserId', null);
    }
  });

  it('delivers a streamed reply into the merged cursor', async function () {
    this.timeout(60000);
    await Meteor.callAsync('itest.reset');

    const support = new Agent(AGENT);
    const sessionId: string = await support.start({ title: 'itest' });
    const handle = support.subscribe(sessionId);
    // Teardown on EVERY exit (try/finally below): a failed assertion would
    // otherwise leave this subscription and its merge autorun live for the
    // rest of the client run. stop() is idempotent, so the success path's own
    // stop() calls — part of what this test asserts — are unaffected.
    try {

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
    assert.ok(assistant, 'the committed assistant row must exist');

    assert.equal(assistant!.content, 'live streamed reply');
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].content, 'hello');
    assert.isTrue(rows.every((m: any) => typeof m.seq === 'number'));

    assert.isNotNull(streamed, 'no in-flight row was ever observed — deltas never crossed DDP');
    assert.equal(streamed.seq, assistant!.seq, 'the in-flight row must carry the future msgSeq');
    // Non-empty first: `startsWith('')` is vacuously true, so an in-flight row
    // that never carried any text would otherwise pass the prefix check.
    assert.isAbove(streamed.content.length, 0, 'in-flight row never carried any text');
    assert.isTrue(
      'live streamed reply'.startsWith(streamed.content),
      `in-flight text must be a prefix of the committed text, got "${streamed.content}"`,
    );

    // --- teardown, asserted on the same session rather than in a test of its
    // own: `stop()` needs a LIVE subscription and a running merge computation
    // to be worth anything, and a second test would need a second start+send
    // to get them — which the rate-limit budget above does not have room for.
    // Subscriptions are not rate limited (the rules are `type: 'method'`), so
    // re-subscribing below costs nothing against it.
    support.stop(sessionId);
    assert.isFalse(handle.ready(), 'stop() must stop the subscription it created');
    assert.lengthOf(
      support.messages(sessionId).fetch(), 0,
      'stop() must clear the merged view it maintained',
    );
    support.stop(sessionId);          // idempotent: a double unmount must not throw
    support.stop();                   // …with or without the guard argument

    // And it is not one-way: subscribing again rebuilds both halves.
    const second = support.subscribe(sessionId);
    await waitFor('the re-subscription to become ready', 20000, () => second.ready());
    await waitFor('the merged view to repopulate', 20000, () =>
      support.messages(sessionId).fetch()
        .some((m: any) => m.role === 'assistant' && m.content === 'live streamed reply'));
    support.stop();
    } finally {
      try { support.stop(); } catch { /* already stopped */ }
    }
  });
});
