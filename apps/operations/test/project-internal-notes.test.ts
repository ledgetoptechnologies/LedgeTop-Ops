import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

import { createProjectInternalNote, deleteProjectInternalNote, readProjectInternalNotes, updateProjectInternalNote } from "../src/worker/project-internal-notes";

const actor = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com", displayName: "Beau Koltz",
  accessSubject: "owner", projectAlphaUserId: null } as StaffPrincipal;
const key = () => `project_note_${crypto.randomUUID()}`;
let runtime: Miniflare, ops: D1Database, env: Env, sequence = 0;
function context(source = "project-alpha:primary", id = "notes-org"): ClientHubCollectionContext {
  return { root: { source_id: source as `project-alpha:${string}`, root_namespace: "business", kind: "organization", public_id: id,
    pa_public_id: id, mapping_status: "mapped", display_name: id, source_name: "Project Alpha", sort_name: id, status: "active",
    portal_status: "active", workspace_id: null, legacy_account_id: null, account_count: 0, project_count: 0, request_count: 0,
    contact_count: 0, meaningful_activity_at: null, source_version: "r1", indexed_at: "2026-09-02T00:00:00.000Z", scan_generation: 1 },
  access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "c".repeat(43),
  canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: id } };
}
async function root(projectId: string, source = "project-alpha:primary") {
  const id = `notes-org-${++sequence}`, scope = context(source, id);
  await ops.batch([
    ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)").bind(source,id,id),
    ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,'{}','r1',?)").bind(id,id,source),
    ops.prepare("INSERT INTO pa_projects(id,organization_id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,'{}','r1',?)").bind(projectId,id,projectId,source),
  ]);
  return scope;
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { OPS_DB: "project-notes-ops", DELIVERY_DB: "project-notes-delivery" } });
  ops = await runtime.getD1Database("OPS_DB") as D1Database;
  const delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database, directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql")).sort())
    await ops.batch(splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8")).map(sql => ops.prepare(sql)));
  env = { OPS_DB: ops, DELIVERY_DB: delivery } as Env;
}, 120_000);
afterAll(async () => runtime?.dispose());

describe("source-qualified project internal notes", () => {
  it("keeps project scope, audit revisions, idempotent replays, and root notes separate", async () => {
    const project = `project-one-${++sequence}`, scope = await root(project), create = { expectedContextVersion: scope.contextVersion, title: " Arrival ", body: "Call first." };
    const createKey = key(), saved = await createProjectInternalNote(env, actor, scope, project, create, createKey);
    expect(saved).toMatchObject({ version: 1, deleted: false, replayed: false });
    expect(await createProjectInternalNote(env, actor, scope, project, create, createKey)).toEqual({ ...saved, replayed: true });
    expect((await readProjectInternalNotes(env, actor, scope, project)).notes[0]).toMatchObject({ id: saved.noteId, title: "Arrival", body: "Call first." });
    await expect(readProjectInternalNotes(env, actor, scope, "project-two")).rejects.toMatchObject({ status: 404 });
    const updated = await updateProjectInternalNote(env, actor, scope, project, saved.noteId, { expectedContextVersion: scope.contextVersion,
      expectedVersion: 1, title: "Arrival", body: "Call site lead first." }, key());
    expect(updated).toMatchObject({ version: 2, replayed: false });
    const deleted = await deleteProjectInternalNote(env, actor, scope, project, saved.noteId,
      { expectedContextVersion: scope.contextVersion, expectedVersion: 2 }, key());
    expect(deleted).toMatchObject({ version: 3, deleted: true });
    expect((await ops.prepare("SELECT version,action FROM project_internal_note_revisions WHERE note_id=? ORDER BY version").bind(saved.noteId).all()).results)
      .toEqual([{ version: 1, action: "created" }, { version: 2, action: "updated" }, { version: 3, action: "deleted" }]);
    expect(await ops.prepare("SELECT count(*) count FROM project_internal_note_write_fences WHERE project_id=?")
      .bind(project).first<number>("count")).toBe(0);
    expect(await ops.prepare("SELECT count(*) count FROM client_internal_notes").first<number>("count")).toBe(0);
    await expect(ops.prepare("DELETE FROM project_internal_notes WHERE id=?").bind(saved.noteId).run()).rejects.toThrow();
  }, 40_000);

  it("rejects the same idempotency key when the project tuple changes", async () => {
    const primary = `project-primary-${++sequence}`, other = `project-other-${++sequence}`, scope = await root(primary), requestKey = key(), input = { expectedContextVersion: scope.contextVersion, title: "Scoped", body: "Private" };
    await ops.prepare("INSERT INTO pa_projects(id,organization_id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,'{}','r1','project-alpha:primary')").bind(other,scope.root.public_id,other).run();
    await createProjectInternalNote(env, actor, scope, primary, input, requestKey);
    await expect(createProjectInternalNote(env, actor, scope, other, input, requestKey)).rejects.toMatchObject({ status: 409 });
  }, 40_000);

  it("rolls back every note row when the project is reassigned immediately before the batch writes", async () => {
    const project = `project-fence-${++sequence}`, scope = await root(project), requestKey = key();
    const trigger = `CREATE TRIGGER project_note_test_reassign BEFORE INSERT ON project_internal_note_write_fences
      WHEN NEW.project_id='${project}' BEGIN UPDATE pa_projects SET organization_id='reassigned-during-write' WHERE id='${project}'; END;`;
    await ops.batch(splitD1MigrationStatements(trigger).map(sql => ops.prepare(sql)));
    try {
      await expect(createProjectInternalNote(env, actor, scope, project, { expectedContextVersion: scope.contextVersion,
        title: "Must not persist", body: "The project moved before the guarded write." }, requestKey)).rejects.toMatchObject({ status: 409 });
    } finally { await ops.prepare("DROP TRIGGER project_note_test_reassign").run(); }
    for (const table of ["project_internal_notes", "project_internal_note_revisions", "project_internal_note_mutations", "project_internal_note_write_fences"])
      expect(await ops.prepare(`SELECT count(*) count FROM ${table} WHERE project_id=?`).bind(project).first<number>("count")).toBe(0);
  }, 40_000);
});
