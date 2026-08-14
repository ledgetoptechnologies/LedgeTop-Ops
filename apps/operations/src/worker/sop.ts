import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { renderSopMarkdown } from "../sop-markdown";
import { requirePermission } from "./acl";
import { auditAddress } from "./request-security";
import type { Env, StaffPrincipal } from "./types";
import { readAuthorizedWorkContextSopRevision } from "./work-context-sops";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;
type AppContext = Context<AppEnv>;

const slugSchema = z.string().trim().min(3).max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must use lowercase words separated by hyphens");
const contentFields = {
  title: z.string().trim().min(3).max(160),
  purpose: z.string().trim().min(3).max(500),
  markdownBody: z.string().trim().min(1).max(100_000),
};
const createSchema = z.object({ slug: slugSchema, ...contentFields }).strict();
const draftSchema = z.object({ expectedVersion: z.number().int().positive(), ...contentFields }).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const restoreSchema = versionSchema.extend({ revisionId: z.string().uuid() }).strict();

interface DocumentRow {
  id: string;
  slug: string;
  status: "draft" | "published" | "archived";
  version: number;
  draft_revision_id: string | null;
  published_revision_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  archived_at: string | null;
  created_by: string;
  updated_by: string;
}

interface RevisionRow {
  id: string;
  sop_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  change_kind: "created" | "draft_saved" | "published" | "archived" | "restored";
  title: string;
  purpose: string;
  markdown_body: string;
  rendered_html: string;
  toc_json: string;
  sanitizer_version: number;
  author_id: string;
  author_email: string;
  author_display_name: string;
  created_at: string;
  published_at: string | null;
}

async function jsonBody<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map(issue => issue.message).join("; "),
    });
  return parsed.data;
}

function etag(version: number): string {
  return `"sop-${version}"`;
}

function requireIfMatch(c: AppContext, expectedVersion: number): void {
  const supplied = c.req.header("If-Match");
  if (!supplied)
    throw new HTTPException(428, { message: "If-Match is required" });
  if (supplied !== etag(expectedVersion))
    throw new HTTPException(400, { message: "If-Match does not match expectedVersion" });
}

function parseToc(value: string): Array<{ id: string; level: number; text: string }> {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Persisted state errors are logged by the application error handler.
  }
  throw new Error("SOP table of contents is invalid");
}

function revisionDto(row: RevisionRow) {
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    changeKind: row.change_kind,
    title: row.title,
    purpose: row.purpose,
    markdownBody: row.markdown_body,
    html: row.rendered_html,
    toc: parseToc(row.toc_json),
    sanitizerVersion: row.sanitizer_version,
    author: {
      id: row.author_id,
      email: row.author_email,
      displayName: row.author_display_name,
    },
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

async function documentRow(env: Env, id: string): Promise<DocumentRow> {
  const row = await env.OPS_DB.withSession("first-primary")
    .prepare(`SELECT id,slug,status,version,draft_revision_id,published_revision_id,
      created_at,updated_at,published_at,archived_at,created_by,updated_by
      FROM sop_documents WHERE id=?`)
    .bind(id)
    .first<DocumentRow>();
  if (!row) throw new HTTPException(404, { message: "SOP not found" });
  return row;
}

async function revisionRow(env: Env, id: string): Promise<RevisionRow> {
  const row = await env.OPS_DB.withSession("first-primary")
    .prepare(`SELECT id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,
      markdown_body,rendered_html,toc_json,sanitizer_version,author_id,author_email,
      author_display_name,created_at,published_at FROM sop_revisions WHERE id=?`)
    .bind(id)
    .first<RevisionRow>();
  if (!row) throw new HTTPException(404, { message: "SOP revision not found" });
  return row;
}

async function adminDetail(env: Env, id: string) {
  const document = await documentRow(env, id);
  const history = await env.OPS_DB.withSession("first-primary")
    .prepare(`SELECT id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,
      markdown_body,rendered_html,toc_json,sanitizer_version,author_id,author_email,
      author_display_name,created_at,published_at
      FROM sop_revisions WHERE sop_id=? ORDER BY revision_number DESC`)
    .bind(id)
    .all<RevisionRow>();
  const byId = new Map(history.results.map(row => [row.id, row]));
  return {
    sop: {
      id: document.id,
      slug: document.slug,
      status: document.status,
      version: document.version,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
      publishedAt: document.published_at,
      archivedAt: document.archived_at,
      draftRevision: document.draft_revision_id
        ? revisionDto(byId.get(document.draft_revision_id) || await revisionRow(env, document.draft_revision_id))
        : null,
      publishedRevision: document.published_revision_id
        ? revisionDto(byId.get(document.published_revision_id) || await revisionRow(env, document.published_revision_id))
        : null,
    },
    revisions: history.results.map(revisionDto),
  };
}

async function currentVersion(env: Env, id: string): Promise<number | null> {
  const row = await env.OPS_DB.withSession("first-primary")
    .prepare("SELECT version FROM sop_documents WHERE id=?")
    .bind(id)
    .first<{ version: number }>();
  return row?.version ?? null;
}

async function conflict(c: AppContext, id: string) {
  const version = await currentVersion(c.env, id);
  return c.json({
    error: "This SOP changed after you opened it. Refresh before saving.",
    currentVersion: version,
    currentEtag: version === null ? null : etag(version),
  }, 409);
}

async function auditInsert(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  action: string,
  sopId: string,
  details: unknown,
  guardSql?: string,
  guardValues: unknown[] = [],
): Promise<D1PreparedStatement> {
  const address = await auditAddress(env, request);
  return env.OPS_DB.prepare(
    `INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,
      entity_type,entity_id,division_id,details_json,client_address_hash)
     SELECT 'staff',?,?,?,?, 'sop',?,NULL,?,?
     ${guardSql ? `WHERE ${guardSql}` : ""}`,
  ).bind(
    principal.id,
    principal.email,
    principal.displayName,
    action,
    sopId,
    JSON.stringify(details),
    address,
    ...guardValues,
  );
}

async function ensureManage(c: AppContext): Promise<StaffPrincipal> {
  const principal = c.get("principal");
  await requirePermission(c.env, principal, "sops.manage");
  return principal;
}

export function registerSopRoutes(app: App): void {
  app.get("/api/sops", async c => {
    await requirePermission(c.env, c.get("principal"), "sops.view");
    const search = (c.req.query("search") || "").trim().slice(0, 160);
    const like = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const result = await c.env.OPS_DB.withSession("first-primary")
      .prepare(`SELECT d.id,d.slug,d.version,d.updated_at,d.published_at,
        r.id revision_id,r.revision_number,r.title,r.purpose
        FROM sop_documents d JOIN sop_revisions r ON r.id=d.published_revision_id
        WHERE d.status='published' AND (?='' OR r.title LIKE ? ESCAPE '\\' OR r.purpose LIKE ? ESCAPE '\\' OR d.slug LIKE ? ESCAPE '\\')
        ORDER BY r.title COLLATE NOCASE,d.id`)
      .bind(search, like, like, like)
      .all<Record<string, any>>();
    return c.json({ sops: result.results.map(row => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      purpose: row.purpose,
      status: "published",
      version: row.version,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      publishedRevisionId: row.revision_id,
      publishedRevisionNumber: row.revision_number,
      draftRevisionNumber: null,
    })) });
  });

  app.get("/api/sops/:slug/revisions/:revisionId", async c => {
    const principal = c.get("principal");
    const row = await readAuthorizedWorkContextSopRevision(
      c.env,
      principal,
      c.req.query("contextKind"),
      c.req.query("contextId"),
      c.req.param("slug"),
      c.req.param("revisionId"),
    );
    c.header("ETag", `"sop-revision-${row.revision_id}"`);
    c.header("Cache-Control", "private, no-store");
    return c.json({ sop: {
      id: row.id,
      slug: row.slug,
      status: row.status,
      version: row.version,
      title: row.title,
      purpose: row.purpose,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.revision_published_at,
      revision: revisionDto({
        id: row.revision_id,
        sop_id: row.id,
        revision_number: row.revision_number,
        parent_revision_id: row.parent_revision_id,
        change_kind: row.change_kind,
        title: row.title,
        purpose: row.purpose,
        markdown_body: row.markdown_body,
        rendered_html: row.rendered_html,
        toc_json: row.toc_json,
        sanitizer_version: row.sanitizer_version,
        author_id: row.author_id,
        author_email: row.author_email,
        author_display_name: row.author_display_name,
        created_at: row.revision_created_at,
        published_at: row.revision_published_at,
      }),
    } });
  });

  app.get("/api/sops/:slug", async c => {
    await requirePermission(c.env, c.get("principal"), "sops.view");
    const row = await c.env.OPS_DB.withSession("first-primary")
      .prepare(`SELECT d.id,d.slug,d.status,d.version,d.created_at,d.updated_at,d.published_at,
        r.id revision_id,r.sop_id,r.revision_number,r.parent_revision_id,r.change_kind,
        r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,
        r.author_id,r.author_email,r.author_display_name,r.created_at revision_created_at,
        r.published_at revision_published_at
        FROM sop_documents d JOIN sop_revisions r ON r.id=d.published_revision_id
        WHERE d.slug=? AND d.status='published'`)
      .bind(c.req.param("slug"))
      .first<any>();
    if (!row) throw new HTTPException(404, { message: "SOP not found" });
    c.header("ETag", etag(row.version));
    return c.json({ sop: {
      id: row.id,
      slug: row.slug,
      status: row.status,
      version: row.version,
      title: row.title,
      purpose: row.purpose,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      revision: revisionDto({
        id: row.revision_id,
        sop_id: row.id,
        revision_number: row.revision_number,
        parent_revision_id: row.parent_revision_id,
        change_kind: row.change_kind,
        title: row.title,
        purpose: row.purpose,
        markdown_body: row.markdown_body,
        rendered_html: row.rendered_html,
        toc_json: row.toc_json,
        sanitizer_version: row.sanitizer_version,
        author_id: row.author_id,
        author_email: row.author_email,
        author_display_name: row.author_display_name,
        created_at: row.revision_created_at,
        published_at: row.revision_published_at,
      }),
    } });
  });

  app.get("/api/admin/sops", async c => {
    await ensureManage(c);
    const search = (c.req.query("search") || "").trim().slice(0, 160);
    const like = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const result = await c.env.OPS_DB.withSession("first-primary")
      .prepare(`SELECT d.id,d.slug,d.status,d.version,d.updated_at,d.published_at,
        draft.revision_number draft_revision_number,published.revision_number published_revision_number,
        COALESCE(draft.title,published.title) title,COALESCE(draft.purpose,published.purpose) purpose
        FROM sop_documents d
        LEFT JOIN sop_revisions draft ON draft.id=d.draft_revision_id
        LEFT JOIN sop_revisions published ON published.id=d.published_revision_id
        WHERE (?='' OR COALESCE(draft.title,published.title) LIKE ? ESCAPE '\\'
          OR COALESCE(draft.purpose,published.purpose) LIKE ? ESCAPE '\\' OR d.slug LIKE ? ESCAPE '\\')
        ORDER BY d.updated_at DESC,d.id`)
      .bind(search, like, like, like)
      .all<any>();
    return c.json({ sops: result.results.map(row => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      purpose: row.purpose,
      status: row.status,
      version: row.version,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      draftRevisionNumber: row.draft_revision_number,
      publishedRevisionNumber: row.published_revision_number,
    })) });
  });

  app.get("/api/admin/sops/:id", async c => {
    await ensureManage(c);
    const value = await adminDetail(c.env, c.req.param("id"));
    c.header("ETag", etag(value.sop.version));
    return c.json(value);
  });

  app.post("/api/admin/sops", async c => {
    const principal = await ensureManage(c);
    const input = await jsonBody(c, createSchema);
    const duplicate = await c.env.OPS_DB.withSession("first-primary")
      .prepare("SELECT 1 found FROM sop_documents WHERE slug=?")
      .bind(input.slug)
      .first();
    if (duplicate) return c.json({ error: "That SOP slug is already in use" }, 409);
    const id = crypto.randomUUID(), revisionId = crypto.randomUUID();
    const rendered = renderSopMarkdown(input.markdownBody);
    try {
      await c.env.OPS_DB.batch([
        c.env.OPS_DB.prepare(`INSERT INTO sop_documents
          (id,slug,status,version,created_by,updated_by) VALUES (?,?,'draft',1,?,?)`)
          .bind(id, input.slug, principal.id, principal.id),
        c.env.OPS_DB.prepare(`INSERT INTO sop_revisions
          (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
            rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name)
          VALUES (?,?,1,NULL,'created',?,?,?,?,?,?,?,?,?)`)
          .bind(revisionId, id, input.title, input.purpose, input.markdownBody, rendered.html,
            JSON.stringify(rendered.toc), rendered.sanitizerVersion, principal.id, principal.email, principal.displayName),
        c.env.OPS_DB.prepare("UPDATE sop_documents SET draft_revision_id=? WHERE id=?")
          .bind(revisionId, id),
        await auditInsert(c.env, c.req.raw, principal, "sop.created", id, { slug: input.slug, revisionNumber: 1 }),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: sop_documents\.slug/i.test(error.message))
        return c.json({ error: "That SOP slug is already in use" }, 409);
      throw error;
    }
    const value = await adminDetail(c.env, id);
    c.header("ETag", etag(value.sop.version));
    return c.json(value, 201);
  });

  app.put("/api/admin/sops/:id/draft", async c => {
    const principal = await ensureManage(c);
    const input = await jsonBody(c, draftSchema);
    requireIfMatch(c, input.expectedVersion);
    const id = c.req.param("id"), document = await documentRow(c.env, id);
    if (document.status === "archived")
      return c.json({ error: "Restore an archived revision before editing" }, 409);
    const rendered = renderSopMarkdown(input.markdownBody), revisionId = crypto.randomUUID();
    const parentId = document.draft_revision_id || document.published_revision_id;
    const statements = [
      c.env.OPS_DB.prepare(`INSERT INTO sop_revisions
        (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
          rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name)
        SELECT ?,d.id,(SELECT COALESCE(MAX(r.revision_number),0)+1 FROM sop_revisions r WHERE r.sop_id=d.id),
          ?,'draft_saved',?,?,?,?,?,?,?,?,?
        FROM sop_documents d WHERE d.id=? AND d.version=?`)
        .bind(revisionId, parentId, input.title, input.purpose, input.markdownBody, rendered.html,
          JSON.stringify(rendered.toc), rendered.sanitizerVersion, principal.id, principal.email,
          principal.displayName, id, input.expectedVersion),
      c.env.OPS_DB.prepare(`UPDATE sop_documents SET draft_revision_id=?,version=version+1,
        updated_by=?,updated_at=datetime('now') WHERE id=? AND version=? AND EXISTS
        (SELECT 1 FROM sop_revisions WHERE id=? AND sop_id=?)`)
        .bind(revisionId, principal.id, id, input.expectedVersion, revisionId, id),
      await auditInsert(c.env, c.req.raw, principal, "sop.draft_saved", id,
        { expectedVersion: input.expectedVersion },
        "EXISTS (SELECT 1 FROM sop_documents WHERE id=? AND version=? AND draft_revision_id=?)",
        [id, input.expectedVersion + 1, revisionId]),
    ];
    const result = await c.env.OPS_DB.batch(statements);
    if (!result[1]?.meta.changes) return conflict(c, id);
    const value = await adminDetail(c.env, id);
    c.header("ETag", etag(value.sop.version));
    return c.json(value);
  });

  app.post("/api/admin/sops/:id/publish", async c => {
    const principal = await ensureManage(c);
    const input = await jsonBody(c, versionSchema);
    requireIfMatch(c, input.expectedVersion);
    const id = c.req.param("id"), document = await documentRow(c.env, id);
    if (!document.draft_revision_id)
      return c.json({ error: "There is no draft revision to publish" }, 409);
    const revisionId = crypto.randomUUID();
    const result = await c.env.OPS_DB.batch([
      c.env.OPS_DB.prepare(`INSERT INTO sop_revisions
        (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
          rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name,published_at)
        SELECT ?,r.sop_id,(SELECT COALESCE(MAX(x.revision_number),0)+1 FROM sop_revisions x WHERE x.sop_id=r.sop_id),
          r.id,'published',r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,?,?,?,datetime('now')
        FROM sop_revisions r JOIN sop_documents d ON d.draft_revision_id=r.id
        WHERE d.id=? AND d.version=?`)
        .bind(revisionId, principal.id, principal.email, principal.displayName, id, input.expectedVersion),
      c.env.OPS_DB.prepare(`UPDATE sop_documents SET status='published',published_revision_id=?,draft_revision_id=NULL,
        version=version+1,updated_by=?,updated_at=datetime('now'),published_at=datetime('now'),archived_at=NULL
        WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM sop_revisions WHERE id=? AND sop_id=?)`)
        .bind(revisionId, principal.id, id, input.expectedVersion, revisionId, id),
      await auditInsert(c.env, c.req.raw, principal, "sop.published", id,
        { expectedVersion: input.expectedVersion, revisionId },
        "EXISTS (SELECT 1 FROM sop_documents WHERE id=? AND version=? AND published_revision_id=?)",
        [id, input.expectedVersion + 1, revisionId]),
    ]);
    if (!result[1]?.meta.changes) return conflict(c, id);
    const value = await adminDetail(c.env, id);
    c.header("ETag", etag(value.sop.version));
    return c.json(value);
  });

  app.post("/api/admin/sops/:id/archive", async c => {
    const principal = await ensureManage(c);
    const input = await jsonBody(c, versionSchema);
    requireIfMatch(c, input.expectedVersion);
    const id = c.req.param("id"), document = await documentRow(c.env, id);
    if (document.status === "archived") return c.json({ error: "SOP is already archived" }, 409);
    const sourceId = document.draft_revision_id || document.published_revision_id;
    if (!sourceId) throw new Error("SOP document has no current revision");
    const revisionId = crypto.randomUUID();
    const result = await c.env.OPS_DB.batch([
      c.env.OPS_DB.prepare(`INSERT INTO sop_revisions
        (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
          rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name)
        SELECT ?,r.sop_id,(SELECT COALESCE(MAX(x.revision_number),0)+1 FROM sop_revisions x WHERE x.sop_id=r.sop_id),
          r.id,'archived',r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,?,?,?
        FROM sop_revisions r JOIN sop_documents d ON d.id=r.sop_id
        WHERE r.id=? AND d.id=? AND d.version=?`)
        .bind(revisionId, principal.id, principal.email, principal.displayName, sourceId, id, input.expectedVersion),
      c.env.OPS_DB.prepare(`UPDATE sop_documents SET status='archived',draft_revision_id=NULL,version=version+1,
        updated_by=?,updated_at=datetime('now'),archived_at=datetime('now')
        WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM sop_revisions WHERE id=? AND sop_id=?)`)
        .bind(principal.id, id, input.expectedVersion, revisionId, id),
      await auditInsert(c.env, c.req.raw, principal, "sop.archived", id,
        { expectedVersion: input.expectedVersion },
        "EXISTS (SELECT 1 FROM sop_documents WHERE id=? AND version=? AND status='archived') AND EXISTS (SELECT 1 FROM sop_revisions WHERE id=? AND sop_id=?)",
        [id, input.expectedVersion + 1, revisionId, id]),
    ]);
    if (!result[1]?.meta.changes) return conflict(c, id);
    const value = await adminDetail(c.env, id);
    c.header("ETag", etag(value.sop.version));
    return c.json(value);
  });

  app.post("/api/admin/sops/:id/restore", async c => {
    const principal = await ensureManage(c);
    const input = await jsonBody(c, restoreSchema);
    requireIfMatch(c, input.expectedVersion);
    const id = c.req.param("id"), document = await documentRow(c.env, id);
    const source = await revisionRow(c.env, input.revisionId);
    if (source.sop_id !== id) throw new HTTPException(404, { message: "SOP revision not found" });
    const revisionId = crypto.randomUUID();
    const nextStatus = document.status === "published" ? "published" : "draft";
    const result = await c.env.OPS_DB.batch([
      c.env.OPS_DB.prepare(`INSERT INTO sop_revisions
        (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,
          rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name)
        SELECT ?,r.sop_id,(SELECT COALESCE(MAX(x.revision_number),0)+1 FROM sop_revisions x WHERE x.sop_id=r.sop_id),
          r.id,'restored',r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,?,?,?
        FROM sop_revisions r JOIN sop_documents d ON d.id=r.sop_id
        WHERE r.id=? AND d.id=? AND d.version=?`)
        .bind(revisionId, principal.id, principal.email, principal.displayName,
          input.revisionId, id, input.expectedVersion),
      c.env.OPS_DB.prepare(`UPDATE sop_documents SET status=?,draft_revision_id=?,version=version+1,
        updated_by=?,updated_at=datetime('now'),archived_at=NULL
        WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM sop_revisions WHERE id=? AND sop_id=?)`)
        .bind(nextStatus, revisionId, principal.id, id, input.expectedVersion, revisionId, id),
      await auditInsert(c.env, c.req.raw, principal, "sop.restored", id,
        { expectedVersion: input.expectedVersion, sourceRevisionId: input.revisionId },
        "EXISTS (SELECT 1 FROM sop_documents WHERE id=? AND version=? AND draft_revision_id=?)",
        [id, input.expectedVersion + 1, revisionId]),
    ]);
    if (!result[1]?.meta.changes) return conflict(c, id);
    const value = await adminDetail(c.env, id);
    c.header("ETag", etag(value.sop.version));
    return c.json(value);
  });
}
