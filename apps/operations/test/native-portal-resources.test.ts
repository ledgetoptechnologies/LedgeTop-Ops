import { readFileSync,readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createLocalJWKSet,exportJWK,generateKeyPair,SignJWT,type JWTVerifyGetKey } from 'jose';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { provisionPortalSourceAuthority,setPortalSourceAuthorityState,type PortalAuthorityConnectorIdentity } from '../../client/src/worker/project-alpha-portal-authority';
import { handleRegisteredProjectAlphaPortalRequest,portalSourceProjectionPath,verifyRegisteredPortalAccess } from '../../client/src/worker/project-alpha-portal-ingress';
import { createClientPortalRouter } from '../../client/src/worker/client-portal/routes';
import { resolveCloudflareClientPrincipal } from '../../client/src/worker/client-portal/access-identity';
import { resolveEffectivePortalWorkspaceContext,resolveNativePortalWorkspaceReadContext } from '../../client/src/worker/client-portal/workspace-v2';
import { d1ClientPortalRepository } from '../../client/src/worker/client-portal/repository';
import type { Env } from '../../client/src/worker/types';
import type { ClientFilePage } from '../../client/src/worker/client-portal/types';
import { decodeNativePortalHandle,encodeNativePortalHandle } from '../../client/src/worker/client-portal/native-portal-handles';
import { createNativePortalWorkspaceRouter } from '../../client/src/worker/client-portal/native-portal-resources';
import { readNativeAuthenticatedDeliveryPage } from '../../client/src/worker/client-portal/authenticated-delivery-grants';
import { Hono } from 'hono';
vi.mock('cloudflare:workers',()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
import { previewNativeDeliveryGrant,createNativeDeliveryGrant } from '../src/worker/native-delivery-bindings';
import { getStaffFeedback,transitionStaffFeedback } from '../src/worker/client-feedback';
import { registerProjectAlphaConnector,setProjectAlphaConnectorState } from '../src/worker/project-alpha-connectors';
import { createProjectAlphaSourceContext,prepareProjectAlphaSourceRecords } from '../src/worker/project-alpha-source';
import { encodeRef } from '../src/worker/delivery';
import type { Env as OperationsEnv,StaffPrincipal } from '../src/worker/types';

const issuer='https://native-test.cloudflareaccess.com',app='field_operations_portal',email='person@example.test';
const principal={issuer,subject:'one-global-person',email};
const rootId='a'.repeat(32),projectId='b'.repeat(32);
const staff:StaffPrincipal={id:'staff-test',email:'staff@example.test',displayName:'Authorized staff',accessSubject:'verified-staff',projectAlphaUserId:null};
const bytes=(s:string)=>new TextEncoder().encode(s);
async function hash(s:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
type Fixture={source:string;name:string;secret:string;keyId:string;connector:PortalAuthorityConnectorIdentity;workspace:string;binding:string;grant:string;version:number};
describe('source-owned native portal resources with real signed projection and login',{timeout:60_000},()=>{
  let runtime:Miniflare,db:D1Database,opsDb:D1Database,opsEnv:OperationsEnv,env:Env,keypair:Awaited<ReturnType<typeof generateKeyPair>>,jwks:JWTVerifyGetKey,clientToken:string;
  let a:Fixture,b:Fixture,beforeLogin:number,bootstrapStatus:number,pendingPublicationChecks=0;
  let reads:string[]=[],headHook:(()=>Promise<void>)|null=null,getHook:(()=>Promise<void>)|null=null;
  let bodyCancelled=false;
  function fixture(name:string):Fixture {return {name,source:`project-alpha:native-${name}`,secret:`native-${name}-portal-secret-at-least-32-bytes`,keyId:`native-${name}-key`,
    connector:{sourceId:`project-alpha:native-${name}`,producerBindingId:`native-${name}`,snapshotOrigin:`https://native-${name}.example.test`,
      snapshotBasePath:'/',applicationKey:app,profile:'business_data',revision:1,version:2,state:'active'},workspace:'',binding:`binding-${name}`,grant:`grant-${name}`,version:0};}
  function page(f:Fixture){return {schemaVersion:2,applicationKey:app,deliveryId:'same-page',occurredAt:'2026-08-26T12:00:00.000Z',
    sourceGeneration:'same-generation',sourceSequence:1,workspaceId:'same-workspace',kind:'snapshot.page',snapshotHash:'a'.repeat(64),pageNumber:1,pageCount:1,recordCount:6,
    workspace:{publicId:'same-workspace',rootType:'organization',rootPublicId:rootId,displayName:`Customer ${f.name}`,sourceVersion:'root-v1',active:true},
    entities:[{type:'organization',publicId:rootId,parentPublicId:null,displayName:`Customer ${f.name}`,sourceVersion:'root-v1',active:true,primaryContact:false},
      {type:'project',publicId:projectId,parentPublicId:rootId,displayName:`Project ${f.name}`,sourceVersion:'project-v1',active:true,primaryContact:false}],
    principals:[{publicId:'same-person',emailHint:email,displayName:'Person',sourceVersion:'person-v1',active:true}],
    entitlements:['workspace.view','directory.read','delivery.view'].map((capability,i)=>({publicId:`same-intent-${i}`,principalPublicId:'same-person',capability,
      effect:'allow',scopeType:'workspace',scopePublicId:'same-workspace',sourceVersion:'intent-v1',active:true,validFrom:'2026-08-01T00:00:00.000Z',expiresAt:null}))};}
  async function signed(f:Fixture,payload:{deliveryId:string}&Record<string,unknown>,target=env){
    const body=JSON.stringify(payload),timestamp=new Date().toISOString(),path=portalSourceProjectionPath(f.source);
    const key=await crypto.subtle.importKey('raw',bytes(f.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=await crypto.subtle.sign('HMAC',key,bytes(`${timestamp}\nPOST\n${path}\n${f.keyId}\n${payload.deliveryId}\n${body}`));
    const signature=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
    const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'native-test'}).setIssuer(issuer).setAudience('native-producer-aud')
      .setSubject('explicit-source-producer').setIssuedAt().setExpirationTime('5m').sign(keypair.privateKey);
    return handleRegisteredProjectAlphaPortalRequest(new Request(`https://client.test${path}`,{method:'POST',body,headers:{'Content-Type':'application/json',
      'Cf-Access-Jwt-Assertion':token,'X-Portal-Integration-Application-Key':app,'X-Portal-Integration-Timestamp':timestamp,
      'X-Portal-Integration-Body-SHA256':await hash(body),'X-Portal-Integration-Key-Id':f.keyId,
      'X-Portal-Integration-Delivery-Id':payload.deliveryId,'X-Portal-Integration-Signature':`sha256=${signature}`}}),target,f.source,
      (request,authority)=>verifyRegisteredPortalAccess(request,authority,jwks));
  }
  function router(){return createClientPortalRouter({repository:d1ClientPortalRepository,
    resolvePrincipal:(request,environment)=>resolveCloudflareClientPrincipal(request,environment,jwks)});}
  function request(path:string,options:RequestInit={},target=env,token=clientToken){const headers=new Headers(options.headers);headers.set('Cf-Access-Jwt-Assertion',token);
    return router().request(`https://client.test${path.replace(/^\/api\/client/,'')}`,{...options,headers},target);}
  const base=(f:Fixture)=>`/v2/workspaces/${f.workspace}`;
  async function context(f:Fixture){const response=await request(`${base(f)}/context`);expect(response.status).toBe(200);return response.json() as Promise<{contextVersion:string}>;}
  async function folder(f:Fixture){const response=await request(`${base(f)}/deliveries`);expect(response.status).toBe(200);
    const json=await response.json() as {items:Array<{id:string}>};return json.items[0]!.id;}
  async function files(f:Fixture){const id=await folder(f),response=await request(`${base(f)}/folders/${id}`);expect(response.status).toBe(200);return response.json() as Promise<ClientFilePage>;}
  async function state(f:Fixture,value:'active'|'suspended'){
    const result=await setPortalSourceAuthorityState(env,f.connector,f.version,value,'staff-test');f.version=result.version;
  }
  async function eligibilityCase(name:string,ambiguous=false){
    const f={...b,workspace:''},snapshot=page(f),external=`eligibility-${name}`,root=`root-${name}`,person={issuer,subject:`subject-${name}`,email:`${name}@example.test`};
    snapshot.deliveryId=`page-${name}`;snapshot.workspaceId=external;snapshot.workspace.publicId=external;snapshot.workspace.rootPublicId=root;
    snapshot.sourceGeneration=`generation-${name}`;snapshot.entities[0]!.publicId=root;snapshot.entities[1]!.parentPublicId=root;
    snapshot.principals[0]!.emailHint=person.email;
    for(const item of snapshot.entitlements)item.scopePublicId=external;
    snapshot.recordCount=snapshot.entities.length+snapshot.principals.length+snapshot.entitlements.length;
    expect((await signed(f,snapshot)).status).toBe(200);
    expect((await signed(f,{schemaVersion:2,applicationKey:app,deliveryId:`activate-${name}`,occurredAt:snapshot.occurredAt,
      sourceGeneration:snapshot.sourceGeneration,sourceSequence:1,workspaceId:external,kind:'snapshot.activate',snapshotHash:snapshot.snapshotHash,
      pageCount:1,recordCount:snapshot.recordCount} as typeof snapshot)).status).toBe(200);
    f.workspace=(await db.prepare('SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?')
      .bind(f.source,external).first<string>('workspace_id'))!;
    if(ambiguous)expect((await signed(f,{schemaVersion:2,applicationKey:app,deliveryId:`ambiguous-${name}`,occurredAt:snapshot.occurredAt,
      sourceGeneration:snapshot.sourceGeneration,sourceSequence:2,workspaceId:external,kind:'event',
      event:{resource:'principal',action:'upsert',principal:{...snapshot.principals[0]!,publicId:'second-same-email'}}})).status).toBe(200);
    const token=await new SignJWT({email:person.email,type:'app'}).setProtectedHeader({alg:'RS256',kid:'native-test'}).setIssuer(issuer)
      .setAudience('native-client-aud').setSubject(person.subject).setIssuedAt().setExpirationTime('1h').sign(keypair.privateKey);
    return {f,person,token,snapshot};
  }
  function beforeEligibilityBatch(action:()=>Promise<void>):D1Database{
    let injected=false,proxy:D1Database;
    proxy=new Proxy(db,{get(target,key){
      if(key==='withSession')return ()=>proxy;
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!injected){injected=true;await action();}return target.batch(statements);};
      const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;
    }});return proxy;
  }
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:'2026-07-22',modules:true,script:"export default {fetch(){return new Response('native')}}",d1Databases:{DELIVERY_DB:'native-resources',OPS_DB:'native-operations'}});
    db=await runtime.getD1Database('DELIVERY_DB') as D1Database;
    for(const name of readdirSync(new URL('../../client/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<'0166_').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(
      new URL('../../client/migrations/0172_project_access_authority_history.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(
      new URL('../../client/migrations/0184_native_client_feedback.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(
      new URL('../../client/migrations/0187_authenticated_content_audit.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(
      new URL('../../client/migrations/0188_native_feedback_completion_notices.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    opsDb=await runtime.getD1Database('OPS_DB') as D1Database;
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<'0041_').sort())
      await opsDb.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>opsDb.prepare(sql)));
    await opsDb.batch(splitD1MigrationStatements(readFileSync(
      new URL('../migrations/0050_project_alpha_draft_quote_credentials.sql',import.meta.url),'utf8')).map(sql=>opsDb.prepare(sql)));
    keypair=await generateKeyPair('RS256',{extractable:true});const key=await exportJWK(keypair.publicKey);key.kid='native-test';key.alg='RS256';jwks=createLocalJWKSet({keys:[key]});
    clientToken=await new SignJWT({email,type:'app'}).setProtectedHeader({alg:'RS256',kid:'native-test'}).setIssuer(issuer).setAudience('native-client-aud')
      .setSubject(principal.subject).setIssuedAt().setExpirationTime('1h').sign(keypair.privateKey);
    a=fixture('a');b=fixture('b');
    env={DELIVERY_DB:db,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',CLIENT_PORTAL_ORIGIN:'https://client.test',
      CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:`${a.source},${b.source}`,
      PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true',
      PUBLIC_BULK_RATE_LIMITER:{limit:async()=>({success:true})},
      CLIENT_ACCESS_TEAM_DOMAIN:issuer,CLIENT_ACCESS_AUD:'native-client-aud',DELIVERY_SESSION_SECRET:'native-handle-secret-at-least-thirty-two-bytes',
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED:'true',PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:Object.fromEntries([a,b].map(f=>[f.name,{portalCurrent:{keyId:f.keyId,value:f.secret}}]))}),
      DATA_BUCKET:{
        async head(key:string){reads.push(`head:${key}`);if(headHook){const action=headHook;headHook=null;await action();}
          const name=key.split('/')[1],body=`source-${name}`;return {size:bytes(body).length,etag:`etag-${name}`,httpEtag:`"etag-${name}"`,customMetadata:{}};},
        async get(key:string,options?:{range?:{offset:number;length:number}}){reads.push(`get:${key}`);if(getHook){const action=getHook;getHook=null;await action();}
          const name=key.split('/')[1],all=bytes(`source-${name}`),body=options?.range?all.slice(options.range.offset,options.range.offset+options.range.length):all;
          return {etag:`etag-${name}`,httpEtag:`"etag-${name}"`,customMetadata:{},body:new ReadableStream({start(c){c.enqueue(body);},cancel(){bodyCancelled=true;}})};},
      } as unknown as R2Bucket,
    } as unknown as Env;
    const publicKey=(seed:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const credentials=JSON.parse(env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS!);
    credentials.sets.primary={snapshotApiKey:'native-primary-snapshot-key',eventCurrent:{keyId:'primary-key',algorithm:'ed25519',value:publicKey(1)}};
    for(const [index,f] of [a,b].entries())Object.assign(credentials.sets[f.name],{snapshotApiKey:`native-${f.name}-snapshot-key`,eventCurrent:{keyId:`events-${f.name}`,algorithm:'ed25519',value:publicKey(index+2)}});
    env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=JSON.stringify(credentials);
    opsEnv={...env,OPS_DB:opsDb,APPLICATION_KEY:app,PROJECT_ALPHA_BASE_URL:'https://native-primary.example.test',
      PROJECT_ALPHA_API_KEY:'native-primary-snapshot-key',PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:publicKey(1)} as unknown as OperationsEnv;
    await opsDb.batch([
      opsDb.prepare(`INSERT INTO staff_users(id,email,display_name,status,access_subject) VALUES(?,?,?,'active',?)`).bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
      opsDb.prepare(`INSERT INTO divisions(id,name,code) VALUES('native-division','Native division','native')`),
      opsDb.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('native-admin',?,'role-admin','global','global')`).bind(staff.id),
      opsDb.prepare(`INSERT INTO pa_projects(id,name,payload_json,last_sync_id) VALUES('native-location','Folder location','{}','fixture')`),
      opsDb.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES('native-location','native-division','native/','manual',?)`).bind(staff.id),
    ]);
    for(const permission of ['operations.manage','delivery.browse','projects.view','delivery.share.create','delivery.share.audit','delivery.share.revoke'])
      await opsDb.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin',?)`).bind(permission).run();
    const revision={snapshotBasePath:'/',accessIssuer:issuer,accessAudience:'native-producer-aud',accessSubject:'explicit-source-producer'};
    await registerProjectAlphaConnector(opsEnv,{sourceId:'project-alpha:primary',producerBindingId:'native-primary',snapshotOrigin:'https://native-primary.example.test',
      applicationKey:app,profile:'primary_legacy',displayName:'Primary',revision:{...revision,credentialRef:'primary'}},staff.id);
    await setProjectAlphaConnectorState(opsEnv,'project-alpha:primary',{expectedVersion:1,state:'active'},staff.id);
    for(const f of [a,b]){
      await registerProjectAlphaConnector(opsEnv,{sourceId:f.source,producerBindingId:f.connector.producerBindingId,snapshotOrigin:f.connector.snapshotOrigin,
        applicationKey:app,profile:'business_data',displayName:`Customer ${f.name}`,revision:{...revision,credentialRef:f.name}},staff.id);
      await setProjectAlphaConnectorState(opsEnv,f.source,{expectedVersion:1,state:'active',readVisible:true},staff.id);
      await opsDb.prepare('INSERT INTO pa_connector_portal_sources(source_id,created_by) VALUES(?,?)').bind(f.source,staff.id).run();
      const pending=await provisionPortalSourceAuthority(env,f.connector,{credentialRef:f.name,accessIssuer:issuer,accessAudience:'native-producer-aud',accessSubject:'explicit-source-producer'},null,'staff-test');
      f.version=(await setPortalSourceAuthorityState(env,f.connector,pending.version,'active','staff-test')).version;
      const snapshot=page(f);expect((await signed(f,snapshot)).status).toBe(200);
      expect((await signed(f,{schemaVersion:2,applicationKey:app,deliveryId:'same-activation',occurredAt:snapshot.occurredAt,
        sourceGeneration:snapshot.sourceGeneration,sourceSequence:1,workspaceId:'same-workspace',kind:'snapshot.activate',snapshotHash:snapshot.snapshotHash,pageCount:1,recordCount:6} as typeof snapshot)).status).toBe(200);
      f.workspace=(await db.prepare('SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?')
        .bind(f.source,'same-workspace').first<string>('workspace_id'))!;
    }
    beforeLogin=(await db.prepare('SELECT count(*) n FROM portal_v2_workspace_memberships').first<number>('n'))!;
    bootstrapStatus=(await request('/session')).status;
    expect(bootstrapStatus).toBe(200);
    // Real staff producer: the client cannot consume a pending publication,
    // and no fixture-created membership or binding makes the happy path pass.
    for(const f of [a,b]){
      const mapping=await prepareProjectAlphaSourceRecords(opsDb,createProjectAlphaSourceContext(f.source),
        [{kind:'organization',externalId:'same-organization'},{kind:'project',externalId:'same-project'}]);
      await opsDb.batch([
        opsDb.prepare(`INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,?,?)`)
          .bind(mapping.get('organization','same-organization'),`Customer ${f.name}`,JSON.stringify({public_id:rootId}),'fixture',f.source),
        opsDb.prepare(`INSERT INTO pa_projects(id,organization_id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,?,?,?)`)
          .bind(mapping.get('project','same-project'),mapping.get('organization','same-organization'),`Project ${f.name}`,JSON.stringify({public_id:projectId}),'fixture',f.source),
      ]);
      const input={folderRef:encodeRef(`native/${f.name}`),sourceId:f.source,workspaceId:f.workspace,projectId:mapping.get('project','same-project'),
        principalPublicId:'same-person',reasonCode:'client_delivery',expiresAt:null};
      const preview=await previewNativeDeliveryGrant(opsEnv,staff,input);
      let inspected=false,publicationDb:D1Database;
      publicationDb=new Proxy(db,{get(target,key){if(key==='withSession')return ()=>publicationDb;
        if(key==='batch')return async(statements:D1PreparedStatement[])=>{
          const pending=await db.prepare(`SELECT count(*) n FROM portal_native_staff_grants gate JOIN portal_v2_authenticated_delivery_grants g ON g.id=gate.grant_id
            WHERE g.workspace_id=? AND gate.state='pending'`).bind(f.workspace).first<number>('n');
          if(pending&&!inspected){inspected=true;const response=await request(`${base(f)}/deliveries`);expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({items:[]});pendingPublicationChecks++;}
          return target.batch(statements);
        };
        const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;}});
      const created=await createNativeDeliveryGrant({...opsEnv,DELIVERY_DB:publicationDb},staff,{...input,expectedContextVersion:preview.contextVersion},`native-create-${f.name}`);
      expect(inspected).toBe(true);
      f.grant=created.grant.grantId;
      f.binding=(await db.prepare('SELECT binding_id FROM portal_native_staff_grants WHERE grant_id=?').bind(f.grant).first<string>('binding_id'))!;
      expect(await db.prepare('SELECT state FROM portal_native_staff_grants WHERE grant_id=?').bind(f.grant).first('state')).toBe('active');
      await db.batch([
      db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,8,'2026-08-26T12:00:00Z','text/plain','text')`).bind(`native/${f.name}/report.txt`,`"etag-${f.name}"`),
      db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,8,'2026-08-26T12:00:00Z','text/plain','text')`).bind(`native/${f.name}/child/deep.txt`,`"etag-${f.name}"`),
      db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,8,'2026-08-26T12:00:00Z','text/plain','text')`).bind(`native/${f.name}/_LTDS/private.txt`,`"etag-${f.name}"`),
      ]);
    }
  },180_000);
  afterAll(async()=>runtime.dispose());

  it('real signed projections and login bind one global identity into two independent sources, without legacy accounts',async()=>{
    expect(beforeLogin).toBe(0);expect(bootstrapStatus).toBe(200);expect(a.workspace).not.toBe(b.workspace);expect(pendingPublicationChecks).toBe(2);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities').first('n')).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE source_type='project_alpha' AND status='active'").first('n')).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE source_type='project_alpha' AND status='active'").first('n')).toBe(6);
    for(const table of ['client_accounts','client_identity_links','portal_v2_identity_eligibility_legacy_bridges'])expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
    const response=await request('/v2/workspaces');expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({workspaces:expect.arrayContaining([{id:a.workspace,rootType:'organization',rootPublicId:rootId,displayName:'Customer a',resourceMode:'native',sourceId:a.source},
      {id:b.workspace,rootType:'organization',rootPublicId:rootId,displayName:'Customer b',resourceMode:'native',sourceId:b.source}])});
    expect(await resolveEffectivePortalWorkspaceContext(env,principal,b.workspace)).toBeNull();
  });
  it('source-qualified context and hierarchy expose read capabilities only and keep colliding projects distinct',async()=>{
    for(const f of [a,b]){
      const response=await request(`${base(f)}/context`),json=await response.json();expect(json).toMatchObject({workspace:{id:f.workspace,sourceId:f.source,resourceMode:'native'},
        capabilities:{directoryRead:true,deliveryView:true,requestV2:false,feedback:true,viewer:false,viewBilling:false,manageTeam:false}});
      expect(JSON.stringify(json)).not.toMatch(/legacy_account|bindingId|r2_prefix|identityId|credential/);
      expect(await (await request(`${base(f)}/hierarchy`)).json()).toMatchObject({workspaceId:f.workspace,sourceId:f.source,
        entries:expect.arrayContaining([{type:'project',publicId:projectId,parentPublicId:rootId,parentType:'organization',displayName:`Project ${f.name}`,sourceVersion:'project-v1'}])});
    }
  });
  it('lists only immediate children, hides internal objects, and returns no raw storage key',async()=>{
    const result=await files(b);expect(result.files.map(f=>f.name)).toEqual(['report.txt']);expect(result.folders?.map(f=>f.name)).toEqual(['child']);
    expect(result.prefix).toBe('');expect(JSON.stringify(result)).not.toContain('native/b/');expect(result.files[0]!.thumbnailPath).toBeNull();
    const child=await (await request(`${base(b)}/folders/${result.folders![0]!.id}`)).json() as ClientFilePage;
    expect(child.files.map(f=>f.name)).toEqual(['deep.txt']);expect(child.breadcrumbs?.map(x=>x.name)).toEqual(['Project b','child']);
  });
  it('native feedback is unavailable unless the exact source is in the bounded deploy allowlist',async()=>{
    const onlyA={...env,CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:a.source};
    expect(await (await request(`${base(a)}/context`,{},onlyA)).json()).toMatchObject({capabilities:{feedback:true}});
    expect(await (await request(`${base(b)}/context`,{},onlyA)).json()).toMatchObject({capabilities:{feedback:false}});
    expect((await request(`${base(b)}/feedback`,{},onlyA)).status).toBe(404);
    const malformed={...env,CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:`${a.source},${a.source}`};
    expect(await (await request(`${base(a)}/context`,{},malformed)).json()).toMatchObject({capabilities:{feedback:false}});
  });
  it('keeps organization-folder and client-file feedback source-qualified and lets authorized staff resolve and transition it without a project',async()=>{
    const native=await resolveNativePortalWorkspaceReadContext(env,principal,a.workspace);expect(native).not.toBeNull();
    const clientId='c'.repeat(32),identityId=(await db.prepare('SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?')
      .bind(issuer,principal.subject).first<string>('id'))!,created:string[]=[];
    await db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      VALUES(?,?,'client',? ,?,'Native client','client-v1',1)`).bind(a.workspace,native!.generationId,clientId,rootId).run();
    async function grant(ownerType:'organization'|'client',ownerId:string,version:string,prefix:string){
      const binding=`feedback-${ownerType}-binding`,grantId=`feedback-${ownerType}-grant`,receipt=`feedback-${ownerType}-receipt`;
      await db.batch([
        db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
          VALUES(?,?,?,?,?,'project_alpha',?,'active')`).bind(binding,a.workspace,ownerType,ownerId,prefix,version),
        db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,project_alpha_source_id)
          VALUES(?,? ,?,'portal',?,?)`).bind(receipt,`delivery-${ownerType}`,'d'.repeat(64),grantId,a.source),
        db.prepare(`INSERT INTO project_alpha_delivery_portal_grants(id,receipt_id,workspace_id,folder_binding_id,binding_source_version,
          audience_type,audience_public_id,audience_source_version,actor_id) VALUES(?,?,?,?,?,'principal','same-person','person-v1','project-alpha-test')`)
          .bind(grantId,receipt,a.workspace,binding,version),
      ]);created.push(grantId);return {binding,grantId};
    }
    const org=await grant('organization',rootId,'root-v1','feedback/org/');
    const client=await grant('client',clientId,'client-v1','feedback/client/');
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES('feedback/client/photo.jpg','feedback-etag',42,'2026-08-31T12:00:00.000Z','image/jpeg','image')`).run();
    try{
      const deliveries=await (await request(`${base(a)}/deliveries`)).json() as {items:Array<{id:string;owner:{type:string;publicId:string}}>};
      const orgFolder=deliveries.items.find(item=>item.owner.type==='organization'&&item.owner.publicId===rootId)!;
      const clientFolder=deliveries.items.find(item=>item.owner.type==='client'&&item.owner.publicId===clientId)!;
      expect(orgFolder).toBeTruthy();expect(clientFolder).toBeTruthy();
      const createFeedback=async(target:unknown,message:string)=>{
        const response=await request(`${base(a)}/feedback`,{method:'POST',headers:{Origin:'https://client.test','Content-Type':'application/json',
          'Idempotency-Key':`feedback-${crypto.randomUUID()}`},body:JSON.stringify({target,message})});
        expect(response.status).toBe(201);return (await response.json() as {feedback:{id:string}}).feedback.id;
      };
      const projectFeedback=await createFeedback({kind:'project',projectId},'Please review the project.');
      const orgFeedback=await createFeedback({kind:'folder',projectId:null,folderId:orgFolder.id},'Please review the organization folder.');
      const filePage=await (await request(`${base(a)}/folders/${clientFolder.id}`)).json() as ClientFilePage;
      const clientFeedback=await createFeedback({kind:'file',projectId:null,fileId:filePage.files[0]!.id},'Please review the client file.');
      for(const [id,ownerType] of [[orgFeedback,'organization'],[clientFeedback,'client']] as const){
        const row=await db.prepare(`SELECT owner_scope_type ownerType,owner_public_id ownerId,project_public_id projectId
          FROM portal_native_feedback WHERE id=?`).bind(id).first();
        expect(row).toMatchObject({ownerType,projectId:null});
        const detail=await getStaffFeedback(opsEnv,staff,id);
        expect(detail.feedback.target).toMatchObject({projectId:null,available:true,
          actionPath:`/clients/sources/${encodeURIComponent(a.source)}/business/organizations/${rootId}`});
      }
      const transitioned=await transitionStaffFeedback(opsEnv,staff,orgFeedback,{expectedRevision:1,status:'done',note:'Reviewed.'},`staff-${crypto.randomUUID()}`);
      expect(transitioned.feedback).toMatchObject({status:'done',target:{projectId:null}});
      const inboxResponse=await request(`${base(a)}/feedback-notifications`);expect(inboxResponse.status).toBe(200);
      const inbox=await inboxResponse.json() as {notifications:Array<{id:string;feedbackId:string;readAt:string|null;actionPath:string}>};
      const notice=inbox.notifications.find(item=>item.feedbackId===orgFeedback);expect(notice).toMatchObject({readAt:null,
        actionPath:`/portal/feedback/${encodeURIComponent(orgFeedback)}?workspace=${encodeURIComponent(a.workspace)}`});
      expect((await request(`${base(b)}/feedback-notifications/${notice!.id}`,{method:'PATCH',headers:{Origin:'https://client.test','Content-Type':'application/json'},
        body:JSON.stringify({action:'read'})})).status).toBe(404);
      const marked=await request(`${base(a)}/feedback-notifications/${notice!.id}`,{method:'PATCH',headers:{Origin:'https://client.test','Content-Type':'application/json'},
        body:JSON.stringify({action:'read'})});expect(marked.status).toBe(200);
      expect((await db.prepare('SELECT read_at FROM portal_native_feedback_notifications WHERE id=?').bind(notice!.id).first<string>('read_at'))).toBeTruthy();
      await db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,
        revoked_at=datetime('now'),revoke_reason_code='project_alpha_delivery_revoked' WHERE id=?`).bind(org.grantId).run();
      const afterGrantRevoke=await (await request(`${base(a)}/feedback-notifications`)).json() as {notifications:Array<{id:string}>};
      expect(afterGrantRevoke.notifications.some(item=>item.id===notice!.id)).toBe(false);
      expect((await request(`${base(a)}/feedback-notifications/${notice!.id}`,{method:'PATCH',headers:{Origin:'https://client.test','Content-Type':'application/json'},
        body:JSON.stringify({action:'dismiss'})})).status).toBe(404);
      expect(await db.prepare('SELECT dismissed_at FROM portal_native_feedback_notifications WHERE id=?').bind(notice!.id).first<string>('dismissed_at')).toBeNull();

      // Submitted native feedback is durable staff history. Removing the live
      // file and exact grant must remove client navigation, not the staff item.
      await db.prepare("DELETE FROM file_index WHERE r2_key='feedback/client/photo.jpg'").run();
      await db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,
        revoked_at=datetime('now'),revoke_reason_code='project_alpha_delivery_revoked' WHERE id=?`).bind(client.grantId).run();
      expect((await getStaffFeedback(opsEnv,staff,clientFeedback)).feedback.target)
        .toMatchObject({available:false,actionPath:null,projectId:null});
      expect((await request(`${base(a)}/feedback/${clientFeedback}`)).status).toBe(404);
      expect((await transitionStaffFeedback(opsEnv,staff,clientFeedback,{expectedRevision:1,status:'in_progress',note:null},
        `staff-${crypto.randomUUID()}`)).feedback).toMatchObject({status:'in_progress',target:{available:false,actionPath:null}});

      // Suspending the author or deleting the source project likewise makes
      // navigation unavailable without erasing or reassigning the report.
      await db.prepare("UPDATE portal_v2_identities SET status='suspended',revoked_at=datetime('now') WHERE id=?").bind(identityId).run();
      expect((await getStaffFeedback(opsEnv,staff,projectFeedback)).feedback.target)
        .toMatchObject({available:false,actionPath:null,projectId});
      expect((await request(`${base(a)}/feedback/${projectFeedback}`)).status).not.toBe(200);
      await db.prepare("UPDATE portal_v2_identities SET status='active',revoked_at=NULL WHERE id=?").bind(identityId).run();
      await db.prepare(`UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id=?
        AND entity_type='project' AND public_id=?`).bind(a.workspace,projectId).run();
      expect((await getStaffFeedback(opsEnv,staff,projectFeedback)).feedback.target)
        .toMatchObject({available:false,actionPath:null,projectId});
      expect((await transitionStaffFeedback(opsEnv,staff,projectFeedback,{expectedRevision:1,status:'done',note:'Preserved after removal.'},
        `staff-${crypto.randomUUID()}`)).feedback).toMatchObject({status:'done',target:{available:false,actionPath:null}});
      await db.prepare(`UPDATE portal_v2_directory_entities SET active=1 WHERE workspace_id=?
        AND entity_type='project' AND public_id=?`).bind(a.workspace,projectId).run();
    }finally{
      await db.prepare("UPDATE portal_v2_identities SET status='active',revoked_at=NULL WHERE issuer=? AND subject=?").bind(issuer,principal.subject).run();
      await db.prepare(`UPDATE portal_v2_directory_entities SET active=1 WHERE workspace_id=?
        AND entity_type='project' AND public_id=?`).bind(a.workspace,projectId).run();
      for(const grantId of created)await db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,
        revoked_at=datetime('now'),revoke_reason_code='project_alpha_delivery_revoked' WHERE id=? AND status='active'`).bind(grantId).run();
      await db.prepare("DELETE FROM file_index WHERE r2_key='feedback/client/photo.jpg'").run();
    }
  },120_000);
  async function feedbackCreationRace(fault:'authority-rotation'|'principal-suspension'|'principal-version'|'principal-email',relations=false,
    fixture=a){
      const before={
        feedback:Number(await db.prepare('SELECT count(*) n FROM portal_native_feedback').first('n')),
        events:Number(await db.prepare('SELECT count(*) n FROM portal_native_feedback_events').first('n')),
        audits:Number(await db.prepare("SELECT count(*) n FROM audit_log WHERE action='client.feedback.created'").first('n')),
      };
      let ran=false;
      const target={...env,...(relations?{CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'}:{}),DELIVERY_DB:beforeEligibilityBatch(async()=>{
        ran=true;
        if(fault==='authority-rotation'){
          const rotated={...fixture.connector,revision:fixture.connector.revision+1};
          const staged=await provisionPortalSourceAuthority(env,rotated,{credentialRef:fixture.name,accessIssuer:issuer,
            accessAudience:'native-producer-aud',accessSubject:'explicit-source-producer'},fixture.version,'staff-test');
          fixture.connector=rotated;fixture.version=staged.version;await state(fixture,'active');
        }else if(fault==='principal-suspension'){
          await db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id=? AND public_id='same-person'").bind(fixture.workspace).run();
        }else if(fault==='principal-version'){
          await db.prepare("UPDATE pa_portal_principals SET source_version='person-raced' WHERE workspace_id=? AND public_id='same-person'").bind(fixture.workspace).run();
        }else{
          await db.prepare("UPDATE pa_portal_principals SET email_hint='raced@example.test' WHERE workspace_id=? AND public_id='same-person'").bind(fixture.workspace).run();
        }
      })};
      try{
        const response=await request(`${base(fixture)}/feedback`,{method:'POST',headers:{Origin:'https://client.test','Content-Type':'application/json',
          'Idempotency-Key':`feedback-race-${crypto.randomUUID()}`},body:JSON.stringify({target:{kind:'project',projectId},message:`Race ${fault}.`})},target);
        expect(ran).toBe(true);
        // A completed project is deliberately concealed after its final
        // source authority disappears; active targets report a stale write.
        expect(response.status).toBe(fault==='authority-rotation'&&relations?404:409);
        expect(Number(await db.prepare('SELECT count(*) n FROM portal_native_feedback').first('n'))).toBe(before.feedback);
        expect(Number(await db.prepare('SELECT count(*) n FROM portal_native_feedback_events').first('n'))).toBe(before.events);
        expect(Number(await db.prepare("SELECT count(*) n FROM audit_log WHERE action='client.feedback.created'").first('n'))).toBe(before.audits);
      }finally{
        if(fault==='principal-suspension')await db.prepare("UPDATE pa_portal_principals SET status='active' WHERE workspace_id=? AND public_id='same-person'").bind(fixture.workspace).run();
        else if(fault==='principal-version')await db.prepare("UPDATE pa_portal_principals SET source_version='person-v1' WHERE workspace_id=? AND public_id='same-person'").bind(fixture.workspace).run();
        else if(fault==='principal-email')await db.prepare("UPDATE pa_portal_principals SET email_hint=? WHERE workspace_id=? AND public_id='same-person'").bind(email,fixture.workspace).run();
      }
  }
  it.each(['principal-suspension','principal-version','principal-email'] as const)(
    'native feedback creation rolls back when %s races resolved authorization',fault=>feedbackCreationRace(fault),120_000);
  it('relation-mode scoped identity denial hides the exact project before hierarchy aggregation',async()=>{
    const native=await resolveNativePortalWorkspaceReadContext(env,principal,a.workspace);expect(native).not.toBeNull();
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES(?,?,'native-relation','contains','organization',?,'project',?,'relation-v1')`).bind(a.workspace,native!.generationId,rootId,projectId),
      db.prepare(`INSERT OR IGNORE INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active','project-v1')`).bind(a.workspace,native!.generationId,projectId),
    ]);
    const target={...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'} as Env;
    const before=await (await request(`${base(a)}/hierarchy`,{},target)).json() as {entries:Array<{publicId:string}>};
    expect(before.entries.some(e=>e.publicId===projectId)).toBe(true);
    await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('native-relation-denial',?,?,'project',?,'client_access_removed','staff','staff-test')`).bind(native!.identityId,a.workspace,projectId).run();
    try{
      const after=await (await request(`${base(a)}/hierarchy`,{},target)).json() as {entries:Array<{publicId:string}>};
      expect(after.entries.map(e=>e.publicId)).toContain(rootId);expect(after.entries.map(e=>e.publicId)).not.toContain(projectId);
      expect(await (await request(`${base(a)}/deliveries`,{},target)).json()).toMatchObject({items:[]});
    }finally{await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),revoked_by_actor_type='staff',
      revoked_by_actor_id='staff-test' WHERE id='native-relation-denial'`).run();}
  });
  it('continues beyond one hundred ungranted bindings without false empty completion or N+1 reads',async()=>{
    const ids=Array.from({length:102},(_,i)=>`a-page-${String(i).padStart(3,'0')}`);
    await db.batch(ids.map(id=>db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
      VALUES(?,?,'project',?,?,'operations','project-v1','active')`).bind(id,a.workspace,projectId,`native/ungranted/${id}/`)));
    try{
      let cursor:string|null=null,pages=0,found=0;
      do{
        const response=await request(`${base(a)}/deliveries${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);expect(response.status).toBe(200);
        const page=await response.json() as {items:unknown[];page:{nextCursor:string|null}};
        pages++;found+=page.items.length;cursor=page.page.nextCursor;
        if(pages<5){expect(page.items).toEqual([]);expect(cursor).not.toBeNull();}
        expect(pages).toBeLessThanOrEqual(5);
      }while(cursor);
      expect(pages).toBe(5);expect(found).toBe(1);
      let queries=0,proxy:D1Database;
      proxy=new Proxy(db,{get(target,key){if(key==='withSession')return ()=>proxy;
        if(key==='prepare')return (sql:string)=>{queries++;return target.prepare(sql);};
        const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;}});
      const context=await resolveNativePortalWorkspaceReadContext(env,principal,a.workspace);expect(context).not.toBeNull();
      const page=await readNativeAuthenticatedDeliveryPage({...env,DELIVERY_DB:proxy},principal,context!,'a-page-099');
      expect(page.grants).toHaveLength(1);expect(queries).toBeLessThanOrEqual(6);
    }finally{await db.prepare('DELETE FROM portal_v2_folder_bindings WHERE workspace_id=? AND id IN(SELECT value FROM json_each(?))').bind(a.workspace,JSON.stringify(ids)).run();}
  },120_000);
  it('legacy parent IDs cannot borrow ancestry from another entity type with the same public ID',async()=>{
    const native=await resolveNativePortalWorkspaceReadContext(env,principal,a.workspace);expect(native).not.toBeNull();
    await db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      VALUES(?,?,'client',?,NULL,'Ambiguous parent','ambiguous-v1',1)`).bind(a.workspace,native!.generationId,rootId).run();
    try{
      const response=await request(`${base(a)}/hierarchy`);expect(response.status).toBe(200);
      const page=await response.json() as {entries:Array<{publicId:string;type:string}>};
      expect(page.entries.some(e=>e.type==='project'&&e.publicId===projectId)).toBe(false);
      expect(await (await request(`${base(a)}/deliveries`)).json()).toMatchObject({items:[]});
    }finally{await db.prepare(`DELETE FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND entity_type='client' AND public_id=?`)
      .bind(a.workspace,native!.generationId,rootId).run();}
  });
  it('preserves requested opaque file identity and rejects cross-source handles before R2',async()=>{
    const file=(await files(a)).files[0]!;reads=[];
    const metadata=await request(`${base(a)}/files/${file.id}`);expect(metadata.status).toBe(200);expect(await metadata.json()).toMatchObject({file:{id:file.id},sourceId:a.source});
    expect((await request(`${base(b)}/files/${file.id}`)).status).toBe(404);
    expect((await request(`${base(b)}/files/${file.id}/download`)).status).toBe(404);expect(reads).toEqual([]);
  });
  it('streams exact-source media with Range and HEAD, without selected-workspace ambient authority',async()=>{
    const file=(await files(b)).files[0]!;reads=[];
    const response=await request(file.downloadPath,{method:'HEAD',headers:{Range:'bytes=0-2'}});expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-2/8');expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(reads).toEqual(['head:native/b/report.txt']);
    const download=await request(file.downloadPath,{headers:{Range:'bytes=0-2'}});expect(download.status).toBe(206);
    const reader=download.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('sou');await reader.cancel();
    expect((await request(file.downloadPath,{headers:{Range:'bytes=20-21'}})).status).toBe(416);
  });
  it('audits native preview and download requests once without storing source paths',async()=>{
    env.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED='true';
    env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET='native-content-audit-secret-that-is-long-enough';
    try{
      const file=(await files(b)).files[0]!;
      expect((await request(file.downloadPath,{method:'HEAD'})).status).toBe(200);
      expect((await request(file.downloadPath,{headers:{Range:'bytes=0-2'}})).status).toBe(206);
      expect((await request(file.downloadPath,{headers:{Range:'bytes=3-5'}})).status).toBe(206);
      expect((await request(file.previewPath!)).status).toBe(200);
      const events=(await db.prepare(`SELECT action,authority_mode,source_id,workspace_id,project_public_id,
        resource_label FROM portal_authenticated_content_events ORDER BY action`).all()).results;
      expect(events).toEqual([
        {action:'file.download_requested',authority_mode:'native_delivery',source_id:b.source,
          workspace_id:b.workspace,project_public_id:projectId,resource_label:'report.txt'},
        {action:'file.preview_requested',authority_mode:'native_delivery',source_id:b.source,
          workspace_id:b.workspace,project_public_id:projectId,resource_label:'report.txt'},
      ]);
      expect(JSON.stringify(events)).not.toContain('native/b/');
      expect(JSON.stringify(events)).not.toContain('etag-b');
    }finally{
      env.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED='false';delete env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET;
    }
  });
  it('source suspension hides only that source and never touches its bucket',async()=>{
    const file=(await files(b)).files[0]!;await state(b,'suspended');reads=[];
    try{expect((await request(`${base(b)}/context`)).status).toBe(404);expect((await request(file.downloadPath)).status).toBe(404);expect(reads).toEqual([]);
      const response=await (await request('/v2/workspaces')).json() as {workspaces:Array<{id:string}>};expect(response.workspaces.map(w=>w.id)).toEqual([a.workspace]);
      expect((await request(`${base(a)}/context`)).status).toBe(200);
    }finally{await state(b,'active');}
    expect((await request(file.downloadPath)).status).toBe(409);
  });
  it('authority changing during R2 HEAD prevents GET; changing during GET cancels the unread body',async()=>{
    const first=(await files(b)).files[0]!;headHook=()=>state(b,'suspended');reads=[];
    try{expect((await request(first.downloadPath)).status).toBe(409);expect(reads).toEqual(['head:native/b/report.txt']);}finally{headHook=null;await state(b,'active');}
    const second=(await files(b)).files[0]!;getHook=()=>state(b,'suspended');bodyCancelled=false;
    try{expect((await request(second.downloadPath)).status).toBe(409);expect(bodyCancelled).toBe(true);}finally{getHook=null;await state(b,'active');}
  });
  it('stale expected contexts and tampered handles cannot fall back to another workspace',async()=>{
    const version=(await context(b)).contextVersion,folderId=await folder(b);
    expect((await request(`${base(b)}/deliveries?expectedContext=${'0'.repeat(64)}`)).status).toBe(409);
    expect((await request(`${base(a)}/folders/${folderId}`)).status).toBe(404);
    expect((await request(`${base(b)}/folders/${folderId.slice(0,-1)}!`)).status).toBe(404);
    await state(b,'suspended');await state(b,'active');
    expect((await request(`${base(b)}/hierarchy?expectedContext=${version}`)).status).toBe(409);
  });
  it('secondary selection cannot enter legacy requests, pricing, billing, invitations or Viewer adapters',async()=>{
    for(const path of ['/projects','/service-requests','/billing','/members']){
      const response=await request(path,{headers:{'X-LTDS-Workspace-Id':b.workspace}});expect([403,404]).toContain(response.status);
    }
    expect(await resolveEffectivePortalWorkspaceContext(env,principal,b.workspace)).toBeNull();
  });
  it('scoped denial removes only its current workspace',async()=>{
    const identity=(await db.prepare('SELECT id FROM portal_v2_identities').first<string>('id'))!;
    await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('native-denial',?,?,'workspace',?,'client_access_removed','staff','staff-test')`).bind(identity,b.workspace,b.workspace).run();
    try{expect(await resolveNativePortalWorkspaceReadContext(env,principal,b.workspace)).toBeNull();expect(await resolveNativePortalWorkspaceReadContext(env,principal,a.workspace)).not.toBeNull();}
    finally{await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),revoked_by_actor_type='staff',
      revoked_by_actor_id='staff-test' WHERE id='native-denial'`).run();}
  });
  it('existing global eligibility blocks prevent discovery without adding another identity',async()=>{
    await db.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('native-block','issuer_subject',?,?,'client_access_removed','staff','staff-test')`).bind(issuer,principal.subject).run();
    try{expect((await request('/v2/workspaces')).status).toBe(403);expect((await request(`${base(a)}/context`)).status).toBe(403);}
    finally{await db.prepare("DELETE FROM portal_v2_identity_eligibility_blocks WHERE id='native-block'").run();}
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities').first('n')).toBe(1);
  });
  it('file pages remain bounded and their cursor cannot be borrowed by another folder',async()=>{
    await db.batch(Array.from({length:27},(_,i)=>db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,8,'2026-08-26T12:00:00Z','text/plain','text')`).bind(`native/a/paged-${String(i).padStart(2,'0')}.txt`,'"etag-a"')));
    try{
      const id=await folder(a),first=await (await request(`${base(a)}/folders/${id}`)).json() as ClientFilePage;
      expect(first.files.length+(first.folders?.length??0)).toBe(25);expect(first.cursor).toBeTruthy();
      const second=await (await request(`${base(a)}/folders/${id}?cursor=${first.cursor}`)).json() as ClientFilePage;
      expect(second.cursor).toBeNull();expect(new Set([...first.files,...second.files].map(f=>f.name)).size).toBe(28);
      const child=first.folders![0]!.id;
      expect((await request(`${base(a)}/folders/${child}?cursor=${first.cursor}`)).status).toBe(400);
      expect((await request(`${base(b)}/folders/${await folder(b)}?cursor=${first.cursor}`)).status).toBe(404);
    }finally{await db.prepare("DELETE FROM file_index WHERE r2_key LIKE 'native/a/paged-%'").run();}
  });
  it('a revoked exact grant cannot be replaced by another grant in an already-issued handle',async()=>{
    const file=(await files(b)).files[0]!;
    await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-test',revoke_reason_code='client_access_removed' WHERE id=?`).bind(b.grant).run();
    reads=[];expect((await request(file.downloadPath)).status).toBe(404);expect(reads).toEqual([]);
    expect((await request(`${base(a)}/context`)).status).toBe(200);
  });
  it('primary hierarchy route still falls through the mounted native router unchanged',async()=>{
    const h=new Hono<{Bindings:Env;Variables:{clientPrincipal:typeof principal}}>();
    h.use('*',async(c,next)=>{c.set('clientPrincipal',principal);await next();});
    h.route('/v2/workspaces',createNativePortalWorkspaceRouter() as unknown as Hono<{Bindings:Env;Variables:{clientPrincipal:typeof principal}}>);
    h.get('/v2/workspaces/:workspaceId/hierarchy',c=>c.json({existingPrimary:true}));
    await db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
      VALUES('existing-primary','organization','primary-root','Primary','project-alpha:primary')`).run();
    const response=await h.request('https://client.test/v2/workspaces/existing-primary/hierarchy',{},env);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({existingPrimary:true});
    expect((await h.request('https://client.test/v2/workspaces/nonexistent/hierarchy',{},env)).status).toBe(404);
  });
  it('expired native handles and current binding repoints cannot access newly pointed files',async()=>{
    const file=(await files(a)).files[0]!,handle=(await decodeNativePortalHandle(env,file.id))!;
    const expired=await encodeNativePortalHandle(env,{...handle,expires:Date.now()-1000});reads=[];
    expect((await request(`${base(a)}/files/${expired}/download`)).status).toBe(404);
    await expect(db.prepare('UPDATE portal_v2_folder_bindings SET r2_prefix=? WHERE id=?').bind('native/repointed/',a.binding).run()).rejects.toThrow('native-staff-binding-immutable');
    expect(reads).toEqual([]);
  });
  it('a current folder denial overrides explicit delivery allow before listing or R2',async()=>{
    const file=(await files(a)).files[0]!,identity=(await db.prepare('SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,principal.subject).first<string>('id'))!;
    await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('native-folder-denial',?,?,'folder',?,'client_access_removed','staff','staff-test')`).bind(identity,a.workspace,a.binding).run();reads=[];
    try{expect((await request(file.downloadPath)).status).toBe(409);
      expect(await (await request(`${base(a)}/deliveries`)).json()).toMatchObject({items:[]});expect(reads).toEqual([]);}
    finally{await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),revoked_by_actor_type='staff',
      revoked_by_actor_id='staff-test' WHERE id='native-folder-denial'`).run();}
  });
  it('ambiguous same-email signed principals never create an identity or membership',async()=>{
    const {f,person,token}=await eligibilityCase('ambiguous',true);
    expect((await request('/session',{},env,token)).status).toBe(403);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,person.subject).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
  });
  it('the existing eligibility feature flag remains required for a secondary-only first login',async()=>{
    const {f,person,token}=await eligibilityCase('disabled');
    expect((await request('/session',{}, {...env,CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'false'},token)).status).toBe(403);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,person.subject).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
  });
  it.each(['suspension','principal-version','principal-email','ambiguity','global-block'] as const)('eligibility write fence rolls back %s races',async fault=>{
    const {f,person,token}=await eligibilityCase(`race-${fault}`);
    let ran=false;
    const target={...env,DELIVERY_DB:beforeEligibilityBatch(async()=>{
      ran=true;
      if(fault==='suspension')await state(b,'suspended');
      else if(fault==='principal-version')await db.prepare("UPDATE pa_portal_principals SET source_version='changed-before-bind' WHERE workspace_id=?").bind(f.workspace).run();
      else if(fault==='principal-email')await db.prepare("UPDATE pa_portal_principals SET email_hint='other@example.test' WHERE workspace_id=?").bind(f.workspace).run();
      else if(fault==='ambiguity')await db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
        VALUES(?,'racing-principal',?,'Second','person-v1','active')`).bind(f.workspace,person.email).run();
      else await db.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES('racing-eligibility-block','issuer_subject',?,?,'client_access_removed','staff','staff-test')`).bind(issuer,person.subject).run();
    })};
    try{expect((await request('/session',{},target,token)).status).toBe(403);expect(ran).toBe(true);
      expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,person.subject).first('n')).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
    }finally{if(fault==='suspension')await state(b,'active');}
  });
  it('a real customer grant retains signed completed history only while that exact grant and directory capability remain authorized',async()=>{
    const localProject=(await opsDb.prepare(`SELECT id FROM pa_projects WHERE projection_source_id=? AND json_extract(payload_json,'$.public_id')=?`)
      .bind(a.source,projectId).first<string>('id'))!;
    const input={folderRef:encodeRef('native/a'),sourceId:a.source,workspaceId:a.workspace,projectId:localProject,
      principalPublicId:'same-person',reasonCode:'client_delivery',expiresAt:null,
      accessTerms:{kind:'customer' as const,mode:'until_revoked' as const,expiresAt:null}};
    const preview=await previewNativeDeliveryGrant(opsEnv,staff,input);
    const created=await createNativeDeliveryGrant(opsEnv,staff,{...input,expectedContextVersion:preview.contextVersion},'native-customer-history');
    const completedAt=new Date(Date.now()-40*86400_000).toISOString();
    const snapshot={...page(a),schemaVersion:3,deliveryId:'customer-history-page',sourceGeneration:'customer-history-generation',sourceSequence:100,
      snapshotHash:'c'.repeat(64),recordCount:8,
      relations:[{publicId:'history-owner',relationType:'contains',from:{type:'organization',publicId:rootId},to:{type:'project',publicId:projectId},sourceVersion:'relation-v1',active:true}],
      projectLifecycles:[{projectPublicId:projectId,status:'completed',completedAt,sourceVersion:'lifecycle-completed'}]};
    const relationEnv={...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'};
    expect((await signed(a,snapshot,relationEnv)).status).toBe(200);
    expect((await signed(a,{schemaVersion:3,applicationKey:app,deliveryId:'customer-history-activate',occurredAt:snapshot.occurredAt,
      sourceGeneration:snapshot.sourceGeneration,sourceSequence:100,workspaceId:'same-workspace',kind:'snapshot.activate',snapshotHash:snapshot.snapshotHash,
      pageCount:1,recordCount:8},relationEnv)).status).toBe(200);
    const hierarchy=await request(`${base(a)}/hierarchy`,{},relationEnv);expect(hierarchy.status).toBe(200);
    expect(await hierarchy.json()).toMatchObject({entries:expect.arrayContaining([expect.objectContaining({type:'project',publicId:projectId})])});
    const deliveries=await request(`${base(a)}/deliveries`,{},relationEnv);expect(deliveries.status).toBe(200);
    const selected=await deliveries.json() as {items:Array<{id:string}>};expect(selected.items).toHaveLength(1);
    const contents=await request(`${base(a)}/folders/${selected.items[0]!.id}`,{},relationEnv);expect(contents.status).toBe(200);
    const file=(await contents.json() as ClientFilePage).files[0]!;
    const identity=(await db.prepare('SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,principal.subject).first<string>('id'))!;
    const denyId='customer-history-directory-deny';
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      VALUES(?,?,?,'directory.read','deny','project',?,'operations','active')`).bind(denyId,a.workspace,identity,projectId).run();
    try{const denied=await (await request(`${base(a)}/hierarchy`,{},relationEnv)).json() as {entries:Array<{publicId:string}>};
      expect(denied.entries.some(entry=>entry.publicId===projectId)).toBe(false);}
    finally{await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id=?`).bind(denyId).run();}
    await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-test',revoke_reason_code='client_access_removed' WHERE id=?`)
      .bind(created.grant.grantId).run();
    const after=await (await request(`${base(a)}/hierarchy`,{},relationEnv)).json() as {entries:Array<{publicId:string}>};
    expect(after.entries.some(entry=>entry.publicId===projectId)).toBe(false);
    expect(await (await request(`${base(a)}/deliveries`,{},relationEnv)).json()).toMatchObject({items:[]});
    reads=[];expect((await request(file.downloadPath,{},relationEnv)).status).toBe(404);expect(reads).toEqual([]);
    expect((await request(`${base(b)}/context`)).status).toBe(200);
  },120_000);
  it('a still-live collaborator until-revoked grant also keeps completed history discoverable without adding directory permission',async()=>{
    const localProject=(await opsDb.prepare(`SELECT id FROM pa_projects WHERE projection_source_id=? AND json_extract(payload_json,'$.public_id')=?`)
      .bind(a.source,projectId).first<string>('id'))!;
    const input={folderRef:encodeRef('native/a'),sourceId:a.source,workspaceId:a.workspace,projectId:localProject,
      principalPublicId:'same-person',reasonCode:'collaborator_delivery',expiresAt:null,
      accessTerms:{kind:'collaborator' as const,mode:'until_revoked' as const,expiresAt:null}};
    const producerEnv={...opsEnv,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'},relationEnv={...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'};
    const preview=await previewNativeDeliveryGrant(producerEnv,staff,input);
    const created=await createNativeDeliveryGrant(producerEnv,staff,{...input,expectedContextVersion:preview.contextVersion},'native-collaborator-history');
    const hierarchy=await request(`${base(a)}/hierarchy`,{},relationEnv);expect(hierarchy.status).toBe(200);
    expect(await hierarchy.json()).toMatchObject({entries:expect.arrayContaining([expect.objectContaining({type:'project',publicId:projectId})])});
    expect(await (await request(`${base(a)}/deliveries`,{},relationEnv)).json()).toMatchObject({items:[expect.objectContaining({owner:expect.objectContaining({publicId:projectId})})]});
    await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-test',revoke_reason_code='client_access_removed' WHERE id=?`)
      .bind(created.grant.grantId).run();
    expect((await (await request(`${base(a)}/hierarchy`,{},relationEnv)).json() as {entries:Array<{publicId:string}>}).entries.some(entry=>entry.publicId===projectId)).toBe(false);
  },120_000);
  // This source-level rotation deliberately leaves the shared source out of
  // sync with Operations. Keep it terminal: later tests must not accidentally
  // depend on authority that this race is specifically proving was revoked.
  it('native feedback creation rolls back when authority-rotation races resolved authorization',
    async()=>{
      // Use the still-active secondary source. The primary source is already
      // in completed-history state here, where feedback is intentionally
      // concealed before a write transaction can begin.
      await feedbackCreationRace('authority-rotation',false,b);
    },120_000);
});
