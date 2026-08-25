/**
 * Register DDP rate-limit rules from `Meteor.settings.packages['10thfloor:agent']`.
 *
 * Returns the number of rules added — the test seam: startup calls this with
 * real settings, tests call it with fixtures. Two rules per METHOD, and two
 * entries govern two methods each (`starts` → `agent.start`/`agent.fork`,
 * `approvals` → `agent.approve`/`agent.deny`), so each of those adds four.
 *
 * A missing/empty settings path (no `packages['10thfloor:agent']`, or no
 * `rateLimit` on it) adds nothing and never throws, so a deployment that
 * hasn't configured rate limits still boots. A PRESENT but malformed entry —
 * any of `sends`, `starts`, `interrupts`, `approvals` or `compacts` given with
 * a non-positive-integer `count` or `intervalMs` — throws a plain `Error`
 * naming the offending field, so a typo
 * in settings.json fails startup loudly instead of silently shipping an
 * unenforced (or nonsensical) limit.
 */
export declare function applyRateLimits(settings: unknown): number;
//# sourceMappingURL=rate-limits.d.ts.map