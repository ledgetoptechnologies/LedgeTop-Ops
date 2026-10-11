import assert from "node:assert/strict";

export function quoteTableIdentifier(tableName) {
  assert(typeof tableName === "string" && tableName.length > 0, "table name must be a non-empty string");
  return `"${tableName.replaceAll('"','""')}"`;
}

/** Count and rows share a read-only provider batch; this is not a cross-table transaction. */
export async function readCompleteTableSnapshot(tableName, batchReader) {
  assert.equal(typeof batchReader, "function", "batch reader must be a function");
  const identifier=quoteTableIdentifier(tableName);
  const results=await batchReader([
    `SELECT COUNT(*) AS snapshot_count FROM ${identifier}`,
    `SELECT * FROM ${identifier}`,
  ]);
  assert(Array.isArray(results) && results.length === 2, "snapshot batch must return exactly two result arrays");
  const [countRows,rows]=results;
  assert(Array.isArray(countRows) && countRows.length === 1, "snapshot count must return exactly one row");
  assert(Array.isArray(rows), "snapshot rows result must be an array");
  const countRow=countRows[0];
  assert(countRow !== null && typeof countRow === "object" && !Array.isArray(countRow), "snapshot count row must be an object");
  assert.deepEqual(Object.keys(countRow),["snapshot_count"], "snapshot count row must contain only snapshot_count");
  const count=countRow.snapshot_count;
  assert(Number.isSafeInteger(count) && count >= 0, "snapshot count must be a nonnegative safe integer");
  assert.equal(rows.length,count,"snapshot rows are incomplete or inconsistent");
  return rows;
}
