import type { ViewerShellSessionGrant } from "@ltds/shared";
import { openViewerWindow, validateViewerSessionModel } from "@ltds/ui";
import { useRef, useState } from "react";
import { api, setCsrf } from "./api";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

/** The exact native client-project target the server returned. Never derived from labels. */
export type NativeViewerTarget = {
  sourceId: string; workspaceId: string; projectPublicId: string;
  projectId: string; generationId: string; sourceVersion: string;
};
const TARGET_FIELDS = ["sourceId", "workspaceId", "projectPublicId", "projectId", "generationId", "sourceVersion"] as const;

export type OperationsViewerShellRoute = { associationId: string; modelId: string; native?: NativeViewerTarget };

export function validNativeViewerTarget(value: Partial<Record<keyof NativeViewerTarget, unknown>>): value is NativeViewerTarget {
  return typeof value.sourceId === "string" && SOURCE.test(value.sourceId)
    && typeof value.workspaceId === "string" && opaque.test(value.workspaceId)
    && typeof value.projectPublicId === "string" && value.projectPublicId.length >= 1 && value.projectPublicId.length <= 200
    && typeof value.projectId === "string" && opaque.test(value.projectId)
    && typeof value.generationId === "string" && opaque.test(value.generationId)
    && typeof value.sourceVersion === "string" && value.sourceVersion.length >= 1 && value.sourceVersion.length <= 200;
}

export function operationsViewerShellPath(route: OperationsViewerShellRoute): string {
  const base = `/viewer/session/${route.native ? "native/" : ""}${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
  if (!route.native) return base;
  const query = new URLSearchParams();
  for (const field of TARGET_FIELDS) query.set(field, route.native[field]);
  return `${base}?${query.toString()}`;
}

export function parseOperationsViewerShellRoute(pathname: string, search = ""): OperationsViewerShellRoute | null {
  const match = /^\/viewer\/session\/(native\/)?([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const [associationId, modelId] = match.slice(2).map(value => decodeURIComponent(value!));
    if (!associationId || !modelId || ![associationId, modelId].every(value => opaque.test(value))) return null;
    if (!match[1]) return { associationId, modelId };
    const params = new URLSearchParams(search);
    if ([...params.keys()].length !== TARGET_FIELDS.length || TARGET_FIELDS.some(field => params.getAll(field).length !== 1)) return null;
    const native = Object.fromEntries(TARGET_FIELDS.map(field => [field, params.get(field)])) as Partial<Record<keyof NativeViewerTarget, unknown>>;
    return validNativeViewerTarget(native) ? { associationId, modelId, native } : null;
  } catch {
    return null;
  }
}

export function OperationsViewerShell({ route }: { route: OperationsViewerShellRoute }) {
  const bootstrap = useRef<Promise<void> | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const ensureAuthenticatedSession = () => {
    if (bootstrap.current) return bootstrap.current;
    const request = api<{ csrfToken?: unknown }>("/api/session").then(session => {
      if (typeof session.csrfToken !== "string" || !session.csrfToken)
        throw new Error("Operations session did not provide request protection");
      setCsrf(session.csrfToken);
    }).catch(error => {
      if (bootstrap.current === request) bootstrap.current = null;
      throw error;
    });
    bootstrap.current = request;
    return request;
  };
  const native = route.native;
  const openViewer = async () => {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      await openViewerWindow<ViewerShellSessionGrant>({
        modelId: route.modelId,
        title: "Operations 3D model",
        issueSession: async idempotencyKey => {
          await ensureAuthenticatedSession();
          // A native link is opened only against its exact returned target; there is no legacy fallback.
          const session = native
            ? await api<ViewerShellSessionGrant>(`/api/viewer/native-associations/${encodeURIComponent(route.associationId)}/session`,
              { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(native) })
            : await api<ViewerShellSessionGrant>(`/api/viewer/associations/${encodeURIComponent(route.associationId)}/session`,
              { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
          // Validate before the Viewer tab navigates, including every silent renewal.
          return validateViewerSessionModel(session, route.modelId);
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "3D Viewer authorization is temporarily unavailable");
    } finally {
      setOpening(false);
    }
  };

  return <main className="viewer-shell-page" aria-label="3D Viewer">
    <section className="card">
      <h1>Open 3D Viewer</h1>
      <p>This model opens in the full Viewer workspace. Your model access is checked again when the Viewer session is created and renewed.</p>
      {error && <p className="viewer-session-error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="button-orange" disabled={opening} onClick={() => void openViewer()}>
          {opening ? "Opening Viewer…" : "Open full Viewer"}
        </button>
        <button type="button" className="button-ghost" onClick={() => window.location.assign("/viewer")}>Back to models</button>
      </div>
    </section>
  </main>;
}
