export type ClientPortalPage = "dashboard" | "projects" | "project" | "deliveries" | "requests" | "request-new" | "feedback" | "account" | "not-found";

export interface ClientPortalRoute {
  isPortal: boolean;
  page: ClientPortalPage;
  projectId: string | null;
  feedbackId?: string;
}

const portalPages = new Set<ClientPortalPage>(["dashboard", "projects", "deliveries", "requests", "feedback", "account"]);

export function parseClientPortalRoute(pathname: string): ClientPortalRoute {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "portal") return { isPortal: false, page: "dashboard", projectId: null };
  if (parts.length === 1) return { isPortal: true, page: "dashboard", projectId: null };
  if (parts.length === 3 && parts[1] === "projects") {
    try { return { isPortal: true, page: "project", projectId: decodeURIComponent(parts[2]!) }; } catch { return { isPortal: true, page: "not-found", projectId: null }; }
  }
  if (parts.length === 3 && parts[1] === "feedback") {
    try { const id = decodeURIComponent(parts[2]!); if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { isPortal: true, page: "feedback", projectId: null, feedbackId: id }; } catch { /* invalid path */ }
    return { isPortal: true, page: "not-found", projectId: null };
  }
  if (parts.length === 3 && parts[1] === "requests" && parts[2] === "new") {
    return { isPortal: true, page: "request-new", projectId: null };
  }
  if (parts.length === 2 && portalPages.has(parts[1] as ClientPortalPage)) {
    return { isPortal: true, page: parts[1] as ClientPortalPage, projectId: null };
  }
  return { isPortal: true, page: "not-found", projectId: null };
}

export function clientPortalPath(page: Exclude<ClientPortalPage, "not-found" | "project" | "request-new">): string {
  return page === "dashboard" ? "/portal" : `/portal/${page}`;
}

export function clientProjectPath(projectId: string): string {
  return `/portal/projects/${encodeURIComponent(projectId)}`;
}

export function clientRequestNewPath(): string {
  return "/portal/requests/new";
}
