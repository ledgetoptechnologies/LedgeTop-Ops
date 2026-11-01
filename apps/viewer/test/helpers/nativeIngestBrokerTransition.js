'use strict';
// Synthetic broker-owned transition only. No production authorization semantics.
const fs=require('node:fs'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),candidate=require('../../server/nativeReadinessBrokerCandidate'),grant=require('../../server/nativeReadinessGrantCandidate'),{digest}=require('../../server/nativeReadinessRequestDigestCandidate');
if(process.env.VIEWER_BROKER_FIXTURE_PAUSE==='1')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=5000');
try{
  const {request,token,nonce,action}=JSON.parse(fs.readFileSync(0,'utf8'));if(typeof nonce!=='string'||!/^[0-9a-f-]{36}$/.test(nonce))throw new Error('hold');
  // Only the broker process passes the UID observed with SO_PEERCRED, never the
  // request payload. This synthetic UID is not real tenant/user authorization.
  const peerUid=process.argv[3];
  const publicKey=fs.readFileSync(process.argv[4],'utf8');
  if(action){const intents=require('../../server/nativeDerivativeIntentCandidate'),complete=require('../../server/nativeDerivativeCompletionCandidate'),authorize=r=>grant.authorize(r,{token,peerUid,publicKey,issuer:'synthetic-issuer',expectedAction:action});if(!authorize(request))throw new Error('hold');let value;if(action==='prepare'){intents.prepare(db,request,{authorize});value='prepared';}else if(action==='confirm'){const old=intents.inspect(db,request.jobId,{authorize:()=>true});if(old.state!=='reconcile'||digest(old.request)!==digest(request))throw new Error('hold');value='confirmed';}else if(action==='complete')value=complete.complete(db,request,{authorize,reviewBaseUrl:'https://example.test'});else throw new Error('hold');process.stdout.write(JSON.stringify({result:{nonce,requestDigest:digest(request),result:value},signature:'fixture'}));}
  else{const commit=candidate.complete(db,request,{authorize:r=>grant.authorize(r,{token,peerUid,publicKey,issuer:'synthetic-issuer'}),reviewBaseUrl:'https://example.test'}),result={...commit,nonce,requestDigest:digest(request)},key=fs.readFileSync(process.argv[5],'utf8'),signature=crypto.sign(null,Buffer.concat([Buffer.from('viewer-readiness-response-v1\0'),Buffer.from(JSON.stringify(result))]),key).toString('base64url');process.stdout.write(JSON.stringify({result,signature}));}
}catch{process.exitCode=1;}finally{db.close();}
