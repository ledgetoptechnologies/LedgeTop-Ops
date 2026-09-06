import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import {
  d1ClientPortalRepository,
  NativeNotificationAuthorizationOverflowError,
} from "../src/worker/client-portal/repository";
import {
  readServiceAssignmentPolicy,
  serviceAssignmentPolicyProofStillCurrent,
} from "../src/worker/client-portal/service-assignment-policy";
import {
  listServiceCatalogPageForSource,
} from "../src/worker/client-portal/service-catalog-page";
import {
  createServiceRequestDraft,
  saveServiceRequestDraft,
  submitServiceRequestDraft,
} from "../src/worker/client-portal/request-v2";
import type { ClientPortalSession, ClientServiceRequestDraftInput } from "../src/worker/client-portal/types";
import { effectiveWorkspaceRequestMutationGuardSql, readEffectiveWorkspaceRequestProof } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import {
  cancelNativeServiceRequest,
  createNativeServiceRequestDraft,
  listNativeServiceCatalog,
  listNativeServiceRequests,
  submitNativeServiceRequestDraft,
} from "../src/worker/client-portal/native-request-v2";
import {
  abortRequestAttachment,
  checkpointRequestAttachment,
  completeRequestAttachment,
  getAuthorizedRequestAttachmentContext,
  initializeRequestAttachment,
  issueNativeRequestAttachmentPartLease,
  listRequestAttachments,
} from "../src/worker/client-portal/request-attachments";
import {
  nativeRequestMutationGuardSql,
  resolveNativeRequestAuthority,
} from "../src/worker/client-portal/native-request-authority";

const sourceId = "project-alpha:primary";
const secondarySourceId = "project-alpha:secondary";
const workspaceId = "policy-workspace";
const session: ClientPortalSession = {
  accountId: "policy-account",
  identityId: "policy-identity",
  workspaceId,
  principalIssuer: "https://issuer.test",
  principalSubject: "policy-subject",
  principalEmail: "policy@example.test",
  displayName: "Policy client",
  role: "manager",
  canViewBilling: false,
};
const secondarySession: ClientPortalSession = {
  ...session,
  accountId: "",
  identityId: "",
  workspaceId: "secondary-policy-workspace",
  nativeSourceId: secondarySourceId,
  nativePortalIdentityId: "portal-policy-identity",
};

describe("exact-target service-assignment request policy", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let databaseIndex = 0;

  beforeAll(() => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: Object.fromEntries(Array.from({ length: 24 }, (_, index) =>
        [`POLICY_DB_${index}`, `service-assignment-policy-${index}`])),
    });
  });

  afterAll(async () => runtime.dispose());

  beforeEach(async () => {
    db = await runtime.getD1Database(`POLICY_DB_${databaseIndex++}`) as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await seedPolicyContext();
    const bucket = {
      async createMultipartUpload(key: string) {
        return { key, uploadId: `upload-${crypto.randomUUID()}`, async abort() {}, async uploadPart() {}, async complete() {} };
      },
      resumeMultipartUpload(key: string, uploadId: string) {
        return { key, uploadId, async abort() {}, async uploadPart() {}, async complete() {
          throw new Error("stale authority must fail before completing R2");
        } };
      },
      async head() { return null; },
      async get() { return null; },
      async delete() {},
    } as unknown as R2Bucket;
    env = {
      DELIVERY_DB: db,
      DATA_BUCKET: bucket,
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "true",
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true",
      CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "true",
      CLIENT_REQUEST_ATTACHMENTS_ENABLED: "true",
      CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET: "s".repeat(32),
      R2_S3_ENDPOINT: "https://846c924bf17bf4f3dd15c97a4c5d1d51.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "client-data",
      CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID: "attachment-access",
      CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY: "attachment-secret".repeat(4),
    } as Env;
  }, 60_000);

  async function seedPolicyContext() {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts
        (id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES ('policy-account','Policy client','active','pa-org-policy',?)`).bind(sourceId),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('policy-identity','policy-account','https://issuer.test','policy-subject','policy@example.test')`),
      db.prepare(`INSERT INTO client_account_members(account_id,identity_id,role)
        VALUES ('policy-account','policy-identity','manager')`),
      db.prepare(`INSERT INTO projects
        (id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
        VALUES ('project-a','Policy client','Project A','clients/policy/a/',?,'pa-project-a'),
          ('project-b','Policy client','Project B','clients/policy/b/',?,'pa-project-b')`).bind(sourceId, sourceId),
      db.prepare(`INSERT INTO client_project_grants(account_id,project_id,can_request_service)
        VALUES ('policy-account','project-a',1),('policy-account','project-b',1)`),
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES (?,?,?)`).bind(workspaceId, sourceId, "pa-policy-workspace"),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
        VALUES (?,'organization','pa-org-policy','policy-account','Policy client','active',?)`).bind(workspaceId, sourceId),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES ('portal-policy-identity','https://issuer.test','policy-subject','policy@example.test','active')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('policy-membership',?,'portal-policy-identity','project_alpha','active','membership-v1')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('directory-1',?,'directory-generation-1',1,'active',1,datetime('now'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'directory-1','organization','pa-org-policy','Policy client','directory-v1',1),
          (?,'directory-1','project','pa-project-a','Project A','directory-v1',1),
          (?,'directory-1','project','pa-project-b','Project B','directory-v1',1)`)
        .bind(workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version) VALUES ('directory-1',?,3)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle
        (workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES (?,'directory-1','pa-project-a','active','directory-v1'),
          (?,'directory-1','pa-project-b','active','directory-v1')`).bind(workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,'directory-1','contains-a','contains','organization','pa-org-policy','project','pa-project-a','directory-v1',1),
          (?,'directory-1','contains-b','contains','organization','pa-org-policy','project','pa-project-b','directory-v1',1)`)
        .bind(workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES (?,'directory-1',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES ('policy-view',?,'portal-policy-identity','workspace.view','allow','workspace',?,'project_alpha','entitlement-v1','active'),
          ('policy-request-root',?,'portal-policy-identity','request.create','allow','workspace',?,'project_alpha','entitlement-v1','active'),
          ('policy-request-project-a',?,'portal-policy-identity','request.create','allow','project','pa-project-a','project_alpha','entitlement-v1','active'),
          ('policy-request-project-b',?,'portal-policy-identity','request.create','allow','project','pa-project-b','project_alpha','entitlement-v1','active')`)
        .bind(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO pa_service_catalog_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('catalog-generation',?,'catalog-v1',1,?,1,3,'active',1)`).bind(sourceId, "c".repeat(64)),
      db.prepare(`UPDATE pa_service_catalog_checkpoint
        SET active_generation_id='catalog-generation',source_generation='catalog-v1',source_sequence=1
        WHERE source_id=?`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,category,display_order,source_updated_at,source_generation,source_sequence)
        VALUES (?,'root-service','service-v1','Root service','Mapping',1,datetime('now'),'catalog-v1',1),
          (?,'project-service','service-v1','Project service','Mapping',2,datetime('now'),'catalog-v1',1),
          (?,'project-service-2','service-v1','Second project service','Mapping',3,datetime('now'),'catalog-v1',1)`)
        .bind(sourceId, sourceId, sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_grants
        (source_id,capability,contract_version,state,created_by)
        VALUES (?,'portal.service-assignments.publish',1,'active','test')`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_workspaces(source_id,workspace_id,state,created_by)
        VALUES (?,?,'active','test')`).bind(sourceId, workspaceId),
      db.prepare(`INSERT INTO pa_service_assignment_source_capabilities
        (source_id,contract_version,state)
        VALUES (?,1,'supported')`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
        (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
        VALUES (?,1,'policy-review-primary','enabled','staff','test-operator','TEST-PRIMARY',
          'Explicitly approved for policy tests',datetime('now'))`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('assignment-generation',?,'assignments-v1',1,?,1,3,'active',1)`)
        .bind(sourceId, "a".repeat(64)),
      db.prepare(`INSERT INTO pa_service_assignments
        (source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
          service_source_version,active,source_updated_at,source_generation,source_sequence)
        VALUES (?,'assignment-root','assignment-v1','organization','pa-org-policy','root-service','service-v1',1,datetime('now'),'assignments-v1',1),
          (?,'assignment-project','assignment-v1','project','pa-project-a','project-service','service-v1',1,datetime('now'),'assignments-v1',1),
          (?,'assignment-project-2','assignment-v1','project','pa-project-a','project-service-2','service-v1',1,datetime('now'),'assignments-v1',1)`)
        .bind(sourceId, sourceId, sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_checkpoints
        (source_id,active_generation_id,source_generation,source_sequence)
        VALUES (?,'assignment-generation','assignments-v1',1)`).bind(sourceId),
    ]);
  }

  async function seedSecondaryPolicyContext() {
    const secondaryWorkspaceId = secondarySession.workspaceId!;
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_source_authorities
        (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,
          active_revision,version,connector_revision,connector_version)
        VALUES (?,'secondary-policy-binding','https://secondary-policy.example',
          '/api/internal/project-alpha/portal-v2','secondary_policy','pending',1,1,1,1)`)
        .bind(secondarySourceId),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions
        (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,
          current_key_id,current_key_fingerprint,created_by)
        VALUES (?,1,'secondary_policy_credentials','https://secondary-policy.example',
          'operations','secondary-policy-subject','secondary-policy-key',?,'test')`)
        .bind(secondarySourceId, "d".repeat(64)),
      db.prepare(`UPDATE pa_portal_source_authorities
        SET state='active',version=2,updated_at=datetime('now') WHERE source_id=?`).bind(secondarySourceId),
      db.prepare(`INSERT INTO pa_portal_workspace_sources
        (workspace_id,projection_source_id,source_workspace_id)
        VALUES (?,?,'shared-source-workspace')`).bind(secondaryWorkspaceId, secondarySourceId),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES (?,'organization','pa-org-policy','Secondary policy client','active',?)`)
        .bind(secondaryWorkspaceId, secondarySourceId),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('secondary-directory-1',?,'secondary-directory-v1',1,'active',1,datetime('now'))`)
        .bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'secondary-directory-1','organization','pa-org-policy',
          'Secondary policy client','secondary-directory-v1',1)`).bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version)
        VALUES ('secondary-directory-1',?,3)`).bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints
        (workspace_id,active_generation_id,source_sequence)
        VALUES (?,'secondary-directory-1',1)`).bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('secondary-policy-membership',?,'portal-policy-identity','project_alpha','active','secondary-member-v1')`)
        .bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO pa_portal_principals
        (workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES (?,'secondary-policy-principal','portal-policy-identity','policy@example.test',
          'Policy client','secondary-member-v1','active')`).bind(secondaryWorkspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES ('secondary-workspace-view',?,'portal-policy-identity','workspace.view','allow','workspace',?,
            'project_alpha','secondary-member-v1','active'),
          ('secondary-request-root',?,'portal-policy-identity','request.create','allow','organization','pa-org-policy',
            'project_alpha','secondary-member-v1','active')`)
        .bind(secondaryWorkspaceId, secondaryWorkspaceId, secondaryWorkspaceId),
      db.prepare(`INSERT INTO pa_service_catalog_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('secondary-catalog-generation',?,'secondary-catalog-v1',1,?,1,2,'active',1)`)
        .bind(secondarySourceId, "e".repeat(64)),
      db.prepare(`INSERT INTO pa_service_catalog_checkpoint
        (source_id,active_generation_id,source_generation,source_sequence)
        VALUES (?,'secondary-catalog-generation','secondary-catalog-v1',1)`).bind(secondarySourceId),
      db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,category,display_order,source_updated_at,source_generation,source_sequence)
        VALUES (?,'root-service','service-v1','Secondary colliding service','Mapping',1,datetime('now'),'secondary-catalog-v1',1),
          (?,'secondary-only','service-v1','Secondary-only service','Mapping',2,datetime('now'),'secondary-catalog-v1',1)`)
        .bind(secondarySourceId, secondarySourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_grants
        (source_id,capability,contract_version,state,created_by)
        VALUES (?,'portal.service-assignments.publish',1,'active','test')`).bind(secondarySourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_workspaces
        (source_id,workspace_id,state,created_by) VALUES (?,?,'active','test')`)
        .bind(secondarySourceId, secondaryWorkspaceId),
      db.prepare(`INSERT INTO pa_service_assignment_source_capabilities(source_id,contract_version,state)
        VALUES (?,1,'supported')`).bind(secondarySourceId),
      db.prepare(`INSERT INTO pa_service_assignment_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('secondary-assignment-generation',?,'secondary-assignments-v1',1,?,1,2,'active',1)`)
        .bind(secondarySourceId, "f".repeat(64)),
      db.prepare(`INSERT INTO pa_service_assignments
        (source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
          service_source_version,active,source_updated_at,source_generation,source_sequence)
        VALUES (?,'secondary-assignment-collision','assignment-v1','organization','pa-org-policy',
          'root-service','service-v1',1,datetime('now'),'secondary-assignments-v1',1),
          (?,'secondary-assignment-only','assignment-v1','organization','pa-org-policy',
          'secondary-only','service-v1',1,datetime('now'),'secondary-assignments-v1',1)`)
        .bind(secondarySourceId, secondarySourceId),
      db.prepare(`INSERT INTO pa_service_assignment_checkpoints
        (source_id,active_generation_id,source_generation,source_sequence)
        VALUES (?,'secondary-assignment-generation','secondary-assignments-v1',1)`).bind(secondarySourceId),
    ]);
  }

  async function enableSecondaryRequestPolicy() {
    await db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
      (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
      VALUES (?,1,'native-request-policy-review','enabled','staff','test-operator','TEST-NATIVE-REQUEST',
        'Explicit native request policy test',datetime('now'))`).bind(secondarySourceId).run();
  }

  it("keeps native request ownership, catalog collisions, replay, attachments, history, and cancellation source-qualified", async () => {
    await seedSecondaryPolicyContext();
    await enableSecondaryRequestPolicy();
    const services = await listNativeServiceCatalog(env, secondarySession, null);
    expect(services.map(item => [item.publicId, item.name])).toEqual([
      ["root-service", "Secondary colliding service"],
      ["secondary-only", "Secondary-only service"],
    ]);
    const input: ClientServiceRequestDraftInput = {
      projectId: null, requestType: "service", title: "Secondary source request", details: "Exact source request",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
      services: [{ publicId: "root-service", sourceVersion: "service-v1", answers: {} }],
    };
    const created = await createNativeServiceRequestDraft(env, secondarySession, input, "native-create-key-0001");
    expect(created).toMatchObject({ kind: "created", draft: { projectId: null, title: input.title } });
    if (!created || created.kind !== "created") throw new Error("native draft fixture unavailable");
    expect(await createNativeServiceRequestDraft(env, secondarySession, input, "native-create-key-0001"))
      .toMatchObject({ kind: "replayed", draft: { id: created.draft.id } });
    const owner = await db.prepare(`SELECT account_id,created_by_identity_id,catalog_source_id,portal_workspace_id,
        portal_identity_id FROM client_service_request_drafts WHERE id=?`).bind(created.draft.id)
      .first<{account_id:string;created_by_identity_id:string;catalog_source_id:string;portal_workspace_id:string;portal_identity_id:string}>();
    expect(owner).toMatchObject({ catalog_source_id: secondarySourceId, portal_workspace_id: secondarySession.workspaceId,
      portal_identity_id: secondarySession.nativePortalIdentityId });
    const binding = await db.prepare(`SELECT workspace_id,source_id,account_id,storage_identity_id,created_at
      FROM portal_native_request_storage_bindings WHERE workspace_id=?`).bind(secondarySession.workspaceId)
      .first<{workspace_id:string;source_id:string;account_id:string;storage_identity_id:string;created_at:string}>();
    expect(binding).not.toBeNull();
    await db.prepare(`UPDATE portal_native_request_storage_bindings
      SET state='suspended',updated_at=datetime('now') WHERE workspace_id=?`).bind(secondarySession.workspaceId).run();
    await db.prepare(`UPDATE portal_native_request_storage_bindings
      SET state='active',updated_at=datetime('now') WHERE workspace_id=?`).bind(secondarySession.workspaceId).run();
    await expect(db.prepare(`UPDATE portal_native_request_storage_bindings SET account_id='account-a'
      WHERE workspace_id=?`).bind(secondarySession.workspaceId).run()).rejects.toThrow(/ownership is immutable/);
    await expect(db.prepare(`UPDATE portal_native_request_storage_bindings SET created_at=datetime('now','+1 day')
      WHERE workspace_id=?`).bind(secondarySession.workspaceId).run()).rejects.toThrow(/ownership is immutable/);
    await expect(db.prepare(`DELETE FROM portal_native_request_storage_bindings WHERE workspace_id=?`)
      .bind(secondarySession.workspaceId).run()).rejects.toThrow(/cannot be deleted/);
    await expect(db.prepare(`INSERT OR REPLACE INTO portal_native_request_storage_bindings
      (workspace_id,source_id,account_id,storage_identity_id,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,datetime('now'))`).bind(binding!.workspace_id,binding!.source_id,
        binding!.account_id,binding!.storage_identity_id,'active',binding!.created_at).run())
      .rejects.toThrow(/ownership already exists/);
    await db.prepare(`INSERT INTO client_service_request_attachments
      (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,original_name,
       declared_size,content_type,status,actual_size,scanner_verdict,verified_sha256,scanned_at,expires_at)
      VALUES ('native-attachment',?,?,?,?,?,'upload-1','proof.pdf',100,'application/pdf','accepted',100,'clean',?,datetime('now'),datetime('now','+1 day'))`)
      .bind(created.draft.id, owner!.account_id, owner!.created_by_identity_id, "native-upload-key-0001",
        "_ltds/quarantine/request-attachments/native-attachment/object", "a".repeat(64)).run();
    expect((await listRequestAttachments(env, secondarySession, created.draft.id))?.map(row => row.id))
      .toEqual(["native-attachment"]);
    expect(await listRequestAttachments(env, session, created.draft.id)).toBeNull();
    const preRevocationProof = await resolveNativeRequestAuthority(env, secondarySession, null);
    expect(preRevocationProof).not.toBeNull();
    await db.prepare(`UPDATE pa_portal_principals SET status='suspended'
      WHERE workspace_id=? AND identity_id=?`).bind(secondarySession.workspaceId,
        secondarySession.nativePortalIdentityId).run();
    const postRevocationGuard = nativeRequestMutationGuardSql(preRevocationProof!);
    expect(await db.prepare(`SELECT ${postRevocationGuard.sql} ok`).bind(...postRevocationGuard.bindings)
      .first<number>("ok")).toBe(0);
    await db.prepare(`UPDATE pa_portal_principals SET status='active'
      WHERE workspace_id=? AND identity_id=?`).bind(secondarySession.workspaceId,
        secondarySession.nativePortalIdentityId).run();
    await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')
      WHERE id='secondary-request-root'`).run();
    expect(await createNativeServiceRequestDraft(env, secondarySession, input, "native-create-key-0002")).toBeNull();
    expect(await submitNativeServiceRequestDraft(env, secondarySession, created.draft.id, created.draft.version,
      "native-submit-key-0001")).toBeNull();
    await db.prepare(`UPDATE portal_v2_entitlements SET status='active',revoked_at=NULL
      WHERE id='secondary-request-root'`).run();
    const submitted = await submitNativeServiceRequestDraft(env, secondarySession, created.draft.id, created.draft.version,
      "native-submit-key-0001");
    expect(submitted).toMatchObject({ kind: "submitted", request: { title: input.title, status: "submitted" } });
    if (!submitted || submitted.kind !== "submitted") throw new Error("native request fixture unavailable");
    expect((await listNativeServiceRequests(env, secondarySession)).map(item => item.id)).toEqual([submitted.request.id]);
    expect(await cancelNativeServiceRequest(env, secondarySession, submitted.request.id, "native-cancel-key-0001"))
      .toMatchObject({ kind: "cancelled", request: { status: "cancelled" } });
    expect(await cancelNativeServiceRequest(env, secondarySession, submitted.request.id, "native-cancel-key-0001"))
      .toMatchObject({ kind: "replayed", request: { status: "cancelled" } });
  });

  async function submitNativeReceiptFixture(key: string) {
    await seedSecondaryPolicyContext();
    await enableSecondaryRequestPolicy();
    const input: ClientServiceRequestDraftInput = {
      projectId: null, requestType: "service", title: "Native receipt state", details: "Exact receipt only.",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
      services: [{ publicId: "root-service", sourceVersion: "service-v1", answers: {} }],
    };
    const draft = await createNativeServiceRequestDraft(env, secondarySession, input, `${key}-create`);
    if (!draft || draft.kind !== "created") throw new Error("native receipt fixture unavailable");
    const request = await submitNativeServiceRequestDraft(env, secondarySession, draft.draft.id, draft.draft.version, `${key}-submit`);
    if (!request || request.kind !== "submitted") throw new Error("native receipt request unavailable");
    return request.request.id;
  }

  async function seedNativeReceipt(requestId: string, options: { source?: string; stale?: boolean; area?: number } = {}) {
    const id = `native-command-${requestId}`;
    await db.prepare(`INSERT INTO request_pa_draft_quote_commands
        (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
        VALUES(?, ?, (SELECT MAX(revision_number) FROM request_revisions WHERE request_id=?), ?, ?, 'https://alpha.example/api/drafts','operations','https://alpha.example',?,?,?,'{}','staff-test')`)
      .bind(id, requestId, requestId, options.area ?? 0, options.source ?? secondarySourceId, "a".repeat(64), `key-${requestId}`, "b".repeat(64)).run();
    await db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,scope_stale_at,created_by,source_id,command_id)
        SELECT ?,request_id,request_revision,area_revision,idempotency_key,payload_hash,'receipt','draft','draft',1,'/drafts/draft',?,'staff-test',source_id,id
        FROM request_pa_draft_quote_commands WHERE id=?`)
      .bind(`native-receipt-${requestId}`, options.stale ? "2026-09-01T00:00:00.000Z" : null, id).run();
  }

  async function seedForeignPrimaryReceipt() {
    const requestId = "native-receipt-foreign-primary";
    await db.batch([
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id)
        VALUES(?, 'policy-account', NULL, 'policy-identity', 'service', 'Primary foreign receipt',
          'A valid record from the distinct primary source.', 'submitted', 'foreign-primary-receipt-key', ?, ?)`)
        .bind(requestId, "f".repeat(43), sourceId),
      db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES('native-receipt-foreign-primary-revision',?,1,'client','policy-identity','submitted','{}')`).bind(requestId),
    ]);
    await seedNativeReceipt(requestId, { source: sourceId });
    return requestId;
  }

  it.each(["current", "stale", "revision", "area", "wrong source"] as const)("derives native draft completion only for an exact current receipt: %s", async scenario => {
    const requestId = await submitNativeReceiptFixture(`native-receipt-${scenario.replaceAll(" ", "-")}`);
    if (scenario === "stale") await seedNativeReceipt(requestId, { stale: true });
    else if (scenario === "wrong source") await seedForeignPrimaryReceipt();
    else await seedNativeReceipt(requestId);
    if (scenario === "revision") await db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      VALUES(?,?,2,'staff','staff-test','staff_proposal','{}')`).bind(`native-revision-${requestId}`, requestId).run();
    if (scenario === "area") await db.prepare(`INSERT INTO client_service_request_area_revisions
      (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint)
      VALUES(?,?,1,'2026-08-01T00:00:00.000Z',NULL,'[]','Reviewed boundary','Changed area','staff-test',?,?)`)
      .bind(`native-area-${requestId}`, requestId, `native-area-key-${requestId}`, "c".repeat(64)).run();
    expect((await listNativeServiceRequests(env, secondarySession)).find(item => item.id === requestId)?.projectAlphaDraftCreated)
      .toBe(scenario === "current" ? true : undefined);
    if (scenario === "wrong source")
      expect((await listNativeServiceRequests(env, secondarySession)).some(item => item.id === "native-receipt-foreign-primary")).toBe(false);
  });

  it("composes native direct creation through the exact-source draft lifecycle and rejects ambiguous selections", async () => {
    await seedSecondaryPolicyContext();
    await enableSecondaryRequestPolicy();
    const portal = createClientPortalRouter({
      resolvePrincipal: async () => ({
        issuer: "https://issuer.test", subject: "policy-subject", email: "policy@example.test",
      }),
    });
    const requestEnv = {
      ...env,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: "https://client.example",
      PUBLIC_BULK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as Env;
    const headers = {
      Origin: "https://client.example",
      "Content-Type": "application/json",
      "Idempotency-Key": "native-direct-request-0001",
      "X-LTDS-Workspace-Id": secondarySession.workspaceId!,
    };
    const body = {
      projectId: null, requestType: "service" as const, title: "Native direct request", details: "Use exact source service",
      location: null, preferredStartAt: null,
      services: [{ publicId: "secondary-only", sourceVersion: "service-v1", answers: {} }],
    };
    const created = await portal.request("https://client.example/service-requests", {
      method: "POST", headers, body: JSON.stringify(body),
    }, requestEnv);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { request: { id: string } };
    const owner = await db.prepare(`SELECT catalog_source_id,portal_workspace_id,portal_identity_id
      FROM client_service_requests WHERE id=?`).bind(createdBody.request.id)
      .first<{ catalog_source_id: string; portal_workspace_id: string; portal_identity_id: string }>();
    expect(owner).toEqual({ catalog_source_id: secondarySourceId, portal_workspace_id: secondarySession.workspaceId,
      portal_identity_id: secondarySession.nativePortalIdentityId });

    const replayed = await portal.request("https://client.example/service-requests", {
      method: "POST", headers, body: JSON.stringify(body),
    }, requestEnv);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ request: { id: createdBody.request.id } });

    const missing = await portal.request("https://client.example/service-requests", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "native-direct-request-0002" },
      body: JSON.stringify({ ...body, services: undefined }),
    }, requestEnv);
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({
      error: "Select at least one service from this Project Alpha workspace before submitting.",
      code: "native_services_required",
    });
    const invalid = await portal.request("https://client.example/service-requests", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "native-direct-request-0003" },
      body: JSON.stringify({ ...body, services: [{ ...body.services[0], sourceVersion: "invalid version" }] }),
    }, requestEnv);
    expect(invalid.status).toBe(400);

    const crossSource = await portal.request("https://client.example/service-requests", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "native-direct-request-0004" },
      body: JSON.stringify({ ...body, services: [{ publicId: "project-service", sourceVersion: "service-v1", answers: {} }] }),
    }, requestEnv);
    expect(crossSource.status).toBe(409);
    expect(await crossSource.json()).toMatchObject({ code: "service_assignments_changed" });
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_requests WHERE portal_workspace_id=?")
      .bind(secondarySession.workspaceId).first<number>("count")).toBe(1);

    const primaryDowngrade = await portal.request("https://client.example/service-requests", {
      method: "POST",
      headers: {
        Origin: "https://client.example",
        "Content-Type": "application/json",
        "Idempotency-Key": "native-direct-request-0005",
      },
      body: JSON.stringify(body),
    }, { ...requestEnv, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" } as Env);
    expect(primaryDowngrade.status).toBe(400);
    expect(await primaryDowngrade.json()).toMatchObject({ code: "native_workspace_required" });
    expect(await d1ClientPortalRepository.createServiceRequest(env, session, {
      ...body,
      idempotencyKey: "native-direct-request-0005-repository",
      parentRequestId: null,
    })).toBeNull();

    await db.prepare(`UPDATE pa_service_catalog_items SET geometry_requirement='required'
      WHERE source_id=? AND public_id='secondary-only'`).bind(secondarySourceId).run();
    const blocked = await portal.request("https://client.example/service-requests", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "native-direct-request-0006" },
      body: JSON.stringify(body),
    }, requestEnv);
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ code: "geometry_required", servicePublicIds: ["secondary-only"] });
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_request_drafts WHERE portal_workspace_id=?")
      .bind(secondarySession.workspaceId).first<number>("count")).toBe(1);

    await db.prepare(`UPDATE pa_service_catalog_items SET geometry_requirement='optional',question_schema_json=?
      WHERE source_id=? AND public_id='secondary-only'`).bind(JSON.stringify([{
        id: "instructions", label: "Instructions", type: "text", required: true,
      }]), secondarySourceId).run();
    const invalidAnswers = await portal.request("https://client.example/service-requests", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "native-direct-request-0007" },
      body: JSON.stringify(body),
    }, requestEnv);
    expect(invalidAnswers.status).toBe(422);
    expect(await invalidAnswers.json()).toMatchObject({
      code: "answers_incomplete", servicePublicIds: ["secondary-only"],
    });
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_request_drafts WHERE portal_workspace_id=?")
      .bind(secondarySession.workspaceId).first<number>("count")).toBe(1);
  }, 120_000);

  it("lists and counts only exact-recipient service-request notifications for the active native source", async () => {
    await seedSecondaryPolicyContext();
    await enableSecondaryRequestPolicy();
    const direct = await d1ClientPortalRepository.createServiceRequest(env, secondarySession, {
      idempotencyKey: "native-notification-request-0001", projectId: null, requestType: "service",
      title: "Secondary notification request", details: "Keep the notification source-qualified",
      location: null, preferredStartAt: null,
      services: [{ publicId: "secondary-only", sourceVersion: "service-v1", answers: {} }],
    });
    if (!direct || !("request" in direct)) throw new Error("native request was not created");
    const nativeOwner = await db.prepare(`SELECT account_id,created_by_identity_id FROM client_service_requests WHERE id=?`)
      .bind(direct.request.id).first<{ account_id: string; created_by_identity_id: string }>();
    await db.batch([
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,catalog_source_id,
          idempotency_key,request_fingerprint)
        VALUES ('primary-notification-request','policy-account',NULL,'policy-identity','service','Primary request',
          'Primary notification fixture','submitted',?,'primary-notification-request-key',?)`).bind(sourceId, "p".repeat(43)),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES ('primary-notice','policy-account','policy-identity','request_status','service_request',
          'primary-notification-request','primary-notice','Primary update','Primary body','/portal/requests')`),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES ('secondary-notice',?,?, 'request_status','service_request',?,'secondary-notice',
          'Secondary update','Secondary body','/portal/requests')`)
        .bind(nativeOwner!.account_id, nativeOwner!.created_by_identity_id, direct.request.id),
    ]);
    expect(await d1ClientPortalRepository.listNotifications(env, session)).toMatchObject({
      notifications: [{ id: "primary-notice" }], unreadCount: 1,
    });
    expect(await d1ClientPortalRepository.listNotifications(env, secondarySession)).toMatchObject({
      notifications: [{ id: "secondary-notice" }], unreadCount: 1,
    });
    const portal = createClientPortalRouter({ resolvePrincipal: async () => ({
      issuer: "https://issuer.test", subject: "policy-subject", email: "policy@example.test",
    }) });
    const requestEnv = { ...env, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example" } as Env;
    const mutation = (id: string, action: "read" | "dismiss") => portal.request(
      `https://client.example/notifications/${id}`,
      { method: "PATCH", headers: { Origin: "https://client.example", "Content-Type": "application/json",
        "X-LTDS-Workspace-Id": secondarySession.workspaceId! }, body: JSON.stringify({ action }) }, requestEnv,
    );
    expect((await mutation("secondary-notice", "read")).status).toBe(200);
    expect(await db.prepare("SELECT read_at IS NOT NULL value FROM client_portal_notifications WHERE id='secondary-notice'")
      .first<number>("value")).toBe(1);
    expect((await mutation("primary-notice", "dismiss")).status).toBe(404);
    expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id='primary-notice'")
      .first<string | null>("dismissed_at")).toBeNull();
    expect((await mutation("secondary-notice", "dismiss")).status).toBe(200);
    expect(await d1ClientPortalRepository.listNotifications(env, secondarySession)).toMatchObject({
      notifications: [], unreadCount: 0,
    });
  });

  it("fails explicitly instead of reporting zero native notifications beyond the safe authority bound", async () => {
    await seedSecondaryPolicyContext();
    await enableSecondaryRequestPolicy();
    const direct = await d1ClientPortalRepository.createServiceRequest(env, secondarySession, {
      idempotencyKey: "native-notification-overflow-owner", projectId: null, requestType: "service",
      title: "Establish native storage", details: "Create the exact-source storage owner",
      location: null, preferredStartAt: null,
      services: [{ publicId: "secondary-only", sourceVersion: "service-v1", answers: {} }],
    });
    if (!direct || !("request" in direct)) throw new Error("native request was not created");
    const owner = await db.prepare(`SELECT account_id,created_by_identity_id FROM client_service_requests WHERE id=?`)
      .bind(direct.request.id).first<{ account_id: string; created_by_identity_id: string }>();
    await db.prepare(`WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<201
      ) INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      SELECT ?,'secondary-directory-1','project','overflow-project-' || value,'pa-org-policy',
        'Overflow project ' || value,'overflow-project-v1',1 FROM sequence`)
      .bind(secondarySession.workspaceId).run();
    await db.prepare(`WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<201
      ) INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,catalog_source_id,
          idempotency_key,request_fingerprint,portal_workspace_id,portal_identity_id,portal_project_public_id)
      SELECT 'overflow-request-' || value,?,NULL,?,'service','Overflow fixture','Authority bound fixture',
        'submitted',?,'overflow-idempotency-key-' || value,?, ?,?,'overflow-project-' || value FROM sequence`)
      .bind(owner!.account_id, owner!.created_by_identity_id, secondarySourceId, "o".repeat(43),
        secondarySession.workspaceId, secondarySession.nativePortalIdentityId).run();
    await expect(d1ClientPortalRepository.listNotifications(env, secondarySession))
      .rejects.toBeInstanceOf(NativeNotificationAuthorizationOverflowError);
  });

  it("returns an explicit not-yet-available response for unsupported native submitted-request mutations", async () => {
    await seedSecondaryPolicyContext();
    const portal = createClientPortalRouter({
      resolvePrincipal: async () => ({
        issuer: "https://issuer.test", subject: "policy-subject", email: "policy@example.test",
      }),
    });
    const requestEnv = {
      ...env, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example",
    } as Env;
    const headers = { Origin: "https://client.example", "X-LTDS-Workspace-Id": secondarySession.workspaceId! };
    const mutations = [
      ["PATCH", "/service-requests/native-request", { "Content-Type": "application/json" }, {}],
      ["POST", "/service-requests/native-request/change-request", { "Content-Type": "application/json" }, {}],
      ["POST", "/service-requests/native-request/estimate-response", { "Content-Type": "application/json" }, {}],
    ] as const;
    for (const [method, path, extra, body] of mutations) {
      const response = await portal.request(`https://client.example${path}`, {
        method, headers: { ...headers, ...extra }, body: JSON.stringify(body),
      }, requestEnv);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "native_operation_unavailable" });
    }
  });

  it("invalidates one attachment authority proof across every native revocation and generation boundary", async () => {
    await seedSecondaryPolicyContext();
    const proof = await resolveNativeRequestAuthority(env, secondarySession, null);
    expect(proof).not.toBeNull();
    const current = async () => {
      const guard = nativeRequestMutationGuardSql(proof!);
      return db.prepare(`SELECT ${guard.sql} ok`).bind(...guard.bindings).first<number>("ok");
    };
    expect(await current()).toBe(1);

    await db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id=?")
      .bind(secondarySession.workspaceId).run();
    expect(await current(), "principal suspension").toBe(0);
    await db.prepare("UPDATE pa_portal_principals SET status='active' WHERE workspace_id=?")
      .bind(secondarySession.workspaceId).run();

    await db.prepare("UPDATE portal_v2_workspace_memberships SET expires_at=datetime('now','-1 minute') WHERE id='secondary-policy-membership'").run();
    expect(await current(), "membership expiry").toBe(0);
    await db.prepare("UPDATE portal_v2_workspace_memberships SET expires_at=NULL,status='revoked',revoked_at=datetime('now') WHERE id='secondary-policy-membership'").run();
    expect(await current(), "membership revocation").toBe(0);
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='active',revoked_at=NULL WHERE id='secondary-policy-membership'").run();

    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='secondary-request-root'").run();
    expect(await current(), "allow revocation").toBe(0);
    await db.prepare("UPDATE portal_v2_entitlements SET status='active',revoked_at=NULL WHERE id='secondary-request-root'").run();
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
      VALUES ('secondary-request-deny',?,'portal-policy-identity','request.create','deny','organization','pa-org-policy',
        'operations','deny-v1','active')`).bind(secondarySession.workspaceId).run();
    expect(await current(), "live deny").toBe(0);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='secondary-request-deny'").run();

    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('secondary-directory-2',?,'secondary-directory-v2',2,'active',1,datetime('now'))`)
        .bind(secondarySession.workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'secondary-directory-2','organization','pa-org-policy','Secondary policy client','secondary-directory-v2',1)`)
        .bind(secondarySession.workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES ('secondary-directory-2',?,3)`).bind(secondarySession.workspaceId),
      db.prepare(`UPDATE portal_v2_directory_checkpoints SET active_generation_id='secondary-directory-2',source_sequence=2
        WHERE workspace_id=?`).bind(secondarySession.workspaceId),
    ]);
    expect(await current(), "directory generation rotation").toBe(0);

    const rotatedProof = await resolveNativeRequestAuthority(env, secondarySession, null);
    expect(rotatedProof).not.toBeNull();
    const rotatedGuard = nativeRequestMutationGuardSql(rotatedProof!);
    await db.prepare("UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id=?")
      .bind(secondarySourceId).run();
    expect(await db.prepare(`SELECT ${rotatedGuard.sql} ok`).bind(...rotatedGuard.bindings).first<number>("ok"),
      "source authority suspension").toBe(0);
  });

  it("records and consumes a native part-ticket lease and rejects every stale lifecycle mutation", async () => {
    await seedSecondaryPolicyContext();
    await db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
      (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
      VALUES (?,1,'native-attachment-policy-review','enabled','staff','test-operator','TEST-NATIVE-ATTACHMENT',
        'Native attachment authority test',datetime('now'))`).bind(secondarySourceId).run();
    const input: ClientServiceRequestDraftInput = {
      projectId: null, requestType: "service", title: "Attachment authority", details: "Native attachment race proof",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
      services: [{ publicId: "root-service", sourceVersion: "service-v1", answers: {} }],
    };
    const created = await createNativeServiceRequestDraft(env, secondarySession, input, "native-attachment-create-0001");
    expect(created).toMatchObject({ kind: "created" });
    if (!created || created.kind !== "created") throw new Error("native attachment draft unavailable");
    const initialized = await initializeRequestAttachment(env, secondarySession, created.draft.id, {
      clientUploadId: "native-attachment-upload-0001", name: "proof.pdf", contentType: "application/pdf", size: 10,
    });
    const authorized = await getAuthorizedRequestAttachmentContext(env, secondarySession, created.draft.id, initialized.row.id);
    if (!authorized?.nativeProof) throw new Error("native attachment authority unavailable");

    const first = await issueNativeRequestAttachmentPartLease(env, authorized.row, authorized.nativeProof, 1);
    expect(first).not.toBeNull();
    expect((await issueNativeRequestAttachmentPartLease(env, authorized.row, authorized.nativeProof, 1))?.nonce)
      .toBe(first!.nonce);
    const etag = "a".repeat(32);
    expect(await checkpointRequestAttachment(env, authorized.row, 1, etag, 10,
      { proof: authorized.nativeProof, ticketNonce: first!.nonce })).toEqual({ partNumber: 1, etag, size: 10 });
    expect(await db.prepare(`SELECT consumed_at IS NOT NULL consumed FROM portal_native_request_attachment_part_tickets
      WHERE attachment_id=? AND part_number=1`).bind(authorized.row.id).first("consumed")).toBe(1);
    const rotated = await issueNativeRequestAttachmentPartLease(env, authorized.row, authorized.nativeProof, 1);
    expect(rotated?.nonce).not.toBe(first!.nonce);

    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='secondary-request-root'").run();
    await expect(checkpointRequestAttachment(env, authorized.row, 1, etag, 10,
      { proof: authorized.nativeProof, ticketNonce: rotated!.nonce })).rejects.toMatchObject({ status: 409 });
    expect(await db.prepare(`SELECT consumed_at FROM portal_native_request_attachment_part_tickets
      WHERE attachment_id=? AND part_number=1 AND nonce=?`).bind(authorized.row.id, rotated!.nonce).first("consumed_at"))
      .toBeNull();
    await expect(completeRequestAttachment(env, authorized.row, [{ partNumber: 1, etag }], authorized.nativeProof))
      .rejects.toMatchObject({ status: 409 });
    await expect(abortRequestAttachment(env, authorized.row, authorized.nativeProof)).rejects.toMatchObject({ status: 409 });
    expect(await db.prepare("SELECT status FROM client_service_request_attachments WHERE id=?")
      .bind(authorized.row.id).first("status")).toBe("uploading");

    await db.prepare("UPDATE portal_v2_entitlements SET status='active',revoked_at=NULL WHERE id='secondary-request-root'").run();
    expect(await abortRequestAttachment(env, authorized.row, authorized.nativeProof)).toEqual({ idempotent: false });
    expect(await db.prepare("SELECT status FROM client_service_request_attachments WHERE id=?")
      .bind(authorized.row.id).first("status")).toBe("aborted");
  });

  it("fails closed when native authority changes while multipart completion awaits R2", async () => {
    await seedSecondaryPolicyContext();
    await db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
      (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
      VALUES (?,1,'native-completion-race-review','enabled','staff','test-operator','TEST-NATIVE-COMPLETION',
        'Native completion authority race test',datetime('now'))`).bind(secondarySourceId).run();
    const originalBucket = env.DATA_BUCKET;
    const pdfPrefix = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 0, 0]);
    const cases = [
      {
        name: "principal suspension",
        revoke: () => db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id=?")
          .bind(secondarySession.workspaceId).run(),
        restore: () => db.prepare("UPDATE pa_portal_principals SET status='active' WHERE workspace_id=?")
          .bind(secondarySession.workspaceId).run(),
      },
      {
        name: "source authority version rotation",
        revoke: () => db.prepare("UPDATE pa_portal_source_authorities SET version=version+1 WHERE source_id=?")
          .bind(secondarySourceId).run(),
        restore: async () => undefined,
      },
      {
        name: "entitlement revocation",
        revoke: () => db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='secondary-request-root'").run(),
        restore: () => db.prepare("UPDATE portal_v2_entitlements SET status='active',revoked_at=NULL WHERE id='secondary-request-root'").run(),
      },
      {
        name: "directory generation rotation",
        revoke: () => db.batch([
          db.prepare(`INSERT INTO portal_v2_directory_generations
            (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
            VALUES ('secondary-completion-directory-2',?,'secondary-completion-v2',2,'active',1,datetime('now'))`)
            .bind(secondarySession.workspaceId),
          db.prepare(`INSERT INTO portal_v2_directory_entities
            (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
            VALUES (?,'secondary-completion-directory-2','organization','pa-org-policy','Secondary policy client','secondary-completion-v2',1)`)
            .bind(secondarySession.workspaceId),
          db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
            VALUES ('secondary-completion-directory-2',?,3)`).bind(secondarySession.workspaceId),
          db.prepare(`UPDATE portal_v2_directory_checkpoints
            SET active_generation_id='secondary-completion-directory-2',source_sequence=2 WHERE workspace_id=?`)
            .bind(secondarySession.workspaceId),
        ]),
        restore: async () => undefined,
      },
    ];

    for (const [index, boundary] of cases.entries()) {
      env.DATA_BUCKET = originalBucket;
      const input: ClientServiceRequestDraftInput = {
        projectId: null, requestType: "service", title: `Completion race ${index}`, details: boundary.name,
        location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
        siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
        services: [{ publicId: "root-service", sourceVersion: "service-v1", answers: {} }],
      };
      const created = await createNativeServiceRequestDraft(env, secondarySession, input, `native-completion-create-${index}`);
      if (!created || created.kind !== "created") throw new Error(`native completion fixture unavailable: ${boundary.name}`);
      const initialized = await initializeRequestAttachment(env, secondarySession, created.draft.id, {
        clientUploadId: `native-completion-upload-${index}`, name: `proof-${index}.pdf`, contentType: "application/pdf", size: 10,
      });
      const authorized = await getAuthorizedRequestAttachmentContext(env, secondarySession, created.draft.id, initialized.row.id);
      if (!authorized?.nativeProof) throw new Error(`native completion authority unavailable: ${boundary.name}`);
      const lease = await issueNativeRequestAttachmentPartLease(env, authorized.row, authorized.nativeProof, 1);
      const etag = String(index + 1).repeat(32);
      await checkpointRequestAttachment(env, authorized.row, 1, etag, 10,
        { proof: authorized.nativeProof, ticketNonce: lease!.nonce });

      let deleted = 0;
      env.DATA_BUCKET = {
        resumeMultipartUpload(key: string, uploadId: string) {
          return { key, uploadId, async abort() {}, async uploadPart() {}, async complete() {
            if (index !== 0) await boundary.revoke();
            return { size: 10, etag } as R2Object;
          } };
        },
        async get() {
          if (index === 0) {
            await boundary.revoke();
            throw new Error("probe failed after authority revocation");
          }
          return { arrayBuffer: async () => pdfPrefix.buffer } as R2ObjectBody;
        },
        async delete() { deleted += 1; },
      } as unknown as R2Bucket;
      await expect(completeRequestAttachment(env, authorized.row, [{ partNumber: 1, etag }], authorized.nativeProof),
        boundary.name).rejects.toMatchObject({ status: 409 });
      expect(await db.prepare(`SELECT status,completion_claimed_at,completed_at
        FROM client_service_request_attachments WHERE id=?`).bind(authorized.row.id).first(), boundary.name)
        .toMatchObject({ status: "uploading", completion_claimed_at: null, completed_at: null });
      expect(await db.prepare(`SELECT COUNT(*) count FROM client_service_request_attachment_parts WHERE attachment_id=?`)
        .bind(authorized.row.id).first("count"), boundary.name).toBe(1);
      expect(deleted, boundary.name).toBe(1);
      await boundary.restore();
    }
    env.DATA_BUCKET = originalBucket;
  }, 120_000);

  it("is default-off and refuses retained facts whenever any receiver prerequisite is off", async () => {
    expect(await readServiceAssignmentPolicy({ ...env,
      CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "false" }, session, null))
      .toEqual({ state: "disabled", proof: null, assignedServiceCount: null });

    for (const missing of [
      "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED",
      "CLIENT_PORTAL_REQUEST_V2_ENABLED",
      "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
      "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED",
    ] as const) {
      expect(await readServiceAssignmentPolicy({ ...env, [missing]: "false" }, session, null))
        .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    }
  });

  it("uses only the exact root or exact project assignment without inheritance", async () => {
    const root = await readServiceAssignmentPolicy(env, session, null);
    expect(root).toMatchObject({ state: "ready", assignedServiceCount: 1,
      proof: { subjectType: "organization", subjectPublicId: "pa-org-policy", localProjectId: null } });
    const project = await readServiceAssignmentPolicy(env, session, "project-a");
    expect(project).toMatchObject({ state: "ready", assignedServiceCount: 2,
      proof: { subjectType: "project", subjectPublicId: "pa-project-a", localProjectId: "project-a" } });
    expect(await readServiceAssignmentPolicy(env, session, "project-b"))
      .toMatchObject({ state: "no_services_assigned", assignedServiceCount: 0,
        proof: { subjectPublicId: "pa-project-b" } });

    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: null }, session)).services.map(service => service.publicId)).toEqual(["root-service"]);
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a" }, session)).services.map(service => service.publicId))
      .toEqual(["project-service", "project-service-2"]);
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-b" }, session)).services).toEqual([]);
  });

  it("binds continuation to the original actor and exact project", async () => {
    const first = await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1 }, session);
    expect(first.nextCursor).not.toBeNull();
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1, cursor: first.nextCursor! }, session)).services)
      .toHaveLength(1);

    await expect(listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1, cursor: first.nextCursor! },
      { ...session, identityId: "different-identity" })).rejects
      .toMatchObject({ status: 409, code: "catalog_changed" });
    await expect(listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-b", limit: 1, cursor: first.nextCursor! }, session)).rejects
      .toMatchObject({ status: 409, code: "catalog_changed" });
  });

  it("invalidates proofs on enrollment, directory mapping, or policy rollback", async () => {
    const decision = await readServiceAssignmentPolicy(env, session, "project-a");
    expect(decision.state).toBe("ready");
    if (decision.state !== "ready") throw new Error("policy fixture unavailable");
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(true);

    await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
      WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(false);
    await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='active'
      WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env,
      { ...decision.proof, localProjectId: "project-b" })).toBe(false);
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('directory-2',?,'directory-generation-2',2,'active',1,datetime('now'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'directory-2','organization','pa-org-policy','Policy client','directory-v2',1),
          (?,'directory-2','project','pa-project-a','Project A','directory-v2',1),
          (?,'directory-2','project','pa-project-b','Project B','directory-v2',1)`)
        .bind(workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version) VALUES ('directory-2',?,3)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,'directory-2','contains-a-v2','contains','organization','pa-org-policy','project','pa-project-a','directory-v2',1),
          (?,'directory-2','contains-b-v2','contains','organization','pa-org-policy','project','pa-project-b','directory-v2',1)`)
        .bind(workspaceId, workspaceId),
      db.prepare(`UPDATE portal_v2_directory_checkpoints
        SET active_generation_id='directory-2',source_sequence=2 WHERE workspace_id=?`).bind(workspaceId),
    ]);
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(false);
    expect(await serviceAssignmentPolicyProofStillCurrent({ ...env,
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "false" }, decision.proof)).toBe(false);
  });

  it("reports a checkpoint race as unavailable rather than as no assigned services", async () => {
    let interleaved = false;
    const deliveryDatabase = new Proxy(db, {
      get(target, property) {
        if (property !== "withSession") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (constraint?: D1SessionBookmark | D1SessionConstraint) => {
          const current = target.withSession(constraint);
          return new Proxy(current, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty !== "prepare") {
                const value = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
                return typeof value === "function" ? value.bind(sessionTarget) : value;
              }
              return (sql: string) => {
                const statement = sessionTarget.prepare(sql);
                if (!sql.includes("COUNT(DISTINCT catalog.public_id)")) return statement;
                return new Proxy(statement, {
                  get(statementTarget, statementProperty) {
                    if (statementProperty !== "bind") {
                      const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                      return typeof value === "function" ? value.bind(statementTarget) : value;
                    }
                    return (...bindings: unknown[]) => {
                      const bound = statementTarget.bind(...bindings);
                      return new Proxy(bound, {
                        get(boundTarget, boundProperty) {
                          if (boundProperty !== "first") {
                            const value = Reflect.get(boundTarget, boundProperty, boundTarget);
                            return typeof value === "function" ? value.bind(boundTarget) : value;
                          }
                          return async <T>(column?: string) => {
                            const result = column === undefined
                              ? await boundTarget.first<T>()
                              : await boundTarget.first<T>(column);
                            if (!interleaved) {
                              interleaved = true;
                              await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
                                WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
                            }
                            return result;
                          };
                        },
                      });
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    expect(await readServiceAssignmentPolicy({ ...env, DELIVERY_DB: deliveryDatabase }, session, "project-a"))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    expect(interleaved).toBe(true);
  });

  it("persists an exact proof and atomically rolls back an enrollment race", async () => {
    const input: ClientServiceRequestDraftInput = {
      projectId: "project-a",
      requestType: "service",
      title: "Exact project request",
      details: "Request details",
      location: null,
      preferredStartAt: null,
      deliverables: null,
      siteContactName: null,
      siteContactEmail: null,
      siteContactPhone: null,
      desiredCompletionAt: null,
      latitude: null,
      longitude: null,
      areaGeoJson: null,
      poiPoints: [],
      services: [{ publicId: "project-service", sourceVersion: "service-v1", answers: {} }],
    };
    const requestAuthority = await readEffectiveWorkspaceRequestProof(env, {
      issuer: session.principalIssuer!, subject: session.principalSubject!, email: session.principalEmail!,
    }, workspaceId, "project-a");
    expect(requestAuthority).toMatchObject({ projectAllowed: true,
      mutationProof: { workspaceId, localProjectId: "project-a", projectPublicId: "pa-project-a" } });
    const requestGuard = effectiveWorkspaceRequestMutationGuardSql(requestAuthority!.mutationProof);
    expect(requestGuard.sql).toContain("portal_v2_root_access_policies");
    expect(requestGuard.sql).toContain("root_policy.state='revoked'");
    expect(await db.prepare(`SELECT ${requestGuard.sql} allowed`).bind(...requestGuard.bindings).first<number>("allowed")).toBe(1);
    await db.prepare(`INSERT INTO portal_v2_root_access_policies
      (projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
      VALUES (?,'organization','pa-org-policy','revoked','security_concern','staff-one','staff-one')`).bind(sourceId).run();
    expect(await db.prepare(`SELECT ${requestGuard.sql} allowed`).bind(...requestGuard.bindings).first<number>("allowed")).toBe(0);
    await db.prepare(`UPDATE portal_v2_root_access_policies SET state='active',version=version+1,
      reason_code='restored',updated_by_staff_id='staff-one',updated_at=datetime('now')
      WHERE projection_source_id=? AND root_type='organization' AND root_public_id='pa-org-policy'`).bind(sourceId).run();
    const created = await createServiceRequestDraft(env, session, input, "policy-create-key-0001");
    expect(created?.kind).toBe("created");
    const stored = await db.prepare(`SELECT service_assignment_policy_v2_json proof
      FROM client_service_request_drafts WHERE create_idempotency_key='policy-create-key-0001'`)
      .first<string>("proof");
    const persistedProof = JSON.parse(stored!);
    expect(persistedProof).toEqual({
      version: 2, sourceId, reviewId: "policy-review-primary", reviewRevision: 1,
      workspaceId, localProjectId: "project-a", subjectType: "project",
      subjectPublicId: "pa-project-a", generationId: "assignment-generation",
      sourceGeneration: "assignments-v1", sourceSequence: 1,
      directoryGenerationId: "directory-1", directorySourceSequence: 1,
      evaluatedAt: expect.any(String), expiresAt: expect.any(String),
    });
    expect(Object.keys(persistedProof)).toEqual([
      "version", "sourceId", "reviewId", "reviewRevision", "workspaceId", "localProjectId",
      "subjectType", "subjectPublicId", "generationId", "sourceGeneration", "sourceSequence",
      "directoryGenerationId", "directorySourceSequence", "evaluatedAt", "expiresAt",
    ]);
    expect(await db.prepare(`SELECT service_assignment_policy_json FROM client_service_request_drafts
      WHERE create_idempotency_key='policy-create-key-0001'`).first<string>("service_assignment_policy_json"))
      .toBeNull();
    await expect(db.prepare(`UPDATE client_service_request_drafts
      SET service_assignment_policy_v2_json=json_remove(service_assignment_policy_v2_json,'$.reviewId')
      WHERE create_idempotency_key='policy-create-key-0001'`).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE client_service_request_drafts
      SET service_assignment_policy_v2_json=json_set(service_assignment_policy_v2_json,'$.localProjectId',NULL)
      WHERE create_idempotency_key='policy-create-key-0001'`).run()).rejects.toThrow();
    if (!created || !("draft" in created)) throw new Error("expected created draft");
    const saved = await saveServiceRequestDraft(env, session, created.draft.id, created.draft.version,
      { ...input, title: "Updated exact project request" }, "policy-save-key-0001");
    expect(saved?.kind).toBe("updated");
    if (!saved || !("draft" in saved)) throw new Error("expected updated draft");
    const submitted = await submitServiceRequestDraft(env, session, saved.draft.id, saved.draft.version,
      "policy-submit-key-0001");
    expect(submitted?.kind).toBe("submitted");
    expect(await db.prepare(`SELECT count(*) count FROM client_service_requests
      WHERE service_assignment_policy_v2_json IS NOT NULL AND service_assignment_policy_json IS NULL`)
      .first<number>("count")).toBe(1);
    expect(JSON.parse((await db.prepare(`SELECT service_assignment_policy_v2_json proof
      FROM client_service_requests`).first<string>("proof"))!)).toMatchObject({
        version: 2, sourceId, reviewId: "policy-review-primary", reviewRevision: 1,
      });

    let pending = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "withSession") return () => wrapped;
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
              WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const raced = await createServiceRequestDraft({ ...env, DELIVERY_DB: wrapped }, session, input,
      "policy-create-key-raced");
    expect(raced).toEqual({ kind: "service_assignments_changed", servicePublicIds: ["project-service"] });
    expect(await db.prepare(`SELECT count(*) count FROM client_service_request_drafts
      WHERE create_idempotency_key='policy-create-key-raced'`).first<number>("count")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("atomically rejects workspace suspension, identity denial, and request.create revocation races", async () => {
    const input: ClientServiceRequestDraftInput = {
      projectId: "project-a", requestType: "service", title: "Authority race request", details: "Request details",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null,
      poiPoints: [], services: [{ publicId: "project-service", sourceVersion: "service-v1", answers: {} }],
    };
    function databaseWithOneInterleave(action: () => Promise<unknown>): D1Database {
      let pending = true;
      let wrapped: D1Database;
      wrapped = new Proxy(db, {
        get(target, property) {
          if (property === "withSession") return () => wrapped;
          if (property === "batch") return async (statements: D1PreparedStatement[]) => {
            if (pending) { pending = false; await action(); }
            return target.batch(statements);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return wrapped;
    }

    const suspended = await createServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`UPDATE portal_v2_workspaces SET status='suspended' WHERE id=?`).bind(workspaceId).run()) },
    session, input, "authority-race-create");
    expect(suspended).toEqual({ kind: "service_assignments_changed", servicePublicIds: ["project-service"] });
    expect(await db.prepare(`SELECT COUNT(*) count FROM client_service_request_drafts
      WHERE create_idempotency_key='authority-race-create'`).first<number>("count")).toBe(0);
    await db.prepare(`UPDATE portal_v2_workspaces SET status='active' WHERE id=?`).bind(workspaceId).run();

    const created = await createServiceRequestDraft(env, session, input, "authority-race-seed");
    if (!created || !("draft" in created)) throw new Error("expected authority race draft");
    const denied = await saveServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`INSERT INTO portal_v2_identity_denials
        (id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES ('authority-race-deny','portal-policy-identity',?,'project','pa-project-a','test_race','system','test')`)
        .bind(workspaceId).run()) }, session, created.draft.id, created.draft.version,
    { ...input, title: "Denied while saving" }, "authority-race-save");
    expect(denied).toEqual({ kind: "conflict" });
    expect((await db.prepare(`SELECT version FROM client_service_request_drafts WHERE id=?`)
      .bind(created.draft.id).first<number>("version"))).toBe(created.draft.version);
    await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),
      revoked_by_actor_type='system',revoked_by_actor_id='test' WHERE id='authority-race-deny'`).run();

    const revoked = await submitServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')
        WHERE id IN ('policy-request-project-a','policy-request-root')`).run()) }, session, created.draft.id, created.draft.version,
    "authority-race-submit");
    expect(revoked).toEqual({ kind: "conflict" });
    expect(await db.prepare(`SELECT COUNT(*) count FROM client_service_requests
      WHERE id=(SELECT submitted_request_id FROM client_service_request_drafts WHERE id=?)`)
      .bind(created.draft.id).first<number>("count")).toBe(0);
    expect(await db.prepare(`SELECT state FROM client_service_request_drafts WHERE id=?`)
      .bind(created.draft.id).first<string>("state")).toBe("draft");
  });

  it("rejects expired caller windows instead of treating them as an empty assignment set", async () => {
    const evaluatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(await readServiceAssignmentPolicy(env, session, "project-a", { evaluatedAt, expiresAt }))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
  });

  it("routes colliding assignments by exact source and revokes secondary authority independently", async () => {
    await seedSecondaryPolicyContext();
    expect(await readServiceAssignmentPolicy(env, secondarySession, null))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });

    await db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
      (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
      VALUES (?,1,'policy-review-secondary','enabled','staff','test-operator','TEST-SECONDARY',
        'Explicitly approved secondary source',datetime('now'))`).bind(secondarySourceId).run();
    const primary = await readServiceAssignmentPolicy(env, session, null);
    const secondary = await readServiceAssignmentPolicy(env, secondarySession, null);
    expect(primary).toMatchObject({ state: "ready", assignedServiceCount: 1,
      proof: { sourceId, reviewId: "policy-review-primary", reviewRevision: 1 } });
    expect(secondary).toMatchObject({ state: "ready", assignedServiceCount: 2,
      proof: { sourceId: secondarySourceId, reviewId: "policy-review-secondary", reviewRevision: 1 } });
    if (secondary.state !== "ready") throw new Error("secondary policy fixture unavailable");

    await db.prepare(`UPDATE pa_portal_source_authorities
      SET state='suspended',version=3,updated_at=datetime('now') WHERE source_id=?`).bind(secondarySourceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env, secondary.proof)).toBe(false);
    expect(await readServiceAssignmentPolicy(env, secondarySession, null))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    expect(await readServiceAssignmentPolicy(env, session, null)).toMatchObject({ state: "ready", assignedServiceCount: 1 });
  });

  it("requires the latest append-only review and never turns assignments into request authority", async () => {
    const decision = await readServiceAssignmentPolicy(env, session, null);
    expect(decision).toMatchObject({ state: "ready", assignedServiceCount: 1 });
    if (decision.state !== "ready") throw new Error("primary policy fixture unavailable");
    expect(await serviceAssignmentPolicyProofStillCurrent(env,
      { ...decision.proof, reviewId: undefined as unknown as string })).toBe(false);
    const requestAuthority = await readEffectiveWorkspaceRequestProof(env, {
      issuer: session.principalIssuer!, subject: session.principalSubject!, email: session.principalEmail!,
    }, workspaceId, null);
    expect(requestAuthority?.rootAllowed).toBe(true);

    await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')
      WHERE id='policy-request-root'`).run();
    expect((await readEffectiveWorkspaceRequestProof(env, {
      issuer: session.principalIssuer!, subject: session.principalSubject!, email: session.principalEmail!,
    }, workspaceId, null))?.rootAllowed).toBe(false);
    expect(await readServiceAssignmentPolicy(env, session, null)).toMatchObject({ state: "ready", assignedServiceCount: 1 });

    await db.prepare(`INSERT INTO pa_service_assignment_request_policy_reviews
      (source_id,revision,review_id,state,reviewed_by_type,reviewed_by_id,review_reference,rationale,reviewed_at)
      VALUES (?,2,'policy-review-primary-suspended','suspended','staff','test-operator','TEST-PRIMARY-SUSPEND',
        'Policy rollout suspended',datetime('now'))`).bind(sourceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(false);
    expect(await readServiceAssignmentPolicy(env, session, null))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    await expect(db.prepare(`UPDATE pa_service_assignment_request_policy_reviews SET rationale='changed'
      WHERE source_id=? AND revision=2`).bind(sourceId).run()).rejects
      .toThrow("service-assignment-request-policy-review-immutable");
  });
});
