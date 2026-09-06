import {expect,test} from '@playwright/test';

test('native portal Viewer grants are explicit, exact and revocable from Operations',async({page})=>{
  let granted=false;let createBody:Record<string,unknown>|null=null;let revoked=false;
  await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:{id:'staff-one',email:'admin@example.test',displayName:'Admin',status:'Active',
      profileType:'Administrator',isAdministrator:true,permissions:['viewer.view','viewer.manage'],divisions:[]},csrfToken:'csrf',timezone:'America/Chicago',
      mapStyleUrl:null,mapboxPublicToken:null,units:{default:'imperial',resolved:'imperial'},capabilities:{}}});
    if(path==='/api/viewer/overview')return route.fulfill({json:{enabled:true,viewerBaseUrl:'https://viewer.example.test',overview:{schemaVersion:1,
      generatedAt:'2026-09-06T12:00:00Z',projects:{active:1,total:1},models:{published:1,total:1,bytes:1024},jobs:{queued:0,running:0,reviewReady:0,failed:0},
      providers:{enabled:1,healthy:1,total:1},storage:{usedBytes:1024,availableBytes:2048},platform:{ready:true,workerLive:true,lifecycleBlocked:false}}}});
    if(path==='/api/viewer/native-client-grants'&&request.method()==='GET')return route.fulfill({json:{targets:[{sourceId:'project-alpha:primary',
      workspaceId:'workspace-one',workspaceName:'Greenwood',projectPublicId:'project-one',projectName:'Church',associations:[{id:'association-one',modelTitle:'Church model'}]}],
      grants:granted&&!revoked?[{id:'grant-one',workspace_name:'Greenwood',project_name:'Church',model_title:'Church model',scope_type:'task',authorization_expires_at:null}]:[]}});
    if(path==='/api/viewer/native-client-grants'&&request.method()==='POST'){createBody=request.postDataJSON();granted=true;return route.fulfill({status:201,json:{grant:{id:'grant-one'},replayed:false}});}
    if(path==='/api/viewer/native-client-grants/grant-one'&&request.method()==='DELETE'){revoked=true;return route.fulfill({json:{success:true,replayed:false,existingSessionsExpireWithinSeconds:1800}});}
    return route.fulfill({status:404,json:{error:'Not found'}});});
  await page.goto('/viewer');await expect(page.getByRole('heading',{name:'Native client Viewer access'})).toBeVisible();
  await expect(page.getByText(/existing session can remain active for up to 30 minutes/)).toBeVisible();
  await page.getByRole('button',{name:'Grant portal access'}).click();await expect(page.getByRole('heading',{name:'Church model'})).toBeVisible();
  expect(createBody).toMatchObject({sourceId:'project-alpha:primary',workspaceId:'workspace-one',projectPublicId:'project-one',scopeType:'task',
    associationId:'association-one',includeFuturePublished:false,permissions:{measure:true,cameras:true,download:false}});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Revoke access'}).click();
  await expect(page.getByText('No native Viewer access',{exact:true})).toBeVisible();expect(revoked).toBe(true);
});
