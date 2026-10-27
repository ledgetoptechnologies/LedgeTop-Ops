import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createHash, createPublicKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readNativeStaffCutoverSnapshot } from "../../../scripts/native-staff-cutover-v1.mjs";

const pins=vi.hoisted(()=>({cutoverManifest:"",cutoverConfig:"",bootstrapManifest:""}));
vi.mock("../../../scripts/native-staff-cutover-distribution-pin-value.mjs",()=>({
  PINNED_NATIVE_STAFF_CUTOVER_DISTRIBUTION_SHA256:pins.cutoverManifest,
}));
vi.mock("../../../scripts/native-staff-cutover-approved-executor-config-pin-value.mjs",()=>({
  PINNED_NATIVE_STAFF_CUTOVER_CONFIG_SHA256:pins.cutoverConfig,
}));
vi.mock("../../../scripts/native-staff-bootstrap-owner-approval-distribution-pin-value.mjs",()=>({
  PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256:pins.bootstrapManifest,
}));

const root=fileURLToPath(new URL("../../../",import.meta.url));
const sha=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const canonical=(value:any):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`
  :value===null||typeof value!=="object"?JSON.stringify(value)
  :`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const response=(body:any,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json",...headers},
});
const uuid=()=>crypto.randomUUID();
type Person={id:string;email:string;subject:string};
let runtime:Miniflare,db:D1Database,scratch:string,receiptDirectory:string,config:any,signer:any,
  executorModule:any,ownerModule:any,restoreLocalAppData:string|undefined;

function protectTestSigner(directory:string){
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:3072});
  const entropy="synthetic-native-cutover-dpapi-entropy-material";
  const request=JSON.stringify({privateKeyBase64:privateKey.export({type:"pkcs8",format:"der"}).toString("base64"),entropy});
  const result=spawnSync("pwsh.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",
    '$a=Join-Path $PSHOME "System.Security.Cryptography.ProtectedData.dll"; Add-Type -Path $a; $r=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $p=[Convert]::FromBase64String($r.privateKeyBase64); $e=[Text.Encoding]::UTF8.GetBytes($r.entropy); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($p,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'],
    {input:request,encoding:"utf8",windowsHide:true,timeout:20_000,maxBuffer:32*1024,stdio:["pipe","pipe","pipe"]});
  if(result.status!==0)throw new Error(`synthetic-protected-signer-failed:${result.status}`);
  const protectedPrivateKeyPath=path.join(directory,"cutover-integration.dpapi");
  writeFileSync(protectedPrivateKeyPath,Buffer.from(result.stdout.trim(),"base64"),{flag:"wx",mode:0o600});
  const publicKeyPem=publicKey.export({type:"spki",format:"pem"}).toString();
  return {publicKey,publicKeyPem,privateKey,entropy,protectedPrivateKeyPath,
    keyId:sha(createPublicKey(publicKeyPem).export({type:"spki",format:"der"}))};
}

function pinnedSource(){
  const commit=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  const files=["scripts/native-staff-cutover-v1.mjs","scripts/native-staff-sync-preparation.mjs","scripts/native-staff-bootstrap-d1.mjs"];
  const moduleHashes=files.map(file=>sha(readFileSync(path.join(root,file))));
  const names=readdirSync(path.join(root,"apps/operations/migrations"))
    .filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=230).sort();
  if(names.length!==230||names.some((name,index)=>!name.startsWith(`${String(index+1).padStart(4,"0")}_`)))
    throw new Error("synthetic-migration-fixture-invalid");
  const migrationContentsSha256=sha(names.map(name=>`${name}\0${sha(readFileSync(path.join(root,"apps/operations/migrations",name)))}`).join("\n"));
  return {commit,migrationNamesSha256:sha(names.join("\n")),migrationContentsSha256,
    cutoverModuleSha256:moduleHashes[0],syncPreparationModuleSha256:moduleHashes[1],installerModuleSha256:moduleHashes[2]};
}

async function seedOwner():Promise<Person>{
  const id=config.access.owner.staffId,email=`${id}@example.test`,subject=config.access.owner.accessSubject;
  await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id,email,id,subject).run();
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id,subject,id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id,email,id),
  ]);
  const caps=["staff.onboarding.create","staff.onboarding.approve","staff.admission.disable","staff.membership.manage",
    "staff.directory_grant.manage","staff.admin_delegation.manage","staff.admission.enable","staff.profile.edit","staff.profile.read"];
  await db.batch(caps.map(cap=>db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
    VALUES(?,?,?,'allow','global',?)`).bind(`${id}:${cap}`,id,cap,id)));
  const ceilings=[...["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage",
    "directory.portal_access.manage"].map(cap=>["directory",cap] as const),
    ...caps.slice(0,6).map(cap=>["staff_admin",cap] as const)];
  await db.batch(ceilings.map(([domain,cap])=>db.prepare(`INSERT INTO native_staff_delegation_ceilings
    (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
    VALUES(?,?,?,?, 'allow',1,1,1,1,'global')`).bind(`${id}:ceiling:${domain}:${cap}`,
      `${id}:${domain==="directory"?"staff.directory_grant.manage":"staff.admin_delegation.manage"}`,domain,cap)));
  return {id,email,subject};
}

function cutoverCandidate(operator:Person,reviewedSnapshot:any){
  const snapshot=JSON.parse(reviewedSnapshot.snapshotJson);
  const admissions=new Map<string,any>(snapshot.rows.native_staff_admissions.map((row:any)=>[row.staff_id,row]));
  const profiles=new Map<string,any>(snapshot.rows.native_staff_profiles.map((row:any)=>[row.staff_id,row]));
  const cohort=snapshot.rows.staff_users.flatMap((staff:any)=>{
    const admission=admissions.get(staff.id),profile=profiles.get(staff.id);
    if(staff.status!=="active"&&!admission)return [];
    if(!admission||!profile)throw new Error("cutover-integration-seed-bridge-missing");
    return [{staffId:staff.id,email:profile.login_email,accessSubject:admission.bound_access_subject,
      displayName:profile.display_name,active:admission.active===1,admissionVersion:admission.version,profileVersion:profile.version}];
  }).sort((a:any,b:any)=>a.staffId.localeCompare(b.staffId));
  const digest=(value:unknown)=>sha(canonical(value)),cohortSha256=digest(cohort),repositoryRoot=root;
  const candidateCommit=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  const settings={compatibilityDate:"2026-07-22",triggers:["0 * * * *"]};
  const bindings=[{name:"OPS_DB",type:"d1",resourceId:config.target.databaseId},
    {name:"ACCESS_GROUP",type:"text",resourceId:"synthetic-access-group-id"}];
  const workerId="b".repeat(8)+"-"+"b".repeat(4)+"-"+"b".repeat(4)+"-"+"b".repeat(4)+"-"+"b".repeat(12);
  const active={accountId:config.target.accountId,workerName:"ltds-ops-sync",environment:"production",databaseId:workerId,
    runtimeVersion:"2026-07-22",settings,bindings,moduleSha256:"a".repeat(64),sourceCommit:"1".repeat(40)};
  const candidate={...active,moduleSha256:"c".repeat(64),sourceCommit:candidateCommit};
  const settingsSha256=digest(settings),bindingsSha256=digest([...bindings].sort((a,b)=>a.name.localeCompare(b.name)));
  const pinsInput={accountId:active.accountId,workerName:active.workerName,environment:active.environment,databaseId:workerId,
    runtimeVersion:active.runtimeVersion,activeModuleSha256:active.moduleSha256,activeSourceCommit:active.sourceCommit,
    candidateModuleSha256:candidate.moduleSha256,candidateSourceCommit:candidate.sourceCommit,settingsSha256,bindingsSha256,
    staffAccessIssuer:config.access.issuer};
  const sourceEvidence=syncPrep.deriveNativeStaffSyncSourceEvidence({repositoryRoot,sourceCommit:candidateCommit,moduleSha256:candidate.moduleSha256});
  const qualificationBody={schemaVersion:1,kind:"ops-sync-candidate-behavior-qualification-v1",sourceCommit:candidateCommit,
    sourceTreeSha256:sourceEvidence.sourceTreeSha256,sourceEvidenceSha256:sourceEvidence.sourceEvidenceSha256,
    candidateModuleSha256:candidate.moduleSha256,builtModuleSha256:candidate.moduleSha256,vitestVersion:"synthetic-fixture",
    wranglerVersion:"synthetic-fixture",suiteCount:3,testCount:50,testReportSha256:"9".repeat(64),
    qualificationRunnerSha256:"a".repeat(64),testFiles:["connector-ingress.test.ts","native-staff-access.test.ts","native-staff-preparation-entrypoint.test.ts"]};
  const qualificationEvidence={...qualificationBody,qualificationSha256:sha(JSON.stringify(qualificationBody))};
  const activeEmails=cohort.filter((row:any)=>row.active).map((row:any)=>row.email).sort();
  const historical="historical-member@example.test",group=[...activeEmails,historical].sort();
  const groupEvidence={issuer:config.access.issuer,activeBindings:[],pendingIntentCount:0};
  const cohortEvidence={cohortSha256,rows:cohort};
  const syncPreparationReceipt=syncPrep.compileNativeStaffSyncPreparation({active,candidate,
    control:{tablePresent:true,enabled:0,generation:0,appliedGeneration:0,leaseId:null,leaseUntil:null,attemptGeneration:null},
    cohortBefore:cohortEvidence,cohortAfter:structuredClone(cohortEvidence),alternateBindingsBefore:groupEvidence,
    alternateBindingsAfter:structuredClone(groupEvidence),groupBefore:group,groupAfter:structuredClone(group),pins:pinsInput,
    sourceEvidence,qualificationEvidence,repositoryRoot});
  return {schemaVersion:1,kind:"operations-native-staff-cutover-candidate-v1",approvalId:uuid(),commandId:uuid(),
    reviewedSnapshot,controlPlaneStaffIds:[...reviewedSnapshot.controlPlaneStaffIds],operator:{staffId:operator.id,accessSubject:operator.subject},
    syncPreparationReceipt};
}

let syncPrep:any,fetchImpl:typeof fetch;
let miniflareBatchErrors:string[]=[];
let syntheticFetchRoutes:string[]=[];
let syntheticQueryBatches:any[]=[];
describe.skipIf(process.platform !== "win32")("purpose-bound approved native staff cutover executor",()=>{
  beforeAll(async()=>{
    scratch=mkdtempSync(path.join(os.tmpdir(),"native-staff-cutover-approved-integration-"));
    receiptDirectory=path.join(scratch,"receipts");mkdirSync(receiptDirectory);
    signer=protectTestSigner(receiptDirectory);
    const source=pinnedSource();
    config={schemaVersion:1,kind:"operations-native-staff-cutover-trust-config-v1",
      target:{accountId:"a".repeat(32),databaseId:uuid(),databaseName:"synthetic-native-cutover-db"},source,
      access:{origin:"https://ops.example.test",issuer:"https://synthetic.cloudflareaccess.com",audience:"A".repeat(32),
        owner:{staffId:"cutover-owner-e2e",accessSubject:"access|cutover-owner-e2e"},
        cloudflaredExecutablePath:"C:\\synthetic\\cloudflared.exe",cloudflaredExecutableSha256:"2".repeat(64)},
      signer:{algorithm:"RSA-PSS-SHA256",keyId:signer.keyId,publicKeyPem:signer.publicKeyPem,
        protectedPrivateKeyPath:signer.protectedPrivateKeyPath,dpapiEntropy:signer.entropy},receiptDirectory};
    restoreLocalAppData=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=scratch;
    const configDirectory=path.join(scratch,"LedgeTop","native-staff-cutover");mkdirSync(configDirectory,{recursive:true});
    const configBytes=`${JSON.stringify(config)}\n`,configPath=path.join(configDirectory,"trust-config.json");
    writeFileSync(configPath,configBytes,{flag:"wx",mode:0o600});
    pins.cutoverConfig=sha(configBytes);
    pins.cutoverManifest=sha(readFileSync(path.join(root,"scripts/native-staff-cutover-distribution-manifest.json")));
    pins.bootstrapManifest=sha(readFileSync(path.join(root,"scripts/native-staff-bootstrap-owner-approval-distribution-manifest.json")));
    ownerModule=await import("../../../scripts/native-staff-cutover-owner-approval.mjs");
    executorModule=await import("../../../scripts/native-staff-cutover-approved-executor.mjs");
    syncPrep=await import("../../../scripts/native-staff-sync-preparation.mjs");

    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const directory=path.join(root,"apps","operations","migrations");
    for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=230).sort()){
      await db.batch(splitD1MigrationStatements(readFileSync(path.join(directory,name),"utf8")).map(sql=>db.prepare(sql)));
      await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
    }
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id IN ('staff-beau-koltz','staff-kollins-stirn')").run();
  },300_000);
  afterAll(async()=>{
    await runtime?.dispose();
    if(restoreLocalAppData===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=restoreLocalAppData;
    if(scratch)rmSync(scratch,{recursive:true,force:true});
  });

  async function installFetch():Promise<{token:string;proof:any;writeBatches:string[][]}>{
    const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048}),kid="cutover-operator-kid";
    const now=Math.floor(Date.now()/1000),claims={iss:config.access.issuer,aud:config.access.audience,type:"app",
      sub:config.access.owner.accessSubject,exp:now+600,iat:now-2};
    const b64=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
    const header=`${b64({alg:"RS256",kid,typ:"JWT"})}.${b64(claims)}`;
    const token=`${header}.${signBytes("RSA-SHA256",Buffer.from(header),privateKey).toString("base64url")}`;
    const jwk={...publicKey.export({format:"jwk"}),kid,alg:"RS256",use:"sig"};
    const writeBatches:string[][]=[];
    fetchImpl=async(input:any,init?:RequestInit)=>{
      const url=new URL(String(input));
      syntheticFetchRoutes.push(`${init?.method??"GET"} ${url.pathname}`);
      if(url.pathname==="/cdn-cgi/access/certs")return response({keys:[jwk]});
      if(url.origin===config.access.origin&&url.pathname==="/api/session")return response({user:{id:config.access.owner.staffId},csrfToken:"s".repeat(48)});
      if(url.hostname==="api.cloudflare.com"&&url.pathname.endsWith(`/d1/database/${config.target.databaseId}`)
        &&init?.method==="GET")return response({success:true,result:{uuid:config.target.databaseId,name:config.target.databaseName}});
      if(url.hostname==="api.cloudflare.com"&&url.pathname.endsWith(`/d1/database/${config.target.databaseId}/query`)
        &&init?.method==="POST"){
        const body=JSON.parse(String(init.body)) as {batch:Array<{sql:string;params:Array<string|number|null>}>};
        const summary:any={statementCount:body.batch.length,bodyBytes:Buffer.byteLength(String(init.body)),
          maxSqlBytes:Math.max(...body.batch.map(item=>Buffer.byteLength(item.sql))),parameterCount:body.batch.reduce((sum,item)=>sum+item.params.length,0)};
        syntheticQueryBatches.push(summary);
        const writes=body.batch.filter(item=>/^\s*(?:INSERT\s+INTO\s+native_staff_bootstrap_approvals|UPDATE\s+native_staff_access_reconciliation\s+SET\s+enabled\s*=\s*1|INSERT\s+INTO\s+native_staff_bootstrap_receipts)\b/iu.test(item.sql));
        if(writes.length)writeBatches.push(writes.map(item=>item.sql));
        let results;
        try{results=await db.batch(body.batch.map(item=>db.prepare(item.sql).bind(...item.params)));}
        catch(error){miniflareBatchErrors.push(error instanceof Error?error.message:"unknown synthetic Miniflare batch error");throw error;}
        summary.resultCount=results.length;summary.allSuccessful=results.every(row=>row?.success===true);
        summary.resultArrays=results.filter(row=>Array.isArray(row?.results)).length;
        return response({success:true,result:results.map(row=>({success:row.success,results:row.results,meta:row.meta}))});
      }
      throw new Error(`unexpected synthetic fetch target ${url.origin}${url.pathname}`);
    };
    const proof=await ownerModule.verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl});
    return {token,proof,writeBatches};
  }

  async function makeCandidate(){
    const operator=await seedOwner(),reviewedSnapshot=await readNativeStaffCutoverSnapshot(db);
    return {candidate:cutoverCandidate(operator,reviewedSnapshot),operator};
  }

  it("issues, previews, dispatches once, and verifies the exact 0230 cutover via the fixed-target REST adapter",async()=>{
    miniflareBatchErrors=[];syntheticFetchRoutes=[];syntheticQueryBatches=[];
    const {candidate}=await makeCandidate(),{token,proof,writeBatches}=await installFetch();
    ownerModule.initializeNativeStaffCutoverApprovalRegistry(config);
    const receipt=ownerModule.buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:candidate,ownerSession:proof,
      typedConsent:ownerModule.nativeStaffCutoverConsentText(candidate,config)});
    ownerModule.writeNativeStaffCutoverReceiptFile(config,receipt);ownerModule.issueNativeStaffCutoverApproval(config,receipt);
    const bearer="synthetic-d1-api-token-not-used-outside-fetch-fixture";
    const preview=await executorModule.runNativeStaffCutoverApprovedExecutor({candidate,receipt,mode:"preview",
      getAccessToken:()=>token,getBearerToken:()=>bearer,fetchImpl});
    expect(preview.mode).toBe("preview");expect(preview.targetDatabaseId).toBe(config.target.databaseId);
    let result:any;
    try{result=await executorModule.runNativeStaffCutoverApprovedExecutor({candidate,receipt,mode:"execute",
      preparedSha256:preview.preparedSha256,getAccessToken:()=>token,getBearerToken:()=>bearer,fetchImpl});}
    catch(error){const snapshot=JSON.parse(candidate.reviewedSnapshot.snapshotJson);
      const expectedAtomicBatchMinimum=6+Math.ceil(snapshot.schema.length/20)+Object.keys(snapshot.rows).length;
      throw new Error("synthetic cutover execute failed; Miniflare batch diagnostics: "+JSON.stringify(miniflareBatchErrors)
      +"; recent routes: "+JSON.stringify(syntheticFetchRoutes.slice(-8))
      +"; recent batch summaries: "+JSON.stringify(syntheticQueryBatches.slice(-6))
      +"; atomic batch count estimate: "+JSON.stringify({schemaObjects:snapshot.schema.length,rowTables:Object.keys(snapshot.rows).length,
        minimumStatements:expectedAtomicBatchMinimum})
      +"; cause: "+(error instanceof Error?error.message:"unknown"));}
    expect(result).toMatchObject({outcome:"consumed",approvalId:candidate.approvalId,commandId:candidate.commandId});
    const final=await readNativeStaffCutoverSnapshot(db);
    const rows=JSON.parse(final.snapshotJson).rows;
    expect(rows.native_staff_access_reconciliation[0]).toMatchObject({enabled:1,generation:0,applied_generation:0,lease_id:null});
    const receiptRow=await db.prepare("SELECT result_json,result_sha256 FROM native_staff_bootstrap_receipts WHERE command_id=?")
      .bind(candidate.commandId).first<{result_json:string;result_sha256:string}>();
    expect(receiptRow?.result_sha256).toBe(sha(receiptRow!.result_json));
    expect(JSON.parse(receiptRow!.result_json)).toMatchObject({action:"native-staff-cutover",
      syncPreparationReceiptSha256:candidate.syncPreparationReceipt.receiptSha256,
      currentGroupSha256:candidate.syncPreparationReceipt.currentGroupSha256,
      desiredGroupSha256:candidate.syncPreparationReceipt.desiredGroupSha256});
    const registry=ownerModule.readNativeStaffCutoverApprovalRegistry(config);
    expect(registry.envelope.payload.entries[0]).toMatchObject({approvalId:candidate.approvalId,state:"consumed"});
    expect(writeBatches).toHaveLength(1);
    expect(writeBatches[0]).toHaveLength(3);
  },300_000);
});
