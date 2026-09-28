import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {splitD1MigrationStatements} from "../../../client/test/helpers/d1-migrations";
// Test artifact generators are JavaScript CLI modules without declarations.
// @ts-expect-error reviewed test-only JS module
import {transformSeed} from "../../../../scripts/staging-bootstrap.mjs";
// @ts-expect-error reviewed test-only JS module
import {AUTHORITY_MIGRATIONS_TABLE,buildAuthorityArtifacts} from "../../../../scripts/staging-native-authority-packet.mjs";
import {STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID,STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
  STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE,STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID,
  writeNativeDirectoryProfile,writeStagingEmptyEnrollmentOrganizationFixture} from "../../src/worker/native-directory-profile-writer";

export const canonicalOwner=Object.freeze({email:"owner@staging.example.test",displayName:"Synthetic Staging Owner",
  clientStaffId:"staging-client-owner",operationsStaffId:"staging-operations-owner",accessSubject:"staging-access-subject-001"});

/** Test-only full-chain loader. It intentionally exposes no trigger bypass or
 * direct history/receipt seeding primitive. */
export async function applyCanonicalChain(database:D1Database,app:"operations"|"client",final:string,syntheticOwner=false){
  const directory=new URL(`../../../${app}/migrations/`,import.meta.url);
  const names=readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name<=final).sort();
  if(names.at(-1)!==final)throw new Error(`canonical-${app}-final-migration-missing`);
  await database.prepare(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  for(const name of names){
    const raw=readFileSync(new URL(name,directory),"utf8");
    const source=syntheticOwner&&app==="operations"&&name==="0002_seed_acl.sql"?transformSeed("operations",raw,{
      email:canonicalOwner.email,displayName:canonicalOwner.displayName,clientStaffId:canonicalOwner.clientStaffId,
      operationsStaffId:canonicalOwner.operationsStaffId}):raw;
    const statements=splitD1MigrationStatements(source);
    await database.batch([...statements.map(statement=>database.prepare(statement)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  return names;
}

function artifactBase(){
  const root=resolve(new URL("../../../../",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
  const base=mkdtempSync(join(tmpdir(),"ltds-canonical-authority-")),app=join(base,"apps","operations");
  mkdirSync(app,{recursive:true});cpSync(join(root,"apps","operations","migrations"),join(app,"migrations"),{recursive:true});
  mkdirSync(join(base,"docs","staging"),{recursive:true});
  copyFileSync(join(root,"docs","staging","operations.wrangler.json.example"),join(base,"docs","staging","operations.wrangler.json.example"));
  copyFileSync(join(root,"docs","staging","operations.wrangler.json.example"),join(app,"wrangler.staging.json"));
  return base;
}
async function applyArtifact(database:D1Database,sql:string,name:string){
  const statements=splitD1MigrationStatements(sql).filter(value=>!/^\s*(BEGIN|COMMIT)\s*;?\s*$/iu.test(value));
  await database.batch([...statements.map(value=>database.prepare(value)),database.prepare(`INSERT INTO ${AUTHORITY_MIGRATIONS_TABLE}(name) VALUES(?)`).bind(name)]);
}
const evidence="0123456789abcdef".repeat(4);
const fixtureArtifacts=new WeakMap<object,{base:string;v5:ReturnType<typeof buildAuthorityArtifacts>}>();
const cleanArtifacts=new WeakMap<object,{base:string;v3:ReturnType<typeof buildAuthorityArtifacts>;v4?:ReturnType<typeof buildAuthorityArtifacts>}>();
function packet(schemaVersion:number,purpose?:string,expected?:Record<string,unknown>){
  const now=Date.now();return{schemaVersion,packet:{packetId:schemaVersion===3?"staging-authority-canonical-joined-v3":"staging-authority-canonical-joined-v5",mode:schemaVersion===3?"create":"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),reason:"Canonical joined synthetic fixture",
    ...(purpose?{purpose,businessAreaId:"area-default"}:{}),expected:expected??{admissionVersion:0,profileVersion:0,grantVersion:0,grantGeneration:0},
    evidence:{changeTicket:"canonical-joined",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
}
export async function establishGovernedEmptyEnrollmentFixture(database:D1Database){
  await database.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
    .bind(canonicalOwner.accessSubject,canonicalOwner.operationsStaffId).run();
  await database.prepare(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  const base=artifactBase(),v3=buildAuthorityArtifacts(base,packet(3),"revoke");
  await applyArtifact(database,v3.provision.sql,v3.provision.name);await applyArtifact(database,v3.revoke.sql,v3.revoke.name);
  await database.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES('area-default','Reviewed staging area',1)").run();
  const v5=buildAuthorityArtifacts(base,packet(5,"staging-empty-enrollment-fixture",{admissionVersion:2,profileVersion:1,grantVersion:2,grantGeneration:2}),"provision");
  try{await applyArtifact(database,v5.provision.sql,v5.provision.name);}
  catch(error){return{status:"blocked" as const,stage:"reviewed-onboarding-lineage" as const,error:String(error)};}
  fixtureArtifacts.set(database as object,{base,v5});
  const scope={businessAreaId:"area-default",divisionId:null};
  await database.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?, 'organization',?,?, '[]',?)`).bind(STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID,canonicalOwner.operationsStaffId,
      canonicalOwner.accessSubject,STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID,JSON.stringify([scope]),JSON.stringify(STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE),canonicalOwner.operationsStaffId).run();
  return writeStagingEmptyEnrollmentOrganizationFixture(database,{operation:"create",mutationId:STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
    recordId:STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID,expectedLocalVersion:0,kind:"organization",profile:STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE,
    scopes:[scope],destinations:[],createAdmissionId:STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID,
    actor:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,admissionVersion:3,loginEmail:canonicalOwner.email,
      profileVersion:1,selectedGrantId:`staging-directory-profile-edit:${canonicalOwner.operationsStaffId}`,
      selectedIdentityGrantId:`staging-directory-profile-edit:${canonicalOwner.operationsStaffId}`}});
}

export const canonicalUuidOrganization=Object.freeze({
  recordId:"30000000-0000-4000-8000-000000000031",mutationId:"30000000-0000-4000-8000-000000000032",
  admissionId:"canonical-joined-native-organization-admission",sourceId:"project-alpha:primary",
  sourceInstanceId:"10000000-0000-4000-8000-000000000001",applicationId:"10000000-0000-4000-8000-000000000002",
  historyEpochId:"10000000-0000-4000-8000-000000000003",publicId:"a".repeat(32),origin:"https://pa.example.test",
});

/** Creates a normal UUID-backed organization through the production writer.
 * The create admission is still enforced by the canonical triggers and is
 * tied exactly to the reviewed v5 owner authority established above. */
export async function writeGovernedCanonicalUuidOrganization(database:D1Database){
  const admission=await database.prepare(`SELECT admission.version admission_version,profile.version profile_version,
      generation.generation grant_generation
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(canonicalOwner.operationsStaffId,canonicalOwner.accessSubject)
    .first<{admission_version:number;profile_version:number;grant_generation:number}>();
  const grants=await database.prepare(`SELECT permission,id FROM native_directory_grants
    WHERE staff_id=? AND active=1 AND effect='allow' AND permission IN ('directory.profile.edit','directory.identity.link')`)
    .bind(canonicalOwner.operationsStaffId).all<{permission:string;id:string}>();
  const profileGrant=grants.results.find(row=>row.permission==="directory.profile.edit")?.id;
  const identityGrant=grants.results.find(row=>row.permission==="directory.identity.link")?.id;
  if(!admission||!profileGrant)throw new Error("canonical-reviewed-native-writer-authority-missing");
  const scope={businessAreaId:"area-default",divisionId:null};
  const profile={name:"Canonical joined UUID organization",generalEmail:"canonical@example.test",generalPhone:"",
    addressLine1:"1 Canonical Way",addressLine2:"",city:"Austin",state:"TX",postalCode:"78701",country:"US"};
  const destination={sourceId:canonicalUuidOrganization.sourceId,sourceInstanceUUID:canonicalUuidOrganization.sourceInstanceId,
    applicationUUID:canonicalUuidOrganization.applicationId,historyEpoch:canonicalUuidOrganization.historyEpochId,
    origin:canonicalUuidOrganization.origin,externalCanonicalId:canonicalUuidOrganization.recordId,expectedAuthorizationGeneration:"0"};
  await database.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?, 'organization',?,?,?,?)`).bind(canonicalUuidOrganization.admissionId,canonicalOwner.operationsStaffId,
      canonicalOwner.accessSubject,canonicalUuidOrganization.recordId,JSON.stringify([scope]),JSON.stringify(profile),
      JSON.stringify([{sourceId:destination.sourceId,sourceInstanceUUID:destination.sourceInstanceUUID,
        applicationUUID:destination.applicationUUID,historyEpoch:destination.historyEpoch,origin:destination.origin,
        externalCanonicalId:destination.externalCanonicalId}]),canonicalOwner.operationsStaffId).run();
  const outcome=await writeNativeDirectoryProfile(database,{operation:"create",mutationId:canonicalUuidOrganization.mutationId,
    recordId:canonicalUuidOrganization.recordId,expectedLocalVersion:0,kind:"organization",profile,scopes:[scope],
    destinations:[destination],createAdmissionId:canonicalUuidOrganization.admissionId,actor:{staffId:canonicalOwner.operationsStaffId,
      accessSubject:canonicalOwner.accessSubject,admissionVersion:admission.admission_version,loginEmail:canonicalOwner.email,
      profileVersion:admission.profile_version,selectedGrantId:profileGrant,selectedIdentityGrantId:identityGrant??profileGrant}});
  return{outcome,reviewer:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,
    admissionVersion:admission.admission_version,profileVersion:admission.profile_version,grantGeneration:admission.grant_generation}};
}

/** Moves the already-used fixture authority through its reviewed revoke and
 * into the reviewed record-scoped acquisition authority for this UUID row. */
export async function authorizeCanonicalUuidAcquisition(database:D1Database){
  const saved=fixtureArtifacts.get(database as object);if(!saved)throw Error("canonical-fixture-artifacts-missing");
  await applyArtifact(database,saved.v5.revoke.sql,saved.v5.revoke.name);
  const now=Date.now(),input={schemaVersion:5,packet:{packetId:"staging-authority-canonical-joined-acquisition-v5",
    purpose:"existing-directory-acquisition-after-fixture",recordId:canonicalUuidOrganization.recordId,recordKind:"organization",recordVersion:1,
    businessAreaId:"area-default",mode:"reactivate",operatorKind:"synthetic",staffId:canonicalOwner.operationsStaffId,
    email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),reason:"Canonical joined UUID acquisition",
    expected:{admissionVersion:4,profileVersion:1,grantVersion:4,grantGeneration:4,directoryAuthorityState:"v5-fixture-inactive"},
    evidence:{changeTicket:"canonical-joined-acquisition",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const acquisition=buildAuthorityArtifacts(saved.base,input,"provision");
  await applyArtifact(database,acquisition.provision.sql,acquisition.provision.name);
  const current=await database.prepare(`SELECT admission.version admission_version,profile.version profile_version,
      generation.generation grant_generation FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id WHERE admission.staff_id=?`)
    .bind(canonicalOwner.operationsStaffId).first<{admission_version:number;profile_version:number;grant_generation:number}>();
  if(!current)throw Error("canonical-acquisition-authority-missing-after-provision");
  return{acquisition,reviewer:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,
    admissionVersion:current.admission_version,profileVersion:current.profile_version,grantGeneration:current.grant_generation}};
}

export async function establishCleanV3Authority(database:D1Database){
  await database.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
    .bind(canonicalOwner.accessSubject,canonicalOwner.operationsStaffId).run();
  await database.prepare(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  await database.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Reviewed staging area',1)").run();
  const base=artifactBase(),v3=buildAuthorityArtifacts(base,packet(3),"provision");
  await applyArtifact(database,v3.provision.sql,v3.provision.name);cleanArtifacts.set(database as object,{base,v3});
}

export async function transitionCleanV3ToV4Acquisition(database:D1Database){
  const saved=cleanArtifacts.get(database as object);if(!saved)throw Error("canonical-clean-v3-artifacts-missing");
  await applyArtifact(database,saved.v3.revoke.sql,saved.v3.revoke.name);
  const now=Date.now(),input={schemaVersion:4,packet:{packetId:"staging-authority-canonical-clean-v4",purpose:"existing-directory-acquisition",
    recordId:canonicalUuidOrganization.recordId,recordKind:"organization",recordVersion:1,mode:"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),reason:"Canonical clean v4 acquisition",
    expected:{admissionVersion:2,profileVersion:1,grantVersion:2,grantGeneration:2,directoryAuthorityState:"v3-profile-only-inactive"},
    evidence:{changeTicket:"canonical-clean-v4",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const v4=buildAuthorityArtifacts(saved.base,input,"provision");await applyArtifact(database,v4.provision.sql,v4.provision.name);
  saved.v4=v4;
  return{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,admissionVersion:3,profileVersion:1,grantGeneration:4};
}

export async function transitionCleanV4ToV6PortalAuthority(database:D1Database,activationId:string){
  const saved=cleanArtifacts.get(database as object);if(!saved?.v4)throw Error("canonical-clean-v4-artifacts-missing");
  await applyArtifact(database,saved.v4.revoke.sql,saved.v4.revoke.name);
  const now=Date.now(),input={schemaVersion:6,packet:{packetId:"staging-authority-canonical-clean-v6",purpose:"recipient-enrollment-portal-access",
    recordId:canonicalUuidOrganization.recordId,recordKind:"organization",recordVersion:1,activationId,mode:"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),reason:"Canonical clean v6 portal selection",
    expected:{admissionVersion:4,profileVersion:1,grantVersion:4,grantGeneration:4,directoryGrantGeneration:6,
      profileGrantVersion:4,identityGrantVersion:2,portalGrantVersion:0,portalGrantState:"absent",directoryAuthorityState:"v4-acquisition-inactive"},
    evidence:{changeTicket:"canonical-clean-v6",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const v6=buildAuthorityArtifacts(saved.base,input,"provision");await applyArtifact(database,v6.provision.sql,v6.provision.name);
  return{admissionVersion:5,profileVersion:1};
}

/** The first reviewed-lineage prerequisite. Canonical triggers must decide
 * whether it is authorized; this helper never drops or disables them. */
export function createAcquisitionPrerequisite(database:D1Database){
  return database.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version)
    VALUES('60000000-0000-4000-8000-000000000001','organization',1)`).run();
}
