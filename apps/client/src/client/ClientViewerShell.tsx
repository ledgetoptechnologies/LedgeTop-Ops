import { useCallback, useMemo, useState } from "react";
import { Card } from "@ltds/ui";
import { createPortalViewerSession, loadPortalBootstrap, type PortalViewerSession } from "./portal-api";
import { createNativeViewerSession, loadNativeViewerWork, openNativeViewerTaskSession } from "./native-portal-api";
import { clientProjectPath } from "./portal-route";
import { readClientViewerUnits } from "./viewer-units-preference";
import { createViewerSessionIssuer, openClientViewerWindowWithIssuer, viewerLaunchFailureMessage } from "./viewer-window-launch";

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
  return <ProjectViewerLaunch key={`${route.mode}:${route.mode === "native" ? route.workspaceId : "legacy"}:${route.projectId}:${route.associationId}:${route.modelId}`} route={route} />;
}

function ProjectViewerLaunch({ route }: { route: Exclude<ClientViewerShellRoute, { mode: "direct" }> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const issueSession = useCallback(async (key: string) => {
    if (route.mode === "legacy")
      return createPortalViewerSession(route.projectId, route.associationId, key, readClientViewerUnits());
    const bootstrap = await loadPortalBootstrap(undefined, route.workspaceId);
    if (bootstrap.resourceMode !== "native" || bootstrap.workspace.id !== route.workspaceId || bootstrap.capabilities.viewer !== true)
      throw Object.assign(new Error("This 3D model is no longer available for the selected client."), { status: 404 });
    return createNativeViewerSession(bootstrap, route.projectId, route.associationId, key, readClientViewerUnits());
  }, [route]);
  const issue = useMemo(() => createViewerSessionIssuer(issueSession, route.modelId), [issueSession, route.modelId]);
  const exit = new URL(clientProjectPath(route.projectId), window.location.origin);
  exit.searchParams.set("tab", "models");
  if (route.mode === "native") exit.searchParams.set("workspace", route.workspaceId);
  const launch = () => {
    if (busy) return;
    setBusy(true); setMessage("Opening secure 3D Viewer…");
    // openClientViewerWindow reserves the top-level tab synchronously in this click handler.
    void openClientViewerWindowWithIssuer({ title: "Client 3D model", issueSession: issue, onStatus: (_status, text) => setMessage(text) })
      .then(result => setMessage(result.openedIn === "new-tab"
        ? "Viewer opened in a new tab. Keep this portal tab open to renew the session."
        : "The popup was blocked; Viewer opened here without automatic renewal. Reopen it when the session expires."))
      .catch(caught => setMessage(viewerLaunchFailureMessage(caught)))
      .finally(() => setBusy(false));
  };
  return <section className="viewer-shell-page" aria-label="3D Viewer launch">
    <Card title="Secure 3D Viewer">
      <p>This link opens the model in a full-page Viewer window.</p>
      {message && <p role="status" aria-live="polite">{message}</p>}
      <div className="actions">
        <button type="button" className="button-orange" disabled={busy} onClick={launch}>{busy ? "Opening…" : "Open 3D model"}</button>
        <button type="button" className="button-ghost" onClick={() => window.location.assign(`${exit.pathname}${exit.search}`)}>Back to models</button>
      </div>
    </Card>
  </section>;
}

type DirectTaskSession = PortalViewerSession & { modelId: string };
/** The direct task’s first authorized session identifies the model and pins later renewals. */
function DirectTaskViewerShell({ route }: { route: Extract<ClientViewerShellRoute, { mode: "direct" }> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Verify the client’s direct-sharing endpoint inside the already-reserved tab, then request
  // the exact grant/task session. The first authorized session binds model identity for renewal.
  const issueSession = useCallback(async (key: string) => {
    try { await loadNativeViewerWork(route.workspaceId, null); }
    catch (caught) {
      const status = (caught as { status?: number }).status ?? 0;
      // 403/404 means direct sharing can't be checked for this account, which isn't the same as "no longer shared".
      throw Object.assign(new Error("Direct sharing could not be checked."), { status, sharingUnchecked: status === 403 || status === 404 });
    }
    return openNativeViewerTaskSession(route.workspaceId, route.grantId, route.taskId, readClientViewerUnits(), key);
  }, [route.workspaceId, route.grantId, route.taskId]);
  const issue = useMemo(() => createViewerSessionIssuer(issueSession), [issueSession]);
  const launch = () => {
    if (busy) return;
    setBusy(true); setMessage("Opening secure 3D Viewer…");
    void openClientViewerWindowWithIssuer({ title: "Client 3D model", issueSession: issue, onStatus: (_status, text) => setMessage(text) })
      .then(result => setMessage(result.openedIn === "new-tab"
        ? "Viewer opened in a new tab. Keep this portal tab open to renew the session."
        : "The popup was blocked; Viewer opened here without automatic renewal. Reopen it when the session expires."))
      .catch(caught => setMessage(viewerLaunchFailureMessage(caught)))
      .finally(() => setBusy(false));
  };
  return <section className="viewer-shell-page" aria-label="3D Viewer launch"><Card title="Secure 3D Viewer">
    <p>This 3D model opens in a full-page Viewer window.</p>
    {message && <p role="status" aria-live="polite">{message}</p>}
    <div className="actions">
      <button type="button" className="button-orange" disabled={busy} onClick={launch}>{busy ? "Opening…" : "Open 3D model"}</button>
      <button type="button" className="button-ghost" onClick={() => window.location.assign("/portal")}>Back</button>
    </div>
  </Card></section>;
}
