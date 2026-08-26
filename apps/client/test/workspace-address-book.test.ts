import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {createWorkspaceAddressContact,deleteWorkspaceAddressContact,listWorkspaceAddressContacts,prepareAddressBookContactSelection,
 readWorkspaceAddressContact,updateWorkspaceAddressContact,workspaceAddressBookAvailable,workspaceAddressBookReady} from '../src/worker/client-portal/workspace-address-book';
import {createWorkspaceInvitation} from '../src/worker/client-portal/workspace-memberships';

let mf:Miniflare,db:D1Database,sequence=0;
type TestEnv=Parameters<typeof createWorkspaceAddressContact>[0];
let env:TestEnv;
const issuer='https://address-access.example.test',source='project-alpha:primary';
const value=(n:string,email=`${n}@example.test`)=>({displayName:`Contact ${n}`,email,phone:'+1 555 0100',company:'Acme Field',roleOrTrade:'Surveyor'});
async function fixture(options:{standalone?:boolean;projectOnly?:boolean}={}){
 const n=++sequence,id=`address-${n}`,generation=`address-generation-${n}`,root=`address-root-${n}`,project=`address-project-${n}`,identity=`address-manager-${n}`;
 const principal={issuer,subject:identity,email:`${identity}@example.test`},standalone=options.standalone===true;
 await db.batch([
  db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status) VALUES(?,?,?,?,?,'active')`)
   .bind(id,standalone?'standalone_client':'organization',standalone?null:root,standalone?root:null,`Workspace ${n}`),
  db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)`).bind(generation,id,generation),
  db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(generation,id),
  db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,?,?,?,'root-v1')`)
   .bind(id,generation,standalone?'standalone_client':'organization',root,`Root ${n}`),
  db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'project-v1')`)
   .bind(id,generation,project,root,`Project ${n}`),
  db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
   VALUES(?,?,'root-project','contains',?,?,'project',?,'relation-v1')`).bind(id,generation,standalone?'standalone_client':'organization',root,project),
  db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES(?,?,?,'active','project-v1')`).bind(id,generation,project),
  db.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
   VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(source,`address-receipt-${n}`,id,'a'.repeat(64)),
  db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(id,generation),
  db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)`).bind(identity,issuer,identity,principal.email),
  db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES(?,?,?,'operations')`).bind(`address-membership-${n}`,id,identity),
  db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
   VALUES(?,?,?,'workspace.view','workspace',?,'operations')`).bind(`${n}-view`,id,identity,id),
  db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
   VALUES(?,?,?,'member.manage',?,?, 'operations')`).bind(`${n}-manage`,id,identity,options.projectOnly?'project':'workspace',options.projectOnly?project:id),
  db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
   VALUES(?,?,?,'delivery.view','workspace',?,'operations')`).bind(`${n}-delivery`,id,identity,id),
  db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
   VALUES(?,?,?,'request.create','workspace',?,'operations')`).bind(`${n}-request`,id,identity,id),
  db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id) VALUES(?,'allowed',1,'staff')`).bind(id),
 ]);
 return {id,generation,root,project,identity,principal};
}
async function counts(workspaceId:string){const tables=['portal_v2_identities','portal_v2_workspace_memberships','portal_v2_entitlements','portal_v2_invitations','portal_v2_invitation_email_outbox'];
 const result:Record<string,number>={};for(const table of tables)result[table]=await db.prepare(`SELECT count(*) n FROM ${table}${table==='portal_v2_identities'?'':' WHERE '+(table.includes('invitation_email')?`invitation_id IN (SELECT id FROM portal_v2_invitations WHERE workspace_id=?)`:'workspace_id=?')}`)
  .bind(...(table==='portal_v2_identities'?[]:[workspaceId])).first<number>('n')??0;return result;}
function failAfterCommittedBatch(database:D1Database,afterCommit:()=>Promise<void>):D1Database{
 let proxy:D1Database;proxy=new Proxy(database,{get(target,key){
  if(key==='withSession')return()=>proxy;
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);await afterCommit();throw new Error('simulated lost response');};
  const member=target[key as keyof D1Database];return typeof member==='function'?member.bind(target):member;
 }});return proxy;
}

describe('workspace address book: real migrated D1',{concurrent:false,timeout:60_000},()=>{
 beforeAll(async()=>{mf=new Miniflare({modules:true,compatibilityDate:'2026-07-16',script:"export default {fetch(){return new Response('address')}}",d1Databases:['DB']});
  db=await mf.getD1Database('DB') as D1Database;const path=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(path).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)<='0166').sort())
   await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
  env={DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',
   CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED:'true',CLIENT_PORTAL_ADDRESS_BOOK_ENABLED:'true',
   CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET:'f'.repeat(64),DELIVERY_SESSION_SECRET:'s'.repeat(64)};
 },180_000);
 afterAll(async()=>mf.dispose());

 it('provisions address state for new primary workspaces but keeps standalone workspaces unavailable',async()=>{
  expect(await workspaceAddressBookReady(db)).toBe(true);const org=await fixture(),standalone=await fixture({standalone:true});
  expect(await db.prepare(`SELECT source_id FROM portal_workspace_address_book_states WHERE workspace_id=?`).bind(org.id).first('source_id')).toBe(source);
  expect(await db.prepare(`SELECT source_id FROM portal_workspace_address_book_states WHERE workspace_id=?`).bind(standalone.id).first('source_id')).toBeNull();
  expect(await workspaceAddressBookAvailable({...env,CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET:undefined})).toBe(false);
  await expect(createWorkspaceAddressContact(env,standalone.principal,standalone.id,value('standalone'),crypto.randomUUID())).rejects.toMatchObject({status:404});
 });

 it('creates local descriptive records idempotently, permits shared email, derives prior invitation, and creates no authority',async()=>{
  const f=await fixture(),before=await counts(f.id),key=crypto.randomUUID(),created=await createWorkspaceAddressContact(env,f.principal,f.id,value('one','shared@example.test'),key);
  expect(created).toMatchObject({replayed:false,contact:{displayName:'Contact one',email:'shared@example.test',company:'Acme Field',roleOrTrade:'Surveyor',version:1,previousInvitation:null}});
  expect((await createWorkspaceAddressContact(env,f.principal,f.id,value('one','shared@example.test'),key)).contact.id).toBe(created.contact.id);
  const rotatedEnv={...env,DELIVERY_SESSION_SECRET:'r'.repeat(64),DELIVERY_PREVIOUS_SESSION_SECRET:'s'.repeat(64)};
  expect((await createWorkspaceAddressContact(rotatedEnv,f.principal,f.id,value('one','shared@example.test'),key)).contact.id).toBe(created.contact.id);
  const second=await createWorkspaceAddressContact(env,f.principal,f.id,value('two','shared@example.test'),crypto.randomUUID());expect(second.contact.id).not.toBe(created.contact.id);
  expect(await counts(f.id)).toEqual(before);
  await db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at)
   VALUES(?,?,?,?,?,datetime('now','+7 days'))`).bind(crypto.randomUUID(),f.id,'t'.repeat(43),'shared@example.test',f.identity).run();
  expect((await readWorkspaceAddressContact(env,f.principal,f.id,created.contact.id)).contact.previousInvitation).toMatchObject({status:'pending'});
 });

 it('returns a stable capacity error instead of leaking a failed D1 guard',async()=>{
  const f=await fixture();await db.prepare(`WITH RECURSIVE sequence(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM sequence WHERE value<999)
   INSERT INTO portal_workspace_address_contacts(id,workspace_id,source_id,display_name,sort_name,email,email_key,created_by_identity_id,updated_by_identity_id)
   SELECT printf('capacity-%s-%04d',?1,value),?1,?2,printf('Capacity %04d',value),printf('capacity %04d',value),
    printf('capacity-%04d@example.test',value),printf('capacity-%04d@example.test',value),?3,?3 FROM sequence`)
   .bind(f.id,source,f.identity).run();
  await expect(createWorkspaceAddressContact(env,f.principal,f.id,value('overflow'),crypto.randomUUID()))
   .rejects.toMatchObject({status:409,message:'address_book_capacity'});
  expect(await db.prepare(`SELECT count(*) n FROM portal_workspace_address_contact_commands WHERE workspace_id=?`).bind(f.id).first('n')).toBe(0);
 });

 it('uses CAS, exact-version replay, keyed non-PII fingerprints and scrubbed deletion tombstones',async()=>{
  const f=await fixture(),createKey=crypto.randomUUID(),created=await createWorkspaceAddressContact(env,f.principal,f.id,value('private','private@example.test'),createKey),updateKey=crypto.randomUUID();
  const updated=await updateWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,{...value('updated','updated@example.test'),expectedVersion:1},updateKey);
  expect(updated.contact.version).toBe(2);expect((await updateWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,{...value('updated','updated@example.test'),expectedVersion:1},updateKey)).contact.version).toBe(2);
  await expect(createWorkspaceAddressContact(env,f.principal,f.id,value('private','private@example.test'),createKey)).rejects.toMatchObject({status:409});
  await expect(updateWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,{...value('stale'),expectedVersion:1},crypto.randomUUID())).rejects.toMatchObject({status:409});
  const deleteKey=crypto.randomUUID(),deleted=await deleteWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,2,deleteKey);expect(deleted.contact).toMatchObject({status:'deleted',version:3});
  expect((await deleteWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,2,deleteKey)).contact).toMatchObject({status:'deleted',version:3});
  await expect(updateWorkspaceAddressContact(env,f.principal,f.id,created.contact.id,{...value('updated','updated@example.test'),expectedVersion:1},updateKey)).rejects.toMatchObject({status:409});
  const row=await db.prepare(`SELECT display_name,email,phone,company,role_or_trade FROM portal_workspace_address_contacts WHERE id=?`).bind(created.contact.id).first();
  expect(row).toEqual({display_name:null,email:null,phone:null,company:null,role_or_trade:null});
  const hashes=(await db.prepare(`SELECT request_hash FROM portal_workspace_address_contact_commands WHERE workspace_id=?`).bind(f.id).all<{request_hash:string}>()).results;
  expect(hashes.every(item=>/^[a-f0-9]{64}$/.test(item.request_hash))).toBe(true);expect(JSON.stringify(hashes)).not.toContain('private');
  const audit=(await db.prepare(`SELECT changed_fields_json FROM portal_workspace_address_contact_audit WHERE contact_id=?`).bind(created.contact.id).all<{changed_fields_json:string}>()).results;
  expect(JSON.stringify(audit)).not.toContain('example.test');await expect(readWorkspaceAddressContact(env,f.principal,f.id,created.contact.id)).rejects.toMatchObject({status:404});
 });

 it('searches before LIMIT, pages with an encrypted context cursor, and rejects revision changes',async()=>{
  const f=await fixture(),values=Array.from({length:28},(_,index)=>({id:`bulk-${f.id}-${String(index).padStart(2,'0')}`,...value(`bulk ${String(index).padStart(2,'0')}`),
   marker:index===26?'Needle Company':'Acme Field'}));
  await db.batch(values.map(item=>db.prepare(`INSERT INTO portal_workspace_address_contacts(id,workspace_id,source_id,display_name,sort_name,email,email_key,phone,company,company_key,role_or_trade,role_key,created_by_identity_id,updated_by_identity_id)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id,f.id,source,item.displayName,item.displayName.toLocaleLowerCase('en-US'),item.email,item.email.toLocaleLowerCase('en-US'),item.phone,
    item.marker,item.marker.toLocaleLowerCase('en-US'),item.roleOrTrade,item.roleOrTrade!.toLocaleLowerCase('en-US'),f.identity,f.identity)));
  const searched=await listWorkspaceAddressContacts(env,f.principal,f.id,{q:'needle'});expect(searched.items).toHaveLength(1);expect(searched.items[0]?.company).toBe('Needle Company');
  const revision=await db.prepare(`SELECT revision FROM portal_workspace_address_book_states WHERE workspace_id=?`).bind(f.id).first<number>('revision');
  const plain=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({workspaceId:f.id,sourceId:source,
   identityId:f.identity,revision,q:'needle'}))));
  expect(searched.contextVersion).not.toBe([...plain].map(byte=>byte.toString(16).padStart(2,'0')).join(''));
  expect(searched.contextVersion).toMatch(/^[a-f0-9]{64}$/);
  const first=await listWorkspaceAddressContacts(env,f.principal,f.id,{q:''});expect(first.items).toHaveLength(25);expect(first.nextCursor).toMatch(/^ab1_/);
  const second=await listWorkspaceAddressContacts(env,f.principal,f.id,{q:'',cursor:first.nextCursor!});expect(second.items).toHaveLength(3);
  await createWorkspaceAddressContact(env,f.principal,f.id,value('changed'),crypto.randomUUID());
  await expect(listWorkspaceAddressContacts(env,f.principal,f.id,{q:'',cursor:first.nextCursor!})).rejects.toMatchObject({status:409});
  await expect(listWorkspaceAddressContacts(env,f.principal,f.id,{q:'',cursor:first.nextCursor!.slice(0,-2)+'aa'})).rejects.toMatchObject({status:400});
 });

 it('denies project-only managers and applies live identity denials without leaking contacts',async()=>{
  const scoped=await fixture({projectOnly:true});await expect(listWorkspaceAddressContacts(env,scoped.principal,scoped.id,{q:''})).rejects.toMatchObject({status:404});
  const f=await fixture();await createWorkspaceAddressContact(env,f.principal,f.id,value('hidden'),crypto.randomUUID());
  await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,scope_type,status,reason_code,created_by_actor_type,created_by_actor_id)
   VALUES(?,?,'global','active','address_book_test','staff','staff')`).bind(crypto.randomUUID(),f.identity).run();
  await expect(listWorkspaceAddressContacts(env,f.principal,f.id,{q:''})).rejects.toMatchObject({status:404});
 });

 it('uses a selected contact only as an exact direct/request consistency fence',async()=>{
  const f=await fixture(),contact=(await createWorkspaceAddressContact(env,f.principal,f.id,value('invite','invite@example.test'),crypto.randomUUID())).contact;
  const direct=await createWorkspaceInvitation(env,f.principal,f.id,{email:contact.email,addressContact:{id:contact.id,expectedVersion:contact.version},
   organizationWide:true,confirmOrganizationWide:true,capabilities:['delivery.view'],expectedInvitationPolicyVersion:1},crypto.randomUUID(),{emailDeliveryAvailable:true});
  expect(direct.outcome).toBe('created');expect(await db.prepare(`SELECT count(*) n FROM portal_v2_identities WHERE verified_email='invite@example.test'`).first('n')).toBe(0);
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='require_approval',version=2 WHERE workspace_id=?`).bind(f.id).run();
  const requested=await createWorkspaceInvitation(env,f.principal,f.id,{email:contact.email,addressContact:{id:contact.id,expectedVersion:contact.version},
   organizationWide:true,confirmOrganizationWide:true,capabilities:['request.create'],expectedInvitationPolicyVersion:2},crypto.randomUUID(),{emailDeliveryAvailable:false});
  expect(requested.outcome).toBe('approval_requested');expect(await db.prepare(`SELECT count(*) n FROM portal_v2_invitations WHERE workspace_id=?`).bind(f.id).first('n')).toBe(1);
  await expect(createWorkspaceInvitation(env,f.principal,f.id,{email:'different@example.test',addressContact:{id:contact.id,expectedVersion:contact.version},
   organizationWide:true,confirmOrganizationWide:true,capabilities:['delivery.view'],expectedInvitationPolicyVersion:2},crypto.randomUUID(),{emailDeliveryAvailable:false})).rejects.toMatchObject({status:409});
  const selected=await prepareAddressBookContactSelection(env,f.id,{id:contact.id,expectedVersion:contact.version},contact.email);
  await db.prepare(`UPDATE portal_workspace_address_contacts SET display_name=display_name,version=version+1,updated_by_identity_id=? WHERE id=?`).bind(f.identity,contact.id).run();
  await expect(db.batch([selected.fence(crypto.randomUUID())])).rejects.toThrow();
 });

 it('returns an exact committed invitation winner before a selected contact later disappears',async()=>{
  const f=await fixture(),contact=(await createWorkspaceAddressContact(env,f.principal,f.id,value('winner','winner@example.test'),crypto.randomUUID())).contact,
   key=crypto.randomUUID(),racing={...env,DELIVERY_DB:failAfterCommittedBatch(db,async()=>{
    await db.prepare(`UPDATE portal_workspace_address_contacts SET display_name=NULL,sort_name=NULL,email=NULL,email_key=NULL,phone=NULL,company=NULL,company_key=NULL,
     role_or_trade=NULL,role_key=NULL,status='deleted',version=version+1,updated_by_identity_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND status='active'`)
     .bind(f.identity,contact.id,f.id).run();
  })};
  const input={email:contact.email,addressContact:{id:contact.id,expectedVersion:contact.version},organizationWide:true,confirmOrganizationWide:true,
   capabilities:['delivery.view'] as Array<'delivery.view'>,expectedInvitationPolicyVersion:1};
  const result=await createWorkspaceInvitation(racing,f.principal,f.id,input,key,{emailDeliveryAvailable:true});
  expect(result.outcome).toBe('replayed');
  expect(await db.prepare(`SELECT status FROM portal_workspace_address_contacts WHERE id=?`).bind(contact.id).first('status')).toBe('deleted');
  expect((await createWorkspaceInvitation(env,f.principal,f.id,input,key,{emailDeliveryAvailable:true})).outcome).toBe('replayed');
 });
});
