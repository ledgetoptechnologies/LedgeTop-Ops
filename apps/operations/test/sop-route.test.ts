import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  requirePermission: vi.fn(),
  requireMutationSecurity: vi.fn(),
  auditAddress: vi.fn(),
  readAuthorizedWorkContextSopRevision: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  requirePermission: mocks.requirePermission,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditAddress: mocks.auditAddress,
}));
vi.mock("../src/worker/work-context-sops", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/work-context-sops")>(),
  readAuthorizedWorkContextSopRevision: mocks.readAuthorizedWorkContextSopRevision,
}));

import worker from "../src/worker/index";

type SqlValue = string | number | bigint | null | Uint8Array;

class D1Statement {
  values: unknown[] = [];

  constructor(readonly database: DatabaseSync, readonly sql: string) {}

  bind(...values: unknown[]) {
    const next = new D1Statement(this.database, this.sql);
    next.values = values;
    return next;
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }

  private bindings(): SqlValue[] {
    return this.values.map(value => value === undefined ? null : value as SqlValue);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings()) as T | undefined) || null;
  }

  async all<T>() {
    return {
      results: this.statement().all(...this.bindings()) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T>() {
    const result = this.statement().run(...this.bindings());
    return {
      results: [] as T[],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

function d1(database: DatabaseSync) {
  const api = {
    prepare(sql: string) {
      return new D1Statement(database, sql);
    },
    withSession() {
      return api;
    },
    async batch(statements: D1Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(/^\s*(SELECT|PRAGMA)\b/i.test(statement.sql)
            ? await statement.all()
            : await statement.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return api;
}

const principals = {
  admin: {
    id: "staff-admin",
    email: "admin@example.com",
    displayName: "Ops Admin",
    accessSubject: "access-admin",
    projectAlphaUserId: "pa-admin",
  },
  staff: {
    id: "staff-pilot",
    email: "pilot@example.com",
    displayName: "Casey Pilot",
    accessSubject: "access-pilot",
    projectAlphaUserId: "pa-pilot",
  },
} as const;

const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function request(
  path: string,
  user: "admin" | "staff" | "client" | null,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (user) headers.set("X-Test-User", user);
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
    headers.set("Origin", "https://ops.example");
    headers.set("X-CSRF-Token", "test-csrf");
  }
  return new Request(`https://ops.example${path}`, { ...init, headers });
}

function jsonRequest(
  path: string,
  user: "admin" | "staff" | "client" | null,
  method: "POST" | "PUT",
  body: unknown,
  etag?: string,
) {
  return request(path, user, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(etag ? { "If-Match": etag } : {}),
    },
    body: JSON.stringify(body),
  });
}

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE staff_users(
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE roles(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE role_permissions(
      role_id TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      PRIMARY KEY(role_id,permission_key),
      FOREIGN KEY(role_id) REFERENCES roles(id),
      FOREIGN KEY(permission_key) REFERENCES permissions(key)
    );
    CREATE TABLE operational_job_briefs(operation_id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT,
      actor_id TEXT,
      actor_email TEXT,
      actor_display_name TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      division_id TEXT,
      details_json TEXT,
      client_address_hash TEXT,
      created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
  `);
  database.exec(readFileSync(
    new URL("../migrations/0020_internal_sop_library.sql", import.meta.url),
    "utf8",
  ));
  database.exec(`
    CREATE TABLE work_context_sop_links(
      context_kind TEXT NOT NULL,
      context_id TEXT NOT NULL,
      sop_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      PRIMARY KEY(context_kind,context_id,sop_id)
    );
  `);
  const insertStaff = database.prepare(
    "INSERT INTO staff_users(id,email,display_name) VALUES (?,?,?)",
  );
  for (const principal of Object.values(principals)) {
    insertStaff.run(principal.id, principal.email, principal.displayName);
  }
  return {
    database,
    env: {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example",
      PUBLIC_BASE_URL: "https://ops.example",
      OPS_DB: d1(database),
    } as any,
  };
}

const content = {
  title: "General flight operations",
  purpose: "Keep routine field flights consistent and safe.",
  markdownBody: "# Before launch\n\n- Confirm the site briefing\n- Check weather and airspace",
};

async function createSop(state: ReturnType<typeof setup>, slug = "general-flight") {
  const response = await worker.fetch(jsonRequest(
    "/api/admin/sops",
    "admin",
    "POST",
    { slug, ...content },
  ), state.env, executionCtx);
  expect(response.status).toBe(201);
  return await response.json() as any;
}

describe("internal SOP routes", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockImplementation(async (incoming: Request) => {
      const key = incoming.headers.get("X-Test-User");
      if (key === "client") {
        throw new HTTPException(403, {
          message: "Client identities cannot access LTDS Operations",
        });
      }
      if (key !== "admin" && key !== "staff") {
        throw new HTTPException(401, { message: "Authentication required" });
      }
      return principals[key];
    });
    mocks.isAdministrator.mockReset().mockImplementation(
      async (_env: unknown, principal: { id: string }) => principal.id === principals.admin.id,
    );
    mocks.requirePermission.mockReset().mockImplementation(
      async (_env: unknown, principal: { id: string }, permission: string) => {
        if (permission === "sops.view") return;
        if (permission === "sops.manage" && principal.id === principals.admin.id) return;
        throw new HTTPException(403, { message: `Missing permission: ${permission}` });
      },
    );
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditAddress.mockReset().mockResolvedValue("hashed-address");
    mocks.readAuthorizedWorkContextSopRevision.mockReset().mockImplementation(async (
      env: any,
      _principal: unknown,
      kind: string,
      contextId: string,
      slug: string,
      revisionId: string,
    ) => {
      const row = await env.OPS_DB.prepare(`SELECT d.id,d.slug,d.status,d.version,d.created_at,d.updated_at,
        r.id revision_id,r.sop_id,r.revision_number,r.parent_revision_id,r.change_kind,
        r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,
        r.author_id,r.author_email,r.author_display_name,r.created_at revision_created_at,
        r.published_at revision_published_at
        FROM sop_documents d JOIN sop_revisions r ON r.sop_id=d.id
        JOIN work_context_sop_links l ON l.sop_id=d.id AND l.revision_id=r.id
        WHERE d.slug=? AND r.id=? AND r.published_at IS NOT NULL
          AND l.context_kind=? AND l.context_id=?`)
        .bind(slug, revisionId, kind, contextId).first();
      if (!row) throw new HTTPException(404, { message: "Pinned SOP revision not found" });
      return row;
    });
  });

  it("creates, revises, publishes, archives, and restores through immutable history", async () => {
    const state = setup();
    const created = await createSop(state);
    const id = created.sop.id as string;
    const originalRevisionId = created.sop.draftRevision.id as string;
    expect(created.sop).toMatchObject({
      slug: "general-flight",
      status: "draft",
      version: 1,
      draftRevision: { revisionNumber: 1, changeKind: "created" },
      publishedRevision: null,
    });

    const draftResponse = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/draft`,
      "admin",
      "PUT",
      {
        expectedVersion: 1,
        ...content,
        markdownBody: `${content.markdownBody}\n- Confirm launch coordinates`,
      },
      '"sop-1"',
    ), state.env, executionCtx);
    expect(draftResponse.status).toBe(200);
    const draft = await draftResponse.json() as any;
    expect(draft.sop).toMatchObject({
      status: "draft",
      version: 2,
      draftRevision: {
        revisionNumber: 2,
        changeKind: "draft_saved",
        parentRevisionId: originalRevisionId,
      },
    });

    const publishResponse = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/publish`,
      "admin",
      "POST",
      { expectedVersion: 2 },
      '"sop-2"',
    ), state.env, executionCtx);
    expect(publishResponse.status).toBe(200);
    const published = await publishResponse.json() as any;
    expect(published.sop).toMatchObject({
      status: "published",
      version: 3,
      draftRevision: null,
      publishedRevision: { revisionNumber: 3, changeKind: "published" },
    });

    const archiveResponse = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/archive`,
      "admin",
      "POST",
      { expectedVersion: 3 },
      '"sop-3"',
    ), state.env, executionCtx);
    expect(archiveResponse.status).toBe(200);
    const archived = await archiveResponse.json() as any;
    expect(archived.sop).toMatchObject({ status: "archived", version: 4 });

    const restoreResponse = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/restore`,
      "admin",
      "POST",
      { expectedVersion: 4, revisionId: originalRevisionId },
      '"sop-4"',
    ), state.env, executionCtx);
    expect(restoreResponse.status).toBe(200);
    const restored = await restoreResponse.json() as any;
    expect(restored.sop).toMatchObject({
      status: "draft",
      version: 5,
      draftRevision: {
        revisionNumber: 5,
        changeKind: "restored",
        parentRevisionId: originalRevisionId,
      },
    });
    expect(restored.revisions.map((revision: any) => revision.changeKind)).toEqual([
      "restored",
      "archived",
      "published",
      "draft_saved",
      "created",
    ]);

    const detailResponse = await worker.fetch(
      request(`/api/admin/sops/${id}`, "admin"),
      state.env,
      executionCtx,
    );
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get("ETag")).toBe('"sop-5"');
    expect((await detailResponse.json() as any).revisions).toHaveLength(5);

    expect(state.database.prepare(
      "SELECT action FROM audit_events ORDER BY id",
    ).all().map(row => row.action)).toEqual([
      "sop.created",
      "sop.draft_saved",
      "sop.published",
      "sop.archived",
      "sop.restored",
    ]);
    expect(() => state.database.prepare(
      "UPDATE sop_revisions SET title='tampered' WHERE id=?",
    ).run(originalRevisionId)).toThrow("immutable");
    expect(() => state.database.prepare(
      "DELETE FROM sop_revisions WHERE id=?",
    ).run(originalRevisionId)).toThrow("immutable");
  });

  it("requires If-Match and rejects a stale version without revision or audit side effects", async () => {
    const state = setup();
    const created = await createSop(state, "mapping-flight");
    const id = created.sop.id as string;

    const missing = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/draft`,
      "admin",
      "PUT",
      { expectedVersion: 1, ...content },
    ), state.env, executionCtx);
    expect(missing.status).toBe(428);

    const saved = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/draft`,
      "admin",
      "PUT",
      { expectedVersion: 1, ...content, title: "Mapping flight operations" },
      '"sop-1"',
    ), state.env, executionCtx);
    expect(saved.status).toBe(200);

    const stale = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/draft`,
      "admin",
      "PUT",
      { expectedVersion: 1, ...content, title: "Stale overwrite attempt" },
      '"sop-1"',
    ), state.env, executionCtx);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      currentVersion: 2,
      currentEtag: '"sop-2"',
    });
    expect(state.database.prepare(
      "SELECT COUNT(*) count FROM sop_revisions WHERE sop_id=?",
    ).get(id)).toEqual({ count: 2 });
    expect(state.database.prepare(
      "SELECT COUNT(*) count FROM audit_events WHERE entity_id=?",
    ).get(id)).toEqual({ count: 2 });
  });

  it("validates fields and rejects a duplicate stable slug", async () => {
    const state = setup();
    const invalid = await worker.fetch(jsonRequest(
      "/api/admin/sops",
      "admin",
      "POST",
      {
        slug: "Invalid Slug",
        title: "x",
        purpose: "x",
        markdownBody: "",
      },
    ), state.env, executionCtx);
    expect(invalid.status).toBe(400);
    expect(state.database.prepare("SELECT COUNT(*) count FROM sop_documents").get()).toEqual({ count: 0 });

    await createSop(state, "imagery-capture");
    const duplicate = await worker.fetch(jsonRequest(
      "/api/admin/sops",
      "admin",
      "POST",
      { slug: "imagery-capture", ...content, title: "Duplicate imagery SOP" },
    ), state.env, executionCtx);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "That SOP slug is already in use" });
    expect(state.database.prepare("SELECT COUNT(*) count FROM sop_documents").get()).toEqual({ count: 1 });
    expect(state.database.prepare("SELECT COUNT(*) count FROM sop_revisions").get()).toEqual({ count: 1 });
    expect(state.database.prepare("SELECT COUNT(*) count FROM audit_events").get()).toEqual({ count: 1 });
  });

  it("shows only published SOPs to staff and denies admin or client access", async () => {
    const state = setup();
    const created = await createSop(state, "pilot-field-guide");
    const id = created.sop.id as string;

    const draftRead = await worker.fetch(
      request("/api/sops/pilot-field-guide", "staff"),
      state.env,
      executionCtx,
    );
    expect(draftRead.status).toBe(404);

    const publish = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/publish`,
      "admin",
      "POST",
      { expectedVersion: 1 },
      '"sop-1"',
    ), state.env, executionCtx);
    expect(publish.status).toBe(200);

    const list = await worker.fetch(request("/api/sops", "staff"), state.env, executionCtx);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      sops: [{
        slug: "pilot-field-guide",
        status: "published",
        publishedRevisionNumber: 2,
      }],
    });

    const detail = await worker.fetch(
      request("/api/sops/pilot-field-guide", "staff"),
      state.env,
      executionCtx,
    );
    expect(detail.status).toBe(200);
    expect(detail.headers.get("ETag")).toBe('"sop-2"');
    const detailBody = await detail.json() as any;
    expect(detailBody.sop).toMatchObject({
      slug: "pilot-field-guide",
      status: "published",
      revision: { revisionNumber: 2, changeKind: "published" },
    });
    expect(detailBody.sop.revision.html).toContain("<h1");

    const pinnedRevisionId = (await publish.clone().json() as any).sop.publishedRevision.id as string;
    state.database.prepare(`INSERT INTO work_context_sop_links(
      context_kind,context_id,sop_id,revision_id
    ) VALUES ('project','project-1',?,?)`).run(id, pinnedRevisionId);
    const pinned = await worker.fetch(
      request(`/api/sops/pilot-field-guide/revisions/${pinnedRevisionId}?contextKind=project&contextId=project-1`, "staff"),
      state.env,
      executionCtx,
    );
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("ETag")).toBe(`"sop-revision-${pinnedRevisionId}"`);
    expect(pinned.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await pinned.json()).toMatchObject({
      sop: {
        slug: "pilot-field-guide",
        status: "published",
        revision: { id: pinnedRevisionId, revisionNumber: 2 },
      },
    });

    const archive = await worker.fetch(jsonRequest(
      `/api/admin/sops/${id}/archive`,
      "admin",
      "POST",
      { expectedVersion: 2 },
      '"sop-2"',
    ), state.env, executionCtx);
    expect(archive.status).toBe(200);
    const retained = await worker.fetch(
      request(`/api/sops/pilot-field-guide/revisions/${pinnedRevisionId}?contextKind=project&contextId=project-1`, "staff"),
      state.env,
      executionCtx,
    );
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      sop: { status: "archived", revision: { id: pinnedRevisionId } },
    });
    state.database.prepare(`DELETE FROM work_context_sop_links
      WHERE context_kind='project' AND context_id='project-1' AND revision_id=?`)
      .run(pinnedRevisionId);
    expect((await worker.fetch(
      request(`/api/sops/pilot-field-guide/revisions/${pinnedRevisionId}?contextKind=project&contextId=project-1`, "staff"),
      state.env,
      executionCtx,
    )).status).toBe(404);
    expect((await worker.fetch(
      request(`/api/sops/pilot-field-guide/revisions/${crypto.randomUUID()}?contextKind=project&contextId=project-1`, "staff"),
      state.env,
      executionCtx,
    )).status).toBe(404);

    expect((await worker.fetch(
      request("/api/admin/sops", "staff"),
      state.env,
      executionCtx,
    )).status).toBe(403);
    expect((await worker.fetch(
      request("/api/sops", "client"),
      state.env,
      executionCtx,
    )).status).toBe(403);
    expect((await worker.fetch(
      request("/api/sops", null),
      state.env,
      executionCtx,
    )).status).toBe(401);

    expect(mocks.requireMutationSecurity).toHaveBeenCalled();
  });
});
