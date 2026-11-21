import {readFileSync,readdirSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {Hono} from "hono";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";
import {createOperationsDirectFolderRouter} from "../../client/src/worker/client-portal/operations-direct-folder-routes";
import {applyDirectWorkspaceFolderGrant,listDirectWorkspaceFolderGrants,readDirectFolderWorkspaceState}
  from "../../client/src/worker/operations-portal-direct-folder-grants";
import {readNativeDirectFolderWorkspaceState} from "../../client/src/worker/operations-native-direct-folder-authority";
import type {Env as ClientEnv} from "../../client/src/worker/types";
import {encodeRef} from "../src/worker/delivery";
import {registerClientDeliveryRecipientRoutes} from "../src/worker/client-delivery-recipients";
import {registerClientDeliveryRecipientGrantRoutes} from "../src/worker/client-delivery-recipient-grants";
import {readDirectClientFolderAuthorization} from '../src/worker/client-direct-folder-read-authority';
import {revokeOperationsPortalNativeRecipient} from '../src/worker/operations-portal-native-recipient-authority';
import {materializeOperationsPortalNativeRecipientAuthority,dispatchOperationsPortalNativeRecipientAuthority}
  from '../src/worker/operations-portal-native-recipient-authority-dispatch';
import {applyOperationsPortalNativeRecipientAuthority,readOperationsPortalNativeRecipientAuthorityStatus}
  from '../../client/src/worker/operations-portal-native-recipient-authority';
import type {Env as OpsEnv,StaffPrincipal} from "../src/worker/types";
import {runCanonicalPortalResourceAcceptance} from "./helpers/operations-native-portal-resource-acceptance-fixture";

type OpsBindings={Bindings:OpsEnv;Variables:{principal:StaffPrincipal;administrator:boolean}};
const ownerId="acceptance-owner";
const portalSecret="direct-folder-joined-acceptance-secret-at-least-32-bytes";
const portalPrincipal={issuer:"https://acceptance.cloudflareaccess.com",subject:"access|acceptance-recipient",
  email:"recipient@example.test"};
const siblingClientRecord="e1000000-0000-4000-8000-000000000001";
const siblingSubject="access|acceptance-sibling-recipient";

// Keep SQL diagnostics inside this synthetic fixture: production adapters must
// continue returning safe availability errors without leaking query details.
function traceReadDatabase<T extends D1Database|D1DatabaseSession>(database:T,failures:string[]):T{
  const statement=(value:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(value,{get(target,key){
    if(key==='bind')return(...values:unknown[])=>statement(target.bind(...values),sql);
    const method=Reflect.get(target,key);
    if(typeof method!=='function')return method;
    return async(...args:unknown[])=>{try{return await method.apply(target,args);}catch(error){failures.push(`${sql}: ${String(error)}`);throw error;}};
  }});
  return new Proxy(database,{get(target,key){
    if(key==='withSession'&&'withSession' in target)return(bookmark?:string)=>traceReadDatabase(target.withSession(bookmark),failures);
    if(key==='prepare')return(sql:string)=>statement(target.prepare(sql),sql);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}

async function applyMigrationTail(database:D1Database,app:"operations"|"client",after:string){
  const directory=new URL(`../${app==="operations"?"migrations":"../client/migrations"}/`,import.meta.url);
  const names=readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&name>after).sort();
  for(const name of names){
    const statements=splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8"));
    await database.batch([...statements.map(sql=>database.prepare(sql)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  return names;
}

describe("joined direct Client folder sharing",()=>{
  it("previews, creates, lists, replays, revokes, and serves one exact direct folder",async()=>{
    await runCanonicalPortalResourceAcceptance(async context=>{
      const opsTail=await applyMigrationTail(context.operations,"operations","0221_portal_correspondence_lifecycle_write_guards.sql");
      const clientTail=await applyMigrationTail(context.client,"client","0234_pa_principal_reenrollment.sql");
      expect(opsTail.at(-1)).toBe("0243_staff_logs_device_eligibility.sql");
      expect(clientTail.at(-1)).toBe("0244_direct_workspace_folder_grants.sql");

      // The staff principal is injected only at this in-process Hono boundary;
      // it represents synthetic test staff, not a real Access assertion.
      const staff:StaffPrincipal={id:ownerId,email:"acceptance-owner@example.test",displayName:"Acceptance Owner",
        accessSubject:"access|acceptance-owner",projectAlphaUserId:null};
      // Canonical setup already grants this owner browse/create/revoke authority.
      expect(await context.operations.prepare(`SELECT count(*) count FROM staff_permission_overrides
        WHERE staff_id=? AND permission_key IN ('delivery.browse','delivery.share.create','delivery.share.revoke')
          AND effect='allow' AND scope='global' AND scope_key='global'`).bind(ownerId).first<number>('count')).toBe(3);

      const folderPath="Jobs/Clients/_joined-direct-folder";
      const folderRef=encodeRef(folderPath),prefix=`${folderPath}/`;
      const selectedKey=`${prefix}selected.pdf`,siblingKey=`${folderPath}_private/sibling.txt`;
      const selectedObject=await context.bucket.put(selectedKey,"joined selected body",{httpMetadata:{contentType:"application/pdf"}});
      const siblingObject=await context.bucket.put(siblingKey,"joined sibling secret",{httpMetadata:{contentType:"text/plain"}});
      await context.client.batch([
        context.client.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
          VALUES(?,?,?,'2026-11-15T12:00:00.000Z','application/pdf','pdf')`).bind(selectedKey,selectedObject!.etag,"joined selected body".length),
        context.client.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
          VALUES(?,?,?,'2026-11-15T12:00:00.000Z','text/plain','text')`).bind(siblingKey,siblingObject!.etag,"joined sibling secret".length),
      ]);
      expect(await context.operations.prepare(`SELECT count(*) count FROM project_folders
        WHERE substr(?,1,length(rtrim(r2_prefix,'/')||'/'))=rtrim(r2_prefix,'/')||'/'`)
        .bind(prefix).first<number>("count")).toBe(0);

      const clientEnv:ClientEnv={DELIVERY_DB:context.client,DATA_BUCKET:context.bucket,ENVIRONMENT:"staging",
        CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_ORIGIN:"https://client-staging.example.test",
        CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:"true",
        CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",
        CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true",CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED:"true",
        CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED:"true",DELIVERY_SESSION_SECRET:portalSecret} as ClientEnv;
      clientEnv.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED='true';
      expect(await context.client.prepare('SELECT count(*) count FROM portal_v2_workspaces').first<number>('count')).toBe(0);
      expect(await context.client.prepare('SELECT count(*) count FROM portal_v2_workspace_memberships').first<number>('count')).toBe(0);
      const siblingHome=await context.enrollNativeRecipient(siblingClientRecord,siblingSubject,"sibling@example.test");
      expect(siblingHome).toMatchObject({state:"active",recipientBindingId:expect.any(String)});
      expect(await readNativeDirectFolderWorkspaceState(clientEnv,{workspaceId:context.workspace.workspaceId,
        targetId:context.workspace.targetId,clientAuthorityId:context.workspace.clientAuthorityId,sourceId:'project-alpha:primary'}))
        .toMatchObject({authorityModel:'operations_native',memberCount:2,
          recipients:expect.arrayContaining([
            expect.objectContaining({recipientRecordId:context.clientRecord,subject:portalPrincipal.subject}),
            expect.objectContaining({recipientRecordId:siblingClientRecord,subject:siblingSubject}),
          ])});
      const scopedWorkspace=await readDirectFolderWorkspaceState(clientEnv,{protocolVersion:1,
        workspaceId:context.workspace.workspaceId,targetId:context.workspace.targetId,
        clientAuthorityId:context.workspace.clientAuthorityId,sourceId:'project-alpha:primary',
        recipientRecordId:context.clientRecord});
      expect(scopedWorkspace).toMatchObject({ok:true,memberCount:2,
        recipientMemberCount:1,portalReady:true});
      let loseCreateAck=true,loseRevokeReadback=false;
      const binding={
        readDirectFolderSharingCapability:async()=>JSON.stringify({protocolVersion:1,enabled:true}),
        readDirectFolderWorkspaceState:(value:unknown)=>readDirectFolderWorkspaceState(clientEnv,value),
        listDirectWorkspaceFolderGrants:(value:unknown)=>{
          if(loseRevokeReadback){loseRevokeReadback=false;throw new Error('injected postcommit revoke readback failure');}
          return listDirectWorkspaceFolderGrants(clientEnv,value);
        },
        applyDirectWorkspaceFolderGrant:async(value:unknown)=>{
          const result=await applyDirectWorkspaceFolderGrant(clientEnv,value);
          if(result.ok&&result.state==='active'&&!result.replayed&&loseCreateAck){loseCreateAck=false;throw new Error('injected lost create acknowledgment');}
          if(result.ok&&result.state==='revoked'&&!result.replayed)loseRevokeReadback=true;
          return result;
        },
      };
      const readFailures:string[]=[];
      const opsEnv={OPS_DB:traceReadDatabase(context.operations,readFailures),DELIVERY_DB:traceReadDatabase(context.client,readFailures),DATA_BUCKET:context.bucket,
        CLIENT_PORTAL_AUTHORITY_V2:binding,AUTHENTICATED_DELIVERY_CREATION_ENABLED:"true",
        ENVIRONMENT:'staging',EXPECTED_HOST:'ops.test',PUBLIC_BASE_URL:'https://ops.test',
        OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED:'true'} as OpsEnv;
      // In-process service adapter calls the actual Ops reader over both real
      // D1 databases. This does not claim a deployed Cloudflare RPC boundary.
      clientEnv.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER={
        readDirectFolderAuthorization:(value:unknown)=>readDirectClientFolderAuthorization(opsEnv,value),
      } as ClientEnv['OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER'];
      const staffApi=new Hono<OpsBindings>();
      staffApi.use("*",async(c,next)=>{c.set("principal",staff);c.set("administrator",false);await next();});
      registerClientDeliveryRecipientRoutes(staffApi);
      registerClientDeliveryRecipientGrantRoutes(staffApi);
      const apiRequest=(path:string,method="GET",body?:unknown,key?:string)=>staffApi.request(`https://ops.test${path}`,{
        method,headers:{...(body===undefined?{}:{"Content-Type":"application/json"}),...(key?{"Idempotency-Key":key}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      },opsEnv);

      const hiddenRecipients=await apiRequest(`/api/delivery/client-recipients?folderRef=${encodeURIComponent(folderRef)}`);
      expect(hiddenRecipients.status,(await hiddenRecipients.clone().text())+' '+readFailures.join('\n')).toBe(200);
      expect(await hiddenRecipients.json()).toEqual({mode:"recent",projectFolder:false,recipients:[]});
      await context.operations.batch([
        context.operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
          VALUES(?,?,'directory.profile.view','allow','global',?)`).bind('joined-profile-view',ownerId,'acceptance-owner'),
        context.operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by)
          VALUES(?,?,'directory.profile.view','deny','resource',?,?)`).bind('joined-profile-view-sibling-deny',ownerId,siblingClientRecord,'acceptance-owner'),
      ]);
      const recipientResponse=await apiRequest(`/api/delivery/client-recipients?folderRef=${encodeURIComponent(folderRef)}`);
      expect(recipientResponse.status,(await recipientResponse.clone().text())+' '+readFailures.join('\n')).toBe(200);
      const recipients=await recipientResponse.json() as {recipients:Array<{recipientId:string;recipientVersion:string;
        portal:{state:string};memberCount:number|null}>};
      const recipient=recipients.recipients.find(row=>row.recipientId===context.clientRecord);
      const siblingRecipient=recipients.recipients.find(row=>row.recipientId===siblingClientRecord);
      const organizationRecipient=recipients.recipients.find(row=>row.recipientId===context.organization);
      const publicationDiagnostic=recipient?.portal.state==='ready'?null:{
        authority:await context.operations.prepare('SELECT * FROM operations_portal_native_workspace_authority_heads').all(),
        publications:await context.operations.prepare('SELECT * FROM operations_portal_workspace_publication_heads').all(),
        outbox:await context.operations.prepare('SELECT operation_id,state,acknowledged_claim_token FROM operations_portal_workspace_publication_outbox').all(),
        checkpoints:await context.operations.prepare('SELECT * FROM operations_portal_workspace_publication_current_checkpoints').all(),
        workspace:await context.client.prepare('SELECT * FROM portal_v2_workspaces').all(),
      };
      expect(recipient,JSON.stringify(publicationDiagnostic)).toMatchObject({portal:{state:"ready"}});
      if(!recipient)throw new Error("canonical published client recipient missing");
      expect(recipient.memberCount).toBe(1);
      expect(siblingRecipient).toBeUndefined();
      expect(organizationRecipient).toMatchObject({portal:{state:"ready"},memberCount:2});
      const input={folderRef,recipientId:recipient.recipientId,recipientVersion:recipient.recipientVersion,
        audience:"all_members" as const,expiresAt:null};
      const previewResponse=await apiRequest("/api/delivery/client-recipients/grants/preview","POST",input);
      expect(previewResponse.status,await previewResponse.clone().text()).toBe(200);
      const preview=await previewResponse.json() as {previewVersion:string;recipientId:string;recipientCount:number};
      expect(preview).toMatchObject({recipientId:context.clientRecord,recipientCount:1});
      const key="joined-direct-create-operation-001";
      const createBody={...input,previewVersion:preview.previewVersion};
      const lostCreate=await apiRequest("/api/delivery/client-recipients/grants","POST",createBody,key);
      expect(lostCreate.status,await lostCreate.clone().text()).toBe(503);
      expect(await context.client.prepare('SELECT count(*) count FROM operations_portal_direct_folder_grant_mutations').first<number>('count')).toBe(1);
      const createdResponse=await apiRequest("/api/delivery/client-recipients/grants","POST",createBody,key);
      expect(createdResponse.status,await createdResponse.clone().text()).toBe(200);
      const created=await createdResponse.json() as {grant:{grantId:string;version:number;recipientId:string;status:string};replayed:boolean};
      expect(created).toMatchObject({grant:{version:1,recipientId:context.clientRecord,status:"active"},replayed:true});
      const replayResponse=await apiRequest("/api/delivery/client-recipients/grants","POST",createBody,key);
      expect(replayResponse.status,await replayResponse.clone().text()).toBe(200);
      expect(await replayResponse.json()).toMatchObject({grant:created.grant,replayed:true});
      expect(await context.client.prepare(`SELECT count(*) count FROM operations_portal_direct_folder_grants
        WHERE grant_id=?`).bind(created.grant.grantId).first<number>("count")).toBe(1);

      expect(await context.client.prepare("SELECT count(*) count FROM portal_v2_authenticated_delivery_grants").first<number>("count")).toBe(0);
      expect(await context.client.prepare("SELECT count(*) count FROM portal_native_staff_grants").first<number>("count")).toBe(0);

      let activePrincipal={...portalPrincipal};
      const portal=new Hono<{Bindings:ClientEnv}>();
      portal.route('/api/client/operations/direct-folders',
        createOperationsDirectFolderRouter({resolvePrincipal:async()=>activePrincipal}));
      const portalEnv={...clientEnv,CLIENT_PORTAL_ORIGIN:"https://client-staging.example.test"} as ClientEnv;
      const portalRequest=(path:string,headers:Record<string,string>={},method="GET")=>portal.request(`https://client-staging.example.test${path.startsWith('/api/client/')?path:'/api/client/operations/direct-folders'+path}`,{
        method,headers:{"X-LTDS-Workspace-ID":context.workspace.workspaceId,...headers},
      },portalEnv);
      const discovered=await portalRequest("");
      expect(discovered.status,(await discovered.clone().text())+' '+readFailures.join('\n')).toBe(200);
      const folders=await discovered.json() as {items:Array<{id:string;name:string}>};
      expect(folders.items).toHaveLength(1);expect(folders.items[0]!.name).toBe("_joined-direct-folder");
      const folderHandle=folders.items[0]!.id;
      activePrincipal={...portalPrincipal,subject:siblingSubject,email:"sibling@example.test"};
      const siblingDiscovery=await portalRequest("");
      expect(siblingDiscovery.status,await siblingDiscovery.clone().text()).toBe(200);
      expect(await siblingDiscovery.json()).toEqual({resourceMode:"direct_workspace_folders",items:[]});
      const siblingOpen=await portalRequest(`/${encodeURIComponent(folderHandle)}/files`);
      expect(siblingOpen.status).toBe(404);
      const organizationInput={folderRef,recipientId:context.organization,recipientVersion:organizationRecipient!.recipientVersion,
        audience:"all_members" as const,expiresAt:null};
      const organizationPreviewResponse=await apiRequest("/api/delivery/client-recipients/grants/preview","POST",organizationInput);
      expect(organizationPreviewResponse.status,await organizationPreviewResponse.clone().text()).toBe(200);
      const organizationPreview=await organizationPreviewResponse.json() as {previewVersion:string;recipientId:string;recipientCount:number};
      expect(organizationPreview).toMatchObject({recipientId:context.organization,recipientCount:2});
      const organizationCreate=await apiRequest("/api/delivery/client-recipients/grants","POST",{
        ...organizationInput,previewVersion:organizationPreview.previewVersion},"joined-direct-org-create-operation-002");
      expect(organizationCreate.status,await organizationCreate.clone().text()).toBe(200);
      const organizationGrant=await organizationCreate.json() as {grant:{grantId:string;status:string;recipientId:string}};
      expect(organizationGrant.grant).toMatchObject({status:"active",recipientId:context.organization});

      const listedResponse=await apiRequest(`/api/delivery/client-recipients/grants?folderRef=${encodeURIComponent(folderRef)}`);
      expect(listedResponse.status,await listedResponse.clone().text()).toBe(200);
      expect(await listedResponse.json()).toMatchObject({grants:expect.arrayContaining([
        expect.objectContaining({grantId:created.grant.grantId,status:"active",recipientId:context.clientRecord}),
        expect.objectContaining({grantId:organizationGrant.grant.grantId,status:"active",recipientId:context.organization}),
      ])});
      const siblingOrgDiscovery=await portalRequest("");
      expect(siblingOrgDiscovery.status,await siblingOrgDiscovery.clone().text()).toBe(200);
      const {items:siblingOrgFolders}=await siblingOrgDiscovery.json() as {items:Array<{id:string;name:string}>};
      expect(siblingOrgFolders).toHaveLength(1);
      const siblingOrgOpen=await portalRequest(`/${encodeURIComponent(siblingOrgFolders[0]!.id)}/files`);
      expect(siblingOrgOpen.status,await siblingOrgOpen.clone().text()).toBe(200);
      expect((await siblingOrgOpen.json() as {files:Array<{name:string}>}).files.map(file=>file.name)).toEqual(["selected.pdf"]);
      activePrincipal={...portalPrincipal};
      expect((await (await portalRequest("")).json() as {items:Array<{id:string}>}).items).toHaveLength(1);
      const filePageResponse=await portalRequest(`/${encodeURIComponent(folderHandle)}/files`);
      expect(filePageResponse.status,await filePageResponse.clone().text()).toBe(200);
      const page=await filePageResponse.json() as {files:Array<{name:string;previewPath:string;downloadPath:string}>};
      expect(page.files.map(file=>file.name)).toEqual(["selected.pdf"]);
      expect(JSON.stringify(page)).not.toContain("sibling");
      const filePreviewResponse=await portalRequest(new URL(page.files[0]!.previewPath,"https://client-staging.example.test").pathname+
        new URL(page.files[0]!.previewPath,"https://client-staging.example.test").search);
      expect(filePreviewResponse.status,await filePreviewResponse.clone().text()).toBe(200);expect(await filePreviewResponse.text()).toBe("joined selected body");
      const downloadUrl=new URL(page.files[0]!.downloadPath,"https://client-staging.example.test");
      const download=await portalRequest(downloadUrl.pathname+downloadUrl.search);
      expect(download.status,await download.clone().text()).toBe(200);expect(await download.text()).toBe("joined selected body");
      expect(download.headers.get('Cache-Control')).toContain('no-store');
      const resourcePath=downloadUrl.pathname+downloadUrl.search;
      const etag=download.headers.get('ETag')!;
      const ranged=await portalRequest(resourcePath,{'Range':'bytes=0-5','If-Range':etag});
      expect(ranged.status).toBe(206);expect(await ranged.text()).toBe('joined');
      expect(ranged.headers.get('Content-Range')).toBe('bytes 0-5/20');
      const staleRange=await portalRequest(resourcePath,{'Range':'bytes=0-5','If-Range':'"old-etag"'});
      expect(staleRange.status).toBe(200);expect(await staleRange.text()).toBe('joined selected body');
      const invalidRange=await portalRequest(resourcePath,{'Range':'bytes=100-200'});
      expect(invalidRange.status).toBe(416);expect(await invalidRange.text()).toBe('');
      const head=await portalRequest(resourcePath,{},'HEAD');
      expect(head.status).toBe(200);expect(head.headers.get('Content-Length')).toBe('20');expect(await head.text()).toBe('');
      const forged=new URL(downloadUrl);
      const handle=forged.searchParams.get('file')!;
      forged.searchParams.set('file',handle.slice(0,-2)+(handle.at(-2)==='A'?'B':'A')+handle.slice(-1));
      expect((await portalRequest(forged.pathname+forged.search)).status).toBe(404);
      expect(await context.client.prepare('SELECT count(*) count FROM portal_v2_workspaces').first<number>('count')).toBe(0);
      expect(await context.client.prepare('SELECT count(*) count FROM portal_v2_workspace_memberships').first<number>('count')).toBe(0);

      activePrincipal={...portalPrincipal,subject:"access|not-a-member"};
      const denied=await portalRequest(downloadUrl.pathname+downloadUrl.search);
      expect([403,404]).toContain(denied.status);
      activePrincipal={...portalPrincipal};

      await context.operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES('joined-create-deny',?,'delivery.share.create','deny','global','global',?)`)
        .bind(ownerId,ownerId).run();
      const grantsAfterCreateDeny=await apiRequest(`/api/delivery/client-recipients/grants?folderRef=${encodeURIComponent(folderRef)}`);
      expect(grantsAfterCreateDeny.status,await grantsAfterCreateDeny.clone().text()).toBe(200);
      const previewAfterCreateDeny=await apiRequest("/api/delivery/client-recipients/grants/preview","POST",organizationInput);
      expect(previewAfterCreateDeny.status).toBe(404);

      const revokePath=`/api/delivery/client-recipients/grants/${encodeURIComponent(created.grant.grantId)}/revoke`;
      const revokedResponse=await apiRequest(revokePath,"POST",{expectedVersion:created.grant.version},"joined-direct-revoke-operation-001");
      expect(revokedResponse.status,await revokedResponse.clone().text()).toBe(503);
      const revokeReplay=await apiRequest(revokePath,"POST",{expectedVersion:created.grant.version},"joined-direct-revoke-operation-001");
      expect(revokeReplay.status,await revokeReplay.clone().text()).toBe(200);
      expect(await revokeReplay.json()).toMatchObject({grant:{grantId:created.grant.grantId,version:2,status:"revoked"},replayed:true});
      const differentRevoke=await apiRequest(revokePath,"POST",{expectedVersion:created.grant.version},"joined-direct-revoke-different-002");
      expect(differentRevoke.status).toBe(409);
      const unavailable=await portalRequest(downloadUrl.pathname+downloadUrl.search);
      expect([403,404]).toContain(unavailable.status);
      // An organization grant cannot rescue a revoked service-home recipient.
      const currentRoot=await portalRequest('');
      expect(currentRoot.status,await currentRoot.clone().text()).toBe(200);
      const currentRootFolders=await currentRoot.json() as {items:Array<{id:string}>};
      expect(currentRootFolders.items).toHaveLength(1);
      const recipientRevokeOperation=context.id();
      await revokeOperationsPortalNativeRecipient(context.operations,{operationId:recipientRevokeOperation,
        intentId:context.recipient.intentId,expectedRevision:context.recipient.revision,owner:context.owner});
      await materializeOperationsPortalNativeRecipientAuthority(context.operations,recipientRevokeOperation);
      const beforeMirror=await portalRequest(`/${encodeURIComponent(currentRootFolders.items[0]!.id)}/files`);
      expect(beforeMirror.status).toBe(503);
      const recipientWriterEnv={DELIVERY_DB:context.client,ENVIRONMENT:'staging',EXPECTED_HOST:'client-staging.example.test',
        CLIENT_PORTAL_ORIGIN:'https://client-staging.example.test',CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED:'true',
        CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED:'true'} as const;
      await expect(dispatchOperationsPortalNativeRecipientAuthority({OPS_DB:context.operations,
        OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED:'true',OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY:{
          applyNativeAuthority:wire=>applyOperationsPortalNativeRecipientAuthority(recipientWriterEnv,wire),
          getNativeAuthorityStatus:wire=>readOperationsPortalNativeRecipientAuthorityStatus(recipientWriterEnv,wire),
        }},recipientRevokeOperation)).resolves.toMatchObject({status:'acknowledged'});
      const afterMirror=await portalRequest(`/${encodeURIComponent(currentRootFolders.items[0]!.id)}/files`);
      expect(afterMirror.status).toBe(404);
      activePrincipal={...portalPrincipal,subject:siblingSubject,email:"sibling@example.test"};
      const survivingOrgShare=await portalRequest("");
      expect(survivingOrgShare.status,await survivingOrgShare.clone().text()).toBe(200);
      const {items:survivingOrgFolders}=await survivingOrgShare.json() as {items:Array<{id:string}>};
      expect(survivingOrgFolders).toHaveLength(1);
      const survivingOrgOpen=await portalRequest(`/${encodeURIComponent(survivingOrgFolders[0]!.id)}/files`);
      expect(survivingOrgOpen.status,await survivingOrgOpen.clone().text()).toBe(200);
      await context.advanceProject();
      const staleCheckpoint=await portalRequest(`/${encodeURIComponent(survivingOrgFolders[0]!.id)}/files`);
      expect(staleCheckpoint.status).toBe(503);
    },{stopAfterReady:true,operationsThroughMigration:"0221_portal_correspondence_lifecycle_write_guards.sql",
      clientThroughMigration:"0234_pa_principal_reenrollment.sql",additionalClientRecordId:siblingClientRecord});
  },450_000);
});
