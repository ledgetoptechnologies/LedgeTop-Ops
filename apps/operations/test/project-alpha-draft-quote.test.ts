import { describe, expect, it, vi } from "vitest";
import {
  canonicalProjectAlphaJson,
  projectAlphaDraftQuoteCapability,
  projectAlphaDraftIdempotencyKey,
  sendProjectAlphaDraftQuoteCommand,
  sha256Hex,
  type ProjectAlphaDraftQuotePayload,
} from "../src/worker/project-alpha-draft-quote";
import type { Env } from "../src/worker/types";

const payload: ProjectAlphaDraftQuotePayload = {
  schemaVersion: 1,
  source: "ltds-operations",
  request: {
    publicId: "request-public-a",
    revision: 4,
    title: "North site mapping",
    scopeSummary: "Capture the reviewed area.",
    deliverablesSummary: "Orthomosaic and stills",
  },
  authorization: {
    organizationPublicId: "org-public-a",
    clientPublicId: "client-public-a",
    projectPublicId: "project-public-a",
  },
  services: [{
    publicId: "svc-ortho",
    catalogVersion: "catalog-7",
    answers: { resolution: "standard" },
  }],
  workArea: {
    revision: 2,
    hash: "a".repeat(64),
    squareMeters: 8093.713,
    acres: 2,
  },
  attachments: [{
    name: "authorization.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    sha256: "b".repeat(64),
  }],
};

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
      return Response.json({
        receiptId: "receipt-public-a",
        draftQuote: {
          publicId: "quote-public-a",
          documentNumber: "Q-DRAFT-7",
          status: "draft",
          version: 1,
          editorPath: "/quotes/quote-public-a/edit",
        },
      });
    });
    await expect(sendProjectAlphaDraftQuoteCommand(environment(), payload, idempotencyKey, { now, fetcher }))
      .resolves.toMatchObject({ receiptId: "receipt-public-a", draftQuote: { status: "draft" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects non-draft and non-relative editor responses", async () => {
    const invalid = [
      { publicId: "quote-a", documentNumber: null, status: "approved", version: 1, editorPath: "/quotes/a" },
      { publicId: "quote-a", documentNumber: null, status: "draft", version: 1, editorPath: "https://evil.example/quotes/a" },
    ];
    for (const draftQuote of invalid) {
      const call = sendProjectAlphaDraftQuoteCommand(
        environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
        { fetcher: async () => Response.json({ receiptId: "receipt-a", draftQuote }) },
      );
      await expect(call).rejects.toMatchObject({
        status: 502,
        code: "invalid_response",
      });
    }
  });

  it("surfaces catalog staleness and makes transient failures explicitly retryable", async () => {
    await expect(sendProjectAlphaDraftQuoteCommand(
      environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
      { fetcher: async () => Response.json({ code: "STALE_CATALOG" }, { status: 409 }) },
    )).rejects.toMatchObject({ status: 409, code: "stale_catalog" });
    await expect(sendProjectAlphaDraftQuoteCommand(
      environment(), payload, "ltds-pa-draft:request-public-a:r4:a2",
      { fetcher: async () => Response.json({}, { status: 503 }) },
    )).rejects.toMatchObject({ status: 503, code: "integration_unavailable" });
  });
});
