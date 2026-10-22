import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {STAGING_ACCOUNT_ID} from "./staging-requirements.mjs";
const REFERENCE=new URL("../docs/staging/windows-canonical-baseline-local-2026-10-22.json",import.meta.url);
const REFERENCE_SHA256="bca8f55f2c34701f1fdd3d244f40f23382fd836f18f17983fe2f0470b20cef18";
const hex=/^[a-f0-9]{64}$/;
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=code=>{throw Object.assign(new Error(code),{code})};
export function verifyPinnedWindowsSchemaReferenceBytes(value){
 const raw=value.replace(/\r\n/g,"\n");
 if(createHash("sha256").update(raw).digest("hex")!==REFERENCE_SHA256)fail("canonical_reference_pin_mismatch");
 return {reference:JSON.parse(raw),referenceSha256:REFERENCE_SHA256};
}
export async function readPinnedWindowsSchemaReference(){return verifyPinnedWindowsSchemaReferenceBytes(await readFile(REFERENCE,"utf8"));}
/** Pure comparison of supplied observations, NOT a remote query/attestation.
 * This intentionally never upgrades canonicalBaselineVerified: name-only
 * ledgers/schema cannot attest migration data effects or an atomic live state. */
export async function compareWindowsObservedSchemaAndLedger(observation){
 const {reference,referenceSha256}=await readPinnedWindowsSchemaReference();
 if(!observation||observation.schemaVersion!==1||observation.status!=="read_only_observed"
   ||observation.accountId!==STAGING_ACCOUNT_ID||observation.activated!==false||observation.migrationsApplied!==false
   ||!Array.isArray(observation.workers)||observation.workers.length!==2
   ||observation.workers.some(w=>!w||!["operations","delivery"].includes(w.app))
   ||new Set(observation.workers.map(w=>w.app)).size!==2)fail("canonical_observation_invalid");
 const workers=[];
 for(const app of ["operations","delivery"]){
  const w=observation.workers.find(w=>w.app===app),names=w?.migrations?.names;
  if(!w||!Array.isArray(names)||names.length<1||names.length>1024||names.some(n=>typeof n!=="string"||!/^\d{4}_[a-z0-9_]+\.sql$/.test(n))
   ||new Set(names).size!==names.length||w.migrations.count!==names.length||!hex.test(w.migrations.sha256??"")
   ||!hex.test(w.schemaSha256??"")||!Number.isSafeInteger(w.schemaObjectCount)||w.schemaObjectCount<1||w.schemaObjectCount>4096
   ||!Number.isSafeInteger(w.foreignKeyViolationCount)||w.foreignKeyViolationCount<0)fail("canonical_observation_invalid");
  if(hash(names)!==w.migrations.sha256)fail("canonical_observation_ledger_digest_invalid");
  const expected=reference.apps[app],checkpoint=expected.checkpoints.find(c=>c.ledgerSha256===w.migrations.sha256&&JSON.stringify(c.names)===JSON.stringify(names));
  const ledgerMatches=Boolean(checkpoint),schemaMatches=Boolean(checkpoint&&checkpoint.schemaSha256===w.schemaSha256&&checkpoint.schemaObjectCount===w.schemaObjectCount);
  const foreignKeysClean=w.foreignKeyViolationCount===0;
  workers.push({app,status:!ledgerMatches?"ledger_not_canonical_checkpoint":!schemaMatches?"schema_mismatch":!foreignKeysClean?"foreign_key_violations":"matches_pinned_local_replay",
   ledgerMatches,schemaMatches,foreignKeysClean,through:checkpoint?.through??null,sourceInventorySha256:expected.sourceInventorySha256,
   observedSchemaSha256:w.schemaSha256,expectedSchemaSha256:checkpoint?.schemaSha256??null,
   observedSchemaObjectCount:w.schemaObjectCount,expectedSchemaObjectCount:checkpoint?.schemaObjectCount??null});
 }
 return {schemaVersion:1,canonicalBaselineVerified:false,observedSchemaAndLedgerComparison:{
  scope:"Provided ordered migration names and full sqlite_master SQL shape against pinned local replay; no row/data-effects proof",
  status:workers.every(w=>w.status==="matches_pinned_local_replay")?"matches_pinned_local_replay":"requires_review",referenceSha256,workers,
  caveats:["Supplied observations are not signed remote attestation or freshness proof.","Schema pages, ledger, foreign-key result and Worker metadata are non-atomic observations.",
    "Exact SQL text is compared, including ledger/platform metadata; no metadata exceptions or SQL normalization.","SQLite engine/version or migration lineage differences can cause mismatches; never normalize them into approval.",
    "Matching schema and name-only ledger cannot prove historical source execution, seed/data effects, authority correctness or deployment readiness."]}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==4||process.argv[2]!=="--receipt")fail("canonical_comparison_arguments");
  const raw=await readFile(resolve(process.argv[3]),"utf8");if(Buffer.byteLength(raw)>2*1024*1024)fail("canonical_observation_invalid");
  process.stdout.write(JSON.stringify(await compareWindowsObservedSchemaAndLedger(JSON.parse(raw)),null,2)+"\n");
 }catch(error){const allowed=new Set(["canonical_reference_pin_mismatch","canonical_observation_invalid","canonical_observation_ledger_digest_invalid","canonical_comparison_arguments"]);
  process.stderr.write((allowed.has(error?.code)?error.code:"canonical_comparison_failed")+"\n");process.exitCode=1;}
}
