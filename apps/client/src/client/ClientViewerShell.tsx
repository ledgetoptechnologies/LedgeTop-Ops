import { RenewableViewerShell } from "@ltds/ui";
import { createPortalViewerSession } from "./portal-api";
import { clientProjectPath } from "./portal-route";
import { readClientViewerUnits } from "./viewer-units-preference";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type ClientViewerShellRoute = { projectId: string; associationId: string; modelId: string };

export function clientViewerShellPath(route: ClientViewerShellRoute): string {
  return `/portal/viewer/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function parseClientViewerShellRoute(pathname: string): ClientViewerShellRoute | null {
  const match = /^\/portal\/viewer\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const [projectId, associationId, modelId] = match.slice(1).map(value => decodeURIComponent(value!));
    return projectId && associationId && modelId && [projectId, associationId, modelId].every(value => opaque.test(value))
      ? { projectId, associationId, modelId }
      : null;
  } catch {
    return null;
  }
}

export function ClientViewerShell({ route }: { route: ClientViewerShellRoute }) {
  return <RenewableViewerShell
    modelId={route.modelId}
    title="Client 3D model"
    issueSession={key => createPortalViewerSession(route.projectId, route.associationId, key, readClientViewerUnits())}
    onExit={() => window.location.assign(clientProjectPath(route.projectId))}
  />;
}
