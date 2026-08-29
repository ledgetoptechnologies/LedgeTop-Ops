import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listDeliveryShares } from "../src/worker/delivery";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "staff-a", email: "staff@example.test", displayName: "Staff", accessSubject: "subject-a", projectAlphaUserId: null,
};
interface ShareFixture {
  id: string;
  projectPrefix?: string;
  prefix: string | null;
  objectKey?: string;
  division?: string | null;
  projectDivision?: string;
  createdAt?: string;
}

describe("Delivery share history folder scope", () => {
  let runtime: Miniflare;
  let opsDb: D1Database;
  let deliveryDb: D1Database;
  const environment = () => ({ OPS_DB: opsDb, DELIVERY_DB: deliveryDb }) as Env;

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { OPS_DB: "share-history-ops", DELIVERY_DB: "share-history-delivery" },
    });
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    deliveryDb = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await opsDb.exec(`
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      INSERT INTO role_permissions VALUES('audit-role','delivery.share.audit');
    `.replace(/\s*\n\s*/g, " "));
    await deliveryDb.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,r2_prefix TEXT NOT NULL,division_id TEXT,client_name TEXT,project_name TEXT);
      CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,public_id TEXT,label TEXT,password_hash TEXT,
        expires_at TEXT,revoked_at TEXT,revoked_reason TEXT,unavailable_since TEXT,created_at TEXT NOT NULL,
        last_accessed_at TEXT,access_count INTEGER DEFAULT 0,r2_prefix TEXT,r2_object_key TEXT,division_id TEXT);
      CREATE TABLE file_aliases(physical_key TEXT PRIMARY KEY,display_name TEXT);
    `.replace(/\s*\n\s*/g, " "));
  });

  beforeEach(async () => {
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_role_assignments"),
      opsDb.prepare("DELETE FROM staff_permission_overrides"),
      opsDb.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','audit-role','global',NULL)"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("DELETE FROM shares"), deliveryDb.prepare("DELETE FROM projects"),
      deliveryDb.prepare("DELETE FROM file_aliases"),
    ]);
  });
  afterAll(async () => runtime.dispose());

  async function seed(rows: ShareFixture[]) {
    const statements = rows.flatMap(row => [
      deliveryDb.prepare("INSERT INTO projects VALUES(?,?,?,?,?)")
        .bind(`project-${row.id}`, row.projectPrefix ?? row.prefix ?? "Jobs/Clients/Acme/", row.projectDivision ?? "division-a", "Client", "Project"),
      deliveryDb.prepare("INSERT INTO shares(id,project_id,public_id,label,created_at,r2_prefix,r2_object_key,division_id) VALUES(?,?,?,?,?,?,?,?)")
        .bind(row.id, `project-${row.id}`, `public-${row.id}`, row.id, row.createdAt ?? "2026-08-01T12:00:00Z",
          row.prefix, row.objectKey ?? null, row.division === undefined ? "division-a" : row.division),
    ]);
    for (let offset = 0; offset < statements.length; offset += 50)
      await deliveryDb.batch(statements.slice(offset, offset + 50));
  }

  it("includes exact, nested and file targets but never ancestors, similarly named siblings or an outside file", async () => {
    await seed([
      { id: "exact", prefix: "Jobs/Clients/Acme/" },
      { id: "nested", prefix: "Jobs/Clients/Acme/Edited/" },
      { id: "file", prefix: "Jobs/Clients/Acme/Edited/", objectKey: "Jobs/Clients/Acme/Edited/photo.jpg" },
      { id: "legacy", prefix: null, projectPrefix: "Jobs/Clients/Acme/Legacy/" },
      { id: "ancestor", prefix: "Jobs/Clients/" },
      { id: "global", prefix: "Jobs/" },
      { id: "sibling", prefix: "Jobs/Clients/Acme Extra/" },
      { id: "sibling-adjacent", prefix: "Jobs/Clients/Acme0/" },
      { id: "file-outside", prefix: "Jobs/Clients/Acme/", objectKey: "Jobs/Clients/Other/photo.jpg" },
    ]);
    const page = await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Acme/" });
    expect(page.shares.map(share => share.id).sort()).toEqual(["exact", "file", "legacy", "nested"]);
    expect(page.nextCursor).toBeNull();
    expect((await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Acme/Edited/" })).shares.map(share => share.id).sort())
      .toEqual(["file", "nested"]);
    expect((await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/", q: "path:Other/" })).shares.map(share => share.id))
      .toEqual(["file-outside"]);
    expect((await listDeliveryShares(environment(), principal)).shares).toHaveLength(9);
  });

  it("can scope recent links to the current folder and its direct items without descendant contents", async () => {
    await seed([
      { id: "folder", prefix: "Jobs/Clients/Acme/" },
      { id: "direct-file", prefix: "Jobs/Clients/Acme/", objectKey: "Jobs/Clients/Acme/photo.jpg" },
      { id: "direct-folder", prefix: "Jobs/Clients/Acme/Edited/" },
      { id: "nested-file", prefix: "Jobs/Clients/Acme/Edited/", objectKey: "Jobs/Clients/Acme/Edited/photo.jpg" },
      { id: "deeper-folder", prefix: "Jobs/Clients/Acme/Edited/Final/" },
      { id: "deeper-file", prefix: "Jobs/Clients/Acme/Edited/Final/", objectKey: "Jobs/Clients/Acme/Edited/Final/photo.jpg" },
    ]);
    expect((await listDeliveryShares(environment(), principal, {
      prefix: "Jobs/Clients/Acme/", folderScope: "exact",
    })).shares.map(share => share.id).sort()).toEqual(["direct-file", "direct-folder", "folder"]);
    expect((await listDeliveryShares(environment(), principal, {
      prefix: "Jobs/Clients/Acme/Edited/", folderScope: "exact",
    })).shares.map(share => share.id).sort()).toEqual(["deeper-folder", "direct-folder", "nested-file"]);
  });

  it("rejects exact folder scope without a concrete folder", async () => {
    await expect(listDeliveryShares(environment(), principal, { folderScope: "exact" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("treats wildcard, quote and Unicode characters literally and preserves storage-key case", async () => {
    const prefix = "Jobs/Clients/Café's 100%_Done/";
    await seed([
      { id: "exact", prefix },
      { id: "child", prefix, objectKey: `${prefix}photo.jpg` },
      { id: "wildcard-neighbor", prefix: "Jobs/Clients/Café's 100ABDone/" },
      { id: "case-neighbor", prefix: "Jobs/Clients/café's 100%_Done/" },
    ]);
    expect((await listDeliveryShares(environment(), principal, { prefix })).shares.map(share => share.id).sort())
      .toEqual(["child", "exact"]);
    expect((await listDeliveryShares(environment(), principal, { prefix, q: "photo" })).shares.map(share => share.id))
      .toEqual(["child"]);
  });

  it("filters before limit and preserves deterministic keyset pages amid newer unrelated links", async () => {
    await seed([
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `unrelated-${index}`, prefix: "Jobs/Clients/Other/", createdAt: "2026-08-02T12:00:00Z",
      })),
      ...["a", "b", "c", "d", "e"].map(id => ({ id, prefix: "Jobs/Clients/Acme/" })),
    ]);
    const options = { prefix: "Jobs/Clients/Acme/", limit: 2 };
    const first = await listDeliveryShares(environment(), principal, options);
    expect(first.shares.map(share => share.id)).toEqual(["e", "d"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listDeliveryShares(environment(), principal, { ...options, cursor: first.nextCursor! });
    expect(second.shares.map(share => share.id)).toEqual(["c", "b"]);
    const third = await listDeliveryShares(environment(), principal, { ...options, cursor: second.nextCursor! });
    expect(third.shares.map(share => share.id)).toEqual(["a"]);
    expect(third.nextCursor).toBeNull();
  });

  it("intersects folder scope with authorized share/project divisions before pagination", async () => {
    await opsDb.prepare("UPDATE staff_role_assignments SET scope='division',division_id='division-a'").run();
    await seed([
      { id: "z-other-division", prefix: "Jobs/Clients/Acme/", division: "division-b" },
      { id: "b-share-division", prefix: "Jobs/Clients/Acme/", division: "division-a", projectDivision: "division-b" },
      { id: "a-project-division", prefix: "Jobs/Clients/Acme/", division: null },
      { id: "other-folder", prefix: "Jobs/Clients/Other/", division: "division-b" },
    ]);
    const first = await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Acme/", limit: 1 });
    expect(first.shares.map(share => share.id)).toEqual(["b-share-division"]);
    const second = await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Acme/", limit: 1, cursor: first.nextCursor! });
    expect(second.shares.map(share => share.id)).toEqual(["a-project-division"]);
    expect(second.nextCursor).toBeNull();
    expect((await listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Other/" })).shares).toEqual([]);
    await opsDb.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','delivery.share.audit','deny','global',NULL)").run();
    await expect(listDeliveryShares(environment(), principal, { prefix: "Jobs/Clients/Acme/" })).rejects.toMatchObject({ status: 403 });
  });

  it.each(["", "/", "Jobs/../Other/", "Jobs/.previews/", "Jobs/_ltds/", "Jobs/Dump/", "Jobs/Acme\0/", "Jobs/Acme\n/", "a".repeat(1025)])
    ("rejects an invalid supplied prefix %j", async prefix => {
      await expect(listDeliveryShares(environment(), principal, { prefix })).rejects.toMatchObject({ status: 400 });
    });

  it("uses existing folder normalization without treating an empty scope as global history", async () => {
    await seed([{ id: "exact", prefix: "Jobs/Clients/Acme/" }]);
    expect((await listDeliveryShares(environment(), principal, { prefix: "/Jobs//Clients\\Acme" })).shares.map(share => share.id))
      .toEqual(["exact"]);
  });
});
