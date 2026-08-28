import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { readOrganizationOperationalContacts, saveOrganizationOperationalContacts } from "../src/worker/organization-operational-contacts";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const source = "project-alpha:primary", secondary = "project-alpha:secondary";
const TEST_TIMEOUT_MS = 40_000;
const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau Koltz", accessSubject: "owner", projectAlphaUserId: null };
const operationKey = () => `organization_contacts_${crypto.randomUUID()}`;
let runtime: Miniflare, database: D1Database, environment: Pick<Env, "OPS_DB">, sequence = 0;
let beforeMigration: unknown, afterMigration: unknown;

async function stableAuthority() {
  const tables = ["staff_users", "staff_role_assignments", "staff_permission_overrides", "pa_clients", "pa_organizations",
    "pa_projects", "pa_projection_record_ids", "pa_application_entitlements", "viewer_processing_notification_outbox"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}
interface Fixture {
  context: ClientHubCollectionContext; organizationId: string; primaryId: string; deliveryId: string;
  secondDeliveryId: string; otherId: string; secondaryId: string;
}
async function fixture(): Promise<Fixture> {
  const n = ++sequence, organizationId = `organization-contacts-org-${n}`, otherOrg = `organization-contacts-other-${n}`;
  const primaryId = `organization-contacts-primary-${n}`, deliveryId = `organization-contacts-delivery-${n}`;
  const secondDeliveryId = `organization-contacts-delivery-two-${n}`, otherId = `organization-contacts-other-contact-${n}`;
  const secondaryOrg = `organization-contacts-secondary-org-${n}`, secondaryId = `organization-contacts-secondary-contact-${n}`;
  await database.batch([
    ...[[source, "organization", organizationId], [source, "organization", otherOrg], [source, "client", primaryId],
      [source, "client", deliveryId], [source, "client", secondDeliveryId], [source, "client", otherId],
      [secondary, "organization", secondaryOrg], [secondary, "client", secondaryId]].map(([src, kind, id]) =>
      database.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        VALUES(?,?,?,?)`).bind(src, kind, id, id)),
    database.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,1,'{}',?,?)`).bind(organizationId, `Organization ${n}`, `organization-sync-${n}`, source),
    database.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,1,'{}',?,?)`).bind(otherOrg, `Other organization ${n}`, `other-organization-sync-${n}`, source),
    database.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,1,'{}',?,?)`).bind(secondaryOrg, `Secondary organization ${n}`, `secondary-organization-sync-${n}`, secondary),
    ...[[primaryId, "Primary person", organizationId, source, { email: `primary-${n}@example.test`, phone: "+15550000101" }],
      [deliveryId, "Delivery person", organizationId, source, { email: `delivery-${n}@example.test` }],
      [secondDeliveryId, "Second delivery person", organizationId, source, { phone: "+15550000102" }],
      [otherId, "Outside person", otherOrg, source, { email: `outside-${n}@example.test` }],
      [secondaryId, "Secondary person", secondaryOrg, secondary, { email: `secondary-${n}@example.test` }]]
      .map(([id, name, org, src, payload]) => database.prepare(`INSERT INTO pa_clients
        (id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,?,?)`)
        .bind(id, name, org, JSON.stringify(payload), `contact-sync-${id}`, src)),
  ]);
  return { organizationId, primaryId, deliveryId, secondDeliveryId, otherId, secondaryId,
    context: { root: { source_id: source, root_namespace: "business", kind: "organization", public_id: organizationId,
      pa_public_id: organizationId, mapping_status: "mapped", display_name: `Organization ${n}`, source_name: "Project Alpha",
      sort_name: `organization ${n}`, status: "active", portal_status: "none", workspace_id: null, legacy_account_id: null,
      account_count: 0, project_count: 0, request_count: 0, contact_count: 3, meaningful_activity_at: null,
      source_version: `organization-sync-${n}`, indexed_at: "2026-08-28T00:00:00.000Z", scan_generation: 1 },
      access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "c".repeat(43),
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: organizationId } } };
}

function raceDatabase(action: () => Promise<void>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; sql: string }>(); let fired = false;
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => { const proxy = new Proxy(raw, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } }); statements.set(proxy, { raw, sql }); return proxy; };
  const proxy: D1Database = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async <T>(values: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!fired && values.some(value => statements.get(value)?.sql.includes("INSERT INTO organization_operational_write_fences"))) {
        fired = true; await action();
      }
      return target.batch<T>(values.map(value => statements.get(value)?.raw ?? value));
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

function readRaceDatabase(action: () => Promise<void>): D1Database {
  let assignmentReads = 0, fired = false;
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(raw, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
    if (property === "all") return async (...values: unknown[]) => {
      if (sql.includes("FROM organization_operational_contact_assignments assignment") && ++assignmentReads === 3 && !fired) {
        fired = true; await action();
      }
      return (target.all as (...args: unknown[]) => Promise<D1Result>)(...values);
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const proxy: D1Database = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('organization contacts')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database; environment = { OPS_DB: database };
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0045_").sort())
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8")).map(sql => database.prepare(sql)));
  await database.batch([
    database.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
      VALUES(?,?,?,?)`).bind(source, "organization", "migration-populated-organization", "migration-populated-organization"),
    database.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES('migration-populated-organization','Existing organization',1,'{}','existing-sync',?)`).bind(source),
  ]);
  await registerVisibleTestSource(database, secondary, "Secondary");
  beforeMigration = await stableAuthority();
  await database.batch(splitD1MigrationStatements(readFileSync(new URL("0045_organization_operational_contacts.sql", directory), "utf8"))
    .map(sql => database.prepare(sql)));
  afterMigration = await stableAuthority();
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("source-qualified organization operational contacts", () => {
  it("migrates populated D1 without inference and grants only owner/admin defaults", async () => {
    expect(afterMigration).toEqual(beforeMigration);
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_sets").first("count")).toBe(0);
    expect((await database.prepare(`SELECT role_id,permission_key FROM role_permissions
      WHERE permission_key='organization.contacts.manage' ORDER BY role_id`).all()).results).toEqual([
      { role_id: "role-admin", permission_key: "organization.contacts.manage" },
      { role_id: "role-owner", permission_key: "organization.contacts.manage" },
    ]);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("saves one primary and multiple delivery contacts without authority side effects", async () => {
    const item = await fixture(), authority = await stableAuthority();
    const input = { expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(), assignments: [
      { contactId: item.primaryId, role: "primary_operational" },
      { contactId: item.deliveryId, role: "delivery" },
      { contactId: item.secondDeliveryId, role: "delivery" },
    ] };
    const saved = await saveOrganizationOperationalContacts(environment, owner, item.context, input);
    expect(saved).toMatchObject({ sourceId: source, organizationId: item.organizationId, version: 1, replayed: false });
    expect(await saveOrganizationOperationalContacts(environment, owner, item.context, input)).toEqual({ ...saved, replayed: true });
    const workspace = await readOrganizationOperationalContacts(environment, owner, item.context);
    expect(workspace.contacts.assignments.map(value => value.role)).toEqual(["primary_operational", "delivery", "delivery"]);
    expect(workspace.contacts.assignments[0]?.contact?.email).toContain("@example.test");
    expect(workspace.capabilities.canManageOrganizationContacts).toBe(true);
    expect(await stableAuthority()).toEqual(authority);
    const audit = await database.prepare("SELECT details_json FROM organization_operational_events WHERE organization_id=?")
      .bind(item.organizationId).first<string>("details_json");
    expect(audit).toBe(JSON.stringify({ schemaVersion: 1, primaryOperationalCount: 1, deliveryCount: 2 }));
    expect(audit).not.toContain("@example.test");
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_write_fences").first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("enforces role cardinality and exact active same-source organization membership", async () => {
    const item = await fixture();
    const invalid = [
      [{ contactId: item.primaryId, role: "primary_operational" }, { contactId: item.deliveryId, role: "primary_operational" }],
      [{ contactId: item.primaryId, role: "delivery" }, { contactId: item.primaryId, role: "delivery" }],
      [{ contactId: item.otherId, role: "delivery" }],
      [{ contactId: item.secondaryId, role: "delivery" }],
    ];
    for (const assignments of invalid) await expect(saveOrganizationOperationalContacts(environment, owner, item.context, {
      expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(), assignments,
    })).rejects.toMatchObject({ status: expect.any(Number) });
    await database.prepare("UPDATE pa_clients SET active=0 WHERE id=?").bind(item.primaryId).run();
    await expect(saveOrganizationOperationalContacts(environment, owner, item.context, {
      expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(),
      assignments: [{ contactId: item.primaryId, role: "primary_operational" }],
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_sets WHERE organization_id=?")
      .bind(item.organizationId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_revisions WHERE organization_id=?")
      .bind(item.organizationId).first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("rejects stale writers while allowing exactly one concurrent version winner", async () => {
    const item = await fixture();
    await saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), assignments: [{ contactId: item.primaryId, role: "primary_operational" }] });
    const results = await Promise.allSettled([
      saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
        expectedVersion: 1, idempotencyKey: operationKey(), assignments: [{ contactId: item.deliveryId, role: "delivery" }] }),
      saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
        expectedVersion: 1, idempotencyKey: operationKey(), assignments: [{ contactId: item.secondDeliveryId, role: "delivery" }] }),
    ]);
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(value => value.status === "rejected")).toHaveLength(1);
    expect(await database.prepare("SELECT version FROM organization_operational_contact_sets WHERE organization_id=?")
      .bind(item.organizationId).first("version")).toBe(2);
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_revisions WHERE organization_id=?")
      .bind(item.organizationId).first("count")).toBe(2);
  }, TEST_TIMEOUT_MS);

  it("binds retry receipts to the exact request, actor, source and organization", async () => {
    const item = await fixture(), key = operationKey();
    const input = { expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: key,
      assignments: [{ contactId: item.primaryId, role: "primary_operational" as const }] };
    await saveOrganizationOperationalContacts(environment, owner, item.context, input);
    await expect(saveOrganizationOperationalContacts(environment, owner,
      { ...item.context, contextVersion: "d".repeat(43) }, input)).rejects.toMatchObject({ status: 409 });
    await expect(saveOrganizationOperationalContacts(environment, owner, item.context, { ...input,
      assignments: [{ contactId: item.deliveryId, role: "delivery" }] })).rejects.toMatchObject({ status: 409 });
    const another = await fixture();
    await expect(saveOrganizationOperationalContacts(environment, owner, another.context, { ...input,
      expectedContextVersion: another.context.contextVersion })).rejects.toMatchObject({ status: 409 });
  }, TEST_TIMEOUT_MS);

  it("revalidates final assignment membership before releasing contact channels", async () => {
    for (const mutate of [
      (item: Fixture) => database.prepare("UPDATE pa_clients SET organization_id=?,last_sync_id='in-flight-reparent' WHERE id=?")
        .bind(`organization-contacts-other-${sequence}`, item.primaryId).run(),
      (item: Fixture) => database.prepare("UPDATE pa_clients SET active=0,last_sync_id='in-flight-deactivation' WHERE id=?")
        .bind(item.primaryId).run(),
      (item: Fixture) => database.prepare("DELETE FROM pa_clients WHERE id=?").bind(item.primaryId).run(),
    ]) {
      const item = await fixture();
      await saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
        expectedVersion: 0, idempotencyKey: operationKey(), assignments: [{ contactId: item.primaryId, role: "primary_operational" }] });
      const raced = readRaceDatabase(() => mutate(item).then(() => undefined));
      await expect(readOrganizationOperationalContacts({ OPS_DB: raced } as Pick<Env, "OPS_DB">, owner, item.context))
        .rejects.toMatchObject({ status: 409 });
    }
  }, TEST_TIMEOUT_MS);

  it("fails closed on stale context, contact reparenting, root removal and in-batch root races", async () => {
    const item = await fixture();
    await expect(saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: "z".repeat(43),
      expectedVersion: 0, idempotencyKey: operationKey(), assignments: [] })).rejects.toMatchObject({ status: 409 });
    await saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), assignments: [{ contactId: item.primaryId, role: "primary_operational" }] });
    await database.prepare("UPDATE pa_clients SET organization_id=?,last_sync_id='reparented-contact' WHERE id=?")
      .bind(`organization-contacts-other-${sequence}`, item.primaryId).run();
    const afterMove = await readOrganizationOperationalContacts(environment, owner, item.context);
    expect(afterMove.contacts.assignments[0]).toMatchObject({ availability: "unavailable", contact: null });
    await expect(saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 1, idempotencyKey: operationKey(), assignments: [{ contactId: item.primaryId, role: "delivery" }] }))
      .rejects.toMatchObject({ status: 409 });
    await database.prepare("UPDATE pa_organizations SET active=0,last_sync_id='removed-root' WHERE id=?").bind(item.organizationId).run();
    await expect(readOrganizationOperationalContacts(environment, owner, item.context)).rejects.toMatchObject({ status: 404 });

    const raced = await fixture();
    const race = raceDatabase(() => database.prepare("UPDATE pa_organizations SET last_sync_id='raced-root' WHERE id=?")
      .bind(raced.organizationId).run().then(() => undefined));
    await expect(saveOrganizationOperationalContacts({ OPS_DB: race } as Pick<Env, "OPS_DB">, owner, raced.context, {
      expectedContextVersion: raced.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(),
      assignments: [{ contactId: raced.primaryId, role: "primary_operational" }],
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_sets WHERE organization_id=?")
      .bind(raced.organizationId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_write_fences WHERE organization_id=?")
      .bind(raced.organizationId).first("count")).toBe(0);

    const contactRaced = await fixture();
    const contactRace = raceDatabase(() => database.prepare("UPDATE pa_clients SET organization_id=?,last_sync_id='raced-contact' WHERE id=?")
      .bind(`organization-contacts-other-${sequence}`, contactRaced.primaryId).run().then(() => undefined));
    await expect(saveOrganizationOperationalContacts({ OPS_DB: contactRace } as Pick<Env, "OPS_DB">, owner, contactRaced.context, {
      expectedContextVersion: contactRaced.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(),
      assignments: [{ contactId: contactRaced.primaryId, role: "primary_operational" }],
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM organization_operational_contact_sets WHERE organization_id=?")
      .bind(contactRaced.organizationId).first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("keeps current-set identity, revisions, audit and receipts immutable", async () => {
    const item = await fixture();
    await saveOrganizationOperationalContacts(environment, owner, item.context, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), assignments: [] });
    await expect(database.prepare("UPDATE organization_operational_contact_revisions SET snapshot_json='{}' WHERE organization_id=?")
      .bind(item.organizationId).run()).rejects.toThrow(/immutable/);
    await expect(database.prepare("DELETE FROM organization_operational_events WHERE organization_id=?")
      .bind(item.organizationId).run()).rejects.toThrow(/immutable/);
    await expect(database.prepare("UPDATE organization_operational_mutations SET result_version=9 WHERE organization_id=?")
      .bind(item.organizationId).run()).rejects.toThrow(/immutable/);
    await expect(database.prepare("DELETE FROM organization_operational_contact_sets WHERE organization_id=?")
      .bind(item.organizationId).run()).rejects.toThrow(/persistent/);
  }, TEST_TIMEOUT_MS);
});
