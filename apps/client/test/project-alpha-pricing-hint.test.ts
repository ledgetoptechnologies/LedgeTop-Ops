import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { PRIMARY_ALPHA_SOURCE_ID, PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import {
  createProjectAlphaPricingHintProvider,
  fetchProjectAlphaPricingHint,
  projectAlphaPricingRequestSchema,
  projectAlphaPricingHintCapability,
  resolveProjectAlphaPricingAuthorizationContext as resolvePricingContext,
} from "../src/worker/client-portal/project-alpha-pricing-hint";
import pricingFixture from "../../../packages/shared/fixtures/project-alpha-pricing-hint-v1.json";
import type { ClientPricingHintInput } from "../src/worker/client-portal/types";
import type { EffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";

const now = new Date("2026-08-13T12:00:00.000Z");
const secret = "pricing-hint-hmac-secret-that-is-at-least-32-bytes";
const bearer = "pricing-preview-service-token";
const input: ClientPricingHintInput = {
  catalogSource: PRIMARY_CATALOG_SOURCE,
  areaSquareMeters: 889_000,
  areaAcres: 219.7,
  authorizationContext: {
    sourceId: PRIMARY_ALPHA_SOURCE_ID,
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

const draftProof = { id: "draft-a", version: 1 };
const resolveProjectAlphaPricingAuthorizationContext = (
  candidate: Env, workspace: EffectivePortalWorkspaceContext, projectId: string,
) => resolvePricingContext(candidate, workspace, projectId, draftProof);
const expectedContext = {
  catalogSource: PRIMARY_CATALOG_SOURCE,
  authorizationContext: { ...pricingFixture.request.authorizationContext, sourceId: PRIMARY_ALPHA_SOURCE_ID },
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
      expect(init?.redirect).toBe("manual");
      expect(body).not.toContain(PRIMARY_ALPHA_SOURCE_ID);
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
      await expect(fetchProjectAlphaPricingHint({ ...input, authorizationContext: authorizationContext
        ? { ...authorizationContext, sourceId: PRIMARY_ALPHA_SOURCE_ID } : undefined } as ClientPricingHintInput, env(), { fetcher, now })).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never falls back to the primary scalar connector for missing, mismatched or secondary provenance", async () => {
    const fetcher = vi.fn();
    for (const [catalogSource, sourceId] of [
      [undefined, PRIMARY_ALPHA_SOURCE_ID],
      [PRIMARY_CATALOG_SOURCE, undefined],
      [{ sourceId: "project-alpha:secondary" }, PRIMARY_ALPHA_SOURCE_ID],
      [PRIMARY_CATALOG_SOURCE, "project-alpha:secondary"],
      [{ sourceId: "project-alpha:secondary" }, "project-alpha:secondary"],
      [{ sourceId: "project-alpha:primary " }, PRIMARY_ALPHA_SOURCE_ID],
    ]) {
      await expect(fetchProjectAlphaPricingHint({ ...input, catalogSource,
        authorizationContext: { ...input.authorizationContext, sourceId } } as ClientPricingHintInput,
      env(), { fetcher, now })).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([301, 302, 303, 307, 308, 401, 500])("cancels a rejected %s response without following its location", async status => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(new ReadableStream({ cancel }), { status,
        headers: { Location: "https://other.example/private", "Content-Type": "application/json" } });
    });
    await expect(fetchProjectAlphaPricingHint(input, env(), { fetcher: fetcher as typeof fetch, now })).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { "Content-Type": "text/html" },
    { "Content-Type": "application/json", "Content-Length": "16385" },
    { "Content-Type": "application/json", "Content-Length": "invalid" },
  ])("cancels unread bodies with rejected response headers %j", async headers => {
    const cancel = vi.fn();
    await expect(fetchProjectAlphaPricingHint(input, env(), { now,
      fetcher: vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: headers as Record<string, string> })) as typeof fetch,
    })).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds unknown-length streams and rejects malformed UTF-8", async () => {
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8192)); controller.enqueue(new Uint8Array(8193)); }, cancel,
    });
    await expect(fetchProjectAlphaPricingHint(input, env(), { now,
      fetcher: vi.fn(async () => new Response(oversized, { headers: { "Content-Type": "application/json" } })) as typeof fetch,
    })).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(fetchProjectAlphaPricingHint(input, env(), { now,
      fetcher: vi.fn(async () => new Response(new Uint8Array([123, 34, 255, 34, 58, 48, 125]),
        { headers: { "Content-Type": "application/json" } })) as typeof fetch,
    })).resolves.toBeNull();
  });

  it("bounds a hanging response body through the same four-second deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let started!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const observed: { signal?: AbortSignal | null } = {};
    try {
      const result = fetchProjectAlphaPricingHint(input, env(), { now,
        fetcher: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          observed.signal = init?.signal;
          started();
          return new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json" } });
        }) as typeof fetch,
      });
      await fetching;
      await vi.advanceTimersByTimeAsync(4001);
      await expect(result).resolves.toBeNull();
      expect(observed.signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("bounds a fetch that ignores cancellation and cancels its late response", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: Response) => void;
    const responsePending = new Promise<Response>(resolve => { finish = resolve; });
    const cancel = vi.fn();
    try {
      const result = fetchProjectAlphaPricingHint(input, env(), { now,
        fetcher: vi.fn(() => { started(); return responsePending; }) as typeof fetch,
      });
      await fetching;
      await vi.advanceTimersByTimeAsync(4001);
      await expect(result).resolves.toBeNull();
      finish(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects a hint that expires while the response is being read", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    try {
      const result = fetchProjectAlphaPricingHint(input, env(), { now,
        fetcher: vi.fn(async () => {
          started();
          return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
            { headers: { "Content-Type": "application/json" } });
        }) as typeof fetch,
      });
      await fetching;
      await vi.advanceTimersByTimeAsync(2000);
      stream.enqueue(new TextEncoder().encode(JSON.stringify({ ...pricingFixture.response, validUntil: "2026-08-13T12:00:01.000Z" })));
      stream.close();
      await expect(result).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
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
        database.prepare("CREATE TABLE client_service_request_drafts (id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,version INTEGER,catalog_source_id TEXT)"),
        database.prepare("CREATE TABLE client_service_request_draft_services (draft_id TEXT,service_source_id TEXT)"),
      ]);
      await database.batch([
        database.prepare("INSERT INTO projects VALUES ('project-local','pa-project-north-site',1,'project-alpha:primary'),('project-secondary','pa-project-north-site',1,'project-alpha:secondary')"),
        database.prepare("INSERT INTO client_accounts VALUES ('account-a','active','project-alpha:primary'),('account-b','active','project-alpha:secondary')"),
        database.prepare("INSERT INTO portal_v2_workspaces(id,status,legacy_account_id,root_type,pa_organization_public_id,pa_client_public_id) VALUES ('workspace-a','active','account-a','organization','pa-org-acme',NULL)"),
        database.prepare("INSERT INTO client_project_grants VALUES ('account-a','project-local',1,NULL)"),
        database.prepare("INSERT INTO client_project_grants VALUES ('account-a','project-secondary',1,NULL),('account-b','project-secondary',1,NULL)"),
        database.prepare("INSERT INTO client_service_request_drafts VALUES ('draft-a','account-a','project-local',1,'project-alpha:primary')"),
        database.prepare("INSERT INTO client_service_request_draft_services VALUES ('draft-a','project-alpha:primary')"),
      ]);
      const workspace: EffectivePortalWorkspaceContext = {
        workspaceId: "workspace-a", identityId: "identity-v2", rootType: "organization",
        rootPublicId: "pa-org-acme", legacyAccountId: "account-a", legacyIdentityId: "identity-a",
        displayName: "Acme", role: "manager", canViewBilling: false,
      };
      const resolved = await resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, workspace, "project-local");
      expect(resolved).toEqual(expectedContext);
      expect(JSON.stringify(resolved)).not.toMatch(/project-local|account-a|identity/);
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-secondary")).resolves.toBeNull();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,{...workspace,legacyAccountId:"account-b"},"project-secondary")).resolves.toBeNull();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,{...workspace,rootPublicId:"different-root"},"project-local")).resolves.toBeNull();
      // A local legacy wrapper carries no Alpha client ref, but the verified
      // native root and explicit primary project grant still supply this API's
      // complete authorization context. A secondary wrapper never does.
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id=NULL WHERE id='account-a'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-local"))
        .resolves.toEqual(expectedContext);
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id='project-alpha:secondary' WHERE id='account-a'").run();
      await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env,workspace,"project-local")).resolves.toBeNull();
      await database.prepare("UPDATE client_accounts SET project_alpha_source_id='project-alpha:primary' WHERE id='account-a'").run();

      for (const update of [
        "UPDATE client_service_request_drafts SET catalog_source_id='project-alpha:secondary' WHERE id='draft-a'",
        "UPDATE client_service_request_drafts SET account_id='account-b' WHERE id='draft-a'",
        "UPDATE client_service_request_drafts SET version=2 WHERE id='draft-a'",
        "UPDATE client_service_request_draft_services SET service_source_id='project-alpha:secondary' WHERE draft_id='draft-a'",
        "UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:secondary' WHERE id='workspace-a'",
      ]) {
        await database.prepare(update).run();
        await expect(resolveProjectAlphaPricingAuthorizationContext({ DELIVERY_DB: database } as Env, workspace, "project-local")).resolves.toBeNull();
        await database.batch([
          database.prepare("UPDATE client_service_request_drafts SET catalog_source_id='project-alpha:primary',account_id='account-a',version=1 WHERE id='draft-a'"),
          database.prepare("UPDATE client_service_request_draft_services SET service_source_id='project-alpha:primary' WHERE draft_id='draft-a'"),
          database.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:primary' WHERE id='workspace-a'"),
        ]);
      }
      await expect(resolvePricingContext({ DELIVERY_DB: database } as Env, workspace, "project-local", { id: "draft-a", version: 2 })).resolves.toBeNull();
      await expect(resolvePricingContext({ DELIVERY_DB: database } as Env, workspace, "project-local", { id: "missing-draft", version: 1 })).resolves.toBeNull();

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
