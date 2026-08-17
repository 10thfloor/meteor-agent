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
 * The cost: an authenticated user with N simultaneous connections (tabs,
 * devices) gets N independent buckets instead of one bucket shared by
 * `userId`. That is strictly more generous than pure per-user scoping, never
 * less safe — every (user, connection) pair is still isolated from every
 * other — and it keeps registration to the single `addRule` call promised
 * per configured entry, rather than needing a second rule just to special-
 * case `userId === null`.
 */
function addRuleFor(methodName: string, entry: RateLimitEntry, label: string): void {
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
 * `sends` or `starts` given with a non-positive-integer `count` or
 * `intervalMs` — throws a plain `Error` naming the offending field, so a typo
 * in settings.json fails startup loudly instead of silently shipping an
 * unenforced (or nonsensical) limit.
 */
export function applyRateLimits(settings: unknown): number {
  const rateLimit = (settings as AgentPackageSettings | null | undefined)?.rateLimit;
  if (!rateLimit) return 0;

  let added = 0;
  if (rateLimit.sends) {
    addRuleFor(NAMES.mSend, rateLimit.sends, 'sends');
    added += 1;
  }
  if (rateLimit.starts) {
    addRuleFor(NAMES.mStart, rateLimit.starts, 'starts');
    added += 1;
  }
  return added;
}
