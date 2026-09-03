import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import {
  createNativeFeedbackRecord,
  transitionNativeFeedbackRecord,
  type NativeFeedbackAuthorization,
} from "../src/worker/client-portal/native-feedback-store";
import {
  cancelServiceRequest,
  createServiceRequestDraft,
  listServiceCatalog,
  submitServiceRequestDraft,
} from "../src/worker/client-portal/request-v2";
import { acceptRequestAttachmentScanReceipt } from "../src/worker/client-portal/request-attachments";
import type { ClientPortalSession, ClientServiceRequestDraftInput } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const session: ClientPortalSession = {
  accountId: "account-j6",
  identityId: "identity-j6",
  displayName: "Joined client",
  role: "manager",
  canViewBilling: false,
};
const service = {
  publicId: "survey-j6",
  sourceVersion: "catalog-j6-v1",
  name: "Survey mapping",
  summary: "Joined acceptance service",
  category: "Mapping",
  displayOrder: 1,
  geometryRequirement: "optional" as const,
  questions: [{ id: "format", label: "Format", type: "select" as const, required: true, helpText: null,
    options: [{ value: "geotiff", label: "GeoTIFF" }] }],
};
const input: ClientServiceRequestDraftInput = {
  projectId: "project-j6",
  requestType: "service",
  title: "Joined mapping request",
  details: "Exercise the complete local request workflow.",
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
  services: [{ publicId: service.publicId, sourceVersion: service.sourceVersion, answers: { format: "geotiff" } }],
};

describe("J6 joined feedback and service-request acceptance", { timeout: 90_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let operation = 0;
  const key = (label: string) => `${label}-${++operation}-joined-j6`;

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('joined-j6')}}",
      d1Databases: { DELIVERY_DB: `joined-j6-${crypto.randomUUID()}` },
    });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
    }
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES('account-j6','Joined client','active','root-shared','project-alpha:primary'),
          ('account-collision','Collision client','active','root-shared','project-alpha:secondary')`),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('identity-j6','account-j6','https://issuer.test','subject-j6','joined@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-j6','identity-j6','manager')"),
      db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,active,project_alpha_project_id,project_alpha_source_id)
        VALUES('project-j6','Joined client','Joined project','Clients/Joined/',1,'project-shared','project-alpha:primary'),
          ('project-collision','Collision client','Collision project','Clients/Collision/',1,'project-shared','project-alpha:secondary')`),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('account-j6','project-j6',1)"),
      db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,'2026-09-02T12:00:00Z')`)
        .bind(PRIMARY_ALPHA_SOURCE_ID, service.publicId, service.sourceVersion, service.name, service.summary,
          service.category, service.displayOrder, service.geometryRequirement, JSON.stringify(service.questions)),
      db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        VALUES('project-alpha:secondary',? ,?,'Wrong-source service','Must not leak','Mapping',1,'optional','[]',1,'2026-09-02T12:00:00Z')`)
        .bind(service.publicId, service.sourceVersion),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
        VALUES('feedback-identity-j6','https://issuer.test','subject-j6','joined@example.test')`),
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES('workspace-collision','project-alpha:secondary','workspace-collision')`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id,status)
        VALUES('workspace-j6','organization','root-shared','Joined workspace','project-alpha:primary','active'),
          ('workspace-collision','organization','root-shared','Collision workspace','project-alpha:secondary','active')`),
    ]);
    env = { DELIVERY_DB: db, CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET: "joined-j6-scanner-secret-at-least-32-bytes",
      DATA_BUCKET: { head: async () => ({ size: 4, etag: "etag-j6" }) } as unknown as R2Bucket } as Env;
  }, 90_000);

  afterAll(async () => runtime?.dispose());

  function feedback(kind: "project" | "folder" | "file", sourceId: string = PRIMARY_ALPHA_SOURCE_ID,
    workspaceId = "workspace-j6"): NativeFeedbackAuthorization {
    const isProject = kind === "project";
    const isFile = kind === "file";
    return {
      context: { sourceId, workspaceId, identityId: "feedback-identity-j6", issuer: "https://issuer.test", subject: "subject-j6" },
      target: {
        version: 1,
        sourceId,
        workspaceId,
        rootType: "organization",
        rootPublicId: "root-shared",
        kind,
        projectPublicId: isProject ? "project-shared" : null,
        targetType: isProject ? "project" : "folder",
        targetPublicId: isProject ? "project-shared" : "folder-j6",
        label: isFile ? "inspection.jpg" : isProject ? "Joined project" : "Deliverables",
        projectName: isProject ? "Joined project" : null,
        relativePath: isProject ? null : isFile ? "Deliverables/inspection.jpg" : "Deliverables/",
        storageKey: isFile ? "Clients/Joined/Deliverables/inspection.jpg" : null,
        file: isFile ? { etag: "etag-j6", size: 42, uploadedAt: "2026-09-02T12:00:00.000Z" } : null,
        grant: isProject ? null : { source: "project_alpha_delivery", id: "grant-j6", version: 1,
          bindingId: "folder-j6", bindingVersion: "binding-v1", bindingProof: "a".repeat(64), prefix: "Clients/Joined/",
          ownerType: "organization", ownerPublicId: "root-shared", audienceType: "principal",
          audiencePublicId: "principal-j6", audienceSourceVersion: "principal-v1", accessTermsId: null },
        scopeProof: isProject
          ? [{ entityType: "organization", publicId: "root-shared", parentPublicId: null, sourceVersion: "root-v1", depth: 0 },
            { entityType: "project", publicId: "project-shared", parentPublicId: "root-shared", sourceVersion: "project-v1", depth: 1 }]
          : [{ entityType: "organization", publicId: "root-shared", parentPublicId: null, sourceVersion: "root-v1", depth: 0 },
            { entityType: "folder", publicId: "folder-j6", parentPublicId: "root-shared", sourceVersion: "binding-v1", depth: 1 }],
      },
      guard: { sql: "EXISTS(SELECT 1 FROM portal_v2_workspaces WHERE id=? AND status='active' AND project_alpha_source_id=?)",
        bindings: [workspaceId, sourceId] },
      available: true,
    };
  }

  function raceBeforeBatch(action: () => Promise<unknown>): Env {
    let pending = true;
    const wrapped = new Proxy(db, { get(target, property) {
      if (property === "withSession") return () => wrapped;
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (pending) { pending = false; await action(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { ...env, DELIVERY_DB: wrapped };
  }

  it("completes exact project, folder, and file feedback with one creator notice each", async () => {
    const requestCount = await db.prepare("SELECT count(*) n FROM client_service_requests").first<number>("n");
    for (const kind of ["project", "folder", "file"] as const) {
      const authorization = feedback(kind);
      const created = await createNativeFeedbackRecord(db, authorization, `Review ${kind}`, key(`feedback-${kind}`));
      const working = await transitionNativeFeedbackRecord(db, created.record, "staff-j6",
        { expectedRevision: 1, status: "in_progress", note: null }, key(`feedback-working-${kind}`), authorization.guard);
      const done = await transitionNativeFeedbackRecord(db, working.record, "staff-j6",
        { expectedRevision: 2, status: "done", note: "Complete" }, key(`feedback-done-${kind}`), authorization.guard);
      expect(done.record).toMatchObject({ status: "done", revision: 3, target: { kind, sourceId: PRIMARY_ALPHA_SOURCE_ID } });
      expect(await db.prepare("SELECT count(*) n FROM portal_native_feedback_notifications WHERE feedback_id=?")
        .bind(created.record.id).first("n")).toBe(1);
    }
    expect(await db.prepare("SELECT count(*) n FROM client_service_requests").first("n")).toBe(requestCount);

    const collision = feedback("project", "project-alpha:secondary", "workspace-collision");
    collision.context.identityId = "feedback-identity-j6";
    const other = await createNativeFeedbackRecord(db, collision, "Same root and project IDs", key("feedback-collision"));
    expect(other.record.context.sourceId).toBe("project-alpha:secondary");
  });

  it("rechecks feedback authority between load and write without changing history", async () => {
    const authorization = feedback("project");
    const created = await createNativeFeedbackRecord(db, authorization, "Revoke before transition", key("feedback-revoke"));
    await db.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace-j6'").run();
    await expect(transitionNativeFeedbackRecord(db, created.record, "staff-j6",
      { expectedRevision: 1, status: "done", note: null }, key("feedback-revoked-transition"), authorization.guard))
      .rejects.toMatchObject({ code: "changed" });
    expect(await db.prepare("SELECT status,revision FROM portal_native_feedback WHERE id=?").bind(created.record.id).first())
      .toEqual({ status: "new", revision: 1 });
    await db.prepare("UPDATE portal_v2_workspaces SET status='active' WHERE id='workspace-j6'").run();
  });

  it("runs catalog, assignment filter, draft, attachment, submit, review, estimate, exact quote, notice, cancel, and replay", async () => {
    const catalog = await listServiceCatalog(env, session, "project-j6");
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ publicId: service.publicId, name: service.name });

    const unavailableAssignments = { ...env, CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "true",
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" } as Env;
    expect(await createServiceRequestDraft(unavailableAssignments, session, input, key("assignment-filter")))
      .toEqual({ kind: "service_assignments_changed", servicePublicIds: [service.publicId] });

    const draftKey = key("draft");
    const created = await createServiceRequestDraft(env, session, input, draftKey);
    if (!created || !("draft" in created)) throw new Error("J6 draft was not created");
    expect(created.kind).toBe("created");
    const draft = created.draft;
    const replay = await createServiceRequestDraft(env, session, input, draftKey);
    expect(replay).toMatchObject({ kind: "replayed", draft: { id: draft.id } });

    await db.prepare(`INSERT INTO client_service_request_attachments
      (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,original_name,
       declared_size,content_type,status,actual_size,scanner_verdict,verified_sha256,scanned_at,completed_at,expires_at)
      VALUES('attachment-j6',?,'account-j6','identity-j6','upload-joined-j6-0001','_ltds/quarantine/request-attachments/attachment-j6/object',
       'multipart-j6','scope.pdf',4,'application/pdf','accepted',4,'clean',?,datetime('now'),datetime('now'),datetime('now','+1 day'))`)
      .bind(draft.id, "b".repeat(64)).run();

    const submitted = await submitServiceRequestDraft(env, session, draft.id, draft.version, key("submit"));
    if (!submitted || !("request" in submitted)) throw new Error("J6 request was not submitted");
    expect(submitted.kind).toBe("submitted");
    const request = submitted.request;
    expect(await db.prepare("SELECT submitted_request_id,status FROM client_service_request_attachments WHERE id='attachment-j6'").first())
      .toEqual({ submitted_request_id: request.id, status: "accepted" });
    expect(await db.prepare("SELECT count(*) n FROM client_portal_notification_outbox WHERE request_id=? AND event_type='request_submitted'")
      .bind(request.id).first("n")).toBe(1);

    await db.prepare("UPDATE client_service_requests SET status='under_review' WHERE id=?").bind(request.id).run();
    await db.prepare(`INSERT INTO request_operational_estimates
      (id,request_id,version,scope_text,estimate_amount_minor,currency,status,created_by,mutation_key,mutation_fingerprint)
      VALUES('estimate-j6',?,1,'Survey and orthomosaic',250000,'USD','ready','staff-j6','estimate-j6-key',?)`)
      .bind(request.id, "e".repeat(64)).run();

    const endpoint = "https://alpha.example.test/api/v2/integrations/operations/draft-quotes";
    const destination = "d".repeat(64);
    await db.prepare(`INSERT INTO request_pa_draft_quote_commands
      (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,
       destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
      VALUES('quote-command-j6',?,1,0,?,?,?,?,?,'quote-command-j6-key-0001',?,'{}','staff-j6')`)
      .bind(request.id, PRIMARY_ALPHA_SOURCE_ID, endpoint, "operations", "https://alpha.example.test", destination, "f".repeat(64)).run();
    await db.prepare(`INSERT INTO request_pa_draft_quote_receipts
      (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
       project_alpha_artifact_public_id,document_number,artifact_status,artifact_version,editor_path,created_by,source_id,command_id)
      SELECT 'quote-receipt-j6',request_id,request_revision,area_revision,idempotency_key,payload_hash,'pa-receipt-j6',
       'pa-quote-j6','DRAFT-J6','draft',1,'/quotes/pa-quote-j6/edit','staff-j6',source_id,id
      FROM request_pa_draft_quote_commands WHERE id='quote-command-j6'`).run();
    expect(await db.prepare("SELECT command_endpoint,destination_fingerprint FROM request_pa_draft_quote_commands WHERE id='quote-command-j6'").first())
      .toEqual({ command_endpoint: endpoint, destination_fingerprint: destination });
    await expect(db.prepare("UPDATE request_pa_draft_quote_commands SET destination_fingerprint=? WHERE id='quote-command-j6'")
      .bind("c".repeat(64)).run()).rejects.toThrow();

    const second = await createServiceRequestDraft(env, session, input, key("cancel-draft"));
    if (!second || !("draft" in second)) throw new Error("J6 cancellation draft was not created");
    const secondSubmitted = await submitServiceRequestDraft(env, session, second.draft.id, second.draft.version, key("cancel-submit"));
    if (!secondSubmitted || !("request" in secondSubmitted)) throw new Error("J6 cancellation request was not submitted");
    const cancelKey = key("cancel");
    expect(await cancelServiceRequest(env, session, secondSubmitted.request.id, cancelKey))
      .toMatchObject({ kind: "cancelled", request: { status: "cancelled" } });
    expect(await cancelServiceRequest(env, session, secondSubmitted.request.id, cancelKey))
      .toMatchObject({ kind: "replayed", request: { status: "cancelled" } });

    expect(await db.prepare("SELECT count(*) n FROM portal_native_feedback WHERE status='done'").first<number>("n")).toBe(3);
    expect(await db.prepare("SELECT count(*) n FROM client_service_requests WHERE status='cancelled'").first<number>("n")).toBe(1);
  });

  it("fences authority at submit and makes scan/cancel ordering explicit", async () => {
    const assignmentDraft = await createServiceRequestDraft(env, session, input, key("assignment-race-draft"));
    if (!assignmentDraft || !("draft" in assignmentDraft)) throw new Error("J6 assignment-race draft was not created");
    const assignmentsRevokedAfterLoad = { ...env, CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "true",
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" } as Env;
    expect(await submitServiceRequestDraft(assignmentsRevokedAfterLoad, session, assignmentDraft.draft.id,
      assignmentDraft.draft.version, key("assignment-race-submit")))
      .toEqual({ kind: "incomplete", reason: "service_assignments_changed", servicePublicIds: [service.publicId] });

    const created = await createServiceRequestDraft(env, session, input, key("authority-draft"));
    if (!created || !("draft" in created)) throw new Error("J6 authority draft was not created");
    const raced = raceBeforeBatch(() => db.prepare(
      "UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id='account-j6' AND project_id='project-j6'").run());
    expect(await submitServiceRequestDraft(raced, session, created.draft.id, created.draft.version, key("authority-submit")))
      .toEqual({ kind: "conflict" });
    expect(await db.prepare("SELECT count(*) n FROM client_service_requests WHERE id=(SELECT submitted_request_id FROM client_service_request_drafts WHERE id=?)")
      .bind(created.draft.id).first("n")).toBe(0);
    await db.prepare("UPDATE client_project_grants SET revoked_at=NULL WHERE account_id='account-j6' AND project_id='project-j6'").run();

    const scanDraft = await createServiceRequestDraft(env, session, input, key("scan-draft"));
    if (!scanDraft || !("draft" in scanDraft)) throw new Error("J6 scan draft was not created");
    await db.prepare(`INSERT INTO client_service_request_attachments
      (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,original_name,declared_size,
       content_type,status,actual_size,expires_at)
      VALUES('scan-race-j6',?,'account-j6','identity-j6','upload-scan-j6-0001','_ltds/quarantine/request-attachments/scan-race-j6/object',
       'multipart-scan-j6','pending.pdf',4,'application/pdf','quarantined',4,datetime('now','+1 day'))`)
      .bind(scanDraft.draft.id).run();
    expect(await submitServiceRequestDraft(env, session, scanDraft.draft.id, scanDraft.draft.version, key("scan-submit")))
      .toEqual({ kind: "incomplete", reason: "attachments_pending", attachmentCount: 1 });
    await db.prepare("UPDATE client_service_request_attachments SET status='aborted',updated_at=datetime('now') WHERE id='scan-race-j6'").run();
    await expect(acceptRequestAttachmentScanReceipt(env, `Bearer ${env.CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET}`,
      "scan-race-j6", { verdict: "clean", sha256: "a".repeat(64) })).rejects.toMatchObject({ status: 404 });
  });
});
