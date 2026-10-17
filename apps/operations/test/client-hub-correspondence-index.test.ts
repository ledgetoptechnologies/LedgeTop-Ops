import {afterAll,beforeAll,expect,it} from 'vitest';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,createReviewedCorrespondenceGroup} from './helpers/shared-profile-correspondence-fixture';
import {createIndependentPrimaryClientProjection} from './helpers/central-correspondence-client-projection-fixture';
import {reconcileClientHubIndex} from '../src/worker/client-hub-index';
import {managePortalDirectoryCorrespondence,previewPortalDirectoryCorrespondence} from '../src/worker/portal-directory-correspondence';
import type {Env} from '../src/worker/types';
const logical='project-alpha:staging',physical='project-alpha:primary';
beforeAll(initializeCorrespondenceComposerFixture,300_000);
afterAll(disposeCorrespondenceComposerFixture);
async function finish(env:Env){
 await env.OPS_DB.prepare('UPDATE client_hub_directory_state SET next_run_at=NULL').run();
 for(let i=0;i<30;i++){
  const result=await reconcileClientHubIndex(env,40);
  if(result.status==='complete')return;
  expect(result.status).toBe('progress');
 }
 throw Error('Index did not finish within bounded passes');
}
it('folds only a currently reviewed alias and indexes its physical principal under the logical business root',async()=>{
 const f=await createReviewedCorrespondenceGroup(true),record=f.records[0]!;
 const rootPublicId=f.publicIds.get(record.input.recordId)!;
 const projection=await createIndependentPrimaryClientProjection(f.correspondence.client,rootPublicId);
 const db=f.env.OPS_DB;
 const linked=()=>db.prepare("SELECT source_id,root_namespace,public_id,workspace_id FROM client_hub_roots WHERE workspace_id=? AND status='active' ORDER BY source_id,root_namespace")
  .bind(projection.workspaceId).all<{source_id:string;root_namespace:string;public_id:string;workspace_id:string}>();
 const search=()=>db.prepare("SELECT source_id,root_namespace,root_public_id FROM client_hub_search_values WHERE record_type='portal_principal' AND record_id=? AND field='email'")
  .bind(JSON.stringify([projection.workspaceId,projection.principalPublicId])).all<{source_id:string;root_namespace:string;root_public_id:string}>();
 // Exact public-ID collision alone creates neither a logical link nor logical principal search.
 await finish(f.env);
 expect((await linked()).results).toEqual([{source_id:physical,root_namespace:'portal',public_id:projection.workspaceId,workspace_id:projection.workspaceId}]);
 expect((await search()).results.every(row=>row.source_id===physical)).toBe(true);
 await f.correspondence.approve();
 await finish(f.env);
 expect((await linked()).results).toEqual([{source_id:logical,root_namespace:'business',public_id:record.input.recordId,workspace_id:projection.workspaceId}]);
 expect((await search()).results).toEqual([{source_id:logical,root_namespace:'business',root_public_id:record.input.recordId}]);
 const savedConfiguration=f.env.PROJECT_ALPHA_API_V2_CONNECTIONS!;
 const changed=JSON.parse(savedConfiguration);changed.instances[logical].sourceInstanceId='66666666-6666-4666-8666-666666666666';
 f.env.PROJECT_ALPHA_API_V2_CONNECTIONS=JSON.stringify(changed);
 await finish(f.env);
 expect((await linked()).results).toEqual([{source_id:physical,root_namespace:'portal',public_id:projection.workspaceId,workspace_id:projection.workspaceId}]);
 expect((await search()).results.some(row=>row.source_id===logical)).toBe(false);
 f.env.PROJECT_ALPHA_API_V2_CONNECTIONS=savedConfiguration;
 const status=await previewPortalDirectoryCorrespondence(f.correspondence.env,logical);
 if(!status.current)throw Error('missing current correspondence');
 expect((await managePortalDirectoryCorrespondence(f.correspondence.env,f.correspondence.actor,logical,{operationId:crypto.randomUUID(),action:'revoke',expectedVersion:status.current.version,expectedProofSha256:status.current.revocationProofSha256})).ok).toBe(true);
 await finish(f.env);
 expect((await linked()).results).toEqual([{source_id:physical,root_namespace:'portal',public_id:projection.workspaceId,workspace_id:projection.workspaceId}]);
 expect((await search()).results.some(row=>row.source_id===logical)).toBe(false);
},300_000);
