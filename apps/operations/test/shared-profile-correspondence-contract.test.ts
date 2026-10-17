import {expect,it} from 'vitest';
import {portalGrantSchema,stablePortalRequestFingerprint,type SharedProfilePortalGrant} from '../src/worker/shared-profile-portal-authority';
const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222';
const request={operationId:id,id,workspaceId:'workspace',sourceId:'project-alpha:staging',recipientMode:'first_verified_identity',issuer:null,subject:null,
 principalPublicId:'principal',targetType:'client',targetPublicId:'client',recordId:id,groupId:id,expectedRevision:0,state:'active'};
it('accepts the unchanged same-ID wire and only a strict complete alias correspondence pair',()=>{
 expect(portalGrantSchema.safeParse(request).success).toBe(true);
 expect(portalGrantSchema.safeParse({...request,portalSourceId:'project-alpha:primary',correspondenceRevisionId:revision}).success).toBe(true);
 for(const delta of [{portalSourceId:'project-alpha:primary'},{correspondenceRevisionId:revision},
  {portalSourceId:request.sourceId,correspondenceRevisionId:revision},{portalSourceId:'project-alpha:primary',correspondenceRevisionId:'unknown'},
  {portalSourceId:'project-alpha:primary',correspondenceRevisionId:revision,extra:true}])expect(portalGrantSchema.safeParse({...request,...delta}).success).toBe(false);
});
it('pins alias correspondence in stable business intent while preserving legacy NULL representation',async()=>{
 const grant={id,workspace_id:'workspace',source_id:'project-alpha:primary',source_instance_id:'instance',application_id:'application',history_epoch_id:'epoch',
  issuer:'issuer',subject:'subject',principal_public_id:'principal',target_type:'client',target_public_id:'client',record_id:id,group_id:id,revision:1,
  profile_json:'{}',version:1,kind:'client',group_membership_json:JSON.stringify([id])} satisfies SharedProfilePortalGrant;
 const input={protocolVersion:1 as const,workspaceId:'workspace',sourceId:'project-alpha:primary',issuer:'issuer',subject:'subject',authorityRevision:1,
  contextVersion:'a'.repeat(64),verifiedUntil:'2026-10-17T08:00:00.000Z',targets:[],grantId:id,expectedVersion:1,mutationId:id,profile:{name:'Client'}};
 const legacy=await stablePortalRequestFingerprint(input,grant);
 expect(await stablePortalRequestFingerprint(input,{...grant,directory_source_id:null,correspondence_revision_id:null})).toBe(legacy);
 const alias={...grant,directory_source_id:request.sourceId,correspondence_revision_id:revision};
 const aliasHash=await stablePortalRequestFingerprint(input,alias);expect(aliasHash).not.toBe(legacy);
 expect(await stablePortalRequestFingerprint({...input,authorityRevision:9,contextVersion:'b'.repeat(64)},alias)).toBe(aliasHash);
 expect(await stablePortalRequestFingerprint(input,{...alias,correspondence_revision_id:id})).not.toBe(aliasHash);
});
