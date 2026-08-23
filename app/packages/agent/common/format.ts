/**
 * Isomorphic display formatting. `prettySize` began life beside the
 * attachment store (server/attachments.ts, which re-exports it unchanged);
 * it lives here because the CLIENT renders the same sizes — the element's
 * attachment chips (participants spec §7.3) — and the client bundle has no
 * path to server code.
 */

/** `18432` → `18 KB`; sizes in admission notes, read refusals, and chips. */
export function prettySize(n: number): string {
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
