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
    starts?: RateLimitEntry;
    /**
     * `agent.interrupt`. It starts no model call, so it is not the spend
     * vector `sends` is — but it is an unauthenticated-reachable WRITE
     * (`phase: 'stopped'` on every call, against any session id the caller
     * owns) and it is the one method a UI can fire from a button held down.
     * Left unlimited, a flood of interrupts is a free write amplifier against
     * Mongo and, aimed at a session with a turn in flight, a way to keep
     * cancelling work faster than it can start.
     */
    interrupts?: RateLimitEntry;
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

/**
 * Register one DDPRateLimiter rule for `methodName` from a validated entry.
 *
 * Bucket by the PAIR (userId, connectionId), not by userId alone.
 *
 * DDPRateLimiter buckets counters on the actual value of every key present
 * in the matcher (see meteor/rate-limit's `Rule._generateKeyString`),
 * regardless of whether that key's matcher is a literal or an always-true
 * function — so listing a key at all is what turns it into a bucketing
 * dimension. Using only `userId` would put every anonymous caller in ONE
 * shared bucket: `this.userId` is `null` for every anonymous connection (see
 * publications.ts), so a single flooding anonymous connection would exhaust
 * the quota for every *other* anonymous visitor too — a denial-of-service
 * against legitimate anonymous users, not just the attacker. Adding
 * `connectionId` to the same matcher splits that shared bucket per
 * connection, so an anonymous flood only ever burns its own quota.
 *
 * The cost of per-connection bucketing is real and must be capped, not
 * hand-waved: an AUTHENTICATED attacker can open N DDP connections under one
 * login with a few lines of WebSocket scripting and get N independent
 * buckets — a rate-limit bypass in front of paid model calls. So each entry
 * registers a SECOND, per-user rule for authenticated callers only
 * (`userId: (id) => id != null` — no `connectionId`, so it buckets on userId
 * alone). The pair-rule handles anonymous isolation; the user-rule caps the
 * multi-connection multiplication. Legitimate multi-tab users share one
 * per-user allowance, which is the semantics a per-user limit promises
 * anyway. Session budgets (§9) remain the spend backstop behind both.
 */
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
      // Authenticated callers only: anonymous (null) stays governed by the
      // per-connection rule above — a userId-only rule would put every
      // anonymous visitor in one shared bucket, the exact DoS the pair rule
      // exists to prevent.
      userId: (id: string | null) => id != null,
    },
    entry.count,
    entry.intervalMs,
  );
  return 2;
}

/**
 * Register DDP rate-limit rules from `Meteor.settings.packages['10thfloor:agent']`.
 *
 * Returns the number of rules added — the test seam: startup calls this with
 * real settings, tests call it with fixtures.
 *
 * A missing/empty settings path (no `packages['10thfloor:agent']`, or no
 * `rateLimit` on it) adds nothing and never throws, so a deployment that
 * hasn't configured rate limits still boots. A PRESENT but malformed entry —
 * `sends`, `starts` or `interrupts` given with a non-positive-integer `count`
 * or `intervalMs` — throws a plain `Error` naming the offending field, so a typo
 * in settings.json fails startup loudly instead of silently shipping an
 * unenforced (or nonsensical) limit.
 */
export function applyRateLimits(settings: unknown): number {
  const rateLimit = (settings as AgentPackageSettings | null | undefined)?.rateLimit;
  if (!rateLimit) return 0;

  let added = 0;
  if (rateLimit.sends) added += addRuleFor(NAMES.mSend, rateLimit.sends, 'sends');
  if (rateLimit.starts) added += addRuleFor(NAMES.mStart, rateLimit.starts, 'starts');
  if (rateLimit.interrupts) {
    added += addRuleFor(NAMES.mInterrupt, rateLimit.interrupts, 'interrupts');
  }
  return added;
}
