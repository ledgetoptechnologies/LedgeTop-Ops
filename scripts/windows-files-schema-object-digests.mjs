import {createHash} from "node:crypto";
const fail=code=>{throw Object.assign(new Error(code),{code})};
const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
const SCOPE="Exact sqlite_master object identity and SQL UTF-8 hash; null SQL stays null";
const MAX_OBJECTS=4096,MAX_BYTES=2*1024*1024;
// JSON records and explicit null-prototype data records are supported. Reject
// custom prototypes, symbols, hidden fields and accessors before reading values.
function dataRecord(value,names){
 if(!value||typeof value!=="object"||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(k=>typeof k!=="string"||!names.includes(k)))return false;
 const descriptors=Object.getOwnPropertyDescriptors(value);
 return keys.every(k=>descriptors[k].enumerable&&Object.hasOwn(descriptors[k],"value"));
}
function dataArray(value){
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>MAX_OBJECTS)return false;
 const keys=Reflect.ownKeys(value);if(keys.length!==value.length+1)return false;
 for(let i=0;i<value.length;i++){
  const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,"value"))return false;
 }return true;
}
const identifier=value=>typeof value==="string"&&value.length>0&&Buffer.byteLength(value)<=4096;
function boundedManifest(value){if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)fail("schema_object_digests_limit");}
/** Schema identities and exact SQL fingerprints only; never exports SQL or rows. */
export function schemaObjectDigests(schema){
 if(!dataArray(schema))fail("schema_object_digests_invalid");
 const identities=new Set();
 const objects=schema.map(r=>{
  if(!dataRecord(r,["type","name","tbl_name","sql"])||!["table","index","view","trigger"].includes(r.type)
   ||!identifier(r.name)||!identifier(r.tbl_name)||r.sql!==null&&typeof r.sql!=="string")fail("schema_object_digests_invalid");
  const id=JSON.stringify([r.type,r.name,r.tbl_name]);if(identities.has(id))fail("schema_object_digests_invalid");identities.add(id);
  return {type:r.type,name:r.name,tbl_name:r.tbl_name,sqlSha256:r.sql===null?null:"0".repeat(64)};
 });
 const manifest={schemaVersion:1,scope:SCOPE,count:objects.length,sha256:"0".repeat(64),objects};
 boundedManifest(manifest); // Bound complete output before SQL/inventory hashing.
 for(let i=0;i<objects.length;i++)if(schema[i].sql!==null)objects[i].sqlSha256=hash(schema[i].sql);
 manifest.sha256=hash(objects);
 return manifest;
}
function validated(value){
 if(!dataRecord(value,["schemaVersion","scope","count","sha256","objects"])||value.schemaVersion!==1||value.scope!==SCOPE
   ||!dataArray(value.objects)||value.count!==value.objects.length||typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256))fail("schema_object_digests_invalid");
 const map=new Map();for(const r of value.objects){
  if(!dataRecord(r,["type","name","tbl_name","sqlSha256"])||!["table","index","view","trigger"].includes(r.type)
    ||!identifier(r.name)||!identifier(r.tbl_name)||r.sqlSha256!==null&&(typeof r.sqlSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sqlSha256)))fail("schema_object_digests_invalid");
  const id=JSON.stringify([r.type,r.name,r.tbl_name]);if(map.has(id))fail("schema_object_digests_invalid");map.set(id,r);
 }
 boundedManifest(value); // Reject oversized input before any digest calculation.
 if(value.sha256!==hash(value.objects))fail("schema_object_digests_invalid");
 return map;
}
/** Attribution aid only. Never upgrades canonical/deployment/authority proof. */
export function compareSchemaObjectDigests(expected,observed){
 const left=validated(expected),right=validated(observed),missing=[],extra=[],changed=[];
 for(const[id,row]of left){const other=right.get(id);if(!other)missing.push(row);else if(row.sqlSha256!==other.sqlSha256)changed.push({type:row.type,name:row.name,tbl_name:row.tbl_name,expectedSqlSha256:row.sqlSha256,observedSqlSha256:other.sqlSha256});}
 for(const[id,row]of right)if(!left.has(id))extra.push(row);
 return {schemaVersion:1,scope:"Per-object SQL shape difference only; observations may be non-atomic",canonicalBaselineVerified:false,
  inventoryDigestEqual:expected.sha256===observed.sha256,missing,extra,changed};
}
