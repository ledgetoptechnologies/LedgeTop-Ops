import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import {
  applyCanonicalChain, applyCanonicalTail, authorizeCanonicalUuidAcquisition, canonicalOwner,
  canonicalUuidOrganization, establishGovernedEmptyEnrollmentFixture, writeGovernedCanonicalUuidOrganization,
} from "./helpers/verified-recipient-canonical-lineage";

const sources = [
  { sourceId: "project-alpha:ltds-staging", sourceInstanceId: "51000000-0000-4000-8000-000000000001",
    applicationId: "51000000-0000-4000-8000-000000000002", historyEpoch: "51000000-0000-4000-8000-000000000003",
    baseUrl: "https://ltds-pa.example.test" },
  { sourceId: "project-alpha:ltt-staging", sourceInstanceId: "52000000-0000-4000-8000-000000000001",
    applicationId: "52000000-0000-4000-8000-000000000002", historyEpoch: "52000000-0000-4000-8000-000000000003",
    baseUrl: "https://ltt-pa.example.test" },
] as const;
const connections = JSON.stringify({ version: 1, instances: Object.fromEntries([
  [canonicalUuidOrganization.sourceId, { sourceId: canonicalUuidOrganization.sourceId, enabled: true,
    baseUrl: canonicalUuidOrganization.origin, apiKey: "fixture-secret", sourceInstanceId: canonicalUuidOrganization.sourceInstanceId,
    applicationId: canonicalUuidOrganization.applicationId, historyEpoch: canonicalUuidOrganization.historyEpochId }],
  ...sources.map(source => [source.sourceId, { ...source, enabled: true, apiKey: "fixture-secret" }]),
]) });

function creationRemote(): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname, requestId = crypto.randomUUID();
    const reply = (body: Record<string, unknown>, status = 200) => Response.json({ ...body, requestId }, { status,
      headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
    if (path.endsWith("/capabilities")) return reply({ apiVersion: "2", sourceInstanceId: canonicalUuidOrganization.sourceInstanceId,
      applicationId: canonicalUuidOrganization.applicationId, historyEpoch: canonicalUuidOrganization.historyEpochId,
      grantedCapabilities: ["api.capabilities.read", "directory.organizations.create"].map(name => ({ name })),
      implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "POST", path: "/api/v2/directory/organizations/commands", requiredCapability: "directory.organizations.create",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }] });
    const body = JSON.parse(String(init?.body));
    return reply({ sourceInstanceId: canonicalUuidOrganization.sourceInstanceId, applicationId: canonicalUuidOrganization.applicationId,
      historyEpoch: canonicalUuidOrganization.historyEpochId, replayed: false,
      result: { resource: { type: "organization", id: body.externalId, publicId: "b".repeat(32), revision: "1" },
        authorizationGeneration: "1" } }, 201);
  });
}


function twoSourceRemote(): typeof fetch {
  const generations = new Map(sources.map(source => [source.sourceId, "8"]));
  const bindingPath = `/api/v2/bindings/organization/status/${Buffer.from(canonicalUuidOrganization.recordId).toString("base64url")}`;
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const source = sources.find(value => new URL(value.baseUrl).host === url.host);
    if (!source) throw new Error(`unexpected source host: ${url.host}`);
    const requestId = crypto.randomUUID(), generation = generations.get(source.sourceId)!;
    const reply = (body: Record<string, unknown>) => Response.json({ ...body, requestId }, {
      headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
    if (url.pathname === "/api/v2/capabilities") return reply({ apiVersion: "2", sourceInstanceId: source.sourceInstanceId,
      applicationId: source.applicationId, historyEpoch: source.historyEpoch,
      grantedCapabilities: ["api.capabilities.read", "directory.organizations.read",
        "directory.organizations.binding_status.read", "directory.organizations.bind"].map(name => ({ name })),
      implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "GET", path: "/api/v2/directory/organizations/{publicId}", requiredCapability: "directory.organizations.read",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "GET", path: "/api/v2/bindings/organization/status/{base64urlExternalId}",
          requiredCapability: "directory.organizations.binding_status.read", requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "POST", path: "/api/v2/directory/organizations/bindings/commands", requiredCapability: "directory.organizations.bind",
          requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
          requiresExpectedPublicId: true, requiresExpectedRevision: true }] });
    const headers = new Headers(init?.headers);
    expect(headers.get("X-PA-Source-Instance-ID")).toBe(source.sourceInstanceId);
    expect(headers.get("X-PA-Application-ID")).toBe(source.applicationId);
    expect(headers.get("X-PA-History-Epoch")).toBe(source.historyEpoch);
    if (url.pathname === `/api/v2/directory/organizations/${canonicalUuidOrganization.publicId}`)
      return reply({ apiVersion: "2", sourceInstanceId: source.sourceInstanceId, applicationId: source.applicationId,
        historyEpoch: source.historyEpoch, authorizationGeneration: generation,
        resource: { type: "organization", id: canonicalUuidOrganization.publicId, revision: "7" },
        data: { publicId: canonicalUuidOrganization.publicId, name: "Overlapping customer", email: "overlap@example.test",
          phone: null, address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } } });
    if (url.pathname === bindingPath) return reply({ apiVersion: "2", sourceInstanceId: source.sourceInstanceId,
      applicationId: source.applicationId, historyEpoch: source.historyEpoch, authorizationGeneration: generation,
      binding: { type: "organization", externalId: canonicalUuidOrganization.recordId,
        publicId: canonicalUuidOrganization.publicId, createdAt: "2026-10-12T00:00:00.000Z" },
      resource: { revision: "7", present: true } });
    if (url.pathname === "/api/v2/directory/organizations/bindings/commands") {
      const body = JSON.parse(String(init?.body));
      expect(body.externalId).toBe(canonicalUuidOrganization.recordId);
      expect(body.expectedPublicId).toBe(canonicalUuidOrganization.publicId);
      expect(body.expectedAuthorizationGeneration).toBe(generation);
      const next = String(BigInt(generation) + 1n); generations.set(source.sourceId, next);
      return reply({ replayed: false, sourceInstanceId: source.sourceInstanceId, applicationId: source.applicationId,
        historyEpoch: source.historyEpoch, result: { binding: { publicId: canonicalUuidOrganization.publicId },
          resource: { type: "organization", id: canonicalUuidOrganization.recordId, revision: "7" },
          authorizationGeneration: next } });
    }
    throw new Error(`unexpected PA request: ${url.pathname}`);
  });
}


async function snapshot(db: D1Database, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => {
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results;
    return [table, JSON.stringify(rows)] as const;
  })));
}

describe("two-source existing-organization Directory import acceptance", () => {
  let runtime: Miniflare, db: D1Database;
  let reviewer: { staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number; grantGeneration: number };
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await applyCanonicalChain(db, "operations", "0152_operations_portal_workspace_reservations.sql", true);
    await establishGovernedEmptyEnrollmentFixture(db);
    const written = await writeGovernedCanonicalUuidOrganization(db);
    if (written.outcome.status !== "written") throw new Error("canonical fixture write failed");
    await dispatchProjectAlphaDirectoryProfileOutboxCommand({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections },
      canonicalUuidOrganization.sourceId, written.outcome.commandIds[0]!, creationRemote());
    reviewer = (await authorizeCanonicalUuidAcquisition(db)).reviewer;
    await applyCanonicalTail(db, "0152_operations_portal_workspace_reservations.sql", "0200_native_directory_active_binding_refresh_supersessions.sql");
  }, 240_000);
  afterAll(async () => runtime.dispose());

  it("keeps overlapping synthetic LTDS and LTT organization identities source-scoped, explicit, idempotent, and isolated", async () => {
    const untouched = ["operations_shared_projects", "sop_documents", "project_folders", "folder_rules",
      "client_portal_workspace_binding_selections", "operations_portal_folder_reservation_heads"] as const;
    const before = await snapshot(db, untouched), fetcher = twoSourceRemote();
    expect(Object.fromEntries(await Promise.all(untouched.map(async table =>
      [table, await db.prepare(`SELECT count(*) count FROM ${table}`).first("count")] as const))))
      .toEqual({ operations_shared_projects: 0, sop_documents: 0, project_folders: 0, folder_rules: 2,
        client_portal_workspace_binding_selections: 0, operations_portal_folder_reservation_heads: 0 });
    const evidenceBefore = await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_review_evidence")
      .first("count");
    const mappingBefore = await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings").first("count");
    const malformedBase = twoSourceRemote();
    const malformedIdentity = vi.fn<typeof fetch>(async (input, init) => {
      const response = await malformedBase(input, init), body = await response.json() as Record<string, unknown>;
      return Response.json({ ...body, sourceInstanceId: "59000000-0000-4000-8000-000000000001" }, {
        status: response.status, headers: response.headers });
    });
    await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
      PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, { reviewId: "64000000-0000-4000-8000-000000000001",
      commandId: "65000000-0000-4000-8000-000000000001", sourceId: sources[0].sourceId,
      recordId: canonicalUuidOrganization.recordId, externalId: canonicalUuidOrganization.recordId,
      resourceType: "organization", projectAlphaPublicId: canonicalUuidOrganization.publicId,
      expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "8", localRecordVersion: 1, reviewer },
    malformedIdentity)).resolves.toMatchObject({ status: "blocked", reason: "remote" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_review_evidence")
      .first("count")).toBe(evidenceBefore);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings").first("count"))
      .toBe(mappingBefore);
    const outcomes: Array<{ sourceId: string; activationId: string }> = [];
    for (const [index, source] of sources.entries()) {
      const suffix = String(index + 1).padStart(12, "0");
      const reviewId = `61000000-0000-4000-8000-${suffix}`, commandId = `62000000-0000-4000-8000-${suffix}`;
      const idempotencyKey = `63000000-0000-4000-8000-${suffix}`;
      const request = { reviewId, commandId, sourceId: source.sourceId,
        recordId: canonicalUuidOrganization.recordId, externalId: canonicalUuidOrganization.recordId,
        resourceType: "organization" as const, projectAlphaPublicId: canonicalUuidOrganization.publicId,
        expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "8", localRecordVersion: 1, reviewer };
      const acquired = await acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
        PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, request, fetcher);
      if (acquired.status !== "acquired") throw new Error(JSON.stringify(acquired));
      expect(acquired).toMatchObject({ status: "acquired", replayed: false });
      if (index === 0) {
        const receiptCount = await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_review_evidence")
          .first("count");
        await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
          PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, { ...request, sourceId: sources[1].sourceId }, fetcher))
          .resolves.toMatchObject({ status: "conflict" });
        expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_review_evidence")
          .first("count")).toBe(receiptCount);
        expect(await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings").first("count"))
          .toBe(mappingBefore);
      }
      const activated = await activateProjectAlphaExistingDirectoryBinding({ OPS_DB: db,
        PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, { reviewItemId: acquired.reviewReceiptId, idempotencyKey },
      { staffId: canonicalOwner.operationsStaffId, accessSubject: canonicalOwner.accessSubject }, fetcher);
      expect(activated).toMatchObject({ status: "activated", replayed: false,
        recordId: canonicalUuidOrganization.recordId });
      if (activated.status !== "activated") throw new Error(JSON.stringify(activated));
      await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections },
        { reviewId, commandId, sourceId: source.sourceId, recordId: canonicalUuidOrganization.recordId,
          externalId: canonicalUuidOrganization.recordId, resourceType: "organization",
          projectAlphaPublicId: canonicalUuidOrganization.publicId, expectedProjectAlphaRevision: "7",
          expectedAuthorizationGeneration: "8", localRecordVersion: 1, reviewer }, fetcher))
        .resolves.toMatchObject({ status: "acquired", replayed: true });
      await expect(activateProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections },
        { reviewItemId: acquired.reviewReceiptId, idempotencyKey },
        { staffId: canonicalOwner.operationsStaffId, accessSubject: canonicalOwner.accessSubject }, fetcher))
        .resolves.toMatchObject({ status: "activated", replayed: true });
      outcomes.push({ sourceId: source.sourceId, activationId: activated.activationId });
    }
    expect(new Set(outcomes.map(value => value.activationId)).size).toBe(2);
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings
      WHERE record_id=? AND external_id=? AND project_alpha_public_id=?
        AND source_id IN (?,?)`).bind(canonicalUuidOrganization.recordId, canonicalUuidOrganization.recordId,
      canonicalUuidOrganization.publicId, sources[0].sourceId, sources[1].sourceId).first("count")).toBe(2);
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections WHERE record_id=?")
      .bind(canonicalUuidOrganization.recordId).first("count")).toBe(0);
    expect(await snapshot(db, untouched)).toEqual(before);
  }, 240_000);
});

