import { describe, expect, it, vi } from "vitest";
import { FINANCIAL_COLLECTION_TIMEOUT_MS, readConfiguredProjectAlphaFinancialDocuments, selectorFromTrustedFinancialMapping } from "../src/worker/project-alpha-financial-transport";

const source = "150cb108-af37-4973-ab6e-f6d991a6e8c8", application = "250cb108-af37-4973-ab6e-f6d991a6e8c8";
const epoch = "350cb108-af37-4973-ab6e-f6d991a6e8c8";
const mapping = { sourceId: "project-alpha:primary", kind: "client" as const, externalId: "customer-1", publicId: "a".repeat(32),
  revision: "3", projectionSha256: "b".repeat(64), authorizationGeneration: "59" };
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { "project-alpha:primary": {
  sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://pa.example.test", apiKey: "secret-key",
  sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
const selector = selectorFromTrustedFinancialMapping(mapping)!;
const document = (publicId: string) => ({ publicId, kind: "invoice", status: "unpaid", currency: "USD", total: "1.00",
  amountPaid: "0.00", balanceDue: "1.00", documentUrl: "https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
  actionUrl: "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop" });
function response(requestId: string, documents: unknown[], count: number, cursor: string | null, snapshot = "c".repeat(64), init: ResponseInit = {}) {
  return new Response(JSON.stringify({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
    requestId, selector: { kind: mapping.kind, externalId: mapping.externalId, publicId: mapping.publicId, revision: mapping.revision,
      projectionSha256: mapping.projectionSha256, authorizationGeneration: mapping.authorizationGeneration },
    snapshot: { sha256: snapshot, documentCount: count }, documents, nextCursor: cursor }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store",
    "X-Request-ID": requestId, ...(init.headers as Record<string, string> ?? {}) }, ...init });
}

describe("bounded PA financial transport", () => {
  it("keeps colliding public IDs source-local and never reuses links after a source is disabled", async () => {
    const primary = JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS).instances[mapping.sourceId];
    const secondary = { ...primary, sourceId: "project-alpha:secondary", baseUrl: "https://pa-two.example.test",
      apiKey: "second-private-key", sourceInstanceId: "750cb108-af37-4973-ab6e-f6d991a6e8c8" };
    // Independent installations may share application/history IDs and PA-local resource IDs.
    const instances = { [primary.sourceId]: primary, [secondary.sourceId]: secondary };
    const configured = () => ({ PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances }) });
    const secondaryMapping = { ...mapping, sourceId: secondary.sourceId };
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const connection = new URL(String(input)).origin === secondary.baseUrl ? secondary : primary;
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${connection.apiKey}`);
      expect(headers.get("X-PA-Source-Instance-ID")).toBe(connection.sourceInstanceId);
      const original = response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [document("d".repeat(32))], 1, null);
      const body = await original.json() as Record<string, unknown>;
      body.sourceInstanceId = connection.sourceInstanceId;
      body.documents = [{ ...document("d".repeat(32)),
        documentUrl: `${connection.baseUrl}/?page=public-doc&token=abcdefghijklmnop`,
        actionUrl: `${connection.baseUrl}/?page=stripe-checkout&token=abcdefghijklmnop` }];
      return new Response(JSON.stringify(body), { headers: original.headers });
    });
    const [one, two] = await Promise.all([
      readConfiguredProjectAlphaFinancialDocuments(configured(), mapping, selector, send as typeof fetch),
      readConfiguredProjectAlphaFinancialDocuments(configured(), secondaryMapping, selector, send as typeof fetch),
    ]);
    expect(one.status).toBe("ok"); expect(two.status).toBe("ok");
    if (one.status !== "ok" || two.status !== "ok") throw new Error("source-local collections missing");
    expect(one.value.documents[0]!.publicId).toBe(two.value.documents[0]!.publicId);
    expect(new URL(one.value.documents[0]!.documentUrl!).origin).toBe(primary.baseUrl);
    expect(new URL(two.value.documents[0]!.documentUrl!).origin).toBe(secondary.baseUrl);
    const replayedPrimary = vi.fn(async () => response("450cb108-af37-4973-ab6e-f6d991a6e8c8",
      [document("d".repeat(32))], 1, null));
    expect(await readConfiguredProjectAlphaFinancialDocuments(configured(), secondaryMapping, selector,
      replayedPrimary as typeof fetch)).toEqual({ status: "incompatible" });
    expect(replayedPrimary).toHaveBeenCalledTimes(1);
    secondary.enabled = false;
    expect(await readConfiguredProjectAlphaFinancialDocuments(configured(), secondaryMapping, selector, send as typeof fetch))
      .toEqual({ status: "disabled" });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await readConfiguredProjectAlphaFinancialDocuments(configured(), mapping, selector, send as typeof fetch)).status)
      .toBe("ok");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(["organization", "client", "project"] as const)("retains the complete trusted %s selector", async kind => {
    const selectedMapping = { ...mapping, kind };
    const selected = selectorFromTrustedFinancialMapping(selectedMapping)!;
    const send = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get("selectorType")).toBe(kind);
      const original = response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [], 0, null);
      const body = await original.json() as Record<string, unknown>;
      body.selector = { kind, externalId: mapping.externalId, publicId: mapping.publicId,
        revision: mapping.revision, projectionSha256: mapping.projectionSha256,
        authorizationGeneration: mapping.authorizationGeneration };
      return new Response(JSON.stringify(body), { headers: original.headers });
    });
    const result = await readConfiguredProjectAlphaFinancialDocuments(env, selectedMapping, selected, send as typeof fetch);
    expect(result.status).toBe("ok"); expect(send).toHaveBeenCalledTimes(1);
    if (result.status === "ok") expect(result.value.selector.kind).toBe(kind);
  });

  it("collects one immutable snapshot using only the trusted server mapping and safe GETs", async () => {
    const ids = ["150cb108-af37-4973-ab6e-f6d991a6e8c8", "650cb108-af37-4973-ab6e-f6d991a6e8c8"];
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), index = url.searchParams.has("cursor") ? 1 : 0;
      const result = response(ids[index]!, [document(index ? "e".repeat(32) : "d".repeat(32))], 2, index ? null : "next");
      return result;
    });
    const result = await readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, send as typeof fetch);
    expect({ status: result.status, calls: send.mock.calls.length }).toEqual({ status: "ok", calls: 2 });
    if (result.status === "ok") { expect(result.value.documents).toHaveLength(2); expect(Object.isFrozen(result.value.documents)).toBe(true); }
    for (const [input, init] of send.mock.calls) {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
      expect(init?.body).toBeUndefined(); expect(url.origin).toBe("https://pa.example.test");
      expect(url.searchParams.get("externalId")).toBe(mapping.externalId);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-key");
    }
  });

  it.each([
    ["snapshot drift", (n: number) => response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [document(n ? "e".repeat(32) : "d".repeat(32))], 2, n ? null : "next", n ? "f".repeat(64) : "c".repeat(64))],
    ["repeated cursor", () => response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [document("d".repeat(32))], 3, "next")],
    ["duplicate across pages", (n: number) => response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [document("d".repeat(32))], 2, n ? null : "next")],
  ])("rejects %s without disclosing upstream bytes", async (_name, make) => {
    let page = 0; const send = vi.fn(async () => make(page++));
    const result = await readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, send as typeof fetch);
    expect(result).toEqual({ status: "incompatible" }); expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects redirects, oversized pages, arbitrary selectors and disabled configuration without a follow-up", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }));
    expect(await readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, redirect as typeof fetch)).toEqual({ status: "incompatible" });
    const oversized = vi.fn(async () => new Response("x", { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
      "X-Request-ID": "450cb108-af37-4973-ab6e-f6d991a6e8c8", "Content-Length": String(128 * 1024 + 1) } }));
    expect(await readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, oversized as typeof fetch)).toEqual({ status: "incompatible" });
    expect(await readConfiguredProjectAlphaFinancialDocuments(env, { ...mapping, externalId: "other" }, selector, vi.fn() as never)).toEqual({ status: "misconfigured" });
    const disabled = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_API_V2_CONNECTIONS.replace('"enabled":true', '"enabled":false') };
    const never = vi.fn(); expect(await readConfiguredProjectAlphaFinancialDocuments(disabled, mapping, selector, never as never)).toEqual({ status: "disabled" });
    expect(never).not.toHaveBeenCalled();
  });

  it("bounds a header stall with one request-wide deadline and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const pending = readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector,
        vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch);
      await vi.advanceTimersByTimeAsync(FINANCIAL_COLLECTION_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("cancels a hanging response body at the same total deadline, including after partial bytes", async () => {
    vi.useFakeTimers(); let cancelled = 0;
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
        cancel() { cancelled += 1; },
      });
      const send = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "application/json",
        "Cache-Control": "no-store", "X-Request-ID": "450cb108-af37-4973-ab6e-f6d991a6e8c8" } }));
      const pending = readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, send as typeof fetch);
      await vi.advanceTimersByTimeAsync(FINANCIAL_COLLECTION_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(cancelled).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("shares the total deadline across pages instead of granting each page another timeout", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const send = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise(resolve => setTimeout(resolve, 6_000));
          return response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [document("d".repeat(32))], 2, "next");
        }
        return new Promise<Response>(() => undefined);
      });
      const pending = readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector, send as typeof fetch);
      await vi.advanceTimersByTimeAsync(6_000); expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not extend the timeout while the upstream cancellation itself hangs", async () => {
    vi.useFakeTimers(); let cancelled = 0;
    try {
      const stream = new ReadableStream<Uint8Array>({
        cancel() { cancelled += 1; return new Promise<void>(() => undefined); },
      });
      const pending = readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector,
        vi.fn(async () => new Response(stream, { headers: { "Content-Type": "application/json",
          "Cache-Control": "no-store", "X-Request-ID": "450cb108-af37-4973-ab6e-f6d991a6e8c8" } })) as typeof fetch);
      await vi.advanceTimersByTimeAsync(FINANCIAL_COLLECTION_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(cancelled).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("removes completed read abort listeners instead of accumulating one per chunk", async () => {
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    try {
      const original = response("450cb108-af37-4973-ab6e-f6d991a6e8c8", [], 0, null);
      const bytes = new TextEncoder().encode(await original.text());
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      } });
      const result = await readConfiguredProjectAlphaFinancialDocuments(env, mapping, selector,
        vi.fn(async () => new Response(stream, { headers: original.headers })) as typeof fetch);
      expect(result.status).toBe("ok");
      expect(add.mock.calls.filter(call => call[0] === "abort").length).toBeGreaterThan(100);
      expect(remove.mock.calls.filter(call => call[0] === "abort").length)
        .toBe(add.mock.calls.filter(call => call[0] === "abort").length);
    } finally { add.mockRestore(); remove.mockRestore(); }
  });
});
