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
  function environment(connector: "absent" | "legacy" = "absent") {
    const legacyRow = {
      source_id: "project-alpha:staging", display_name: "Staging", state: "active", read_visible: 1,
      connector_version: 3, route_version: 4, route_revision: 2, enabled: 1,
      reviewed_url_template: "https://alpha.example.test/clients/{recordId}/projects",
      external_id: "client-42", sync_status: "healthy", last_attempt_at: null, last_success_at: null,
    };
    const currentRoute = vi.fn().mockResolvedValue({ current: 1 });
    const db = { prepare: () => ({ bind: () => ({
      all: async () => ({ results: connector === "legacy" ? [legacyRow] : [] }),
      first: currentRoute,
    }) }) };
    return { env: { OPS_DB: { withSession: () => db } } as unknown as Env, currentRoute };
  }
  beforeEach(() => native.readClientHubNativeProjectCapability.mockReset());

  it("keeps native creation available without attempting to render a missing legacy route", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: true, reason: "available", scopes: [[]] });
    const result = await readClientHubProjectManagementAction(environment().env, principal, context as never, "/project-management");
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
    const result = await readClientHubProjectManagementAction(environment().env, principal, context as never, "/project-management");
    expect(result.availability).toMatchObject({ available: false, reason: "native_authority_required" });
    expect(result.source.state).toBe("unavailable");
    expect(result.action).toBeNull();
  });

  it("prefers native creation when an enrolled connector also has a reviewed legacy route", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: true, reason: "available", scopes: [[]] });
    const { env, currentRoute } = environment("legacy");
    const result = await readClientHubProjectManagementAction(env, principal, context as never, "/project-management");
    expect(result.availability).toMatchObject({ available: true, reason: "available" });
    expect(result.action).toMatchObject({ kind: "native_create", external: false });
    expect(currentRoute).not.toHaveBeenCalled();
  });

  it("retains the reviewed legacy route when the native destination is disabled", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: false,
      reason: "native_destination_unavailable", scopes: [] });
    const { env, currentRoute } = environment("legacy");
    const result = await readClientHubProjectManagementAction(env, principal, context as never, "/project-management");
    expect(result.availability).toMatchObject({ available: true, reason: "available" });
    expect(result.action).toEqual({ kind: "legacy_external_link", label: "Create project in Project Alpha",
      href: "https://alpha.example.test/clients/client-42/projects", external: true });
    expect(currentRoute).toHaveBeenCalledOnce();
  });

  it("does not expose the legacy route when current native authority denies the actor", async () => {
    native.readClientHubNativeProjectCapability.mockResolvedValue({ available: false,
      reason: "native_authority_required", scopes: [] });
    const { env, currentRoute } = environment("legacy");
    const result = await readClientHubProjectManagementAction(env, principal, context as never, "/project-management");
    expect(result.availability).toMatchObject({ available: false, reason: "native_authority_required" });
    expect(result.action).toBeNull();
    expect(currentRoute).not.toHaveBeenCalled();
  });
  it.each(['source_ack_pending','source_observation_pending','source_binding_unavailable','source_mapping_unavailable'] as const)('preserves native readiness %s rather than claiming a missing legacy route',async reason=>{
    native.readClientHubNativeProjectCapability.mockResolvedValue({available:false,reason,scopes:[]});
    const result=await readClientHubProjectManagementAction(environment('legacy').env,principal,context as never,'/project-management');
    expect(result.availability).toMatchObject({available:false,reason});
    expect(result.availability.explanation).not.toContain('administrator has not reviewed');
    expect(result.action).toBeNull();
  });

});
