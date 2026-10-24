import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Loading, RenewableViewerShell } from "@ltds/ui";
import { createPortalViewerSession, loadPortalBootstrap, type PortalViewerSession } from "./portal-api";
import { createNativeViewerSession, openNativeViewerTaskSession } from "./native-portal-api";
import { clientProjectPath } from "./portal-route";
import { readClientViewerUnits } from "./viewer-units-preference";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const projectCoordinate = /^[^\u0000-\u001f\u007f]{1,256}$/;

export type ClientViewerShellRoute =
  | { mode: "legacy"; projectId: string; associationId: string; modelId: string }
  | { mode: "native"; workspaceId: string; projectId: string; associationId: string; modelId: string }
  /** A task shared directly with one client account; the grant, not a project, scopes it. */
  | { mode: "direct"; workspaceId: string; grantId: string; taskId: string };

/** The project a model route belongs to; direct task grants carry none. */
export function clientViewerRouteProjectId(route: ClientViewerShellRoute | null): string | null {
  return route && route.mode !== "direct" ? route.projectId : null;
}
/** The exact client account a route pins its bootstrap to, if any. */
export function clientViewerRouteWorkspaceId(route: ClientViewerShellRoute | null): string | null {
  return route && route.mode !== "legacy" ? route.workspaceId : null;
}

export function clientViewerShellPath(route: Omit<Extract<ClientViewerShellRoute, { mode: "legacy" }>, "mode">): string {
  return `/portal/viewer/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function nativeClientViewerShellPath(route: Omit<Extract<ClientViewerShellRoute, { mode: "native" }>, "mode">): string {
  return `/portal/viewer/native/${encodeURIComponent(route.workspaceId)}/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function directClientViewerShellPath(route: Omit<Extract<ClientViewerShellRoute, { mode: "direct" }>, "mode">): string {
  return `/portal/viewer/${encodeURIComponent(route.grantId)}/tasks/${encodeURIComponent(route.taskId)}?${new URLSearchParams({ workspace: route.workspaceId })}`;
}

export function parseClientViewerShellRoute(pathname: string, search = ""): ClientViewerShellRoute | null {
  // Checked before the legacy three-segment form, whose middle segment would otherwise read "tasks" as an association.
  const direct = /^\/portal\/viewer\/([^/]+)\/tasks\/([^/]+)$/.exec(pathname);
  if (direct) {
    try {
      const [grantId, taskId] = direct.slice(1).map(value => decodeURIComponent(value!));
      const workspaceId = new URLSearchParams(search).get("workspace") ?? "";
      return grantId && taskId && opaque.test(grantId) && opaque.test(taskId) && opaque.test(workspaceId)
        ? { mode: "direct", workspaceId, grantId, taskId }
        : null;
    } catch {
      return null;
    }
  }
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
  if (route.mode === "direct") return <DirectTaskViewerShell key={`${route.workspaceId}:${route.grantId}:${route.taskId}`} route={route} />;
  const issueSession = async (key: string) => {
    if (route.mode === "legacy")
      return createPortalViewerSession(route.projectId, route.associationId, key, readClientViewerUnits());
    const bootstrap = await loadPortalBootstrap(undefined, route.workspaceId);
    if (bootstrap.resourceMode !== "native" || bootstrap.workspace.id !== route.workspaceId || bootstrap.capabilities.viewer !== true)
      throw new Error("This 3D model is no longer available for the selected client.");
    return createNativeViewerSession(bootstrap, route.projectId, route.associationId, key, readClientViewerUnits());
  };
  const exit = new URL(clientProjectPath(route.projectId), window.location.origin);
  exit.searchParams.set("tab", "models");
  if (route.mode === "native") exit.searchParams.set("workspace", route.workspaceId);
  return <RenewableViewerShell
    routeKey={`${route.mode}:${route.mode === "native" ? `${route.workspaceId}:` : ""}${route.projectId}:${route.associationId}:${route.modelId}`}
    modelId={route.modelId}
    title="Client 3D model"
    issueSession={issueSession}
    onExit={() => window.location.assign(`${exit.pathname}${exit.search}`)}
  />;
}

type DirectTaskSession = PortalViewerSession & { modelId: string };
/**
 * The model behind a direct task grant is only known from its first session, so that
 * first session is issued here and handed to the shared renewable shell, which then
 * renews by posting to the same exact account, grant and task with a fresh key.
 */
function DirectTaskViewerShell({ route }: { route: Extract<ClientViewerShellRoute, { mode: "direct" }> }) {
  const [first, setFirst] = useState<DirectTaskSession | null>(null);
  const [error, setError] = useState("");
  // A failed first issuance keeps its key, so an ambiguous response is retried without minting a second grant.
  const pendingKey = useRef<string | null>(null), inflight = useRef<Promise<void> | null>(null), handedOff = useRef<DirectTaskSession | null>(null);
  const issue = useCallback((key: string) => openNativeViewerTaskSession(route.workspaceId, route.grantId, route.taskId, readClientViewerUnits(), key), [route.workspaceId, route.grantId, route.taskId]);
  const start = useCallback(() => {
    if (inflight.current) return inflight.current;
    setError("");
    const key = pendingKey.current ?? crypto.randomUUID(); pendingKey.current = key;
    const request = issue(key).then(session => { pendingKey.current = null; handedOff.current = session; setFirst(session); },
      caught => { setError(caught instanceof Error ? caught.message : "3D Viewer authorization is temporarily unavailable"); })
      .finally(() => { inflight.current = null; });
    inflight.current = request;
    return request;
  }, [issue]);
  useEffect(() => { void start(); }, [start]);
  const exit = () => window.location.assign("/portal/dashboard");
  if (!first)
    return error
      ? <section className="viewer-shell-page" aria-label="3D Viewer"><Card title="Secure 3D Viewer"><p className="viewer-session-error" role="alert">{error}</p><div className="actions"><button type="button" className="button-orange" onClick={() => void start()}>Retry secure session</button><button type="button" className="button-ghost" onClick={exit}>Back</button></div></Card></section>
      : <section className="viewer-shell-page" aria-label="3D Viewer"><Loading /></section>;
  return <RenewableViewerShell
    routeKey={`direct:${route.workspaceId}:${route.grantId}:${route.taskId}:${first.modelId}`}
    modelId={first.modelId}
    title="Client 3D model"
    issueSession={key => {
      // The shell's first issuance reuses the session issued above; every renewal posts again with its fresh key.
      const ready = handedOff.current; handedOff.current = null;
      return ready ? Promise.resolve(ready) : issue(key);
    }}
    onExit={exit}
  />;
}
