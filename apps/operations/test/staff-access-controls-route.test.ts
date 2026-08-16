import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  requirePermission: vi.fn(),
  sqlScope: vi.fn(),
  requireMutationSecurity: vi.fn(),
  auditStatement: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  requirePermission: mocks.requirePermission,
  sqlScope: mocks.sqlScope,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditStatement: mocks.auditStatement,
}));

import worker from "../src/worker/index";

const principal = { id: "staff-admin", email: "admin@example.com", displayName: "Admin", accessSubject: "access-admin", projectAlphaUserId: null };
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function environment(
  target: { id: string; sync_protected: number; status?: string } = { id: "staff-target", sync_protected: 0 },
  staffRows: Record<string, unknown>[] = [],
) {
  const prepared: Array<{ sql: string; values: unknown[] }> = [];
  let batches = 0;
  const database = {
    prepare(sql: string) {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; prepared.push(this); return this; },
        async first() {
          if (sql.includes("SELECT id,email,status,sync_protected FROM staff_users")) {
            return { ...target, email: "target@example.com", status: target.status || "active" };
          }
          return null;
        },
        async all() {
          if (!sql.includes("FROM staff_users s")) return { results: [] };
          const deniedDivisions = this.values.filter(value => String(value).startsWith("division-denied"));
          return {
            results: sql.includes("denied_staff_division") && deniedDivisions.length
              ? staffRows.filter(row => !deniedDivisions.includes(row.division_id))
              : staffRows,
          };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch() { batches += 1; return []; },
  };
  return {
    env: { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example", OPS_DB: database },
    prepared,
    batchCount: () => batches,
  };
}

const controls = {
  allOperations: false,
  sopAssignment: false,
  deliveryBrowse: true,
  deliveryLinkCreate: false,
  deliveryLinkRevoke: false,
  deliveryLinkAudit: false,
  teamRoster: false,
  administration: false,
};

describe("staff access-control route", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.requirePermission.mockReset().mockResolvedValue(undefined);
    mocks.sqlScope.mockReset().mockResolvedValue({ global: true, deniedGlobal: false, divisions: [], assigned: false, own: false, deniedDivisions: [] });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditStatement.mockReset().mockResolvedValue({ sql: "audit", values: [] });
  });

  it("persists exactly one explicit effect for every submitted capability", async () => {
    const state = environment();
    const response = await worker.fetch(new Request("https://ops.example/api/admin/staff/staff-target/access-controls", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://ops.example" },
      body: JSON.stringify(controls),
    }), state.env as any, executionCtx);

    expect(response.status).toBe(200);
    expect(state.batchCount()).toBe(1);
    const inserts = state.prepared.filter(call => call.sql.startsWith("INSERT INTO staff_permission_overrides"));
    expect(inserts).toHaveLength(8);
    expect(inserts.find(call => call.values[2] === "delivery.browse")?.values[3]).toBe("allow");
    expect(inserts.filter(call => call.values[2] !== "delivery.browse").every(call => call.values[3] === "deny")).toBe(true);
    expect(state.prepared.filter(call => call.sql.startsWith("DELETE FROM staff_permission_overrides"))).toHaveLength(8);
  });

  it("rejects self-edit and protected-owner edits before writing a batch", async () => {
    const self = environment({ id: principal.id, sync_protected: 0 });
    const selfResponse = await worker.fetch(new Request(`https://ops.example/api/admin/staff/${principal.id}/access-controls`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify(controls),
    }), self.env as any, executionCtx);
    expect(selfResponse.status).toBe(409);
    expect(self.batchCount()).toBe(0);

    const protectedOwner = environment({ id: "staff-beau-koltz", sync_protected: 1 });
    const protectedResponse = await worker.fetch(new Request("https://ops.example/api/admin/staff/staff-beau-koltz/access-controls", {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify(controls),
    }), protectedOwner.env as any, executionCtx);
    expect(protectedResponse.status).toBe(409);
    expect(protectedOwner.batchCount()).toBe(0);
  });

  it("allows an administrator to prepare controls for an inactive synced staff member without activating them", async () => {
    const state = environment({ id: "staff-pending", sync_protected: 0, status: "inactive" });
    const response = await worker.fetch(new Request("https://ops.example/api/admin/staff/staff-pending/access-controls", {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify(controls),
    }), state.env as any, executionCtx);
    expect(response.status).toBe(200);
    expect(state.batchCount()).toBe(1);
  });

  it("excludes staff in explicitly denied divisions even with a global team allow", async () => {
    mocks.isAdministrator.mockResolvedValue(false);
    mocks.sqlScope.mockResolvedValue({
      global: true,
      deniedGlobal: false,
      divisions: [],
      assigned: false,
      own: false,
      deniedDivisions: ["division-denied-secret"],
    });
    const state = environment(undefined, [
      { id: "staff-visible", division_id: "division-visible", display_name: "Visible", email: "visible@example.com" },
      { id: "staff-denied", division_id: "division-denied-secret", display_name: "Denied", email: "denied@example.com" },
    ]);

    const response = await worker.fetch(
      new Request("https://ops.example/api/team/staff"),
      state.env as any,
      executionCtx,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { staff: Array<{ id: string }> };
    expect(payload.staff.map(person => person.id)).toEqual(["staff-visible"]);
    const rosterQuery = state.prepared.find(call => call.sql.includes("FROM staff_users s"));
    expect(rosterQuery?.sql).toContain("denied_staff_division");
    expect(rosterQuery?.values).toContain("division-denied-secret");
  });

  it("returns a public roster DTO to non-admin viewers while preserving admin controls", async () => {
    const row = {
      id: "staff-target",
      email: "target@example.com",
      display_name: "Target",
      status: "active",
      roles: "Operator",
      inherited_permissions: "team.view,delivery.browse",
      direct_allows: "team.view",
      global_denies: "delivery.share.create",
    };
    const nonAdmin = environment(undefined, [row]);
    mocks.isAdministrator.mockResolvedValue(false);
    const nonAdminResponse = await worker.fetch(
      new Request("https://ops.example/api/team/staff"),
      nonAdmin.env as any,
      executionCtx,
    );
    const nonAdminPerson = ((await nonAdminResponse.json()) as { staff: Record<string, unknown>[] }).staff[0]!;
    expect(nonAdminPerson).toMatchObject({ id: "staff-target", email: "target@example.com", roles: "Operator" });
    expect(nonAdminPerson).not.toHaveProperty("inherited_permissions");
    expect(nonAdminPerson).not.toHaveProperty("direct_allows");
    expect(nonAdminPerson).not.toHaveProperty("global_denies");
    expect(nonAdminPerson).not.toHaveProperty("localControls");

    const admin = environment(undefined, [row]);
    mocks.isAdministrator.mockResolvedValue(true);
    const adminResponse = await worker.fetch(
      new Request("https://ops.example/api/team/staff"),
      admin.env as any,
      executionCtx,
    );
    const adminPerson = ((await adminResponse.json()) as { staff: Array<Record<string, any>> }).staff[0]!;
    expect(adminPerson.localControls).toMatchObject({ teamRoster: true, deliveryBrowse: true, deliveryLinkCreate: false });
  });
});
