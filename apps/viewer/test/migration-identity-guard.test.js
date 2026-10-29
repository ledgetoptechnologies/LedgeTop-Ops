'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations,openDatabase}=require('../server/database');
const {assertProtectedMigrationIdentity}=require('../server/migrationIdentityGuard');

function legacy(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const m of MIGRATIONS.filter(x=>x.version<=40)){db.exec(m.sql);m.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version,m.name,'2000-01-01T00:00:00Z');}return db;}
const schema=db=>JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all());

test('v40 upgrades to canonical 41 and detects a modified or unrecorded protected table',t=>{
 const db=legacy();t.after(()=>db.close());applyMigrations(db);assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=41').get().name,'gcp_odm_crs_confirmations');assertProtectedMigrationIdentity(db,MIGRATIONS);
 db.exec('DROP TABLE gcp_odm_crs_confirmations');const before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
});

test('wrong protected ledger names fail before journal mode or migration changes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const version of [41,42]){const file=path.join(dir,`${version}.sqlite`),db=new DatabaseSync(file);db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(${version},'other_feature','t'); CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('keep')`);db.close();const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'});assert.equal(hash(),before);}
});

test('case-variant ledger, table and index collisions leave database bytes and journal mode unchanged',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration-case-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const hierarchy=MIGRATIONS.find(x=>x.version===42),cases=['ledger','gcp-table','hierarchy-table','hierarchy-index'];
 for(const kind of cases){const file=path.join(dir,`${kind}.sqlite`),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE');
  const ledger=kind==='ledger'?'SCHEMA_MIGRATIONS':'schema_migrations';db.exec(`CREATE TABLE ${ledger}(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)`);
  if(kind==='gcp-table')db.exec('CREATE TABLE GCP_ODM_CRS_CONFIRMATIONS(id TEXT)');
  if(kind==='hierarchy-table'||kind==='hierarchy-index'){let sql=hierarchy.sql;if(kind==='hierarchy-table')sql=sql.replaceAll('viewer_organizations','VIEWER_ORGANIZATIONS');else sql=sql.replaceAll('viewer_project_groups_org_idx','VIEWER_PROJECT_GROUPS_ORG_IDX');db.exec(sql);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(42,hierarchy.name,'t');}
  db.close();const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'},kind);assert.equal(hash(),before,kind);
  const check=new DatabaseSync(file,{readOnly:true});try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete',kind);}finally{check.close();}assert.equal(fs.existsSync(`${file}-wal`),false,kind);
 }
});

test('index-name trigger collisions fail before changing database bytes or journal mode',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration-trigger-overlap-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [index,name] of ['viewer_project_groups_org_idx','VIEWER_PROJECT_GROUPS_ORG_IDX'].entries()){const file=path.join(dir,`collision-${index}.sqlite`),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE');for(const m of MIGRATIONS){db.exec(m.sql);m.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version,m.name,'t');}db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON viewer_project_groups BEGIN SELECT RAISE(ABORT,'blocked'); END`);db.close();const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'},name);assert.equal(hash(),before,name);const check=new DatabaseSync(file,{readOnly:true});try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete',name);}finally{check.close();}assert.equal(fs.existsSync(`${file}-wal`),false,name);}
});

test('unrecorded protected tables and unknown protected ledger entries fail closed',t=>{
 const db=legacy();t.after(()=>db.close());db.exec('CREATE TABLE gcp_odm_crs_confirmations(id TEXT)');let before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
 db.exec("DROP TABLE gcp_odm_crs_confirmations; INSERT INTO schema_migrations VALUES(42,'viewer_workspace_hierarchy','t')");before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
});

test('canonical ledger with an incompatible protected table fails closed',t=>{
 const db=legacy();t.after(()=>db.close());db.exec("INSERT INTO schema_migrations VALUES(41,'gcp_odm_crs_confirmations','t'); CREATE TABLE gcp_odm_crs_confirmations(set_id TEXT PRIMARY KEY)");const before=schema(db),ledger=JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
 assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()),ledger);
});

test('unexpected trigger on a protected table fails closed',t=>{
 const db=legacy();t.after(()=>db.close());applyMigrations(db);db.exec('CREATE TRIGGER unexpected_guard BEFORE DELETE ON gcp_odm_crs_confirmations BEGIN SELECT RAISE(ABORT,\'blocked\'); END');const before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
});

test('a GCP-only 41 database gains hierarchy 42 without rewriting its control records',t=>{
 const db=legacy();t.after(()=>db.close());const migration=MIGRATIONS.find(x=>x.version===41);db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(41,migration.name,'2000-01-01T00:00:00Z');
 db.exec("INSERT INTO projects(id,display_name,created_at,updated_at) VALUES('p','Test','t','t'); INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,created_at,updated_at) VALUES('d','p','Data','managed','datasets','d','finalized','t','t');");
 db.prepare("INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_sha256,source_content,source_byte_size,crs,elevation_units,created_at,updated_at) VALUES('g','d','Control','generic-csv-v1',?,'bytes',5,'EPSG:4326','m','t','t')").run('a'.repeat(64));
 db.prepare("INSERT INTO gcp_odm_crs_confirmations VALUES('g',?,32616,'m','datum',?,'test','t')").run('a'.repeat(64),'b'.repeat(64));const before=JSON.stringify(db.prepare('SELECT * FROM gcp_odm_crs_confirmations').all());
 applyMigrations(db);assert.equal(JSON.stringify(db.prepare('SELECT * FROM gcp_odm_crs_confirmations').all()),before);assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=42').get().name,'viewer_workspace_hierarchy');
});

test('a populated hierarchy-only 42 database gains 41 without changing assignments',t=>{
 const db=legacy();t.after(()=>db.close());const migration=MIGRATIONS.find(x=>x.version===42);db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(42,migration.name,'t');
 db.exec("INSERT INTO projects(id,display_name,created_at,updated_at) VALUES('p','Project','t','t'); INSERT INTO viewer_organizations(id,display_name) VALUES('org','Organization'); INSERT INTO viewer_project_groups(id,organization_id,display_name) VALUES('group','org','Group'); INSERT INTO viewer_project_hierarchy(project_id,organization_id,group_id,revision) VALUES('p','org','group',2)");
 const before=JSON.stringify(db.prepare('SELECT * FROM viewer_project_hierarchy').all());applyMigrations(db);assert.equal(JSON.stringify(db.prepare('SELECT * FROM viewer_project_hierarchy').all()),before);assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=41').get().name,'gcp_odm_crs_confirmations');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('hierarchy 42 with a missing index or foreign ledger name refuses before applying 41',t=>{
 for(const mode of ['missing-index','wrong-name']){const db=legacy();try{const migration=MIGRATIONS.find(x=>x.version===42);db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(42,mode==='wrong-name'?'foreign_hierarchy':migration.name,'t');if(mode==='missing-index')db.exec('DROP INDEX viewer_project_groups_org_idx');const before=schema(db),ledger=JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()),ledger);assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=41').get(),undefined);}finally{db.close();}}
});

test('unexpected hierarchy indexes and triggers refuse before any migration',()=>{
 for(const extra of ['CREATE INDEX unexpected_hierarchy_index ON viewer_organizations(display_name)',"CREATE TRIGGER unexpected_hierarchy_trigger BEFORE DELETE ON viewer_organizations BEGIN SELECT RAISE(ABORT,'blocked'); END"]){const db=legacy();try{const migration=MIGRATIONS.find(x=>x.version===42);db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(42,migration.name,'t');db.exec(extra);const before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=41').get(),undefined);}finally{db.close();}}
});


test('capacity ledger collisions fail before changing existing schema or ledger',()=>{
 for(const kind of ['foreign-name','unrecorded-table','case-table','foreign-trigger']){
  const db=legacy();try {
   for(const m of MIGRATIONS.filter(x=>x.version===41||x.version===42)){db.exec(m.sql);m.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.name,'t');}
   const m=MIGRATIONS.find(x=>x.version===43);
   if(kind==='foreign-name')db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(43,'other_feature','t');
   if(kind==='unrecorded-table')db.exec('CREATE TABLE viewer_capacity_control(singleton INTEGER)');
   if(kind==='case-table'){db.exec(m.sql.replaceAll('viewer_capacity_control','VIEWER_CAPACITY_CONTROL'));db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(43,m.name,'t');}
   if(kind==='foreign-trigger'){db.exec(m.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(43,m.name,'t');db.exec("CREATE TRIGGER other_capacity_trigger BEFORE DELETE ON viewer_capacity_reservations BEGIN SELECT RAISE(ABORT,'blocked'); END");}
   const before=schema(db), ledger=JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
   assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'},kind);assert.equal(schema(db),before,kind);assert.equal(JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()),ledger,kind);
  }finally{db.close();}
 }
});
