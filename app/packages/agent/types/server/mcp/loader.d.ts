/** Same exports-map seam as pi-ai — Meteor can't follow pi-mcp's exports map
 *  either. Resolution is in `providers/loader.ts`; this file names the package.
 *  The MCP client needs only the root entry (`McpClient`, `StdioTransport`). */
export declare const PI_MCP = "@earendil-works/pi-mcp";
/** Absolute path to a pi-mcp entry file via the exports-map resolver. */
export declare function resolvePiMcpEntry(subpath?: string): string;
/** Import a pi-mcp namespace through the hedge. Cached per subpath. */
export declare function loadPiMcp(subpath?: string): Promise<unknown>;
/** Synchronous check for the MCP client library on disk. Cached after first answer. */
export declare function mcpClientResolvable(): boolean;
/** @deprecated The MCP client is `@earendil-works/pi-mcp`, no longer the
 *  official SDK. Same probe under its old name; use `mcpClientResolvable`. */
export declare const mcpSdkResolvable: typeof mcpClientResolvable;
//# sourceMappingURL=loader.d.ts.map