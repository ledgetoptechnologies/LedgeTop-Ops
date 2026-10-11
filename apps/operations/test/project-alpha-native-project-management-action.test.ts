import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const native = vi.hoisted(() => ({ readClientHubNativeProjectCapability: vi.fn() }));
vi.mock("../src/worker/client-hub-native-project-management", () => native);
vi.mock("../src/worker/acl", () => ({
  isAdministrator: vi.fn().mockResolvedValue(true),
  sqlScope: vi.fn().mockResolvedValue({ global: true, deniedGlobal: false }),
}));
import { readClientHubProjectManagementAction } from "../src/worker/project-alpha-project-management";

describe("native project management action presentation", () => {
  const principal = { id: "owner", email: "owner@example.test" } as StaffPrincipal;
  const context = {
    root: { source_id: "project-alpha:staging", root_namespace: "business", kind: "organization",
      public_id: "organization-1", pa_internal_id: "organization-1", source_name: "Staging" },
    canonicalRoot: { sourceId: "project-alpha:staging", rootNamespace: "business",
      kind: "organization", publicId: "organization-1" },
    contextVersion: "version-1",
  };
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  const env = { OPS_DB: { withSession: () => db } } as unknown as Env;
  beforeEach(() => native.readClientHubNativeProjectCapability.mockReset());

  it("keeps native creation available without attempting to render a missing legacy route", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: true, reason: "available", scopes: [[]] });
    const result = await readClientHubProjectManagementAction(env, principal, context as never, "/project-management");
    expect(result.source.state).toBe("active");
    expect(result.availability).toMatchObject({ available: true, reason: "available" });
    expect(result.action).toEqual({ kind: "native_create", label: "Create project",
      prepareHref: "/project-management/native-projects/prepare",
      submitHref: "/project-management/native-projects/submit", external: false, scopeOptions: [[]] });
    expect(result.sync.requestSync).toBeNull();
  });

  it("does not synthesize an action when the native authority reader denies creation", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: false,
      reason: "native_authority_required", scopes: [] });
    const result = await readClientHubProjectManagementAction(env, principal, context as never, "/project-management");
    expect(result.availability).toMatchObject({ available: false, reason: "native_authority_required" });
    expect(result.source.state).toBe("unavailable");
    expect(result.action).toBeNull();
  });
});
