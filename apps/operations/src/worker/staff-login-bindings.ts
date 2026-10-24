import { isNativeAccessSubject } from './native-access-subject';

/** Input must come from a human Access JWT verified for this deployment's
 * issuer/audience. This module never verifies tokens or trusts request headers. */
export type VerifiedStaffLoginClaims=Readonly<{issuer:string;email:string;subject:string;expiresAt:number;issuedAt:number}>;
export type StaffLoginProof=Readonly<{
 kind:'primary'|'alternate';staffId:string;canonicalEmail:string;canonicalSubject:string;
 issuer:string;email:string;subject:string;expiresAt:number;bindingId:string|null;bindingVersion:number;generation:number;
}>;
export type ResolvedStaffLogin=Readonly<{staff:Readonly<{id:string;email:string;displayName:string;accessSubject:string;projectAlphaUserId:string|null}>;proof:StaffLoginProof}>;
export class StaffLoginBindingError extends Error {
 constructor(readonly code:'staff_login_invalid'|'staff_login_denied'|'staff_login_conflict'|'staff_login_unavailable',readonly status:400|403|404|409|503){super(code);}
}
const fail=(code:StaffLoginBindingError['code'],status:400|403|404|409|503):never=>{throw new StaffLoginBindingError(code,status);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX=/^[a-f0-9]{64}$/u, ID=/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const TABLES=['staff_login_binding_control','staff_login_generations','staff_login_binding_intents','staff_login_bindings','staff_login_binding_audit'];
const OBJECTS=['staff_login_intent_insert','staff_login_intent_update','staff_login_intent_no_delete',
 'staff_login_binding_insert','staff_login_binding_update','staff_login_binding_no_delete','staff_login_binding_linked','staff_login_binding_revoked',
 'staff_login_canonical_insert_collision','staff_login_canonical_update_collision','staff_login_generation_update','staff_login_generation_no_delete',
 'staff_login_audit_no_update','staff_login_audit_no_delete','staff_login_control_no_update','staff_login_control_no_delete',
 'staff_login_bindings_active_email','staff_login_bindings_active_subject'];
const PROOF_KEYS=['kind','staffId','canonicalEmail','canonicalSubject','issuer','email','subject','expiresAt','bindingId','bindingVersion','generation'];
const CLAIM_KEYS=['issuer','email','subject','expiresAt','issuedAt'];
const ownerSql=`EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global')
 AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides d WHERE d.staff_id=s.id AND d.permission_key='administration.view' AND d.effect='deny' AND d.scope='global')`;
const generationSql='coalesce((SELECT generation FROM staff_login_generations g WHERE g.staff_id=s.id),0)';
function plain(value:unknown,keys:string[]):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const actual=Reflect.ownKeys(value);return actual.length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return !!d&&d.enumerable&&'value'in d;});
}
function email(value:unknown):value is string{return typeof value==='string'&&value.length>=3&&value.length<=254&&value===value.trim().toLowerCase()
 &&!/[\s\p{C}]/u.test(value)&&/^[^@]+@[^@]+$/u.test(value);}
function issuer(value:unknown):value is string{try{if(typeof value!=='string')return false;const u=new URL(value);return u.origin===value&&u.protocol==='https:'
 &&u.hostname.endsWith('.cloudflareaccess.com')&&u.hostname!=='.cloudflareaccess.com'&&!u.port&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;}catch{return false;}}
const whole=(n:unknown,min=0):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=9_007_199_254_740_990;
function claimsSnapshot(value:VerifiedStaffLoginClaims):VerifiedStaffLoginClaims|null{
 if(!plain(value,CLAIM_KEYS))return null;const c={issuer:value.issuer,email:value.email,subject:value.subject,expiresAt:value.expiresAt,issuedAt:value.issuedAt};
 const now=Math.floor(Date.now()/1000);return issuer(c.issuer)&&email(c.email)&&isNativeAccessSubject(c.subject)&&whole(c.expiresAt,1)&&c.expiresAt>now
  &&c.expiresAt<=253_402_300_799&&whole(c.issuedAt)&&c.issuedAt<=now&&c.issuedAt<c.expiresAt?Object.freeze(c):null;
}
/** Strict synchronous copy prevents getters/mutation across later awaits. */
export function snapshotStaffLoginProof(value:unknown):StaffLoginProof|null{
 if(!plain(value,PROOF_KEYS))return null;const p=Object.fromEntries(PROOF_KEYS.map(k=>[k,value[k]])) as unknown as StaffLoginProof;
 if((p.kind!=='primary'&&p.kind!=='alternate')||typeof p.staffId!=='string'||!ID.test(p.staffId)||!email(p.canonicalEmail)||!isNativeAccessSubject(p.canonicalSubject)
  ||!issuer(p.issuer)||!email(p.email)||!isNativeAccessSubject(p.subject)||!whole(p.expiresAt,1)||p.expiresAt>253_402_300_799
  ||!whole(p.bindingVersion)||!whole(p.generation))return null;
 if(p.kind==='primary'&&(p.bindingId!==null||p.bindingVersion!==0||p.email!==p.canonicalEmail||p.subject!==p.canonicalSubject))return null;
 if(p.kind==='alternate'&&(typeof p.bindingId!=='string'||!UUID.test(p.bindingId)||p.bindingVersion<1||p.generation<1||p.email===p.canonicalEmail))return null;
 return Object.freeze(p);
}
async function boundary<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(error instanceof StaffLoginBindingError)throw error;
 if(error instanceof Error&&/staff_login_|UNIQUE constraint failed/i.test(error.message))return fail('staff_login_conflict',409);
 return fail('staff_login_unavailable',503);}}
async function schemaReady(db:D1Database):Promise<boolean>{
 const tables=(await db.withSession('first-primary').prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(()=>'?').join(',')})`).bind(...TABLES).all<{name:string}>()).results;
 if(tables.length===0)return false;if(tables.length!==TABLES.length)return fail('staff_login_unavailable',503);
 const state=await db.withSession('first-primary').prepare('SELECT schema_version version FROM staff_login_binding_control WHERE singleton=1').first<{version:number}>();
 const objects=(await db.withSession('first-primary').prepare(`SELECT name FROM sqlite_master WHERE name IN (${OBJECTS.map(()=>'?').join(',')})`).bind(...OBJECTS).all<{name:string}>()).results;
 if(state?.version!==1||objects.length!==OBJECTS.length)return fail('staff_login_unavailable',503);return true;
}
type StaffRow={id:string;email:string;display_name:string;access_subject:string|null;project_alpha_user_id:string|null;status:string};
function validStaff(s:StaffRow|undefined|null):s is StaffRow&{access_subject:string}{return !!s&&typeof s.id==='string'&&ID.test(s.id)&&email(s.email)&&isNativeAccessSubject(s.access_subject)
 &&typeof s.display_name==='string'&&s.display_name.trim().length>0&&s.display_name.length<=160&&s.status==='active'
 &&(s.project_alpha_user_id===null||typeof s.project_alpha_user_id==='string');}
function resolved(s:StaffRow&{access_subject:string},c:VerifiedStaffLoginClaims,generation:number,binding?:{id:string;version:number}):ResolvedStaffLogin{
 const staff=Object.freeze({id:s.id,email:s.email,displayName:s.display_name,accessSubject:s.access_subject,projectAlphaUserId:s.project_alpha_user_id});
 const proof:StaffLoginProof=Object.freeze({kind:binding?'alternate':'primary',staffId:s.id,canonicalEmail:s.email,canonicalSubject:s.access_subject,
  issuer:c.issuer,email:c.email,subject:c.subject,expiresAt:c.expiresAt,bindingId:binding?.id??null,bindingVersion:binding?.version??0,generation});
 return Object.freeze({staff,proof});
}
/** No automatic staff creation, primary binding, email linking or subject rebind. */
export async function resolveVerifiedStaffLogin(db:D1Database,input:VerifiedStaffLoginClaims):Promise<ResolvedStaffLogin|null>{return boundary(async()=>{
 const c=claimsSnapshot(input);if(!c)return null;const ready=await schemaReady(db),session=db.withSession('first-primary');
 const rows=(await session.prepare('SELECT id,email,display_name,access_subject,project_alpha_user_id,status FROM staff_users WHERE email=? COLLATE NOCASE LIMIT 2').bind(c.email).all<StaffRow>()).results;
 if(rows.length){const s=rows[0];if(rows.length!==1||!validStaff(s)||s.email!==c.email||s.access_subject!==c.subject)return null;
  const generation=ready?await session.prepare('SELECT generation FROM staff_login_generations WHERE staff_id=?').bind(s.id).first<number>('generation')??0:0;
  if(!whole(generation))return fail('staff_login_unavailable',503);return resolved(s,c,generation);}
 if(!ready)return null;
 const aliases=(await session.prepare(`SELECT s.id,s.email,s.display_name,s.access_subject,s.project_alpha_user_id,s.status,
  b.id binding_id,b.version binding_version,g.generation,i.created_at_ms intent_created_at_ms
  FROM staff_login_bindings b JOIN staff_users s ON s.id=b.staff_id JOIN staff_login_generations g ON g.staff_id=s.id
  JOIN staff_login_binding_intents i ON i.id=b.intent_id AND i.status='claimed' AND i.binding_id=b.id
  WHERE b.issuer=? AND b.login_email=? COLLATE BINARY AND b.access_subject=? AND b.status='active'
   AND s.email=i.canonical_email COLLATE BINARY AND s.access_subject=i.canonical_subject LIMIT 2`)
  .bind(c.issuer,c.email,c.subject).all<StaffRow&{binding_id:string;binding_version:number;generation:number;intent_created_at_ms:number}>()).results;
 const a=aliases[0];if(aliases.length!==1||!validStaff(a)||!UUID.test(a.binding_id)||!whole(a.binding_version,1)||!whole(a.generation,1)
  ||c.issuedAt<Math.floor(a.intent_created_at_ms/1000)||c.expiresAt<=Math.floor(Date.now()/1000))return null;
 return resolved(a,c,a.generation,{id:a.binding_id,version:a.binding_version});
});}
/** Recheck after upstream waits. Invalid/revoked/stale proof is false; storage
 * errors throw unavailable rather than masquerading as an unknown identity. */
export async function assertCurrentStaffLogin(db:D1Database,value:StaffLoginProof,nowSeconds=Math.floor(Date.now()/1000)):Promise<boolean>{return boundary(async()=>{
 const p=snapshotStaffLoginProof(value);if(!p||!whole(nowSeconds)||p.expiresAt<=nowSeconds)return false;
 const ready=await schemaReady(db);if(!ready&&p.kind!=='primary')return false;
 const row=await db.withSession('first-primary').prepare(`SELECT 1 ok FROM staff_users s WHERE s.id=? AND s.email=? COLLATE BINARY
  AND s.access_subject=? AND s.status='active' ${ready?`AND ${generationSql}=?`:''}`)
  .bind(p.staffId,p.canonicalEmail,p.canonicalSubject,...(ready?[p.generation]:[])).first('ok');
 if(row!==1||!ready&&p.generation!==0)return false;if(p.kind==='primary')return true;
 return await db.withSession('first-primary').prepare(`SELECT 1 ok FROM staff_login_bindings b JOIN staff_login_binding_intents i ON i.id=b.intent_id
  WHERE b.id=? AND b.staff_id=? AND b.version=? AND b.status='active' AND b.issuer=? AND b.login_email=? COLLATE BINARY
   AND b.access_subject=? AND i.status='claimed' AND i.binding_id=b.id AND i.canonical_email=? COLLATE BINARY AND i.canonical_subject=?`)
  .bind(p.bindingId,p.staffId,p.bindingVersion,p.issuer,p.email,p.subject,p.canonicalEmail,p.canonicalSubject).first('ok')===1;
});}
async function owner(db:D1Database,value:StaffLoginProof):Promise<StaffLoginProof>{
 const p=snapshotStaffLoginProof(value);if(!p||p.kind!=='primary'||!await assertCurrentStaffLogin(db,p))return fail('staff_login_denied',403);
 if(!await schemaReady(db))return fail('staff_login_unavailable',503);
 if(await db.withSession('first-primary').prepare(`SELECT 1 ok FROM staff_users s WHERE s.id=? AND ${ownerSql}`).bind(p.staffId).first('ok')!==1)return fail('staff_login_denied',403);return p;
}
function bytesHex(bytes:Uint8Array){return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');}
const hash=async(value:string)=>bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
export async function createStaffLoginBindingIntent(db:D1Database,primary:StaffLoginProof,targetEmail:string):Promise<{intentId:string;verificationToken:string;expiresAt:string}>{return boundary(async()=>{
 const p=await owner(db,primary);if(!email(targetEmail)||targetEmail===p.canonicalEmail)return fail('staff_login_invalid',400);
 const now=Date.now(),id=crypto.randomUUID(),token=bytesHex(crypto.getRandomValues(new Uint8Array(32))),digest=await hash(token);
 const where=`s.id=? AND s.status='active' AND s.email=? COLLATE BINARY AND s.access_subject=? AND ${ownerSql} AND ?*1000>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`;
 const batch=await db.batch([
  db.prepare(`INSERT INTO staff_login_generations(staff_id,generation) SELECT s.id,0 FROM staff_users s WHERE ${where} ON CONFLICT(staff_id) DO NOTHING`)
   .bind(p.staffId,p.canonicalEmail,p.canonicalSubject,p.expiresAt),
  db.prepare(`INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,created_at_ms,expires_at_ms)
   SELECT ?,s.id,s.email,s.access_subject,?,?,?,?,?,? FROM staff_users s WHERE ${where} AND ${generationSql}=?
    AND (SELECT count(*) FROM staff_login_binding_intents x WHERE x.staff_id=s.id AND x.status='pending' AND x.expires_at_ms>?)<10`)
   .bind(id,p.issuer,targetEmail,digest,p.generation,now,now+900_000,p.staffId,p.canonicalEmail,p.canonicalSubject,p.expiresAt,p.generation,now),
  db.prepare(`INSERT INTO staff_login_binding_audit SELECT ?,staff_id,id,NULL,'intent_created',? FROM staff_login_binding_intents WHERE id=?`)
   .bind(`intent:${id}`,now,id),
 ]);
 if(batch[1]?.meta.changes!==1)return fail('staff_login_conflict',409);
 return {intentId:id,verificationToken:token,expiresAt:new Date(now+900_000).toISOString()};
});}
type IntentReference=Readonly<{intentId:string;verificationToken:string}>;
type IntentContextRow=StaffRow&{canonical_email:string;canonical_subject:string;issuer:string;alternate_email:string;
 intent_staff_id:string;intent_generation:number;intent_status:string;created_at_ms:number;expires_at_ms:number;
 generation:number;owner_allowed:number;db_now_ms:number;binding_id:string|null;binding_subject:string|null;
 binding_issuer:string|null;binding_email:string|null;binding_status:string|null;binding_version:number|null};
type ValidatedIntent=Readonly<{row:IntentContextRow;state:'pending'|'linked'}>;
function intentSnapshot(value:IntentReference):IntentReference|null{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return null;
 const id=Object.getOwnPropertyDescriptor(value,'intentId'),secret=Object.getOwnPropertyDescriptor(value,'verificationToken');
 if(!id?.enumerable||!('value'in id)||typeof id.value!=='string'||!UUID.test(id.value)
  ||!secret?.enumerable||!('value'in secret)||typeof secret.value!=='string'||!HEX.test(secret.value))return null;
 return Object.freeze({intentId:id.value,verificationToken:secret.value});
}
/** Shared preview/claim guard: even the canonical display context is private
 * until both the random secret and the exact verified target identity match. */
async function readValidatedIntent(db:D1Database,c:VerifiedStaffLoginClaims,value:IntentReference,digest:string):Promise<ValidatedIntent>{
 if(!await schemaReady(db))return fail('staff_login_unavailable',503);
 const row=await db.withSession('first-primary').prepare(`SELECT s.id,s.email,s.display_name,s.access_subject,s.project_alpha_user_id,s.status,
  i.staff_id intent_staff_id,i.canonical_email,i.canonical_subject,i.issuer,i.alternate_email,i.generation intent_generation,
  i.status intent_status,i.created_at_ms,i.expires_at_ms,coalesce(g.generation,-1) generation,
  CASE WHEN ${ownerSql} THEN 1 ELSE 0 END owner_allowed,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) db_now_ms,
  b.id binding_id,b.access_subject binding_subject,b.issuer binding_issuer,b.login_email binding_email,b.status binding_status,b.version binding_version
  FROM staff_login_binding_intents i LEFT JOIN staff_users s ON s.id=i.staff_id
  LEFT JOIN staff_login_generations g ON g.staff_id=i.staff_id
  LEFT JOIN staff_login_bindings b ON b.id=i.binding_id AND b.intent_id=i.id AND b.staff_id=i.staff_id
  WHERE i.id=? AND i.token_sha256=?`).bind(value.intentId,digest).first<IntentContextRow>();
 if(!row||row.issuer!==c.issuer||row.alternate_email!==c.email||c.issuedAt<Math.floor(row.created_at_ms/1000)
  ||c.expiresAt<=Math.floor(Date.now()/1000))return fail('staff_login_denied',403);
 if(row.intent_status==='claimed'&&row.binding_status==='active'&&row.binding_subject!==c.subject)return fail('staff_login_denied',403);
 if(!validStaff(row)||row.id!==row.intent_staff_id||row.email!==row.canonical_email||row.access_subject!==row.canonical_subject
  ||!whole(row.generation)||!whole(row.intent_generation)||!whole(row.created_at_ms)||!whole(row.expires_at_ms)
  ||row.expires_at_ms<=Math.max(Date.now(),row.db_now_ms))return fail('staff_login_conflict',409);
 if(row.intent_status==='pending'){
  if(row.owner_allowed!==1||row.generation!==row.intent_generation)return fail('staff_login_conflict',409);
  return {row,state:'pending'};
 }
 if(row.intent_status!=='claimed'||row.binding_status!=='active'||!row.binding_id||!UUID.test(row.binding_id)
  ||row.binding_issuer!==c.issuer||row.binding_email!==c.email||row.binding_subject!==c.subject||!whole(row.binding_version,1)
  ||row.generation<=row.intent_generation)return fail('staff_login_conflict',409);
 return {row,state:'linked'};
}
export async function previewStaffLoginBindingIntent(db:D1Database,input:VerifiedStaffLoginClaims,value:IntentReference):Promise<{
 canonicalEmail:string;ownerDisplayName:string;targetEmail:string;expiresAt:string;state:'pending'|'linked';
}>{return boundary(async()=>{
 const c=claimsSnapshot(input),ref=intentSnapshot(value);if(!c||!ref)return fail('staff_login_denied',403);
 const context=await readValidatedIntent(db,c,ref,await hash(ref.verificationToken));
 return {canonicalEmail:context.row.canonical_email,ownerDisplayName:context.row.display_name,targetEmail:context.row.alternate_email,
  expiresAt:new Date(context.row.expires_at_ms).toISOString(),state:context.state};
});}
export async function claimStaffLoginBindingIntent(db:D1Database,input:VerifiedStaffLoginClaims,value:IntentReference):Promise<{bindingId:string;staffId:string;version:number}>{return boundary(async()=>{
 const c=claimsSnapshot(input),ref=intentSnapshot(value);if(!c||!ref)return fail('staff_login_denied',403);
 const digest=await hash(ref.verificationToken),context=await readValidatedIntent(db,c,ref,digest);
 if(context.state==='linked')return {bindingId:context.row.binding_id!,staffId:context.row.id,version:context.row.binding_version!};
 const id=crypto.randomUUID(),now=Date.now();
 const result=await db.prepare(`INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms)
  SELECT ?,i.staff_id,i.issuer,i.alternate_email,?,i.id,? FROM staff_login_binding_intents i JOIN staff_users s ON s.id=i.staff_id
  WHERE i.id=? AND i.token_sha256=? AND i.status='pending' AND i.issuer=? AND i.alternate_email=? COLLATE BINARY
   AND i.expires_at_ms>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
   AND ?>=CAST(i.created_at_ms/1000 AS INTEGER) AND ?*1000>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
   AND s.status='active' AND s.email=i.canonical_email COLLATE BINARY AND s.access_subject=i.canonical_subject AND ${ownerSql}
   AND ${generationSql}=i.generation
   AND NOT EXISTS(SELECT 1 FROM staff_users collision WHERE collision.email=? COLLATE NOCASE OR collision.access_subject=?)
   AND NOT EXISTS(SELECT 1 FROM staff_login_bindings b WHERE b.status='active' AND b.issuer=? AND (b.login_email=? COLLATE NOCASE OR b.access_subject=?))
   AND (SELECT count(*) FROM staff_login_bindings b WHERE b.staff_id=s.id AND b.status='active')<10
   RETURNING id bindingId,staff_id staffId,version`)
  .bind(id,c.subject,now,ref.intentId,digest,c.issuer,c.email,c.issuedAt,c.expiresAt,c.email,c.subject,c.issuer,c.email,c.subject)
  .first<{bindingId:string;staffId:string;version:number}>();
 if(!result){
  // A concurrent identical claim is still an exact replay. Other changed,
  // expired or closed approvals retain the same preview/claim classification.
  const current=await readValidatedIntent(db,c,ref,digest);
  if(current.state==='linked')return {bindingId:current.row.binding_id!,staffId:current.row.id,version:current.row.binding_version!};
  return fail('staff_login_conflict',409);
 }
 return result;
});}
export async function revokeStaffLoginBinding(db:D1Database,primary:StaffLoginProof,value:{bindingId:string;expectedVersion:number}):Promise<{bindingId:string;version:number;status:'revoked'}>{return boundary(async()=>{
 const p=await owner(db,primary);if(!value||typeof value.bindingId!=='string'||!UUID.test(value.bindingId)||!whole(value.expectedVersion,1))return fail('staff_login_invalid',400);
 const existing=await db.withSession('first-primary').prepare('SELECT status,version FROM staff_login_bindings WHERE id=? AND staff_id=?').bind(value.bindingId,p.staffId).first<{status:string;version:number}>();
 if(existing?.status==='revoked'&&existing.version===value.expectedVersion+1)return {bindingId:value.bindingId,version:existing.version,status:'revoked'};
 const changed=await db.prepare(`UPDATE staff_login_bindings SET status='revoked',version=version+1,revoked_at_ms=?,revoked_by_staff_id=?
  WHERE id=? AND staff_id=? AND status='active' AND version=? AND EXISTS(SELECT 1 FROM staff_users s
   WHERE s.id=? AND s.status='active' AND s.email=? COLLATE BINARY AND s.access_subject=? AND ${ownerSql} AND ${generationSql}=?
    AND ?*1000>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) RETURNING id bindingId,version,status`)
  .bind(Date.now(),p.staffId,value.bindingId,p.staffId,value.expectedVersion,p.staffId,p.canonicalEmail,p.canonicalSubject,p.generation,p.expiresAt)
  .first<{bindingId:string;version:number;status:'revoked'}>();
 if(!changed)return fail('staff_login_conflict',409);return changed;
});}
export async function listStaffLoginBindings(db:D1Database,primary:StaffLoginProof):Promise<Array<{bindingId:string;email:string;version:number;status:'active'|'revoked';createdAt:string;revokedAt:string|null}>>{return boundary(async()=>{
 const p=await owner(db,primary);const rows=(await db.withSession('first-primary').prepare(`SELECT id,login_email,version,status,created_at_ms,revoked_at_ms
  FROM staff_login_bindings WHERE staff_id=? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at_ms DESC,id LIMIT 50`).bind(p.staffId)
  .all<{id:string;login_email:string;version:number;status:'active'|'revoked';created_at_ms:number;revoked_at_ms:number|null}>()).results;
 await owner(db,p);return rows.map(r=>({bindingId:r.id,email:r.login_email,version:r.version,status:r.status,
  createdAt:new Date(r.created_at_ms).toISOString(),revokedAt:r.revoked_at_ms===null?null:new Date(r.revoked_at_ms).toISOString()}));
});}
