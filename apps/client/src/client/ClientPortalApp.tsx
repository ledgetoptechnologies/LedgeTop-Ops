import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Brand, Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import {
  createPortalServiceRequest,
  loadPortalBootstrap,
  loadPortalDeliveries,
  type PortalBootstrap,
  type PortalDelivery,
  type PortalProject,
  type PortalServiceRequest,
  type PortalServiceRequestStatus,
} from "./portal-api";
import { clientPortalPath, parseClientPortalRoute, type ClientPortalPage } from "./portal-route";
import { MapAreaSelector, type PortalAreaGeoJson } from "./MapAreaSelector";

type ReadyPage = Exclude<ClientPortalPage, "not-found">;
type PortalGate =
  | { status: "loading" }
  | { status: "blocked"; title: string; detail: string }
  | { status: "ready"; data: PortalBootstrap };

const navigation: Array<{ page: ReadyPage; label: string }> = [
  { page: "dashboard", label: "Dashboard" },
  { page: "projects", label: "Projects" },
  { page: "deliveries", label: "Deliveries" },
  { page: "requests", label: "Requests" },
  { page: "account", label: "Account" },
];

function blockedPortal(caught: unknown): Extract<PortalGate, { status: "blocked" }> {
  const error = caught as RequestError;
  if (error.status === 404) {
    return { status: "blocked", title: "Portal unavailable", detail: "The client portal is not enabled for this site." };
  }
  if (error.status === 401) {
    return {
      status: "blocked",
      title: "Client sign-in is not available yet",
      detail: "LTDS must approve and connect an identity provider before client sign-in can begin.",
    };
  }
  if (error.status === 403) {
    return { status: "blocked", title: "Access not provisioned", detail: "Your verified identity is not linked to an active client account." };
  }
  if (error.status === 503) {
    return { status: "blocked", title: "Portal configuration incomplete", detail: "Client portal access is not ready on this site." };
  }
  return { status: "blocked", title: "Portal temporarily unavailable", detail: "We could not load the client portal. Please try again later." };
}

function formatDate(value: string | null): string {
  if (!value) return "No date set";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusLabel(status: PortalServiceRequestStatus): string {
  return status.replace("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}

function statusTone(status: PortalServiceRequestStatus): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed" || status === "accepted") return "success";
  if (status === "cancelled" || status === "declined") return "danger";
  if (status === "submitted") return "warning";
  return "neutral";
}

function PortalBoundary({ children }: { children: ReactNode }) {
  return (
    <div className="client-portal-boundary">
      <header className="client-portal-gate-header"><Brand product="Client portal" /></header>
      <main className="client-portal-gate-main">{children}</main>
    </div>
  );
}

function RequestList({ requests, projects, limit }: { requests: PortalServiceRequest[]; projects: PortalProject[]; limit?: number }) {
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.projectName])), [projects]);
  const visible = limit ? requests.slice(0, limit) : requests;
  if (visible.length === 0) return <EmptyState title="No service requests" detail="Requests you submit will appear here." />;
  return (
    <div className="portal-request-list">
      {visible.map(request => (
        <article key={request.id} className="portal-request-row">
          <div>
            <strong>{request.title}</strong>
            <span>{projectNames.get(request.projectId) || "Authorized project"} · {request.requestType === "flight" ? "Flight" : "Service"}</span>
          </div>
          <StatusPill tone={statusTone(request.status)}>{statusLabel(request.status)}</StatusPill>
          <time>{formatDate(request.createdAt)}</time>
        </article>
      ))}
    </div>
  );
}

function ServiceRequestForm({
  projects,
  onCreated,
  mapboxPublicToken,
}: {
  projects: PortalProject[];
  onCreated: (request: PortalServiceRequest) => void;
  mapboxPublicToken: string | null;
}) {
  const eligibleProjects = projects.filter(project => project.canRequestService);
  const [projectId, setProjectId] = useState(eligibleProjects[0]?.id || "");
  const [requestType, setRequestType] = useState<"flight" | "service">("flight");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [location, setLocation] = useState("");
  const [preferredStartAt, setPreferredStartAt] = useState("");
  const [serviceCategory, setServiceCategory] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [siteContactName, setSiteContactName] = useState("");
  const [siteContactEmail, setSiteContactEmail] = useState("");
  const [siteContactPhone, setSiteContactPhone] = useState("");
  const [desiredCompletionAt, setDesiredCompletionAt] = useState("");
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [areaGeoJson, setAreaGeoJson] = useState<PortalAreaGeoJson | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!eligibleProjects.some(project => project.id === projectId)) setProjectId(eligibleProjects[0]?.id || "");
  }, [eligibleProjects, projectId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const request = await createPortalServiceRequest({
        projectId,
        requestType,
        title,
        details,
        location: location.trim() || null,
        preferredStartAt: preferredStartAt ? new Date(preferredStartAt).toISOString() : null,
        serviceCategory: serviceCategory.trim() || null,
        deliverables: deliverables.trim() || null,
        siteContactName: siteContactName.trim() || null,
        siteContactEmail: siteContactEmail.trim() || null,
        siteContactPhone: siteContactPhone.trim() || null,
        desiredCompletionAt: desiredCompletionAt ? new Date(desiredCompletionAt).toISOString() : null,
        latitude: point?.[1] ?? null,
        longitude: point?.[0] ?? null,
        areaGeoJson,
      }, idempotencyKey);
      onCreated(request);
      setTitle("");
      setDetails("");
      setLocation("");
      setPreferredStartAt("");
      setServiceCategory("");
      setDeliverables("");
      setSiteContactName("");
      setSiteContactEmail("");
      setSiteContactPhone("");
      setDesiredCompletionAt("");
      setPoint(null);
      setAreaGeoJson(null);
      setIdempotencyKey(crypto.randomUUID());
      setMessage({ tone: "success", text: "Request submitted. LTDS will review it shortly." });
    } catch (caught) {
      const error = caught as RequestError;
      const retry = error.status === 429 && error.retryAfterMs
        ? ` Try again in about ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} seconds.`
        : "";
      setMessage({ tone: "error", text: `${error.message || "The request could not be submitted."}${retry}` });
    } finally {
      setSubmitting(false);
    }
  }

  if (eligibleProjects.length === 0) {
    return <EmptyState title="Requesting is not available" detail="No project on this account currently permits new service requests." />;
  }

  return (
    <form className="portal-request-form" onSubmit={submit}>
      <div className="portal-form-grid">
        <label>Project<select value={projectId} onChange={event => setProjectId(event.target.value)} required>
          {eligibleProjects.map(project => <option key={project.id} value={project.id}>{project.projectName}</option>)}
        </select></label>
        <label>Request type<select value={requestType} onChange={event => setRequestType(event.target.value as "flight" | "service")}>
          <option value="flight">Flight request</option>
          <option value="service">Service request</option>
        </select></label>
        <label className="portal-form-wide">Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required /></label>
        <label className="portal-form-wide">Details<textarea value={details} onChange={event => setDetails(event.target.value)} maxLength={5000} rows={5} required /></label>
        <label>Location <span>(optional)</span><input value={location} onChange={event => setLocation(event.target.value)} maxLength={240} /></label>
        <label>Preferred start <span>(optional)</span><input type="datetime-local" value={preferredStartAt} onChange={event => setPreferredStartAt(event.target.value)} /></label>
        <label>Service category <span>(optional)</span><input value={serviceCategory} onChange={event => setServiceCategory(event.target.value)} maxLength={100} placeholder="e.g. aerial imaging" /></label>
        <label>Desired completion <span>(optional)</span><input type="datetime-local" value={desiredCompletionAt} onChange={event => setDesiredCompletionAt(event.target.value)} /></label>
        <label className="portal-form-wide">Requested deliverables <span>(optional)</span><textarea value={deliverables} onChange={event => setDeliverables(event.target.value)} maxLength={2000} rows={3} placeholder="Photos, video, orthomosaic, inspection notes…" /></label>
        <label>Site contact name <span>(optional)</span><input value={siteContactName} onChange={event => setSiteContactName(event.target.value)} maxLength={160} /></label>
        <label>Site contact email <span>(optional)</span><input type="email" value={siteContactEmail} onChange={event => setSiteContactEmail(event.target.value)} maxLength={320} /></label>
        <label>Site contact phone <span>(optional)</span><input type="tel" value={siteContactPhone} onChange={event => setSiteContactPhone(event.target.value)} maxLength={64} /></label>
        <div className="portal-form-wide"><MapAreaSelector value={areaGeoJson} onChange={setAreaGeoJson} token={mapboxPublicToken} point={point} onPoint={setPoint} /></div>
      </div>
      <div className="portal-form-actions">
        <p className={message?.tone === "error" ? "portal-message error" : "portal-message"} aria-live="polite">{message?.text}</p>
        <button className="button-orange" disabled={submitting}>{submitting ? "Submitting…" : "Submit request"}</button>
      </div>
    </form>
  );
}

export function ClientPortalApp({ initialPage }: { initialPage: ClientPortalPage }) {
  const [gate, setGate] = useState<PortalGate>({ status: "loading" });
  const [page, setPage] = useState<ClientPortalPage>(initialPage);
  const [requests, setRequests] = useState<PortalServiceRequest[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [deliveries, setDeliveries] = useState<Record<string, PortalDelivery[] | undefined>>({});
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);

  useEffect(() => {
    let active = true;
    loadPortalBootstrap().then(data => {
      if (!active) return;
      setRequests(data.requests);
      setSelectedProjectId(data.projects[0]?.id || "");
      setGate({ status: "ready", data });
    }).catch(caught => {
      if (active) setGate(blockedPortal(caught));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const route = parseClientPortalRoute(window.location.pathname);
      if (!route.isPortal) window.location.reload();
      else setPage(route.page);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (gate.status !== "ready" || page !== "deliveries" || !selectedProjectId || deliveries[selectedProjectId]) return;
    let active = true;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    loadPortalDeliveries(selectedProjectId).then(result => {
      if (active) setDeliveries(current => ({ ...current, [selectedProjectId]: result }));
    }).catch(() => {
      if (active) setDeliveriesError("Deliveries could not be loaded for this project.");
    }).finally(() => {
      if (active) setDeliveriesLoading(false);
    });
    return () => { active = false; };
  }, [deliveries, gate.status, page, selectedProjectId]);

  function navigate(nextPage: ReadyPage) {
    window.history.pushState({}, "", clientPortalPath(nextPage));
    setPage(nextPage);
  }

  if (gate.status === "loading") {
    return <PortalBoundary><Card><Loading /></Card></PortalBoundary>;
  }
  if (gate.status === "blocked") {
    return <PortalBoundary><Card><EmptyState title={gate.title} detail={gate.detail} /></Card></PortalBoundary>;
  }

  const { account, projects } = gate.data;
  const currentDeliveries = deliveries[selectedProjectId] || [];
  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const onCreated = (created: PortalServiceRequest) => {
    setRequests(current => [created, ...current.filter(request => request.id !== created.id)]);
  };

  let content: ReactNode;
  if (page === "not-found") {
    content = <Card><EmptyState title="Page not found" detail="This client portal page does not exist." /></Card>;
  } else if (page === "dashboard") {
    content = <>
      <section className="portal-welcome"><span className="eyebrow">Client portal</span><h1>Welcome, {account.displayName}</h1><p>Your authorized projects, deliveries, and service requests in one place.</p></section>
      <div className="portal-stat-grid">
        <Card><span className="portal-stat">{projects.length}</span><strong>Projects</strong><button className="portal-text-action" onClick={() => navigate("projects")}>View projects</button></Card>
        <Card><span className="portal-stat">{requests.length}</span><strong>Service requests</strong><button className="portal-text-action" onClick={() => navigate("requests")}>Manage requests</button></Card>
        <Card><span className="portal-stat">{projects.filter(project => project.canRequestService).length}</span><strong>Request-ready projects</strong><button className="portal-text-action" onClick={() => navigate("requests")}>Start a request</button></Card>
      </div>
      <Card title="Recent requests" action={<button className="button-ghost button-small" onClick={() => navigate("requests")}>View all</button>}>
        <RequestList requests={requests} projects={projects} limit={4} />
      </Card>
    </>;
  } else if (page === "projects") {
    content = <><section className="portal-page-heading"><span className="eyebrow">Authorized access</span><h1>Projects</h1><p>Only projects granted to this account appear here.</p></section>
      {projects.length === 0 ? <Card><EmptyState title="No projects available" detail="Your client account has no active project grants." /></Card> : <div className="portal-project-grid">{projects.map(project => <Card key={project.id} className="portal-project-card"><span className="portal-project-ref">{project.externalRef}</span><h2>{project.projectName}</h2><p>{project.clientName}</p><StatusPill tone={project.canRequestService ? "success" : "neutral"}>{project.canRequestService ? "Requests enabled" : "View only"}</StatusPill></Card>)}</div>}
    </>;
  } else if (page === "deliveries") {
    content = <><section className="portal-page-heading"><span className="eyebrow">Authorized access</span><h1>Deliveries</h1><p>Browse delivery records granted through your projects.</p></section>
      <Card title="Project deliveries">
        {projects.length === 0 ? <EmptyState title="No projects available" detail="A project grant is required before deliveries can be listed." /> : <>
          <label className="portal-project-picker">Project<select value={selectedProjectId} onChange={event => setSelectedProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.projectName}</option>)}</select></label>
          {deliveriesLoading ? <Loading /> : deliveriesError ? <p className="portal-message error">{deliveriesError}</p> : currentDeliveries.length === 0 ? <EmptyState title="No active deliveries" detail="No delivery shares are currently granted for this project." /> : <div className="portal-delivery-list">{currentDeliveries.map(delivery => <article key={delivery.shareId}><div><strong>{delivery.label || `${selectedProject?.projectName || "Project"} delivery`}</strong><span>Open this delivery through its existing protected-share workflow.</span></div><div><StatusPill tone={delivery.requiresPassword ? "warning" : "neutral"}>{delivery.requiresPassword ? "Password protected" : "Protected share"}</StatusPill><small>{delivery.expiresAt ? `Expires ${formatDate(delivery.expiresAt)}` : "No expiration"}</small><a className="button-orange button-small" href={delivery.handoffPath}>Open delivery</a></div></article>)}</div>}
          <p className="portal-notice">Opening a delivery keeps its existing link security, expiration, and optional password requirements in place.</p>
        </>}
      </Card>
    </>;
  } else if (page === "requests") {
    content = <><section className="portal-page-heading"><span className="eyebrow">Flight & service</span><h1>Requests</h1><p>Submit a request against a project where your account has permission.</p></section>
      <Card title="New request"><ServiceRequestForm projects={projects} onCreated={onCreated} mapboxPublicToken={gate.data.mapboxPublicToken} /></Card>
      <Card title="Request history"><RequestList requests={requests} projects={projects} /></Card>
    </>;
  } else {
    content = <><section className="portal-page-heading"><span className="eyebrow">Verified account</span><h1>Account</h1><p>Identity details are established only by the server-side authentication integration.</p></section>
      <Card title="Client account" className="portal-account-card"><div className="portal-avatar" aria-hidden="true">{account.displayName.slice(0, 2).toUpperCase()}</div><div><strong>{account.displayName}</strong><p>Authorized client account</p></div></Card>
      <Card title="Sign-in status"><p className="portal-copy">This session was accepted through LTDS's provider-neutral verified identity boundary. Identity-provider selection, enrollment, password recovery, and MFA are not implemented by this portal.</p></Card>
    </>;
  }

  return (
    <div className="client-portal">
      <header className="client-portal-header">
        <Brand product="Client portal" />
        <span className="portal-account-name">{account.displayName}</span>
      </header>
      <div className="client-portal-frame">
        <nav className="client-portal-nav" aria-label="Client portal">
          {navigation.map(item => <a key={item.page} href={clientPortalPath(item.page)} aria-current={page === item.page ? "page" : undefined} onClick={event => { event.preventDefault(); navigate(item.page); }}>{item.label}</a>)}
        </nav>
        <main className="client-portal-main">{content}</main>
      </div>
    </div>
  );
}
