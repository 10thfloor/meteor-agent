// Chord publishes `./delta` through an `exports` map, which Meteor's resolver
// does not follow, so the client imports the file behind it by path. That path
// is not in the map either, which is why TypeScript needs telling what is there.
declare module '@earendil-works/chord/dist/delta/index.js' {
  /** Apply one batch of Chord operations and return the new value; the previous one is left as it was. */
  export function applyImmutable<T>(target: T | undefined, ops: readonly unknown[]): T;
}
