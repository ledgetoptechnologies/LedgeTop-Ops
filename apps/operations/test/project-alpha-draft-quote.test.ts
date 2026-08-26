import { describe, expect, it, vi } from "vitest";
import {
  canonicalProjectAlphaJson,
  parseProjectAlphaDraftQuotePayload,
  parseProjectAlphaDraftQuoteResult,
  projectAlphaDraftQuoteCapability,
  projectAlphaDraftIdempotencyKey,
  sendProjectAlphaDraftQuoteCommand,
  sha256Hex,
  type ProjectAlphaDraftQuotePayload,
} from "../src/worker/project-alpha-draft-quote";
import type { Env } from "../src/worker/types";
import draftQuoteFixture from "../../../packages/shared/fixtures/project-alpha-draft-quote-v1.json";

const payload = draftQuoteFixture.valid.request as ProjectAlphaDraftQuotePayload;

function environment(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_ALPHA_BASE_URL: "https://project-alpha.example",
    PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "true",
    PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "draft-only-key",
    PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    APPLICATION_KEY: "ltds_ops",
    ...overrides,
  } as unknown as Env;
}

async function expectedHmac(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("Project Alpha private draft command", () => {
  it("accepts and rejects the shared versioned command corpus exactly", () => {
    expect(draftQuoteFixture.contract).toBe("ltds-project-alpha-draft-quote-v1");
    expect(draftQuoteFixture.endpoint).toBe("/api/v2/integrations/ltds/draft-quotes");
    expect(parseProjectAlphaDraftQuotePayload(draftQuoteFixture.valid.request)).toEqual(payload);
    expect(parseProjectAlphaDraftQuoteResult(draftQuoteFixture.valid.response)).toEqual(draftQuoteFixture.valid.response);
    for (const specimen of draftQuoteFixture.invalidRequests)
      expect(parseProjectAlphaDraftQuotePayload(specimen.request), specimen.name).toBeNull();
    for (const specimen of draftQuoteFixture.invalidResponses)
      expect(parseProjectAlphaDraftQuoteResult(specimen.response), specimen.name).toBeNull();
  });

  it("fails before signing or network for every shared invalid request", async () => {
    const fetcher = vi.fn();
    for (const specimen of draftQuoteFixture.invalidRequests) {
      await expect(sendProjectAlphaDraftQuoteCommand(
        environment(), specimen.request as ProjectAlphaDraftQuotePayload,
        "ltds-pa-draft:request-public-a:r4:a2", { fetcher },
      ), specimen.name).rejects.toMatchObject({ status: 409, code: "invalid_response" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is fail-closed by default and requires the dedicated secret set", () => {
    expect(projectAlphaDraftQuoteCapability(environment({ PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "false" }))).toEqual({
      enabled: false,
      reason: "Project Alpha draft creation is not enabled",
    });
    expect(projectAlphaDraftQuoteCapability(environment({ PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: undefined }))).toEqual({
      enabled: false,
      reason: "Project Alpha draft creation is not configured",
    });
  });

  it("keeps retries stable and changes the key for either immutable revision", () => {
    expect(projectAlphaDraftIdempotencyKey("request-public-a", 4, 2))
      .toBe("ltds-pa-draft:request-public-a:r4:a2");
    expect(projectAlphaDraftIdempotencyKey("request-public-a", 5, 2))
      .not.toBe(projectAlphaDraftIdempotencyKey("request-public-a", 4, 2));
    expect(projectAlphaDraftIdempotencyKey("request-public-a", 4, 3))
      .not.toBe(projectAlphaDraftIdempotencyKey("request-public-a", 4, 2));
  });

  it("canonicalizes the payload and signs the exact bounded body, revision key, and timestamp", async () => {
    expect(canonicalProjectAlphaJson({ z: 1, nested: { b: 2, a: 1 }, a: 3 }))
      .toBe('{"a":3,"nested":{"a":1,"b":2},"z":1}');
    const now = new Date("2026-08-13T12:34:56.000Z");
    const idempotencyKey = "ltds-pa-draft:request-public-a:r4:a2";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://project-alpha.example/api/v2/integrations/ltds_ops/draft-quotes");
      const headers = new Headers(init?.headers);
      const rawBody = String(init?.body);
      const bodyHash = await sha256Hex(rawBody);
      expect(rawBody).toBe(canonicalProjectAlphaJson(payload));
      expect(headers.get("Authorization")).toBe("Bearer draft-only-key");
      expect(headers.get("Idempotency-Key")).toBe(idempotencyKey);
      expect(headers.get("X-Portal-Integration-Application-Key")).toBe("ltds_ops");
      expect(headers.get("X-Portal-Integration-Body-SHA256")).toBe(bodyHash);
      expect(headers.get("X-Portal-Integration-Timestamp")).toBe(now.toISOString());
      expect(init?.redirect).toBe("manual");
      const signed = `${now.toISOString()}\nPOST\n/api/v2/integrations/ltds_ops/draft-quotes\n${idempotencyKey}\n${bodyHash}`;
      expect(headers.get("X-Portal-Integration-Signature")).toBe(`sha256=${await expectedHmac("0123456789abcdef0123456789abcdef", signed)}`);
      return Response.json(draftQuoteFixture.valid.response);
    });
    await expect(sendProjectAlphaDraftQuoteCommand(environment(), payload, idempotencyKey, { now, fetcher }))
      .resolves.toMatchObject({ receiptId: "receipt-public-a", draftQuote: { status: "draft" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects every shared invalid response specimen", async () => {
    for (const specimen of draftQuoteFixture.invalidResponses) {
      const call = sendProjectAlphaDraftQuoteCommand(
        environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
        { fetcher: async () => Response.json(specimen.response) },
      );
      await expect(call).rejects.toMatchObject({
        status: 502,
        code: "invalid_response",
      });
    }
  });

  it("maps every shared bounded error and makes transient failures retryable", async () => {
    const expected: Record<string, { status: number; code: string }> = {
      IDEMPOTENCY_CONFLICT: { status: 409, code: "idempotency_conflict" },
      STALE_CATALOG: { status: 409, code: "stale_catalog" },
      SCOPE_DENIED: { status: 409, code: "scope_denied" },
    };
    for (const specimen of draftQuoteFixture.errorResponses) {
      const expectedError = expected[specimen.body.code];
      expect(expectedError, specimen.body.code).toBeDefined();
      await expect(sendProjectAlphaDraftQuoteCommand(
        environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
        { fetcher: async () => Response.json(specimen.body, { status: specimen.status }) },
      )).rejects.toMatchObject(expectedError!);
    }
    await expect(sendProjectAlphaDraftQuoteCommand(
      environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
      { fetcher: async () => Response.json({}, { status: 503 }) },
    )).rejects.toMatchObject({ status: 503, code: "integration_unavailable" });
  });

  it.each(["project-alpha:secondary", "", "untrusted"])("never signs another source with the primary credentials: %s", async sourceId => {
    const fetcher = vi.fn();
    await expect(sendProjectAlphaDraftQuoteCommand(environment(), payload, "saved-command-key", { sourceId, fetcher }))
      .rejects.toMatchObject({ status: 409, code: "scope_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins the whole destination while permitting credentials to rotate at that destination", async () => {
    const target = { sourceId: "project-alpha:primary", commandEndpoint: "https://project-alpha.example/api/v2/integrations/ltds_ops/draft-quotes",
      applicationKey: "ltds_ops", editorOrigin: "https://project-alpha.example" };
    const destination = { ...target, destinationFingerprint: await sha256Hex(canonicalProjectAlphaJson(target)) };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(draftQuoteFixture.valid.response));
    for (const changed of [{ PROJECT_ALPHA_BASE_URL: "https://different-alpha.example" }, { APPLICATION_KEY: "different_app" }]) {
      await expect(sendProjectAlphaDraftQuoteCommand(environment(changed), payload, "saved-command-key", { destination, fetcher }))
        .rejects.toMatchObject({ code: "destination_changed" });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sendProjectAlphaDraftQuoteCommand(environment({ PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "rotated-key",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "r".repeat(32) }), payload, "saved-command-key", { destination, fetcher }))
      .resolves.toEqual(draftQuoteFixture.valid.response);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer rotated-key");
  });

  it.each([301, 302, 303, 307, 308])("cancels redirects without forwarding credentials (%s)", async status => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), {
      status, headers: { Location: "https://another-alpha.example/private" },
    }));
    await expect(sendProjectAlphaDraftQuoteCommand(environment(), payload, "saved-command-key", { fetcher }))
      .rejects.toMatchObject({ status: 502, code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce(); expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["declared overflow", "stream overflow", "non-JSON", "invalid UTF-8"])("rejects and releases bounded response: %s", async specimen => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (specimen === "stream overflow") controller.enqueue(new Uint8Array(16 * 1024 + 1));
        if (specimen === "invalid UTF-8") { controller.enqueue(new Uint8Array([0xc3, 0x28])); controller.close(); }
      }, cancel: cancelled,
    });
    const headers: Record<string,string> = { "Content-Type": specimen === "non-JSON" ? "text/html" : "application/json" };
    if (specimen === "declared overflow") headers["Content-Length"] = "16385";
    await expect(sendProjectAlphaDraftQuoteCommand(environment(), payload, "saved-command-key", {
      fetcher: async () => new Response(stream, { headers }),
    })).rejects.toMatchObject({ status: 502, code: "invalid_response" });
    if (specimen !== "invalid UTF-8") expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each(["fetch", "body"])("bounds a stalled %s and cancels any late response", async stage => {
    vi.useFakeTimers();
    try {
      let started!: () => void, resolveFetch!: (response: Response) => void;
      const start = new Promise<void>(resolve => { started = resolve; });
      const cancelled = vi.fn();
      const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "application/json" } });
      const pending = sendProjectAlphaDraftQuoteCommand(environment(), payload, "saved-command-key", {
        fetcher: async () => { started(); return stage === "body" ? response : new Promise<Response>(resolve => { resolveFetch = resolve; }); },
      });
      const rejected = expect(pending).rejects.toMatchObject({ status: 503, code: "integration_unavailable" });
      await start;
      await vi.advanceTimersByTimeAsync(8_001);
      await rejected;
      if (stage === "fetch") { resolveFetch(response); await Promise.resolve(); await Promise.resolve(); }
      expect(cancelled).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
