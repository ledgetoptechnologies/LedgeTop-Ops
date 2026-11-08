import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {expect,it} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {reviewedOperationsMigrationNames} from './helpers/reviewed-operations-migration-chain';
// @ts-expect-error reviewed test-only JavaScript seed transformer
import {transformSeed} from '../../../scripts/staging-bootstrap.mjs';

it('applies the reviewed full Operations chain including Intel and later portal successors',async()=>{
 const directory=new URL('../migrations/',import.meta.url);
 // This validates every physical successor and its hash before enumeration;
 // unknown SQL files cannot silently join the integration rehearsal.
 reviewedOperationsMigrationNames(directory);
 const names=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
 const intelRelease=['0229_owner_intel_source_feed.sql','0230_app_release_pilot.sql','0231_owner_google_ads_summary.sql'];
 const intelStart=names.indexOf(intelRelease[0]);
 expect(intelStart).toBeGreaterThanOrEqual(0);
 expect(names.slice(intelStart,intelStart+intelRelease.length)).toEqual(intelRelease);
 const portalSuccessors=['0233_operations_portal_native_recipient_capability_intents.sql',
  '0234_operations_portal_native_inquiry_capability.sql','0235_ops_principal_inquiries.sql'];
 expect(names).toEqual(expect.arrayContaining([...intelRelease,...portalSuccessors]));
 expect(names.indexOf(intelRelease.at(-1)!)).toBeLessThan(names.indexOf(portalSuccessors[0]));
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
