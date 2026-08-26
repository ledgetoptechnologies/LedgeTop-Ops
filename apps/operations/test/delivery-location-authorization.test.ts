import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listDeliveryFolderLocations, resolveDeliveryLocationAsset } from "../src/worker/delivery-locations";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema } from "./helpers/project-alpha-connectors";

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
  const r2Reads = { head: vi.fn(), get: vi.fn(), list: vi.fn() };

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
    await applyConnectorSchema(opsDb);

    await applySql(
      opsDb,
      `CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL);
       CREATE TABLE staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE local_staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE staff_permission_overrides(staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
       CREATE TABLE project_folders(project_id TEXT PRIMARY KEY,division_id TEXT NOT NULL,r2_prefix TEXT NOT NULL);
       CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');`,
    );
    await applySql(
      deliveryDb,
      `CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL);
       CREATE TABLE image_asset_locations(source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,folder_prefix TEXT NOT NULL,latitude REAL,longitude REAL,status TEXT NOT NULL);
       CREATE TABLE image_thumbnail_jobs(source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,thumbnail_key TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT);
       CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,restored_at TEXT);`,
    );
  });

  beforeEach(async () => {
    coordinateQueries = [];
    r2Reads.head.mockReset();
    r2Reads.get.mockReset();
    r2Reads.list.mockReset();
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
      deliveryDb.prepare("DELETE FROM image_thumbnail_jobs"),
      deliveryDb.prepare("DELETE FROM file_index"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a',4096,'2026-08-07T12:00:00.000Z','image/jpeg','image')"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('Jobs/Clients/Acme/Delivery/no-gps.jpg','etag-b',4096,'2026-08-07T12:00:00.000Z','image/jpeg','image')"),
      deliveryDb.prepare("INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a','Jobs/Clients/Acme/Delivery/',44.5,-88.1,'ready')"),
      deliveryDb.prepare("INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status) VALUES('Jobs/Clients/Acme/Delivery/no-gps.jpg','etag-b','Jobs/Clients/Acme/Delivery/',NULL,NULL,'absent')"),
      deliveryDb.prepare("INSERT INTO image_thumbnail_jobs(source_key,source_etag,thumbnail_key,status,error_code) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a','_ltds/thumbnails/ready.webp','ready',NULL)"),
    ]);

    const trackedDeliveryDb = {
      prepare(sql: string) {
        if (sql.includes("image-location.operations-assets")) coordinateQueries.push(sql);
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
      DELIVERY_TOKEN_SECRET: "test-location-secret-that-is-at-least-32-characters",
      DATA_BUCKET: r2Reads,
    } as unknown as Env;
  });

  afterAll(async () => miniflare.dispose());

  it("returns coordinates for an inherited same-division allow without an explicit deny", async () => {
    await expect(
      listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery"),
    ).resolves.toEqual({
      points: [{
        latitude: 44.5,
        longitude: -88.1,
        imageCount: 1,
        assetRef: expect.stringMatching(/^loc_[A-Za-z0-9_-]{43}$/),
      }],
      totalImageCount: 2,
      unmappedImageCount: 1,
      imageCount: 1,
      truncated: false,
    });
    expect(coordinateQueries).toHaveLength(1);
  });

  it("treats an empty root prefix as an authorized empty aggregate", async () => {
    await expect(listDeliveryFolderLocations(env, principal, "")).resolves.toEqual({
      points: [], totalImageCount: 0, unmappedImageCount: 0, imageCount: 0, truncated: false,
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

  it("resolves the listed current version and returns existing authorized URLs without R2 reads", async () => {
    const listed = await listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery");
    const assetRef = listed.points[0]?.assetRef;
    expect(assetRef).toBeTruthy();
    await expect(resolveDeliveryLocationAsset(
      env,
      principal,
      "Jobs/Clients/Acme/Delivery",
      assetRef!,
    )).resolves.toMatchObject({
      name: "photo.jpg",
      displayName: "photo.jpg",
      kind: "image",
      size: 4096,
      thumbnailState: "ready",
      thumbnailUrl: expect.stringMatching(/^\/api\/delivery\/items\/.+\/thumbnail$/),
      sourceUrl: expect.stringMatching(/^\/api\/delivery\/items\/.+\/source$/),
      previewUrl: expect.stringMatching(/^\/api\/delivery\/items\/.+\/source$/),
      downloadUrl: expect.stringMatching(/^\/api\/delivery\/items\/.+\/download$/),
    });
    expect(coordinateQueries).toHaveLength(2);
    expect(r2Reads.head).not.toHaveBeenCalled();
    expect(r2Reads.get).not.toHaveBeenCalled();
    expect(r2Reads.list).not.toHaveBeenCalled();
  });

  it("returns 404 for a stale exact-version reference without reading R2", async () => {
    const listed = await listDeliveryFolderLocations(env, principal, "Jobs/Clients/Acme/Delivery");
    const assetRef = listed.points[0]?.assetRef;
    await deliveryDb.prepare("UPDATE file_index SET etag='etag-b' WHERE r2_key='Jobs/Clients/Acme/Delivery/photo.jpg'").run();
    await expect(resolveDeliveryLocationAsset(
      env,
      principal,
      "Jobs/Clients/Acme/Delivery",
      assetRef!,
    )).rejects.toMatchObject({ status: 404 });
    expect(r2Reads.head).not.toHaveBeenCalled();
    expect(r2Reads.get).not.toHaveBeenCalled();
  });

  it("normalizes revoked and cross-client resolver authorization failures to 404 before asset query", async () => {
    const opaqueRef = `loc_${"a".repeat(43)}`;
    await expect(resolveDeliveryLocationAsset(
      env,
      principal,
      "Jobs/Clients/Other/Delivery",
      opaqueRef,
    )).rejects.toMatchObject({ status: 404 });
    expect(coordinateQueries).toHaveLength(0);

    await opsDb.prepare("INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope,division_id) VALUES('staff-a','delivery.browse','deny','global',NULL)").run();
    await expect(resolveDeliveryLocationAsset(
      env,
      principal,
      "Jobs/Clients/Acme/Delivery",
      opaqueRef,
    )).rejects.toMatchObject({ status: 404 });
    expect(coordinateQueries).toHaveLength(0);
    expect(r2Reads.get).not.toHaveBeenCalled();
  });
});
