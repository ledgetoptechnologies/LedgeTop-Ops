import type { Permission } from "@ltds/shared";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  evaluatePermission,
  hasLocalGlobalAllow,
  loadGrants,
  requirePermission,
  sqlScope,
} from "./acl";
import { auditAddress } from "./request-security";
import { d1TablesPresent } from "./schema-readiness";
import type { Env, ResourceContext, StaffPrincipal } from "./types";
import { paProjectFilter, paResourceFilter } from "./visibility";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;
type AppContext = Context<AppEnv>;

export type WorkContextKind = "project" | "task";

export interface WorkContextSopSummary {
  sopId: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  title: string;
  purpose: string;
  publishedAt: string;
  linkedAt: string;
  archived: boolean;
  publicationState: "current" | "superseded" | "archived" | "unpublished";
  href: string;
}

export interface AuthorizedWorkContextSopRevisionRow {
  id: string;
  slug: string;
  status: "draft" | "published" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  revision_id: string;
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
  revision_created_at: string;
  revision_published_at: string;
}

interface WorkContextRow {
  id: string;
  title: string;
  status: string | null;
  division_id: string | null;
  owner_id: string | null;
  assigned_staff_ids: string | null;
  manage_staff_ids: string | null;
}

interface LinkRow {
  context_id: string;
  version: number;
  updated_at: string;
  sop_id: string | null;
  revision_id: string | null;
  linked_at: string | null;
  document_status: "draft" | "published" | "archived" | null;
  published_revision_id: string | null;
  revision_number: number | null;
  slug: string | null;
  title: string | null;
  purpose: string | null;
  published_at: string | null;
}

const kindSchema = z.enum(["project", "task"]);
const WORK_CONTEXT_SOP_TABLES = [
  "work_context_sop_link_sets",
  "work_context_sop_links",
  "work_context_sop_mutation_guards",
] as const;
const replacementSchema = z.object({
  expectedVersion: z.number().int().min(0),
  revisionIds: z.array(z.string().uuid()).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.revisionIds).size !== value.revisionIds.length)
    context.addIssue({ code: "custom", message: "SOP revision IDs must be unique" });
});

export async function workContextSopsAvailable(env: Env): Promise<boolean> {
  return d1TablesPresent(env.OPS_DB, WORK_CONTEXT_SOP_TABLES);
}

function viewPermission(kind: WorkContextKind): Permission {
  return kind === "project" ? "projects.view" : "tasks.view";
}

function contextResource(row: WorkContextRow): ResourceContext {
  return {
    divisionId: row.division_id,
    ownerId: row.owner_id,
    assignedStaffIds: row.assigned_staff_ids?.split(",").filter(Boolean) || [],
  };
}

function contextManageResource(row: WorkContextRow): ResourceContext {
  return {
    divisionId: row.division_id,
    ownerId: row.owner_id,
    assignedStaffIds: row.manage_staff_ids?.split(",").filter(Boolean) || [],
  };
}

function scopedPermissionSql(permission: Permission, assignedColumn: "assigned" | "manage_assigned"): string {
  return `NOT EXISTS (
      SELECT 1 FROM current_grants denied
      WHERE denied.permission='${permission}' AND denied.source='override' AND denied.effect='deny'
        AND (denied.scope='global'
          OR (denied.scope='division' AND denied.division_id=context.division_id)
          OR (denied.scope='assigned' AND context.${assignedColumn}=1)
          OR (denied.scope='own' AND context.owned=1))
    ) AND EXISTS (
      SELECT 1 FROM current_grants allowed
      WHERE allowed.permission='${permission}' AND allowed.effect='allow'
        AND (allowed.scope='global'
          OR (allowed.scope='division' AND allowed.division_id=context.division_id)
          OR (allowed.scope='assigned' AND context.${assignedColumn}=1)
          OR (allowed.scope='own' AND context.owned=1))
    )`;
}

function unscopedPermissionSql(permission: Permission): string {
  return `NOT EXISTS (
      SELECT 1 FROM current_grants denied
      WHERE denied.permission='${permission}' AND denied.source='override' AND denied.effect='deny'
    ) AND EXISTS (
      SELECT 1 FROM current_grants allowed
      WHERE allowed.permission='${permission}' AND allowed.effect='allow'
    )`;
}

/**
 * Builds a live authorization snapshot. Unlike the list decorators, this SQL
 * intentionally reads grants, Project Alpha assignment and the target in the
 * same D1 statement/batch that releases protected data or commits a mutation.
 */
function authoritativeContextSql(kind: WorkContextKind): { ctes: string; allowed: string } {
  const target = kind === "project"
    ? `SELECT p.id,d.id division_id,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL
          AND p.manager_user_id=actor.project_alpha_user_id THEN 1 ELSE 0 END owned,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL AND (
          p.manager_user_id=actor.project_alpha_user_id
          OR EXISTS (SELECT 1 FROM pa_project_assignments a
            WHERE a.project_id=p.id AND a.user_id=actor.project_alpha_user_id AND a.active=1)
          OR EXISTS (SELECT 1 FROM pa_operations o JOIN pa_operation_assignments a
            ON a.operation_id=o.id AND a.user_id=actor.project_alpha_user_id AND a.active=1
            WHERE o.project_id=p.id AND o.active=1)
          OR EXISTS (SELECT 1 FROM pa_tasks t JOIN pa_task_assignments a
            ON a.task_id=t.id AND a.user_id=actor.project_alpha_user_id AND a.active=1
            WHERE t.project_id=p.id AND t.active=1)
        ) THEN 1 ELSE 0 END assigned,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL AND (
          p.manager_user_id=actor.project_alpha_user_id
          OR EXISTS (SELECT 1 FROM pa_project_assignments a
            WHERE a.project_id=p.id AND a.user_id=actor.project_alpha_user_id AND a.active=1)
        ) THEN 1 ELSE 0 END manage_assigned
       FROM pa_projects p CROSS JOIN actor
       LEFT JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id
       WHERE p.id=? AND p.active=1`
    : `SELECT t.id,d.id division_id,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL
          AND t.created_by_user_id=actor.project_alpha_user_id THEN 1 ELSE 0 END owned,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM pa_task_assignments a
          WHERE a.task_id=t.id AND a.user_id=actor.project_alpha_user_id AND a.active=1
        ) THEN 1 ELSE 0 END assigned,
        CASE WHEN actor.project_alpha_user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM pa_task_assignments a
          WHERE a.task_id=t.id AND a.user_id=actor.project_alpha_user_id AND a.active=1
        ) THEN 1 ELSE 0 END manage_assigned
       FROM pa_tasks t CROSS JOIN actor
       LEFT JOIN divisions d ON d.project_alpha_business_unit_id=t.business_unit_id
       WHERE t.id=? AND t.active=1`;
  const view = viewPermission(kind);
  return {
    ctes: `WITH actor AS (
      SELECT id,project_alpha_user_id FROM staff_users WHERE id=?
    ), current_grants AS (
      SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id,'role' source
      FROM staff_role_assignments a JOIN actor ON actor.id=a.staff_id
      JOIN role_permissions rp ON rp.role_id=a.role_id
      UNION ALL
      SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id,'role' source
      FROM local_staff_role_assignments a JOIN actor ON actor.id=a.staff_id
      JOIN role_permissions rp ON rp.role_id=a.role_id
      UNION ALL
      SELECT a.permission_key permission,a.effect,a.scope,a.division_id,'override' source
      FROM staff_permission_overrides a JOIN actor ON actor.id=a.staff_id
    ), context AS (${target})`,
    allowed: `(${unscopedPermissionSql(view)})
      AND (
        EXISTS (SELECT 1 FROM staff_role_assignments admin
          JOIN actor ON actor.id=admin.staff_id
          WHERE admin.role_id IN ('role-owner','role-admin') AND admin.scope='global')
        OR (
          EXISTS (SELECT 1 FROM staff_permission_overrides all_work JOIN actor ON actor.id=all_work.staff_id
            WHERE all_work.permission_key='operations.view_all' AND all_work.effect='allow'
              AND all_work.scope='global')
          AND EXISTS (SELECT 1 FROM current_grants global_view
            WHERE global_view.permission='${view}' AND global_view.effect='allow'
              AND global_view.scope='global')
        )
        OR context.assigned=1 OR context.owned=1
      )
      AND (${scopedPermissionSql("sops.view", "assigned")})`,
  };
}

async function visibleContext(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
  kind: WorkContextKind,
  id: string,
): Promise<WorkContextRow> {
  await requirePermission(env, principal, viewPermission(kind));
  const [scope, explicitAll] = await Promise.all([
    sqlScope(env, principal, viewPermission(kind)),
    hasLocalGlobalAllow(env, principal, "operations.view_all"),
  ]);
  if (kind === "project") {
    const filter = paProjectFilter(scope, principal, administrator, explicitAll);
    const row = await env.OPS_DB.withSession("first-primary").prepare(
      `SELECT p.id,p.name title,p.status,d.id division_id,
        (SELECT owner.id FROM staff_users owner WHERE owner.project_alpha_user_id=p.manager_user_id LIMIT 1) owner_id,
        (SELECT GROUP_CONCAT(s.id) FROM staff_users s WHERE s.project_alpha_user_id IN (
          SELECT a.user_id FROM pa_project_assignments a WHERE a.project_id=p.id AND a.active=1
          UNION SELECT a.user_id FROM pa_operations o JOIN pa_operation_assignments a
            ON a.operation_id=o.id AND a.active=1 WHERE o.project_id=p.id AND o.active=1
          UNION SELECT a.user_id FROM pa_tasks t JOIN pa_task_assignments a
            ON a.task_id=t.id AND a.active=1 WHERE t.project_id=p.id AND t.active=1
          UNION SELECT p.manager_user_id WHERE p.manager_user_id IS NOT NULL
        )) assigned_staff_ids,
        (SELECT GROUP_CONCAT(s.id) FROM staff_users s WHERE s.project_alpha_user_id IN (
          SELECT a.user_id FROM pa_project_assignments a WHERE a.project_id=p.id AND a.active=1
          UNION SELECT p.manager_user_id WHERE p.manager_user_id IS NOT NULL
        )) manage_staff_ids
       FROM pa_projects p
       LEFT JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id
       WHERE p.id=? AND ${filter.sql}`,
    ).bind(id, ...filter.values).first<WorkContextRow>();
    if (!row) throw new HTTPException(404, { message: "Project not found" });
    return row;
  }
  const filter = paResourceFilter(scope, principal, administrator, "t", "task", explicitAll);
  const row = await env.OPS_DB.withSession("first-primary").prepare(
    `SELECT t.id,t.title,t.status,d.id division_id,
      (SELECT owner.id FROM staff_users owner WHERE owner.project_alpha_user_id=t.created_by_user_id LIMIT 1) owner_id,
      (SELECT GROUP_CONCAT(s.id) FROM pa_task_assignments a
        JOIN staff_users s ON s.project_alpha_user_id=a.user_id
        WHERE a.task_id=t.id AND a.active=1) assigned_staff_ids,
      (SELECT GROUP_CONCAT(s.id) FROM pa_task_assignments a
        JOIN staff_users s ON s.project_alpha_user_id=a.user_id
        WHERE a.task_id=t.id AND a.active=1) manage_staff_ids
     FROM pa_tasks t
     LEFT JOIN divisions d ON d.project_alpha_business_unit_id=t.business_unit_id
     WHERE t.id=? AND ${filter.sql}`,
  ).bind(id, ...filter.values).first<WorkContextRow>();
  if (!row) throw new HTTPException(404, { message: "Task not found" });
  return row;
}

function linkSummary(kind: WorkContextKind, row: LinkRow): WorkContextSopSummary | null {
  if (!row.sop_id || !row.revision_id || row.revision_number === null || !row.slug ||
      !row.title || !row.purpose || !row.published_at || !row.linked_at) return null;
  return {
    sopId: row.sop_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    slug: row.slug,
    title: row.title,
    purpose: row.purpose,
    publishedAt: row.published_at,
    linkedAt: row.linked_at,
    archived: row.document_status === "archived",
    publicationState: row.document_status === "archived"
      ? "archived"
      : row.document_status !== "published" || !row.published_revision_id
        ? "unpublished"
        : row.published_revision_id === row.revision_id
          ? "current"
          : "superseded",
    href: `/sops/${encodeURIComponent(row.slug)}/revisions/${encodeURIComponent(row.revision_id)}?contextKind=${kind}&contextId=${encodeURIComponent(row.context_id)}`,
  };
}

async function linkRows(
  env: Env,
  kind: WorkContextKind,
  ids: string[],
): Promise<LinkRow[]> {
  if (!ids.length) return [];
  const output: LinkRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const rows = await env.OPS_DB.withSession("first-primary").prepare(
      `SELECT sets.context_id,sets.version,sets.updated_at,l.sop_id,l.revision_id,l.linked_at,
        d.status document_status,d.published_revision_id,r.revision_number,d.slug,r.title,r.purpose,r.published_at
       FROM work_context_sop_link_sets sets
       LEFT JOIN work_context_sop_links l
         ON l.context_kind=sets.context_kind AND l.context_id=sets.context_id
       LEFT JOIN sop_documents d ON d.id=l.sop_id
       LEFT JOIN sop_revisions r ON r.id=l.revision_id AND r.sop_id=l.sop_id
       WHERE sets.context_kind=? AND sets.context_id IN (${chunk.map(() => "?").join(",")})
       ORDER BY sets.context_id,r.title COLLATE NOCASE,r.id`,
    ).bind(kind, ...chunk).all<LinkRow>();
    output.push(...rows.results);
  }
  return output;
}

async function contextRows(
  env: Env,
  kind: WorkContextKind,
  ids: string[],
): Promise<WorkContextRow[]> {
  if (!ids.length) return [];
  const output: WorkContextRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const placeholders = chunk.map(() => "?").join(",");
    const query = kind === "project"
      ? `SELECT p.id,p.name title,p.status,d.id division_id,
          (SELECT owner.id FROM staff_users owner WHERE owner.project_alpha_user_id=p.manager_user_id LIMIT 1) owner_id,
          (SELECT GROUP_CONCAT(s.id) FROM staff_users s WHERE s.project_alpha_user_id IN (
            SELECT a.user_id FROM pa_project_assignments a WHERE a.project_id=p.id AND a.active=1
            UNION SELECT a.user_id FROM pa_operations o JOIN pa_operation_assignments a
              ON a.operation_id=o.id AND a.active=1 WHERE o.project_id=p.id AND o.active=1
            UNION SELECT a.user_id FROM pa_tasks t JOIN pa_task_assignments a
              ON a.task_id=t.id AND a.active=1 WHERE t.project_id=p.id AND t.active=1
            UNION SELECT p.manager_user_id WHERE p.manager_user_id IS NOT NULL
          )) assigned_staff_ids,
          (SELECT GROUP_CONCAT(s.id) FROM staff_users s WHERE s.project_alpha_user_id IN (
            SELECT a.user_id FROM pa_project_assignments a WHERE a.project_id=p.id AND a.active=1
            UNION SELECT p.manager_user_id WHERE p.manager_user_id IS NOT NULL
          )) manage_staff_ids
         FROM pa_projects p LEFT JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id
         WHERE p.active=1 AND p.id IN (${placeholders})`
      : `SELECT t.id,t.title,t.status,d.id division_id,
          (SELECT owner.id FROM staff_users owner WHERE owner.project_alpha_user_id=t.created_by_user_id LIMIT 1) owner_id,
          (SELECT GROUP_CONCAT(s.id) FROM pa_task_assignments a
            JOIN staff_users s ON s.project_alpha_user_id=a.user_id
            WHERE a.task_id=t.id AND a.active=1) assigned_staff_ids,
          (SELECT GROUP_CONCAT(s.id) FROM pa_task_assignments a
            JOIN staff_users s ON s.project_alpha_user_id=a.user_id
            WHERE a.task_id=t.id AND a.active=1) manage_staff_ids
         FROM pa_tasks t LEFT JOIN divisions d ON d.project_alpha_business_unit_id=t.business_unit_id
         WHERE t.active=1 AND t.id IN (${placeholders})`;
    const rows = await env.OPS_DB.withSession("first-primary").prepare(query)
      .bind(...chunk).all<WorkContextRow>();
    output.push(...rows.results);
  }
  return output;
}

/**
 * Adds bounded summary-only link data to an already-authorized Project/Task
 * list. It never returns markdown, rendered HTML, TOCs, or implicit links from
 * another work-context kind.
 */
export async function decorateWorkContextsWithSops<T extends { id: string }>(
  env: Env,
  principal: StaffPrincipal,
  kind: WorkContextKind,
  rows: T[],
): Promise<Array<T & {
  sopLinks: WorkContextSopSummary[];
  sopLinkVersion: number;
  canManageSops: boolean;
}>> {
  const ids = [...new Set(rows.map(row => row.id))];
  if (!ids.length) return [];
  if (!(await workContextSopsAvailable(env)))
    return rows.map(row => ({ ...row, sopLinks: [], sopLinkVersion: 0, canManageSops: false }));
  const [contexts, grants] = await Promise.all([
    contextRows(env, kind, ids),
    loadGrants(env, principal.id),
  ]);
  const byId = new Map(contexts.map(row => [row.id, row]));
  const visibleForSops = contexts.filter(row =>
    evaluatePermission(grants, principal, "sops.view", contextResource(row))
  );
  const visibleIds = visibleForSops.map(row => row.id);
  const links = await linkRows(env, kind, visibleIds);
  const linkMap = new Map<string, WorkContextSopSummary[]>();
  const versionMap = new Map<string, number>();
  for (const row of links) {
    versionMap.set(row.context_id, row.version);
    const summary = linkSummary(kind, row);
    if (!summary) continue;
    const current = linkMap.get(row.context_id) || [];
    current.push(summary);
    linkMap.set(row.context_id, current);
  }
  const visibleSet = new Set(visibleIds);
  return rows.map(row => {
    const context = byId.get(row.id);
    const canView = visibleSet.has(row.id);
    return {
      ...row,
      sopLinks: canView ? linkMap.get(row.id) || [] : [],
      sopLinkVersion: canView ? versionMap.get(row.id) || 0 : 0,
      canManageSops: Boolean(canView && context && evaluatePermission(
        grants,
        principal,
        "sops.assign",
        contextManageResource(context),
      )),
    };
  });
}

async function state(
  env: Env,
  principal: StaffPrincipal,
  kind: WorkContextKind,
  context: WorkContextRow,
) {
  const resource = contextResource(context);
  await requirePermission(env, principal, "sops.view", resource);
  const rows = await linkRows(env, kind, [context.id]);
  return {
    context: {
      kind,
      id: context.id,
      title: context.title,
      status: context.status,
    },
    version: rows[0]?.version || 0,
    updatedAt: rows[0]?.updated_at || null,
    sops: rows.map(row => linkSummary(kind, row)).filter((value): value is WorkContextSopSummary => value !== null),
    canEdit: await (async () => {
      try {
        await requirePermission(env, principal, "sops.assign", contextManageResource(context));
        return true;
      } catch (error) {
        if (error instanceof HTTPException && error.status === 403) return false;
        throw error;
      }
    })(),
  };
}

export async function readAuthorizedWorkContextSopRevision(
  env: Env,
  principal: StaffPrincipal,
  rawKind: string | undefined,
  contextId: string | undefined,
  slug: string,
  revisionId: string,
): Promise<AuthorizedWorkContextSopRevisionRow> {
  const parsed = kindSchema.safeParse(rawKind);
  if (!parsed.success || !contextId || contextId.length > 128)
    throw new HTTPException(404, { message: "Pinned SOP revision not found" });
  if (!(await workContextSopsAvailable(env)))
    throw new HTTPException(404, { message: "Pinned SOP revision not found" });
  const authorization = authoritativeContextSql(parsed.data);
  const row = await env.OPS_DB.withSession("first-primary").prepare(
    `${authorization.ctes}
     SELECT d.id,d.slug,d.status,d.version,d.created_at,d.updated_at,
       r.id revision_id,r.sop_id,r.revision_number,r.parent_revision_id,r.change_kind,
       r.title,r.purpose,r.markdown_body,r.rendered_html,r.toc_json,r.sanitizer_version,
       r.author_id,r.author_email,r.author_display_name,r.created_at revision_created_at,
       r.published_at revision_published_at
     FROM context
     JOIN work_context_sop_link_sets sets
       ON sets.context_kind=? AND sets.context_id=context.id
     JOIN work_context_sop_links l
       ON l.context_kind=sets.context_kind AND l.context_id=sets.context_id
     JOIN sop_documents d ON d.id=l.sop_id
     JOIN sop_revisions r ON r.id=l.revision_id AND r.sop_id=d.id
     WHERE ${authorization.allowed}
       AND d.slug=? AND r.id=? AND r.published_at IS NOT NULL`,
  ).bind(principal.id, contextId, parsed.data, slug, revisionId)
    .first<AuthorizedWorkContextSopRevisionRow>();
  if (!row) throw new HTTPException(404, { message: "Pinned SOP revision not found" });
  return row;
}

async function jsonBody(c: AppContext) {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  });
  const parsed = replacementSchema.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map(issue => issue.message).join("; "),
    });
  return parsed.data;
}

async function currentVersion(env: Env, kind: WorkContextKind, id: string): Promise<number> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT version FROM work_context_sop_link_sets WHERE context_kind=? AND context_id=?",
  ).bind(kind, id).first<{ version: number }>();
  return row?.version || 0;
}

async function replaceLinks(
  c: AppContext,
  kind: WorkContextKind,
  context: WorkContextRow,
  input: z.infer<typeof replacementSchema>,
): Promise<boolean> {
  const principal = c.get("principal");
  const resource = contextResource(context);
  await requirePermission(c.env, principal, "sops.view", resource);
  await requirePermission(c.env, principal, "sops.assign", contextManageResource(context));

  const currentLinks = await linkRows(c.env, kind, [context.id]);
  const selected = input.revisionIds.length
    ? await c.env.OPS_DB.withSession("first-primary").prepare(
      `SELECT d.id sop_id,r.id revision_id
       FROM sop_documents d JOIN sop_revisions r ON r.sop_id=d.id
       LEFT JOIN work_context_sop_links existing
         ON existing.context_kind=? AND existing.context_id=?
           AND existing.sop_id=d.id AND existing.revision_id=r.id
       WHERE r.id IN (${input.revisionIds.map(() => "?").join(",")})
         AND ((d.status='published' AND d.published_revision_id=r.id)
           OR existing.revision_id IS NOT NULL)`,
    ).bind(kind, context.id, ...input.revisionIds).all<{ sop_id: string; revision_id: string }>()
    : { results: [] as Array<{ sop_id: string; revision_id: string }> };
  if (selected.results.length !== input.revisionIds.length)
    throw new HTTPException(409, {
      message: "One or more SOP revisions are no longer the current published revision. Refresh and try again.",
    });

  const mutationId = crypto.randomUUID();
  const nextVersion = input.expectedVersion + 1;
  const authorization = authoritativeContextSql(kind);
  const guard = c.env.OPS_DB.prepare(
    `${authorization.ctes}
     INSERT OR IGNORE INTO work_context_sop_mutation_guards
       (mutation_id,context_kind,context_id,staff_id)
     SELECT ?,?,?,? FROM context
     WHERE ${authorization.allowed}
       AND (${scopedPermissionSql("sops.assign", "manage_assigned")})`,
  ).bind(principal.id, context.id, mutationId, kind, context.id, principal.id);
  const mutation = input.expectedVersion === 0
    ? c.env.OPS_DB.prepare(
      `INSERT OR IGNORE INTO work_context_sop_link_sets
        (context_kind,context_id,version,mutation_id,updated_by)
       SELECT ?,?,1,?,? WHERE EXISTS (
         SELECT 1 FROM work_context_sop_mutation_guards
         WHERE mutation_id=? AND context_kind=? AND context_id=? AND staff_id=?
       )`,
    ).bind(kind, context.id, mutationId, principal.id,
      mutationId, kind, context.id, principal.id)
    : c.env.OPS_DB.prepare(
      `UPDATE work_context_sop_link_sets
       SET version=?,mutation_id=?,updated_by=?,updated_at=datetime('now')
       WHERE context_kind=? AND context_id=? AND version=? AND EXISTS (
         SELECT 1 FROM work_context_sop_mutation_guards
         WHERE mutation_id=? AND context_kind=? AND context_id=? AND staff_id=?
       )`,
    ).bind(nextVersion, mutationId, principal.id, kind, context.id, input.expectedVersion,
      mutationId, kind, context.id, principal.id);
  const retainedRevisionIds = selected.results.map(row => row.revision_id);
  const currentRevisionIds = new Set(currentLinks
    .filter(row => row.revision_id)
    .map(row => row.revision_id as string));
  const statements: D1PreparedStatement[] = [
    guard,
    mutation,
    c.env.OPS_DB.prepare(
      `DELETE FROM work_context_sop_links
       WHERE context_kind=? AND context_id=?${retainedRevisionIds.length
         ? ` AND revision_id NOT IN (${retainedRevisionIds.map(() => "?").join(",")})`
         : ""} AND EXISTS (
          SELECT 1 FROM work_context_sop_link_sets sets
          WHERE sets.context_kind=? AND sets.context_id=? AND sets.version=? AND sets.mutation_id=?
        )`,
    ).bind(kind, context.id, ...retainedRevisionIds, kind, context.id, nextVersion, mutationId),
  ];
  for (const row of selected.results.filter(candidate => !currentRevisionIds.has(candidate.revision_id))) {
    statements.push(c.env.OPS_DB.prepare(
      `INSERT INTO work_context_sop_links
        (context_kind,context_id,sop_id,revision_id,linked_by)
       SELECT ?,?,?,?,? WHERE EXISTS (
         SELECT 1 FROM work_context_sop_link_sets sets
         WHERE sets.context_kind=? AND sets.context_id=? AND sets.version=? AND sets.mutation_id=?
       )`,
    ).bind(
      kind,
      context.id,
      row.sop_id,
      row.revision_id,
      principal.id,
      kind,
      context.id,
      nextVersion,
      mutationId,
    ));
  }
  const address = await auditAddress(c.env, c.req.raw);
  statements.push(c.env.OPS_DB.prepare(
    `INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,
      entity_type,entity_id,division_id,details_json,client_address_hash)
     SELECT 'staff',?,?,?,?, 'work_context_sop_links',?,?,?,?
     WHERE EXISTS (
       SELECT 1 FROM work_context_sop_link_sets sets
       WHERE sets.context_kind=? AND sets.context_id=? AND sets.version=? AND sets.mutation_id=?
     )`,
  ).bind(
    principal.id,
    principal.email,
    principal.displayName,
    "work_context_sops.replaced",
    `${kind}:${context.id}`,
    context.division_id,
    JSON.stringify({ kind, version: nextVersion, revisionIds: input.revisionIds }),
    address,
    kind,
    context.id,
    nextVersion,
    mutationId,
  ));
  statements.push(c.env.OPS_DB.prepare(
    "DELETE FROM work_context_sop_mutation_guards WHERE mutation_id=?",
  ).bind(mutationId));
  const results = await c.env.OPS_DB.batch(statements);
  if (!results[0]?.meta.changes)
    throw new HTTPException(403, {
      message: "Your access to manage these quick SOP links changed. Refresh and try again.",
    });
  return Boolean(results[1]?.meta.changes);
}

export function registerWorkContextSopRoutes(app: App): void {
  app.get("/api/work-contexts/:kind/:id/sops", async c => {
    const kind = kindSchema.safeParse(c.req.param("kind"));
    if (!kind.success) throw new HTTPException(404, { message: "Work context not found" });
    if (!(await workContextSopsAvailable(c.env)))
      return c.json({
        error: "Work-context SOP links are temporarily unavailable",
        code: "capability_unavailable",
      }, 503);
    const principal = c.get("principal");
    const context = await visibleContext(
      c.env,
      principal,
      c.get("administrator"),
      kind.data,
      c.req.param("id"),
    );
    return c.json(await state(c.env, principal, kind.data, context));
  });

  app.put("/api/work-contexts/:kind/:id/sops", async c => {
    const kind = kindSchema.safeParse(c.req.param("kind"));
    if (!kind.success) throw new HTTPException(404, { message: "Work context not found" });
    if (!(await workContextSopsAvailable(c.env)))
      return c.json({
        error: "Work-context SOP links are temporarily unavailable",
        code: "capability_unavailable",
      }, 503);
    const principal = c.get("principal");
    const context = await visibleContext(
      c.env,
      principal,
      c.get("administrator"),
      kind.data,
      c.req.param("id"),
    );
    const input = await jsonBody(c);
    try {
      if (!(await replaceLinks(c, kind.data, context, input)))
        return c.json({
          error: "These quick SOP links changed. Refresh and try again.",
          currentVersion: await currentVersion(c.env, kind.data, context.id),
        }, 409);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof Error && /current published SOP revision|work context is not active/i.test(error.message))
        throw new HTTPException(409, { message: "The work context or selected SOP changed. Refresh and try again." });
      throw error;
    }
    return c.json(await state(c.env, principal, kind.data, context));
  });
}
