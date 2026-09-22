import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  writeNativeDirectoryProfile,
  type NativeDirectoryDestinationAuthority,
  type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome,
} from "../src/worker/native-directory-profile-writer";

let runtime: Miniflare;
let db: D1Database;
let sequence = 1;
const sourceId = "project-alpha:primary";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const origin = "https://pa.example.test";
const organizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Standalone Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main Street", addressLine2: "Suite 2", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;

function uuid(): string { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function publicId(): string { return (sequence++).toString(16).padStart(32, "0"); }
function destination(recordId: string, expectedAuthorizationGeneration = "0"): NativeDirectoryDestinationAuthority {
  return { sourceId, sourceInstanceUUID, applicationUUID, historyEpoch, origin, externalCanonicalId: recordId, expectedAuthorizationGeneration };
}
async function seedActor(scope: "global" | "business_area" = "global") {
  const id = `actor-${sequence++}`, accessSubject = `access|${id}`, grantId = `grant-${id}`, identityGrantId = `identity-${id}`, loginEmail = `${id}@example.test`;
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')`).bind(id, loginEmail, id, accessSubject),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')`).bind(id, accessSubject),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)`).bind(id, loginEmail, id),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.profile.edit','allow',?,?,'owner')`).bind(grantId, id, scope, scope === "business_area" ? "area" : null),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.identity.link','allow',?,?,'owner')`).bind(identityGrantId, id, scope, scope === "business_area" ? "area" : null),
  ]);
  return { staffId: id, accessSubject, admissionVersion: 1, selectedGrantId: grantId,
    loginEmail, profileVersion: 1, selectedIdentityGrantId: identityGrantId } as const;
}
async function create(kind: "organization" | "client", actor?: Awaited<ReturnType<typeof seedActor>>, requestedRecordId?: string) {
  actor ??= await seedActor();
  const recordId = requestedRecordId ?? (kind === "client" ? uuid() : `ops/${kind}/${sequence++}`), mutationId = uuid();
  const input = { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind,
    profile: kind === "organization" ? organizationProfile : clientProfile, scopes: [{ businessAreaId: "area", divisionId: "division" }],
    destinations: [destination(recordId)], actor } as NativeDirectoryProfileWrite;
  const outcome = await writeNativeDirectoryProfile(db, input);
  return { input, outcome, actor };
}
function written(outcome: NativeDirectoryProfileWriteOutcome) {
  expect(outcome.status).toBe("written");
  if (outcome.status !== "written") throw new Error(`write failed: ${outcome.reason}`);
  return outcome;
}
async function acknowledgeCreate(input: NativeDirectoryProfileWrite, outcome: NativeDirectoryProfileWriteOutcome, generation = "1") {
  const result = written(outcome), id = publicId();
  for (const commandId of result.commandIds) {
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
      source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(sourceId, input.kind, input.recordId, id, sourceInstanceUUID, applicationUUID, historyEpoch, commandId).run();
    const response = { status: "acknowledged", response: { sourceInstanceId: sourceInstanceUUID, applicationId: applicationUUID,
      historyEpoch, result: { resource: { type: input.kind, publicId: id, revision: "1" }, authorizationGeneration: generation } } };
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`)
      .bind(JSON.stringify(response), commandId).run();
  }
  await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=? AND state='materialized'`).bind(input.mutationId).run();
  return id;
}
async function count(table: string): Promise<number> { return await db.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count") ?? -1; }

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0125").sort();
  for (const migration of migrations) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')`),
    db.prepare(`INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)`),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)`),
    db.prepare(`CREATE TABLE delivery_rows(id TEXT PRIMARY KEY,payload BLOB NOT NULL)`),
    db.prepare(`CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT NOT NULL,payload BLOB NOT NULL)`),
    db.prepare(`INSERT INTO delivery_rows VALUES('delivery',x'ff0080')`),
    db.prepare(`INSERT INTO delivery_public_links VALUES('link','https://public.example.test/keep',x'00ff80')`),
  ]);
}, 240_000);
afterAll(async () => { await runtime.dispose(); });

describe("canonical native Directory profile writer", () => {
  it("creates an organization through the authority fence and reserves one command per destination", async () => {
    const { input, outcome } = await create("organization"), result = written(outcome);
    expect(result).toMatchObject({ replayed: false, recordId: input.recordId, kind: "organization", version: 1 });
    expect(await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?`).bind(input.recordId).first())
      .toEqual({ record_kind: "organization", current_version: 1 });
    expect(await db.prepare(`SELECT profile_json FROM operations_directory_revisions WHERE record_id=?`).bind(input.recordId).first("profile_json"))
      .toBe(JSON.stringify(organizationProfile));
    expect(await db.prepare(`SELECT original_verified_access_subject FROM operations_directory_audit WHERE mutation_id=?`).bind(input.mutationId).first("original_verified_access_subject"))
      .toBe(input.actor.accessSubject);
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_intents WHERE mutation_id=?`).bind(input.mutationId).first("count"))
      .toBe(1);
    expect(await count("operations_directory_write_fences")).toBe(0);
  });

  it("creates a standalone client without placing parent relationship data in profile JSON", async () => {
    const { input, outcome } = await create("client"), result = written(outcome);
    const revision = await db.prepare(`SELECT profile_json FROM operations_directory_revisions WHERE record_id=?`).bind(input.recordId).first<string>("profile_json");
    expect(JSON.parse(revision!)).toEqual(clientProfile);
    expect(revision).not.toContain("organization");
    const command = await db.prepare(`SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?`).bind(result.commandIds[0]).first<string>("command_json");
    expect(JSON.parse(command!)).toMatchObject({ operation: "create", resourceType: "client", fields: { ...clientProfile, organizationPublicId: null } });
    expect(command).not.toContain('"organization":');
    expect(await db.prepare(`SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?`).bind(input.recordId).first())
      .toEqual({ organization_record_id: null, relationship_version: 1 });
    expect(await db.prepare(`SELECT evidence_kind FROM operations_directory_intent_relationship_dependencies WHERE client_record_id=?`).bind(input.recordId).first("evidence_kind"))
      .toBe("unlinked");
  });

  it("updates organization and client profiles from enrolled destinations and active mappings", async () => {
    for (const kind of ["organization", "client"] as const) {
      const seeded = await create(kind); await acknowledgeCreate(seeded.input, seeded.outcome);
      const mutationId = uuid(), profile = kind === "organization" ? { ...organizationProfile, name: "Updated Organization" }
        : { name: "Updated Client", email: clientProfile.email, phone: clientProfile.phone, addressLine1: clientProfile.addressLine1,
            addressLine2: clientProfile.addressLine2, city: clientProfile.city, state: clientProfile.state, postalCode: clientProfile.postalCode, country: clientProfile.country };
      const update = { operation: "update", mutationId, recordId: seeded.input.recordId, expectedLocalVersion: 1, kind, profile,
        destinations: [destination(seeded.input.recordId, "1")], actor: seeded.actor } as NativeDirectoryProfileWrite;
      const result = written(await writeNativeDirectoryProfile(db, update));
      expect(result.version).toBe(2);
      const command = JSON.parse((await db.prepare(`SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?`).bind(result.commandIds[0]).first<string>("command_json"))!);
      expect(command).toMatchObject({ operation: "update", expectedRevision: "1", expectedAuthorizationGeneration: "1", fields: profile });
    }
  });

  it("fails closed instead of silently unlinking a linked client during profile update", async () => {
    const actor = await seedActor(), organization = await create("organization", actor, uuid()), client = await create("client", actor);
    written(organization.outcome); written(client.outcome);
    const relationshipMutationId = uuid(), verifiedUntil = new Date(Date.now() + 60_000).toISOString();
    await db.batch([
      db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,
        previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
        organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until)
        VALUES(?,?,1,NULL,?,1,NULL,1,?,?,?,?,?,?)`).bind(relationshipMutationId, client.input.recordId, organization.input.recordId,
          actor.staffId, actor.accessSubject, actor.loginEmail, actor.admissionVersion, actor.profileVersion, verifiedUntil),
      db.prepare(`UPDATE operations_directory_client_organizations SET organization_record_id=?,relationship_version=2,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE client_record_id=? AND relationship_version=1`)
        .bind(organization.input.recordId, client.input.recordId),
      db.prepare(`DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?`).bind(relationshipMutationId),
    ]);
    await expect(writeNativeDirectoryProfile(db, { operation: "update", mutationId: uuid(), recordId: client.input.recordId,
      expectedLocalVersion: 1, kind: "client", profile: { name: clientProfile.name, email: clientProfile.email, phone: clientProfile.phone,
        addressLine1: clientProfile.addressLine1, addressLine2: clientProfile.addressLine2, city: clientProfile.city, state: clientProfile.state,
        postalCode: clientProfile.postalCode, country: clientProfile.country }, destinations: [destination(client.input.recordId, "1")], actor }))
      .resolves.toEqual({ status: "blocked", reason: "client_relationship_linked_out_of_scope" });
  });

  it("resolves acquired active mappings from activation or same-local-version refresh evidence", async () => {
    for (const refreshed of [false, true]) {
      const seeded = await create("organization"), activePublicId = publicId(), expectedGeneration = refreshed ? "8" : "7";
      const fake = (row: Record<string, unknown> | null) => ({ bind() { return this; }, async first() { return row; } }) as D1PreparedStatement;
      const acquired = new Proxy(db, { get(target, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("state<>'acknowledged' LIMIT 1")) return fake(null);
          if (sql.includes("FROM project_alpha_active_directory_mappings")) return fake({ projectAlphaPublicId: activePublicId, mappingKind: "acquired", provenanceId: "activation-fixture" });
          if (sql.includes("FROM project_alpha_existing_directory_binding_revision_refresh_receipts"))
            return fake(refreshed ? { revision: "4", authorizationGeneration: "8" } : null);
          if (sql.includes("FROM project_alpha_existing_directory_binding_activation_receipts")) return fake({ revision: "3" });
          return target.prepare(sql);
        };
        const member = target[property as keyof D1Database]; return typeof member === "function" ? member.bind(target) : member;
      } }) as D1Database;
      const result = written(await writeNativeDirectoryProfile(acquired, { operation: "update", mutationId: uuid(), recordId: seeded.input.recordId,
        expectedLocalVersion: 1, kind: "organization", profile: { ...organizationProfile, name: refreshed ? "Refreshed" : "Activated" },
        destinations: [destination(seeded.input.recordId, expectedGeneration)], actor: seeded.actor }));
      const command = JSON.parse((await db.prepare(`SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?`)
        .bind(result.commandIds[0]).first<string>("command_json"))!);
      expect(command).toMatchObject({ expectedProjectAlphaPublicId: activePublicId, expectedRevision: refreshed ? "4" : "3",
        expectedAuthorizationGeneration: expectedGeneration });
    }
  });

  it("rejects stale local versions without reserving any rows", async () => {
    const seeded = await create("organization"), before = await count("operations_directory_materializations");
    await expect(writeNativeDirectoryProfile(db, { operation: "update", mutationId: uuid(), recordId: seeded.input.recordId,
      expectedLocalVersion: 9, kind: "organization", profile: organizationProfile, destinations: [destination(seeded.input.recordId, "1")], actor: seeded.actor }))
      .resolves.toEqual({ status: "conflict", reason: "stale_local_version" });
    expect(await count("operations_directory_materializations")).toBe(before);
  });

  it("replays an exact idempotent body and conflicts on mutation-ID body reuse", async () => {
    const seeded = await create("organization"), initial = written(seeded.outcome);
    expect(await writeNativeDirectoryProfile(db, seeded.input)).toEqual({ ...initial, replayed: true });
    await expect(writeNativeDirectoryProfile(db, { ...seeded.input, profile: { ...organizationProfile, name: "Different" } } as NativeDirectoryProfileWrite))
      .resolves.toEqual({ status: "conflict", reason: "idempotency_body_conflict" });
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_revisions WHERE record_id=?`).bind(seeded.input.recordId).first("count")).toBe(1);
  });

  it("fails closed on admission drift and a scope-matching deny", async () => {
    const actor = await seedActor("business_area"), first = await create("organization", actor); written(first.outcome);
    await db.prepare(`UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id=?`).bind(actor.staffId).run();
    const blockedAdmission = await create("organization", { ...actor, admissionVersion: 1 });
    expect(blockedAdmission.outcome).toEqual({ status: "blocked", reason: "native_directory_authority" });
    const denyActor = await seedActor("business_area");
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.profile.edit','deny','business_area','area','owner')`).bind(`deny-${denyActor.staffId}`, denyActor.staffId).run();
    const blockedDeny = await create("client", denyActor);
    expect(blockedDeny.outcome).toEqual({ status: "blocked", reason: "native_directory_authority" });
  });

  it("rolls back every guarded write when a late materialization statement fails", async () => {
    const actor = await seedActor(), recordId = `ops/organization/${sequence++}`, mutationId = uuid(), value = { operation: "create", mutationId,
      recordId, expectedLocalVersion: 0, kind: "organization", profile: organizationProfile,
      scopes: [{ businessAreaId: "area", divisionId: "division" }], destinations: [destination(recordId)], actor } as NativeDirectoryProfileWrite;
    let prepared = 0;
    const failing = new Proxy(db, { get(target, property) {
      if (property === "prepare") return (sql: string) => { prepared++; return target.prepare(prepared === 8 ? "INSERT INTO missing_late_table VALUES(1)" : sql); };
      const member = target[property as keyof D1Database]; return typeof member === "function" ? member.bind(target) : member;
    } }) as D1Database;
    await expect(writeNativeDirectoryProfile(failing, value)).resolves.toEqual({ status: "blocked", reason: "authority_or_atomic_write" });
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_records WHERE record_id=?`).bind(recordId).first("count")).toBe(0);
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_audit WHERE mutation_id=?`).bind(mutationId).first("count")).toBe(0);
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_directory_outbox WHERE external_id=?`).bind(recordId).first("count")).toBe(0);
  });

  it("serializes concurrent expected-version writers so exactly one commits", async () => {
    const seeded = await create("organization"); await acknowledgeCreate(seeded.input, seeded.outcome);
    const write = (name: string) => writeNativeDirectoryProfile(db, { operation: "update", mutationId: uuid(), recordId: seeded.input.recordId,
      expectedLocalVersion: 1, kind: "organization", profile: { ...organizationProfile, name }, destinations: [destination(seeded.input.recordId, "1")], actor: seeded.actor });
    const results = await Promise.all([write("Concurrent A"), write("Concurrent B")]);
    expect(results.filter(result => result.status === "written")).toHaveLength(1);
    expect(results.filter(result => result.status !== "written")).toHaveLength(1);
    expect(await db.prepare(`SELECT current_version FROM operations_directory_records WHERE record_id=?`).bind(seeded.input.recordId).first("current_version")).toBe(2);
  });

  it("preserves legacy mappings and unrelated Delivery/public-link rows byte-for-byte", async () => {
    const seeded = await create("organization"); await acknowledgeCreate(seeded.input, seeded.outcome);
    const beforeMapping = await db.prepare(`SELECT * FROM project_alpha_directory_mappings WHERE external_id=?`).bind(seeded.input.recordId).first();
    const beforeDelivery = await db.prepare(`SELECT hex(payload) payload FROM delivery_rows WHERE id='delivery'`).first();
    const beforeLink = await db.prepare(`SELECT url,hex(payload) payload FROM delivery_public_links WHERE id='link'`).first();
    written(await writeNativeDirectoryProfile(db, { operation: "update", mutationId: uuid(), recordId: seeded.input.recordId,
      expectedLocalVersion: 1, kind: "organization", profile: { ...organizationProfile, city: "Dallas" },
      destinations: [destination(seeded.input.recordId, "1")], actor: seeded.actor }));
    expect(await db.prepare(`SELECT * FROM project_alpha_directory_mappings WHERE external_id=?`).bind(seeded.input.recordId).first()).toEqual(beforeMapping);
    expect(await db.prepare(`SELECT hex(payload) payload FROM delivery_rows WHERE id='delivery'`).first()).toEqual(beforeDelivery);
    expect(await db.prepare(`SELECT url,hex(payload) payload FROM delivery_public_links WHERE id='link'`).first()).toEqual(beforeLink);
  });
});
