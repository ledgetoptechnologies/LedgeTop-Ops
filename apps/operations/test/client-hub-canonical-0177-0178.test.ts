import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { findClientHubRoot, listClientHubRoots } from "../src/worker/client-hub-directory";
import { reconcileClientHubIndex } from "../src/worker/client-hub-index";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from
  "../src/worker/native-directory-profile-writer";
import { acquireProjectAlphaExistingDirectoryBinding } from
  "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from
  "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyCanonicalChain, applyCanonicalTail } from "./helpers/verified-recipient-canonical-lineage";

const migration0177 = "0177_operations_directory_acquired_intent_update_authority.sql";
const migration0178 = "0178_project_alpha_project_inbound_reconciliation.sql";
const sourceId = "project-alpha:primary";
const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpochId = "33333333-3333-4333-8333-333333333333";
const recordId = "hub-boundary/organization/one";
const externalId = "pa/organization/existing-boundary";
const publicId = "90000000000000000000000000000017";
const ownerId = "hub-boundary-owner";
const ownerSubject = "access|hub-boundary-owner";
const areaId = "hub-boundary-area";
const divisionId = "hub-boundary-division";
const profile = {
  name: "Canonical boundary organization",
  generalEmail: "boundary@example.test",
  generalPhone: "",
  addressLine1: "177 Boundary Way",
  addressLine2: "",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};
const connections = JSON.stringify({ version: 1, instances: { [sourceId]: {
  sourceId,
  enabled: true,
  baseUrl: "https://pa.example.test",
  apiKey: "synthetic-private-key",
  sourceInstanceId,
  applicationId,
  historyEpoch: historyEpochId,
} } });
const principal: StaffPrincipal = {
  id: ownerId,
  email: "hub-boundary-owner@example.test",
  displayName: "Hub boundary owner",
  accessSubject: ownerSubject,
  projectAlphaUserId: null,
};

let sequence = 1;
const uuid = () => `97000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;

function projectAlphaRemote() {
  let generation = "8";
  let request = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestId = `98000000-0000-4000-8000-${String(++request).padStart(12, "0")}`;
    const reply = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...body, requestId }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
    });
    if (path === "/api/v2/capabilities") return reply({
      apiVersion: "2",
      sourceInstanceId,
      applicationId,
      historyEpoch: historyEpochId,
      grantedCapabilities: ["api.capabilities.read", "directory.organizations.read",
        "directory.organizations.binding_status.read", "directory.organizations.bind"].map(name => ({ name })),
      implementedEndpoints: [
        { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "GET", path: "/api/v2/directory/organizations/{publicId}",
          requiredCapability: "directory.organizations.read", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "GET", path: "/api/v2/bindings/organization/status/{base64urlExternalId}",
          requiredCapability: "directory.organizations.binding_status.read", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "POST", path: "/api/v2/directory/organizations/bindings/commands",
          requiredCapability: "directory.organizations.bind", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true, requiresExpectedPublicId: true,
          requiresExpectedRevision: true },
      ],
    });
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== "Bearer synthetic-private-key"
      || headers.get("X-PA-Source-Instance-ID") !== sourceInstanceId
      || headers.get("X-PA-Application-ID") !== applicationId
      || headers.get("X-PA-History-Epoch") !== historyEpochId)
      throw new Error("synthetic PA identity boundary was not preserved");
    if (path === `/api/v2/directory/organizations/${publicId}`) return reply({
      apiVersion: "2",
      sourceInstanceId,
      applicationId,
      historyEpoch: historyEpochId,
      authorizationGeneration: generation,
      resource: { type: "organization", id: publicId, revision: "7" },
      data: { publicId, name: profile.name, email: profile.generalEmail, phone: null,
        address: { line1: profile.addressLine1, line2: null, city: profile.city, state: profile.state,
          postalCode: profile.postalCode, country: profile.country } },
    });
    if (path === `/api/v2/bindings/organization/status/${Buffer.from(externalId).toString("base64url")}`)
      return reply({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        authorizationGeneration: generation,
        binding: { type: "organization", externalId, publicId, createdAt: "2026-10-01T12:00:00.000Z" },
        resource: { revision: "7", present: true } });
    if (path === "/api/v2/directory/organizations/bindings/commands" && init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as Record<string, string>;
      if (command.externalId !== externalId || command.expectedPublicId !== publicId
        || command.expectedRevision !== "7" || command.expectedAuthorizationGeneration !== "8")
        throw new Error("binding command lost the reviewed identity tuple");
      generation = "9";
      return reply({ replayed: true, sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        result: { binding: { publicId }, resource: { type: "organization", id: externalId, revision: "7" },
          authorizationGeneration: generation } });
    }
    throw new Error(`unexpected synthetic PA request ${init?.method ?? "GET"} ${path}`);
  });
}

async function seedOwner(db: D1Database) {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(ownerId, principal.email, principal.displayName, ownerSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(ownerId, ownerSubject, ownerId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(ownerId, principal.email, principal.displayName),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${ownerId}-role`, ownerId, ownerId),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link",
      "directory.enrollment.manage"].map((permission, index) => db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,? ,?,'allow','global',1,?)`)
        .bind(`${ownerId}-native-${index}`, ownerId, permission, ownerId)),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,granted_by)
      VALUES(?,?,'project.shared.sync','allow','global',?)`).bind(`${ownerId}-project-sync`, ownerId, ownerId),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Hub boundary area',1)").bind(areaId),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES(?,?,'Hub boundary division',1)`).bind(divisionId, areaId),
  ]);
}

async function writeOrganization(db: D1Database) {
  const admissionId = `admission-${uuid()}`;
  const scope = { businessAreaId: areaId, divisionId };
  const destination = { sourceId, sourceInstanceUUID: sourceInstanceId, applicationUUID: applicationId,
    historyEpoch: historyEpochId, origin: "https://pa.example.test", externalCanonicalId: recordId,
    expectedAuthorizationGeneration: "0" };
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?, 'organization',?,?,?,?)`).bind(admissionId, ownerId, ownerSubject, recordId,
      JSON.stringify([scope]), JSON.stringify(profile), JSON.stringify([{ sourceId, sourceInstanceUUID: sourceInstanceId,
        applicationUUID: applicationId, historyEpoch: historyEpochId, origin: destination.origin,
        externalCanonicalId: recordId }]), ownerId).run();
  const write: NativeDirectoryCreateWrite = {
    operation: "create",
    mutationId: uuid(),
    createAdmissionId: admissionId,
    recordId,
    expectedLocalVersion: 0,
    kind: "organization",
    profile,
    scopes: [scope],
    destinations: [destination],
    actor: { staffId: ownerId, accessSubject: ownerSubject, loginEmail: principal.email, admissionVersion: 1,
      profileVersion: 1, selectedGrantId: `${ownerId}-native-1`, selectedIdentityGrantId: `${ownerId}-native-2` },
  };
  const outcome = await writeNativeDirectoryProfile(db, write);
  expect(outcome).toMatchObject({ status: "written", replayed: false, recordId, version: 1 });
}

async function activateAcquiredMapping(db: D1Database) {
  const grantGeneration = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(ownerId).first<number>("generation");
  if (grantGeneration === null) throw new Error("synthetic owner grant generation was not materialized");
  const remote = projectAlphaRemote();
  const acquired = await acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
    PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, {
      reviewId: uuid(), commandId: uuid(), sourceId, recordId, externalId, resourceType: "organization",
      projectAlphaPublicId: publicId, expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "8",
      localRecordVersion: 1, reviewer: { staffId: ownerId, accessSubject: ownerSubject, admissionVersion: 1,
        profileVersion: 1, grantGeneration },
    }, remote);
  expect(acquired).toMatchObject({ status: "acquired", replayed: false });
  if (acquired.status !== "acquired") throw new Error(`synthetic acquisition failed: ${JSON.stringify(acquired)}`);
  await expect(activateProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
    PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, {
      reviewItemId: acquired.reviewReceiptId,
      idempotencyKey: uuid(),
    }, { staffId: ownerId, accessSubject: ownerSubject }, remote)).resolves.toMatchObject({
      status: "activated",
      replayed: false,
      recordId,
    });
}

async function finishIndex(env: Env) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await reconcileClientHubIndex(env, 40);
    if (result.status === "complete") return;
    expect(result.status).toBe("progress");
  }
  throw new Error("Client Hub index did not finish within the test bound");
}

async function stableHubRead(env: Env) {
  const result = await listClientHubRoots(env, principal, { source: sourceId, grouping: "records", sort: "name" });
  expect(result.clients).toHaveLength(1);
  const listed = result.clients[0]!;
  const detail = await findClientHubRoot(env, "organization", recordId, sourceId, "business");
  await expect(findClientHubRoot(env, "organization", externalId, sourceId, "business"))
    .rejects.toMatchObject({ status: 404 });
  return {
    list: { sourceId: listed.source_id, namespace: listed.root_namespace, kind: listed.kind,
      publicId: listed.public_id, paPublicId: listed.pa_public_id, mappingStatus: listed.mapping_status,
      displayName: listed.display_name, detailPath: listed.detail_path },
    detail: { sourceId: detail.source_id, namespace: detail.root_namespace, kind: detail.kind,
      publicId: detail.public_id, paPublicId: detail.pa_public_id, mappingStatus: detail.mapping_status,
      displayName: detail.display_name },
    mapping: await env.OPS_DB.prepare(`SELECT source_id,resource_type,record_id,external_id,project_alpha_public_id
      FROM project_alpha_active_directory_mappings WHERE record_id=?`).bind(recordId).first(),
  };
}

describe("canonical Client Hub across the 0177 to 0178 boundary", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let ops: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
    ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await applyCanonicalChain(ops, "operations", migration0177, true);
    await applyCanonicalChain(delivery, "client", "0228_operations_portal_native_content_start_audit.sql");
    env = { OPS_DB: ops, DELIVERY_DB: delivery, PROJECT_ALPHA_API_V2_CONNECTIONS: connections } as Env;
    await seedOwner(ops);
    await writeOrganization(ops);
    await activateAcquiredMapping(ops);
    await finishIndex(env);
  }, 30_000);

  afterAll(async () => runtime?.dispose());

  it("keeps unequal acquired IDs canonical for list and detail after applying exactly 0178", async () => {
    expect(await ops.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
      .toBe(migration0177);
    const before = await stableHubRead(env);
    expect(before).toEqual({
      list: { sourceId, namespace: "business", kind: "organization", publicId: recordId,
        paPublicId: publicId, mappingStatus: "mapped", displayName: profile.name,
        detailPath: `/clients/sources/${encodeURIComponent(sourceId)}/business/organizations/${encodeURIComponent(recordId)}` },
      detail: { sourceId, namespace: "business", kind: "organization", publicId: recordId,
        paPublicId: publicId, mappingStatus: "mapped", displayName: profile.name },
      mapping: { source_id: sourceId, resource_type: "organization", record_id: recordId,
        external_id: externalId, project_alpha_public_id: publicId },
    });

    expect(await applyCanonicalTail(ops, migration0177, migration0178)).toEqual([migration0178]);
    expect(await ops.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
      .toBe(migration0178);
    await ops.prepare("UPDATE client_hub_directory_state SET next_run_at=NULL").run();
    await finishIndex(env);

    expect(await stableHubRead(env)).toEqual(before);
    expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
