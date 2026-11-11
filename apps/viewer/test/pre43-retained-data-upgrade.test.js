'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,openDatabase}=require('../server/database');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

test('pre-43 upload, processing and retained-source rows survive the current migration chain',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pre43-upgrade-')),file=path.join(root,'viewer.sqlite');let db=new DatabaseSync(file);
  t.after(()=>{try{db?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  // Construct the real historical schema, including migration after-hooks.
  for(const migration of MIGRATIONS.filter(item=>item.version<43)){
    db.exec('BEGIN IMMEDIATE');try{db.exec(migration.sql);migration.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version,migration.name,'2026-01-01T00:00:00.000Z');db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  const ts='2026-01-01T00:00:00.000Z',csv='id,latitude,longitude\np1,44,-89\n',digest=sha(csv),manifest=JSON.stringify([{id:'file-0',relativePath:'control.csv',byteSize:Buffer.byteLength(csv),sha256:digest}]);
  db.prepare('INSERT INTO projects(id,display_name,created_at,updated_at) VALUES (?,?,?,?)').run('project','Synthetic',ts,ts);
  db.prepare("INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,manifest_sha256,file_count,byte_size,created_at,updated_at,finalized_at) VALUES (?,?,?,'managed','datasets',?,'finalized',?,1,?,?,?,?)").run('dataset','project','Historical','historical',sha('manifest'),Buffer.byteLength(csv),ts,ts,ts);
  db.prepare('INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)').run('source','dataset','control.csv',Buffer.byteLength(csv),digest,'{}',ts);
  db.prepare("INSERT INTO upload_sessions(id,dataset_id,token_hash,subject,expected_manifest_json,chunk_size,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'open',?,?,?)").run('upload','dataset',sha('fixture-token'),'ops:fixture',manifest,1024,'2099-01-01T00:00:00.000Z',ts,ts);
  db.prepare('INSERT INTO upload_chunks(upload_id,file_id,chunk_index,byte_size,sha256,relative_path,created_at) VALUES (?,?,0,?,?,?,?)').run('upload','file-0',Buffer.byteLength(csv),digest,'control.csv',ts);
  db.prepare("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES (?,?,?,?,'processing',?,?)").run('task','project','dataset','Task',ts,ts);
  db.prepare("INSERT INTO processing_attempts(id,task_id,attempt_number,options_json,status,created_at,updated_at) VALUES (?, ?, 1, '{}', 'running', ?, ?)").run('attempt','task',ts,ts);
  db.prepare("INSERT INTO retained_imports(id,dataset_id,source_kind,source_root_key,source_relative_path,staging_root_key,staging_relative_path,state,created_at,updated_at) VALUES (?,?,'server_folder','dataset_import',?,'cache',?,'queued',?,?)").run('retained','dataset','fixture-source','fixture-staging',ts,ts);
  db.prepare('INSERT INTO retained_import_files(retained_import_id,relative_path,source_relative_path,role,byte_size,sha256) VALUES (?,?,?,?,?,?)').run('retained','control.csv','control.csv','source',Buffer.byteLength(csv),digest);
  db.prepare("INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_file_id,source_filename,source_sha256,source_content,source_byte_size,crs,elevation_units,created_at,updated_at) VALUES (?,?,?,'generic-csv-v1',?,?,?,?,?,'EPSG:4326','m',?,?)").run('set','dataset','Control','source','control.csv',digest,csv,Buffer.byteLength(csv),ts,ts);
  const reads=[['upload_sessions','id','upload'],['upload_chunks','upload_id','upload'],['processing_attempts','id','attempt'],['retained_imports','id','retained'],['retained_import_files','retained_import_id','retained'],['gcp_sets','id','set']];
  const columns={upload_sessions:'id,dataset_id,token_hash,subject,expected_manifest_json,chunk_size,status,expires_at',upload_chunks:'upload_id,file_id,chunk_index,byte_size,sha256,relative_path',processing_attempts:'id,task_id,attempt_number,options_json,status',retained_imports:'id,dataset_id,source_kind,source_relative_path,staging_relative_path,state',retained_import_files:'retained_import_id,relative_path,source_relative_path,role,byte_size,sha256',gcp_sets:'id,dataset_id,source_file_id,source_sha256,source_content,source_byte_size'};
  const snapshot=reads.map(([table,key,id])=>({...db.prepare(`SELECT ${columns[table]} FROM ${table} WHERE ${key}=?`).get(id)}));
  db.close();db=null;db=openDatabase(file);
  assert.deepEqual(reads.map(([table,key,id])=>({...db.prepare(`SELECT ${columns[table]} FROM ${table} WHERE ${key}=?`).get(id)})),snapshot);
  assert.deepEqual(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map(row=>({...row})),MIGRATIONS.map(({version,name})=>({version,name})));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const retained=db.prepare('SELECT dataset_file_id,dataset_id,sha256,byte_size FROM retained_dataset_files WHERE dataset_file_id=?').get('source');
  assert.deepEqual({...retained},{dataset_file_id:'source',dataset_id:'dataset',sha256:digest,byte_size:Buffer.byteLength(csv)});
  const gcp=db.prepare('SELECT source_file_id,sha256,source_content,byte_size FROM retained_gcp_sources WHERE dataset_id=?').get('dataset');
  assert.deepEqual({...gcp},{source_file_id:'source',sha256:digest,source_content:csv,byte_size:Buffer.byteLength(csv)});
});
