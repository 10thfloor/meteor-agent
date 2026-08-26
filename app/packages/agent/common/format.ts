/** Isomorphic display formatting — shared between client and server. */

/** `18432` → `18 KB`; sizes in admission notes, read refusals, and chips. */
export function prettySize(n: number): string {
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
