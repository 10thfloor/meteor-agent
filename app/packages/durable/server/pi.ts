import { loadPackage, resolvePackageEntry } from './loader';

// The one place this package's server code reaches Pi Durable, Chord and
// pi-ai, and the record of what it takes from them. Every shape here was read off the
// installed `dist/*.d.ts` of the pinned versions (pi-durable 1.0.0, chord
// 1.0.0); Pi Durable says its API changes without notice, so a bump is a
// verification event (CONTRIBUTING).
//
// From `@earendil-works/pi-durable` (dist/index.d.ts):
//   Harness.open(storage, options, context): Promise<Harness>   harness/harness.d.ts
//   class StorageRejected extends Error                         errors.d.ts
//     The Session recognises it by identity (`instanceof`), so the storage
//     must throw the class of the same module instance the harness loaded.
//   interface Storage, the 16-method contract                   types.d.ts
//   `./testing`: createStorageConformance({ assertions, withStorage })
// From `@earendil-works/chord`:
//   `./context`: BACKGROUND_CONTEXT, a Context that never cancels
//   `./delta`:   apply(target, ops), which replays a document's deltas
//
// From `@earendil-works/pi-ai`: nothing. Pi Durable depends on it, and an app
// builds the `Models` its harness runs with from it, so `loadPiAi()` hands
// the app the copy Pi Durable itself uses. This package calls none of it.
//
// The client takes one more thing from Chord, by file path, because the
// browser bundler follows no `exports` map either: `applyImmutable` from
// `dist/delta/index.js` (client/conversation.ts).

export const PI_DURABLE = '@earendil-works/pi-durable';
export const CHORD = '@earendil-works/chord';
export const PI_AI = '@earendil-works/pi-ai';

/** `loadPiDurable()` for the harness, `loadPiDurable('testing')` for the conformance suite. */
export function loadPiDurable(subpath?: string): Promise<unknown> {
  return loadPackage(PI_DURABLE, subpath);
}

/** `loadChord('context')` for `BACKGROUND_CONTEXT`, `loadChord('delta')` for `apply`. */
export function loadChord(subpath?: string): Promise<unknown> {
  return loadPackage(CHORD, subpath);
}

/**
 * The pi-ai that Pi Durable runs on: `loadPiAi('models')` for `createModels`,
 * `loadPiAi('providers/all')` for `builtinModels`. Build a harness's `models`
 * from this one, whatever other copy of pi-ai the app has.
 */
export function loadPiAi(subpath?: string): Promise<unknown> {
  return loadPackage(PI_AI, subpath);
}

/** Synchronous check for Pi Durable and Chord on disk. Cached after first answer. */
let onDisk: boolean | null = null;
export function piDurableResolvable(): boolean {
  if (onDisk === null) {
    try {
      resolvePackageEntry(PI_DURABLE);
      resolvePackageEntry(CHORD, 'delta');
      onDisk = true;
    } catch {
      onDisk = false;
    }
  }
  return onDisk;
}

/** What the storage, the host and the publication need at run time. */
export type PiRuntime = {
  /** The whole `@earendil-works/pi-durable` namespace. */
  readonly durable: any;
  readonly Harness: { open(storage: any, options: any, context: any): Promise<any> };
  readonly StorageRejected: new (message: string, options?: ErrorOptions) => Error;
  readonly apply: <T>(target: T | undefined, ops: readonly any[]) => T;
  readonly context: any;
};

let runtime: Promise<PiRuntime> | undefined;

/** Load both packages once and check they still expose what this package calls. */
export function piRuntime(): Promise<PiRuntime> {
  if (runtime === undefined) {
    const loading = (async () => {
      const durable = await loadPiDurable() as any;
      const delta = await loadChord('delta') as any;
      const context = (await loadChord('context') as any)?.BACKGROUND_CONTEXT;
      if (typeof durable?.Harness?.open !== 'function' || typeof durable?.StorageRejected !== 'function') {
        throw new Error('[10thfloor:durable] pi-durable exposes no Harness.open/StorageRejected');
      }
      if (typeof delta?.apply !== 'function' || !context) {
        throw new Error('[10thfloor:durable] chord exposes no delta apply/BACKGROUND_CONTEXT');
      }
      return { durable, Harness: durable.Harness, StorageRejected: durable.StorageRejected, apply: delta.apply, context };
    })();
    runtime = loading;
    loading.catch(() => { if (runtime === loading) runtime = undefined; });
  }
  return runtime;
}
