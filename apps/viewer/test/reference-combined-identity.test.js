'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations}=require('../server/database');
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA recursive_triggers=OFF');applyMigrations(db);return db;}
test('rowid aliases cannot replace dormant capacity or custody records',t=>{
 const db=setup(t);
 db.exec("INSERT INTO viewer_capacity_reservations(id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,remaining_bytes,peak_inodes,remaining_inodes,state,created_at,updated_at) VALUES('r','d','rev','test','w','ns','o','f',1,100,100,1,1,'held','t','t'); INSERT INTO viewer_custody_intents VALUES('i','j',1,'staging','h','{}','building','t'); INSERT INTO viewer_custody_pins VALUES('i','csv',1,'h','source',1)");
 const r=db.prepare('SELECT rowid n FROM viewer_capacity_reservations').get().n,i=db.prepare('SELECT rowid n FROM viewer_custody_intents').get().n,p=db.prepare('SELECT rowid n FROM viewer_custody_pins').get().n;
 for(const k of ['rowid','_rowid_','oid']){
  assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO viewer_capacity_reservations(${k},id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,remaining_bytes,peak_inodes,remaining_inodes,state,created_at,updated_at) VALUES(?,'new','new','rev','test','new','ns','o','f',1,100,100,1,1,'held','t','t')`).run(r));
  assert.throws(()=>db.prepare(`UPDATE OR REPLACE viewer_capacity_reservations SET ${k}=? WHERE id='r'`).run(r+1));
  assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO viewer_custody_intents(${k},id,job_id,generation,environment,binding_sha256,canonical_binding,state,created_at) VALUES(?,'new','new',1,'staging','h','{}','building','t')`).run(i));
  assert.throws(()=>db.prepare(`UPDATE OR REPLACE viewer_custody_intents SET ${k}=?,state='prepared' WHERE id='i'`).run(i+1));
  assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO viewer_custody_pins(${k},intent_id,object_id,byte_size,sha256,kind,permanent_csv) VALUES(?,'i','other',1,'h','source',0)`).run(p));
  assert.throws(()=>db.prepare(`UPDATE OR REPLACE viewer_custody_pins SET ${k}=? WHERE object_id='csv'`).run(p+1));
 }
 assert.throws(()=>db.exec("INSERT OR REPLACE INTO viewer_capacity_control VALUES(1,'cooperative','verified')"));
 assert.equal(db.prepare("SELECT permanent_csv FROM viewer_custody_pins WHERE object_id='csv'").get().permanent_csv,1);
 assert.equal(db.prepare('SELECT remaining_bytes FROM viewer_capacity_reservations').get().remaining_bytes,100);
});
test('older prototype 43 and 44 schemas fail strict preflight',t=>{for(const version of [43,44]){const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const m of MIGRATIONS.filter(x=>x.version<=version)){let sql=m.sql;if(m.version===43){sql=sql.replace(/    CREATE TRIGGER viewer_capacity_control_no_replace[^\n]*\n/,'');}if(m.version===44){sql=sql.replace('WHERE rowid=NEW.rowid OR id=NEW.id OR (job_id=', 'WHERE id=NEW.id OR (job_id=');}db.exec(sql);m.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.name,'t');}assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});}finally{db.close();}}});
