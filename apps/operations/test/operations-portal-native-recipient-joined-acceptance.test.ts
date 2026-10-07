import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { resolveCloudflareClientPrincipal, resolveCloudflareRecipientEnrollmentProof } from
  "../../client/src/worker/client-portal/access-identity";
import { createOperationsHomeRouter } from "../../client/src/worker/client-portal/operations-home-routes";
import { handleOperationsNativeRecipientEnrollmentHttp } from
  "../../client/src/worker/client-portal/operations-native-recipient-enrollment-http";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus } from
  "../../client/src/worker/operations-portal-native-recipient-authority";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc } from
  "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import type { Env as ClientEnv } from "../../client/src/worker/types";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from
  "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication, dispatchOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationBinding } from
  "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from
  "../src/worker/operations-portal-workspace-publication-invocations";
import { readClientPortalServiceMetadataRpc } from "../src/worker/client-portal-service-metadata-entrypoint";
import { writeCustomerServiceEnrollment } from "../src/worker/ops-customer-service-enrollments";
import { issueOperationsPortalNativeRecipientIntent, confirmOperationsPortalNativeRecipientIntent,
  revokeOperationsPortalNativeRecipient, readOperationsPortalNativeRecipientIntent } from
  "../src/worker/operations-portal-native-recipient-authority";
import { inspectOperationsPortalNativeRecipientEnrollmentRpc,
  redeemOperationsPortalNativeRecipientEnrollmentRpc } from
  "../src/worker/operations-portal-native-recipient-enrollment-entrypoint";
import { dispatchOperationsPortalNativeRecipientAuthority,
  materializeOperationsPortalNativeRecipientAuthority } from
  "../src/worker/operations-portal-native-recipient-authority-dispatch";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

let sequence = 1;
const id = () => `a0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const rootId = "ops/organization/joined-recipient", clientId = "ops/client/joined-recipient";
const issuer = "https://joined-recipient.cloudflareaccess.com", subject = "access|joined-recipient";
const audience = "joined-recipient-client-portal";
const clientOrigin = "https://client-staging.ledgetopdroneservices.com";
const future = (hours = 1) => new Date(Date.now() + hours * 3_600_000).toISOString();
function owner(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "joined-recipient-owner",
    verifiedAccessSubject: "access|joined-recipient-owner", email: "joined-owner@example.test",
    displayName: "Joined Recipient Owner", profileVersion: 1 }, admissionVersion: 1, verifiedUntil: future(2) };
}

async function applyDraft(database: D1Database, application: "operations" | "client", name: string) {
  const url = application === "operations" ? new URL(`../migrations/${name}`, import.meta.url)
    : new URL(`../../client/migrations/${name}`, import.meta.url);
  await database.batch(splitD1MigrationStatements(readFileSync(url, "utf8"))
    .map(statement => database.prepare(statement)));
}

async function seedOwner(database: D1Database) {
  await database.batch([
    database.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('joined-recipient-owner','joined-owner@example.test','Joined Recipient Owner',
        'access|joined-recipient-owner','active')`),
    database.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('joined-recipient-owner','access|joined-recipient-owner',1,'joined-recipient-owner')`),
    database.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('joined-recipient-owner','joined-owner@example.test','Joined Recipient Owner')`),
    database.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('joined-recipient-owner-role','joined-recipient-owner','role-owner','global',NULL,'global',
        'joined-recipient-owner')`),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link",
      "directory.enrollment.manage"].map((permission, index) =>
      database.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,'joined-recipient-owner',?,'allow','global',1,'joined-recipient-owner')`)
        .bind(`joined-recipient-grant-${index}`, permission)),
    database.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('joined-recipient-projects-view','joined-recipient-owner','projects.view','allow','global',NULL,
        'global','joined-recipient-owner')`),
  ]);
}

async function seedRecord(database: D1Database, recordId: string, kind: "organization" | "client",
  parent: string | null = null) {
  const mutationId = id(), admissionId = `joined-admission-${id()}`;
  const scopes = [{ businessAreaId: "joined-recipient-area", divisionId: "joined-recipient-division" }];
  const destination = { sourceId: "project-alpha:primary",
    sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
    applicationUUID: "22222222-2222-4222-8222-222222222222",
    historyEpoch: "33333333-3333-4333-8333-333333333333",
    origin: "https://pa.example.test", externalCanonicalId: recordId,
    expectedAuthorizationGeneration: "0" };
  const profile = kind === "organization"
    ? { name: "Joined Organization", generalEmail: "organization@example.test", generalPhone: "",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: "Joined Client", email: "client@example.test", phone: "", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  await database.batch([
    database.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, owner().identity.staffId, owner().identity.verifiedAccessSubject,
        recordId, kind, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
          sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
          historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]),
        owner().identity.staffId),
    ...(kind === "client" ? [database.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,?)`).bind(admissionId, recordId, parent, parent === null ? null : 1)] : []),
  ]);
  const write = { operation: "create", mutationId, createAdmissionId: admissionId, recordId,
    expectedLocalVersion: 0, kind, profile, scopes, destinations: [destination], actor: {
      staffId: owner().identity.staffId, accessSubject: owner().identity.verifiedAccessSubject,
      loginEmail: owner().identity.email, admissionVersion: 1, profileVersion: 1,
      selectedGrantId: "joined-recipient-grant-1", selectedIdentityGrantId: "joined-recipient-grant-2" },
    ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {}),
  } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(database, write);
  if (outcome.status !== "written") throw new Error(`native directory fixture failed: ${outcome.reason}`);
  expect(outcome).toMatchObject({ status: "written", version: 1 });
  return { write, outcome };
}

async function acknowledgeCreate(database: D1Database, seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string) {
  for (const commandId of seed.outcome.commandIds) await database.batch([
    database.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,
      lease_token='joined-recipient-fixture',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`)
      .bind(commandId),
    database.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,?,?,?,?,?,?,?)`).bind(seed.write.destinations[0]!.sourceId, seed.write.kind, seed.write.recordId,
        publicId, seed.write.destinations[0]!.sourceInstanceUUID, seed.write.destinations[0]!.applicationUUID,
        seed.write.destinations[0]!.historyEpoch, commandId),
    database.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({
        status: "acknowledged", response: { sourceInstanceId: seed.write.destinations[0]!.sourceInstanceUUID,
          applicationId: seed.write.destinations[0]!.applicationUUID, historyEpoch: seed.write.destinations[0]!.historyEpoch,
          result: { resource: { type: seed.write.kind, id: seed.write.recordId, publicId, revision: "1" },
            data: { publicId }, authorizationGeneration: "1" } },
      }), commandId),
  ]);
  await database.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(seed.write.mutationId).run();
}

describe("Ops-native recipient joined local acceptance", () => {
  let runtime: Miniflare, operations: D1Database, client: D1Database;
  let accessPrivateKey: CryptoKey, accessJwks: JWTVerifyGetKey;
  let targetId: string, authorityId: string, workspaceId: string;

  async function accessToken(tokenSubject = subject, tokenIssuer = issuer) {
    return new SignJWT({ type: "app", sub: tokenSubject, email: "joined-recipient@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "joined-recipient-access", typ: "JWT" })
      .setIssuer(tokenIssuer).setAudience(audience).setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(accessPrivateKey);
  }

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
    operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    client = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const accessKeys = await generateKeyPair("RS256", { extractable: true });
    const accessPublicJwk = await exportJWK(accessKeys.publicKey);
    accessPublicJwk.alg = "RS256"; accessPublicJwk.kid = "joined-recipient-access"; accessPublicJwk.use = "sig";
    accessPrivateKey = accessKeys.privateKey;
    accessJwks = createLocalJWKSet({ keys: [accessPublicJwk] });
    expect(await applyCanonicalChain(operations, "operations",
      "0153_operations_portal_workspace_publication_outbox.sql", true)).toHaveLength(153);
    for (const name of ["0154_operations_portal_native_recipient_authority.sql",
      "0156_operations_portal_workspace_publication_invocations.sql",
      "0157_operations_portal_native_workspace_cleanup.sql", "0160_operations_portal_native_recipient_labels.sql"])
      await applyDraft(operations, "operations", name);
    // Current directory consumers require the explicit Operations-record ID
    // projection introduced by 0170; this historical acceptance fixture stops
    // its canonical chain at 0153 and therefore applies that view migration
    // explicitly rather than exercising an obsolete mapping shape.
    await applyDraft(operations, "operations", "0170_project_alpha_active_directory_project_guard.sql");
    expect(await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql"))
      .toHaveLength(142);
    await applyDraft(client, "client", "0224_operations_portal_native_recipient_authority.sql");
    await seedOwner(operations);
    await operations.batch([
      operations.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('joined-recipient-area','Joined Area',1)"),
      operations.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
        VALUES('joined-recipient-division','joined-recipient-area','Joined Division',1)`),
    ]);
    const organization = await seedRecord(operations, rootId, "organization");
    await acknowledgeCreate(operations, organization, "10000000000000000000000000000001");
    await seedRecord(operations, clientId, "client", rootId);
    await operations.prepare(`INSERT INTO operations_service_definitions
      (service_id,provider_id,source_id,source_service_id,display_name)
      VALUES('web','operations','joined-fixture','web','Website services')`).run();
    await expect(writeCustomerServiceEnrollment(operations, owner(), { mutationId: id(), idempotencyKey: id(),
      customerRecordId: clientId, serviceId: "web", desiredState: "active", expectedRevision: 0 }))
      .resolves.toMatchObject({ state: "active", revision: 1, replayed: false });

    targetId = id(); authorityId = id(); workspaceId = `workspace:${id()}`;
    await reserveOperationsPortalWorkspace(operations, owner(), { operationId: id(), targetId, clientAuthorityId: authorityId,
      workspaceId, rootKind: "organization", rootRecordId: rootId, rootRecordVersion: 1,
      relationshipVersion: null, expectedRevision: 0, reason: "Reserve joined recipient workspace" });
    const publication = await reserveOperationsPortalWorkspacePublication(operations, owner(), { operationId: id(),
      publicationId: id(), targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 0,
      reason: "Publish joined recipient topology" });
    const invocationId = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, owner(), { invocationId,
      operationId: publication.operationId, action: "publish", reason: "Dispatch joined recipient topology" });
    const publicationEnvironment = { DELIVERY_DB: client, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
      ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
    const binding: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async wire => JSON.stringify(await publishOperationsPortalWorkspaceRpc(publicationEnvironment, wire)),
      getPublicationStatus: async wire => JSON.stringify(
        await getOperationsPortalWorkspacePublicationStatusRpc(publicationEnvironment, wire)),
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding,
      operationId: publication.operationId, invocationId, action: "publish" }))
      .resolves.toMatchObject({ status: "acknowledged" });
  }, 240_000);

  afterAll(async () => runtime.dispose());

  it("joins owner issue, Client consent, durable receipt, service home, revoke, and reconciliation", async () => {
    const issued = await issueOperationsPortalNativeRecipientIntent(operations, { operationId: id(), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner: owner() });
    if (!issued.opaqueToken) throw new Error("expected one-time enrollment token");
    const recipientAccessToken = await accessToken();
    const clientAccessEnv = { CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience } as ClientEnv;
    const enrollmentEnv = { OPS_DB: operations, ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.example.test",
      TEAM_DOMAIN: issuer, CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true" } as const;
    const dependencies = { env: clientAccessEnv, enabled: true, environment: "staging", origin: clientOrigin,
      csrfSecret: "joined-native-recipient-csrf-secret-long-enough", binding: {
        inspectNativeEnrollment: (input: unknown) => inspectOperationsPortalNativeRecipientEnrollmentRpc(enrollmentEnv, input),
        redeemNativeEnrollment: (input: unknown) => redeemOperationsPortalNativeRecipientEnrollmentRpc(enrollmentEnv, input),
      }, resolveProof: (request: Request, env: ClientEnv) =>
        resolveCloudflareRecipientEnrollmentProof(request, env, accessJwks) };
    const headers = { Origin: clientOrigin, "Sec-Fetch-Site": "same-origin", "X-Operations-Enrollment-Request": "1",
      "Cf-Access-Jwt-Assertion": recipientAccessToken };
    const session = await handleOperationsNativeRecipientEnrollmentHttp(new Request(
      `${clientOrigin}/api/client/operations/recipient-enrollment/session`, { headers }), dependencies);
    expect(session.status).toBe(200);
    const csrf = (await session.json() as { csrfToken: string }).csrfToken;
    const post = (action: "inspect" | "redeem", body: unknown) => handleOperationsNativeRecipientEnrollmentHttp(new Request(
      `${clientOrigin}/api/client/operations/recipient-enrollment/${action}`, { method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(body) }), dependencies);
    // Canonical Miniflare D1 calls are slower than the production service-binding
    // deadline on Windows. Freeze only the local transport timer; the real Ops
    // inspect/redeem queries and every identity/CSRF check still execute.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const inspection = await post("inspect", { intentId: issued.review.intentId, opaqueToken: issued.opaqueToken });
      const inspectionBody = await inspection.json();
      expect(inspection.status, JSON.stringify(inspectionBody)).toBe(200);
      expect(inspectionBody).toMatchObject({ state: "issued", target: { targetId, targetRevision: 1,
        clientRecordId: clientId, displayLabel: "Joined Client" } });
      const consent = await post("redeem", { intentId: issued.review.intentId, opaqueToken: issued.opaqueToken,
        operationId: id(), acknowledged: true, acknowledgedTarget: { targetId, targetRevision: 1,
          clientRecordId: clientId } });
      expect(consent.status).toBe(200);
      expect(await consent.json()).toMatchObject({ state: "pending", revision: 2 });
    } finally { vi.useRealTimers(); }

    const confirmOperationId = id();
    await confirmOperationsPortalNativeRecipientIntent(operations, { operationId: confirmOperationId,
      intentId: issued.review.intentId, expectedRevision: 2, owner: owner() });
    await materializeOperationsPortalNativeRecipientAuthority(operations, confirmOperationId);
    const clientAuthorityEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" } as const;
    const dispatchEnv = { OPS_DB: operations, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority(clientAuthorityEnv, wire),
        getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(clientAuthorityEnv, wire),
      } };
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, confirmOperationId))
      .resolves.toMatchObject({ status: "acknowledged" });
    await expect(readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId))
      .resolves.toMatchObject({ state: "active", revision: 4 });
    expect(await operations.prepare("SELECT count(*) count FROM operations_portal_native_authority_receipts")
      .first<number>("count")).toBe(1);

    const homeEnv = { DELIVERY_DB: client, CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true", CLIENT_PORTAL_ORIGIN: clientOrigin,
      CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience,
      CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true", CLIENT_PORTAL_SERVICE_METADATA_READER: {
        readServiceMetadata: async (input: unknown) => JSON.stringify(await readClientPortalServiceMetadataRpc({
          OPS_DB: operations, CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
          CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true" }, input)),
      } } as unknown as ClientEnv;
    const homeRouter = createOperationsHomeRouter({ resolvePrincipal: (request, env) =>
      resolveCloudflareClientPrincipal(request, env, accessJwks) });
    const homeRequest = (token: string) => new Request(`${clientOrigin}/home/${authorityId}`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const home = await homeRouter.fetch(homeRequest(recipientAccessToken), homeEnv);
    expect(home.status).toBe(200);
    expect(await home.json()).toMatchObject({ resourceMode: "operations_home", authorityId, workspaceId,
      ownershipEpoch: 1, grantRevision: 1,
      services: [{ serviceId: "web", providerId: "operations", displayLabel: "Website services", revision: 1 }] });
    expect((await homeRouter.fetch(homeRequest(await accessToken(subject, "https://wrong.cloudflareaccess.com")), homeEnv)).status)
      .toBe(401);
    expect((await homeRouter.fetch(homeRequest(await accessToken("access|wrong-recipient")), homeEnv)).status).toBe(403);

    const revokeOperationId = id();
    await revokeOperationsPortalNativeRecipient(operations, { operationId: revokeOperationId,
      intentId: issued.review.intentId, expectedRevision: 4, owner: owner() });
    expect((await homeRouter.fetch(homeRequest(recipientAccessToken), homeEnv)).status).toBe(403);
    await materializeOperationsPortalNativeRecipientAuthority(operations, revokeOperationId);
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, revokeOperationId))
      .resolves.toMatchObject({ status: "acknowledged" });
    await expect(readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId))
      .resolves.toMatchObject({ state: "revoked", revision: 6 });
    expect((await homeRouter.fetch(homeRequest(recipientAccessToken), homeEnv)).status).toBe(403);
    expect(await operations.prepare("SELECT count(*) count FROM operations_portal_native_authority_receipts")
      .first<number>("count")).toBe(2);
    expect(await client.prepare("SELECT state FROM operations_portal_native_recipient_authority_heads")
      .first<string>("state")).toBe("revoked");
  });
});
