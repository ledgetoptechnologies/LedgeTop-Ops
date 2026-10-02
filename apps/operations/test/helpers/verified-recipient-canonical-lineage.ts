import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,copyFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {gunzipSync} from "node:zlib";
import {splitD1MigrationStatements} from "../../../client/test/helpers/d1-migrations";
// Test artifact generators are JavaScript CLI modules without declarations.
// @ts-expect-error reviewed test-only JS module
import {transformSeed} from "../../../../scripts/staging-bootstrap.mjs";
// @ts-expect-error reviewed test-only JS module
import {AUTHORITY_MIGRATIONS_TABLE,buildAuthorityArtifacts} from "../../../../scripts/staging-native-authority-packet.mjs";
// @ts-expect-error reviewed test-only JS module
import {buildOnboardingAuthorityArtifacts} from "../../../../scripts/staging-onboarding-authority-packet.mjs";
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
  const root=resolve(fileURLToPath(new URL("../../../../",import.meta.url)));
  const base=mkdtempSync(join(tmpdir(),"ltds-canonical-authority-")),app=join(base,"apps","operations");
  const sourceMigrations=join(root,"apps","operations","migrations"),targetMigrations=join(app,"migrations");
  const names=readdirSync(sourceMigrations).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name<="0152_operations_portal_workspace_reservations.sql").sort();
  const contents=names.map(name=>`${name}\0${createHash("sha256").update(readFileSync(join(sourceMigrations,name))).digest("hex")}`);
  if(names.length!==152||names.at(-1)!=="0152_operations_portal_workspace_reservations.sql"
    ||createHash("sha256").update(names.join("\n")).digest("hex")!=="a3eb1153187e13a1013b3d5ddd3dcc0c3d93ba2a272bb3650246df9ea9d8e109"
    ||createHash("sha256").update(contents.join("\n")).digest("hex")!=="f854aa66e1bb1b3c81feb7a11b18d654b11232d5e3732234ebff12e779f6e3a9")
    throw Error("canonical-reviewed-0152-migration-contract-mismatch");
  mkdirSync(targetMigrations,{recursive:true});
  for(const name of names)copyFileSync(join(sourceMigrations,name),join(targetMigrations,name));
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
const cleanPortalArtifacts=new WeakMap<object,ReturnType<typeof buildAuthorityArtifacts>>();
type HistoricalArtifact=ReturnType<typeof buildAuthorityArtifacts>;
type HistoricalFixtureState={base:string;sourceCommit:string;sourceTree:string;historical:HistoricalArtifact;
  onboarding:ReturnType<typeof buildOnboardingAuthorityArtifacts>;v7?:ReturnType<typeof buildAuthorityArtifacts>;
  v8?:ReturnType<typeof buildAuthorityArtifacts>};
const historicalFixtureArtifacts=new WeakMap<object,HistoricalFixtureState>();
function packet(schemaVersion:number,purpose?:string,expected?:Record<string,unknown>){
  const now=Date.now();return{schemaVersion,packet:{packetId:schemaVersion===3?"staging-authority-canonical-joined-v3":"staging-authority-canonical-joined-v5",mode:schemaVersion===3?"create":"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),reason:"Canonical joined synthetic fixture",
    ...(purpose?{purpose,businessAreaId:"area-default"}:{}),expected:expected??{admissionVersion:0,profileVersion:0,grantVersion:0,grantGeneration:0},
    evidence:{changeTicket:"canonical-joined",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
}

type HistoricalSourceBundle={fixtureVersion:number;sourceCommit:string;sourceTree:string;
  operationsMigrationContract:{count:number;finalMigration:string;namesSha256:string;contentsSha256:string};
  files:Array<{path:string;gitBlob:string;sha256:string;gzipBase64:string}>};
const historicalSourcePins=Object.freeze({
  "scripts/staging-native-authority-packet.mjs":Object.freeze({gitBlob:"acebdf1d29fcfacf395f34f8ccf97eb7bfd1c0ca",sha256:"5794f26863c05107f519fb0474f69ed2c9b91a139387e9faf9c10127a4d4d56b"}),
  "scripts/staging-bootstrap.mjs":Object.freeze({gitBlob:"329ea1d651f245e95ac10a2dc9ef3b410c503248",sha256:"47eb1756ad6487026a9757a5a785815160b72bf29f5b2678e85f9a4a2838c3b7"}),
  "scripts/staging-requirements.mjs":Object.freeze({gitBlob:"5c6075b835f8b3ffe5e5f24efefb590a7aab4e59",sha256:"ec1b2e01be87492ffe2c1d8d889c0b6e0c67945be320eccc6915346e9bd60aa8"}),
  "docs/staging/operations.wrangler.json.example":Object.freeze({gitBlob:"c58a90baae578b88c26225e3c5b9257f0e62ff06",sha256:"7305599319af73bea6f5c38b03af5aea652f47bbd941103b13dd2ca62abe5185"}),
});
const historicalSourcePaths=Object.keys(historicalSourcePins);

function digest(algorithm:"sha1"|"sha256",value:Uint8Array|string){return createHash(algorithm).update(value).digest("hex");}
function gitBlobDigest(value:Uint8Array){
  return createHash("sha1").update(`blob ${value.byteLength}\0`).update(value).digest("hex");
}

/** Materializes reviewed historical producer bytes carried by the test fixture.
 * This does not invoke Git, so the rehearsal also works in a shallow checkout. */
function historicalArtifactBase(){
  const root=resolve(fileURLToPath(new URL("../../../../",import.meta.url)));
  const bundle=JSON.parse(readFileSync(new URL("../fixtures/historical-v2-authority-sources.json",import.meta.url),"utf8")) as HistoricalSourceBundle;
  if(bundle.fixtureVersion!==1||bundle.sourceCommit!=="332ffbb947c3dc50a96f7b0fc5e2a976f693bdbc"
    ||bundle.sourceTree!=="c07acd54f7c0e747b66e97ea7d9656210b7d7007")throw Error("historical-v2-source-pin-mismatch");
  if(bundle.operationsMigrationContract.count!==122
    ||bundle.operationsMigrationContract.finalMigration!=="0122_project_alpha_project_v2_canonical_activation.sql"
    ||bundle.operationsMigrationContract.namesSha256!=="a4f9d709bfb3b1ba96bf3acadb370eac6465e2b5ec9fef7d8bb0db20792de71a"
    ||bundle.operationsMigrationContract.contentsSha256!=="20f127ae3193884494a021ac2f1851f6c2db06834d6f94498850d315e02df5d7")
    throw Error("historical-v2-migration-contract-pin-mismatch");
  if(JSON.stringify(bundle.files.map(file=>file.path))!==JSON.stringify(historicalSourcePaths))
    throw Error("historical-v2-source-inventory-mismatch");
  const base=mkdtempSync(join(tmpdir(),"ltds-historical-v2-authority-"));
  for(const file of bundle.files){
    const expected=historicalSourcePins[file.path as keyof typeof historicalSourcePins];
    if(!expected||file.gitBlob!==expected.gitBlob||file.sha256!==expected.sha256)
      throw Error(`historical-v2-source-metadata-mismatch:${file.path}`);
    const bytes=gunzipSync(Buffer.from(file.gzipBase64,"base64"));
    if(digest("sha256",bytes)!==file.sha256||gitBlobDigest(bytes)!==file.gitBlob)
      throw Error(`historical-v2-source-content-mismatch:${file.path}`);
    const target=join(base,...file.path.split("/"));mkdirSync(resolve(target,".."),{recursive:true});writeFileSync(target,bytes);
  }
  const sourceDirectory=join(root,"apps","operations","migrations"),targetDirectory=join(base,"apps","operations","migrations");
  mkdirSync(targetDirectory,{recursive:true});
  const names=readdirSync(sourceDirectory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name<=bundle.operationsMigrationContract.finalMigration).sort();
  if(names.length!==bundle.operationsMigrationContract.count||digest("sha256",names.join("\n"))!==bundle.operationsMigrationContract.namesSha256)
    throw Error("historical-v2-migration-name-pin-mismatch");
  const contents=names.map(name=>{
    const source=readFileSync(join(sourceDirectory,name));copyFileSync(join(sourceDirectory,name),join(targetDirectory,name));
    return `${name}\0${digest("sha256",source)}`;
  });
  if(digest("sha256",contents.join("\n"))!==bundle.operationsMigrationContract.contentsSha256)
    throw Error("historical-v2-migration-content-pin-mismatch");
  copyFileSync(join(base,"docs","staging","operations.wrangler.json.example"),join(base,"apps","operations","wrangler.staging.json"));
  return{base,bundle,names};
}

async function applyCanonicalTail(database:D1Database,after:string,final:string){
  const directory=new URL("../../../operations/migrations/",import.meta.url);
  const names=readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name>after&&name<=final).sort();
  if(names.at(-1)!==final)throw Error("canonical-operations-tail-final-migration-missing");
  for(const name of names){
    const statements=splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8"));
    await database.batch([...statements.map(statement=>database.prepare(statement)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  return names;
}

/** Builds the real pre-0123 schema-v2 bootstrap lineage, then applies the
 * forward migrations and the real onboarding provision producer. */
export async function establishHistoricalPreservedOnboardingLineage(database:D1Database){
  const fixture=historicalArtifactBase();
  const historicalBootstrap=await import(pathToFileURL(join(fixture.base,"scripts","staging-bootstrap.mjs")).href) as {
    transformSeed:(app:string,source:string,owner:{email:string;displayName:string;clientStaffId:string;operationsStaffId:string})=>string};
  const historicalProducer=await import(pathToFileURL(join(fixture.base,"scripts","staging-native-authority-packet.mjs")).href) as {
    buildAuthorityArtifacts:(base:string,input:unknown,phase:string)=>HistoricalArtifact};
  await database.prepare(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  for(const name of fixture.names){
    const raw=readFileSync(join(fixture.base,"apps","operations","migrations",name),"utf8");
    const source=name==="0002_seed_acl.sql"?historicalBootstrap.transformSeed("operations",raw,{email:canonicalOwner.email,
      displayName:canonicalOwner.displayName,clientStaffId:canonicalOwner.clientStaffId,operationsStaffId:canonicalOwner.operationsStaffId}):raw;
    const statements=splitD1MigrationStatements(source);
    await database.batch([...statements.map(statement=>database.prepare(statement)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  await database.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
    .bind(canonicalOwner.accessSubject,canonicalOwner.operationsStaffId).run();
  await database.prepare(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  const now=Date.now(),historicalInput={schemaVersion:2,packet:{packetId:"staging-authority-canonical-history-v2",mode:"create",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
    accessSubject:canonicalOwner.accessSubject,issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),
    reason:"Canonical historical schema-v2 lineage rehearsal",expected:{admissionVersion:0,profileVersion:0,grantVersion:0,grantGeneration:0},
    evidence:{changeTicket:"canonical-history-v2",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const historical=historicalProducer.buildAuthorityArtifacts(fixture.base,historicalInput,"revoke");
  await applyArtifact(database,historical.provision.sql,historical.provision.name);
  await applyArtifact(database,historical.revoke.sql,historical.revoke.name);
  await applyCanonicalTail(database,fixture.bundle.operationsMigrationContract.finalMigration,"0152_operations_portal_workspace_reservations.sql");
  await database.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Reviewed staging area',1)").run();
  const base=artifactBase(),onboardingInput={schemaVersion:1,packet:{packetId:"staging-onboarding-authority-canonical-history",
    purpose:"client-onboarding-positive-acceptance",operatorKind:"synthetic",staffId:canonicalOwner.operationsStaffId,
    email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,businessAreaId:"area-default",
    issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),
    reason:"Canonical historical onboarding lineage rehearsal",expected:{admissionVersion:2,profileVersion:1},
    evidence:{changeTicket:"canonical-history-onboarding",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const onboarding=buildOnboardingAuthorityArtifacts(base,onboardingInput,"revoke");
  await applyArtifact(database,onboarding.provision.sql,onboarding.provision.name);
  historicalFixtureArtifacts.set(database as object,{base,sourceCommit:fixture.bundle.sourceCommit,sourceTree:fixture.bundle.sourceTree,historical,onboarding});
  return{sourceCommit:fixture.bundle.sourceCommit,sourceTree:fixture.bundle.sourceTree,
    historicalManifest:historical.provision.manifest,onboardingGrantId:onboarding.ids.grant};
}

/** Revokes real onboarding authority and provisions schema v7 against the
 * exact 1/3 preserved profile histories produced above. */
export async function transitionHistoricalOnboardingToV7Acquisition(database:D1Database){
  const saved=historicalFixtureArtifacts.get(database as object);if(!saved)throw Error("canonical-historical-lineage-missing");
  await applyArtifact(database,saved.onboarding.revoke.sql,saved.onboarding.revoke.name);
  const now=Date.now(),input={schemaVersion:7,packet:{packetId:"staging-authority-canonical-history-v7",
    purpose:"existing-directory-acquisition-preserving-onboarding-profile",recordId:canonicalUuidOrganization.recordId,
    recordKind:"organization",recordVersion:1,businessAreaId:"area-default",mode:"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
    accessSubject:canonicalOwner.accessSubject,issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),
    reason:"Canonical historical schema-v7 acquisition rehearsal",expected:{admissionVersion:4,profileVersion:1,
      grantVersion:2,grantGeneration:2,directoryGrantGeneration:4,profileGrantVersion:1,onboardingGrantVersion:3,
      profileHistoryGenerations:[1],onboardingHistoryGenerations:[2,3,4],identityGrantVersion:0,identityHistoryGenerations:[],
      identityGrantState:"absent",directoryAuthorityState:"v7-profile-plus-onboarding-inactive"},
    evidence:{changeTicket:"canonical-history-v7",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const v7=buildAuthorityArtifacts(saved.base,input,"revoke");await applyArtifact(database,v7.provision.sql,v7.provision.name);saved.v7=v7;
  const current=await database.prepare(`SELECT admission.version admission_version,profile.version profile_version,
      generation.generation grant_generation FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id WHERE admission.staff_id=?`)
    .bind(canonicalOwner.operationsStaffId).first<{admission_version:number;profile_version:number;grant_generation:number}>();
  if(!current)throw Error("canonical-historical-v7-authority-missing-after-provision");
  return{v7,reviewer:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,
    admissionVersion:current.admission_version,profileVersion:current.profile_version,grantGeneration:current.grant_generation}};
}

/** Revokes schema v7 only after the real acquisition/activation consumers have
 * emitted their durable lineage, then provisions schema v8 against its receipt. */
export async function transitionHistoricalV7ToV8PortalAuthority(database:D1Database,activationId:string){
  const saved=historicalFixtureArtifacts.get(database as object);if(!saved?.v7)throw Error("canonical-historical-v7-artifacts-missing");
  await applyArtifact(database,saved.v7.revoke.sql,saved.v7.revoke.name);
  const now=Date.now(),input={schemaVersion:8,packet:{packetId:"staging-authority-canonical-history-v8",
    purpose:"recipient-enrollment-portal-access-preserving-onboarding-profile",recordId:canonicalUuidOrganization.recordId,
    recordKind:"organization",recordVersion:1,activationId,businessAreaId:"area-default",mode:"reactivate",operatorKind:"synthetic",
    staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
    accessSubject:canonicalOwner.accessSubject,issuedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),
    reason:"Canonical historical schema-v8 portal selection rehearsal",expected:{admissionVersion:6,profileVersion:1,
      grantVersion:2,grantGeneration:2,directoryGrantGeneration:8,profileGrantVersion:3,onboardingGrantVersion:3,
      activationReceiptDirectoryGrantGeneration:6,profileHistoryGenerations:[1,5,7],onboardingHistoryGenerations:[2,3,4],
      identityGrantVersion:2,identityHistoryGenerations:[6,8],portalGrantVersion:0,portalHistoryGenerations:[],
      portalGrantState:"absent",directoryAuthorityState:"v7-acquisition-plus-onboarding-inactive"},
    evidence:{changeTicket:"canonical-history-v8",reviewer:"canonical-reviewer",bindingEvidenceSha256:evidence}}};
  const v8=buildAuthorityArtifacts(saved.base,input,"revoke");await applyArtifact(database,v8.provision.sql,v8.provision.name);saved.v8=v8;
  return{v8,actor:{identity:{kind:"native" as const,staffId:canonicalOwner.operationsStaffId,
    verifiedAccessSubject:canonicalOwner.accessSubject,email:canonicalOwner.email,displayName:canonicalOwner.displayName,profileVersion:1},
    admissionVersion:7,verifiedUntil:new Date(Date.now()+30*60_000).toISOString()}};
}

export async function revokeHistoricalV8PortalAuthority(database:D1Database){
  const saved=historicalFixtureArtifacts.get(database as object);if(!saved?.v8)throw Error("canonical-historical-v8-artifacts-missing");
  await applyArtifact(database,saved.v8.revoke.sql,saved.v8.revoke.name);
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
  cleanPortalArtifacts.set(database as object,v6);
  return{admissionVersion:5,profileVersion:1};
}

/** Revoke through the reviewed producer, never by directly altering grants. */
export async function revokeCleanV6PortalAuthority(database:D1Database){
  const saved=cleanPortalArtifacts.get(database as object);if(!saved)throw Error("canonical-clean-v6-artifacts-missing");
  await applyArtifact(database,saved.revoke.sql,saved.revoke.name);
}

/** The first reviewed-lineage prerequisite. Canonical triggers must decide
 * whether it is authorized; this helper never drops or disables them. */
export function createAcquisitionPrerequisite(database:D1Database){
  return database.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version)
    VALUES('60000000-0000-4000-8000-000000000001','organization',1)`).run();
}
