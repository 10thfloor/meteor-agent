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
  run(
    request: IsolatedExecutionRequest,
    context: { signal: AbortSignal; onOutput: (chunk: IsolatedExecutionOutput) => void },
  ): Promise<{ exitCode: number | null }>;
}

export interface IsolatedExecutionOptions {
  signal?: AbortSignal;
  /** Receives only bounded output. Called synchronously in emission order;
   * throwing requests cancellation and is rethrown after the provider settles. */
  onOutput?: (chunk: IsolatedExecutionOutput) => void;
}

export type IsolatedExecutionInterruption = 'cancelled' | 'timeout' | 'output-limit';

export class IsolatedExecutionError extends Error {
  readonly code: IsolatedExecutionInterruption;
  readonly result: IsolatedExecutionResult;

  constructor(code: IsolatedExecutionInterruption, result: IsolatedExecutionResult) {
    super(code === 'timeout' ? 'The execution reached its time limit.'
      : code === 'output-limit' ? 'The execution reached its output limit.'
        : 'The execution was cancelled.');
    this.name = 'IsolatedExecutionError';
    this.code = code;
    this.result = result;
  }
}

function validateRequest(request: IsolatedExecutionRequest): IsolatedExecutionRequest {
  if (!request || typeof request.workspaceId !== 'string'
    || !request.workspaceId.trim() || request.workspaceId.includes('\0')
    || !Array.isArray(request.command) || !request.command.length
    || !request.command[0] || request.command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || (request.stdin !== undefined && typeof request.stdin !== 'string')
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1
    || request.maxOutputBytes > 16 * 1024 * 1024) {
    throw new TypeError('An isolated execution requires a workspace, argv, a positive timeout, and an output limit of at most 16 MiB.');
  }
  // Copy only the contract fields: caller/provider mutations and undeclared
  // env/host-path fields cannot silently broaden this boundary.
  return {
    workspaceId: request.workspaceId, command: [...request.command],
    ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes,
  };
}

/** Run through a cooperative sandbox provider. There is deliberately no
 * Promise.race: a timeout is a request to stop real work, not permission to
 * leave it running invisibly. A provider that cannot confirm termination must
 * report cleanup-unconfirmed / stop-unconfirmed rather than resolving or merely
 * throwing AbortError. A stop failure must never imply permission to delete a
 * retained environment. */
export async function runIsolatedExecution(
  provider: IsolatedExecutionProvider,
  request: IsolatedExecutionRequest,
  options: IsolatedExecutionOptions = {},
): Promise<IsolatedExecutionResult> {
  const input = validateRequest(request);
  if (!provider || typeof provider.run !== 'function') throw new TypeError('An isolated execution provider is required.');
  const maxOutputBytes = input.maxOutputBytes;
  const abort = new AbortController();
  const result: IsolatedExecutionResult = {
    exitCode: null, stdout: '', stderr: '', outputBytes: 0, truncated: false,
  };
  let interruption: IsolatedExecutionInterruption | undefined;
  let callbackFailure: unknown;
  let callbackFailed = false;
  let finished = false;
  const interrupt = (code: IsolatedExecutionInterruption): void => {
    if (finished || interruption) return;
    interruption = code;
    abort.abort(new IsolatedExecutionError(code, { ...result }));
  };
  const cancel = (): void => interrupt('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timeout = setTimeout(() => interrupt('timeout'), input.timeoutMs);
  (timeout as any).unref?.();
  try {
    if (interruption) throw new IsolatedExecutionError(interruption, { ...result });
    let completion: { exitCode: number | null } | undefined;
    let providerFailure: unknown;
    let providerFailed = false;
    try {
      completion = await provider.run(input, {
        signal: abort.signal,
        onOutput(chunk) {
          if (finished || abort.signal.aborted) return;
          if (!chunk || (chunk.stream !== 'stdout' && chunk.stream !== 'stderr') || typeof chunk.text !== 'string') {
            callbackFailure = new TypeError('An execution provider emitted invalid output.');
            callbackFailed = true;
            cancel();
            return;
          }
          const bytes = Buffer.from(chunk.text, 'utf8');
          const remaining = maxOutputBytes - result.outputBytes;
          let end = Math.min(bytes.length, remaining);
          // Do not turn an incomplete multibyte character into a replacement
          // character that would itself exceed the remaining byte allowance.
          while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
          const text = bytes.subarray(0, end).toString('utf8');
          const overflow = bytes.length > remaining;
          result[chunk.stream] += text;
          result.outputBytes += end;
          if (overflow) result.truncated = true;
          if (text && options.onOutput) {
            try { options.onOutput({ stream: chunk.stream, text }); }
            catch (error) {
              callbackFailure = error;
              callbackFailed = true;
              cancel();
            }
          }
          if (overflow) interrupt('output-limit');
        },
      });
    } catch (error) {
      providerFailure = error;
      providerFailed = true;
    }
    // Lost confirmation is more important than why cancellation was requested.
    // Preserve the adapter's receipt/cleanup metadata for durable host recovery.
    if (providerFailed && ['cleanup-unconfirmed', 'stop-unconfirmed'].includes((providerFailure as { code?: string })?.code ?? '')) throw providerFailure;
    if (callbackFailed) throw callbackFailure;
    if (interruption) throw new IsolatedExecutionError(interruption, { ...result });
    if (providerFailed) throw providerFailure;
    if (!completion || (completion.exitCode !== null && !Number.isSafeInteger(completion.exitCode))) {
      throw new TypeError('An execution provider returned an invalid exit code.');
    }
    result.exitCode = completion.exitCode;
    return { ...result };
  } finally {
    finished = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
