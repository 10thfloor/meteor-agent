import { assert } from 'chai';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';
import {
  AgentSessions, AgentMessages, AgentDeltas,
} from '../common/collections';
import { ACTIVE_PHASES, DECIDED_PHASES, type Phase } from '../common/types';

describe('10thfloor:agent scaffold', () => {
  it('exposes stable collection names', () => {
    assert.equal(NAMES.sessions, 'agent_sessions');
    assert.equal(NAMES.messages, 'agent_messages');
    assert.equal(NAMES.deltas, 'agent_deltas');
  });

  it('sizes the delta cap in bytes', () => {
    assert.isAbove(DELTA_CAP_BYTES, 1024 * 1024);
  });
});

/**
 * H-DECIDED-PHASES. `ACTIVE_PHASES` (running) and `DECIDED_PHASES` (settled)
 * are each a single definition in `common/types` precisely so the six inline
 * copies of the terminal list cannot drift. This pins the invariant that gives
 * them meaning: the two are disjoint and together cover every `Phase` except
 * the one deliberately-neither phase, `idle`. Enumerating the whole union here
 * means adding a new `Phase` breaks this test until it is classified as active,
 * decided, or explicitly neither — the compile-time union has no other guard.
 */
describe('phase classification is a partition (H-DECIDED-PHASES)', () => {
  const ALL_PHASES: Phase[] = [
    'idle', 'streaming', 'calling', 'awaiting',
    'compacting', 'retrying', 'stopped', 'error',
  ];
  const NEITHER: Phase[] = ['idle'];

  it('active and decided sets do not overlap', () => {
    const overlap = ACTIVE_PHASES.filter((p) => DECIDED_PHASES.includes(p));
    assert.deepEqual(overlap, [], `phases in both ACTIVE and DECIDED: ${overlap.join(', ')}`);
  });

  it('active + decided + neither cover every Phase exactly once', () => {
    const union = [...ACTIVE_PHASES, ...DECIDED_PHASES, ...NEITHER].sort();
    assert.deepEqual(
      union,
      [...ALL_PHASES].sort(),
      'every Phase must be classified as active, decided, or explicitly neither',
    );
    assert.equal(
      union.length,
      new Set(union).size,
      'no Phase may appear in more than one classification',
    );
  });

  it('pins the exact decided set', () => {
    assert.deepEqual([...DECIDED_PHASES].sort(), ['awaiting', 'error', 'stopped']);
  });
});

/**
 * H-DENY. The startup registers a blanket client-write `deny` on all three
 * collections (see `denyAllClientWrites` in server/index.ts), so that a host app
 * shipping Meteor's default `insecure` package cannot inherit direct write
 * access. Meteor's allow-deny package stores each collection's registered
 * validators on `collection._validators.{insert,update,remove}.deny` and flips
 * `collection._restricted` true the moment any deny rule registers — with that
 * flag set, `insecure` grants nothing.
 *
 * The deny is applied inside the package's async `Meteor.startup`, AFTER
 * `ensureCapped`/`ensureIndexes` await real Mongo work. This suite's very first
 * test file can therefore run before that boot finishes, so the assertion polls
 * for the deny to land rather than assuming it already has (the same async-boot
 * reality every other server test lives with).
 */
const waitFor = async (cond: () => boolean, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

describe('safety by construction (H-DENY)', () => {
  const denyLen = (c: any, op: string): number =>
    (c as any)._validators?.[op]?.deny?.length ?? 0;
  const denied = (c: any): boolean =>
    denyLen(c, 'insert') > 0 && denyLen(c, 'update') > 0 && denyLen(c, 'remove') > 0;

  for (const [label, c] of [
    ['sessions', AgentSessions], ['messages', AgentMessages], ['deltas', AgentDeltas],
  ] as const) {
    it(`denies all client writes to ${label}`, async function () {
      this.timeout(30000);
      await waitFor(() => denied(c), `${label} to have its blanket deny registered`);
      assert.isAbove(denyLen(c, 'insert'), 0, `${label}: insert must be denied`);
      assert.isAbove(denyLen(c, 'update'), 0, `${label}: update must be denied`);
      assert.isAbove(denyLen(c, 'remove'), 0, `${label}: remove must be denied`);
      assert.isTrue((c as any)._restricted, `${label} must be in restricted mode`);
    });
  }
});

/**
 * H-DEFAULTS. The uncapped-agent warning is a startup side effect (it already
 * ran when this package booted); this pins that its inputs — the registry
 * iterator it walks — are present and that walking them cannot throw, which is
 * the whole contract the finding asked of the package.
 */
describe('production-ceiling warning (H-DEFAULTS)', () => {
  it('exposes a registry iterator and can scan it without throwing', async () => {
    const { listAgents } = await import('../server/registry');
    assert.isFunction(listAgents);
    assert.doesNotThrow(() => {
      for (const [name, config] of listAgents()) {
        assert.isString(name);
        assert.isObject(config);
      }
    });
  });
});
