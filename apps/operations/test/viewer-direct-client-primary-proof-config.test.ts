import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';

vi.mock('../src/worker/acl',()=>({sqlScope:vi.fn(async()=>({global:true,deniedGlobal:false}))}));
import {listDirectViewerClientGrantWorkspace} from '../src/worker/viewer-direct-client-grants';

const PRIMARY='project-alpha:primary';
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
let mf:Miniflare;
let database:D1Database;

function config(path:URL){return JSON.parse(readFileSync(path,'utf8')) as {vars:Record<string,string>};}
async function sha256(value:string){
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function apply(name:string){
 const sql=readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),'utf8');
 await database.batch(splitD1MigrationStatements(sql).map(statement=>database.prepare(statement)));
}

beforeAll(async()=>{
 mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",
  d1Databases:{DELIVERY_DB:'primary-proof-config'}});
 database=await mf.getD1Database('DELIVERY_DB') as D1Database;
 await database.batch([
  `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
   root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
  `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
  `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
  `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
  `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
  `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
  `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`,
 ].map(sql=>database.prepare(sql)));
 await apply('0162_portal_source_authorities.sql');
 await database.batch([
  database.prepare(`INSERT INTO portal_v2_workspaces VALUES('primary-workspace',? ,NULL,'active','Synthetic LTDS Client',
   'standalone_client',NULL,'primary-client')`).bind(PRIMARY),
  database.prepare(`INSERT INTO pa_portal_workspace_sources VALUES('primary-workspace',?,'primary-source-workspace')`).bind(PRIMARY),
  database.prepare(`INSERT INTO portal_v2_directory_checkpoints VALUES('primary-workspace','primary-generation',1)`),
  database.prepare(`INSERT INTO portal_v2_directory_generations VALUES('primary-generation','primary-workspace','active',1)`),
  database.prepare(`INSERT INTO portal_v2_directory_entities VALUES('primary-workspace','primary-generation','standalone_client',
   'primary-client','v1',1,'Synthetic LTDS Client')`),
  database.prepare(`INSERT INTO pa_connectors VALUES(?,1,'LTDS')`).bind(PRIMARY),
 ]);
 await apply('0231_portal_primary_private_ingress_authority.sql');
 await apply('0237_viewer_direct_client_grants.sql');
});
afterAll(async()=>{await mf?.dispose();});

function env(overrides:Partial<Env>={}):Env{return {DELIVERY_DB:database,OPS_DB:database,
 APPLICATION_KEY:'ltds_ops',...overrides} as Env;}

describe('primary Viewer recipient private-proof configuration',()=>{
 it('uses the existing Operations application key without adding portal bindings or enabling Viewer flags',()=>{
  const ops=config(new URL('../wrangler.jsonc',import.meta.url));
  const client=config(new URL('../../client/wrangler.jsonc',import.meta.url));
  expect(client.vars.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED).toBe('false');
  expect(client.vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY).toBe('ltds_ops');
  expect(ops.vars.APPLICATION_KEY).toBe(client.vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY);
  expect(ops.vars.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED).toBeUndefined();
  expect(ops.vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY).toBeUndefined();
  expect(ops.vars.CLIENT_VIEWER_SESSION_ISSUER_ENABLED).toBe('true');
  expect(client.vars.CLIENT_VIEWER_ENABLED).toBe('true');
 });

 it('defaults to the matching private authority and denies absent, mismatched, or explicit legacy mode without its key',async()=>{
  const read=(sourceEnv:Env)=>listDirectViewerClientGrantWorkspace(sourceEnv,principal,{q:'Synthetic'});
  const rootCount=async()=>database.prepare('SELECT count(*) n FROM portal_v2_workspaces').first<number>('n');
  const authorityCount=async()=>database.prepare('SELECT count(*) n FROM pa_portal_primary_private_authority').first<number>('n');

  expect((await read(env())).clients).toEqual([]);
  expect(await authorityCount()).toBe(0);
  expect(await rootCount()).toBe(1);

  // Fixture represents a row created earlier by authenticated private ingress.
  await database.prepare(`INSERT INTO pa_portal_primary_private_authority(source_id,application_key,state,version)
   VALUES(?,'ltds_ops','active',1)`).bind(PRIMARY).run();
  const result=await read(env());
  expect(result.clients).toEqual([{sourceId:PRIMARY,workspaceId:'primary-workspace',displayName:'Synthetic LTDS Client',businessName:'LTDS'}]);
  expect((await read(env({APPLICATION_KEY:undefined}))).clients).toEqual([]);
  expect((await read(env({APPLICATION_KEY:'other-app'}))).clients).toEqual([]);
  expect((await read(env({PROJECT_ALPHA_PORTAL_APPLICATION_KEY:'other-app'}))).clients).toEqual([]);
  expect((await read(env({PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'true'}))).clients).toEqual([]);
  expect(await authorityCount()).toBe(1);
  expect(await rootCount()).toBe(1);
 });

 it('preserves explicitly configured legacy HMAC proof instead of silently switching modes',async()=>{
  const secret='legacy-primary-hmac-secret-with-at-least-32-bytes';
  await database.prepare('INSERT INTO pa_portal_source_signing_keys(fingerprint,source_id) VALUES(?,?)')
   .bind(await sha256(secret),PRIMARY).run();
  const result=await listDirectViewerClientGrantWorkspace(env({PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:'legacy-v1',
   PROJECT_ALPHA_PORTAL_HMAC_SECRET:secret}),principal,{q:'Synthetic'});
  expect(result.clients).toEqual([{sourceId:PRIMARY,workspaceId:'primary-workspace',displayName:'Synthetic LTDS Client',businessName:'LTDS'}]);
  expect(await database.prepare('SELECT count(*) n FROM pa_portal_source_signing_keys').first<number>('n')).toBe(1);
  expect(await database.prepare('SELECT count(*) n FROM pa_portal_primary_private_authority').first<number>('n')).toBe(1);
 });
});
