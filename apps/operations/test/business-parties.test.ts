import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { businessPartyMutationSchema, mutateBusinessParty, previewBusinessParty, readBusinessParty, readBusinessPartyForRoot,
  readableBusinessPartySql, type BusinessPartyOperation, type BusinessPartyRoot } from "../src/worker/business-parties";
import { registerProjectAlphaConnector, setProjectAlphaConnectorState, type ProjectAlphaConnectorEnvironment } from "../src/worker/project-alpha-connectors";
import type { Env, StaffPrincipal } from "../src/worker/types";

const primary = "project-alpha:primary", secondary = "project-alpha:secondary", third = "project-alpha:third";
const administrator: StaffPrincipal = { id: "party-admin", email: "admin@example.test", displayName: "Administrator", accessSubject: "admin", projectAlphaUserId: null };
const viewer: StaffPrincipal = { id: "party-viewer", email: "viewer@example.test", displayName: "Viewer", accessSubject: "viewer", projectAlphaUserId: null };
const key = () => `party_${crypto.randomUUID()}`;
let runtime: Miniflare, database: D1Database, environment: Pick<Env, "OPS_DB">, counter = 0;
let before: unknown, after: unknown;
async function stableRows() {
  const tables = ["staff_users", "staff_role_assignments", "staff_permission_overrides", "pa_clients", "pa_organizations", "pa_projects", "pa_projection_record_ids", "pa_connectors", "pa_connector_revisions"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}
async function root(sourceId: string, kind: BusinessPartyRoot["kind"] = "organization", active = 1, explicitId?: string): Promise<BusinessPartyRoot> {
  const external = explicitId ?? `party-record-${++counter}`;
  const recordId = sourceId === primary ? external : `pa-local-${sourceId.slice(14)}-${external}`;
  const recordKind = kind === "organization" ? "organization" : "client";
  await database.batch([
    database.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,?,?,?)")
      .bind(sourceId, recordKind, external, recordId),
    database.prepare(`INSERT INTO ${kind === "organization" ? "pa_organizations" : "pa_clients"}(id,projection_source_id,name,active,payload_json,last_sync_id)
      VALUES(?,?,?,?,?,'party-fixture')`).bind(recordId, sourceId, `Customer ${external}`, active, JSON.stringify({ id: external })),
  ]);
  return { sourceId, kind, recordId };
}
async function create(roots?: BusinessPartyRoot[], displayName = "Reviewed customer") {
  const operation: BusinessPartyOperation = { action: "create", displayName, roots: roots ?? [await root(primary), await root(secondary)] };
  const preview = await previewBusinessParty(environment, administrator, operation);
  const input = { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() };
  const result = await mutateBusinessParty(environment, administrator, input);
  return { operation, preview, input, result, party: await readBusinessParty(environment, administrator, result.partyId) };
}
/** Keep the real D1 transaction; inject a concurrent authoritative change just
 * before its first write, or after the initial idempotency receipt read. */
function raceDatabase(action: () => Promise<void>, at: "batch" | "receipt" = "batch"): { db: D1Database; fired: () => boolean } {
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; sql: string }>(); let fired = false;
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(raw, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "first") return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.first, target, args);
        if (!fired && at === "receipt" && sql.includes("FROM business_party_mutations")) { fired = true; await action(); }
        return result;
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }); statements.set(proxy, { raw, sql }); return proxy;
  };
  const proxy: D1Database = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async <T>(values: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!fired && at === "batch" && values.some(value => statements.get(value)?.sql.includes("INSERT INTO business_party_write_fences"))) {
        fired = true; await action();
      }
      return target.batch<T>(values.map(value => statements.get(value)?.raw ?? value));
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } }); return { db: proxy, fired: () => fired };
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('parties')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database; environment = { OPS_DB: database };
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0036_").sort())
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8")).map(sql => database.prepare(sql)));
  await database.batch([
    database.prepare("INSERT INTO staff_users(id,email,display_name) VALUES('party-admin','admin@example.test','Administrator'),('party-viewer','viewer@example.test','Viewer')"),
    database.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('party-admin-role','party-admin','role-admin','global','global')"),
    database.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('party-view','party-viewer','team.view','allow','global','global','party-admin')"),
  ]);
  const signing = (seed: number) => ({ keyId: "current", algorithm: "ed25519" as const,
    value: btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") });
  const sets = { primary: { snapshotApiKey: "primary-secret", eventCurrent: signing(1) },
    secondary: { snapshotApiKey: "secondary-secret", eventCurrent: signing(2) }, third: { snapshotApiKey: "third-secret", eventCurrent: signing(3) } };
  const config: ProjectAlphaConnectorEnvironment = { ...environment, PROJECT_ALPHA_BASE_URL: "https://primary.example.test", PROJECT_ALPHA_API_KEY: "original",
    APPLICATION_KEY: "ltds_ops", PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: signing(1).value,
    PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets }) };
  for (const name of ["primary", "secondary", "third"] as const) {
    await registerProjectAlphaConnector(config, { sourceId: `project-alpha:${name}`, producerBindingId: name, snapshotOrigin: `https://${name}.example.test`,
      applicationKey: "ltds_ops", profile: name === "primary" ? "primary_legacy" : "business_data", displayName: name,
      revision: { credentialRef: name, snapshotBasePath: "/", accessIssuer: "https://access.example.test", accessAudience: "audience", accessSubject: "subject" } }, administrator.id);
    await setProjectAlphaConnectorState(config, `project-alpha:${name}`, { expectedVersion: 1, state: "active", readVisible: true }, administrator.id);
  }
  await root(primary); before = await stableRows();
  await database.batch(splitD1MigrationStatements(readFileSync(new URL("0036_business_parties.sql", directory), "utf8")).map(sql => database.prepare(sql)));
  after = await stableRows();
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("explicit Operations business-party linking", () => {
  it("preserves populated sources/staff exactly and creates no inferred business links during migration", async () => {
    expect(after).toEqual(before); expect(await database.prepare("SELECT count(*) count FROM business_parties").first("count")).toBe(0);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    for (const table of ["business_parties", "business_party_links", "business_party_events", "business_party_mutations"])
      expect(await database.prepare(`PRAGMA quick_check('${table}')`).first("quick_check")).toBe("ok");
  });
  it("creates reviewed same-kind grouping, preserves source URLs and authority rows, and replays exactly once", async () => {
    const roots = [await root(primary, "organization", 1, "same-external-id"), await root(secondary, "organization", 1, "same-external-id")];
    const before = await stableRows(), saved = await create(roots, " E\u0301LAN customer ");
    expect(saved.party.displayName).toBe("ÉLAN customer"); expect(saved.party.members).toHaveLength(2); expect(saved.party.needsReview).toBe(false);
    expect(await database.prepare("SELECT sort_name FROM business_parties WHERE id=?").bind(saved.result.partyId).first("sort_name")).toBe("élan customer");
    expect(saved.party.members[0]?.detailPath).toBe(`/clients/sources/${encodeURIComponent(primary)}/business/organizations/same-external-id`);
    expect(await stableRows()).toEqual(before);
    expect(await mutateBusinessParty(environment, administrator, saved.input)).toEqual({ ...saved.result, replayed: true });
    expect(await database.prepare("SELECT count(*) count FROM business_party_events WHERE party_id=?").bind(saved.result.partyId).first("count")).toBe(1);
    expect((await readBusinessParty(environment, viewer, saved.result.partyId)).canManage).toBe(false);
    expect((await readBusinessPartyForRoot(environment, administrator, roots[0]!)).businessParty?.id).toBe(saved.result.partyId);
  }, 20_000);
  it("adds a source and unlinks down to one stable survivor, then closes the final member without deleting history", async () => {
    const saved = await create(), added = await root(third);
    const add: BusinessPartyOperation = { action: "add", partyId: saved.result.partyId, expectedVersion: 1, root: added };
    const preview = await previewBusinessParty(environment, administrator, add);
    await mutateBusinessParty(environment, administrator, { operation: add, previewContextVersion: preview.contextVersion, idempotencyKey: key() });
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      const party = await readBusinessParty(environment, administrator, saved.result.partyId);
      const operation: BusinessPartyOperation = { action: "unlink", partyId: party.id, expectedVersion: party.version, linkId: party.members[0]!.linkId! };
      const preview = await previewBusinessParty(environment, administrator, operation);
      expect(preview.members).toHaveLength(remaining - 1); expect(preview.removedMember?.linkId).toBe(operation.linkId);
      const input = { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() };
      const result = await mutateBusinessParty(environment, administrator, input);
      expect(result.status).toBe(remaining === 1 ? "closed" : "active");
      expect(await mutateBusinessParty(environment, administrator, input)).toEqual({ ...result, replayed: true });
    }
    await expect(readBusinessParty(environment, administrator, saved.result.partyId)).rejects.toMatchObject({ status: 404 });
    expect(await database.prepare("SELECT count(*) count FROM business_party_links WHERE party_id=?").bind(saved.result.partyId).first("count")).toBe(3);
    expect(await database.prepare("SELECT count(*) count FROM business_party_events WHERE party_id=?").bind(saved.result.partyId).first("count")).toBe(5);
  }, 30_000);
  it.each(["inactive", "missing", "moved"])("rejects %s new roots in both create and add", async condition => {
    const kind = condition === "moved" ? "standalone_client" : "organization";
    const invalid = await root(secondary, kind), live = await root(primary, kind);
    if (condition === "inactive") await database.prepare("UPDATE pa_organizations SET active=0 WHERE id=?").bind(invalid.recordId).run();
    if (condition === "missing") await database.prepare("DELETE FROM pa_organizations WHERE id=?").bind(invalid.recordId).run();
    if (condition === "moved") {
      const organization = await root(secondary);
      await database.prepare("UPDATE pa_clients SET organization_id=? WHERE id=?").bind(organization.recordId, invalid.recordId).run();
    }
    await expect(previewBusinessParty(environment, administrator, { action: "create", displayName: "Invalid", roots: [live, invalid] }))
      .rejects.toMatchObject({ status: 404 });
    const saved = await create([await root(primary, kind), await root(third, kind)]);
    await expect(previewBusinessParty(environment, administrator, { action: "add", partyId: saved.result.partyId, expectedVersion: 1, root: invalid }))
      .rejects.toMatchObject({ status: 404 });
  }, 20_000);
  it("requires same kind, distinct producers and unlinked roots; never merges existing groups silently", async () => {
    const saved = await create();
    for (const roots of [[await root(primary), await root(secondary, "standalone_client")], [await root(primary), await root(primary)]])
      await expect(previewBusinessParty(environment, administrator, { action: "create", displayName: "Invalid", roots })).rejects.toMatchObject({ status: 409 });
    await expect(previewBusinessParty(environment, administrator, { action: "create", displayName: "Other", roots: [saved.operation.action === "create" ? saved.operation.roots[0] : await root(primary), await root(secondary)] }))
      .rejects.toMatchObject({ status: 409 });
    await expect(previewBusinessParty(environment, viewer, { action: "unlink", partyId: saved.result.partyId, expectedVersion: 1, linkId: saved.party.members[0]!.linkId }))
      .rejects.toMatchObject({ status: 403 });
  }, 20_000);
  it.each(["inactive", "moved", "missing"])("provides redacted administrator repair for %s members and preserves independently authorized history", async condition => {
    const kind = condition === "moved" ? "standalone_client" : "organization";
    const roots = [await root(primary, kind), await root(secondary, kind)], saved = await create(roots);
    const table = kind === "organization" ? "pa_organizations" : "pa_clients";
    if (condition === "moved") {
      const organization = await root(secondary);
      await database.prepare("UPDATE pa_clients SET organization_id=?,name='Private changed owner contact' WHERE id=?").bind(organization.recordId, roots[1]!.recordId).run();
    } else await database.prepare(condition === "missing" ? `DELETE FROM ${table} WHERE id=?` : `UPDATE ${table} SET active=0 WHERE id=?`).bind(roots[1]!.recordId).run();
    await expect(readBusinessParty(environment, viewer, saved.result.partyId)).rejects.toMatchObject({ status: 404 });
    const repair = await readBusinessParty(environment, administrator, saved.result.partyId), removed = repair.members.find(member => member.availability === "unavailable")!;
    expect(repair.needsReview).toBe(true); expect(removed.displayName).toBe("Unavailable source record"); expect(removed.detailPath).toBeNull();
    expect(JSON.stringify(repair)).not.toContain("Private changed owner contact");
    expect((await readBusinessPartyForRoot(environment, administrator, roots[0]!)).businessParty?.needsReview).toBe(true);
    const operation: BusinessPartyOperation = { action: "unlink", partyId: repair.id, expectedVersion: repair.version, linkId: removed.linkId! };
    const preview = await previewBusinessParty(environment, administrator, operation);
    expect(preview.removedMember?.availability).toBe("unavailable");
    await mutateBusinessParty(environment, administrator, { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() });
    expect((await readBusinessParty(environment, viewer, repair.id)).members).toHaveLength(1);
  }, 20_000);
  it("never exposes aggregate or repair metadata for a hidden source", async () => {
    const saved = await create();
    await database.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?").bind(secondary).run();
    try {
      await expect(readBusinessParty(environment, administrator, saved.result.partyId)).rejects.toMatchObject({ status: 404 });
      expect((await readBusinessPartyForRoot(environment, administrator, saved.party.members[0]!.root)).businessParty).toBeNull();
      await expect(mutateBusinessParty(environment, administrator, saved.input)).rejects.toMatchObject({ status: 404 });
      expect(await database.prepare(`SELECT 1 visible FROM business_parties party WHERE party.id=? AND ${readableBusinessPartySql("party.id")}`).bind(saved.result.partyId).first()).toBeNull();
    } finally { await database.prepare("UPDATE pa_connectors SET read_visible=1,version=version+1 WHERE source_id=?").bind(secondary).run(); }
  }, 15_000);
  it("can sequentially repair two unavailable members and close the party, including exact unlink replay", async () => {
    const roots = [await root(primary), await root(secondary)], saved = await create(roots);
    await database.batch(roots.map(root => database.prepare("UPDATE pa_organizations SET active=0 WHERE id=?").bind(root.recordId)));
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      const repair = await readBusinessParty(environment, administrator, saved.result.partyId);
      expect(repair.needsReview).toBe(true); expect(repair.members.every(member => member.availability === "unavailable")).toBe(true);
      const operation: BusinessPartyOperation = { action: "unlink", partyId: repair.id, expectedVersion: repair.version, linkId: repair.members[0]!.linkId! };
      const preview = await previewBusinessParty(environment, administrator, operation);
      expect(preview.members).toHaveLength(remaining - 1);
      const input = { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() };
      const result = await mutateBusinessParty(environment, administrator, input);
      expect(result.status).toBe(remaining === 1 ? "closed" : "active");
      expect(await mutateBusinessParty(environment, administrator, input)).toEqual({ ...result, replayed: true });
    }
    expect(await database.prepare("SELECT status FROM business_parties WHERE id=?").bind(saved.result.partyId).first("status")).toBe("closed");
  }, 20_000);
  it("persists long exact local handles without truncation or rewriting their source identity", async () => {
    const roots = [await root(primary, "organization", 1, "a".repeat(512)), await root(secondary, "organization", 1, "b".repeat(480))];
    const saved = await create(roots);
    expect(saved.party.members.map(member => member.root.recordId).sort()).toEqual(roots.map(root => root.recordId).sort());
  }, 15_000);
  it.each(["rename", "deactivate", "permission"])("rejects a %s change inside the transaction boundary with no party/audit/receipt partial write", async change => {
    const roots = [await root(primary), await root(secondary)];
    const operation: BusinessPartyOperation = { action: "create", displayName: "Race", roots };
    const preview = await previewBusinessParty(environment, administrator, operation), idempotencyKey = key();
    const raced = raceDatabase(async () => {
      if (change === "permission") await database.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES('party-race-deny','party-admin','team.manage','deny','global','global','party-admin')`).run();
      else await database.prepare(change === "rename" ? "UPDATE pa_organizations SET name='Changed after preview' WHERE id=?" : "UPDATE pa_organizations SET active=0 WHERE id=?")
        .bind(roots[1]!.recordId).run();
    });
    const before = await database.prepare("SELECT count(*) count FROM business_parties").first("count");
    try {
      await expect(mutateBusinessParty({ OPS_DB: raced.db }, administrator, { operation, previewContextVersion: preview.contextVersion, idempotencyKey }))
        .rejects.toMatchObject({ status: 409 });
      expect(raced.fired()).toBe(true); expect(await database.prepare("SELECT count(*) count FROM business_parties").first("count")).toBe(before);
      expect(await database.prepare("SELECT 1 found FROM business_party_mutations WHERE idempotency_key=?").bind(idempotencyKey).first()).toBeNull();
    } finally { if (change === "permission") await database.prepare("DELETE FROM staff_permission_overrides WHERE id='party-race-deny'").run(); }
  }, 20_000);
  it("recognizes an identical winner committed after the initial receipt read but before preflight", async () => {
    const operation: BusinessPartyOperation = { action: "create", displayName: "Concurrent", roots: [await root(primary), await root(secondary)] };
    const preview = await previewBusinessParty(environment, administrator, operation), input = { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() };
    let winner: Awaited<ReturnType<typeof mutateBusinessParty>> | undefined;
    const raced = raceDatabase(async () => { winner = await mutateBusinessParty(environment, administrator, input); }, "receipt");
    const result = await mutateBusinessParty({ OPS_DB: raced.db }, administrator, input);
    expect(raced.fired()).toBe(true); expect(result).toEqual({ ...winner, replayed: true });
    expect(await database.prepare("SELECT count(*) count FROM business_party_mutations WHERE idempotency_key=?").bind(input.idempotencyKey).first("count")).toBe(1);
  }, 20_000);
  it("rejects actor-key reuse for different operations and competing same-version additions", async () => {
    const saved = await create(), newRoot = await root(third);
    await expect(mutateBusinessParty(environment, administrator, { ...saved.input,
      operation: { ...saved.operation, displayName: "Different reviewed name" } })).rejects.toMatchObject({ status: 409 });
    const operation: BusinessPartyOperation = { action: "add", partyId: saved.result.partyId, expectedVersion: 1, root: newRoot };
    const preview = await previewBusinessParty(environment, administrator, operation);
    const input = { operation, previewContextVersion: preview.contextVersion, idempotencyKey: key() };
    const raced = raceDatabase(async () => { await mutateBusinessParty(environment, administrator, { ...input, idempotencyKey: key() }); });
    await expect(mutateBusinessParty({ OPS_DB: raced.db }, administrator, input)).rejects.toMatchObject({ status: 409 });
    expect(raced.fired()).toBe(true);
    expect((await readBusinessParty(environment, administrator, saved.result.partyId)).members).toHaveLength(3);
    expect(await database.prepare("SELECT count(*) count FROM business_party_events WHERE party_id=?").bind(saved.result.partyId).first("count")).toBe(2);
  }, 20_000);
  it("rolls back links and the party when immutable audit publication fails", async () => {
    const operation: BusinessPartyOperation = { action: "create", displayName: "Audit failure", roots: [await root(primary), await root(secondary)] };
    const preview = await previewBusinessParty(environment, administrator, operation), idempotencyKey = key();
    const before = await database.prepare("SELECT count(*) count FROM business_parties").first("count");
    await database.prepare("CREATE TRIGGER fixture_party_audit_failure BEFORE INSERT ON business_party_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END").run();
    try { await expect(mutateBusinessParty(environment, administrator, { operation, previewContextVersion: preview.contextVersion, idempotencyKey })).rejects.toMatchObject({ status: 503 }); }
    finally { await database.prepare("DROP TRIGGER fixture_party_audit_failure").run(); }
    expect(await database.prepare("SELECT count(*) count FROM business_parties").first("count")).toBe(before);
    expect(await database.prepare("SELECT 1 found FROM business_party_mutations WHERE idempotency_key=?").bind(idempotencyKey).first()).toBeNull();
  }, 15_000);
  it("protects durable identities, active ownership and audit/receipt history against REPLACE or UPDATE bypass", async () => {
    const saved = await create();
    for (const sql of [
      "INSERT OR REPLACE INTO business_parties SELECT * FROM business_parties WHERE id=?",
      "UPDATE business_parties SET kind='standalone_client',version=version+1 WHERE id=?",
      "DELETE FROM business_parties WHERE id=?",
      "INSERT OR REPLACE INTO business_party_links SELECT * FROM business_party_links WHERE party_id=?",
      "UPDATE business_party_links SET source_id='project-alpha:third' WHERE party_id=?",
      "DELETE FROM business_party_links WHERE party_id=?",
      "INSERT OR REPLACE INTO business_party_events SELECT * FROM business_party_events WHERE party_id=?",
      "UPDATE business_party_events SET actor_id='changed' WHERE party_id=?",
      "DELETE FROM business_party_mutations WHERE party_id=?",
    ]) await expect(database.prepare(sql).bind(saved.result.partyId).run()).rejects.toThrow();
    await expect(database.prepare(`INSERT INTO business_party_links(id,party_id,source_id,record_kind,record_id,linked_by)
      VALUES(?,?,'project-alpha:third','organization',?,'party-admin')`).bind(key(), saved.result.partyId, saved.party.members[0]!.root.recordId).run())
      .rejects.toThrow(/FOREIGN KEY/);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 15_000);
  it.each(["x", "\u754c", '"'])("keeps maximum-length 32-root request/audit JSON bounded with %s characters", character => {
    const roots = Array.from({ length: 32 }, (_, index): BusinessPartyRoot => ({ sourceId: `project-alpha:${"s".repeat(61)}${String(index).padStart(3, "0")}`,
      kind: "organization", recordId: character.repeat(512) }));
    const operation: BusinessPartyOperation = { action: "create", displayName: "x".repeat(160), roots };
    const input = { operation, previewContextVersion: "f".repeat(64), idempotencyKey: "k".repeat(128) };
    expect(businessPartyMutationSchema.safeParse(input).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThan(64 * 1024);
    expect(new TextEncoder().encode(JSON.stringify({ operation })).byteLength).toBeLessThan(65536);
  });
});
