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

const sourceId = "project-alpha:source-error-test";
const actor: StaffPrincipal = { id: "source-error-admin", email: "admin@example.test", displayName: "Admin", accessSubject: "verified-subject", projectAlphaUserId: null };
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare, db: D1Database, env: Env;
async function request(query = "") {
  return worker.fetch(new Request(`https://ops.example/api/client-hub${query}`), env, execution);
}

describe("Client Hub source visibility errors through the Operations entrypoint", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file) && file.slice(0, 4) <= "0036").sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(file, directory), "utf8")).map(sql => db.prepare(sql)));
    }
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(actor.id, actor.email, actor.displayName),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('source-error-role',?,'role-admin','global','global')").bind(actor.id),
    ]);
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
    // This read needs no Delivery, media, queue, or external-network bindings.
    env = { OPS_DB: db, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
      PUBLIC_BASE_URL: "https://ops.example" } as Env;
  }, 60_000);
  beforeEach(() => { mocks.authenticateStaff.mockReset().mockResolvedValue(actor); });
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
  });

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
});
