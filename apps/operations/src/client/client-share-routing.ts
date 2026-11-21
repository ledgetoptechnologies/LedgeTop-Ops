/** Client-side shape checks and routing for the combined share recipient
 * search. The server decides the back end; the client only refuses rows whose
 * stated back end disagrees with their source, so a tampered or stale row can
 * never be sent to the other back end's routes. */
export const PRIMARY_SHARE_SOURCE_ID = "project-alpha:primary";
export type ClientShareBackend = "primary" | "native";
export type ClientShareAudienceType = "principal" | "department" | "organization" | "client";
export type ClientShareBackendState = "ready" | "link_required" | "not_permitted" | "unavailable" | "failed";
export type ClientShareTruncation = Record<ClientShareAudienceType | "connected", boolean>;
export type ClientShareRecipient = {
  key: string; backend: ClientShareBackend; sourceId: string; divisionLabel: string; workspaceId: string; workspaceName: string;
  audienceType: ClientShareAudienceType; publicId: string; displayName: string; email: string | null; folderBindingId?: string;
};
export type ClientShareRecipientSearch = { recipients: ClientShareRecipient[]; primary: ClientShareBackendState; native: ClientShareBackendState; truncated: ClientShareTruncation };
export type ClientShareProject = { projectId: string; projectName: string; projectEndSupported: boolean };
export type ClientShareProjects = { projects: ClientShareProject[]; bound: boolean; complete: boolean };

// Same four kinds the old picker offered; project-wide audiences are not offered.
const AUDIENCE_TYPES: readonly ClientShareAudienceType[] = ["principal", "department", "organization", "client"];
const STATES: readonly ClientShareBackendState[] = ["ready", "link_required", "not_permitted", "unavailable", "failed"];
const TRUNCATION_KEYS = [...AUDIENCE_TYPES, "connected"] as const;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

/** Exactly one back end per source: the primary source uses the authenticated
 * grant routes, every other source uses the connected-workspace routes. */
export function backendForSource(sourceId: string): ClientShareBackend {
  return sourceId === PRIMARY_SHARE_SOURCE_ID ? "primary" : "native";
}
export function recipientKey(backend: ClientShareBackend, sourceId: string, workspaceId: string, type: ClientShareAudienceType, publicId: string): string {
  return JSON.stringify([backend, sourceId, workspaceId, type, publicId]);
}

export function validClientShareRecipient(value: unknown): value is ClientShareRecipient {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!text(row.sourceId) || !SOURCE.test(row.sourceId) || !text(row.workspaceId) || !text(row.workspaceName) || !text(row.publicId)
    || !text(row.displayName) || !text(row.divisionLabel) || !(row.email === null || typeof row.email === "string")
    || !AUDIENCE_TYPES.includes(row.audienceType as ClientShareAudienceType) || "projects" in row) return false;
  const backend = backendForSource(row.sourceId);
  if (row.backend !== backend || row.key !== recipientKey(backend, row.sourceId, row.workspaceId, row.audienceType as ClientShareAudienceType, row.publicId)) return false;
  if (backend === "primary") return text(row.folderBindingId);
  // Connected workspaces grant one exact person.
  return row.audienceType === "principal" && row.folderBindingId === undefined;
}
export function validClientShareRecipientSearch(value: unknown): value is ClientShareRecipientSearch {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.recipients) || row.recipients.length > 60 || !STATES.includes(row.primary as ClientShareBackendState)
    || !STATES.includes(row.native as ClientShareBackendState) || !row.truncated || typeof row.truncated !== "object") return false;
  const truncated = row.truncated as Record<string, unknown>;
  if (Object.keys(truncated).length !== TRUNCATION_KEYS.length || !TRUNCATION_KEYS.every(key => typeof truncated[key] === "boolean")) return false;
  if (!row.recipients.every(validClientShareRecipient)) return false;
  const rows = row.recipients as ClientShareRecipient[], keys = rows.map(item => item.key);
  if (new Set(keys).size !== keys.length) return false;
  // A back end that reported no access must not contribute rows or counts.
  if (row.primary !== "ready" && AUDIENCE_TYPES.some(kind => truncated[kind])) return false;
  if (row.native !== "ready" && truncated.connected) return false;
  return rows.every(item => (item.backend === "primary" ? row.primary : row.native) === "ready");
}
export function anyTruncated(truncated: ClientShareTruncation): boolean {
  return TRUNCATION_KEYS.some(key => truncated[key]);
}

function validProject(value: unknown): value is ClientShareProject {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return text(row.projectId) && text(row.projectName) && typeof row.projectEndSupported === "boolean";
}
export function validClientShareProjects(value: unknown): value is ClientShareProjects {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.projects) || row.projects.length > 20 || typeof row.bound !== "boolean" || typeof row.complete !== "boolean"
    || !row.projects.every(validProject)) return false;
  const ids = (row.projects as ClientShareProject[]).map(project => project.projectId);
  return new Set(ids).size === ids.length && (!row.bound || ids.length <= 1);
}
export type NativeShareTarget = { sourceId: string; sourceName: string; workspaceId: string; workspaceName: string; projectId: string; projectName: string; projectEndSupported: boolean };
/** Connected-workspace targets for a chosen person. Empty for any primary row,
 * so it can never feed the native routes. */
export function nativeTargetsForRecipient(recipient: ClientShareRecipient, projects: ClientShareProject[]): NativeShareTarget[] {
  if (recipient.backend !== "native" || backendForSource(recipient.sourceId) !== "native") return [];
  return projects.map(project => ({ sourceId: recipient.sourceId, sourceName: recipient.divisionLabel, workspaceId: recipient.workspaceId,
    workspaceName: recipient.workspaceName, projectId: project.projectId, projectName: project.projectName, projectEndSupported: project.projectEndSupported }));
}
/** The project step: chosen automatically only when the folder is already
 * bound to it, or when the complete, unfiltered set has exactly one. */
export function autoSelectedProject(result: ClientShareProjects): { project: ClientShareProject; reason: "bound" | "only" } | null {
  if (result.projects.length !== 1) return null;
  if (result.bound) return { project: result.projects[0]!, reason: "bound" };
  return result.complete ? { project: result.projects[0]!, reason: "only" } : null;
}

/** A short stable reference so same-named rows without an email differ. */
export function recipientReference(recipient: Pick<ClientShareRecipient, "publicId">): string {
  return recipient.publicId.slice(-6);
}
/** Same-named rows stay distinguishable: division, workspace, then the email,
 * or the audience kind with a short reference. */
export function recipientDetail(recipient: ClientShareRecipient): string {
  const kind = recipient.audienceType === "principal" ? recipient.email || `Verified person · ref ${recipientReference(recipient)}`
    : `${recipient.audienceType} · current members · ref ${recipientReference(recipient)}`;
  return `${recipient.divisionLabel} · ${recipient.workspaceName} · ${kind}`;
}
