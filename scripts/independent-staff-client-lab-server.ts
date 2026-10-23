// Developer-only loopback lab. Never mounted in either production Worker.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createIndependentStaffClientFixture } from './independent-staff-client-fixture';
import { executeNativeStaffManagementCommand } from '../apps/operations/src/worker/native-staff-management-command';
import { applyEntitlementEventForSource, applyProjectionEventForSource } from '../apps/ops-sync/src/projection';
import { resolveNativeStaffIdentity } from '../apps/operations/src/worker/native-staff-identity';

declare const LAB_PORT: number;
const fixture = await createIndependentStaffClientFixture();
const { db, environment, dataset, sources } = fixture;
const token = randomBytes(32).toString('hex');
const origin = `http://127.0.0.1:${LAB_PORT}`;
const actor = { staffId: 'synthetic-admin', verifiedAccessSubject: 'synthetic-admin-subject' };
let lastEvent = 'Synthetic dataset initialized. All data is temporary.';
let pending = Promise.resolve();

async function state() {
  const employee = await db.prepare(`SELECT p.staff_id id,p.display_name displayName,p.login_email email,p.version profileVersion,
    a.active,a.version admissionVersion FROM native_staff_profiles p JOIN native_staff_admissions a USING(staff_id)
    WHERE p.staff_id=?`).bind(dataset.opsEmployee.id).first();
  const clients = (await db.prepare(`SELECT m.projection_source_id source,m.external_id id,c.name
    FROM pa_clients c JOIN pa_projection_record_ids m ON m.local_id=c.id AND m.record_kind='client'
    WHERE m.external_id LIKE 'synthetic-%' ORDER BY m.external_id,m.projection_source_id`).all()).results;
  const admitted = await resolveNativeStaffIdentity(db, {
    verifiedEmail: dataset.opsEmployee.email, verifiedAccessSubject: 'synthetic-employee-subject',
  });
  return { employee, clients, nativeLoginAllowed: admitted !== null, lastEvent,
    receiptCount: await db.prepare('SELECT count(*) FROM native_staff_management_commands').first('count(*)') };
}

async function projectClient(client: any, name: string) {
  for (const destination of client.destinations) {
    const eventId = randomUUID(), at = new Date().toISOString();
    await applyProjectionEventForSource(environment, sources[destination], {
      event_id: eventId, event_type: 'projection.changed', occurred_at: at, schema_version: 1, application_key: 'ltds_ops',
      projection: { entity_type: 'client', entity_id: client.id, action: 'upsert', source_updated_at: at,
        data: { id: client.id, name, email: client.email, active: true } },
    }, `lab-${eventId}`);
  }
}
for (const client of dataset.clients) await projectClient(client, client.name);

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ledge Top — synthetic employee/client lab</title>
<style>body{font:16px system-ui;max-width:960px;margin:32px auto;padding:0 20px;color:#17232d;background:#f4f6f8}section{background:white;padding:24px;border:1px solid #d9e0e5;border-radius:12px;margin:20px 0}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:9px;border:1px solid #9ca9b1;border-radius:6px}button{cursor:pointer;margin:6px 6px 6px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:26px}.note{color:#54636e}</style>
<h1>Ledge Top — synthetic employee/client lab</h1>
<p class="note">Temporary local D1 data only. No production connections, emails, files, or permissions. This panel calls the real Ops native employee-command and PA inbound-projection services. It does not test outbound PA delivery or the deployed sign-in flow.</p>
<section><h2>Independent Ops employee</h2><pre id="employee"></pre>
<form id="employeeForm"><label>Display name <input id="employeeName" maxlength="160" required></label><button>Save Ops profile</button></form>
<button id="disable">Disable native admission</button><button id="enable">Enable native admission</button>
<button id="paEvent">Simulate PA revocation for the same email</button>
<p class="note">PA's event must leave the Ops employee unchanged. Native admission controls this lab's native identity resolver; production still uses its existing login until a separate tested cutover.</p></section>
<section><h2>Client source isolation</h2><p class="note">Simulates incoming PA client updates for each fixture's selected destinations: Drone Services, Technologies, or both. These are source projections, not a live two-server fanout test.</p>
<form id="clientForm"><label>Dummy client <select id="client"></select></label><label>Client name <input id="clientName" maxlength="160" required></label><button>Simulate selected PA updates</button></form><pre id="clients"></pre></section>
<section><h2>Result</h2><pre id="result" role="status"></pre></section>
<script>
const token=${JSON.stringify(token)};
let current;
async function api(path,value){const r=await fetch(path,{method:value?'POST':'GET',headers:{'X-Lab-Token':token,...(value?{'Content-Type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
async function refresh(){current=await api('/api/state');document.getElementById('employee').textContent=JSON.stringify({...current.employee,nativeLoginAllowed:current.nativeLoginAllowed},null,2);document.getElementById('employeeName').value=current.employee.displayName;document.getElementById('clients').textContent=JSON.stringify(current.clients.map(c=>({...c,source:c.source==='project-alpha:primary'?'Ledge Top Drone Services':'Ledge Top Technologies'})),null,2);document.getElementById('result').textContent=current.lastEvent+' | Audit receipts: '+current.receiptCount;}
async function act(path,data){try{await api(path,data);await refresh();}catch(e){document.getElementById('result').textContent=e.message;}}
document.getElementById('employeeForm').onsubmit=e=>{e.preventDefault();act('/api/employee',{action:'staff.profile.edit',expectedVersion:current.employee.profileVersion,displayName:document.getElementById('employeeName').value});};
for(const action of ['enable','disable'])document.getElementById(action).onclick=()=>act('/api/employee',{action:'staff.admission.'+action,expectedVersion:current.employee.admissionVersion});
document.getElementById('paEvent').onclick=()=>act('/api/pa-employee-event',{});
document.getElementById('clientForm').onsubmit=e=>{e.preventDefault();act('/api/client-update',{id:document.getElementById('client').value,name:document.getElementById('clientName').value});};
const fixtures=${JSON.stringify(dataset.clients.map((c: any) => ({id:c.id,name:c.name}))).replace(/</g, '\\u003c')};
for(const item of fixtures){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;document.getElementById('client').append(option);}
refresh().catch(e=>document.getElementById('result').textContent=e.message);
</script></html>`;

async function mutate(path: string, value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_request');
  if (path === '/api/employee') {
    if (!['staff.profile.edit','staff.admission.enable','staff.admission.disable'].includes(value.action)) throw Error('invalid_action');
    const receipt = await executeNativeStaffManagementCommand(db, {
      commandId: `synthetic-${randomUUID()}`, contractVersion: 1, capability: value.action, actor,
      targetStaffId: dataset.opsEmployee.id, expectedVersion: value.expectedVersion, reason: 'Synthetic loopback lab exercise',
      ...(value.action === 'staff.profile.edit' ? {displayName: value.displayName} : {}),
    });
    lastEvent = `Ops-only command ${receipt.capability} completed at version ${receipt.resultVersion}. No PA call was made.`;
  } else if (path === '/api/pa-employee-event') {
    const eventId = randomUUID();
    const result = await applyEntitlementEventForSource(environment, sources.ltds, {
      event_id:eventId,event_type:'application_entitlement.revoked',occurred_at:new Date().toISOString(),schema_version:1,
      user:{id:'synthetic-pa-employee',email:dataset.opsEmployee.email,display_name:'Synthetic PA employee changed',active:false},
      entitlement:{application_key:'ltds_ops',enabled:false,role_key:'role-admin',business_unit_ids:[]},
    }, `lab-${eventId}`);
    lastEvent = `PA employee event ${result}; Ops employee and native admission unchanged.`;
  } else if (path === '/api/client-update') {
    const client = dataset.clients.find((c: any) => c.id === value.id);
    if (!client || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) throw Error('invalid_client');
    await projectClient(client, value.name.trim());
    lastEvent = `Synthetic inbound client projection updated only ${client.destinations.join(', ')}.`;
  } else throw Error('unknown_action');
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const reply = (status: number, data: any) => {response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(data));};
  if (request.headers.host !== `127.0.0.1:${LAB_PORT}`) { reply(403,{error:'loopback_host_required'}); return; }
  if (request.method === 'GET' && request.url === '/') {response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
  if (request.headers['x-lab-token'] !== token) {reply(403,{error:'lab_token_required'});return;}
  try {
    if (request.method === 'GET' && request.url === '/api/state') {await pending;reply(200,await state());return;}
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {reply(403,{error:'same_origin_json_required'});return;}
    let body = '', length = 0;
    for await (const chunk of request) {length += Buffer.byteLength(chunk);if (length > 16_384) {reply(413,{error:'request_too_large'});return;}body += chunk;}
    const value = JSON.parse(body);
    if (request.url === '/api/shutdown') {reply(200,{ok:true});setTimeout(() => void close(),50);return;}
    const operation = pending.then(() => mutate(request.url!,value));
    pending = operation.catch(() => {});
    await operation;
    reply(200,{ok:true});
  } catch {reply(409,{error:'Command refused. Refresh the current version and check the synthetic target and authority.'});}
});
server.listen(LAB_PORT,'127.0.0.1',() => console.log(`Synthetic Ledge Top lab ready at ${origin}. Ctrl+C discards all lab data.`));
async function close() {server.close();await fixture.runtime.dispose();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
