/**
 * Resolve a package entry through its exports map (Meteor's resolver can't).
 * `from` is where the search for `node_modules` starts: the server's working
 * directory, except in tests.
 */
export declare function resolvePackageEntry(pkg: string, subpath?: string, from?: string): string;
/**
 * Three-step hedge: bare import → file:// URL → temp shim. Cached per subpath.
 * A package that is resolved from Pi Durable's side skips the bare import,
 * which could only ever name the shared copy.
 */
export declare function loadPackage(pkg: string, subpath?: string): Promise<unknown>;
//# sourceMappingURL=loader.d.ts.map