import { loadPackage, resolvePackageEntry } from '../providers/loader';

/** Same exports-map seam as pi-ai — Meteor can't follow pi-mcp's exports map
 *  either. Resolution is in `providers/loader.ts`; this file names the package.
 *  The MCP client needs only the root entry (`McpClient`, `StdioTransport`). */
export const PI_MCP = '@earendil-works/pi-mcp';

/** Absolute path to a pi-mcp entry file via the exports-map resolver. */
export function resolvePiMcpEntry(subpath?: string): string {
  return resolvePackageEntry(PI_MCP, subpath);
}

/** Import a pi-mcp namespace through the hedge. Cached per subpath. */
export function loadPiMcp(subpath?: string): Promise<unknown> {
  return loadPackage(PI_MCP, subpath);
}

let onDisk: boolean | null = null;

/** Synchronous check for the MCP client library on disk. Cached after first answer. */
export function mcpClientResolvable(): boolean {
  if (onDisk === null) {
    try {
      onDisk = typeof resolvePiMcpEntry() === 'string';
    } catch {
      onDisk = false;
    }
  }
  return onDisk;
}

/** @deprecated The MCP client is `@earendil-works/pi-mcp`, no longer the
 *  official SDK. Same probe under its old name; use `mcpClientResolvable`. */
export const mcpSdkResolvable = mcpClientResolvable;
