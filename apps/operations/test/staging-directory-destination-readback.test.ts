import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), grant: vi.fn(), read: vi.fn(), native: vi.fn() }));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/native-directory-profile-routes", () => ({ selectGrant: mocks.grant,
  readNativeDirectoryClientProfileSnapshot: async () => ({ version: 5, profile }) }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.native }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: () => ({ enabled: true,
  connection: { baseUrl: "https://pa.example.test" } }) }));
vi.mock("../src/worker/project-alpha-directory-read-api-v2", () => ({ readConfiguredProjectAlphaDirectoryProfile: mocks.read }));

import { registerStagingDirectoryDestinationReadbackRoute, STAGING_DIRECTORY_DESTINATION_READBACK_ROUTE }
  from "../src/worker/staging-directory-destination-readback";

const recordId = "614ed50f-8800-4ab3-aa69-009d8e5cefa9", paId = "a".repeat(32);
const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const profile = { name: "Synthetic Portal Acceptance", email: "", phone: "", clientType: "unknown",
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
const principal: StaffPrincipal = { id: "staff-beau-koltz", email: "owner@example.test", displayName: "Owner",
  accessSubject: "access|owner", projectAlphaUserId: null };

function fixture(options: { mappings?: unknown[]; receipts?: unknown[]; owner?: boolean; administrator?: boolean;
  secondMappings?: unknown[]; secondReceipts?: unknown[] } = {}) {
  const mappings = options.mappings ?? [{ sourceInstanceId, applicationId, historyEpoch, projectAlphaPublicId: paId,
  }];
  const receipts = options.receipts ?? [{ projectAlphaRevision: "7", authorizationGeneration: "9", destinationOrigin: "https://pa.example.test" }];
  let mappingReads = 0, receiptReads = 0;
  const session = { prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({
    first: vi.fn(async () => sql.includes("staff_role_assignments") ? (options.owner === false ? null : { ok: 1 }) : null),
    all: vi.fn(async () => {
      if (sql.includes("project_alpha_active_directory_mappings"))
        return { results: ++mappingReads === 2 && options.secondMappings ? options.secondMappings : mappings };
      return { results: ++receiptReads === 2 && options.secondReceipts ? options.secondReceipts : receipts };
    }),
  })) })) };
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", options.administrator !== false); await next(); });
  registerStagingDirectoryDestinationReadbackRoute(app);
  const env = { ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
    PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED: "true", OPS_DB: { withSession: () => session } } as unknown as Env;
  const send = (body: unknown = { expectedLocalVersion: 5 }, origin = "https://ops-staging.ledgetopdroneservices.com") =>
    app.request(`${origin}${STAGING_DIRECTORY_DESTINATION_READBACK_ROUTE}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  return { send };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false }); mocks.grant.mockResolvedValue("view-grant");
  mocks.native.mockResolvedValue({ identity: { staffId: principal.id, email: principal.email,
    verifiedAccessSubject: principal.accessSubject }, admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z" });
  mocks.read.mockResolvedValue({ status: "observed", observation: { sourceId: "project-alpha:staging", sourceInstanceId,
    applicationId, historyEpoch, authorizationGeneration: "9", resource: { type: "client", id: paId, revision: "7" },
    profile: { publicId: paId, name: profile.name, email: null, phone: null, clientType: "unknown", organizationPublicId: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } } } });
});

describe("fixed staging Directory destination readback", () => {
  it("independently fetches the exact PA profile and returns booleans only", async () => {
    const response = await fixture().send(); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "verified", exactIdentity: true, exactVersion: true,
      exactGeneration: true, exactProfile: true });
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "project-alpha:staging", "client", paId);
    expect(JSON.stringify(body)).not.toContain(paId);
  });

  it("fails closed for arbitrary input, wrong host, absent authority, ambiguous mapping, and absent receipt", async () => {
    expect((await fixture().send({ expectedLocalVersion: 5, sourceId: "project-alpha:other" })).status).toBe(400);
    expect((await fixture().send({ expectedLocalVersion: Number.MAX_SAFE_INTEGER + 1 })).status).toBe(400);
    expect((await fixture().send({ expectedLocalVersion: 5 }, "https://ops.example.test")).status).toBe(404);
    expect((await fixture({ administrator: false }).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true }); expect((await fixture().send()).status).toBe(403);
    mocks.native.mockResolvedValueOnce({ identity: { staffId: "staff-other", email: principal.email,
      verifiedAccessSubject: principal.accessSubject }, admissionVersion: 1 }); expect((await fixture().send()).status).toBe(403);
    mocks.grant.mockResolvedValueOnce(null); expect((await fixture().send()).status).toBe(403);
    expect(await (await fixture({ mappings: [{}, {}] }).send()).json()).toMatchObject({ status: "blocked", exactIdentity: false });
    expect(await (await fixture({ receipts: [] }).send()).json()).toMatchObject({ status: "blocked", exactIdentity: false });
  });

  it("reports mismatch without returning identities, profile fields, or credentials", async () => {
    mocks.read.mockResolvedValueOnce({ status: "observed", observation: { sourceId: "project-alpha:staging", sourceInstanceId, applicationId, historyEpoch,
      authorizationGeneration: "10", resource: { type: "client", id: paId, revision: "8" },
      profile: { publicId: paId, name: "wrong", email: null, phone: null, clientType: "unknown", organizationPublicId: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } } } });
    const body = await (await fixture().send()).json() as Record<string, unknown>;
    expect(body).toEqual({ status: "mismatch", exactIdentity: true, exactVersion: false, exactGeneration: false, exactProfile: false });
    expect(JSON.stringify(body)).not.toMatch(/Synthetic|owner|project-alpha|[a-f0-9]{32}/);
  });

  it("fails closed for the wrong configured receipt origin and a local proof change during the remote read", async () => {
    const wrongOrigin = await (await fixture({ receipts: [{ projectAlphaRevision: "7", authorizationGeneration: "9",
      destinationOrigin: "https://other.example.test" }] }).send()).json();
    expect(wrongOrigin).toMatchObject({ status: "blocked", exactIdentity: false });
    expect(mocks.read).not.toHaveBeenCalled();

    const changed = await (await fixture({ secondReceipts: [{ projectAlphaRevision: "8", authorizationGeneration: "9",
      destinationOrigin: "https://pa.example.test" }] }).send()).json();
    expect(changed).toMatchObject({ status: "blocked", exactIdentity: false });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("requires the configured source id in the independent observation", async () => {
    mocks.read.mockResolvedValueOnce({ status: "observed", observation: { sourceId: "project-alpha:other", sourceInstanceId,
      applicationId, historyEpoch, authorizationGeneration: "9", resource: { type: "client", id: paId, revision: "7" },
      profile: { publicId: paId, name: profile.name, email: null, phone: null, clientType: "unknown", organizationPublicId: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } } } });
    expect(await (await fixture().send()).json()).toMatchObject({ status: "mismatch", exactIdentity: false });
  });
});
