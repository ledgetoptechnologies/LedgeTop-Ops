import {Miniflare} from "miniflare";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {applyCanonicalChain,authorizeCanonicalUuidAcquisition,canonicalUuidOrganization,createAcquisitionPrerequisite,
  establishGovernedEmptyEnrollmentFixture,
  establishCleanV3Authority,establishHistoricalPreservedOnboardingLineage,transitionCleanV3ToV4Acquisition,
  transitionCleanV4ToV6PortalAuthority,transitionHistoricalOnboardingToV7Acquisition,transitionHistoricalV7ToV8PortalAuthority,
  revokeCleanV6PortalAuthority,revokeHistoricalV8PortalAuthority,
  writeGovernedCanonicalUuidOrganization} from "./helpers/verified-recipient-canonical-lineage";
import {selectPortalWorkspaceBinding} from "../src/worker/client-portal-workspace-binding-selection";
import {canonicalOwner} from "./helpers/verified-recipient-canonical-lineage";
import {acquireProjectAlphaExistingDirectoryBinding} from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import {activateProjectAlphaExistingDirectoryBinding} from "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";

const acquiredSource=Object.freeze({sourceId:"project-alpha:secondary",sourceInstanceId:"50000000-0000-4000-8000-000000000001",
  applicationId:"50000000-0000-4000-8000-000000000002",historyEpochId:"50000000-0000-4000-8000-000000000003",origin:"https://pa-secondary.example.test"});
const connections=JSON.stringify({version:1,instances:{[canonicalUuidOrganization.sourceId]:{sourceId:canonicalUuidOrganization.sourceId,
  enabled:true,baseUrl:canonicalUuidOrganization.origin,apiKey:"test-secret",sourceInstanceId:canonicalUuidOrganization.sourceInstanceId,
  applicationId:canonicalUuidOrganization.applicationId,historyEpoch:canonicalUuidOrganization.historyEpochId},[acquiredSource.sourceId]:{
  sourceId:acquiredSource.sourceId,enabled:true,baseUrl:acquiredSource.origin,apiKey:"test-secret",sourceInstanceId:acquiredSource.sourceInstanceId,
  applicationId:acquiredSource.applicationId,historyEpoch:acquiredSource.historyEpochId}}});
function createRemote():typeof fetch{return vi.fn<typeof fetch>(async(input,init)=>{
  const path=new URL(String(input)).pathname,requestId=crypto.randomUUID(),reply=(value:Record<string,unknown>,status=200)=>new Response(JSON.stringify({...value,requestId}),
    {status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Request-ID":requestId}});
  if(path.endsWith("/capabilities"))return reply({apiVersion:"2",sourceInstanceId:canonicalUuidOrganization.sourceInstanceId,
    applicationId:canonicalUuidOrganization.applicationId,historyEpoch:canonicalUuidOrganization.historyEpochId,
    grantedCapabilities:["api.capabilities.read","directory.organizations.create"].map(name=>({name})),implementedEndpoints:[
      {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
      {method:"POST",path:"/api/v2/directory/organizations/commands",requiredCapability:"directory.organizations.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]});
  const body=JSON.parse(String(init?.body));return reply({sourceInstanceId:canonicalUuidOrganization.sourceInstanceId,
    applicationId:canonicalUuidOrganization.applicationId,historyEpoch:canonicalUuidOrganization.historyEpochId,replayed:false,
    result:{resource:{type:"organization",id:body.externalId,publicId:"b".repeat(32),revision:"1"},authorizationGeneration:"1"}},201);
});}
function projectAlphaRemote():typeof fetch{
  const bindingPath=`/api/v2/bindings/organization/status/${Buffer.from(canonicalUuidOrganization.recordId).toString("base64url")}`;
  return vi.fn<typeof fetch>(async(input,init)=>{
    const path=new URL(String(input)).pathname,headers=new Headers(init?.headers),requestId=crypto.randomUUID();
    const reply=(value:Record<string,unknown>)=>new Response(JSON.stringify({...value,requestId}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId}});
    if(path==="/api/v2/capabilities")return reply({apiVersion:"2",sourceInstanceId:acquiredSource.sourceInstanceId,
      applicationId:acquiredSource.applicationId,historyEpoch:acquiredSource.historyEpochId,
      grantedCapabilities:["api.capabilities.read","directory.organizations.read","directory.organizations.binding_status.read","directory.organizations.bind"].map(name=>({name})),
      implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
        {method:"GET",path:"/api/v2/directory/organizations/{publicId}",requiredCapability:"directory.organizations.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
        {method:"GET",path:"/api/v2/bindings/organization/status/{base64urlExternalId}",requiredCapability:"directory.organizations.binding_status.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
        {method:"POST",path:"/api/v2/directory/organizations/bindings/commands",requiredCapability:"directory.organizations.bind",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true,requiresExpectedPublicId:true,requiresExpectedRevision:true}]});
    if(headers.get("Authorization")!=="Bearer test-secret")throw Error("unexpected PA authority");
    if(path===`/api/v2/directory/organizations/${canonicalUuidOrganization.publicId}`)return reply({apiVersion:"2",
      sourceInstanceId:acquiredSource.sourceInstanceId,applicationId:acquiredSource.applicationId,
      historyEpoch:acquiredSource.historyEpochId,authorizationGeneration:"8",resource:{type:"organization",id:canonicalUuidOrganization.publicId,revision:"7"},
      data:{publicId:canonicalUuidOrganization.publicId,name:"Canonical joined UUID organization",email:"canonical@example.test",phone:null,
        address:{line1:"1 Canonical Way",line2:null,city:"Austin",state:"TX",postalCode:"78701",country:"US"}}});
    if(path===bindingPath)return reply({apiVersion:"2",sourceInstanceId:acquiredSource.sourceInstanceId,
      applicationId:acquiredSource.applicationId,historyEpoch:acquiredSource.historyEpochId,authorizationGeneration:"8",
      binding:{type:"organization",externalId:canonicalUuidOrganization.recordId,publicId:canonicalUuidOrganization.publicId,createdAt:new Date().toISOString()},resource:{revision:"7",present:true}});
    if(path==="/api/v2/directory/organizations/bindings/commands")return reply({replayed:false,sourceInstanceId:acquiredSource.sourceInstanceId,
      applicationId:acquiredSource.applicationId,historyEpoch:acquiredSource.historyEpochId,
      result:{binding:{publicId:canonicalUuidOrganization.publicId},resource:{type:"organization",id:canonicalUuidOrganization.recordId,revision:"7"}}});
    throw Error(`unexpected PA request ${path}`);
  });
}

describe("verified recipient authority canonical joined prerequisite",()=>{
  let runtime:Miniflare,ops:D1Database,client:D1Database;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",
      d1Databases:{OPS_DB:crypto.randomUUID(),DELIVERY_DB:crypto.randomUUID()}});
    ops=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    client=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
  });
  afterAll(async()=>runtime.dispose());

  it("creates the governed canonical fixture and rejects its non-UUID record as ineligible for workspace selection",async()=>{
    const operations=await applyCanonicalChain(ops,"operations","0165_project_alpha_inventory_generation_surface_scope.sql",true);
    const delivery=await applyCanonicalChain(client,"client","0221_verified_recipient_delivery_authority.sql");
    expect(operations).toHaveLength(165);expect(delivery).toHaveLength(140);
    expect(await ops.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(165);
    expect(await client.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(140);
    await expect(createAcquisitionPrerequisite(ops)).rejects.toThrow(/directory|authority|admission|denied|guard/i);
    expect(await ops.prepare("SELECT count(*) count FROM operations_directory_records WHERE record_id='60000000-0000-4000-8000-000000000001'").first("count")).toBe(0);
    expect(await ops.prepare("SELECT count(*) count FROM verified_recipient_delivery_authority_commands").first("count")).toBe(0);
    expect(await client.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_heads").first("count")).toBe(0);
    const fixture=await establishGovernedEmptyEnrollmentFixture(ops);
    expect(fixture).toMatchObject({status:"written",replayed:false,recordId:"staging-native-empty-enrollment-organization-v1",version:1});
    expect(await ops.prepare("SELECT count(*) count FROM staging_native_authority_migrations").first("count")).toBe(3);
    expect(await ops.prepare("SELECT count(*) count FROM operations_directory_records WHERE record_id='staging-native-empty-enrollment-organization-v1'").first("count")).toBe(1);
    const actor={identity:{kind:"native" as const,staffId:canonicalOwner.operationsStaffId,
      verifiedAccessSubject:canonicalOwner.accessSubject,email:canonicalOwner.email,displayName:canonicalOwner.displayName,profileVersion:1},
      admissionVersion:3,verifiedUntil:new Date(Date.now()+30*60_000).toISOString()};
    await expect(selectPortalWorkspaceBinding(ops,actor,{selectionId:"11111111-1111-4111-8111-111111111111",
      recordId:"staging-native-empty-enrollment-organization-v1",activationId:"22222222-2222-4222-8222-222222222222",
      workspaceId:"canonical-workspace",sourceWorkspaceId:"canonical-source-workspace",
      checkpoint:{sourceGeneration:"generation-1",sourceSequence:1,snapshotGenerationId:"snapshot-1"}}))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
    expect(await ops.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections").first("count")).toBe(0);
  },240_000);

  it("writes, dispatches, acquires, and activates a normal UUID organization, but does not infer portal authority",async()=>{
    const written=await writeGovernedCanonicalUuidOrganization(ops);
    expect(written.outcome).toMatchObject({status:"written",replayed:false,recordId:canonicalUuidOrganization.recordId,version:1});
    expect(await ops.prepare("SELECT state FROM project_alpha_directory_outbox WHERE external_id=?")
      .bind(canonicalUuidOrganization.recordId).first("state")).toBe("pending");
    if(written.outcome.status!=="written")throw Error("canonical writer failed");
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand({OPS_DB:ops,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
      canonicalUuidOrganization.sourceId,written.outcome.commandIds[0]!,createRemote())).resolves.toMatchObject({status:"acknowledged",replayed:false});
    expect(await ops.prepare(`SELECT count(*) count FROM project_alpha_directory_outbox outbox
      JOIN operations_directory_materializations materialization ON materialization.command_id=outbox.command_id
      JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
      JOIN project_alpha_directory_mappings mapping ON mapping.command_id=outbox.command_id
      WHERE outbox.command_id=? AND outbox.state='acknowledged' AND outbox.outcome_json IS NOT NULL
        AND intent.state='acknowledged' AND intent.record_id=? AND mapping.external_id=intent.external_canonical_id`)
      .bind(written.outcome.commandIds[0],canonicalUuidOrganization.recordId).first("count")).toBe(1);
    const authority=await authorizeCanonicalUuidAcquisition(ops);
    const fetcher=projectAlphaRemote(),reviewId="40000000-0000-4000-8000-000000000001",commandId="40000000-0000-4000-8000-000000000002";
    const acquired=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:ops,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},{reviewId,commandId,
      sourceId:acquiredSource.sourceId,recordId:canonicalUuidOrganization.recordId,resourceType:"organization",
      projectAlphaPublicId:canonicalUuidOrganization.publicId,localRecordVersion:1,reviewer:authority.reviewer},fetcher);
    expect(acquired).toMatchObject({status:"acquired",replayed:false});
    if(acquired.status!=="acquired")throw Error(`canonical acquisition failed: ${JSON.stringify(acquired)}`);
    expect(await ops.prepare(`SELECT count(*) count FROM project_alpha_existing_directory_binding_review_evidence review
      JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.review_receipt_id=review.receipt_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=command.command_id
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.command_id=command.command_id
      JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
      JOIN project_alpha_acquired_mapping_activation inactive ON inactive.receipt_id=mapping.receipt_id
      WHERE review.receipt_id=? AND review.review_id=? AND command.command_id=? AND acquired.receipt_id=?
        AND review.record_id=? AND response.project_alpha_public_id=? AND mapping.activation_state='inactive'
        AND inactive.state='inactive' AND claim.record_id=review.record_id`)
      .bind(acquired.reviewReceiptId,reviewId,commandId,acquired.acquiredReceiptId,canonicalUuidOrganization.recordId,
        canonicalUuidOrganization.publicId).first("count")).toBe(1);
    const activated=await activateProjectAlphaExistingDirectoryBinding({OPS_DB:ops,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
      {reviewItemId:acquired.reviewReceiptId,idempotencyKey:"40000000-0000-4000-8000-000000000003"},
      {staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher);
    expect(activated).toMatchObject({status:"activated",replayed:false,recordId:canonicalUuidOrganization.recordId});
    if(activated.status!=="activated")throw Error(`canonical activation failed: ${JSON.stringify(activated)}`);
    expect(await ops.prepare(`SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts activation
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
        ON acquired.receipt_id=activation.acquired_receipt_id
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=activation.native_owner_claim_id
        AND claim.receipt_id=acquired.receipt_id
      JOIN project_alpha_active_directory_mappings active ON active.provenance_id=activation.activation_id
        AND active.mapping_kind='acquired'
      WHERE activation.activation_id=? AND activation.review_receipt_id=? AND activation.acquired_receipt_id=?
        AND activation.record_id=? AND active.external_id=activation.external_id
        AND active.project_alpha_public_id=activation.project_alpha_public_id`)
      .bind(activated.activationId,acquired.reviewReceiptId,acquired.acquiredReceiptId,
        canonicalUuidOrganization.recordId).first("count")).toBe(1);
    expect(await ops.prepare(`SELECT count(*) count FROM native_directory_grants WHERE staff_id=?
      AND permission='directory.portal_access.manage' AND effect='allow' AND active=1`)
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(0);
    await expect(selectPortalWorkspaceBinding(ops,{identity:{kind:"native",staffId:canonicalOwner.operationsStaffId,
      verifiedAccessSubject:canonicalOwner.accessSubject,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
      profileVersion:authority.reviewer.profileVersion},admissionVersion:authority.reviewer.admissionVersion,
      verifiedUntil:new Date(Date.now()+30*60_000).toISOString()},{selectionId:"40000000-0000-4000-8000-000000000004",
      recordId:canonicalUuidOrganization.recordId,activationId:activated.activationId,workspaceId:"canonical-workspace",
      sourceWorkspaceId:"canonical-source-workspace",checkpoint:{sourceGeneration:"generation-1",sourceSequence:1,snapshotGenerationId:"snapshot-1"}}))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
    expect(await ops.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections WHERE record_id=?")
      .bind(canonicalUuidOrganization.recordId).first("count")).toBe(0);
  },240_000);

  it("uses the clean reviewed v3 to v4 to v6 lineage to authorize an inactive workspace selection",async()=>{
    const isolated=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    try{
      const database=await isolated.getD1Database("OPS_DB") as unknown as D1Database;
      await applyCanonicalChain(database,"operations","0165_project_alpha_inventory_generation_surface_scope.sql",true);
      await establishCleanV3Authority(database);
      const written=await writeGovernedCanonicalUuidOrganization(database);
      expect(written.outcome).toMatchObject({status:"written",recordId:canonicalUuidOrganization.recordId,version:1});
      if(written.outcome.status!=="written")throw Error("clean canonical writer failed");
      await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        canonicalUuidOrganization.sourceId,written.outcome.commandIds[0]!,createRemote())).resolves.toMatchObject({status:"acknowledged"});
      const reviewer=await transitionCleanV3ToV4Acquisition(database),fetcher=projectAlphaRemote();
      const acquired=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},{
        reviewId:"70000000-0000-4000-8000-000000000001",commandId:"70000000-0000-4000-8000-000000000002",
        sourceId:acquiredSource.sourceId,recordId:canonicalUuidOrganization.recordId,resourceType:"organization",
        projectAlphaPublicId:canonicalUuidOrganization.publicId,localRecordVersion:1,reviewer},fetcher);
      expect(acquired).toMatchObject({status:"acquired",replayed:false});if(acquired.status!=="acquired")throw Error(JSON.stringify(acquired));
      const activated=await activateProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        {reviewItemId:acquired.reviewReceiptId,idempotencyKey:"70000000-0000-4000-8000-000000000003"},
        {staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher);
      expect(activated).toMatchObject({status:"activated",replayed:false});if(activated.status!=="activated")throw Error(JSON.stringify(activated));
      const portal=await transitionCleanV4ToV6PortalAuthority(database,activated.activationId);
      const actor={identity:{kind:"native" as const,staffId:canonicalOwner.operationsStaffId,
        verifiedAccessSubject:canonicalOwner.accessSubject,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
        profileVersion:portal.profileVersion},admissionVersion:portal.admissionVersion,verifiedUntil:new Date(Date.now()+30*60_000).toISOString()};
      const command={selectionId:"70000000-0000-4000-8000-000000000004",recordId:canonicalUuidOrganization.recordId,
          activationId:activated.activationId,workspaceId:"canonical-clean-workspace",sourceWorkspaceId:"canonical-clean-source",
          checkpoint:{sourceGeneration:"generation-1",sourceSequence:1,snapshotGenerationId:"snapshot-1"}};
      const selection=await selectPortalWorkspaceBinding(database,actor,command);
      expect(selection).toMatchObject({recordId:canonicalUuidOrganization.recordId,activationId:activated.activationId,
        rootType:"organization",rootPublicId:canonicalUuidOrganization.publicId,state:"inactive",replayed:false});
      await expect(selectPortalWorkspaceBinding(database,actor,command)).resolves.toEqual({...selection,replayed:true});
      for(const altered of [{...command,workspaceId:"other-workspace"},
        {...command,checkpoint:{...command.checkpoint,sourceSequence:2}},
        {...command,activationId:"70000000-0000-4000-8000-000000000099"}]){
        await expect(selectPortalWorkspaceBinding(database,actor,altered)).rejects.toThrow("portal_workspace_binding_selection_denied");
      }
      await expect(selectPortalWorkspaceBinding(database,{...actor,identity:{...actor.identity,
        verifiedAccessSubject:"forged-staging-subject"}},command)).rejects.toThrow("portal_workspace_binding_selection_denied");
      await revokeCleanV6PortalAuthority(database);
      await expect(selectPortalWorkspaceBinding(database,actor,command)).rejects.toThrow("portal_workspace_binding_selection_denied");
      expect(await database.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections")
        .first("count")).toBe(1);
      expect(await database.prepare("SELECT count(*) count FROM verified_recipient_delivery_authority_commands")
        .first("count")).toBe(0);
    }finally{await isolated.dispose();}
  },240_000);

  it("rehearses immutable historical v2 through real onboarding, v7 acquisition, activation, and v8 selection",async()=>{
    const isolated=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    try{
      const database=await isolated.getD1Database("OPS_DB") as unknown as D1Database;
      const historical=await establishHistoricalPreservedOnboardingLineage(database);
      expect(historical).toMatchObject({
        sourceCommit:"332ffbb947c3dc50a96f7b0fc5e2a976f693bdbc",
        sourceTree:"c07acd54f7c0e747b66e97ea7d9656210b7d7007",
        historicalManifest:{schemaVersion:2,canonicalOperationsLedger:{count:122,
          finalMigration:"0122_project_alpha_project_v2_canonical_activation.sql",
          chainSha256:"20f127ae3193884494a021ac2f1851f6c2db06834d6f94498850d315e02df5d7"}},
      });
      expect(await database.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(165);
      expect((await database.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE staff_id=? AND permission='directory.profile.edit' AND scope_kind='global' ORDER BY grant_version`)
        .bind(canonicalOwner.operationsStaffId).all()).results).toEqual([{grant_version:1,active:0,grant_generation:1}]);
      expect((await database.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE grant_id=? ORDER BY grant_version`).bind(historical.onboardingGrantId).all()).results).toEqual([
        {grant_version:1,active:0,grant_generation:2},{grant_version:2,active:1,grant_generation:3},
      ]);

      const written=await writeGovernedCanonicalUuidOrganization(database);
      expect(written.outcome).toMatchObject({status:"written",replayed:false,recordId:canonicalUuidOrganization.recordId,version:1});
      if(written.outcome.status!=="written")throw Error("historical canonical writer failed");
      await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        canonicalUuidOrganization.sourceId,written.outcome.commandIds[0]!,createRemote())).resolves.toMatchObject({status:"acknowledged",replayed:false});

      const authority=await transitionHistoricalOnboardingToV7Acquisition(database);
      expect(authority.reviewer).toMatchObject({admissionVersion:5,profileVersion:1,grantGeneration:6});
      expect((await database.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE grant_id=? ORDER BY grant_version`).bind(historical.onboardingGrantId).all()).results).toEqual([
        {grant_version:1,active:0,grant_generation:2},{grant_version:2,active:1,grant_generation:3},
        {grant_version:3,active:0,grant_generation:4},
      ]);
      expect((await database.prepare(`SELECT permission,scope_kind,active,grant_version,grant_generation
        FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation`)
        .bind(canonicalOwner.operationsStaffId).all()).results).toEqual([
        {permission:"directory.profile.edit",scope_kind:"global",active:0,grant_version:1,grant_generation:1},
        {permission:"directory.profile.edit",scope_kind:"business_area",active:0,grant_version:1,grant_generation:2},
        {permission:"directory.profile.edit",scope_kind:"business_area",active:1,grant_version:2,grant_generation:3},
        {permission:"directory.profile.edit",scope_kind:"business_area",active:0,grant_version:3,grant_generation:4},
        {permission:"directory.profile.edit",scope_kind:"global",active:1,grant_version:2,grant_generation:5},
        {permission:"directory.identity.link",scope_kind:"resource",active:1,grant_version:1,grant_generation:6},
      ]);

      const fetcher=projectAlphaRemote(),request={reviewId:"80000000-0000-4000-8000-000000000001",
        commandId:"80000000-0000-4000-8000-000000000002",sourceId:acquiredSource.sourceId,
        recordId:canonicalUuidOrganization.recordId,resourceType:"organization" as const,
        projectAlphaPublicId:canonicalUuidOrganization.publicId,localRecordVersion:1,reviewer:authority.reviewer};
      const acquired=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},request,fetcher);
      expect(acquired).toMatchObject({status:"acquired",replayed:false});if(acquired.status!=="acquired")throw Error(JSON.stringify(acquired));
      await expect(acquireProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},request,fetcher))
        .resolves.toEqual({...acquired,replayed:true});
      const activationRequest={reviewItemId:acquired.reviewReceiptId,idempotencyKey:"80000000-0000-4000-8000-000000000003"};
      const activated=await activateProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        activationRequest,{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher);
      expect(activated).toMatchObject({status:"activated",replayed:false,recordId:canonicalUuidOrganization.recordId});
      if(activated.status!=="activated")throw Error(JSON.stringify(activated));
      await expect(activateProjectAlphaExistingDirectoryBinding({OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        activationRequest,{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher))
        .resolves.toEqual({...activated,replayed:true});
      expect(await database.prepare(`SELECT directory_grant_generation FROM project_alpha_existing_directory_binding_activation_receipts
        WHERE activation_id=?`).bind(activated.activationId).first("directory_grant_generation")).toBe(6);
      expect(await database.prepare(`SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts activation
        JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=activation.acquired_receipt_id
        JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=activation.native_owner_claim_id
        JOIN project_alpha_active_directory_mappings active ON active.provenance_id=activation.activation_id
        WHERE activation.activation_id=? AND activation.review_receipt_id=? AND activation.record_id=?
          AND active.mapping_kind='acquired' AND claim.receipt_id=acquired.receipt_id`)
        .bind(activated.activationId,acquired.reviewReceiptId,canonicalUuidOrganization.recordId).first("count")).toBe(1);

      const portal=await transitionHistoricalV7ToV8PortalAuthority(database,activated.activationId);
      const priorHistory=(await database.prepare(`SELECT grant_id,grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE grant_id IN (?,?,?) ORDER BY grant_id,grant_version`)
        .bind(authority.v7.ids.directoryGrant,authority.v7.ids.identityGrant,historical.onboardingGrantId).all()).results;
      expect(priorHistory).toHaveLength(8);
      const selectionCommand={selectionId:"80000000-0000-4000-8000-000000000004",recordId:canonicalUuidOrganization.recordId,
        activationId:activated.activationId,workspaceId:"canonical-historical-workspace",sourceWorkspaceId:"canonical-historical-source",
        checkpoint:{sourceGeneration:"generation-1",sourceSequence:1,snapshotGenerationId:"snapshot-1"}};
      const selection=await selectPortalWorkspaceBinding(database,portal.actor,selectionCommand);
      expect(selection).toMatchObject({recordId:canonicalUuidOrganization.recordId,activationId:activated.activationId,
        rootType:"organization",rootPublicId:canonicalUuidOrganization.publicId,state:"inactive",replayed:false});
      await expect(selectPortalWorkspaceBinding(database,portal.actor,selectionCommand)).resolves.toEqual({...selection,replayed:true});
      expect((await database.prepare(`SELECT permission,scope_kind,resource_id,active FROM native_directory_grants
        WHERE staff_id=? ORDER BY permission,scope_kind`).bind(canonicalOwner.operationsStaffId).all()).results).toEqual([
        {permission:"directory.identity.link",scope_kind:"resource",resource_id:canonicalUuidOrganization.recordId,active:0},
        {permission:"directory.portal_access.manage",scope_kind:"resource",resource_id:canonicalUuidOrganization.recordId,active:1},
        {permission:"directory.profile.edit",scope_kind:"business_area",resource_id:null,active:0},
        {permission:"directory.profile.edit",scope_kind:"global",resource_id:null,active:0},
      ]);
      await revokeHistoricalV8PortalAuthority(database);
      expect((await database.prepare(`SELECT grant_id,grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE grant_id IN (?,?,?) ORDER BY grant_id,grant_version`)
        .bind(authority.v7.ids.directoryGrant,authority.v7.ids.identityGrant,historical.onboardingGrantId).all()).results).toEqual(priorHistory);
      expect((await database.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
        WHERE grant_id=? ORDER BY grant_version`).bind(portal.v8.ids.portalAccessGrant).all()).results).toEqual([
        {grant_version:1,active:1,grant_generation:9},{grant_version:2,active:0,grant_generation:10},
      ]);
      await expect(selectPortalWorkspaceBinding(database,portal.actor,selectionCommand)).rejects.toThrow("portal_workspace_binding_selection_denied");
    }finally{await isolated.dispose();}
  },240_000);
});
