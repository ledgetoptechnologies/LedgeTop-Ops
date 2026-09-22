import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryProfileWrite } from "../src/worker/native-directory-profile-writer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";

let runtime: Miniflare, db: D1Database, sequence = 1;
const sourceId = "project-alpha:primary", source = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
const baseUrl = "https://pa.example.test", requestId = "44444444-4444-4444-8444-444444444444";
const organizationProfile = { name: "Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "Texas", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;
const env = (overrides: Record<string, unknown> = {}) => ({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
  [sourceId]: { sourceId, enabled: true, baseUrl, apiKey: "secret", sourceInstanceId: source, applicationId: application, historyEpoch: epoch },
} }), ...overrides });
function uuid() { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId,
} }); }
function capabilities() {
  const endpoints = (["organizations", "clients"] as const).flatMap(plural => [
    { method: "POST", path: `/api/v2/directory/${plural}/commands`, requiredCapability: `directory.${plural}.create`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/profile/commands`, requiredCapability: `directory.${plural}.write`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
  ]);
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId,
    grantedCapabilities: ["api.capabilities.read", "directory.organizations.create", "directory.organizations.write", "directory.clients.create", "directory.clients.write"].map(name => ({ name })),
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...endpoints] };
}
function transport(publicId: string, generation: string, posts: unknown[], failure?: number, expire?: () => Promise<void>) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const kind = path.includes("/clients") ? "client" : "organization";
    const update = path.includes("/profile/commands");
    if (path.endsWith("/capabilities")) return json(capabilities());
    const body = JSON.parse(String(init?.body)); posts.push(body); if (expire) await expire();
    if (failure) return json({}, failure);
    return json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false,
      result: { resource: update ? { type: kind, publicId, revision: "2" }
        : { type: kind, id: body.externalId, publicId, revision: "1" }, authorizationGeneration: generation } }, update ? 200 : 201);
  });
}
async function actor() {
  const staffId = `staff-${sequence++}`, accessSubject = `access|${staffId}`, loginEmail = `${staffId}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')").bind(staffId, loginEmail, staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')").bind(staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId, loginEmail, staffId),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.edit','allow','global','owner')").bind(`edit-${staffId}`, staffId),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.identity.link','allow','global','owner')").bind(`identity-${staffId}`, staffId),
  ]);
  return { staffId, accessSubject, admissionVersion: 1, selectedGrantId: `edit-${staffId}`, loginEmail, profileVersion: 1, selectedIdentityGrantId: `identity-${staffId}` };
}
async function create(kind: "organization" | "client") {
  const staff = await actor(), recordId = kind === "client" ? uuid() : `ops/org/${sequence++}`, mutationId = uuid();
  const input = { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind,
    profile: kind === "client" ? clientProfile : organizationProfile, scopes: [{ businessAreaId: "area", divisionId: "division" }],
    destinations: [{ sourceId, sourceInstanceUUID: source, applicationUUID: application, historyEpoch: epoch, origin: baseUrl,
      externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" }], actor: staff } as NativeDirectoryProfileWrite;
  const result = await writeNativeDirectoryProfile(db, input); if (result.status !== "written") throw new Error(result.reason);
  return { input, staff, commandId: result.commandIds[0]! };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const migration of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0131").sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)"),
    db.prepare("CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT,payload BLOB)"),
    db.prepare("INSERT INTO delivery_public_links VALUES('keep','https://public.example.test/keep',x'00ff80')"),
  ]);
}, 240_000);
afterAll(async () => runtime.dispose());

describe("native Directory profile outbox dispatcher", () => {
  it("creates organizations and standalone clients with exact API-v2 bodies, atomically settles, and replays", async () => {
    for (const kind of ["organization", "client"] as const) {
      const value = await create(kind), posts: unknown[] = [], publicId = (sequence++).toString(16).padStart(32, "0");
      const send = transport(publicId, "1", posts);
      const first = await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, value.commandId, send);
      if (first.status !== "acknowledged") throw new Error(JSON.stringify({ first, calls: send.mock.calls.map(([url]) => String(url)) }));
      expect(first).toEqual({ status: "acknowledged", commandId: value.commandId, replayed: false, publicId, revision: "1" });
      expect(posts).toEqual([kind === "organization"
        ? { commandId: value.commandId, externalId: value.input.recordId, expectedAuthorizationGeneration: "0", profile: organizationProfile }
        : { commandId: value.commandId, externalId: value.input.recordId, expectedAuthorizationGeneration: "0", profile: clientProfile, organization: null }]);
      expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id=?").bind(value.commandId).first("state")).toBe("acknowledged");
      expect(await db.prepare("SELECT state FROM operations_directory_intents WHERE mutation_id=?").bind(value.input.mutationId).first("state")).toBe("acknowledged");
      expect(await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first("project_alpha_public_id")).toBe(publicId);
      const noSend = vi.fn<typeof fetch>();
      await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, value.commandId, noSend)).resolves.toMatchObject({ status: "acknowledged", replayed: true });
      expect(noSend).not.toHaveBeenCalled();
    }
  });

  it("retries an uncertain request with the same command and safely terminalizes a trusted conflict", async () => {
    const retry = await create("organization"), firstBodies: unknown[] = [];
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, retry.commandId, transport("a".repeat(32), "1", firstBodies, 500)))
      .resolves.toMatchObject({ status: "uncertain", reason: "http_status", httpStatus: 500 });
    expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id=?").bind(retry.commandId).first("state")).toBe("pending");
    await db.prepare("UPDATE project_alpha_directory_outbox SET next_attempt_at=0 WHERE command_id=?").bind(retry.commandId).run();
    const secondBodies: unknown[] = [];
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, retry.commandId, transport("a".repeat(32), "1", secondBodies)))
      .resolves.toMatchObject({ status: "acknowledged" });
    expect(secondBodies).toEqual(firstBodies);

    const conflict = await create("organization"), posts: unknown[] = [];
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, conflict.commandId, transport("b".repeat(32), "1", posts, 409)))
      .resolves.toMatchObject({ status: "conflict", reason: "remote", httpStatus: 409 });
    expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id=?").bind(conflict.commandId).first("state")).toBe("terminal");
    const noSend = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, conflict.commandId, noSend)).resolves.toMatchObject({ status: "conflict", reason: "remote" });
    expect(noSend).not.toHaveBeenCalled();
  });

  it("updates legacy organization and standalone-client mappings with exact profile bodies and no mapping or public-link rewrite", async () => {
    for (const kind of ["organization", "client"] as const) {
      const value = await create(kind), publicId = (sequence++).toString(16).padStart(32, "0");
      await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, value.commandId, transport(publicId, "1", []));
      const beforeMapping = await db.prepare("SELECT * FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first();
      const beforeLink = await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first();
      const profile = kind === "organization" ? { ...organizationProfile, name: "Updated Organization" }
        : { name: "Updated Client", email: clientProfile.email, phone: clientProfile.phone, addressLine1: clientProfile.addressLine1,
            addressLine2: clientProfile.addressLine2, city: clientProfile.city, state: clientProfile.state,
            postalCode: clientProfile.postalCode, country: clientProfile.country };
      const mutationId = uuid(), result = await writeNativeDirectoryProfile(db, { operation: "update", mutationId,
        recordId: value.input.recordId, expectedLocalVersion: 1, kind, profile,
        destinations: [{ sourceId, sourceInstanceUUID: source, applicationUUID: application, historyEpoch: epoch, origin: baseUrl,
          externalCanonicalId: value.input.recordId, expectedAuthorizationGeneration: "1" }], actor: value.staff } as NativeDirectoryProfileWrite);
      if (result.status !== "written") throw new Error(result.reason);
      const posts: unknown[] = [];
      await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, result.commandIds[0]!, transport(publicId, "2", posts)))
        .resolves.toMatchObject({ status: "acknowledged", publicId, revision: "2" });
      expect(posts).toEqual([{ commandId: result.commandIds[0], expectedRevision: "1", expectedAuthorizationGeneration: "1", profile }]);
      expect(await db.prepare("SELECT * FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first()).toEqual(beforeMapping);
      expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE external_id=?").bind(value.input.recordId).first("n")).toBe(1);
      expect(await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first()).toEqual(beforeLink);
    }
  });

  it("updates an acquired active mapping without synthesizing legacy state and uses its acknowledgement for the next edit", async () => {
    const value = await create("organization"), publicId = "d".repeat(32);
    const acknowledgedCreate = JSON.stringify({ status: "acknowledged", response: { sourceInstanceId: source, applicationId: application,
      historyEpoch: epoch, result: { resource: { type: "organization", id: value.input.recordId, publicId, revision: "1" }, authorizationGeneration: "1" } } });
    await db.batch([
      db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='fixture',lease_expires_at=9999999999999 WHERE command_id=?").bind(value.commandId),
      db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?").bind(acknowledgedCreate, value.commandId),
      db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=?").bind(value.input.mutationId),
    ]);
    const fake = (result: Record<string, unknown> | null) => ({ bind() { return this; }, async first() { return result; } }) as D1PreparedStatement;
    const acquired = new Proxy(db, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("FROM project_alpha_active_directory_mappings")) return fake({ project_alpha_public_id: publicId,
          projectAlphaPublicId: publicId, mapping_kind: "acquired", mappingKind: "acquired", provenanceId: "activation" });
        if (sql.includes("FROM project_alpha_existing_directory_binding_revision_refresh_receipts")) return fake(null);
        if (sql.includes("FROM project_alpha_existing_directory_binding_activation_receipts")) return fake({ revision: "1" });
        return target.prepare(sql);
      };
      const member = target[property as keyof D1Database]; return typeof member === "function" ? member.bind(target) : member;
    } }) as D1Database;
    const firstProfile = { ...organizationProfile, city: "Dallas" }, firstMutation = uuid();
    const first = await writeNativeDirectoryProfile(acquired, { operation: "update", mutationId: firstMutation, recordId: value.input.recordId,
      expectedLocalVersion: 1, kind: "organization", profile: firstProfile,
      destinations: [{ sourceId, sourceInstanceUUID: source, applicationUUID: application, historyEpoch: epoch, origin: baseUrl,
        externalCanonicalId: value.input.recordId, expectedAuthorizationGeneration: "1" }], actor: value.staff } as NativeDirectoryProfileWrite);
    if (first.status !== "written") throw new Error(first.reason);
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand({ ...env(), OPS_DB: acquired }, sourceId, first.commandIds[0]!, transport(publicId, "2", [])))
      .resolves.toMatchObject({ status: "acknowledged", revision: "2" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE external_id=?").bind(value.input.recordId).first("n")).toBe(0);

    const second = await writeNativeDirectoryProfile(acquired, { operation: "update", mutationId: uuid(), recordId: value.input.recordId,
      expectedLocalVersion: 2, kind: "organization", profile: { ...firstProfile, city: "Houston" },
      destinations: [{ sourceId, sourceInstanceUUID: source, applicationUUID: application, historyEpoch: epoch, origin: baseUrl,
        externalCanonicalId: value.input.recordId, expectedAuthorizationGeneration: "2" }], actor: value.staff } as NativeDirectoryProfileWrite);
    if (second.status !== "written") throw new Error(second.reason);
    expect(JSON.parse((await db.prepare("SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?")
      .bind(second.commandIds[0]).first<string>("command_json"))!)).toMatchObject({ expectedProjectAlphaPublicId: publicId,
        expectedRevision: "2", expectedAuthorizationGeneration: "2" });
  });

  it("rechecks identity and current authority, and an expired settlement lease makes no partial acknowledgement", async () => {
    const revoked = await create("organization"), noSend = vi.fn<typeof fetch>();
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id=?").bind(revoked.staff.staffId).run();
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, revoked.commandId, noSend)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noSend).not.toHaveBeenCalled();

    const value = await create("organization"), beforeLink = await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first();
    const posts: unknown[] = [];
    const expired = transport("c".repeat(32), "1", posts, undefined, async () => {
      await db.prepare("UPDATE project_alpha_directory_outbox SET lease_expires_at=0 WHERE command_id=?").bind(value.commandId).run();
    });
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, value.commandId, expired)).resolves.toEqual({ status: "uncertain", reason: "lost_lease" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM operations_directory_intents WHERE mutation_id=?").bind(value.input.mutationId).first("state")).toBe("materialized");
    expect(await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first()).toEqual(beforeLink);
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, value.commandId, transport("c".repeat(32), "1", [])))
      .resolves.toMatchObject({ status: "acknowledged" });

    const mismatch = await create("organization");
    const wrong = JSON.parse(env().PROJECT_ALPHA_API_V2_CONNECTIONS); wrong.instances[sourceId].applicationId = "99999999-9999-4999-8999-999999999999";
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env({ PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify(wrong) }), sourceId, mismatch.commandId, noSend))
      .resolves.toEqual({ status: "blocked", reason: "destination" });
  });
});
