import {HTTPException} from 'hono/http-exception';
import type {Env as ClientEnv} from '../types';
import type {VerifiedClientPrincipal} from './types';
import {authorizePortalWorkspaceCapability,type PortalAuthorizationEnv} from './workspace-v2';
import {captureWorkspaceInvitationDelegation} from './project-invitation-delegation';

type Env=PortalAuthorizationEnv&Partial<Pick<ClientEnv,'CLIENT_PORTAL_ADDRESS_BOOK_ENABLED'|'CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET'|'DELIVERY_SESSION_SECRET'|'DELIVERY_PREVIOUS_SESSION_SECRET'>>;
type Database=Pick<D1Database,'prepare'|'batch'>;
const TABLES=['portal_workspace_address_book_states','portal_workspace_address_contacts','portal_workspace_address_contact_commands',
  'portal_workspace_address_contact_audit','portal_workspace_address_contact_fences'] as const;
const PAGE=25,MAX_CONTACTS=1000,CURSOR_MS=15*60_000;
const ids=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const keys=/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const controls=/[\u0000-\u001f\u007f-\u009f]/u;

export interface AddressBookContactInput {displayName:string;email:string;phone:string|null;company:string|null;roleOrTrade:string|null}
export interface AddressBookContactSelection {id:string;expectedVersion:number}
export interface PriorAddressBookInvitation {status:'pending'|'accepted'|'revoked'|'expired';lastInvitedAt:string}
export interface AddressBookContact extends AddressBookContactInput {id:string;workspaceId:string;sourceId:string;version:number;
 createdAt:string;updatedAt:string;previousInvitation:PriorAddressBookInvitation|null}
export interface DeletedAddressBookContact {id:string;workspaceId:string;sourceId:string;status:'deleted';version:number}
interface ContactRow {id:string;workspace_id:string;source_id:string;display_name:string|null;sort_name:string|null;email:string|null;email_key:string|null;
 phone:string|null;company:string|null;company_key:string|null;role_or_trade:string|null;role_key:string|null;status:'active'|'deleted';version:number;
 created_at:string;updated_at:string;prior_invitation:string|null}
interface Manager {identityId:string;workspaceId:string;sourceId:string;revision:number}
interface Cursor {v:1;workspaceId:string;sourceId:string;identityId:string;revision:number;q:string;afterSort:string;afterId:string;expires:number}

function fail(status:400|404|409|503,code:string):never {throw new HTTPException(status,{message:code});}
function iso(value:string):string{return /^\d{4}-\d{2}-\d{2} /.test(value)?`${value.replace(' ','T')}Z`:value;}
function normalize(value:string,max:number,field:string):string{
 const result=value.normalize('NFC').trim();if(!result||result.length>max||controls.test(result))fail(400,`address_contact_${field}_invalid`);return result;
}
function optional(value:string|null,max:number,field:string):string|null{return value===null?null:normalize(value,max,field);}
function input(value:AddressBookContactInput){
 const displayName=normalize(value.displayName,160,'name'),email=normalize(value.email,320,'email').toLocaleLowerCase('en-US');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'address_contact_email_invalid');
 const phone=optional(value.phone,64,'phone'),company=optional(value.company,160,'company'),roleOrTrade=optional(value.roleOrTrade,160,'role');
 return {displayName,sortName:displayName.toLocaleLowerCase('en-US'),email,emailKey:email,phone,company,
  companyKey:company?.toLocaleLowerCase('en-US')??null,roleOrTrade,roleKey:roleOrTrade?.toLocaleLowerCase('en-US')??null};
}
async function stableFingerprint(env:Env,purpose:'command'|'context',value:string):Promise<string>{
 const secret=env.CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET??'';if(secret.length<32)fail(503,'address_book_unavailable');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`workspace-address-${purpose}-v1\0${value}`)))]
  .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function commandFingerprint(env:Env,value:string):Promise<string>{return stableFingerprint(env,'command',value);}
function base64(bytes:Uint8Array):string{let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function bytes(value:string):Uint8Array|null{try{const padded=value.replace(/-/g,'+').replace(/_/g,'/');const result=Uint8Array.from(atob(padded),c=>c.charCodeAt(0));return base64(result)===value?result:null;}catch{return null;}}
async function cursorKey(secret:string):Promise<CryptoKey>{if(secret.length<32)throw new Error('address-book-cursor-unavailable');
 return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`address-book-cursor-v1\0${secret}`)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function encodeCursor(env:Env,value:Cursor):Promise<string>{const iv=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cursorKey(env.DELIVERY_SESSION_SECRET??''),plain));
 const payload=new Uint8Array(iv.length+encrypted.length);payload.set(iv);payload.set(encrypted,iv.length);return `ab1_${base64(payload)}`;}
async function decodeCursor(env:Env,value:string):Promise<Cursor|null>{if(value.length>4096||!value.startsWith('ab1_'))return null;const payload=bytes(value.slice(4));if(!payload||payload.length<29)return null;
 for(const secret of [env.DELIVERY_SESSION_SECRET,env.DELIVERY_PREVIOUS_SESSION_SECRET]){if(!secret||secret.length<32)continue;try{
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:payload.slice(0,12)},await cursorKey(secret),payload.slice(12)))) as Partial<Cursor>;
  if(raw.v!==1||!ids.test(raw.workspaceId??'')||!ids.test(raw.identityId??'')||typeof raw.sourceId!=='string'||typeof raw.revision!=='number'
    ||typeof raw.q!=='string'||typeof raw.afterSort!=='string'||!ids.test(raw.afterId??'')||typeof raw.expires!=='number'
    ||raw.expires<=Date.now()||raw.expires>Date.now()+CURSOR_MS+60_000)return null;return raw as Cursor;
 }catch{/* Wrong purpose/key, malformed payload or retired key fails closed. */}}
 return null;}

export function workspaceAddressBookEnabled(env:Pick<ClientEnv,'CLIENT_PORTAL_ADDRESS_BOOK_ENABLED'>):boolean{return env.CLIENT_PORTAL_ADDRESS_BOOK_ENABLED==='true';}
export async function workspaceAddressBookReady(db:Pick<D1Database,'prepare'>):Promise<boolean>{
 const rows=(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(()=>'?').join(',')})`).bind(...TABLES).all<{name:string}>()).results;
 if(!rows.length)return false;if(rows.length!==TABLES.length)fail(503,'address_book_unavailable');return true;
}
export async function workspaceAddressBookAvailable(env:Env):Promise<boolean>{return workspaceAddressBookEnabled(env)
 &&(env.CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET?.length??0)>=32&&workspaceAddressBookReady(env.DELIVERY_DB);}
export async function workspaceAddressBookAvailableFor(env:Env,workspaceId:string):Promise<boolean>{if(!await workspaceAddressBookAvailable(env))return false;
 return (await env.DELIVERY_DB.prepare(`SELECT 1 FROM portal_v2_workspaces w JOIN portal_workspace_address_book_states s
  ON s.workspace_id=w.id AND s.source_id=w.project_alpha_source_id WHERE w.id=? AND w.root_type='organization' AND w.status='active'`)
  .bind(workspaceId).first())!==null;}
/** Adds consistency only: selecting a contact never supplies invitation or
 * membership authority. The invitation continues through its normal gates. */
export async function prepareAddressBookContactSelection(env:Env,workspaceId:string,selection:AddressBookContactSelection,emailValue:string){
 if(!ids.test(selection.id)||!Number.isSafeInteger(selection.expectedVersion)||selection.expectedVersion<1
   ||!await workspaceAddressBookAvailableFor(env,workspaceId))fail(409,'address_contact_changed');
 const email=normalize(emailValue,320,'email').toLocaleLowerCase('en-US');
 const row=await env.DELIVERY_DB.prepare(`SELECT contact.source_id FROM portal_workspace_address_contacts contact
  JOIN portal_v2_workspaces workspace ON workspace.id=contact.workspace_id AND workspace.project_alpha_source_id=contact.source_id
  WHERE contact.id=? AND contact.workspace_id=? AND contact.status='active' AND contact.version=? AND contact.email_key=?
    AND workspace.root_type='organization' AND workspace.status='active'`)
  .bind(selection.id,workspaceId,selection.expectedVersion,email).first<{source_id:string}>();if(!row)fail(409,'address_contact_changed');
 return {id:selection.id,version:selection.expectedVersion,sourceId:row.source_id,fence:(token:string)=>fence(env.DELIVERY_DB,
  `EXISTS(SELECT 1 FROM portal_workspace_address_contacts contact JOIN portal_v2_workspaces workspace
    ON workspace.id=contact.workspace_id AND workspace.project_alpha_source_id=contact.source_id
    WHERE contact.id=? AND contact.workspace_id=? AND contact.source_id=? AND contact.status='active' AND contact.version=? AND contact.email_key=?
      AND workspace.root_type='organization' AND workspace.status='active')`,[selection.id,workspaceId,row.source_id,selection.expectedVersion,email])};
}

async function manager(env:Env,principal:VerifiedClientPrincipal,workspaceId:string):Promise<Manager|null>{
 if(!await workspaceAddressBookAvailable(env)||!ids.test(workspaceId))return null;
 const row=await env.DELIVERY_DB.prepare(`SELECT i.id identity_id,w.id workspace_id,w.project_alpha_source_id source_id,s.revision
  FROM portal_v2_identities i JOIN portal_v2_workspace_memberships m ON m.identity_id=i.id AND m.workspace_id=?
  JOIN portal_v2_workspaces w ON w.id=m.workspace_id AND w.root_type='organization' AND w.status='active'
  JOIN portal_workspace_address_book_states s ON s.workspace_id=w.id AND s.source_id=w.project_alpha_source_id
  WHERE i.issuer=? AND i.subject=? AND lower(i.verified_email)=? AND i.status='active' AND i.revoked_at IS NULL
    AND m.status='active' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))`)
  .bind(workspaceId,principal.issuer,principal.subject,principal.email.trim().toLocaleLowerCase('en-US'))
  .first<{identity_id:string;workspace_id:string;source_id:string;revision:number}>();
 if(!row)return null;const target={scopeType:'workspace' as const,publicId:workspaceId};
 if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',target)
   ||!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'member.manage',target))return null;
 return {identityId:row.identity_id,workspaceId:row.workspace_id,sourceId:row.source_id,revision:row.revision};
}
export async function canManageWorkspaceAddressBook(env:Env,principal:VerifiedClientPrincipal,workspaceId:string):Promise<boolean>{
 try{const current=await manager(env,principal,workspaceId);if(!current)return false;
  await captureWorkspaceInvitationDelegation(env,{workspaceId,target:{scopeType:'workspace',publicId:workspaceId},identityId:current.identityId,
   issuer:principal.issuer,subject:principal.subject,email:principal.email.trim().toLocaleLowerCase('en-US')},[],null);return true;
 }catch{return false;}}
async function writableManager(env:Env,principal:VerifiedClientPrincipal,workspaceId:string){const current=await manager(env,principal,workspaceId);if(!current)fail(404,'address_book_unavailable');
 let proof:Awaited<ReturnType<typeof captureWorkspaceInvitationDelegation>>;try{proof=await captureWorkspaceInvitationDelegation(env,{workspaceId,
  target:{scopeType:'workspace',publicId:workspaceId},identityId:current.identityId,issuer:principal.issuer,subject:principal.subject,
  email:principal.email.trim().toLocaleLowerCase('en-US')},[],null);}catch{fail(404,'address_book_unavailable');}return {...current,proof};}

const priorSql=`(SELECT json_object('status',CASE WHEN invitation.status='pending' AND datetime(invitation.expires_at)<=datetime('now') THEN 'expired' ELSE invitation.status END,
 'lastInvitedAt',invitation.created_at) FROM portal_v2_invitations invitation WHERE invitation.workspace_id=contact.workspace_id
 AND lower(invitation.invited_email)=contact.email_key ORDER BY invitation.created_at DESC,invitation.id DESC LIMIT 1) prior_invitation`;
const select=`SELECT contact.id,contact.workspace_id,contact.source_id,contact.display_name,contact.sort_name,contact.email,contact.email_key,
 contact.phone,contact.company,contact.company_key,contact.role_or_trade,contact.role_key,contact.status,contact.version,
 contact.created_at,contact.updated_at,${priorSql} FROM portal_workspace_address_contacts contact`;
function view(row:ContactRow):AddressBookContact{if(row.status!=='active'||!row.display_name||!row.email)throw new Error('address-contact-not-active');
 let previousInvitation:PriorAddressBookInvitation|null=null;if(row.prior_invitation){const parsed=JSON.parse(row.prior_invitation) as PriorAddressBookInvitation;
  previousInvitation={status:parsed.status,lastInvitedAt:iso(parsed.lastInvitedAt)};}
 return {id:row.id,workspaceId:row.workspace_id,sourceId:row.source_id,displayName:row.display_name,email:row.email,phone:row.phone,
  company:row.company,roleOrTrade:row.role_or_trade,version:row.version,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),previousInvitation};}
async function activeContact(db:Pick<D1Database,'prepare'>,workspaceId:string,contactId:string):Promise<ContactRow|null>{
 return db.prepare(`${select} WHERE contact.id=? AND contact.workspace_id=? AND contact.status='active'`).bind(contactId,workspaceId).first<ContactRow>();}
async function currentRevision(db:Pick<D1Database,'prepare'>,workspaceId:string,sourceId:string):Promise<number|null>{return db.prepare(
 `SELECT revision FROM portal_workspace_address_book_states WHERE workspace_id=? AND source_id=?`).bind(workspaceId,sourceId).first<number>('revision');}
async function context(env:Env,manager:Manager,q:string):Promise<string>{return stableFingerprint(env,'context',JSON.stringify({workspaceId:manager.workspaceId,
 sourceId:manager.sourceId,identityId:manager.identityId,revision:manager.revision,q}));}

export async function listWorkspaceAddressContacts(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,query?:{q?:string;cursor?:string}){
 const initial=await manager(env,principal,workspaceId);if(!initial)fail(404,'address_book_unavailable');
 const q=(query?.q??'').normalize('NFC').trim().toLocaleLowerCase('en-US');if(q.length>100||controls.test(q))fail(400,'address_book_query_invalid');
 let afterSort='',afterId='';const expected=await context(env,initial,q);
 if(query?.cursor){const decoded=await decodeCursor(env,query.cursor);if(!decoded)fail(400,'address_book_cursor_invalid');
  if(decoded.workspaceId!==workspaceId||decoded.sourceId!==initial.sourceId||decoded.identityId!==initial.identityId||decoded.q!==q
    ||decoded.revision!==initial.revision)fail(409,'address_book_cursor_changed');afterSort=decoded.afterSort;afterId=decoded.afterId;}
 const filters=[`contact.workspace_id=?`,`contact.source_id=?`,`contact.status='active'`],values:unknown[]=[workspaceId,initial.sourceId];
 if(q){filters.push(`(instr(contact.sort_name,?)>0 OR instr(contact.email_key,?)>0 OR instr(COALESCE(contact.phone,''),?)>0
   OR instr(COALESCE(contact.company_key,''),?)>0 OR instr(COALESCE(contact.role_key,''),?)>0)`);values.push(q,q,q,q,q);}
 if(afterId){filters.push(`(contact.sort_name>? OR (contact.sort_name=? AND contact.id>?))`);values.push(afterSort,afterSort,afterId);}
 const rows=(await env.DELIVERY_DB.prepare(`${select} WHERE ${filters.join(' AND ')} ORDER BY contact.sort_name,contact.id LIMIT ?`)
  .bind(...values,PAGE+1).all<ContactRow>()).results;const selected=rows.slice(0,PAGE),last=selected.at(-1);
 const final=await manager(env,principal,workspaceId),revision=await currentRevision(env.DELIVERY_DB,workspaceId,initial.sourceId);
 if(!final||final.identityId!==initial.identityId||final.sourceId!==initial.sourceId||revision!==initial.revision)fail(409,'address_book_context_changed');
 return {items:selected.map(view),nextCursor:rows.length>PAGE&&last?await encodeCursor(env,{v:1,workspaceId,sourceId:initial.sourceId,
  identityId:initial.identityId,revision:initial.revision,q,afterSort:last.sort_name!,afterId:last.id,expires:Date.now()+CURSOR_MS}):null,contextVersion:expected};
}
export async function readWorkspaceAddressContact(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,contactId:string){
 const initial=await manager(env,principal,workspaceId);if(!initial||!ids.test(contactId))fail(404,'address_contact_unavailable');
 const row=await activeContact(env.DELIVERY_DB,workspaceId,contactId);if(!row||row.source_id!==initial.sourceId)fail(404,'address_contact_unavailable');
 const final=await manager(env,principal,workspaceId);if(!final||final.identityId!==initial.identityId||final.sourceId!==initial.sourceId
  ||final.revision!==initial.revision||row.version<1||row.source_id!==final.sourceId)fail(409,'address_book_context_changed');
 return {contact:view(row),contextVersion:await context(env,initial,'')};
}

async function saved(db:Pick<D1Database,'prepare'>,manager:Manager,key:string,operation:string,hash:string){if(!keys.test(key))fail(400,'address_contact_idempotency_invalid');
 const row=await db.prepare(`SELECT operation,request_hash,contact_id,result_version FROM portal_workspace_address_contact_commands
  WHERE workspace_id=? AND actor_identity_id=? AND idempotency_key=?`).bind(manager.workspaceId,manager.identityId,key)
  .first<{operation:string;request_hash:string;contact_id:string;result_version:number}>();
 if(row&&(row.operation!==operation||row.request_hash!==hash))fail(409,'address_contact_idempotency_conflict');return row;}
function command(db:Database,manager:Manager,key:string,operation:string,hash:string,contactId:string,version:number){return db.prepare(`INSERT INTO portal_workspace_address_contact_commands
 (workspace_id,actor_identity_id,idempotency_key,operation,request_hash,contact_id,result_version) VALUES(?,?,?,?,?,?,?)`)
 .bind(manager.workspaceId,manager.identityId,key,operation,hash,contactId,version);}
function fence(db:Database,condition:string,values:unknown[]){return db.prepare(`INSERT INTO portal_workspace_address_contact_fences(id,write_guard)
 VALUES(?,CASE WHEN (${condition}) THEN 1 ELSE 0 END)`).bind(crypto.randomUUID(),...values);}
function audit(db:Database,manager:Manager,contactId:string,version:number,action:string,fields:string[]){return db.prepare(`INSERT INTO portal_workspace_address_contact_audit
 (id,workspace_id,source_id,contact_id,contact_version,actor_identity_id,action,changed_fields_json) VALUES(?,?,?,?,?,?,?,?)`)
 .bind(crypto.randomUUID(),manager.workspaceId,manager.sourceId,contactId,version,manager.identityId,action,JSON.stringify(fields));}
async function replay(env:Env,principal:VerifiedClientPrincipal,initial:Manager,row:{contact_id:string;result_version:number},expected:'active'):Promise<{contact:AddressBookContact;replayed:true}>;
async function replay(env:Env,principal:VerifiedClientPrincipal,initial:Manager,row:{contact_id:string;result_version:number},expected:'deleted'):Promise<{contact:DeletedAddressBookContact;replayed:true}>;
async function replay(env:Env,principal:VerifiedClientPrincipal,initial:Manager,row:{contact_id:string;result_version:number},expected:'active'|'deleted'){
 const current=await activeContact(env.DELIVERY_DB,initial.workspaceId,row.contact_id),final=await manager(env,principal,initial.workspaceId);
 if(!final||final.identityId!==initial.identityId||final.sourceId!==initial.sourceId)fail(404,'address_book_unavailable');
 if(current){if(expected!=='active'||current.source_id!==initial.sourceId||current.version!==row.result_version)fail(409,'address_contact_replay_superseded');return {contact:view(current),replayed:true as const};}
 const tombstone=await env.DELIVERY_DB.prepare(`SELECT id,workspace_id workspaceId,source_id sourceId,status,version FROM portal_workspace_address_contacts WHERE id=? AND workspace_id=? AND status='deleted'`)
  .bind(row.contact_id,initial.workspaceId).first<DeletedAddressBookContact>();
 if(tombstone&&expected==='deleted'&&tombstone.sourceId===initial.sourceId&&tombstone.version===row.result_version)return {contact:tombstone,replayed:true as const};
 fail(409,'address_contact_replay_superseded');}
async function hydrateActive(env:Env,principal:VerifiedClientPrincipal,initial:Manager,contactId:string,version:number){const row=await activeContact(env.DELIVERY_DB,initial.workspaceId,contactId),
 final=await manager(env,principal,initial.workspaceId);if(!row||row.source_id!==initial.sourceId||row.version!==version||!final||final.identityId!==initial.identityId
  ||final.sourceId!==initial.sourceId||final.revision!==initial.revision+1)fail(409,'address_book_context_changed');return view(row);}
async function hydrateDeleted(env:Env,principal:VerifiedClientPrincipal,initial:Manager,contactId:string,version:number){const final=await manager(env,principal,initial.workspaceId),
 row=await env.DELIVERY_DB.prepare(`SELECT id,workspace_id workspaceId,source_id sourceId,status,version FROM portal_workspace_address_contacts
  WHERE id=? AND workspace_id=? AND source_id=? AND status='deleted' AND version=?`).bind(contactId,initial.workspaceId,initial.sourceId,version).first<DeletedAddressBookContact>();
 if(!row||!final||final.identityId!==initial.identityId||final.sourceId!==initial.sourceId||final.revision!==initial.revision+1)fail(409,'address_book_context_changed');return row;}

export async function createWorkspaceAddressContact(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,value:AddressBookContactInput,idempotencyKey:string){
 const manager=await writableManager(env,principal,workspaceId),normalized=input(value),hash=await commandFingerprint(env,JSON.stringify(normalized));
 const prior=await saved(env.DELIVERY_DB,manager,idempotencyKey,'create',hash);if(prior)return replay(env,principal,manager,prior,'active');
 const id=crypto.randomUUID();try{await env.DELIVERY_DB.batch([manager.proof.fence(`address-create-${id}`),
  fence(env.DELIVERY_DB,`(SELECT count(*) FROM portal_workspace_address_contacts WHERE workspace_id=? AND status='active')<?`,[workspaceId,MAX_CONTACTS]),
  env.DELIVERY_DB.prepare(`INSERT INTO portal_workspace_address_contacts(id,workspace_id,source_id,display_name,sort_name,email,email_key,phone,company,company_key,role_or_trade,role_key,created_by_identity_id,updated_by_identity_id)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,workspaceId,manager.sourceId,normalized.displayName,normalized.sortName,normalized.email,normalized.emailKey,
    normalized.phone,normalized.company,normalized.companyKey,normalized.roleOrTrade,normalized.roleKey,manager.identityId,manager.identityId),
  command(env.DELIVERY_DB,manager,idempotencyKey,'create',hash,id,1),audit(env.DELIVERY_DB,manager,id,1,'contact.created',['displayName','email','phone','company','roleOrTrade'])]);
 }catch(error){const winner=await saved(env.DELIVERY_DB,manager,idempotencyKey,'create',hash);if(winner)return replay(env,principal,manager,winner,'active');
  const active=await env.DELIVERY_DB.prepare(`SELECT count(*) total FROM portal_workspace_address_contacts
   WHERE workspace_id=? AND source_id=? AND status='active'`).bind(workspaceId,manager.sourceId).first<number>('total');
  if((active??0)>=MAX_CONTACTS)fail(409,'address_book_capacity');
  throw error;}
 return {contact:await hydrateActive(env,principal,manager,id,1),replayed:false as const};
}
export async function updateWorkspaceAddressContact(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,contactId:string,value:AddressBookContactInput&{expectedVersion:number},idempotencyKey:string){
 const manager=await writableManager(env,principal,workspaceId);if(!ids.test(contactId)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1)fail(400,'address_contact_invalid');
 const normalized=input(value),hash=await commandFingerprint(env,JSON.stringify({contactId,expectedVersion:value.expectedVersion,...normalized}));const prior=await saved(env.DELIVERY_DB,manager,idempotencyKey,'update',hash);if(prior)return replay(env,principal,manager,prior,'active');
 const old=await activeContact(env.DELIVERY_DB,workspaceId,contactId);if(!old||old.source_id!==manager.sourceId)fail(404,'address_contact_unavailable');if(old.version!==value.expectedVersion)fail(409,'address_contact_changed');
 const changed:string[]=[];for(const [name,before,after] of [['displayName',old.display_name,normalized.displayName],['email',old.email_key,normalized.emailKey],['phone',old.phone,normalized.phone],
  ['company',old.company,normalized.company],['roleOrTrade',old.role_or_trade,normalized.roleOrTrade]] as const)if(before!==after)changed.push(name);
 const version=old.version+1;try{await env.DELIVERY_DB.batch([manager.proof.fence(`address-update-${crypto.randomUUID()}`),fence(env.DELIVERY_DB,
  `EXISTS(SELECT 1 FROM portal_workspace_address_contacts WHERE id=? AND workspace_id=? AND source_id=? AND status='active' AND version=?)`,[contactId,workspaceId,manager.sourceId,old.version]),
  env.DELIVERY_DB.prepare(`UPDATE portal_workspace_address_contacts SET display_name=?,sort_name=?,email=?,email_key=?,phone=?,company=?,company_key=?,role_or_trade=?,role_key=?,
   version=version+1,updated_by_identity_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND source_id=? AND status='active' AND version=?`)
   .bind(normalized.displayName,normalized.sortName,normalized.email,normalized.emailKey,normalized.phone,normalized.company,normalized.companyKey,
    normalized.roleOrTrade,normalized.roleKey,manager.identityId,contactId,workspaceId,manager.sourceId,old.version),command(env.DELIVERY_DB,manager,idempotencyKey,'update',hash,contactId,version),
  audit(env.DELIVERY_DB,manager,contactId,version,'contact.updated',changed)]);
 }catch(error){const winner=await saved(env.DELIVERY_DB,manager,idempotencyKey,'update',hash);if(winner)return replay(env,principal,manager,winner,'active');
  const current=await activeContact(env.DELIVERY_DB,workspaceId,contactId);if(!current||current.version!==old.version)fail(409,'address_contact_changed');throw error;}
 return {contact:await hydrateActive(env,principal,manager,contactId,version),replayed:false as const};
}
export async function deleteWorkspaceAddressContact(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,contactId:string,expectedVersion:number,idempotencyKey:string){
 const manager=await writableManager(env,principal,workspaceId);if(!ids.test(contactId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)fail(400,'address_contact_invalid');
 const hash=await commandFingerprint(env,JSON.stringify({contactId,expectedVersion})),prior=await saved(env.DELIVERY_DB,manager,idempotencyKey,'delete',hash);if(prior)return replay(env,principal,manager,prior,'deleted');
 const old=await activeContact(env.DELIVERY_DB,workspaceId,contactId);if(!old||old.source_id!==manager.sourceId)fail(404,'address_contact_unavailable');if(old.version!==expectedVersion)fail(409,'address_contact_changed');const version=old.version+1;
 try{await env.DELIVERY_DB.batch([manager.proof.fence(`address-delete-${crypto.randomUUID()}`),fence(env.DELIVERY_DB,
  `EXISTS(SELECT 1 FROM portal_workspace_address_contacts WHERE id=? AND workspace_id=? AND source_id=? AND status='active' AND version=?)`,[contactId,workspaceId,manager.sourceId,old.version]),
  env.DELIVERY_DB.prepare(`UPDATE portal_workspace_address_contacts SET display_name=NULL,sort_name=NULL,email=NULL,email_key=NULL,phone=NULL,company=NULL,company_key=NULL,
   role_or_trade=NULL,role_key=NULL,status='deleted',version=version+1,updated_by_identity_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id=? AND workspace_id=? AND source_id=? AND status='active' AND version=?`).bind(manager.identityId,contactId,workspaceId,manager.sourceId,old.version),
  command(env.DELIVERY_DB,manager,idempotencyKey,'delete',hash,contactId,version),audit(env.DELIVERY_DB,manager,contactId,version,'contact.deleted',['status','displayName','email','phone','company','roleOrTrade'])]);
 }catch(error){const winner=await saved(env.DELIVERY_DB,manager,idempotencyKey,'delete',hash);if(winner)return replay(env,principal,manager,winner,'deleted');const current=await activeContact(env.DELIVERY_DB,workspaceId,contactId);if(!current||current.version!==old.version)fail(409,'address_contact_changed');throw error;}
 return {contact:await hydrateDeleted(env,principal,manager,contactId,version),replayed:false as const};
}
