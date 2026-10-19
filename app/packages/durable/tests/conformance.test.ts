import assert from 'assert';
import { Random } from 'meteor/random';
import { destroyMongoStorage, loadPiDurable, openMongoStorage } from 'meteor/10thfloor:durable';

// Pi Durable ships the semantic conformance suite its own memory, SQLite and
// JSONL backends pass. Here it runs against MongoStorage inside a Meteor
// server, on the connection and the driver Meteor itself uses. The suite is
// runner-independent: it takes assertions and a storage provider, and returns
// named cases.

/** Jest's `toEqual`: properties holding `undefined` do not count. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    Object.defineProperty(out, key, { value: withoutUndefined(child), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Jest's `toMatchObject`: every property of `expected` is in `actual`, recursively; arrays match in full. */
function assertMatches(actual: unknown, expected: unknown, at = 'value'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${at} is an array`);
    assert.strictEqual((actual as unknown[]).length, expected.length, `${at} length`);
    expected.forEach((item, index) => assertMatches((actual as unknown[])[index], item, `${at}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${at} is an object`);
    for (const key of Object.keys(expected)) {
      assertMatches((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${at}.${key}`);
    }
    return;
  }
  assert.strictEqual(actual, expected, at);
}

const assertions = {
  ok: (value: unknown, message?: string) => assert.ok(value, message ?? 'expected a truthy value'),
  strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
  deepEqual: (actual: unknown, expected: unknown) =>
    assert.deepStrictEqual(withoutUndefined(actual), withoutUndefined(expected)),
  partialDeepEqual: (actual: unknown, expected: unknown) => assertMatches(actual, expected),
  greaterThan: (actual: number, expected: number) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: async (operation: Promise<unknown>, messageIncludes: string) => {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(
        String((error as Error)?.message).includes(messageIncludes),
        `expected a rejection mentioning "${messageIncludes}", got "${(error as Error)?.message}"`,
      );
      return true;
    });
  },
};

describe('MongoStorage (Pi Durable storage conformance, on Meteor\'s Mongo connection)', function () {
  this.timeout(120_000);

  it('passes every case of the conformance suite', async function () {
    const testing = await loadPiDurable('testing') as any;
    const cases: { name: string; run(): Promise<void> }[] = testing.createStorageConformance({
      assertions,
      // Every case gets its own storage key in the shared collections.
      withStorage: async (use: (storage: unknown) => Promise<void>) => {
        const key = `conformance-${Random.id()}`;
        const storage = await openMongoStorage(key);
        try {
          await use(storage);
        } finally {
          await destroyMongoStorage(key);
        }
      },
    });
    // The suite had 23 cases at pi-durable 1.0.0; a release that drops cases should be noticed.
    assert.ok(cases.length >= 23, `expected at least 23 conformance cases, got ${cases.length}`);

    const failures: string[] = [];
    for (const testCase of cases) {
      try {
        await testCase.run();
      } catch (error) {
        failures.push(`${testCase.name}: ${(error as Error)?.message}`);
      }
    }
    assert.deepStrictEqual(failures, [], `${failures.length} of ${cases.length} conformance cases failed`);
  });
});
