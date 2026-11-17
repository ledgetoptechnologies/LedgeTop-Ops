/** Client-side shape checks and routing for the combined share recipient
 * search. The server decides the back end; the client only refuses rows whose
 * stated back end disagrees with their source, so a tampered or stale row can
 * never be sent to the other back end's routes. */
export const PRIMARY_SHARE_SOURCE_ID = "project-alpha:primary";
export type ClientShareBackend = "primary" | "native";
export type ClientShareAudienceType = "principal" | "department" | "organization" | "client" | "project";
export type ClientShareBackendState = "ready" | "link_required" | "not_permitted" | "unavailable";
export type ClientShareProject = { projectId: string; projectName: string; projectEndSupported: boolean };
export type ClientShareRecipient = {
  key: string; backend: ClientShareBackend; sourceId: string; divisionLabel: string; workspaceId: string; workspaceName: string;
  audienceType: ClientShareAudienceType; publicId: string; displayName: string; email: string | null;
  folderBindingId?: string; projects?: ClientShareProject[];
};
export type ClientShareRecipientSearch = { recipients: ClientShareRecipient[]; primary: ClientShareBackendState; native: ClientShareBackendState; truncated: boolean };

// Same four kinds the old picker offered; project-wide audiences are not offered.
const AUDIENCE_TYPES: readonly ClientShareAudienceType[] = ["principal", "department", "organization", "client"];
const STATES: readonly ClientShareBackendState[] = ["ready", "link_required", "not_permitted", "unavailable"];
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

function validProject(value: unknown): value is ClientShareProject {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return text(row.projectId) && text(row.projectName) && typeof row.projectEndSupported === "boolean";
}
export function validClientShareRecipient(value: unknown): value is ClientShareRecipient {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!text(row.sourceId) || !SOURCE.test(row.sourceId) || !text(row.workspaceId) || !text(row.workspaceName) || !text(row.publicId)
    || !text(row.displayName) || !text(row.divisionLabel) || !(row.email === null || typeof row.email === "string")
    || !AUDIENCE_TYPES.includes(row.audienceType as ClientShareAudienceType)) return false;
  const backend = backendForSource(row.sourceId);
  if (row.backend !== backend || row.key !== recipientKey(backend, row.sourceId, row.workspaceId, row.audienceType as ClientShareAudienceType, row.publicId)) return false;
  if (backend === "primary") return text(row.folderBindingId) && row.projects === undefined;
  // Connected workspaces grant one exact person on one listed project.
  return row.audienceType === "principal" && row.folderBindingId === undefined && Array.isArray(row.projects) && row.projects.length > 0
    && row.projects.length <= 10 && row.projects.every(validProject)
    && new Set(row.projects.map(project => project.projectId)).size === row.projects.length;
}
export function validClientShareRecipientSearch(value: unknown): value is ClientShareRecipientSearch {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.recipients) || row.recipients.length > 60 || typeof row.truncated !== "boolean"
    || !STATES.includes(row.primary as ClientShareBackendState) || !STATES.includes(row.native as ClientShareBackendState)) return false;
  if (!row.recipients.every(validClientShareRecipient)) return false;
  const keys = (row.recipients as ClientShareRecipient[]).map(item => item.key);
  if (new Set(keys).size !== keys.length) return false;
  // A back end that reported no access must not contribute rows.
  return (row.recipients as ClientShareRecipient[]).every(item => (item.backend === "primary" ? row.primary : row.native) === "ready");
}

/** Project step for a connected-workspace person: chosen automatically when
 * there is exactly one candidate, otherwise the person must pick one. */
export function autoSelectedProject(recipient: ClientShareRecipient): ClientShareProject | null {
  return recipient.backend === "native" && recipient.projects?.length === 1 ? recipient.projects[0]! : null;
}

export type NativeShareTarget = { sourceId: string; sourceName: string; workspaceId: string; workspaceName: string; projectId: string; projectName: string; projectEndSupported: boolean };
/** Connected-workspace targets for a person chosen in the combined search.
 * Empty for any primary row, so it can never feed the native routes. */
export function nativeTargetsForRecipient(recipient: ClientShareRecipient): NativeShareTarget[] {
  if (recipient.backend !== "native" || backendForSource(recipient.sourceId) !== "native") return [];
  return (recipient.projects ?? []).map(project => ({ sourceId: recipient.sourceId, sourceName: recipient.divisionLabel, workspaceId: recipient.workspaceId,
    workspaceName: recipient.workspaceName, projectId: project.projectId, projectName: project.projectName, projectEndSupported: project.projectEndSupported }));
}

/** Same-named rows stay distinguishable: division, then workspace, then the
 * contact detail or audience kind. */
export function recipientDetail(recipient: ClientShareRecipient): string {
  const kind = recipient.audienceType === "principal" ? recipient.email || "Verified person" : `${recipient.audienceType} · current members`;
  return `${recipient.divisionLabel} · ${recipient.workspaceName} · ${kind}`;
}
