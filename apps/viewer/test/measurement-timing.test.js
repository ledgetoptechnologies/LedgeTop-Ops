'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {queueWaitTiming,sanitizedMeasurementTiming,emitMeasurementTiming,readQueueTiming}=require('../server/measurementTiming');
test('queue timing uses claim time not completion time and marks malformed future or backwards timestamps unknown',()=>{
  const start='2026-09-29T10:00:00.000Z',claim='2026-09-29T10:00:01.250Z',now=Date.parse('2026-09-29T10:10:00.000Z');
  assert.deepEqual(queueWaitTiming(start,claim,now),{phase:'queue',queueWaitMs:1250});
  for(const [a,b]of [[claim,start],[start,'2027-01-01T00:00:00.000Z'],['1',claim],[null,claim],[start,'invalid'],['2026-02-31T10:00:00.000Z',claim]])assert.equal(queueWaitTiming(a,b,now).queueWaitMs,null);
  const db={prepare:sql=>{assert.equal(sql,'SELECT created_at,updated_at FROM ephemeral_measurement_jobs WHERE id=?');return{get:id=>{assert.equal(id,'job');return{created_at:start,updated_at:claim};}};}};
  assert.equal(readQueueTiming(db,'ephemeral_measurement_jobs','job').queueWaitMs,1250);assert.equal(readQueueTiming(db,'arbitrary_table','job').queueWaitMs,null);
});
test('timing whitelist bounds numeric values and strips sensitive and arbitrary fields',()=>{
  const value={phase:'point-surface',cacheHit:true,verifiedReadMs:3.123456,decodeGridMs:Infinity,totalMs:-1,pointsRead:2,nodesRead:1,source:'/private/path',token:'secret',vertices:[[1,2,3]],random:'x'.repeat(10000)};
  const clean=sanitizedMeasurementTiming(value);assert.deepEqual(clean,{phase:'point-surface',totalMs:null,verifiedReadMs:3.123,decodeGridMs:null,pointsRead:2,nodesRead:1,cacheHit:true});assert.ok(JSON.stringify(clean).length<256);
  assert.equal(sanitizedMeasurementTiming({phase:'/secret/path'}),null);
  const records=[];emitMeasurementTiming({method:'surface-transect',source:{kind:'ept',path:'/secret'},authority:{token:'secret'}},value,row=>records.push(row));
  assert.equal(records.length,1);assert.doesNotMatch(JSON.stringify(records),/secret|private|vertices|random/);
  assert.doesNotThrow(()=>emitMeasurementTiming({},value,()=>{throw Error('log unavailable');}));
});
