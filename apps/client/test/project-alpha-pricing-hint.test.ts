import { describe, expect, it, vi } from "vitest";
import {
  createProjectAlphaPricingHintProvider,
  fetchProjectAlphaPricingHint,
  projectAlphaPricingHintCapability,
} from "../src/worker/client-portal/project-alpha-pricing-hint";
import type { ClientPricingHintInput } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const now = new Date("2026-08-13T12:00:00.000Z");
const secret = "pricing-hint-hmac-secret-that-is-at-least-32-bytes";
const bearer = "pricing-preview-service-token";
const input: ClientPricingHintInput = {
  areaSquareMeters: 889_000,
  areaAcres: 219.7,
  services: [{
    publicId: "svc-mapping",
    sourceVersion: "v7",
    name: "Private display name",
    summary: null,
    questions: [],
    answers: { browserControlledAnswer: "not-forwarded" },
  }],
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_ALPHA_PRICING_HINTS_ENABLED: "true",
    PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.example/api/v2/integrations/ltds/pricing-hints",
    PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: "https://alpha.example",
    PROJECT_ALPHA_PRICING_HINT_API_KEY: bearer,
    PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET: secret,
    PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY: "ltds-client-production",
    PROJECT_ALPHA_PRICING_HINT_CURRENCIES: "USD,CAD",
    ...overrides,
  } as Env;
}

function response(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    schemaVersion: 1,
    catalogVersion: "catalog-v19",
    coverageSquareMetres: "889000.000000",
    displayMode: "starting_at",
    currency: "USD",
    startingAt: "1500.00",
    typicalMinimum: null,
    typicalMaximum: null,
    reasonUnavailable: null,
    disclaimer: "Planning guidance only. Final quote after staff review.",
    validUntil: "2026-08-13T12:10:00.000Z",
    ...overrides,
  });
}

async function hexDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("Project Alpha pricing hint provider", () => {
  it("sends only canonical server coverage and public service identities with an exact-body signature", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://alpha.example/api/v2/integrations/ltds/pricing-hints");
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual({
        coverageSquareMetres: "889000.000000",
        schemaVersion: 1,
        scope: "portal.pricing.preview",
        services: [{ publicId: "svc-mapping", sourceVersion: "v7" }],
        source: "ltds-client-portal",
      });
      expect(body).not.toContain("browserControlledAnswer");
      expect(body).not.toContain("219.7");
      expect(body).not.toContain("Private display name");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${bearer}`);
      expect(headers.get("X-LTDS-Scope")).toBe("portal.pricing.preview");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const bodyHash = await hexDigest(body);
      expect(headers.get("X-LTDS-Body-SHA256")).toBe(bodyHash);
      const signed = `${now.toISOString()}\nPOST\n/api/v2/integrations/ltds/pricing-hints\nportal.pricing.preview\n${bodyHash}`;
      expect(headers.get("X-LTDS-Signature")).toBe(`sha256=${await signature(signed)}`);
      const tamperedHash = await hexDigest(body.replace("889000.000000", "1.000000"));
      expect(await signature(signed.replace(bodyHash, tamperedHash))).not.toBe(headers.get("X-LTDS-Signature")?.slice(7));
      return response();
    });
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: fetcher as typeof fetch, now })).resolves.toEqual({
      kind: "starting_at",
      currency: "USD",
      startingAtMinor: 150_000,
      disclaimer: "Planning guidance only. Final quote after staff review.",
      basisVersion: "catalog-v19",
      validUntil: "2026-08-13T12:10:00.000Z",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed before network for disabled, incomplete, or non-allowlisted endpoint configuration", async () => {
    const fetcher = vi.fn();
    for (const candidate of [
      env({ PROJECT_ALPHA_PRICING_HINTS_ENABLED: "false" }),
      env({ PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET: "short" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://attacker.example/api/v2/integrations/ltds/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.example/other" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "http://alpha.example/api/v2/integrations/ltds/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://user:pass@alpha.example/api/v2/integrations/ltds/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://127.0.0.1/api/v2/integrations/ltds/pricing-hints", PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: "https://127.0.0.1" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.internal/api/v2/integrations/ltds/pricing-hints", PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: "https://alpha.internal" }),
    ]) {
      expect(projectAlphaPricingHintCapability(candidate).enabled).toBe(false);
      await expect(fetchProjectAlphaPricingHint(input, candidate, { fetcher, now })).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["unapproved currency", { currency: "EUR" }],
    ["malformed decimal", { startingAt: "1500" }],
    ["negative decimal", { startingAt: "-1.00" }],
    ["mismatched coverage", { coverageSquareMetres: "1.000000" }],
    ["unsafe disclaimer", { disclaimer: "Guaranteed quote" }],
    ["expired result", { validUntil: "2026-08-13T11:59:59.000Z" }],
    ["overlong freshness", { validUntil: "2026-08-15T12:00:00.000Z" }],
    ["extra response field", { internalFormula: "secret" }],
  ])("degrades %s to unavailable", async (_name, override) => {
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: vi.fn(async () => response(override)) as typeof fetch, now })).resolves.toBeNull();
  });

  it("accepts a bounded typical range and rejects reversed endpoints", async () => {
    const provider = createProjectAlphaPricingHintProvider({
      now,
      fetcher: vi.fn(async () => response({
        displayMode: "typical_range", startingAt: null, typicalMinimum: "1800.00", typicalMaximum: "2400.00",
      })) as typeof fetch,
    });
    await expect(provider(input, env())).resolves.toMatchObject({ kind: "typical_range", minimumMinor: 180_000, maximumMinor: 240_000 });
    await expect(fetchProjectAlphaPricingHint(input, env(), { now, fetcher: vi.fn(async () => response({
      displayMode: "typical_range", startingAt: null, typicalMinimum: "2400.00", typicalMaximum: "1800.00",
    })) as typeof fetch })).resolves.toBeNull();
  });

  it("treats timeout, upstream denial, oversized data, and none mode as unavailable without leaking credentials", async () => {
    const throwing = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); });
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: throwing as typeof fetch, now })).resolves.toBeNull();
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: vi.fn(async () => new Response(bearer, { status: 401 })) as typeof fetch, now })).resolves.toBeNull();
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: vi.fn(async () => new Response("x".repeat(16 * 1024 + 1), { headers: { "Content-Type": "application/json" } })) as typeof fetch, now })).resolves.toBeNull();
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: vi.fn(async () => response({
      displayMode: "none", currency: null, startingAt: null, reasonUnavailable: "Scope requires staff review",
    })) as typeof fetch, now })).resolves.toBeNull();
  });
});
