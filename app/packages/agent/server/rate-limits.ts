import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { NAMES } from '../common/names';

/** One entry of `Meteor.settings.packages['10thfloor:agent'].rateLimit`. */
interface RateLimitEntry {
  count: number;
  intervalMs: number;
}

interface AgentPackageSettings {
  rateLimit?: {
    sends?: RateLimitEntry;
    /** `agent.start` AND `agent.fork` — both create a session, and the fork
     *  additionally copies a whole transcript. One entry, two methods; see
     *  `applyRateLimits`. */
    starts?: RateLimitEntry;
    /** `agent.interrupt` — unauthenticated-reachable write; unlimited, it
     *  becomes a write amplifier or a cancel-faster-than-start loop. */
    interrupts?: RateLimitEntry;
    /** `agent.approve` + `agent.deny` — one entry. They share a budget because
     *  they are the same decision; separate knobs let deny bypass approve. */
    approvals?: RateLimitEntry;
    /** `agent.compact` — each call buys a provider round trip (summarization);
     *  no turn budget applies, so this is the spend backstop. */
    compacts?: RateLimitEntry;
    /** Memory methods — `search` is the expensive one (embedding at query time). */
    memories?: RateLimitEntry;
  };
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `10thfloor:agent: settings.rateLimit.${field} must be a positive integer `
      + `(got ${JSON.stringify(value)})`,
    );
  }
}

/** Register one rate-limit rule. Buckets by (userId, connectionId) for anonymous
 *  isolation, plus a per-userId rule for authenticated multi-connection capping. */
function addRuleFor(methodName: string, entry: RateLimitEntry, label: string): number {
  assertPositiveInteger(entry.count, `${label}.count`);
  assertPositiveInteger(entry.intervalMs, `${label}.intervalMs`);

  DDPRateLimiter.addRule(
    {
      type: 'method',
      name: methodName,
      userId: () => true,
      connectionId: () => true,
    },
    entry.count,
    entry.intervalMs,
  );
  DDPRateLimiter.addRule(
    {
      type: 'method',
      name: methodName,
      // Authenticated only — see addRuleFor's doc for the anonymous-bucket rationale.
      userId: (id: string | null) => id != null,
    },
    entry.count,
    entry.intervalMs,
  );
  return 2;
}

/** Register DDP rate-limit rules from package settings. Returns rule count
 *  (the test seam). Missing settings = no rules; malformed entries throw. */
export function applyRateLimits(settings: unknown): number {
  const rateLimit = (settings as AgentPackageSettings | null | undefined)?.rateLimit;
  if (!rateLimit) return 0;

  let added = 0;
  if (rateLimit.sends) {
    added += addRuleFor(NAMES.mSend, rateLimit.sends, 'sends');
    // A crew note buys no provider call, but is still a transcript write. It
    // shares the input budget so `contribute` cannot bypass a deployment's
    // anti-flood ceiling by selecting the non-waking composer mode.
    added += addRuleFor(NAMES.mContribute, rateLimit.sends, 'sends');
  }
  if (rateLimit.starts) {
    added += addRuleFor(NAMES.mStart, rateLimit.starts, 'starts');
    // Fork shares the `starts` budget — it creates a session too, and a
    // separate knob would let it bypass the start limit.
    added += addRuleFor(NAMES.mFork, rateLimit.starts, 'starts');
  }
  if (rateLimit.interrupts) {
    added += addRuleFor(NAMES.mInterrupt, rateLimit.interrupts, 'interrupts');
  }
  if (rateLimit.approvals) {
    // Two methods, one entry — same per-method bucketing shape as starts.
    added += addRuleFor(NAMES.mApprove, rateLimit.approvals, 'approvals');
    added += addRuleFor(NAMES.mDeny, rateLimit.approvals, 'approvals');
  }
  if (rateLimit.compacts) {
    // Separate from `sends` — same cost, but operators tune them apart.
    added += addRuleFor(NAMES.mCompact, rateLimit.compacts, 'compacts');
  }
  if (rateLimit.memories) {
    // One entry, three methods — the `approvals` shape: they are one surface
    // an operator tunes together, and giving `search` its own knob would just
    // make the cheap methods the way around the expensive one's limit.
    added += addRuleFor(NAMES.mMemorySave, rateLimit.memories, 'memories');
    added += addRuleFor(NAMES.mMemorySearch, rateLimit.memories, 'memories');
    added += addRuleFor(NAMES.mMemoryForget, rateLimit.memories, 'memories');
  }
  return added;
}
