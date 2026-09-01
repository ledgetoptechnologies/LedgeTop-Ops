import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNativeFeedbackRecord, transitionNativeFeedbackRecord, type NativeFeedbackAuthorization } from "../src/worker/client-portal/native-feedback-store";

describe("native secondary-source feedback persistence", { timeout: 30_000 }, () => {
  let runtime: Miniflare, db: D1Database, sequence = 0;
  const operation = () => `native-feedback-operation-${++sequence}`;
  const authorization = (sourceId = "project-alpha:secondary", workspaceId = "workspace-secondary"): NativeFeedbackAuthorization => ({
    context: { sourceId, workspaceId, identityId: "identity-secondary", issuer: "https://issuer.test", subject: "person-secondary" },
    target: { version: 1, sourceId, workspaceId, rootType: "organization", rootPublicId: "org-secondary", kind: "project",
      projectPublicId: "project-secondary", targetType: "project", targetPublicId: "project-secondary", label: "Secondary project",
      projectName: "Secondary project", relativePath: null, storageKey: null, file: null, grant: null,
      scopeProof: [{ entityType: "organization", publicId: "org-secondary", parentPublicId: null, sourceVersion: "org-v1", depth: 0 },
        { entityType: "project", publicId: "project-secondary", parentPublicId: "org-secondary", sourceVersion: "project-v1", depth: 1 }] },
    guard: { sql: "EXISTS(SELECT 1 FROM portal_v2_workspaces WHERE id=? AND status='active')", bindings: [workspaceId] }, available: true,
  });
  const deliveryAuthorization = (ownerType: "organization"|"department"|"client", kind: "folder"|"file"): NativeFeedbackAuthorization => {
    const value = authorization(), ownerPublicId = `${ownerType}-secondary`, isFile = kind === "file";
    value.target = { ...value.target, kind, projectPublicId: null, targetType: "folder", targetPublicId: "binding-secondary",
      label: isFile ? "inspection.jpg" : "Edited photos", projectName: null, relativePath: isFile ? "Edited/inspection.jpg" : "Edited/",
      storageKey: isFile ? "secondary/Edited/inspection.jpg" : null,
      file: isFile ? { etag: "file-etag", size: 42, uploadedAt: "2026-08-31T12:00:00.000Z" } : null,
      grant: { source: "project_alpha_delivery", id: "grant-secondary", version: 1, bindingId: "binding-secondary",
        bindingVersion: "binding-v1", bindingProof: "a".repeat(64), prefix: "secondary/", ownerType, ownerPublicId,
        audienceType: "principal", audiencePublicId: "principal-secondary", audienceSourceVersion: "principal-v1", accessTermsId: null },
      scopeProof: [{ entityType: "organization", publicId: "org-secondary", parentPublicId: null, sourceVersion: "org-v1", depth: 0 },
        { entityType: ownerType, publicId: ownerPublicId, parentPublicId: "org-secondary", sourceVersion: "owner-v1", depth: 1 },
        { entityType: "folder", publicId: "binding-secondary", parentPublicId: ownerPublicId, sourceVersion: "binding-v1", depth: 2 }] };
    return value;
  };
  function beforeBatch(action: () => Promise<void>): D1Database {
    let injected = false, proxy: D1Database;
    proxy = new Proxy(db, { get(target, key) {
      if (key === "withSession") return () => proxy;
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!injected) { injected = true; await action(); }
        return target.batch(statements);
      };
      const value = target[key as keyof D1Database]; return typeof value === "function" ? value.bind(target) : value;
    } });
    return proxy;
  }
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE feedback_authority_gate(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO portal_v2_identities VALUES('identity-secondary');
      INSERT INTO portal_v2_workspaces VALUES('workspace-secondary','active');
      INSERT INTO portal_v2_workspaces VALUES('workspace-other','active');
      INSERT INTO feedback_authority_gate VALUES('exact-publication','active');`);
    const migration = readFileSync(new URL("../migrations/0184_native_client_feedback.sql", import.meta.url), "utf8")
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");
    await db.exec(migration);
  });
  afterAll(async () => runtime?.dispose());
  beforeEach(async () => {
    await db.prepare("UPDATE portal_v2_workspaces SET status='active'").run();
    await db.prepare("UPDATE feedback_authority_gate SET state='active'").run();
  });

  it("stores a source-qualified immutable target without modifying the primary schema", async () => {
    const created = await createNativeFeedbackRecord(db, authorization(), "Please review the north boundary.", operation());
    expect(created).toMatchObject({ replayed: false, record: { id: expect.stringMatching(/^native_/), context: {
      sourceId: "project-alpha:secondary", workspaceId: "workspace-secondary" }, target: {
      sourceId: "project-alpha:secondary", workspaceId: "workspace-secondary", projectPublicId: "project-secondary" } } });
    await expect(db.prepare("UPDATE portal_native_feedback SET target_json='{}' WHERE id=?").bind(created.record.id).run()).rejects.toThrow();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_feedback'").first()).toBeNull();
  });

  it("scopes idempotency by source and workspace and rechecks authority on replay", async () => {
    const key = operation(), first = await createNativeFeedbackRecord(db, authorization(), "Same text", key);
    expect(await createNativeFeedbackRecord(db, authorization(), "Same text", key)).toMatchObject({ replayed: true, record: { id: first.record.id } });
    const other = authorization("project-alpha:other", "workspace-other");
    other.target.sourceId = "project-alpha:other"; other.target.workspaceId = "workspace-other";
    const second = await createNativeFeedbackRecord(db, other, "Same text", key);
    expect(second.record.id).not.toBe(first.record.id);
    await db.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace-secondary'").run();
    await expect(createNativeFeedbackRecord(db, authorization(), "Same text", key)).rejects.toMatchObject({ code: "changed" });
  });

  it("fences lifecycle writes after revocation and keeps the event history unchanged", async () => {
    const created = await createNativeFeedbackRecord(db, authorization(), "Keep this exact target", operation());
    await db.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace-secondary'").run();
    await expect(transitionNativeFeedbackRecord(db, created.record, "staff-a",
      { expectedRevision: 1, status: "done", note: "Handled" }, operation(), authorization().guard)).rejects.toMatchObject({ code: "changed" });
    expect(await db.prepare("SELECT count(*) n FROM portal_native_feedback_events WHERE feedback_id=?").bind(created.record.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT status,revision FROM portal_native_feedback WHERE id=?").bind(created.record.id).first()).toEqual({ status: "new", revision: 1 });
  });

  it.each([
    ["organization", "folder"], ["client", "file"], ["department", "folder"],
  ] as const)("preserves %s-owned %s feedback without fabricating a project", async (ownerType, kind) => {
    const created = await createNativeFeedbackRecord(db, deliveryAuthorization(ownerType, kind), `Review this ${kind}`, operation());
    expect(created.record.target).toMatchObject({ kind, projectPublicId: null, projectName: null,
      grant: { ownerType, ownerPublicId: `${ownerType}-secondary` } });
    expect(await db.prepare(`SELECT owner_scope_type ownerType,owner_public_id ownerId,project_public_id projectId
      FROM portal_native_feedback WHERE id=?`).bind(created.record.id).first()).toEqual({
      ownerType, ownerId: `${ownerType}-secondary`, projectId: null,
    });
  });

  it("puts the exact authority predicate inside create and transition mutations", async () => {
    const exact = authorization();
    exact.guard = { sql: "EXISTS(SELECT 1 FROM feedback_authority_gate WHERE id=? AND state='active')", bindings: ["exact-publication"] };
    await expect(createNativeFeedbackRecord(beforeBatch(() => db.prepare(
      "UPDATE feedback_authority_gate SET state='revoked' WHERE id='exact-publication'").run().then(() => undefined)), exact,
      "Race the publication", operation())).rejects.toMatchObject({ code: "changed" });
    expect(await db.prepare("SELECT count(*) n FROM portal_native_feedback WHERE message='Race the publication'").first("n")).toBe(0);

    await db.prepare("UPDATE feedback_authority_gate SET state='active' WHERE id='exact-publication'").run();
    const created = await createNativeFeedbackRecord(db, exact, "Race the transition", operation());
    await expect(transitionNativeFeedbackRecord(beforeBatch(() => db.prepare(
      "UPDATE feedback_authority_gate SET state='revoked' WHERE id='exact-publication'").run().then(() => undefined)), created.record, "staff-a",
      { expectedRevision: 1, status: "done", note: "Handled" }, operation(), exact.guard)).rejects.toMatchObject({ code: "changed" });
    expect(await db.prepare("SELECT status,revision FROM portal_native_feedback WHERE id=?").bind(created.record.id).first()).toEqual({ status: "new", revision: 1 });
    expect(await db.prepare("SELECT count(*) n FROM portal_native_feedback_events WHERE feedback_id=?").bind(created.record.id).first("n")).toBe(1);
  });
});
