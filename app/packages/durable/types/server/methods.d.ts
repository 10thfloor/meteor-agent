export declare function registerMethods(): void;
/**
 * Register DDP rate-limit rules from the package settings and return how many
 * were added. Missing settings add none; a malformed entry throws.
 *
 * - `submits`: `durable.submit`. Each one may buy a model request.
 * - `creates`: `durable.root`, `durable.create`, `durable.fork`.
 * - `controls`: `durable.abort`, `durable.withdraw`, `durable.reset`, `durable.compact`.
 */
export declare function applyRateLimits(settings: unknown): number;
//# sourceMappingURL=methods.d.ts.map