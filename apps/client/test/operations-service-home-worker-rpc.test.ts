import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { writeClientAuthorityWorkspaceBinding } from "../src/worker/client-authority-workspace-binding";
import { applyClientPortalAuthorityV3, getClientPortalAuthorityV3Status } from "../src/worker/client-portal-authority-v2-entrypoint";

async function bundle(url: URL): Promise<string> {
  const result = await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true },
    build: { ssr: fileURLToPath(url), target: "esnext", write: false, minify: false,
      rollupOptions: { external: id => id.startsWith("cloudflare:") } } });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw Error("service metadata RPC bundle missing");
  const chunk = output.output.find(item => item.type === "chunk" && item.isEntry);
  if (!chunk || chunk.type !== "chunk") throw Error("service metadata RPC entrypoint missing");
  return chunk.code;
}

describe("Operations service home through a real named Worker binding", () => {
  // Transport-only fixture using reviewed legacy synthetic authority writers; this is not native-cutover acceptance.
  let runtime: Miniflare, opsDb: D1Database, clientDb: D1Database;
  const authorityId = "11111111-1111-4111-8111-111111111111", selectionId = "22222222-2222-4222-8222-222222222222";
  const recipientBindingId = "33333333-3333-4333-8333-333333333333", issuer = "https://access.example.test";
  const owner = { identity: { kind: "native" as const, staffId: "owner",
    verifiedAccessSubject: "access|owner", email: "owner@example.test", displayName: "Owner", profileVersion: 3 },
    admissionVersion: 2, verifiedUntil: new Date(Date.now() + 30 * 60_000).toISOString() };
  beforeAll(async () => {
    const [driver, reader] = await Promise.all([
      bundle(new URL("./fixtures/operations-service-metadata-rpc-driver.ts", import.meta.url)),
      bundle(new URL("../../operations/src/worker/client-portal-service-metadata-entrypoint.ts", import.meta.url)),
    ]);
    runtime = new Miniflare({ workers: [
      { name: "client", modules: true, compatibilityDate: "2026-07-16", compatibilityFlags: ["nodejs_compat"],
        script: driver, bindings: { CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true" },
        d1Databases: { DELIVERY_DB: crypto.randomUUID() }, serviceBindings: { CLIENT_PORTAL_SERVICE_METADATA_READER:
          { name: "operations", entrypoint: "ClientPortalServiceMetadataReader" } } },
      { name: "operations", modules: true, compatibilityDate: "2026-07-22", compatibilityFlags: ["nodejs_compat"],
        script: reader, bindings: { CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true" },
        d1Databases: { OPS_DB: crypto.randomUUID() } },
    ] });
    clientDb = await runtime.getD1Database("DELIVERY_DB", "client") as unknown as D1Database;
    opsDb = await runtime.getD1Database("OPS_DB", "operations") as unknown as D1Database;
    const db = clientDb;
    const root = "a".repeat(32);
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-one','organization',?,NULL,'project-alpha:east','active')").bind(root),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:east','source-one')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-one','workspace-one','generation-one',1,'project-alpha:east','organization',?)").bind(root),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-one','generation-one',1,'snapshot-one')"),
    ]);
    for (const name of ["0216_client_authority_workspace_ownership_claim.sql", "0217_client_authority_workspace_claim_evidence.sql",
      "0218_client_authority_workspace_binding.sql", "0219_operations_portal_authority_v2.sql", "0220_operations_portal_authority_v3_permissions.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    expect(await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: db, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: selectionId, clientAuthorityId: authorityId, workspaceId: "workspace-one",
      projectionSourceId: "project-alpha:east", sourceWorkspaceId: "source-one", rootType: "organization", rootPublicId: root,
      expectedCheckpoint: { sourceGeneration: "generation-one", sourceSequence: 1, snapshotGenerationId: "snapshot-one" },
    })).toMatchObject({ operationId: selectionId, clientAuthorityId: authorityId, workspaceId: "workspace-one", state: "inactive" });
    await opsDb.batch([
      opsDb.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      opsDb.prepare("CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT)"),
      opsDb.prepare(`CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(activation_id TEXT PRIMARY KEY,record_id TEXT,
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT,
        resource_type TEXT,local_record_version INTEGER)`),
      opsDb.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      opsDb.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)"),
      opsDb.prepare("CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER)"),
      opsDb.prepare("CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER)"),
      opsDb.prepare("CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER)"),
    ]);
    for (const name of ["0103_client_onboarding_recipient_identity_bindings.sql", "0143_client_portal_workspace_binding_selection.sql",
      "0144_client_portal_workspace_binding_outbox.sql", "0145_client_portal_authority_v2_outbox.sql",
      "0146_ops_customer_service_enrollments.sql", "0147_client_portal_authority_v3_permissions.sql",
      "0148_client_portal_recipient_enrollment.sql", "0149_client_portal_recipient_enrollment_sql_fences.sql",
      "0150_client_portal_recipient_enrollment_cancellation.sql"]) {
      const sql = readFileSync(new URL(`../../operations/migrations/${name}`, import.meta.url), "utf8");
      await opsDb.batch(splitD1MigrationStatements(sql).map(statement => opsDb.prepare(statement)));
    }
    const rootId = "organization:one", clientId = "client:one", publicId = "a".repeat(32);
    await opsDb.batch([
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(rootId),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientId),
      opsDb.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(clientId, rootId),
      opsDb.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES('activation',?,'project-alpha:east','instance','app','epoch',?,'organization',1)").bind(rootId, publicId),
      opsDb.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      opsDb.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      opsDb.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      opsDb.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      opsDb.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
      opsDb.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.enrollment.manage','allow',1,'global',NULL,NULL,NULL)"),
      opsDb.prepare("INSERT INTO client_onboarding_recipient_identity_bindings(binding_id,target_client_record_id,access_issuer,access_subject,status) VALUES(?,?,?,'person-one','active')").bind(recipientBindingId, clientId, issuer),
    ]);
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_selections VALUES(?,?,?, ?, 'activation',1,'project-alpha:east','instance','app','epoch',
      'organization',?,'workspace-one','source-one','generation-one',1,'snapshot-one','owner','access|owner',2,3,5,?,'inactive',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(selectionId, "b".repeat(64), authorityId, rootId, publicId, new Date(Date.now() + 30 * 60_000).toISOString()).run();
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_outbox(operation_id,client_authority_id,workspace_id,projection_source_id,
      source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,checkpoint_snapshot_generation_id,
      reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation)
      VALUES(?,?,'workspace-one','project-alpha:east','source-one','organization',?,'generation-one',1,'snapshot-one','owner','access|owner',2,3,5)`)
      .bind(selectionId, authorityId, publicId).run();
    await opsDb.prepare("INSERT INTO client_portal_workspace_binding_outbox_audit VALUES(?,'inactive.binding.enqueued','owner',5,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(selectionId).run();
    await opsDb.prepare("UPDATE client_portal_workspace_binding_outbox SET state='dispatching',claim_token='claim',claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE operation_id=?").bind(selectionId).run();
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_outbox_receipts VALUES(?,?,'workspace-one','project-alpha:east','source-one','organization',?,'generation-one',1,'snapshot-one','inactive',1,0,'claim',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(selectionId, authorityId, publicId).run();
    await opsDb.prepare("UPDATE client_portal_workspace_binding_outbox SET state='acknowledged',attempt_count=1,claim_token=NULL,claim_until=NULL,acknowledged_claim_token='claim' WHERE operation_id=?").bind(selectionId).run();
    await opsDb.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES('hosting','ltds','catalog','hosting','Managed hosting')").run();
    const enrollmentModule = new URL("../../operations/src/worker/ops-customer-service-enrollments.ts", import.meta.url).href;
    const { writeCustomerServiceEnrollment } = await import(enrollmentModule);
    expect(await writeCustomerServiceEnrollment(opsDb, owner, { mutationId: "service-enrollment-one", idempotencyKey: "service-enrollment-key-one",
      customerRecordId: clientId, serviceId: "hosting", desiredState: "active", expectedRevision: 0 }))
      .toEqual({ mutationId: "service-enrollment-one", customerRecordId: clientId, serviceId: "hosting", state: "active", revision: 1, replayed: false });
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("passes an authorized descriptive summary, then denies it after revocation, through the real primitive binding", async () => {
    const authorityModule = new URL("../../operations/src/worker/client-portal-authority-v2-outbox.ts", import.meta.url).href;
    const { enqueueClientPortalAuthorityV3, dispatchNextClientPortalAuthorityV2 } = await import(authorityModule);
    const rawDenied = { type: "string", symbols: [], parsed: { ok: false, protocolVersion: 1, authorityId,
      workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1, issuer, subject: "person-one", code: "denied" } };
    expect(await (await runtime.dispatchFetch("https://client.example.test/raw")).json()).toEqual(rawDenied);
    expect(await (await runtime.dispatchFetch("https://client.example.test/")).json()).toEqual({ ok: false, code: "denied" });
    const writer = { DELIVERY_DB: clientDb, CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED: "true", CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED: "true" };
    const dispatch = { OPS_DB: opsDb, CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED: "true", CLIENT_PORTAL_AUTHORITY_V2: {
      applyAuthorityV3: (input: unknown) => applyClientPortalAuthorityV3(writer, input),
      getAuthorityV3Status: (input: unknown) => getClientPortalAuthorityV3Status(writer, input),
      applyAuthority: async () => ({ ok: false, protocolVersion: 2, code: "unsupported", retryable: false }),
      getAuthorityStatus: async () => ({ ok: false, protocolVersion: 2, code: "unsupported", retryable: false }),
    } };
    const activeOperation = "44444444-4444-4444-8444-444444444444";
    expect(await enqueueClientPortalAuthorityV3(opsDb, owner, { operationId: activeOperation, clientAuthorityId: authorityId,
      workspaceId: "workspace-one", bindingOperationId: selectionId, recipientBindingId, issuer, subject: "person-one",
      desiredState: "active", expectedOwnershipEpoch: 0, expectedGrantRevision: 0, permissions: ["operations.service_home.read"] }))
      .toEqual({ operationId: activeOperation, replayed: false });
    expect(await dispatchNextClientPortalAuthorityV2(dispatch, activeOperation)).toEqual({ status: "acknowledged", operationId: activeOperation });
    const raw = await runtime.dispatchFetch("https://client.example.test/raw");
    expect(await raw.json()).toEqual({ type: "string", symbols: [], parsed: { ok: true, protocolVersion: 1,
      authorityId, workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1, issuer, subject: "person-one",
      services: [{ serviceId: "hosting", providerId: "ltds", displayLabel: "Managed hosting", revision: 1 }] } });
    const response = await runtime.dispatchFetch("https://client.example.test/");
    expect(await response.json()).toEqual({ ok: true, authorityId, workspaceId: "workspace-one", ownershipEpoch: 1,
      grantRevision: 1, services: [{ serviceId: "hosting", providerId: "ltds", displayLabel: "Managed hosting", revision: 1 }] });

    const revokeOperation = "55555555-5555-4555-8555-555555555555";
    expect(await enqueueClientPortalAuthorityV3(opsDb, owner, { operationId: revokeOperation, clientAuthorityId: authorityId,
      workspaceId: "workspace-one", bindingOperationId: selectionId, recipientBindingId, issuer, subject: "person-one",
      desiredState: "revoked", expectedOwnershipEpoch: 1, expectedGrantRevision: 1, permissions: [] }))
      .toEqual({ operationId: revokeOperation, replayed: false });
    expect(await dispatchNextClientPortalAuthorityV2(dispatch, revokeOperation)).toMatchObject({ status: "acknowledged" });
    expect(await (await runtime.dispatchFetch("https://client.example.test/raw")).json()).toEqual(rawDenied);
    const denied = await runtime.dispatchFetch("https://client.example.test/");
    expect(await denied.json()).toEqual({ ok: false, code: "denied" });
  });
});
