import {createHash} from "node:crypto";
import {mkdtemp,writeFile,lstat,realpath,unlink,rmdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DIAGNOSTIC_IDENTITIES,DIAGNOSTIC_REPORT_SHA256} from "./windows-files-schema-diagnostic-allowlist.mjs";
const fail=code=>{throw Object.assign(new Error(code),{code})};
const sha=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const queries=Object.freeze(Object.fromEntries(Object.entries(DIAGNOSTIC_IDENTITIES).map(([app,rows])=>{
  if(rows.some(r=>r.length!==3||r.some(v=>typeof v!=="string"||! /^[A-Za-z0-9_]+$/.test(v))))fail("definition_allowlist_invalid");
  const predicates=rows.map(([type,name,table])=>`(type='${type}' AND name='${name}' AND tbl_name='${table}')`);
  return [app,`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE ${predicates.join(" OR ")} ORDER BY type,name,tbl_name LIMIT ${rows.length+1}`];
})));
/** No identifier or SQL parameter accepted; only the two reviewed app keys. */
export function diagnosticSchemaQuery(app){if(!Object.hasOwn(queries,app))fail("definition_app_invalid");return queries[app];}
export function selectDiagnosticDefinitions(app,schema,{selectedOnly=false}={}){
  if(!Object.hasOwn(DIAGNOSTIC_IDENTITIES,app)||!Array.isArray(schema)||schema.length>4096)fail("definition_response_invalid");
  const allowed=new Set(DIAGNOSTIC_IDENTITIES[app].map(r=>JSON.stringify(r))),seen=new Set(),selected=[];
  for(const row of schema){
    if(!row||Object.keys(row).sort().join()!=="name,sql,tbl_name,type"||[row.type,row.name,row.tbl_name].some(v=>typeof v!=="string")||row.sql!==null&&typeof row.sql!=="string")fail("definition_response_invalid");
    const identity=JSON.stringify([row.type,row.name,row.tbl_name]);
    if(!allowed.has(identity)){if(selectedOnly)fail("definition_response_invalid");continue;}
    if(seen.has(identity))fail("definition_response_invalid");seen.add(identity);
    if(row.sql!==null&&Buffer.byteLength(row.sql)>128*1024)fail("definition_response_limit");
    selected.push(Object.freeze({type:row.type,name:row.name,tbl_name:row.tbl_name,sql:row.sql}));
  }
  selected.sort((a,b)=>JSON.stringify([a.type,a.name,a.tbl_name]).localeCompare(JSON.stringify([b.type,b.name,b.tbl_name])));
  if(Buffer.byteLength(JSON.stringify(selected))>1024*1024)fail("definition_response_limit");
  return Object.freeze(selected);
}
export function diagnosticDefinitionSummary(app,rows){
  const checked=selectDiagnosticDefinitions(app,rows,{selectedOnly:true});
  return {app,allowlistReportSha256:DIAGNOSTIC_REPORT_SHA256,selectedIdentities:DIAGNOSTIC_IDENTITIES[app].length,
    observedCount:checked.length,sha256:sha(checked),objects:checked.map(r=>({type:r.type,name:r.name,tbl_name:r.tbl_name,
      sqlSha256:r.sql===null?null:createHash("sha256").update(r.sql).digest("hex")})),
    absent:DIAGNOSTIC_IDENTITIES[app].filter(id=>!checked.some(r=>JSON.stringify(id)===JSON.stringify([r.type,r.name,r.tbl_name])))};
}
async function checkedDirectory(directory){
  const absolute=path.resolve(directory);
  if(!path.isAbsolute(directory)||absolute.startsWith("\\\\")||process.platform==="win32"&&!/^[A-Za-z]:\\/.test(absolute))fail("definition_review_path_invalid");
  // Check the supplied path before resolving it, so resolution cannot hide a
  // reparse/junction ancestor. The actual reviewed PC's temp root is on C:.
  for(let part=absolute;;part=path.dirname(part)){
    if((await lstat(part)).isSymbolicLink())fail("definition_review_path_invalid");
    if(path.dirname(part)===part)break;
  }
  const resolved=await realpath(absolute);
  if(resolved!==absolute)fail("definition_review_path_invalid");
  return resolved;
}
/** Raw DDL is written only to this newly owned local review file, never returned. */
export async function retainDefinitionReviewFile(captures){
  const safe=captures.map(({app,rows,...metadata})=>({app,rows:selectDiagnosticDefinitions(app,rows,{selectedOnly:true}),...metadata}));
  const content=JSON.stringify({schemaVersion:1,scope:"Private local selected DDL review only; no readiness or semantic-equivalence proof",captures:safe},null,2);
  if(Buffer.byteLength(content)>3*1024*1024)fail("definition_response_limit");
  const root=await checkedDirectory(tmpdir()),directory=await mkdtemp(path.join(root,"ops-windows-ddl-review-"));
  const file=path.join(directory,"selected-definitions.json");let success=false;
  try{
    if(await checkedDirectory(directory)!==directory||path.dirname(directory)!==root)fail("definition_review_path_invalid");
    await writeFile(file,content,{encoding:"utf8",flag:"wx",mode:0o600});success=true;
    return {reviewFile:file,reviewFileSha256:createHash("sha256").update(content).digest("hex"),rawSqlInPublicReceipt:false};
  }catch{fail("definition_review_write_failed");}
  finally{if(!success){await unlink(file).catch(()=>{});await rmdir(directory).catch(()=>{});}}
}
