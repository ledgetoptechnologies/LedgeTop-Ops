import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { airspaceView, rebuildOperationAirspaceMatches, refreshTfrs } from "../src/worker/airspace";
import type { Env } from "../src/worker/types";

describe("Wisconsin TFR refresh and cached notices", () => {
  let mf: Miniflare, db: D1Database, env: Env;
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS"] });
    db = await mf.getD1Database("OPS") as unknown as D1Database;
    env = { OPS_DB: db } as Env;
    const original = splitD1MigrationStatements(readFileSync(new URL("../migrations/0001_operations.sql", import.meta.url), "utf8"));
    await db.batch(original.filter(sql => /^CREATE TABLE (airspace_source_health|tfr_notices|tfr_effective_intervals|tfr_geometries|sua_areas|sua_reservations)\b/.test(sql)).map(sql => db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0006_airspace_sync_fingerprints.sql", import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    // Only these PA columns are read by the airspace list/match queries.
    await db.batch([
      db.prepare("CREATE TABLE pa_operations (id TEXT PRIMARY KEY,projection_source_id TEXT,project_id TEXT,title TEXT,active INTEGER,status TEXT,scheduled_start_at TEXT,scheduled_end_at TEXT)"),
      db.prepare("CREATE TABLE pa_service_locations (id TEXT,project_id TEXT,active INTEGER,latitude REAL,longitude REAL)"),
      db.prepare("CREATE TABLE pa_operation_airspace_matches (operation_id TEXT,source_type TEXT,source_id TEXT,match_type TEXT,projection_source_id TEXT)"),
    ]);
  }, 60_000);
  beforeEach(async () => {
    await db.batch(["pa_operation_airspace_matches", "pa_service_locations", "pa_operations", "tfr_geometries", "tfr_effective_intervals", "tfr_notices", "airspace_source_health"].map(table => db.prepare(`DELETE FROM ${table}`)));
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await mf?.dispose(); });

  it("excludes Michigan bbox matches, keeps Wisconsin no-shape/multi-state notices, and repairs old WI labels even with an unchanged fingerprint", async () => {
    const michigan = { type: "Feature", properties: { NOTAM_KEY: "6/1001", STATE: "MI" }, geometry: { type: "Polygon", coordinates: [[[-87.7,46],[-87.5,46],[-87.5,46.2],[-87.7,46.2],[-87.7,46]]] } };
    const listed = [
      { notam_id: "6/1001", state: "MI", description: "Michigan notice" },
      { notam_id: "6/1002", state: "WI", description: "Wisconsin no-shape notice" },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getTfrList")) return Response.json(listed);
      if (url.includes("noShapeTfrList")) return Response.json([{ notam_id: "6/1002", state: "MI", description: "Adjacent-state entry for same notice" }]);
      if (url.includes("geoserver")) return Response.json({ type: "FeatureCollection", features: [michigan], totalFeatures: 1 });
      if (url.endsWith("detail_6_1002.xml")) return new Response("<root><dateEffective>2026-01-01T00:00:00Z</dateEffective><dateExpire>2099-01-01T00:00:00Z</dateExpire></root>");
      throw new Error(`Unexpected FAA request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await db.prepare("INSERT INTO tfr_notices (id,notam_id,state,title,status,official_url) VALUES ('tfr-6-1001','6/1001','WI','Michigan notice','active','https://tfr.faa.gov/test')").run();
    expect(await refreshTfrs(env)).toEqual({ records: 1, changed: true });
    let view = await airspaceView(env);
    expect(view.tfrs).toHaveLength(1); // The dashboard uses this same list's length.
    expect(view.tfrs[0]).toMatchObject({ notam_id: "6/1002", state: "WI", title: "Wisconsin no-shape notice", geometry_available: 0 });
    expect(await db.prepare("SELECT state,missing_snapshots FROM tfr_notices WHERE notam_id='6/1001'").first()).toEqual({ state: "MI", missing_snapshots: 1 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("detail_6_1001.xml"))).toBe(false);
    // Finish the normal absence lifecycle, then simulate a still-mislabelled
    // cache row after the new source fingerprint has already been stored.
    await refreshTfrs(env);
    expect(await refreshTfrs(env)).toEqual({ records: 1, changed: false });
    await db.prepare("UPDATE tfr_notices SET state='WI',status='active' WHERE notam_id='6/1001'").run();
    expect(await refreshTfrs(env)).toEqual({ records: 1, changed: true });
    expect(await db.prepare("SELECT state FROM tfr_notices WHERE notam_id='6/1001'").first()).toEqual({ state: "MI" });
    view = await airspaceView(env);
    expect(view.tfrs.map(row => row.notam_id)).toEqual(["6/1002"]);
    expect(await db.prepare("SELECT COUNT(*) AS total FROM tfr_notices").first()).toEqual({ total: 2 }); // No cache deletion.
  });

  it("filters cached Michigan matches from views and match rebuilding", async () => {
    await db.batch([
      db.prepare("INSERT INTO tfr_notices (id,notam_id,state,title,status,official_url,effective_at,expires_at) VALUES ('tfr-6-1003','6/1003','MI','Michigan notice','active','https://tfr.faa.gov/test','2026-01-01','2099-01-01')"),
      db.prepare("INSERT INTO tfr_notices (id,notam_id,state,title,status,official_url,effective_at,expires_at) VALUES ('tfr-6-1004','6/1004',' wi ','Wisconsin notice','active','https://tfr.faa.gov/test','2026-01-01','2099-01-01')"),
      db.prepare("INSERT INTO pa_operations VALUES ('op','source','project','Test','1','scheduled','2026-10-17','2026-10-18')"),
      db.prepare("INSERT INTO pa_operations VALUES ('wi-op','source','wi-project','Wisconsin test','1','scheduled','2026-10-17','2026-10-18')"),
      db.prepare("INSERT INTO pa_service_locations VALUES ('location','project',1,46.1,-87.6)"),
      db.prepare("INSERT INTO pa_service_locations VALUES ('wi-location','wi-project',1,44.1,-89.6)"),
      db.prepare("INSERT INTO tfr_geometries VALUES ('mi-geometry','tfr-6-1003',?,46,-87.7,46.2,-87.5)").bind(JSON.stringify({ type: "Polygon", coordinates: [[[-87.7,46],[-87.5,46],[-87.5,46.2],[-87.7,46.2],[-87.7,46]]] })),
      db.prepare("INSERT INTO tfr_geometries VALUES ('wi-geometry','tfr-6-1004',?,44,-89.7,44.2,-89.5)").bind(JSON.stringify({ type: "Polygon", coordinates: [[[-89.7,44],[-89.5,44],[-89.5,44.2],[-89.7,44.2],[-89.7,44]]] })),
      db.prepare("INSERT INTO pa_operation_airspace_matches VALUES ('op','tfr','tfr-6-1003','intersects','source')"),
      db.prepare("INSERT INTO pa_operation_airspace_matches VALUES ('wi-op','tfr','tfr-6-1004','intersects','source')"),
    ]);
    expect((await airspaceView(env)).operationMatches).toMatchObject([{ operation_id: "wi-op", source_id: "tfr-6-1004" }]);
    expect(await rebuildOperationAirspaceMatches(env)).toBe(1);
    expect((await db.prepare("SELECT operation_id,source_id FROM pa_operation_airspace_matches").all()).results).toEqual([{ operation_id: "wi-op", source_id: "tfr-6-1004" }]);
  });
});
