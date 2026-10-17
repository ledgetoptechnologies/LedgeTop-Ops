import { Hono } from "hono";
import { afterAll,beforeAll,expect,it } from "vitest";
import { initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,createReviewedCorrespondenceGroup,correspondenceFixtureState } from "./helpers/shared-profile-correspondence-fixture";
import { createIndependentPrimaryClientProjection } from "./helpers/central-correspondence-client-projection-fixture";
import { sharedProfilePortalSetup } from "../src/worker/native-directory-shared-profile-routes";
import { manageSharedProfilePortalGrant,authorizedSharedProfilePortalGrants,transitionSharedProfilePortalAuthority,prepareSharedProfilePortalWrite } from "../src/worker/shared-profile-portal-authority";
import { managePortalDirectoryCorrespondence,previewPortalDirectoryCorrespondence } from "../src/worker/portal-directory-correspondence";
import { createClientPortalRouter } from "../../client/src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../../client/src/worker/client-portal/repository";
import type { Env,StaffPrincipal } from "../src/worker/types";
import type { SharedProfilePortalProof } from "../../../packages/shared/src/shared-business-profile";
import { resolveClientHubWorkspaces } from "../src/worker/client-hub-workspace";

beforeAll(initializeCorrespondenceComposerFixture,300_000);
afterAll(disposeCorrespondenceComposerFixture);

it("issues an exact logical-source grant only for the genuine complete physical primary workspace, then suspends and explicitly revokes it",async()=>{
 const f=await createReviewedCorrespondenceGroup(),{db,correspondence,httpMocks}=correspondenceFixtureState();
 const logical="project-alpha:staging",primary="project-alpha:primary";
 const selected=f.records.find(r=>r.input.destinations[0]!.sourceId===logical)!;
 const rootPublicId=f.publicIds.get(selected.input.recordId)!;
 const physical=await createIndependentPrimaryClientProjection(correspondence.client,rootPublicId);
 const wrongRoot=await createIndependentPrimaryClientProjection(correspondence.client,crypto.randomUUID().replaceAll("-",""));
 const pending=await createIndependentPrimaryClientProjection(correspondence.client,rootPublicId,{activate:false});
 const bridge=await correspondence.approve();
 const actor:StaffPrincipal={id:f.actor.staffId,email:f.actor.loginEmail,displayName:"Native Owner",accessSubject:f.actor.accessSubject,projectAlphaUserId:null};
 await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)").bind(crypto.randomUUID(),actor.id,actor.id).run();
 httpMocks.authenticate.mockResolvedValue({identity:{kind:"native",staffId:actor.id,email:actor.email,displayName:actor.displayName,verifiedAccessSubject:actor.accessSubject,profileVersion:f.actor.profileVersion},admissionVersion:f.actor.admissionVersion});
 const members=f.records.map(r=>({recordId:r.input.recordId,kind:"client" as const,version:1,profile:f.profile,sourceIds:r.input.destinations.map(d=>d.sourceId),parentRecordId:null,relationshipVersion:1,parentVersion:null}));
 const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
 app.use("*",async(c,next)=>{c.set("principal",actor);c.set("administrator",true);await next();});
 app.get("/setup",async c=>c.json(await sharedProfilePortalSetup(c,f.groupId,members,true)));
 const setup=async()=>await(await app.fetch(new Request("https://ops.example.test/setup"),f.env)).json() as {available:boolean;candidates:Array<{workspaceId:string;sourceId:string;portalSourceId?:string;correspondenceRevisionId?:string;state:string;currentGrantId?:string}>};
 const initial=await setup();expect(initial.available).toBe(true);expect(initial.candidates).toHaveLength(1);
 expect(initial.candidates[0]).toMatchObject({workspaceId:physical.workspaceId,sourceId:logical,portalSourceId:primary,correspondenceRevisionId:bridge.result.revisionId,state:"available"});
 const lookup={key:"alias",source_id:logical,kind:"standalone_client" as const,business_id:selected.input.recordId,pa_public_id:rootPublicId,workspace_id:null};
 const hub=await resolveClientHubWorkspaces(f.env,[lookup,{...lookup,key:"physical",source_id:primary},{...lookup,key:"foreign-collision",source_id:"project-alpha:secondary"}]);
 expect(hub.get("alias")).toMatchObject({status:"mapped",workspace:{id:physical.workspaceId,project_alpha_source_id:primary}});
 expect(hub.get("physical")).toMatchObject({status:"mapped",workspace:{id:physical.workspaceId,project_alpha_source_id:primary}});
 expect(hub.get("foreign-collision")).toMatchObject({status:"missing",workspace:null});
 const create={operationId:crypto.randomUUID(),id:crypto.randomUUID(),workspaceId:physical.workspaceId,sourceId:logical,portalSourceId:primary,correspondenceRevisionId:bridge.result.revisionId,
  recipientMode:"first_verified_identity",issuer:null,subject:null,principalPublicId:physical.principalPublicId,targetType:"client",targetPublicId:rootPublicId,
  recordId:selected.input.recordId,groupId:f.groupId,expectedRevision:0,state:"active"};
 for(const changed of [{workspaceId:wrongRoot.workspaceId,principalPublicId:wrongRoot.principalPublicId},
  {workspaceId:pending.workspaceId,principalPublicId:pending.principalPublicId},
  {principalPublicId:crypto.randomUUID().replaceAll("-","")},{sourceId:"project-alpha:secondary"},
  {correspondenceRevisionId:crypto.randomUUID()}]){
  expect(await manageSharedProfilePortalGrant(f.env,actor,{...create,...changed,operationId:crypto.randomUUID(),id:crypto.randomUUID()})).toEqual({ok:false});
 }
 expect(await db.prepare("SELECT count(*) n FROM shared_profile_portal_grants WHERE group_id=?").bind(f.groupId).first("n")).toBe(0);
 const contentBefore=await correspondence.client.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first("n");
 const membersBefore=await correspondence.client.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n");
 expect(await manageSharedProfilePortalGrant(f.env,actor,create)).toEqual({ok:true,revision:1});
 expect(await correspondence.client.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(membersBefore);
 expect(await correspondence.client.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first("n")).toBe(contentBefore);
 expect(await db.prepare("SELECT source_id,directory_source_id,correspondence_revision_id FROM shared_profile_portal_grants WHERE id=?").bind(create.id).first())
  .toEqual({source_id:primary,directory_source_id:logical,correspondence_revision_id:bridge.result.revisionId});
 expect((await setup()).candidates).toEqual([expect.objectContaining({currentGrantId:create.id,state:"enabled"})]);
 expect(await transitionSharedProfilePortalAuthority(f.env,{protocolVersion:1,operationId:crypto.randomUUID(),workspaceId:physical.workspaceId,sourceId:primary,expectedRevision:1,revision:1,state:"active"})).toEqual({ok:true,revision:1});
 // Real Client sign-in binds only the existing producer's identity eligibility.
 const clientActor={issuer:"https://access.example.test",subject:"independent-client",email:"independent-client@example.test"};
 const router=createClientPortalRouter({resolvePrincipal:async()=>clientActor,repository:d1ClientPortalRepository});
 const clientEnv={...physical.env,CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true"};
 const session=await router.request("https://client.example.test/session",{},clientEnv);
 expect(session.status,await session.text()).toBe(200);
 const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId:physical.workspaceId,sourceId:primary,issuer:clientActor.issuer,subject:clientActor.subject,authorityRevision:1,contextVersion:"a".repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString(),targets:[{principalPublicId:physical.principalPublicId,scopeType:"client",publicId:rootPublicId}]};
 // First-login binding is explicit to the selected principal/client, never an email lookup in Ops.
 const {bindSharedProfilePortalIdentity}=await import("../src/worker/shared-profile-portal-authority");
 expect(await bindSharedProfilePortalIdentity(f.env,proof)).toMatchObject({ok:true,bound:1});
 expect(await authorizedSharedProfilePortalGrants(f.env,proof)).toHaveLength(1);
 expect(await authorizedSharedProfilePortalGrants(f.env,{...proof,sourceId:logical})).toEqual([]);
 const prepared=await prepareSharedProfilePortalWrite(f.env,{...proof,grantId:create.id,expectedVersion:1,mutationId:crypto.randomUUID(),profile:{...f.profile,name:"Independent update"}});
 expect(prepared).not.toBeNull();
 const status=await previewPortalDirectoryCorrespondence(f.env,logical);
 expect(await managePortalDirectoryCorrespondence(f.env,correspondence.actor,logical,{operationId:crypto.randomUUID(),action:"revoke",expectedVersion:status.current!.version,expectedProofSha256:status.current!.revocationProofSha256},correspondence.send)).toMatchObject({ok:true});
 expect(await authorizedSharedProfilePortalGrants(f.env,proof)).toEqual([]);
 expect((await resolveClientHubWorkspaces(f.env,[lookup])).get("alias")).toMatchObject({status:"missing",workspace:null});
 expect(await prepareSharedProfilePortalWrite(f.env,{...proof,grantId:create.id,expectedVersion:1,mutationId:crypto.randomUUID(),profile:f.profile})).toBeNull();
 expect((await setup()).candidates).toEqual([expect.objectContaining({currentGrantId:create.id,state:"suspended"})]);
 expect(await manageSharedProfilePortalGrant(f.env,actor,{...create,operationId:crypto.randomUUID(),expectedRevision:2,state:"revoked"})).toEqual({ok:true,revision:3});
 expect((await setup()).candidates).toEqual([expect.objectContaining({currentGrantId:create.id,state:"revoked"})]);
 expect(await correspondence.client.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first("n")).toBe(contentBefore);
 expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
 expect((await correspondence.client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
},120_000);
