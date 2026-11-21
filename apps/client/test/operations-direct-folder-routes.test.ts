import {describe,expect,it} from 'vitest';
import {Hono} from 'hono';
import {createOperationsDirectFolderRouter} from '../src/worker/client-portal/operations-direct-folder-routes';
import type {Env} from '../src/worker/types';
import {readDirectFolderSharingCapability} from '../src/worker/operations-portal-direct-folder-grants';

describe('Operations direct folder admission gate',()=>{
  it('advertises no direct-sharing capability in PA mode even when the direct flag is on',()=>{
    expect(JSON.parse(readDirectFolderSharingCapability({CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:'true'})))
      .toEqual({protocolVersion:1,enabled:false});
    expect(JSON.parse(readDirectFolderSharingCapability({CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:'true',
      CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:'true'})))
      .toEqual({protocolVersion:1,enabled:true});
  });
  for(const flags of [
    {},
    {CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:'true'},
    {CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:'true',CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:'false'},
    {CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:'true'},
  ])it(`stays closed without all explicit gates: ${JSON.stringify(flags)}`,async()=>{
    let resolutions=0;
    const app=new Hono<{Bindings:Env}>();
    app.route('/api/client/operations/direct-folders',createOperationsDirectFolderRouter({resolvePrincipal:async()=>{
      resolutions++;return null;
    }}));
    const response=await app.request('https://portal.test/api/client/operations/direct-folders',{},flags as Env);
    expect(response.status).toBe(404);expect(resolutions).toBe(0);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it('requires authentication even for disabled feature metadata',async()=>{
    let resolutions=0;
    const app=new Hono<{Bindings:Env}>();
    app.route('/api/client/operations/direct-folders',createOperationsDirectFolderRouter({resolvePrincipal:async()=>{
      resolutions++;return null;
    }}));
    const response=await app.request('https://portal.test/api/client/operations/direct-folders/capability',{},
      {CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:'true',
        CLIENT_PORTAL_ORIGIN:'https://portal.test',ENVIRONMENT:'staging',CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:'false'} as Env);
    expect(response.status).toBe(401);expect(resolutions).toBe(1);
  });
});
