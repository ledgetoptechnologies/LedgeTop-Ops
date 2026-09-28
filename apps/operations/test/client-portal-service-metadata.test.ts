import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readClientPortalServiceMetadata } from "../src/worker/client-portal-service-metadata";

describe("private client portal service metadata reader", () => {
  let runtime: Miniflare;
  let db: D1Database;
  const authorityId = "11111111-1111-4111-8111-111111111111";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const recipientId = "33333333-3333-4333-8333-333333333333";
  const workspaceId = "workspace-one";
  const issuer = "https://access.example.test";
  const subject = "principal-one";
  const customer = "customer-one";
  const request = () => ({ protocolVersion: 1 as const, authorityId, workspaceId,
    ownershipEpoch: 1, grantRevision: 1, issuer, subject });

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const schema = [
      `CREATE TABLE client_portal_authority_v2_outbox(operation_id TEXT PRIMARY KEY,binding_operation_id TEXT,
        client_authority_id TEXT,workspace_id TEXT,recipient_binding_id TEXT,issuer TEXT,subject TEXT,
        desired_state TEXT,expected_ownership_epoch INTEGER,expected_grant_revision INTEGER,state TEXT)`,
      `CREATE TABLE client_portal_authority_v2_outbox_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,
        workspace_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,resulting_state TEXT)`,
      `CREATE TABLE client_portal_workspace_binding_outbox(operation_id TEXT PRIMARY KEY,state TEXT)`,
      `CREATE TABLE client_portal_workspace_binding_outbox_receipts(operation_id TEXT PRIMARY KEY,
        client_authority_id TEXT,workspace_id TEXT,state TEXT,revision INTEGER)`,
      `CREATE TABLE client_portal_workspace_binding_selections(selection_id TEXT PRIMARY KEY,client_authority_id TEXT,
        workspace_id TEXT,record_id TEXT,root_type TEXT)`,
      `CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY,target_client_record_id TEXT,
        access_issuer TEXT,access_subject TEXT,status TEXT,expires_at TEXT)`,
      `CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT)`,
      `CREATE TABLE operations_service_definitions(service_id TEXT PRIMARY KEY,provider_id TEXT,display_name TEXT)`,
      `CREATE TABLE operations_customer_service_enrollments(customer_record_id TEXT,service_id TEXT,state TEXT,revision INTEGER)`,
    ];
    await db.batch(schema.map(sql => db.prepare(sql)));
  });
  afterAll(async () => { await runtime.dispose(); });

  beforeEach(async () => {
    for (const table of ["client_portal_authority_v2_outbox_receipts", "client_portal_authority_v2_outbox",
      "client_portal_workspace_binding_outbox_receipts", "client_portal_workspace_binding_outbox",
      "client_portal_workspace_binding_selections", "client_onboarding_recipient_identity_bindings",
      "operations_directory_client_organizations", "operations_customer_service_enrollments",
      "operations_service_definitions"]) await db.prepare(`DELETE FROM ${table}`).run();
    await db.batch([
      db.prepare(`INSERT INTO client_portal_workspace_binding_outbox VALUES(?,'acknowledged')`).bind(bindingId),
      db.prepare(`INSERT INTO client_portal_workspace_binding_outbox_receipts VALUES(?,?,?,'inactive',1)`)
        .bind(bindingId, authorityId, workspaceId),
      db.prepare(`INSERT INTO client_portal_workspace_binding_selections VALUES(?,?,?,?,?)`)
        .bind(bindingId, authorityId, workspaceId, customer, "standalone_client"),
      db.prepare(`INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,?,?,?, 'active',NULL)`)
        .bind(recipientId, customer, issuer, subject),
      db.prepare(`INSERT INTO client_portal_authority_v2_outbox VALUES('active-op',?,?,?,?,?,?, 'active',0,0,'acknowledged')`)
        .bind(bindingId, authorityId, workspaceId, recipientId, issuer, subject),
      db.prepare(`INSERT INTO client_portal_authority_v2_outbox_receipts VALUES('active-op',?,?,?,?,1,1,'active')`)
        .bind(authorityId, workspaceId, issuer, subject),
      db.prepare(`INSERT INTO operations_service_definitions VALUES('service-ltds','ltds','Inspection')`),
      db.prepare(`INSERT INTO operations_service_definitions VALUES('service-ltt','ltt','Inspection')`),
      db.prepare(`INSERT INTO operations_customer_service_enrollments VALUES(?,'service-ltds','active',3)`).bind(customer),
      db.prepare(`INSERT INTO operations_customer_service_enrollments VALUES(?,'service-ltt','active',7)`).bind(customer),
    ]);
  });

  it("returns provider-qualified, bounded metadata while keeping same-name services distinct", async () => {
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toEqual({ ok: true, protocolVersion: 1,
      services: [
        { serviceId: "service-ltds", providerId: "ltds", displayLabel: "Inspection", revision: 3 },
        { serviceId: "service-ltt", providerId: "ltt", displayLabel: "Inspection", revision: 7 },
      ] });
  });

  it("fails closed for swapped principals, grant mismatch, and binding receipt mismatch", async () => {
    await expect(readClientPortalServiceMetadata(db, { ...request(), issuer: subject, subject: issuer }))
      .resolves.toMatchObject({ ok: false, code: "denied" });
    await expect(readClientPortalServiceMetadata(db, { ...request(), grantRevision: 2 }))
      .resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE client_portal_workspace_binding_outbox_receipts SET workspace_id='other'").run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
  });

  it("fails closed when the exact recipient is expired or revoked", async () => {
    await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at='2000-01-01T00:00:00.000Z'").run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=NULL,status='revoked'").run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
  });

  it("returns only current active enrollments for the exact bound customer", async () => {
    await db.prepare("UPDATE operations_customer_service_enrollments SET state='revoked' WHERE service_id='service-ltds'").run();
    await db.prepare("INSERT INTO operations_customer_service_enrollments VALUES('other-customer','service-ltds','active',99)").run();
    const result = await readClientPortalServiceMetadata(db, request());
    expect(result).toEqual({ ok: true, protocolVersion: 1,
      services: [{ serviceId: "service-ltt", providerId: "ltt", displayLabel: "Inspection", revision: 7 }] });
  });

  it("uses an organization only to validate the current relation, never to inherit sibling services", async () => {
    await db.prepare("UPDATE client_portal_workspace_binding_selections SET record_id='organization-one',root_type='organization'").run();
    await db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,'organization-one')").bind(customer).run();
    await db.prepare("INSERT INTO operations_directory_client_organizations VALUES('sibling-customer','organization-one')").run();
    await db.prepare("INSERT INTO operations_customer_service_enrollments VALUES('sibling-customer','service-ltds','active',99)").run();
    const result = await readClientPortalServiceMetadata(db, request());
    expect(result.ok && result.services.map(service => service.revision)).toEqual([3, 7]);
    await db.prepare("DELETE FROM operations_directory_client_organizations WHERE client_record_id=?").bind(customer).run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
  });

  it("returns an empty list for a valid authority with no active enrollments", async () => {
    await db.prepare("UPDATE operations_customer_service_enrollments SET state='revoked'").run();
    await expect(readClientPortalServiceMetadata(db, request()))
      .resolves.toEqual({ ok: true, protocolVersion: 1, services: [] });
  });

  it("blocks a newer revoke as soon as it is queued and after it is acknowledged", async () => {
    await db.prepare(`INSERT INTO client_portal_authority_v2_outbox VALUES('revoke-op',?,?,?,?,?,?, 'revoked',1,1,'pending')`)
      .bind(bindingId, authorityId, workspaceId, recipientId, issuer, subject).run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE client_portal_authority_v2_outbox SET state='acknowledged' WHERE operation_id='revoke-op'").run();
    await db.prepare(`INSERT INTO client_portal_authority_v2_outbox_receipts VALUES('revoke-op',?,?,?,?,1,2,'revoked')`)
      .bind(authorityId, workspaceId, issuer, subject).run();
    await expect(readClientPortalServiceMetadata(db, request())).resolves.toMatchObject({ ok: false, code: "denied" });
  });

  it("fences an earlier receipt when a higher ownership epoch command is pending", async () => {
    await db.prepare(`INSERT INTO client_portal_authority_v2_outbox VALUES('epoch-op',?,?,?,?,?,?, 'active',2,0,'pending')`)
      .bind(bindingId, authorityId, workspaceId, recipientId, issuer, subject).run();
    await expect(readClientPortalServiceMetadata(db, request()))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
  });

  it("rejects non-exact requests and fails instead of truncating an oversized result", async () => {
    await expect(readClientPortalServiceMetadata(db, { ...request(), extra: true }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "invalid_request" });
    const inserts = Array.from({ length: 99 }, (_, index) => {
      const id = `bulk-${String(index).padStart(3, "0")}`;
      return [db.prepare("INSERT INTO operations_service_definitions VALUES(?,?,'Bulk')").bind(id, "bulk"),
        db.prepare("INSERT INTO operations_customer_service_enrollments VALUES(?,?,'active',1)").bind(customer, id)];
    }).flat();
    await db.batch(inserts);
    await expect(readClientPortalServiceMetadata(db, request()))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "overflow" });
  });

  it("rejects accessor, symbol, and hostile proxy inputs and contains storage failures", async () => {
    const accessor = Object.fromEntries(Object.entries(request()));
    Object.defineProperty(accessor, "subject", { enumerable: true, get: () => subject });
    await expect(readClientPortalServiceMetadata(db, accessor))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "invalid_request" });
    await expect(readClientPortalServiceMetadata(db, { ...request(), [Symbol("hidden")]: true }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "invalid_request" });
    const hostile = new Proxy(request(), { ownKeys: () => { throw Error("hostile"); } });
    await expect(readClientPortalServiceMetadata(db, hostile))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "invalid_request" });
    const broken = { withSession: () => { throw Error("storage unavailable"); } } as unknown as D1Database;
    await expect(readClientPortalServiceMetadata(broken, request()))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
  });
});
