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
      expect(String(input)).toBe("https://project-alpha.example/api/v2/integrations/ltds/draft-quotes");
      const headers = new Headers(init?.headers);
      const rawBody = String(init?.body);
      const bodyHash = await sha256Hex(rawBody);
      expect(rawBody).toBe(canonicalProjectAlphaJson(payload));
      expect(headers.get("Authorization")).toBe("Bearer draft-only-key");
      expect(headers.get("Idempotency-Key")).toBe(idempotencyKey);
      expect(headers.get("X-LTDS-Application-Key")).toBe("ltds_ops");
      expect(headers.get("X-LTDS-Body-SHA256")).toBe(bodyHash);
      expect(headers.get("X-LTDS-Timestamp")).toBe(now.toISOString());
      expect(init?.redirect).toBe("error");
      const signed = `${now.toISOString()}\nPOST\n/api/v2/integrations/ltds/draft-quotes\n${idempotencyKey}\n${bodyHash}`;
      expect(headers.get("X-LTDS-Signature")).toBe(`sha256=${await expectedHmac("0123456789abcdef0123456789abcdef", signed)}`);
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
});
