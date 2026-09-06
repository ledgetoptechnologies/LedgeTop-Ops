import type { ViewerSessionGrant } from "@ltds/shared";
import { RenewableViewerShell } from "@ltds/ui";
import { useRef } from "react";
import { api, setCsrf } from "./api";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type OperationsViewerShellRoute = { associationId: string; modelId: string };

export function operationsViewerShellPath(route: OperationsViewerShellRoute): string {
  return `/viewer/session/${encodeURIComponent(route.associationId)}/${encodeURIComponent(route.modelId)}`;
}

export function parseOperationsViewerShellRoute(pathname: string): OperationsViewerShellRoute | null {
  const match = /^\/viewer\/session\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const [associationId, modelId] = match.slice(1).map(value => decodeURIComponent(value!));
    return associationId && modelId && [associationId, modelId].every(value => opaque.test(value))
      ? { associationId, modelId }
      : null;
  } catch {
    return null;
  }
}

export function OperationsViewerShell({ route }: { route: OperationsViewerShellRoute }) {
  const bootstrap = useRef<Promise<void> | null>(null);
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

  return <RenewableViewerShell
    modelId={route.modelId}
    title="Operations 3D model"
    issueSession={async key => {
      await ensureAuthenticatedSession();
      return api<ViewerSessionGrant>(
        `/api/viewer/associations/${encodeURIComponent(route.associationId)}/session`,
        { method: "POST", headers: { "Idempotency-Key": key } },
      );
    }}
    onExit={() => window.location.assign("/viewer")}
  />;
}
