/**
 * Resolve a pi-ai entry file the way Node's own ESM resolver would, which
 * understands `exports` maps (Meteor's does not — the whole reason this file
 * exists). We do NOT use `createRequire(...).resolve()` here: that walks the
 * CJS resolution algorithm, which only honors the `require`/`node`/`default`
 * conditions — never `import`. pi-ai's package.json declares `type: module`
 * and an `exports["."]` with only `types`/`import` conditions (no `require`,
 * no `default`), so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * even though a perfectly good ESM entry exists (verified empirically against
 * the installed package). Instead we read the package's own package.json and
 * pick its entry the same way the ESM resolver would: `exports[key].import`
 * (or `.default`), falling back to `main` for CJS-style packages.
 *
 * `subpath` selects a deep export, e.g. `'providers/all'`. Exported as a test
 * seam.
 */
export declare function resolvePackageEntry(pkg: string, subpath?: string): string;
/** pi-ai's entry. Kept as its own export: it is the name the M1/M2 tests and
 *  every comment in this package already use. */
export declare function resolvePiAiEntry(subpath?: string): string;
/** typebox's entry — `resolveTypeboxEntry('value')` for the `Value` module. */
export declare function resolveTypeboxEntry(subpath?: string): string;
/**
 * Import an absolute file:// URL through a genuine ESM module. The shim lives
 * in the OS temp dir — always writable, unlike node_modules on a read-only
 * container filesystem (the M1 shim's fatal flaw). Because it receives a
 * RESOLVED URL rather than a bare specifier, the shim's own location has no
 * bearing on resolution, which is what makes the temp dir usable at all.
 */
export declare function shimLoad(urlHref: string): Promise<unknown>;
/**
 * Hedged, in order of preference:
 *  1. plain dynamic import of the bare specifier — becomes the only path the
 *     day Meteor ships `exports` support (PR #13520);
 *  2. dynamic import of the resolved file:// URL — works today in dev, no
 *     writes anywhere;
 *  3. temp-dir shim around the same URL — for a runtime whose import() is
 *     intercepted.
 * Returns the module namespace AS-IS (live bindings preserved); callers must
 * not mutate it.
 *
 * `subpath` loads a deep export instead of the root one — `'providers/all'`
 * for the built-in model catalog. Each key is cached separately.
 */
export declare function loadPackage(pkg: string, subpath?: string): Promise<unknown>;
export declare function loadPiAi(subpath?: string): Promise<unknown>;
/**
 * typebox through the same three-step hedge. `loadTypebox('value')` yields the
 * namespace whose `Value.Check` is the full JSON-Schema checker behind
 * `validateToolArgs` — see `server/tools.ts` for the probe that established
 * this is the ONLY route (pi-ai re-exports `Type`, never `Value`).
 */
export declare function loadTypebox(subpath?: string): Promise<unknown>;
export declare function typeboxValueResolvable(): boolean;
//# sourceMappingURL=loader.d.ts.map