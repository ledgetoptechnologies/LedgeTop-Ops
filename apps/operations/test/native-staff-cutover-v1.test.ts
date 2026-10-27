import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { compileNativeStaffCutoverV1, executeNativeStaffCutoverD1, prepareNativeStaffCutoverD1 }
  from "../../../scripts/native-staff-cutover-v1.mjs";
// @ts-expect-error reviewed test-only JavaScript source contract
import { assertNativeStaffCutoverMigrationSource, readNativeStaffCutoverSnapshot } from "../../../scripts/native-staff-cutover-v1.mjs";

let runtime:Miniflare, db:D1Database, serial=0;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const stable=(value:unknown):string=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:!value||typeof value!=="object"?JSON.stringify(value):`{${Object.keys(value as object).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(",")}}`;
type Person={id:string;email:string;subject:string};

async function seedOwner():Promise<Person>{
  const id=`cutover-owner-${++serial}`,email=`${id}@example.test`,subject=`access|${id}`;
  await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id,email,id,subject).run();
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id,subject,id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id,email,id),
  ]);
  const caps=["staff.onboarding.create","staff.onboarding.approve","staff.admission.disable","staff.membership.manage",
    "staff.directory_grant.manage","staff.admin_delegation.manage","staff.admission.enable","staff.profile.edit","staff.profile.read"];
  await db.batch(caps.map(cap=>db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
    VALUES(?,?,?,'allow','global',?)`).bind(`${id}:${cap}`,id,cap,id)));
  const ceilings=[...(["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage","directory.portal_access.manage"]
    .map(cap=>["directory",cap] as const)),...caps.slice(0,6).map(cap=>["staff_admin",cap] as const)];
  await db.batch(ceilings.map(([domain,cap])=>db.prepare(`INSERT INTO native_staff_delegation_ceilings
    (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
    VALUES(?,?,?,?, 'allow',1,1,1,1,'global')`).bind(`${id}:ceiling:${domain}:${cap}`,
      `${id}:${domain==='directory'?'staff.directory_grant.manage':'staff.admin_delegation.manage'}`,domain,cap)));
  return {id,email,subject};
}

async function cutoverInput(operator:Person){
  const reviewedSnapshot=await readNativeStaffCutoverSnapshot(db);
  const snapshot=JSON.parse(reviewedSnapshot.snapshotJson) as {rows:{
    staff_users:Record<string,unknown>[];native_staff_admissions:Record<string,unknown>[];native_staff_profiles:Record<string,unknown>[];
  }};
  const admissions=new Map(snapshot.rows.native_staff_admissions.map(row=>[row.staff_id,row]));
  const profiles=new Map(snapshot.rows.native_staff_profiles.map(row=>[row.staff_id,row]));
  const cohort=snapshot.rows.staff_users.flatMap(staff=>{
    const admission=admissions.get(staff.id),profile=profiles.get(staff.id);
    if(staff.status!=="active"&&!admission)return [];
    if(!admission||!profile)throw new Error("cutover-test-seed-bridge-missing");
    return [{staffId:staff.id,email:profile.login_email,accessSubject:admission.bound_access_subject,
      displayName:profile.display_name,active:admission.active===1,admissionVersion:admission.version,profileVersion:profile.version}];
  }).sort((a,b)=>String(a.staffId).localeCompare(String(b.staffId)));
  const cohortSha256=hash(stable(cohort));
  const desiredGroup=cohort.filter(row=>row.active).map(row=>row.email).sort();
  const groupPolicy={exclude:[],require:[],is_default:false};
  const groupObservation=(offset:number)=>{
    const body={schemaVersion:1,kind:"cloudflare-access-group-observation-v1",accountId:"a".repeat(32),
      groupId:"11111111-1111-4111-8111-111111111111",groupName:"Synthetic Ops Staff",
      observedAt:new Date(Date.now()+offset).toISOString(),managedEmailCount:desiredGroup.length,
      managedEmailsSha256:hash(stable(desiredGroup)),includeRuleCount:desiredGroup.length,
      policySha256:hash(stable(groupPolicy)),providerResponseSha256:"5".repeat(64)};
    return {...body,evidenceSha256:hash(stable(body))};
  };
  const prepBody={schemaVersion:1,kind:"operations-native-staff-sync-dormant-preparation-v1",accountId:"a".repeat(32),
    workerName:"ltds-ops-sync",environment:"production",databaseId:"b".repeat(8)+"-"+"b".repeat(4)+"-"+"b".repeat(4)+"-"+"b".repeat(4)+"-"+"b".repeat(12),
    activeRuntimeVersion:"2026-07-22",candidateRuntimeVersion:"2026-07-22",activeSettingsSha256:"c".repeat(64),
    candidateSettingsSha256:"d".repeat(64),bindingsSha256:"e".repeat(64),activeModuleSha256:"f".repeat(64),
    candidateModuleSha256:"1".repeat(64),activeSourceCommit:"2".repeat(40),candidateSourceCommit:"3".repeat(40),
    candidateSourceTreeSha256:"5".repeat(64),sourceEvidenceSha256:"6".repeat(64),behaviorQualificationSha256:"7".repeat(64),
    testReportSha256:"8".repeat(64),builtModuleSha256:"1".repeat(64),qualificationRunnerSha256:"9".repeat(64),
    controlState:"disabled",cohortSha256,activeStaffCount:cohort.filter(row=>row.active).length,activeAlternateBindingCount:0,
    alternateBindingEvidenceSha256:"4".repeat(64),accessGroupObservations:{before:groupObservation(-1000),after:groupObservation(0)},
    currentGroupCount:desiredGroup.length,currentGroupSha256:hash(stable(desiredGroup)),
    desiredGroupCount:desiredGroup.length,desiredGroupSha256:hash(stable(desiredGroup))};
  const syncPreparationReceipt={...prepBody,receiptSha256:hash(stable(prepBody))};
  const controlPlaneStaffIds=[...reviewedSnapshot.controlPlaneStaffIds];
  const artifact=compileNativeStaffCutoverV1({reviewedSnapshot,controlPlaneStaffIds,
    operator:{staffId:operator.id,accessSubject:operator.subject},syncPreparationReceipt});
  const now=Date.now(),approvalId=crypto.randomUUID(),commandId=`cutover-${crypto.randomUUID()}`;
  return {schemaVersion:1,approval:{approvalId,operatorStaffId:operator.id,operatorSubject:operator.subject,
      issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+5*60_000).toISOString()},commandId,
    canonicalPlanJson:artifact.canonicalPlanJson,bindingEvidenceJson:artifact.bindingEvidenceJson,reviewedSnapshot,
    controlPlaneStaffIds,operator:{staffId:operator.id,accessSubject:operator.subject},syncPreparationReceipt,
    trustEnvelope:{schemaVersion:1,synthetic:true}};
}

const trust=async()=>true;

function observeMutationBatch(target:D1Database){
  const metadata=new WeakMap<object,{sql:string;params:unknown[]}>();
  const batches:{sql:string[];params:unknown[][]}[]=[];
  let armed=false;
  const observed=new Proxy(target,{get(inner,property){
    if(property==="prepare")return (sql:string)=>{
      const statement=inner.prepare(sql);
      return new Proxy(statement,{get(prepared,key){
        if(key==="bind")return (...params:unknown[])=>{
          const bound=prepared.bind(...params);
          metadata.set(bound as object,{sql,params});
          return bound;
        };
        const value=Reflect.get(prepared,key,prepared);return typeof value==="function"?value.bind(prepared):value;
      }});
    };
    if(property==="batch")return async(statements:Parameters<D1Database["batch"]>[0])=>{
      if(armed)batches.push({sql:statements.map(statement=>metadata.get(statement as object)?.sql??"<untracked>"),
        params:statements.map(statement=>metadata.get(statement as object)?.params??[])});
      return inner.batch(statements);
    };
    const value=Reflect.get(inner,property,inner);return typeof value==="function"?value.bind(inner):value;
  }}) as D1Database;
  return {db:observed,batches,arm(){armed=true;}};
}

function expectPacked230Batch(batch:{sql:string[];params:unknown[][]}){
  expect(batch.sql).not.toContain("<untracked>");
  expect(batch.sql.length).toBeLessThanOrEqual(256);
  const guards=batch.sql.slice(0,-3);
  const marker=/ELSE json\('native-staff-cutover-[a-z-]+-mismatch'\)/gu;
  const perStatement=guards.map(sql=>[...sql.matchAll(marker)].length);
  expect(perStatement.every(count=>count>=1&&count<=8)).toBe(true);
  expect(guards.reduce((total,sql)=>total+[...sql.matchAll(marker)].length,0)).toBe(340);
  for(const [index,sql] of guards.entries()){
    expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(80_000);
    expect(Array.isArray(batch.params[index])).toBe(true);
    expect(batch.params[index]!.length).toBeLessThanOrEqual(100);
  }
}

describe("first native staff cutover compiler and D1 executor",()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const dir=new URL("../migrations/",import.meta.url);
    for(const name of readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=230).sort()){
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,dir),"utf8")).map(sql=>db.prepare(sql)));
      await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
    }
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id IN ('staff-beau-koltz','staff-kollins-stirn')").run();
  },180_000);
  beforeEach(async()=>{
    await db.prepare(`UPDATE native_staff_access_reconciliation SET enabled=0,generation=0,applied_generation=0,
      lease_id=NULL,lease_until=NULL,attempt_generation=NULL,last_success_at=NULL,last_error=NULL WHERE singleton=1`).run();
  });
  afterAll(async()=>runtime?.dispose());

  it("accepts only the byte-pinned local Ads successor without expanding the reviewed D1 prefix",()=>{
    const dir=new URL("../migrations/",import.meta.url);
    const localNames=readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/u.test(name)).sort();
    const targetNames=localNames.slice(0,230);
    const readMigrationBytes=(name:string)=>readFileSync(new URL(name,dir));
    expect(localNames.slice(-2)).toEqual(["0230_app_release_pilot.sql","0231_owner_google_ads_summary.sql"]);
    expect(assertNativeStaffCutoverMigrationSource({targetNames,localNames,readMigrationBytes})).toBe(true);
    expect(()=>assertNativeStaffCutoverMigrationSource({targetNames,localNames:[...localNames,"0232_unreviewed.sql"],readMigrationBytes}))
      .toThrow(/migration_chain_mismatch/u);
    expect(()=>assertNativeStaffCutoverMigrationSource({targetNames,localNames,
      readMigrationBytes:(name:string)=>name==="0231_owner_google_ads_summary.sql"?Buffer.from("-- altered unreviewed bytes\n"):readMigrationBytes(name)}))
      .toThrow(/migration_contents_changed/u);
  });

  it("writes only the exact cutover receipt and enabled flag atomically",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    const prepared=await prepareNativeStaffCutoverD1(input,{db,verifyApproval:trust});
    const dispatches:unknown[]=[];
    const observed=observeMutationBatch(db);
    const result=await executeNativeStaffCutoverD1(observed.db,prepared,{verifyApproval:trust,beforeMutationDispatch:async value=>{
      dispatches.push(value);observed.arm();
    }});
    expect(observed.batches).toHaveLength(1);
    expectPacked230Batch(observed.batches[0]!);
    expect(dispatches).toEqual([{schemaVersion:1,commandId:input.commandId,approvalId:input.approval.approvalId,
      snapshotSha256:prepared.reviewedSnapshot.snapshotSha256,planSha256:prepared.planSha256,bindingSha256:prepared.bindingSha256}]);
    expect(result).toMatchObject({action:"native-staff-cutover",enabled:1,generation:0});
    const control=await db.prepare("SELECT enabled,generation,applied_generation,lease_id FROM native_staff_access_reconciliation WHERE singleton=1").first();
    expect(control).toEqual({enabled:1,generation:0,applied_generation:0,lease_id:null});
    const receipt=await db.prepare("SELECT canonical_plan_json,independent_binding_verification_json FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first<any>();
    expect(JSON.parse(receipt.canonical_plan_json)).toEqual({kind:"operations-native-staff-cutover-v1",
      cohortSha256:JSON.parse(input.canonicalPlanJson).cohortSha256,controlPlaneStaffIds:[operator.id]});
    expect(JSON.parse(receipt.independent_binding_verification_json)).toEqual({kind:"operations-native-staff-binding-review-v1",
      cohortSha256:JSON.parse(input.canonicalPlanJson).cohortSha256,operatorStaffId:operator.id,operatorSubject:operator.subject});
    const storedResult=await db.prepare("SELECT result_json FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first<{result_json:string}>();
    expect(JSON.parse(storedResult!.result_json)).toMatchObject({syncPreparationReceiptSha256:input.syncPreparationReceipt.receiptSha256,
      currentGroupSha256:input.syncPreparationReceipt.currentGroupSha256,desiredGroupSha256:input.syncPreparationReceipt.desiredGroupSha256,
      accessGroupObservations:input.syncPreparationReceipt.accessGroupObservations});
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?").bind(operator.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?").bind(operator.id).first("n")).toBe(9);
  },180_000);

  it("keeps the cutover target at the frozen 0230 ledger when only the reviewed 0231 Ads source is appended",async()=>{
    const dir=new URL("../migrations/",import.meta.url);
    const local=readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/u.test(name)).sort();
    expect(local.slice(-2)).toEqual(["0230_app_release_pilot.sql","0231_owner_google_ads_summary.sql"]);
    const reviewed=await readNativeStaffCutoverSnapshot(db);
    expect(reviewed.migrationNames).toHaveLength(230);
    expect(reviewed.migrationNames.at(-1)).toBe("0230_app_release_pilot.sql");
    expect(reviewed.migrationNames).not.toContain("0231_owner_google_ads_summary.sql");

    await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind("0231_owner_google_ads_summary.sql").run();
    try {
      await expect(readNativeStaffCutoverSnapshot(db)).rejects.toThrow(/migration_chain_mismatch/u);
    } finally {
      await db.prepare("DELETE FROM d1_migrations WHERE name=?").bind("0231_owner_google_ads_summary.sql").run();
    }
  },180_000);

  it("packs the full 0230 snapshot and atomically rolls back every cutover write on late drift",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    const prepared=await prepareNativeStaffCutoverD1(input,{db,verifyApproval:trust});
    const snapshot=JSON.parse(prepared.reviewedSnapshot.snapshotJson) as {schema_count:number;schema:unknown[]};
    expect(snapshot.schema_count).toBe(2535);
    expect(snapshot.schema).toHaveLength(2535);
    const observed=observeMutationBatch(db);
    const dispatch=vi.fn(async()=>{
      await db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
        VALUES(?,?,'role-operator','global',NULL,'global',?)`).bind(`late:${operator.id}`,operator.id,operator.id).run();
      observed.arm();
    });
    await expect(executeNativeStaffCutoverD1(observed.db,prepared,{verifyApproval:trust,beforeMutationDispatch:dispatch}))
      .rejects.toThrow(/native_staff_cutover_atomic_batch_(?:refused|not_committed)/u);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observed.batches).toHaveLength(1);
    expectPacked230Batch(observed.batches[0]!);
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM staff_role_assignments WHERE id=?").bind(`late:${operator.id}`).first("n")).toBe(1);
  },180_000);

  it("refuses a changed full snapshot before any approval, receipt, or enable write",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    const prepared=await prepareNativeStaffCutoverD1(input,{db,verifyApproval:trust});
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by) VALUES(?,?,'role-operator','global',NULL,'global',?)")
      .bind(`changed:${operator.id}`,operator.id,operator.id).run();
    const dispatch=vi.fn();
    await expect(executeNativeStaffCutoverD1(db,prepared,{verifyApproval:trust,beforeMutationDispatch:dispatch})).rejects.toThrow(/snapshot_changed/u);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first("n")).toBe(0);
  },180_000);

  it("treats null-target delegation ceiling changes as authority-wide snapshot drift",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    const prepared=await prepareNativeStaffCutoverD1(input,{db,verifyApproval:trust});
    const ceiling=await db.prepare("SELECT id FROM native_staff_delegation_ceilings ORDER BY id LIMIT 1").first<{id:string}>();
    expect(ceiling).not.toBeNull();
    const before=await db.prepare("SELECT target_staff_id,active,version FROM native_staff_delegation_ceilings WHERE id=?").bind(ceiling!.id)
      .first<{target_staff_id:string|null;active:number;version:number}>();
    expect(before!.target_staff_id).toBeNull();
    await db.prepare(`UPDATE native_staff_delegation_ceilings SET active=0,version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(ceiling!.id).run();
    const dispatch=vi.fn();
    await expect(executeNativeStaffCutoverD1(db,prepared,{verifyApproval:trust,beforeMutationDispatch:dispatch}))
      .rejects.toThrow(/snapshot_changed/u);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
  },180_000);

  it("fails before D1 dispatch when the registry hook refuses and verifies exact expected receipt bytes",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    const prepared=await prepareNativeStaffCutoverD1(input,{db,verifyApproval:trust});
    const refuse=vi.fn(async()=>{throw new Error("registry-dispatch-refused");});
    const before=await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled");
    await expect(executeNativeStaffCutoverD1(db,prepared,{verifyApproval:trust,beforeMutationDispatch:refuse}))
      .rejects.toThrow("registry-dispatch-refused");
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(before);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);

    const forgedDb=new Proxy(db,{get(target,property){
      if(property!=="prepare")return Reflect.get(target,property,target);
      return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes("FROM native_staff_bootstrap_receipts WHERE command_id=?"))return statement;
        return new Proxy(statement,{get(inner,key){
          if(key==="bind")return (...values:unknown[])=>{
            const bound=inner.bind(...values);
            return new Proxy(bound,{get(boundTarget,boundKey){
              if(boundKey==="first")return async(...args:unknown[])=>{
                const readFirst=boundTarget.first as (...values:unknown[])=>Promise<Record<string,unknown>|null>;
                const row=await readFirst.apply(boundTarget,args);
                if(!row)return row;
                const forged=JSON.stringify({schemaVersion:1,action:"native-staff-cutover",forged:true});
                return {...row,result_json:forged,result_sha256:hash(forged)};
              };
              const value=Reflect.get(boundTarget,boundKey);return typeof value==="function"?value.bind(boundTarget):value;
            }});
          };
          const value=Reflect.get(inner,key);return typeof value==="function"?value.bind(inner):value;
        }});
      };
    }});
    const preparedAgain=await prepareNativeStaffCutoverD1(await cutoverInput(operator),{db,verifyApproval:trust});
    await expect(executeNativeStaffCutoverD1(forgedDb,preparedAgain,{verifyApproval:trust})).rejects.toThrow(/durable_readback_uncertain/u);
  },180_000);

  it("refuses an enabled or non-idle control and does not reinterpret bootstrap-install receipts",async()=>{
    const operator=await seedOwner(),input=await cutoverInput(operator);
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1").run();
    const live=await readNativeStaffCutoverSnapshot(db);
    expect(()=>compileNativeStaffCutoverV1({reviewedSnapshot:live,controlPlaneStaffIds:[operator.id],
      operator:{staffId:operator.id,accessSubject:operator.subject},syncPreparationReceipt:input.syncPreparationReceipt})).toThrow(/control_not_dormant/u);
    expect(input.canonicalPlanJson).toContain("operations-native-staff-cutover-v1");
    expect(stable(JSON.parse(input.canonicalPlanJson))).not.toContain("operations-native-staff-bootstrap-install-v1");
  },180_000);
});
