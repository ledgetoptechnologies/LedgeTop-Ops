import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  requirePermission: vi.fn(),
  sqlScope: vi.fn(),
  hasLocalGlobalAllow: vi.fn(),
  hasPermission: vi.fn(),
  requireMutationSecurity: vi.fn(),
  auditAddress: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  requirePermission: mocks.requirePermission,
  sqlScope: mocks.sqlScope,
  hasLocalGlobalAllow: mocks.hasLocalGlobalAllow,
  hasPermission: mocks.hasPermission,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditAddress: mocks.auditAddress,
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
    return { results: this.statement().all(...this.bindings()) as T[], meta: { changes: 0 } };
  }
  async run<T>() {
    const result = this.statement().run(...this.bindings());
    return { results: [] as T[], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

function d1(database: DatabaseSync) {
  const api = {
    prepare(sql: string) { return new D1Statement(database, sql); },
    withSession() { return api; },
    async batch(statements: D1Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements)
          results.push(/^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ? await statement.all() : await statement.run());
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
  admin: { id: "staff-admin", email: "admin@example.com", displayName: "Ops Admin", accessSubject: "access-admin", projectAlphaUserId: "pa-admin" },
  pilot: { id: "staff-pilot", email: "pilot@example.com", displayName: "Colin Pilot", accessSubject: "access-pilot", projectAlphaUserId: "pa-pilot" },
  unrelated: { id: "staff-other", email: "other@example.com", displayName: "Other Pilot", accessSubject: "access-other", projectAlphaUserId: "pa-other" },
} as const;
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function request(path: string, user: keyof typeof principals | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (user) headers.set("X-Test-User", user);
  if (init.method && !["GET", "HEAD"].includes(init.method)) {
    headers.set("Origin", "https://ops.example");
    headers.set("X-CSRF-Token", "test");
  }
  return new Request(`https://ops.example${path}`, { ...init, headers });
}

function setup() {
  const ops = new DatabaseSync(":memory:");
  ops.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,project_alpha_user_id TEXT UNIQUE);
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE roles(id TEXT PRIMARY KEY);
    CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL,PRIMARY KEY(role_id,permission_key),FOREIGN KEY(role_id) REFERENCES roles(id),FOREIGN KEY(permission_key) REFERENCES permissions(key));
    CREATE TABLE divisions(id TEXT PRIMARY KEY,project_alpha_business_unit_id TEXT UNIQUE);
    CREATE TABLE pa_operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,business_unit_id TEXT,title TEXT NOT NULL,status TEXT NOT NULL,scheduled_start_at TEXT,scheduled_end_at TEXT,location TEXT,active INTEGER NOT NULL,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER NOT NULL,PRIMARY KEY(operation_id,user_id));
    CREATE TABLE pa_service_locations(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,latitude REAL,longitude REAL,active INTEGER NOT NULL);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT,created_at TEXT DEFAULT(datetime('now')));
  `);
  ops.exec(readFileSync(new URL("../migrations/0017_operational_job_briefs.sql", import.meta.url), "utf8"));
  ops.exec(readFileSync(new URL("../migrations/0020_internal_sop_library.sql", import.meta.url), "utf8"));
  ops.exec(readFileSync(new URL("../migrations/0025_sop_assignment_permission.sql", import.meta.url), "utf8"));
  ops.exec(readFileSync(new URL("../migrations/0035_project_alpha_connectors.sql", import.meta.url), "utf8"));
  const insertStaff = ops.prepare("INSERT INTO staff_users VALUES (?,?,?,?)");
  for (const value of Object.values(principals)) insertStaff.run(value.id, value.email, value.displayName, value.projectAlphaUserId);
  ops.prepare("INSERT INTO divisions VALUES (?,?)").run("division-flight", "unit-flight");
  ops.prepare("INSERT INTO pa_operations(id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,active) VALUES (?,?,?,?,?,?,?,?,?)").run(
    "operation-1", "pa-project-1", "unit-flight", "North parcel mapping", "scheduled",
    "2026-08-10T15:00:00Z", "2026-08-10T18:00:00Z", "North parcel", 1,
  );
  ops.prepare("INSERT INTO pa_operations(id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,active) VALUES (?,?,?,?,?,?,?,?,?)").run(
    "operation-2", "pa-project-1", "unit-flight", "South parcel mapping", "scheduled",
    "2026-08-11T15:00:00Z", "2026-08-11T18:00:00Z", "South parcel", 1,
  );
  ops.prepare("INSERT INTO pa_operation_assignments VALUES (?,?,1)").run("operation-1", "pa-pilot");
  ops.prepare("INSERT INTO pa_service_locations VALUES (?,?,?,?,?,1)").run("location-1", "pa-project-1", "North field", 44.765432, -88.123456);

  const delivery = new DatabaseSync(":memory:");
  delivery.exec(`
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT,project_alpha_source_id TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,active INTEGER,project_alpha_source_id TEXT);
    CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,project_id TEXT,account_id TEXT,r2_prefix TEXT,revoked_at TEXT);
    CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT,size INTEGER,content_type TEXT);
    INSERT INTO client_accounts VALUES ('account-1','active',NULL);
    INSERT INTO projects VALUES ('portal-project-1','pa-project-1',1,'project-alpha:primary');
    INSERT INTO client_folder_associations VALUES ('association-1','project','portal-project-1','account-1','Jobs/Clients/Acme/North/',NULL);
  `);

  const objects = new Map<string, { bytes: Uint8Array; httpEtag: string; contentType: string }>();
  const projectKml = "Jobs/Clients/Acme/North/client-plan.kml";
  objects.set(projectKml, { bytes: new TextEncoder().encode("<kml>client</kml>"), httpEtag: '"client-etag"', contentType: "application/vnd.google-earth.kml+xml" });
  delivery.prepare("INSERT INTO file_index VALUES (?,?,?,?)").run(projectKml, '"client-etag"', 17, "application/vnd.google-earth.kml+xml");
  let gets = 0;
  const bucket = {
    async put(key: string, value: ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const stored = { bytes, httpEtag: `"staff-${objects.size}"`, contentType: options?.httpMetadata?.contentType || "application/octet-stream" };
      objects.set(key, stored);
      return { key, size: bytes.byteLength, httpEtag: stored.httpEtag };
    },
    async head(key: string) {
      const value = objects.get(key);
      return value ? { size: value.bytes.byteLength, httpEtag: value.httpEtag } : null;
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      gets += 1;
      const value = objects.get(key);
      if (!value) return null;
      const bytes = options?.range ? value.bytes.slice(options.range.offset, options.range.offset + options.range.length) : value.bytes;
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { body: new Blob([body]).stream() };
    },
    async delete(key: string) { objects.delete(key); },
  };
  return {
    ops,
    delivery,
    bucket,
    env: {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example",
      PUBLIC_BASE_URL: "https://ops.example",
      OPS_DB: d1(ops),
      DELIVERY_DB: d1(delivery),
      DATA_BUCKET: bucket,
    } as any,
    objectGets: () => gets,
    setObjectEtag(key: string, etag: string) {
      const value = objects.get(key);
      if (value) value.httpEtag = etag;
    },
    projectKml,
  };
}

describe("operational job brief routes", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockImplementation(async (incoming: Request) => {
      const key = incoming.headers.get("X-Test-User") as keyof typeof principals | null;
      if (!key || !principals[key]) throw new HTTPException(401, { message: "Authentication required" });
      return principals[key];
    });
    mocks.isAdministrator.mockReset().mockImplementation(async (_env: unknown, principal: { id: string }) => principal.id === principals.admin.id);
    mocks.requirePermission.mockReset().mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (permission === "operations.view") return;
      if (permission === "delivery.browse" && (principal.id === principals.admin.id || principal.id === principals.unrelated.id)) return;
      if (principal.id === principals.admin.id && permission === "operations.manage") return;
      if (principal.id === principals.admin.id && ["sops.view", "sops.assign"].includes(permission)) return;
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    mocks.sqlScope.mockReset().mockResolvedValue({ global: true, divisions: [], assigned: true, own: false, deniedDivisions: [], deniedGlobal: false });
    mocks.hasLocalGlobalAllow.mockReset().mockResolvedValue(false);
    mocks.hasPermission.mockReset().mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (permission === "operations.manage") return principal.id === principals.admin.id;
      if (permission === "sops.view") return principal.id === principals.admin.id || principal.id === principals.pilot.id;
      if (permission === "sops.assign") return principal.id === principals.admin.id;
      return false;
    });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditAddress.mockReset().mockResolvedValue("hashed-address");
  });

  it("creates multiple items, exposes them to the assigned pilot, conflicts safely, and preserves audit history", async () => {
    const state = setup();
    const create = await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        items: [
          { id: "scope-map", category: "Mapping mission", title: "Orthomosaic", instructions: "Fly 300 ft AGL with 80/75 overlap." },
          { id: "scope-photo", category: "Marketing photos", title: "Exterior set", instructions: "Capture front, side, and context views." },
        ],
      }),
    }), state.env, executionCtx);
    expect(create.status).toBe(200);
    expect((await create.json() as any).brief).toMatchObject({ version: 1, items: [{ category: "Mapping mission" }, { category: "Marketing photos" }] });

    const pilotRead = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot"), state.env, executionCtx);
    expect(pilotRead.status).toBe(200);
    const pilotPayload = await pilotRead.json() as any;
    expect(pilotPayload.canEdit).toBe(false);
    expect(pilotPayload.brief.items).toHaveLength(2);
    expect(pilotPayload.operation.navigation.googleMapsUrl).toContain("44.765432%2C-88.123456");

    const pilotMutation = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, items: [] }),
    }), state.env, executionCtx);
    expect(pilotMutation.status).toBe(403);

    expect((await worker.fetch(request("/api/operations/operation-1/job-brief", "unrelated"), state.env, executionCtx)).status).toBe(404);

    const updateBody = {
      expectedVersion: 1,
      items: [{ id: "scope-map", category: "Mapping mission", title: "Orthomosaic", instructions: "Fly 275 ft AGL with 82/78 overlap." }],
    };
    const update = await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updateBody),
    }), state.env, executionCtx);
    expect(update.status).toBe(200);
    expect((await update.json() as any).brief.version).toBe(2);

    const conflict = await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updateBody),
    }), state.env, executionCtx);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ currentVersion: 2 });

    const refreshed = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot"), state.env, executionCtx);
    const refreshedPayload = await refreshed.json() as any;
    expect(refreshedPayload.brief.items[0].instructions).toContain("275 ft");
    expect(refreshedPayload.history.map((entry: any) => entry.version)).toEqual([2, 1]);
    expect(refreshedPayload.history[0].author.displayName).toBe("Ops Admin");
    expect(state.ops.prepare("SELECT COUNT(*) count FROM audit_events").get()).toEqual({ count: 2 });
    expect(() => state.ops.prepare("UPDATE operational_job_brief_revisions SET change_kind='scope_saved'").run()).toThrow("immutable");
  });

  it.each(["absent", "null", "missing-latitude", "missing-longitude"])("returns no navigation for %s service coordinates", async variant => {
    const state = setup();
    try {
      if (variant === "absent") state.ops.exec("DELETE FROM pa_service_locations");
      else if (variant === "null") state.ops.exec("UPDATE pa_service_locations SET latitude=NULL,longitude=NULL");
      else if (variant === "missing-latitude") state.ops.exec("UPDATE pa_service_locations SET latitude=NULL");
      else state.ops.exec("UPDATE pa_service_locations SET longitude=NULL");
      const response = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot"), state.env, executionCtx);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operation: { navigation: null } });
    } finally {
      state.ops.close();
      state.delivery.close();
    }
  });

  it("retains navigation for an explicitly stored zero-coordinate service location", async () => {
    const state = setup();
    try {
      state.ops.exec("UPDATE pa_service_locations SET latitude=0,longitude=0");
      const response = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot"), state.env, executionCtx);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operation: { navigation: {
        latitude: 0, longitude: 0, googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=0.000000%2C0.000000",
      } } });
    } finally {
      state.ops.close();
      state.delivery.close();
    }
  });

  it("does not resolve a secondary operation through a primary Delivery project with the same raw ID", async () => {
    const state = setup();
    state.ops.prepare("UPDATE pa_operations SET projection_source_id='project-alpha:secondary' WHERE id='operation-1'").run();
    const response = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/reference", "admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, objectKey: state.projectKml }),
    }), state.env, executionCtx);
    expect(response.status).toBe(404);
    expect(state.ops.prepare("SELECT count(*) count FROM operational_job_brief_attachments").get()).toEqual({ count: 0 });
    expect(state.objectGets()).toBe(0);
  });

  it("keeps staff uploads and authorized project KML private behind the brief assignment", async () => {
    const state = setup();
    const seed = await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [{ id: "scope-map", category: "Mapping", title: "Flight", instructions: "Use the attached KML." }] }),
    }), state.env, executionCtx);
    expect(seed.status).toBe(200);

    const staffBytes = new TextEncoder().encode("<kml>staff</kml>");
    const pilotUpload = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/upload", "pilot", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.google-earth.kml+xml",
        "Content-Length": String(staffBytes.byteLength),
        "X-Expected-Version": "1",
        "X-File-Name": "pilot-plan.kml",
      },
      body: staffBytes,
    }), state.env, executionCtx);
    expect(pilotUpload.status).toBe(403);

    const pilotReference = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/reference", "pilot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, objectKey: state.projectKml }),
    }), state.env, executionCtx);
    expect(pilotReference.status).toBe(403);

    const upload = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/upload", "admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.google-earth.kml+xml",
        "Content-Length": String(staffBytes.byteLength),
        "X-Expected-Version": "1",
        "X-File-Name": "staff-plan.kml",
      },
      body: staffBytes,
    }), state.env, executionCtx);
    expect(upload.status).toBe(201);
    const uploadPayload = await upload.json() as any;
    expect(uploadPayload.brief.version).toBe(2);
    expect(uploadPayload.brief.attachments[0]).toMatchObject({ sourceKind: "staff_upload", displayName: "staff-plan.kml" });
    expect(uploadPayload.brief.attachments[0]).not.toHaveProperty("objectKey");
    expect(uploadPayload.brief.attachments[0].contentUrl).toMatch(/^\/api\/operations\/operation-1\/job-brief\/attachments\//);

    const reference = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/reference", "admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, objectKey: state.projectKml }),
    }), state.env, executionCtx);
    expect(reference.status).toBe(201);
    const referencePayload = await reference.json() as any;
    expect(referencePayload.brief.version).toBe(3);
    expect(referencePayload.brief.attachments[1]).toMatchObject({ sourceKind: "project_file", displayName: "client-plan.kml" });

    const duplicateReference = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/reference", "admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, objectKey: state.projectKml }),
    }), state.env, executionCtx);
    expect(duplicateReference.status).toBe(409);

    const secondSeed = await worker.fetch(request("/api/operations/operation-2/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [] }),
    }), state.env, executionCtx);
    expect(secondSeed.status).toBe(200);
    const secondReference = await worker.fetch(request("/api/operations/operation-2/job-brief/attachments/reference", "admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, objectKey: state.projectKml }),
    }), state.env, executionCtx);
    expect(secondReference.status).toBe(201);

    const deniedReference = await worker.fetch(request("/api/operations/operation-1/job-brief/attachments/reference", "admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, objectKey: "Jobs/Clients/Other/private.kml" }),
    }), state.env, executionCtx);
    expect(deniedReference.status).toBe(404);

    const contentUrl = uploadPayload.brief.attachments[0].contentUrl as string;
    const pilotContent = await worker.fetch(request(contentUrl, "pilot"), state.env, executionCtx);
    expect(pilotContent.status).toBe(200);
    expect(pilotContent.headers.get("Content-Type")).toBe("application/vnd.google-earth.kml+xml");
    expect(pilotContent.headers.get("Content-Disposition")).toContain("attachment");
    expect(pilotContent.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await pilotContent.text()).toBe("<kml>staff</kml>");

    const projectContentUrl = referencePayload.brief.attachments[1].contentUrl as string;
    const projectContent = await worker.fetch(request(projectContentUrl, "pilot"), state.env, executionCtx);
    expect(projectContent.status).toBe(200);
    expect(await projectContent.text()).toBe("<kml>client</kml>");

    const getsBeforeDenial = state.objectGets();
    expect((await worker.fetch(request(contentUrl, "unrelated"), state.env, executionCtx)).status).toBe(404);
    expect((await worker.fetch(request(contentUrl, null), state.env, executionCtx)).status).toBe(401);
    expect((await worker.fetch(request(projectContentUrl, "unrelated"), state.env, executionCtx)).status).toBe(404);
    expect((await worker.fetch(request(projectContentUrl, null), state.env, executionCtx)).status).toBe(401);
    expect(state.objectGets()).toBe(getsBeforeDenial);

    const privateKey = state.ops.prepare(
      "SELECT object_key FROM operational_job_brief_attachments WHERE operation_id='operation-1' AND source_kind='staff_upload'",
    ).get() as { object_key: string };
    expect(privateKey.object_key).toContain("/_ltds/");
    const guessedRef = Buffer.from(privateKey.object_key).toString("base64url");
    const genericBypass = await worker.fetch(
      request(`/api/delivery/items/${guessedRef}/download`, "unrelated"),
      state.env,
      executionCtx,
    );
    expect(genericBypass.status).toBe(404);
    expect(state.objectGets()).toBe(getsBeforeDenial);

    state.setObjectEtag(state.projectKml, '"changed-etag"');
    const changedProject = await worker.fetch(request(projectContentUrl, "pilot"), state.env, executionCtx);
    expect(changedProject.status).toBe(409);
  });

  it("pins published SOP revisions to an authorized job and preserves them after archival", async () => {
    const state = setup();
    const sopId = "00000000-0000-4000-8000-000000000010";
    const revisionId = "00000000-0000-4000-8000-000000000011";
    state.ops.prepare(`INSERT INTO sop_documents
      (id,slug,status,version,created_by,updated_by) VALUES (?,?,'draft',1,?,?)`)
      .run(sopId, "mapping-flight", principals.admin.id, principals.admin.id);
    state.ops.prepare(`INSERT INTO sop_revisions
      (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
        rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name,published_at)
      VALUES (?,?,1,NULL,'published','Mapping flight','Standard mapping capture','## Capture\nUse 80/75 overlap.',
        '<h2 id="sop-heading-capture">Capture</h2><p>Use 80/75 overlap.</p>',?,1,?,?,?,datetime('now'))`)
      .run(revisionId, sopId, JSON.stringify([{ id: "sop-heading-capture", level: 2, text: "Capture" }]),
        principals.admin.id, principals.admin.email, principals.admin.displayName);
    state.ops.prepare(`UPDATE sop_documents SET status='published',published_revision_id=?,
      published_at=datetime('now') WHERE id=?`).run(revisionId, sopId);

    const seed = await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [] }),
    }), state.env, executionCtx);
    expect(seed.status).toBe(200);

    const linked = await worker.fetch(request("/api/operations/operation-1/job-brief/sops", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, revisionIds: [revisionId] }),
    }), state.env, executionCtx);
    expect(linked.status).toBe(200);
    expect((await linked.json() as any).brief.sops[0]).toMatchObject({
      sopId,
      revisionId,
      revisionNumber: 1,
      title: "Mapping flight",
    });

    const snapshot = state.ops.prepare(
      "SELECT snapshot_json FROM operational_job_brief_revisions WHERE operation_id=? AND version=2",
    ).get("operation-1") as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json).sops[0].revisionId).toBe(revisionId);

    state.ops.prepare(`UPDATE sop_documents SET status='archived',version=version+1,
      archived_at=datetime('now') WHERE id=?`).run(sopId);
    const pilot = await worker.fetch(
      request("/api/operations/operation-1/job-brief", "pilot"),
      state.env,
      executionCtx,
    );
    expect(pilot.status).toBe(200);
    expect((await pilot.json() as any).brief.sops[0]).toMatchObject({
      revisionId,
      publicationState: "archived",
      html: expect.stringContaining("80/75 overlap"),
    });
    expect((await worker.fetch(
      request("/api/operations/operation-1/job-brief", "unrelated"),
      state.env,
      executionCtx,
    )).status).toBe(404);

    const preserved = await worker.fetch(request("/api/operations/operation-1/job-brief/sops", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, revisionIds: [revisionId] }),
    }), state.env, executionCtx);
    expect(preserved.status).toBe(200);
    expect((await preserved.json() as any).brief).toMatchObject({
      version: 3,
      sops: [{ revisionId, publicationState: "archived" }],
    });

    const secondSeed = await worker.fetch(request("/api/operations/operation-2/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [] }),
    }), state.env, executionCtx);
    expect(secondSeed.status).toBe(200);
    const archivedLink = await worker.fetch(request("/api/operations/operation-2/job-brief/sops", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, revisionIds: [revisionId] }),
    }), state.env, executionCtx);
    expect(archivedLink.status).toBe(409);
    expect(state.ops.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("lets an assigned operator with sops.assign update SOP pins without broader operations management", async () => {
    const state = setup();
    const sopId = "00000000-0000-4000-8000-000000000030";
    const revisionId = "00000000-0000-4000-8000-000000000031";
    state.ops.prepare(`INSERT INTO sop_documents
      (id,slug,status,version,created_by,updated_by) VALUES (?,?,'published',1,?,?)`)
      .run(sopId, "operator-flight", principals.admin.id, principals.admin.id);
    state.ops.prepare(`INSERT INTO sop_revisions
      (id,sop_id,revision_number,change_kind,title,purpose,markdown_body,rendered_html,toc_json,
        sanitizer_version,author_id,author_email,author_display_name,published_at)
      VALUES (?,?,1,'published','Operator flight','Assigned guidance','Body','<p>Body</p>','[]',1,?,?,?,datetime('now'))`)
      .run(revisionId, sopId, principals.admin.id, principals.admin.email, principals.admin.displayName);
    state.ops.prepare("UPDATE sop_documents SET published_revision_id=? WHERE id=?").run(revisionId, sopId);
    expect((await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [] }),
    }), state.env, executionCtx)).status).toBe(200);

    mocks.requirePermission.mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (permission === "operations.view") return;
      if (["sops.view", "sops.assign"].includes(permission) && principal.id === principals.pilot.id) return;
      if (["operations.manage", "sops.manage"].includes(permission))
        throw new HTTPException(403, { message: `Missing permission: ${permission}` });
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    mocks.hasPermission.mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (["sops.view", "sops.assign"].includes(permission)) return principal.id === principals.pilot.id;
      return false;
    });

    const linked = await worker.fetch(request("/api/operations/operation-1/job-brief/sops", "pilot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, revisionIds: [revisionId] }),
    }), state.env, executionCtx);
    expect(linked.status).toBe(200);
    expect((await linked.json() as any).brief.sops).toMatchObject([{ revisionId }]);

    mocks.requirePermission.mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (permission === "operations.view" || (permission === "sops.view" && principal.id === principals.pilot.id)) return;
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    const explicitlyDenied = await worker.fetch(request("/api/operations/operation-1/job-brief/sops", "pilot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, revisionIds: [] }),
    }), state.env, executionCtx);
    expect(explicitlyDenied.status).toBe(403);
    expect(state.ops.prepare("SELECT version FROM operational_job_briefs WHERE operation_id='operation-1'").get())
      .toEqual({ version: 2 });

    const broaderEdit = await worker.fetch(request("/api/operations/operation-1/job-brief", "pilot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, items: [] }),
    }), state.env, executionCtx);
    expect(broaderEdit.status).toBe(403);
    const authoring = await worker.fetch(request("/api/admin/sops", "pilot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized" }),
    }), state.env, executionCtx);
    expect(authoring.status).toBe(403);
  });

  it("omits pinned SOP content when an assigned pilot has an explicit effective deny", async () => {
    const state = setup();
    const sopId = "00000000-0000-4000-8000-000000000020";
    const revisionId = "00000000-0000-4000-8000-000000000021";
    state.ops.prepare(`INSERT INTO sop_documents
      (id,slug,status,version,created_by,updated_by) VALUES (?,?,'published',1,?,?)`)
      .run(sopId, "denied-flight", principals.admin.id, principals.admin.id);
    state.ops.prepare(`INSERT INTO sop_revisions
      (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
        rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name,published_at)
      VALUES (?,?,1,NULL,'published','Restricted flight','Pinned restricted guidance','Private text',
        '<p>DENIED SOP CONTENT</p>','[]',1,?,?,?,datetime('now'))`)
      .run(revisionId, sopId, principals.admin.id, principals.admin.email, principals.admin.displayName);
    state.ops.prepare("UPDATE sop_documents SET published_revision_id=? WHERE id=?").run(revisionId, sopId);
    expect((await worker.fetch(request("/api/operations/operation-1/job-brief", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, items: [] }),
    }), state.env, executionCtx)).status).toBe(200);
    expect((await worker.fetch(request("/api/operations/operation-1/job-brief/sops", "admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, revisionIds: [revisionId] }),
    }), state.env, executionCtx)).status).toBe(200);

    mocks.hasPermission.mockImplementation(async (_env: unknown, principal: { id: string }, permission: string) => {
      if (permission === "operations.manage") return principal.id === principals.admin.id;
      if (permission === "sops.view") return principal.id === principals.admin.id;
      return false;
    });
    const denied = await worker.fetch(
      request("/api/operations/operation-1/job-brief", "pilot"),
      state.env,
      executionCtx,
    );
    expect(denied.status).toBe(200);
    const text = await denied.text();
    expect(JSON.parse(text).canViewSops).toBe(false);
    expect(JSON.parse(text).brief.sops).toEqual([]);
    expect(text).not.toContain("DENIED SOP CONTENT");
  });
});
