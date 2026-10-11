import assert from "node:assert/strict";
import test from "node:test";
import { collectOrderedReadOnlySnapshot } from "./ordered-read-only-snapshot.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("caps reads at four and returns deterministic input order", async () => {
  const keys=["slow","fast","middle","fourth","fifth","sixth"];
  const delays={slow:30,fast:1,middle:15,fourth:5,fifth:1,sixth:1};
  let active=0,maximum=0;
  const snapshot=await collectOrderedReadOnlySnapshot(keys,async key=>{
    active+=1;maximum=Math.max(maximum,active);
    await delay(delays[key]);active-=1;
    return `${key}-rows`;
  });
  assert.equal(maximum,4);
  assert.deepEqual(Object.keys(snapshot),keys);
  assert.deepEqual(Object.values(snapshot),keys.map(key=>`${key}-rows`));
});

test("failure starts no further reads, safely settles in-flight reads, and is not retried", async () => {
  const keys=["one","fail","three","four","must-not-start","also-must-not-start"],started=[],settled=[];
  const failure=Error("read failed");
  await assert.rejects(collectOrderedReadOnlySnapshot(keys,async key=>{
    started.push(key);
    if(key==="fail"){await delay(2);settled.push(key);throw failure;}
    await delay(20);settled.push(key);return key;
  }),error=>{
    assert.equal(error,failure);
    assert.deepEqual(started,["one","fail","three","four"]);
    assert.deepEqual([...settled].sort(),["fail","four","one","three"].sort(),"rejection waits for every started read to settle");
    assert.equal(started.filter(key=>key==="fail").length,1,"failed reads are never retried");
    return true;
  });
});

test("rejects unsafe scheduling inputs before starting reads", async () => {
  let calls=0;const read=async()=>{calls+=1;};
  await assert.rejects(collectOrderedReadOnlySnapshot(["a","b"],read,{concurrency:5}),/1 to 4/u);
  await assert.rejects(collectOrderedReadOnlySnapshot(["a","a"],read),/unique/u);
  await assert.rejects(collectOrderedReadOnlySnapshot([""],read),/non-empty/u);
  assert.equal(calls,0);
});
