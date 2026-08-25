/**
 * The loader seam for `@modelcontextprotocol/sdk` — the SAME hedge pi-ai goes
 * through, for a package with a slightly different shape.
 *
 * PROBE (@modelcontextprotocol/sdk 1.30.0, read off the installed
 * `package.json` and `dist/esm/**\/*.d.ts`, plus a runtime probe):
 *
 *  - `"type": "module"`, and there is NO `main` at all. Every entry is behind
 *    the `exports` map:
 *      `"."`        → `{ types: ./dist/esm/index.d.ts,
 *                        import: ./dist/esm/index.js,
 *                        require: ./dist/cjs/index.js }`
 *      `"./client"` → `{ …, import: ./dist/esm/client/index.js,
 *                        require: ./dist/cjs/client/index.js }`
 *      `"./*"`      → `{ …, import: ./dist/esm/*, require: ./dist/cjs/* }`
 *    So the transport lives at the WILDCARD key `./client/stdio.js`, which
 *    resolves to `./dist/esm/client/stdio.js`.
 *  - UNLIKE pi-ai, this package is DUAL: every condition set carries a
 *    `require` pointing at a real CJS build, so `createRequire(...).resolve()`
 *    would succeed here where it throws ERR_PACKAGE_PATH_NOT_EXPORTED for
 *    pi-ai. That does NOT make a plain import work under Meteor: Meteor's
 *    resolver cannot follow an `exports` map at all, and neither
 *    `@modelcontextprotocol/sdk/client` nor `…/client/stdio.js` exists as a
 *    real path on disk (the files are under `dist/esm/` and `dist/cjs/`). The
 *    only bare specifier Meteor could resolve is the internal
 *    `…/dist/cjs/client/index.js`, i.e. reaching past the package's own public
 *    surface into its build layout — exactly the coupling this seam exists to
 *    avoid. So: same seam, same three-step hedge, and `loadPackage`'s first
 *    branch (plain `import` of the bare specifier) becomes the live one the day
 *    Meteor ships `exports` support.
 *  - The two names this package needs, confirmed by a runtime probe of the ESM
 *    build: `client/index.js` exports `Client` (plus
 *    `getSupportedElicitationModes`), and `client/stdio.js` exports
 *    `StdioClientTransport`, `getDefaultEnvironment` and
 *    `DEFAULT_INHERITED_ENV_VARS`.
 *
 * The resolver itself is NOT duplicated here. `server/providers/loader.ts`
 * already implements the `exports`-map walk (wildcard keys included — pi-ai
 * needs them for `./providers/*`), the dev/production `node_modules` search and
 * the import → file-URL → temp-shim hedge, and it is the file
 * `scripts/verify-build.sh` re-verifies against a real production bundle. A
 * second copy would be a second thing to keep correct. This file is the
 * SDK-specific half of the seam: the package name, the probe notes, and the
 * three entry points the MCP client uses.
 */
export declare const MCP_SDK = "@modelcontextprotocol/sdk";
/** Absolute path to one of the SDK's entry files, resolved the way Node's ESM
 *  resolver would. `resolveMcpSdkEntry('client')` for the `Client` class,
 *  `resolveMcpSdkEntry('client/stdio.js')` for the stdio transport. */
export declare function resolveMcpSdkEntry(subpath?: string): string;
/**
 * Import an SDK namespace through the hedge. Cached per subpath by
 * `loadPackage`, so the first MCP tool call in a process pays the import and
 * nothing after it does.
 *
 * Nothing outside `server/mcp/` may import the SDK directly — rule 1 of the
 * dependency policy in CONTRIBUTING.md, which now covers two packages.
 */
export declare function loadMcpSdk(subpath?: string): Promise<unknown>;
/**
 * SYNCHRONOUS: is the SDK installed in this app?
 *
 * Nothing in the package's hot path needs this — an MCP tool that cannot load
 * the SDK answers `mcp-unavailable` like any other unreachable server — but a
 * host that wants to fail its own boot when the peer dep is missing has no
 * other way to ask, and the loader tests assert on it. Cached after the first
 * answer, exactly as `typeboxValueResolvable()` is.
 */
export declare function mcpSdkResolvable(): boolean;
//# sourceMappingURL=loader.d.ts.map