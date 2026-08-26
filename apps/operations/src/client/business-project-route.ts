import type { ClientSummary, ClientRootNamespace } from "./ClientDirectory";

export interface BusinessProjectRoute {
  sourceId: string;
  rootNamespace: ClientRootNamespace;
  kind: "organizations" | "standalone";
  publicId: string;
  projectId: string;
}
const validId = (value: string) => value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

export function readBusinessProjectRoute(pathname: string): BusinessProjectRoute | { invalid: true } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "clients" || parts[1] !== "sources" || parts[6] !== "projects") return null;
  if (parts.length !== 8 || parts[3] !== "business" || !["organizations", "standalone"].includes(parts[4] || "")) return { invalid: true };
  try {
    const sourceId = decodeURIComponent(parts[2]!), publicId = decodeURIComponent(parts[5]!), projectId = decodeURIComponent(parts[7]!);
    if (![sourceId, publicId, projectId].every(validId)) return { invalid: true };
    return { sourceId, rootNamespace: parts[3] as ClientRootNamespace, kind: parts[4] as BusinessProjectRoute["kind"], publicId, projectId };
  } catch { return { invalid: true }; }
}

export function businessProjectClientPath(route: Omit<BusinessProjectRoute, "projectId">): string {
  return `/clients/sources/${encodeURIComponent(route.sourceId)}/${route.rootNamespace}/${route.kind}/${encodeURIComponent(route.publicId)}`;
}

/** Keep navigation context, never a caller-supplied return URL or auth token. */
export function clientWorkspaceFilters(search: string): string {
  const incoming = new URLSearchParams(search), result = new URLSearchParams();
  for (const key of ["q", "login_q"]) {
    const value = incoming.get(key)?.trim().slice(0, 200);
    if (value) result.set(key, value);
  }
  const source = incoming.get("source");
  if (source && (source === "delivery:local" || /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source))) result.set("source", source);
  const enums: Record<string, string[]> = { kind: ["organization", "standalone_client"], sort: ["name"], business_status: ["current", "completed", "cancelled"],
    login_link: ["linked", "unlinked", "conflict"], login_blocked: ["yes", "no"], login_status: ["suspended", "revoked", "all"] };
  for (const [key, options] of Object.entries(enums)) {
    const value = incoming.get(key);
    if (value && options.includes(value)) result.set(key, value);
  }
  return result.size ? `?${result}` : "";
}

export function businessProjectHref(client: ClientSummary, projectId: string, search = location.search): string | null {
  if (!client.source_id || client.root_namespace !== "business" || !validId(projectId) || !validId(client.public_id) || !validId(client.source_id)) return null;
  return `${businessProjectClientPath({ sourceId: client.source_id, rootNamespace: client.root_namespace, kind: client.route_kind, publicId: client.public_id })}/projects/${encodeURIComponent(projectId)}${clientWorkspaceFilters(search)}`;
}
