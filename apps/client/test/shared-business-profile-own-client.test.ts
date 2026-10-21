import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleProjectAlphaPortalProjectionRequest } from "../src/worker/project-alpha-portal";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { verifiedClientPrincipalFromAccessPayload } from "../src/worker/client-portal/access-identity";
import { PORTAL_WORKSPACE_HEADER, resolveEffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import {createBusinessProfileRouter,resolveBusinessProfileProof} from '../src/worker/client-portal/business-profile';
import {readSharedProfilePortalAuthority} from '../src/worker/shared-profile-portal-authority-entrypoint';
import {authorizeNativePortalReadTarget,resolveNativePortalWorkspaceReadContext} from '../src/worker/client-portal/workspace-v2';
import type {SharedProfilePortalBinding,SharedProfilePortalProof} from '../../../packages/shared/src/shared-business-profile';
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

vi.mock('cloudflare:workers',()=>({WorkerEntrypoint:class{}}));
const applicationKey = "field_operations_portal";
const keyId = "primary-native-test-v1";
const secret = "primary-native-test-secret-at-least-thirty-two-bytes";
const ingressPath = "/api/internal/project-alpha/portal-v2";
const origin = "https://client.test";
const flags = ["CLIENT_PORTAL_HIERARCHY_V2_ENABLED", "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED", "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED"] as const;

async function hexDigest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("standalone own-client profile target resolution", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  const sendEmail = vi.fn();

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "primary-native-portal-eligibility" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await db.prepare("UPDATE portal_shared_profile_runtime SET hooks_ready=1 WHERE id=1").run();
    env = {
      DELIVERY_DB: db, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId, PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "primary-native-sync-audience",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true", CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true",
      CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "true", CLIENT_PORTAL_INVITATION_EMAIL: { send: sendEmail },
    } as unknown as Env;
  }, 60_000);

  afterAll(async () => runtime?.dispose());

  async function deliver(payload: Record<string, unknown>, environment = env) {
    const body = JSON.stringify(payload), timestamp = new Date().toISOString();
    const signingKeyId = environment.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID!;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(environment.PROJECT_ALPHA_PORTAL_HMAC_SECRET!),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(
      `${timestamp}\nPOST\n${ingressPath}\n${signingKeyId}\n${payload.deliveryId}\n${body}`));
    const signature = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return handleProjectAlphaPortalProjectionRequest(new Request(`${origin}${ingressPath}`, {
      method: "POST", headers: { "Content-Type": "application/json",
        "X-Portal-Integration-Application-Key": applicationKey, "X-Portal-Integration-Timestamp": timestamp,
        "X-Portal-Integration-Body-SHA256": await hexDigest(body), "X-Portal-Integration-Key-Id": signingKeyId,
        "X-Portal-Integration-Delivery-Id": String(payload.deliveryId), "X-Portal-Integration-Signature": `sha256=${signature}` }, body,
    }), environment, async () => undefined);
  }

  async function project(name: string, options: { duplicateEmail?: boolean; noPrincipals?: boolean } = {}) {
    const workspaceId = `pa-workspace-${name}`, rootId = `pa-org-${name}`;
    const actor: VerifiedClientPrincipal = { issuer: "https://team.cloudflareaccess.com",
      subject: `subject-${name}`, email: `${name}@example.test` };
    const principalId = `pa-principal-${name}`;
    const principals = options.noPrincipals ? [] : [{ publicId: principalId, emailHint: actor.email,
      displayName: "Verified person", sourceVersion: "principal-v1", active: true }];
    if (options.duplicateEmail) principals.push({ ...principals[0]!, publicId: `${principalId}-duplicate` });
    const entitlements = options.noPrincipals ? [] : ["workspace.view", "directory.read"].map((capability, index) => ({
      publicId: `pa-entitlement-${name}-${index}`, principalPublicId: principalId, capability, effect: "allow",
      scopeType: "client", scopePublicId: rootId, sourceVersion: "grant-v1", active: true,
      validFrom: "2026-01-01T00:00:00.000Z", expiresAt: null,
    }));
    const common = { schemaVersion: 2, applicationKey, occurredAt: "2026-09-03T00:00:00.000Z",
      sourceGeneration: `generation-${name}`, sourceSequence: 10, workspaceId, snapshotHash: "b".repeat(64),
      pageCount: 1, recordCount: 1 + principals.length + entitlements.length };
    const page = { ...common, kind: "snapshot.page", deliveryId: `${name}-page`, pageNumber: 1,
      workspace: { publicId: workspaceId, rootType: "standalone_client", rootPublicId: rootId,
        displayName: `Organization ${name}`, sourceVersion: "root-v1", active: true },
      entities: [{ type: "standalone_client", publicId: rootId, parentPublicId: null, displayName: `Organization ${name}`,
        sourceVersion: "root-v1", active: true, primaryContact: false }], principals, entitlements };
    const pageResponse = await deliver(page);
    if (options.duplicateEmail) {
      // The production staging uniqueness constraint rejects ambiguity before
      // activation, rather than allowing a duplicate-email workspace to exist.
      expect(pageResponse.status).toBe(409);
      expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspaces WHERE id=?")
        .bind(workspaceId).first("n")).toBe(0);
      return { workspaceId, rootId, actor, principalId, common, page };
    }
    expect(await pageResponse.json()).not.toHaveProperty("error");
    expect(pageResponse.status).toBe(200);
    const activation = await deliver({ ...common, kind: "snapshot.activate", deliveryId: `${name}-activate` });
    expect(await activation.json()).not.toHaveProperty("error");
    expect(activation.status).toBe(200);
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_workspaces WHERE id=?").bind(workspaceId)
      .first("legacy_account_id")).toBeNull();
    return { workspaceId, rootId, actor, principalId, common, page };
  }

  function router(actor: VerifiedClientPrincipal) {
    return createClientPortalRouter({ resolvePrincipal: async () => actor, repository: d1ClientPortalRepository });
  }
  async function request(actor: VerifiedClientPrincipal, path: string, environment = env) {
    return router(actor).request(`${origin}${path}`, {}, environment);
  }
  async function assertNoBinding(workspaceId: string) {
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(0);
  }
  async function assertNoLegacyOrMail() {
    for (const table of ["client_accounts", "client_identity_links", "client_account_members",
      "portal_v2_legacy_member_bridges", "portal_v2_identity_eligibility_legacy_bridges", "client_account_invitations",
      "portal_v2_invitations", "portal_v2_invitation_email_outbox", "client_portal_notification_outbox"])
      expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n"), table).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  }

  async function own(name:string){
    const f=await project(name);
    const bootstrapEnv:Env={...env,SHARED_PROFILE_PORTAL:{transitionAuthority:async()=>({ok:true}),bindProfileIdentity:async()=>({ok:true,bound:0}),readProfile:async()=>({ok:false,code:'unavailable'}),updateProfile:async()=>({ok:false,code:'unavailable'})}};
    expect((await request(f.actor,'/session',bootstrapEnv)).status).toBe(200);
    expect((await request(f.actor,'/v2/workspaces',bootstrapEnv)).status).toBe(200);
    const exact=(p:SharedProfilePortalProof)=>p.workspaceId===f.workspaceId&&p.sourceId==='project-alpha:primary'&&p.issuer===f.actor.issuer&&p.subject===f.actor.subject&&p.targets.some(t=>t.scopeType==='client'&&t.principalPublicId===f.principalId&&t.publicId===f.rootId);
    let granted=true;
    const result=(p:SharedProfilePortalProof)=>({ok:true as const,profiles:granted&&exact(p)?[{grantId:'11111111-1111-4111-8111-111111111111',kind:'client' as const,version:1,profile:{phone:''},editable:true}]:[]});
    const read=vi.fn(async(p:SharedProfilePortalProof)=>result(p));
    const update=vi.fn(async(p:SharedProfilePortalProof)=>granted&&exact(p)?result(p):({ok:false as const,code:'denied' as const}));
    const binding:SharedProfilePortalBinding={transitionAuthority:async()=>({ok:true}),bindProfileIdentity:async(p)=>({ok:true,bound:granted&&exact(p)?1:0}),readProfile:read,updateProfile:update};
    const environment={...env,SHARED_PROFILE_PORTAL:binding};
    // Middleware must precede routes in Hono, so use an enclosing router.
    const {Hono}=await import('hono');const app=new Hono();app.use('*',async(c,next)=>{c.set('clientPrincipal' as never,f.actor as never);await next();});app.route('/',createBusinessProfileRouter());
    const get=()=>app.request(`${origin}/${f.workspaceId}/business-profile`,{},environment);
    const patch=()=>app.request(`${origin}/${f.workspaceId}/business-profile`,{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({grantId:'11111111-1111-4111-8111-111111111111',expectedVersion:1,mutationId:crypto.randomUUID(),profile:{phone:'920-555-0147'}})},environment);
    return {...f,environment,get,patch,read,update,revokeGrant:()=>{granted=false;}};
  }
  it('reads and edits its exact standalone profile while preserving the Ops client-scope proof',async()=>{
    const f=await own('profile-own');
    const context=await resolveNativePortalWorkspaceReadContext(f.environment,f.actor,f.workspaceId);expect(context).not.toBeNull();
    expect(await authorizeNativePortalReadTarget(f.environment,context!,'directory.read',{scopeType:'client',publicId:f.rootId})).toBe(false);
    expect(await authorizeNativePortalReadTarget(f.environment,context!,'directory.read',{scopeType:'standalone_client',publicId:f.rootId})).toBe(true);
    const view=await(await request(f.actor,`/v2/workspaces/${f.workspaceId}/context`)).json() as {capabilities:{directoryRead:boolean}};expect(view.capabilities.directoryRead).toBe(false);
    const get=await f.get();expect(get.status).toBe(200);expect(await get.json()).toMatchObject({ok:true,profiles:[{editable:true}]});
    const proof=f.read.mock.calls[0]![0];expect(proof.targets).toEqual([{principalPublicId:f.principalId,scopeType:'client',publicId:f.rootId}]);
    expect((await f.patch()).status).toBe(200);expect(f.update).toHaveBeenCalledOnce();
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND capability='directory.read' AND effect='allow'").bind(f.workspaceId).first('n')).toBe(1);
  },60_000);
  it('never infers another client or accepts a foreign source in private queued-write authority',async()=>{
    const f=await own('profile-isolation');await f.get();
    for(const change of [{sourceId:'project-alpha:secondary'},{publicId:'another-client'},{principalPublicId:'another-principal'}]){
      const result=await readSharedProfilePortalAuthority(f.environment,{protocolVersion:1,workspaceId:f.workspaceId,sourceId:'project-alpha:primary',issuer:f.actor.issuer,subject:f.actor.subject,principalPublicId:f.principalId,scopeType:'client',publicId:f.rootId,...change});expect(result.ok).toBe(false);
    }
    const other=await own('profile-other');const wrong=await resolveBusinessProfileProof(f.environment,other.actor,f.workspaceId);expect(wrong).toBeNull();
  },60_000);
  it('keeps explicit directory deny precedence over own workspace eligibility',async()=>{
    const f=await own('profile-denied');
    const id=await db.prepare('SELECT id FROM portal_v2_identities WHERE subject=?').bind(f.actor.subject).first<string>('id');
    await db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status,valid_from) VALUES(?,?,?,'directory.read','deny','client',?,'operations','v1','active','2026-01-01T00:00:00.000Z')").bind(crypto.randomUUID(),f.workspaceId,id,f.rootId).run();
    const response=await f.get();expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,profiles:[]});expect((await f.patch()).status).toBe(403);
  },60_000);
  it('requires the independent Ops profile grant even with eligible own-client workspace access',async()=>{
    const f=await own('profile-no-grant');f.revokeGrant();expect(await(await f.get()).json()).toEqual({ok:true,profiles:[]});expect((await f.patch()).status).toBe(403);
  },60_000);
  it('drops profile authority when the current principal membership is revoked',async()=>{
    const f=await own('profile-revoked');await f.get();f.read.mockClear();
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=?").bind(f.workspaceId).run();
    expect((await f.get()).status).toBe(503);expect(f.read).not.toHaveBeenCalled();
  },60_000);
});
