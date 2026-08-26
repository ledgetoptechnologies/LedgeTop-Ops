import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { listServiceCatalogPage, listServiceCatalogPageForSource, ServiceCatalogPageError } from "../src/worker/client-portal/service-catalog-page";
import { listServiceCatalog } from "../src/worker/client-portal/request-v2";
import type { ClientPortalRepository, ClientPortalSession, ClientServiceCatalogPage } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

describe("bounded versioned service catalog pages", () => {
  let miniflare: Miniflare;
  let database: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DELIVERY_DB: "catalog-pages" } });
    database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await database.batch(statements.map(statement => database.prepare(statement)));
    }
    env = { DELIVERY_DB: database, PROJECT_ALPHA_CATALOG_APPLICATION_KEY: "generic-service-catalog" } as Env;
  }, 60_000);
  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM pa_service_catalog_items"),
      database.prepare("DELETE FROM pa_service_catalog_checkpoint"),
      database.prepare("DELETE FROM pa_service_catalog_generations"),
      database.prepare(`INSERT INTO pa_service_catalog_generations(id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES('generation-a','catalog-a',1,?,1,0,'active',1)`).bind("a".repeat(64)),
      database.prepare("INSERT INTO pa_service_catalog_checkpoint(active_generation_id,source_generation,source_sequence) VALUES ('generation-a','catalog-a',2)"),
    ]);
  });

  async function seed(count: number, sourceId: string = PRIMARY_ALPHA_SOURCE_ID) {
    const items = Array.from({ length: count }, (_, index) => ({
      id: `svc-${String(index).padStart(4, "0")}`, category: index % 3 === 0 ? "Mapping" : index % 3 === 1 ? "mapping" : "Élevation",
      name: index % 2 ? "Inspection" : "inspection", order: index % 4,
    }));
    await database.prepare(`INSERT INTO pa_service_catalog_items
      (source_id,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
      SELECT ?,json_extract(value,'$.id'),'version-1',json_extract(value,'$.name'),NULL,json_extract(value,'$.category'),
        json_extract(value,'$.order'),'optional','[]',1,'2026-08-25T12:00:00Z' FROM json_each(?)`)
      .bind(sourceId, JSON.stringify(items)).run();
  }

  it("pages every active service beyond the compatibility limit without duplicates or collation gaps", async () => {
    await seed(507);
    expect(await listServiceCatalog(env)).toHaveLength(500);
    const expected = (await database.prepare(`SELECT public_id FROM pa_service_catalog_items WHERE active=1
      ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id`).all<{ public_id: string }>()).results.map(row => row.public_id);
    const ids: string[] = [];
    let cursor: string | undefined;
    const pages: ClientServiceCatalogPage[] = [];
    do {
      const page = await listServiceCatalogPage(env, { cursor });
      expect(page.services.length).toBeLessThanOrEqual(100);
      expect(page.complete).toBe(page.nextCursor === null);
      expect(page.source).toEqual({ generation: "catalog-a", sequence: 2 });
      ids.push(...page.services.map(service => service.publicId));
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThanOrEqual(6);
    } while (cursor);
    expect(pages).toHaveLength(6);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(507);
    const last = await listServiceCatalogPage(env, { cursor: pages[4]!.nextCursor! });
    expect(last).toEqual(pages[5]);
  });

  it("rejects event checkpoint drift, replacement generations and changed source application on continuation", async () => {
    await seed(3);
    const first = await listServiceCatalogPage(env, { limit: 1 });
    await database.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=3").run();
    await expect(listServiceCatalogPage(env, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    await database.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=2").run();
    await expect(listServiceCatalogPage({ ...env, PROJECT_ALPHA_CATALOG_APPLICATION_KEY: "other-source" }, { cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    await database.batch([
      database.prepare("UPDATE pa_service_catalog_generations SET status='superseded' WHERE id='generation-a'"),
      database.prepare(`INSERT INTO pa_service_catalog_generations(id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES('generation-b','catalog-b',3,?,1,0,'active',1)`).bind("b".repeat(64)),
      database.prepare("UPDATE pa_service_catalog_checkpoint SET active_generation_id='generation-b',source_generation='catalog-b',source_sequence=3"),
    ]);
    await expect(listServiceCatalogPage(env, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409, code: "catalog_changed" });
  });

  it("checks the checkpoint again after reading rows before returning a page", async () => {
    await seed(3);
    let changed = false;
    const session = database.withSession("first-primary");
    const raced = new Proxy(session, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(prepared, method) {
          if (method === "bind") return (...bindings: unknown[]) => wrap(prepared.bind(...bindings));
          if (method === "all" && sql.includes("FROM pa_service_catalog_items")) return async () => {
            const rows = await prepared.all();
            if (!changed) { changed = true; await database.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=3").run(); }
            return rows;
          };
          const value = Reflect.get(prepared, method, prepared);
          return typeof value === "function" ? value.bind(prepared) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const wrapped = new Proxy(database, { get(target, property) {
      if (property === "withSession") return () => raced;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(listServiceCatalogPage({ ...env, DELIVERY_DB: wrapped })).rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    expect(changed).toBe(true);
  });

  it("uses typed not-ready only for an initial legacy catalog, never to bless a stale projected cursor", async () => {
    await seed(2);
    const first = await listServiceCatalogPage(env, { limit: 1 });
    await database.prepare("UPDATE pa_service_catalog_checkpoint SET active_generation_id=NULL,source_generation='legacy',source_sequence=0").run();
    await expect(listServiceCatalogPage(env)).rejects.toMatchObject({ status: 503, code: "catalog_not_ready" });
    expect(await listServiceCatalog(env)).toHaveLength(2);
    await expect(listServiceCatalogPage(env, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409, code: "catalog_changed" });
  });

  it("returns an initialized empty catalog as complete", async () => {
    expect(await listServiceCatalogPage(env)).toEqual({ services: [], nextCursor: null, complete: true, source: { generation: "catalog-a", sequence: 2 } });
  });

  it("separates colliding source IDs and source-bound cursors without invalidating the other source", async () => {
    const second = createCatalogSourceContext("project-alpha:secondary");
    await database.batch([
      database.prepare(`INSERT INTO pa_service_catalog_generations(id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('secondary-generation',?,'catalog-a',1,?,1,0,'active',1)`).bind(second.sourceId, "a".repeat(64)),
      database.prepare(`INSERT INTO pa_service_catalog_checkpoint(source_id,active_generation_id,source_generation,source_sequence)
        VALUES (?,'secondary-generation','catalog-a',2)`).bind(second.sourceId),
    ]);
    await seed(3);
    await seed(3, second.sourceId);
    await database.prepare("UPDATE pa_service_catalog_items SET summary='Secondary only' WHERE source_id=?").bind(second.sourceId).run();
    const primary = await listServiceCatalogPage(env, { limit: 1 });
    const secondary = await listServiceCatalogPageForSource(env, second, { limit: 1 });
    expect(primary.services[0]?.publicId).toBe(secondary.services[0]?.publicId);
    expect(primary.services[0]?.summary).toBeNull();
    expect(secondary.services[0]?.summary).toBe("Secondary only");
    expect(await listServiceCatalog(env)).toHaveLength(3);
    await expect(listServiceCatalogPageForSource(env, second, { cursor: primary.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    await expect(listServiceCatalogPage(env, { cursor: secondary.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    await database.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=3 WHERE source_id=?").bind(second.sourceId).run();
    expect((await listServiceCatalogPage(env, { cursor: primary.nextCursor! })).services).toHaveLength(2);
    await expect(listServiceCatalogPageForSource(env, second, { cursor: secondary.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    const refreshedSecondary = await listServiceCatalogPageForSource(env, second, { limit: 1 });
    await database.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=3 WHERE source_id=?").bind(PRIMARY_ALPHA_SOURCE_ID).run();
    expect((await listServiceCatalogPageForSource(env, second, { cursor: refreshedSecondary.nextCursor! })).services).toHaveLength(2);
    await database.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE source_id=?").bind(PRIMARY_ALPHA_SOURCE_ID).run();
    expect((await listServiceCatalogPage(env)).services).toEqual([]);
    expect(await listServiceCatalog(env)).toEqual([]);
  });

  it("uses the production catalog ordering index for bounded continuation", async () => {
    const plan = await database.prepare(`EXPLAIN QUERY PLAN SELECT public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json
      FROM pa_service_catalog_items WHERE source_id=? AND active=1 AND
        (category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id) > (? COLLATE NOCASE,?,? COLLATE NOCASE,?)
      ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id LIMIT ?`)
      .bind(PRIMARY_ALPHA_SOURCE_ID, "Mapping", 1, "Inspection", "svc-0001", 101).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes("idx_pa_service_catalog_client_order"))).toBe(true);
    expect(plan.results.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  });

  it.each(["", "not-base64!", "a".repeat(2049), "e30", "eyJ2IjoyfQ"])("rejects malformed cursor %s with a safe typed error", async cursor => {
    await expect(listServiceCatalogPage(env, { cursor })).rejects.toMatchObject({ status: 400, code: "catalog_cursor_invalid" });
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity])("rejects an out-of-bounds page size %s", async limit => {
    await expect(listServiceCatalogPage(env, { limit })).rejects.toMatchObject({ status: 400, code: "catalog_cursor_invalid" });
  });

  it("does not silently omit malformed active services and claim a complete catalog", async () => {
    await seed(1);
    await database.prepare("UPDATE pa_service_catalog_items SET question_schema_json='[1]'").run();
    await expect(listServiceCatalogPage(env)).rejects.toMatchObject({ status: 503, code: "catalog_unavailable" });
  });
});

describe("service catalog page route", () => {
  const session: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "Acme", role: "manager", canViewBilling: false };
  const env = { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example", ENVIRONMENT: "development" } as Env;
  const principal = async () => ({ issuer: "https://issuer.example", subject: "client-a", email: "client@example.test" });
  function router(page = vi.fn(async (): Promise<ClientServiceCatalogPage> => ({ services: [], complete: true, nextCursor: null, source: { generation: "catalog-a", sequence: 2 } }))) {
    return { page, app: createClientPortalRouter({ resolvePrincipal: principal,
      repository: { resolveSession: async () => session, listServiceCatalogPage: page } as unknown as ClientPortalRepository }) };
  }

  it("passes the authorized session and bounded options to the optional repository page method", async () => {
    const { app, page } = router();
    const response = await app.request("https://client.example/service-catalog/page?limit=25&cursor=opaque", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(page).toHaveBeenCalledWith(expect.anything(), session, { limit: 25, cursor: "opaque" });
  });

  it.each(["limit=101", "limit=01", "limit=1.5", "limit=1&limit=2", "cursor=a&cursor=b", "price=true", "sourceId=project-alpha:secondary"])("rejects invalid page query %s before repository access", async query => {
    const { app, page } = router();
    const response = await app.request(`https://client.example/service-catalog/page?${query}`, {}, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "catalog_cursor_invalid" });
    expect(page).not.toHaveBeenCalled();
  });

  it("preserves feature gating and client authentication for the new subroute", async () => {
    const { app, page } = router();
    expect((await app.request("https://client.example/service-catalog/page", {}, { ...env, CLIENT_PORTAL_REQUEST_V2_ENABLED: "false" })).status).toBe(404);
    const denied = createClientPortalRouter({ resolvePrincipal: async () => null, repository: { resolveSession: async () => session, listServiceCatalogPage: page } as unknown as ClientPortalRepository });
    expect((await denied.request("https://client.example/service-catalog/page", {}, env)).status).toBe(401);
    expect(page).not.toHaveBeenCalled();
  });

  it("returns only typed safe catalog errors", async () => {
    const { app } = router(vi.fn(async () => { throw new ServiceCatalogPageError(503, "catalog_not_ready"); }));
    const response = await app.request("https://client.example/service-catalog/page", {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Versioned service library browsing is not ready.", code: "catalog_not_ready" });
  });
});
