import {schemaObjectDigests} from "./windows-files-schema-object-digests.mjs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {readFile,readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {WINDOWS_SCHEMA_QUERY} from "./windows-files-schema-query.mjs";
import {assertCanonicalFileRunner} from "./windows-files-canonical-runner.mjs";
import {selectDiagnosticDefinitions} from "./windows-files-schema-definition-diagnostic.mjs";
import {reviewedOperationsMigrationNames,reviewedClientMigrationNames} from "../apps/operations/test/helpers/reviewed-operations-migration-chain.ts";

const root=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(new URL("../apps/client/package.json",import.meta.url));
const sha=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
export const canonicalSchemaQuery=WINDOWS_SCHEMA_QUERY;
// Exact reviewed pinned Wrangler getCreateMigrationsTableQuery output. Do not
// replace it with the older test-helper ledger (different SQL/type/constraints).
export const wranglerLedgerDDL='CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);';
const profiles={operations:{directory:"operations",baseline:"0221_portal_correspondence_lifecycle_write_guards.sql",final:"0224_windows_portal_publication_chain_index.sql",count:221},
  delivery:{directory:"client",baseline:"0234_pa_principal_reenrollment.sql",final:"0236_windows_portal_successor_content_start_audit.sql",count:153}};
export async function generateWindowsCanonicalBaseline({baselineOnly=false,includeSchemaObjectDigests=false,selectedDefinitionObserver}={}){
  assertCanonicalFileRunner();
  if(typeof baselineOnly!=="boolean"||typeof includeSchemaObjectDigests!=="boolean")throw Error("canonical_replay_options_invalid");
  if(selectedDefinitionObserver!==undefined&&(!baselineOnly||typeof selectedDefinitionObserver!=="function"))throw Error("canonical_definition_observer_requires_baseline_only");
  const {Miniflare}=require("miniflare"),{unstable_splitSqlQuery}=require("wrangler");
  // Existing independent immutable source contracts validate full current source
  // and successors before any local SQL executes. They do not alter old pins.
  reviewedOperationsMigrationNames(new URL("../apps/operations/migrations/",import.meta.url));
  reviewedClientMigrationNames(new URL("../apps/client/migrations/",import.meta.url));
  const result={schemaVersion:1,scope:"local-canonical-schema-and-ledger-replay",canonicalBaselineVerified:false,
    runtime:{node:process.versions.node,miniflare:require("miniflare/package.json").version,wrangler:require("wrangler/package.json").version,lockSha256:sha(await readFile(resolve(root,"apps/client/package-lock.json"),"utf8")),compatibilityDate:"2026-08-06",workerd:require("workerd/package.json").version},
    ledgerDDLSha256:sha(wranglerLedgerDDL),schemaQuerySha256:sha(canonicalSchemaQuery),apps:{}};
  for(const [app,p]of Object.entries(profiles)){
    const directory=resolve(root,"apps",p.directory,"migrations"),names=(await readdir(directory)).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n<=(baselineOnly?p.baseline:p.final)).sort();
    const sources=await Promise.all(names.map(async name=>({name,source:(await readFile(resolve(directory,name),"utf8")).replace(/\r\n/g,"\n")})));
    if(names.indexOf(p.baseline)!==p.count-1)throw Error("canonical_baseline_inventory_count");
    const mf=new Miniflare({modules:true,compatibilityDate:result.runtime.compatibilityDate,script:"export default {}",d1Databases:["DB"],outboundService:()=>{throw Error("canonical_replay_network_denied");}});
    try{
      const db=await mf.getD1Database("DB");await db.prepare(wranglerLedgerDDL).run();
      const checkpoints=[];
      for(const {name,source}of sources){
        const statements=unstable_splitSqlQuery(source).map(s=>s.trim()).filter(s=>s&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(s));
        await db.batch([...statements.map(s=>db.prepare(s)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
        if(name>=p.baseline){
          const ledger=(await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results.map(r=>r.name);
          const schema=(await db.prepare(canonicalSchemaQuery).all()).results;
          checkpoints.push({through:name,names:ledger,ledgerSha256:sha(ledger),schemaSha256:sha(schema.map(r=>[r.type,r.name,r.tbl_name,r.sql])),schemaObjectCount:schema.length,
            foreignKeyViolationCount:(await db.prepare("PRAGMA foreign_key_check").all()).results.length,
            ...(includeSchemaObjectDigests?{schemaObjectDigests:schemaObjectDigests(schema)}:{})});
          if(selectedDefinitionObserver){
            const observation=Object.freeze({app,through:name,schemaSha256:checkpoints.at(-1).schemaSha256,rows:selectDiagnosticDefinitions(app,schema)});
            try{await selectedDefinitionObserver(observation);}catch{throw Error("canonical_definition_observer_failed");}
          }
        }
      }
      result.apps[app]={baseline:p.baseline,sourceInventorySha256:sha(sources.map(({name,source})=>[name,sha(source)])),sourceCount:sources.length,
        sqliteVersion:"Not exposed: local D1 authorizer rejects sqlite_version()",checkpoints};
    }finally{await mf.dispose()}
  }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(!args.includes("--local-replay")||new Set(args).size!==args.length||args.some(a=>!["--local-replay","--baseline-only","--schema-object-digests"].includes(a)))throw Error("canonical_replay_requires_explicit_local_flag");
 process.stdout.write(JSON.stringify(await generateWindowsCanonicalBaseline({baselineOnly:args.includes("--baseline-only"),includeSchemaObjectDigests:args.includes("--schema-object-digests")}),null,2)+"\n");
}
