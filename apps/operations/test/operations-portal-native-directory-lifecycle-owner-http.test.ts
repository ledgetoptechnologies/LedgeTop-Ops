import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOperationsNativeDirectoryLifecycleOwnerHttp,
  OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE,
  type OperationsNativeDirectoryLifecycleOwnerHttpDependencies } from "../src/worker/operations-portal-native-directory-lifecycle-owner-http";

const origin = "https://ops-staging.example.test", id = "11111111-1111-4111-8111-111111111111";
const actor = { identity: { kind: "native" as const, staffId: "owner", verifiedAccessSubject: "access|owner",
  email: "owner@example.test", displayName: "Owner", profileVersion: 3 }, admissionVersion: 2,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const authenticate = vi.fn(), selectAuthority = vi.fn(), write = vi.fn();
let runtime: Miniflare, database: D1Database;

function deps(overrides: Partial<OperationsNativeDirectoryLifecycleOwnerHttpDependencies> = {}): OperationsNativeDirectoryLifecycleOwnerHttpDependencies {
  return { environment: "staging", enabledFlag: "true", expectedHost: "ops-staging.example.test",
    configuration: { enabled: true, origin, issuer: "https://team.cloudflareaccess.com",
      staffAudience: "a".repeat(16), csrfSecret: "synthetic-test-secret-at-least-thirty-two-bytes" },
    database: {} as D1Database, authenticate, selectAuthority, write, ...overrides };
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const method = body === undefined ? "GET" : "POST";
  return new Request(`${origin}${OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE}/${path}`, { method,
    headers: { "Sec-Fetch-Site": "same-origin", ...(method === "GET" ? { "X-Native-Staff-Request": "1" }
      : { Origin: origin, "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function token(d = deps()): Promise<string> {
  const response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("session"), d);
  expect(response.status).toBe(200); return (await response.json() as { csrfToken: string }).csrfToken;
}
const input = { mutationId: id, expectedLifecycleVersion: 0, expectedRecordVersion: 4 };

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  await database.batch([
    database.prepare("CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,status TEXT)"),
    database.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
    database.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,display_name TEXT,version INTEGER)"),
    database.prepare(`CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,
      scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT)`),
    database.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,business_area_id TEXT,division_id TEXT,active INTEGER)"),
    database.prepare("CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER)"),
    database.prepare("INSERT INTO staff_users VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    database.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
    database.prepare("INSERT INTO native_staff_profiles VALUES('owner','owner@example.test','Owner',3)"),
  ]);
});
afterAll(async () => runtime.dispose());

async function authorityFixture(scope: "global" | "resource" | "business_area" | "division" | "assigned",
  deny = false): Promise<OperationsNativeDirectoryLifecycleOwnerHttpDependencies> {
  await database.batch([database.prepare("DELETE FROM native_directory_grants"),
    database.prepare("DELETE FROM native_directory_resource_scopes"), database.prepare("DELETE FROM native_directory_assignments")]);
  if (scope === "business_area" || scope === "division") await database.prepare(
    "INSERT INTO native_directory_resource_scopes VALUES('client-one','area-one','division-one',1)").run();
  if (scope === "assigned") await database.prepare("INSERT INTO native_directory_assignments VALUES('client-one','owner',1)").run();
  const values = scope === "resource" ? [null, null, "client-one"] : scope === "business_area" ? ["area-one", null, null]
    : scope === "division" ? [null, "division-one", null] : [null, null, null];
  for (const [grantId, permission] of [["profile-allow", "directory.profile.edit"], ["enrollment-allow", "directory.enrollment.manage"]])
    await database.prepare(`INSERT INTO native_directory_grants VALUES(?,?,?,'allow',1,?,?,?,?)`)
      .bind(grantId, "owner", permission, scope, ...values).run();
  if (deny) await database.prepare(`INSERT INTO native_directory_grants VALUES('profile-deny','owner','directory.profile.edit','deny',1,?,?,?,?)`)
    .bind(scope, ...values).run();
  return deps({ database, selectAuthority: undefined });
}

describe("operations native Directory lifecycle owner HTTP", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks(); authenticate.mockResolvedValue(actor);
    selectAuthority.mockResolvedValue({ selectedProfileGrantId: "profile-grant", selectedEnrollmentGrantId: "enrollment-grant" });
    write.mockResolvedValue({ status: "written", replayed: false, recordId: "client-one", lifecycleVersion: 1,
      lifecycleStatus: "archive_pending", reservations: [] });
  });

  it("is default-off and fails closed when disabled", async () => {
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("session"), deps({ enabledFlag: "false" }))).status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("requires current native authentication and a live actor-bound CSRF", async () => {
    authenticate.mockRejectedValueOnce(Error("denied"));
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("session"), deps())).status).toBe(403);
    authenticate.mockResolvedValue(actor); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
    const csrf = await token(); vi.setSystemTime(new Date("2026-10-12T12:30:00.000Z"));
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), deps())).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not invoke the writer when the actor expires during authority lookup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
    const expiring = { ...actor, verifiedUntil: "2026-10-12T12:00:30.000Z" };
    authenticate.mockResolvedValue(expiring);
    selectAuthority.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-12T12:00:31.000Z"));
      return { selectedProfileGrantId: "profile-grant", selectedEnrollmentGrantId: "enrollment-grant" };
    });
    const csrf = await token(), response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(
      request("clients/client-one/archive", input, { "X-CSRF-Token": csrf }), deps());
    expect(response.status).toBe(403); expect(write).not.toHaveBeenCalled();
  });

  it("returns a truthful success when the actor expires while the writer is awaited", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
    const expiring = { ...actor, verifiedUntil: "2026-10-12T12:00:30.000Z" };
    authenticate.mockResolvedValue(expiring);
    write.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-12T12:00:31.000Z"));
      return { status: "written", replayed: false, recordId: "client-one", lifecycleVersion: 1,
        lifecycleStatus: "archive_pending", reservations: [] };
    });
    const csrf = await token(), response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(
      request("clients/client-one/archive", input, { "X-CSRF-Token": csrf }), deps());
    expect(response.status).toBe(200);
    expect((await response.json() as { outcome: { status: string } }).outcome.status).toBe("written");
    expect(write.mock.calls[0]?.[1]).toMatchObject({ actor: { verifiedUntil: expiring.verifiedUntil } });
  });

  it("derives authority server-side and preserves grant denial", async () => {
    const csrf = await token(); selectAuthority.mockResolvedValueOnce(null);
    const response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("organizations/org-one/restore", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(response.status).toBe(403); expect(write).not.toHaveBeenCalled();
  });

  it.each(["global", "resource", "business_area", "division", "assigned"] as const)(
    "selects current applicable %s grants from D1", async scope => {
      const d = await authorityFixture(scope), csrf = await token(d);
      const response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
        { "X-CSRF-Token": csrf }), d);
      expect(response.status).toBe(200);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ actor: expect.objectContaining({
        selectedProfileGrantId: "profile-allow", selectedEnrollmentGrantId: "enrollment-allow",
      }) }));
    });

  it("applies D1 deny precedence and rejects stale actor versions or inactive scopes before the writer", async () => {
    let d = await authorityFixture("resource", true), csrf = await token(d);
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), d)).status).toBe(403);
    expect(write).not.toHaveBeenCalled();

    d = await authorityFixture("global"); csrf = await token(d);
    await database.prepare("UPDATE native_staff_admissions SET version=3 WHERE staff_id='owner'").run();
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), d)).status).toBe(403);
    await database.prepare("UPDATE native_staff_admissions SET version=2 WHERE staff_id='owner'").run();

    d = await authorityFixture("business_area"); csrf = await token(d);
    await database.prepare("UPDATE native_directory_resource_scopes SET active=0").run();
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), d)).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed for bad host/origin configuration and oversized bodies", async () => {
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("session"), deps({
      expectedHost: "other.example.test" }))).status).toBe(404);
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("session"), deps({
      configuration: { ...deps().configuration, origin: "https://other.example.test" } }))).status).toBe(404);
    const csrf = await token(), oversized = new Request(`${origin}${OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE}/clients/client-one/archive`, {
      method: "POST", headers: { "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "application/json",
        "X-CSRF-Token": csrf }, body: JSON.stringify({ ...input, padding: "x".repeat(2_048) }) });
    expect((await handleOperationsNativeDirectoryLifecycleOwnerHttp(oversized, deps())).status).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects source, destination, grant, and owner-field injection before writing", async () => {
    const csrf = await token();
    for (const injected of [{ sourceId: "project-alpha:other" }, { destinations: [] }, { selectedProfileGrantId: "attacker" },
      { owner: true }]) {
      const response = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive",
        { ...input, ...injected }, { "X-CSRF-Token": csrf }), deps());
      expect(response.status).toBe(400);
    }
    expect(selectAuthority).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("derives route kind/action/record and preserves idempotent replay", async () => {
    const csrf = await token();
    const first = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), deps());
    write.mockResolvedValueOnce({ status: "written", replayed: true, recordId: "client-one", lifecycleVersion: 1,
      lifecycleStatus: "archive_pending", reservations: [] });
    const replay = await handleOperationsNativeDirectoryLifecycleOwnerHttp(request("clients/client-one/archive", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(first.status).toBe(200); expect(replay.status).toBe(200);
    expect((await replay.json() as { outcome: { replayed: boolean } }).outcome.replayed).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[1]).toMatchObject({ ...input, recordId: "client-one", kind: "client", action: "archive",
      actor: { staffId: "owner", accessSubject: "access|owner", admissionVersion: 2, loginEmail: "owner@example.test",
        profileVersion: 3, verifiedUntil: "2099-01-01T00:00:00.000Z",
        selectedProfileGrantId: "profile-grant", selectedEnrollmentGrantId: "enrollment-grant" } });
    expect(write.mock.calls[1]?.[1]).toEqual(write.mock.calls[0]?.[1]);
  });
});
