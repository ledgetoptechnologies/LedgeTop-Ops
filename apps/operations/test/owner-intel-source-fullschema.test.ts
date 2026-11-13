import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {expect,it} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {reviewedOperationsMigrationNames} from './helpers/reviewed-operations-migration-chain';
// @ts-expect-error reviewed test-only JavaScript seed transformer
import {transformSeed} from '../../../scripts/staging-bootstrap.mjs';

it('applies the reviewed full Operations chain including default-off owner Ads and the pinned Logs successors',async()=>{
 const directory=new URL('../migrations/',import.meta.url);
 // This validates every physical successor and its hash before enumeration;
 // unknown SQL files cannot silently join the integration rehearsal.
 reviewedOperationsMigrationNames(directory);
 const names=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
  expect(names).toHaveLength(235);
  expect(names.slice(0,230).at(-1)).toBe('0230_app_release_pilot.sql');
  expect(names.slice(230)).toEqual(['0231_owner_google_ads_summary.sql','0240_flight_logs_permissions.sql','0241_staff_usernames.sql',
    '0242_native_staff_onboarding_approval_actor_authority.sql','0243_staff_logs_device_eligibility.sql']);
 const runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {}',d1Databases:{OPS_DB:crypto.randomUUID()}});
 try{
  const db=await runtime.getD1Database('OPS_DB') as unknown as D1Database;
  await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)').run();
  for(const name of names){
   const raw=readFileSync(new URL(name,directory),'utf8').replace(/\r\n/g,'\n');
   const sql=name==='0002_seed_acl.sql'?transformSeed('operations',raw,{email:'synthetic-schema@staging.example.test',displayName:'Synthetic Staging Schema Owner',clientStaffId:'staging-client-owner',operationsStaffId:'staging-ops-owner'}) as string:raw;
   await db.batch([...splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  }
  expect((await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all<{name:string}>()).results.map(row=>row.name)).toEqual(names);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect(await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_source_control WHERE singleton=1').first()).toEqual({enabled:0,storage_accepted:0});
  expect(await db.prepare('SELECT enabled,storage_accepted FROM app_release_control WHERE singleton=1').first()).toEqual({enabled:0,storage_accepted:0});
  expect(await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control WHERE singleton=1').first()).toEqual({enabled:0,storage_accepted:0});
  for(const table of ['owner_intel_source_bindings','owner_intel_source_inbox','owner_intel_source_projections','ci_ingest_producer_keys','owner_intel_read_grants'])
   expect(await db.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>('count')).toBe(0);
  for(const table of ['owner_intel_google_ads_bindings','owner_intel_google_ads_inbox','owner_intel_google_ads_projections'])
   expect(await db.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>('count')).toBe(0);
 }finally{await runtime.dispose();}
},300000);
