import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readClientInternalNotes } from "../src/worker/client-internal-notes";
import { resolveClientHubSourceRoot } from "../src/worker/client-hub-source";
import { writeNativeDirectoryProfile } from "../src/worker/native-directory-profile-writer";
import { drainNativeDirectoryOutboxes } from "../src/worker/native-directory-outbox-scheduler";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import { approveNativeOnlyClientOnboarding } from "../src/worker/native-directory-onboarding-write-composer";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

let runtime: Miniflare, db: D1Database, sequence = 1;
const sourceId = "project-alpha:staging";
const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const baseUrl = "https://pa-staging.example.test";
const requestId = "44444444-4444-4444-8444-444444444444";
const publicId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const actorId = "notes-native-reader";
const actor: StaffPrincipal = { id: actorId, email: "reader@example.test", displayName: "Reader",
  accessSubject: "access|notes-native-reader", projectAlphaUserId: null };
const connection = JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
  baseUrl, apiKey: "test-only", sourceInstanceId, applicationId, historyEpoch } } });
const env = (connections = connection): Pick<Env, "OPS_DB" | "DELIVERY_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> => ({
  OPS_DB: db, DELIVERY_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
});
const uid = () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json",
    "Cache-Control": "no-store", "X-Request-ID": requestId } });
}
function sourceTransport() {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/capabilities") return response({ apiVersion: "2", sourceInstanceId, applicationId,
      historyEpoch, requestId, grantedCapabilities: ["api.capabilities.read", "directory.clients.create"].map(name => ({ name })),
      implementedEndpoints: [
        { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: "directory.clients.create",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      ] });
    if (path !== "/api/v2/directory/clients/commands" || init?.method !== "POST")
      throw new Error(`Unexpected PA request ${init?.method ?? "GET"} ${path}`);
    const command = JSON.parse(String(init.body)) as { externalId: string };
    return response({ sourceInstanceId, applicationId, historyEpoch, requestId, replayed: false,
      result: { resource: { type: "client", id: command.externalId, publicId, revision: "1" },
        authorizationGeneration: "1" } }, 201);
  };
}
function acquisitionTransport(externalId: string, acquiredPublicId: string, seen: string[]) {
  let generation = "8", bound = true;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname;
    seen.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/v2/capabilities") return response({ apiVersion: "2", sourceInstanceId, applicationId,
      historyEpoch, requestId, grantedCapabilities: ["api.capabilities.read", "directory.clients.read",
        "directory.clients.binding_status.read", "directory.clients.bind"].map(name => ({ name })),
      implementedEndpoints: [
        { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "GET", path: "/api/v2/directory/clients/{publicId}", requiredCapability: "directory.clients.read",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "GET", path: "/api/v2/bindings/client/status/{base64urlExternalId}",
          requiredCapability: "directory.clients.binding_status.read", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "POST", path: "/api/v2/directory/clients/bindings/commands", requiredCapability: "directory.clients.bind",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
          requiresExpectedPublicId: true, requiresExpectedRevision: true },
      ] });
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== "Bearer test-only" || headers.get("X-PA-Source-Instance-ID") !== sourceInstanceId
      || headers.get("X-PA-Application-ID") !== applicationId || headers.get("X-PA-History-Epoch") !== historyEpoch)
      throw new Error("synthetic acquisition transport crossed the configured identity boundary");
    if (path === `/api/v2/directory/clients/${acquiredPublicId}`) return response({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch, requestId, authorizationGeneration: generation,
      resource: { type: "client", id: acquiredPublicId, revision: "7" }, data: { publicId: acquiredPublicId,
        name: "Native mapped client", email: "client@example.test", phone: null,
        address: { line1: "1 Main", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
        clientType: "business", organizationPublicId: null } });
    const statusPath = `/api/v2/bindings/client/status/${Buffer.from(externalId).toString("base64url")}`;
    if (path === statusPath) return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
      authorizationGeneration: generation, binding: { type: "client", externalId, publicId: acquiredPublicId,
        createdAt: "2026-10-01T12:00:00.000Z" }, resource: { revision: "7", present: bound } });
    if (path === "/api/v2/directory/clients/bindings/commands" && init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as Record<string, string>;
      if (command.externalId !== externalId || command.expectedPublicId !== acquiredPublicId
        || command.expectedRevision !== "7" || command.expectedAuthorizationGeneration !== "8")
        throw new Error("synthetic acquired mapping command changed reviewed identity");
      bound = true; generation = "9";
      return response({ sourceInstanceId, applicationId, historyEpoch, requestId, replayed: false,
        result: { binding: { publicId: acquiredPublicId }, resource: { type: "client", id: externalId, revision: "7" },
          authorizationGeneration: generation } });
    }
    throw new Error(`Unexpected acquisition request ${init?.method ?? "GET"} ${path}`);
  };
}
async function nativeClient(recordId: string) {
  const mutationId = uid(), createAdmissionId = `admission-${mutationId}`;
  const scopes = [{ businessAreaId: "area", divisionId: "division" }];
  const profile = { name: "Native mapped client", email: "client@example.test", phone: "", clientType: "business" as const,
    addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
  const destination = { sourceId, sourceInstanceUUID: sourceInstanceId, applicationUUID: applicationId,
    historyEpoch, origin: baseUrl, externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  await db.batch([
    db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,'client',?,?,?,?)`).bind(createAdmissionId, actorId, actor.accessSubject, recordId,
        JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ ...destination, expectedAuthorizationGeneration: undefined }]), actorId),
    db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id)
      VALUES(?,?)`).bind(createAdmissionId, recordId),
  ]);
  const result = await writeNativeDirectoryProfile(db, { operation: "create", mutationId, createAdmissionId, recordId,
    expectedLocalVersion: 0, kind: "client", profile, scopes, destinations: [destination],
    actor: { staffId: actorId, accessSubject: actor.accessSubject, loginEmail: actor.email,
      admissionVersion: 1, profileVersion: 1, selectedGrantId: `${actorId}-edit`, selectedIdentityGrantId: `${actorId}-identity` },
    relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } });
  if (result.status !== "written") throw new Error(`Native client create failed: ${result.status}`);
  return result;
}
async function nativeOnlyClient(recordId: string) {
  const scopes = [{ businessAreaId: "area", divisionId: "division" }];
  const profile = { name: "Native mapped client", email: "client@example.test", phone: "", clientType: "business" as const,
    addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
  const decisionId = uid(), invitationId = uid(), submissionId = uid(), issuanceCommandId = uid(), mutationId = uid();
  const fieldsSha256 = "a".repeat(64), verifiedUntil = new Date(Date.now() + 300_000).toISOString();
  const derived = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`${mutationId}\0client-relationship\0unlinked`))).slice(0, 16);
  derived[6] = (derived[6]! & 15) | 64; derived[8] = (derived[8]! & 63) | 128;
  const hex = [...derived].map(value => value.toString(16).padStart(2, "0")).join("");
  const relationshipMutationId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  await db.batch([
    db.prepare(`INSERT INTO client_onboarding_invitations
      (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version)
      VALUES(?,?,?,?,?,NULL,'pending',1)`).bind(invitationId, "b".repeat(64), actorId, actor.accessSubject,
        new Date(Date.now() + 3_600_000).toISOString()),
    db.prepare(`INSERT INTO client_onboarding_issuance_commands
      (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,issuer_profile_version,issuer_email,verified_until)
      VALUES(?,?,?,?,1,1,?,?)`).bind(invitationId, issuanceCommandId, "c".repeat(64), JSON.stringify(scopes), actor.email, verifiedUntil),
    db.prepare(`INSERT INTO client_onboarding_submissions(invitation_id,submission_id,fields_json,fields_sha256)
      VALUES(?,?,'{}',?)`).bind(invitationId, submissionId, fieldsSha256),
  ]);
  const outcome = await approveNativeOnlyClientOnboarding(db, {
    decisionId, invitationId, submissionId, fieldsSha256, requestSha256: "d".repeat(64), reason: "Approved local native client",
    reviewedFieldsJson: "{}", scopes, verifiedUntil, relationship: { mode: "change", expectedVersion: 0, mutationId: relationshipMutationId },
    profile: { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind: "client", createAdmissionId:
      `client-onboarding:${decisionId}:client`, profile, scopes, destinations: [],
    actor: { staffId: actorId, accessSubject: actor.accessSubject, admissionVersion: 1, profileVersion: 1,
      selectedGrantId: `${actorId}-edit`, loginEmail: actor.email, selectedIdentityGrantId: `${actorId}-identity` },
    relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } },
  });
  if (outcome.status !== "written") throw new Error(`Native-only client create failed: ${JSON.stringify(outcome)}`);
  expect(outcome).toMatchObject({ status: "written", clientRecordId: recordId, organizationRecordId: null, relationshipVersion: 1 });
  expect(await db.prepare("SELECT count(*) FROM project_alpha_directory_outbox WHERE external_id=?")
    .bind(recordId).first<number>("count(*)")).toBe(0);
  expect(await db.prepare("SELECT organization_record_id FROM operations_directory_client_organizations WHERE client_record_id=?")
    .bind(recordId).first("organization_record_id")).toBeNull();
  return outcome;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: "notes-native-ops" } });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) await db.batch([
    ...splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)),
    db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration),
  ]);
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(actorId, actor.email, actor.displayName, actor.accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(actorId, actor.accessSubject, actorId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(actorId, actor.email, actor.displayName),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.profile.edit','allow','global',1,?)`).bind(`${actorId}-edit`, actorId, actorId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.identity.link','allow','global',1,?)`).bind(`${actorId}-identity`, actorId, actorId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.enrollment.manage','allow','global',1,?)`).bind(`${actorId}-enrollment`, actorId, actorId),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${actorId}-owner-role`, actorId, actorId),
    db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES(?,?,'team.view','allow','global','global',?)`).bind(uid(), actorId, actorId),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Test area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Test division',1)"),
  ]);
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("native Directory roots in Client Hub internal-note proof", () => {
  it("requires the acknowledged exact active mapping and rechecks its canonical relationship proof", async () => {
    const recordId = `native-client-${uid()}`;
    const create = await nativeClient(recordId);
    const resolved = await resolveClientHubSourceRoot(env(), "standalone_client", recordId, sourceId);
    expect(resolved).toBeNull();
    const root: ClientHubCollectionContext["root"] = { source_id: sourceId as `project-alpha:${string}`,
      root_namespace: "business", kind: "standalone_client",
      public_id: recordId, pa_internal_id: recordId, pa_public_id: null, mapping_status: "missing" as const,
      display_name: "Native mapped client", source_name: "Project Alpha staging", sort_name: "Native mapped client",
      status: "active", portal_status: "mapping_unavailable", workspace_id: null, legacy_account_id: null,
      account_count: 0, project_count: 0, request_count: 0, contact_count: 0, meaningful_activity_at: null,
      source_version: null, indexed_at: "", scan_generation: 0 };
    const context: ClientHubCollectionContext = { root, paRootId: recordId,
      access: { directory: true, requests: false, delivery: false, viewer: false },
      contextVersion: "c".repeat(43), canonicalRoot: { sourceId, rootNamespace: "business",
        kind: "standalone_client", publicId: recordId } };
    await expect(readClientInternalNotes(env(), actor, context)).rejects.toMatchObject({ status: 404 });

    const drained = await drainNativeDirectoryOutboxes({ ...env(), NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true" },
      { send: sourceTransport(), rotationTime: Date.now() });
    expect(drained).toMatchObject({ status: "drained", attempted: 1, acknowledged: 1 });
    expect(await db.prepare(`SELECT state FROM project_alpha_directory_outbox WHERE command_id=?`)
      .bind(create.commandIds[0]).first("state")).toBe("acknowledged");
    const mapped = await resolveClientHubSourceRoot(env(), "standalone_client", recordId, sourceId);
    expect(mapped).toMatchObject({ id: recordId, pa_internal_id: recordId, pa_public_id: publicId, mapping_status: "mapped" });
    const currentContext: ClientHubCollectionContext = { ...context, root: { ...root, pa_internal_id: mapped!.pa_internal_id,
      pa_public_id: mapped!.pa_public_id, mapping_status: mapped!.mapping_status } };
    await expect(readClientInternalNotes(env(), actor, currentContext)).resolves.toMatchObject({
      canonicalRoot: { sourceId, rootNamespace: "business", kind: "standalone_client", publicId: recordId },
      notes: [], capabilities: { canManageNotes: true },
    });
    const wrongTuple = JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
      baseUrl, apiKey: "test-only", sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      applicationId, historyEpoch } } });
    await expect(readClientInternalNotes(env(wrongTuple), actor, currentContext)).rejects.toMatchObject({ status: 404 });
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES(?,?,'client.notes.manage','allow','global','global',?)`).bind(uid(), actorId, actorId).run();
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES(?,?,'client.notes.manage','deny','global','global',?)`).bind(uid(), actorId, actorId).run();
    await expect(readClientInternalNotes(env(), actor, currentContext)).resolves.toMatchObject({
      capabilities: { canManageNotes: false },
    });
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES(?,?,'team.view','deny','global','global',?)`).bind(uid(), actorId, actorId).run();
    await expect(readClientInternalNotes(env(), actor, currentContext)).rejects.toMatchObject({ status: 403 });
    await db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='team.view'")
      .bind(actorId).run();
  }, 60_000);

  it("accepts an acquired mapping where the Operations route ID differs from PA's external ID", async () => {
    const recordId = `acquired-client-${uid()}`, externalId = `pa/staging/client/${uid()}`;
    await nativeOnlyClient(recordId); // durable local canonical record without unrelated PA create work
    const grantGeneration = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(actorId).first<number>("generation");
    if (grantGeneration === null) throw new Error("native reviewer grant generation was not materialized");
    const acquiredPublicId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const requests: string[] = [], remote = acquisitionTransport(externalId, acquiredPublicId, requests);
    const acquired = await acquireProjectAlphaExistingDirectoryBinding(env(), { reviewId: uid(), commandId: uid(),
      sourceId, recordId, externalId, resourceType: "client", projectAlphaPublicId: acquiredPublicId,
      expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "8", localRecordVersion: 1,
      reviewer: { staffId: actorId, accessSubject: actor.accessSubject, admissionVersion: 1,
        profileVersion: 1, grantGeneration } }, remote);
    if (acquired.status !== "acquired") throw new Error(`Synthetic acquisition failed: ${JSON.stringify(acquired)}; requests=${JSON.stringify(requests)}`);
    expect(acquired).toMatchObject({ status: "acquired", replayed: false });
    await expect(activateProjectAlphaExistingDirectoryBinding(env(), { reviewItemId: acquired.reviewReceiptId,
      idempotencyKey: uid() }, { staffId: actorId, accessSubject: actor.accessSubject }, remote))
      .resolves.toMatchObject({ status: "activated", replayed: false, recordId });
    const mapped = await resolveClientHubSourceRoot(env(), "standalone_client", recordId, sourceId);
    expect(mapped).toMatchObject({ id: recordId, pa_internal_id: externalId, pa_public_id: acquiredPublicId,
      mapping_status: "mapped" });
    const root = { source_id: sourceId as `project-alpha:${string}`, root_namespace: "business" as const,
      kind: "standalone_client" as const, public_id: recordId, pa_internal_id: externalId,
      pa_public_id: acquiredPublicId, mapping_status: "mapped" as const, display_name: "Native mapped client",
      source_name: "Project Alpha staging", sort_name: "Native mapped client", status: "active",
      portal_status: "mapping_unavailable", workspace_id: null, legacy_account_id: null, account_count: 0,
      project_count: 0, request_count: 0, contact_count: 0, meaningful_activity_at: null, source_version: null,
      indexed_at: "", scan_generation: 0 };
    const context: ClientHubCollectionContext = { root, paRootId: externalId,
      access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "d".repeat(43),
      canonicalRoot: { sourceId, rootNamespace: "business", kind: "standalone_client", publicId: recordId } };
    await expect(readClientInternalNotes(env(), actor, context)).resolves.toMatchObject({
      canonicalRoot: { sourceId, rootNamespace: "business", kind: "standalone_client", publicId: recordId },
      notes: [], capabilities: { canManageNotes: false },
    });
  }, 60_000);
});
