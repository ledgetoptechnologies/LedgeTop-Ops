'use strict';
// Synthetic broker-owned transition only. No production authorization semantics.
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),candidate=require('../../server/nativeReadinessBrokerCandidate');
if(process.env.VIEWER_BROKER_FIXTURE_PAUSE==='1')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=5000');
try{
  const request=JSON.parse(fs.readFileSync(0,'utf8'));
  // The Python fixture checked SO_PEERCRED for a synthetic UID. This does not
  // authenticate a real worker, tenant or user.
  const result=candidate.complete(db,request,{authorize:()=>true,reviewBaseUrl:'https://example.test'});
  process.stdout.write(JSON.stringify(result));
}catch{process.exitCode=1;}finally{db.close();}
