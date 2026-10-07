import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { isProjectInboundAuthorized, safeProjectInboundDecision,
  type InboundProjectGrant } from "../src/worker/project-alpha-project-inbound-reconciliation";

const migrations = resolve(import.meta.dirname, "../migrations");
const files = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const publicId = "d".repeat(32), oldProjection = "a".repeat(64), nextProjection = "b".repeat(64);
const project = "ops-project-1", staff = "staff-beau-koltz", subject = "owner-subject";
const requestId = "10000000-0000-4000-8000-000000000001";

function migrate(db: DatabaseSync, name: string) {
  for (const statement of unstable_splitSqlQuery(readFileSync(resolve(migrations, name), "utf8"))) db.exec(statement);
}
function remoteJson(revision = "2", projection = nextProjection,
  directory: Readonly<{ clientPublicId?: string | null; organizationPublicId?: string | null }> = {}) {
  return JSON.stringify({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
    requestId: "10000000-0000-4000-8000-000000000002", replayed: false, accepted: true,
    resource: { type: "project", id: publicId, revision, projectionSha256: projection },
    data: { name: "PA edited name", description: "reviewed", status: "active", archived: false,
      overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
      clientPublicId: directory.clientPublicId ?? null, organizationPublicId: directory.organizationPublicId ?? null } });
}
function localJson() {
  return JSON.stringify({ application_id: application, archived: 0, archived_at: null,
    canonical_projection_sha256: oldProjection, client_record_id: null, completed_at: null, current_version: 1,
    description: null, external_project_id: project, history_epoch_id: epoch, lifecycle: "active", name: "Ops name",
    organization_record_id: null, overdue_warning: 0, pa_revision: "1", planned_end: null, planned_start: null,
    project_alpha_public_id: publicId, scopes_json: "[]", source_id: "project-alpha:primary", source_instance_id: source });
}
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of files) {
    if (name === "0065_project_alpha_project_reconciliation.sql") {
      // no special handling; marker only documents the point at which the
      // immutable mapping fixture already exists.
    }
    if (name === "0065_project_alpha_project_reconciliation.sql") { /* fall through */ }
    if (name === "0086_native_shared_projects.sql") {
      migrate(db, name);
      continue;
    }
    if (name === "0170_project_alpha_active_directory_project_guard.sql") {
      db.exec("DROP TRIGGER operations_shared_projects_bound_refresh_guard");
      db.prepare(`INSERT INTO operations_shared_projects(external_project_id,source_id,source_instance_id,application_id,
        history_epoch_id,project_alpha_public_id,pa_revision,current_version,name,lifecycle,scopes_json,
        canonical_projection_sha256) VALUES(?,?,?,?,?,?,?,1,'Ops name','active','[]',?)`)
        .run(project, "project-alpha:primary", source, application, epoch, publicId, "1", oldProjection);
      db.exec(`CREATE TRIGGER operations_shared_projects_bound_refresh_guard BEFORE INSERT ON operations_shared_projects
        BEGIN SELECT 1; END`);
    }
    migrate(db, name);
    if (name === "0064_project_alpha_project_history_epoch.sql") {
      db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
        destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
        .run(project, "project-alpha:primary", application, "https://pa.example.test", source, epoch);
      db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
        source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
        attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES('10000000-0000-4000-8000-000000000010',?,'bind','{}','project-alpha:primary',?,
          'https://pa.example.test',?,'{}','leased',0,0,'fixture-lease',4102444800,?)`)
        .run(project, application, source, epoch);
      db.prepare(`INSERT INTO project_alpha_project_mappings(external_project_id,source_id,source_instance_id,
        application_id,project_alpha_public_id,establishment_kind,establishment_command_id,create_command_id,
        history_epoch_id) VALUES(?,?,?,?,?,'bind','10000000-0000-4000-8000-000000000010',NULL,?)`)
        .run(project, "project-alpha:primary", source, application, publicId, epoch);
    }
  }
  db.prepare("INSERT INTO native_staff_admissions(staff_id,active,bound_access_subject,admitted_by,version) VALUES(?,1,?,?,1)")
    .run(staff, subject, staff);
  db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,'owner@example.test','Fixture Owner',1)")
    .run(staff);
  db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES('grant-owner',?,'project.shared.sync','allow','global',1,1,?)`).run(staff, staff);
  db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
    history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
    VALUES('project-alpha:primary',?,?,?,'project',?,'7',?,1)`).run(source, application, epoch, requestId, "e".repeat(64));
  db.prepare(`INSERT INTO project_alpha_api_v2_project_observations(source_id,source_instance_id,application_id,
    history_epoch_id,request_id,external_project_id,project_alpha_public_id,resource_revision,projection_sha256,
    lifecycle_status,archived) VALUES('project-alpha:primary',?,?,?,?,?,?, '2',?,'active',0)`)
    .run(source, application, epoch, requestId, project, publicId, nextProjection);
  db.exec("CREATE TABLE public_link_sentinel(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO public_link_sentinel VALUES('link','unchanged'); CREATE TABLE financial_sentinel(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO financial_sentinel VALUES('invoice','unchanged');");
  return db;
}
function proposal(db: DatabaseSync, id: string, remoteSnapshot = remoteJson(), normalizedScopesJson = "[]") {
  db.prepare(`INSERT INTO project_alpha_project_inbound_proposals(proposal_id,idempotency_key,request_sha256,
    source_id,source_instance_id,application_id,history_epoch_id,external_project_id,project_alpha_public_id,
    expected_local_version,expected_local_projection_sha256,observed_request_id,observed_authorization_generation,
    observed_remote_revision,observed_remote_projection_sha256,local_snapshot_json,remote_snapshot_json,
    remote_snapshot_sha256,target_organization_record_id,target_client_record_id,reviewer_staff_id,
    reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,project_grant_generation,
    normalized_scopes_json,expires_at) VALUES(?,?,?,'project-alpha:primary',?,?,?,?,?,1,?,?,'7','2',?,?,?,?,
      NULL,NULL,?,?,1,1,1,?,'2999-01-01T00:00:00.000Z')`).run(id,
    id.replace(/.$/, "2"), "f".repeat(64), source, application, epoch, project, publicId, oldProjection, requestId,
    nextProjection, localJson(), remoteSnapshot, "c".repeat(64), staff, subject, normalizedScopesJson);
}
function resolveAccept(db: DatabaseSync, proposalId: string, resolutionId: string, normalizedScopesJson = "[]") {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_authorizations(resolution_id,proposal_id,
      idempotency_key,request_sha256,decision,final_remote_snapshot_json,final_remote_snapshot_sha256,
      final_remote_revision,final_remote_projection_sha256,final_authorization_generation,
      target_organization_record_id,target_client_record_id,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,project_grant_generation,normalized_scopes_json)
      VALUES(?,?,?,?,'accept_project_alpha',?,?, '2',?,'7',NULL,NULL,?,?,1,1,1,?)`).run(resolutionId,
      proposalId, resolutionId.replace(/.$/, "3"), "9".repeat(64), remoteJson(), "c".repeat(64), nextProjection, staff, subject,
      normalizedScopesJson);
    db.prepare(`UPDATE operations_shared_projects SET pa_revision='2',current_version=2,
      canonical_projection_sha256=?,name='PA edited name',description='reviewed',lifecycle='active',archived=0,
      overdue_warning=0,completed_at=NULL,archived_at=NULL,planned_start=NULL,planned_end=NULL,
      organization_record_id=NULL,client_record_id=NULL,scopes_json='[]' WHERE external_project_id=?`)
      .run(nextProjection, project);
    db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,pa_revision,read_json,
      refresh_command_id,v2_settlement_id,inbound_resolution_id) VALUES(?,2,NULL,?,NULL,NULL,?)`)
      .run(project, remoteJson(), resolutionId);
    db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_receipts(resolution_id,proposal_id,decision,
      prior_local_version,resulting_local_version) VALUES(?,?,'accept_project_alpha',1,2)`).run(resolutionId, proposalId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

describe("PA-origin mapped project reconciliation guards", () => {
  it("requires both business area and division identity for division-scoped authority", () => {
    const grant: InboundProjectGrant = { effect: "allow", scope_kind: "division", business_area_id: "area-a",
      division_id: "division-1", external_project_id: null };
    expect(isProjectInboundAuthorized([grant], project,
      [{ scopeKind: "division", businessAreaId: "area-a", divisionId: "division-1" }])).toBe(true);
    expect(isProjectInboundAuthorized([grant], project,
      [{ scopeKind: "division", businessAreaId: "area-b", divisionId: "division-1" }])).toBe(false);
  });

  it("routes an inbound accept that changes the activated owner or client to follow-up", () => {
    const current = { organizationRecordId: "org-a", clientRecordId: "client-a" };
    expect(safeProjectInboundDecision("accept_project_alpha", current, current)).toBe("accept_project_alpha");
    expect(safeProjectInboundDecision("accept_project_alpha", current,
      { organizationRecordId: "org-b", clientRecordId: "client-a" })).toBe("requires_follow_up");
    expect(safeProjectInboundDecision("accept_project_alpha", current,
      { organizationRecordId: "org-a", clientRecordId: "client-b" })).toBe("requires_follow_up");
    expect(safeProjectInboundDecision("keep_operations", current,
      { organizationRecordId: "org-b", clientRecordId: "client-b" })).toBe("requires_follow_up");
  });

  it("preserves the full migration chain and outgoing guard while default direct edits fail", () => {
    const db = fixture();
    expect(() => db.prepare("UPDATE operations_shared_projects SET name='silent overwrite' WHERE external_project_id=?")
      .run(project)).toThrow(/versioned writer/);
    expect(db.prepare("SELECT name FROM operations_shared_projects WHERE external_project_id=?").get(project)).toEqual({ name: "Ops name" });
  });

  it("rejects malformed and duplicate scope structures on proposals and resolutions", () => {
    const invalidScopes = [
      "[{}]",
      '[{"scopeKind":"business_area","businessAreaId":"area-a","divisionId":null,"extra":true}]',
      '[{"scopeKind":"business_area","businessAreaId":"area-a","divisionId":null},{"scopeKind":"business_area","businessAreaId":"area-a","divisionId":null}]',
      '[{"scopeKind":"division","businessAreaId":"area-a","divisionId":"division-1"},{"scopeKind":"division","businessAreaId":"area-a","divisionId":"division-1"}]',
    ];
    for (const [index, scopeJson] of invalidScopes.entries()) {
      const db = fixture();
      expect(() => proposal(db, `20000000-0000-4000-8000-00000000010${index}`, remoteJson(), scopeJson))
        .toThrow(/project inbound scopes are malformed/);
    }

    const malformedResolutionScopes =
      '[{"scopeKind":"business_area","businessAreaId":"area-a","divisionId":null},{"scopeKind":"business_area","businessAreaId":"area-a","divisionId":null}]';
    const db = fixture(), proposalId = "20000000-0000-4000-8000-000000000020";
    const resolutionId = "30000000-0000-4000-8000-000000000020";
    proposal(db, proposalId);
    expect(() => resolveAccept(db, proposalId, resolutionId, malformedResolutionScopes)).toThrow();
    expect(db.prepare("SELECT count(*) n FROM project_alpha_project_inbound_resolution_authorizations").get())
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT current_version,name FROM operations_shared_projects WHERE external_project_id=?").get(project))
      .toEqual({ current_version: 1, name: "Ops name" });

    const isolatedDb = fixture(), isolatedProposalId = "20000000-0000-4000-8000-000000000021";
    proposal(isolatedDb, isolatedProposalId);
    for (const { name } of isolatedDb.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND tbl_name='project_alpha_project_inbound_resolution_authorizations'
      AND name<>'project_alpha_project_inbound_resolution_authorizations_scope_shape'`).all() as Array<{ name: string }>) {
      isolatedDb.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    expect(() => resolveAccept(isolatedDb, isolatedProposalId, "30000000-0000-4000-8000-000000000021",
      malformedResolutionScopes)).toThrow(/project inbound scopes are malformed/);
  });

  it("atomically appends accepted PA history without changing mapping, public-link, or financial rows", () => {
    const db = fixture(), proposalId = "20000000-0000-4000-8000-000000000001", resolutionId = "30000000-0000-4000-8000-000000000001";
    proposal(db, proposalId);
    const before = {
      mapping: db.prepare("SELECT * FROM project_alpha_project_mappings").all(),
      outbox: db.prepare("SELECT * FROM project_alpha_project_outbox").all(),
      links: db.prepare("SELECT * FROM public_link_sentinel").all(),
      financial: db.prepare("SELECT * FROM financial_sentinel").all(),
    };
    resolveAccept(db, proposalId, resolutionId);
    expect(db.prepare("SELECT current_version,name,pa_revision,canonical_projection_sha256 FROM operations_shared_projects WHERE external_project_id=?").get(project))
      .toEqual({ current_version: 2, name: "PA edited name", pa_revision: "2", canonical_projection_sha256: nextProjection });
    expect(db.prepare("SELECT inbound_resolution_id FROM operations_shared_project_revisions WHERE external_project_id=? AND version=2").get(project))
      .toEqual({ inbound_resolution_id: resolutionId });
    expect(db.prepare("SELECT * FROM project_alpha_project_mappings").all()).toEqual(before.mapping);
    expect(db.prepare("SELECT * FROM project_alpha_project_outbox").all()).toEqual(before.outbox);
    expect(db.prepare("SELECT * FROM public_link_sentinel").all()).toEqual(before.links);
    expect(db.prepare("SELECT * FROM financial_sentinel").all()).toEqual(before.financial);
  });

  it("rolls the whole resolution back when local CAS or authority changes", () => {
    const db = fixture(), proposalId = "20000000-0000-4000-8000-000000000003", resolutionId = "30000000-0000-4000-8000-000000000003";
    proposal(db, proposalId);
    db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=?")
      .run(staff);
    expect(() => resolveAccept(db, proposalId, resolutionId)).toThrow(/stale/);
    expect(db.prepare("SELECT count(*) n FROM project_alpha_project_inbound_resolution_authorizations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT current_version,name FROM operations_shared_projects WHERE external_project_id=?").get(project))
      .toEqual({ current_version: 1, name: "Ops name" });
  });

  it("rejects null target IDs when the immutable remote snapshot names an owner", () => {
    const db = fixture(), proposalId = "20000000-0000-4000-8000-000000000004";
    const resolutionId = "30000000-0000-4000-8000-000000000004";
    const remoteSnapshot = remoteJson("2", nextProjection, { organizationPublicId: "e".repeat(32) });
    proposal(db, proposalId, remoteSnapshot);
    expect(() => db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_authorizations(resolution_id,
      proposal_id,idempotency_key,request_sha256,decision,final_remote_snapshot_json,final_remote_snapshot_sha256,
      final_remote_revision,final_remote_projection_sha256,final_authorization_generation,
      target_organization_record_id,target_client_record_id,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,project_grant_generation,normalized_scopes_json)
      VALUES(?,?,?,?,'keep_operations',?,?,'2',?,'7',NULL,NULL,?,?,1,1,1,'[]')`).run(
      resolutionId, proposalId, resolutionId.replace(/.$/, "4"), "8".repeat(64), remoteSnapshot,
      "c".repeat(64), nextProjection, staff, subject,
    )).toThrow(/stale/);
    expect(db.prepare("SELECT count(*) n FROM project_alpha_project_inbound_resolution_authorizations").get())
      .toEqual({ n: 0 });
  });

  it("records keep-operations and follow-up decisions without changing the canonical head", () => {
    for (const [suffix, decision] of [["5", "keep_operations"], ["7", "requires_follow_up"]] as const) {
      const db = fixture(), proposalId = `20000000-0000-4000-8000-00000000000${suffix}`;
      const resolutionId = `30000000-0000-4000-8000-00000000000${suffix}`; proposal(db, proposalId);
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_authorizations(resolution_id,proposal_id,
        idempotency_key,request_sha256,decision,final_remote_snapshot_json,final_remote_snapshot_sha256,
        final_remote_revision,final_remote_projection_sha256,final_authorization_generation,
        target_organization_record_id,target_client_record_id,reviewer_staff_id,reviewer_access_subject,
        reviewer_admission_version,reviewer_profile_version,project_grant_generation,normalized_scopes_json)
        VALUES(?,?,?,?,?,?,?,'2',?,'7',NULL,NULL,?,?,1,1,1,'[]')`).run(resolutionId, proposalId,
        resolutionId.replace(/.$/, "4"), "8".repeat(64), decision, remoteJson(), "c".repeat(64), nextProjection, staff, subject);
      db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_receipts(resolution_id,proposal_id,decision,
        prior_local_version,resulting_local_version) VALUES(?,?,?,1,1)`).run(resolutionId, proposalId, decision);
      db.exec("COMMIT");
      expect(db.prepare("SELECT current_version,name FROM operations_shared_projects WHERE external_project_id=?").get(project))
        .toEqual({ current_version: 1, name: "Ops name" });
    }
  });
});
