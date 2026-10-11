import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), canManage: vi.fn(), read: vi.fn(), create: vi.fn(), write: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.authenticate }));
vi.mock("../src/worker/ops-service-management", () => ({ canManageOperationsCustomerServices: mocks.canManage,
  readOperationsServiceManagement: mocks.read, createOperationsServiceDefinition: mocks.create,
  writeOperationsCustomerServiceEnrollment: mocks.write }));

import { OPS_SERVICE_MANAGEMENT_ROUTE, registerOpsServiceManagementRoutes } from "../src/worker/ops-service-management-routes";

const principal = { id: "staff-one" } as StaffPrincipal;
const actor = { identity: { staffId: "staff-one" }, admissionVersion: 2 };
function application(env: Partial<Env>, administrator = true) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("/api/*", async (context, next) => { context.set("principal", principal); context.set("administrator", administrator); await next(); });
  registerOpsServiceManagementRoutes(app);
  return (path: string, init?: RequestInit) => app.request(`https://ops.example.test${path}`, init,
    { ENVIRONMENT: "staging", OPS_SERVICE_MANAGEMENT_ENABLED: "true", TEAM_DOMAIN: "issuer",
      OPERATIONS_AUD: "audience", OPS_DB: {} as D1Database, ...env } as Env);
}

describe("Operations service management routes", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.authenticate.mockResolvedValue(actor); mocks.canManage.mockResolvedValue(true);
    mocks.read.mockResolvedValue({ definitions: [], enrollments: [] }); });

  it("is default-off and staging-only before authentication or database access", async () => {
    expect((await application({ OPS_SERVICE_MANAGEMENT_ENABLED: undefined })(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a`)).status).toBe(404);
    expect((await application({ ENVIRONMENT: "production" })(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a`)).status).toBe(404);
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("allows scoped non-administrators but requires an exact native identity", async () => {
    expect((await application({}, false)(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a`)).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledTimes(1); mocks.read.mockClear();
    mocks.authenticate.mockResolvedValueOnce({ ...actor, identity: { staffId: "someone-else" } });
    expect((await application({})(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a`)).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("binds enrollment body and idempotency key to the exact route client", async () => {
    const body = { mutationId: "mutation-123456789", idempotencyKey: "idempotency-123456", customerRecordId: "client-b",
      serviceId: "service-a", desiredState: "active", expectedRevision: 0 };
    const response = await application({})(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a/enrollments`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": body.idempotencyKey }, body: JSON.stringify(body) });
    expect(response.status).toBe(400); expect(mocks.write).not.toHaveBeenCalled();
  });

  it("passes exact authenticated enrollment and definition POST commands", async () => {
    const enrollment = { mutationId: "mutation-123456789", idempotencyKey: "idempotency-123456", customerRecordId: "client-a",
      serviceId: "service-a", desiredState: "active", expectedRevision: 0 };
    mocks.write.mockResolvedValueOnce({ ...enrollment, state: "active", revision: 1, replayed: false });
    const enrolled = await application({}, false)(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/client-a/enrollments`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": enrollment.idempotencyKey }, body: JSON.stringify(enrollment) });
    expect(enrolled.status).toBe(200); expect(mocks.write).toHaveBeenCalledWith(expect.anything(), actor, enrollment);

    const definition = { mutationId: "definition-123456789", idempotencyKey: "definition-idempotency", serviceId: "service-a",
      providerId: "provider-a", sourceId: "source-a", sourceServiceId: "remote-a", displayName: "Drone service" };
    mocks.create.mockResolvedValueOnce({ serviceId: "service-a", replayed: false });
    const created = await application({})(`${OPS_SERVICE_MANAGEMENT_ROUTE}/definitions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": definition.idempotencyKey }, body: JSON.stringify(definition) });
    expect(created.status).toBe(201); expect(mocks.create).toHaveBeenCalledWith(expect.anything(), actor, definition);
  });
});
