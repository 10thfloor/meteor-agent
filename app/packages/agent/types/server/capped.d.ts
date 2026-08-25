/** Create the delta collection as capped. Idempotent: a NamespaceExists error
 *  (code 48) means a collection of that name already exists — but code 48 fires
 *  whether or not that existing collection is actually capped. If it were ever
 *  created as a normal collection (a stray write, a migration, an ops action),
 *  silently swallowing the error would report success while leaving an
 *  unbounded collection in place, defeating the whole self-managing-eviction
 *  design. So on that path we verify capped-ness explicitly via collStats and
 *  fail loudly if it is not capped, rather than converting or dropping data
 *  someone may care about. */
export declare function ensureCapped(): Promise<void>;
//# sourceMappingURL=capped.d.ts.map