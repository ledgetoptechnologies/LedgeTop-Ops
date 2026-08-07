import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listDeliveryFolderLocations } from "../src/worker/delivery-locations";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "staff-a",
  email: "staff@example.test",
  displayName: "Staff",
  accessSubject: "subject-a",
  projectAlphaUserId: null,
};

async function applySql(db: D1Database, sql: string): Promise<void> {
  for (const statement of sql
    .split(/;\s*(?:\n|$)/)
    .map((value) => value.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
}

describe("Operations delivery location authorization", () => {
  let miniflare: Miniflare;
  let opsDb: D1Database;
  let deliveryDb: D1Database;
  let env: Env;
  let coordinateQueries: string[];

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: {
        OPS_DB: "delivery-location-authorization-ops",
        DELIVERY_DB: "delivery-location-authorization-delivery",
      },
    });
    opsDb = (await miniflare.getD1Database("OPS_DB")) as unknown as D1Database;
    deliveryDb = (await miniflare.getD1Database("DELIVERY_DB")) as unknown as D1Database;

    await applySql(
      opsDb,
      `CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL);
       CREATE TABLE staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE local_staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE staff_permission_overrides(staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE project_folders(project_id TEXT PRIMARY KEY,division_id TEXT NOT NULL,r2_prefix TEXT NOT NULL);
       CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT);`,
    );
    await applySql(
      deliveryDb,
      `CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,media_kind TEXT NOT NULL);
       CREATE TABLE image_asset_locations(source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,folder_prefix TEXT NOT NULL,latitude REAL,longitude REAL,status TEXT NOT NULL);
       CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,restored_at TEXT);`,
    );
  });

  beforeEach(async () => {
    coordinateQueries = [];
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_permission_overrides"),
      opsDb.prepare("DELETE FROM staff_role_assignments"),
      opsDb.prepare("DELETE FROM local_staff_role_assignments"),
      opsDb.prepare("DELETE FROM role_permissions"),
      opsDb.prepare("DELETE FROM project_folders"),
      opsDb.prepare("DELETE FROM pa_projects"),
      opsDb.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('delivery-role','delivery.browse')"),
      opsDb.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES('staff-a','delivery-role','division','division-a')"),
      opsDb.prepare("INSERT INTO pa_projects(id,name) VALUES('project-a','Acme')"),
      opsDb.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix) VALUES('project-a','division-a','Jobs/Clients/Acme/')"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("DELETE FROM delivery_tombstones"),
      deliveryDb.prepare("DELETE FROM image_asset_locations"),
      deliveryDb.prepare("DELETE FROM file_index"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,media_kind) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a','image')"),
      deliveryDb.prepare("INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a','Jobs/Clients/Acme/Delivery/',44.5,-88.1,'ready')"),
    ]);

    const trackedDeliveryDb = {
      prepare(sql: string) {
        if (sql.includes("image-location.operations-list")) coordinateQueries.push(sql);
        return deliveryDb.prepare(sql);
      },
    };
    env = {
      OPS_DB: {
        withSession() {
          return opsDb;
        },
        prepare(sql: string) {
          return opsDb.prepare(sql);
        },
      },
      DELIVERY_DB: trackedDeliveryDb,
    } as unknown as Env;
  });

  afterAll(async () => miniflare.dispose());

  it("returns coordinates for an inherited same-division allow without an explicit deny", async () => {
    await expect(
      listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery"),
    ).resolves.toEqual({
      points: [{ latitude: 44.5, longitude: -88.1, imageCount: 1 }],
      imageCount: 1,
      truncated: false,
    });
    expect(coordinateQueries).toHaveLength(1);
  });

  it("treats an empty root prefix as an authorized empty aggregate", async () => {
    await expect(listDeliveryFolderLocations(env, principal, "")).resolves.toEqual({
      points: [], imageCount: 0, truncated: false,
    });
    expect(coordinateQueries).toHaveLength(1);
  });

  it("rejects an explicit same-division deny before querying coordinates", async () => {
    await opsDb
      .prepare("INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope,division_id) VALUES('staff-a','delivery.browse','deny','division','division-a')")
      .run();

    await expect(
      listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery"),
    ).rejects.toMatchObject({ status: 403 });
    expect(coordinateQueries).toHaveLength(0);
  });

  it("rejects an explicit global deny despite a retained division allow", async () => {
    await opsDb
      .prepare("INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope,division_id) VALUES('staff-a','delivery.browse','deny','global',NULL)")
      .run();

    await expect(
      listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery"),
    ).rejects.toMatchObject({ status: 403 });
    expect(coordinateQueries).toHaveLength(0);
  });
});
