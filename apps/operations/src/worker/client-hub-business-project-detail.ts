import { HTTPException } from "hono/http-exception";
import { businessContactChannels, businessContactChannelsSql } from "./client-business-contact";
import { clientHubDetailPath } from "./client-hub-directory";
import { clientHubBusinessProjectOwnership, clientHubBusinessProjectSourceProof } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy, type ClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import type { Env, StaffPrincipal } from "./types";

export interface ClientHubBusinessProjectDetail {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"];
  client: { display_name: string; detail_path: string };
  contextVersion: string;
  refreshedAt: string;
  project: {
    id: string; name: string; status: string | null; description: string | null;
    start_date: string | null; end_date: string | null; created_at: string | null;
    manager: { id: string; display_name: string | null } | null;
  };
  linkedContact: {
    id: string; display_name: string; email: string | null; phone: string | null;
    sourceField: "project.client_id";
  } | null;
  availability: {
    linkedContact: "available" | "not_projected" | "unavailable";
    siteContacts: "not_projected"; billingContacts: "not_projected"; projectMemory: "not_projected";
  };
  operationalWorkspaceAvailable: boolean;
  businessActivityAvailable: boolean;
  auditTimelineAvailable: boolean;
  feedbackHistoryAvailable: boolean;
}
interface DetailRow {
  id: string; name: string; status: string | null; start_date: string | null; end_date: string | null;
  client_id: string | null; organization_id: string | null; description: string | null; created_at: string | null;
  manager_id: string | null; manager_name: string | null;
  contact_id: string | null; contact_name: string | null; email: string | null; phone: string | null;
}

function changed(): never {
  throw new HTTPException(409, { message: "Project ownership or permissions changed. Refresh the client workspace to continue" });
}
// The source payload can contain billing and private fields. Only these two
// explicitly projected description/date scalars are selected from it.
function sourceText(path: "$.description" | "$.created_at", maximum: number): string {
  return `CASE WHEN json_valid(p.payload_json) THEN CASE WHEN json_type(p.payload_json,'${path}')='text'
    AND length(json_extract(p.payload_json,'${path}'))<=${maximum}
    THEN json_extract(p.payload_json,'${path}') END END`;
}
function text(value: string | null, maximum: number, multiline = false): string | null {
  if (value === null || value.length > maximum || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)) return null;
  return value.trim() || null;
}
function date(value: string | null): string | null {
  if (!value || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
  const day = value.slice(0, 10), parsedDay = Date.parse(day);
  if (!Number.isFinite(parsedDay) || new Date(parsedDay).toISOString().slice(0, 10) !== day) return null;
  const parsed = Date.parse(value.length > 10 && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value + "Z" : value);
  return Number.isFinite(parsed) ? value.length === 10 ? day : new Date(parsed).toISOString() : null;
}
async function readRow(env: Env, context: ClientHubCollectionContext, projectId: string,
  policy: ClientHubBusinessProjectPolicy): Promise<DetailRow | null> {
  const owner = clientHubBusinessProjectOwnership(context);
  // An explicit project organization takes precedence over its linked client.
  // A stale/out-of-root client reference must not expose another client's
  // contact details even when the project itself remains visible here.
  const contact = context.root.kind === "organization"
    ? "contact.organization_id=?" : "contact.id=? AND contact.organization_id IS NULL";
  return env.OPS_DB.withSession("first-primary").prepare(`SELECT p.id,p.name,p.status,p.start_date,p.end_date,
    p.client_id,p.organization_id,${sourceText("$.description", 8000)} description,${sourceText("$.created_at", 64)} created_at,
    manager.id manager_id,manager.display_name manager_name,contact.id contact_id,contact.name contact_name,
    ${businessContactChannelsSql("contact.payload_json")}
    FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
      LEFT JOIN pa_clients contact ON contact.id=p.client_id AND contact.projection_source_id=p.projection_source_id AND contact.active=1 AND (${contact})
      LEFT JOIN pa_users manager ON manager.id=p.manager_user_id AND manager.projection_source_id=p.projection_source_id AND manager.active=1
    WHERE p.id=? AND (${owner.sql}) AND (${policy.filter.sql}) LIMIT 1`)
    .bind(context.root.public_id, projectId, ...owner.values, ...policy.filter.values).first<DetailRow>();
}

/** Read-only projected business data, not a portal grant or a write capability.
 * The caller must recheck the shared Client Hub context after this read.
 * There is no cross-database snapshot guarantee; current source and ownership
 * are checked before and after the bounded projection query. */
export async function readClientHubBusinessProjectDetail(env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string,
  options: { expectedContextVersion?: string } = {}): Promise<ClientHubBusinessProjectDetail> {
  if (!projectId || projectId.length > 512 || /[\u0000-\u001f\u007f]/.test(projectId))
    throw new HTTPException(400, { message: "Business project identifier is invalid" });
  if (options.expectedContextVersion !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.expectedContextVersion))
    throw new HTTPException(400, { message: "Client context is invalid" });
  if (options.expectedContextVersion !== undefined && options.expectedContextVersion !== context.contextVersion) changed();
  if (context.root.root_namespace !== "business")
    throw new HTTPException(404, { message: "Business project not found" });
  const policy = await readClientHubBusinessProjectPolicy(env, principal);
  if (!context.access.directory || !policy.allowed)
    throw new HTTPException(403, { message: "Client directory and project-view permissions are required" });
  const source = await clientHubBusinessProjectSourceProof(env, context);
  const row = await readRow(env, context, projectId, policy);
  if (!row) throw new HTTPException(404, { message: "Business project not found" });
  const currentPolicy = await readClientHubBusinessProjectPolicy(env, principal);
  const currentSource = await clientHubBusinessProjectSourceProof(env, context);
  if (!currentPolicy.allowed || currentPolicy.proof !== policy.proof || currentSource !== source) changed();
  const current = await readRow(env, context, projectId, currentPolicy);
  if (!current || JSON.stringify(current) !== JSON.stringify(row)) changed();
  const linkedContact = row.contact_id && row.contact_name !== null ? {
    id: row.contact_id, display_name: row.contact_name, ...businessContactChannels(row),
    sourceField: "project.client_id" as const,
  } : null;
  return {
    canonicalRoot: context.canonicalRoot,
    client: { display_name: context.root.display_name, detail_path: clientHubDetailPath(context.root) },
    contextVersion: context.contextVersion, refreshedAt: new Date().toISOString(),
    project: { id: row.id, name: row.name, status: text(row.status, 80), description: text(row.description, 8000, true),
      start_date: date(row.start_date), end_date: date(row.end_date), created_at: date(row.created_at),
      manager: row.manager_id ? { id: row.manager_id, display_name: text(row.manager_name, 500) } : null },
    linkedContact,
    availability: { linkedContact: linkedContact ? "available" : row.client_id ? "unavailable" : "not_projected",
      siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" },
    operationalWorkspaceAvailable: true,
    businessActivityAvailable: true,
    auditTimelineAvailable: true,
    feedbackHistoryAvailable: context.canonicalRoot.sourceId === "project-alpha:primary",
  };
}
