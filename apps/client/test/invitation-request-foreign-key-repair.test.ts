import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,describe,expect,it} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';

const canonicalParent='portal_workspace_invitation_requests';
const dependentTables=[
  'portal_workspace_invitation_request_commands',
  'portal_workspace_invitation_approvals',
  'portal_workspace_invitation_request_audit',
] as const;
const requiredObjects=[
  'idx_portal_invitation_approval_expiry',
  'portal_invitation_approval_insert',
  'portal_invitation_approval_update',
  'portal_invitation_approval_delete',
  'portal_invitation_request_command_insert',
  'portal_invitation_command_approval_namespace',
  'portal_invitation_request_command_update',
  'portal_invitation_request_command_delete',
  'portal_invitation_request_audit_insert',
  'portal_invitation_request_audit_update',
  'portal_invitation_request_audit_delete',
  'portal_workspace_invitation_publications',
  'portal_invitation_policy_issue',
  'portal_invitation_approved_identity_update',
  'portal_invitation_approved_replace',
  'portal_invitation_approved_entitlement_insert',
  'portal_invitation_approved_entitlement_update',
  'portal_invitation_policy_accept',
  'portal_invitation_approved_mail_claim',
] as const;

async function apply(db:D1Database,name:string){
  const source=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  const statements=splitD1MigrationStatements(source);
  if(statements.length)await db.batch(statements.map(sql=>db.prepare(sql)));
}
async function applyThrough(db:D1Database,last:string){
  const names=readdirSync(new URL('../migrations/',import.meta.url))
    .filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name<=last).sort();
  for(const name of names)await apply(db,name);
}
async function foreignParents(db:D1Database,table:string){
  return (await db.prepare(`PRAGMA foreign_key_list(${table})`).all<{table:string}>()).results.map(row=>row.table);
}
async function assertRepairedSchema(db:D1Database){
  for(const table of dependentTables)expect(await foreignParents(db,table)).toContain(canonicalParent);
  const temporaryNames=['portal_workspace_invitation_requests_0165','portal_workspace_invitation_requests_0171',
    'portal_workspace_invitation_request_commands_0173','portal_workspace_invitation_approvals_0173',
    'portal_workspace_invitation_request_audit_0173'];
  const stale=(await db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL`).all<{sql:string}>()).results
    .filter(object=>temporaryNames.some(name=>object.sql.includes(name)));
  expect(stale).toEqual([]);
  const objects=(await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${requiredObjects.map(()=>'?').join(',')})`)
    .bind(...requiredObjects).all<{name:string}>()).results.map(row=>row.name).sort();
  expect(objects).toEqual([...requiredObjects].sort());
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
}
async function seedInvitationRequest(db:D1Database){
  const workspace='workspace-preserved',identity='identity-preserved',generation='generation-preserved';
  await db.batch([
    db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status)
      VALUES(?,'organization','organization-preserved','Preserved organization','active')`).bind(workspace),
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,?,1,'active',1)`).bind(generation,workspace,generation),
    db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`)
      .bind(generation,workspace),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
      VALUES(?,?,'organization','organization-preserved','Preserved organization','r1')`).bind(workspace,generation),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project','project-preserved','organization-preserved','Preserved project','p1')`).bind(workspace,generation),
    db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
      VALUES(?,?,'project-preserved','active','p1')`).bind(workspace,generation),
    db.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES('project-alpha:primary','receipt-preserved',?,'snapshot_activate',?,1,'completed')`).bind(workspace,'a'.repeat(64)),
    db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`)
      .bind(workspace,generation),
    db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
      VALUES(?,'https://issuer.example.test','subject-preserved','manager@example.test')`).bind(identity),
    db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id)
      VALUES(?,'require_approval',1,'staff-preserved')`).bind(workspace),
  ]);
  await db.prepare(`INSERT INTO portal_project_access_terms
    (id,workspace_id,source_id,project_public_id,kind,mode,expires_at,created_by_actor_type,created_by_actor_id)
    VALUES('terms-preserved',?,'project-alpha:primary','project-preserved','collaborator','specific_date','2099-01-01T00:00:00Z','identity',?)`)
    .bind(workspace,identity).run();
  await db.prepare(`INSERT INTO portal_workspace_invitation_requests
    (id,workspace_id,source_id,requester_identity_id,recipient_email,scope_type,scope_public_id,capabilities_json,
     access_terms_id,request_hash,policy_version,status,version)
    VALUES('request-preserved',?,'project-alpha:primary',?,'guest@example.test','project','project-preserved','["delivery.view"]',
      'terms-preserved','hash-preserved',1,'pending',1)`).bind(workspace,identity).run();
}
async function seedAffectedDependentHistory(db:D1Database,missingParent:string){
  const workspace='workspace-preserved',identity='identity-preserved';
  // An affected database cannot create a new approval through the runtime: its
  // approval trigger resolves the missing temporary parent first. Recreate the
  // parent and remove that one broken trigger to model retained rows from a
  // snapshot/restore, then prove 0173 preserves them while restoring guards.
  if(!/^portal_workspace_invitation_requests_\d{4}$/.test(missingParent))throw new Error(`unexpected parent ${missingParent}`);
  // D1 does not allow foreign_keys to be disabled. Recreate the otherwise
  // missing historical parent just long enough to model rows restored from a
  // snapshot of the affected schema.
  await db.exec(`CREATE TABLE ${missingParent}(id TEXT PRIMARY KEY); INSERT INTO ${missingParent}(id) VALUES('request-preserved');
    DROP TRIGGER portal_invitation_approval_insert;`);
  await db.batch([
    db.prepare(`INSERT INTO portal_workspace_invitation_request_commands
      (workspace_id,actor_id,idempotency_key,operation,request_hash,request_id,result_json)
      VALUES(?,?,'command-key-preserved','submit','hash-preserved','request-preserved','{"outcome":"preserved"}')`).bind(workspace,identity),
    db.prepare(`INSERT INTO portal_workspace_invitation_approvals
      (id,request_id,request_version,invitation_id,actor_staff_id,authorization_fingerprint,context_version,delegation_proof,publication_deadline)
      VALUES('approval-preserved','request-preserved',1,'invitation-preserved','staff-preserved',?,?,?,datetime('now','+5 minutes'))`)
      .bind('b'.repeat(64),'c'.repeat(64),'proof-preserved'),
    db.prepare(`INSERT INTO portal_workspace_invitation_request_audit
      (id,workspace_id,request_id,actor_type,actor_id,action,authorization_id,details_json)
      VALUES('audit-preserved',?,'request-preserved','staff','staff-preserved','request.reviewed','approval-preserved','{"preserved":true}')`)
      .bind(workspace),
  ]);
}

describe('invitation request dependent foreign-key repair',{timeout:180_000,concurrent:false},()=>{
  const runtimes:Miniflare[]=[];
  afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.dispose()));});
  async function database(name:string){
    const runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:name}});
    runtimes.push(runtime);
    return await runtime.getD1Database('DB') as D1Database;
  }

  it('repairs an already-upgraded populated database without rewriting approval history',async()=>{
    const db=await database('invitation-fk-upgrade');
    await applyThrough(db,'0170_authenticated_delivery_change_notifications.sql');
    await seedInvitationRequest(db);
    await apply(db,'0171_secondary_workspace_membership_management.sql');
    await apply(db,'0172_project_access_authority_history.sql');
    const brokenParents=new Set((await Promise.all(dependentTables.map(table=>foreignParents(db,table)))).flat());
    expect(brokenParents.has(canonicalParent)).toBe(false);
    expect([...brokenParents].some(parent=>/^portal_workspace_invitation_requests_\d{4}$/.test(parent))).toBe(true);
    const missingParent=[...brokenParents].find(parent=>/^portal_workspace_invitation_requests_\d{4}$/.test(parent))!;
    await seedAffectedDependentHistory(db,missingParent);
    const before:Record<string,unknown[]>={};
    for(const table of dependentTables)before[table]=(await db.prepare(`SELECT * FROM ${table}`).all()).results;

    await apply(db,'0173_invitation_request_foreign_key_repair.sql');
    await db.exec(`DROP TABLE ${missingParent};`);
    await assertRepairedSchema(db);
    for(const table of dependentTables)
      expect((await db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before[table]);
    await expect(db.prepare(`UPDATE portal_workspace_invitation_request_audit SET action='tampered' WHERE id='audit-preserved'`).run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare(`DELETE FROM portal_workspace_invitation_approvals WHERE id='approval-preserved'`).run())
      .rejects.toThrow(/persistent/);
  });

  it('leaves a clean full migration chain with the same canonical constraints and objects',async()=>{
    const db=await database('invitation-fk-clean');
    await applyThrough(db,'0173_invitation_request_foreign_key_repair.sql');
    await assertRepairedSchema(db);
  });
});
