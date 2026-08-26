import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  createProjectAlphaPricingHintProvider,
  fetchProjectAlphaPricingHint,
  projectAlphaPricingRequestSchema,
  projectAlphaPricingHintCapability,
  resolveProjectAlphaPricingAuthorizationContext,
} from "../src/worker/client-portal/project-alpha-pricing-hint";
import pricingFixture from "../../../packages/shared/fixtures/project-alpha-pricing-hint-v1.json";
import type { ClientPricingHintInput } from "../src/worker/client-portal/types";
import type { EffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";

const now = new Date("2026-08-13T12:00:00.000Z");
const secret = "pricing-hint-hmac-secret-that-is-at-least-32-bytes";
const bearer = "pricing-preview-service-token";
const input: ClientPricingHintInput = {
  areaSquareMeters: 889_000,
  areaAcres: 219.7,
  authorizationContext: {
    workspaceRoot: { type: "organization", publicId: "pa-org-acme" },
    projectPublicId: "pa-project-north-site",
  },
  services: [{
    publicId: "svc-mapping",
    sourceVersion: "v7",
    name: "Private display name",
    summary: null,
    category: "Mapping",
    displayOrder: 10,
    geometryRequirement: "required",
    questions: [],
    answers: { browserControlledAnswer: "not-forwarded" },
  }],
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_ALPHA_PRICING_HINTS_ENABLED: "true",
    PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.example/api/v2/integrations/ltds-client-production/pricing-hints",
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
    ...pricingFixture.response,
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
      expect(String(url)).toBe("https://alpha.example/api/v2/integrations/ltds-client-production/pricing-hints");
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual(pricingFixture.request);
      expect(body).not.toContain("browserControlledAnswer");
      expect(body).not.toContain("219.7");
      expect(body).not.toContain("Private display name");
      expect(body).not.toContain("project-a");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${bearer}`);
      expect(headers.get("X-Portal-Integration-Application-Key")).toBe("ltds-client-production");
      expect(headers.get("X-Portal-Integration-Scope")).toBe("portal.pricing.preview");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const bodyHash = await hexDigest(body);
      expect(headers.get("X-Portal-Integration-Body-SHA256")).toBe(bodyHash);
      const signed = `${now.toISOString()}\nPOST\n/api/v2/integrations/ltds-client-production/pricing-hints\nportal.pricing.preview\n${bodyHash}`;
      expect(headers.get("X-Portal-Integration-Signature")).toBe(`sha256=${await signature(signed)}`);
      const tamperedHash = await hexDigest(body.replace("889000.000000", "1.000000"));
      expect(await signature(signed.replace(bodyHash, tamperedHash))).not.toBe(headers.get("X-Portal-Integration-Signature")?.slice(7));
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

  it("accepts the shared response and rejects every shared negative request and response specimen", async () => {
    expect(projectAlphaPricingRequestSchema.safeParse(pricingFixture.request).success).toBe(true);
    for (const specimen of pricingFixture.invalidRequests) {
      expect(projectAlphaPricingRequestSchema.safeParse(specimen.request).success, specimen.name).toBe(false);
    }
    await expect(fetchProjectAlphaPricingHint(input, env(), {
      fetcher: vi.fn(async () => Response.json(pricingFixture.response)) as typeof fetch,
      now,
    })).resolves.toMatchObject({ kind: "starting_at", startingAtMinor: 150_000 });
    for (const specimen of pricingFixture.invalidResponses) {
      await expect(fetchProjectAlphaPricingHint(input, env(), {
        fetcher: vi.fn(async () => Response.json(specimen.response)) as typeof fetch,
        now,
      }), specimen.name).resolves.toBeNull();
    }
  });

  it("fails closed before network for disabled, incomplete, or non-allowlisted endpoint configuration", async () => {
    const fetcher = vi.fn();
    for (const candidate of [
      env({ PROJECT_ALPHA_PRICING_HINTS_ENABLED: "false" }),
      env({ PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET: "short" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://attacker.example/api/v2/integrations/ltds-client-production/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.example/other" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "http://alpha.example/api/v2/integrations/ltds-client-production/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://user:pass@alpha.example/api/v2/integrations/ltds-client-production/pricing-hints" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://127.0.0.1/api/v2/integrations/ltds-client-production/pricing-hints", PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: "https://127.0.0.1" }),
      env({ PROJECT_ALPHA_PRICING_HINT_URL: "https://alpha.internal/api/v2/integrations/ltds-client-production/pricing-hints", PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: "https://alpha.internal" }),
    ]) {
      expect(projectAlphaPricingHintCapability(candidate).enabled).toBe(false);
      await expect(fetchProjectAlphaPricingHint(input, candidate, { fetcher, now })).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails unavailable before network for missing, malformed, or numeric legacy authorization context", async () => {
    const fetcher = vi.fn();
    for (const authorizationContext of [
      undefined,
      { workspaceRoot: { type: "organization", publicId: "42" }, projectPublicId: "pa-project-north-site" },
      { workspaceRoot: { type: "organization", publicId: "pa-org-acme" }, projectPublicId: "42" },
      { workspaceRoot: { type: "department", publicId: "pa-org-acme" }, projectPublicId: "pa-project-north-site" },
      { workspaceRoot: { type: "organization", publicId: "pa-org-acme", localId: "account-a" }, projectPublicId: "pa-project-north-site" },
    ]) {
      await expect(fetchProjectAlphaPricingHint({ ...input, authorizationContext } as ClientPricingHintInput, env(), { fetcher, now })).resolves.toBeNull();
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

describe("Project Alpha pricing authorization context resolver", () => {
  it("derives only opaque PA root/project identities from the authorized local relationship", async () => {
    const miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "pricing-context-test" },
    });
    try {
      const database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
      await database.batch([
        database.prepare("CREATE TABLE projects (id TEXT PRIMARY KEY,project_alpha_project_id TEXT,active INTEGER NOT NULL,project_alpha_source_id TEXT)"),
        database.prepare("CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT,project_alpha_source_id TEXT)"),
        database.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT,legacy_account_id TEXT,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary')"),
        database.prepare("CREATE TABLE client_project_grants (account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER NOT NULL,revoked_at TEXT)"),
      ]);
      await database.batch([
        database.prepare("INSERT INTO projects VALUES ('project-local','pa-project-north-site',1,'project-alpha:primary'),('project-secondary','pa-project-north-site',1,'project-alpha:secondary')"),
        database.prepare("INSERT INTO client_accounts VALUES ('account-a','active','project-alpha:primary'),('account-b','active','project-alpha:secondary')"),
        database.prepare("INSERT INTO portal_v2_workspaces(id,status,legacy_account_id,root_type,pa_organization_public_id,pa_client_public_id) VALUES ('workspace-a','active','account-a','organization','pa-org-acme',NULL)"),
        database.prepare("INSERT INTO client_project_grants VALUES ('account-a','project-local',1,NULL)"),
        database.prepare("INSERT INTO client_project_grants VALUES ('account-a','project-secondary',1,NULL),('account-b','project-secondary',1,NULL)"),
      ]);
      const workspace: EffectivePortalWorkspaceContext = {
        workspaceId: "workspace-a", identityId: "identity-v2", rootType: "organization",
        rootPublicId: "pa-org-acme", legacyAccountId: "account-a", legacyIdentityId: "identity-a",
        displayName: "Acme", role: "manager", canViewBilling: false,
      };
      const resolved = await resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, workspace, "project-local");
      expect(resolved).toEqual(pricingFixture.request.authorizationContext);
      expect(JSON.stringify(resolved)).not.toMatch(/project-local|account-a|identity/);
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-secondary")).resolves.toBeNull();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,{...workspace,legacyAccountId:"account-b"},"project-secondary")).resolves.toBeNull();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,{...workspace,rootPublicId:"different-root"},"project-local")).resolves.toBeNull();
      // A local legacy wrapper carries no Alpha client ref, but the verified
      // native root and explicit primary project grant still supply this API's
      // complete authorization context. A secondary wrapper never does.
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id=NULL WHERE id='account-a'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-local"))
        .resolves.toEqual(pricingFixture.request.authorizationContext);
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id='project-alpha:secondary' WHERE id='account-a'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-local")).resolves.toBeNull();
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id='project-alpha:primary' WHERE id='account-a'").run();

      await database.prepare("UPDATE projects SET project_alpha_project_id='42' WHERE id='project-local'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, workspace, "project-local")).resolves.toBeNull();
      await database.prepare("UPDATE projects SET project_alpha_project_id='pa-project-north-site',active=0 WHERE id='project-local'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, workspace, "project-local")).resolves.toBeNull();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, { ...workspace, rootPublicId: "42" }, "project-local")).resolves.toBeNull();
    } finally {
      await miniflare.dispose();
    }
  });
});
