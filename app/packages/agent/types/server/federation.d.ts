/** A small, stateless MCP surface for exposing an explicitly selected slice of
 * a Constellation. Authentication and target resolution are re-checked at the
 * dispatch boundary, so disabling, rotating, archiving, or changing the
 * allowlist revokes the next call without restarting the server. */
export declare const FEDERATION_MCP_PATH = "/constellation/mcp";
export declare const FEDERATION_PROTOCOL_VERSION = "2025-11-25";
export declare const FEDERATION_PROMPT_MAX = 50000;
export declare const FEDERATION_BODY_MAX: number;
export interface FederationGrant {
    ownerId: string;
    agentIds: string[];
    missionIds: string[];
    revision: number;
}
export interface FederationTarget {
    kind: 'agent' | 'mission';
    id: string;
    displayName: string;
    description?: string;
}
export interface FederationDependencies {
    /** Return null for disabled, expired, rotated, malformed, or unknown tokens. */
    resolveGrant(token: string): Promise<FederationGrant | null>;
    /** Resolve only targets which are still active and owned by the grant owner. */
    resolveTargets(grant: FederationGrant): Promise<FederationTarget[]>;
    invoke(target: FederationTarget, prompt: string, grant: FederationGrant): Promise<string>;
}
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: unknown;
}
export type JsonRpcResponse = {
    jsonrpc: '2.0';
    id: string | number | null;
    result: unknown;
} | {
    jsonrpc: '2.0';
    id: string | number | null;
    error: {
        code: number;
        message: string;
    };
};
export interface FederationDispatchResult {
    status: number;
    response?: JsonRpcResponse;
}
export declare function hashFederationToken(token: string): string;
export declare function issueFederationToken(): {
    token: string;
    tokenHash: string;
    tokenHint: string;
};
export declare function federationTokenMatches(token: string, expectedHash: string): boolean;
export declare function isLoopbackAddress(address: unknown): boolean;
/** Stable and collision-resistant even when two display/runtime ids slugify to
 * the same MCP name. The hash is an identifier checksum, not a credential. */
export declare function federationToolName(target: Pick<FederationTarget, 'kind' | 'id'>): string;
/** Process one stateless MCP JSON-RPC message. The bearer is re-resolved for
 * tools/call after all catalog/setup work and immediately before invocation. */
export declare function dispatchFederationMcp(bearerToken: string, rawRequest: unknown, dependencies: FederationDependencies): Promise<FederationDispatchResult>;
//# sourceMappingURL=federation.d.ts.map