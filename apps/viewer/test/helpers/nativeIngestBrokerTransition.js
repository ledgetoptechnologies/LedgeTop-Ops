'use strict';
// Synthetic broker-owned transition only. No production authorization semantics.
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),candidate=require('../../server/nativeReadinessBrokerCandidate');
if(process.env.VIEWER_BROKER_FIXTURE_PAUSE==='1')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=5000');
try{
  const request=JSON.parse(fs.readFileSync(0,'utf8'));
  // Only the broker process passes the UID observed with SO_PEERCRED, never the
  // request payload. This synthetic UID is not real tenant/user authorization.
  const peerUid=process.argv[3];
  const result=candidate.complete(db,request,{authorize:()=>peerUid==='21002',reviewBaseUrl:'https://example.test'});
  process.stdout.write(JSON.stringify(result));
}catch{process.exitCode=1;}finally{db.close();}
