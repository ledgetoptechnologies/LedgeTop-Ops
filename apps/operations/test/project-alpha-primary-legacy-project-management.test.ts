import { beforeEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
}));
vi.mock("../src/worker/acl", () => acl);

import { readClientHubProjectManagementAction } from "../src/worker/project-alpha-project-management";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal = { id: "admin", email: "admin@example.test", displayName: "Admin" } as StaffPrincipal;
const root = {
  source_id: "project-alpha:primary",
  source_name: "Primary Project Alpha",
  root_namespace: "business",
  kind: "standalone_client",
  public_id: "local-client-1",
};
const context = {
  root,
  canonicalRoot: { sourceId: root.source_id, rootNamespace: "business", kind: root.kind, publicId: root.public_id },
  contextVersion: "context-version",
};

function environment(options: { configured?: boolean; mapped?: boolean } = {}): Env {
  const configured = options.configured ?? true, mapped = options.mapped ?? true;
  const database = {
    withSession: () => database,
    prepare(sql: string) {
      return {
        bind: (..._values: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM pa_connectors connector")) return { results: [] };
            if (sql.includes("FROM pa_projection_record_ids mapping")) return { results: mapped ? [{
              source_id: "project-alpha:primary", display_name: "Primary Project Alpha", state: "active", read_visible: 1,
              connector_version: 0, route_version: null, route_revision: null, enabled: null, reviewed_url_template: null,
              external_id: "42", sync_status: "healthy", last_attempt_at: "2026-09-03 13:00:00",
              last_success_at: "2026-09-03 12:59:00",
            }] : [] };
            throw new Error(`Unexpected query: ${sql}`);
          },
        }),
      };
    },
  };
  return {
    OPS_DB: database as unknown as D1Database,
    PROJECT_ALPHA_BASE_URL: configured ? "https://alpha.example.test" : undefined,
    PROJECT_ALPHA_API_KEY: configured ? "legacy-read-key" : undefined,
    APPLICATION_KEY: configured ? "ltds_ops" : undefined,
  } as Env;
}

describe("primary legacy Project Alpha project-management compatibility", () => {
  beforeEach(() => {
    acl.isAdministrator.mockReset().mockResolvedValue(true);
    acl.sqlScope.mockReset().mockResolvedValue({ global: true, deniedGlobal: false });
  });

  it("retains exact primary sync health without inventing a connector or project route", async () => {
    const result = await readClientHubProjectManagementAction(environment(), principal, context as never,
      "/api/client-hub/sources/project-alpha%3Aprimary/business/standalone/local-client-1/project-management");
    expect(result).toMatchObject({
      source: { sourceId: "project-alpha:primary", displayName: "Primary Project Alpha", state: "active" },
      availability: { available: false, reason: "route_not_configured" },
      action: null,
      sync: {
        status: "healthy",
        lastAttemptAt: "2026-09-03T13:00:00.000Z",
        lastSuccessAt: "2026-09-03T12:59:00.000Z",
        requestSync: { href: "/api/admin/integrations/project-alpha/sync", method: "POST" },
      },
    });
    expect(result.availability.explanation).toContain("has not reviewed");
  });

  it("fails closed when deployment ownership or the exact primary mapping is absent", async () => {
    for (const env of [environment({ configured: false }), environment({ mapped: false })]) {
      const result = await readClientHubProjectManagementAction(env, principal, context as never, "/refresh");
      expect(result).toMatchObject({
        source: { sourceId: "project-alpha:primary", state: "unregistered" },
        availability: { available: false, reason: "source_not_registered" },
        action: null,
        sync: { status: "not_configured", requestSync: null },
      });
    }
  });

  it("never applies the primary compatibility path to another source", async () => {
    const secondaryContext = { ...context, root: { ...root, source_id: "project-alpha:secondary" },
      canonicalRoot: { ...context.canonicalRoot, sourceId: "project-alpha:secondary" } };
    const result = await readClientHubProjectManagementAction(environment(), principal, secondaryContext as never, "/refresh");
    expect(result).toMatchObject({
      source: { sourceId: "project-alpha:secondary", state: "unregistered" },
      availability: { available: false, reason: "source_not_registered" },
      action: null,
      sync: { status: "not_configured", requestSync: null },
    });
  });
});
