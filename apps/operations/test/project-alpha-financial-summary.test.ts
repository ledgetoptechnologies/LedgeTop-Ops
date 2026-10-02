import { describe, expect, it, vi } from "vitest";
import { readProjectAlphaFinancialSummary } from "../src/worker/project-alpha-financial-summary";

const sourceId = "project-alpha:ltt";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const projectPublicId = "0123456789abcdef0123456789abcdef";
const invoiceUrl = "https://pa.example.test/?page=public-doc&type=invoice&token=0123456789abcdef";
const paymentUrl = "https://pa.example.test/?page=stripe-checkout&token=abcdef0123456789";

function env(enabled: boolean | undefined = true, publicOrigins = "") {
  return {
    PROJECT_ALPHA_FINANCIAL_SUMMARY_ENABLED: enabled === undefined ? undefined : String(enabled),
    PROJECT_ALPHA_FINANCIAL_SUMMARY_PUBLIC_ORIGINS: publicOrigins,
    PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
      [sourceId]: { sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "secret-key",
        financialApiKey: "finance-readonly-key", sourceInstanceId, applicationId, historyEpoch },
    } }),
  } as never;
}

function metadata() {
  return {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "financial.portal_summary.read" }],
    implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "GET", path: "/api/v2/financial/summary", requiredCapability: "financial.portal_summary.read" },
    ],
  };
}

function summary() {
  return {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    resource: { type: "project", externalId: "42", publicId: projectPublicId },
    returnedPageTotals: { invoiceTotal: "100.00", amountPaid: "25.00", balanceDue: "75.00" },
    invoices: [{ documentNumber: 12, status: "partial", total: "100.00", amountPaid: "25.00", balanceDue: "75.00",
      dueDate: null, documentDate: "2026-10-01", invoicePublicUrl: invoiceUrl, paymentPublicUrl: paymentUrl }],
    nextCursor: null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Request-ID": requestId,
  } });
}

describe("read-only PA financial summary transport", () => {
  it("is default-off and does not inspect credentials or make a network request", async () => {
    const send = vi.fn<typeof fetch>();
    await expect(readProjectAlphaFinancialSummary(env(false), {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send)).resolves.toEqual({ ok: false, protocolVersion: 1, code: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the exact mapped project summary using the scoped server credential", async () => {
    const send = vi.fn<typeof fetch>(async input => String(input).endsWith("/api/v2/capabilities")
      ? json(metadata()) : json(summary()));
    const result = await readProjectAlphaFinancialSummary(env(), {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send);
    expect(result).toMatchObject({ ok: true, summary: { resource: { publicId: projectPublicId } } });
    expect(send).toHaveBeenCalledTimes(2);
    const [url, init] = send.mock.calls[1]!;
    expect(String(url)).toBe(`https://pa.example.test/api/v2/financial/summary?projectPublicId=${projectPublicId}&limit=100`);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer finance-readonly-key");
    expect(init).toMatchObject({ redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(JSON.stringify(result)).not.toContain("finance-readonly-key");
  });

  it("fails closed when PA lacks the dedicated scope", async () => {
    const caps = metadata();
    caps.grantedCapabilities = [{ name: "api.capabilities.read" }];
    const send = vi.fn<typeof fetch>(async () => json(caps));
    await expect(readProjectAlphaFinancialSummary(env(), {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send)).resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to the general sync key when no dedicated finance key is configured", async () => {
    const configured = env() as { PROJECT_ALPHA_API_V2_CONNECTIONS: string };
    configured.PROJECT_ALPHA_API_V2_CONNECTIONS = configured.PROJECT_ALPHA_API_V2_CONNECTIONS.replace(',"financialApiKey":"finance-readonly-key"', "");
    const send = vi.fn<typeof fetch>();
    await expect(readProjectAlphaFinancialSummary(configured as never, {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send)).resolves.toEqual({ ok: false, protocolVersion: 1, code: "misconfigured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects invoice links that escape the configured PA origin", async () => {
    const payload = summary();
    payload.invoices[0]!.invoicePublicUrl = "https://attacker.example/?page=public-doc&type=invoice&token=0123456789abcdef";
    const send = vi.fn<typeof fetch>(async input => String(input).endsWith("/api/v2/capabilities")
      ? json(metadata()) : json(payload));
    await expect(readProjectAlphaFinancialSummary(env(), {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send)).resolves.toEqual({ ok: false, protocolVersion: 1, code: "incompatible" });
  });

  it("permits a separately configured staging public-link origin without allowing other hosts", async () => {
    const stageUrl = "https://pa-staging.ledgetoptechnologies.com/?page=public-doc&type=invoice&token=0123456789abcdef";
    const payload = summary();
    payload.invoices[0]!.invoicePublicUrl = stageUrl;
    const send = vi.fn<typeof fetch>(async input => String(input).endsWith("/api/v2/capabilities")
      ? json(metadata()) : json(payload));
    const result = await readProjectAlphaFinancialSummary(env(true, "https://pa-staging.ledgetoptechnologies.com"), {
      protocolVersion: 1, sourceId, projectPublicId,
    }, send);
    expect(result).toMatchObject({ ok: true, summary: { invoices: [{ invoicePublicUrl: stageUrl }] } });
  });

  it("rejects caller-supplied untrusted source and project selectors before any request", async () => {
    const send = vi.fn<typeof fetch>();
    for (const request of [
      { protocolVersion: 1, sourceId, projectPublicId: "../../private" },
      { protocolVersion: 1, sourceId, projectPublicId, unexpected: true },
    ]) {
      await expect(readProjectAlphaFinancialSummary(env(), request, send))
        .resolves.toMatchObject({ ok: false, code: "incompatible" });
    }
    await expect(readProjectAlphaFinancialSummary(env(), {
      protocolVersion: 1, sourceId: "project-alpha:other", projectPublicId,
    }, send)).resolves.toMatchObject({ ok: false, code: "misconfigured" });
    expect(send).not.toHaveBeenCalled();
  });
});
