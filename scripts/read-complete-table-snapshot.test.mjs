import assert from "node:assert/strict";
import test from "node:test";
import { quoteTableIdentifier, readCompleteTableSnapshot } from "./read-complete-table-snapshot.mjs";

test("requests count and rows together with a safely quoted identifier",async()=>{
  const rows=[{id:1},{id:2}],seen=[];
  const returned=await readCompleteTableSnapshot('odd"table',async queries=>{seen.push(queries);return [[{snapshot_count:2}],rows];});
  assert.deepEqual(seen,[[
    'SELECT COUNT(*) AS snapshot_count FROM "odd""table"',
    'SELECT * FROM "odd""table"',
  ]]);
  assert.equal(returned,rows);
  assert.equal(quoteTableIdentifier('odd"table'),'"odd""table"');
});
test("accepts a genuinely empty table",async()=>{
  const rows=[];
  assert.equal(await readCompleteTableSnapshot("empty_table",async()=>[[{snapshot_count:0}],rows]),rows);
});
test("rejects malformed, unsafe, and truncated batch results",async()=>{
  const invalid=[null, [], [[{snapshot_count:0}]], [[{snapshot_count:0}],[],[]],
    [[],[]], [[{snapshot_count:0},{snapshot_count:0}],[]], [[null],[]],
    [[{snapshot_count:0,extra:true}],[]], [[{snapshot_count:"0"}],[]],
    [[{snapshot_count:-1}],[]], [[{snapshot_count:Number.MAX_SAFE_INTEGER+1}],[]],
    [[{snapshot_count:2}],[{id:1}]], [[{snapshot_count:0}],null]];
  for(const result of invalid) await assert.rejects(readCompleteTableSnapshot("table_name",async()=>result));
});
test("validates inputs before invoking the reader",async()=>{
  let calls=0;const reader=async()=>{calls+=1;return [[{snapshot_count:0}],[]];};
  for(const table of ["",null,{},42]) await assert.rejects(readCompleteTableSnapshot(table,reader));
  await assert.rejects(readCompleteTableSnapshot("table",null));
  assert.equal(calls,0);
});
