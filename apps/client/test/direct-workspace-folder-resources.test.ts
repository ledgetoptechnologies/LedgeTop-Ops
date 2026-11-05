import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {Hono} from 'hono';
import {readFileSync} from 'node:fs';
import {Buffer} from 'node:buffer';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {createDirectWorkspaceFolderResourceRouter,directWorkspaceFolderCoordinate} from '../src/worker/client-portal/direct-workspace-folder-resources';
import {readDirectFolderWorkspaceState,listDirectWorkspaceFolderGrants,applyDirectWorkspaceFolderGrant} from '../src/worker/operations-portal-direct-folder-grants';
import type {Env} from '../src/worker/types';
import type {ClientPortalSession,VerifiedClientPrincipal} from '../src/worker/client-portal/types';

const sha='a'.repeat(64),workspace='df-workspace',target='df-target',authority='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source='project-alpha:primary',rootPublic='pa-root',rootRecord='ops-org',recipient='ops-client';
const folderRef=Buffer.from('Jobs/Clients/Example Org').toString('base64url');
const issuer='https://access.example.test',subject='access|customer';
const principal:VerifiedClientPrincipal={issuer,subject,email:'customer@example.test'};
const secondPrincipal:VerifiedClientPrincipal={issuer,subject:'access|coworker',email:'coworker@example.test'};
const session:ClientPortalSession={accountId:'',identityId:'',workspaceId:workspace,principalIssuer:issuer,principalSubject:subject,
  displayName:'Customer',role:'member',canViewBilling:false};
type TestBindings={Bindings:Env;Variables:{clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal}};

describe('direct Operations workspace folder resources',()=>{
  let mf:Miniflare,db:D1Database,bucket:R2Bucket,env:Env,app:Hono<TestBindings>;
  let folderHandle='',fileHandle='',currentPrincipal=principal;
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:'2026-07-22',modules:true,script:'export default {}',
      d1Databases:{DELIVERY_DB:crypto.randomUUID()},r2Buckets:{DATA_BUCKET:crypto.randomUUID()}});
    db=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
    bucket=await mf.getR2Bucket('DATA_BUCKET') as unknown as R2Bucket;
    const snapshot={snapshotId:'df-snapshot',sourceSequence:1,snapshotSha256:sha,directoryRecords:[
      {recordId:rootRecord,kind:'organization',parentRecordId:null,version:'1',relationshipVersion:null,displayName:'Example Org',
        externalFences:[{sourceId:source,sourceInstanceId:'pa-instance',applicationId:'project-alpha',historyEpoch:'history-1',
          authorizationGeneration:'auth-1',publicId:rootPublic,revision:'1',projectionSha256:sha}]},
      {recordId:recipient,kind:'client',parentRecordId:rootRecord,version:'1',relationshipVersion:'1',displayName:'Example Client',
        externalFences:[{sourceId:source,sourceInstanceId:'pa-instance',applicationId:'project-alpha',historyEpoch:'history-1',
          authorizationGeneration:'auth-1',publicId:'pa-client',revision:'1',projectionSha256:sha}]},
    ]};
    await db.batch([
      db.prepare('CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT)'),
      db.prepare('CREATE TABLE portal_v2_workspace_memberships(id TEXT,workspace_id TEXT,identity_id TEXT,source_type TEXT,status TEXT,source_version TEXT,expires_at TEXT,revoked_at TEXT)'),
      db.prepare('CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,status TEXT,revoked_at TEXT)'),
      db.prepare('CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT)'),
      db.prepare('CREATE TABLE operations_portal_native_workspace_authority_heads(target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,root_kind TEXT,root_record_id TEXT,state TEXT)'),
      db.prepare('CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT,latest_operation_id TEXT)'),
      db.prepare('CREATE TABLE operations_portal_workspace_publication_receipts(operation_id TEXT,target_id TEXT,resulting_revision INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT)'),
      db.prepare('CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT,target_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_sha256 TEXT,snapshot_json TEXT)'),
      db.prepare('CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)'),
      db.prepare('CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER,source_generation TEXT)'),
      db.prepare('CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,parent_public_id TEXT,source_version TEXT,active INTEGER)'),
      db.prepare('CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)'),
      db.prepare('CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,status TEXT,complete INTEGER)'),
      db.prepare(`CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT,size INTEGER,uploaded_at TEXT,content_type TEXT,media_kind TEXT)`),
      db.prepare(`CREATE TABLE delivery_tombstones(physical_key TEXT,tombstone_kind TEXT,restored_at TEXT)`),
      db.prepare('INSERT INTO portal_v2_workspaces VALUES(?,?,?,?,?,?)').bind(workspace,'organization',rootPublic,null,source,'active'),
      db.prepare('INSERT INTO pa_portal_workspace_sources VALUES(?,?)').bind(workspace,source),
      db.prepare('INSERT INTO operations_portal_native_workspace_authority_heads VALUES(?,?,?,?,?,?,?)').bind(target,1,authority,workspace,'organization',rootRecord,'active'),
      db.prepare('INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,?,?)').bind('pub-op',target,1,'df-snapshot',sha),
      db.prepare('INSERT INTO operations_portal_workspace_publication_heads VALUES(?,?,?,?,?,?,?,?,?)').bind(target,1,authority,workspace,1,1,'df-snapshot',sha,'pub-op'),
      db.prepare('INSERT INTO operations_portal_workspace_publication_snapshots VALUES(?,?,?,?,?,?)').bind('df-snapshot',target,1,1,sha,JSON.stringify(snapshot)),
      db.prepare('INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,?)').bind(workspace,'df-directory-generation',1),
      db.prepare('INSERT INTO portal_v2_directory_generations VALUES(?,?,?,?,?)').bind('df-directory-generation',workspace,'active',1,'df-directory-source'),
      db.prepare('INSERT INTO portal_v2_directory_entities VALUES(?,?,?,?,?,?,1)').bind(workspace,'df-directory-generation','organization',rootPublic,null,'root-v1'),
      db.prepare('INSERT INTO portal_v2_directory_entities VALUES(?,?,?,?,?,?,1)').bind(workspace,'df-directory-generation','client','pa-client',rootPublic,'client-v1'),
      db.prepare('INSERT INTO pa_portal_projection_checkpoints VALUES(?,?,?,?)').bind(workspace,'df-directory-source',1,'df-projection-generation'),
      db.prepare('INSERT INTO pa_portal_projection_generations VALUES(?,?,?,?,?,?,1)').bind('df-projection-generation',workspace,'df-directory-source',1,source,'active'),
      db.prepare('INSERT INTO portal_v2_identities VALUES(?,?,?,\'active\',NULL)').bind('df-identity',issuer,subject),
      db.prepare('INSERT INTO portal_v2_identities VALUES(?,?,?,\'active\',NULL)').bind('df-identity-2',issuer,secondPrincipal.subject),
      db.prepare('INSERT INTO portal_v2_workspace_memberships VALUES(?,?,?,\'operations\',\'active\',\'member-v1\',NULL,NULL)').bind('df-member',workspace,'df-identity'),
      db.prepare('INSERT INTO portal_v2_workspace_memberships VALUES(?,?,?,\'operations\',\'active\',\'member-v1\',NULL,NULL)').bind('df-member-2',workspace,'df-identity-2'),
      db.prepare('CREATE TABLE portal_v2_public_links(id TEXT PRIMARY KEY,token TEXT)'),
      db.prepare('INSERT INTO portal_v2_public_links VALUES(\'old-link\',\'untouched\')'),
    ]);
    const migration=readFileSync(new URL('../migrations/0244_direct_workspace_folder_grants.sql',import.meta.url),'utf8');
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
    // The direct-folder feature defaults on; operators may explicitly disable it.
    env={DELIVERY_DB:db,DATA_BUCKET:bucket,DELIVERY_SESSION_SECRET:'direct-folder-test-session-secret-value-0001'} as Env;
    const state=await readDirectFolderWorkspaceState(env,{protocolVersion:1,workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source});
    if(!state.ok)throw new Error(`state setup failed: ${state.code}`);
    const command={protocolVersion:1,operationId:'df-create-op',action:'grant.create',workspaceId:workspace,targetId:target,
      clientAuthorityId:authority,sourceId:source,folderRef,
      recipientRecordId:recipient,expectedWorkspaceVersion:state.workspaceVersion,expectedMembershipVersion:state.membershipVersion,
      grantId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expiresAt:null};
    const created=await applyDirectWorkspaceFolderGrant(env,command);if(!created.ok)throw new Error(`grant setup failed: ${created.code}`);
    const map=await bucket.put('Jobs/Clients/Example Org/map.txt','map content',{httpMetadata:{contentType:'text/plain'}});
    const task=await bucket.put('Jobs/Clients/Example Org/sub/task.txt','task content',{httpMetadata:{contentType:'text/plain'}});
    const sibling=await bucket.put('Jobs/Clients/Example Org Extra/private.txt','sibling content',{httpMetadata:{contentType:'text/plain'}});
    await db.batch([
      db.prepare("INSERT INTO file_index VALUES('Jobs/Clients/Example Org/map.txt',?,11,'2026-11-02T12:00:00Z','text/plain','text')").bind(map.etag),
      db.prepare("INSERT INTO file_index VALUES('Jobs/Clients/Example Org/sub/task.txt',?,12,'2026-11-02T12:00:00Z','text/plain','text')").bind(task.etag),
      db.prepare("INSERT INTO file_index VALUES('Jobs/Clients/Example Org Extra/private.txt',?,15,'2026-11-02T12:00:00Z','text/plain','text')").bind(sibling.etag),
    ]);
    app=new Hono<TestBindings>();
    app.use('*',async(c,next)=>{c.set('clientSession',session);c.set('clientPrincipal',currentPrincipal);await next();});
    app.route('/api/client/direct-workspace-folders',createDirectWorkspaceFolderResourceRouter());
  });
  afterEach(async()=>mf.dispose());

  it('lists and opens only the exact project-free folder subtree with opaque handles',async()=>{
    const root=await app.request('https://client.test/api/client/direct-workspace-folders',{},env);
    expect(root.status).toBe(200);const result=await root.json() as {items:Array<{id:string;name:string}>};
    expect(result.items).toHaveLength(1);expect(result.items[0]!.name).toBe('Example Org');
    expect(JSON.stringify(result)).not.toContain('Jobs/Clients/Example Org/');
    expect(JSON.stringify(result)).not.toContain('df-binding');folderHandle=result.items[0]!.id;
    expect(folderHandle).toMatch(/^df1_[A-Za-z0-9_-]+$/u);
    expect(await directWorkspaceFolderCoordinate(env,folderHandle,'folder')).toEqual({workspaceId:workspace});
    expect(await directWorkspaceFolderCoordinate(env,folderHandle,'file')).toBeNull();
    const files=await app.request(`https://client.test/api/client/direct-workspace-folders/${encodeURIComponent(folderHandle)}/files`,{},env);
    expect(files.status,await files.clone().text()).toBe(200);
    const page=await files.json() as {files:Array<{id:string;name:string;previewPath:string;downloadPath:string}>;folders:Array<{id:string;name:string}>};
    expect(page.files.map(file=>file.name)).toEqual(['map.txt']);expect(page.folders.map(folder=>folder.name)).toEqual(['sub']);
    expect(JSON.stringify(page)).not.toContain('Jobs/Clients/Example Org/');fileHandle=page.files[0]!.id;
    expect(fileHandle).toMatch(/^df1_[A-Za-z0-9_-]+$/u);
    expect(await directWorkspaceFolderCoordinate(env,fileHandle,'file')).toEqual({workspaceId:workspace});
    expect(await directWorkspaceFolderCoordinate(env,`${fileHandle.slice(0,-1)}x`,'file')).toBeNull();
    const metadata=await app.request(`https://client.test/api/client/direct-workspace-folders/files/${encodeURIComponent(fileHandle)}`,{},env);
    expect(metadata.status).toBe(200);
    const preview=await app.request(`https://client.test${page.files[0]!.previewPath}`,{},env);
    expect(preview.status).toBe(200);expect(await preview.text()).toBe('map content');
  });

  it('rechecks membership and direct grant version on every resource request',async()=>{
    const root=await app.request('https://client.test/api/client/direct-workspace-folders',{},env);
    folderHandle=(await root.json() as {items:Array<{id:string}>}).items[0]!.id;
    const files=await app.request(`https://client.test/api/client/direct-workspace-folders/${encodeURIComponent(folderHandle)}/files`,{},env);
    fileHandle=(await files.json() as {files:Array<{id:string}>}).files[0]!.id;
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at='2026-11-02T12:00:00Z' WHERE id='df-member'").run();
    const denied=await app.request(`https://client.test/api/client/direct-workspace-folders/files/${encodeURIComponent(fileHandle)}`,{},env);
    expect(denied.status).toBe(404);
    expect(await db.prepare("SELECT token FROM portal_v2_public_links WHERE id='old-link'").first('token')).toBe('untouched');
  });

  it('grants the selected Client workspace to every active workspace member',async()=>{
    currentPrincipal=secondPrincipal;
    const root=await app.request('https://client.test/api/client/direct-workspace-folders',{},env);
    expect(root.status).toBe(200);
    const items=(await root.json() as {items:Array<{id:string}>}).items;
    expect(items).toHaveLength(1);
    const files=await app.request(`https://client.test/api/client/direct-workspace-folders/${encodeURIComponent(items[0]!.id)}/files`,{},env);
    expect(files.status).toBe(200);
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at='2026-11-02T12:00:00Z' WHERE id='df-member-2'").run();
    const denied=await app.request(`https://client.test/api/client/direct-workspace-folders/${encodeURIComponent(items[0]!.id)}/files`,{},env);
    expect(denied.status).toBe(404);
  });

  it('invalidates existing handles after the direct client-profile grant is revoked',async()=>{
    const root=await app.request('https://client.test/api/client/direct-workspace-folders',{},env);
    folderHandle=(await root.json() as {items:Array<{id:string}>}).items[0]!.id;
    const files=await app.request(`https://client.test/api/client/direct-workspace-folders/${encodeURIComponent(folderHandle)}/files`,{},env);
    fileHandle=(await files.json() as {files:Array<{id:string}>}).files[0]!.id;
    const state=await readDirectFolderWorkspaceState(env,{protocolVersion:1,workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source});
    expect(state.ok).toBe(true);if(!state.ok)throw new Error(state.code);
    const revoked=await applyDirectWorkspaceFolderGrant(env,{protocolVersion:1,operationId:'df-revoke-after-handle',action:'grant.revoke',
      workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source,folderRef,recipientRecordId:recipient,
      expectedWorkspaceVersion:state.workspaceVersion,expectedMembershipVersion:state.membershipVersion,
      grantId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedGrantVersion:1});
    expect(revoked).toMatchObject({ok:true,state:'revoked'});
    const denied=await app.request(`https://client.test/api/client/direct-workspace-folders/files/${encodeURIComponent(fileHandle)}`,{},env);
    expect(denied.status).toBe(404);
  });

  it('allows the owner to list and revoke a share after the last member is removed',async()=>{
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at='2026-11-02T12:00:00Z' WHERE workspace_id=?").bind(workspace).run();
    const state=await readDirectFolderWorkspaceState(env,{protocolVersion:1,workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source});
    expect(state.ok).toBe(true);if(!state.ok)throw new Error(state.code);
    expect(state.memberCount).toBe(0);
    const common={protocolVersion:1,workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source,
      folderRef,
      expectedWorkspaceVersion:state.workspaceVersion,expectedMembershipVersion:state.membershipVersion};
    const listing=await listDirectWorkspaceFolderGrants(env,common);
    if(!listing.ok)throw new Error(listing.code);
    expect(listing.memberCount).toBe(0);expect(listing.grants).toMatchObject([{grantId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',status:'active'}]);
    const revoked=await applyDirectWorkspaceFolderGrant(env,{...common,recipientRecordId:recipient,action:'grant.revoke',operationId:'df-revoke-after-removal',
      grantId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedGrantVersion:1});
    expect(revoked).toMatchObject({ok:true,state:'revoked',version:2});
  });

  it('marks a naturally expired active grant as cleanup eligible without reviving it',async()=>{
    // Expiration is time-derived; bypass the immutable-authority trigger only
    // to model the passage of time on the already-created grant.
    await db.prepare('DROP TRIGGER operations_portal_direct_folder_grant_authority_immutable').run();
    await db.prepare(`UPDATE operations_portal_direct_folder_grants SET expires_at='2000-01-01T00:00:00.000Z'
      WHERE grant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`).run();
    const state=await readDirectFolderWorkspaceState(env,{protocolVersion:1,workspaceId:workspace,targetId:target,
      clientAuthorityId:authority,sourceId:source});
    expect(state.ok).toBe(true);if(!state.ok)throw new Error(state.code);
    const grants=await listDirectWorkspaceFolderGrants(env,{protocolVersion:1,workspaceId:workspace,targetId:target,
      clientAuthorityId:authority,sourceId:source,folderRef,expectedWorkspaceVersion:state.workspaceVersion,
      expectedMembershipVersion:state.membershipVersion});
    expect(grants).toMatchObject({ok:true,grants:[{status:'expired',canRevoke:true}]});
    const common={protocolVersion:1,workspaceId:workspace,targetId:target,clientAuthorityId:authority,sourceId:source,
      folderRef,recipientRecordId:recipient,expectedWorkspaceVersion:state.workspaceVersion,
      expectedMembershipVersion:state.membershipVersion};
    const revoked=await applyDirectWorkspaceFolderGrant(env,{...common,action:'grant.revoke',operationId:'df-revoke-expired',
      grantId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedGrantVersion:1});
    expect(revoked).toMatchObject({ok:true,state:'revoked',version:2});
    const replacement=await applyDirectWorkspaceFolderGrant(env,{...common,action:'grant.create',operationId:'df-replace-expired',
      grantId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expiresAt:null});
    expect(replacement).toMatchObject({ok:true,state:'active',version:1});
    const after=await listDirectWorkspaceFolderGrants(env,{protocolVersion:1,workspaceId:workspace,targetId:target,
      clientAuthorityId:authority,sourceId:source,folderRef,expectedWorkspaceVersion:state.workspaceVersion,
      expectedMembershipVersion:state.membershipVersion});
    expect(after.ok&&after.grants.find(item=>item.grantId==='cccccccc-cccc-4ccc-8ccc-cccccccccccc'))
      .toMatchObject({status:'active',canRevoke:true});
  });

  it('allows an explicit operational opt-out',async()=>{
    env.CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED='false';
    const response=await app.request('https://client.test/api/client/direct-workspace-folders',{},env);
    expect(response.status).toBe(404);
    env.CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED=undefined;
  });
});
