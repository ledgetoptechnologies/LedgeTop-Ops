'use strict';
// Unwired source-stage projection. Every writing connection must install the
// same function before touching dataset_operations; old connections fail
// closed. Completion is NOT authorization or proof of an old-writer drain.
const {catalogIdentity}=require('./referenceCatalogIdentity');
const TEST_SCHEMA=`
CREATE TABLE reference_catalog_projection(operation_id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK(status IN ('resolved','unresolved')), payload_attempt_id TEXT, column_attempt_id TEXT);
CREATE INDEX reference_catalog_payload_attempt_idx ON reference_catalog_projection(payload_attempt_id);
CREATE INDEX reference_catalog_column_attempt_idx ON reference_catalog_projection(column_attempt_id);
CREATE INDEX reference_catalog_unresolved_idx ON reference_catalog_projection(status);
CREATE TABLE reference_catalog_projection_state(id INTEGER PRIMARY KEY CHECK(id=1), high_water TEXT, cursor TEXT, scan_complete INTEGER NOT NULL DEFAULT 0 CHECK(scan_complete IN (0,1)), authority_ready INTEGER NOT NULL DEFAULT 0 CHECK(authority_ready=0));
INSERT INTO reference_catalog_projection_state(id) VALUES(1);
CREATE TRIGGER reference_catalog_projection_insert AFTER INSERT ON dataset_operations BEGIN
 DELETE FROM reference_catalog_projection WHERE operation_id=NEW.id;
 INSERT INTO reference_catalog_projection SELECT NEW.id,json_extract(v,'$.status'),json_extract(v,'$.payloadAttemptId'),json_extract(v,'$.columnAttemptId') FROM (SELECT ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id) v) WHERE NEW.operation_type='catalog_map';
END;
CREATE TRIGGER reference_catalog_projection_update AFTER UPDATE OF id,operation_type,payload_json,processing_attempt_id ON dataset_operations BEGIN
 DELETE FROM reference_catalog_projection WHERE operation_id=OLD.id;
 DELETE FROM reference_catalog_projection WHERE operation_id=NEW.id;
 INSERT INTO reference_catalog_projection SELECT NEW.id,json_extract(v,'$.status'),json_extract(v,'$.payloadAttemptId'),json_extract(v,'$.columnAttemptId') FROM (SELECT ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id) v) WHERE NEW.operation_type='catalog_map';
END;
CREATE TRIGGER reference_catalog_projection_delete AFTER DELETE ON dataset_operations BEGIN DELETE FROM reference_catalog_projection WHERE operation_id=OLD.id; END;`;
function installFunction(db){db.function('ltds_catalog_identity',(payloadJson,processingAttemptId)=>JSON.stringify(catalogIdentity({payloadJson,processingAttemptId})));}
class ReferenceCatalogProjection{
 constructor(db){this.db=db;}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 begin(){return this.tx(()=>{const s=this.db.prepare('SELECT * FROM reference_catalog_projection_state WHERE id=1').get();if(s.high_water!==null||s.scan_complete)return s;const h=this.db.prepare("SELECT MAX(id) AS value FROM dataset_operations WHERE operation_type='catalog_map'").get().value;if(h===null)this.db.prepare('UPDATE reference_catalog_projection_state SET scan_complete=1 WHERE id=1').run();else this.db.prepare('UPDATE reference_catalog_projection_state SET high_water=? WHERE id=1').run(h);return this.state();});}
 state(){return this.db.prepare('SELECT * FROM reference_catalog_projection_state WHERE id=1').get();}
 backfill({limit=32}={}){if(!Number.isInteger(limit)||limit<1||limit>64)throw Error('invalid batch size');return this.tx(()=>{const s=this.state();if(s.scan_complete||s.high_water===null)return s;const next=this.db.prepare("SELECT id,length(CAST(payload_json AS BLOB)) AS byte_size,processing_attempt_id FROM dataset_operations WHERE operation_type='catalog_map' AND id>? AND id<=? ORDER BY id LIMIT 1"),read=this.db.prepare('SELECT payload_json FROM dataset_operations WHERE id=?'),put=this.db.prepare('INSERT INTO reference_catalog_projection(operation_id,status,payload_attempt_id,column_attempt_id) VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,payload_attempt_id=excluded.payload_attempt_id,column_attempt_id=excluded.column_attempt_id');let cursor=s.cursor||'',bytes=0,processed=0,done=false;while(processed<limit){const r=next.get(cursor,s.high_water);if(!r){done=true;break;}const n=r.byte_size;if(processed&&n<=4194304&&bytes+n>4194304)break;const payloadJson=n>4194304?null:read.get(r.id).payload_json,parsed=catalogIdentity({payloadJson,processingAttemptId:r.processing_attempt_id});put.run(r.id,parsed.status,parsed.payloadAttemptId??null,parsed.columnAttemptId??null);cursor=r.id;processed++;if(n<=4194304)bytes+=n;}this.db.prepare('UPDATE reference_catalog_projection_state SET cursor=?,scan_complete=? WHERE id=1').run(cursor,done?1:0);return this.state();});}
}
module.exports={TEST_SCHEMA,installFunction,ReferenceCatalogProjection};
