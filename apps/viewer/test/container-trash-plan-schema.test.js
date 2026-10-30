'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');

test('container plan identities and reserved children survive restart and reject replacement',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-container-plan-')),dbPath=path.join(root,'fixture.sqlite');
 let db=openDatabase(dbPath);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 let p=new ProcessingRepository(db);const project=p.createProject({displayName:'Synthetic'}),trash=p.trashProject(project.id,'fixture');
 db.prepare("INSERT INTO container_trash_plans(container_trash_id,status,created_at) VALUES(?,'planned',?)").run(trash.id,'2026-01-01T00:00:00.000Z');
 db.prepare("INSERT INTO container_trash_plan_claims(entity_type,entity_id,container_trash_id) VALUES('dataset',?,?)").run('synthetic-dataset',trash.id);
 const add=db.prepare("INSERT INTO container_trash_plan_members(container_trash_id,entity_type,entity_id,reserved_trash_id,ownership_basis,owner_id) VALUES(?,'dataset',?,?,'project','owner')");
 add.run(trash.id,'synthetic-dataset','reserved-child');
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO container_trash_plan_members(container_trash_id,entity_type,entity_id,reserved_trash_id,ownership_basis,owner_id) VALUES(?,'dataset',?,?,'project','owner')").run(trash.id,'synthetic-dataset','replacement'),/replacement/);
 assert.throws(()=>db.prepare("UPDATE container_trash_plans SET status='complete',completed_at=? WHERE container_trash_id=?").run('2026-01-01T00:00:01.000Z',trash.id),/cannot complete/);
 assert.throws(()=>db.prepare('UPDATE container_trash_plan_members SET entity_id=? WHERE container_trash_id=?').run('other',trash.id),/immutable/);
 assert.throws(()=>db.prepare('DELETE FROM container_trash_plan_members WHERE container_trash_id=?').run(trash.id),/retained/);
 assert.throws(()=>db.prepare('DELETE FROM container_trash_plan_claims WHERE container_trash_id=?').run(trash.id),/retained/);
 const other=p.createProject({displayName:'Other synthetic'}),otherTrash=p.trashProject(other.id,'fixture');
 db.prepare("INSERT INTO container_trash_plans(container_trash_id,status,created_at) VALUES(?,'planned',?)").run(otherTrash.id,'2026-01-01T00:00:00.000Z');
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO container_trash_plan_claims(entity_type,entity_id,container_trash_id) VALUES('dataset',?,?)").run('synthetic-dataset',otherTrash.id),/already claimed/);
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO container_trash_plans(container_trash_id,status,created_at) VALUES(?,'planned',?)").run(trash.id,'2026-01-01T00:00:00.000Z'),/replacement/);
 db.close();db=openDatabase(dbPath);p=new ProcessingRepository(db);
 assert.equal(db.prepare('SELECT reserved_trash_id FROM container_trash_plan_members WHERE container_trash_id=?').get(trash.id).reserved_trash_id,'reserved-child');
 assert.equal(p.getTrash(trash.id).entityId,project.id);
});
