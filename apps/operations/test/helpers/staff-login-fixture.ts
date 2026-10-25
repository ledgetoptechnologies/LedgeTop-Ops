import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../../client/test/helpers/d1-migrations';
import type {VerifiedStaffLoginClaims} from '../../src/worker/staff-login-bindings';

export const STAFF_LOGIN_TEST_ISSUER='https://synthetic-team.cloudflareaccess.com';
export const staffLoginClaims=(email:string,subject:string):VerifiedStaffLoginClaims=>({issuer:STAFF_LOGIN_TEST_ISSUER,email,subject,
 issuedAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+3600});
const baseline=`
 CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,display_name TEXT,access_subject TEXT UNIQUE,
  project_alpha_user_id TEXT,status TEXT,last_seen_at TEXT,updated_at TEXT);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
 CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT UNIQUE,active INTEGER,version INTEGER);
 CREATE TABLE test_employee_grants(staff_id TEXT,admission_version INTEGER);
`;
export async function seedStaffLoginOwner(db:D1Database,label:string){
 const id=`owner-${label}`,email=`primary-${label}@example.test`,subject=`access|owner-${label}`;
 await db.batch([
  db.prepare('INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,status) VALUES(?,?,?,?,NULL,?)').bind(id,email,'Synthetic Owner',subject,'active'),
  db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(id),
  db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,7)').bind(id,subject),
  db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,?,?,17)').bind(id,email,'Synthetic Owner'),
  db.prepare('INSERT INTO test_employee_grants VALUES(?,7)').bind(id),
 ]);
 return {id,email,subject,alternate:`alternate-${label}@example.test`,alternateSubject:`access|alternate-${label}`};
}
/** Local-only D1 fixture. Generate the secondary claims/JWT AFTER creating the
 * intent: a stale prior sign-in deliberately cannot prove the second step. */
export async function createStaffLoginFixture(options:{includeCompatibilityDatabases?:boolean}={}){
 const runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('ok')}}",
  d1Databases:{OPS_DB:'staff-login-full',...(options.includeCompatibilityDatabases?{LEGACY_DB:'staff-login-legacy',PARTIAL_DB:'staff-login-partial'}:{})}});
 try {
  const db=await runtime.getD1Database('OPS_DB') as unknown as D1Database;
  const legacy=options.includeCompatibilityDatabases?await runtime.getD1Database('LEGACY_DB') as unknown as D1Database:undefined;
  const partial=options.includeCompatibilityDatabases?await runtime.getD1Database('PARTIAL_DB') as unknown as D1Database:undefined;
  const profile=readFileSync(new URL('../../migrations/0059_native_staff_profiles.sql',import.meta.url),'utf8');
  for(const current of [db,legacy,partial].filter((d):d is D1Database=>!!d))await current.batch(splitD1MigrationStatements(baseline+profile).map(sql=>current.prepare(sql)));
  const migration=readFileSync(new URL('../../migrations/0226_staff_login_bindings.sql',import.meta.url),'utf8');
  await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
  if(partial)await partial.prepare('CREATE TABLE staff_login_binding_control(singleton INTEGER PRIMARY KEY,schema_version INTEGER)').run();
  const owner=await seedStaffLoginOwner(db,'fixture');
  return {runtime,db,legacy,partial,owner,issuer:STAFF_LOGIN_TEST_ISSUER,primaryClaims:staffLoginClaims(owner.email,owner.subject),claims:staffLoginClaims};
 }catch(error){await runtime.dispose();throw error;}
}
