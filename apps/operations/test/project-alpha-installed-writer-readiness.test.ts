import { describe, expect, it, vi } from "vitest";
import { readInstalledWriterReadiness } from "../src/worker/project-alpha-installed-writer-readiness";
import type { ProjectAlphaApiV2Endpoint } from "../src/worker/project-alpha-api-v2";

const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connection = { baseUrl: "https://private-pa.example.test", apiKey: "private-bearer",
  accessClientId: "private-access-id", accessClientSecret: "private-access-secret",
  expectedSourceInstanceId: sourceInstanceId, expectedApplicationId: applicationId, expectedHistoryEpoch: historyEpoch };

// Actual PA v2 route shapes, including singular binding-status kinds and the
// contact-only expected-revision descriptor (regular profiles omit it).
function metadata() {
  const implementedEndpoints: ProjectAlphaApiV2Endpoint[] = [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }];
  const add = (method: string, path: string, requiredCapability: string, extra = {}) => implementedEndpoints.push({
    method, path, requiredCapability, requiresSourceInstanceId: true, requiresApplicationId: true,
    requiresHistoryEpoch: true, ...extra,
  });
  for (const [kind, plural] of [["client", "clients"], ["organization", "organizations"]]) {
    add("GET", `/api/v2/directory/${plural}/{publicId}`, `directory.${plural}.read`);
    add("POST", `/api/v2/directory/${plural}/commands`, `directory.${plural}.create`);
    add("POST", `/api/v2/directory/${plural}/{publicId}/profile/commands`, `directory.${plural}.write`);
    add("GET", `/api/v2/bindings/${kind}/status/{base64urlExternalId}`, `directory.${plural}.binding_status.read`);
    add("POST", `/api/v2/directory/${plural}/bindings/revisions/commands`, `directory.${plural}.binding.revision.refresh`);
    add("POST", `/api/v2/directory/${plural}/bindings/revisions/commands/reconcile`, `directory.${plural}.binding.revision.refresh`);
  }
  add("POST", "/api/v2/directory/clients/{publicId}/contact-profile/commands", "directory.clients.write", { requiresExpectedRevision: true });
  add("POST", "/api/v2/directory/clients/{publicId}/organization/assign/commands", "directory.clients.organization.assign");
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: [...new Set(implementedEndpoints.map(item => item.requiredCapability))].map(name => ({ name })),
    implementedEndpoints };
}
function response(data: unknown = metadata(), status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId,
  } });
}

describe("installed writer readiness from a single capabilities observation", () => {
  it("checks fourteen exact endpoint contracts and the linked-create grant using one GET, without sending commands or returning secrets/raw capabilities", async () => {
    const send = vi.fn<typeof fetch>(async () => response());
    const result = await readInstalledWriterReadiness(connection, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toBe("https://private-pa.example.test/api/v2/capabilities");
    const request = send.mock.calls[0]![1]!;
    expect(request).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(new Headers(request.headers).get("Authorization")).toBe("Bearer private-bearer");
    expect(result).toMatchObject({ meaning: "advertised_prerequisites_only", singleCapabilitiesObservation: true,
      identity: { status: "advertised", exactIdentityMatch: true } });
    expect(Object.keys(result.checks).sort()).toEqual(["clientCreate", "clientRead", "clientProfileWrite", "clientContactProfileWrite",
      "clientBindingStatus", "clientBindingRefresh", "clientBindingReconcile", "organizationRead", "organizationCreate",
      "organizationProfileWrite", "organizationBindingStatus", "organizationBindingRefresh", "organizationBindingReconcile",
      "clientOrganizationAssign", "clientOrganizationAssignGrant"].sort());
    expect(Object.values(result.checks).every(item => item.status === "advertised")).toBe(true);
    const text = JSON.stringify(result);
    for (const forbidden of ["private-", "directory.", "/api/", "grantedCapabilities", "implementedEndpoints", "apiKey", "Authorization"])
      expect(text).not.toContain(forbidden);
  });

  it.each([
    ["directory.clients.create", ["clientCreate"]],
    ["directory.clients.read", ["clientRead"]],
    ["directory.clients.write", ["clientProfileWrite", "clientContactProfileWrite"]],
    ["directory.clients.binding_status.read", ["clientBindingStatus"]],
    ["directory.clients.binding.revision.refresh", ["clientBindingRefresh", "clientBindingReconcile"]],
    ["directory.organizations.read", ["organizationRead"]],
    ["directory.organizations.create", ["organizationCreate"]],
    ["directory.organizations.write", ["organizationProfileWrite"]],
    ["directory.organizations.binding_status.read", ["organizationBindingStatus"]],
    ["directory.organizations.binding.revision.refresh", ["organizationBindingRefresh", "organizationBindingReconcile"]],
    ["directory.clients.organization.assign", ["clientOrganizationAssign", "clientOrganizationAssignGrant"]],
  ] as const)("fails only the checks requiring removed granted scope %s", async (missing, expected) => {
    const data = metadata();
    data.grantedCapabilities = data.grantedCapabilities.filter(item => item.name !== missing);
    const send = vi.fn<typeof fetch>(async () => response(data));
    const result = await readInstalledWriterReadiness(connection, send);
    expect(result.identity.status).toBe("advertised");
    expect(Object.entries(result.checks).filter(([, item]) => item.status === "unavailable" && item.reason === "missing_capability")
      .map(([name]) => name).sort()).toEqual([...expected].sort());
    expect(Object.values(result.checks).some(item => item.status === "advertised")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not advertise unimplemented endpoints even when every capability is granted", async () => {
    const data = metadata();
    data.implementedEndpoints = data.implementedEndpoints.filter(item => item.path === "/api/v2/capabilities");
    const result = await readInstalledWriterReadiness(connection, async () => response(data));
    expect(Object.entries(result.checks).filter(([name]) => name !== "clientOrganizationAssignGrant")
      .every(([, item]) => item.status === "unavailable" && item.reason === "missing_endpoint")).toBe(true);
    expect(result.checks.clientOrganizationAssignGrant!.status).toBe("advertised");
  });

  it("pins the selected source and credentials across the capability await", async () => {
    const selected = { ...connection };
    const result = await readInstalledWriterReadiness(selected, async () => {
      selected.expectedApplicationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      selected.apiKey = "changed-key";
      return response();
    });
    expect(Object.values(result.checks).every(item => item.status === "advertised")).toBe(true);
  });

  it("does not substitute regular profile metadata for the contact-profile revision contract", async () => {
    const data = metadata();
    Object.assign(data.implementedEndpoints.find(item => item.path.includes("contact-profile"))!, { requiresExpectedRevision: false });
    const result = await readInstalledWriterReadiness(connection, async () => response(data));
    expect(result.checks.clientContactProfileWrite).toMatchObject({ status: "unavailable", reason: "missing_endpoint" });
    expect(result.checks.clientProfileWrite!.status).toBe("advertised");
  });

  it("distinguishes the required linked-create grant from an optional standalone assignment route", async () => {
    const data = metadata();
    data.implementedEndpoints = data.implementedEndpoints.filter(item => !item.path.includes("organization/assign/commands"));
    const result = await readInstalledWriterReadiness(connection, async () => response(data));
    expect(result.checks.clientOrganizationAssign).toMatchObject({ status: "unavailable", reason: "missing_endpoint" });
    expect(result.checks.clientOrganizationAssignGrant!.status).toBe("advertised");
    expect(result.checks.clientCreate!.status).toBe("advertised");
  });

  it("requires an explicit configured history epoch and does not make a request when it is absent", async () => {
    const send = vi.fn<typeof fetch>(async () => response());
    const result = await readInstalledWriterReadiness({ ...connection, expectedHistoryEpoch: undefined }, send);
    expect(result.identity).toMatchObject({ status: "unavailable", reason: "configuration" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["sourceInstanceId", "applicationId", "historyEpoch"] as const)("rejects a mismatched %s before advertising any check", async field => {
    const data = metadata();
    data[field] = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const result = await readInstalledWriterReadiness(connection, async () => response(data));
    expect(Object.values(result.checks).every(item => item.status === "unavailable")).toBe(true);
    expect(result.identity.exactIdentityMatch).toBe(false);
  });

  it.each([401, 403, 429, 500])("keeps HTTP %s unavailable and does not retry", async status => {
    const send = vi.fn<typeof fetch>(async () => response({}, status));
    const result = await readInstalledWriterReadiness(connection, send);
    expect(Object.values(result.checks).every(item => item.status === "unavailable")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails transport and oversized or malformed metadata closed without retry or leaking provider errors", async () => {
    for (const send of [vi.fn<typeof fetch>(async () => { throw Error("private-bearer private-provider-message"); }),
      vi.fn<typeof fetch>(async () => response("x".repeat(65537))),
      vi.fn<typeof fetch>(async () => response({ unexpected: "private-provider-message" }))]) {
      const result = await readInstalledWriterReadiness(connection, send);
      expect(Object.values(result.checks).every(item => item.status === "unavailable")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
