/** A provider-neutral boundary for code that MUST run outside the Meteor
 * process. This module does not itself create a sandbox, grant network/file
 * access, or persist jobs. Those are explicit responsibilities of the host
 * and the selected provider. Never implement a provider with in-process eval. */
export interface IsolatedExecutionRequest {
    /** Opaque, host-authorized workspace identity, not an arbitrary host path. */
    workspaceId: string;
    /** Executable and argv. No implicit shell interpretation. */
    command: string[];
    stdin?: string;
    timeoutMs: number;
    /** Combined stdout/stderr UTF-8 byte ceiling, enforced before delivery. */
    maxOutputBytes: number;
}
export interface IsolatedExecutionOutput {
    stream: 'stdout' | 'stderr';
    text: string;
}
export interface IsolatedExecutionResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputBytes: number;
    truncated: boolean;
}
export interface IsolatedExecutionProvider {
    /** MUST honor signal, terminate the exact execution, and settle only after
     * termination/cleanup is confirmed. An uncertain cleanup MUST reject with
     * code `cleanup-unconfirmed`, or `stop-unconfirmed` when a retained workspace
     * must be quarantined (the runner preserves these errors). Closing a
     * transport or racing an abort Promise is not proof of remote termination.
     * Providers own isolation and resource/egress policy, must not inherit host
     * credentials, and must not call onOutput after this Promise settles. */
    run(request: IsolatedExecutionRequest, context: {
        signal: AbortSignal;
        onOutput: (chunk: IsolatedExecutionOutput) => void;
    }): Promise<{
        exitCode: number | null;
    }>;
}
export interface IsolatedExecutionOptions {
    signal?: AbortSignal;
    /** Receives only bounded output. Called synchronously in emission order;
     * throwing requests cancellation and is rethrown after the provider settles. */
    onOutput?: (chunk: IsolatedExecutionOutput) => void;
}
export type IsolatedExecutionInterruption = 'cancelled' | 'timeout' | 'output-limit';
export declare class IsolatedExecutionError extends Error {
    readonly code: IsolatedExecutionInterruption;
    readonly result: IsolatedExecutionResult;
    constructor(code: IsolatedExecutionInterruption, result: IsolatedExecutionResult);
}
/** Run through a cooperative sandbox provider. There is deliberately no
 * Promise.race: a timeout is a request to stop real work, not permission to
 * leave it running invisibly. A provider that cannot confirm termination must
 * report cleanup-unconfirmed / stop-unconfirmed rather than resolving or merely
 * throwing AbortError. A stop failure must never imply permission to delete a
 * retained environment. */
export declare function runIsolatedExecution(provider: IsolatedExecutionProvider, request: IsolatedExecutionRequest, options?: IsolatedExecutionOptions): Promise<IsolatedExecutionResult>;
//# sourceMappingURL=execution.d.ts.map