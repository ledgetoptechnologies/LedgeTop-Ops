'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const test=require('node:test');
const {MIGRATIONS,openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {GcpSourceOriginals}=require('../server/gcpSourceOriginals');

test('real schema42 disk database upgrades legacy sources and reopens retained originals',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-upgrade-'));
  const identity=fs.statSync(root,{bigint:true}),file=path.join(root,'viewer.sqlite');
  let database=new DatabaseSync(file);
  t.after(()=>{
    database?.close();
    const current=fs.statSync(root,{bigint:true});
    assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
    assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep+'ltds-gcp-upgrade-'));
    fs.rmSync(root,{recursive:true});
  });
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
  // Build the real prior schema from its unchanged migration SQL/hooks, with
  // its real ledger. Never mutate the exported migration list for other tests.
  for(const migration of MIGRATIONS.filter(value=>value.version<=42)){
    database.exec('BEGIN IMMEDIATE');
    try{
      database.exec(migration.sql);migration.after?.(database);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(migration.version,migration.name,new Date().toISOString());
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
  }
  const processing=new ProcessingRepository(database);
  const project=processing.createProject({displayName:'Synthetic legacy source'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const source='point_id,label,latitude,longitude,elevation_m\r\nA,A,44.5,-88.1,250\r\n';
  const sha=crypto.createHash('sha256').update(source).digest('hex'),now=new Date().toISOString();
  database.prepare(`INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_filename,source_sha256,
    source_content,source_byte_size,crs,elevation_units,created_at,updated_at)
    VALUES ('legacy',?,'Control','generic-csv-v1','control.csv',?,?,?,'EPSG:4326','m',?,?)`)
    .run(dataset.id,sha,source,Buffer.byteLength(source),now,now);
  database.close();database=null;

  database=openDatabase(file);
  assert.equal(database.prepare('SELECT name FROM schema_migrations WHERE version=46').get().name,
    'viewer_gcp_permanent_source_originals');
  let originals=new GcpSourceOriginals(database);
  const migrated=database.prepare("SELECT source_original_id FROM gcp_sets WHERE id='legacy'").get();
  assert.equal(originals.get(migrated.source_original_id).fidelity,'legacy_utf8_snapshot');
  assert.deepEqual(originals.get(migrated.source_original_id).bytes,Buffer.from(source));
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(source)]);
  const uploaded=originals.retain({datasetId:dataset.id,projectId:project.id,fileName:'original.csv',bytes});
  assert.equal(new GcpRepository(database).deleteSet('legacy'),true);
  database.close();database=null;

  database=openDatabase(file);originals=new GcpSourceOriginals(database);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=46').get().n,1);
  assert.deepEqual(originals.get(uploaded.id).bytes,bytes);
  assert.equal(originals.get(uploaded.id).fidelity,'original_bytes');
  assert.deepEqual(originals.get(migrated.source_original_id).bytes,Buffer.from(source));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM gcp_sets WHERE id='legacy'").get().n,0);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
