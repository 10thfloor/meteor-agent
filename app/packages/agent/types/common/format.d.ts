/**
 * Isomorphic display formatting. `prettySize` began life beside the
 * attachment store (server/attachments.ts, which re-exports it unchanged);
 * it lives here because the CLIENT renders the same sizes — the element's
 * attachment chips (participants spec §7.3) — and the client bundle has no
 * path to server code.
 */
/** `18432` → `18 KB`; sizes in admission notes, read refusals, and chips. */
export declare function prettySize(n: number): string;
//# sourceMappingURL=format.d.ts.map