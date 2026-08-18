/**
 * Type-check-only shims for Meteor surfaces that `@types/meteor` (pinned at the
 * 2.x line) does not yet describe. This file is NOT part of the shipped package
 * and produces no runtime code — it exists solely so `tsc --noEmit` can check
 * `packages/agent/**` against the real Meteor 3.x API instead of drowning the
 * genuine-typo signal in "property does not exist" noise from an incomplete
 * `.d.ts`. Every entry here is a documented Meteor global, not a code fix.
 */

// `meteor/ddp-common` has no `@types/meteor` module. The package reaches it only
// as `(DDPCommon as any).MethodInvocation` (server/tools.ts) to build a genuine
// method invocation for tool `this`; `any` is all the call site needs.
declare module 'meteor/ddp-common' {
  export const DDPCommon: any;
}

declare module 'meteor/meteor' {
  namespace Meteor {
    /** The live DDP server (`Meteor.server.method_handlers`, …). Server only. */
    const server: any;
    /** True inside `meteor test-packages` / `meteor test`. Present in Meteor 3.x
     *  but absent from the pinned `@types/meteor`. */
    const isTest: boolean;
    /** True inside `meteor test-packages` specifically (§ the UNDER_TEST gate in
     *  server/index.ts). Absent from the pinned `@types/meteor`. */
    const isPackageTest: boolean;
  }
}

// Meteor 3.x's async cursor API and the raw-driver handle. `@types/meteor`
// ships neither `observeChangesAsync` (only the sync `observeChanges`) nor the
// `MongoInternals` export the capped-collection setup reaches through to hit
// the native driver.
declare module 'meteor/mongo' {
  namespace Mongo {
    interface Cursor<T, U = T> {
      observeChangesAsync(
        callbacks: unknown,
        options?: { nonMutatingCallbacks?: boolean },
      ): Promise<{ stop(): void }>;
    }
  }
  const MongoInternals: any;
}
