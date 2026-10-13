import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), authenticate: vi.fn(), reserve: vi.fn(), compare: vi.fn(), seal: vi.fn(),
  audit: vi.fn(), batch: vi.fn() }));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: mocks.authenticate,
}));
vi.mock("../src/worker/project-alpha-directory-read-adoption", () => ({
  reserveProjectAlphaDirectoryReadAdoption: mocks.reserve,
}));
vi.mock("../src/worker/project-alpha-directory-read-adoption-field-review", () => ({
  compareProjectAlphaDirectoryReadAdoptionFields: mocks.compare,
  sealProjectAlphaDirectoryReadAdoptionFieldReview: mocks.seal,
}));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import {
  PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_COMPARE_ROUTE,
  PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_FIELD_REVIEW_ROUTE,
  PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE,
  registerProjectAlphaDirectoryReadAdoptionRoutes,
} from "../src/worker/project-alpha-directory-read-adoption-routes";

const principal: StaffPrincipal = { id: "admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "native:staff:admin", projectAlphaUserId: null };
const idempotencyKey = "70000000-0000-4000-8000-000000000007";
const reviewId = "80000000-0000-4000-8000-000000000008";
const request = { sourceId: "project-alpha:primary", resourceType: "client",
  recordId: "ops-customer-1", expectedLocalRecordVersion: 3, projectAlphaPublicId: "a".repeat(32) };

function fixture(enabled = true, administrator = true, environment = "staging") {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", administrator); await next(); });
  registerProjectAlphaDirectoryReadAdoptionRoutes(app);
  const env = { ENVIRONMENT: environment, PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: enabled ? "true" : "false",
    OPS_DB: { batch: mocks.batch }, TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "audience_12345678",
    AUDIT_IP_SECRET: "audit" } as unknown as Env;
  const send = (body: unknown = request, key = idempotencyKey) => app.request(
    `https://ops.example.test${PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE}`,
    { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body) }, env);
  const compare = (body:unknown={}) => app.request(`https://ops.example.test${PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_COMPARE_ROUTE.replace(":reviewId",reviewId)}`,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},env);
  const seal = (body:unknown) => app.request(`https://ops.example.test${PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_FIELD_REVIEW_ROUTE.replace(":reviewId",reviewId)}`,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},env);
  return { send, compare, seal };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.authenticate.mockResolvedValue({ admissionVersion: 4, verifiedUntil: "2026-10-01T13:00:00.000Z",
    identity: { kind: "native", staffId: principal.id, verifiedAccessSubject: principal.accessSubject,
      email: principal.email, displayName: principal.displayName, profileVersion: 5 } });
  mocks.reserve.mockResolvedValue({ status: "reserved", reviewId: "review", claimId: "claim", state: "inactive" });
  mocks.compare.mockResolvedValue({ status:"compared",reviewId,resourceType:"client",fields:[
    {field:"name",localValue:"Private local name",projectAlphaValue:"Private PA name",equal:false},
  ] });
  mocks.seal.mockResolvedValue({status:"sealed",receiptId:"receipt"});
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
});

describe("Project Alpha exact Directory read-adoption route", () => {
  it("is staging-only and default-off before authentication or reservation", async () => {
    expect((await fixture(false).send()).status).toBe(404);
    expect((await fixture(true, true, "production").send()).status).toBe(404);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("requires administrator membership and deny-aware global integrations.manage", async () => {
    expect((await fixture(true, false).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("requires strict input, a UUID idempotency key, and matching current native identity", async () => {
    expect((await fixture().send({ ...request, fuzzyMatch: true })).status).toBe(400);
    expect((await fixture().send({ ...request, externalId: "browser-chosen-pa-id" })).status).toBe(400);
    expect((await fixture().send(request, "not-a-uuid")).status).toBe(400);
    mocks.authenticate.mockResolvedValueOnce({ admissionVersion: 4,
      identity: { staffId: "someone-else", verifiedAccessSubject: principal.accessSubject,
        email: principal.email, profileVersion: 5 } });
    const mismatched = await fixture().send();
    expect(mismatched.status, await mismatched.text()).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("passes only the selected exact pair and version, returning an inactive claim", async () => {
    const response = await fixture().send();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ outcome: {
      status: "reserved", reviewId: "review", claimId: "claim", state: "inactive",
    } });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({ ENVIRONMENT: "staging" }), {
      ...request, idempotencyKey,
      actor: { staffId: principal.id, accessSubject: principal.accessSubject,
        admissionVersion: 4, profileVersion: 5 },
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(request.recordId);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(request.projectAlphaPublicId);
  });

  it("is mounted after the authenticated mutation security middleware", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const mutation = source.indexOf('app.use("/api/*"');
    const csrf = source.indexOf("await requireMutationSecurity", mutation);
    const route = source.indexOf("registerProjectAlphaDirectoryReadAdoptionRoutes(app)");
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(csrf).toBeGreaterThan(mutation);
    expect(route).toBeGreaterThan(csrf);
  });

  it("returns compared PII only after all administrator, permission, and current-native-actor gates", async () => {
    const allowed = await fixture().compare();
    expect(allowed.status,await allowed.clone().text()).toBe(200);
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
    expect(await allowed.json()).toEqual({outcome:{status:"compared",reviewId,resourceType:"client",fields:[
      {field:"name",localValue:"Private local name",projectAlphaValue:"Private PA name",equal:false},
    ]}});
    expect(mocks.compare).toHaveBeenCalledWith(expect.anything(),reviewId,{staffId:principal.id,accessSubject:principal.accessSubject,admissionVersion:4,profileVersion:5});

    mocks.compare.mockClear();
    const denied = await fixture(true,false).compare();
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("Private");
    expect(mocks.compare).not.toHaveBeenCalled();
    mocks.scope.mockResolvedValueOnce({global:false,deniedGlobal:false});
    expect((await fixture().compare()).status).toBe(403);
    expect(mocks.compare).not.toHaveBeenCalled();
    expect((await fixture().compare({unexpected:true})).status).toBe(400);
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("strictly accepts only complete enum field decisions and never audits raw comparison values", async () => {
    const decisions = {name:"requires_follow_up",email:"unchanged",phone:"unchanged",address_line1:"unchanged",
      address_line2:"unchanged",city:"unchanged",state:"unchanged",postal_code:"unchanged",country:"unchanged",
      client_type:"unchanged",organization_public_id:"unchanged"};
    expect((await fixture().seal({decisions:{...decisions,rawValue:"must-not-persist"}})).status).toBe(400);
    expect((await fixture().seal({decisions:{...decisions,email:"overwrite"}})).status).toBe(400);
    expect(mocks.seal).not.toHaveBeenCalled();
    const response=await fixture().seal({decisions});
    expect(response.status,await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.seal).toHaveBeenCalledWith(expect.anything(),{reviewId,decisions,actor:{staffId:principal.id,
      accessSubject:principal.accessSubject,admissionVersion:4,profileVersion:5}});
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("Private local name");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("must-not-persist");
  });

  it("returns stale comparison outcomes without creating a seal or any route-level authority mutation", async () => {
    mocks.compare.mockResolvedValueOnce({status:"blocked",reason:"pa_profile_changed"});
    const response=await fixture().compare();
    expect(await response.json()).toEqual({outcome:{status:"blocked",reason:"pa_profile_changed"}});
    expect(mocks.seal).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });
});
