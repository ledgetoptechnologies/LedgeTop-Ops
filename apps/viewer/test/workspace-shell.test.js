'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'workspace-projects.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'workspace-new-task.mjs'),'utf8');
const api=fs.readFileSync(path.join(root,'server','processingApi.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server','index.js'),'utf8');

test('workspace redeems an Ops grant and removes it from the URL',()=>{
  assert.match(source,/\/api\/v1\/admin-sessions\/redeem/);
  assert.match(source,/syncWorkspaceView\('replace'\)/);
  assert.match(source,/return`\/workspace\?\$\{params\}`/);
  assert.match(source,/sessionStorage\.setItem\(TOKEN_KEY,state\.token\)/);
});
test('workspace keeps imports and access modes explicit',()=>{
  assert.match(source,/This immediately queues a durable import from the managed server folder/);
  assert.match(source,/there is no preview step/);
  assert.match(source,/\/api\/v1\/processing\/server-task-imports/);
  assert.match(source,/\/api\/v1\/workspace\/client-grants/);
  assert.doesNotMatch(source,/Scan WebODM mount/);
});
test('workspace client grants are responsive, project-filtered, and preserve public links',()=>{
  assert.match(source,/client-grant-form/);
  assert.match(source,/associationModelId\(item\)!==output\.modelId/);
  assert.match(source,/scopeType:onlyOutputId\?'task':'project'/);
  assert.match(source,/includeFuturePublished:!onlyOutputId&&form\.elements\.includeFuturePublished\.checked/);
  assert.match(source,/revoke-client-grant/);
  assert.doesNotMatch(source,/ops\.ledgetopdroneservices\.com\/data/);
  assert.match(source,/share-form/);
  assert.match(fs.readFileSync(path.join(root,'workspace-management.css'),'utf8'),/@media\(max-width:720px\)/);
});
test('workspace management panels issue real bearer API mutations',()=>{
  for(const route of [
    '/api/v1/projects','/api/v1/datasets','/api/v1/task-submissions',
    '/api/v1/processing/providers','/api/v1/processing/server-task-imports',
    '/review-sessions','/publish',
    '/api/v1/storage/trash/',
  ]) assert.ok(source.includes(route),`missing workspace API ${route}`);
  assert.match(source,/Idempotency-Key/);
  assert.match(source,/selectedAssetKinds:result\.assetKinds/);
  assert.doesNotMatch(source,/credential\.token|rootKey/);
});
test('workspace supports bounded resumable browser uploads and staff share lifecycle',()=>{
  for(const value of ['/uploads','/chunks/','/finalize','processingRole','missingChunks','files.length>128','64*1024**2','processing/shares/'])assert.ok(source.includes(value),value);
  assert.match(source,/crypto\.subtle\.digest/);
  assert.match(source,/share-form/);
  assert.match(api,/router\.post\('\/api\/v1\/processing\/outputs\/:id\/shares'/);
  assert.match(api,/router\.delete\('\/api\/v1\/processing\/shares\/:id'/);
});
test('permission denial preserves the valid admin session',()=>{
  assert.match(source,/if\(response\.status===403\)throw responseError/);
  const forbidden=source.slice(source.indexOf('if(response.status===403'),source.indexOf("if(!response.ok)"));
  assert.doesNotMatch(forbidden,/removeItem|state\.token=null/);
});
test('workspace renders every management section instead of placeholders',()=>{
  for(const view of ['dashboard','selectedProject','providers','diagnostics'])
    assert.match(source,new RegExp(`function ${view}\\(`));
  assert.doesNotMatch(source,/sectionPlaceholder/);
});
test('Ops overview is aggregate-only and service authenticated',()=>{
  assert.match(api,/router\.get\('\/api\/v1\/overview',authorize\('',\{hmacOnly:true\}\)/);
  const route=api.slice(api.indexOf("router.get('/api/v1/overview'"),api.indexOf("router.get('/api/v1/projects'"));
  for(const field of ['schemaVersion','generatedAt','projects','models','jobs','providers','storage','platform'])assert.match(route,new RegExp(`${field}:`));
  assert.doesNotMatch(route,/relativePath|rootKey|credential|token/);
  assert.match(route,/NOT EXISTS \(SELECT 1 FROM processing_attempts a JOIN model_outputs o ON o\.attempt_id=a\.id WHERE a\.dataset_id=d\.id/);
  assert.match(route,/o\.storage_mode='adopted'/);
});
test('workspace route remains separate from model sessions',()=>{
  assert.match(server,/app\.get\(\['\/workspace', '\/workspace\/\*'\]/);
  assert.match(server,/workspace\.html/);
});
test('review tabs use an isolated random channel for bounded session renewal',()=>{
  const openers=source.slice(source.indexOf('async function openReview'),source.indexOf('async function downloadOutputAsset'));
  assert.match(source,/import \{ ReviewSessionController \} from '\.\/review-session-controller\.mjs'/);
  assert.match(source,/import \{ beginIsolatedViewerLaunch \} from '\.\/isolated-viewer-launch\.mjs'/);
  assert.match(source,/new ReviewSessionController\(/);
  assert.match(openers,/launch=await readyViewerLauncher\(\)/);
  assert.match(openers,/reviewSessionController\.track\(launch\.channelId,\{attemptId:result\.attemptId,modelId:result\.modelId,modelVersionId:result\.modelVersionId,sessionTtlSeconds:result\.sessionTtlSeconds\}\)/);
  assert.match(openers,/launch\.navigate\(result\.embedUrl,\{renewable:true\}\)/);
  assert.doesNotMatch(openers,/about:blank|target\.opener|target\.location/);
});
test('invalid server task-import projects are rejected before durable receipt reservation',()=>{
  const guard=api.indexOf('router.use(serverTaskImportPaths');
  const route=api.indexOf('router.post(serverTaskImportPaths');
  assert.ok(guard>0&&guard<route);
  assert.match(api,/serverTaskImportPaths=\['\/api\/v1\/processing\/server-task-imports','\/api\/v1\/processing\/webodm-task-imports'\]/);
  assert.match(api.slice(guard,route),/authorize\('viewer\.datasets\.import'\)/);
  assert.match(api.slice(guard,route),/!processing\.getProject\(req\.body\.projectId\)/);
});
