import { RenewableViewerShell } from "@ltds/ui";
import { createPortalViewerSession, loadPortalBootstrap } from "./portal-api";
import { createNativeViewerSession } from "./native-portal-api";
import { clientProjectPath } from "./portal-route";
import { readClientViewerUnits } from "./viewer-units-preference";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const projectCoordinate = /^[^\u0000-\u001f\u007f]{1,256}$/;

export type ClientViewerShellRoute =
  | { mode: "legacy"; projectId: string; associationId: string; modelId: string }
  | { mode: "native"; workspaceId: string; projectId: string; associationId: string; modelId: string };

export function clientViewerShellPath(route: Omit<Extract<ClientViewerShellRoute, { mode: "legacy" }>, "mode">): string {
  return `/portal/viewer/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function nativeClientViewerShellPath(route: Omit<Extract<ClientViewerShellRoute, { mode: "native" }>, "mode">): string {
  return `/portal/viewer/native/${encodeURIComponent(route.workspaceId)}/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function parseClientViewerShellRoute(pathname: string): ClientViewerShellRoute | null {
  const native = /^\/portal\/viewer\/native\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (native) {
    try {
      const [workspaceId, projectId, associationId, modelId] = native.slice(1).map(value => decodeURIComponent(value!));
      return workspaceId && projectId && associationId && modelId && opaque.test(workspaceId) && projectCoordinate.test(projectId) &&
        opaque.test(associationId) && opaque.test(modelId)
        ? { mode: "native", workspaceId, projectId, associationId, modelId }
        : null;
    } catch {
      return null;
    }
  }
  const match = /^\/portal\/viewer\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const [projectId, associationId, modelId] = match.slice(1).map(value => decodeURIComponent(value!));
    return projectId && associationId && modelId && [projectId, associationId, modelId].every(value => opaque.test(value))
      ? { mode: "legacy", projectId, associationId, modelId }
      : null;
  } catch {
    return null;
  }
}

export function ClientViewerShell({ route }: { route: ClientViewerShellRoute }) {
  const issueSession = async (key: string) => {
    if (route.mode === "legacy")
      return createPortalViewerSession(route.projectId, route.associationId, key, readClientViewerUnits());
    const bootstrap = await loadPortalBootstrap(undefined, route.workspaceId);
    if (bootstrap.resourceMode !== "native" || bootstrap.workspace.id !== route.workspaceId || bootstrap.capabilities.viewer !== true)
      throw new Error("This 3D model is no longer available in the selected workspace.");
    return createNativeViewerSession(bootstrap, route.projectId, route.associationId, key, readClientViewerUnits());
  };
  const exit = new URL(clientProjectPath(route.projectId), window.location.origin);
  if (route.mode === "native") exit.searchParams.set("workspace", route.workspaceId);
  return <RenewableViewerShell
    routeKey={`${route.mode}:${route.mode === "native" ? `${route.workspaceId}:` : ""}${route.projectId}:${route.associationId}:${route.modelId}`}
    modelId={route.modelId}
    title="Client 3D model"
    issueSession={issueSession}
    onExit={() => window.location.assign(`${exit.pathname}${exit.search}`)}
  />;
}
