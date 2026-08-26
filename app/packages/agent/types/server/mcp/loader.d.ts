/** Same exports-map seam as pi-ai — Meteor can't follow the SDK's exports map
 *  either. Resolution is in `providers/loader.ts`; this file names the package
 *  and the three entry points the MCP client uses. */
export declare const MCP_SDK = "@modelcontextprotocol/sdk";
/** Absolute path to an SDK entry file via the exports-map resolver. */
export declare function resolveMcpSdkEntry(subpath?: string): string;
/** Import an SDK namespace through the hedge. Cached per subpath. */
export declare function loadMcpSdk(subpath?: string): Promise<unknown>;
/** Synchronous check for the SDK on disk. Cached after first answer. */
export declare function mcpSdkResolvable(): boolean;
//# sourceMappingURL=loader.d.ts.map