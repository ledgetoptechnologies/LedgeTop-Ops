import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from
  "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace } from
  "../src/worker/operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication,
  dispatchOperationsPortalWorkspacePublication as dispatchPublication,
  type OperationsPortalWorkspacePublicationBinding } from
  "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from
  "../src/worker/operations-portal-workspace-publication-invocations";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc } from
  "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { issueOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent,
  confirmOperationsPortalNativeRecipientIntent, revokeOperationsPortalNativeRecipient,
  readOperationsPortalNativeRecipientIntent } from
  "../src/worker/operations-portal-native-recipient-authority";
import { materializeOperationsPortalNativeRecipientAuthority,
  dispatchOperationsPortalNativeRecipientAuthority } from
  "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus } from
  "../../client/src/worker/operations-portal-native-recipient-authority";
import { issueOperationsPortalNativeDeliveryAuthority, listOperationsPortalNativeDeliveryCandidates,
  revokeOperationsPortalNativeDeliveryAuthority } from
  "../src/worker/operations-portal-native-delivery-authority-issuer";
import { dispatchNextOperationsPortalNativeDeliveryAuthority } from
  "../src/worker/operations-portal-native-delivery-authority-dispatch";
import { readOperationsPortalNativeDeliveryAuthorizationEntrypoint } from
  "../src/worker/operations-portal-native-delivery-authority-reader";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus } from
  "../../client/src/worker/operations-portal-native-delivery-authority";
import { createOperationsNativeDeliveryRouter } from
  "../../client/src/worker/client-portal/operations-native-delivery-routes";
import { createOperationsHomeRouter } from
  "../../client/src/worker/client-portal/operations-home-routes";
import { createClientPortalRouter } from
  "../../client/src/worker/client-portal/routes";
import type { OperationsPortalNativeDeliveryAuthorityBinding } from
  "@ltds/shared/operations-portal-native-delivery-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import type { Env as ClientEnv } from "../../client/src/worker/types";
import { acquireProjectAlphaExistingDirectoryBinding } from
  "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from
  "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import { writeCustomerServiceEnrollment } from "../src/worker/ops-customer-service-enrollments";
import { readClientPortalServiceMetadataRpc } from "../src/worker/client-portal-service-metadata-entrypoint";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "../src/worker/project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";

let runtime: Miniflare, operations: D1Database, client: D1Database, bucket: R2Bucket, sequence = 1;
const id = () => `e0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const organization = "acceptance/organization/one", clientRecord = "acceptance/client/one";
const organizationExternalId = "pa/organization/existing-one";
const organizationPublicId = "90000000000000000000000000000001";
const projectPublicId = "90000000000000000000000000000003", projectProjectionSha256 = "a".repeat(64);
const sourceId = "project-alpha:primary";
const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpochId = "33333333-3333-4333-8333-333333333333";
const externalProject = "acceptance/project/one", physicalProject = "acceptance/physical/one";
const division = "acceptance-division", basePrefix = "acceptance/client-one/project/";
const selectedPrefix = `${basePrefix}selected/`, siblingPrefix = `${basePrefix}sibling/`;
const issuer = "https://acceptance.cloudflareaccess.com", subject = "access|acceptance-recipient";
const portalOrigin = "https://client-staging.ledgetopdroneservices.com";
const projectAlphaConnections = JSON.stringify({ version: 1, instances: { [sourceId]: {
  sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "acceptance-private-key",
  sourceInstanceId, applicationId, historyEpoch: historyEpochId,
} } });

function existingOrganizationRemote() {
  let generation = "8", bound = true, request = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestId = `91000000-0000-4000-8000-${String(++request).padStart(12, "0")}`;
    const headers = new Headers(init?.headers);
    const reply = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...body, requestId }), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
    });
    if (path === "/api/v2/capabilities") return reply({ apiVersion: "2", sourceInstanceId, applicationId,
      historyEpoch: historyEpochId, grantedCapabilities: ["api.capabilities.read", "directory.organizations.read",
        "directory.organizations.binding_status.read", "directory.organizations.bind"].map(name => ({ name })),
      implementedEndpoints: [
        { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "GET", path: "/api/v2/directory/organizations/{publicId}", requiredCapability: "directory.organizations.read",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "GET", path: "/api/v2/bindings/organization/status/{base64urlExternalId}",
          requiredCapability: "directory.organizations.binding_status.read", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "POST", path: "/api/v2/directory/organizations/bindings/commands",
          requiredCapability: "directory.organizations.bind", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true, requiresExpectedPublicId: true,
          requiresExpectedRevision: true },
      ] });
    if (headers.get("Authorization") !== "Bearer acceptance-private-key"
      || headers.get("X-PA-Source-Instance-ID") !== sourceInstanceId
      || headers.get("X-PA-Application-ID") !== applicationId
      || headers.get("X-PA-History-Epoch") !== historyEpochId) throw new Error("invalid PA identity boundary");
    if (path === `/api/v2/directory/organizations/${organizationPublicId}`) return reply({ apiVersion: "2",
      sourceInstanceId, applicationId, historyEpoch: historyEpochId, authorizationGeneration: generation,
      resource: { type: "organization", id: organizationPublicId, revision: "7" }, data: { publicId: organizationPublicId,
        name: "Existing acceptance organization", email: null, phone: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } } });
    if (path === `/api/v2/bindings/organization/status/${Buffer.from(organizationExternalId).toString("base64url")}`)
      return reply({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        authorizationGeneration: generation, binding: { type: "organization", externalId: organizationExternalId,
          publicId: organizationPublicId, createdAt: "2026-10-01T12:00:00.000Z" },
        resource: { revision: "7", present: bound } });
    if (path === "/api/v2/directory/organizations/bindings/commands" && init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as Record<string, string>;
      if (command.externalId !== organizationExternalId || command.expectedPublicId !== organizationPublicId
        || command.expectedRevision !== "7" || command.expectedAuthorizationGeneration !== "8")
        throw new Error("binding command lost reviewed identity");
      const replayed = bound; bound = true; generation = "9";
      return reply({ replayed, sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        result: { binding: { publicId: organizationPublicId },
          resource: { type: "organization", id: organizationExternalId, revision: "7" },
          authorizationGeneration: generation } });
    }
    throw new Error(`unexpected PA request ${init?.method ?? "GET"} ${path}`);
  });
}

function projectResponse(body: Record<string, unknown>, status = 200) {
  const requestId = typeof body.requestId === "string" ? body.requestId : "92000000-0000-4000-8000-000000000001";
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Request-ID": requestId } });
}
function projectCapabilities(capability: "projects.create" | "projects.v2.read") {
  const endpoint = capability === "projects.create"
    ? { method: "POST", path: "/api/v2/projects/commands", requiredCapability: capability }
    : { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: capability };
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
    requestId: "92000000-0000-4000-8000-000000000001",
    grantedCapabilities: ["api.capabilities.read", capability].map(name => ({ name })), implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { ...endpoint, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    ] };
}
async function activateProjectAlphaProject() {
  const principal = owner(), commandId = id();
  const action: Extract<ProjectAlphaProjectV2CommandProducerAction, { operation: "create" }> = {
    sourceId, actor: { staffId: principal.identity.staffId, accessSubject: principal.identity.verifiedAccessSubject,
      email: principal.identity.email, admissionVersion: principal.admissionVersion,
      profileVersion: principal.identity.profileVersion, verifiedUntil: principal.verifiedUntil, scopes: [] },
    operation: "create", local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
    directory: { organizationRecordId: organization, clientRecordId: null },
    command: { commandId, externalId: externalProject, expectedAuthorizationGeneration: "9",
      project: { name: "Selected Deliverables", description: "Project-v2 portal provenance acceptance",
        estimatedStart: null, estimatedEnd: null },
      organization: { externalId: organizationExternalId, expectedPublicId: organizationPublicId,
        expectedRevision: "7", expectedProjectionSha256: projectProjectionSha256 }, client: null },
  };
  const environment = { OPS_DB: operations, PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaConnections };
  const mismatchedCommandId = id();
  const mismatchedAction = { ...action, command: { ...action.command, commandId: mismatchedCommandId,
    organization: { ...action.command.organization, externalId: organization } } };
  await expect(planProjectAlphaProjectV2Command(environment, mismatchedAction))
    .resolves.toEqual({ status: "blocked", reason: "directory" });
  await expect(Promise.all([
    operations.prepare("SELECT count(*) AS count FROM project_alpha_project_outbox WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM native_project_command_reservations WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM native_project_command_proofs WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_request_fingerprints WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_events WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_canonical_intents WHERE command_id=?")
      .bind(mismatchedCommandId).first("count"),
    operations.prepare("SELECT count(*) AS count FROM project_alpha_project_destinations WHERE external_project_id=?")
      .bind(externalProject).first("count"),
  ])).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  await expect(planProjectAlphaProjectV2Command(environment, action)).resolves.toMatchObject({ status: "queued", replayed: false });
  const commandTransport = vi.fn<typeof fetch>(async (_input, init) => init?.method !== "POST"
    ? projectResponse(projectCapabilities("projects.create"))
    : projectResponse({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
      requestId: "92000000-0000-4000-8000-000000000001", replayed: false,
      result: { resource: { type: "project", id: externalProject, publicId: projectPublicId, revision: "1",
        projectionSha256: projectProjectionSha256 }, authorizationGeneration: "10",
        presentation: { portalPublished: false, publicLinkEnabled: false } } }, 201));
  const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(environment, sourceId, commandId, commandTransport);
  expect(dispatched).toMatchObject({ status: "acknowledged", replayed: false, receiptId: expect.any(String) });
  if (dispatched.status !== "acknowledged") throw new Error("Project-v2 command was not acknowledged");
  const readTransport = vi.fn<typeof fetch>(async input => String(input).endsWith("/api/v2/capabilities")
    ? projectResponse(projectCapabilities("projects.v2.read"))
    : projectResponse({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
      requestId: "92000000-0000-4000-8000-000000000002", replayed: false, accepted: true,
      resource: { type: "project", id: projectPublicId, revision: "1", projectionSha256: projectProjectionSha256 },
      data: { name: action.command.project.name, description: action.command.project.description, status: "active",
        archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null,
        estimatedEnd: null, clientPublicId: null, organizationPublicId } }));
  const settled = await settleProjectAlphaProjectV2Read({ OPS_DB: operations }, dispatched.receiptId, {
    baseUrl: "https://pa.example.test", apiKey: "acceptance-private-key", expectedSourceInstanceId: sourceInstanceId,
    expectedApplicationId: applicationId, expectedHistoryEpoch: historyEpochId,
  }, readTransport);
  expect(settled).toMatchObject({ status: "settled", commandId, successReceiptId: dispatched.receiptId });
  if (settled.status !== "settled") throw new Error(`Project-v2 read was not settled: ${JSON.stringify(settled)}`);
  await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: operations }, settled.settlementId))
    .resolves.toMatchObject({ status: "activated", commandId, externalProjectId: externalProject, version: 1 });
  expect(await operations.prepare(`SELECT source_id,external_project_id,project_alpha_public_id FROM project_alpha_project_mappings
    WHERE external_project_id=?`).bind(externalProject).first())
    .toEqual({ source_id: sourceId, external_project_id: externalProject, project_alpha_public_id: projectPublicId });
  expect(await operations.prepare(`SELECT external_project_id,name,lifecycle,organization_record_id,client_record_id
    FROM operations_shared_projects WHERE external_project_id=?`).bind(externalProject).first())
    .toEqual({ external_project_id: externalProject, name: "Selected Deliverables", lifecycle: "active",
      organization_record_id: organization, client_record_id: null });
  expect(await operations.prepare(`SELECT external_project_id,version,pa_revision FROM operations_shared_project_revisions
    WHERE external_project_id=?`).bind(externalProject).first())
    .toEqual({ external_project_id: externalProject, version: 1, pa_revision: null });
  expect(await operations.prepare(`SELECT project_alpha_revision FROM project_alpha_project_v2_canonical_settlement_receipts
    WHERE command_id=?`).bind(commandId).first("project_alpha_revision")).toBe("1");
}

function future(hours = 1) { return new Date(Date.now() + hours * 3_600_000).toISOString(); }
function owner(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "acceptance-owner",
    verifiedAccessSubject: "access|acceptance-owner", email: "acceptance-owner@example.test",
    displayName: "Acceptance Owner", profileVersion: 1 }, admissionVersion: 1, verifiedUntil: future(2) };
}
async function applyDraft(database: D1Database, application: "operations" | "client", name: string) {
  const url = application === "operations" ? new URL(`../migrations/${name}`, import.meta.url)
    : new URL(`../../client/migrations/${name}`, import.meta.url);
  await database.batch(splitD1MigrationStatements(readFileSync(url, "utf8")).map(sql => database.prepare(sql)));
}
async function seedOwner() {
  await operations.batch([
    operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('acceptance-owner','acceptance-owner@example.test','Acceptance Owner','access|acceptance-owner','active')`),
    operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('acceptance-owner','access|acceptance-owner',1,'acceptance-owner')`),
    operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('acceptance-owner','acceptance-owner@example.test','Acceptance Owner')`),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('acceptance-owner-role','acceptance-owner','role-owner','global',NULL,'global','acceptance-owner')`),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link",
      "directory.enrollment.manage"].map((permission, index) =>
      operations.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,'acceptance-owner',?,'allow','global',1,'acceptance-owner')`)
        .bind(`acceptance-native-grant-${index}`, permission)),
    ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) =>
      operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,'acceptance-owner',?,'allow','global',NULL,'global','acceptance-owner')`)
        .bind(`acceptance-delivery-permission-${index}`, permission)),
    operations.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,granted_by)
      VALUES('acceptance-project-sync','acceptance-owner','project.shared.sync','allow','global','acceptance-owner')`),
  ]);
}
async function seedDirectoryRecord(recordId: string, kind: "organization" | "client", parent: string | null = null) {
  const mutationId = id(), admissionId = `admission-${id()}`;
  const scopes = [{ businessAreaId: "acceptance-area", divisionId: "acceptance-business-division" }];
  const destination = { sourceId: "project-alpha:primary",
    sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
    applicationUUID: "22222222-2222-4222-8222-222222222222",
    historyEpoch: "33333333-3333-4333-8333-333333333333", origin: "https://pa.example.test",
    externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  const profile = kind === "organization"
    ? { name: "Acceptance Organization", generalEmail: "organization@example.test", generalPhone: "",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: "Acceptance Client", email: "client@example.test", phone: "", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  await operations.batch([
    operations.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "acceptance-owner", "access|acceptance-owner", recordId, kind,
        JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
          sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
          historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]),
        "acceptance-owner"),
    ...(kind === "client" ? [operations.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,1)`).bind(admissionId, recordId, parent)] : []),
  ]);
  const write = { operation: "create", mutationId, createAdmissionId: admissionId, recordId,
    expectedLocalVersion: 0, kind, profile, scopes, destinations: [destination], actor: {
      staffId: "acceptance-owner", accessSubject: "access|acceptance-owner", loginEmail: "acceptance-owner@example.test",
      admissionVersion: 1, profileVersion: 1, selectedGrantId: "acceptance-native-grant-1",
      selectedIdentityGrantId: "acceptance-native-grant-2" },
    ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {}),
  } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(operations, write);
  if (outcome.status !== "written") throw new Error(`directory fixture failed: ${outcome.reason}`);
  return { write, outcome };
}
async function dispatchPublicationCommand(operationId: string) {
  const clientEnvironment = { DELIVERY_DB: client, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
    ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
  const binding: OperationsPortalWorkspacePublicationBinding = {
    publishWorkspace: publication => publishOperationsPortalWorkspaceRpc(clientEnvironment, publication).then(JSON.stringify),
    getPublicationStatus: publication => getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication).then(JSON.stringify),
  };
  const invocationId = id();
  await reserveOperationsPortalWorkspacePublicationInvocation(operations, owner(), { invocationId, operationId,
    action: "publish", reason: "Acceptance publish" });
  return dispatchPublication({ db: operations, binding, operationId, invocationId, action: "publish" });
}

describe("Ops Delivery to authenticated Client portal resource acceptance", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), CLIENT_DB: crypto.randomUUID() },
      r2Buckets: { DATA_BUCKET: crypto.randomUUID() } });
    operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    client = await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
    bucket = await runtime.getR2Bucket("DATA_BUCKET") as unknown as R2Bucket;
    // Keep the migrated schema aligned with the current native-directory
    // producers used to establish the pre-onboarding source of truth.
    await applyCanonicalChain(operations, "operations", "0187_operations_portal_native_delivery_literal_prefix_guard.sql", true);
    await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql");
    for (const name of ["0224_operations_portal_native_recipient_authority.sql",
      "0225_operations_portal_workspace_publication_cancellations.sql",
      "0226_operations_portal_native_workspace_cleanup.sql",
      "0227_operations_portal_native_delivery_authority.sql",
      "0228_operations_portal_native_content_start_audit.sql"])
      await applyDraft(client, "client", name);
    await seedOwner();
    await operations.batch([
      operations.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Acceptance Division','ACCEPT',1)").bind(division),
      operations.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('acceptance-area','Acceptance Area',1)"),
      operations.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
        VALUES('acceptance-business-division','acceptance-area','Acceptance Business Division',1)`),
    ]);
    await seedDirectoryRecord(organization, "organization");
    const grantGeneration = await operations.prepare(`SELECT generation FROM native_directory_grant_generations
      WHERE staff_id='acceptance-owner'`).first<number>("generation");
    if (grantGeneration === null) throw new Error("owner grant generation was not materialized");
    const acquisitionInput = { reviewId: id(), commandId: id(), sourceId, recordId: organization,
      externalId: organizationExternalId, resourceType: "organization" as const,
      projectAlphaPublicId: organizationPublicId, expectedProjectAlphaRevision: "7",
      expectedAuthorizationGeneration: "8", localRecordVersion: 1, reviewer: {
        staffId: "acceptance-owner", accessSubject: "access|acceptance-owner", admissionVersion: 1,
        profileVersion: 1, grantGeneration,
      } };
    const remote = existingOrganizationRemote();
    const acquired = await acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: operations,
      PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaConnections }, acquisitionInput, remote);
    if (acquired.status !== "acquired") {
      const failures = await Promise.all(remote.mock.results.map(async result => {
        try { await result.value; return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
      }));
      throw new Error(`reviewed acquisition failed: ${JSON.stringify({ acquired, failures,
        calls: remote.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: init?.body })) })}`);
    }
    expect(acquired).toMatchObject({ status: "acquired", replayed: false });
    await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: operations,
      PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaConnections }, acquisitionInput, remote))
      .resolves.toMatchObject({ status: "acquired", replayed: true });
    await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: operations,
      PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaConnections }, {
        ...acquisitionInput, externalId: `${organizationExternalId}-tampered`,
      }, remote)).resolves.toEqual({ status: "conflict", reason: "reservation" });
    await expect(activateProjectAlphaExistingDirectoryBinding({ OPS_DB: operations,
      PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaConnections }, {
        reviewItemId: acquired.reviewReceiptId, idempotencyKey: id(),
      }, { staffId: "acceptance-owner", accessSubject: "access|acceptance-owner" }, remote))
      .resolves.toMatchObject({ status: "activated", recordId: organization });
    expect(await operations.prepare(`SELECT record_id,external_id,mapping_kind
      FROM project_alpha_active_directory_mappings WHERE record_id=?`).bind(organization).first())
      .toEqual({ record_id: organization, external_id: organizationExternalId, mapping_kind: "acquired" });
    await seedDirectoryRecord(clientRecord, "client", organization);
    await activateProjectAlphaProject();
    await operations.batch([
      operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
        VALUES(?,?,?,?,?,?)`).bind(physicalProject, division, basePrefix, "manual", "acceptance-owner", "2026-10-01 12:00:00"),
    ]);
  }, 240_000);
  afterAll(async () => runtime?.dispose());

  it("denies unenrolled and cross-tenant principals, resolves only the enrolled workspace, and preserves public shares", async () => {
    // Model a pre-existing PA-authoritative public link. Seed it before any
    // workspace publication, recipient enrollment, or delivery-authority work
    // so the invariant covers the complete onboarding/grant path, not only
    // the final resource reads and revoke.
    await client.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix)
      VALUES('acceptance-public-project','Public client','Public project','public/acceptance/')`).run();
    await client.prepare(`INSERT INTO shares(id,project_id,token_hash,label,created_by_type,created_by_id)
      VALUES('acceptance-public-share','acceptance-public-project','acceptance-public-token','Public link','staff','acceptance-owner')`).run();
    const publicShareBefore = await client.prepare("SELECT * FROM shares WHERE id='acceptance-public-share'").first();
    const expectPublicShareUnchanged = async () => {
      expect(await client.prepare("SELECT * FROM shares WHERE id='acceptance-public-share'").first())
        .toEqual(publicShareBefore);
    };
    await operations.batch([
      operations.prepare(`INSERT INTO operations_service_definitions
        (service_id,provider_id,source_id,source_service_id,display_name)
        VALUES('acceptance-drone','ltds-drone','project-alpha:primary','drone','Drone services')`),
      operations.prepare(`INSERT INTO operations_service_definitions
        (service_id,provider_id,source_id,source_service_id,display_name)
        VALUES('acceptance-website','ltt-web','project-alpha:secondary','website','Website services')`),
    ]);
    await writeCustomerServiceEnrollment(operations, owner(), { mutationId: id(), idempotencyKey: id(),
      customerRecordId: clientRecord, serviceId: "acceptance-drone", desiredState: "active", expectedRevision: 0 });
    await writeCustomerServiceEnrollment(operations, owner(), { mutationId: id(), idempotencyKey: id(),
      customerRecordId: clientRecord, serviceId: "acceptance-website", desiredState: "active", expectedRevision: 0 });
    await writeCustomerServiceEnrollment(operations, owner(), { mutationId: id(), idempotencyKey: id(),
      customerRecordId: clientRecord, serviceId: "acceptance-website", desiredState: "revoked", expectedRevision: 1 });

    const workspace = { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
      rootKind: "organization" as const, rootRecordId: organization, rootRecordVersion: 1,
      relationshipVersion: null, expectedRevision: 0 as const, reason: "Acceptance workspace" };
    await reserveOperationsPortalWorkspace(operations, owner(), workspace);
    const folder = { operationId: id(), targetId: workspace.targetId, reservationId: id(), expectedRevision: 0 as const,
      expectedWorkspaceRevision: 1, externalProjectId: externalProject, projectVersion: 1,
      opsFolderProjectId: physicalProject, opsDivisionId: division, baseR2Prefix: basePrefix,
      baseMatchMethod: "manual", baseConfirmedBy: "acceptance-owner", baseConfirmedAt: "2026-10-01 12:00:00",
      clientFolderBindingId: `client-folder:${id()}`, selectedR2Prefix: selectedPrefix,
      reason: "Exact selected folder" };
    await reserveOperationsPortalFolder(operations, owner(), folder);
    const publication = await reserveOperationsPortalWorkspacePublication(operations, owner(), { operationId: id(),
      publicationId: id(), targetId: workspace.targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 0,
      reason: "Publish exact selected folder" });
    await expect(dispatchPublicationCommand(publication.operationId)).resolves.toMatchObject({ status: "acknowledged" });
    await expectPublicShareUnchanged();

    const reader = { readNativeDeliveryAuthorization: (input: Parameters<typeof readOperationsPortalNativeDeliveryAuthorizationEntrypoint>[1]) =>
      readOperationsPortalNativeDeliveryAuthorizationEntrypoint({ OPS_DB: operations, ENVIRONMENT: "staging",
        EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
        OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" }, input) };
    const portalEnvironment = { DELIVERY_DB: client, DATA_BUCKET: bucket, ENVIRONMENT: "staging",
      CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: portalOrigin,
      CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
      CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: async (input: unknown) =>
        JSON.stringify(await readClientPortalServiceMetadataRpc({ OPS_DB: operations,
          CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
          CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true" }, input)) },
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: reader,
      DELIVERY_SESSION_SECRET: "acceptance-handle-secret-at-least-32-bytes",
      CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: "acceptance-audit-secret-at-least-32-bytes" } as unknown as ClientEnv;
    let activePrincipal = { issuer, subject, email: "recipient@example.test" };
    const resolvePrincipal = async () => activePrincipal;
    // Match the production Client Worker mount order and prefixes: this proves
    // service discovery, Delivery content, and generic portal admission share
    // one host without turning a service-home grant into broad portal access.
    const router = new Hono<{ Bindings: ClientEnv }>();
    router.route("/api/client/v2/operations", createOperationsHomeRouter({ resolvePrincipal }));
    router.route("/api/client/operations/data", createOperationsNativeDeliveryRouter({ resolvePrincipal }));
    router.route("/api/client", createClientPortalRouter({ resolvePrincipal }));

    const unenrolledHome = await router.fetch(new Request(`${portalOrigin}/api/client/v2/operations/home`), portalEnvironment);
    expect(unenrolledHome.status).toBe(403);
    expect(await unenrolledHome.json()).toEqual({ error: "Client access is not provisioned" });
    const unenrolledDeliveries = await router.fetch(
      new Request(`${portalOrigin}/api/client/operations/data/deliveries`), portalEnvironment);
    expect(unenrolledDeliveries.status).toBe(200);
    expect(await unenrolledDeliveries.json()).toEqual({
      resourceMode: "operations_native_delivery",
      items: [],
      page: { nextCursor: null }
    });

    const issued = await issueOperationsPortalNativeRecipientIntent(operations, { operationId: id(),
      targetId: workspace.targetId, targetClientRecordId: clientRecord, expiresAt: future(24), owner: owner() });
    await redeemOperationsPortalNativeRecipientIntent(operations, { operationId: id(), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(2), acknowledgedTarget: { targetId: workspace.targetId, targetRevision: 1,
        clientRecordId: clientRecord } });
    const homeOperationId = id();
    await confirmOperationsPortalNativeRecipientIntent(operations, { operationId: homeOperationId,
      intentId: issued.review.intentId, expectedRevision: 2, owner: owner() });
    await materializeOperationsPortalNativeRecipientAuthority(operations, homeOperationId);
    const recipientEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" } as const;
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeAuthority: wire => applyOperationsPortalNativeRecipientAuthority(recipientEnvironment, wire),
        getNativeAuthorityStatus: wire => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnvironment, wire),
      } }, homeOperationId)).resolves.toMatchObject({ status: "acknowledged" });
    await expectPublicShareUnchanged();
    const home = await readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId);
    expect(home).toMatchObject({ state: "active", recipientBindingId: expect.any(String) });
    if (!home?.recipientBindingId) throw new Error("recipient onboarding did not produce a binding");

    const candidate = (await listOperationsPortalNativeDeliveryCandidates(operations,
      { targetId: workspace.targetId, owner: owner() })).items.find(value =>
        value.recipientBindingId === home.recipientBindingId && value.folderReservationId === folder.reservationId);
    if (!candidate) throw new Error("reviewed delivery candidate was not produced");
    const authorityId = id(), grantOperationId = id();
    await issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: grantOperationId, authorityId,
      recipientBindingId: home.recipientBindingId, folderReservationId: folder.reservationId, expectedRevision: 0,
      expectedCandidateFingerprint: candidate.candidateFingerprint,
      features: ["folder.list", "file.metadata", "file.preview", "file.download"], expiresAt: future(1),
      reasonCode: "Acceptance exact folder grant", owner: owner() });
    const deliveryEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: "true" } as const;
    const deliveryBinding: OperationsPortalNativeDeliveryAuthorityBinding = {
      applyNativeDeliveryAuthority: wire => applyOperationsPortalNativeDeliveryAuthority(deliveryEnvironment, wire),
      getNativeDeliveryAuthorityStatus: wire => readOperationsPortalNativeDeliveryAuthorityStatus(deliveryEnvironment, wire),
    };
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: operations,
      binding: deliveryBinding, operationId: grantOperationId })).resolves.toEqual({ operationId: grantOperationId,
      state: "acknowledged" });
    await expectPublicShareUnchanged();

    const selectedKey = `${selectedPrefix}selected.txt`, siblingKey = `${siblingPrefix}sibling.txt`;
    const selectedObject = await bucket.put(selectedKey, "selected body", { httpMetadata: { contentType: "text/plain" } });
    const siblingObject = await bucket.put(siblingKey, "sibling secret", { httpMetadata: { contentType: "text/plain" } });
    await client.batch([
      client.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
        VALUES(?,?,?,datetime('now'),'text/plain','other')`).bind(selectedKey, selectedObject!.etag, 13),
      client.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
        VALUES(?,?,?,datetime('now'),'text/plain','other')`).bind(siblingKey, siblingObject!.etag, 14),
    ]);
    const homeDiscovery = await router.fetch(new Request(`${portalOrigin}/api/client/v2/operations/home`), portalEnvironment);
    expect(homeDiscovery.status, await homeDiscovery.clone().text()).toBe(200);
    const homePayload = await homeDiscovery.json() as { resourceMode: string; homes: Array<{
      authorityId: string; workspaceId: string; services: Array<{ serviceId: string }> }> };
    expect(homePayload.resourceMode).toBe("operations_home");
    expect(homePayload.homes).toHaveLength(1);
    expect(homePayload.homes[0]).toMatchObject({
      authorityId: workspace.clientAuthorityId,
      workspaceId: workspace.workspaceId
    });
    expect(homePayload.homes.flatMap(value => value.services.map(service => service.serviceId)))
      .toEqual(["acceptance-drone"]);
    const genericSession = await router.fetch(new Request(`${portalOrigin}/api/client/session`), portalEnvironment);
    expect([401, 403]).toContain(genericSession.status);
    const genericCatalog = await router.fetch(new Request(`${portalOrigin}/api/client/service-catalog`), portalEnvironment);
    expect([401, 403]).toContain(genericCatalog.status);

    const discovery = await router.fetch(new Request(`${portalOrigin}/api/client/operations/data/deliveries`), portalEnvironment);
    expect(discovery.status, await discovery.clone().text()).toBe(200);
    const deliveryPage = await discovery.json() as { items: Array<{ id: string; displayName: string }> };
    expect(deliveryPage.items).toEqual([{ id: expect.stringMatching(/^ond1_/), displayName: "Selected Deliverables" }]);
    const rootHandle = deliveryPage.items[0]!.id;

    // The same provider-local subject under another Access issuer is another tenant.
    // It must not collide with the enrolled issuer+subject tuple or reuse its handle.
    activePrincipal = {
      issuer: "https://collision.cloudflareaccess.com",
      subject,
      email: "collision@example.test"
    };
    const collisionHome = await router.fetch(new Request(`${portalOrigin}/api/client/v2/operations/home`), portalEnvironment);
    expect(collisionHome.status).toBe(403);
    const collisionDiscovery = await router.fetch(
      new Request(`${portalOrigin}/api/client/operations/data/deliveries`), portalEnvironment);
    expect(collisionDiscovery.status).toBe(200);
    expect(await collisionDiscovery.json()).toEqual({
      resourceMode: "operations_native_delivery",
      items: [],
      page: { nextCursor: null }
    });
    const collisionHandle = await router.fetch(
      new Request(`${portalOrigin}/api/client/operations/data/folders/${encodeURIComponent(rootHandle)}`),
      portalEnvironment);
    expect(collisionHandle.status).toBe(404);
    activePrincipal = { issuer, subject, email: "recipient@example.test" };

    const listing = await router.fetch(new Request(`${portalOrigin}/api/client/operations/data/folders/${encodeURIComponent(rootHandle)}`), portalEnvironment);
    expect(listing.status, await listing.clone().text()).toBe(200);
    const contents = await listing.json() as { files: Array<{ id: string; name: string }>; folders: Array<{ name: string }> };
    expect(contents.files.map(value => value.name)).toEqual(["selected.txt"]);
    expect(contents.folders).toEqual([]);
    expect(JSON.stringify(contents)).not.toContain(siblingPrefix);
    expect(JSON.stringify(contents)).not.toContain("sibling.txt");
    const fileHandle = contents.files[0]!.id;
    const downloadUrl = `${portalOrigin}/api/client/operations/data/files/${encodeURIComponent(fileHandle)}/download`;
    const download = await router.fetch(new Request(downloadUrl), portalEnvironment);
    expect(download.status, await download.clone().text()).toBe(200);
    expect(await download.text()).toBe("selected body");

    const sibling = await router.fetch(new Request(
      `${portalOrigin}/api/client/operations/data/files/${encodeURIComponent(siblingKey)}/download`), portalEnvironment);
    expect(sibling.status).toBe(404);
    expect(await sibling.text()).not.toContain("sibling secret");
    const contentStartCount = await client.prepare(
      "SELECT count(*) count FROM operations_portal_native_content_start_events")
      .first<number>("count");
    expect(contentStartCount).toBeGreaterThan(0);

    const revokeOperationId = id();
    await revokeOperationsPortalNativeDeliveryAuthority(operations, { operationId: revokeOperationId,
      authorityId, expectedRevision: 1, reasonCode: "Acceptance revoke", owner: owner() });
    await expectPublicShareUnchanged();
    expect((await router.fetch(new Request(downloadUrl), portalEnvironment)).status).toBe(404);
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: operations,
      binding: deliveryBinding, operationId: revokeOperationId })).resolves.toEqual({ operationId: revokeOperationId,
      state: "acknowledged" });
    await expectPublicShareUnchanged();
    expect((await router.fetch(new Request(downloadUrl), portalEnvironment)).status).toBe(404);
    expect(await client.prepare("SELECT state FROM operations_portal_native_delivery_heads WHERE authority_id=?")
      .bind(authorityId).first("state")).toBe("revoked");
    const homeAfterDeliveryRevoke = await router.fetch(new Request(`${portalOrigin}/api/client/v2/operations/home`), portalEnvironment);
    expect(homeAfterDeliveryRevoke.status).toBe(200);
    expect(await homeAfterDeliveryRevoke.json()).toMatchObject({ homes: [{ services: [{ serviceId: "acceptance-drone" }] }] });

    const recipientRevokeOperationId = id();
    await revokeOperationsPortalNativeRecipient(operations, { operationId: recipientRevokeOperationId,
      intentId: issued.review.intentId, expectedRevision: 4, owner: owner() });
    await materializeOperationsPortalNativeRecipientAuthority(operations, recipientRevokeOperationId);
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeAuthority: wire => applyOperationsPortalNativeRecipientAuthority(recipientEnvironment, wire),
        getNativeAuthorityStatus: wire => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnvironment, wire),
      } }, recipientRevokeOperationId)).resolves.toMatchObject({ status: "acknowledged" });
    await expect(readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId))
      .resolves.toMatchObject({ state: "revoked", revision: 6 });
    expect((await router.fetch(new Request(
      `${portalOrigin}/api/client/operations/data/folders/${encodeURIComponent(rootHandle)}`), portalEnvironment)).status)
      .toBe(404);
    expect((await router.fetch(new Request(downloadUrl), portalEnvironment)).status).toBe(404);
    expect(await client.prepare("SELECT state FROM operations_portal_native_delivery_heads WHERE authority_id=?")
      .bind(authorityId).first("state")).toBe("revoked");
    expect(await client.prepare(`SELECT state FROM operations_portal_native_recipient_authority_heads
      WHERE recipient_binding_id=?`).bind(home.recipientBindingId).first("state")).toBe("revoked");
    expect(await operations.prepare(`SELECT count(*) count FROM operations_portal_native_authority_receipts
      WHERE operation_id=?`).bind(recipientRevokeOperationId).first<number>("count")).toBe(1);
    expect(await client.prepare("SELECT count(*) count FROM operations_portal_native_content_start_events")
      .first<number>("count")).toBe(contentStartCount);
    expect((await router.fetch(new Request(`${portalOrigin}/api/client/v2/operations/home`), portalEnvironment)).status)
      .toBe(403);
    await expectPublicShareUnchanged();
    expect(await client.prepare("SELECT * FROM shares WHERE id='acceptance-public-share'").first()).toEqual(publicShareBefore);
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
