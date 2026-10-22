import {createHash} from "node:crypto";
const fail=code=>{throw Object.assign(new Error(code),{code})};
const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
/** Schema identities and exact SQL fingerprints only; never exports SQL or rows. */
export function schemaObjectDigests(schema){
 if(!Array.isArray(schema)||schema.length>4096)fail("schema_object_digests_invalid");
 const identities=new Set();
 const objects=schema.map(r=>{
  if(!r||Object.keys(r).sort().join()!=="name,sql,tbl_name,type"||!["table","index","view","trigger"].includes(r.type)
   ||typeof r.name!=="string"||!r.name||typeof r.tbl_name!=="string"||!r.tbl_name||r.sql!==null&&typeof r.sql!=="string")fail("schema_object_digests_invalid");
  const id=JSON.stringify([r.type,r.name,r.tbl_name]);if(identities.has(id))fail("schema_object_digests_invalid");identities.add(id);
  return {type:r.type,name:r.name,tbl_name:r.tbl_name,sqlSha256:r.sql===null?null:hash(r.sql)};
 });
 if(Buffer.byteLength(JSON.stringify(objects))>2*1024*1024)fail("schema_object_digests_limit");
 return {schemaVersion:1,scope:"Exact sqlite_master object identity and SQL UTF-8 hash; null SQL stays null",count:objects.length,sha256:hash(objects),objects};
}
function validated(value){
 if(!value||value.schemaVersion!==1||!Array.isArray(value.objects)||value.count!==value.objects.length||value.objects.length>4096||value.sha256!==hash(value.objects))fail("schema_object_digests_invalid");
 const map=new Map();for(const r of value.objects){
  if(!r||Object.keys(r).sort().join()!=="name,sqlSha256,tbl_name,type"||!["table","index","view","trigger"].includes(r.type)
    ||typeof r.name!=="string"||!r.name||typeof r.tbl_name!=="string"||!r.tbl_name||r.sqlSha256!==null&&(typeof r.sqlSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sqlSha256)))fail("schema_object_digests_invalid");
  const id=JSON.stringify([r.type,r.name,r.tbl_name]);if(map.has(id))fail("schema_object_digests_invalid");map.set(id,r);
 }return map;
}
/** Attribution aid only. Never upgrades canonical/deployment/authority proof. */
export function compareSchemaObjectDigests(expected,observed){
 const left=validated(expected),right=validated(observed),missing=[],extra=[],changed=[];
 for(const[id,row]of left){const other=right.get(id);if(!other)missing.push(row);else if(row.sqlSha256!==other.sqlSha256)changed.push({type:row.type,name:row.name,tbl_name:row.tbl_name,expectedSqlSha256:row.sqlSha256,observedSqlSha256:other.sqlSha256});}
 for(const[id,row]of right)if(!left.has(id))extra.push(row);
 return {schemaVersion:1,scope:"Per-object SQL shape difference only; observations may be non-atomic",canonicalBaselineVerified:false,missing,extra,changed};
}
