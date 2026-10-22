import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
const boundary = vi.hoisted(() => ({ keys: vi.fn(), admitted: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: boundary.keys }));
vi.mock("../src/worker/client-portal/workspace-v2", async () => ({
  ...await vi.importActual<typeof import("../src/worker/client-portal/workspace-v2")>("../src/worker/client-portal/workspace-v2"),
  portalIdentityAccepted: boundary.admitted,
}));
import { Hono } from "hono";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import type { ClientPortalRepository, ClientPortalSession } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
const origin = "https://portal.example", issuer = "https://synthetic.cloudflareaccess.com", audience = "synthetic-portal-only";
let pair: Awaited<ReturnType<typeof generateKeyPair>>, other: Awaited<ReturnType<typeof generateKeyPair>>, keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => { pair = await generateKeyPair("RS256", { extractable: true }); other = await generateKeyPair("RS256");
  const publicKey = await exportJWK(pair.publicKey); publicKey.kid = "portal-session-test"; keys = createLocalJWKSet({ keys: [publicKey] }); });
beforeEach(() => { boundary.keys.mockReturnValue(keys); boundary.admitted.mockResolvedValue(true); });
async function token(extra: Partial<JWTPayload> = {}, signingKey = pair.privateKey) {
  return new SignJWT({ iss: issuer, aud: audience, sub: "access|synthetic", type: "app", email: "Verified@Example.com",
    exp: Math.floor(Date.now()/1000)+300, ...extra }).setProtectedHeader({ alg: "RS256", kid: "portal-session-test" }).sign(signingKey);
}
function fixture(hierarchy = false, provisioned = true) {
  const session: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "CRM Company", role: "member", canViewBilling: false,
    principalEmail: "crm-contact@example.invalid" };
  const resolveSession = vi.fn(async () => provisioned ? session : null);
  // Unrelated repository data access must fail rather than silently succeeding.
  const unexpected = (): never => { throw Error("Unexpected repository access"); };
  const repository: ClientPortalRepository = { resolveSession,
    listProjects: unexpected, getProject: unexpected, listProjectFiles: unexpected,
    listPastDeliveries: unexpected, listProjectFileLocations: unexpected, listPastDeliveryLocations: unexpected,
    getAuthorizedFile: unexpected, listDeliveries: unexpected, getDeliveryHandoff: unexpected,
    listNotifications: unexpected, updateNotification: unexpected, listServiceRequests: unexpected,
    getServiceRequest: unexpected, createServiceRequest: unexpected, updateServiceRequest: unexpected,
    createChangeRequest: unexpected, listMembers: unexpected, listInvitations: unexpected,
    createInvitation: unexpected, revokeMember: unexpected, revokeInvitation: unexpected,
  };
  const router = createClientPortalRouter({ repository, feedbackSchemaAvailable: async () => false });
  const env = { ENVIRONMENT: "development", CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin,
    CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience,
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: hierarchy ? "true" : "false" } as Env;
  const call = (path: string, assertion: string | null, extraHeaders: Record<string,string> = {}, overrides: Partial<Env> = {}) =>
    router.request(origin+path, { headers: { ...(assertion === null ? {} : { "Cf-Access-Jwt-Assertion": assertion }), ...extraHeaders } }, { ...env, ...overrides });
  return { call, resolveSession, router, env };
}
describe("verified portal account/session metadata", () => {
  it("adds only the verified sign-in email, not the CRM contact email", async () => {
    const f = fixture(), response = await f.call("/session", await token());
    expect(response.status).toBe(200); expect((await response.json() as {account: unknown}).account).toEqual({ id: "account-a", displayName: "CRM Company", email: "verified@example.com" });
  });
  it("returns only verified expiry and server time without a workspace header", async () => {
    const f = fixture(true, false), expiry = Math.floor(Date.now()/1000)+300, before = Date.now();
    const response = await f.call("/session/status", await token({ exp: expiry }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as {serverTime: string; expiresAt: string}; expect(Object.keys(value).sort()).toEqual(["expiresAt","serverTime"]);
    expect(value.expiresAt).toBe(new Date(expiry*1000).toISOString());
    expect(Date.parse(value.serverTime)).toBeGreaterThanOrEqual(before); expect(Date.parse(value.serverTime)).toBeLessThanOrEqual(Date.now());
    const withHeader=await f.call("/session/status",await token(),{"X-LTDS-Workspace-Id":"untrusted-unused-workspace"});expect(withHeader.status).toBe(200);
  });
  it("keeps timing workspace-independent at the actual mounted API path", async () => {
    const f=fixture(true,false), app=new Hono().route("/api/client",f.router);
    const response=await app.request(origin+"/api/client/session/status", {headers:{"Cf-Access-Jwt-Assertion":await token()}},f.env);
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("uses the same signed cookie fallback when the injected assertion is absent", async () => {
    const response=await fixture().call("/session/status",null,{Cookie:`CF_Authorization=${await token()}`});expect(response.status).toBe(200);
  });
  it("preserves portal admission, account and feature/origin gates", async () => {
    const assertion=await token(), f=fixture(true); boundary.admitted.mockResolvedValueOnce(false);
    expect((await f.call("/session/status",assertion)).status).toBe(403);
    expect((await fixture(false,false).call("/session/status",assertion)).status).toBe(403);
    expect((await f.call("/session/status",assertion,{}, {CLIENT_PORTAL_ENABLED:"false"})).status).toBe(404);
    expect((await f.call("/session/status",assertion,{}, {CLIENT_PORTAL_ORIGIN:"https://other.example"})).status).toBe(404);
  });
  it.each(["missing","expired","wrong-signature","wrong-issuer","wrong-audience","missing-expiry","forged-email"])("rejects %s with no-store and no identity lookup", async kind => {
    const f=fixture(); let assertion:string|null;
    if(kind==="missing")assertion=null;
    else if(kind==="wrong-signature")assertion=await token({},other.privateKey);
    else if(kind==="forged-email") {const signed=await token();const parts=signed.split(".");parts[1]=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:"access|synthetic",type:"app",email:"attacker@example.com",exp:Math.floor(Date.now()/1000)+300})).toString("base64url");assertion=parts.join(".");}
    else assertion=await token(kind==="expired"?{exp:Math.floor(Date.now()/1000)-10}:kind==="wrong-issuer"?{iss:"https://other.cloudflareaccess.com"}:kind==="wrong-audience"?{aud:"staff-audience"}:{exp:undefined});
    const response=await f.call("/session/status",assertion);expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toBe("no-store");expect(f.resolveSession).not.toHaveBeenCalled();
  });
  it.each([{service_token_id:"machine"},{exp:Math.floor(Date.now()/1000)+300.5},{aud:[audience,"staff-audience"]}])("refuses timing without the stricter human signed-deadline proof", async claims => {
    const response=await fixture().call("/session/status",await token(claims));expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
