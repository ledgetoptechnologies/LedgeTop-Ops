'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {openDatabase} = require('../server/database');
const {ProcessingRepository} = require('../server/processingRepository');
const {GcpRepository} = require('../server/gcpRepository');
const {parseRawGcpSource} = require('../server/gcpRawSource');
const {prepareGcpRawJournal} = require('../server/gcpRawJournal');
const {derivedSetMatches} = require('../server/gcpRawDerivedVerifier');

test('derived comparison requires complete unmodified points and provenance', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-derived-'));
  const db=openDatabase(path.join(root,'db.sqlite'));
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const repo=new ProcessingRepository(db), project=repo.createProject({displayName:'Synthetic'});
  const dataset=repo.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:'flight'});
  repo.finalizeDataset(dataset.id,[],'a'.repeat(64));
  const encoded=Buffer.from('point_id,label,latitude,longitude,elevation_m\nA,A,1,2,3\n').toString('base64');
  const raw=parseRawGcpSource({encoded,format:'generic-csv-v1'});
  const entry=prepareGcpRawJournal(db,{datasetId:dataset.id,encoded,format:'generic-csv-v1',confirmation:raw.confirmationToken,displayName:'Control',fileName:'survey.csv',actorId:'synthetic',requestKey:'synthetic-1'},{capacityPolicy:{maxJournalBytes:1000000,maxJournalEntries:100}});
  const row=db.prepare('SELECT * FROM viewer_gcp_raw_sources WHERE id=?').get(entry.id);
  const gcp=new GcpRepository(db), ordinary=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceFilename:'survey.csv',sourceSha256:raw.sha256,sourceContent:raw.content,crs:raw.parsed.crs,elevationUnits:raw.parsed.elevationUnits,provenance:raw.parsed.provenance,points:raw.parsed.points,createdBy:'synthetic'});
  assert.notEqual(ordinary.id,entry.id);
  assert.equal(derivedSetMatches(db,row,raw),false); // normal import cannot recover this journal
  const stamp='2026-01-01T00:00:00Z';
  // Synthetic matching set exercises the diagnostic only. No implemented
  // recovery path currently creates this identity or makes it visible safely.
  db.prepare(`INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_filename,source_sha256,source_content,source_byte_size,crs,elevation_units,created_by,created_at,updated_at) VALUES(?,?,?,'generic-csv-v1',?,?,?,?,'EPSG:4326','m',?,?,?)`).run(entry.id,dataset.id,'Control','survey.csv',raw.sha256,raw.content,raw.byteSize,'synthetic',stamp,stamp);
  db.prepare(`INSERT INTO gcp_import_provenance(set_id,adapter,coordinate_system,vertical_datum,linear_unit,source_sha256,confirmed_by,confirmed_at) VALUES(?,'generic-csv-v1','EPSG:4326','declared by source','m',?,'synthetic',?)`).run(entry.id,raw.sha256,stamp);
  const pointId=`gcp_${crypto.createHash('sha256').update(`${entry.id}\0A`).digest('hex').slice(0,32)}`;
  db.prepare('INSERT INTO gcp_points(id,set_id,external_id,label,latitude,longitude,elevation_m,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(pointId,entry.id,'A','A',1,2,3,stamp,stamp);
  assert.equal(derivedSetMatches(db,row,raw),true);
  db.prepare('UPDATE gcp_points SET elevation_m=4 WHERE id=?').run(pointId);
  assert.equal(derivedSetMatches(db,row,raw),false);
  db.prepare('UPDATE gcp_points SET elevation_m=3 WHERE id=?').run(pointId);
  db.prepare("UPDATE gcp_import_provenance SET vertical_datum='altered' WHERE set_id=?").run(entry.id);
  assert.equal(derivedSetMatches(db,row,raw),false);
  db.prepare("UPDATE gcp_import_provenance SET vertical_datum='declared by source' WHERE set_id=?").run(entry.id);
  db.prepare("INSERT INTO gcp_odm_crs_confirmations(set_id,source_sha256,epsg_code,horizontal_unit,vertical_datum,validation_sha256,confirmed_by,confirmed_at) VALUES(?,?,4326,'m','test',?,'synthetic',?)").run(entry.id,raw.sha256,'b'.repeat(64),stamp);
  assert.equal(derivedSetMatches(db,row,raw),false);
  db.prepare('DELETE FROM gcp_odm_crs_confirmations WHERE set_id=?').run(entry.id);
  db.prepare('DELETE FROM gcp_points WHERE id=?').run(pointId);
  assert.equal(derivedSetMatches(db,row,raw),false);
  assert.equal(db.prepare('SELECT status FROM viewer_gcp_raw_sources WHERE id=?').get(entry.id).status,'pending');
});
