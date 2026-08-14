export type DeliveryNamespace = "staff" | "client-delegated";

export function parseDeliveryRoute(
  pathname: string,
  hash: string,
  namespace: DeliveryNamespace = "staff",
): { publicId: string; secret: string } {
  const segments = pathname.split("/").filter(Boolean);
  const expectedRoot = namespace === "client-delegated" ? "client-share" : "s";
  const publicId = segments.length === 2 && segments[0] === expectedRoot ? segments[1] || "" : "";
  if (!publicId) return { publicId: "", secret: "" };
  let fragment = "";
  if (hash.startsWith("#") && hash.length > 1) {
    try { fragment = decodeURIComponent(hash.slice(1)); } catch { fragment = ""; }
  }
  return { publicId, secret: fragment || (publicId.length > 30 ? publicId : "") };
}

export function consumeDeliveryRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
  namespace: DeliveryNamespace = "staff",
): { publicId: string; secret: string } {
  const route = parseDeliveryRoute(location.pathname, location.hash, namespace);
  if (route.secret && location.hash) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return route;
}

export type DeliveryBrowseView = "grid" | "list";

export interface DeliveryBrowseState {
  folderId: string;
  fileId: string;
  view: DeliveryBrowseView;
}

const opaqueItemRef = /^[A-Za-z0-9_-]{1,4096}$/;

export function parseDeliveryBrowseState(search: string, fallbackView: DeliveryBrowseView = "grid"): DeliveryBrowseState {
  const params = new URLSearchParams(search);
  const folder = params.get("folder") || "";
  const file = params.get("file") || "";
  const requestedView = params.get("view");
  return {
    folderId: opaqueItemRef.test(folder) ? folder : "",
    fileId: opaqueItemRef.test(file) ? file : "",
    view: requestedView === "grid" || requestedView === "list" ? requestedView : fallbackView,
  };
}

export function deliveryBrowsePath(
  publicId: string,
  state: DeliveryBrowseState,
  namespace: DeliveryNamespace = "staff",
): string {
  const params = new URLSearchParams();
  if (state.folderId) params.set("folder", state.folderId);
  if (state.fileId) params.set("file", state.fileId);
  params.set("view", state.view);
  const root = namespace === "client-delegated" ? "/client-share" : "/s";
  return `${root}/${encodeURIComponent(publicId)}?${params.toString()}`;
}

export function deliveryApiBase(publicId: string, namespace: DeliveryNamespace = "staff"): string {
  const root = namespace === "client-delegated" ? "/client-share/api/shares" : "/api/public/shares";
  return `${root}/${encodeURIComponent(publicId)}`;
}

export interface DeliverySessionResult {
  publicId: string;
  canonicalPath: string;
}

export async function openDeliveryRoute(
  route: { publicId: string; secret: string; accessCode?: string },
  dependencies: {
    createSession: (route: { publicId: string; secret: string; accessCode?: string }) => Promise<DeliverySessionResult>;
    loadManifest: (publicId: string) => Promise<void>;
  },
): Promise<DeliverySessionResult | null> {
  if (!route.secret) {
    await dependencies.loadManifest(route.publicId);
    return null;
  }

  const session = await dependencies.createSession(route);
  await dependencies.loadManifest(session.publicId);
  return session;
}
