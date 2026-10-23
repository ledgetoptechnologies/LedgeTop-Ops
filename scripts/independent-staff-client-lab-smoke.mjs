// Exercises only the synthetic loopback lab. No configurable host or credentials.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
const origin = 'http://127.0.0.1:8789';
const page = await fetch(`${origin}/`, {signal:AbortSignal.timeout(10_000)});
assert.equal(page.status,200);
const token = (await page.text()).match(/const token="([a-f0-9]{64})"/)?.[1];
assert.ok(token,'Synthetic lab token must be present');
async function request(path,value,headers={}) {
  return fetch(`${origin}${path}`,{method:value?'POST':'GET',headers:{'X-Lab-Token':token,
    ...(value?{'Origin':origin,'Content-Type':'application/json'}:{}),...headers},
    ...(value?{body:JSON.stringify(value)}:{}),signal:AbortSignal.timeout(10_000)});
}
const state = async()=>{const r=await request('/api/state');assert.equal(r.status,200);return r.json();};
assert.equal((await fetch(`${origin}/api/state`)).status,403);
assert.equal((await request('/api/state',null,{'X-Lab-Token':'wrong'})).status,403);
assert.equal((await request('/api/employee',{}, {'Origin':'https://untrusted.invalid'})).status,403);
const wrongHostStatus = await new Promise((resolve,reject) => {
  const req=httpRequest(`${origin}/api/state`,{headers:{Host:'untrusted.invalid','X-Lab-Token':token}},res=>{res.resume();resolve(res.statusCode);});
  req.on('error',reject);req.setTimeout(10_000,()=>req.destroy(Error('Host check timed out')));req.end();
});
assert.equal(wrongHostStatus,403);
let before = await state();
const name = 'Synthetic Browser/HTTP Edited Employee';
assert.equal((await request('/api/employee',{action:'staff.profile.edit',expectedVersion:before.employee.profileVersion,displayName:name})).status,200);
let after = await state();
assert.equal(after.employee.displayName,name);
assert.equal(after.receiptCount,before.receiptCount+1);
assert.equal((await request('/api/employee',{action:'staff.profile.edit',expectedVersion:before.employee.profileVersion,displayName:'Stale overwrite'})).status,409);
assert.equal((await state()).employee.displayName,name);
assert.equal((await request('/api/pa-employee-event',{})).status,200);
assert.deepEqual((await state()).employee,after.employee);
assert.equal((await request('/api/employee',{action:'staff.admission.disable',expectedVersion:after.employee.admissionVersion})).status,200);
after = await state();
assert.equal(after.nativeLoginAllowed,false);
assert.equal((await request('/api/employee',{action:'staff.admission.enable',expectedVersion:after.employee.admissionVersion})).status,200);
assert.equal((await state()).nativeLoginAllowed,true);
before = await state();
assert.equal((await request('/api/client-update',{id:'synthetic-drone-only',name:'Synthetic Drone Client HTTP Update'})).status,200);
after = await state();
assert.equal(after.clients.find(c=>c.id==='synthetic-drone-only').name,'Synthetic Drone Client HTTP Update');
assert.deepEqual(after.clients.filter(c=>c.source==='project-alpha:secondary'),before.clients.filter(c=>c.source==='project-alpha:secondary'));
assert.equal((await request('/api/client-update',{id:'not-a-fixture',name:'No access'})).status,409);
console.log('Synthetic lab HTTP smoke passed: Host/Origin/token refusals, profile edit/stale refusal, PA employee isolation, native disable/enable, client source isolation.');
