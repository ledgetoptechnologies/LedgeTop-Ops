import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {projectAccessAuthorityHistoryReady,projectAccessGrantEvent,projectAccessInvitationEvent,reconcileProjectAccessAuthorityExpiries}
  from '../src/worker/client-portal/project-access-authority-history';

const foundation=`
  PRAGMA foreign_keys=ON;
  CREATE TABLE portal_project_access_terms(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT,mode TEXT,expires_at TEXT);
  CREATE TABLE portal_project_access_deadlines(access_terms_id TEXT PRIMARY KEY,deadline_at TEXT);
  CREATE TABLE portal_workspace_invitation_requests(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,scope_type TEXT,scope_public_id TEXT,access_terms_id TEXT);
  CREATE TABLE portal_v2_invitations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,revoked_at TEXT,accepted_at TEXT,accepted_by_identity_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE portal_v2_invitation_entitlements(invitation_id TEXT,access_terms_id TEXT);
  CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT);
  CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,access_terms_id TEXT,status TEXT,revoked_at TEXT,
    expires_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE portal_v2_authenticated_delivery_grant_recipients(grant_id TEXT,workspace_id TEXT,identity_id TEXT);
  CREATE TABLE portal_v2_membership_audit(id TEXT PRIMARY KEY,workspace_id TEXT,invitation_id TEXT,action TEXT);
  CREATE TABLE portal_v2_authenticated_delivery_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,action TEXT);
  CREATE TABLE portal_native_staff_grant_events(id TEXT PRIMARY KEY,grant_id TEXT,authorization_id TEXT,action TEXT);
`;

describe('project access authority history',{timeout:60_000,concurrent:false},()=>{
  let runtime:Miniflare,db:D1Database;
  beforeEach(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['DB']});
    db=await runtime.getD1Database('DB') as D1Database;
    await db.exec(foundation.replace(/\s*\n\s*/g,' '));
    const migration=readFileSync(new URL('../migrations/0172_project_access_authority_history.sql',import.meta.url),'utf8');
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare(`INSERT INTO portal_project_access_terms VALUES('terms-a','workspace-a','project-alpha:one','project-a','specific_date','2099-01-01T00:00:00Z')`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings VALUES('binding-a','workspace-a','project','project-a')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,workspace_id,folder_binding_id,access_terms_id,status,revoked_at)
        VALUES('grant-a','workspace-a','binding-a','terms-a','active',NULL)`),
    ]);
  });
  afterEach(async()=>runtime.dispose());

  it('preserves every revoke/restore transition and makes exact producer replay idempotent',async()=>{
    expect(await projectAccessAuthorityHistoryReady(db)).toBe(true);
    const transitions=[['grant_revoked','audit-a'],['grant_restored','audit-b'],['grant_revoked','audit-c']] as const;
    for(const [eventKind,auditId] of transitions){
      const action=eventKind==='grant_restored'?'grant.restored':'grant.revoked';
      await db.prepare('INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES(?,?,?)').bind(auditId,'grant-a',action).run();
      await projectAccessGrantEvent(db,{grantId:'grant-a',eventKind,producerEventKey:`authenticated-grant-audit:${auditId}`,
        actor:{type:'staff',id:'operator'},requiredGrantAuditId:auditId}).run();
    }
    const rows=await db.prepare(`SELECT recorded_sequence,event_kind,producer_event_key FROM portal_project_access_authority_events ORDER BY recorded_sequence`).all();
    expect(rows.results.map(row=>row.event_kind)).toEqual(['grant_revoked','grant_restored','grant_revoked']);
    const replay=await projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_revoked',producerEventKey:'authenticated-grant-audit:audit-a',
      actor:{type:'staff',id:'operator'},requiredGrantAuditId:'audit-a'}).run();
    expect(replay.meta.changes).toBe(0);
    await expect(projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_revoked',producerEventKey:'authenticated-grant-audit:audit-a',
      actor:{type:'staff',id:'different-operator'},requiredGrantAuditId:'audit-a'}).run()).rejects.toThrow(/replay conflicts/);
    expect((await db.prepare('SELECT count(*) n FROM portal_project_access_authority_events').first<number>('n'))).toBe(3);
  });

  it('rolls back term-backed mutations when an immutable producer proof is mismatched, even without foreign keys',async()=>{
    await db.batch([
      db.prepare(`INSERT INTO portal_project_access_terms VALUES('terms-invite','workspace-a','project-alpha:one','project-a','specific_date','2099-01-01T00:00:00Z')`),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,status,accepted_at,accepted_by_identity_id) VALUES('invite-a','workspace-a','accepted','2026-01-01T00:00:00Z','person-a')`),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements VALUES('invite-a','terms-invite')`),
      db.prepare(`INSERT INTO portal_v2_membership_audit VALUES('membership-wrong','workspace-a','invite-a','invitation.accepted')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('grant-wrong','grant-a','grant.revoked')`),
    ]);
    await db.prepare('PRAGMA foreign_keys=OFF').run();
    await expect(db.batch([
      db.prepare(`UPDATE portal_v2_invitations SET status='revoked',revoked_at='2026-02-01T00:00:00Z' WHERE id='invite-a'`),
      projectAccessInvitationEvent(db,{invitationId:'invite-a',eventKind:'invitation_revoked',producerEventKey:'membership:membership-wrong',
        actor:{type:'staff',id:'operator'},requiredMembershipAuditId:'membership-wrong'}),
    ])).rejects.toThrow(/exact current coordinates/);
    expect(await db.prepare(`SELECT status FROM portal_v2_invitations WHERE id='invite-a'`).first('status')).toBe('accepted');
    await expect(db.batch([
      db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked' WHERE id='grant-a'`),
      projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_restored',producerEventKey:'authenticated-grant-audit:grant-wrong',
        actor:{type:'staff',id:'operator'},requiredGrantAuditId:'grant-wrong'}),
    ])).rejects.toThrow(/exact current coordinates/);
    expect(await db.prepare(`SELECT status FROM portal_v2_authenticated_delivery_grants WHERE id='grant-a'`).first('status')).toBe('active');
    await db.prepare(`DELETE FROM portal_v2_authenticated_delivery_grants WHERE id='grant-a'`).run();
    await expect(projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_revoked',producerEventKey:'authenticated-grant-audit:missing-target',
      actor:{type:'staff',id:'operator'},requiredGrantAuditId:'grant-wrong'}).run()).rejects.toThrow(/constraint|project access authority/i);
    await db.prepare(`DELETE FROM portal_v2_invitations WHERE id='invite-a'`).run();
    await expect(projectAccessInvitationEvent(db,{invitationId:'invite-a',eventKind:'invitation_revoked',producerEventKey:'membership:missing-target',
      actor:{type:'staff',id:'operator'},requiredMembershipAuditId:'membership-wrong'}).run()).rejects.toThrow(/constraint|project access authority/i);
  });

  it('records each exact expiry once without any notification state',async()=>{
    const expiry=new Date(Date.now()+100).toISOString(),after=Date.parse(expiry)+1_000;
    await db.prepare(`UPDATE portal_project_access_terms SET expires_at=? WHERE id='terms-a'`).bind(expiry).run();
    expect(await reconcileProjectAccessAuthorityExpiries(db,after)).toBe(0);
    expect(await db.prepare(`SELECT count(*) n FROM portal_project_access_authority_events`).first('n')).toBe(0);
    expect(await reconcileProjectAccessAuthorityExpiries(db,after,100,true)).toBe(1);
    expect(await reconcileProjectAccessAuthorityExpiries(db,after,100,true)).toBe(0);
    expect(await db.prepare(`SELECT authority_type,event_kind,actor_type,actor_id,subject_identity_id,occurred_at
      FROM portal_project_access_authority_events`).first()).toEqual({authority_type:'authenticated_delivery_grant',event_kind:'access_expired',
        actor_type:'system',actor_id:null,subject_identity_id:null,occurred_at:expiry});
  });

  it('does not guess an expiry that predates collection',async()=>{
    await db.prepare(`UPDATE portal_project_access_terms SET expires_at='2020-01-01T00:00:00Z' WHERE id='terms-a'`).run();
    expect(await reconcileProjectAccessAuthorityExpiries(db,Date.now(),100,true)).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM portal_project_access_authority_events').first<number>('n')).toBe(0);
  });

  it('rejects backdated non-expiry lifecycle events before collection began',async()=>{
    const collection=await db.prepare(`SELECT collection_started_at FROM portal_project_access_authority_history_state WHERE singleton=1`).first<string>('collection_started_at');
    const before=new Date(Date.parse(collection!)-1).toISOString();
    await db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('backdated-audit','grant-a','grant.revoked')`).run();
    await expect(projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_revoked',producerEventKey:'authenticated-grant-audit:backdated-audit',
      actor:{type:'staff',id:'operator'},requiredGrantAuditId:'backdated-audit',occurredAt:before}).run()).rejects.toThrow(/exact current coordinates/);
  });

  it('uses the earliest grant boundary, skips pending invitations, and preserves millisecond collection precision',async()=>{
    const collection=await db.prepare(`SELECT collection_started_at FROM portal_project_access_authority_history_state WHERE singleton=1`).first<string>('collection_started_at');
    const collectionMs=Date.parse(collection!),before=new Date(collectionMs-1).toISOString(),after=new Date(collectionMs+1_000).toISOString(),later=new Date(collectionMs+60_000).toISOString();
    await db.batch([
      db.prepare(`UPDATE portal_project_access_terms SET expires_at=? WHERE id='terms-a'`).bind(later),
      db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET expires_at=? WHERE id='grant-a'`).bind(after),
      db.prepare(`INSERT INTO portal_project_access_terms VALUES('terms-before','workspace-a','project-alpha:one','project-a','specific_date',?)`).bind(before),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,status,created_at) VALUES('pending-before','workspace-a','pending',?)`).bind(new Date(collectionMs-10_000).toISOString()),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements VALUES('pending-before','terms-before')`),
      db.prepare(`INSERT INTO portal_project_access_terms VALUES('terms-pending','workspace-a','project-alpha:one','project-a','specific_date',?)`).bind(after),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,status,created_at) VALUES('pending-after','workspace-a','pending',?)`).bind(new Date(collectionMs-10_000).toISOString()),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements VALUES('pending-after','terms-pending')`),
    ]);
    expect(await reconcileProjectAccessAuthorityExpiries(db,Date.parse(later)+1_000,100,true)).toBe(1);
    expect(await db.prepare(`SELECT authority_id,occurred_at FROM portal_project_access_authority_events WHERE event_kind='access_expired'`).all())
      .toMatchObject({results:[{authority_id:'grant-a',occurred_at:after}]});
  });

  it('records a delayed expiry before a later revoke and deduplicates invitation entitlements',async()=>{
    const expiry=new Date(Date.now()+100).toISOString(),revokedAt=new Date(Date.parse(expiry)+1_000).toISOString();
    await db.batch([
      db.prepare(`UPDATE portal_project_access_terms SET expires_at=? WHERE id='terms-a'`).bind(expiry),
      db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=? WHERE id='grant-a'`).bind(revokedAt),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('audit-revoked','grant-a','grant.revoked')`),
    ]);
    await projectAccessGrantEvent(db,{grantId:'grant-a',eventKind:'grant_revoked',producerEventKey:'authenticated-grant-audit:audit-revoked',
      actor:{type:'staff',id:'operator'},requiredGrantAuditId:'audit-revoked',occurredAt:revokedAt}).run();
    await db.batch([
      db.prepare(`INSERT INTO portal_project_access_terms VALUES('terms-invite','workspace-a','project-alpha:one','project-a','specific_date',?)`).bind(expiry),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,status,revoked_at,accepted_at,accepted_by_identity_id,created_at)
        VALUES('invite-a','workspace-a','accepted',NULL,?,'person-a',?)`)
        .bind(new Date(Date.parse(expiry)-1_000).toISOString(),new Date(Date.parse(expiry)-2_000).toISOString()),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements VALUES('invite-a','terms-invite')`),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements VALUES('invite-a','terms-invite')`),
    ]);
    expect(await reconcileProjectAccessAuthorityExpiries(db,Date.parse(revokedAt)+1_000,100,true)).toBe(2);
    const rows=await db.prepare(`SELECT authority_type,event_kind,occurred_at FROM portal_project_access_authority_events
      ORDER BY datetime(occurred_at),recorded_sequence`).all();
    expect(rows.results).toEqual([
      {authority_type:'authenticated_delivery_grant',event_kind:'access_expired',occurred_at:expiry},
      {authority_type:'invitation',event_kind:'access_expired',occurred_at:expiry},
      {authority_type:'authenticated_delivery_grant',event_kind:'grant_revoked',occurred_at:revokedAt},
    ]);
  });
});
