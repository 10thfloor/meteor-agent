// S2b — is a plain object REALLY sufficient, or is DDPCommon.MethodInvocation
// required? S2 conflated two things: a plain object as ambient carrier vs. as
// the invocation a handler actually receives. Meteor.callAsync builds its own
// invocation internally, so S2 never tested the second case.
import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';

const EV = DDP._CurrentMethodInvocation;

// A method exercising the FULL invocation surface a real one would use.
Meteor.methods({
  'spike.surface'() {
    return {
      ctor: this.constructor?.name,
      userId: this.userId,
      hasUnblock: typeof this.unblock,
      hasSetUserId: typeof this.setUserId,
      isSimulation: this.isSimulation,
      connection: this.connection === null ? 'null' : typeof this.connection,
      hasRandomSeed: 'randomSeed' in this,
    };
  },
  'spike.usesUnblock'() {
    this.unblock();
    return `unblocked:${this.userId}`;
  },
  async 'spike.limited'() {
    return 'ok';
  },
});

DDPRateLimiter.addRule({ type: 'method', name: 'spike.limited' }, 2, 60_000);

export async function s2bReport() {
  const detail = {};

  // (a) What does a handler ACTUALLY receive via Meteor.callAsync under a
  //     plain-object ambient context?
  detail.viaCallAsync = await EV.withValue({ userId: 'u1', isSimulation: false }, async () =>
    Meteor.callAsync('spike.surface'),
  );

  // (b) Does a method that calls this.unblock() survive that path?
  try {
    detail.unblockViaCallAsync = await EV.withValue({ userId: 'u2', isSimulation: false }, async () =>
      Meteor.callAsync('spike.usesUnblock'),
    );
  } catch (e) {
    detail.unblockViaCallAsync = { error: e.message };
  }

  // (c) DIRECT handler invocation with a plain object as `this` — the case S2
  //     never covered. This is what happens if the harness bypasses callAsync.
  const handler = Meteor.server.method_handlers['spike.usesUnblock'];
  detail.directWithPlainObject = await (async () => {
    try {
      const r = await handler.call({ userId: 'u3', isSimulation: false }, {});
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })();

  // (d) Is DDPCommon reachable, and does a real MethodInvocation fix (c)?
  let DDPCommon = null;
  try {
    ({ DDPCommon } = require('meteor/ddp-common'));
    detail.ddpCommonAvailable = typeof DDPCommon?.MethodInvocation === 'function';
  } catch (e) {
    detail.ddpCommonAvailable = false;
    detail.ddpCommonError = e.message.split('\n')[0];
  }

  if (detail.ddpCommonAvailable) {
    const inv = new DDPCommon.MethodInvocation({
      isSimulation: false,
      userId: 'u4',
      connection: null,
      randomSeed: null,
    });
    detail.realInvocationSurface = {
      hasUnblock: typeof inv.unblock,
      hasSetUserId: typeof inv.setUserId,
      userId: inv.userId,
    };
    detail.directWithRealInvocation = await (async () => {
      try {
        const r = await handler.call(inv, {});
        return { ok: true, result: r };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
  }

  // (e) SPEC CLAIM CHECK: does DDPRateLimiter apply to server-side calls?
  //     §7 claims adopted methods get their rate limits "already enforced".
  const limitedResults = [];
  for (let i = 0; i < 5; i += 1) {
    try {
      limitedResults.push(
        await EV.withValue({ userId: 'u5', isSimulation: false }, async () =>
          Meteor.callAsync('spike.limited'),
        ),
      );
    } catch (e) {
      limitedResults.push(`ERR:${e.error || e.message}`);
    }
  }
  detail.rateLimiterOnServerCalls = {
    ruleAllows: 2,
    attempts: 5,
    results: limitedResults,
    enforced: limitedResults.some((r) => String(r).startsWith('ERR:')),
  };

  return { detail };
}
