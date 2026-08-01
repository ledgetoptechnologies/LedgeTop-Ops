export type ClientPortalPage = "dashboard" | "projects" | "project" | "deliveries" | "requests" | "request-new" | "account" | "not-found";

export interface ClientPortalRoute {
  isPortal: boolean;
  page: ClientPortalPage;
  projectId: string | null;
}

const portalPages = new Set<ClientPortalPage>(["dashboard", "projects", "deliveries", "requests", "account"]);

export function parseClientPortalRoute(pathname: string): ClientPortalRoute {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "portal") return { isPortal: false, page: "dashboard", projectId: null };
  if (parts.length === 1) return { isPortal: true, page: "dashboard", projectId: null };
  if (parts.length === 3 && parts[1] === "projects") {
    return { isPortal: true, page: "project", projectId: decodeURIComponent(parts[2]!) };
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
