import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";

let runtime: Miniflare, db: D1Database, sequence = 1;
const sourceId = "project-alpha:primary", source = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
const baseUrl = "https://pa.example.test", requestId = "44444444-4444-4444-8444-444444444444";
const organizationProfile = { name: "Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "Texas", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;
const env = (overrides: Record<string, unknown> = {}, configuredSourceId = sourceId) => ({ OPS_DB: db,
  PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    [configuredSourceId]: { sourceId: configuredSourceId, enabled: true, baseUrl, apiKey: "secret", sourceInstanceId: source,
      applicationId: application, historyEpoch: epoch },
  } }), ...overrides });
function uuid() { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId,
} }); }
function capabilities(extraGrantedCapabilities: string[] = []) {
  const endpoints = (["organizations", "clients"] as const).flatMap(plural => [
    { method: "POST", path: `/api/v2/directory/${plural}/commands`, requiredCapability: `directory.${plural}.create`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/profile/commands`, requiredCapability: `directory.${plural}.write`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
  ]);
  if (extraGrantedCapabilities.includes("directory.clients.organization.assign")) endpoints.push({
    method: "POST", path: "/api/v2/directory/clients/{publicId}/organization/assign/commands",
    requiredCapability: "directory.clients.organization.assign", requiresSourceInstanceId: true,
    requiresApplicationId: true, requiresHistoryEpoch: true,
  });
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId,
    grantedCapabilities: [...new Set(["api.capabilities.read", "directory.organizations.create", "directory.organizations.write", "directory.clients.create", "directory.clients.write", ...extraGrantedCapabilities])].map(name => ({ name })),
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...endpoints] };
}
function transport(publicId: string, generation: string, posts: unknown[], failure?: number, expire?: () => Promise<void>,
  responseRevision = "2", replayed = false, extraGrantedCapabilities: string[] = []) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const kind = path.includes("/clients") ? "client" : "organization";
    const update = path.includes("/profile/commands");
    if (path.endsWith("/capabilities")) return json(capabilities(extraGrantedCapabilities));
    const body = JSON.parse(String(init?.body)); posts.push(body); if (expire) await expire();
    if (failure) return json({}, failure);
    return json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed,
      result: { resource: update ? { type: kind, publicId, revision: responseRevision }
        : { type: kind, id: body.externalId, publicId, revision: "1" }, authorizationGeneration: generation } }, update ? 200 : 201);
  });
}
async function actor(scope: "global" | "business_area" = "global", businessAreaId = "area") {
  const staffId = `staff-${sequence++}`, accessSubject = `access|${staffId}`, loginEmail = `${staffId}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')").bind(staffId, loginEmail, staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')").bind(staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId, loginEmail, staffId),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,'directory.profile.edit','allow',?,?,'owner')")
      .bind(`edit-${staffId}`, staffId, scope, scope === "business_area" ? businessAreaId : null),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,'directory.identity.link','allow',?,?,'owner')")
      .bind(`identity-${staffId}`, staffId, scope, scope === "business_area" ? businessAreaId : null),
  ]);
  return { staffId, accessSubject, admissionVersion: 1, selectedGrantId: `edit-${staffId}`, loginEmail, profileVersion: 1, selectedIdentityGrantId: `identity-${staffId}` };
}
async function create(kind: "organization" | "client", organizationRecordId: string | null = null, requestedRecordId?: string,
  requestedClientProfile: typeof clientProfile = clientProfile,
  grantScope: "global" | "business_area" = "global",
  requestedScopes: readonly { businessAreaId: string; divisionId: string | null }[] = [{ businessAreaId: "area", divisionId: "division" }],
  destinationSourceId = sourceId) {
  const staff = await actor(grantScope, requestedScopes[0]?.businessAreaId ?? "area"), recordId = requestedRecordId ?? (kind === "client" ? uuid() : `ops/org/${sequence++}`), mutationId = uuid();
  const createAdmissionId = `admission-${mutationId}`;
  const input = { operation: "create", mutationId, createAdmissionId, recordId, expectedLocalVersion: 0, kind,
    profile: kind === "client" ? requestedClientProfile : organizationProfile, scopes: requestedScopes,
    destinations: [{ sourceId: destinationSourceId, sourceInstanceUUID: source, applicationUUID: application, historyEpoch: epoch, origin: baseUrl,
      externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" }], actor: staff,
    ...(kind === "client" ? { relationship: { organizationRecordId, expectedRelationshipVersion: 0 } } : {}) } as NativeDirectoryCreateWrite;
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, staff.staffId, staff.accessSubject, recordId, kind,
      JSON.stringify(input.scopes), JSON.stringify(input.profile), JSON.stringify(input.destinations.map(({ expectedAuthorizationGeneration: _, ...value }) => value)), staff.staffId).run();
  if (kind === "client") {
    const organizationRecordVersion = organizationRecordId === null ? null
      : await db.prepare("SELECT current_version FROM operations_directory_records WHERE record_id=? AND record_kind='organization'")
        .bind(organizationRecordId).first<number>("current_version");
    await db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,?)`)
      .bind(createAdmissionId, recordId, organizationRecordId, organizationRecordVersion).run();
  }
  const result = await writeNativeDirectoryProfile(db, input); if (result.status !== "written") throw new Error(result.reason);
  return { input, staff, commandId: result.commandIds[0]! };
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0203").sort();
  await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
  for (const migration of migrations) await db.batch([
    ...splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)),
    db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration),
  ]);
  expect((await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map(row => row.name))
    .toEqual(migrations);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
    .toBe("0203_effective_native_directory_enrollment_consumers.sql");
  expect(await db.prepare("SELECT count(*) FROM d1_migrations").first("count(*)")).toBe(203);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)"),
    db.prepare("CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT,payload BLOB)"),
    db.prepare("INSERT INTO delivery_public_links VALUES('keep','https://public.example.test/keep',x'00ff80')"),
  ]);
}, 240_000);
afterAll(async () => runtime.dispose());


describe("linked client conditional organization-assignment scope", () => {
  it.each(["missing-scope", "scope-revoked-before-post"] as const)("preserves pending authority and retries exact command after %s", async failure => {
    const parent = await create("organization", null, uuid());
    const parentPublicId = uuid().replaceAll("-", ""), clientPublicId = uuid().replaceAll("-", "");
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, parent.commandId,
      transport(parentPublicId, "1", []))).resolves.toMatchObject({ status: "acknowledged" });
    const client = await create("client", parent.input.recordId), posts: unknown[] = [];
    const enrollmentBefore = await db.prepare("SELECT * FROM effective_native_directory_enrollments WHERE record_id=?")
      .bind(client.input.recordId).first();
    const commandBefore = await db.prepare("SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?")
      .bind(client.commandId).first<string>("command_json");
    const granted = failure === "missing-scope" ? [] : ["directory.clients.organization.assign"];
    const send = transport(clientPublicId, "1", posts, failure === "missing-scope" ? undefined : 403,
      undefined, "2", false, granted);
    const denied = await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, client.commandId, send);
    expect(denied).toMatchObject({ status: "uncertain" });
    if (failure === "missing-scope") {
      expect(denied).toMatchObject({ reason: "preflight:unauthorized:missing_capability" });
      expect(posts).toEqual([]);
    } else {
      expect(denied).toMatchObject({ httpStatus: 403 });
      expect(posts).toHaveLength(1);
    }
    expect(await db.prepare("SELECT state,lease_token,outcome_json,command_json FROM project_alpha_directory_outbox WHERE command_id=?")
      .bind(client.commandId).first()).toEqual({ state: "pending", lease_token: null, outcome_json: null, command_json: commandBefore });
    expect(await db.prepare("SELECT COUNT(*) n FROM project_alpha_directory_mappings WHERE command_id=?")
      .bind(client.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT * FROM effective_native_directory_enrollments WHERE record_id=?")
      .bind(client.input.recordId).first()).toEqual(enrollmentBefore);
    await db.prepare("UPDATE project_alpha_directory_outbox SET next_attempt_at=0 WHERE command_id=?").bind(client.commandId).run();
    const acceptedPosts: unknown[] = [];
    const grantedOnly = transport(clientPublicId, "1", acceptedPosts, undefined, undefined, "2", false,
      ["directory.clients.organization.assign"]);
    // The PA create grant is sufficient even when standalone relationship routes are disabled.
    const grantWithoutRelationshipEndpoint: typeof fetch = async (url, init) => {
      const response = await grantedOnly(url, init);
      if (!String(url).endsWith("/capabilities")) return response;
      const body = await response.json() as ReturnType<typeof capabilities>;
      body.implementedEndpoints = body.implementedEndpoints.filter(endpoint => !endpoint.path.includes("/organization/assign/"));
      return json(body);
    };
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, client.commandId, grantWithoutRelationshipEndpoint))
      .resolves.toMatchObject({ status: "acknowledged", publicId: clientPublicId, revision: "1" });
    expect(acceptedPosts).toHaveLength(1);
    if (posts.length) expect(acceptedPosts[0]).toEqual(posts[0]);
    expect(acceptedPosts[0]).toMatchObject({ commandId: client.commandId, organization: { externalId: parent.input.recordId, expectedRevision: "1" } });
    expect(await db.prepare("SELECT COUNT(*) n FROM project_alpha_directory_mappings WHERE command_id=?")
      .bind(client.commandId).first("n")).toBe(1);
    const noSend = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, client.commandId, noSend))
      .resolves.toMatchObject({ status: "acknowledged", replayed: true });
    expect(noSend).not.toHaveBeenCalled();
  });
});

