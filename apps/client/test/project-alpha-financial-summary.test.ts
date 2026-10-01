import { describe, expect, it, vi } from "vitest";
import {
  fetchProjectAlphaFinancialSummary,
  resolveFinancialProjectAuthority,
} from "../src/worker/client-portal/project-alpha-financial-summary";
import type { Env } from "../src/worker/types";
import type { EffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "123e4567-e89b-42d3-a456-426614174000";
const applicationId = "223e4567-e89b-42d3-a456-426614174000";
const historyEpoch = "323e4567-e89b-42d3-a456-426614174000";
const requestId = "423e4567-e89b-42d3-a456-426614174000";
const projectPublicId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const projectExternalId = "ops-project-one";

const workspace: EffectivePortalWorkspaceContext = {
  workspaceId: "workspace-one",
  identityId: "identity-one",
  rootType: "organization",
  rootPublicId: "org-one",
  legacyAccountId: "account-one",
  legacyIdentityId: "legacy-person-one",
  displayName: "Workspace One",
  role: "member",
  canViewBilling: true,
};

function connection(source = sourceId) {
  return JSON.stringify({ version: 1, instances: {
    [source]: { sourceId: source, enabled: true, baseUrl: "https://pa.example.test/", apiKey: "financial-summary-key-0001",
      sourceInstanceId, applicationId, historyEpoch },
  } });
}

function env(row: unknown, overrides: Partial<Env> = {}): Env {
  const statement = { bind: vi.fn().mockReturnThis(), first: vi.fn(async () => row) };
  return {
    CLIENT_PORTAL_FINANCIAL_SUMMARY_ENABLED: "true",
    CLIENT_PORTAL_FINANCIAL_API_V2_CONNECTIONS: connection(),
    DELIVERY_DB: { withSession: () => ({ prepare: () => statement }) } as unknown as D1Database,
    ...overrides,
  } as Env;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    resource: { type: "project", externalId: projectExternalId, publicId: projectPublicId },
    returnedPageTotals: { invoiceTotal: "100.00", amountPaid: "20.00", balanceDue: "80.00" },
    invoices: [{ documentNumber: 101, status: "sent", total: "100.00", amountPaid: "20.00", balanceDue: "80.00",
      dueDate: "2026-10-01", documentDate: "2026-09-01", invoicePublicUrl: null, paymentPublicUrl: null }],
    nextCursor: null,
    ...overrides,
  };
}

function response(value = payload()): Response {
  return Response.json(value, { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
}

describe("Project Alpha client financial summary", () => {
  it("does not resolve a project when the person lacks billing permission", async () => {
    const database = env({ source_id: sourceId, project_public_id: projectPublicId });
    expect(await resolveFinancialProjectAuthority(database, { ...workspace, canViewBilling: false }, "project-one")).toBeNull();
  });

  it("fails closed when the account or per-person project grant is inactive or revoked", async () => {
    expect(await resolveFinancialProjectAuthority(env(null), workspace, "project-one")).toBeNull();
  });

  it("rejects a cross-source response identity mismatch", async () => {
    const fetcher = vi.fn(async () => response(payload({ sourceInstanceId: "523e4567-e89b-42d3-a456-426614174000" })));
    expect(await fetchProjectAlphaFinancialSummary(env(null), { sourceId, projectPublicId }, null, { fetcher })).toBeNull();
  });

  it("rejects staff-only action URLs and other unknown response fields", async () => {
    const unsafe = payload();
    (unsafe.invoices[0] as Record<string, unknown>).invoiceActionUrl = "https://pa.example.test/?page=invoice";
    const fetcher = vi.fn(async () => response(unsafe));
    expect(await fetchProjectAlphaFinancialSummary(env(null), { sourceId, projectPublicId }, null, { fetcher })).toBeNull();
  });

  it("performs one source-pinned project fetch and returns a strict scoped response", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v2/financial/summary");
      expect([...url.searchParams.keys()].sort()).toEqual(["limit", "projectPublicId"]);
      expect(url.searchParams.getAll("projectPublicId")).toEqual([projectPublicId]);
      expect(url.searchParams.has("projectExternalId")).toBe(false);
      expect(url.searchParams.get("limit")).toBe("50");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer financial-summary-key-0001");
      expect(headers.get("X-PA-Source-Instance-ID")).toBe(sourceInstanceId);
      expect(headers.get("X-PA-Application-ID")).toBe(applicationId);
      expect(headers.get("X-PA-History-Epoch")).toBe(historyEpoch);
      return response();
    });
    const result = await fetchProjectAlphaFinancialSummary(env(null), { sourceId, projectPublicId }, null, { fetcher });
    expect(result?.resource).toEqual({ type: "project", externalId: projectExternalId, publicId: projectPublicId });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed when Project Alpha is unavailable or the connector is disabled", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    expect(await fetchProjectAlphaFinancialSummary(env(null), { sourceId, projectPublicId }, null, { fetcher })).toBeNull();
    expect(await fetchProjectAlphaFinancialSummary(env(null, { CLIENT_PORTAL_FINANCIAL_SUMMARY_ENABLED: "false" }),
      { sourceId, projectPublicId }, null, { fetcher })).toBeNull();
  });
});
