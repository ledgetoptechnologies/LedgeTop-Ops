import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), connection: vi.fn(), writer: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.authenticate }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: mocks.connection }));
vi.mock("../src/worker/native-directory-profile-writer", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/worker/native-directory-profile-writer")>();
  return { ...actual, writeNativeDirectoryProfile: mocks.writer };
});
import { NATIVE_DIRECTORY_PROFILE_ROUTE, registerNativeDirectoryProfileRoutes } from "../src/worker/native-directory-profile-routes";

const principal: StaffPrincipal = { id: "staff-one", email: "staff@example.test", displayName: "Staff",
  accessSubject: "staff-subject", projectAlphaUserId: null };
const ids = { mutation: "11111111-1111-4111-8111-111111111111", client: "22222222-2222-4222-8222-222222222222",
  instance: "33333333-3333-4333-8333-333333333333", application: "44444444-4444-4444-8444-444444444444",
  epoch: "55555555-5555-4555-8555-555555555555", command: "66666666-6666-4666-8666-666666666666" };
const sourceId = "project-alpha:primary", origin = "https://pa.example.test";
const scopes = [{ businessAreaId: "drone", divisionId: null }];
const organization = { name: "Example Org", generalEmail: "ops@example.test", generalPhone: "", addressLine1: "",
  addressLine2: "", city: "", state: "", postalCode: "", country: "" };
const client = { name: "Example Client", email: "client@example.test", phone: "", clientType: "consumer" as const,
  addressLine1: "", addressLine2: "", city: "", state: "WI", postalCode: "", country: "" };

type Row = Record<string, unknown>;
function database(options: { enrollment?: unknown; outboxState?: string; deny?: string; missingGeneration?: boolean;
  admission?: false; connectorActive?: false; replay?: "exact" | "conflict"; linked?: boolean } = {}) {
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async all<T>() {
        if (sql.includes("operations_directory_materializations")) return { results: [{ command_id: ids.command }] as T[] };
        if (sql.includes("effect='allow'")) {
          const permission = String(values[1]);
          return { results: [{ id: permission === "directory.identity.link" ? "identity-grant" : "edit-grant",
            scope_kind: "global", business_area_id: null, division_id: null, resource_id: null }] as T[] };
        }
        if (sql.includes("effect='deny'")) {
          const permission = String(values[1]);
          return { results: options.deny === permission ? [{ id: "deny", scope_kind: "global",
            business_area_id: null, division_id: null, resource_id: null }] as T[] : [] };
        }
        if (sql.includes("native_directory_resource_scopes")) return { results: scopes as T[] };
        return { results: [] as T[] };
      },
      async first<T>(column?: string): Promise<T | null> {
        let value: unknown = null;
        if (sql.includes("SELECT grant.id")) value = options.deny === String(values[1]) ? null
          : { id: String(values[1]) === "directory.identity.link" ? "identity-grant" : "edit-grant" };
        else if (sql.includes("operations_directory_audit audit") && options.replay) value = {
          command_json: JSON.stringify({ operation: "create", mutationId: ids.mutation, resourceType: "organization",
            recordId: ids.mutation, expectedLocalVersion: 0, actor: {},
            fields: options.replay === "conflict" ? { ...organization, name: "Different" } : organization,
            scopes, destinations: [{ sourceId }] }), actor_id: principal.id,
          original_verified_access_subject: principal.accessSubject, record_id: ids.mutation, version: 1, record_kind: "organization",
        };
        else if (sql.includes("native_directory_create_admissions")) value = options.admission === false ? null : { id: "create-admission",
          destinations_json: JSON.stringify([{ sourceId, sourceInstanceUUID: ids.instance, applicationUUID: ids.application,
            historyEpoch: ids.epoch, origin, externalCanonicalId: String(values[2]) }]) };
        else if (sql.includes("FROM pa_connectors")) value = options.connectorActive === false ? null : { ok: 1 };
        else if (sql.includes("operations_directory_client_organizations")) value = {
          organization_record_id: options.linked ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : null, relationship_version: 2,
        };
        else if (sql.includes("native_directory_assignments")) value = null;
        else if (sql.includes("native_directory_enrollments")) value = options.enrollment === undefined ? null
          : { destinations_json: JSON.stringify(options.enrollment) };
        else if (sql.includes("SELECT generation FROM")) value = options.missingGeneration ? null : "7";
        else if (sql.includes("project_alpha_directory_outbox WHERE command_id"))
          value = { source_id: sourceId, state: options.outboxState ?? "pending" };
        if (column && value && typeof value === "object") return ((value as Row)[column] ?? null) as T | null;
        return value as T | null;
      },
    };
    return statement;
  }, withSession() { return db; } };
  return db as unknown as D1Database;
}

function fixture(options: { enabled?: boolean; db?: D1Database } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", false); await next(); });
  registerNativeDirectoryProfileRoutes(app);
  const env = { NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: options.enabled === false ? "false" : "true",
    TEAM_DOMAIN: "https://team.example.test", OPERATIONS_AUD: "operations-audience-1234",
    PROJECT_ALPHA_API_V2_CONNECTIONS: "server-owned", OPS_DB: options.db ?? database() } as unknown as Env;
  const send = (path: string, body: unknown, method = "POST", key = ids.mutation) => app.request(`https://ops.example${path}`, {
    method, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  }, env);
  return { send, env };
}

describe("native Directory profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ admissionVersion: 3, verifiedUntil: "2099-01-01T00:00:00.000Z",
      identity: { kind: "native", staffId: principal.id, verifiedAccessSubject: principal.accessSubject,
        email: principal.email, displayName: principal.displayName, profileVersion: 4 } });
    mocks.connection.mockReturnValue({ sourceId, enabled: true, connection: { baseUrl: origin,
      expectedSourceInstanceId: ids.instance, expectedApplicationId: ids.application, expectedHistoryEpoch: ids.epoch } });
    mocks.writer.mockResolvedValue({ status: "written", replayed: false, mutationId: ids.mutation,
      recordId: ids.mutation, kind: "organization", version: 1, commandIds: [ids.command] });
  });

  it("mounts default-off camouflage before shared /api authentication", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const guard = source.indexOf("app.use(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/*`");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(source.indexOf('app.use("/api/*"'));
    expect(source).toContain("registerNativeDirectoryProfileRoutes(app)");
  });

  it("is default-off before native authentication or body handling", async () => {
    const response = await fixture({ enabled: false }).send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, "not-json");
    expect(response.status).toBe(404);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("creates an organization with only server-derived identity, grants, record ID, namespace and generation", async () => {
    const response = await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization,
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "pending", recordId: ids.mutation,
      kind: "organization", version: 1, replayed: false, destinations: [{ sourceId, state: "pending" }] });
    expect(mocks.writer).toHaveBeenCalledWith(expect.anything(), {
      operation: "create", mutationId: ids.mutation, recordId: ids.mutation,
      expectedLocalVersion: 0, kind: "organization", profile: organization, scopes,
      createAdmissionId: "create-admission",
      actor: { staffId: principal.id, accessSubject: principal.accessSubject, admissionVersion: 3,
        loginEmail: principal.email, profileVersion: 4, selectedGrantId: "edit-grant", selectedIdentityGrantId: "edit-grant" },
      destinations: [{ sourceId, sourceInstanceUUID: ids.instance, applicationUUID: ids.application,
        historyEpoch: ids.epoch, origin, externalCanonicalId: ids.mutation,
        expectedAuthorizationGeneration: "7" }],
    });
  });

  it("creates a standalone client only with a current identity-link grant and no caller authority fields", async () => {
    mocks.writer.mockResolvedValueOnce({ status: "written", replayed: false, mutationId: ids.mutation,
      recordId: ids.mutation, kind: "client", version: 1, commandIds: [ids.command] });
    const response = await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: client,
    });
    expect(response.status).toBe(202);
    expect(mocks.writer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "client", recordId: ids.mutation,
      relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 },
      actor: expect.objectContaining({ selectedGrantId: "edit-grant", selectedIdentityGrantId: "identity-grant" }) }));
    const forged = await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: client,
      actor: { staffId: "attacker" }, expectedAuthorizationGeneration: "999",
    });
    expect(forged.status).toBe(400);
  });

  it("updates from the immutable enrollment without accepting browser source selection", async () => {
    const enrollment = [{ sourceId, sourceInstanceUUID: ids.instance, applicationUUID: ids.application,
      historyEpoch: ids.epoch, origin, externalCanonicalId: ids.client }];
    mocks.writer.mockResolvedValueOnce({ status: "written", replayed: true, mutationId: ids.mutation,
      recordId: ids.client, kind: "client", version: 2, commandIds: [ids.command] });
    const value = { mutationId: ids.mutation, expectedLocalVersion: 1,
      profile: { name: client.name, email: client.email, phone: client.phone, addressLine1: "", addressLine2: "",
        city: "", state: "WI", postalCode: "", country: "" } };
    const route = `${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients/${ids.client}`;
    const response = await fixture({ db: database({ enrollment, outboxState: "acknowledged" }) }).send(route, value, "PATCH");
    expect(response.status).toBe(200);
    expect(mocks.writer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "update", recordId: ids.client,
      expectedLocalVersion: 1, relationship: { organizationRecordId: null, expectedRelationshipVersion: 2 },
      destinations: [{ ...enrollment[0], expectedAuthorizationGeneration: "7" }] }));
    expect((await fixture({ db: database({ enrollment }) }).send(route, { ...value, sourceIds: [sourceId] }, "PATCH")).status).toBe(400);
    const linked = await fixture({ db: database({ enrollment, linked: true }) }).send(route, value, "PATCH");
    expect(linked.status).toBe(409);
    await expect(linked.json()).resolves.toEqual({ status: "conflict", reason: "standalone_relationship_changed" });
  });

  it("requires an exact pre-issued admission, active connector and enrollment-management authority", async () => {
    const path = `${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, value = {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization,
    };
    expect((await fixture({ db: database({ admission: false }) }).send(path, value)).status).toBe(409);
    expect((await fixture({ db: database({ connectorActive: false }) }).send(path, value)).status).toBe(409);
    expect((await fixture({ db: database({ deny: "directory.enrollment.manage" }) }).send(path, value)).status).toBe(403);
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("returns a committed exact replay before mutable grants, admission or connection selection", async () => {
    mocks.connection.mockImplementation(() => { throw new Error("rotated"); });
    const response = await fixture({ db: database({ admission: false, connectorActive: false,
      deny: "directory.profile.edit", replay: "exact" }) }).send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization,
    });
    expect(response.status).toBe(202);
    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    const conflict = await fixture({ db: database({ replay: "conflict" }) }).send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization,
    });
    expect(conflict.status).toBe(409);
  });

  it("fails closed on native identity mismatch, identity-link deny, missing authority state and writer conflicts", async () => {
    mocks.authenticate.mockResolvedValueOnce({ admissionVersion: 3, identity: { staffId: "other", email: principal.email,
      verifiedAccessSubject: principal.accessSubject, profileVersion: 4 } });
    expect((await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization })).status).toBe(403);
    expect((await fixture({ db: database({ deny: "directory.identity.link" }) }).send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: client })).status).toBe(403);
    expect((await fixture({ db: database({ missingGeneration: true }) }).send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization })).status).toBe(409);
    mocks.writer.mockResolvedValueOnce({ status: "conflict", reason: "stale_local_version" });
    const conflict = await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ status: "conflict", reason: "stale_local_version" });
  });

  it("requires an exact UUID idempotency header and exposes no direct HTTP sender", async () => {
    expect((await fixture().send(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      mutationId: ids.mutation, sourceIds: [sourceId], scopes, profile: organization,
    }, "POST", ids.client)).status).toBe(400);
    const source = readFileSync(new URL("../src/worker/native-directory-profile-routes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("send:");
    expect(source).not.toContain("project_alpha_project_v2_success_receipts");
    expect(source).toContain('withSession("first-primary")');
  });
});
