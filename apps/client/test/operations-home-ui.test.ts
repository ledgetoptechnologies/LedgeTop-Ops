import { describe, expect, it } from "vitest";
import { loadOperationsHome, type PortalRequest } from "../src/client/portal-api";
import { isUnifiedPortalRoot, operationsBootstrapOutcome } from "../src/client/PortalBootstrapApp";
import { isOptionalClientWorkspaceBootstrapAbsence } from "../src/client/portal-bootstrap-classification";

const home = {
  authorityId: "12345678-1234-4123-8123-123456789abc",
  workspaceId: "workspace-one",
  ownershipEpoch: 2,
  grantRevision: 4,
  services: [
    { serviceId: "service-one", providerId: "provider-one", displayLabel: "Aerial operations", revision: 3 },
  ],
};

function requestReturning(value: unknown, calls: Array<{ url: string; init?: RequestInit & { omitWorkspace?: boolean } }>): PortalRequest {
  return (async (url: string, init?: RequestInit & { omitWorkspace?: boolean }) => {
    calls.push({ url, init });
    return value;
  }) as PortalRequest;
}

describe("operations home browser API", () => {
  it("accepts the exact bounded envelope without a legacy workspace header", async () => {
    const calls: Array<{ url: string; init?: RequestInit & { omitWorkspace?: boolean } }> = [];
    const signal = new AbortController().signal;
    await expect(loadOperationsHome(requestReturning({ resourceMode: "operations_home", homes: [home] }, calls), signal))
      .resolves.toEqual({ resourceMode: "operations_home", homes: [home] });
    expect(calls).toEqual([{ url: "/api/client/v2/operations/home", init: { signal, omitWorkspace: true } }]);
  });

  it.each([
    ["no authorized homes", { resourceMode: "operations_home", homes: [] }],
    ["an authorized home with no listed services", { resourceMode: "operations_home", homes: [{ ...home, services: [] }] }],
  ])("accepts %s as a verified empty service home", async (_name, response) => {
    await expect(loadOperationsHome(requestReturning(response, []))).resolves.toEqual(response);
  });

  it("accepts the server field boundaries and opaque identifiers containing slashes", async () => {
    const boundaryHome = {
      ...home,
      workspaceId: `/${"w".repeat(199)}`,
      services: [
        { serviceId: `/${"s".repeat(128)}`, providerId: `/${"p".repeat(127)}`, displayLabel: "L".repeat(160), revision: 1 },
        { serviceId: `/${"t".repeat(190)}`, providerId: "provider/with/slash", displayLabel: "Service two", revision: 2 },
      ],
    };
    await expect(loadOperationsHome(requestReturning({ resourceMode: "operations_home", homes: [boundaryHome] }, [])))
      .resolves.toEqual({ resourceMode: "operations_home", homes: [boundaryHome] });
  });

  it.each([
    ["extra envelope data", { resourceMode: "operations_home", homes: [home], token: "secret" }],
    ["wrong mode", { resourceMode: "legacy", homes: [home] }],
    ["duplicate authority", { resourceMode: "operations_home", homes: [home, { ...home, workspaceId: "workspace-two" }] }],
    ["duplicate service", { resourceMode: "operations_home", homes: [{ ...home, services: [home.services[0], home.services[0]] }] }],
    ["too many homes", { resourceMode: "operations_home", homes: Array.from({ length: 21 }, (_, index) => ({ ...home, authorityId: `authority-${index}` })) }],
    ["too many services", { resourceMode: "operations_home", homes: [{ ...home, services: Array.from({ length: 101 }, (_, index) => ({ ...home.services[0], serviceId: `service-${index}` })) }] }],
    ["service ID over 191 characters", { resourceMode: "operations_home", homes: [{ ...home, services: [{ ...home.services[0], serviceId: "s".repeat(192) }] }] }],
    ["provider ID over 128 characters", { resourceMode: "operations_home", homes: [{ ...home, services: [{ ...home.services[0], providerId: "p".repeat(129) }] }] }],
    ["label over 160 characters", { resourceMode: "operations_home", homes: [{ ...home, services: [{ ...home.services[0], displayLabel: "x".repeat(161) }] }] }],
    ["workspace over 200 characters", { resourceMode: "operations_home", homes: [{ ...home, workspaceId: "w".repeat(201) }] }],
    ["unsafe revision", { resourceMode: "operations_home", homes: [{ ...home, grantRevision: Number.MAX_SAFE_INTEGER + 1 }] }],
  ])("fails closed for %s", async (_name, response) => {
    await expect(loadOperationsHome(requestReturning(response, []))).rejects.toMatchObject({ status: 503 });
  });
});

describe("operations home bootstrap routing", () => {
  it("classifies only an unscoped Client admission denial as an absent optional workspace surface", () => {
    const absent = Object.assign(new Error("not provisioned"), {
      status: 403,
      body: { error: "Client access is not provisioned" },
    });
    expect(isOptionalClientWorkspaceBootstrapAbsence(absent, null)).toBe(true);
    expect(isOptionalClientWorkspaceBootstrapAbsence(absent, "requested-workspace")).toBe(false);
    expect(isOptionalClientWorkspaceBootstrapAbsence(Object.assign(new Error("denied"), {
      status: 403,
      body: { error: "Select an authorized client workspace" },
    }), null)).toBe(false);
    expect(isOptionalClientWorkspaceBootstrapAbsence(Object.assign(new Error("unavailable"), {
      status: 503,
      body: { error: "Client access is not provisioned" },
    }), null)).toBe(false);
  });

  it("probes only the unified portal root", () => {
    expect(isUnifiedPortalRoot("/portal")).toBe(true);
    expect(isUnifiedPortalRoot("/portal/")).toBe(true);
    expect(isUnifiedPortalRoot("/portal/dashboard")).toBe(false);
    expect(isUnifiedPortalRoot("/portal/projects")).toBe(false);
    expect(isUnifiedPortalRoot("/s/public-share")).toBe(false);
  });

  it("allows legacy fallback only for an explicit 404", () => {
    expect(operationsBootstrapOutcome(Object.assign(new Error("disabled"), { status: 404 }))).toBe("legacy");
    for (const failure of [
      Object.assign(new Error("unauthenticated"), { status: 401 }),
      Object.assign(new Error("forbidden"), { status: 403 }),
      Object.assign(new Error("unavailable"), { status: 503 }),
      new TypeError("network failure"),
      { get status() { throw new Error("hostile accessor"); } },
    ]) expect(operationsBootstrapOutcome(failure)).toBe("blocked");
  });
});
