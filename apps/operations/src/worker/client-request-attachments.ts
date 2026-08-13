import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqlScope } from "./acl";
import type { Env, StaffPrincipal } from "./types";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;

interface StaffRequestAttachmentRow {
  id: string;
  original_name: string;
  content_type: string;
  actual_size: number;
}

interface StaffRequestAttachmentDownloadRow extends StaffRequestAttachmentRow {
  object_key: string;
}

async function requireOperationsManage(env: Env, principal: StaffPrincipal): Promise<void> {
  const scope = await sqlScope(env, principal, "operations.manage");
  if (!scope.global || scope.deniedGlobal)
    throw new HTTPException(403, { message: "Global operations.manage permission required" });
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && value.length <= 128;
}

function encodedDisposition(name: string): string {
  const normalized = name.normalize("NFC").trim(),
    leaf = normalized.split(/[\\/]/).pop()?.trim() || "attachment";
  const ascii = leaf
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[\0-\x1f\x7f"\\]/g, "_")
    .slice(0, 180) || "attachment";
  const encoded = encodeURIComponent(leaf)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function activeRequestExists(env: Env, requestId: string): Promise<boolean> {
  const row = await env.DELIVERY_DB.withSession("first-primary")
    .prepare(
      `SELECT r.id FROM client_service_requests r
       JOIN client_accounts account ON account.id=r.account_id AND account.status='active'
       WHERE r.id=?`,
    )
    .bind(requestId)
    .first<{ id: string }>();
  return Boolean(row);
}

export function registerClientRequestAttachmentRoutes(app: App): void {
  app.get("/api/client-service-requests/:id/attachments", async c => {
    await requireOperationsManage(c.env, c.get("principal"));
    const requestId = c.req.param("id");
    if (!validOpaqueId(requestId) || !(await activeRequestExists(c.env, requestId)))
      throw new HTTPException(404, { message: "Client request not found" });

    const rows = await c.env.DELIVERY_DB.withSession("first-primary")
      .prepare(
        `SELECT id,original_name,content_type,actual_size
         FROM client_service_request_attachments
         WHERE submitted_request_id=? AND status='accepted'
         ORDER BY created_at,id`,
      )
      .bind(requestId)
      .all<StaffRequestAttachmentRow>();

    return c.json({
      attachments: rows.results.map(row => ({
        id: row.id,
        name: row.original_name,
        contentType: row.content_type,
        size: row.actual_size,
        downloadPath: `/api/client-service-requests/${encodeURIComponent(requestId)}/attachments/${encodeURIComponent(row.id)}/download`,
      })),
    });
  });

  app.get("/api/client-service-requests/:id/attachments/:attachmentId/download", async c => {
    await requireOperationsManage(c.env, c.get("principal"));
    const requestId = c.req.param("id"), attachmentId = c.req.param("attachmentId");
    if (!validOpaqueId(requestId) || !validOpaqueId(attachmentId))
      throw new HTTPException(404, { message: "Attachment not found" });

    const row = await c.env.DELIVERY_DB.withSession("first-primary")
      .prepare(
        `SELECT attachment.id,attachment.original_name,attachment.content_type,
          attachment.actual_size,attachment.object_key
         FROM client_service_request_attachments attachment
         JOIN client_service_requests request ON request.id=attachment.submitted_request_id
         JOIN client_accounts account ON account.id=request.account_id AND account.status='active'
         WHERE attachment.id=? AND attachment.submitted_request_id=? AND attachment.status='accepted'`,
      )
      .bind(attachmentId, requestId)
      .first<StaffRequestAttachmentDownloadRow>();
    if (!row)
      throw new HTTPException(404, { message: "Attachment not found" });

    const object = await c.env.DATA_BUCKET.get(row.object_key);
    if (!object || object.size !== row.actual_size)
      throw new HTTPException(404, { message: "Attachment not found" });

    return new Response(object.body, {
      headers: {
        "Content-Type": row.content_type,
        "Content-Length": String(object.size),
        "Content-Disposition": encodedDisposition(row.original_name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
