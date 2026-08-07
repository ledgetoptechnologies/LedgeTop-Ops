import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Brand, Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import type { DeliveryLocationCollection } from "@ltds/shared";
import type { RequestError } from "./bulk-download";
import {
  createPortalChangeRequest,
  createPortalServiceRequest,
  loadPortalBootstrap,
  loadPortalPastDeliveries,
  loadPortalPastDeliveryLocations,
  loadPortalProjectFileLocations,
  loadPortalProjectFiles,
  respondToPortalEstimate,
  updatePortalServiceRequest,
  type PortalBootstrap,
  type PortalFile,
  type PortalFilePage,
  type PortalPoi,
  type PortalProject,
  type PortalServiceRequest,
  type PortalServiceRequestInput,
  type PortalServiceRequestStatus,
} from "./portal-api";
import {
  clientPortalPath,
  clientProjectPath,
  clientRequestNewPath,
  parseClientPortalRoute,
  type ClientPortalPage,
} from "./portal-route";
import { MapAreaSelector } from "./MapAreaSelector";
import { ImageLocationMap } from "./ImageLocationMap";

type TopPage = "dashboard" | "projects" | "deliveries" | "requests" | "account";
type WorkspaceTab = "overview" | "files" | "requests";
type PortalGate =
  | { status: "loading" }
  | { status: "blocked"; title: string; detail: string }
  | { status: "ready"; data: PortalBootstrap };

const navigation: Array<{ page: TopPage; label: string }> = [
  { page: "dashboard", label: "Dashboard" },
  { page: "projects", label: "Projects" },
  { page: "deliveries", label: "Past deliveries" },
  { page: "requests", label: "Service requests" },
  { page: "account", label: "Account" },
];

function blockedPortal(
  caught: unknown,
): Extract<PortalGate, { status: "blocked" }> {
  const error = caught as RequestError;
  if (error.status === 404)
    return {
      status: "blocked",
      title: "Portal unavailable",
      detail: "The client portal is not enabled for this site.",
    };
  if (error.status === 401)
    return {
      status: "blocked",
      title: "Sign in required",
      detail: "Sign in with the client identity provided by LTDS to continue.",
    };
  if (error.status === 403)
    return {
      status: "blocked",
      title: "Access not provisioned",
      detail:
        "Your verified identity is not linked to an active client account. Contact your LTDS representative.",
    };
  if (error.status === 503)
    return {
      status: "blocked",
      title: "Portal configuration incomplete",
      detail: "Client portal access is not ready on this site.",
    };
  return {
    status: "blocked",
    title: "Portal temporarily unavailable",
    detail: "We could not load the client portal. Please try again later.",
  };
}

function formatDate(
  value: string | null | undefined,
  includeTime = true,
): string {
  if (!value) return "Not scheduled";
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        ...(includeTime ? { timeStyle: "short" as const } : {}),
      }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function statusLabel(status: PortalServiceRequestStatus): string {
  if (status === "accepted_pending_pa_linkage")
    return "Accepted · preparing paperwork";
  if (status === "accepted_linked") return "Accepted";
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(
  status: PortalServiceRequestStatus,
): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed" || status === "accepted_linked") return "success";
  if (status === "cancelled" || status === "declined") return "danger";
  if (status === "submitted" || status === "accepted_pending_pa_linkage")
    return "warning";
  return "neutral";
}

function projectStatusLabel(status: string | null): string {
  if (!status) return "Active";
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function PortalBoundary({ children }: { children: ReactNode }) {
  return (
    <div className="client-portal-boundary">
      <header className="client-portal-gate-header">
        <Brand product="Client portal" />
      </header>
      <main className="client-portal-gate-main">{children}</main>
    </div>
  );
}

function FileBrowser({
  load,
  loadLocations,
  mapToken,
  locationScopeLabel,
  emptyTitle,
  emptyDetail,
}: {
  load: (cursor: string | null) => Promise<PortalFilePage>;
  loadLocations: () => Promise<DeliveryLocationCollection>;
  mapToken: string | null;
  locationScopeLabel: string;
  emptyTitle: string;
  emptyDetail: string;
}) {
  const [files, setFiles] = useState<PortalFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<DeliveryLocationCollection | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setFiles([]);
    setCursor(null);
    load(null)
      .then((result) => {
        if (active) {
          setFiles(result.files);
          setCursor(result.cursor);
        }
      })
      .catch(() => {
        if (active) setError("Files could not be loaded. Please try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    let active = true;
    setLocations(null);
    setLocationError(null);
    loadLocations()
      .then((result) => { if (active) setLocations(result); })
      .catch(() => { if (active) setLocationError("Image locations could not be loaded."); });
    return () => { active = false; };
  }, [loadLocations]);
  const more = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await load(cursor);
      setFiles((current) => [...current, ...result.files]);
      setCursor(result.cursor);
    } catch {
      setError("More files could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <div>
      <ImageLocationMap token={mapToken} locations={locations} scopeLabel={locationScopeLabel} />
      {locationError && <p className="portal-message error" role="alert">{locationError}</p>}
      {loading ? <Loading /> : error && files.length === 0 ? (
        <p className="portal-message error" role="alert">{error}</p>
      ) : files.length === 0 ? (
        <EmptyState title={emptyTitle} detail={emptyDetail} />
      ) : <div className="portal-file-list">
        {files.map((file) => (
          <article key={file.id} className="portal-file-row">
            <div className="portal-file-icon" aria-hidden="true">
              {file.contentType?.startsWith("image/")
                ? "IMG"
                : file.name.split(".").pop()?.slice(0, 4).toUpperCase() ||
                  "FILE"}
            </div>
            <div>
              <strong>{file.name}</strong>
              <span>
                {formatBytes(file.size)} · Added {formatDate(file.uploadedAt)}
              </span>
            </div>
            <div className="portal-file-actions">
              {file.previewPath && (
                <a
                  className="button-ghost button-small"
                  href={file.previewPath}
                  target="_blank"
                  rel="noreferrer"
                >
                  Preview
                </a>
              )}
              <a
                className="button-orange button-small"
                href={file.downloadPath}
              >
                Download
              </a>
            </div>
          </article>
        ))}
      </div>}
      {error && (
        <p className="portal-message error" role="alert">
          {error}
        </p>
      )}
      {cursor && (
        <div className="portal-load-more">
          <button
            className="button-ghost"
            onClick={() => void more()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function QuoteSummary({ request }: { request: PortalServiceRequest }) {
  const quote = request.acceptedQuote;
  if (!quote) return null;
  return (
    <aside className="portal-quote-summary">
      <span>Verified accepted quote</span>
      <strong>
        {quote.total === null
          ? "Amount unavailable"
          : new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: quote.currency || "USD",
            }).format(quote.total)}
      </strong>
      <small>
        {quote.documentNumber || "Document number unavailable"} · {quote.status} · Verified{" "}
        {formatDate(quote.verifiedAt)}
      </small>
    </aside>
  );
}

function EstimateSummary({
  request,
  onRespond,
}: {
  request: PortalServiceRequest;
  onRespond?: (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => void;
}) {
  const estimate = request.operationalEstimate;
  if (!estimate || estimate.status === "draft") return null;
  return (
    <aside className="portal-estimate-summary">
      <span>Non-binding LTDS operational estimate</span>
      <strong>
        {estimate.amount === null
          ? "Scope proposal"
          : new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: estimate.currency || "USD",
            }).format(estimate.amount)}
      </strong>
      <p>{estimate.scope}</p>
      <small>
        This is not a quote, contract, or invoice. Project Alpha remains the
        financial system of record.
      </small>
      <div>
        <StatusPill
          tone={
            estimate.status === "accepted"
              ? "success"
              : estimate.status === "change_requested"
                ? "warning"
                : "neutral"
          }
        >
          {estimate.status === "ready"
            ? "Estimate ready"
            : estimate.status.replaceAll("_", " ")}
        </StatusPill>
        {estimate.status === "ready" && onRespond && (
          <>
            <button
              className="button-orange button-small"
              onClick={() => onRespond(request, "accept")}
            >
              Accept estimate
            </button>
            <button
              className="button-ghost button-small"
              onClick={() => onRespond(request, "request_change")}
            >
              Request changes
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function RequestList({
  requests,
  projects,
  limit,
  onEdit,
  onChange,
  onEstimateRespond,
}: {
  requests: PortalServiceRequest[];
  projects: PortalProject[];
  limit?: number;
  onEdit?: (request: PortalServiceRequest) => void;
  onChange?: (request: PortalServiceRequest) => void;
  onEstimateRespond?: (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => void;
}) {
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.projectName])),
    [projects],
  );
  const visible = limit ? requests.slice(0, limit) : requests;
  if (visible.length === 0)
    return (
      <EmptyState
        title="No service requests"
        detail="Requests you submit will appear here."
      />
    );
  return (
    <div className="portal-request-list">
      {visible.map((request) => (
        <article key={request.id} className="portal-request-row">
          <div className="portal-request-main">
            <div>
              <strong>{request.title}</strong>
              <span>
                {request.projectId
                  ? projectNames.get(request.projectId) || "Authorized project"
                  : "New or one-off service"}{" "}
                · Service request
                {request.parentRequestId ? " · Linked change request" : ""}
              </span>
            </div>
            <EstimateSummary request={request} onRespond={onEstimateRespond} />
            <QuoteSummary request={request} />
          </div>
          <div className="portal-request-state">
            <StatusPill tone={statusTone(request.status)}>
              {statusLabel(request.status)}
            </StatusPill>
            <time>{formatDate(request.createdAt)}</time>
          </div>
          {(onEdit || onChange) && (
            <div className="portal-request-actions">
              {request.status === "submitted" && onEdit && (
                <button
                  className="button-ghost button-small"
                  onClick={() => onEdit(request)}
                >
                  Edit
                </button>
              )}
              {request.status !== "submitted" &&
                !["declined", "cancelled", "completed"].includes(
                  request.status,
                ) &&
                onChange && (
                  <button
                    className="button-ghost button-small"
                    onClick={() => onChange(request)}
                  >
                    Request a change
                  </button>
                )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function ServiceRequestForm({
  projects,
  projectId: fixedProjectId,
  initial,
  changeOf,
  onSaved,
  onCancel,
  mapboxPublicToken,
}: {
  projects: PortalProject[];
  projectId?: string;
  initial?: PortalServiceRequest;
  changeOf?: PortalServiceRequest;
  onSaved: (request: PortalServiceRequest) => void;
  onCancel?: () => void;
  mapboxPublicToken: string | null;
}) {
  const eligibleProjects = projects.filter(
    (project) => project.canRequestService,
  );
  const source = initial || changeOf;
  const [projectId, setProjectId] = useState<string>(
    fixedProjectId ?? source?.projectId ?? "",
  );
  const [requestType] = useState<"flight" | "service">(
    source?.requestType ?? "service",
  );
  const [title, setTitle] = useState(
    changeOf ? `Service update: ${changeOf.title}` : (source?.title ?? ""),
  );
  const [details, setDetails] = useState(
    changeOf ? "" : (source?.details ?? ""),
  );
  const [location, setLocation] = useState(source?.location ?? "");
  const [preferredStartAt, setPreferredStartAt] = useState(
    source?.preferredStartAt?.slice(0, 16) ?? "",
  );
  const [serviceCategory, setServiceCategory] = useState(
    source?.serviceCategory ?? "",
  );
  const [deliverables, setDeliverables] = useState(source?.deliverables ?? "");
  const [siteContactName, setSiteContactName] = useState(
    source?.siteContactName ?? "",
  );
  const [siteContactEmail, setSiteContactEmail] = useState(
    source?.siteContactEmail ?? "",
  );
  const [siteContactPhone, setSiteContactPhone] = useState(
    source?.siteContactPhone ?? "",
  );
  const [desiredCompletionAt, setDesiredCompletionAt] = useState(
    source?.desiredCompletionAt?.slice(0, 16) ?? "",
  );
  const [points, setPoints] = useState<PortalPoi[]>(
    source?.poiPoints ??
      (source?.longitude != null && source.latitude != null
        ? [{ longitude: source.longitude, latitude: source.latitude }]
        : []),
  );
  const [areaGeoJson, setAreaGeoJson] = useState(source?.areaGeoJson ?? null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const mode = initial ? "edit" : changeOf ? "change" : "create";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || saved) return;
    setSubmitting(true);
    setMessage(null);
    const input: PortalServiceRequestInput = {
      projectId: projectId || null,
      parentRequestId: changeOf?.id ?? null,
      requestType,
      title,
      details,
      location: location.trim() || null,
      preferredStartAt: preferredStartAt
        ? new Date(preferredStartAt).toISOString()
        : null,
      serviceCategory: serviceCategory.trim() || null,
      deliverables: deliverables.trim() || null,
      siteContactName: siteContactName.trim() || null,
      siteContactEmail: siteContactEmail.trim() || null,
      siteContactPhone: siteContactPhone.trim() || null,
      desiredCompletionAt: desiredCompletionAt
        ? new Date(desiredCompletionAt).toISOString()
        : null,
      latitude: points[0]?.latitude ?? null,
      longitude: points[0]?.longitude ?? null,
      poiPoints: points,
      areaGeoJson,
    };
    try {
      const saved =
        mode === "edit"
          ? await updatePortalServiceRequest(
              initial!.id,
              input,
              initial!.updatedAt,
              idempotencyKey,
            )
          : mode === "change"
            ? await createPortalChangeRequest(
                changeOf!.id,
                input,
                idempotencyKey,
              )
            : await createPortalServiceRequest(input, idempotencyKey);
      onSaved(saved);
      setSaved(true);
      setMessage({
        tone: "success",
        text:
          mode === "edit"
            ? "Request updated."
            : mode === "change"
              ? "Change request submitted."
              : "Request submitted. LTDS will review it shortly.",
      });
    } catch (caught) {
      const error = caught as RequestError;
      const retry =
        error.status === 429 && error.retryAfterMs
          ? ` Try again in about ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} seconds.`
          : "";
      setMessage({
        tone: "error",
        text: `${error.message || "The request could not be saved."}${retry}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="portal-request-form" onSubmit={submit}>
      <div className="portal-request-layout">
        <div className="portal-request-map">
          <MapAreaSelector
            value={areaGeoJson}
            onChange={setAreaGeoJson}
            token={mapboxPublicToken}
            points={points}
            onPoints={setPoints}
            locationLabel={location}
            onLocationLabel={setLocation}
          />
        </div>
        <div className="portal-request-fields">
          <header className="portal-request-section-heading">
            <span>Request details</span>
            <h3>Tell us what you need</h3>
          </header>
          {!fixedProjectId && (
            <label>
              Project context
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">New or one-off service</option>
                {eligibleProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.projectName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="portal-project-context">
            {projectId
              ? `Existing project: ${eligibleProjects.find((project) => project.id === projectId)?.projectName || "authorized project"}. LTDS will triage this request in that project context.`
              : "New or one-off service. LTDS will review and triage this request before any project setup."}{" "}
            This screen does not create or change a Project Alpha project.
          </p>
          <label>
            Service request title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              required
              placeholder="Spring site progress imagery"
            />
          </label>
          <label>
            What do you need?
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              maxLength={5000}
              rows={5}
              required
              placeholder={
                changeOf
                  ? "Describe exactly what should change."
                  : "Scope, goals, and any site constraints."
              }
            />
          </label>
          <header className="portal-request-section-heading portal-request-section-divider">
            <span>Planning</span>
            <h3>Schedule and deliverables</h3>
          </header>
          <div className="portal-form-grid">
            <label>
              Location <span>(optional)</span>
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={240}
              />
            </label>
            <label>
              Preferred start <span>(optional)</span>
              <input
                type="datetime-local"
                value={preferredStartAt}
                onChange={(event) => setPreferredStartAt(event.target.value)}
              />
            </label>
            <label>
              Service category <span>(optional)</span>
              <input
                value={serviceCategory}
                onChange={(event) => setServiceCategory(event.target.value)}
                maxLength={100}
                placeholder="Aerial imaging"
              />
            </label>
            <label>
              Desired completion <span>(optional)</span>
              <input
                type="datetime-local"
                value={desiredCompletionAt}
                onChange={(event) => setDesiredCompletionAt(event.target.value)}
              />
            </label>
          </div>
          <label>
            Requested deliverables <span>(optional)</span>
            <textarea
              value={deliverables}
              onChange={(event) => setDeliverables(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Photos, video, orthomosaic, inspection notes…"
            />
          </label>
          <fieldset className="portal-contact-fields">
            <legend>
              On-site contact <span>(optional)</span>
            </legend>
            <label>
              Name
              <input
                value={siteContactName}
                onChange={(event) => setSiteContactName(event.target.value)}
                maxLength={160}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={siteContactEmail}
                onChange={(event) => setSiteContactEmail(event.target.value)}
                maxLength={320}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                value={siteContactPhone}
                onChange={(event) => setSiteContactPhone(event.target.value)}
                maxLength={64}
              />
            </label>
          </fieldset>
        </div>
      </div>
      <div className="portal-form-actions">
        <p
          className={
            message?.tone === "error"
              ? "portal-message error"
              : "portal-message"
          }
          aria-live="polite"
        >
          {message?.text}
        </p>
        {onCancel && (
          <button type="button" className="button-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="button-orange" disabled={submitting || saved}>
          {submitting
            ? "Saving…"
            : saved
              ? "Submitted"
              : mode === "edit"
                ? "Save changes"
                : mode === "change"
                  ? "Submit change request"
                  : "Submit request"}
        </button>
      </div>
    </form>
  );
}

function ProjectWorkspace({
  project,
  requests,
  mapboxPublicToken,
  onSaved,
  onBack,
}: {
  project: PortalProject;
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
  onSaved: (request: PortalServiceRequest) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const projectRequests = requests.filter(
    (request) => request.projectId === project.id,
  );
  const loadFiles = useMemo(
    () => (cursor: string | null) => loadPortalProjectFiles(project.id, cursor),
    [project.id],
  );
  const loadLocations = useMemo(
    () => () => loadPortalProjectFileLocations(project.id),
    [project.id],
  );
  return (
    <>
      <button className="portal-back" onClick={onBack}>
        ← All projects
      </button>
      <section className="portal-project-hero">
        <div>
          <span className="portal-project-ref">{project.externalRef}</span>
          <h1>{project.projectName}</h1>
          <p>{project.clientName}</p>
        </div>
        <StatusPill tone="success">
          {projectStatusLabel(project.status)}
        </StatusPill>
      </section>
      <nav className="portal-workspace-tabs" aria-label="Project workspace">
        {(["overview", "files", "requests"] as WorkspaceTab[]).map((item) => (
          <button
            key={item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => setTab(item)}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <div className="portal-overview-grid">
          <Card title="Project overview">
            <p className="portal-summary">
              {project.summary ||
                "Your LTDS team will add a project summary as work progresses."}
            </p>
            <dl className="portal-detail-list">
              <div>
                <dt>Next milestone</dt>
                <dd>{project.nextMilestone || "To be scheduled"}</dd>
              </div>
              <div>
                <dt>Last update</dt>
                <dd>{formatDate(project.lastUpdateAt)}</dd>
              </div>
              <div>
                <dt>Service address</dt>
                <dd>
                  {project.serviceAddress ||
                    project.siteAddress ||
                    "Not provided"}
                </dd>
              </div>
            </dl>
          </Card>
          <Card title="Project contact">
            <dl className="portal-detail-list">
              <div>
                <dt>Name</dt>
                <dd>{project.projectContactName || "LTDS Operations"}</dd>
              </div>
              {project.projectContactEmail && (
                <div>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${project.projectContactEmail}`}>
                      {project.projectContactEmail}
                    </a>
                  </dd>
                </div>
              )}
              {project.projectContactPhone && (
                <div>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${project.projectContactPhone}`}>
                      {project.projectContactPhone}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </Card>
          <Card title="Recent requests" className="portal-overview-wide">
            <RequestList
              requests={projectRequests}
              projects={[project]}
              limit={3}
            />
          </Card>
        </div>
      )}
      {tab === "files" && (
        <Card title="Project files">
          <FileBrowser
            load={loadFiles}
            loadLocations={loadLocations}
            mapToken={mapboxPublicToken}
            locationScopeLabel="this project's available files"
            emptyTitle="No project files yet"
            emptyDetail="Deliverables will appear here when your LTDS team publishes them."
          />
        </Card>
      )}
      {tab === "requests" && (
        <>
          <Card title="Request additional service" className="portal-request-card">
            <ServiceRequestForm
              projects={[project]}
              projectId={project.id}
              onSaved={onSaved}
              mapboxPublicToken={mapboxPublicToken}
            />
          </Card>
          <Card title="Project request history">
            <RequestList requests={projectRequests} projects={[project]} />
          </Card>
        </>
      )}
    </>
  );
}

export function ClientPortalApp({
  initialPage,
}: {
  initialPage: ClientPortalPage;
}) {
  const initialRoute = parseClientPortalRoute(window.location.pathname);
  const [gate, setGate] = useState<PortalGate>({ status: "loading" });
  const [page, setPage] = useState<ClientPortalPage>(initialPage);
  const [projectId, setProjectId] = useState<string | null>(
    initialRoute.projectId,
  );
  const [requests, setRequests] = useState<PortalServiceRequest[]>([]);
  const [editing, setEditing] = useState<{
    request: PortalServiceRequest;
    change: boolean;
  } | null>(null);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const pastDeliveryLoader = useMemo(
    () => (cursor: string | null) => loadPortalPastDeliveries(cursor),
    [],
  );
  const pastDeliveryLocationLoader = useMemo(
    () => () => loadPortalPastDeliveryLocations(),
    [],
  );

  useEffect(() => {
    let active = true;
    loadPortalBootstrap()
      .then((data) => {
        if (active) {
          setRequests(data.requests);
          setGate({ status: "ready", data });
        }
      })
      .catch((caught) => {
        if (active) setGate(blockedPortal(caught));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const route = parseClientPortalRoute(window.location.pathname);
      if (!route.isPortal) window.location.reload();
      else {
        setPage(route.page);
        setProjectId(route.projectId);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(nextPage: TopPage) {
    window.history.pushState({}, "", clientPortalPath(nextPage));
    setProjectId(null);
    setPage(nextPage);
    setEditing(null);
  }
  function openProject(id: string) {
    window.history.pushState({}, "", clientProjectPath(id));
    setProjectId(id);
    setPage("project");
  }
  function openNewRequest() {
    window.history.pushState({}, "", clientRequestNewPath());
    setProjectId(null);
    setPage("request-new");
    setEditing(null);
    setRequestNotice(null);
  }
  function finishNewRequest(saved: PortalServiceRequest) {
    onSaved(saved);
    setRequestNotice("Request submitted. LTDS will review it shortly.");
    window.history.pushState({}, "", clientPortalPath("requests"));
    setPage("requests");
  }
  if (gate.status === "loading")
    return (
      <PortalBoundary>
        <Card>
          <Loading />
        </Card>
      </PortalBoundary>
    );
  if (gate.status === "blocked")
    return (
      <PortalBoundary>
        <Card>
          <EmptyState title={gate.title} detail={gate.detail} />
        </Card>
      </PortalBoundary>
    );

  const { account, projects, mapboxPublicToken } = gate.data;
  const onSaved = (saved: PortalServiceRequest) => {
    setRequests((current) => [
      saved,
      ...current.filter((request) => request.id !== saved.id),
    ]);
    setEditing(null);
  };
  const onEstimateRespond = async (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => {
    const note =
      response === "request_change"
        ? window.prompt(
            "Describe what should change in the operational estimate",
          )
        : null;
    if (response === "request_change" && !note?.trim()) return;
    if (
      response === "accept" &&
      !window.confirm(
        "Accept this non-binding LTDS operational estimate? A separate Project Alpha quote will still be required before financial approval.",
      )
    )
      return;
    try {
      onSaved(
        await respondToPortalEstimate(
          request.id,
          request.operationalEstimate!.id,
          response,
          note?.trim() || null,
          crypto.randomUUID(),
        ),
      );
    } catch (caught) {
      window.alert((caught as Error).message);
    }
  };
  const selectedProject = projects.find((project) => project.id === projectId);
  let content: ReactNode;

  if (page === "project")
    content = selectedProject ? (
      <ProjectWorkspace
        project={selectedProject}
        requests={requests}
        mapboxPublicToken={mapboxPublicToken}
        onSaved={onSaved}
        onBack={() => navigate("projects")}
      />
    ) : (
      <Card>
        <EmptyState
          title="Project unavailable"
          detail="This project is not part of your current access grant."
        />
      </Card>
    );
  else if (page === "not-found")
    content = (
      <Card>
        <EmptyState
          title="Page not found"
          detail="This client portal page does not exist."
        />
      </Card>
    );
  else if (page === "dashboard")
    content = (
      <>
        <section className="portal-welcome">
          <span className="eyebrow">Client portal</span>
          <h1>Welcome, {account.displayName}</h1>
          <p>
            Project progress, files, and service requests—all in one secure
            workspace.
          </p>
        </section>
        <div className="portal-stat-grid">
          <Card>
            <span className="portal-stat">{projects.length}</span>
            <strong>Active projects</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("projects")}
            >
              View projects
            </button>
          </Card>
          <Card>
            <span className="portal-stat">
              {
                requests.filter(
                  (request) =>
                    !["completed", "cancelled", "declined"].includes(
                      request.status,
                    ),
                ).length
              }
            </span>
            <strong>Open requests</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("requests")}
            >
              View requests
            </button>
          </Card>
          <Card>
            <span className="portal-stat">
              {
                requests.filter(
                  (request) => request.status === "accepted_linked",
                ).length
              }
            </span>
            <strong>Accepted requests</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("requests")}
            >
              Review details
            </button>
          </Card>
        </div>
        <Card title="Your projects">
          {projects.length ? (
            <div className="portal-project-strip">
              {projects.slice(0, 3).map((project) => (
                <button
                  key={project.id}
                  onClick={() => openProject(project.id)}
                >
                  <span>{project.externalRef}</span>
                  <strong>{project.projectName}</strong>
                  <small>
                    {project.nextMilestone || "Open project workspace"}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No projects available"
              detail="Your client account has no active project grants."
            />
          )}
        </Card>
        <Card title="Recent requests">
          <RequestList requests={requests} projects={projects} limit={4} />
        </Card>
      </>
    );
  else if (page === "projects")
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Project workspaces</span>
          <h1>Projects</h1>
          <p>
            Track project details, download files, and request additional
            service.
          </p>
        </section>
        {projects.length === 0 ? (
          <Card>
            <EmptyState
              title="No projects available"
              detail="Your client account has no active project grants."
            />
          </Card>
        ) : (
          <div className="portal-project-grid">
            {projects.map((project) => (
              <button
                key={project.id}
                className="portal-project-card ltds-card"
                onClick={() => openProject(project.id)}
              >
                <div>
                  <span className="portal-project-ref">
                    {project.externalRef}
                  </span>
                  <StatusPill tone="success">
                    {projectStatusLabel(project.status)}
                  </StatusPill>
                </div>
                <h2>{project.projectName}</h2>
                <p>{project.summary || project.clientName}</p>
                <span className="portal-project-link">Open workspace →</span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  else if (page === "deliveries")
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Client archive</span>
          <h1>Past deliveries</h1>
          <p>
            Secure files granted to your client account across completed and
            historical work.
          </p>
        </section>
        <Card title="Delivery archive">
          <FileBrowser
            load={pastDeliveryLoader}
            loadLocations={pastDeliveryLocationLoader}
            mapToken={mapboxPublicToken}
            locationScopeLabel="your available delivery files"
            emptyTitle="No past deliveries"
            emptyDetail="Files published to your client archive will appear here."
          />
        </Card>
      </>
    );
  else if (page === "requests")
    content = (
      <>
        <section className="portal-page-heading portal-page-heading-action">
          <div>
            <span className="eyebrow">Flight & service</span>
            <h1>Service requests</h1>
            <p>Review request status, scope, estimates, and prior activity.</p>
          </div>
          {!editing && (
            <button className="button-orange" onClick={openNewRequest}>
              Submit new request
            </button>
          )}
        </section>
        {requestNotice && <p className="portal-message portal-request-notice" role="status">{requestNotice}</p>}
        {editing ? (
          <Card
            className="portal-request-card"
            title={
              editing.change ? "Request a change" : "Edit submitted request"
            }
          >
            <ServiceRequestForm
              key={`${editing.change ? "change" : "edit"}:${editing.request.id}`}
              projects={projects}
              initial={editing.change ? undefined : editing.request}
              changeOf={editing.change ? editing.request : undefined}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
              mapboxPublicToken={mapboxPublicToken}
            />
          </Card>
        ) : (
          <div className="portal-request-summary" aria-label="Request summary">
            <div><strong>{requests.length}</strong><span>Total requests</span></div>
            <div><strong>{requests.filter((request) => !["completed", "cancelled", "declined"].includes(request.status)).length}</strong><span>Open requests</span></div>
            <div><strong>{requests.filter((request) => request.operationalEstimate?.status === "ready").length}</strong><span>Estimates ready</span></div>
          </div>
        )}
        <Card title="Request history">
          <RequestList
            requests={requests}
            projects={projects}
            onEdit={(request) => setEditing({ request, change: false })}
            onChange={(request) => setEditing({ request, change: true })}
            onEstimateRespond={onEstimateRespond}
          />
        </Card>
      </>
    );
  else if (page === "request-new")
    content = (
      <>
        <section className="portal-page-heading portal-page-heading-action">
          <div>
            <span className="eyebrow">New flight & service request</span>
            <h1>Define your site and scope</h1>
            <p>
              Start with the map, then add the project, timing, deliverables,
              and on-site details LTDS needs to review the work.
            </p>
          </div>
          <button className="button-ghost" onClick={() => navigate("requests")}>
            Back to request history
          </button>
        </section>
        <Card title="New request" className="portal-request-card">
          <ServiceRequestForm
            key="new-request"
            projects={projects}
            onSaved={finishNewRequest}
            onCancel={() => navigate("requests")}
            mapboxPublicToken={mapboxPublicToken}
          />
        </Card>
      </>
    );
  else
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Account</span>
          <h1>Your account</h1>
          <p>
            LTDS provisions and manages client access directly during the pilot.
          </p>
        </section>
        <div className="portal-account-grid">
          <Card title="Client account" className="portal-account-card">
            <div className="portal-avatar" aria-hidden="true">
              {account.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{account.displayName}</strong>
              {account.email && <p>{account.email}</p>}
              {account.phone && <p>{account.phone}</p>}
            </div>
          </Card>
          <Card title="Access & security">
            <p className="portal-copy">
              Your account uses a verified identity and server-managed project
              grants. Contact LTDS to add a colleague, update access, or change
              your account details.
            </p>
            <a
              className="button-ghost button-small portal-contact-action"
              href="mailto:info@ledgetopdroneservices.com"
            >
              Contact LTDS
            </a>
          </Card>
        </div>
      </>
    );

  return (
    <div className="client-portal">
      <header className="client-portal-header">
        <Brand product="Client portal" />
        <nav className="client-portal-top-nav" aria-label="Client portal">
          {navigation.map((item) => (
            <a
              key={item.page}
              href={clientPortalPath(item.page)}
              aria-current={
                page === item.page ||
                (item.page === "projects" && page === "project") ||
                (item.page === "requests" && page === "request-new")
                  ? "page"
                  : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                navigate(item.page);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <button
          className="portal-account-button"
          onClick={() => navigate("account")}
          aria-label="Open account"
        >
          {account.displayName.slice(0, 2).toUpperCase()}
        </button>
      </header>
      <main className="client-portal-main">{content}</main>
    </div>
  );
}
