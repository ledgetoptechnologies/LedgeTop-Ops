import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { resolveCloudflareRecipientEnrollmentProof } from "../../client/src/worker/client-portal/access-identity";
import { applyClientPortalAuthorityV2, applyClientPortalAuthorityV3, getClientPortalAuthorityV2Status,
  getClientPortalAuthorityV3Status } from "../../client/src/worker/client-portal-authority-v2-entrypoint";
import { writeClientAuthorityWorkspaceBinding } from "../../client/src/worker/client-authority-workspace-binding";
import { readOperationsServiceHome } from "../../client/src/worker/client-portal/operations-service-home";
import { handleRecipientEnrollmentHttp } from "../../client/src/worker/client-portal/recipient-enrollment-http";
import type { Env as ClientEnv } from "../../client/src/worker/types";
import { dispatchNextClientPortalAuthorityV2 } from "../src/worker/client-portal-authority-v2-outbox";
import { inspectRecipientEnrollmentRpc, redeemRecipientEnrollmentRpc } from "../src/worker/client-portal-recipient-enrollment-entrypoint";
import { confirmRecipientEnrollmentIntent, issueRecipientEnrollmentIntent, reconcileRecipientEnrollmentRevocation,
  revokeRecipientEnrollmentBinding } from "../src/worker/client-portal-recipient-enrollment-ledger";
import { readClientPortalServiceMetadata } from "../src/worker/client-portal-service-metadata";
import { readClientPortalServiceMetadataRpc } from "../src/worker/client-portal-service-metadata-entrypoint";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const issuer = "https://team.cloudflareaccess.com";
const audience = "client-portal-audience";
const origin = "https://client-staging.example.test";
const selectionId = "11111111-1111-4111-8111-111111111111";
const authorityId = "22222222-2222-4222-8222-222222222222";
const activationId = "33333333-3333-4333-8333-333333333333";
const rootId = "organization:one";
const clientId = "client:one";
const workspaceId = "workspace-one";
const sourceId = "project-alpha:primary";
const sourceWorkspaceId = "source-workspace";
const publicId = "a".repeat(32);
const future = () => new Date(Date.now() + 30 * 60_000).toISOString();
const operation = () => crypto.randomUUID();
const owner: AuthenticatedNativeStaffWithAdmissionVersion = {
  identity: { kind: "native", staffId: "owner", verifiedAccessSubject: "access|owner", email: "owner@example.test",
    displayName: "Owner", profileVersion: 3 }, admissionVersion: 2, verifiedUntil: future(),
};

async function migrate(db: D1Database, names: readonly string[], app: "operations" | "client") {
  for (const name of names) {
    const sql = readFileSync(new URL(`../../${app}/migrations/${name}`, import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
  }
}

describe("recipient enrollment joined acceptance", () => {
  let runtime: Miniflare, opsDb: D1Database, clientDb: D1Database, privateKey: CryptoKey, jwks: JWTVerifyGetKey;

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    clientDb = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const keys = await generateKeyPair("RS256", { extractable: true }), publicJwk = await exportJWK(keys.publicKey);
    publicJwk.alg = "RS256"; publicJwk.kid = "recipient-key"; publicJwk.use = "sig";
    privateKey = keys.privateKey; jwks = createLocalJWKSet({ keys: [publicJwk] });

    // Reduced prerequisite projection plus the actual durable portal migrations under acceptance.
    await opsDb.batch([
      opsDb.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      opsDb.prepare("CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT,PRIMARY KEY(record_id,version))"),
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
    ]);
    await migrate(opsDb, ["0103_client_onboarding_recipient_identity_bindings.sql", "0143_client_portal_workspace_binding_selection.sql",
      "0144_client_portal_workspace_binding_outbox.sql", "0145_client_portal_authority_v2_outbox.sql",
      "0146_ops_customer_service_enrollments.sql", "0147_client_portal_authority_v3_permissions.sql",
      "0148_client_portal_recipient_enrollment.sql", "0149_client_portal_recipient_enrollment_sql_fences.sql"], "operations");
    await opsDb.batch([
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(rootId),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientId),
      opsDb.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)").bind(clientId, JSON.stringify({ name: "Example Customer" })),
      opsDb.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(clientId, rootId),
      opsDb.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES(?,? ,?,'instance','app','epoch',?,'organization',1)`)
        .bind(activationId, rootId, sourceId, publicId),
      opsDb.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      opsDb.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      opsDb.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      opsDb.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      opsDb.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
    ]);
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_selections VALUES(?,?,?, ?,?,1,?,'instance','app','epoch',
      'organization',?,?,?,'generation',1,'snapshot','owner','access|owner',2,3,5,?,'inactive',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(selectionId, "b".repeat(64), authorityId, rootId, activationId, sourceId, publicId, workspaceId, sourceWorkspaceId, future()).run();
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_outbox(operation_id,client_authority_id,workspace_id,projection_source_id,
      source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
      checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,
      reviewed_profile_version,reviewed_grant_generation) VALUES(?,?,?,?,?,'organization',?,'generation',1,'snapshot','owner','access|owner',2,3,5)`)
      .bind(selectionId, authorityId, workspaceId, sourceId, sourceWorkspaceId, publicId).run();
    await opsDb.prepare("INSERT INTO client_portal_workspace_binding_outbox_audit VALUES(?,'inactive.binding.enqueued','owner',5,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(selectionId).run();
    await opsDb.prepare("UPDATE client_portal_workspace_binding_outbox SET state='dispatching',claim_token='claim',claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE operation_id=?").bind(selectionId).run();
    await opsDb.prepare(`INSERT INTO client_portal_workspace_binding_outbox_receipts VALUES(?,?,?,?,?,'organization',?,'generation',1,'snapshot','inactive',1,0,'claim',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(selectionId, authorityId, workspaceId, sourceId, sourceWorkspaceId, publicId).run();
    await opsDb.prepare("UPDATE client_portal_workspace_binding_outbox SET state='acknowledged',attempt_count=1,claim_token=NULL,claim_until=NULL,acknowledged_claim_token='claim' WHERE operation_id=?").bind(selectionId).run();

    await clientDb.batch([
      clientDb.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT NOT NULL)"),
      clientDb.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
      clientDb.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
      clientDb.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
      clientDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,'organization',?,NULL,?,'active')").bind(workspaceId, publicId, sourceId),
      clientDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(workspaceId, sourceId, sourceWorkspaceId),
      clientDb.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot',?,'generation',1,?,'organization',?)").bind(workspaceId, sourceId, publicId),
      clientDb.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES(?,'generation',1,'snapshot')").bind(workspaceId),
    ]);
    await migrate(clientDb, ["0216_client_authority_workspace_ownership_claim.sql", "0217_client_authority_workspace_claim_evidence.sql",
      "0218_client_authority_workspace_binding.sql", "0219_operations_portal_authority_v2.sql",
      "0220_operations_portal_authority_v3_permissions.sql"], "client");
    await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: clientDb, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: selectionId, clientAuthorityId: authorityId, workspaceId, projectionSourceId: sourceId, sourceWorkspaceId,
      rootType: "organization", rootPublicId: publicId,
      expectedCheckpoint: { sourceGeneration: "generation", sourceSequence: 1, snapshotGenerationId: "snapshot" },
    });
  }, 30_000);

  afterAll(async () => runtime.dispose());

  it("redeems a signed recipient through private RPC, grants a home, then fully revokes and reconciles", async () => {
    const issued = await issueRecipientEnrollmentIntent(opsDb, { target: { clientRecordId: clientId, selectionId },
      expiresAt: future(), operationId: operation(), owner });
    if (!("opaqueToken" in issued)) throw Error("expected fresh enrollment token");
    const token = await new SignJWT({ type: "app", sub: "recipient-subject", email: "recipient@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "recipient-key", typ: "JWT" }).setIssuer(issuer).setAudience(audience)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600).sign(privateKey);
    const clientEnv = { CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience } as ClientEnv;
    const rpcEnv = { OPS_DB: opsDb, ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.example.test", TEAM_DOMAIN: issuer,
      CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED: "true" };
    const dependencies = { env: clientEnv, enabled: true, environment: "staging", origin,
      csrfSecret: "recipient-enrollment-test-csrf-secret-000000000000", binding: {
        inspectEnrollment: (input: unknown) => inspectRecipientEnrollmentRpc(rpcEnv, input),
        redeemEnrollment: (input: unknown) => redeemRecipientEnrollmentRpc(rpcEnv, input),
      }, resolveProof: (request: Request, env: ClientEnv) => resolveCloudflareRecipientEnrollmentProof(request, env, jwks) };
    const headers = { "Cf-Access-Jwt-Assertion": token, "X-Recipient-Enrollment-Request": "1", "Sec-Fetch-Site": "same-origin" };
    const session = await handleRecipientEnrollmentHttp(new Request(`${origin}/api/client/v2/recipient-enrollment/session`, { headers }), dependencies);
    expect(session.status).toBe(200);
    const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
    const post = (path: string, body: unknown) => handleRecipientEnrollmentHttp(new Request(`${origin}${path}`, { method: "POST",
      headers: { ...headers, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }), dependencies);
    const inspected = await post("/api/client/v2/recipient-enrollment/inspect", { intentId: issued.intentId, opaqueToken: issued.opaqueToken });
    expect(await inspected.json()).toMatchObject({ state: "issued", target: { clientRecordId: clientId, selectionId, displayLabel: "Example Customer" } });
    const redeemed = await post("/api/client/v2/recipient-enrollment/redeem", { intentId: issued.intentId, opaqueToken: issued.opaqueToken,
      operationId: operation(), acknowledged: true, acknowledgedTarget: { clientRecordId: clientId, selectionId } });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ intentId: issued.intentId, revision: 2, state: "pending" });
    expect(await opsDb.prepare("SELECT count(*) n FROM client_onboarding_recipient_identity_bindings").first("n")).toBe(0);

    const clientWriter = { DELIVERY_DB: clientDb, CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED: "true",
      CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED: "true" };
    const dispatch = { OPS_DB: opsDb, CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED: "true", CLIENT_PORTAL_AUTHORITY_V2: {
      applyAuthority: (input: unknown) => applyClientPortalAuthorityV2(clientWriter, input),
      getAuthorityStatus: (input: unknown) => getClientPortalAuthorityV2Status(clientWriter, input),
      applyAuthorityV3: (input: unknown) => applyClientPortalAuthorityV3(clientWriter, input),
      getAuthorityV3Status: (input: unknown) => getClientPortalAuthorityV3Status(clientWriter, input),
    } };
    const confirmed = await confirmRecipientEnrollmentIntent(opsDb, { intentId: issued.intentId, expectedRevision: 2,
      operationId: operation(), owner });
    expect(await dispatchNextClientPortalAuthorityV2(dispatch, confirmed.operationId)).toMatchObject({ status: "acknowledged" });
    const principal = { issuer, subject: "recipient-subject" };
    const head = await clientDb.prepare("SELECT client_authority_id,workspace_id,ownership_epoch,grant_revision,state,protocol_version,permissions_json,issuer,subject FROM portal_operations_principal_grant_heads").first();
    expect(head).toMatchObject({ client_authority_id: authorityId, workspace_id: workspaceId, ownership_epoch: 1,
      grant_revision: 1, state: "active", protocol_version: 3, permissions_json: '["operations.service_home.read"]',
      issuer, subject: principal.subject });
    expect(await clientDb.prepare("SELECT state,revision FROM portal_client_authority_workspace_bindings").first())
      .toEqual({ state: "inactive", revision: 1 });
    expect(await clientDb.prepare("SELECT protocol_version,permissions_json,resulting_state FROM portal_operations_authority_v2_receipts").first())
      .toEqual({ protocol_version: 3, permissions_json: '["operations.service_home.read"]', resulting_state: "active" });
    expect(await clientDb.prepare(`SELECT count(*) n FROM portal_operations_principal_grant_heads g
      JOIN portal_operations_workspace_authority_heads w ON w.workspace_id=g.workspace_id AND w.client_authority_id=g.client_authority_id
        AND w.ownership_epoch=g.ownership_epoch AND w.state='active'
      JOIN portal_client_authority_workspace_bindings b ON b.client_authority_id=w.client_authority_id AND b.workspace_id=w.workspace_id
        AND b.operation_id=w.binding_operation_id AND b.state='inactive' AND b.revision=1
      JOIN portal_v2_workspaces p ON p.id=b.workspace_id AND p.status='active'
      JOIN portal_operations_authority_v2_receipts r ON r.operation_id=g.last_operation_id AND r.client_authority_id=g.client_authority_id
        AND r.workspace_id=g.workspace_id AND r.issuer=g.issuer AND r.subject=g.subject AND r.ownership_epoch=g.ownership_epoch
        AND r.grant_revision=g.grant_revision AND r.resulting_state='active' AND r.protocol_version=3 AND r.permissions_json=g.permissions_json
      WHERE b.client_authority_id=? AND g.issuer=? AND g.subject=? AND g.state='active' AND g.protocol_version=3
        AND g.permissions_json='["operations.service_home.read"]'`).bind(authorityId, issuer, principal.subject).first("n")).toBe(1);
    await expect(readClientPortalServiceMetadata(opsDb, { protocolVersion: 1, authorityId, workspaceId,
      ownershipEpoch: 1, grantRevision: 1, issuer, subject: principal.subject })).resolves.toMatchObject({ ok: true, services: [] });
    const homeEnv = { DELIVERY_DB: clientDb, CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
      CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: (input: unknown) => readClientPortalServiceMetadataRpc({
        OPS_DB: opsDb, CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true" }, input) } };
    // Miniflare serializes the two D1 bindings slowly on Windows; freeze only the transport deadline while retaining
    // the real Client discovery query and real Operations metadata query.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(readOperationsServiceHome(homeEnv, principal, authorityId)).resolves.toMatchObject({ ok: true,
        authorityId, workspaceId, ownershipEpoch: 1, grantRevision: 1, services: [] });
    } finally { vi.useRealTimers(); }

    const revoked = await revokeRecipientEnrollmentBinding(opsDb, { intentId: issued.intentId, expectedRevision: 3,
      operationId: operation(), owner });
    await expect(readOperationsServiceHome(homeEnv, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
    expect(await dispatchNextClientPortalAuthorityV2(dispatch, revoked.operationId)).toMatchObject({ status: "acknowledged" });
    const reconciled = await reconcileRecipientEnrollmentRevocation(opsDb, { intentId: issued.intentId, expectedRevision: 4,
      operationId: operation(), owner });
    expect(reconciled.review).toMatchObject({ state: "revoked", revision: 5 });
    expect(await opsDb.prepare("SELECT status FROM client_onboarding_recipient_identity_bindings").first("status")).toBe("revoked");
    await expect(readOperationsServiceHome(homeEnv, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
  }, 30_000);
});
