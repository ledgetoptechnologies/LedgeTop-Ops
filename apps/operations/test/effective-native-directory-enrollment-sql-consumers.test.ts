import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';

const objects=[
  ['view','operations_directory_live_write_fences'],['view','operations_directory_live_relationship_fences'],
  ['trigger','operations_directory_intent_relationship_dependencies_insert_guard'],['view','project_alpha_directory_live_relationship_commands'],
  ['trigger','project_alpha_directory_relationship_generation_recovery_authorization_review_exact'],
  ['trigger','project_alpha_directory_relationship_generation_recovery_client_enrollment'],
  ['trigger','project_alpha_directory_relationship_generation_recovery_organization_enrollment'],
  ['view','project_alpha_directory_live_relationship_generation_recoveries'],['view','operations_directory_live_lifecycle_fences'],
] as const;
const migrations=new URL('../migrations/',import.meta.url);
async function migrate(database:D1Database,through?:string){
  for(const name of readdirSync(migrations).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&(!through||name<through)).sort())
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(sql=>database.prepare(sql)));
}

let runtime:Miniflare,db:D1Database;
describe('effective enrollment SQL consumers',()=>{
  beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS']});db=await runtime.getD1Database('OPS') as D1Database;await migrate(db);},120_000);
  afterAll(async()=>runtime.dispose());

  it('applies in the full chain and changes only the enrollment relation in every affected definition',async()=>{
    const prior=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['PRIOR']});
    try{
      const priorDb=await prior.getD1Database('PRIOR') as D1Database;await migrate(priorDb,'0203_');
      for(const [type,name] of objects){
        const before=await priorDb.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').bind(type,name).first<string>('sql');
        const after=await db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').bind(type,name).first<string>('sql');
        expect(after,name).toBe(before!.replaceAll('native_directory_enrollments','effective_native_directory_enrollments'));
        expect(after,name).not.toMatch(/\bnative_directory_enrollments\b/);
      }
    }finally{await prior.dispose();}
  },120_000);

  it('projects only the latest additive snapshot, making an exact old-snapshot join stale',async()=>{
    const view=await db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='effective_native_directory_enrollments'").first<string>('sql');
    const probe=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['PROBE']});
    try{
      const p=await probe.getD1Database('PROBE') as D1Database;
      const setup=`CREATE TABLE native_directory_enrollments(record_id TEXT,destinations_json TEXT,create_admission_id TEXT,created_at TEXT);CREATE TABLE reviewed_import_enrollment_receipts(receipt_id TEXT,admission_id TEXT,record_id TEXT,enrollment_version INTEGER,destinations_json TEXT,admitted_at TEXT);${view};CREATE TABLE fences(record_id TEXT,destinations_json TEXT);`;
      await p.batch(splitD1MigrationStatements(setup).map(sql=>p.prepare(sql)));
      const old='[{"sourceId":"s","externalCanonicalId":"old"}]',latest='[{"sourceId":"s","externalCanonicalId":"old"},{"sourceId":"s2","externalCanonicalId":"new"}]';
      await p.batch([p.prepare("INSERT INTO native_directory_enrollments VALUES('ops',?,'create','2026-01-01T00:00:00.000Z')").bind(old),p.prepare("INSERT INTO fences VALUES('ops',?)").bind(old)]);
      expect(await p.prepare('SELECT count(*) n FROM fences JOIN effective_native_directory_enrollments USING(record_id) WHERE json(fences.destinations_json)=json(effective_native_directory_enrollments.destinations_json)').first<number>('n')).toBe(1);
      await p.prepare("INSERT INTO reviewed_import_enrollment_receipts VALUES('r','a','ops',1,?,'2026-01-02T00:00:00.000Z')").bind(latest).run();
      expect(await p.prepare('SELECT count(*) n FROM fences JOIN effective_native_directory_enrollments USING(record_id) WHERE json(fences.destinations_json)=json(effective_native_directory_enrollments.destinations_json)').first<number>('n')).toBe(0);
    }finally{await probe.dispose();}
  });
});
