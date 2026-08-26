import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { projectAlphaReadVisibleSql, requireProjectAlphaReadVisibility } from "../src/worker/project-alpha-read-visibility";
import { paCalendarFilter, paProjectFilter, paResourceFilter } from "../src/worker/visibility";
import type { StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe("registered business read visibility", () => {
  it("applies the same primary-compatible, fail-closed source predicate to broad project, operation, task and calendar reads", async () => {
    runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    const db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.exec("CREATE TABLE records(id TEXT PRIMARY KEY,active INTEGER,projection_source_id TEXT); INSERT INTO records VALUES('a',1,'project-alpha:primary'),('b',1,'project-alpha:secondary'),('c',0,'project-alpha:secondary');");
    const env = { OPS_DB: db };
    await expect(requireProjectAlphaReadVisibility(env, "project-alpha:primary")).rejects.toThrow();
    await applyConnectorSchema(db);
    const scope = { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };
    const actor = { id: "staff", projectAlphaUserId: "1" } as StaffPrincipal;
    const filters = [paProjectFilter(scope, actor, true), paProjectFilter(scope, actor, false, true),
      paResourceFilter(scope, actor, true, "p", "operation"), paResourceFilter(scope, actor, false, "p", "task", true),
      paCalendarFilter(scope, actor, true, "p"), paCalendarFilter(scope, actor, false, "p", true)];
    const selected = async (filter: typeof filters[number]) => (await db.prepare(`SELECT p.id FROM records p WHERE ${filter.sql} ORDER BY p.id`).bind(...filter.values).all<{ id: string }>()).results;
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }]);
    await expect(requireProjectAlphaReadVisibility(env, "project-alpha:secondary")).rejects.toMatchObject({ status: 404 });
    await registerVisibleTestSource(db, "project-alpha:secondary", "Business B");
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }, { id: "b" }]);
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await requireProjectAlphaReadVisibility(env, "project-alpha:secondary")).toMatchObject({ visible: 1, display_name: "Business B" });
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:secondary'").run();
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }]);
    await registerVisibleTestSource(db, "project-alpha:primary", "Primary company");
    expect(await requireProjectAlphaReadVisibility(env, "project-alpha:primary")).toMatchObject({ visible: 1, display_name: "Primary company" });
    await expect(db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:primary'").run()).rejects.toThrow();
    expect(await requireProjectAlphaReadVisibility(env, "delivery:local")).toMatchObject({ visible: 1, display_name: "Local delivery" });
  }, 30_000);

  it("rejects SQL expressions instead of interpolating a caller-provided source expression", () => {
    for (const value of ["p.source_id OR 1=1", "p.source_id;DROP TABLE records", "p.source_id--", "p.source_id)", "p..source_id"])
      expect(() => projectAlphaReadVisibleSql(value)).toThrow("invalid-project-alpha-source-column");
    expect(projectAlphaReadVisibleSql("p.projection_source_id")).toContain("visible_connector.source_id=p.projection_source_id");
  });
});
