import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createStaffLoginFixture,seedStaffLoginOwner,staffLoginClaims as claims} from './helpers/staff-login-fixture';
import {assertCurrentStaffLogin,claimStaffLoginBindingIntent,createStaffLoginBindingIntent,listStaffLoginBindings,previewStaffLoginBindingIntent,
 resolveVerifiedStaffLogin,revokeStaffLoginBinding,snapshotStaffLoginProof} from '../src/worker/staff-login-bindings';

const issuer='https://synthetic-team.cloudflareaccess.com';
describe('existing-profile alternate login two-proof ledger',{timeout:120_000},()=>{
 let runtime:Awaited<ReturnType<typeof createStaffLoginFixture>>['runtime'],db:D1Database,legacy:D1Database,partial:D1Database;
 beforeAll(async()=>{
  const f=await createStaffLoginFixture({includeCompatibilityDatabases:true});runtime=f.runtime;db=f.db;legacy=f.legacy!;partial=f.partial!;
 },120_000);
 afterAll(async()=>runtime?.dispose());
 async function seed(label:string,current=db){return seedStaffLoginOwner(current,label);}
 async function primary(o:Awaited<ReturnType<typeof seed>>,current=db){const r=await resolveVerifiedStaffLogin(current,claims(o.email,o.subject));expect(r?.proof.kind).toBe('primary');return r!.proof;}
 async function link(o:Awaited<ReturnType<typeof seed>>){const intent=await createStaffLoginBindingIntent(db,await primary(o),o.alternate);
  const result=await claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent);return {intent,result};}
 async function seedBindingHistory(o:Awaited<ReturnType<typeof seed>>,count:number,revoked:boolean){
  await db.prepare('INSERT INTO staff_login_generations VALUES(?,0)').bind(o.id).run();
  const statements:D1PreparedStatement[]=[],created=Date.now()-10_000;
  for(let i=0;i<count;i++){
   const intentId=crypto.randomUUID(),bindingId=crypto.randomUUID(),address=`history-${o.id}-${i}@example.test`,subject=`access|history-${o.id}-${i}`;
   statements.push(db.prepare('INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(intentId,o.id,o.email,o.subject,issuer,address,intentId.replaceAll('-','').padStart(64,'0'),i*(revoked?2:1),created+i,created+i+900_000));
   statements.push(db.prepare('INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms) VALUES(?,?,?,?,?,?,?)')
    .bind(bindingId,o.id,issuer,address,subject,intentId,created+i));
   if(revoked)statements.push(db.prepare("UPDATE staff_login_bindings SET status='revoked',version=2,revoked_at_ms=?,revoked_by_staff_id=? WHERE id=?")
    .bind(created+i+1,o.id,bindingId));
  }
  for(let i=0;i<statements.length;i+=50)await db.batch(statements.slice(i,i+50));
 }

 it('links two independently verified logins to one profile without changing its canonical identity, roles or durable admission grants',async()=>{
  const o=await seed('shared'),before=await primary(o),{intent,result}=await link(o);
  const a=await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject)),p=await resolveVerifiedStaffLogin(db,claims(o.email,o.subject));
  expect(a?.staff).toEqual(p?.staff);expect(a?.staff).toMatchObject({id:o.id,email:o.email,accessSubject:o.subject});
  expect(a?.proof).toMatchObject({kind:'alternate',email:o.alternate,subject:o.alternateSubject,canonicalSubject:o.subject,bindingId:result.bindingId,generation:1});
  expect(p?.proof).toMatchObject({kind:'primary',subject:o.subject,generation:1});
  expect(await assertCurrentStaffLogin(db,before)).toBe(false);expect(await assertCurrentStaffLogin(db,a!.proof)).toBe(true);
  expect(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version')).toBe(18);
  expect(await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(o.id).first('version')).toBe(7);
  expect(await db.prepare('SELECT count(*) n FROM test_employee_grants g JOIN native_staff_admissions a ON a.staff_id=g.staff_id AND a.version=g.admission_version WHERE g.staff_id=?').bind(o.id).first('n')).toBe(1);
  expect(await db.prepare('SELECT count(*) n FROM staff_users WHERE id=? OR email=?').bind(o.id,o.alternate).first('n')).toBe(1);
  expect(await db.prepare('SELECT count(*) n FROM staff_role_assignments WHERE staff_id=?').bind(o.id).first('n')).toBe(1);
  const row=await db.prepare('SELECT token_sha256,status FROM staff_login_binding_intents WHERE id=?').bind(intent.intentId).first<{token_sha256:string;status:string}>();
  expect(row?.token_sha256).toMatch(/^[a-f0-9]{64}$/);expect(row?.token_sha256).not.toBe(intent.verificationToken);expect(row?.status).toBe('claimed');
 });
 it('a pending intent cannot admit its target and wrong token/email/issuer cannot consume it',async()=>{
  const o=await seed('pending'),intent=await createStaffLoginBindingIntent(db,await primary(o),o.alternate);
  expect(await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject))).toBeNull();
  for(const [c,input] of [[claims(o.alternate,o.alternateSubject),{...intent,verificationToken:'f'.repeat(64)}],
   [claims('wrong@example.test',o.alternateSubject),intent],[{...claims(o.alternate,o.alternateSubject),issuer:'https://other-team.cloudflareaccess.com'},intent]] as const){
   await expect(claimStaffLoginBindingIntent(db,c,input)).rejects.toMatchObject({code:'staff_login_denied'});
  }
  expect(await db.prepare('SELECT status FROM staff_login_binding_intents WHERE id=?').bind(intent.intentId).first('status')).toBe('pending');
  expect(await db.prepare('SELECT count(*) n FROM staff_login_bindings WHERE staff_id=?').bind(o.id).first('n')).toBe(0);
 });
 it('claim replay is stable, cannot rebind a subject, and current proof fails after owner revokes only the alternate login',async()=>{
  const o=await seed('revoke'),{intent,result}=await link(o),oldAlias=(await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject)))!.proof;
  expect(await claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent)).toEqual(result);
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,'access|replacement'),intent)).rejects.toMatchObject({code:'staff_login_denied'});
  expect(await resolveVerifiedStaffLogin(db,claims(o.alternate,'access|replacement'))).toBeNull();
  await expect(revokeStaffLoginBinding(db,oldAlias,{bindingId:result.bindingId,expectedVersion:1})).rejects.toMatchObject({code:'staff_login_denied'});
  expect(await revokeStaffLoginBinding(db,await primary(o),{bindingId:result.bindingId,expectedVersion:1})).toMatchObject({status:'revoked',version:2});
  expect(await assertCurrentStaffLogin(db,oldAlias)).toBe(false);expect(await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject))).toBeNull();
  expect(await primary(o)).toMatchObject({generation:2});
  expect(await revokeStaffLoginBinding(db,await primary(o),{bindingId:result.bindingId,expectedVersion:1})).toMatchObject({status:'revoked',version:2});
  expect(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version')).toBe(19);
  expect(await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(o.id).first('version')).toBe(7);
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent)).rejects.toMatchObject({code:'staff_login_conflict'});
 });
 it('rejects canonical email/subject and active-alias collisions without changing either profile',async()=>{
  const a=await seed('collision-a'),b=await seed('collision-b');
  await expect(createStaffLoginBindingIntent(db,await primary(a),b.email)).rejects.toMatchObject({code:'staff_login_conflict'});
  const intent=await createStaffLoginBindingIntent(db,await primary(a),a.alternate);
  await expect(claimStaffLoginBindingIntent(db,claims(a.alternate,b.subject),intent)).rejects.toMatchObject({code:'staff_login_conflict'});
  const first=await claimStaffLoginBindingIntent(db,claims(a.alternate,a.alternateSubject),intent);
  const second=await createStaffLoginBindingIntent(db,await primary(b),b.alternate);
  await expect(claimStaffLoginBindingIntent(db,claims(b.alternate,a.alternateSubject),second)).rejects.toMatchObject({code:'staff_login_conflict'});
  await expect(db.prepare('UPDATE staff_users SET access_subject=? WHERE id=?').bind(a.alternateSubject,b.id).run()).rejects.toThrow();
  await expect(db.prepare('UPDATE staff_login_bindings SET access_subject=? WHERE id=?').bind('access|new',first.bindingId).run()).rejects.toThrow();
  expect(await primary(b)).toMatchObject({canonicalSubject:b.subject});
 });
 it('requires a current primary owner approval and preserves primary login on malformed or non-owner requests',async()=>{
  const o=await seed('owner'),p=await primary(o);
  await db.prepare("DELETE FROM staff_role_assignments WHERE staff_id=?").bind(o.id).run();
  await expect(createStaffLoginBindingIntent(db,p,o.alternate)).rejects.toMatchObject({code:'staff_login_denied'});
  expect(await primary(o)).toMatchObject({canonicalSubject:o.subject});
  await db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(o.id).run();
  await db.prepare("INSERT INTO staff_permission_overrides VALUES(?,'administration.view','deny','global')").bind(o.id).run();
  await expect(createStaffLoginBindingIntent(db,await primary(o),o.alternate)).rejects.toMatchObject({code:'staff_login_denied'});
 });
 it('denies both login credentials after canonical staff is disabled and rejects expired JWT evidence',async()=>{
  const o=await seed('disabled');await link(o);
  const proof=(await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject)))!.proof;
  await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(o.id).run();
  expect(await resolveVerifiedStaffLogin(db,claims(o.alternate,o.alternateSubject))).toBeNull();
  expect(await resolveVerifiedStaffLogin(db,claims(o.email,o.subject))).toBeNull();expect(await assertCurrentStaffLogin(db,proof)).toBe(false);
  const exp=await seed('expired');expect(await resolveVerifiedStaffLogin(db,{...claims(exp.email,exp.subject),expiresAt:Math.floor(Date.now()/1000)})).toBeNull();
 });
 it('rejects a second proof issued before the intent and a canonical identity change after approval',async()=>{
  const o=await seed('fresh'),intent=await createStaffLoginBindingIntent(db,await primary(o),o.alternate);
  await expect(claimStaffLoginBindingIntent(db,{...claims(o.alternate,o.alternateSubject),issuedAt:Math.floor(Date.now()/1000)-60},intent)).rejects.toMatchObject({code:'staff_login_denied'});
  await db.prepare('UPDATE staff_users SET access_subject=? WHERE id=?').bind('access|changed',o.id).run();
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent)).rejects.toMatchObject({code:'staff_login_conflict'});
 });
 it('an expired fifteen-minute approval cannot create a binding even with a current secondary JWT',async()=>{
  const o=await seed('intent-expiry'),intentId=crypto.randomUUID(),token='b'.repeat(64);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const created=Date.now()-900_100;
  await db.batch([
   db.prepare('INSERT INTO staff_login_generations VALUES(?,0)').bind(o.id),
   db.prepare('INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,0,?,?)')
    .bind(intentId,o.id,o.email,o.subject,issuer,o.alternate,digest,created,created+900_000),
  ]);
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),{intentId,verificationToken:token})).rejects.toMatchObject({code:'staff_login_conflict'});
  await expect(previewStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),{intentId,verificationToken:token})).rejects.toMatchObject({code:'staff_login_conflict'});
  await expect(previewStaffLoginBindingIntent(db,claims('wrong-expired@example.test',o.alternateSubject),{intentId,verificationToken:token})).rejects.toMatchObject({code:'staff_login_denied'});
  expect(await db.prepare('SELECT count(*) n FROM staff_login_bindings WHERE staff_id=?').bind(o.id).first('n')).toBe(0);
 });
 it('returns only bounded safe own inventory and rejects another owner revoking the binding',async()=>{
  const o=await seed('list'),other=await seed('list-other'),{intent,result}=await link(o);
  const list=await listStaffLoginBindings(db,await primary(o));expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({bindingId:result.bindingId,email:o.alternate,status:'active',version:1,revokedAt:null});
  expect(JSON.stringify(list)).not.toContain(o.alternateSubject);expect(JSON.stringify(list)).not.toContain(intent.verificationToken);
  expect(Object.keys(list[0]!).sort()).toEqual(['bindingId','createdAt','email','revokedAt','status','version']);
  await expect(revokeStaffLoginBinding(db,await primary(other),{bindingId:result.bindingId,expectedVersion:1})).rejects.toMatchObject({code:'staff_login_conflict'});
 });
 it('rolls back binding, consumed intent, generation, profile change and audit on a failed profile update',async()=>{
  const o=await seed('rollback'),intent=await createStaffLoginBindingIntent(db,await primary(o),o.alternate);
  await db.prepare(`CREATE TRIGGER reject_test_profile BEFORE UPDATE ON native_staff_profiles WHEN OLD.staff_id='owner-rollback' BEGIN SELECT RAISE(ABORT,'test_profile_failure'); END`).run();
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent)).rejects.toMatchObject({code:'staff_login_unavailable'});
  expect(await db.prepare('SELECT status FROM staff_login_binding_intents WHERE id=?').bind(intent.intentId).first('status')).toBe('pending');
  expect(await db.prepare('SELECT count(*) n FROM staff_login_bindings WHERE staff_id=?').bind(o.id).first('n')).toBe(0);
  expect(await db.prepare('SELECT generation FROM staff_login_generations WHERE staff_id=?').bind(o.id).first('generation')).toBe(0);
  expect(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version')).toBe(17);
  expect(await db.prepare("SELECT count(*) n FROM staff_login_binding_audit WHERE staff_id=? AND action='linked'").bind(o.id).first('n')).toBe(0);
 });
 it('missing alias schema preserves bound primary only; partial schema and storage failures fail closed',async()=>{
  const a=await seed('legacy',legacy),b=await seed('partial',partial);
  const p=await primary(a,legacy);expect(p.generation).toBe(0);expect(await assertCurrentStaffLogin(legacy,p)).toBe(true);
  expect(await resolveVerifiedStaffLogin(legacy,claims(a.alternate,a.alternateSubject))).toBeNull();
  await expect(resolveVerifiedStaffLogin(partial,claims(b.email,b.subject))).rejects.toMatchObject({code:'staff_login_unavailable'});
  const broken={withSession(){throw Error('storage offline');}} as unknown as D1Database;
  await expect(resolveVerifiedStaffLogin(broken,claims(a.email,a.subject))).rejects.toMatchObject({code:'staff_login_unavailable'});
 });
 it('never binds an unbound primary identity and snapshots strict scalar proof without invoking getters',async()=>{
  const o=await seed('unbound');await db.prepare('UPDATE staff_users SET access_subject=NULL WHERE id=?').bind(o.id).run();
  expect(await resolveVerifiedStaffLogin(db,claims(o.email,o.subject))).toBeNull();
  expect(await db.prepare('SELECT access_subject FROM staff_users WHERE id=?').bind(o.id).first('access_subject')).toBeNull();
  const p=await primary(await seed('snapshot'));let called=false;
  const getter={...p};Object.defineProperty(getter,'email',{enumerable:true,get(){called=true;return p.email;}});
  expect(snapshotStaffLoginProof(getter)).toBeNull();expect(called).toBe(false);
  expect(snapshotStaffLoginProof({...p,staffId:{toString(){called=true;return p.staffId;}}})).toBeNull();expect(called).toBe(false);
  const copy=snapshotStaffLoginProof(p);expect(copy).toEqual(p);expect(copy).not.toBe(p);expect(Object.isFrozen(copy)).toBe(true);
  expect(snapshotStaffLoginProof({...p,extra:true})).toBeNull();
 });
 it('keeps all active credentials visible when durable revoked history exceeds a page',async()=>{
  const o=await seed('history');await seedBindingHistory(o,51,true);const {result}=await link(o);
  const list=await listStaffLoginBindings(db,await primary(o));expect(list).toHaveLength(50);
  expect(list.filter(r=>r.status==='active').map(r=>r.bindingId)).toEqual([result.bindingId]);expect(list[0]?.status).toBe('active');
  expect(await db.prepare('SELECT count(*) n FROM staff_login_bindings WHERE staff_id=?').bind(o.id).first('n')).toBe(52);
  expect(await db.prepare("SELECT count(*) n FROM staff_login_binding_audit WHERE staff_id=? AND action='revoked'").bind(o.id).first('n')).toBe(51);
 });
 it('caps active bindings in both the command and SQL trigger without changing the existing ten credentials',async()=>{
  const o=await seed('capacity');await seedBindingHistory(o,10,false);const intent=await createStaffLoginBindingIntent(db,await primary(o),o.alternate);
  await expect(claimStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),intent)).rejects.toMatchObject({code:'staff_login_conflict'});
  await expect(db.prepare('INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms) VALUES(?,?,?,?,?,?,?)')
   .bind(crypto.randomUUID(),o.id,issuer,o.alternate,o.alternateSubject,intent.intentId,Date.now()).run()).rejects.toThrow();
  expect((await listStaffLoginBindings(db,await primary(o))).filter(r=>r.status==='active')).toHaveLength(10);
  expect(await db.prepare('SELECT generation FROM staff_login_generations WHERE staff_id=?').bind(o.id).first('generation')).toBe(10);
  expect(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version')).toBe(27);
  expect(await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(o.id).first('version')).toBe(7);
 });
 it('previews the exact approving owner in a two-owner deployment without changing any business state',async()=>{
  const a=await seed('preview-a'),b=await seed('preview-b');
  // Two legitimate owners can prepare pending approvals for the same mailbox.
  // The mailbox holder must see which exact profile a particular secret names.
  const intentA=await createStaffLoginBindingIntent(db,await primary(a),a.alternate),intentB=await createStaffLoginBindingIntent(db,await primary(b),a.alternate);
  const snapshot=async()=>{
   const queries=[
    'SELECT * FROM staff_users WHERE id IN (?,?) ORDER BY id',
    'SELECT * FROM native_staff_profiles WHERE staff_id IN (?,?) ORDER BY staff_id',
    'SELECT * FROM native_staff_admissions WHERE staff_id IN (?,?) ORDER BY staff_id',
    'SELECT * FROM staff_login_generations WHERE staff_id IN (?,?) ORDER BY staff_id',
    'SELECT * FROM staff_login_binding_intents WHERE staff_id IN (?,?) ORDER BY id',
    'SELECT * FROM staff_login_bindings WHERE staff_id IN (?,?) ORDER BY id',
    'SELECT * FROM staff_login_binding_audit WHERE staff_id IN (?,?) ORDER BY id',
   ];
   return (await db.batch(queries.map(sql=>db.prepare(sql).bind(a.id,b.id)))).map(r=>r.results);
  };
  const before=await snapshot(),c=claims(a.alternate,a.alternateSubject);
  const preview=await previewStaffLoginBindingIntent(db,c,intentA);
  expect(preview).toEqual({canonicalEmail:a.email,ownerDisplayName:'Synthetic Owner',targetEmail:a.alternate,expiresAt:intentA.expiresAt,state:'pending'});
  expect(Object.keys(preview).sort()).toEqual(['canonicalEmail','expiresAt','ownerDisplayName','state','targetEmail']);
  expect(JSON.stringify(preview)).not.toContain(b.email);expect(JSON.stringify(preview)).not.toContain(a.subject);expect(JSON.stringify(preview)).not.toContain(intentA.verificationToken);
  expect(await previewStaffLoginBindingIntent(db,c,intentB)).toEqual({canonicalEmail:b.email,ownerDisplayName:'Synthetic Owner',targetEmail:a.alternate,expiresAt:intentB.expiresAt,state:'pending'});
  await expect(previewStaffLoginBindingIntent(db,c,{intentId:intentB.intentId,verificationToken:intentA.verificationToken})).rejects.toMatchObject({code:'staff_login_denied',status:403});
  await expect(previewStaffLoginBindingIntent(db,claims(b.alternate,b.alternateSubject),intentA)).rejects.toMatchObject({code:'staff_login_denied',status:403});
  expect(await snapshot()).toEqual(before);
 });
 it('previews an already-linked exact identity without replaying its mutation, then refuses subject substitution and revoked links',async()=>{
  const o=await seed('preview-linked'),{intent,result}=await link(o),c=claims(o.alternate,o.alternateSubject);
  const generation=await db.prepare('SELECT generation FROM staff_login_generations WHERE staff_id=?').bind(o.id).first('generation');
  expect(await previewStaffLoginBindingIntent(db,c,intent)).toMatchObject({canonicalEmail:o.email,targetEmail:o.alternate,state:'linked'});
  expect(await db.prepare('SELECT generation FROM staff_login_generations WHERE staff_id=?').bind(o.id).first('generation')).toBe(generation);
  expect(await db.prepare("SELECT count(*) n FROM staff_login_binding_audit WHERE staff_id=? AND action='linked'").bind(o.id).first('n')).toBe(1);
  await expect(previewStaffLoginBindingIntent(db,claims(o.alternate,'access|wrong-preview-subject'),intent)).rejects.toMatchObject({code:'staff_login_denied',status:403});
  await revokeStaffLoginBinding(db,await primary(o),{bindingId:result.bindingId,expectedVersion:1});
  await expect(previewStaffLoginBindingIntent(db,c,intent)).rejects.toMatchObject({code:'staff_login_conflict',status:409});
 });
 it('invalidates a pending preview when another credential mutation changes its pinned owner generation',async()=>{
  const o=await seed('preview-generation'),p=await primary(o);
  const old=await createStaffLoginBindingIntent(db,p,o.alternate),otherEmail='other-preview-generation@example.test';
  const fresh=await createStaffLoginBindingIntent(db,p,otherEmail);
  await claimStaffLoginBindingIntent(db,claims(otherEmail,'access|other-preview-generation'),fresh);
  const before=await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version');
  await expect(previewStaffLoginBindingIntent(db,claims(o.alternate,o.alternateSubject),old)).rejects.toMatchObject({code:'staff_login_conflict',status:409});
  expect(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(o.id).first('version')).toBe(before);
  expect(await db.prepare('SELECT status FROM staff_login_binding_intents WHERE id=?').bind(old.intentId).first('status')).toBe('pending');
 });
});
