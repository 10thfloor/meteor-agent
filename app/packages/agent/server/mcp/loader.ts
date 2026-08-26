import { loadPackage, resolvePackageEntry } from '../providers/loader';

/** Same exports-map seam as pi-ai — Meteor can't follow the SDK's exports map
 *  either. Resolution is in `providers/loader.ts`; this file names the package
 *  and the three entry points the MCP client uses. */
export const MCP_SDK = '@modelcontextprotocol/sdk';

/** Absolute path to an SDK entry file via the exports-map resolver. */
export function resolveMcpSdkEntry(subpath?: string): string {
  return resolvePackageEntry(MCP_SDK, subpath);
}

/** Import an SDK namespace through the hedge. Cached per subpath. */
export function loadMcpSdk(subpath?: string): Promise<unknown> {
  return loadPackage(MCP_SDK, subpath);
}

let onDisk: boolean | null = null;

/** Synchronous check for the SDK on disk. Cached after first answer. */
export function mcpSdkResolvable(): boolean {
  if (onDisk === null) {
    try {
      onDisk = typeof resolveMcpSdkEntry('client') === 'string';
    } catch {
      onDisk = false;
    }
  }
  return onDisk;
}
