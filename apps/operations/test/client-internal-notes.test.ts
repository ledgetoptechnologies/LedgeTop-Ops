import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { createClientInternalNote, deleteClientInternalNote, readClientInternalNotes, updateClientInternalNote } from "../src/worker/client-internal-notes";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const actor = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com", displayName: "Beau Koltz",
  accessSubject: "owner", projectAlphaUserId: null } as StaffPrincipal;
const key = () => `client_note_${crypto.randomUUID()}`;
let runtime: Miniflare, ops: D1Database, delivery: D1Database, env: Pick<Env,"OPS_DB"|"DELIVERY_DB">, sequence = 0;
function context(source: string, id: string): ClientHubCollectionContext {
  return { root: { source_id: source as `project-alpha:${string}`, root_namespace: "business", kind: "organization", public_id: id,
    pa_public_id: id, mapping_status: "mapped", display_name: id, source_name: "Project Alpha", sort_name: id, status: "active",
    portal_status: "active", workspace_id: null, legacy_account_id: null, account_count: 0, project_count: 0, request_count: 0,
    contact_count: 0, meaningful_activity_at: null, source_version: "r1", indexed_at: "2026-09-02T00:00:00.000Z", scan_generation: 1 },
    access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "c".repeat(43),
    canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: id } };
}
async function root(source = "project-alpha:primary", fixedId?: string) {
  const id = fixedId ?? `notes-org-${++sequence}`;
  await ops.batch([
    ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)").bind(source,id,id),
    ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,'{}','r1',?)").bind(id,id,source),
  ]);
  return context(source,id);
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { OPS_DB: "notes-ops", DELIVERY_DB: "notes-delivery" } });
  ops = await runtime.getD1Database("OPS_DB") as D1Database; delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
    const statements = splitD1MigrationStatements(readFileSync(new URL(filename,directory),"utf8"));
    await ops.batch(statements.map(sql => ops.prepare(sql)));
  }
  env = { OPS_DB: ops, DELIVERY_DB: delivery };
}, 120_000);
afterAll(async () => runtime?.dispose());

describe("source-qualified internal Client Hub notes", () => {
  it("creates, updates, soft deletes, and replays mutations without losing immutable history", async () => {
    const scope = await root(), createKey = key(), create = { expectedContextVersion: scope.contextVersion, title: " Site preference ", body: "Call first." };
    const saved = await createClientInternalNote(env,actor,scope,create,createKey);
    expect(saved).toMatchObject({ version: 1, deleted: false, replayed: false });
    expect(await createClientInternalNote(env,actor,scope,create,createKey)).toEqual({ ...saved, replayed: true });
    await expect(createClientInternalNote(env,actor,scope,{ ...create, title: "Different" },createKey)).rejects.toMatchObject({ status: 409 });
    expect((await readClientInternalNotes(env,actor,scope)).notes[0]).toMatchObject({ id: saved.noteId, title: "Site preference", body: "Call first.", version: 1 });
    const updated = await updateClientInternalNote(env,actor,scope,saved.noteId,{ expectedContextVersion: scope.contextVersion,
      expectedVersion: 1, title: "Site preference", body: "Call the superintendent first." },key());
    expect(updated).toMatchObject({ version: 2, replayed: false });
    await expect(updateClientInternalNote(env,actor,scope,saved.noteId,{ expectedContextVersion: scope.contextVersion,
      expectedVersion: 1, title: "Stale", body: "" },key())).rejects.toMatchObject({ status: 409 });
    const deleteKey = key(), deleted = await deleteClientInternalNote(env,actor,scope,saved.noteId,
      { expectedContextVersion: scope.contextVersion, expectedVersion: 2 },deleteKey);
    expect(deleted).toMatchObject({ version: 3, deleted: true, replayed: false });
    expect(await deleteClientInternalNote(env,actor,scope,saved.noteId,
      { expectedContextVersion: scope.contextVersion, expectedVersion: 2 },deleteKey)).toEqual({ ...deleted, replayed: true });
    expect((await readClientInternalNotes(env,actor,scope)).notes).toEqual([]);
    expect((await ops.prepare("SELECT version,action FROM client_internal_note_revisions WHERE note_id=? ORDER BY version")
      .bind(saved.noteId).all()).results).toEqual([{ version: 1, action: "created" }, { version: 2, action: "updated" }, { version: 3, action: "deleted" }]);
    await expect(ops.prepare("UPDATE client_internal_note_revisions SET action='updated' WHERE note_id=? AND version=1").bind(saved.noteId).run()).rejects.toThrow();
    await expect(ops.prepare("DELETE FROM client_internal_notes WHERE id=?").bind(saved.noteId).run()).rejects.toThrow();
  }, 40_000);

  it("isolates business roots by exact source and root tuple", async () => {
    await registerVisibleTestSource(ops,"project-alpha:secondary","Secondary");
    const primary = await root("project-alpha:primary"), other = await root("project-alpha:secondary");
    const saved = await createClientInternalNote(env,actor,primary,{ expectedContextVersion: primary.contextVersion, title: "Primary only", body: "private" },key());
    expect((await readClientInternalNotes(env,actor,other)).notes).toEqual([]);
    await expect(updateClientInternalNote(env,actor,other,saved.noteId,{ expectedContextVersion: other.contextVersion,
      expectedVersion: 1, title: "Cross source", body: "blocked" },key())).rejects.toMatchObject({ status: 409 });
  }, 40_000);

  it("requires live visibility and explicit mutation authority", async () => {
    const scope = await root();
    await ops.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'client.notes.manage','deny','global','global',?)")
      .bind(crypto.randomUUID(),actor.id,actor.id).run();
    expect((await readClientInternalNotes(env,actor,scope)).capabilities.canManageNotes).toBe(false);
    await expect(createClientInternalNote(env,actor,scope,{ expectedContextVersion: scope.contextVersion, title: "Denied", body: "" },key()))
      .rejects.toMatchObject({ status: 403 });
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='client.notes.manage'").bind(actor.id).run();
    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id=? AND projection_source_id=?").bind(scope.root.public_id,scope.root.source_id).run();
    await expect(readClientInternalNotes(env,actor,scope)).rejects.toMatchObject({ status: 404 });
  }, 40_000);
});
