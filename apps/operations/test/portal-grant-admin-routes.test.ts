import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(), authorizeItem: vi.fn(), listGrants: vi.fn(), searchAudiences: vi.fn(),
  listDenials: vi.fn(), searchIdentities: vi.fn(), searchScopes: vi.fn(), isAdministrator: vi.fn(),
  previewGrant:vi.fn(),createGrant:vi.fn(),restoreGrant:vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(), isAdministrator: mocks.isAdministrator,
}));
vi.mock("../src/worker/delivery", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/delivery")>(), authorizeItem: mocks.authorizeItem,
}));
vi.mock("../src/worker/authenticated-delivery-grants", () => ({
  authenticatedDeliveryGrantsEnabled: () => true,
  createAuthenticatedDeliveryGrant: mocks.createGrant, restoreAuthenticatedDeliveryGrant: mocks.restoreGrant,
  previewAuthenticatedDeliveryGrant: mocks.previewGrant,
  revokeAuthenticatedDeliveryGrant: vi.fn(), listAuthenticatedDeliveryGrants: mocks.listGrants,
  searchAuthenticatedDeliveryGrantAudiences: mocks.searchAudiences,
}));
vi.mock("../src/worker/client-portal-deny-policies", () => ({
  portalDenyPolicyManagementEnabled: () => true,
  createPortalIdentityDenial: vi.fn(), revokePortalIdentityDenial: vi.fn(),
  listPortalIdentityDenials: mocks.listDenials, searchPortalDenyIdentities: mocks.searchIdentities,
  searchPortalDenyScopes: mocks.searchScopes,
}));

import worker from "../src/worker/index";
import type { Env as OperationsEnv } from "../src/worker/types";
import {csrfToken} from '../src/worker/request-security';

const principal = { id: "staff-admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "access-admin", projectAlphaUserId: "pa-admin" };
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example",
  INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_BASE_URL: "https://incoming.example",PUBLIC_BASE_URL:'https://ops.example',
  OPERATIONS_SESSION_SECRET:'primary-route-test-secret-at-least-32-bytes' } as unknown as OperationsEnv;
async function post(path:string,value:unknown,secure=true){return worker.fetch(new Request(`https://ops.example${path}`,{method:'POST',headers:{
  'Content-Type':'application/json','Idempotency-Key':'primary-route-mutation-key',...(secure?{Origin:'https://ops.example','X-CSRF-Token':await csrfToken(env,principal)}:{})},body:JSON.stringify(value)}),env,context);}

describe("portal grant and deny management read routes", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.authenticateStaff.mockResolvedValue(principal);
    mocks.isAdministrator.mockResolvedValue(true);
    mocks.authorizeItem.mockResolvedValue("Jobs/Clients/Acme/");
    mocks.listGrants.mockResolvedValue({ folderBindingId: "binding-a", grants: [] });
    mocks.searchAudiences.mockResolvedValue({ audiences: [] });
    mocks.listDenials.mockResolvedValue({ denials: [] });
    mocks.searchIdentities.mockResolvedValue({ identities: [] });
    mocks.searchScopes.mockResolvedValue({ scopes: [] });
  });

  it("authorizes the opaque folder reference before listing scoped grants", async () => {
    const response = await worker.fetch(new Request("https://ops.example/api/delivery/authenticated-grants?folderRef=folder-acme"), env, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folderBindingId: "binding-a", grants: [] });
    expect(mocks.authorizeItem).toHaveBeenCalledWith(env, principal, "folder-acme");
    expect(mocks.listGrants).toHaveBeenCalledWith(env, principal, "Jobs/Clients/Acme/");
  });

  it("validates and forwards bounded audience and denial scope searches", async () => {
    const audience = await worker.fetch(new Request("https://ops.example/api/delivery/authenticated-grants/audiences?folderBindingId=binding-a&q=Acme&audienceType=organization"), env, context);
    expect(audience.status).toBe(200);
    expect(mocks.searchAudiences).toHaveBeenCalledWith(env, principal, "binding-a", "Acme", "organization");

    const scope = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials/scopes?scopeType=project&q=Hilly"), env, context);
    expect(scope.status).toBe(200);
    expect(mocks.searchScopes).toHaveBeenCalledWith(env, principal, "project", "Hilly");

    const invalid = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials/scopes?scopeType=folder&q=secret"), env, context);
    expect(invalid.status).toBe(400);
    expect(mocks.searchScopes).toHaveBeenCalledTimes(1);
  });

  it("hydrates denial management through the gated list function", async () => {
    const response = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials"), env, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ denials: [] });
    expect(mocks.listDenials).toHaveBeenCalledWith(env, principal);
  });
  it('mounts a flat secured preview and forwards exact project terms',async()=>{
    const input={folderBindingId:'binding-a',audienceType:'principal',audiencePublicId:'person-a',reasonCode:'reviewed',expiresAt:null,
      accessTerms:{kind:'customer',mode:'until_revoked',expiresAt:null}};
    mocks.previewGrant.mockResolvedValue({operation:input,contextVersion:'a'.repeat(64),accessTerms:input.accessTerms});
    const response=await post('/api/delivery/authenticated-grants/preview',input);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({operation:input,contextVersion:'a'.repeat(64)});
    expect(mocks.previewGrant).toHaveBeenCalledWith(env,principal,input);
    const denied=await post('/api/delivery/authenticated-grants/preview',input,false);expect(denied.status).toBe(403);
    const spoofed=await post('/api/delivery/authenticated-grants/preview',{...input,actorId:'other'});expect(spoofed.status).toBe(400);
    expect(mocks.previewGrant).toHaveBeenCalledTimes(1);
  });
  it('forwards reviewed create and restore context without allowing actor or term coercion',async()=>{
    const terms={kind:'collaborator',mode:'until_revoked',expiresAt:null},version='b'.repeat(64);
    const input={folderBindingId:'binding-a',audienceType:'principal',audiencePublicId:'person-a',reasonCode:'reviewed',expiresAt:null,accessTerms:terms,expectedContextVersion:version};
    mocks.createGrant.mockResolvedValue({grant:{id:'grant-a'},replayed:false});mocks.restoreGrant.mockResolvedValue({grant:{id:'grant-b'},replayed:false});
    expect((await post('/api/delivery/authenticated-grants',input)).status).toBe(201);
    expect(mocks.createGrant).toHaveBeenCalledWith(env,principal,input,'primary-route-mutation-key');
    expect((await post('/api/delivery/authenticated-grants/grant-a/restore',{expectedVersion:1,reasonCode:'restore',expiresAt:null,accessTerms:terms,expectedContextVersion:version})).status).toBe(201);
    expect(mocks.restoreGrant).toHaveBeenCalledWith(env,principal,'grant-a',1,'restore',null,'primary-route-mutation-key',{accessTerms:terms,expectedContextVersion:version});
    expect((await post('/api/delivery/authenticated-grants',{...input,accessTerms:{kind:'customer',mode:'specific_date',expiresAt:'2030-01-01T00:00:00Z'}})).status).toBe(400);
  });
});
