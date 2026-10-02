export declare const PI_DURABLE = "@earendil-works/pi-durable";
export declare const CHORD = "@earendil-works/chord";
export declare const PI_AI = "@earendil-works/pi-ai";
/** `loadPiDurable()` for the harness, `loadPiDurable('testing')` for the conformance suite. */
export declare function loadPiDurable(subpath?: string): Promise<unknown>;
/** `loadChord('context')` for `BACKGROUND_CONTEXT`, `loadChord('delta')` for `apply`. */
export declare function loadChord(subpath?: string): Promise<unknown>;
/**
 * The pi-ai that Pi Durable runs on: `loadPiAi('models')` for `createModels`,
 * `loadPiAi('providers/all')` for `builtinModels`. Build a harness's `models`
 * from this one, whatever other copy of pi-ai the app has.
 */
export declare function loadPiAi(subpath?: string): Promise<unknown>;
export declare function piDurableResolvable(): boolean;
/** What the storage, the host and the publication need at run time. */
export type PiRuntime = {
    /** The whole `@earendil-works/pi-durable` namespace. */
    readonly durable: any;
    readonly Harness: {
        open(storage: any, options: any, context: any): Promise<any>;
    };
    readonly StorageRejected: new (message: string, options?: ErrorOptions) => Error;
    readonly apply: <T>(target: T | undefined, ops: readonly any[]) => T;
    readonly context: any;
};
/** Load both packages once and check they still expose what this package calls. */
export declare function piRuntime(): Promise<PiRuntime>;
//# sourceMappingURL=pi.d.ts.map