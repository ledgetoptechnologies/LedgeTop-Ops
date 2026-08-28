import { useEffect, useRef, useState } from "react";
import { loadPortalRequestReadiness, type PortalProject, type PortalRequestReadiness, type PortalRequestReadinessReason } from "./portal-api";

export type RequestAvailability = { state: "loading" | "error" | "ready"; data: PortalRequestReadiness | null; retry: () => void };
export function useRequestAvailability(contextKey: string | null, workspaceId: string | null, projectId: string | null = null): RequestAvailability {
  const [result, setResult] = useState<{ key: string; state: "loading" | "error" | "ready"; data: PortalRequestReadiness | null }>({ key: "", state: "loading", data: null });
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const key = JSON.stringify([contextKey, workspaceId, projectId, revision]);
  useEffect(() => {
    const current = ++sequence.current;
    if (contextKey === null) return;
    const controller = new AbortController();
    setResult({ key, state: "loading", data: null });
    loadPortalRequestReadiness(projectId, controller.signal).then(data => {
      if (controller.signal.aborted || current !== sequence.current) return;
      if (data.workspaceId !== workspaceId) throw new Error("Request workspace changed.");
      setResult({ key, state: "ready", data });
    }).catch(() => {
      if (!controller.signal.aborted && current === sequence.current) setResult({ key, state: "error", data: null });
    });
    return () => { controller.abort(); sequence.current += 1; };
  }, [key, contextKey, workspaceId, projectId]);
  return { ...(result.key === key ? result : { state: "loading" as const, data: null }), retry: () => setRevision(value => value + 1) };
}

export function canBeginRequest(readiness: RequestAvailability, projects: PortalProject[]): boolean {
  return readiness.state === "ready" && Boolean(readiness.data && (readiness.data.root.canStartRequest
    || readiness.data.projectRequestsSupported && projects.some(project => project.canRequestService)));
}
export function requestUnavailableReason(reason?: PortalRequestReadinessReason): string {
  if (reason === "catalog_unavailable") return "The service library is not ready for new requests. Your existing requests and saved drafts are unchanged.";
  if (reason === "no_services_assigned") return "No services are currently assigned to this request context. Your existing requests and saved drafts are unchanged.";
  if (reason === "service_assignments_unavailable") return "Assigned services cannot be verified right now. Your existing requests and saved drafts are unchanged; try again shortly.";
  if (reason === "project_unavailable") return "This project is no longer available for a new request in this workspace.";
  if (reason === "request_not_permitted") return "Your current access does not include starting a request for this context.";
  if (reason === "legacy_access_unavailable") return "Service requests are not connected for this workspace yet.";
  return "New requests are temporarily unavailable. Your existing requests and saved drafts are unchanged.";
}
export function RequestAvailabilityMessage({ availability }: { availability: RequestAvailability }) {
  if (availability.state === "loading") return <p role="status">Checking request availability…</p>;
  if (availability.state === "error") return <div className="portal-inline-error" role="alert"><p>Request availability could not be verified. No new request was started.</p><button type="button" className="button-ghost" onClick={availability.retry}>Retry request availability</button></div>;
  return <div className="portal-inline-error" role="status"><p>{requestUnavailableReason(availability.data?.reason)}</p><button type="button" className="button-ghost" onClick={availability.retry}>Check availability again</button></div>;
}
