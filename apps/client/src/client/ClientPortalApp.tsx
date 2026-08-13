import {
  useEffect,
  useMemo,
  useRef,
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
  createPortalServiceDraft,
  checkpointPortalAttachmentPart,
  completePortalRequestAttachment,
  initializePortalRequestAttachment,
  loadPortalBootstrap,
  loadPortalPastDeliveries,
  loadPortalPastDeliveryLocations,
  loadPortalProjectFileLocations,
  loadPortalProjectFiles,
  loadPortalNotifications,
  loadPortalPricingHint,
  loadPortalRequestAttachment,
  loadPortalServiceCatalog,
  loadPortalWorkspaceAccess,
  loadPortalWorkspaceHierarchy,
  loadPortalWorkspaces,
  invitePortalWorkspaceMember,
  revokePortalWorkspaceInvitation,
  suspendPortalWorkspaceMember,
  respondToPortalEstimate,
  removePortalRequestAttachment,
  requestPortalAttachmentPartTicket,
  savePortalServiceDraft,
  submitPortalServiceDraft,
  uploadPortalAttachmentPart,
  updatePortalNotification,
  updatePortalServiceRequest,
  type PortalBootstrap,
  type PortalFile,
  type PortalFilePage,
  type PortalPoi,
  type PortalAreaGeoJson,
  type PortalPricingHint,
  type PortalRequestAttachmentStatus,
  type PortalNotification,
  type PortalProject,
  type PortalServiceRequest,
  type PortalServiceCatalogItem,
  type PortalServiceDraft,
  type PortalServiceDraftInput,
  type PortalServiceQuestion,
  type PortalServiceRequestInput,
  type PortalServiceRequestStatus,
  type PortalWorkspace,
  type PortalWorkspaceEntry,
  type PortalWorkspaceInvitation,
  type PortalWorkspaceMember,
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

function PortalNotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PortalNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  const reload = () => loadPortalNotifications().then(page => {
    setItems(page.notifications);
    setUnread(page.unreadCount);
    setError("");
  }).catch(caught => setError((caught as Error).message));

  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setOpen(false);
        (root.current?.querySelector("button") as HTMLButtonElement | null)?.focus();
      } else if (event instanceof MouseEvent && root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  const mutate = async (item: PortalNotification, action: "read" | "dismiss") => {
    await updatePortalNotification(item.id, action);
    if (action === "dismiss") setItems(current => current.filter(candidate => candidate.id !== item.id));
    else setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, readAt: new Date().toISOString() } : candidate));
    if (!item.readAt) setUnread(value => Math.max(0, value - 1));
  };

  return <div className="portal-notification-center" ref={root}>
    <button className="portal-notification-bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open}
      aria-controls="portal-notification-panel" onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true">🔔</span>{unread > 0 && <span className="portal-notification-count">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <section id="portal-notification-panel" className="portal-notification-panel" aria-label="Notifications">
      <header><strong>Notifications</strong><button className="button-ghost button-small" onClick={() => setOpen(false)} aria-label="Close notifications">Close</button></header>
      {error && <p role="alert">{error}</p>}
      {!error && !items.length && <p className="portal-notification-empty">You’re all caught up.</p>}
      <div className="portal-notification-list">
        {items.map(item => <article key={item.id} className={item.readAt ? "" : "is-unread"}>
          {item.actionPath ? <a href={item.actionPath} onClick={event => {
            event.preventDefault(); void mutate(item, "read"); setOpen(false);
            window.history.pushState({}, "", item.actionPath!); window.dispatchEvent(new PopStateEvent("popstate"));
          }}><strong>{item.title}</strong></a> : <strong>{item.title}</strong>}
          <p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small>
          <div>{!item.readAt && <button className="button-ghost button-small" onClick={() => void mutate(item, "read")}>Mark read</button>}
            <button className="button-ghost button-small" onClick={() => void mutate(item, "dismiss")}>Dismiss</button></div>
        </article>)}
      </div>
    </section>}
  </div>;
}

type TopPage = "dashboard" | "projects" | "deliveries" | "requests" | "account";
type WorkspaceTab = "overview" | "files" | "requests";
type PortalGate =
  | { status: "loading" }
  | { status: "blocked"; title: string; detail: string }
  | { status: "ready"; data: PortalBootstrap };

const navigation: Array<{ page: TopPage; label: string }> = [
  { page: "dashboard", label: "Home" },
  { page: "projects", label: "Projects" },
  { page: "deliveries", label: "Deliveries" },
  { page: "requests", label: "Requests" },
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
            {request.workAreaRevision && (
              <aside className="portal-work-area-update" role="status">
                <strong>Operations updated the work area</strong>
                <span>{request.workAreaRevision.changeSummary}</span>
                <small>
                  Staff revision {request.workAreaRevision.revisionNumber} · {formatDate(request.workAreaRevision.updatedAt)}
                </small>
              </aside>
            )}
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

const REQUEST_STEPS = ["services", "location", "details", "contact", "review"] as const;
type RequestStep = (typeof REQUEST_STEPS)[number];

function requestStepFromLocation(): RequestStep {
  const requested = new URLSearchParams(window.location.search).get("step");
  return REQUEST_STEPS.includes(requested as RequestStep) ? requested as RequestStep : "services";
}

function questionIsAnswered(question: PortalServiceQuestion, value: unknown): boolean {
  if (!question.required) return true;
  if (question.type === "boolean") return typeof value === "boolean";
  if (question.type === "multi_select") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function ServiceQuestionField({
  serviceId,
  question,
  value,
  onChange,
}: {
  serviceId: string;
  question: PortalServiceQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `service-${serviceId}-${question.id}`;
  const helpId = question.helpText ? `${id}-help` : undefined;
  const shared = { id, required: question.required, "aria-describedby": helpId };
  let control: ReactNode;
  if (question.type === "text") {
    control = <input {...shared} value={typeof value === "string" ? value : ""} maxLength={question.maxLength} onChange={(event) => onChange(event.target.value)} />;
  } else if (question.type === "number") {
    control = <input {...shared} type="number" value={typeof value === "number" ? value : ""} min={question.minimum ?? undefined} max={question.maximum ?? undefined} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} />;
  } else if (question.type === "boolean") {
    control = <select {...shared} value={typeof value === "boolean" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Select an answer</option><option value="true">Yes</option><option value="false">No</option></select>;
  } else if (question.type === "select") {
    control = <select {...shared} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Select an option</option>{question.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  } else {
    const selected = Array.isArray(value) ? value as string[] : [];
    control = <div className="portal-service-options" id={id} aria-describedby={helpId}>{question.options.map(option => <label key={option.value} className="portal-check-option"><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} /> <span>{option.label}</span></label>)}</div>;
  }
  return <div className="portal-service-question"><label htmlFor={question.type === "multi_select" ? undefined : id}>{question.label}{question.required ? <span aria-hidden="true"> *</span> : <span> (optional)</span>}{control}</label>{question.helpText && <small id={helpId}>{question.helpText}</small>}</div>;
}

function formatRequestMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}

const REQUEST_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const requestAttachmentTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
};
type RequestAttachmentUi = {
  key: string; id?: string; clientUploadId: string; file: File; name: string; size: number;
  status: PortalRequestAttachmentStatus | "queued" | "error"; uploadedBytes: number;
  completedParts: number; totalParts: number; error?: string;
};

function normalizedAttachmentType(file: File): string | null {
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const expected = requestAttachmentTypes[extension];
  if (!expected || (file.type && file.type.toLowerCase() !== expected)) return null;
  return expected;
}

function attachmentStatusLabel(status: RequestAttachmentUi["status"]): string {
  if (status === "queued") return "Waiting";
  if (status === "uploading") return "Uploading";
  if (status === "quarantined") return "Quarantined";
  if (status === "scanning") return "Scanning";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  if (status === "aborted") return "Removed";
  return "Needs attention";
}

function NewServiceRequestWizard({
  projects,
  projectId: fixedProjectId,
  onSaved,
  onCancel,
  mapboxPublicToken,
  attachmentsEnabled = false,
}: {
  projects: PortalProject[];
  projectId?: string;
  onSaved: (request: PortalServiceRequest) => void;
  onCancel?: () => void;
  mapboxPublicToken: string | null;
  attachmentsEnabled?: boolean;
}) {
  const eligibleProjects = projects.filter(project => project.canRequestService);
  const [step, setStepState] = useState<RequestStep>(requestStepFromLocation);
  const [catalog, setCatalog] = useState<PortalServiceCatalogItem[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>({});
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [location, setLocation] = useState("");
  const [preferredStartAt, setPreferredStartAt] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [siteContactName, setSiteContactName] = useState("");
  const [siteContactEmail, setSiteContactEmail] = useState("");
  const [siteContactPhone, setSiteContactPhone] = useState("");
  const [desiredCompletionAt, setDesiredCompletionAt] = useState("");
  const [points, setPoints] = useState<PortalPoi[]>([]);
  const [areaGeoJson, setAreaGeoJson] = useState<PortalAreaGeoJson | null>(null);
  const [draft, setDraft] = useState<PortalServiceDraft | null>(null);
  const [pricingHint, setPricingHint] = useState<PortalPricingHint | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<RequestAttachmentUi[]>([]);
  const [attachmentMessage, setAttachmentMessage] = useState("");
  const mounted = useRef(true);
  const draftRef = useRef<PortalServiceDraft | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastSaved = useRef("");
  const createKey = useRef(crypto.randomUUID());

  const reloadCatalog = () => {
    setCatalogState("loading");
    loadPortalServiceCatalog().then(items => {
      if (!mounted.current) return;
      setCatalog(items);
      setCatalogState("ready");
    }).catch(() => {
      if (mounted.current) setCatalogState("error");
    });
  };

  useEffect(() => {
    mounted.current = true;
    reloadCatalog();
    const onPopState = () => setStepState(requestStepFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => { mounted.current = false; window.removeEventListener("popstate", onPopState); };
  }, []);

  useEffect(() => {
    if (!pricingHint) return;
    const remaining = Date.parse(pricingHint.validUntil) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setPricingHint(null);
      return;
    }
    const timeout = window.setTimeout(() => setPricingHint(null), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [pricingHint]);

  const input = useMemo<PortalServiceDraftInput>(() => ({
    projectId: projectId || null,
    requestType: "service",
    title: title.trim(),
    details: details.trim(),
    location: location.trim() || null,
    preferredStartAt: preferredStartAt ? new Date(preferredStartAt).toISOString() : null,
    deliverables: deliverables.trim() || null,
    siteContactName: siteContactName.trim() || null,
    siteContactEmail: siteContactEmail.trim() || null,
    siteContactPhone: siteContactPhone.trim() || null,
    desiredCompletionAt: desiredCompletionAt ? new Date(desiredCompletionAt).toISOString() : null,
    latitude: points[0]?.latitude ?? null,
    longitude: points[0]?.longitude ?? null,
    areaGeoJson,
    poiPoints: points.map(point => ({ longitude: point.longitude, latitude: point.latitude, label: point.label?.trim() || null })),
    services: selectedServices.map(publicId => ({ publicId, answers: answers[publicId] ?? {} })),
  }), [projectId, title, details, location, preferredStartAt, deliverables, siteContactName, siteContactEmail, siteContactPhone, desiredCompletionAt, points, areaGeoJson, selectedServices, answers]);
  const inputJson = JSON.stringify(input);

  const persist = (snapshot: PortalServiceDraftInput, serialized: string): Promise<void> => {
    saveChain.current = saveChain.current.catch(() => undefined).then(async () => {
      if (serialized === lastSaved.current) return;
      if (mounted.current) { setSaveState("saving"); setMessage(""); }
      try {
        const current = draftRef.current;
        const saved = current
          ? await savePortalServiceDraft(current.id, current.version, snapshot, crypto.randomUUID())
          : await createPortalServiceDraft(snapshot, createKey.current);
        draftRef.current = saved;
        lastSaved.current = serialized;
        if (mounted.current) {
          setDraft(saved);
          setSaveState("saved");
          setDirty(false);
          loadPortalPricingHint(saved.id).then(hint => mounted.current && setPricingHint(hint)).catch(() => mounted.current && setPricingHint(null));
        }
      } catch (caught) {
        const error = caught as RequestError;
        if (mounted.current) {
          setSaveState(error.status === 409 ? "conflict" : "error");
          setMessage(error.status === 409 ? "This draft changed in another tab. Reload this page before making more changes." : "Your latest changes could not be saved. Check your connection and try again.");
        }
        throw caught;
      }
    });
    return saveChain.current;
  };

  const updateAttachment = (key: string, update: Partial<RequestAttachmentUi>) =>
    setAttachments(current => current.map(item => item.key === key ? { ...item, ...update } : item));

  async function pollAttachment(key: string, draftId: string, attachmentId: string) {
    for (let attempt = 0; attempt < 120 && mounted.current; attempt += 1) {
      const current = await loadPortalRequestAttachment(draftId, attachmentId);
      updateAttachment(key, { status: current.status });
      if (["accepted", "rejected", "expired", "aborted"].includes(current.status)) return;
      await new Promise(resolve => window.setTimeout(resolve, 1000));
    }
  }

  async function uploadAttachment(item: RequestAttachmentUi) {
    updateAttachment(item.key, { status: "uploading", error: undefined });
    try {
      await persist(input, inputJson);
      const currentDraft = draftRef.current;
      if (!currentDraft) throw new Error("Save the request draft before adding files.");
      const contentType = normalizedAttachmentType(item.file);
      if (!contentType) throw new Error("Choose a JPEG, PNG, WebP, HEIC, HEIF, or PDF whose extension matches its file type.");
      const initialized = await initializePortalRequestAttachment(currentDraft.id, {
        clientUploadId: item.clientUploadId, name: item.name, contentType, size: item.size,
      });
      const completed = new Map(initialized.completedParts.map(part => [part.partNumber, part]));
      const count = Math.ceil(item.size / initialized.partSize);
      updateAttachment(item.key, { id: initialized.attachmentId, totalParts: count, completedParts: completed.size,
        uploadedBytes: [...completed.values()].reduce((sum, part) => sum + part.size, 0), status: initialized.status });
      if (initialized.status !== "uploading") {
        await pollAttachment(item.key, currentDraft.id, initialized.attachmentId);
        return;
      }
      for (let partNumber = 1; partNumber <= count; partNumber += 1) {
        if (completed.has(partNumber)) continue;
        const start = (partNumber - 1) * initialized.partSize;
        const blob = item.file.slice(start, Math.min(item.size, start + initialized.partSize), contentType);
        const priorBytes = [...completed.values()].reduce((sum, part) => sum + part.size, 0);
        const ticket = await requestPortalAttachmentPartTicket(currentDraft.id, initialized.attachmentId, partNumber);
        if (ticket.contentLength !== blob.size || ticket.contentType !== contentType) throw new Error("The upload ticket does not match this file part.");
        const etag = await uploadPortalAttachmentPart(ticket, blob, loaded => updateAttachment(item.key, { uploadedBytes: priorBytes + loaded }));
        const checkpoint = await checkpointPortalAttachmentPart(currentDraft.id, initialized.attachmentId, { partNumber, etag, size: blob.size });
        completed.set(partNumber, checkpoint);
        updateAttachment(item.key, { completedParts: completed.size, uploadedBytes: priorBytes + blob.size });
      }
      const result = await completePortalRequestAttachment(currentDraft.id, initialized.attachmentId, [...completed.values()]);
      updateAttachment(item.key, { status: result.status, uploadedBytes: item.size });
      await pollAttachment(item.key, currentDraft.id, initialized.attachmentId);
    } catch (caught) {
      updateAttachment(item.key, { status: "error", error: (caught as Error).message || "Upload failed." });
    }
  }

  function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const candidates = [...files];
    const active = attachments.filter(item => !["aborted", "expired", "rejected"].includes(item.status));
    if (active.length + candidates.length > 10) { setAttachmentMessage("A request can include at most 10 files."); return; }
    if (active.reduce((sum, item) => sum + item.size, 0) + candidates.reduce((sum, file) => sum + file.size, 0) > REQUEST_ATTACHMENT_MAX_TOTAL_BYTES) {
      setAttachmentMessage("Attachments can total at most 100 MiB per request."); return;
    }
    const invalid = candidates.find(file => file.size <= 0 || file.size > REQUEST_ATTACHMENT_MAX_FILE_BYTES || !normalizedAttachmentType(file));
    if (invalid) { setAttachmentMessage(`${invalid.name} is unsupported. Use JPEG, PNG, WebP, HEIC, HEIF, or PDF files up to 25 MiB each; archives are not allowed.`); return; }
    setAttachmentMessage("");
    const items = candidates.map(file => ({ key: crypto.randomUUID(), clientUploadId: crypto.randomUUID(), file, name: file.name, size: file.size,
      status: "queued" as const, uploadedBytes: 0, completedParts: 0, totalParts: Math.ceil(file.size / (8 * 1024 * 1024)) }));
    setAttachments(current => [...current, ...items]);
    for (const item of items) void uploadAttachment(item);
  }

  async function removeAttachment(item: RequestAttachmentUi) {
    try {
      const currentDraft = draftRef.current;
      if (currentDraft && item.id && item.status === "uploading") await removePortalRequestAttachment(currentDraft.id, item.id);
      setAttachments(current => current.filter(candidate => candidate.key !== item.key));
    } catch (caught) { updateAttachment(item.key, { error: (caught as Error).message || "The file could not be removed." }); }
  }

  useEffect(() => {
    if (!dirty || saveState === "conflict") return;
    const timer = window.setTimeout(() => void persist(input, inputJson).catch(() => undefined), 700);
    return () => window.clearTimeout(timer);
  }, [inputJson, dirty, saveState]);

  const change = (setter: () => void) => { setter(); setDirty(true); setSaveState("idle"); };
  const selectedCatalog = selectedServices.map(id => catalog.find(service => service.publicId === id)).filter((service): service is PortalServiceCatalogItem => Boolean(service));
  const servicesComplete = selectedCatalog.length > 0 && selectedCatalog.every(service => service.questions.every(question => questionIsAnswered(question, answers[service.publicId]?.[question.id])));

  function goTo(next: RequestStep, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("step", next);
    window.history[replace ? "replaceState" : "pushState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
    setStepState(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function next() {
    if (step === "services" && !servicesComplete) { setMessage("Select at least one service and answer its required questions."); return; }
    if (step === "details" && (!title.trim() || !details.trim())) { setMessage("Add a request title and description before continuing."); return; }
    if (step === "contact" && siteContactEmail && !/^\S+@\S+\.\S+$/.test(siteContactEmail)) { setMessage("Enter a valid on-site contact email or leave it blank."); return; }
    setMessage("");
    const index = REQUEST_STEPS.indexOf(step);
    if (index < REQUEST_STEPS.length - 1) goTo(REQUEST_STEPS[index + 1]!);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pendingAttachments = attachments.some(item => ["queued", "uploading", "quarantined", "scanning", "error"].includes(item.status));
    if (step !== "review" || submitting || pendingAttachments || !servicesComplete || !title.trim() || !details.trim()) {
      if (pendingAttachments) setMessage("Wait for every attachment to be accepted or rejected before submitting.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      await persist(input, inputJson);
      const current = draftRef.current;
      if (!current) throw new Error("Draft was not saved");
      const request = await submitPortalServiceDraft(current.id, current.version, crypto.randomUUID());
      onSaved(request);
    } catch (caught) {
      const error = caught as RequestError;
      setMessage(error.status === 422 ? "The service library changed or a required answer is missing. Return to Services, review your selections, and try again." : error.message || "The request could not be submitted.");
    } finally { setSubmitting(false); }
  }

  return <form className="portal-request-form portal-request-wizard" onSubmit={submit}>
    <nav className="portal-request-stepper" aria-label="Service request progress"><ol>{REQUEST_STEPS.map((item, index) => <li key={item} className={item === step ? "is-current" : REQUEST_STEPS.indexOf(step) > index ? "is-complete" : ""}><button type="button" onClick={() => index <= REQUEST_STEPS.indexOf(step) && goTo(item)} aria-current={item === step ? "step" : undefined}><span>{index + 1}</span>{item === "services" ? "Services" : item === "location" ? "Work area" : item === "details" ? "Details" : item === "contact" ? "Contact" : "Review"}</button></li>)}</ol></nav>
    <div className="portal-autosave-status" role="status" aria-live="polite"><span className={`save-dot ${saveState}`} aria-hidden="true" />{saveState === "saving" ? "Saving draft..." : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved" : saveState === "conflict" ? "Draft conflict" : dirty ? "Changes waiting to save" : "Your progress will save automatically"}</div>
    {step === "services" && <section className="portal-wizard-panel" aria-labelledby="request-services-title"><header><span>Step 1 of 5</span><h3 id="request-services-title">What services do you need?</h3><p>Select between 1 and 10 services from the current Project Alpha service library.</p></header>
      {catalogState === "loading" && <div aria-label="Loading service library"><Loading /></div>}
      {catalogState === "error" && <div className="portal-inline-error" role="alert"><p>The service library could not be loaded. No request data was lost.</p><button type="button" className="button-ghost" onClick={reloadCatalog}>Retry</button></div>}
      {catalogState === "ready" && catalog.length === 0 && <EmptyState title="No services available" detail="LTDS has not published any client-request services yet." />}
      <div className="portal-service-catalog">{catalog.map(service => { const selected = selectedServices.includes(service.publicId); return <article key={service.publicId} className={selected ? "is-selected" : ""}><label className="portal-service-select"><input type="checkbox" checked={selected} disabled={!selected && selectedServices.length >= 10} onChange={(event) => change(() => setSelectedServices(current => event.target.checked ? [...current, service.publicId] : current.filter(id => id !== service.publicId)))} /><span><strong>{service.name}</strong>{service.summary && <small>{service.summary}</small>}</span></label>{selected && service.questions.length > 0 && <div className="portal-service-questions">{service.questions.map(question => <ServiceQuestionField key={question.id} serviceId={service.publicId} question={question} value={answers[service.publicId]?.[question.id]} onChange={value => change(() => setAnswers(current => ({ ...current, [service.publicId]: { ...(current[service.publicId] ?? {}), [question.id]: value } })))} />)}</div>}</article>; })}</div>
    </section>}
    {step === "location" && <section className="portal-wizard-panel" aria-labelledby="request-location-title"><header><span>Step 2 of 5</span><h3 id="request-location-title">Show us the work area</h3><p>Search, add points, or draw the area directly on the secure map. Clients cannot upload or import KML files.</p></header><div className="portal-request-map portal-request-map-step"><MapAreaSelector value={areaGeoJson} onChange={value => change(() => setAreaGeoJson(value))} token={mapboxPublicToken} points={points} onPoints={value => change(() => setPoints(value))} locationLabel={location} onLocationLabel={value => change(() => setLocation(value))} /></div>{draft?.areaAcres != null && <div className="portal-coverage-card"><span>Estimated coverage</span><strong>{draft.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres</strong><small>Calculated by LTDS from the area drawn above.</small></div>}</section>}
    {step === "details" && <section className="portal-wizard-panel" aria-labelledby="request-details-title"><header><span>Step 3 of 5</span><h3 id="request-details-title">Scope and timing</h3><p>Describe the outcome you need. LTDS will confirm feasibility and the final scope.</p></header>{!fixedProjectId && <label>Project context<select value={projectId} onChange={event => change(() => setProjectId(event.target.value))}><option value="">New or one-off service</option>{eligibleProjects.map(project => <option key={project.id} value={project.id}>{project.projectName}</option>)}</select></label>}<label>Service request title<input value={title} onChange={event => change(() => setTitle(event.target.value))} maxLength={160} required /></label><label>What do you need?<textarea value={details} onChange={event => change(() => setDetails(event.target.value))} maxLength={5000} rows={6} required /></label><div className="portal-form-grid"><label>Location <span>(optional)</span><input value={location} onChange={event => change(() => setLocation(event.target.value))} maxLength={240} /></label><label>Preferred start <span>(optional)</span><input type="datetime-local" value={preferredStartAt} onChange={event => change(() => setPreferredStartAt(event.target.value))} /></label><label>Desired completion <span>(optional)</span><input type="datetime-local" value={desiredCompletionAt} onChange={event => change(() => setDesiredCompletionAt(event.target.value))} /></label></div><label>Requested deliverables <span>(optional)</span><textarea value={deliverables} onChange={event => change(() => setDeliverables(event.target.value))} maxLength={2000} rows={4} /></label></section>}
    {step === "contact" && <section className="portal-wizard-panel" aria-labelledby="request-contact-title"><header><span>Step 4 of 5</span><h3 id="request-contact-title">Contact and supporting files</h3><p>Add an optional on-site contact and any authorized reference photos or PDFs.</p></header><fieldset className="portal-contact-fields"><legend>Contact details <span>(optional)</span></legend><label>Name<input value={siteContactName} onChange={event => change(() => setSiteContactName(event.target.value))} maxLength={160} /></label><label>Email<input type="email" value={siteContactEmail} onChange={event => change(() => setSiteContactEmail(event.target.value))} maxLength={320} /></label><label>Phone<input type="tel" value={siteContactPhone} onChange={event => change(() => setSiteContactPhone(event.target.value))} maxLength={64} /></label></fieldset>{attachmentsEnabled ? <div className="portal-attachment-uploader"><header><div><strong>Supporting files</strong><p>Up to 10 JPEG, PNG, WebP, HEIC, HEIF, or PDF files; 25 MiB each and 100 MiB total. Archives are not allowed.</p></div><label className="button-ghost portal-file-picker">Add files<input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" onChange={event => { addAttachments(event.target.files); event.currentTarget.value = ""; }} /></label></header>{attachmentMessage && <p role="alert" className="portal-message error">{attachmentMessage}</p>}<div className="portal-attachment-list" aria-live="polite">{attachments.map(item => <article key={item.key}><div><strong>{item.name}</strong><span>{formatBytes(item.size)} / {attachmentStatusLabel(item.status)}</span></div><progress max={item.size} value={Math.min(item.uploadedBytes, item.size)} aria-label={`${item.name} upload progress`} /><small>{item.totalParts ? `${item.completedParts} of ${item.totalParts} parts` : "Preparing upload"}</small>{item.error && <p role="alert">{item.error}</p>}<div>{item.status === "error" && <button type="button" className="button-ghost button-small" onClick={() => void uploadAttachment(item)}>Retry</button>}{["queued", "uploading", "error"].includes(item.status) && <button type="button" className="button-ghost button-small" onClick={() => void removeAttachment(item)}>Remove</button>}</div></article>)}</div></div> : <div className="portal-attachments-coming"><strong>Supporting files are coming soon</strong><p>Secure request attachments are not enabled for this portal. Do not place sensitive file links in the description.</p></div>}</section>}
    {step === "review" && <section className="portal-wizard-panel portal-review" aria-labelledby="request-review-title"><header><span>Step 5 of 5</span><h3 id="request-review-title">Review your request</h3><p>Nothing is submitted until you select Submit request.</p></header><div className="portal-review-grid"><article><header><h4>Services</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("services")}>Edit services</button></header><ul>{selectedCatalog.map(service => <li key={service.publicId}><strong>{service.name}</strong>{service.questions.map(question => { const value = answers[service.publicId]?.[question.id]; if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null; const labels = question.type === "select" || question.type === "multi_select" ? question.options.filter(option => (Array.isArray(value) ? value : [value]).includes(option.value)).map(option => option.label).join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : String(value); return <span key={question.id}>{question.label}: {labels}</span>; })}</li>)}</ul></article><article><header><h4>Work area</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("location")}>Edit work area</button></header><p>{location || "No location label provided"}</p><p>{draft?.areaAcres != null ? `${draft.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres` : areaGeoJson ? "Coverage is being calculated" : "No polygon drawn"} / {points.length} point{points.length === 1 ? "" : "s"}</p></article><article><header><h4>Scope and timing</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("details")}>Edit details</button></header><strong>{title || "Title required"}</strong><p>{details || "Description required"}</p><p>{projectId ? eligibleProjects.find(project => project.id === projectId)?.projectName ?? "Authorized project" : "New or one-off service"}</p><p>{deliverables || "No separate deliverables noted"}</p></article><article><header><h4>Contact</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("contact")}>Edit contact</button></header><p>{siteContactName || "No on-site contact"}</p>{siteContactEmail && <p>{siteContactEmail}</p>}{siteContactPhone && <p>{siteContactPhone}</p>}</article></div><aside className="portal-pricing-hint"><span>Planning guidance</span>{pricingHint ? <><strong>{pricingHint.kind === "starting_at" ? `Starting at ${formatRequestMoney(pricingHint.startingAtMinor, pricingHint.currency)}` : `Typical range ${formatRequestMoney(pricingHint.minimumMinor, pricingHint.currency)} to ${formatRequestMoney(pricingHint.maximumMinor, pricingHint.currency)}`}</strong><p>{pricingHint.disclaimer}</p></> : <><strong>Final quote after review</strong><p>A reliable price hint is not available for this request. Submitting does not authorize work or create a charge. LTDS will review the scope and create the actual estimate in Project Alpha.</p></>}</aside></section>}
    {step === "review" && <section className="portal-review-attachments" aria-labelledby="review-attachments-title"><header><h3 id="review-attachments-title">Supporting files</h3><button type="button" className="button-ghost button-small" onClick={() => goTo("contact")}>Edit files</button></header>{attachments.length ? <ul>{attachments.filter(item => item.status !== "aborted").map(item => <li key={item.key}><div><strong>{item.name}</strong><span>{formatBytes(item.size)}</span></div><span className={`portal-attachment-status ${item.status}`}>{attachmentStatusLabel(item.status)}</span></li>)}</ul> : <p>No supporting files were added.</p>}</section>}
    {message && <p className="portal-message error" role="alert">{message}</p>}
    <div className="portal-form-actions portal-wizard-actions">{onCancel && <button type="button" className="button-ghost" onClick={onCancel}>Cancel</button>}{step !== "services" && <button type="button" className="button-ghost" onClick={() => goTo(REQUEST_STEPS[REQUEST_STEPS.indexOf(step) - 1]!)}>Back</button>}{step === "review" ? <button key="submit-request" type="submit" className="button-orange" disabled={submitting || saveState === "conflict" || attachments.some(item => ["queued", "uploading", "quarantined", "scanning", "error"].includes(item.status))}>{submitting ? "Submitting..." : "Submit request"}</button> : <button key="continue-request" type="button" className="button-orange" onClick={() => void next()}>Continue</button>}</div>
  </form>;
}

function ServiceRequestForm(props: Parameters<typeof NewServiceRequestWizard>[0] & { initial?: PortalServiceRequest; changeOf?: PortalServiceRequest; requestV2?: boolean }) {
  if (props.requestV2 && !props.initial && !props.changeOf) return <NewServiceRequestWizard {...props} />;
  return <LegacyServiceRequestForm {...props} />;
}

function LegacyServiceRequestForm({
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
  requestV2,
  requestAttachments,
  onSaved,
  onBack,
}: {
  project: PortalProject;
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
  requestV2: boolean;
  requestAttachments: boolean;
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
              requestV2={requestV2}
              attachmentsEnabled={requestAttachments}
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

function WorkspaceTeamPanel() {
  const [workspaces, setWorkspaces] = useState<PortalWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projects, setProjects] = useState<PortalWorkspaceEntry[]>([]);
  const [members, setMembers] = useState<PortalWorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<PortalWorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [projectId, setProjectId] = useState("");
  const [organizationWide, setOrganizationWide] = useState(false);
  const [wideConfirmed, setWideConfirmed] = useState(false);
  const [canRequest, setCanRequest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshAccess = async (id: string) => {
    const [hierarchy, access] = await Promise.all([loadPortalWorkspaceHierarchy(id), loadPortalWorkspaceAccess(id)]);
    const availableProjects = hierarchy.filter(entry => entry.type === "project");
    setProjects(availableProjects);
    setProjectId(current => availableProjects.some(project => project.publicId === current) ? current : availableProjects[0]?.publicId ?? "");
    setMembers(access.members);
    setInvitations(access.invitations);
  };

  useEffect(() => {
    let cancelled = false;
    loadPortalWorkspaces().then(async values => {
      if (cancelled) return;
      setWorkspaces(values);
      const first = values[0]?.id ?? "";
      setWorkspaceId(first);
      if (first) await refreshAccess(first);
    }).catch(caught => { if (!cancelled) setError((caught as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const selectWorkspace = async (id: string) => {
    setWorkspaceId(id); setError(""); setBusy(true);
    try { await refreshAccess(id); } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || (!organizationWide && !projectId)) return;
    setBusy(true); setError("");
    try {
      await invitePortalWorkspaceMember(workspaceId, {
        email,
        ...(organizationWide ? { organizationWide: true, confirmOrganizationWide: wideConfirmed } : { projectPublicId: projectId }),
        capabilities: canRequest ? ["delivery.view", "request.create"] : ["delivery.view"],
      });
      setEmail(""); setOrganizationWide(false); setWideConfirmed(false); setCanRequest(false);
      await refreshAccess(workspaceId);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (error && workspaces.length === 0) return <p className="portal-copy" role="status">Team management is not available for this account. Contact LTDS for access changes.</p>;
  return <div className="portal-team-panel">
    {workspaces.length > 1 && <label>Workspace<select value={workspaceId} onChange={event => void selectWorkspace(event.target.value)} disabled={busy}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.displayName}</option>)}</select></label>}
    <form onSubmit={invite} className="portal-team-invite-form">
      <h3>Invite a project collaborator</h3>
      <p className="portal-copy">Access defaults to one project. Invitees authenticate with the exact email address below.</p>
      <label>Email address<input type="email" required maxLength={320} value={email} onChange={event => setEmail(event.target.value)} /></label>
      {!organizationWide && <label>Project<select required value={projectId} onChange={event => setProjectId(event.target.value)}><option value="" disabled>Select a project</option>{projects.map(project => <option key={project.publicId} value={project.publicId}>{project.displayName}</option>)}</select></label>}
      <label className="portal-check"><input type="checkbox" checked={canRequest} onChange={event => setCanRequest(event.target.checked)} /> Allow this person to submit service requests for the selected scope</label>
      <label className="portal-check portal-wide-access"><input type="checkbox" checked={organizationWide} onChange={event => { setOrganizationWide(event.target.checked); setWideConfirmed(false); }} /> Give access across this entire client workspace</label>
      {organizationWide && <div className="portal-danger-disclosure" role="alert"><strong>Broader access</strong><p>This person will be able to see current and future projects across the workspace.</p><label className="portal-check"><input type="checkbox" required checked={wideConfirmed} onChange={event => setWideConfirmed(event.target.checked)} /> I understand and want to grant workspace-wide access.</label></div>}
      <button className="button-primary" disabled={busy || (!organizationWide && !projectId) || (organizationWide && !wideConfirmed)}>{busy ? "Saving…" : "Send invitation"}</button>
      {error && <p className="portal-form-error" role="alert">{error}</p>}
    </form>
    <div className="portal-team-lists">
      <section><h3>People</h3>{members.map(member => <div className="portal-team-row" key={member.identityId}><span><strong>{member.email ?? "Verified portal user"}</strong><small>{member.manager ? "Manager" : "Member"} · {member.status}</small></span>{member.status === "active" && <button className="button-ghost button-small" onClick={async () => { setBusy(true); try { await suspendPortalWorkspaceMember(workspaceId, member.identityId); await refreshAccess(workspaceId); } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); } }}>Suspend</button>}</div>)}</section>
      <section><h3>Invitations</h3>{invitations.length === 0 ? <p className="portal-copy">No invitations yet.</p> : invitations.map(invitation => <div className="portal-team-row" key={invitation.id}><span><strong>{invitation.email}</strong><small>{invitation.scope.type === "project" ? "Project access" : "Workspace-wide"} · {invitation.status}</small></span>{invitation.status === "pending" && <button className="button-ghost button-small" onClick={async () => { setBusy(true); try { await revokePortalWorkspaceInvitation(workspaceId, invitation.id); await refreshAccess(workspaceId); } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); } }}>Revoke</button>}</div>)}</section>
    </div>
  </div>;
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavTrigger = useRef<HTMLButtonElement>(null);
  const mobileNavPanel = useRef<HTMLDivElement>(null);
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
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileNavPanel.current?.querySelector<HTMLElement>("a")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        mobileNavTrigger.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = [...(mobileNavPanel.current?.querySelectorAll<HTMLElement>('a, button:not([disabled])') || [])];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const resize = () => { if (window.innerWidth > 960) setMobileNavOpen(false); };
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", resize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
    };
  }, [mobileNavOpen]);

  function navigate(nextPage: TopPage) {
    window.history.pushState({}, "", clientPortalPath(nextPage));
    setProjectId(null);
    setPage(nextPage);
    setEditing(null);
    setMobileNavOpen(false);
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

  const { account, projects, mapboxPublicToken, capabilities } = gate.data;
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
        requestV2={capabilities.requestV2}
        requestAttachments={capabilities.requestAttachments}
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
              requestV2={capabilities.requestV2}
              attachmentsEnabled={capabilities.requestAttachments}
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
            requestV2={capabilities.requestV2}
            attachmentsEnabled={capabilities.requestAttachments}
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
          {capabilities.workspaceMembershipManagement && <Card title="Team access" className="portal-team-card"><WorkspaceTeamPanel /></Card>}
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
        <PortalNotificationCenter />
        <button ref={mobileNavTrigger} className="portal-nav-trigger" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="portal-mobile-navigation" onClick={() => setMobileNavOpen(true)}><span className="nav-hamburger" aria-hidden="true"><i /><i /><i /></span></button>
        <button
          className="portal-account-button"
          onClick={() => navigate("account")}
          aria-label="Open account"
        >
          {account.displayName.slice(0, 2).toUpperCase()}
        </button>
      </header>
      {mobileNavOpen && <div className="portal-mobile-nav-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setMobileNavOpen(false); mobileNavTrigger.current?.focus(); } }}>
        <div ref={mobileNavPanel} id="portal-mobile-navigation" className="portal-mobile-nav" role="dialog" aria-modal="true" aria-label="Navigation">
          <header><strong>Navigation</strong><button type="button" aria-label="Close navigation" onClick={() => { setMobileNavOpen(false); mobileNavTrigger.current?.focus(); }}>Close</button></header>
          <nav aria-label="Mobile client portal navigation">
            {[...navigation, { page: "account" as const, label: "Account" }].map((item) => <a key={item.page} href={clientPortalPath(item.page)} aria-current={page === item.page || (item.page === "projects" && page === "project") || (item.page === "requests" && page === "request-new") ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(item.page); }}>{item.label}</a>)}
          </nav>
        </div>
      </div>}
      <main className="client-portal-main">{content}</main>
    </div>
  );
}
