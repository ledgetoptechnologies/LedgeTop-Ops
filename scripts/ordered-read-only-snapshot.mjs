import assert from "node:assert/strict";

/**
 * Run independent read-only snapshot queries with bounded concurrency.
 * Results retain the exact key order supplied by the caller.
 */
export async function collectOrderedReadOnlySnapshot(keys, read, { concurrency = 4 } = {}) {
  assert(Array.isArray(keys), "snapshot keys must be an array");
  assert.equal(typeof read, "function", "snapshot reader must be a function");
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, "snapshot concurrency must be an integer from 1 to 4");
  assert(keys.every(key => typeof key === "string" && key.length > 0), "snapshot keys must be non-empty strings");
  assert.equal(new Set(keys).size, keys.length, "snapshot keys must be unique");

  const results = new Array(keys.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure;

  async function worker() {
    while (!failed) {
      const index = nextIndex;
      if (index >= keys.length) return;
      nextIndex += 1;
      try {
        results[index] = await read(keys[index], index);
      } catch (error) {
        if (!failed) { failed = true; firstFailure = error; }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));
  if (failed) throw firstFailure;
  return Object.fromEntries(keys.map((key, index) => [key, results[index]]));
}
