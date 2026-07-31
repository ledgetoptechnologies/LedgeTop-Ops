export type ClientPortalPage = "dashboard" | "projects" | "deliveries" | "requests" | "account" | "not-found";

export interface ClientPortalRoute {
  isPortal: boolean;
  page: ClientPortalPage;
}

const portalPages = new Set<ClientPortalPage>(["dashboard", "projects", "deliveries", "requests", "account"]);

export function parseClientPortalRoute(pathname: string): ClientPortalRoute {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "portal") return { isPortal: false, page: "dashboard" };
  if (parts.length === 1) return { isPortal: true, page: "dashboard" };
  if (parts.length === 2 && portalPages.has(parts[1] as ClientPortalPage)) {
    return { isPortal: true, page: parts[1] as ClientPortalPage };
  }
  return { isPortal: true, page: "not-found" };
}

export function clientPortalPath(page: Exclude<ClientPortalPage, "not-found">): string {
  return page === "dashboard" ? "/portal" : `/portal/${page}`;
}
