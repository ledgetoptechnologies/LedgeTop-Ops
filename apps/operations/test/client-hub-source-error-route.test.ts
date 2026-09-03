import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
import worker from "../src/worker/index";
import { createProjectAlphaSourceContext, prepareProjectAlphaSourceRecords } from "../src/worker/project-alpha-source";
import type { Env, StaffPrincipal } from "../src/worker/types";
import type { ClientBusinessActivityPage } from "../src/worker/client-business-activity";
import { setProjectAlphaProjectManagementRoute } from "../src/worker/project-alpha-project-management";

const sourceId = "project-alpha:source-error-test";
const actor: StaffPrincipal = { id: "source-error-admin", email: "admin@example.test", displayName: "Admin", accessSubject: "verified-subject", projectAlphaUserId: null };
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare, db: D1Database, env: Env;
async function request(query = "") {
  return worker.fetch(new Request(`https://ops.example/api/client-hub${query}`), env, execution);
}
async function activityRequest(id: string, query = "", namespace = "business") {
  return worker.fetch(new Request(`https://ops.example/api/client-hub/sources/${encodeURIComponent(sourceId)}/${namespace}/standalone/${encodeURIComponent(id)}/activity${query}`), env, execution);
}
async function timelineRequest(id: string, query = "", namespace = "business") {
  return worker.fetch(new Request(`https://ops.example/api/client-hub/sources/${encodeURIComponent(sourceId)}/${namespace}/standalone/${encodeURIComponent(id)}/timeline${query}`), env, execution);
}
async function projectManagementRequest(id: string, query = "", namespace = "business", source = sourceId) {
  return worker.fetch(new Request(`https://ops.example/api/client-hub/sources/${encodeURIComponent(source)}/${namespace}/standalone/${encodeURIComponent(id)}/project-management${query}`), env, execution);
}
async function activityClient(times = ["2025-04-01T12:00:00.000Z", "2025-04-02T12:00:00.000Z"]) {
  const externalId = `activity-http-${crypto.randomUUID()}`;
  const mapping = await prepareProjectAlphaSourceRecords(db, createProjectAlphaSourceContext(sourceId), [{ kind: "client", externalId }]);
  const id = mapping.get("client", externalId), name = `Activity customer ${externalId}`;
  await db.prepare(`INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id)
    VALUES(?,?,NULL,1,?,'snapshot-http-fixture',?)`).bind(id, name,
    JSON.stringify({ updated_at: times[0], actor: "untrusted-actor-must-not-leak", private_note: "private-payload-must-not-leak" }), sourceId).run();
  for (const time of times.slice(1)) await db.prepare("UPDATE pa_clients SET payload_json=? WHERE id=?")
    .bind(JSON.stringify({ updated_at: time }), id).run();
  await db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
    VALUES(?,'business','standalone_client',?,?,?,'active')`).bind(sourceId, id, name, name.toLowerCase()).run();
  return { id, name, externalId };
}

describe("Client Hub source visibility errors through the Operations entrypoint", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file) && file.slice(0, 4) <= "0037").sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(file, directory), "utf8")).map(sql => db.prepare(sql)));
    }
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0046_project_alpha_project_management_routes.sql", import.meta.url), "utf8"))
      .map(sql => db.prepare(sql)));
    // Use the current Delivery schema: exact secondary workspace resolution is
    // part of the shared root proof even when this fixture has no workspace.
    const clientMigrations = new URL("../../client/migrations/", import.meta.url);
    for (const file of readdirSync(clientMigrations).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      await delivery.batch(splitD1MigrationStatements(readFileSync(new URL(file, clientMigrations), "utf8"))
        .map(sql => delivery.prepare(sql)));
    }
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(actor.id, actor.email, actor.displayName),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('source-error-role',?,'role-admin','global','global')").bind(actor.id),
    ]);
    await registerVisibleTestSource(db, "project-alpha:primary", "Primary source");
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id='project-alpha:primary'").run();
    await registerVisibleTestSource(db, sourceId, "Private secondary source");
    const ids = await prepareProjectAlphaSourceRecords(db, createProjectAlphaSourceContext(sourceId),
      [{ kind: "client", externalId: "1" }, { kind: "client", externalId: "2" }]);
    for (const externalId of ["1", "2"]) {
      const id = ids.get("client", externalId), name = `Private secondary client ${externalId}`;
      await db.batch([
        db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,NULL,1,'{}','fixture',?)").bind(id, name, sourceId),
        db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
          VALUES(?,'business','standalone_client',?,?,?,'active')`).bind(sourceId, id, name, name.toLowerCase()),
      ]);
    }
    await db.prepare("UPDATE client_hub_directory_state SET ready=1").run();
    // Directory reads are Operations-only; activity uses only the empty
    // Delivery account proof above, never media, queues or external networking.
    env = { OPS_DB: db, DELIVERY_DB: delivery, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
      PUBLIC_BASE_URL: "https://ops.example", OPERATIONS_SESSION_SECRET: "source-timeline-secret-that-is-long-enough-123" } as Env;
  }, 60_000);
  beforeEach(async () => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(actor);
    await registerVisibleTestSource(db, sourceId, "Private secondary source");
  });
  afterAll(async () => { await runtime?.dispose(); });

  it("preserves the source-change code and safe message so the browser can discard previously loaded rows", async () => {
    const first = await request("?limit=1");
    expect(first.status).toBe(200);
    const page = await first.json() as { clients: Array<{ display_name: string }>; nextCursor: string };
    expect(page.clients[0]?.display_name).toBe("Private secondary client 1");
    expect(page.nextCursor).toBeTruthy();
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?").bind(sourceId).run();
    const continuation = await request(`?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect(continuation.status).toBe(409);
    expect(continuation.headers.get("Cache-Control")).toContain("no-store");
    expect(await continuation.json()).toEqual({ code: "source_visibility_changed", error: "Client sources changed. Refresh the results to continue." });
    const refreshed = await request();
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).not.toContain("Private secondary");
  }, 30_000);

  it("does not forward arbitrary HTTPException response bodies from other failures", async () => {
    mocks.authenticateStaff.mockRejectedValue(new HTTPException(403, { message: "Authentication required",
      res: Response.json({ code: "source_visibility_changed", privateData: "must-not-be-forwarded" }, { status: 403 }) }));
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  it("keeps an ordinary directory revision conflict distinct from source visibility loss", async () => {
    await registerVisibleTestSource(db, sourceId, "Private secondary source");
    const first = await request("?limit=1");
    expect(first.status).toBe(200);
    const page = await first.json() as { nextCursor: string };
    await db.prepare("UPDATE client_hub_roots SET display_name=display_name||' updated' WHERE source_id=?").bind(sourceId).run();
    const response = await request(`?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The client directory changed. Refresh the results to continue" });
  });

  it("returns only source-owned activity DTOs with real pagination and no read-side writes", async () => {
    const client = await activityClient();
    const before = await db.prepare("SELECT count(*) count FROM client_business_activity").first<number>("count");
    const first = await activityRequest(client.id, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toContain("no-store");
    const page = await first.json() as ClientBusinessActivityPage;
    expect(page).toMatchObject({ coverage: "source_records_only", canonicalRoot: { sourceId, rootNamespace: "business", publicId: client.id },
      page: { available: true, hasMore: true, returned: 1, limit: 1 } });
    expect(page.items[0]).toMatchObject({ sourceId, recordId: client.id, recordKind: "client", recordName: client.name,
      origin: "source_observation", action: "source_record_updated", occurredAt: "2025-04-02T12:00:00.000Z" });
    expect(page.items[0]).not.toHaveProperty("actor");
    expect(JSON.stringify(page)).not.toMatch(/untrusted-actor|private-payload|payload_json|event_key/);
    const next = await activityRequest(client.id, `?limit=1&expectedContextVersion=${encodeURIComponent(page.contextVersion)}&cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    expect(next.status).toBe(200);
    const second = await next.json() as ClientBusinessActivityPage;
    expect(second.asOf).toBe(page.asOf);
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null, returned: 1 });
    expect(second.items[0]?.occurredAt).toBe("2025-04-01T12:00:00.000Z");
    expect(second.items[0]?.id).not.toBe(page.items[0]?.id);
    expect(await db.prepare("SELECT count(*) count FROM client_business_activity").first<number>("count")).toBe(before);
    expect(await env.DELIVERY_DB.prepare("SELECT count(*) count FROM client_accounts").first<number>("count")).toBe(0);
  }, 30_000);

  it("returns a read-only exact-source Project Alpha project action and safe synchronization affordances", async () => {
    const client = await activityClient(), connector = await db.prepare("SELECT version FROM pa_connectors WHERE source_id=?").bind(sourceId).first<{version:number}>();
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(sourceId).run();
    const activeVersion = connector!.version + 1;
    await setProjectAlphaProjectManagementRoute(env, sourceId, { expectedConnectorVersion: activeVersion, expectedVersion: null,
      idempotencyKey: "source-action-route-key-0001", reviewedUrlTemplate: "https://alpha.example.test/customers/{recordId}/projects/new" }, actor.id);
    await db.prepare(`INSERT INTO integration_health(integration,status,last_attempt_at,last_success_at,projection_source_id)
      VALUES('project-alpha','healthy','2026-08-28 12:00:00','2026-08-28 11:59:00',?)
      ON CONFLICT(projection_source_id,integration) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at`)
      .bind(sourceId).run();
    const before={projects:await db.prepare("SELECT count(*) count FROM pa_projects WHERE projection_source_id=?").bind(sourceId).first<number>("count"),
      audit:await db.prepare("SELECT count(*) count FROM pa_connector_project_management_route_audit WHERE source_id=?").bind(sourceId).first<number>("count")};
    const response=await projectManagementRequest(client.id);expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body=await response.json() as Record<string,any>;
    expect(body).toMatchObject({
      canonicalRoot:{sourceId,rootNamespace:"business",kind:"standalone_client",publicId:client.id},
      source:{sourceId,displayName:"Private secondary source",state:"active"},
      availability:{available:true,reason:"available"},
      action:{label:"Create project in Project Alpha",external:true,
        href:`https://alpha.example.test/customers/${encodeURIComponent(client.externalId)}/projects/new`},
      sync:{status:"healthy",lastAttemptAt:"2026-08-28T12:00:00.000Z",lastSuccessAt:"2026-08-28T11:59:00.000Z",
        refresh:{label:"Refresh synchronization status",href:`/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/standalone/${encodeURIComponent(client.id)}/project-management`,method:"GET"},
        requestSync:{label:"Sync source now",href:`/api/admin/integrations/project-alpha/connectors/${encodeURIComponent(sourceId)}/sync`,method:"POST"}},
    });
    expect(body.contextVersion).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(body)).not.toMatch(/payload_json|snapshot_origin|api.key|credential/i);
    expect(await db.prepare("SELECT count(*) count FROM pa_projects WHERE projection_source_id=?").bind(sourceId).first<number>("count")).toBe(before.projects);
    expect(await db.prepare("SELECT count(*) count FROM pa_connector_project_management_route_audit WHERE source_id=?").bind(sourceId).first<number>("count")).toBe(before.audit);
    const stale=await projectManagementRequest(client.id,"?expectedContextVersion=stale-context");expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({error:"Client context changed. Refresh the workspace to continue"});
  }, 30_000);

  it("retains only the exact source synchronization health when its project-management route is not configured", async () => {
    const exactSource = `project-alpha:unconfigured-${crypto.randomUUID()}`;
    await registerVisibleTestSource(db, exactSource, "Unconfigured source");
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(exactSource).run();
    const externalId = `unconfigured-http-${crypto.randomUUID()}`;
    const mapping = await prepareProjectAlphaSourceRecords(db, createProjectAlphaSourceContext(exactSource), [{ kind: "client", externalId }]);
    const id = mapping.get("client", externalId), name = "Unconfigured secondary client";
    await db.batch([
      db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,NULL,1,'{}','fixture',?)")
        .bind(id, name, exactSource),
      db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
        VALUES(?,'business','standalone_client',?,?,?,'active')`).bind(exactSource, id, name, name.toLowerCase()),
      db.prepare(`INSERT INTO integration_health(integration,status,last_attempt_at,last_success_at,projection_source_id)
        VALUES('project-alpha','healthy','2026-08-28 12:00:00','2026-08-28 11:59:00','project-alpha:primary')
        ON CONFLICT(projection_source_id,integration) DO UPDATE SET status=excluded.status,
          last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at`),
      db.prepare(`INSERT INTO integration_health(integration,status,last_attempt_at,last_success_at,projection_source_id)
        VALUES('project-alpha','error','2026-08-29 12:00:00',NULL,?)
        ON CONFLICT(projection_source_id,integration) DO UPDATE SET status=excluded.status,
          last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at`).bind(exactSource),
    ]);
    const response = await projectManagementRequest(id, "", "business", exactSource);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as Record<string, any>;
    expect(body).toMatchObject({
      canonicalRoot: { sourceId: exactSource, rootNamespace: "business", kind: "standalone_client", publicId: id },
      source: { sourceId: exactSource, displayName: "Unconfigured source", state: "active" },
      availability: { available: false, reason: "route_not_configured" },
      action: null,
      sync: { status: "error", lastAttemptAt: "2026-08-29T12:00:00.000Z", lastSuccessAt: null },
    });
    expect(body.sync.explanation).toContain("Unconfigured source synchronization needs attention");
    expect(JSON.stringify(body)).not.toContain("2026-08-28T12:00:00.000Z");
  }, 30_000);

  it("fails the Project Alpha action closed when the exact source or reviewed route is inactive", async () => {
    const client=await activityClient(), current=await db.prepare("SELECT version FROM pa_connectors WHERE source_id=?").bind(sourceId).first<number>("version");
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(sourceId).run();
    const suspended=await projectManagementRequest(client.id);expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({availability:{available:false,reason:"source_inactive"},action:null,
      sync:{requestSync:null}});
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(sourceId).run();
    const route=await db.prepare("SELECT version FROM pa_connector_project_management_routes WHERE source_id=?").bind(sourceId).first<number>("version");
    const connectorVersion=(current??0)+2;
    await setProjectAlphaProjectManagementRoute(env,sourceId,{expectedConnectorVersion:connectorVersion,expectedVersion:route,
      idempotencyKey:"source-action-route-disable",reviewedUrlTemplate:null},actor.id);
    const disabled=await projectManagementRequest(client.id);expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({availability:{available:false,reason:"route_disabled"},action:null});
    expect((await projectManagementRequest(client.id,"","portal")).status).toBe(404);
    expect((await worker.fetch(new Request(`https://ops.example/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/standalone/${encodeURIComponent("unknown")}/project-management`),env,execution)).status).toBe(404);
  },30_000);

  it("exposes a source-qualified staff timeline while keeping every secondary portal category unavailable", async () => {
    const client = await activityClient(["2025-05-01T12:00:00.000Z", "2025-05-02T12:00:00.000Z"]);
    const first = await timelineRequest(client.id, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toContain("no-store");
    const page = await first.json() as import("@ltds/shared").ClientAuditTimelinePage;
    expect(page).toMatchObject({ canonicalRoot: { sourceId, rootNamespace: "business", publicId: client.id },
      coverage: { project: { available: true, reason: null }, request: { available: false, reason: "unsupported_source" },
        feedback: { available: false, reason: "unsupported_source" }, access: { available: false, reason: "unsupported_source" },
        delivery: { available: false, reason: "not_applicable" }, notification: { available: false, reason: "unsupported_source" } },
      page: { returned: 1, hasMore: true, limit: 1 } });
    expect(page.items[0]).toMatchObject({ sourceId, producer: "project_alpha", category: "project",
      actor: null, result: "informational", resource: { label: client.name } });
    expect(JSON.stringify(page)).not.toMatch(/untrusted-actor|private-payload|payload_json|event_key/);
    const next = await timelineRequest(client.id, `?limit=1&expectedContextVersion=${encodeURIComponent(page.contextVersion)}&cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    expect(next.status).toBe(200);
    expect((await next.json() as import("@ltds/shared").ClientAuditTimelinePage).page).toMatchObject({ returned: 1, hasMore: false });
  }, 30_000);

  it("rejects stale expected workspace context before returning activity", async () => {
    const client = await activityClient();
    const first = await activityRequest(client.id);
    expect(first.status).toBe(200);
    const page = await first.json() as ClientBusinessActivityPage;
    // A source visibility epoch change invalidates the shared detail context.
    await registerVisibleTestSource(db, sourceId, "Renamed source");
    const response = await activityRequest(client.id, `?expectedContextVersion=${encodeURIComponent(page.contextVersion)}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Client context changed. Refresh the workspace to continue" });
  }, 30_000);

  it("rejects stale activity continuation when a new applied observation changes ordering", async () => {
    const client = await activityClient();
    const page = await (await activityRequest(client.id, "?limit=1")).json() as ClientBusinessActivityPage;
    await db.prepare("UPDATE pa_clients SET payload_json=? WHERE id=?")
      .bind(JSON.stringify({ updated_at: "2025-04-03T12:00:00.000Z" }), client.id).run();
    const response = await activityRequest(client.id, `?cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Business activity or access changed. Refresh the client workspace to continue" });
  }, 30_000);

  it("rejects an activity cursor reused for another source root", async () => {
    const firstClient = await activityClient(), secondClient = await activityClient();
    const response = await activityRequest(firstClient.id, "?limit=1");
    expect(response.status).toBe(200);
    const page = await response.json() as ClientBusinessActivityPage;
    const wrong = await activityRequest(secondClient.id, `?cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "Business activity cursor does not match this resource" });
  }, 30_000);

  it("denies activity after source hiding without returning old data or cursor", async () => {
    const client = await activityClient();
    const page = await (await activityRequest(client.id, "?limit=1")).json() as ClientBusinessActivityPage;
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?").bind(sourceId).run();
    const response = await activityRequest(client.id, `?cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(client.name);
    expect(body).not.toContain("items");
  }, 30_000);

  it("requires actual global directory authority and authenticated entry for activity", async () => {
    const client = await activityClient();
    mocks.authenticateStaff.mockRejectedValueOnce(new HTTPException(401, { message: "Authentication required" }));
    expect((await activityRequest(client.id)).status).toBe(401);
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES('activity-http-deny',?,'team.view','deny','global','global',?)`).bind(actor.id, actor.id).run();
    try {
      const response = await activityRequest(client.id);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(client.name);
    } finally {
      await db.prepare("DELETE FROM staff_permission_overrides WHERE id='activity-http-deny'").run();
    }
  }, 30_000);

  it.each(["?limit=0", "?limit=101", "?limit=no", "?cursor=invalid!", "?projectId="])("rejects malformed activity options %s", async query => {
    const client = await activityClient();
    const response = await activityRequest(client.id, query);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/SELECT|SQLITE|D1_ERROR|payload_json/);
  }, 30_000);

  it("does not reinterpret portal namespace activity as business history", async () => {
    const client = await activityClient();
    const response = await activityRequest(client.id, "", "portal");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(client.name);
  });
});
