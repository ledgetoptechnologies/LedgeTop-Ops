import {expect,test} from '@playwright/test';

test('Models dashboard leaves client sharing inside the Viewer workspace',async({page})=>{
  let nativeGrantRequests=0;
  await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:{id:'staff-one',email:'admin@example.test',displayName:'Admin',status:'Active',
      profileType:'Administrator',isAdministrator:true,permissions:['viewer.view','viewer.manage'],divisions:[]},csrfToken:'csrf',timezone:'America/Chicago',
      mapStyleUrl:null,mapboxPublicToken:null,units:{default:'imperial',resolved:'imperial'},capabilities:{}}});
    if(path==='/api/viewer/overview')return route.fulfill({json:{enabled:true,viewerBaseUrl:'https://viewer.example.test',overview:{schemaVersion:1,
      generatedAt:'2026-09-06T12:00:00Z',projects:{active:1,total:1},models:{published:1,total:1,bytes:1024},jobs:{queued:0,running:0,reviewReady:0,failed:0},
      providers:{enabled:1,healthy:1,total:1},storage:{usedBytes:1024,availableBytes:2048},platform:{ready:true,workerLive:true,lifecycleBlocked:false}}}});
    if(path.startsWith('/api/viewer/native-client-grants')){nativeGrantRequests+=1;return route.fulfill({status:500,json:{error:'This endpoint must not be called by the Models dashboard'}});}
    return route.fulfill({status:404,json:{error:'Not found'}});});
  await page.goto('/viewer');
  await expect(page.getByRole('heading',{name:'3D models',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Open Viewer workspace'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Native client Viewer access'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Grant portal access'})).toHaveCount(0);
  expect(nativeGrantRequests).toBe(0);
});
