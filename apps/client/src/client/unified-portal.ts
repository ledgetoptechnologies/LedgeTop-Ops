import { projectAlphaSourceName } from "@ltds/shared";
import { requestJson } from "./bulk-download";
import { loadNativeHierarchy, loadNativePortalContext, type NativePortalContext } from "./native-portal-api";
import type { PortalProject, PortalRequest, PortalServiceRequest, PortalWorkspace } from "./portal-api";

/**
 * One portal across every client account a person may open. Nothing here widens
 * access: each account is loaded with its own explicit scope, so the server
 * authorizes every call exactly as it does for a single selected account, and
 * every item keeps the account it came from for any follow-up action.
 */

const PRIMARY_SOURCE = "project-alpha:primary";
const MAX_HIERARCHY_PAGES = 10;
const ACCOUNT_CONCURRENCY = 4;

export interface UnifiedAccount {
  workspace: PortalWorkspace;
  /** Business that serves this account; legacy rows are always the primary source. */
  business: string;
  /** Client account name; shown only when the person can open more than one. */
  clientName: string;
}

export interface UnifiedProject {
  key: string;
  account: UnifiedAccount;
  projectId: string;
  projectName: string;
  status: string | null;
  lastUpdateAt: string | null;
  canRequestService: boolean;
}

export interface UnifiedRequest {
  key: string;
  account: UnifiedAccount;
  request: PortalServiceRequest;
  projectName: string | null;
}

export type UnifiedAccountResult =
  | { status: "ready"; account: UnifiedAccount; projects: UnifiedProject[]; requests: UnifiedRequest[]; canRequest: boolean }
  | { status: "error"; account: UnifiedAccount; message: string };

const KNOWN_BUSINESS_SOURCES = new Set([PRIMARY_SOURCE, "project-alpha:secondary"]);

export function unifiedAccount(workspace: PortalWorkspace): UnifiedAccount {
  const source = workspace.sourceId ?? PRIMARY_SOURCE;
  // Clients only ever see the two business names; any other source stays a neutral "Ledge Top".
  return { workspace, business: KNOWN_BUSINESS_SOURCES.has(source) ? projectAlphaSourceName(source) : "Ledge Top", clientName: workspace.displayName };
}

/** A legacy row (no source) is primary-only; any other source must be native, matching the single-account bootstrap. */
export function unifiedAccountSupported(workspace: PortalWorkspace): boolean {
  return workspace.resourceMode === "native" || !workspace.sourceId || workspace.sourceId === PRIMARY_SOURCE;
}

function projectsFrom(account: UnifiedAccount, projects: PortalProject[]): UnifiedProject[] {
  return projects.map(project => ({
    key: `${account.workspace.id}\u0000${project.id}`, account, projectId: project.id, projectName: project.projectName,
    status: project.status, lastUpdateAt: project.lastUpdateAt, canRequestService: project.canRequestService,
  }));
}

function requestsFrom(account: UnifiedAccount, requests: PortalServiceRequest[], projectNames: Map<string, string>): UnifiedRequest[] {
  return requests.map(request => ({
    key: `${account.workspace.id}\u0000${request.id}`, account, request,
    projectName: request.projectId ? projectNames.get(request.projectId) ?? null : null,
  }));
}

async function loadNativeProjects(context: NativePortalContext, signal: AbortSignal): Promise<PortalProject[]> {
  if (!context.capabilities.directoryRead) return [];
  const projects: PortalProject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_HIERARCHY_PAGES; page++) {
    const result = await loadNativeHierarchy(context, signal, cursor);
    for (const entry of result.entries) if (entry.type === "project") projects.push({
      id: entry.publicId, externalRef: entry.publicId, clientName: context.workspace.displayName, projectName: entry.displayName,
      // An active directory row may represent a retained, completed project;
      // the hierarchy response does not attest its current lifecycle status.
      canRequestService: context.capabilities.requestV2 === true, status: null, summary: null, siteAddress: null, serviceAddress: null,
      projectContactName: null, projectContactEmail: null, projectContactPhone: null, nextMilestone: null, lastUpdateAt: null,
    });
    cursor = result.page.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error("This client’s project list is too large to load completely here. Open that client’s projects to see the remaining items.");
  return projects;
}

export async function loadUnifiedAccount(
  account: UnifiedAccount, signal: AbortSignal, request: PortalRequest = requestJson,
): Promise<UnifiedAccountResult> {
  const workspaceId = account.workspace.id;
  try {
    if (!unifiedAccountSupported(account.workspace)) throw Object.assign(new Error("This client account is not available here"), { status: 403 });
    if (account.workspace.resourceMode === "native") {
      const context = await loadNativePortalContext(account.workspace, request, signal);
      const canRequest = context.capabilities.requestV2 === true;
      const [projects, requests] = await Promise.all([
        loadNativeProjects(context, signal),
        canRequest ? request<{ requests: PortalServiceRequest[] }>("/api/client/service-requests", { signal, workspaceId }) : { requests: [] },
      ]);
      const unifiedProjects = projectsFrom(account, projects);
      return { status: "ready", account, projects: unifiedProjects, canRequest,
        requests: requestsFrom(account, Array.isArray(requests.requests) ? requests.requests : [], new Map(projects.map(item => [item.id, item.projectName]))) };
    }
    const [session, projects, requests] = await Promise.all([
      request<{ capabilities?: { requestV2?: boolean } }>("/api/client/session", { signal, workspaceId }),
      request<{ projects: PortalProject[] }>("/api/client/projects", { signal, workspaceId }),
      request<{ requests: PortalServiceRequest[] }>("/api/client/service-requests", { signal, workspaceId }),
    ]);
    const projectList = Array.isArray(projects.projects) ? projects.projects : [];
    return { status: "ready", account, projects: projectsFrom(account, projectList),
      canRequest: session.capabilities?.requestV2 === true && projectList.some(project => project.canRequestService),
      requests: requestsFrom(account, Array.isArray(requests.requests) ? requests.requests : [], new Map(projectList.map(item => [item.id, item.projectName]))) };
  } catch (caught) {
    if (signal.aborted) throw caught;
    return { status: "error", account, message: (caught as Error).message || "This client account could not be loaded." };
  }
}

/** Loads every account with bounded concurrency; results arrive per account so the page can render progressively. */
export async function loadUnifiedPortal(
  workspaces: PortalWorkspace[], signal: AbortSignal, onResult: (result: UnifiedAccountResult) => void,
  request: PortalRequest = requestJson,
): Promise<void> {
  const queue = workspaces.map(unifiedAccount);
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await loadUnifiedAccount(next, signal, request);
      if (signal.aborted) return;
      onResult(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));
}

/** Sorted, de-duplicated client names: shown on items only when a person spans several client accounts. */
export function showsClientName(accounts: UnifiedAccount[]): boolean {
  return new Set(accounts.map(account => account.clientName)).size > 1 || accounts.length > new Set(accounts.map(account => account.business)).size;
}

export type AccountArea = "drone" | "web" | "general";

/**
 * What kind of work an account covers, described for the client instead of naming a business.
 * The business still comes only from the server-assigned source; this just words it.
 */
export function accountArea(account: UnifiedAccount): AccountArea {
  const source = account.workspace.sourceId ?? PRIMARY_SOURCE;
  return source === PRIMARY_SOURCE ? "drone" : source === "project-alpha:secondary" ? "web" : "general";
}

export const AREA_TEXT: Record<AccountArea, { name: string; need: string; needDetail: string; deliveries: string; feedback: string }> = {
  drone: { name: "Drone and survey", need: "Drone flight or field work", needDetail: "Mapping, inspections, photos, video and site data.",
    deliveries: "Drone and survey deliveries", feedback: "Drone and survey work" },
  web: { name: "Website and marketing", need: "Website or marketing", needDetail: "Website changes, Google Ads, SEO, email and IT help.",
    deliveries: "Website and marketing files", feedback: "Website and marketing" },
  general: { name: "Ledge Top", need: "Other Ledge Top work", needDetail: "Anything else you need from Ledge Top.",
    deliveries: "Deliveries", feedback: "Your work with Ledge Top" },
};

export function accountLabel(account: UnifiedAccount, withClient: boolean): string {
  return withClient ? `${account.business} · ${account.clientName}` : account.business;
}
