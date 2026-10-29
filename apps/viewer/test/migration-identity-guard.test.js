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
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration-guard-')),file=path.join(dir,'db.sqlite');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(file);db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(41,'other_feature','t'); CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('keep')");db.close();
 const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'});assert.equal(hash(),before);
});

test('unrecorded protected tables and unknown protected ledger entries fail closed',t=>{
 const db=legacy();t.after(()=>db.close());db.exec('CREATE TABLE gcp_odm_crs_confirmations(id TEXT)');let before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
 db.exec("DROP TABLE gcp_odm_crs_confirmations; INSERT INTO schema_migrations VALUES(42,'viewer_workspace_hierarchy','t')");before=schema(db);assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);
});

test('canonical ledger with an incompatible protected table fails closed',t=>{
 const db=legacy();t.after(()=>db.close());db.exec("INSERT INTO schema_migrations VALUES(41,'gcp_odm_crs_confirmations','t'); CREATE TABLE gcp_odm_crs_confirmations(set_id TEXT PRIMARY KEY)");const before=schema(db),ledger=JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
 assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});assert.equal(schema(db),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()),ledger);
});
