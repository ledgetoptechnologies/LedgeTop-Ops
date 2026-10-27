import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES } from './native-staff-cutover-distribution-pin.mjs';
import { assertFreshNativeStaffAccessGroup, assertNativeStaffAccessGroupStateMatches,
  readNativeStaffAccessGroupObservation, validateNativeStaffAccessGroupObservation } from './native-staff-cutover-access-group-observation.mjs';
import { createApprovedExecutorD1Provider } from './native-staff-bootstrap-approved-executor.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const now = Date.parse('2026-10-27T12:00:00.000Z');
const config = { target:{accountId:'a'.repeat(32)}, accessGroup:{id:'11111111-1111-4111-8111-111111111111',name:'Synthetic Ops Staff'} };
const group = () => ({id:config.accessGroup.id,name:config.accessGroup.name,
  include:[{email:{email:' Staff@Example.test '}},{email:{email:'owner@example.test'}}],
  exclude:[],require:[],is_default:[],
  created_at:'provider-metadata-is-covered-by-response-hash'});
const credential = (token=`synthetic-bearer-${'x'.repeat(40)}`) => ({schemaVersion:1,accountId:config.target.accountId,
  groupId:config.accessGroup.id,groupName:config.accessGroup.name,token});
function response(body,{status=200}={}) {
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
}
function fetchFor(result,{status=200}={}) {
  const calls=[];
  return { calls, fetchImpl:async (url,init)=>{calls.push({url:String(url),init});return response({success:status===200,result}, {status});} };
}
const read = (fetchImpl, clock=()=>now) => readNativeStaffAccessGroupObservation({config,getAccessGroupReadCredential:async()=>credential(),fetchImpl,now:clock});

test('performs one exact GET and returns immutable hashed evidence without members or credentials',async()=>{
  const fake=fetchFor(group());
  const observation=await read(fake.fetchImpl);
  assert.equal(fake.calls.length,1);
  assert.equal(fake.calls[0].url,`https://api.cloudflare.com/client/v4/accounts/${config.target.accountId}/access/groups/${config.accessGroup.id}`);
  assert.equal(fake.calls[0].init.method,'GET');
  assert.equal(fake.calls[0].init.redirect,'manual');
  assert.equal(fake.calls[0].init.headers.Authorization,`Bearer synthetic-bearer-${'x'.repeat(40)}`);
  assert.deepEqual(Object.keys(observation).sort(),['accountId','evidenceSha256','groupId','groupName','includeRuleCount',
    'kind','managedEmailCount','managedEmailsSha256','observedAt','policySha256','providerResponseSha256','schemaVersion'].sort());
  assert.equal(observation.accountId,config.target.accountId);
  assert.equal(observation.groupId,config.accessGroup.id);
  assert.equal(observation.groupName,config.accessGroup.name);
  assert.equal(observation.managedEmailCount,2);
  assert.equal(observation.includeRuleCount,2);
  assert.equal(observation.managedEmailsSha256,sha(canonical(['owner@example.test','staff@example.test'])));
  assert.equal(observation.policySha256,sha(canonical({exclude:group().exclude,require:group().require,is_default:[]})));
  assert.equal(observation.providerResponseSha256.length,64);
  assert.equal(observation.evidenceSha256.length,64);
  assert.equal(JSON.stringify(observation).includes('owner@example.test'),false);
  assert.equal(JSON.stringify(observation).includes('synthetic-bearer'),false);
  assert.equal(Object.isFrozen(observation),true);
});

test('rejects capsule identity metadata that does not match the reviewed group before fetching',async()=>{
  for(const changes of [{accountId:'b'.repeat(32)},{groupId:'22222222-2222-4222-8222-222222222222'},{groupName:'Other group'}]){
    let fetches=0;
    await assert.rejects(readNativeStaffAccessGroupObservation({config,
      getAccessGroupReadCredential:async()=>({...credential(),...changes}),
      fetchImpl:async()=>{fetches++;throw new Error('must-not-fetch');},now:()=>now}),/provider_credential_invalid/u);
    assert.equal(fetches,0);
  }
});

for (const [label, mutate, code] of [
  ['wrong group id',value=>value.id='22222222-2222-4222-8222-222222222222','group_identity_or_policy_invalid'],
  ['wrong group name',value=>value.name='Other','group_identity_or_policy_invalid'],
  ['include rule with extra selector',value=>value.include[0].domain={domain:'example.test'},'unmanaged_include_rule'],
  ['non-email include',value=>value.include[0]={everyone:{}},'unmanaged_include_rule'],
  ['duplicate normalized member',value=>value.include.push({email:{email:'STAFF@example.test'}}),'group_member_duplicate'],
  ['missing exclude field',value=>delete value.exclude,'group_shape_invalid'],
  ['default flag with a nonempty AccessRule list',value=>value.is_default=[{certificate:{}}],'unsupported_group_policy'],
  ['nonempty exclude policy',value=>value.exclude=[{certificate:{}}],'unsupported_group_policy'],
  ['nonempty require policy',value=>value.require=[{auth_method:{auth_method:'mfa'}}],'unsupported_group_policy'],
  ['unknown policy field',value=>value.session_duration='12h','group_shape_invalid'],
]) test(`rejects ${label}`,async()=>{
  const value=group();mutate(value);const fake=fetchFor(value);
  await assert.rejects(read(fake.fetchImpl),new RegExp(code));
  assert.equal(fake.calls.length,1);
});

test('refuses redirects, non-200 responses, missing token and oversized responses without retries',async()=>{
  const redirects=[];
  await assert.rejects(read(async (_url,init)=>{redirects.push(init);return Response.redirect('https://attacker.invalid/group',302);}),/provider_response_invalid/u);
  assert.equal(redirects.length,1);
  const unavailable=fetchFor(group(),{status:503});
  await assert.rejects(read(unavailable.fetchImpl),/provider_response_invalid/u);
  assert.equal(unavailable.calls.length,1);
  await assert.rejects(readNativeStaffAccessGroupObservation({config,getAccessGroupReadCredential:async()=>credential(''),fetchImpl:async()=>{throw new Error('no-fetch');},now:()=>now}),/provider_credential_invalid/u);
  const oversized=await read(async()=>new Response('x'.repeat(2*1024*1024+1),{status:200,
    headers:{'content-length':String(2*1024*1024+1)}})).catch(error=>error);
  assert.match(oversized.message,/response_too_large/u);
  let cancelled=false,remaining=3;
  const stream=new ReadableStream({pull(controller){if(remaining-- > 0)controller.enqueue(new Uint8Array(1024*1024));},
    cancel(){cancelled=true;}});
  const chunked=await read(async()=>new Response(stream,{status:200})).catch(error=>error);
  assert.match(chunked.message,/response_too_large/u);
  assert.equal(cancelled,true);
});

test('keeps the bounded fetch signal through body reads, cancels rejected bodies, and sanitizes body abort errors',async()=>{
  let signal,nonOkCancelled=false;
  const nonOkBody=new ReadableStream({cancel(){nonOkCancelled=true;}});
  await assert.rejects(read(async(_url,init)=>{
    signal=init.signal;
    return new Response(nonOkBody,{status:403});
  }),/provider_response_invalid/u);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted,false);
  assert.equal(nonOkCancelled,true);

  let lengthCancelled=false;
  const lengthBody=new ReadableStream({cancel(){lengthCancelled=true;}});
  await assert.rejects(read(async()=>new Response(lengthBody,{status:200,
    headers:{'content-length':String(2*1024*1024+1)}})),/response_too_large/u);
  assert.equal(lengthCancelled,true);

  const abortLike=new ReadableStream({pull(){throw new DOMException('synthetic bearer secret must not escape','AbortError');}});
  const error=await read(async(_url,init)=>{
    signal=init.signal;
    return new Response(abortLike,{status:200});
  }).catch(value=>value);
  assert.match(error.message,/native_staff_access_group_response_read_failed/u);
  assert.equal(error.message.includes('synthetic bearer secret'),false);
});

test('rejects malformed envelope and invalid UTF-8 JSON bytes',async()=>{
  await assert.rejects(read(async()=>response({success:false,result:group()})),/provider_envelope_invalid/u);
  await assert.rejects(read(async()=>response({success:true,errors:[{code:1000,message:'provider error'}],result:group()})),/provider_envelope_invalid/u);
  await assert.rejects(read(async()=>response({success:true,messages:[{code:'1000',message:'bad code'}],result:group()})),/provider_envelope_invalid/u);
  await assert.rejects(read(async()=>response({success:true,errors:{code:1000,message:'not an array'},result:group()})),/provider_envelope_invalid/u);
  const notices=await read(async()=>response({success:true,messages:[{code:1000,message:'informational'}],result:group()}));
  assert.equal(notices.managedEmailCount,2);
  const invalid=new Response(new Uint8Array([0xff,0xfe]),{status:200});
  await assert.rejects(read(async()=>invalid),/response_json_invalid/u);
});

test('evidence validator refuses tampering, stale timestamps and unbound extra fields',async()=>{
  const observation=await read(fetchFor(group()).fetchImpl);
  const changed={...observation,providerResponseSha256:'0'.repeat(64)};
  await assert.rejects(Promise.resolve().then(()=>validateNativeStaffAccessGroupObservation(changed,{now})),/evidence_digest_invalid/u);
  const stale={...observation,observedAt:new Date(now-11*60_000).toISOString()};
  stale.evidenceSha256=sha(canonical(Object.fromEntries(Object.entries(stale).filter(([key])=>key!=='evidenceSha256'))));
  await assert.rejects(Promise.resolve().then(()=>validateNativeStaffAccessGroupObservation(stale,{now})),/observation_stale/u);
  assert.throws(()=>validateNativeStaffAccessGroupObservation({...observation,rawEmails:['private@example.test']},{now}),/evidence_shape_invalid/u);
});

test('fresh-read comparison ignores time/raw response digest but refuses member, policy, or target drift',async()=>{
  const first=await read(fetchFor(group()).fetchImpl);
  const metadataChanged=group();metadataChanged.created_at='different-provider-metadata';
  const later=await read(fetchFor(metadataChanged).fetchImpl,()=>now+1000);
  assert.equal(assertNativeStaffAccessGroupStateMatches(first,later,{now:now+1000}),true);
  const membershipChanged=group();membershipChanged.include.push({email:{email:'new@example.test'}});
  const changed=await read(fetchFor(membershipChanged).fetchImpl,()=>now+1000);
  assert.throws(()=>assertNativeStaffAccessGroupStateMatches(first,changed,{now:now+1000}),/group_state_changed/u);
  const changedPolicy={...later,policySha256:'0'.repeat(64)};
  const policy={...changedPolicy};
  const {evidenceSha256:_policyHash,...policyBody}=policy;
  policy.evidenceSha256=sha(canonical(policyBody));
  assert.throws(()=>assertNativeStaffAccessGroupStateMatches(first,policy,{now:now+1000}),/group_state_changed/u);
});

test('freshness assertion performs a new pinned GET and rejects stale or cross-group evidence',async()=>{
  const before=await read(fetchFor(group()).fetchImpl,()=>now-1000);
  const after=await read(fetchFor(group()).fetchImpl,()=>now);
  const live=fetchFor(group());
  assert.equal((await assertFreshNativeStaffAccessGroup({config,reviewedBefore:before,reviewedAfter:after,
    getAccessGroupReadCredential:async()=>credential(),fetchImpl:live.fetchImpl,now:()=>now})).groupId,config.accessGroup.id);
  assert.equal(live.calls.length,1);
  const cross={...after,groupId:'22222222-2222-4222-8222-222222222222'};
  cross.evidenceSha256=sha(canonical(Object.fromEntries(Object.entries(cross).filter(([key])=>key!=='evidenceSha256'))));
  await assert.rejects(assertFreshNativeStaffAccessGroup({config,reviewedBefore:before,reviewedAfter:cross,
    getAccessGroupReadCredential:async()=>credential(),fetchImpl:live.fetchImpl,now:()=>now}),/group_state_changed/u);
});

test('the cutover call path keeps Access Groups and D1 credentials separate and never falls back after group denial',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const cli=readFileSync(path.join(root,'scripts/native-staff-cutover-owner-approval-cli.mjs'),'utf8');
  const executor=readFileSync(path.join(root,'scripts/native-staff-cutover-approved-executor.mjs'),'utf8');
  assert.match(cli,/getAccessGroupReadCredential:loadPinnedAccessGroupReadCredential/u);
  assert.match(cli,/createApprovedExecutorD1Provider\(\{config,getBearerToken:wranglerBearerToken\}\)/u);
  assert.match(executor,/getAccessGroupReadCredential=loadPinnedAccessGroupReadCredential/u);
  assert.match(executor,/createApprovedExecutorD1Provider\(\{config,getBearerToken,fetchImpl\}\)/u);
  assert.match(executor,/getAccessGroupReadCredential,fetchImpl/u);

  const extended={...config,target:{...config.target,databaseId:'22222222-2222-4222-8222-222222222222'}};
  const groupToken='synthetic-group-read-token-never-real-123456';
  const managementToken='synthetic-wrangler-management-token-never-real-123456';
  const requests=[];
  const fetchImpl=async(url,init)=>{
    const target=String(url),authorization=new Headers(init?.headers).get('authorization');
    requests.push({target,authorization,method:init?.method});
    if(target.includes('/access/groups/')){
      assert.equal(authorization,`Bearer ${groupToken}`);
      return response({success:true,result:group()});
    }
    assert.match(target,/\/d1\/database\//u);
    assert.equal(authorization,`Bearer ${managementToken}`);
    return response({success:true,result:{uuid:extended.target.databaseId,name:'synthetic-cutover-db'}});
  };
  const observed=await readNativeStaffAccessGroupObservation({config:extended,
    getAccessGroupReadCredential:async()=>credential(groupToken),fetchImpl,now:()=>now});
  const provider=createApprovedExecutorD1Provider({config:{...extended,target:{...extended.target,databaseName:'synthetic-cutover-db'}},
    getBearerToken:async()=>managementToken,fetchImpl});
  await provider.assertTarget();
  assert.equal(observed.groupId,config.accessGroup.id);
  assert.deepEqual(requests.map(item=>item.authorization),[`Bearer ${groupToken}`,`Bearer ${managementToken}`]);
  assert.equal(requests[0].method,'GET');
  assert.equal(requests[1].method,'GET');

  let groupReads=0,deniedCalls=0;
  await assert.rejects(readNativeStaffAccessGroupObservation({config:extended,
    getAccessGroupReadCredential:async()=>{groupReads++;return credential(groupToken);},
    fetchImpl:async(url,init)=>{
      deniedCalls++;
      assert.match(String(url),/\/access\/groups\//u);
      assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${groupToken}`);
      return response({success:false,errors:[{code:10000,message:'denied'}]},{status:403});
    },now:()=>now}),/provider_response_invalid/u);
  assert.equal(groupReads,1);
  assert.equal(deniedCalls,1);
  assert.equal(requests.length,2);
});

test('the closed cutover runtime manifest includes every capsule runtime dependency at its current byte hash',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const manifest=JSON.parse(readFileSync(path.join(root,'scripts/native-staff-cutover-distribution-manifest.json'),'utf8'));
  const entries=[...NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES].sort();
  assert.deepEqual(manifest.files.map(entry=>entry.path),entries);
  const changedRuntimePaths=new Set(['scripts/access-group-read-capsule.mjs','scripts/access-group-read-capsule-pins.mjs',
    'scripts/access-group-read-capsule-unseal.ps1','scripts/native-staff-cutover-access-group-observation.mjs',
    'scripts/native-staff-cutover-approved-executor.mjs','scripts/native-staff-cutover-distribution-pin.mjs',
    'scripts/native-staff-cutover-owner-approval-cli.mjs']);
  for(const entry of manifest.files){
    if(entry.path==='apps/operations/node_modules/wrangler/wrangler-dist/cli.js'){
      assert.equal(entry.sha256,'a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd');
      continue;
    }
    if(process.platform==='win32'&&changedRuntimePaths.has(entry.path))
      assert.equal(entry.sha256,sha(readFileSync(path.join(root,entry.path))),entry.path);
  }
  assert.ok(manifest.files.some(entry=>entry.path==='scripts/access-group-read-capsule.mjs'));
  assert.ok(manifest.files.some(entry=>entry.path==='scripts/access-group-read-capsule-pins.mjs'));
  assert.ok(manifest.files.some(entry=>entry.path==='scripts/access-group-read-capsule-unseal.ps1'));
});
