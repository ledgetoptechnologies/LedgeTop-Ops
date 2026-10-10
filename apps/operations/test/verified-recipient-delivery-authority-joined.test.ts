import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedRecipientDeliveryAuthorityReceipt, type VerifiedRecipientDeliveryAuthorityCommand } from
  "@ltds/shared/verified-recipient-delivery-authority";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { dispatchNextVerifiedRecipientDeliveryAuthority, enqueueVerifiedRecipientDeliveryAuthority,
  listVerifiedRecipientDeliveryAuthoritiesForEnrollment } from
  "../src/worker/verified-recipient-delivery-authority-ledger";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import {applyVerifiedRecipientDeliveryAuthorityRpc,getVerifiedRecipientDeliveryAuthorityStatusRpc} from
  "../../client/src/worker/verified-recipient-delivery-authority-entrypoint";

const selectionId = "11111111-1111-4111-8111-111111111111";
const clientAuthorityId = "22222222-2222-4222-8222-222222222222";
const recipientBindingId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const homeOperationId = "55555555-5555-4555-8555-555555555555";
const authorityId = "66666666-6666-4666-8666-666666666666";
const rootId = "organization:one", clientId = "client:one", workspaceId = "workspace-one";
const folderId = "folder-one", sourceId = "project-alpha:primary", projectPublicId = "project-public";
const fixedVerifiedUntil = new Date(Date.now() + 3_600_000).toISOString();
const future = () => fixedVerifiedUntil;

function command(action: "upsert" | "revoke" = "upsert", expected = action === "upsert" ? 0 : 1,
  operationId = crypto.randomUUID()): VerifiedRecipientDeliveryAuthorityCommand {
  return { protocol: "verified-recipient-delivery-authority", protocolVersion: 1, action, operationId,
    recipient: { recipientBindingId, enrollmentIntentId: intentId, enrollmentRevision: 3,
      issuer: "https://team.cloudflareaccess.com", subject: "access|recipient" },
    selection: { selectionId, clientAuthorityId, clientRecordId: clientId, workspaceId },
    homeAuthority: { ownershipEpoch: 1, grantRevision: 1, grantOperationId: homeOperationId },
    resource: { folderBindingId: folderId, folderBindingSourceVersion: "folder-v1", sourceId,
      projectPublicId, projectSourceVersion: "project-v1", currentGenerationId: "directory-v1" },
    authority: { authorityId, expectedRevision: expected, resultingRevision: expected + 1 },
    terms: { reasonCode: "reviewed folder share", expiresAt: null,
      accessTerms: { id: "terms-one", kind: "customer", mode: "until_revoked",
        reviewedExpiresAt: null, effectiveExpiresAt: null } },
    ownerProof: { staffId: "owner", verifiedAccessSubject: "access|owner", admissionVersion: 2,
      profileVersion: 3, grantGeneration: 5, verifiedUntil: future() } };
}

describe("verified recipient delivery authority joined minimal protocol integration", () => {
  let runtime: Miniflare, opsDb: D1Database, deliveryDb: D1Database;
  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    deliveryDb = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await opsDb.batch([
      opsDb.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)"),
      opsDb.prepare("CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      opsDb.prepare("CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
      opsDb.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT)"),
      opsDb.prepare("CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_workspace_binding_selections(selection_id TEXT PRIMARY KEY,client_authority_id TEXT,record_id TEXT,workspace_id TEXT,source_id TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_workspace_binding_outbox(operation_id TEXT PRIMARY KEY,state TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_workspace_binding_outbox_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT,state TEXT,revision INTEGER)"),
      opsDb.prepare("CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY,status TEXT,expires_at TEXT,target_client_record_id TEXT,access_issuer TEXT,access_subject TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_recipient_enrollment_intents(intent_id TEXT PRIMARY KEY,selection_id TEXT,binding_id TEXT,target_client_record_id TEXT,state TEXT,revision INTEGER,access_issuer TEXT,access_subject TEXT,grant_operation_id TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_recipient_enrollment_cancellations(intent_id TEXT PRIMARY KEY)"),
      opsDb.prepare("CREATE TABLE client_portal_authority_v2_outbox(operation_id TEXT PRIMARY KEY,state TEXT,protocol_version INTEGER,binding_operation_id TEXT,client_authority_id TEXT,workspace_id TEXT,recipient_binding_id TEXT,issuer TEXT,subject TEXT,desired_state TEXT,permissions_json TEXT)"),
      opsDb.prepare("CREATE TABLE client_portal_authority_v2_outbox_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,resulting_state TEXT,protocol_version INTEGER,permissions_json TEXT)"),
      opsDb.prepare("CREATE TABLE pa_projects(id TEXT PRIMARY KEY,projection_source_id TEXT,active INTEGER,payload_json TEXT)"),
      opsDb.prepare("CREATE TABLE project_folders(project_id TEXT PRIMARY KEY,division_id TEXT,r2_prefix TEXT)"),
    ]);
    const migration = readFileSync(new URL("../migrations/0151_verified_recipient_delivery_authority_outbox.sql", import.meta.url), "utf8");
    for (const [index, statement] of splitD1MigrationStatements(migration).entries()) {
      try { await opsDb.prepare(statement).run(); }
      catch (error) { throw new Error(`0151 statement ${index} failed`, { cause: error }); }
    }
    await opsDb.batch([
      opsDb.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      opsDb.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      opsDb.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      opsDb.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global',NULL)"),
      ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map(permission =>
        opsDb.prepare("INSERT INTO role_permissions VALUES('role-owner',?)").bind(permission)),
      opsDb.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'resource',?,NULL,NULL)").bind(rootId),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'organization')").bind(rootId),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'client')").bind(clientId),
      opsDb.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(clientId, rootId),
      opsDb.prepare("INSERT INTO client_portal_workspace_binding_selections VALUES(?,?,?,?,?)").bind(selectionId, clientAuthorityId, rootId, workspaceId, sourceId),
      opsDb.prepare("INSERT INTO client_portal_workspace_binding_outbox VALUES(?,'acknowledged')").bind(selectionId),
      opsDb.prepare("INSERT INTO client_portal_workspace_binding_outbox_receipts VALUES(?,?,?,'inactive',1)").bind(selectionId, clientAuthorityId, workspaceId),
      opsDb.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,'active',NULL,?,?,?)")
        .bind(recipientBindingId, clientId, "https://team.cloudflareaccess.com", "access|recipient"),
      opsDb.prepare("INSERT INTO client_portal_recipient_enrollment_intents VALUES(?,?,?,?, 'active',3,?,?,?)")
        .bind(intentId, selectionId, recipientBindingId, clientId, "https://team.cloudflareaccess.com", "access|recipient", homeOperationId),
      opsDb.prepare(`INSERT INTO client_portal_authority_v2_outbox VALUES(?,'acknowledged',3,?,?,?,?,?,?,'active','["operations.service_home.read"]')`)
        .bind(homeOperationId, selectionId, clientAuthorityId, workspaceId, recipientBindingId,
          "https://team.cloudflareaccess.com", "access|recipient"),
      opsDb.prepare(`INSERT INTO client_portal_authority_v2_outbox_receipts VALUES(?,?,?,?,?,1,1,'active',3,'["operations.service_home.read"]')`)
        .bind(homeOperationId, clientAuthorityId, workspaceId, "https://team.cloudflareaccess.com", "access|recipient"),
      opsDb.prepare("INSERT INTO pa_projects VALUES('project-one',?,1,?)").bind(sourceId, JSON.stringify({ public_id: projectPublicId })),
      opsDb.prepare("INSERT INTO project_folders VALUES('project-one','division-one','delivery/project-one/')"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,source_version TEXT,status TEXT,revoked_at TEXT,owner_scope_type TEXT,owner_public_id TEXT,r2_prefix TEXT,UNIQUE(id,workspace_id))"),
      deliveryDb.prepare("CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER)"),
      deliveryDb.prepare("CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER)"),
      deliveryDb.prepare("CREATE TABLE portal_primary_staff_bindings(binding_id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,owner_scope_type TEXT,project_public_id TEXT,project_source_version TEXT,directory_generation_id TEXT,r2_prefix TEXT,state TEXT,version INTEGER)"),
      deliveryDb.prepare("CREATE TABLE portal_native_staff_bindings(binding_id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT,r2_prefix TEXT)"),
      deliveryDb.prepare("CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER,version INTEGER)"),
      deliveryDb.prepare("CREATE TABLE pa_portal_source_authority_revisions(source_id TEXT,revision INTEGER,PRIMARY KEY(source_id,revision))"),
      deliveryDb.prepare("CREATE TABLE portal_v2_root_access_policies(projection_source_id TEXT,root_type TEXT,root_public_id TEXT,state TEXT)"),
      deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active','organization','root-public',NULL)").bind(workspaceId, sourceId),
      deliveryDb.prepare("INSERT INTO portal_v2_folder_bindings VALUES(?,?,?,'active',NULL,'project',?,?)")
        .bind(folderId, workspaceId, "folder-v1", projectPublicId, "delivery/project-one/"),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,'directory-v1')").bind(workspaceId),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES('directory-v1',?,'active',1)").bind(workspaceId),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,'directory-v1','project',?,'project-v1',1)").bind(workspaceId, projectPublicId),
      deliveryDb.prepare("INSERT INTO portal_primary_staff_bindings VALUES(?,?,?,'project',?,?,'directory-v1',?,'active',1)")
        .bind(folderId, workspaceId, sourceId, projectPublicId, "project-v1", "delivery/project-one/"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("CREATE TABLE portal_client_authority_workspace_bindings(client_authority_id TEXT PRIMARY KEY,workspace_id TEXT,operation_id TEXT UNIQUE,state TEXT,revision INTEGER)"),
      deliveryDb.prepare("CREATE TABLE portal_client_authority_workspace_binding_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_client_authority_workspace_binding_audit(operation_id TEXT PRIMARY KEY)"),
      deliveryDb.prepare("CREATE TABLE portal_operations_workspace_authority_heads(workspace_id TEXT PRIMARY KEY,client_authority_id TEXT,ownership_epoch INTEGER,state TEXT,binding_operation_id TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_operations_principal_grant_heads(workspace_id TEXT,client_authority_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT,last_operation_id TEXT,protocol_version INTEGER,permissions_json TEXT,PRIMARY KEY(workspace_id,issuer,subject))"),
      deliveryDb.prepare("CREATE TABLE portal_operations_authority_v2_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,resulting_state TEXT,protocol_version INTEGER,permissions_json TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_operations_authority_v2_audit(operation_id TEXT PRIMARY KEY)"),
      deliveryDb.prepare("CREATE TABLE portal_project_access_terms(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT,kind TEXT,mode TEXT,expires_at TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_project_access_deadlines(access_terms_id TEXT PRIMARY KEY,deadline_at TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_project_access_current_lifecycle(workspace_id TEXT,source_id TEXT,project_public_id TEXT,lifecycle_status TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_native_staff_grants(grant_id TEXT PRIMARY KEY,binding_id TEXT,source_id TEXT,state TEXT,authorization_id TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_native_staff_grant_events(grant_id TEXT,authorization_id TEXT,action TEXT)"),
      deliveryDb.prepare("CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,binding_source_version TEXT,status TEXT,revoked_at TEXT)"),
      deliveryDb.prepare("INSERT INTO portal_client_authority_workspace_bindings VALUES(?,?,?,?,1)").bind(clientAuthorityId,workspaceId,selectionId,"inactive"),
      deliveryDb.prepare("INSERT INTO portal_client_authority_workspace_binding_receipts VALUES(?,?,?)").bind(selectionId,clientAuthorityId,workspaceId),
      deliveryDb.prepare("INSERT INTO portal_operations_workspace_authority_heads VALUES(?,?,1,'active',?)").bind(workspaceId,clientAuthorityId,selectionId),
      deliveryDb.prepare("INSERT INTO portal_operations_principal_grant_heads VALUES(?,?,?,?,1,1,'active',?,3,?)").bind(workspaceId,clientAuthorityId,"https://team.cloudflareaccess.com","access|recipient",homeOperationId,'["operations.service_home.read"]'),
      deliveryDb.prepare("INSERT INTO portal_operations_authority_v2_receipts VALUES(?,?,?,?,?,1,1,'active',3,?)").bind(homeOperationId,clientAuthorityId,workspaceId,"https://team.cloudflareaccess.com","access|recipient",'["operations.service_home.read"]'),
      deliveryDb.prepare("INSERT INTO portal_project_access_terms VALUES('terms-one',?,?,?,?,?,NULL)").bind(workspaceId,sourceId,projectPublicId,"customer","until_revoked"),
    ]);
    // The current writer requires immutable creation provenance and distinct
    // operation-actor columns from 0222. An old minimal 0221-only fixture must
    // not be used as evidence for the newer joined protocol.
    for (const name of ["0221_verified_recipient_delivery_authority.sql",
      "0222_verified_recipient_delivery_cross_manager_revoke.sql"]) {
      const clientMigration=readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),"utf8");
      await deliveryDb.batch(splitD1MigrationStatements(clientMigration).map(statement=>deliveryDb.prepare(statement)));
    }
  }, 30_000);
  afterEach(async () => runtime.dispose());

  it("applies actual 0151, records exact command, and permits only identical replay", async () => {
    const first = command();
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, first))
      .resolves.toEqual({ operationId: first.operationId, state: "pending", replayed: false });
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, first))
      .resolves.toEqual({ operationId: first.operationId, state: "pending", replayed: true });
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb,
      { ...first, terms: { ...first.terms, reasonCode: "changed" } })).rejects.toThrow("denied");
    expect(await opsDb.prepare("SELECT count(*) n FROM verified_recipient_delivery_authority_commands").first("n")).toBe(1);
    const duplicate = command("upsert", 0);
    (duplicate.authority as { authorityId: string }).authorityId = "77777777-7777-4777-8777-777777777777";
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, duplicate)).rejects.toThrow("denied");
  });

  it("rolls the whole enqueue back when current owner generation changes after preflight", async () => {
    const rawSession = opsDb.withSession("first-primary"); let raced = false;
    const racing = { withSession: () => new Proxy(rawSession, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!raced) { raced = true; await opsDb.prepare("UPDATE native_directory_grant_generations SET generation=6 WHERE staff_id='owner'").run(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) } as unknown as D1Database;
    await expect(enqueueVerifiedRecipientDeliveryAuthority(racing, deliveryDb, command())).rejects.toThrow("denied");
    expect(await opsDb.prepare("SELECT count(*) n FROM verified_recipient_delivery_authority_commands").first("n")).toBe(0);
  });

  it("fails closed on scoped delivery denies and stale folder generations", async () => {
    await opsDb.prepare("INSERT INTO staff_permission_overrides VALUES('owner','delivery.share.create','deny','division','division-one')").run();
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, command())).rejects.toThrow("denied");
    await opsDb.prepare("DELETE FROM staff_permission_overrides").run();
    await deliveryDb.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='other' WHERE workspace_id=?").bind(workspaceId).run();
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, command())).rejects.toThrow("denied");
  });

  it("preserves every split command guard as an independently closed predicate", async () => {
    const cases: readonly [string, D1PreparedStatement, D1PreparedStatement][] = [
      ["selection receipt", opsDb.prepare("UPDATE client_portal_workspace_binding_outbox_receipts SET revision=2"),
        opsDb.prepare("UPDATE client_portal_workspace_binding_outbox_receipts SET revision=1")],
      ["recipient correlation", opsDb.prepare("UPDATE client_portal_recipient_enrollment_intents SET access_subject='other'"),
        opsDb.prepare("UPDATE client_portal_recipient_enrollment_intents SET access_subject='access|recipient'")],
      ["home receipt", opsDb.prepare("UPDATE client_portal_authority_v2_outbox_receipts SET grant_revision=2"),
        opsDb.prepare("UPDATE client_portal_authority_v2_outbox_receipts SET grant_revision=1")],
      ["project resource", opsDb.prepare(`UPDATE pa_projects SET payload_json='{"public_id":"other"}'`),
        opsDb.prepare("UPDATE pa_projects SET payload_json=?").bind(JSON.stringify({ public_id: projectPublicId }))],
    ];
    for (const [label, invalidate, restore] of cases) {
      await invalidate.run();
      await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, command()), label)
        .rejects.toThrow("denied");
      await restore.run();
    }
  });

  it("strictly acknowledges a Client receipt and lists drain readiness", async () => {
    const value = command(); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, value);
    const binding = { applyAuthority: async (input: VerifiedRecipientDeliveryAuthorityCommand) =>
      ({ ok: true, receipt: createVerifiedRecipientDeliveryAuthorityReceipt(input, "recorded") }),
      getAuthorityStatus: async () => ({ ok: false, protocol: "verified-recipient-delivery-authority",
        protocolVersion: 1, code: "not_found", retryable: true }) };
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: value.operationId })).resolves.toEqual({ operationId: value.operationId, state: "acknowledged" });
    expect(await listVerifiedRecipientDeliveryAuthoritiesForEnrollment(opsDb, recipientBindingId)).toEqual([expect.objectContaining({
      authorityId, state: "active", clientReceiptAcknowledged: true })]);
  });

  it("sanitizes hostile bridge envelopes into a claimed retry", async () => {
    const value = command(); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, value);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("hostile"); } });
    const binding = { applyAuthority: async () => hostile, getAuthorityStatus: async () => hostile };
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: value.operationId })).resolves.toEqual({ operationId: value.operationId, state: "retry" });
    expect(await opsDb.prepare("SELECT state FROM verified_recipient_delivery_authority_outbox WHERE operation_id=?")
      .bind(value.operationId).first("state")).toBe("retry");
  });

  it("commits revoke deny-first and completes after owner/home expiry before binding revoke", async () => {
    const create = command(); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, create);
    const binding = { applyAuthority: async (input: VerifiedRecipientDeliveryAuthorityCommand) =>
      ({ ok: true, receipt: createVerifiedRecipientDeliveryAuthorityReceipt(input, "recorded") }),
      getAuthorityStatus: async (input: VerifiedRecipientDeliveryAuthorityCommand) =>
        ({ ok: true, receipt: createVerifiedRecipientDeliveryAuthorityReceipt(input, "replayed") }) };
    await dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: create.operationId });
    const revoke = command("revoke", 1); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, revoke);
    expect(await opsDb.prepare("SELECT state FROM verified_recipient_delivery_authority_heads WHERE authority_id=?")
      .bind(authorityId).first("state")).toBe("revoked");
    await expect(opsDb.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked' WHERE binding_id=?")
      .bind(recipientBindingId).run()).rejects.toThrow();
    await opsDb.batch([
      opsDb.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='owner'"),
      opsDb.prepare("UPDATE client_portal_authority_v2_outbox SET desired_state='revoked' WHERE operation_id=?").bind(homeOperationId),
    ]);
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: revoke.operationId })).resolves.toEqual({ operationId: revoke.operationId, state: "acknowledged" });
    await expect(opsDb.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked' WHERE binding_id=?")
      .bind(recipientBindingId).run()).resolves.toBeTruthy();
  });

  it("never dead-letters a committed revoke with a corrupted stored command", async () => {
    const create = command(); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, create);
    const binding = { applyAuthority: async (input: VerifiedRecipientDeliveryAuthorityCommand) =>
      ({ ok: true, receipt: createVerifiedRecipientDeliveryAuthorityReceipt(input, "recorded") }),
      getAuthorityStatus: async () => ({ ok: false, protocol: "verified-recipient-delivery-authority",
        protocolVersion: 1, code: "not_found", retryable: true }) };
    await dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: create.operationId });

    const revoke = command("revoke", 1); await enqueueVerifiedRecipientDeliveryAuthority(opsDb, deliveryDb, revoke);
    await opsDb.prepare("DROP TRIGGER verified_recipient_delivery_command_no_update").run();
    await opsDb.prepare(`UPDATE verified_recipient_delivery_authority_commands
      SET command_sha256=? WHERE operation_id=?`).bind("0".repeat(64), revoke.operationId).run();

    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: opsDb, deliveryDatabase: deliveryDb, binding,
      operationId: revoke.operationId })).resolves.toEqual({ operationId: revoke.operationId, state: "retry" });
    expect(await opsDb.prepare("SELECT state FROM verified_recipient_delivery_authority_outbox WHERE operation_id=?")
      .bind(revoke.operationId).first("state")).toBe("retry");
    await expect(opsDb.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked' WHERE binding_id=?")
      .bind(recipientBindingId).run()).rejects.toThrow();
  });

  const clientEnv=()=>({DELIVERY_DB:deliveryDb,ENVIRONMENT:"staging",
    EXPECTED_HOST:"delivery-staging.ledgetopdroneservices.com",
    CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED:"true",
    CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED:"true"});
  const realBinding=()=>({
    applyAuthority:(input:unknown)=>applyVerifiedRecipientDeliveryAuthorityRpc(clientEnv(),input),
    getAuthorityStatus:(input:unknown)=>getVerifiedRecipientDeliveryAuthorityStatusRpc(clientEnv(),input),
  });

  it("joins real enqueue and dispatch to matching durable Client and Operations closed receipts",async()=>{
    const value=command("upsert",0,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,value)).resolves.toMatchObject({state:"pending",replayed:false});
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:realBinding(),operationId:value.operationId}))
      .resolves.toEqual({operationId:value.operationId,state:"acknowledged"});
    const client=await deliveryDb.prepare("SELECT request_json FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?").bind(value.operationId).first<string>("request_json");
    const ops=await opsDb.prepare("SELECT receipt_json FROM verified_recipient_delivery_authority_receipts WHERE operation_id=?").bind(value.operationId).first<string>("receipt_json");
    expect(client).toBeTruthy();
    const opsReceipt=JSON.parse(ops!) as Record<string,unknown>;
    const status=(await getVerifiedRecipientDeliveryAuthorityStatusRpc(clientEnv(),value) as {ok:true;receipt:Record<string,unknown>}).receipt;
    expect(opsReceipt).toEqual({...status,status:"recorded"});
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(clientEnv(),value)).resolves.toMatchObject({ok:true,receipt:{status:"replayed"}});
  });

  it("recovers a lost apply response through real Client status",async()=>{
    const value=command("upsert",0,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,value);
    const lost={applyAuthority:async(input:unknown)=>{await applyVerifiedRecipientDeliveryAuthorityRpc(clientEnv(),input);throw new Error("lost response");},
      getAuthorityStatus:(input:unknown)=>getVerifiedRecipientDeliveryAuthorityStatusRpc(clientEnv(),input)};
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:lost,operationId:value.operationId}))
      .resolves.toEqual({operationId:value.operationId,state:"acknowledged"});
    expect(await opsDb.prepare("SELECT state FROM verified_recipient_delivery_authority_outbox WHERE operation_id=?").bind(value.operationId).first("state")).toBe("acknowledged");
  });

  it("recovers exact durable Client status after Ops proof expires without issuing a new apply",async()=>{
    const value=command("upsert",0,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    await enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,value);
    const obscured={applyAuthority:async(input:unknown)=>{await applyVerifiedRecipientDeliveryAuthorityRpc(clientEnv(),input);throw new Error("lost response");},
      getAuthorityStatus:async()=>({ok:false as const,protocol:"verified-recipient-delivery-authority" as const,
        protocolVersion:1 as const,code:"not_found" as const,retryable:true})};
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:obscured,operationId:value.operationId}))
      .resolves.toEqual({operationId:value.operationId,state:"retry"});
    await opsDb.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='owner'").run();
    await new Promise(resolve=>setTimeout(resolve,10_500));
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(clientEnv(),value)).resolves.toMatchObject({ok:true,receipt:{status:"replayed"}});
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:realBinding(),operationId:value.operationId}))
      .resolves.toEqual({operationId:value.operationId,state:"acknowledged"});
    expect(await opsDb.prepare("SELECT state,last_error_code FROM verified_recipient_delivery_authority_outbox WHERE operation_id=?").bind(value.operationId).first())
      .toEqual({state:"acknowledged",last_error_code:null});
  });

  it("keeps revoke drain false until exact Client acknowledgement and rejects drifted targets",async()=>{
    const create=command("upsert",0,"cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,create);
    await dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:realBinding(),operationId:create.operationId});
    const revoke=command("revoke",1,"dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    await enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,revoke);
    expect(await listVerifiedRecipientDeliveryAuthoritiesForEnrollment(opsDb,recipientBindingId)).toEqual([
      expect.objectContaining({state:"revoked",clientReceiptAcknowledged:false})]);
    await expect(opsDb.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked' WHERE binding_id=?").bind(recipientBindingId).run()).rejects.toThrow();
    await expect(dispatchNextVerifiedRecipientDeliveryAuthority({opsDatabase:opsDb,deliveryDatabase:deliveryDb,binding:realBinding(),operationId:revoke.operationId}))
      .resolves.toEqual({operationId:revoke.operationId,state:"acknowledged"});
    expect(await listVerifiedRecipientDeliveryAuthoritiesForEnrollment(opsDb,recipientBindingId)).toEqual([
      expect.objectContaining({state:"revoked",clientReceiptAcknowledged:true})]);
    const wrongRecipient={...command("upsert",0),recipient:{...command().recipient,subject:"wrong"}};
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,wrongRecipient)).rejects.toThrow("denied");
    const wrongFolder={...command("upsert",0),resource:{...command().resource,folderBindingId:"wrong-folder"}};
    await expect(enqueueVerifiedRecipientDeliveryAuthority(opsDb,deliveryDb,wrongFolder)).rejects.toThrow("denied");
  });
});
