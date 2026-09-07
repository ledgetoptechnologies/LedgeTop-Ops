import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIMARY_CATALOG_SOURCE, createCatalogSourceContext } from '@ltds/shared';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { applyProjectAlphaDeliveryIntent, applyProjectAlphaDeliveryIntentRevoke } from '../src/worker/project-alpha-delivery-intents';
import { primaryDeliveryAuthorityProof } from '../src/worker/project-alpha-primary-delivery-authority';
import { adoptPortalDeliveryNotifications, authorizePortalDeliveryNotificationBatch, nativeDeliveryNotificationsReady,
  processPortalDeliveryNotificationBatches, stagePortalDeliveryNotificationStatements, type NativeBatch } from '../src/worker/portal-delivery-notification-batches';
import { authorizeNativeDeliveryNotification, controlNativeDeliveryNotification, nativeNotificationCandidates,
  readNativeDeliveryNotification, readNativeDeliveryNotificationScope } from '../src/worker/native-delivery-notification-center';
import { registerVisibleTestSource } from './helpers/project-alpha-connectors';
import * as mailer from '../src/worker/mailer';
import type { Env, StaffPrincipal } from '../src/worker/types';

const staff:StaffPrincipal={id:'native-staff',email:'native-staff@example.test',displayName:'Native staff',accessSubject:'native-staff-access',projectAlphaUserId:null};
const publicId=(name:string)=>createHash('sha256').update(name).digest('hex').slice(0,32);
const fingerprint=(payload:unknown)=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const primaryProof=primaryDeliveryAuthorityProof({mode:'legacy_primary',sourceId:PRIMARY_CATALOG_SOURCE.sourceId,
  revision:0,version:0,profile:'primary_legacy'});
function intercept(db:D1Database,predicate:(sql:string)=>boolean,action:()=>Promise<unknown>):D1Database{
  let fired=false;let proxy:D1Database;
  proxy=new Proxy(db,{get(target,key){
    if(key==='withSession')return()=>proxy;
    if(key==='prepare')return(sql:string)=>{
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(s,k){
        if(k==='bind')return(...values:unknown[])=>wrap(s.bind(...values));
        if(k==='run'||k==='first'||k==='all')return async(...args:unknown[])=>{
          if(!fired&&predicate(sql)){fired=true;await action();}
          return (s[k] as (...args:unknown[])=>unknown).apply(s,args);
        };return typeof s[k as keyof D1PreparedStatement]==='function'?(s[k as keyof D1PreparedStatement] as Function).bind(s):s[k as keyof D1PreparedStatement];
      }});
      return wrap(target.prepare(sql));
    };
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      // Bound statements remain proxies: inspect their captured SQL via the
      // prepare wrapper below; the batch itself is the interleaving boundary.
      if(!fired&&predicate('BATCH')){fired=true;await action();}return target.batch(statements);
    };
    const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;
  }});return proxy;
}

function tracked(db:D1Database,stats:{queries:number;maxBindings:number;executed:{sql:string;args:unknown[]}[]}):D1Database{
  const statements=new WeakMap<object,{sql:string;args:unknown[]}>();let proxy:D1Database;
  proxy=new Proxy(db,{get(target,key){
    if(key==='withSession')return()=>proxy;
    if(key==='prepare')return(sql:string)=>{
      const wrap=(s:D1PreparedStatement,args:unknown[]):D1PreparedStatement=>{
        const record={sql,args};const p=new Proxy(s,{get(t,k){
          if(k==='bind')return(...values:unknown[])=>{stats.maxBindings=Math.max(stats.maxBindings,values.length);return wrap(t.bind(...values),values);};
          if(k==='first'||k==='all'||k==='run')return(...values:unknown[])=>{stats.queries++;stats.executed.push(record);return(t[k] as Function).apply(t,values);};
          const value=t[k as keyof D1PreparedStatement];return typeof value==='function'?value.bind(t):value;
        }});statements.set(p,record);return p;
      };return wrap(target.prepare(sql),[]);
    };
    if(key==='batch')return(statementList:D1PreparedStatement[])=>{stats.queries+=statementList.length;
      for(const statement of statementList){const record=statements.get(statement);if(record)stats.executed.push(record);}return target.batch(statementList);};
    const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;
  }});return proxy;
}

describe('native delivery staging, exact authority and controls — migrated D1',{timeout:30_000},()=>{
  let mf:Miniflare,db:D1Database,ops:D1Database,empty:D1Database,env:Env;
  let preserved:Record<string,unknown[]>;
  const oldTables=['project_alpha_delivery_intent_receipts','project_alpha_delivery_portal_grants','project_alpha_delivery_portal_notification_outbox','project_alpha_delivery_intent_audit'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(oldTables.map(async table=>[table,(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results])));
  beforeAll(async()=>{
    mf=new Miniflare({compatibilityDate:'2026-07-22',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY:'native-notification',OPS:'native-notification-ops',EMPTY:'native-notification-empty'}});
    db=await mf.getD1Database('DELIVERY') as unknown as D1Database;ops=await mf.getD1Database('OPS') as unknown as D1Database;empty=await mf.getD1Database('EMPTY') as unknown as D1Database;
    for(const [database,path,maximum] of [[db,'../../client/migrations/',160],[ops,'../migrations/',38]] as const){
      const directory=new URL(path,import.meta.url);
      for(const name of readdirSync(directory).filter(n=>/^\d+.*\.sql$/.test(n)&&Number(n.slice(0,4))<=maximum).sort())
        await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>database.prepare(sql)));
    }
    // The upgrade fixtures create accepted portal intents before the later
    // native mail-batch migrations are exercised. Apply the required ledger
    // first so those accepted intents retain their recipient history.
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0202_native_delivery_recipient_events.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0203_primary_delivery_authority.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await ops.batch([
      ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
      ops.prepare("INSERT INTO divisions(id,name,code) VALUES('native-division','Native division','NATIVE')"),
      ...['audit','create','revoke'].map(p=>ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES(?,?,?,'allow','global','global',?)`).bind(`native-${p}`,staff.id,`delivery.share.${p}`,staff.id)),
    ]);
    env={DELIVERY_DB:db,OPS_DB:ops,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:'project-alpha',PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:'true',
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true',
      DELIVERY_BASE_URL:'https://client.example.test',OPERATIONS_SESSION_SECRET:'native-notification-test-secret-at-least-32'} as Env;
    for(const state of ['pending','attempted','processing','sent','failed','suppressed'] as const){
      const f=await fixture(`upgrade-${state}`);await create(f);
      if(state!=='pending')await db.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status=?,attempt_count=?,lease_expires_at=?,last_error=?
        WHERE principal_public_id=?`).bind(state==='attempted'?'pending':state,state==='sent'?1:2,state==='processing'?'2999-01-01 00:00:00':null,`original-${state}`,f.principal).run();
    }
    preserved=await snapshot();
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0161_portal_delivery_notification_batches.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0162_portal_source_authorities.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0182_portal_delivery_notification_source_ready.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0197_portal_root_access_policy.sql',import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED='true';
  },120_000);
  afterAll(async()=>{await mf?.dispose();});
  beforeEach(async()=>{
    vi.restoreAllMocks();vi.spyOn(mailer,'sendNotificationMail').mockResolvedValue(undefined);
    // Keep earlier fixtures out of later dispatch windows even if this real-D1
    // suite takes longer than the actual five-minute quiet period. Preserve
    // immutable items/history; each test explicitly makes its own batch due.
    await db.prepare("UPDATE portal_delivery_notification_batches SET eligible_at='2999-01-01 00:00:00' WHERE status='pending'").run();
  });

  async function fixture(name:string,source=PRIMARY_CATALOG_SOURCE,bindingType='project_alpha',ownerType:'project'|'organization'='project'){
    const workspace=`${name}-workspace`,projectPublic=publicId(`${name}-project`),organization=publicId(`${name}-org`),owner=ownerType==='organization'?organization:projectPublic,principal=`${name}-principal`,binding=`${name}-binding`,prefix=`Deliveries/${name}/`;
    if(source.sourceId!==PRIMARY_CATALOG_SOURCE.sourceId&&!await db.prepare('SELECT 1 ok FROM pa_portal_source_authorities WHERE source_id=?').bind(source.sourceId).first('ok')){
      const token=fingerprint(source.sourceId).slice(0,24),keyFingerprint=fingerprint(`notification-key:${source.sourceId}`);
      await db.batch([
        db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
          application_key,state,active_revision,version,connector_revision,connector_version)
          VALUES(?,?,?,'/','project-alpha','active',1,1,1,1)`).bind(source.sourceId,`notification-${token}`,`https://${token}.example.test`),
        db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,
          access_subject,current_key_id,current_key_fingerprint,created_by)
          VALUES(?,1,'notification','https://access.example.test','notification-audience','notification-producer','notification-key',?,'fixture')`)
          .bind(source.sourceId,keyFingerprint),
      ]);
    }
    await db.batch([
      db.prepare('INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)').bind(workspace,source.sourceId,workspace),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id) VALUES(?,'organization',?,?,?)").bind(workspace,organization,`Workspace ${name}`,source.sourceId),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)").bind(`${workspace}-generation`,workspace,`${workspace}-generation`),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,'Organization','v1')").bind(workspace,`${workspace}-generation`,organization),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,'Folder label','v1')").bind(workspace,`${workspace}-generation`,projectPublic,organization),
      db.prepare('INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)').bind(workspace,`${workspace}-generation`),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,?,?,?,?,'v1')").bind(binding,workspace,ownerType,owner,prefix,bindingType),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status) VALUES(?,?,?,'Explicit recipient','pv1','active')").bind(workspace,principal,`${name}@example.test`),
    ]);
    if(source!==PRIMARY_CATALOG_SOURCE){
      await registerVisibleTestSource(ops,source.sourceId,`Source ${name}`);
      await ops.batch([
        ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'project',?,?)")
          .bind(source.sourceId,`${name}-project`,`${name}-project`),
        ...(ownerType==='organization'?[ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)")
          .bind(source.sourceId,`${name}-org`,`${name}-org`)]:[]),
      ]);
    }
    await ops.batch([
      ...(ownerType==='organization'?[ops.prepare("INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,'Organization',?,'native-fixture',?)").bind(`${name}-org`,JSON.stringify({public_id:organization}),source.sourceId)]:[]),
      ops.prepare("INSERT INTO pa_projects(id,name,payload_json,last_sync_id,organization_id,projection_source_id) VALUES(?,?,?,'native-fixture',?,?)")
        .bind(`${name}-project`,`Project ${name}`,JSON.stringify({public_id:projectPublic}),ownerType==='organization'?`${name}-org`:null,source.sourceId),
      ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'native-division',?,'manual',?)").bind(`${name}-project`,prefix,staff.id),
    ]);
    return {name,workspace,owner,ownerType,principal,binding,prefix,source};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function proof(f:Fixture){
    if(f.source.sourceId===PRIMARY_CATALOG_SOURCE.sourceId)return primaryProof;
    const row=await db.prepare(`SELECT active_revision revision,version,connector_revision connectorRevision,
      connector_version connectorVersion FROM pa_portal_source_authorities WHERE source_id=?`).bind(f.source.sourceId)
      .first<{revision:number;version:number;connectorRevision:number;connectorVersion:number}>();
    if(!row)throw new Error('missing fixture delivery authority');
    return{sourceId:f.source.sourceId,...row};
  }
  async function create(f:Fixture,suffix='first',environment=env){
    const payload={schemaVersion:1,applicationKey:'project-alpha',deliveryId:`${f.name}-${suffix}`,occurredAt:new Date().toISOString(),
      scope:{type:f.ownerType,publicId:f.owner},audience:{type:'principal',publicId:f.principal},accessMode:'portal',expiresAt:null,label:null,notify:true};
    return applyProjectAlphaDeliveryIntent(environment,payload,{deliveryId:payload.deliveryId,fingerprint:fingerprint(payload)},
      f.source,environment.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,await proof(f));
  }
  async function batch(f:Fixture){return (await db.prepare('SELECT * FROM portal_delivery_notification_batches WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(f.workspace).first<NativeBatch>())!;}
  async function due(f:Fixture){await db.prepare("UPDATE portal_delivery_notification_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=? AND status='pending'").bind(f.workspace).run();}
  async function revoke(f:Fixture,receiptId:string){const payload={schemaVersion:1,applicationKey:'project-alpha',deliveryId:`${f.name}-revoke`,occurredAt:new Date().toISOString(),receiptId,reasonCode:'project_alpha_delivery_revoked'};
    return applyProjectAlphaDeliveryIntentRevoke(env,payload,{deliveryId:payload.deliveryId,fingerprint:fingerprint(payload)},
      f.source,env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,await proof(f));}
  async function publicRow(f:Fixture){const row=await batch(f);return (await nativeNotificationCandidates(env,row.status==='pending'||row.status==='processing'?'pending':'history')).find(r=>r.id===`nb_${row.id}`)!;}

  it('preserves all populated old receipt/grant/audit/outbox bytes and foreign keys; absent schema is explicit',async()=>{
    expect(await snapshot()).toEqual(preserved);expect(await nativeDeliveryNotificationsReady(env)).toBe(true);
    expect(await nativeDeliveryNotificationsReady({...env,DELIVERY_DB:empty})).toBe(false);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('portal_delivery_notification_batches')").first('quick_check')).toBe('ok');
  });
  it('atomically stages explicit intents, groups exact versions, and does not reset grace on receipt replay',async()=>{
    const f=await fixture('stage');await create(f);const first=await batch(f);
    await db.prepare("UPDATE portal_delivery_notification_batches SET eligible_at='2999-01-01 00:00:00' WHERE id=?").bind(first.id).run();
    // Reuse the accepted wire fingerprint, not a newly generated occurredAt.
    const receipt=await db.prepare('SELECT * FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?').bind('stage-first').first<any>();
    const replay={schemaVersion:1,applicationKey:'project-alpha',deliveryId:'stage-first',occurredAt:new Date().toISOString(),scope:{type:'project',publicId:f.owner},audience:{type:'principal',publicId:f.principal},accessMode:'portal',expiresAt:null,label:null,notify:true};
    await applyProjectAlphaDeliveryIntent(env,replay,{deliveryId:'stage-first',fingerprint:receipt.request_fingerprint},
      PRIMARY_CATALOG_SOURCE,env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,primaryProof);
    expect((await batch(f)).eligible_at).toBe('2999-01-01 00:00:00');
    await create(f,'second');const current=await batch(f);expect(current.id).toBe(first.id);expect(current.eligible_at).not.toBe('2999-01-01 00:00:00');
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_items WHERE batch_id=?').bind(first.id).first('n')).toBe(2);
    expect(await db.prepare('SELECT min(grant_version) n FROM portal_delivery_notification_items WHERE batch_id=?').bind(first.id).first('n')).toBe(1);
    expect((await nativeNotificationCandidates(env,'pending')).some(r=>r.workspace_id===f.workspace&&r.deliveryMode==='awaiting_staging')).toBe(false);
  });
  it('records one immutable recipient event for an unclaimed principal before any mail attempt',async()=>{
    const f=await fixture('recipient-ledger');
    const first=await create(f);
    const event=await db.prepare(`SELECT source_id,workspace_id,receipt_id,grant_id,grant_version,folder_binding_id,
      binding_source_version,owner_scope_type,owner_public_id,r2_prefix,principal_public_id,principal_source_version,event_type
      FROM native_delivery_recipient_events WHERE receipt_id=?`).bind(first.receiptId).first<Record<string,unknown>>();
    expect(event).toEqual({source_id:f.source.sourceId,workspace_id:f.workspace,receipt_id:first.receiptId,grant_id:expect.any(String),
      grant_version:1,folder_binding_id:f.binding,binding_source_version:'v1',owner_scope_type:f.ownerType,owner_public_id:f.owner,
      r2_prefix:f.prefix,principal_public_id:f.principal,principal_source_version:'pv1',event_type:'grant_accepted'});
    expect(JSON.stringify(event)).not.toContain('@example.test');
    expect(await db.prepare("SELECT count(*) n FROM native_delivery_recipient_event_state").first('n')).toBe(0);
    expect(vi.mocked(mailer.sendNotificationMail)).not.toHaveBeenCalled();

    const receipt=await db.prepare('SELECT request_fingerprint FROM project_alpha_delivery_intent_receipts WHERE receipt_id=?')
      .bind(first.receiptId).first<{request_fingerprint:string}>();
    const replay={schemaVersion:1,applicationKey:'project-alpha',deliveryId:`${f.name}-first`,occurredAt:new Date().toISOString(),
      scope:{type:f.ownerType,publicId:f.owner},audience:{type:'principal',publicId:f.principal},accessMode:'portal',expiresAt:null,label:null,notify:true};
    await applyProjectAlphaDeliveryIntent(env,replay,{deliveryId:replay.deliveryId,fingerprint:receipt!.request_fingerprint},
      f.source,env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,await proof(f));
    expect(await db.prepare('SELECT count(*) n FROM native_delivery_recipient_events WHERE receipt_id=?').bind(first.receiptId).first('n')).toBe(1);
  });
  it('adopts only never-attempted granted rows and preserves attempted/inflight/revoked jobs',async()=>{
    await adoptPortalDeliveryNotifications(env);
    const after=await db.prepare("SELECT outbox.* FROM project_alpha_delivery_portal_notification_outbox outbox WHERE principal_public_id LIKE 'upgrade-%' ORDER BY id").all<any>();
    for(const row of after.results){const before=(preserved.project_alpha_delivery_portal_notification_outbox as any[]).find(v=>v.id===row.id)!;
      if(before.principal_public_id==='upgrade-pending-principal')expect(row).toMatchObject({status:'suppressed',attempt_count:0,last_error:'native-batch-staged'});
      else expect(row).toEqual(before);
    }
    const direct=await nativeNotificationCandidates(env,'pending');expect(direct.filter(r=>r.principal_public_id==='upgrade-attempted-principal'||r.principal_public_id==='upgrade-processing-principal').every(r=>r.deliveryMode==='direct_legacy')).toBe(true);
  });
  it('does not adopt a direct claim that wins at the adoption transaction boundary',async()=>{
    const f=await fixture('claim-race');await create(f,'old',{...env,DELIVERY_DB:db} as Env);
    // A separate pre-upgrade insert models a never-attempted old outbox row.
    const prior=await db.prepare('SELECT * FROM project_alpha_delivery_portal_notification_outbox WHERE principal_public_id=? LIMIT 1').bind(f.principal).first<any>();
    const receiptId=crypto.randomUUID(),outboxId=crypto.randomUUID();
    await db.batch([db.prepare("INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,project_alpha_source_id) VALUES(?,?,?,'portal',?,'project-alpha:primary')").bind(receiptId,`${f.name}-direct`,fingerprint('direct'),prior.grant_id),
      db.prepare("INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type) VALUES(?,?,?,?,?,'granted')").bind(outboxId,receiptId,prior.grant_id,f.principal,'pv1')]);
    await db.prepare("UPDATE project_alpha_delivery_portal_notification_outbox SET status='processing',attempt_count=1,lease_expires_at=datetime('now','+15 minutes') WHERE id=?").bind(outboxId).run();
    await db.batch(stagePortalDeliveryNotificationStatements(db,outboxId));
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_items WHERE outbox_id=?').bind(outboxId).first('n')).toBe(0);
  });
  it('sends after eligibility once, seals content, and never invents file counts',async()=>{
    const f=await fixture('dispatch');await create(f);await processPortalDeliveryNotificationBatches(env);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();await due(f);await processPortalDeliveryNotificationBatches(env);
    expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);expect(vi.mocked(mailer.sendNotificationMail).mock.calls[0]?.[1]).toMatchObject({to:'dispatch@example.test',subject:'Delivery available in your portal'});
    expect(vi.mocked(mailer.sendNotificationMail).mock.calls[0]?.[1].text).toContain(`workspace=${f.workspace}`);
    const row=await batch(f);expect(row).toMatchObject({status:'sent',attempt_count:1});expect(row.dispatch_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await processPortalDeliveryNotificationBatches(env);expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);
    const result=await readNativeDeliveryNotification(env,`nb_${row.id}`,staff);expect(result.item).toMatchObject({kind:'portal_delivery',workspaceName:'Workspace dispatch',canCancel:false,canSendNow:false});
    expect(result.item).not.toHaveProperty('addedCount');expect(JSON.stringify(result)).not.toContain('r2_prefix');
  });

  it('suppresses a queued notification when the client root is revoked before publication',async()=>{
    const f=await fixture('root-revoked');await create(f);await due(f);
    const root=await db.prepare(`SELECT project_alpha_source_id,root_type,
      COALESCE(pa_organization_public_id,pa_client_public_id) root_public_id
      FROM portal_v2_workspaces WHERE id=?`).bind(f.workspace)
      .first<{project_alpha_source_id:string;root_type:string;root_public_id:string}>();
    await db.prepare(`INSERT INTO portal_v2_root_access_policies
      (projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
      VALUES(?,?,?,'revoked','security_hold',?,?)`)
      .bind(root!.project_alpha_source_id,root!.root_type,root!.root_public_id,staff.id,staff.id).run();
    await processPortalDeliveryNotificationBatches(env);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect((await batch(f)).status).toBe('suppressed');
  });
  it('round-robins due batches by registered source so one noisy source cannot consume the ten-send window',async()=>{
    const noisySource=createCatalogSourceContext('project-alpha:fair-noisy');
    const waitingSource=createCatalogSourceContext('project-alpha:fair-waiting');
    for(let index=0;index<11;index++){
      const f=await fixture(`fair-noisy-${index}`,noisySource);await create(f);
    }
    // Make the single waiting-source batch strictly newer than all eleven
    // noisy-source batches. Per-source rank, rather than global age, must
    // still reserve it a place in this run's bounded ten-send window.
    await new Promise(resolve=>setTimeout(resolve,1_100));
    const waiting=await fixture('fair-waiting',waitingSource);await create(waiting);
    await db.prepare("UPDATE portal_delivery_notification_batches SET eligible_at=datetime('now','-1 second') WHERE source_id IN (?,?)")
      .bind(noisySource.sourceId,waitingSource.sourceId).run();

    const stats={queries:0,maxBindings:0,executed:[] as {sql:string;args:unknown[]}[]};
    const monitored={...env,DELIVERY_DB:tracked(db,stats)};
    expect(await processPortalDeliveryNotificationBatches(monitored)).toBe(10);
    expect(await batch(waiting)).toMatchObject({source_id:waitingSource.sourceId,status:'sent',attempt_count:1});
    expect(await db.prepare("SELECT count(*) n FROM portal_delivery_notification_batches WHERE source_id=? AND status='sent'")
      .bind(noisySource.sourceId).first('n')).toBe(9);
    expect(vi.mocked(mailer.sendNotificationMail).mock.calls.map(call=>call[1].to)).toContain('fair-waiting@example.test');
    const probe=stats.executed.find(entry=>entry.sql.includes('idx_portal_delivery_notification_source_pending'));
    expect(probe).toBeDefined();
    const plan=JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN ${probe!.sql}`).bind(...probe!.args).all()).results);
    expect(plan).toContain('idx_portal_delivery_notification_source_pending');
    expect(plan).toContain('idx_portal_delivery_notification_source_processing');
    expect(plan).toMatch(/eligible_at<\?/);
    expect(plan).toMatch(/lease_expires_at<\?/);
    expect(stats.queries).toBeLessThan(180);
  },90_000);
  it('advances the durable source cursor so eleven backlogged sources all receive capacity across consecutive runs',async()=>{
    const fixtures:Fixture[]=[];
    for(let index=0;index<11;index++)fixtures.push(await fixture(`capacity-${String(index).padStart(2,'0')}`,
      createCatalogSourceContext(`project-alpha:capacity-${String(index).padStart(2,'0')}`)));
    const inserts:D1PreparedStatement[]=[];
    for(const [sourceIndex,f] of fixtures.entries())for(let item=0;item<2;item++){
      inserts.push(db.prepare(`INSERT INTO portal_delivery_notification_batches
        (id,source_id,workspace_id,folder_binding_id,binding_source_version,principal_public_id,principal_source_version,
          owner_scope_type,owner_public_id,r2_prefix,status,eligible_at,sealed_at,created_at)
        VALUES(?,?,?,?,? ,?,?, ?,?,?,'pending',datetime('now','-1 second'),datetime('now'),?)`)
        .bind(`capacity-${sourceIndex}-${item}`,f.source.sourceId,f.workspace,f.binding,'v1',f.principal,'pv1',f.ownerType,f.owner,f.prefix,
          `2020-01-${String(sourceIndex+1).padStart(2,'0')} 00:00:0${item}`));
    }
    await db.batch(inserts);

    expect(await processPortalDeliveryNotificationBatches(env)).toBe(10);
    expect(await processPortalDeliveryNotificationBatches(env)).toBe(10);
    const sourceIds=fixtures.map(f=>f.source.sourceId),placeholders=sourceIds.map(()=>'?').join(',');
    expect(await db.prepare(`SELECT count(DISTINCT source_id) n FROM portal_delivery_notification_batches
      WHERE source_id IN (${placeholders}) AND status='suppressed'`).bind(...sourceIds).first('n')).toBe(11);
    expect(await db.prepare("SELECT staged_last_source_id FROM portal_delivery_notification_scheduler WHERE id='source-round-robin'")
      .first('staged_last_source_id')).toMatch(/^project-alpha:capacity-/);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
  },120_000);
  it.each(['operations','legacy'])('preserves previously supported %s binding notification authority',async type=>{
    const f=await fixture(`binding-${type}`,PRIMARY_CATALOG_SOURCE,type);await create(f);expect(await authorizePortalDeliveryNotificationBatch(env,await batch(f))).not.toBeNull();
  });
  it('keeps source and principal/workspace collisions separate while scheduling secondary portal mail',async()=>{
    const f=await fixture('secondary',createCatalogSourceContext('project-alpha:secondary'));await create(f);
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_batches WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(1);
    expect((await nativeNotificationCandidates(env,'pending')).some(r=>r.workspace_id===f.workspace)).toBe(true);
    await due(f);await processPortalDeliveryNotificationBatches(env);
    expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mailer.sendNotificationMail).mock.calls[0]?.[1]).toMatchObject({to:'secondary@example.test'});
    expect(await batch(f)).toMatchObject({source_id:'project-alpha:secondary',status:'sent',attempt_count:1});
  });
  it('suppresses a secondary notification when its registered source is suspended before send',async()=>{
    const source=createCatalogSourceContext('project-alpha:notify-suspended'),f=await fixture('source-suspended',source);await create(f);await due(f);
    await db.prepare("UPDATE pa_portal_source_authorities SET state='suspended',version=version+1,updated_at=datetime('now') WHERE source_id=?")
      .bind(source.sourceId).run();
    await processPortalDeliveryNotificationBatches(env);
    const suppressed=await batch(f);
    expect(suppressed).toMatchObject({source_id:source.sourceId,status:'suppressed',last_error:'publication-context-changed'});
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    const history=(await nativeNotificationCandidates(env,'history')).find(row=>row.id===`nb_${suppressed.id}`);
    expect(history).toBeDefined();
    expect((await readNativeDeliveryNotification(env,history!.id,staff)).item)
      .toMatchObject({status:'suppressed',sourceName:'Source source-suspended'});
  });
  it('suppresses before send when a grant is revoked; revocation remains a direct outbox job',async()=>{
    const f=await fixture('revoked');const accepted=await create(f);await revoke(f,accepted.receiptId);await due(f);await processPortalDeliveryNotificationBatches(env);
    expect((await batch(f)).status).toBe('suppressed');expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect((await nativeNotificationCandidates(env,'pending')).find(r=>r.workspace_id===f.workspace&&r.eventType==='revoked')).toMatchObject({deliveryMode:'direct_legacy'});
  });
  it('keeps the same provider identity on uncertain retry but refuses changed email/content',async()=>{
    const f=await fixture('uncertain');await create(f);await due(f);vi.mocked(mailer.sendNotificationMail).mockRejectedValueOnce(new Error('secret SMTP error'));
    await processPortalDeliveryNotificationBatches(env);const first=await batch(f);expect(first.status).toBe('pending');
    const sent=vi.mocked(mailer.sendNotificationMail).mock.calls[0]![1];await due(f);await processPortalDeliveryNotificationBatches(env);
    expect(vi.mocked(mailer.sendNotificationMail).mock.calls[1]![1]).toEqual(sent);expect((await batch(f)).attempt_count).toBe(2);
    const changed=await fixture('email-change');await create(changed);await due(changed);vi.mocked(mailer.sendNotificationMail).mockRejectedValueOnce(new Error('uncertain'));
    await processPortalDeliveryNotificationBatches(env);const calls=vi.mocked(mailer.sendNotificationMail).mock.calls.length;
    await db.prepare("UPDATE pa_portal_principals SET email_hint='another@example.test' WHERE workspace_id=?").bind(changed.workspace).run();await due(changed);await processPortalDeliveryNotificationBatches(env);
    expect((await batch(changed)).status).toBe('suppressed');expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(calls);
  });
  it('rejects same-email identity rebinding after first publication',async()=>{
    const f=await fixture('identity-rebind');
    const identity=async(id:string)=>db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,'https://issuer.test',?,?)").bind(id,id,`${f.name}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES(?,?,?,'project_alpha')").bind(`${id}-member`,f.workspace,id),
      db.prepare('UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?').bind(id,f.workspace,f.principal)]);
    await identity('identity-first');await create(f);await due(f);vi.mocked(mailer.sendNotificationMail).mockRejectedValueOnce(new Error('uncertain'));
    await processPortalDeliveryNotificationBatches(env);await identity('identity-second');await due(f);await processPortalDeliveryNotificationBatches(env);
    expect((await batch(f)).status).toBe('suppressed');expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);
  });
  it('checks publication authority inside the final D1 write, not only previous JS reads',async()=>{
    const f=await fixture('publish-race');await create(f);await due(f);
    const raced=intercept(db,sql=>sql.includes('SET dispatch_fingerprint='),()=>db.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(f.binding).run());
    await processPortalDeliveryNotificationBatches({...env,DELIVERY_DB:raced});expect((await batch(f)).status).toBe('suppressed');expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
  });
  it('rechecks registered source authority inside the final publication write',async()=>{
    const source=createCatalogSourceContext('project-alpha:notify-publish-race'),f=await fixture('source-publish-race',source);await create(f);await due(f);
    const raced=intercept(db,sql=>sql.includes('SET dispatch_fingerprint='),()=>db.prepare(
      "UPDATE pa_portal_source_authorities SET state='suspended',version=version+1,updated_at=datetime('now') WHERE source_id=?")
      .bind(source.sourceId).run());
    await processPortalDeliveryNotificationBatches({...env,DELIVERY_DB:raced});
    expect(await batch(f)).toMatchObject({source_id:source.sourceId,status:'suppressed',last_error:'publication-context-changed'});
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
  });
  it('requires exact primary public-ID owner mapping and current division permissions for staff',async()=>{
    const f=await fixture('staff-scope');await create(f);const row=await publicRow(f);expect(await readNativeDeliveryNotificationScope(env,row)).not.toBeNull();
    await ops.prepare("UPDATE pa_projects SET payload_json='{}' WHERE id=?").bind(`${f.name}-project`).run();
    expect(await readNativeDeliveryNotificationScope(env,row)).toBeNull();await expect(readNativeDeliveryNotification(env,row.id,staff)).rejects.toMatchObject({status:404});
  });
  it('does not fall back to an ancestor division when the actual longest folder owner is inactive',async()=>{
    const f=await fixture('longest-owner',PRIMARY_CATALOG_SOURCE,'project_alpha','organization');await create(f);const row=await publicRow(f);
    await ops.batch([
      ops.prepare("INSERT INTO pa_projects(id,name,organization_id,payload_json,last_sync_id) VALUES('ancestor-native-project','Ancestor',?,?,'fixture')").bind(`${f.name}-org`,JSON.stringify({public_id:publicId('ancestor-native-project')})),
      ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES('ancestor-native-project','native-division','Deliveries/','manual',?)").bind(staff.id),
      ops.prepare('UPDATE pa_projects SET active=0 WHERE id=?').bind(`${f.name}-project`),
    ]);
    try{expect(await readNativeDeliveryNotificationScope(env,row)).toBeNull();}
    finally{await ops.prepare("DELETE FROM project_folders WHERE project_id='ancestor-native-project'").run();}
  });
  it('atomically controls pending batches, replays same actor key and creates a successor after sealing',async()=>{
    const f=await fixture('control');await create(f);const row=await publicRow(f),key='native-control-request-0001';
    expect(await authorizeNativeDeliveryNotification(env,row)).not.toBeNull();
    const result=await controlNativeDeliveryNotification(env,staff,row.id,'send-now',row.revision,key);expect(result.replayed).toBe(false);
    expect(await controlNativeDeliveryNotification(env,staff,row.id,'send-now',row.revision,key)).toMatchObject({...result,replayed:true});
    await expect(controlNativeDeliveryNotification(env,staff,row.id,'cancel',row.revision,key)).rejects.toMatchObject({status:409});
    await create(f,'successor');expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_batches WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(2);
    await db.prepare("UPDATE portal_delivery_notification_batches SET eligible_at='2999-01-01 00:00:00' WHERE workspace_id=?").bind(f.workspace).run();
    const next=await publicRow(f);await controlNativeDeliveryNotification(env,staff,next.id,'cancel',next.revision,'native-control-request-0002');
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_controls WHERE batch_id IN (SELECT id FROM portal_delivery_notification_batches WHERE workspace_id=?)').bind(f.workspace).first('n')).toBe(2);
  });
  it('does not let direct native rows offer cancellation or send-now',async()=>{
    const candidate=(await nativeNotificationCandidates(env,'pending')).find(r=>r.principal_public_id==='upgrade-attempted-principal')!;
    const result=await readNativeDeliveryNotification(env,candidate.id,staff);expect(result.item).toMatchObject({canCancel:false,canSendNow:false,deliveryMode:'direct_legacy',recipientEmail:null});
    await expect(controlNativeDeliveryNotification(env,staff,candidate.id,'cancel',1,'native-direct-control-0001')).rejects.toMatchObject({status:404});
  });
  it('rolls back control receipt and audit when current binding changes before CAS',async()=>{
    const f=await fixture('control-race');await create(f);const row=await publicRow(f);
    const raced=intercept(db,sql=>sql==='BATCH',()=>db.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(f.binding).run());
    await expect(controlNativeDeliveryNotification({...env,DELIVERY_DB:raced},staff,row.id,'send-now',row.revision,'native-race-control-0001')).rejects.toMatchObject({status:409});
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_controls WHERE batch_id=?').bind(row.storageId).first('n')).toBe(0);
  });
  it('enforces immutable item, batch ownership, receipt history and one-batch adoption',async()=>{
    const f=await fixture('immutable');await create(f);const b=await batch(f),item=await db.prepare('SELECT * FROM portal_delivery_notification_items WHERE batch_id=?').bind(b.id).first<any>();
    await expect(db.prepare("UPDATE portal_delivery_notification_batches SET principal_public_id='another' WHERE id=?").bind(b.id).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM portal_delivery_notification_items WHERE outbox_id=?').bind(item.outbox_id).run()).rejects.toThrow();
    await expect(db.prepare('INSERT OR REPLACE INTO portal_delivery_notification_items(outbox_id,batch_id,grant_version,staging_token) VALUES(?,?,1,?)').bind(item.outbox_id,b.id,'replacement').run()).rejects.toThrow();
    await Promise.all([db.batch(stagePortalDeliveryNotificationStatements(db,item.outbox_id)),db.batch(stagePortalDeliveryNotificationStatements(db,item.outbox_id))]);
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_items WHERE outbox_id=?').bind(item.outbox_id).first('n')).toBe(1);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('rejects current scoped denies and revocation on replay without undoing existing control history',async()=>{
    const f=await fixture('control-deny');await create(f);const row=await publicRow(f),key='native-deny-control-0001';
    await controlNativeDeliveryNotification(env,staff,row.id,'cancel',row.revision,key);
    const denyId=crypto.randomUUID();
    await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,'delivery.share.revoke','deny','division','native-division','native-division',?)`).bind(denyId,staff.id,staff.id).run();
    try{await expect(controlNativeDeliveryNotification(env,staff,row.id,'cancel',row.revision,key)).rejects.toMatchObject({status:404});
      expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_controls WHERE batch_id=?').bind(row.storageId).first('n')).toBe(1);
    }finally{await ops.prepare('DELETE FROM staff_permission_overrides WHERE id=?').bind(denyId).run();}
  });
  it('concurrent same-key controls converge to one durable receipt and one audit',async()=>{
    const f=await fixture('control-concurrent');await create(f);const row=await publicRow(f),key='native-concurrent-control-0001';
    const results=await Promise.all([controlNativeDeliveryNotification(env,staff,row.id,'cancel',row.revision,key),controlNativeDeliveryNotification(env,staff,row.id,'cancel',row.revision,key)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(await db.prepare('SELECT count(*) n FROM portal_delivery_notification_controls WHERE batch_id=?').bind(row.storageId).first('n')).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE entity_id=? AND action='portal.delivery.notification.cancelled'").bind(row.storageId).first('n')).toBe(1);
  },30_000);
  it('bounds uncached 50-scope scan plus 25 selected authorization/rechecks, uses indexed production keysets and <=100 bind parameters',async()=>{
    const f=await fixture('budget');await create(f);const stats={queries:0,maxBindings:0,executed:[] as {sql:string;args:unknown[]}[]};
    const monitored={...env,DELIVERY_DB:tracked(db,stats),OPS_DB:tracked(ops,stats)};
    const row=await publicRow(f);
    for(let n=0;n<50;n++)expect(await readNativeDeliveryNotificationScope(monitored,row)).not.toBeNull();
    for(let n=0;n<25;n++){expect(await authorizeNativeDeliveryNotification(monitored,row)).not.toBeNull();expect(await readNativeDeliveryNotificationScope(monitored,row)).not.toBeNull();}
    expect(stats.queries).toBeLessThanOrEqual(410); // Leaves >500 for combined legacy policy/reads and scheduler overhead.
    await nativeNotificationCandidates(monitored,'pending',undefined,25);
    const selects=stats.executed.filter(r=>r.sql.includes('ORDER BY batch.created_at DESC')||r.sql.includes('ORDER BY outbox.created_at DESC'));
    expect(selects).toHaveLength(2);
    for(const select of selects){const plan=JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN ${select.sql}`).bind(...select.args).all()).results);
      expect(plan).toMatch(/idx_portal_delivery_notification_(pending|direct_pending)/);expect(plan).not.toContain('USE TEMP B-TREE');}
    await due(f);await processPortalDeliveryNotificationBatches(monitored);expect(stats.maxBindings).toBeLessThanOrEqual(100);
    expect(stats.queries).toBeLessThan(800); // Entire measured read protocol plus one worker dispatch.
  },90_000);
  it('does not claim a live processing lease, and stale provider completion cannot overwrite an expired-lease successor',async()=>{
    const f=await fixture('lease-successor');await create(f);await due(f);
    let announce!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{announce=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(mailer.sendNotificationMail).mockImplementationOnce(async()=>{announce();await held;});
    const firstWorker=processPortalDeliveryNotificationBatches(env);
    let successor:NativeBatch|undefined;
    try{
      await entered;const first=await batch(f);
      expect(first).toMatchObject({status:'processing',attempt_count:1});expect(first.lease_token).toBeTruthy();
      await processPortalDeliveryNotificationBatches(env);expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);
      expect((await batch(f)).lease_token).toBe(first.lease_token);
      await db.prepare("UPDATE portal_delivery_notification_batches SET lease_expires_at=datetime('now','-1 second') WHERE id=?").bind(first.id).run();
      await processPortalDeliveryNotificationBatches(env);successor=await batch(f);
      expect(successor).toMatchObject({status:'sent',attempt_count:2,lease_token:null});
      expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(2);
      const calls=vi.mocked(mailer.sendNotificationMail).mock.calls;
      expect(calls[1]![1]).toEqual(calls[0]![1]); // Same frozen payload/provider identity, not a new send identity.
    }finally{release();await firstWorker;}
    expect(await batch(f)).toEqual(successor);
    expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE entity_id=? AND action='portal.delivery.notification.sent'").bind(successor!.id).first('n')).toBe(1);
  },60_000);
  it('stops after exactly three failed claims, never resets the retry budget, and preserves sealed publication',async()=>{
    const f=await fixture('three-attempts');await create(f);
    vi.mocked(mailer.sendNotificationMail).mockRejectedValue(new Error('uncertain provider acceptance'));
    let published:string|null=null;
    for(let attempt=1;attempt<=3;attempt++){
      await due(f);await processPortalDeliveryNotificationBatches(env);const row=await batch(f);
      expect(row).toMatchObject({attempt_count:attempt,status:attempt===3?'failed':'pending',lease_token:null,lease_expires_at:null,last_error:'delivery-attempt-failed'});
      expect(row.sealed_at).not.toBeNull();expect(row.dispatch_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      if(published===null)published=row.dispatch_fingerprint;else expect(row.dispatch_fingerprint).toBe(published);
      if(attempt<3)expect(Date.parse(row.eligible_at.replace(' ','T')+'Z')).toBeGreaterThan(Date.now());
    }
    const terminal=await batch(f);await processPortalDeliveryNotificationBatches(env);expect(await batch(f)).toEqual(terminal);
    expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(3);
    expect(new Set(vi.mocked(mailer.sendNotificationMail).mock.calls.map(call=>call[1].messageIdKey)).size).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE entity_id=? AND action='portal.delivery.notification.failed'").bind(terminal.id).first('n')).toBe(1);
    await expect(controlNativeDeliveryNotification(env,staff,`nb_${terminal.id}`,'send-now',terminal.revision,'native-terminal-control-0001')).rejects.toMatchObject({status:409});
  },60_000);
  it('recovers expired third-attempt crashes for every registered source without a fourth send',async()=>{
    const f=await fixture('final-crash');await create(f);const row=await batch(f);
    await db.prepare(`UPDATE portal_delivery_notification_batches SET status='processing',attempt_count=3,
      sealed_at=datetime('now'),lease_token='crashed-final-token',lease_expires_at=datetime('now','-1 second') WHERE id=?`).bind(row.id).run();
    const secondary=await fixture('secondary-exhausted',createCatalogSourceContext('project-alpha:secondary'));
    const secondaryId=crypto.randomUUID();
    await db.prepare(`INSERT INTO portal_delivery_notification_batches(id,source_id,workspace_id,folder_binding_id,binding_source_version,
      principal_public_id,principal_source_version,owner_scope_type,owner_public_id,r2_prefix,status,attempt_count,sealed_at,lease_token,lease_expires_at)
      VALUES(?,?,?,?,'v1',?,'pv1','project',?,?,'processing',3,datetime('now'),'secondary-token',datetime('now','-1 second'))`)
      .bind(secondaryId,secondary.source.sourceId,secondary.workspace,secondary.binding,secondary.principal,secondary.owner,secondary.prefix).run();
    const pendingPlan=JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM portal_delivery_notification_batches
      INDEXED BY idx_portal_delivery_notification_pending_exhausted
      WHERE status='pending' AND attempt_count>=3 AND eligible_at<=datetime('now')
      ORDER BY eligible_at,created_at,id LIMIT 50`).all()).results);
    const processingPlan=JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM portal_delivery_notification_batches
      INDEXED BY idx_portal_delivery_notification_processing_exhausted
      WHERE status='processing' AND attempt_count>=3 AND lease_expires_at<=datetime('now')
      ORDER BY lease_expires_at,created_at,id LIMIT 50`).all()).results);
    expect(pendingPlan).toContain('idx_portal_delivery_notification_pending_exhausted');
    expect(processingPlan).toContain('idx_portal_delivery_notification_processing_exhausted');
    expect(pendingPlan+processingPlan).not.toContain('USE TEMP B-TREE');
    await processPortalDeliveryNotificationBatches(env);
    expect(await batch(f)).toMatchObject({status:'failed',attempt_count:3,lease_token:null,lease_expires_at:null,last_error:'attempts-exhausted'});
    expect(await db.prepare('SELECT * FROM portal_delivery_notification_batches WHERE id=?').bind(secondaryId).first())
      .toMatchObject({source_id:'project-alpha:secondary',status:'failed',attempt_count:3,lease_token:null,lease_expires_at:null,last_error:'attempts-exhausted'});
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    const terminal=await batch(f);await processPortalDeliveryNotificationBatches(env);expect(await batch(f)).toEqual(terminal);
  },30_000);
  it('seals exactly fifty items and stages item fifty-one in a separate bounded successor',async()=>{
    const f=await fixture('fifty-items');await create(f);const first=await batch(f);
    const original=await db.prepare('SELECT grant_id FROM project_alpha_delivery_portal_notification_outbox WHERE principal_public_id=? LIMIT 1').bind(f.principal).first<{grant_id:string}>();
    expect(original).not.toBeNull();
    const pending: D1PreparedStatement[]=[];
    const outboxIds:string[]=[];
    // The first intent proves authorization. Remaining fixtures are equivalent
    // immutable explicit-principal receipts/outboxes, all using its exact grant;
    // invoke the real five-statement producer adapter for every item.
    for(let index=2;index<=51;index++){
      const receiptId=crypto.randomUUID(),outboxId=crypto.randomUUID();outboxIds.push(outboxId);
      pending.push(db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
        (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,project_alpha_source_id)
        VALUES(?,?,?,'portal',?,'project-alpha:primary')`).bind(receiptId,`${f.name}-${index}`,fingerprint([f.name,index]),original!.grant_id),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type)
        VALUES(?,?,?,?,'pv1','granted')`).bind(outboxId,receiptId,original!.grant_id,f.principal),
      ...stagePortalDeliveryNotificationStatements(db,outboxId));
    }
    // Bounded chunks retain per-intent atomicity while avoiding giant fixtures.
    for(let offset=0;offset<pending.length;offset+=70)await db.batch(pending.slice(offset,offset+70));
    const rows=(await db.prepare(`SELECT batch.id,batch.sealed_at,batch.attempt_count,count(item.outbox_id) item_count
      FROM portal_delivery_notification_batches batch JOIN portal_delivery_notification_items item ON item.batch_id=batch.id
      WHERE batch.workspace_id=? GROUP BY batch.id ORDER BY item_count DESC`).bind(f.workspace).all<{id:string;sealed_at:string|null;attempt_count:number;item_count:number}>()).results;
    expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({id:first.id,item_count:50,attempt_count:0});expect(rows[0]!.sealed_at).not.toBeNull();
    expect(rows[1]).toMatchObject({item_count:1,attempt_count:0,sealed_at:null});
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_delivery_portal_notification_outbox WHERE principal_public_id=? AND status='suppressed' AND last_error='native-batch-staged'").bind(f.principal).first('n')).toBe(51);
    const before=await db.prepare('SELECT revision,eligible_at FROM portal_delivery_notification_batches WHERE id=?').bind(rows[1]!.id).first();
    await db.batch(stagePortalDeliveryNotificationStatements(db,outboxIds.at(-1)!));
    expect(await db.prepare('SELECT revision,eligible_at FROM portal_delivery_notification_batches WHERE id=?').bind(rows[1]!.id).first()).toEqual(before);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  },60_000);
});
