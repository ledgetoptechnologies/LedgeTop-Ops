import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {MAINTENANCE_APPROVAL_TARGET as target,readLiveMaintenanceBinding,
  installReviewedMaintenanceApproval} from './staging-directory-maintenance-approval.mjs';

const id=n=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const rejected=/staging maintenance approval rejected/u;
const privateMarker='SYNTHETIC_PRIVATE_DIAGNOSTIC_DO_NOT_EXPOSE';
const token='synthetic-provider-token-not-a-real-credential';
function provider(mutate=()=>{}){
  const deployment={deployments:[{id:id(1),versions:[{version_id:id(2),percentage:100}]}]};
  const version={id:id(2),resources:{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'staging'},
    {name:'OPS_DB',type:'d1',id:target.databaseLabel},
    {name:'PRIVATE_SETTING',type:'secret_text',text:privateMarker}]}};
  mutate(deployment,version);
  const calls=[];
  const fetch=async(url,init)=>{
    calls.push({url,init});
    return Response.json({success:true,result:structuredClone(url.endsWith('/deployments')?deployment:version)});
  };
  return {deployment,version,calls,fetch};
}
test('live binding reads only the exact account/worker, sole active version and pinned staging D1',async()=>{
  for(const database of [{id:target.databaseLabel},{database_id:target.databaseLabel},
    {id:target.databaseLabel,database_id:target.databaseLabel}]){
    const f=provider((_d,v)=>Object.assign(v.resources.bindings[1],database));
    if(!Object.hasOwn(database,'id'))delete f.version.resources.bindings[1].id;
    const result=await readLiveMaintenanceBinding({token,fetch:f.fetch});
    assert.deepEqual(result,{target,deploymentId:id(1),versionId:id(2)});
    assert.equal(JSON.stringify(result).includes(privateMarker),false);
    assert.equal(f.calls.length,3);
    for(const {url,init} of f.calls){
      assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${target.accountLabel}/workers/scripts/${target.workerLabel}/`));
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.headers.Authorization,`Bearer ${token}`);
    }
  }
});
test('live binding rejects split/absent traffic, wrong version/environment/database, duplicate or malformed bindings',async()=>{
  const cases=[
    d=>{d.deployments=[];},d=>{d.deployments[0].versions[0].percentage=99;},
    d=>{d.deployments[0].versions.push({version_id:id(3),percentage:0});},
    d=>{d.deployments[0].id='not-a-version';},
    (_d,v)=>{v.id=id(3);},(_d,v)=>{v.resources.bindings[0].text='production';},
    (_d,v)=>{v.resources.bindings[0].type='secret_text';},
    (_d,v)=>{v.resources.bindings=v.resources.bindings.filter(b=>b.name!=='ENVIRONMENT');},
    (_d,v)=>{v.resources.bindings[1].id=id(4);},
    (_d,v)=>{v.resources.bindings[1].database_id=id(4);},
    (_d,v)=>{v.resources.bindings[1].type='service';},
    (_d,v)=>{v.resources.bindings.push({...v.resources.bindings[1]});},
    (_d,v)=>{v.resources.bindings.push({...v.resources.bindings[0]});},
    (_d,v)=>{v.resources.bindings.push(null);},
  ];
  for(const change of cases){const f=provider(change);await assert.rejects(readLiveMaintenanceBinding({token,fetch:f.fetch}),rejected);}
});
test('live deployment drift is rejected even when the database ID remains unchanged',async()=>{
  const f=provider();let count=0;
  const fetch=async(url,init)=>{const response=await f.fetch(url,init);if(++count===3){const body=await response.json();body.result.deployments[0].id=id(9);return Response.json(body);}return response;};
  await assert.rejects(readLiveMaintenanceBinding({token,fetch}),rejected);
});
test('provider errors, malformed envelopes, oversized and unreadable bodies are bounded and sanitized',async()=>{
  const failures=[async()=>{throw Error(privateMarker);},async()=>new Response(privateMarker,{status:403}),
    async()=>new Response(privateMarker),async()=>Response.json({success:false,errors:[{message:privateMarker}]}),
    async()=>Response.json({success:true,result:null}),async()=>new Response('x'.repeat(1_048_577)),
    async()=>new Response(new ReadableStream({start(controller){controller.error(Error(privateMarker));}}))];
  for(const fetch of failures){await assert.rejects(readLiveMaintenanceBinding({token,fetch}),error=>error.message==='staging maintenance approval rejected');}
  let cancelled=false;
  const fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1_048_577));},cancel(){cancelled=true;}}));
  await assert.rejects(readLiveMaintenanceBinding({token,fetch}),rejected);assert.equal(cancelled,true);
});

function fixture(){
  const nowValue=new Date('2026-10-11T18:00:00.000Z');
  const input={target,staffId:'synthetic-owner',grantId:id(20),commandId:id(21),
    operator:{staffId:'synthetic-owner',accessSubject:'access|synthetic-owner'},
    approvalIssuer:{staffId:'synthetic-reviewer',accessSubject:'access|synthetic-reviewer'},
    identityEvidence:{staffId:'synthetic-owner',accessSubject:'access|synthetic-owner',verificationId:id(22),
      verifiedAt:'2026-10-11T17:59:00.000Z',expiresAt:'2026-10-11T18:30:00.000Z',issuer:'synthetic-independent-verifier'}};
  const plan={...input,protocol:'native-directory-maintenance-authority',version:1,
    snapshot:{staff:[{id:input.staffId,status:'active'}]}};
  const compiled=()=>{const canonicalPlanJson=JSON.stringify(plan),independentBindingVerificationJson=JSON.stringify(plan.identityEvidence);
    return {plan:structuredClone(plan),canonicalPlanJson,canonicalPlanSha256:sha(canonicalPlanJson),
      independentBindingVerificationJson,independentBindingVerificationSha256:sha(independentBindingVerificationJson)};};
  const reviewed=compiled();
  const artifact={plan:reviewed.plan,planSha256:reviewed.canonicalPlanSha256,
    independentBindingVerificationSha256:reviewed.independentBindingVerificationSha256};
  const binding={target,deploymentId:id(1),versionId:id(2)};
  const calls={compile:[],verify:0,review:0,prepare:[],writes:[]},ids=new Set();
  const db={prepare(sql){calls.prepare.push(sql);return {bind(...params){return {async run(){
    if(ids.has(params[0]))throw Error(`${privateMarker}: duplicate approval`);
    ids.add(params[0]);calls.writes.push(params);return {success:true,meta:{changes:1}};
  }}}};}};
  const options={db,artifact,approvalId:id(23),now:()=>new Date(nowValue),
    // This stub models only the trusted core dependency boundary. The module
    // must delegate canonical reconstruction to the actual core compiler in use;
    // these tests do not replace its separate real-D1 schema/authority tests.
    compile:async(selectedDb,selectedInput)=>{calls.compile.push({db:selectedDb,input:selectedInput});return compiled();},
    verifyBinding:async()=>{calls.verify++;return structuredClone(binding);},
    review:async(selectedArtifact,selectedBinding)=>{calls.review++;assert.deepEqual(selectedArtifact,artifact);assert.deepEqual(selectedBinding,binding);return true;}};
  return {input,plan,compiled,artifact,binding,calls,options};
}
test('installer recompiles the exact frozen reviewed input and inserts only approval, never grant/execution',async()=>{
  const f=fixture(),result=await installReviewedMaintenanceApproval(f.options);
  assert.deepEqual(result,{approvalId:id(23),commandId:id(21),planSha256:f.artifact.planSha256,
    expiresAt:'2026-10-11T18:15:00.000Z',grantExecuted:false});
  assert.ok(f.calls.compile.length>=1);for(const call of f.calls.compile){assert.equal(call.db,f.options.db);assert.deepEqual(call.input,f.input);}
  assert.ok(f.calls.verify>=2);assert.equal(f.calls.review,1);assert.equal(f.calls.writes.length,1);
  assert.equal(f.calls.prepare.length,1);assert.match(f.calls.prepare[0],/INSERT INTO native_directory_maintenance_authority_approvals/u);
  assert.doesNotMatch(f.calls.prepare[0],/OR REPLACE|OR IGNORE|native_directory_grants|receipts|UPDATE|DELETE/u);
  const values=f.calls.writes[0],compiled=f.compiled();
  assert.deepEqual(values,[id(23),compiled.canonicalPlanJson,f.artifact.planSha256,f.input.operator.staffId,
    f.input.operator.accessSubject,compiled.independentBindingVerificationJson,f.artifact.independentBindingVerificationSha256,
    f.input.approvalIssuer.staffId,f.input.approvalIssuer.accessSubject,'2026-10-11T18:00:00.000Z','2026-10-11T18:15:00.000Z']);
});
test('installer caps approval expiry to independent evidence and rejects expired/future/invalid evidence before writes',async()=>{
  const capped=fixture();capped.plan.identityEvidence.expiresAt='2026-10-11T18:05:00.000Z';
  const changed=capped.compiled();capped.options.artifact={plan:changed.plan,planSha256:changed.canonicalPlanSha256,
    independentBindingVerificationSha256:changed.independentBindingVerificationSha256};capped.options.review=async()=>true;
  assert.equal((await installReviewedMaintenanceApproval(capped.options)).expiresAt,'2026-10-11T18:05:00.000Z');
  for(const change of [f=>{f.options.now=()=>new Date('invalid');},
    f=>{f.options.now=()=>new Date('2026-10-11T18:31:00.000Z');},f=>{f.options.now=()=>new Date('2026-10-11T17:58:00.000Z');}]){
    const f=fixture();change(f);await assert.rejects(installReviewedMaintenanceApproval(f.options));assert.equal(f.calls.writes.length,0);
  }
});
test('installer rejects extra fields, wrong target/pins, changed hashes/compiler state and nonexplicit review without writes',async()=>{
  const changes=[f=>{f.options.artifact={...f.artifact,approved:true};},
    f=>{f.options.artifact={...f.artifact,plan:{...f.artifact.plan,target:{...target,environment:'production'}}};},
    f=>{f.options.verifyBinding=async()=>({...f.binding,target:{...target,databaseLabel:id(99)}});},
    f=>{f.options.verifyBinding=async()=>({...f.binding,versionId:'invalid'});},
    f=>{f.options.artifact={...f.artifact,planSha256:'0'.repeat(64)};},
    f=>{f.options.artifact={...f.artifact,independentBindingVerificationSha256:'0'.repeat(64)};},
    f=>{f.options.compile=async()=>({...f.compiled(),canonicalPlanJson:'{}'});},
    f=>{f.options.compile=async()=>({...f.compiled(),independentBindingVerificationJson:'{}'});},
    f=>{f.options.compile=async()=>{const c=f.compiled();c.plan.snapshot.staff[0].status='inactive';return c;};},
    f=>{f.options.review=async()=>false;},f=>{f.options.review=async()=>1;},
    f=>{f.options.verifyBinding=async()=>({...f.binding,versionId:++f.calls.verify===1?id(2):id(3)});}];
  for(const change of changes){const f=fixture();change(f);await assert.rejects(installReviewedMaintenanceApproval(f.options));assert.equal(f.calls.writes.length,0);}
});
test('identity drift during trusted review must not install a stale approval',async()=>{
  const f=fixture();f.options.review=async()=>{f.plan.snapshot.staff[0].status='inactive';return true;};
  await assert.rejects(installReviewedMaintenanceApproval(f.options),rejected);assert.equal(f.calls.writes.length,0);
});
test('trusted review cannot mutate the private artifact or provider pin used for insertion',async()=>{
  const f=fixture();f.options.review=async(artifact,binding)=>{
    artifact.plan.commandId=id(98);artifact.plan.operator.staffId='wrong-owner';binding.target.databaseLabel=id(99);return true;
  };
  const result=await installReviewedMaintenanceApproval(f.options);
  assert.equal(result.commandId,id(21));assert.equal(f.calls.writes[0][3],'synthetic-owner');
  assert.equal(f.calls.writes[0][1],f.compiled().canonicalPlanJson);
});
test('unconfirmed or uncertain approval insertion never retries or executes a grant',async()=>{
  for(const result of [{success:false,meta:{changes:1}},{success:true},{success:true,meta:{changes:0}},null]){
    const f=fixture();let attempts=0;
    f.options.db.prepare=sql=>{f.calls.prepare.push(sql);return {bind:()=>({run:async()=>{attempts++;return result;}})};};
    await assert.rejects(installReviewedMaintenanceApproval(f.options),rejected);
    assert.equal(attempts,1);assert.equal(f.calls.prepare.length,1);
  }
  const f=fixture();let attempts=0;
  f.options.db.prepare=sql=>{f.calls.prepare.push(sql);return {bind:()=>({run:async()=>{attempts++;throw Error(privateMarker);}})};};
  await assert.rejects(installReviewedMaintenanceApproval(f.options),error=>error.message==='staging maintenance approval rejected');
  assert.equal(attempts,1);assert.equal(f.calls.prepare.length,1);
});
test('installer sanitizes dependency failures and rejects approval reuse without execution or overwrite',async()=>{
  for(const dependency of ['compile','verifyBinding','review']){
    const f=fixture();f.options[dependency]=async()=>{throw Error(privateMarker);};
    await assert.rejects(installReviewedMaintenanceApproval(f.options),error=>error.message==='staging maintenance approval rejected');
    assert.equal(f.calls.writes.length,0);
  }
  const f=fixture();await installReviewedMaintenanceApproval(f.options);
  await assert.rejects(installReviewedMaintenanceApproval(f.options),error=>error.message==='staging maintenance approval rejected');
  assert.equal(f.calls.writes.length,1);assert.equal(f.calls.prepare.length,2);
  assert.ok(f.calls.prepare.every(sql=>!sql.includes('native_directory_grants')));
});
