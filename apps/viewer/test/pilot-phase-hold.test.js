'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('real-provider pilot phases remain held without explicit synthetic mode',()=>{
 const script=path.join(__dirname,'helpers','real-coordinator-chain.cjs');
 for(const phase of ['submit','status','finish','resume-ingest'])for(const flag of ['', 'true', '0']){
  const result=spawnSync(process.execPath,[script,phase],{encoding:'utf8',timeout:5000,env:{...process.env,LTDS_PILOT_SYNTHETIC_TEST:flag,VIEWER_PILOT_REAL_ENABLED:'',VIEWER_FIXTURE_ROOT:'/fixture-state/viewer',VIEWER_FIXTURE_PHOTOS:'/fixture-input',VIEWER_FIXTURE_COORDINATOR:'https://127.0.0.1:28443',VIEWER_FIXTURE_OWNER:'pilot-'+'a'.repeat(32),TEST_VIEWER_TOKEN:'synthetic-fixture',VIEWER_FIXTURE_KEY:'fixture-key'}});
  assert.equal(result.status,1);assert.match(result.stderr,/pilot execution held pending integrated supervision and receipt review/);
 }
});
