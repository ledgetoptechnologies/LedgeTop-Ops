import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const start=source.indexOf('let workspaceAuthorityEpoch='),end=source.indexOf('\nasync function authenticatedDownload(',start),transport=source.slice(start,end);
function fixture(fetcher){const state={token:'token',adminSession:{id:'session',subject:'user',permissions:['viewer.gcp.read','viewer.gcp.write'],controllerOrigin:'https://ops.example'}};let cleared=0;
 const context=vm.createContext({state,WeakMap,JSON,Date,DOMException,Headers,fetch:fetcher,workspaceRecovery:{wait:async()=>{},isPaused:()=>false},workspaceRenewal:null,responseError:(message,status)=>Object.assign(new Error(message),{status}),clearWorkspaceAuthorization:()=>{cleared++;},crypto:{randomUUID:()=> 'request-id'},clientAccessDiagnostic:()=>({})});
 vm.runInContext(transport,context);return{state,context,cleared:()=>cleared};}
const response=(status,json)=>({status,ok:status>=200&&status<300,headers:{get:()=>null},json});
test('a late response body cannot clear or modify a replacement authority',async()=>{
 let finish;const f=fixture(async()=>response(200,()=>new Promise(resolve=>{finish=resolve;}))),pending=f.context.api('/api/test');
 await new Promise(resolve=>setImmediate(resolve));f.state.adminSession={...f.state.adminSession,id:'other'};finish({data:'old'});
 await assert.rejects(pending,{status:409});assert.equal(f.cleared(),0);
});
test('a mutation waiting for recovery is not dispatched under a changed authority',async()=>{
 let release,calls=0;const f=fixture(async()=>{calls++;return response(200,async()=>({}));});f.context.workspaceRecovery.wait=()=>new Promise(resolve=>{release=resolve;});
 const pending=f.context.api('/api/change',{method:'POST',body:{value:1}});f.state.adminSession={...f.state.adminSession,subject:'other'};release();
 await assert.rejects(pending,{status:409});assert.equal(calls,0);
});
test('same-bearer same-session same-scope renewal can retry one 401',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;if(calls===1){f.state.adminSession={...f.state.adminSession};return response(401,async()=>({}));}return response(200,async()=>({ok:true}));});
 assert.equal((await f.context.api('/api/change',{method:'POST',body:{value:1}})).ok,true);assert.equal(calls,2);assert.equal(f.cleared(),0);
});
test('same token with changed scope is not replayed',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;f.state.adminSession={...f.state.adminSession,permissions:['viewer.gcp.read']};return response(401,async()=>({}));});
 await assert.rejects(f.context.api('/api/change',{method:'POST',body:{}}),{status:409});assert.equal(calls,1);assert.equal(f.cleared(),0);
});

test('late 401 from an old session cannot clear its replacement',async()=>{
 let deliver;const f=fixture(()=>new Promise(resolve=>{deliver=resolve;})),pending=f.context.api('/api/test');
 await new Promise(resolve=>setImmediate(resolve));f.state.adminSession={...f.state.adminSession,id:'replacement'};deliver(response(401,async()=>({})));
 await assert.rejects(pending,{status:409});assert.equal(f.cleared(),0);
});

test('material authority change followed by return to the same values rejects the old response',async()=>{
 let finish;const f=fixture(async()=>response(200,()=>new Promise(resolve=>{finish=resolve;}))),pending=f.context.api('/api/test');
 await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('workspaceAuthorityEpoch++',f.context);f.state.adminSession={...f.state.adminSession,permissions:['viewer.gcp.read']};
 vm.runInContext('workspaceAuthorityEpoch++',f.context);f.state.adminSession={...f.state.adminSession,permissions:['viewer.gcp.read','viewer.gcp.write']};finish({ok:true});
 await assert.rejects(pending,{status:409});assert.equal(f.cleared(),0);
});

for(const mode of ['restore','redeem'])for(const status of [200,401])test(`late ${mode} ${status} cannot install or clear replacement authority`,async()=>{
 let finish,installed=0;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 f.context.location={pathname:'/workspace/grant-value'};f.context.consumeReauthorizationState=()=>true;f.context.installWorkspaceSession=()=>{installed++;};f.context.syncWorkspaceView=()=>{};
 const line=source.split(/\r?\n/).find(value=>value.startsWith(`async function ${mode==='restore'?'restoreWorkspaceSession':'redeemGrant'}(`));vm.runInContext(line,f.context);
 const pending=mode==='restore'?f.context.restoreWorkspaceSession():f.context.redeemGrant();
 f.state.adminSession={...f.state.adminSession,id:'replacement'};finish(response(status,async()=>({session:{id:'old'}})));
 await assert.rejects(pending,{status:409});assert.equal(installed,0);assert.equal(f.cleared(),0);
});

test('authority change after mutation dispatch preserves idempotency and reports unknown outcome',async()=>{
 let deliver;const f=fixture(()=>new Promise(resolve=>{deliver=resolve;})),pending=f.context.api('/api/change',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{value:1}});
 await new Promise(resolve=>setImmediate(resolve));f.state.adminSession={...f.state.adminSession,id:'replacement'};deliver(response(200,async()=>({ok:true})));
 await assert.rejects(pending,error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key'&&/outcome is unknown/.test(error.message));
});

test('silent successful renewal clears recovery latch even if a popup was independently paused',()=>{
 const f=fixture(async()=>response(200,async()=>({}))),options=[];let cancelled=0;
 Object.assign(f.context,{workspaceRecovery:{isPaused:()=>true,cancelIfStale:()=>cancelled++},sessionStorage:{setItem(){}},TOKEN_KEY:'token-key',OPS_ORIGIN_KEY:'origin-key',validateWorkspaceSessionEnvelope:value=>({session:value.session,controllerOrigin:'https://ops.example'}),reviewSessionController:{setAuthenticatedSubject(){}},WorkspaceSessionRenewal:class{constructor(value){options.push(value);}start(){}dispose(){}}});
 vm.runInContext('let workspaceAuthorizationClearing=true; let workspaceController=null;',f.context);
 const line=source.split(/\r?\n/).find(value=>value.startsWith('function installWorkspaceSession('));vm.runInContext(line,f.context);
 f.context.installWorkspaceSession({accessToken:'token',session:f.state.adminSession});vm.runInContext('workspaceAuthorizationClearing=true',f.context);
 options[0].onSession({session:{...f.state.adminSession,permissions:['viewer.gcp.read']}});
 assert.equal(vm.runInContext('workspaceAuthorizationClearing',f.context),false);assert.ok(cancelled>0);
});

test('network failure after mutation dispatch reports unknown outcome with safe key and does not retry',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw new TypeError('network unavailable');});
 await assert.rejects(f.context.api('/api/change',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{}}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');assert.equal(calls,1);
});
test('pre-aborted mutation never dispatches and does not claim unknown outcome',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return response(200,async()=>({}));}),controller=new AbortController();controller.abort();
 await assert.rejects(f.context.api('/api/change',{method:'POST',body:{},signal:controller.signal}),error=>error.code!=='workspace_mutation_outcome_unknown');assert.equal(calls,0);
});
test('abort after dispatched mutation is an unknown outcome, not an automatic retry',async()=>{
 let calls=0,reject;const f=fixture(()=>{calls++;return new Promise((_resolve,fail)=>{reject=fail;});}),controller=new AbortController();
 const pending=f.context.api('/api/change',{method:'POST',body:{},signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();reject(controller.signal.reason);
 await assert.rejects(pending,error=>error.code==='workspace_mutation_outcome_unknown');assert.equal(calls,1);
});

for(const failure of ['stream rejection','malformed json'])test(`successful mutation with ${failure} is reported as uncertain`,async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return response(200,async()=>{throw failure==='stream rejection'?new TypeError('stream closed'):new SyntaxError('bad json');});});
 await assert.rejects(f.context.api('/api/change',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{}}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');assert.equal(calls,1);
});
test('empty 204 is a valid completed mutation and is not parsed',async()=>{
 let parsed=false;const f=fixture(async()=>response(204,async()=>{parsed=true;throw new Error('must not parse');}));
 assert.equal(await f.context.api('/api/change',{method:'POST',body:{}}),null);assert.equal(parsed,false);
});
test('a mutation 5xx is conservatively uncertain without retry',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return response(500,async()=>({code:'internal_error'}));});
 await assert.rejects(f.context.api('/api/change',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{}}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');assert.equal(calls,1);
});

for(const payload of [null,{}])test('GCP receipt-requiring mutation rejects structurally incomplete success',async()=>{
 const f=fixture(async()=>response(200,async()=>payload));
 await assert.rejects(f.context.api('/api/gcp',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{},validateReceipt:body=>typeof body?.set?.id==='string'}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');
});
test('receipt-requiring mutation rejects 204 but ordinary delete accepts it',async()=>{
 const f=fixture(async()=>response(204,async()=>{throw new Error('must not parse');}));
 await assert.rejects(f.context.api('/api/gcp',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{},validateReceipt:body=>!!body?.set?.id}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');
 assert.equal(await f.context.api('/api/gcp/mark',{method:'DELETE'}),null);
});
test('valid receipt-requiring mutation returns verified result',async()=>{
 const f=fixture(async()=>response(201,async()=>({set:{id:'set',datasetId:'dataset'},points:[]})));
 assert.equal((await f.context.api('/api/gcp',{method:'POST',body:{},validateReceipt:body=>body?.set?.id==='set'&&Array.isArray(body.points)})).set.id,'set');
});

test('malformed auto-import receipt produces uncertain outcome with the original key',async()=>{
 const line=source.split(/\r?\n/).find(value=>value.startsWith('function validGcpAutoImportReceipt('));
 const f=fixture(async()=>response(200,async()=>({sets:null,scanned:1,imported:1,ignoredInvalid:0,failed:0,limited:false})));vm.runInContext(`${source.split(/\r?\n/).find(value=>value.startsWith('function validGcpSetList('))}\n${line}`,f.context);
 await assert.rejects(f.context.api('/api/auto-import',{method:'POST',headers:{'Idempotency-Key':'stable-key'},body:{},validateReceipt:body=>f.context.validGcpAutoImportReceipt(body,'dataset')}),error=>error.code==='workspace_mutation_outcome_unknown'&&error.idempotencyKey==='stable-key');
});
