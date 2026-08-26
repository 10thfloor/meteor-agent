/** Resolve a package entry through its exports map (Meteor's resolver can't). */
export declare function resolvePackageEntry(pkg: string, subpath?: string): string;
/** pi-ai's entry. */
export declare function resolvePiAiEntry(subpath?: string): string;
/** typebox's entry — `resolveTypeboxEntry('value')` for the `Value` module. */
export declare function resolveTypeboxEntry(subpath?: string): string;
/** Import a file:// URL through a temp ESM shim (Meteor's CJS bundle has no
 *  dynamic import). Shim lives in tmpdir so it works on read-only filesystems. */
export declare function shimLoad(urlHref: string): Promise<unknown>;
/** Three-step hedge: bare import → file:// URL → temp shim. Cached per subpath. */
export declare function loadPackage(pkg: string, subpath?: string): Promise<unknown>;
export declare function loadPiAi(subpath?: string): Promise<unknown>;
/** typebox through the same hedge. `loadTypebox('value')` for `Value.Check`. */
export declare function loadTypebox(subpath?: string): Promise<unknown>;
export declare function typeboxValueResolvable(): boolean;
//# sourceMappingURL=loader.d.ts.map