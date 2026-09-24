import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { transformSeed } from "./staging-bootstrap.mjs";
import { AUTHORITY_MIGRATIONS_TABLE, buildAuthorityArtifacts } from "./staging-native-authority-packet.mjs";
import { ONBOARDING_AUTHORITY_MIGRATIONS_TABLE, buildOnboardingAuthorityArtifacts, validateGeneratedOnboardingAuthority, validateOnboardingAuthorityInput, writeOnboardingAuthority } from "./staging-onboarding-authority-packet.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const owner = Object.freeze({ email: "owner@staging.example.test", displayName: "Synthetic Staging Owner", clientStaffId: "staging-client-owner", operationsStaffId: "staging-operations-owner" });
const subject = "staging-access-subject-001", evidenceSha = "0123456789abcdef".repeat(4);
const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

function oldInput() { return { schemaVersion: 3, packet: { packetId: "staging-authority-project-v2-prior", mode: "create", operatorKind: "synthetic", staffId: owner.operationsStaffId, email: owner.email, displayName: owner.displayName, accessSubject: subject, issuedAt, expiresAt, reason: "Prior bounded staging authority", expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0 }, evidence: { changeTicket: "prior-change", reviewer: "prior-reviewer", bindingEvidenceSha256: evidenceSha } } }; }
function input(overrides = {}) { const base = { schemaVersion: 1, packet: { packetId: "staging-onboarding-authority-positive-001", purpose: "client-onboarding-positive-acceptance", operatorKind: "synthetic", staffId: owner.operationsStaffId, email: owner.email, displayName: owner.displayName, accessSubject: subject, businessAreaId: "area-default", issuedAt, expiresAt, reason: "Bounded positive client onboarding acceptance", expected: { admissionVersion: 2, profileVersion: 1 }, evidence: { changeTicket: "onboarding-change", reviewer: "onboarding-reviewer", bindingEvidenceSha256: evidenceSha } } }; return { ...base, ...overrides, packet: { ...base.packet, ...(overrides.packet ?? {}) } }; }
function fixture() { const base=fs.mkdtempSync(path.join(os.tmpdir(),"ltds-onboarding-authority-")), app=path.join(base,"apps","operations"); fs.mkdirSync(app,{recursive:true}); fs.cpSync(path.join(repositoryRoot,"apps","operations","migrations"),path.join(app,"migrations"),{recursive:true}); fs.copyFileSync(path.join(repositoryRoot,"docs","staging","operations.wrangler.json.example"),path.join(app,"wrangler.staging.json")); return base; }
function apply(db, source, name, table="d1_migrations") { db.exec("BEGIN"); try { db.exec(source); db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name); db.exec("COMMIT"); } catch(error) { try { db.exec("ROLLBACK"); } catch {} throw error; } }
function database() { const db=new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"); const directory=path.join(repositoryRoot,"apps","operations","migrations"); for(const name of fs.readdirSync(directory).filter(n=>n.endsWith(".sql")).sort()) { let source=fs.readFileSync(path.join(directory,name),"utf8"); if(name==="0002_seed_acl.sql") source=transformSeed("operations",source,owner); apply(db,source,name); } db.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(subject,owner.operationsStaffId); db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Fixture area',1)").run(); db.exec(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`); return db; }
function priorInactive(db, base) { const prior=buildAuthorityArtifacts(base,oldInput(),"revoke"); apply(db,prior.provision.sql,prior.provision.name,AUTHORITY_MIGRATIONS_TABLE); apply(db,prior.revoke.sql,prior.revoke.name,AUTHORITY_MIGRATIONS_TABLE); return prior; }
function row(db, source, ...args) { const value=db.prepare(source).get(...args); return value ? {...value} : value; }

test("accepts only the fixed, bounded onboarding purpose", () => {
  assert.deepEqual(validateOnboardingAuthorityInput(input()), []);
  for (const invalid of [input({schemaVersion:2}), input({packet:{purpose:"project-sync"}}), input({packet:{accessSubject:"a.b.c"}}), input({packet:{expected:{admissionVersion:0,profileVersion:1}}}), input({packet:{businessAreaId:"bad id"}}), input({packet:{unexpectedPermission:"directory.identity.link"}})]) assert(validateOnboardingAuthorityInput(invalid).length>0);
});

test("reactivates only admission plus one business-area profile-edit allow, then revokes without touching prior rows", () => {
  const base=fixture(), db=database(), prior=priorInactive(db,base), artifact=buildOnboardingAuthorityArtifacts(base,input(),"revoke");
  const beforeProject=row(db,"SELECT active,version FROM native_project_grants WHERE staff_id=?",owner.operationsStaffId);
  apply(db,artifact.provision.sql,artifact.provision.name,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(row(db,"SELECT active,version FROM native_staff_admissions WHERE staff_id=?",owner.operationsStaffId),{active:1,version:3});
  assert.deepEqual(row(db,"SELECT permission,effect,scope_kind,business_area_id,active FROM native_directory_grants WHERE id=?",artifact.ids.grant),{permission:"directory.profile.edit",effect:"allow",scope_kind:"business_area",business_area_id:"area-default",active:1});
  assert.deepEqual(row(db,"SELECT active FROM native_directory_grants WHERE id=?",prior.ids.directoryGrant),{active:0});
  assert.deepEqual(row(db,"SELECT active,version FROM native_project_grants WHERE staff_id=?",owner.operationsStaffId),beforeProject);
  apply(db,artifact.revoke.sql,artifact.revoke.name,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(row(db,"SELECT active,version FROM native_staff_admissions WHERE staff_id=?",owner.operationsStaffId),{active:0,version:4});
  assert.deepEqual(row(db,"SELECT active FROM native_directory_grants WHERE id=?",artifact.ids.grant),{active:0});
  assert.deepEqual(row(db,"SELECT active FROM native_directory_grants WHERE id=?",prior.ids.directoryGrant),{active:0});
  assert.deepEqual(row(db,"SELECT active,version FROM native_project_grants WHERE staff_id=?",owner.operationsStaffId),beforeProject);
  assert.equal(row(db,`SELECT count(*) count FROM ${ONBOARDING_AUTHORITY_MIGRATIONS_TABLE}`).count,4);
});

test("fails closed on active unrelated Directory authority or Project authority", () => {
  for (const kind of ["directory","project"]) { const base=fixture(), db=database(), prior=priorInactive(db,base), artifact=buildOnboardingAuthorityArtifacts(base,input(),"provision"); if(kind==="directory") db.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").run(prior.ids.directoryGrant); else db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id=?").run(prior.ids.grant); assert.throws(()=>apply(db,artifact.provision.sql,artifact.provision.name,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE)); assert.deepEqual(row(db,"SELECT active,version FROM native_staff_admissions WHERE staff_id=?",owner.operationsStaffId),{active:0,version:2}); }
});

test("revoke requires no in-flight actor work and rolls back atomically", () => {
  const base=fixture(), db=database(); priorInactive(db,base); const artifact=buildOnboardingAuthorityArtifacts(base,input(),"revoke"); apply(db,artifact.provision.sql,artifact.provision.name,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE);
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='operations_directory_write_fences'").all()) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.prepare("INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes) VALUES('staging-onboarding-blocker','update',?,?,3,'directory.profile.edit','fixture-record','organization',1,?,'[]','{}','{}','[]',0)").run(owner.operationsStaffId,subject,artifact.ids.grant);
  assert.throws(()=>apply(db,artifact.revoke.sql,artifact.revoke.name,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(row(db,"SELECT active,version FROM native_staff_admissions WHERE staff_id=?",owner.operationsStaffId),{active:1,version:3});
  assert.deepEqual(row(db,"SELECT active FROM native_directory_grants WHERE id=?",artifact.ids.grant),{active:1});
});

test("builds a 140-migration, staging-only, sanitized, one-file packet", () => {
  const base=fixture(), artifact=buildOnboardingAuthorityArtifacts(base,input(),"revoke");
  assert.equal(artifact.provision.manifest.canonicalMigrationCount,140);
  assert.equal(artifact.provision.sql.includes("project.shared.sync"),false);
  assert.equal(artifact.provision.sql.includes("'business_area'"),true);
  assert.equal(JSON.stringify(artifact.provision.manifest).includes(subject),false);
  assert.equal(artifact.configs.provision.d1_databases.find(row=>row.binding==="OPS_DB").migrations_table,ONBOARDING_AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(writeOnboardingAuthority(base,artifact).length,6);
  assert.deepEqual(validateGeneratedOnboardingAuthority(base,artifact),[]);
});
