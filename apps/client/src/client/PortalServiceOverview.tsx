import { useEffect, useRef, useState } from "react";
import { Card, Loading } from "@ltds/ui";
import { loadPortalServiceCatalogPage, type PortalServiceCatalogItem } from "./portal-api";
import type { RequestAvailability } from "./RequestAvailability";
import "./PortalServiceOverview.css";

export function PortalServiceOverview({ contextKey, workspaceId, expectedAssignment, requestV2, availability, onStartRequest }: {
  contextKey: string;
  workspaceId: string | null;
  expectedAssignment: Readonly<{ sourceId: string; subjectType: "organization" | "standalone_client"; subjectPublicId: string }> | null;
  requestV2: boolean;
  availability: RequestAvailability;
  onStartRequest: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "unassigned" | "error">("idle");
  const [services, setServices] = useState<PortalServiceCatalogItem[]>([]);
  const [loadedProof, setLoadedProof] = useState("");
  const [incomplete, setIncomplete] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const canLoad = requestV2 && expectedAssignment !== null && availability.state === "ready"
    && availability.data?.workspaceId === workspaceId
    && availability.data.root.canStartRequest;
  const proofKey = JSON.stringify([contextKey, workspaceId, expectedAssignment?.sourceId,
    expectedAssignment?.subjectType, expectedAssignment?.subjectPublicId]);
  const showReady = canLoad && state === "ready" && loadedProof === proofKey;

  useEffect(() => {
    const current = ++sequence.current;
    setServices([]); setIncomplete(false); setLoadedProof("");
    if (!canLoad) { setState("idle"); return; }
    const controller = new AbortController();
    setState("loading");
    loadPortalServiceCatalogPage(null, null, controller.signal).then(page => {
      if (controller.signal.aborted || current !== sequence.current) return;
      if (!page.assignment || page.assignment.sourceId !== expectedAssignment!.sourceId
        || page.assignment.subjectType !== expectedAssignment!.subjectType
        || page.assignment.subjectPublicId !== expectedAssignment!.subjectPublicId) {
        setServices([]); setIncomplete(false); setState("unassigned"); return;
      }
      setServices(page.services); setIncomplete(!page.complete || page.nextCursor !== null);
      setLoadedProof(proofKey); setState("ready");
    }).catch(() => {
      if (!controller.signal.aborted && current === sequence.current) setState("error");
    });
    return () => { controller.abort(); sequence.current += 1; };
  }, [canLoad, contextKey, expectedAssignment?.sourceId, expectedAssignment?.subjectType,
    expectedAssignment?.subjectPublicId, proofKey, revision]);

  if (!requestV2 || expectedAssignment === null || state === "unassigned"
    || state === "ready" && !showReady && availability.state === "ready"
    || availability.state === "ready" && (!availability.data?.root.canStartRequest
      || availability.data.workspaceId !== workspaceId)) return null;
  return <Card title="Assigned services" className="portal-service-overview">
    {availability.state === "loading" && <p role="status">Checking assigned services…</p>}
    {availability.state === "error" && <p role="status">Assigned services are unavailable until request access can be verified.</p>}
    {state === "loading" && <Loading />}
    {state === "error" && <div className="portal-inline-error" role="alert"><p>Assigned services could not be loaded. No request was started.</p><button type="button" className="button-ghost" onClick={() => setRevision(value => value + 1)}>Retry assigned services</button></div>}
    {showReady && <>
      <p className="portal-card-intro">Services currently assigned to this workspace. Choose Start a request to define the service, location, timing, and deliverables.</p>
      {services.length > 0 ? <ul className="portal-service-overview-list">{services.map(service => <li key={`${service.publicId}:${service.sourceVersion}`}>
        <span>{service.category}</span><strong>{service.name}</strong><p>{service.summary}</p>
      </li>)}</ul> : <p>No assigned services are available on this page.</p>}
      {incomplete && <p className="portal-service-overview-note">Showing the first page of assigned services. The request form contains the complete service library.</p>}
      <button type="button" className="button-orange" onClick={onStartRequest}>Start a request</button>
    </>}
  </Card>;
}
