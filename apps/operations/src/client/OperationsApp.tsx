import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BRAND, type DeliveryLocationCollection, type Permission, type SessionUser } from "@ltds/shared";
import { Brand, Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { ApiError, api, setCsrf } from "./api";
import { generateSecureAccessCode } from "./access-code";
import {
  DELIVERY_JOBS_PREFIX,
  DELIVERY_ROOT_PREFIX,
  deliveryPathFromPrefix,
  prefixFromDeliveryPath,
} from "./delivery-route";
import {
  operationsSectionPath,
  pathOperationsSection,
  pathPage,
  type OperationsPage as Page,
  type OperationsSection,
} from "./operations-route";
import { DropboxImportDialog } from "./DropboxImportDialog";
import { ClientRequestWorkflow } from "./ClientRequestWorkflow";
import { JobBriefPanel } from "./JobBriefPanel";
import { SopLibrary } from "./SopLibrary";
import { ImageLocationMap } from "./ImageLocationMap";
import {
  activateDeliveryFolderCache,
  deactivateDeliveryFolderCache,
  invalidateDeliveryFolderCache,
  readDeliveryFolderCache,
  writeDeliveryFolderCache,
} from "./delivery-folder-cache";

type OperationsUser = SessionUser & {
  status: "Active";
  profileType: "Administrator" | "Employee";
  isAdministrator: boolean;
};
interface Session {
  user: OperationsUser;
  csrfToken: string;
  timezone: string;
  mapStyleUrl: string | null;
  mapboxPublicToken: string | null;
  capabilities?: {
    dropboxImport?: {
      enabled: boolean;
      reason: "available" | "disabled" | "not-configured";
    };
    incomingUploads?: { enabled: boolean; reason: "available" | "disabled" };
    directDeliveryUploads?: {
      enabled: boolean;
      reason: "available" | "disabled";
    };
    deliveryJobsRoot?: { enabled: boolean };
  };
}
interface ActiveDeliveryShare {
  id: string;
  shareUrl: string | null;
  passwordProtected: boolean;
  expiresAt: string | null;
  recoverable: boolean;
  recipientEmail?: string | null;
}
interface DeliveryShareResult {
  id: string;
  shareUrl: string;
  accessCode: string | null;
  passwordProtected: boolean;
  expiresAt: string | null;
  lifecycle: "created" | "reused" | "updated" | "rotated";
  idempotentReplay: boolean;
}
interface IncomingUploadSummary {
  id?: string;
  name?: string;
  fileName?: string;
  contributorName?: string;
  status?: string;
  size?: number;
  createdAt?: string;
  uploadedAt?: string;
}
interface IncomingLink {
  id: string;
  url: string;
  accessCodeProtected: boolean;
  createdAt: string;
  outstandingFiles: number;
  outstandingBytes: number;
  recentUploads: IncomingUploadSummary[];
}
interface IncomingLinkResponse {
  link: IncomingLink | null;
}
const NAV: Array<{
  page: Page;
  label: string;
  permissions: Permission[];
  administrator?: boolean;
}> = [
  { page: "dashboard", label: "Dashboard", permissions: ["dashboard.view"] },
  {
    page: "operations",
    label: "Operations",
    permissions: ["operations.view", "projects.view", "tasks.view"],
  },
  { page: "sops", label: "SOP Library", permissions: ["sops.view"] },
  { page: "airspace", label: "Airspace", permissions: ["airspace.view"] },
  { page: "delivery", label: "Delivery", permissions: ["delivery.browse"] },
  { page: "team", label: "Team", permissions: ["team.view"] },
  {
    page: "administration",
    label: "Administration",
    permissions: ["administration.view"],
  },
];
function allowed(user: SessionUser, permission: Permission) {
  return user.permissions.includes(permission);
}
function navAllowed(user: OperationsUser, item: (typeof NAV)[number]) {
  return (
    item.permissions.some((permission) => allowed(user, permission)) &&
    (!item.administrator || user.isAdministrator)
  );
}
function date(value?: string | null) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024,
    index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}
export function OperationsApp() {
  const [session, setSession] = useState<Session | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState<Page>(pathPage(location.pathname));
  useEffect(() => {
    api<Session>("/api/session")
      .then((value) => {
        setCsrf(value.csrfToken);
        activateDeliveryFolderCache(JSON.stringify({
          userId: value.user.id,
          permissions: [...value.user.permissions].sort(),
          divisions: value.user.divisions.map((division) => JSON.stringify(division)).sort(),
          administrator: value.user.isAdministrator,
          jobsRoot: value.capabilities?.deliveryJobsRoot?.enabled === true,
        }));
        setSession(value);
        const current = NAV.find((item) => item.page === page),
          visible = current && navAllowed(value.user, current);
        if (!visible) {
          const first = NAV.find((item) => navAllowed(value.user, item));
          if (first) navigate(first.page);
        }
      })
      .catch((caught) => setError(caught.message));
  }, []);
  useEffect(() => {
    const pop = () => setPage(pathPage(location.pathname));
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  function navigate(next: Page) {
    setPage(next);
    history.pushState(null, "", next === "dashboard" ? "/" : `/${next}`);
    if (next === "operations" || next === "delivery")
      dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo(0, 0);
  }
  if (error)
    return (
      <main className="fatal">
        <EmptyState title="Operations unavailable" detail={error} />
      </main>
    );
  if (!session)
    return (
      <main className="fatal">
        <Loading />
      </main>
    );
  const props = { session };
  return (
    <div className="ops-shell">
      <header className="ops-header">
        <Brand product="Operations" />
        <nav>
          {NAV.filter((item) => navAllowed(session.user, item)).map((item) => (
            <button
              key={item.page}
              className={page === item.page ? "active" : ""}
              onClick={() => navigate(item.page)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="profile">
          <span>{session.user.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            {session.user.displayName}
            <small>
              {session.user.status} {session.user.profileType}
            </small>
            <small>{session.user.email}</small>
          </div>
        </div>
      </header>
      <main className="ops-main">
        <PageHeading page={page} />
        {page === "dashboard" && <Dashboard {...props} />}{" "}
        {page === "operations" && <OperationsHub {...props} />}{" "}
        {page === "sops" && allowed(session.user, "sops.view") && (
          <SopLibrary user={session.user} />
        )}{" "}
        {page === "airspace" && <Airspace />}{" "}
        {page === "delivery" && allowed(session.user, "delivery.browse") && (
          <DeliveryHub {...props} />
        )}{" "}
        {page === "team" && allowed(session.user, "team.view") && (
          <Team {...props} />
        )}{" "}
        {page === "administration" &&
          allowed(session.user, "administration.view") && (
            <Administration {...props} />
          )}
      </main>
    </div>
  );
}

function PageHeading({ page }: { page: Page }) {
  const copy: Record<Page, [string, string]> = {
    dashboard: [
      "Operations dashboard",
      "Assigned work, airspace awareness, delivery activity, and system health.",
    ],
    operations: [
      "Operations",
      "Detailed operational schedules, projects, and task queues managed in Project Alpha.",
    ],
    sops: [
      "Internal SOP library",
      "Published field guidance and Operations-owned procedures for staff and pilots.",
    ],
    airspace: [
      "Airspace awareness",
      "Official FAA TFR and special-use airspace information for Wisconsin.",
    ],
    delivery: [
      "Client delivery",
      "Browse the live R2 hierarchy and create secure client links.",
    ],
    team: [
      "Team",
      "Project Alpha-managed staff access, divisions, and role assignments.",
    ],
    administration: [
      "Administration",
      "Integration synchronization, security, and audit history.",
    ],
  };
  return (
    <div className="page-heading">
      <span className="eyebrow">LTDS Operations</span>
      <h1>{copy[page][0]}</h1>
      <p>{copy[page][1]}</p>
    </div>
  );
}
async function cachedFolderApi(prefix: string): Promise<any> {
  const key = `/api/delivery/folders?prefix=${encodeURIComponent(prefix)}`;
  const data = await api<any>(key);
  writeDeliveryFolderCache(prefix, data);
  return data;
}

function cachedFolderData(prefix: string): any | null {
  return readDeliveryFolderCache(prefix);
}

function invalidateDeliveryCacheOnAccessError(error: unknown, prefix: string): boolean {
  if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return false;
  if (error.status === 401 || error.status === 403) invalidateDeliveryFolderCache();
  else invalidateDeliveryFolderCache(prefix);
  return true;
}

function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setError("");
    setLoading(true);
    return loader()
      .then((value) => {
        setData(value);
        setLoading(false);
      })
      .catch((caught) => {
        setError(caught.message);
        setLoading(false);
      });
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, loading };
}
function ErrorLine({ error }: { error: string }) {
  return error ? <div className="notice error">{error}</div> : null;
}
function PanelSkeleton() {
  return (
    <div className="panel-skeleton" role="status" aria-label="Loading">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
function ViewerSkeleton() {
  return (
    <span
      className="ops-viewer-skeleton"
      role="status"
      aria-label="Loading preview"
    />
  );
}
function ManagedNotice({
  detail = "Create and edit this information in Project Alpha. Changes appear here after synchronization.",
}: {
  detail?: string;
}) {
  return (
    <div className="notice managed-notice">
      <strong>Managed in Project Alpha</strong>
      <span>{detail}</span>
    </div>
  );
}

function Dashboard({ session }: { session: Session }) {
  const { data, error } = useLoad(() => api<any>("/api/dashboard"), []);
  const pending = useLoad(
    () =>
      allowed(session.user, "operations.manage")
        ? api<{ count: number }>("/api/client-service-requests/pending-count")
        : Promise.resolve({ count: 0 }),
    [],
  );
  if (!data && !error) return <Loading />;
  const integrations = (data?.integrations || []).filter(
    (item: any) =>
      String(item.integration).toLowerCase().replaceAll("_", "-") ===
      "project-alpha",
  );
  const projectAlpha = integrations.find(
    (item: any) =>
      String(item.integration).toLowerCase().replaceAll("_", "-") ===
      "project-alpha",
  );
  const stale = Boolean(
    projectAlpha &&
    (projectAlpha.stale ||
      projectAlpha.status === "stale" ||
      projectAlpha.status === "error"),
  );
  const activeTfrs = data?.airspace?.activeTfrs ?? 0;
  const scheduledTfrs = data?.airspace?.scheduledTfrs ?? 0;
  return (
    <>
      <ErrorLine error={error} />
      {stale && (
        <div className="notice stale-notice">
          <strong>Project Alpha data may be out of date.</strong>
          <span>
            Cached information remains available in read-only mode while
            synchronization recovers.
          </span>
        </div>
      )}
      {allowed(session.user, "operations.manage") && (
        <a className="pending-request-card ltds-card" href="/operations/client-requests?status=submitted">
          <span>Client service requests</span>
          <strong>{pending.data?.count ?? "—"}</strong>
          <p>Awaiting staff review</p>
          <span className="button-orange button-small">Open review queue</span>
        </a>
      )}
      <div className="stats">
        <Card>
          <strong>{data?.operations.length || 0}</strong>
          <span>Open operations</span>
        </Card>
        <Card>
          <strong>{data?.tasks.length || 0}</strong>
          <span>Open tasks</span>
        </Card>
        <Card>
          <strong>{activeTfrs}</strong>
          <span>Active TFRs</span>
        </Card>
        <Card>
          <strong>{scheduledTfrs}</strong>
          <span>Scheduled TFRs</span>
        </Card>
      </div>
      <div className="dashboard-grid">
        <Card title="Upcoming operations">
          {data?.operations.length ? (
            <SimpleRows
              rows={data.operations.map((item: any) => ({
                title: item.title,
                detail: `${item.division_name || item.business_unit_name || "Project Alpha"} · ${date(item.scheduled_start)}`,
                status: item.status,
              }))}
            />
          ) : (
            <EmptyState
              title="No open operations"
              detail="Scheduled Project Alpha work will appear here."
            />
          )}
        </Card>
        <Card title="My work queue">
          {data?.tasks.length ? (
            <SimpleRows
              rows={data.tasks.map((item: any) => ({
                title: item.title,
                detail: date(item.due_at),
                status: item.status,
              }))}
            />
          ) : (
            <EmptyState
              title="No open tasks"
              detail="Assigned Project Alpha work will appear here."
            />
          )}
        </Card>
        <Card title="Project Alpha integration">
          {integrations.length ? (
            integrations.map((item: any) => (
              <div className="health-row" key={item.integration}>
                <div>
                  <strong>{item.integration}</strong>
                  <small>
                    {item.last_success_at
                      ? `Last success ${date(item.last_success_at)}`
                      : "No successful sync yet"}
                  </small>
                </div>
                <StatusPill
                  tone={
                    item.status === "healthy" && !item.stale
                      ? "success"
                      : item.status === "error"
                        ? "danger"
                        : "warning"
                  }
                >
                  {item.stale ? "stale" : item.status}
                </StatusPill>
              </div>
            ))
          ) : (
            <EmptyState
              title="No integration status"
              detail="Project Alpha synchronization has not reported yet."
            />
          )}
        </Card>
        {session.user.isAdministrator && (
          <Card title="Recent delivery activity">
            {data?.recentShares.length ? (
              <SimpleRows
                rows={data.recentShares.map((item: any) => ({
                  title: `${item.client_name} · ${item.project_name}`,
                  detail: item.r2_prefix,
                  status: item.revoked_at ? "revoked" : "active",
                }))}
              />
            ) : (
              <EmptyState
                title="No delivery links"
                detail="Newly created client links will appear here."
              />
            )}
          </Card>
        )}
      </div>
    </>
  );
}
function SimpleRows({
  rows,
}: {
  rows: Array<{ title: string; detail: string; status: string }>;
}) {
  return (
    <div className="simple-rows">
      {rows.map((row, index) => (
        <div key={`${row.title}-${index}`}>
          <div>
            <strong>{row.title}</strong>
            <small>{row.detail}</small>
          </div>
          <StatusPill
            tone={
              row.status === "blocked" || row.status === "revoked"
                ? "danger"
                : row.status === "active" || row.status === "ready"
                  ? "success"
                  : "neutral"
            }
          >
            {row.status.replaceAll("_", " ")}
          </StatusPill>
        </div>
      ))}
    </div>
  );
}

function OperationsHub({ session }: { session: Session }) {
  const sections: Array<{
    id: OperationsSection;
    label: string;
    permission: Permission;
  }> = [
    { id: "operations", label: "Operations", permission: "operations.view" },
    { id: "projects", label: "Projects", permission: "projects.view" },
    { id: "tasks", label: "Tasks", permission: "tasks.view" },
    {
      id: "client-requests",
      label: "Client requests",
      permission: "operations.manage",
    },
  ];
  const visible = sections.filter((item) =>
    allowed(session.user, item.permission),
  );
  const initial = pathOperationsSection(location.pathname);
  const [section, setSection] = useState<OperationsSection>(
    visible.some((item) => item.id === initial)
      ? initial
      : visible[0]?.id || "operations",
  );
  useEffect(() => {
    const sync = () => {
      if (pathPage(location.pathname) !== "operations") return;
      const requested = pathOperationsSection(location.pathname),
        next = visible.some((item) => item.id === requested)
          ? requested
          : visible[0]?.id || "operations";
      setSection(next);
      const expected = operationsSectionPath(next);
      const isRequestDetail =
        next === "client-requests" &&
        location.pathname.startsWith(`${expected}/`);
      if (!isRequestDetail && location.pathname !== expected)
        history.replaceState(null, "", expected);
    };
    sync();
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, [session.user.permissions.join("|")]);
  const open = (next: OperationsSection) => {
    setSection(next);
    history.pushState(null, "", operationsSectionPath(next));
    window.scrollTo(0, 0);
  };
  return (
    <>
      <nav
        className="operations-subtabs"
        role="tablist"
        aria-label="Operations views"
      >
        {visible.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={section === item.id}
            className={section === item.id ? "active" : ""}
            onClick={() => open(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {section === "operations" && allowed(session.user, "operations.view") && (
        <Operations session={session} />
      )}
      {section === "projects" && allowed(session.user, "projects.view") && (
        <Projects session={session} />
      )}{" "}
      {section === "tasks" && allowed(session.user, "tasks.view") && <Tasks />}
      {section === "client-requests" &&
        allowed(session.user, "operations.manage") && <ClientRequestWorkflow mapToken={session.mapboxPublicToken} />}
    </>
  );
}

type ClientRequest = {
  id: string;
  account_name: string;
  project_name: string | null;
  client_name: string | null;
  request_type: "flight" | "service";
  title: string;
  details: string;
  location_text: string | null;
  preferred_start_at: string | null;
  service_category: string | null;
  deliverables_text: string | null;
  site_contact_name: string | null;
  site_contact_email: string | null;
  site_contact_phone: string | null;
  desired_completion_at: string | null;
  latitude: number | null;
  longitude: number | null;
  area_geojson: string | null;
  status:
    | "submitted"
    | "under_review"
    | "accepted_pending_pa_linkage"
    | "accepted_linked"
    | "declined"
    | "cancelled"
    | "completed";
  quote_document_number: string | null;
  created_at: string;
};
function ClientRequestQueue() {
  const { data, error, reload } = useLoad(
    () => api<{ requests: ClientRequest[] }>("/api/client-service-requests"),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const update = async (
    request: ClientRequest,
    status:
      "under_review" | "accepted_pending_pa_linkage" | "declined" | "completed",
  ) => {
    if (busy) return;
    setBusy(request.id);
    try {
      await api(
        `/api/client-service-requests/${encodeURIComponent(request.id)}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
      await reload();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const linkQuote = async (request: ClientRequest) => {
    const raw = prompt("Project Alpha accepted quote ID");
    if (!raw) return;
    const artifactId = Number(raw);
    if (!Number.isInteger(artifactId) || artifactId <= 0) {
      alert("Enter a positive Project Alpha quote ID.");
      return;
    }
    setBusy(request.id);
    try {
      await api(
        `/api/client-service-requests/${encodeURIComponent(request.id)}/pa-quote`,
        { method: "POST", body: JSON.stringify({ artifactId }) },
      );
      await reload();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="notice managed-notice">
        <strong>Project Alpha remains authoritative</strong>
        <span>
          Accepting a request moves it to pending linkage. It becomes linked
          only after an accepted Project Alpha quote is verified.
        </span>
      </div>
      <ErrorLine error={error} />
      <Card title="Client request queue">
        {data?.requests.length ? (
          <div className="simple-rows">
            {data.requests.map((request) => (
              <article key={request.id}>
                <div>
                  <strong>{request.title}</strong>
                  <small>
                    {request.account_name} ·{" "}
                    {request.project_name || "On-demand request"} ·{" "}
                    {request.request_type}
                    {request.service_category
                      ? ` · ${request.service_category}`
                      : ""}
                  </small>
                  <p>{request.details}</p>
                  {request.deliverables_text && (
                    <p>
                      <strong>Deliverables:</strong> {request.deliverables_text}
                    </p>
                  )}
                  <small>
                    {request.location_text || "No location"}
                    {request.area_geojson
                      ? " · Map area provided"
                      : request.latitude !== null && request.longitude !== null
                        ? " · Map point provided"
                        : ""}{" "}
                    ·{" "}
                    {request.preferred_start_at
                      ? `Preferred ${date(request.preferred_start_at)}`
                      : "No preferred time"}
                    {request.desired_completion_at
                      ? ` · Needed by ${date(request.desired_completion_at)}`
                      : ""}
                  </small>
                  {request.quote_document_number && (
                    <small>
                      Verified PA quote: {request.quote_document_number}
                    </small>
                  )}
                </div>
                <div className="client-request-actions">
                  <StatusPill
                    tone={
                      request.status === "accepted_linked" ||
                      request.status === "completed"
                        ? "success"
                        : request.status === "declined" ||
                            request.status === "cancelled"
                          ? "danger"
                          : request.status === "submitted" ||
                              request.status === "accepted_pending_pa_linkage"
                            ? "warning"
                            : "neutral"
                    }
                  >
                    {request.status.replaceAll("_", " ")}
                  </StatusPill>
                  {request.status === "submitted" && (
                    <button
                      className="button-ghost button-small"
                      disabled={busy === request.id}
                      onClick={() => void update(request, "under_review")}
                    >
                      Review
                    </button>
                  )}
                  {["submitted", "under_review"].includes(request.status) && (
                    <button
                      className="button-orange button-small"
                      disabled={busy === request.id}
                      onClick={() =>
                        void update(request, "accepted_pending_pa_linkage")
                      }
                    >
                      Accept pending PA quote
                    </button>
                  )}
                  {request.status === "accepted_pending_pa_linkage" && (
                    <button
                      className="button-orange button-small"
                      disabled={busy === request.id}
                      onClick={() => void linkQuote(request)}
                    >
                      Verify PA quote
                    </button>
                  )}
                  {["submitted", "under_review"].includes(request.status) && (
                    <button
                      className="button-danger button-small"
                      disabled={busy === request.id}
                      onClick={() => void update(request, "declined")}
                    >
                      Decline
                    </button>
                  )}
                  {request.status === "accepted_linked" && (
                    <button
                      className="button-orange button-small"
                      disabled={busy === request.id}
                      onClick={() => void update(request, "completed")}
                    >
                      Complete
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No client requests"
            detail="Submitted client requests will appear here for triage."
          />
        )}
      </Card>
    </>
  );
}

function Operations({ session }: { session: Session }) {
  const { data, error } = useLoad(
    () => api<{ operations: any[] }>("/api/operations"),
    [],
  );
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [briefDirty, setBriefDirty] = useState(false);
  const selectBrief = useCallback((operationId: string | null) => {
    if (briefDirty && !window.confirm("Discard the unsaved job brief draft?")) return;
    setBriefDirty(false);
    setSelectedOperationId(operationId);
  }, [briefDirty]);
  return (
    <>
      <ManagedNotice detail="Project Alpha manages operation identity, schedule, and assignment. LTDS Operations owns the versioned execution brief shown to assigned pilots." />
      <ErrorLine error={error} />
      <Card className="table-card">
        {data?.operations.length ? (
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Business unit</th>
                <th>Schedule</th>
                <th>Status</th>
                <th>Brief</th>
              </tr>
            </thead>
            <tbody>
              {data.operations.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    <small>{item.project_name || "No linked project"}</small>
                  </td>
                  <td>
                    {item.division_name ||
                      item.business_unit_name ||
                      "Unassigned"}
                  </td>
                  <td>{date(item.scheduled_start)}</td>
                  <td>
                    <StatusPill
                      tone={
                        item.status === "blocked" || item.status === "cancelled"
                          ? "danger"
                          : item.status === "ready" ||
                              item.status === "completed"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {item.status.replaceAll("_", " ")}
                    </StatusPill>
                  </td>
                  <td>
                    <button
                      className="button-ghost button-small"
                      aria-expanded={selectedOperationId === item.id}
                      onClick={() => selectBrief(selectedOperationId === item.id ? null : item.id)}
                    >
                      {selectedOperationId === item.id ? "Close brief" : "View brief"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No operations yet"
            detail="Operations will appear after Project Alpha synchronizes."
          />
        )}
      </Card>
      {selectedOperationId && (
        <JobBriefPanel
          key={selectedOperationId}
          operationId={selectedOperationId}
          canReferenceProjectFiles={allowed(session.user, "delivery.browse")}
          onDirtyChange={setBriefDirty}
          close={() => selectBrief(null)}
        />
      )}
    </>
  );
}

type PortalAccount = {
  id: string;
  display_name: string;
  status: string;
  project_count: number;
};
function Projects({ session }: { session: Session }) {
  const [search, setSearch] = useState("");
  const { data, error, reload } = useLoad(
    () =>
      api<{ projects: any[] }>(
        `/api/projects${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      ),
    [search],
  );
  const accounts = useLoad(
    () =>
      session.user.isAdministrator
        ? api<{ accounts: PortalAccount[] }>("/api/client-portal/accounts")
        : Promise.resolve({ accounts: [] }),
    [],
  );
  return (
    <>
      <ManagedNotice
        detail={
          session.user.isAdministrator
            ? "Project details remain managed in Project Alpha. Link a client account and bounded delivery folder here."
            : "Project details are read-only here and scoped only to your Project, Operation, and Task assignments."
        }
      />
      <div className="section-actions">
        <input
          className="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects, clients, or managers"
        />
        <button className="button-ghost" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <ErrorLine error={error || accounts.error} />
      <div className="card-grid">
        {data?.projects.map((project) => (
          <Card key={project.id}>
            <div className="project-card">
              <div className="record-badges">
                <StatusPill>{project.status || "project"}</StatusPill>
                <span className="managed-badge">Managed in Project Alpha</span>
              </div>
              <h3>{project.name}</h3>
              <p>{project.customer_name}</p>
              <small>
                {project.manager_name
                  ? `Manager: ${project.manager_name}`
                  : "No project manager"}
              </small>
              <small>
                {project.start_date
                  ? `Starts ${new Date(project.start_date).toLocaleDateString()}`
                  : "No project date"}
              </small>
              {project.r2_prefix && <code>{project.r2_prefix}</code>}
              {session.user.isAdministrator &&
                allowed(session.user, "delivery.browse") && (
                  <FolderAssociation
                    project={project}
                    session={session}
                    accounts={accounts.data?.accounts || []}
                  />
                )}
            </div>
          </Card>
        ))}
      </div>
      {data && !data.projects.length && (
        <Card>
          <EmptyState
            title="No matching projects"
            detail="Project Alpha projects will appear after a successful sync."
          />
        </Card>
      )}
    </>
  );
}
function FolderAssociation({
  project,
  session,
  accounts,
}: {
  project: any;
  session: Session;
  accounts: PortalAccount[];
}) {
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  return open ? (
    <form
      className="folder-association"
      onSubmit={async (event) => {
        event.preventDefault();
        const raw = Object.fromEntries(new FormData(event.currentTarget));
        try {
          await api("/api/client-portal/projects", {
            method: "POST",
            body: JSON.stringify({
              accountId: raw.accountId,
              projectAlphaProjectId: project.id,
              canRequestService: true,
            }),
          });
          await api(`/api/projects/${project.id}/folder`, {
            method: "POST",
            body: JSON.stringify({
              divisionId: raw.divisionId,
              r2Prefix: raw.r2Prefix,
              accountId: raw.accountId,
            }),
          });
          setMessage("Client workspace and delivery folder linked.");
        } catch (caught) {
          setMessage((caught as Error).message);
        }
      }}
    >
      <select name="accountId" required defaultValue="">
        <option value="" disabled>
          Select client account
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.display_name}
          </option>
        ))}
      </select>
      <select name="divisionId">
        {session.user.divisions.map((div) => (
          <option key={div.id} value={div.id}>
            {div.name}
          </option>
        ))}
      </select>
      <input
        name="r2Prefix"
        defaultValue={project.r2_prefix || ""}
        placeholder="Jobs/Clients/client/project/"
        required
      />
      <button
        className="button-orange button-small"
        disabled={!accounts.length}
      >
        Link workspace
      </button>
      {!accounts.length && (
        <small>Provision a client account in Administration first.</small>
      )}
      {message && <small>{message}</small>}
    </form>
  ) : (
    <button className="button-ghost button-small" onClick={() => setOpen(true)}>
      {project.r2_prefix ? "Edit client linkage" : "Link client workspace"}
    </button>
  );
}

function Tasks() {
  const { data, error } = useLoad(
    () => api<{ tasks: any[] }>("/api/tasks"),
    [],
  );
  const columns = [
    { key: "todo", label: "To do" },
    { key: "in_progress", label: "In progress" },
    { key: "blocked", label: "Blocked" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
  ];
  return (
    <>
      <ManagedNotice />
      <ErrorLine error={error} />
      <div className="kanban">
        {columns.map((column) => (
          <Card key={column.key} title={column.label}>
            <div className="task-stack">
              {data?.tasks
                .filter(
                  (task) =>
                    task.status === column.key ||
                    (column.key === "completed" && task.status === "done"),
                )
                .map((task) => (
                  <article key={task.id}>
                    <strong>{task.title}</strong>
                    <p>
                      {task.description ||
                        task.notes ||
                        task.project_name ||
                        task.operation_title ||
                        "Operational task"}
                    </p>
                    <small>
                      {task.assigned_name || "Unassigned"} · {date(task.due_at)}
                    </small>
                  </article>
                ))}
              {data &&
                !data.tasks.some(
                  (task) =>
                    task.status === column.key ||
                    (column.key === "completed" && task.status === "done"),
                ) && <span className="column-empty">No tasks</span>}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Airspace() {
  const { data, error, reload } = useLoad(
    () => api<any>("/api/airspace/tfrs"),
    [],
  );
  const activeTfrs =
    data?.tfrs?.filter((item: any) => item.status === "active").length || 0;
  const scheduledTfrs =
    data?.tfrs?.filter((item: any) => item.status === "scheduled").length || 0;
  const suaStatusRank: Record<string, number> = {
    active: 0,
    pending: 0,
    upcoming: 1,
    not_listed: 2,
  };
  data?.sua?.sort(
    (a: any, b: any) =>
      (suaStatusRank[a.status] ?? 3) - (suaStatusRank[b.status] ?? 3),
  );
  return (
    <>
      <div className="safety-banner">
        <strong>Situational awareness only</strong>
        <p>
          {data?.disclaimer ||
            "Verify current FAA sources and NOTAMs before flight. This screen never represents a clearance."}
        </p>
      </div>
      <div className="section-actions">
        <button className="button-ghost" onClick={() => void reload()}>
          Refresh view
        </button>
      </div>
      <ErrorLine error={error} />
      <div className="airspace-counts">
        <div>
          <strong>{activeTfrs}</strong>
          <span>Active TFRs</span>
        </div>
        <div>
          <strong>{scheduledTfrs}</strong>
          <span>Scheduled TFRs</span>
        </div>
        <p>This feed lists TFR-related NOTAMs, not every FAA NOTAM.</p>
      </div>
      <div className="source-strip">
        {data?.sources.map((source: any) => (
          <div key={source.source}>
            <strong>{source.source}</strong>
            <StatusPill
              tone={
                source.status === "fresh"
                  ? "success"
                  : source.status === "error"
                    ? "danger"
                    : "warning"
              }
            >
              {source.status}
            </StatusPill>
            <small>
              {source.last_success_at
                ? date(source.last_success_at)
                : "No successful refresh"}
            </small>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        {data?.operationMatches?.length ? (
          <Card title="Operations requiring airspace review">
            {data.operationMatches.map((item: any) => (
              <article
                className="airspace-row"
                key={`${item.operation_id}-${item.source_type}-${item.source_id}`}
              >
                <div>
                  <strong>{item.operation_title}</strong>
                  <p>{item.source_title}</p>
                </div>
                <StatusPill
                  tone={item.match_type === "intersects" ? "danger" : "warning"}
                >
                  {item.match_type}
                </StatusPill>
              </article>
            ))}
          </Card>
        ) : null}
        <Card title="Temporary Flight Restrictions">
          {data?.tfrs.length ? (
            data.tfrs.map((item: any) => (
              <article className="airspace-row" key={item.id}>
                <div>
                  <strong>
                    {item.notam_id} · {item.title}
                  </strong>
                  <p>{item.description}</p>
                  <small>
                    {item.geometry_available
                      ? "Mapped geometry"
                      : "Geometry unavailable"}{" "}
                    · {date(item.effective_at)} to {date(item.expires_at)}
                  </small>
                </div>
                <div>
                  <StatusPill
                    tone={
                      item.status === "active"
                        ? "danger"
                        : item.status === "scheduled"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {item.status}
                  </StatusPill>
                  <a href={item.official_url} target="_blank" rel="noreferrer">
                    FAA record
                  </a>
                </div>
              </article>
            ))
          ) : (
            <EmptyState
              title="No listed Wisconsin TFRs"
              detail="Check the source freshness above; this is not a clearance."
            />
          )}
        </Card>
        <Card title="MOA & special-use airspace">
          {data?.sua.length ? (
            data.sua.map((item: any) => (
              <article className="airspace-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p>
                    {item.airspace_type} ·{" "}
                    {item.low_altitude || "Lower altitude not listed"} to{" "}
                    {item.high_altitude || "Upper altitude not listed"}
                  </p>
                  <small>
                    {item.status === "not_listed"
                      ? "No current reservation is listed; published operating hours may still apply."
                      : `${date(item.starts_at)} to ${date(item.ends_at)}`}
                  </small>
                </div>
                <StatusPill
                  tone={
                    item.status === "active"
                      ? "danger"
                      : item.status === "upcoming" || item.status === "pending"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {item.status.replaceAll("_", " ")}
                </StatusPill>
              </article>
            ))
          ) : (
            <EmptyState
              title="No SUA schedule records"
              detail="A missing schedule is unknown, never assumed inactive."
            />
          )}
        </Card>
      </div>
    </>
  );
}

function Delivery({ session }: { session: Session }) {
  const [prefix, setPrefix] = useState("Jobs/Clients/"),
    [view, setView] = useState<"grid" | "list">("grid"),
    [preview, setPreview] = useState<any>(null),
    [shareRevision, setShareRevision] = useState(0);
  const { data, error, reload } = useLoad(
    () =>
      api<any>(`/api/delivery/folders?prefix=${encodeURIComponent(prefix)}`),
    [prefix],
  );
  const crumbs = useMemo(() => {
    const parts = prefix.split("/").filter(Boolean);
    let built = "";
    return parts.map((name) => {
      built += `${name}/`;
      return { name, prefix: built };
    });
  }, [prefix]);
  return (
    <>
      <div className="delivery-tools">
        <nav>
          <button onClick={() => setPrefix("")}>All files</button>
          {crumbs.map((crumb) => (
            <span key={crumb.prefix}>
              /
              <button onClick={() => setPrefix(crumb.prefix)}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <button
          className={view === "grid" ? "active" : ""}
          onClick={() => setView("grid")}
        >
          Grid
        </button>
        <button
          className={view === "list" ? "active" : ""}
          onClick={() => setView("list")}
        >
          List
        </button>
        <button className="button-ghost" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <ErrorLine error={error} />
      <Card className="file-browser">
        {!data ? (
          <Loading />
        ) : !data.folders.length && !data.files.length ? (
          <EmptyState
            title="This folder is empty"
            detail="The view updates dynamically when TrueNAS syncs new content."
          />
        ) : view === "grid" ? (
          <div className="file-grid">
            {data.folders.map((item: any) => (
              <FolderCard
                key={item.prefix}
                item={item}
                open={() => setPrefix(item.prefix)}
                share={
                  allowed(session.user, "delivery.share.create")
                    ? () => setPreview({ shareFolder: item })
                    : undefined
                }
              />
            ))}
            {data.files.map((item: any) => (
              <FileCard
                key={item.id}
                item={item}
                preview={() => setPreview(item)}
              />
            ))}
          </div>
        ) : (
          <div className="file-list">
            {data.folders.map((item: any) => (
              <button key={item.prefix} onClick={() => setPrefix(item.prefix)}>
                <span>▰</span>
                <strong>{item.name}</strong>
                {item.isShared && <SharedBadge />}
                <small>Folder</small>
              </button>
            ))}
            {data.files.map((item: any) => (
              <button key={item.id} onClick={() => setPreview(item)}>
                <span>▧</span>
                <strong>{item.name}</strong>
                {item.isShared && <SharedBadge />}
                <small>{bytes(item.size)}</small>
              </button>
            ))}
          </div>
        )}
      </Card>
      {preview?.shareFolder && (
        <ShareDialog
          folder={preview.shareFolder}
          canRevoke={allowed(session.user, "delivery.share.revoke")}
          close={() => setPreview(null)}
          changed={() => setShareRevision((value) => value + 1)}
        />
      )}{" "}
      {preview && !preview.shareFolder && (
        <FilePreview item={preview} close={() => setPreview(null)} />
      )}
      <TrashPanel />
      <ShareHistory session={session} revision={shareRevision} />
    </>
  );
}
type DeliveryItem = {
  id?: string;
  prefix?: string;
  physicalKey?: string;
  name?: string;
  displayName?: string;
  kind?: string;
  size?: number;
  isShared?: boolean;
  thumbnailUrl?: string;
  thumbnailState?: "pending" | "ready" | "failed" | "not_applicable";
  thumbnailErrorCode?: string;
  thumbnailFallbackKind?: string;
  downloadUrl?: string;
  previewUrl?: string;
  sourceUrl?: string;
  previewStatus?: string;
  searchPath?: string;
};
type DeliveryFolderPage = {
  prefix: string;
  folders?: DeliveryItem[];
  files?: DeliveryItem[];
  nextCursor?: string | null;
};
const MAX_DELIVERY_FOLDER_PAGES = 100;
type DeliveryOperation = {
  id?: string;
  operationId?: string;
  jobId?: string;
  status?: string;
  progress?: number;
  processed_items?: number;
  total_items?: number;
  message?: string;
  error?: string;
  error_message?: string;
};
function joinDeliveryPath(prefix: string, name: string, folder = false) {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${base}${name.replace(/^\/+/, "")}${folder ? "/" : ""}`;
}
function itemKey(item: DeliveryItem) {
  return item.physicalKey || item.prefix || "";
}
type BrowserUploadConflictResolution = "skip" | "rename" | "replace";
type BrowserUploadConflict = {
  intentId: string;
  ordinal: number;
  relativePath: string;
  choices: BrowserUploadConflictResolution[];
};
type BrowserUploadConflictResolver = (
  conflict: BrowserUploadConflict,
) => Promise<BrowserUploadConflictResolution | null>;
type BrowserUploadConflictPrompt = BrowserUploadConflict & {
  resolve: (resolution: BrowserUploadConflictResolution | null) => void;
};
type BrowserUploadProgress = {
  ordinal: number;
  name: string;
  relativePath: string;
  uploadedBytes: number;
  totalBytes: number;
  status: "pending" | "uploading" | "completed" | "skipped" | "failed" | "stopped";
  error?: string;
};
type BrowserUploadSession = {
  sessionId?: string;
  partSize?: number;
  status: "active" | "completed" | "skipped" | "aborted" | "expired";
  parts?: Array<{ partNumber: number; etag: string; size: number }>;
};
type BrowserUploadPartTicket = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  partNumber: number;
  size: number;
};
const MAX_BROWSER_UPLOAD_FILES = 100;
const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 ** 3;
const MAX_BROWSER_UPLOAD_FILE_BYTES = 500 * 1024 ** 3;
const BLOCKED_BROWSER_UPLOAD_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
]);
const RESERVED_BROWSER_UPLOAD_SEGMENTS = new Set([
  "dump",
  "_ltds",
  ".previews",
]);

class UploadAuthorizationError extends Error {}
class DirectUploadError extends Error {}

function browserUploadRelativePath(file: File) {
  const supplied =
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
    file.name;
  if (
    !supplied ||
    supplied.length > 1000 ||
    supplied.startsWith("/") ||
    supplied.includes("\\") ||
    supplied.endsWith("/") ||
    supplied.includes("//") ||
    /[\0-\x1f\x7f]/.test(supplied)
  )
    throw new Error(`“${file.name}” has an invalid relative path.`);
  const normalized = supplied.normalize("NFC"),
    parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        RESERVED_BROWSER_UPLOAD_SEGMENTS.has(part.toLowerCase()),
    )
  )
    throw new Error(`“${file.name}” has an invalid or reserved path.`);
  return normalized;
}

function uploadError(error: unknown): Error {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403))
    return new UploadAuthorizationError(
      "Upload stopped because your Operations authorization expired or changed. Reauthenticate and verify access before retrying.",
    );
  return error instanceof Error ? error : new Error("The upload failed.");
}

function retryableUploadError(error: unknown) {
  if (!(error instanceof ApiError)) return error instanceof TypeError;
  return (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500 ||
    (error.status === 409 &&
      error.message.toLowerCase().includes("already in progress"))
  );
}

async function uploadDirectR2Part(
  sessionId: string,
  partNumber: number,
  chunk: Blob,
) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const ticket = await api<BrowserUploadPartTicket>(
        `/api/delivery/uploads/${encodeURIComponent(sessionId)}/parts/${partNumber}/ticket`,
        { method: "POST", body: "{}" },
      );
      let directUrl: URL;
      try {
        directUrl = new URL(ticket.url);
      } catch {
        throw new DirectUploadError("The upload part ticket URL was invalid.");
      }
      if (
        ticket.method !== "PUT" ||
        ticket.partNumber !== partNumber ||
        ticket.size !== chunk.size ||
        !Number.isFinite(Date.parse(ticket.expiresAt)) ||
        Date.parse(ticket.expiresAt) <= Date.now() + 5_000 ||
        directUrl.protocol !== "https:" ||
        !directUrl.hostname.endsWith(".r2.cloudflarestorage.com") ||
        directUrl.origin === location.origin
      )
        throw new DirectUploadError("The upload part ticket was invalid or expired.");
      const headers = new Headers(ticket.headers);
      if (headers.get("Content-Type") !== "application/octet-stream")
        throw new DirectUploadError("The upload part ticket had invalid headers.");
      let response: Response;
      try {
        response = await fetch(directUrl, {
          method: ticket.method,
          headers,
          body: chunk,
          credentials: "omit",
        });
      } catch {
        throw new DirectUploadError("The browser could not reach R2 for this upload part.");
      }
      if (!response.ok)
        throw new DirectUploadError(`R2 rejected the upload part (${response.status}).`);
      const etag = response.headers.get("ETag")?.trim();
      if (!etag) throw new DirectUploadError("R2 did not return an upload part ETag.");
      await api(
        `/api/delivery/uploads/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
        {
          method: "PUT",
          body: JSON.stringify({ etag, size: chunk.size }),
        },
      );
      return;
    } catch (caught) {
      const error = uploadError(caught);
      if (error instanceof UploadAuthorizationError) throw error;
      if (!(error instanceof DirectUploadError) || attempt === 2) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError || new DirectUploadError("The direct upload part failed.");
}

async function uploadIntentFile(
  intentId: string,
  ordinal: number,
  file: File,
  progress: (value: BrowserUploadProgress) => void,
  relativePath: string,
  resolveConflict: BrowserUploadConflictResolver,
) {
  let lastError: Error | undefined;
  let selectedResolution: BrowserUploadConflictResolution | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const created = await api<BrowserUploadSession>("/api/delivery/uploads", {
        method: "POST",
        body: JSON.stringify({
          intentId,
          ordinal,
          ...(selectedResolution ? { conflictResolution: selectedResolution } : {}),
        }),
      });
      if (created.status === "skipped") {
        progress({
          ordinal,
          name: file.name,
          relativePath,
          uploadedBytes: 0,
          totalBytes: file.size,
          status: "skipped",
          error: "Kept the existing file.",
        });
        return "skipped" as const;
      }
      if (created.status === "completed") {
        progress({
          ordinal,
          name: file.name,
          relativePath,
          uploadedBytes: file.size,
          totalBytes: file.size,
          status: "completed",
        });
        return "completed" as const;
      }
      if (!created.sessionId || !created.partSize) throw new Error("The upload session response was incomplete.");
      const checkpoint = await api<BrowserUploadSession>(
        `/api/delivery/uploads/${encodeURIComponent(created.sessionId)}`,
      );
      if (checkpoint.status === "completed") {
        progress({
          ordinal,
          name: file.name,
          relativePath,
          uploadedBytes: file.size,
          totalBytes: file.size,
          status: "completed",
        });
        return "completed" as const;
      }
      const uploadedParts = new Map(
        (checkpoint.parts || []).map((part) => [part.partNumber, part.size]),
      );
      let uploadedBytes = [...uploadedParts.values()].reduce(
        (total, size) => total + size,
        0,
      );
      progress({
        ordinal,
        name: file.name,
        relativePath,
        uploadedBytes,
        totalBytes: file.size,
        status: "uploading",
      });
      for (
        let offset = 0, partNumber = 1;
        offset < file.size;
        offset += created.partSize, partNumber += 1
      ) {
        if (uploadedParts.has(partNumber)) continue;
        const chunk = file.slice(
          offset,
          Math.min(file.size, offset + created.partSize),
        );
        await uploadDirectR2Part(created.sessionId, partNumber, chunk);
        uploadedBytes += chunk.size;
        progress({
          ordinal,
          name: file.name,
          relativePath,
          uploadedBytes,
          totalBytes: file.size,
          status: "uploading",
        });
      }
      let completionResolution: BrowserUploadConflictResolution | null = null;
      let completion: { status?: string } | undefined;
      for (let completionAttempt = 0; completionAttempt < 3; completionAttempt += 1) {
        try {
          completion = await api<{ status?: string }>(
            `/api/delivery/uploads/${encodeURIComponent(created.sessionId)}/complete`,
            {
              method: "POST",
              body: JSON.stringify(completionResolution ? { conflictResolution: completionResolution } : {}),
            },
          );
          break;
        } catch (caught) {
          if (
            caught instanceof ApiError &&
            caught.status === 409 &&
            caught.payload.error === "upload_destination_conflict"
          ) {
            const conflict = caught.payload.conflict as BrowserUploadConflict | undefined;
            if (!conflict || conflict.intentId !== intentId || conflict.ordinal !== ordinal)
              throw new Error("The upload conflict response was invalid.");
            if (completionAttempt === 2)
              throw new Error(`The collision for “${relativePath}” changed repeatedly. Refresh and try again.`);
            completionResolution = await resolveConflict(conflict);
            if (!completionResolution) throw new Error(`Upload cancelled for “${relativePath}”.`);
            continue;
          }
          const error = uploadError(caught);
          if (error instanceof UploadAuthorizationError) throw error;
          if (!retryableUploadError(caught) || completionAttempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** completionAttempt));
        }
      }
      if (!completion) throw new Error("The upload could not be completed.");
      if (completion.status === "skipped") {
        progress({
          ordinal,
          name: file.name,
          relativePath,
          uploadedBytes: 0,
          totalBytes: file.size,
          status: "skipped",
          error: "Kept the existing file.",
        });
        return "skipped" as const;
      }
      progress({
        ordinal,
        name: file.name,
        relativePath,
        uploadedBytes: file.size,
        totalBytes: file.size,
        status: "completed",
      });
      return "completed" as const;
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.status === 409 &&
        caught.payload.error === "upload_destination_conflict"
      ) {
        const conflict = caught.payload.conflict as BrowserUploadConflict | undefined;
        if (!conflict || conflict.intentId !== intentId || conflict.ordinal !== ordinal)
          throw new Error("The upload conflict response was invalid.");
        if (attempt === 2) throw new Error(`The collision for “${relativePath}” changed repeatedly. Refresh and try again.`);
        selectedResolution = await resolveConflict(conflict);
        if (!selectedResolution) throw new Error(`Upload cancelled for “${relativePath}”.`);
        continue;
      }
      lastError = uploadError(caught);
      if (lastError instanceof UploadAuthorizationError) throw lastError;
      if (!retryableUploadError(caught) || attempt === 2) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError || new Error("The upload failed.");
}

async function uploadDeliveryFiles(
  prefix: string,
  files: File[],
  progress: (value: BrowserUploadProgress) => void,
  resolveConflict: BrowserUploadConflictResolver,
) {
  if (!files.length) return { completed: 0, skipped: 0, failed: 0 };
  if (files.length > MAX_BROWSER_UPLOAD_FILES)
    throw new Error(
      `Choose no more than ${MAX_BROWSER_UPLOAD_FILES} files at a time.`,
    );
  const prepared = files.map((file, ordinal) => {
    const relativePath = browserUploadRelativePath(file),
      contentType = (file.type || "application/octet-stream").toLowerCase();
    if (file.size <= 0 || file.size > MAX_BROWSER_UPLOAD_FILE_BYTES)
      throw new Error(`“${relativePath}” has an unsupported file size.`);
    if (BLOCKED_BROWSER_UPLOAD_TYPES.has(contentType))
      throw new Error(`“${relativePath}” is an active web file and cannot be uploaded.`);
    return { file, ordinal, relativePath, contentType };
  });
  const totalBytes = prepared.reduce((total, item) => total + item.file.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BROWSER_UPLOAD_BYTES)
    throw new Error(`The selected batch exceeds the ${bytes(MAX_BROWSER_UPLOAD_BYTES)} limit.`);
  prepared.forEach(({ file, ordinal, relativePath }) =>
    progress({
      ordinal,
      name: file.name,
      relativePath,
      uploadedBytes: 0,
      totalBytes: file.size,
      status: "pending",
    }),
  );
  const idempotencyKey = crypto.randomUUID(),
    intentRequest = {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        rootPrefix: prefix,
        files: prepared.map(({ relativePath, file, contentType }) => ({
          relativePath,
          size: file.size,
          contentType,
        })),
      }),
    } satisfies RequestInit;
  let intent: { intentId: string } | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      intent = await api<{ intentId: string }>(
        "/api/delivery/uploads/intents",
        intentRequest,
      );
      break;
    } catch (caught) {
      const error = uploadError(caught);
      if (error instanceof UploadAuthorizationError) {
        prepared.forEach(({ file, ordinal, relativePath }) =>
          progress({
            ordinal,
            name: file.name,
            relativePath,
            uploadedBytes: 0,
            totalBytes: file.size,
            status: "stopped",
            error: error.message,
          }),
        );
      }
      if (
        error instanceof UploadAuthorizationError ||
        !retryableUploadError(caught) ||
        attempt === 2
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  if (!intent) throw new Error("The upload intent could not be created.");
  let completed = 0,
    skipped = 0,
    failed = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]!;
    try {
      const outcome = await uploadIntentFile(
        intent.intentId,
        item.ordinal,
        item.file,
        progress,
        item.relativePath,
        resolveConflict,
      );
      if (outcome === "skipped") skipped += 1;
      else completed += 1;
    } catch (caught) {
      const error = uploadError(caught);
      if (error instanceof UploadAuthorizationError) {
        for (let rest = index; rest < prepared.length; rest += 1) {
          const stopped = prepared[rest]!;
          progress({
            ordinal: stopped.ordinal,
            name: stopped.file.name,
            relativePath: stopped.relativePath,
            uploadedBytes: 0,
            totalBytes: stopped.file.size,
            status: "stopped",
            error: error.message,
          });
        }
        throw error;
      }
      failed += 1;
      progress({
        ordinal: item.ordinal,
        name: item.file.name,
        relativePath: item.relativePath,
        uploadedBytes: 0,
        totalBytes: item.file.size,
        status: "failed",
        error: error.message,
      });
    }
  }
  return { completed, skipped, failed };
}

const legacyBrowserUploadConflict: BrowserUploadConflictResolver = async (conflict) => {
  throw new Error(`“${conflict.relativePath}” already exists. Resolve the collision in the current Delivery workspace.`);
};

async function uploadDeliveryFile(prefix: string, file: File) {
  const result = await uploadDeliveryFiles(prefix, [file], () => {}, legacyBrowserUploadConflict);
  if (result.failed) throw new Error(`Upload failed for ${file.name}.`);
  return {
    status: "completed",
    progress: 1,
    message: `Uploaded ${file.name}`,
  } satisfies DeliveryOperation;
}
const deliveryOperations = {
  createFolder: (prefix: string, name: string) =>
    api<DeliveryOperation>("/api/delivery/fs/folders", {
      method: "POST",
      body: JSON.stringify({ key: joinDeliveryPath(prefix, name, true) }),
    }),
  mutate: (
    action: string,
    sourceKeyOrBody: string | Record<string, unknown>,
    targetKey?: string,
    sharePolicy: "keep" | "revoke" = "revoke",
    conflict: "fail" | "replace" | "rename" = "fail",
  ) => {
    if (typeof sourceKeyOrBody !== "string" || !targetKey)
      return Promise.reject(
        new Error("The file operation request is invalid."),
      );
    return api<DeliveryOperation>(`/api/delivery/fs/${action}`, {
      method: "POST",
      body: JSON.stringify({
        sourceKey: sourceKeyOrBody,
        targetKey,
        conflict,
        sharePolicy,
      }),
    }).then((value) => ({ ...value, operationId: value.jobId }));
  },
  remove: (item: DeliveryItem) =>
    api<DeliveryOperation>(
      `/api/delivery/fs/items/${encodeURIComponent(itemRef(item))}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          confirmation:
            itemKey(item).replace(/\/$/, "").split("/").pop() ||
            displayName(item),
        }),
      },
    ),
  upload: uploadDeliveryFile,
  status: (id: string) =>
    api<{ job: DeliveryOperation }>(
      `/api/delivery/fs/jobs/${encodeURIComponent(id)}`,
    ).then((value) => ({
      ...value.job,
      progress: value.job.total_items
        ? Number(value.job.processed_items || 0) / Number(value.job.total_items)
        : 0,
      error: value.job.error_message || undefined,
    })),
};
function itemRef(item: DeliveryItem) {
  return item.id || item.prefix || item.name || "";
}
function DeliveryWorkspace({ session }: { session: Session }) {
  const [prefix, setPrefix] = useState("Jobs/Clients/"),
    [view, setView] = useState<"grid" | "list">("grid"),
    [preview, setPreview] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [selectionMode, setSelectionMode] = useState(false),
    [operation, setOperation] = useState<DeliveryOperation | null>(null),
    [operationError, setOperationError] = useState(""),
    [uploading, setUploading] = useState(false),
    [input, setInput] = useState<HTMLInputElement | null>(null);
  const { data, error, reload, loading } = useLoad<any>(
    () => cachedFolderApi(prefix),
    [prefix],
  );
  const displayData = data;
  const items: DeliveryItem[] = displayData
    ? [...(displayData.folders || []), ...(displayData.files || [])]
    : [];
  const canWrite =
      session.user.isAdministrator || allowed(session.user, "delivery.rename"),
    canUpload =
      session.user.isAdministrator &&
      allowed(session.user, "delivery.files.upload") &&
      session.capabilities?.directDeliveryUploads?.enabled === true,
    canDelete =
      session.user.isAdministrator || allowed(session.user, "delivery.delete"),
    canShare = allowed(session.user, "delivery.share.create");
  useEffect(() => setSelected([]), [prefix]);
  const crumbs = useMemo(() => {
    const parts = prefix.split("/").filter(Boolean);
    let built = "";
    return parts.map((name) => {
      built += `${name}/`;
      return { name, prefix: built };
    });
  }, [prefix]);
  const toggle = (item: DeliveryItem) => {
    const ref = itemRef(item);
    setSelected((current) =>
      current.includes(ref)
        ? current.filter((value) => value !== ref)
        : [...current, ref],
    );
  };
  const refresh = async () => {
    setSelected([]);
    invalidateDeliveryFolderCache(prefix);
    await reload();
  };
  const run = async (request: Promise<DeliveryOperation>) => {
    setOperationError("");
    try {
      const result = await request;
      setOperation(result);
      const id = result.operationId || result.id;
      if (id) {
        let current = result;
        for (
          let attempt = 0;
          attempt < 120 &&
          current.status !== "completed" &&
          current.status !== "failed" &&
          current.status !== "error";
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          current = await deliveryOperations.status(id);
          setOperation(current);
        }
        if (current.status === "failed" || current.status === "error")
          setOperationError(
            current.error || current.message || "The operation failed.",
          );
      }
      await refresh();
    } catch (caught) {
      setOperationError((caught as Error).message);
    }
  };
  const selectedItems = items.filter((item) =>
    selected.includes(itemRef(item)),
  );
  const mutate = (action: string) => {
    if (!selected.length) return;
    if (
      action === "delete" &&
      !confirm(
        `Move ${selected.length} item${selected.length === 1 ? "" : "s"} to Trash? Items can be restored for 7 days.`,
      )
    )
      return;
    const target =
      action === "copy" || action === "move"
        ? prompt(`Destination folder for ${action}`, prefix)
        : null;
    if ((action === "copy" || action === "move") && target === null) return;
    void run(
      deliveryOperations.mutate(action, {
        prefix,
        refs: selected.map((ref) => ({ ref })),
        targetPrefix: target || undefined,
      }),
    );
  };
  const rename = () => {
    const item = selectedItems[0];
    if (!item) return;
    const next = prompt("New display name", displayName(item));
    if (next && next.trim() !== displayName(item))
      void run(
        deliveryOperations.mutate("rename", {
          prefix,
          ref: itemRef(item),
          name: next.trim(),
        }),
      );
  };
  const newFolder = () => {
    const name = prompt("New folder name");
    if (name?.trim())
      void run(deliveryOperations.createFolder(prefix, name.trim()));
  };
  const upload = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length || !canUpload) return;
    setUploading(true);
    void uploadDeliveryFiles(prefix, list, () => {}, legacyBrowserUploadConflict)
      .then(({ completed, failed }) => {
        setOperation({
          status: failed ? "failed" : "completed",
          progress: completed / list.length,
          message: `Uploaded ${completed} of ${list.length} items`,
        });
        if (failed) setOperationError(`${failed} upload${failed === 1 ? "" : "s"} failed.`);
        void refresh();
      })
      .catch((caught) => setOperationError((caught as Error).message))
      .finally(() => setUploading(false));
  };
  return (
    <>
      <div className="delivery-toolbar">
        <nav className="delivery-crumbs">
          <button onClick={() => setPrefix("")}>All files</button>
          {crumbs.map((crumb) => (
            <span key={crumb.prefix}>
              /
              <button onClick={() => setPrefix(crumb.prefix)}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="delivery-toolbar-actions">
          <button
            className="button-orange"
            disabled={!canWrite}
            onClick={newFolder}
          >
            New folder
          </button>
          <button
            className="button-ghost"
            disabled={!canUpload || uploading}
            onClick={() => input?.click()}
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            ref={setInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) upload(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            className={selectionMode ? "active" : "button-ghost"}
            onClick={() => setSelectionMode((value) => !value)}
          >
            {selectionMode ? "Done selecting" : "Select"}
          </button>
          <button className="button-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className={view === "grid" ? "active" : "button-ghost"}
            onClick={() => setView("grid")}
          >
            Grid
          </button>
          <button
            className={view === "list" ? "active" : "button-ghost"}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
      </div>
      <div className="delivery-selection-bar">
        <label>
          <input
            type="checkbox"
            checked={items.length > 0 && selected.length === items.length}
            onChange={() =>
              setSelected(
                selected.length === items.length ? [] : items.map(itemRef),
              )
            }
          />{" "}
          Select all in this folder
        </label>
        <span>{selected.length} selected</span>
        {selected.length > 0 && (
          <>
            <button
              className="button-ghost"
              disabled={!canWrite || selected.length !== 1}
              onClick={rename}
            >
              Rename
            </button>
            <button
              className="button-ghost"
              disabled={!canWrite}
              onClick={() => mutate("copy")}
            >
              Copy
            </button>
            <button
              className="button-ghost"
              disabled={!canWrite}
              onClick={() => mutate("move")}
            >
              Move
            </button>
            <button
              className="button-danger"
              disabled={!canDelete}
              onClick={() => mutate("delete")}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {(operation || operationError) && (
        <div className={`operation-status ${operationError ? "error" : ""}`}>
          <strong>
            {operationError
              ? "Operation failed"
              : operation?.status === "completed"
                ? "Operation complete"
                : "Working…"}
          </strong>
          <span>
            {operationError ||
              operation?.message ||
              `${Math.round((operation?.progress || 0) * 100)}% complete`}
          </span>
        </div>
      )}
      <ErrorLine error={error} />
      <div
        className="delivery-dropzone"
        onDragOver={(event: any) => event.preventDefault()}
        onDrop={(event: any) => {
          event.preventDefault();
          upload(event.dataTransfer.files);
        }}
      >
        <Card className="file-browser">
          {!displayData && loading ? (
            <DeliverySkeleton />
          ) : !items.length && !loading ? (
            <EmptyState
              title="This folder is empty"
              detail="Drop files here or use Upload to add delivery content."
            />
          ) : view === "grid" ? (
            <div className="file-grid">
              {items.map((item) => (
                <DeliveryGridItem
                  key={itemRef(item)}
                  item={item}
                  selected={selected.includes(itemRef(item))}
                  selectionMode={selectionMode}
                  toggle={() => toggle(item)}
                  open={() =>
                    item.kind === "folder" || item.prefix
                      ? setPrefix(item.prefix || "")
                      : setPreview(item)
                  }
                  share={
                    item.kind === "folder" && canShare
                      ? () => setPreview({ shareFolder: item })
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="file-list">
              {items.map((item) => (
                <DeliveryListItem
                  key={itemRef(item)}
                  item={item}
                  selected={selected.includes(itemRef(item))}
                  selectionMode={selectionMode}
                  toggle={() => toggle(item)}
                  open={() =>
                    item.kind === "folder" || item.prefix
                      ? setPrefix(item.prefix || "")
                      : setPreview(item)
                  }
                />
              ))}
            </div>
          )}
        </Card>
      </div>
      {preview?.shareFolder && (
        <ShareDialog
          folder={preview.shareFolder}
          canRevoke={allowed(session.user, "delivery.share.revoke")}
          close={() => setPreview(null)}
          changed={() => {}}
        />
      )}
      {preview && !preview.shareFolder && (
        <FilePreview item={preview} close={() => setPreview(null)} />
      )}
      <TrashPanel />
    </>
  );
}
function DeliveryWorkspaceV2({ session }: { session: Session }) {
  const [prefix, setPrefix] = useState(() =>
      prefixFromDeliveryPath(location.pathname),
    ),
    [view, setView] = useState<"grid" | "list">("grid"),
    [preview, setPreview] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState(""),
    [searchState, setSearchState] = useState<{ query: string; items: DeliveryItem[]; nextCursor: string | null; loading: boolean; error: string }>({ query: "", items: [], nextCursor: null, loading: false, error: "" });
  const searchInput = useRef<HTMLInputElement | null>(null);
  const [thumbnailQueue, setThumbnailQueue] = useState<{ pending: number; processing: number; total: number } | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [selectionMode, setSelectionMode] = useState(false),
    [operation, setOperation] = useState<DeliveryOperation | null>(null),
    [operationError, setOperationError] = useState("");
  const currentPrefixRef = useRef(prefix);
  currentPrefixRef.current = prefix;
  const [uploading, setUploading] = useState(false),
    [fileInput, setFileInput] = useState<HTMLInputElement | null>(null),
    [folderInput, setFolderInput] = useState<HTMLInputElement | null>(null);
  const [uploadProgress, setUploadProgress] = useState<BrowserUploadProgress[]>([]),
    [uploadConflict, setUploadConflict] = useState<BrowserUploadConflictPrompt | null>(null);
  const [showDropboxImport, setShowDropboxImport] = useState(() => {
    const params = new URLSearchParams(location.search);
    return Boolean(params.get("dropboxImportAuthorization"));
  });
  const [folderState, setFolderState] = useState<{
    prefix: string;
    data: DeliveryFolderPage | null;
    error: string;
    loading: boolean;
  }>({ prefix: "", data: null, error: "", loading: true });
  const folderRequestId = useRef(0);
  const folderRequest = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const requestedPrefix = prefix;
    if (requestedPrefix !== currentPrefixRef.current) return;
    const requestId = ++folderRequestId.current;
    folderRequest.current?.abort();
    const controller = new AbortController();
    folderRequest.current = controller;
    setFolderState({ prefix: requestedPrefix, data: null, error: "", loading: true });
    let accumulated: DeliveryFolderPage | null = null;
    try {
      try {
        const access = await api<{ revision: string }>("/api/delivery/access-revision", { signal: controller.signal });
        if (requestedPrefix !== currentPrefixRef.current || requestId !== folderRequestId.current || controller.signal.aborted) return;
        if (!/^dbr_[A-Za-z0-9_-]{43}$/.test(access.revision)) throw new Error("Delivery authorization revision was invalid.");
        activateDeliveryFolderCache(JSON.stringify({ userId: session.user.id, revision: access.revision }));
        setFolderState({ prefix: requestedPrefix, data: cachedFolderData(requestedPrefix), error: "", loading: true });
      } catch {
        if (requestedPrefix !== currentPrefixRef.current || requestId !== folderRequestId.current || controller.signal.aborted) return;
        deactivateDeliveryFolderCache();
      }
      const folders = new Map<string, DeliveryItem>();
      const files = new Map<string, DeliveryItem>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let completed = false;
      for (let pageNumber = 0; pageNumber < MAX_DELIVERY_FOLDER_PAGES; pageNumber += 1) {
        if (requestedPrefix !== currentPrefixRef.current || requestId !== folderRequestId.current || controller.signal.aborted) return;
        const query = new URLSearchParams({ prefix: requestedPrefix });
        if (cursor) query.set("cursor", cursor);
        const page = await api<DeliveryFolderPage>(
          `/api/delivery/folders?${query.toString()}`,
          { signal: controller.signal },
        );
        if (requestedPrefix !== currentPrefixRef.current || requestId !== folderRequestId.current || controller.signal.aborted) return;
        for (const [index, item] of (page.folders || []).entries()) {
          const key = itemRef(item) || `folder:${pageNumber}:${index}`;
          if (!folders.has(key)) folders.set(key, item);
        }
        for (const [index, item] of (page.files || []).entries()) {
          const key = itemRef(item) || `file:${pageNumber}:${index}`;
          if (!files.has(key)) files.set(key, item);
        }
        const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.trim()
          ? page.nextCursor
          : null;
         accumulated = {
           prefix: requestedPrefix,
           folders: [...folders.values()],
           files: [...files.values()],
           nextCursor,
         };
         writeDeliveryFolderCache(requestedPrefix, accumulated);
         setFolderState({ prefix: requestedPrefix, data: accumulated, error: "", loading: Boolean(nextCursor) });
        if (!nextCursor) {
          completed = true;
          break;
        }
        if (seenCursors.has(nextCursor)) throw new Error("Folder listing returned a repeated cursor.");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!completed) throw new Error(`Folder listing exceeded ${MAX_DELIVERY_FOLDER_PAGES} pages. Narrow the folder or refresh to try again.`);
    } catch (caught) {
      if (requestId !== folderRequestId.current || controller.signal.aborted) return;
      const accessDenied = invalidateDeliveryCacheOnAccessError(caught, requestedPrefix);
       setFolderState({
         prefix: requestedPrefix,
         data: accessDenied ? null : accumulated,
         error: (caught as Error).message,
         loading: false,
       });
    }
  }, [prefix, session.user.id]);
  useEffect(() => {
    void reload();
    return () => {
      folderRequestId.current += 1;
      folderRequest.current?.abort();
    };
  }, [reload]);
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchState({ query: "", items: [], nextCursor: null, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchState((current) => ({ ...current, query, loading: true, error: "" }));
      void api<{ items: DeliveryItem[]; nextCursor: string | null }>(`/api/delivery/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) setSearchState({ query, items: value.items || [], nextCursor: value.nextCursor || null, loading: false, error: "" });
        })
        .catch((caught) => {
          if (!controller.signal.aborted) setSearchState({ query, items: [], nextCursor: null, loading: false, error: (caught as Error).message });
        });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [searchQuery]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      searchInput.current?.focus();
      setSearchQuery((current) => `${current}${event.key}`);
    };
    addEventListener("keydown", focusSearch);
    return () => removeEventListener("keydown", focusSearch);
  }, []);
  const data = folderState.prefix === prefix ? folderState.data : null;
  const error = folderState.prefix === prefix ? folderState.error : "";
  const loading = folderState.prefix !== prefix || folderState.loading;
  const displayData = data;
  const [locationState, setLocationState] = useState<{
    prefix: string;
    data: DeliveryLocationCollection | null;
    error: string;
  }>({ prefix: "", data: null, error: "" });
  const locationRequestId = useRef(0);
  const locationRequest = useRef<AbortController | null>(null);
  const reloadLocations = useCallback(async () => {
    const requestedPrefix = prefix;
    if (requestedPrefix !== currentPrefixRef.current) return;
    const requestId = ++locationRequestId.current;
    locationRequest.current?.abort();
    const controller = new AbortController();
    locationRequest.current = controller;
    setLocationState({ prefix: requestedPrefix, data: null, error: "" });
    try {
      const value = await api<DeliveryLocationCollection>(
        `/api/delivery/folders/locations?prefix=${encodeURIComponent(requestedPrefix)}`,
        { signal: controller.signal },
      );
      if (requestId !== locationRequestId.current || controller.signal.aborted) return;
      setLocationState({ prefix: requestedPrefix, data: value, error: "" });
    } catch (caught) {
      if (requestId !== locationRequestId.current || controller.signal.aborted) return;
      setLocationState({
        prefix: requestedPrefix,
        data: null,
        error: (caught as Error).message,
      });
    }
  }, [prefix]);
  useEffect(() => {
    void reloadLocations();
    return () => {
      locationRequestId.current += 1;
      locationRequest.current?.abort();
    };
  }, [reloadLocations]);
  const locations = locationState.prefix === prefix ? locationState.data : null;
  const locationError = locationState.prefix === prefix ? locationState.error : "";
  const folderItems: DeliveryItem[] = displayData
    ? [...(displayData.folders || []), ...(displayData.files || [])]
    : [];
  const searching = Boolean(searchQuery.trim());
  const items = searching ? searchState.items : folderItems;
  const admin = session.user.isAdministrator;
  const canCreate = admin && allowed(session.user, "delivery.files.create"),
    canUpload =
      admin &&
      allowed(session.user, "delivery.files.upload") &&
      session.capabilities?.directDeliveryUploads?.enabled === true;
  const canCopy = admin && allowed(session.user, "delivery.files.copy"),
    canMove = admin && allowed(session.user, "delivery.files.move");
  const canDelete = admin && allowed(session.user, "delivery.delete"),
    canShare = allowed(session.user, "delivery.share.create");
  useEffect(() => {
    if (!admin || !allowed(session.user, "delivery.browse")) return;
    let cancelled = false;
    const load = () => void api<{ pending: number; processing: number; total: number }>("/api/delivery/thumbnail-queue")
      .then((value) => { if (!cancelled) setThumbnailQueue(value); })
      .catch(() => { if (!cancelled) setThumbnailQueue(null); });
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [admin, session.user]);
  const openFolder = useCallback((nextPrefix: string) => {
    const safePrefix = nextPrefix || DELIVERY_ROOT_PREFIX;
    setPrefix(safePrefix);
    setPreview(null);
    const nextPath = deliveryPathFromPrefix(safePrefix);
    if (location.pathname !== nextPath) history.pushState(null, "", nextPath);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const canonicalPath = deliveryPathFromPrefix(
      prefixFromDeliveryPath(location.pathname),
    );
    if (location.pathname !== canonicalPath)
      history.replaceState(null, "", canonicalPath);
    const onPopState = () => {
      setPrefix(prefixFromDeliveryPath(location.pathname));
      setPreview(null);
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    setSelected([]);
    setSelectionMode(false);
  }, [prefix]);
  const crumbs = useMemo(() => {
    const parts = prefix.split("/").filter(Boolean);
    let built = "";
    return parts.map((name) => {
      built += `${name}/`;
      return { name, prefix: built };
    });
  }, [prefix]);
  const selectedItems = items.filter((item) =>
    selected.includes(itemRef(item)),
  );
  const toggle = (item: DeliveryItem) => {
    const ref = itemRef(item);
    setSelected((current) =>
      current.includes(ref)
        ? current.filter((value) => value !== ref)
        : [...current, ref],
    );
  };
  const refresh = async () => {
    const requestedPrefix = prefix;
    if (requestedPrefix !== currentPrefixRef.current) return;
    setSelected([]);
    invalidateDeliveryFolderCache(prefix);
    await Promise.all([reload(), reloadLocations()]);
  };
  const run = async (request: Promise<DeliveryOperation>) => {
    setOperationError("");
    try {
      let current = await request;
      setOperation(current);
      const id = current.operationId || current.jobId;
      if (id)
        for (
          let attempt = 0;
          attempt < 120 &&
          current.status !== "completed" &&
          current.status !== "failed";
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          current = await deliveryOperations.status(id);
          setOperation(current);
        }
      if (current.status === "failed")
        throw new Error(
          current.error || current.error_message || "The operation failed.",
        );
      invalidateDeliveryFolderCache();
      await refresh();
    } catch (caught) {
      invalidateDeliveryCacheOnAccessError(caught, prefix);
      setOperationError((caught as Error).message);
    }
  };
  const targetFor = (
    item: DeliveryItem,
    targetPrefix: string,
    newName?: string,
  ) =>
    joinDeliveryPath(
      targetPrefix,
      newName ||
        itemKey(item).replace(/\/$/, "").split("/").pop() ||
        displayName(item),
      Boolean(item.prefix),
    );
  const shareChoice = (
    itemsToMove: DeliveryItem[],
  ): "keep" | "revoke" | null => {
    if (!itemsToMove.some((item) => item.isShared)) return "revoke";
    if (confirm("Keep the existing client link active at the new location?"))
      return "keep";
    return confirm("Revoke the existing client link instead?")
      ? "revoke"
      : null;
  };
  const mutationRequest = async (
    action: "copy" | "move" | "rename",
    item: DeliveryItem,
    target: string,
    sharePolicy: "keep" | "revoke",
  ) => {
    try {
      return await deliveryOperations.mutate(
        action,
        itemKey(item),
        target,
        sharePolicy,
        "fail",
      );
    } catch (caught) {
      if (!(caught as Error).message.toLowerCase().includes("destination"))
        throw caught;
      const choice = prompt(
        "An item already exists at the destination. Type replace to overwrite it, keep to keep both, or Cancel to stop.",
        "keep",
      );
      if (choice === null) throw new Error("Operation cancelled.");
      const conflict =
        choice.trim().toLowerCase() === "replace"
          ? "replace"
          : choice.trim().toLowerCase() === "keep"
            ? "rename"
            : null;
      if (!conflict) throw new Error("Choose replace or keep.");
      return deliveryOperations.mutate(
        action,
        itemKey(item),
        target,
        sharePolicy,
        conflict,
      );
    }
  };
  const mutateMany = async (action: "copy" | "move") => {
    if (!selectedItems.length) return;
    const target = prompt(`Destination folder for ${action}`, prefix);
    if (target === null) return;
    const sharePolicy =
      action === "move" ? shareChoice(selectedItems) : "revoke";
    if (!sharePolicy) return;
    for (const item of selectedItems)
      await run(
        mutationRequest(action, item, targetFor(item, target), sharePolicy),
      );
  };
  const rename = () => {
    const item = selectedItems[0];
    if (!item) return;
    const next = prompt("New file or folder name", displayName(item));
    if (!next?.trim() || next.trim() === displayName(item)) return;
    const sharePolicy = shareChoice([item]);
    if (!sharePolicy) return;
    void run(
      mutationRequest(
        "rename",
        item,
        targetFor(item, prefix, next.trim()),
        sharePolicy,
      ),
    );
  };
  const remove = async () => {
    if (
      !selectedItems.length ||
      !confirm(
        `Delete ${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}? They can be restored for 7 days.`,
      )
    )
      return;
    for (const item of selectedItems)
      await run(deliveryOperations.remove(item));
  };
  const itemAction = (action: "rename" | "copy" | "move" | "delete", item: DeliveryItem) => {
    if (action === "delete") {
      if (confirm(`Delete ${displayName(item)}? It can be restored for 7 days.`)) void run(deliveryOperations.remove(item));
      return;
    }
    if (action === "rename") {
      const next = prompt("New file or folder name", displayName(item));
      if (!next?.trim() || next.trim() === displayName(item)) return;
      const sharePolicy = shareChoice([item]);
      if (sharePolicy) void run(mutationRequest("rename", item, targetFor(item, itemKey(item).replace(/[^/]+\/?$/, ""), next.trim()), sharePolicy));
      return;
    }
    const target = prompt(`Destination folder for ${action}`, prefix);
    if (target === null) return;
    const sharePolicy = action === "move" ? shareChoice([item]) : "revoke";
    if (sharePolicy) void run(mutationRequest(action, item, targetFor(item, target), sharePolicy));
  };
  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length || !canUpload) return;
    setUploading(true);
    setOperationError("");
    setUploadProgress([]);
    try {
      const live = new Map<number, BrowserUploadProgress>();
      const resolveConflict: BrowserUploadConflictResolver = (conflict) =>
        new Promise((resolve) => setUploadConflict({ ...conflict, resolve }));
      const result = await uploadDeliveryFiles(
        prefix,
        list,
        (next) => {
          const previous = live.get(next.ordinal),
            merged =
              (next.status === "stopped" || next.status === "failed") && previous
                ? { ...next, uploadedBytes: previous.uploadedBytes }
                : next;
          live.set(next.ordinal, merged);
          const entries = [...live.values()].sort(
              (left, right) => left.ordinal - right.ordinal,
            ),
            total = entries.reduce(
              (sum, entry) => sum + entry.totalBytes,
              0,
            ),
            uploaded = entries.reduce(
              (sum, entry) => sum + (entry.status === "skipped" ? entry.totalBytes : entry.uploadedBytes),
              0,
            );
          setUploadProgress(entries);
          setOperation({
            status: "running",
            progress: total ? uploaded / total : 0,
            message: `Uploaded ${bytes(uploaded)} of ${bytes(total)}`,
          });
        },
        resolveConflict,
      );
      invalidateDeliveryFolderCache();
      await refresh();
      setOperation({
        status: result.failed ? "failed" : "completed",
        progress: (result.completed + result.skipped) / list.length,
        message: `Uploaded ${result.completed} item${result.completed === 1 ? "" : "s"}${result.skipped ? `; kept ${result.skipped} existing` : ""}`,
      });
      if (result.failed)
        setOperationError(
          `${result.failed} upload${result.failed === 1 ? "" : "s"} failed. Review the file results below.`,
        );
    } catch (caught) {
      invalidateDeliveryCacheOnAccessError(caught, prefix);
      setOperationError(uploadError(caught).message);
    } finally {
      setUploading(false);
    }
  };
  const previewItems = items.filter((item) => !item.prefix);
  return (
    <>
      <div className="delivery-toolbar">
        <div className="delivery-toolbar-actions">
          <label className="delivery-search">
            <span className="sr-only">Search delivery files and folders</span>
            <input ref={searchInput} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search files and folders" aria-label="Search files and folders" />
            {searchQuery && <button type="button" className="delivery-search-clear" aria-label="Clear search" onClick={() => setSearchQuery("")}>×</button>}
          </label>
          <button
            className="button-orange"
            disabled={!canCreate}
            onClick={() => {
              const name = prompt("New folder name");
              if (name?.trim())
                void run(deliveryOperations.createFolder(prefix, name.trim()));
            }}
          >
            New folder
          </button>
          {!canUpload && allowed(session.user, "delivery.files.upload") && (
            <span className="managed-badge">
              {!admin
                ? "Direct browser uploads require administrator access."
                : "Direct browser uploads are disabled. Use an Incoming request link."}
            </span>
          )}
          <button
            className="button-ghost"
            disabled={!canUpload || uploading}
            onClick={() => fileInput?.click()}
          >
            {uploading ? "Uploading…" : "Upload files"}
          </button>
          <button
            className="button-ghost"
            disabled={!canUpload || uploading}
            onClick={() => folderInput?.click()}
          >
            Upload folder
          </button>
          {session.capabilities?.dropboxImport?.enabled && (
            <button
              className="button-ghost"
              disabled={!canUpload}
              onClick={() => setShowDropboxImport(true)}
            >
              Import from Dropbox
            </button>
          )}
          <input
            ref={setFileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={setFolderInput}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: "", directory: "" } as any)}
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            className={selectionMode ? "active" : "button-ghost"}
            onClick={() => {
              setSelectionMode((value) => !value);
              setSelected([]);
            }}
          >
            {selectionMode ? "Done selecting" : "Select"}
          </button>
          <button className="button-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className={view === "grid" ? "active" : "button-ghost"}
            onClick={() => setView("grid")}
          >
            Grid
          </button>
          <button
            className={view === "list" ? "active" : "button-ghost"}
            onClick={() => setView("list")}
          >
            List
          </button>
          {thumbnailQueue && (
            <span className="thumbnail-queue-indicator" title={`${thumbnailQueue.pending} pending, ${thumbnailQueue.processing} processing`} aria-label={`Thumbnail queue: ${thumbnailQueue.total} outstanding`}>
              Thumbnails: {thumbnailQueue.total}
            </span>
          )}
        </div>
        <nav className="delivery-crumbs" aria-label="Current delivery folder">
          {session.capabilities?.deliveryJobsRoot?.enabled ? (
            <button title="Jobs" onClick={() => openFolder(DELIVERY_JOBS_PREFIX)}>
              Jobs
            </button>
          ) : <span>Jobs</span>}
          {crumbs.slice(1).map((crumb) => (
            <span key={crumb.prefix}>
              /
              <button
                title={crumb.name}
                onClick={() => openFolder(crumb.prefix)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      </div>
      {selectionMode && (
        <div className="delivery-selection-bar">
          <label>
            <input
              type="checkbox"
              checked={items.length > 0 && selected.length === items.length}
              onChange={() =>
                setSelected(
                  selected.length === items.length ? [] : items.map(itemRef),
                )
              }
            />{" "}
            Select all in this folder
          </label>
          <span>{selected.length} selected</span>
          {selected.length > 0 && (
            <>
              <button
                className="button-ghost"
                disabled={!canMove || selected.length !== 1}
                onClick={rename}
              >
                Rename
              </button>
              <button
                className="button-ghost"
                disabled={!canCopy}
                onClick={() => void mutateMany("copy")}
              >
                Copy
              </button>
              <button
                className="button-ghost"
                disabled={!canMove}
                onClick={() => void mutateMany("move")}
              >
                Move
              </button>
              <button
                className="button-danger"
                disabled={!canDelete}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {(operation || operationError) && (
        <div className={`operation-status ${operationError ? "error" : ""}`}>
          <strong>
            {operationError
              ? "Operation failed"
              : operation?.status === "completed"
                ? "Operation complete"
                : "Working…"}
          </strong>
          <span>
            {operationError ||
              operation?.message ||
              `${Math.round((operation?.progress || 0) * 100)}% complete`}
          </span>
        </div>
      )}
      {uploadConflict && (
        <div className="modal-backdrop">
          <div className="ltds-card" role="dialog" aria-modal="true" aria-labelledby="upload-conflict-title">
            <header>
              <h2 id="upload-conflict-title">File already exists</h2>
            </header>
            <p>
              <strong>{uploadConflict.relativePath}</strong> already exists in this folder.
              Choose which version to keep.
            </p>
            <div className="actions">
              <button
                className="button-ghost"
                onClick={() => {
                  const prompt = uploadConflict;
                  setUploadConflict(null);
                  prompt.resolve("skip");
                }}
              >
                Keep old
              </button>
              <button
                className="button-orange"
                onClick={() => {
                  const prompt = uploadConflict;
                  setUploadConflict(null);
                  prompt.resolve("replace");
                }}
              >
                Keep new
              </button>
              <button
                className="button-ghost"
                onClick={() => {
                  const prompt = uploadConflict;
                  setUploadConflict(null);
                  prompt.resolve("rename");
                }}
              >
                Keep both
              </button>
              <button
                className="button-ghost"
                onClick={() => {
                  const prompt = uploadConflict;
                  setUploadConflict(null);
                  prompt.resolve(null);
                }}
              >
                Cancel upload
              </button>
            </div>
          </div>
        </div>
      )}
      {uploadProgress.length > 0 && (
        <Card className="upload-progress" aria-label="Upload progress">
          <header>
            <strong>Browser upload</strong>
            <small>
              {uploadProgress.filter((item) => item.status === "completed" || item.status === "skipped").length}
              /{uploadProgress.length} files resolved
            </small>
          </header>
          <div className="simple-rows">
            {uploadProgress.map((item) => (
              <div key={`${item.ordinal}-${item.relativePath}`}>
                <span>
                  <strong>{item.relativePath}</strong>
                  <small>
                    {bytes(item.uploadedBytes)} of {bytes(item.totalBytes)}
                    {item.error ? ` · ${item.error}` : ""}
                  </small>
                </span>
                <span>
                  <progress
                    aria-label={`${item.relativePath} upload progress`}
                    max={item.totalBytes}
                    value={item.uploadedBytes}
                  />
                  <small>{item.status}</small>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <ErrorLine error={error} />
      <ErrorLine error={searchState.error} />
      <ErrorLine error={locationError} />
      {locations && locations.points.length > 0 && (
        <ImageLocationMap
          key={prefix}
          token={session.mapboxPublicToken}
          locations={locations}
          scopeLabel="this folder"
          loadAsset={(assetRef) => api<DeliveryItem>(
            `/api/delivery/folders/location-assets/${encodeURIComponent(assetRef)}?prefix=${encodeURIComponent(prefix)}`,
          ) as Promise<any>}
          openAsset={(asset) => setPreview(asset)}
        />
      )}
      <div
        className="delivery-dropzone"
        onDragOver={(event) => {
          if (canUpload) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!canUpload) return;
          event.preventDefault();
          void upload(event.dataTransfer.files);
        }}
      >
        <Card className="file-browser">
          {searching && searchState.loading && items.length === 0 ? (
            <DeliverySkeleton />
          ) : loading && items.length === 0 ? (
            <DeliverySkeleton />
          ) : !items.length && !loading ? (
            <EmptyState
              title={searching ? "No matching files or folders" : "This folder is empty"}
              detail={
                canUpload
                  ? "Drop files here or use Upload to add delivery content."
                  : "No delivery files are currently available."
              }
            />
          ) : view === "grid" ? (
            <div className="file-grid">
              {items.map((item) => (
                <DeliveryGridItem
                  key={itemRef(item)}
                  item={item}
                  selected={selected.includes(itemRef(item))}
                  selectionMode={selectionMode}
                  toggle={() => toggle(item)}
                  open={() =>
                    item.prefix ? openFolder(item.prefix) : setPreview(item)
                  }
                  share={
                    item.prefix && canShare
                      ? () => setPreview({ shareFolder: item })
                      : undefined
                  }
                  actions={{ rename: canMove, copy: canCopy, move: canMove, delete: canDelete }}
                  act={(action) => itemAction(action, item)}
                />
              ))}
            </div>
          ) : (
            <div className="file-list">
              {items.map((item) => (
                <DeliveryListItem
                  key={itemRef(item)}
                  item={item}
                  selected={selected.includes(itemRef(item))}
                  selectionMode={selectionMode}
                  toggle={() => toggle(item)}
                  open={() =>
                    item.prefix ? openFolder(item.prefix) : setPreview(item)
                  }
                  share={item.prefix && canShare ? () => setPreview({ shareFolder: item }) : undefined}
                  actions={{ rename: canMove, copy: canCopy, move: canMove, delete: canDelete }}
                  act={(action) => itemAction(action, item)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
      {preview?.shareFolder && (
        <ShareDialog
          folder={preview.shareFolder}
          canRevoke={allowed(session.user, "delivery.share.revoke")}
          close={() => setPreview(null)}
          changed={() => {
            invalidateDeliveryFolderCache(prefix);
            void reload();
          }}
        />
      )}{" "}
      {preview && !preview.shareFolder && (
        <FilePreview
          item={preview}
          items={previewItems}
          select={setPreview}
          close={() => setPreview(null)}
        />
      )}
      {admin && canDelete && <TrashPanel />}
      <ShareHistory session={session} revision={0} />
      {showDropboxImport && session.capabilities?.dropboxImport?.enabled && (
        <DropboxImportDialog
          destinationPrefix={prefix}
          canUpload={canUpload}
          onClose={() => setShowDropboxImport(false)}
          onStarted={() => {
            invalidateDeliveryFolderCache(prefix);
            void reload();
          }}
        />
      )}
    </>
  );
}
function DeliveryHub({ session }: { session: Session }) {
  const [tab, setTab] = useState<"delivery" | "incoming">("delivery");
  const canViewIncoming =
    allowed(session.user, "file_requests.view") &&
    session.capabilities?.incomingUploads?.enabled === true;
  return (
    <>
      <div
        className="delivery-subtabs"
        role="tablist"
        aria-label="Delivery tools"
      >
        <button
          role="tab"
          aria-selected={tab === "delivery"}
          className={tab === "delivery" ? "active" : ""}
          onClick={() => setTab("delivery")}
        >
          Client delivery
        </button>
        {canViewIncoming && (
          <button
            role="tab"
            aria-selected={tab === "incoming"}
            className={tab === "incoming" ? "active" : ""}
            onClick={() => setTab("incoming")}
          >
            Incoming uploads
          </button>
        )}
      </div>
      {tab === "delivery" || !canViewIncoming ? (
        <DeliveryWorkspaceV2 session={session} />
      ) : (
        <IncomingUploads />
      )}
    </>
  );
}
function IncomingUploads() {
  const { data, error, reload } = useLoad<IncomingLinkResponse>(
    () => api("/api/delivery/incoming-link"),
    [],
  );
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [message, setMessage] = useState(""),
    [accessCode, setAccessCode] = useState("");
  const link = data?.link;
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await action();
      await reload();
      setMessage(success);
    } catch (caught) {
      setActionError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setActionError("");
      setMessage("Incoming upload link copied.");
    } catch {
      setActionError(
        "The link could not be copied. Select and copy it manually.",
      );
    }
  };
  const saveAccessCode = () =>
    void run(
      () =>
        api("/api/delivery/incoming-link", {
          method: "PATCH",
          body: JSON.stringify({ accessCode: accessCode.trim() || null }),
        }),
      accessCode.trim() ? "Access code updated." : "Access code removed.",
    );
  if (!data && !error)
    return (
      <Card>
        <PanelSkeleton />
      </Card>
    );
  return (
    <section className="incoming-workspace">
      <ErrorLine error={error || actionError} />
      {message && <div className="notice incoming-success">{message}</div>}
      {!link ? (
        <Card>
          <div className="incoming-empty">
            <EmptyState
              title="No incoming upload link"
              detail="Create one reusable link for contributors to send files to the private incoming bucket."
            />
            <button
              className="button-orange"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api("/api/delivery/incoming-link", {
                      method: "POST",
                      body: "{}",
                    }),
                  "Incoming upload link created.",
                )
              }
            >
              {busy ? "Creating…" : "Create incoming link"}
            </button>
          </div>
        </Card>
      ) : (
        <>
          <Card
            title="Reusable incoming link"
            action={<StatusPill tone="success">Active</StatusPill>}
          >
            <p className="muted">
              Send this link to contributors. They can upload files, but they
              cannot browse or download anything already in the bucket.
            </p>
            <div className="incoming-link-row">
              <input
                aria-label="Incoming upload link"
                readOnly
                value={link.url}
              />
              <button
                className="button-orange"
                disabled={busy}
                onClick={() => void copyLink()}
              >
                Copy link
              </button>
            </div>
            <div className="incoming-link-meta">
              <span>Created {date(link.createdAt)}</span>
              <span>
                {link.accessCodeProtected
                  ? "Access code protected"
                  : "No access code"}
              </span>
            </div>
            <div className="incoming-actions">
              <label>
                <span>Access code</span>
                <input
                  type="text"
                  value={accessCode}
                  onChange={(event) => setAccessCode(event.target.value)}
                  placeholder={
                    link.accessCodeProtected
                      ? "Enter a replacement code"
                      : "Optional access code"
                  }
                  disabled={busy}
                />
              </label>
              <button
                className="button-ghost"
                disabled={busy}
                onClick={saveAccessCode}
              >
                {accessCode.trim() ? "Save access code" : "Remove access code"}
              </button>
              <button
                className="button-ghost"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Replace this link? The current link will stop working.",
                    )
                  )
                    void run(
                      () =>
                        api("/api/delivery/incoming-link/rotate", {
                          method: "POST",
                          body: "{}",
                        }),
                      "Incoming upload link replaced.",
                    );
                }}
              >
                Replace link
              </button>
              <button
                className="button-danger"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Revoke this incoming upload link? Contributors using it will no longer be able to upload.",
                    )
                  )
                    void run(
                      () =>
                        api("/api/delivery/incoming-link", {
                          method: "DELETE",
                        }),
                      "Incoming upload link revoked.",
                    );
                }}
              >
                Revoke
              </button>
            </div>
          </Card>
          <div className="incoming-stats">
            <Card>
              <strong>{link.outstandingFiles}</strong>
              <span>Files awaiting pickup</span>
            </Card>
            <Card>
              <strong>{bytes(link.outstandingBytes)}</strong>
              <span>Awaiting pickup</span>
            </Card>
          </div>
          <Card
            title="Recent uploads"
            action={
              <button
                className="button-ghost button-small"
                disabled={busy}
                onClick={() => void reload()}
              >
                Refresh
              </button>
            }
          >
            {link.recentUploads.length ? (
              <div className="incoming-upload-list">
                {link.recentUploads.map((upload, index) => (
                  <div
                    key={
                      upload.id ||
                      `${upload.fileName || upload.name || "upload"}-${index}`
                    }
                  >
                    <div>
                      <strong>
                        {upload.fileName || upload.name || "Uploaded file"}
                      </strong>
                      <small>
                        {upload.contributorName || "Contributor"}
                        {upload.size !== undefined
                          ? ` · ${bytes(upload.size)}`
                          : ""}
                        {upload.uploadedAt || upload.createdAt
                          ? ` · ${date(upload.uploadedAt || upload.createdAt)}`
                          : ""}
                      </small>
                    </div>
                    <StatusPill
                      tone={
                        upload.status === "accepted"
                          ? "success"
                          : upload.status === "rejected"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {upload.status || "uploaded"}
                    </StatusPill>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No recent uploads"
                detail="Contributor uploads and TrueNAS pickup status will appear here."
              />
            )}
          </Card>
        </>
      )}
    </section>
  );
}
function DeliverySkeleton() {
  return (
    <div className="delivery-skeleton">
      {[1, 2, 3, 4, 5, 6].map((value) => (
        <div key={value}>
          <span />
          <b />
          <small />
        </div>
      ))}
    </div>
  );
}
function DeliveryGridItem({
  item,
  selected,
  selectionMode,
  toggle,
  open,
  share,
  actions,
  act,
}: {
  item: DeliveryItem;
  selected: boolean;
  selectionMode: boolean;
  toggle: () => void;
  open: () => void;
  share?: () => void;
  actions?: Record<"rename" | "copy" | "move" | "delete", boolean>;
  act?: (action: "rename" | "copy" | "move" | "delete") => void;
}) {
  const folder = item.kind === "folder" || Boolean(item.prefix);
  return (
    <article
      className={`file-card selectable-card ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${selectionMode ? "Select" : "Open"} ${displayName(item)}`}
      onClick={(event) => {
        event.currentTarget.focus();
        if (selectionMode) toggle(); else open();
      }}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        if (selectionMode) toggle(); else open();
      }}
    >
      {selectionMode && (
        <button
          className="select-checkbox"
          aria-label={`Select ${displayName(item)}`}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {selected ? "✓" : ""}
        </button>
      )}
      <div className="file-visual">
        {folder ? (
          <span className="folder-shape" />
        ) : (
          <OperationsThumbnail item={item} />
        )}{" "}
        {item.isShared && <SharedBadge />}
      </div>
      <div className="file-card-title">
        <strong title={displayName(item)}>{displayName(item)}</strong>
      </div>
      <small>
        {folder
          ? "Folder"
          : `${bytes(item.size || 0)} · ${item.kind || "file"}`}
      </small>
      {share && (
        <button
          className="share-chip"
          onClick={(event) => {
            event.stopPropagation();
            share();
          }}
        >
          Share
        </button>
      )}
      {actions && act && <DeliveryItemMenu item={item} share={share} actions={actions} act={act} />}
    </article>
  );
}
function DeliveryListItem({
  item,
  selected,
  selectionMode,
  toggle,
  open,
  share,
  actions,
  act,
}: {
  item: DeliveryItem;
  selected: boolean;
  selectionMode: boolean;
  toggle: () => void;
  open: () => void;
  share?: () => void;
  actions?: Record<"rename" | "copy" | "move" | "delete", boolean>;
  act?: (action: "rename" | "copy" | "move" | "delete") => void;
}) {
  const folder = item.kind === "folder" || Boolean(item.prefix);
  return (
    <div className={`delivery-list-item ${selected ? "selected" : ""}`}>
      <button className="delivery-list-open" onClick={() => (selectionMode ? toggle() : open())}>
      {selectionMode && (
        <span className="select-checkbox">{selected ? "✓" : ""}</span>
      )}
      <span>{folder ? "▰" : "▧"}</span>
      <strong>{displayName(item)}</strong>
      {item.isShared && <SharedBadge />}
      <small>{folder ? "Folder" : bytes(item.size || 0)}</small>
      </button>
      {actions && act && <DeliveryItemMenu item={item} share={share} actions={actions} act={act} />}
    </div>
  );
}
function DeliveryItemMenu({ item, share, actions, act }: { item: DeliveryItem; share?: () => void; actions: Record<"rename" | "copy" | "move" | "delete", boolean>; act: (action: "rename" | "copy" | "move" | "delete") => void }) {
  const [open, setOpen] = useState(false);
  const invoke = (action: "rename" | "copy" | "move" | "delete") => { setOpen(false); act(action); };
  return <div className="delivery-item-menu" onClick={(event) => event.stopPropagation()}>
    <button className="delivery-item-menu-trigger" aria-label={`Actions for ${displayName(item)}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋮</button>
    {open && <div className="delivery-item-menu-popover" role="menu" aria-label={`Actions for ${displayName(item)}`}>
      {share && <button role="menuitem" onClick={() => { setOpen(false); share(); }}>Share</button>}
      {actions.rename && <button role="menuitem" onClick={() => invoke("rename")}>Rename</button>}
      {actions.copy && <button role="menuitem" onClick={() => invoke("copy")}>Copy</button>}
      {actions.move && <button role="menuitem" onClick={() => invoke("move")}>Move</button>}
      {actions.delete && <button className="danger" role="menuitem" onClick={() => invoke("delete")}>Delete</button>}
    </div>}
  </div>;
}
function SharedBadge() {
  return (
    <span
      className="shared-badge"
      title="This item is currently shared"
      aria-label="Currently shared"
    >
      Shared
    </span>
  );
}
function displayName(item: any) {
  return item.alias || item.displayName || item.name || "Unnamed item";
}
function DeliveryMutationActions({ item }: { item: any }) {
  const renameUrl = item.renameUrl || item.actions?.rename;
  const deleteUrl = item.deleteUrl || item.actions?.delete;
  if (!renameUrl && !deleteUrl) return null;
  return (
    <div className="file-mutation-actions">
      {renameUrl && (
        <button
          className="button-ghost button-small"
          onClick={(event) => {
            event.stopPropagation();
            const current = displayName(item);
            const next = window.prompt(
              `Display name for ${current}\nLeave blank to restore the original name.`,
              current,
            );
            if (next === null || next.trim() === current) return;
            const request = next.trim()
              ? api(renameUrl, {
                  method: "PATCH",
                  body: JSON.stringify({ displayName: next.trim() }),
                })
              : api(renameUrl, { method: "DELETE" });
            void request
              .then(() => window.location.reload())
              .catch((error) => window.alert(error.message));
          }}
        >
          Rename
        </button>
      )}
      {deleteUrl && (
        <button
          className="button-danger button-small"
          onClick={(event) => {
            event.stopPropagation();
            void confirmAndDelete(item, deleteUrl);
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
async function confirmAndDelete(item: any, url: string) {
  try {
    const impact = await api<any>(`${url}/delete-preview`, {
      method: "POST",
      body: "{}",
    });
    const summary = `Permanently delete ${impact.objectCount} object${impact.objectCount === 1 ? "" : "s"} (${bytes(impact.byteCount)})${impact.shareCount ? ` and revoke ${impact.shareCount} active share${impact.shareCount === 1 ? "" : "s"}` : ""}?\n\n${(impact.warnings || []).join("\n")}`;
    if (!window.confirm(summary)) return;
    const typed = window.prompt(
      `Type ${impact.typedName} to confirm permanent deletion`,
    );
    if (typed !== impact.typedName) {
      if (typed !== null)
        window.alert("The name did not match. Nothing was deleted.");
      return;
    }
    await api(url, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: typed }),
    });
    window.location.reload();
  } catch (error) {
    window.alert((error as Error).message);
  }
}
function FolderCardV2({
  item,
  open,
  share,
}: {
  item: any;
  open: () => void;
  share?: () => void;
}) {
  return (
    <article className="file-card">
      <button className="file-visual" onClick={open}>
        <span className="folder-shape" />
        {item.isShared && <SharedBadge />}
      </button>
      <div className="file-card-title">
        <strong title={displayName(item)}>{displayName(item)}</strong>
      </div>
      <small>Folder</small>
      {share && (
        <button className="share-chip" onClick={share}>
          Share
        </button>
      )}
      <DeliveryMutationActions item={item} />
    </article>
  );
}
function FileCardV2({ item, preview }: { item: any; preview: () => void }) {
  return (
    <article className="file-card">
      <button className="file-visual" onClick={preview}>
        <OperationsThumbnail item={item} />
        {item.kind === "video" && <b className="play">▶</b>}
        {item.kind === "video" && item.previewStatus === "processing" && (
          <span className="media-status">Preparing preview…</span>
        )}
        {item.isShared && <SharedBadge />}
      </button>
      <div className="file-card-title">
        <strong title={displayName(item)}>{displayName(item)}</strong>
      </div>
      <small>
        {bytes(item.size)} · {item.kind}
      </small>
      <a className="download-chip" href={item.downloadUrl}>
        Download
      </a>
      <DeliveryMutationActions item={item} />
    </article>
  );
}
function OperationsThumbnail({ item }: { item: DeliveryItem }) {
  const [failed, setFailed] = useState(!item.thumbnailUrl);
  const fallback = item.thumbnailFallbackKind === "pdf" ? "PDF" : item.thumbnailFallbackKind === "archive" ? "ZIP" : item.thumbnailFallbackKind === "spreadsheet" ? "Sheet" : item.thumbnailFallbackKind === "document" ? "Doc" : item.thumbnailFallbackKind || item.kind || "File";
  const status = item.thumbnailState === "pending"
    ? "Thumbnail processing\u2026"
    : item.thumbnailState === "failed" && item.thumbnailErrorCode === "renderer_unavailable"
      ? "Private renderer pending"
    : item.thumbnailState === "failed" && ["input_too_large", "video_input_too_large"].includes(item.thumbnailErrorCode || "")
      ? "Needs heavy-media renderer"
      : item.thumbnailState === "failed"
        ? "Thumbnail generation failed"
        : item.thumbnailState === "not_applicable"
          ? "File-type icon"
          : "Thumbnail unavailable";
  if (failed)
    return (
      <span className="ops-preview-placeholder file-type-placeholder" aria-label={`${fallback} preview unavailable`}>
        <span className="file-kind" aria-hidden="true">{fallback}</span>
        <small>{status}</small>
      </span>
    );
  return (
    <img
      src={item.thumbnailUrl}
      loading="lazy"
      decoding="async"
      width="340"
      height="220"
      alt={`${displayName(item)} thumbnail`}
      onError={() => setFailed(true)}
    />
  );
}
function FolderCard({
  item,
  open,
  share,
}: {
  item: any;
  open: () => void;
  share?: () => void;
}) {
  return <FolderCardV2 item={item} open={open} share={share} />;
}
function FileCard({ item, preview }: { item: any; preview: () => void }) {
  return <FileCardV2 item={item} preview={preview} />;
}
function ShareDialog({
  folder,
  canRevoke,
  close,
  changed,
}: {
  folder: any;
  canRevoke: boolean;
  close: () => void;
  changed: () => void;
}) {
  const [active, setActive] = useState<ActiveDeliveryShare | null | undefined>(
    undefined,
  );
  const [result, setResult] = useState<DeliveryShareResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expirationMode, setExpirationMode] = useState<"never" | "custom">(
    "never",
  );
  const [expiresAt, setExpiresAt] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [generated, setGenerated] = useState(false);
  const [removeCode, setRemoveCode] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");

  useEffect(() => {
    let mounted = true;
    api<{ share: ActiveDeliveryShare | null }>(
      "/api/delivery/shares/active?prefix=" + encodeURIComponent(folder.prefix),
    )
      .then((value) => {
        if (!mounted) return;
        setActive(value.share);
        setRecipientEmail(value.share?.recipientEmail || "");
        if (value.share?.expiresAt) {
          setExpirationMode("custom");
          const valueDate = new Date(value.share.expiresAt);
          setExpiresAt(
            new Date(
              valueDate.getTime() - valueDate.getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16),
          );
        }
      })
      .catch((caught) => {
        if (mounted) setError((caught as Error).message);
      })
      .finally(() => {
        if (mounted)
          setActive((current) => (current === undefined ? null : current));
      });
    return () => {
      mounted = false;
    };
  }, [folder.prefix]);

  const shown = result
    ? {
        id: result.id,
        shareUrl: result.shareUrl,
        passwordProtected: result.passwordProtected,
        expiresAt: result.expiresAt,
        recoverable: true,
      }
    : active;
  const codeWillChange = Boolean(
    shown && !result && (accessCode || removeCode),
  );

  function markDirty() {
    setResult(null);
  }

  async function unshare() {
    if (
      !shown ||
      !confirm(
        "Unshare this folder? Anyone using the current link will lose access.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("/api/delivery/shares/" + shown.id, { method: "DELETE" });
      setActive(null);
      setResult(null);
      setAccessCode("");
      setGenerated(false);
      setRemoveCode(false);
      changed();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <Card
        title="Share folder"
        action={
          <button
            className="button-ghost button-small"
            onClick={close}
            disabled={busy}
          >
            Close
          </button>
        }
      >
        {active === undefined ? (
          <Loading />
        ) : (
          <>
            <div className="share-folder-path">
              <span>Folder</span>
              <code>{folder.prefix}</code>
            </div>
            {shown && (
              <div className="current-share">
                <div>
                  <strong>Already shared</strong>
                  <small>
                    {shown.passwordProtected
                      ? "Protected with an access code"
                      : "Anyone with the complete link can open it"}
                    {shown.expiresAt
                      ? " · Expires " + date(shown.expiresAt)
                      : " · Never expires"}
                  </small>
                </div>
                {shown.shareUrl ? (
                  <div className="current-share-link">
                    <code>
                      <a href={shown.shareUrl} target="_blank" rel="noreferrer">
                        {shown.shareUrl}
                      </a>
                    </code>
                    <button
                      className="button-ghost button-small"
                      onClick={() =>
                        void navigator.clipboard.writeText(shown.shareUrl!)
                      }
                    >
                      Copy
                    </button>
                  </div>
                ) : (
                  <div className="notice">
                    This older link cannot be recovered. Saving below will
                    replace it with one managed link and invalidate the older
                    URL.
                  </div>
                )}
              </div>
            )}
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  const body: Record<string, unknown> = {
                    r2Prefix: folder.prefix,
                    expiresAt:
                      expirationMode === "custom" && expiresAt
                        ? new Date(expiresAt).toISOString()
                        : null,
                    recipientEmail: recipientEmail.trim() || null,
                  };
                  if (removeCode) body.removeAccessCode = true;
                  else if (accessCode.trim())
                    body.accessCode = accessCode.trim();
                  const value = (
                    await api<{ share: DeliveryShareResult }>(
                      "/api/delivery/shares",
                      {
                        method: "POST",
                        headers: { "Idempotency-Key": crypto.randomUUID() },
                        body: JSON.stringify(body),
                      },
                    )
                  ).share;
                  setResult(value);
                  setActive({
                    id: value.id,
                    shareUrl: value.shareUrl,
                    passwordProtected: value.passwordProtected,
                    expiresAt: value.expiresAt,
                    recoverable: true,
                  });
                  setRemoveCode(false);
                  changed();
                } catch (caught) {
                  setError((caught as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Expiration
                <select
                  value={expirationMode}
                  onChange={(event) => {
                    setExpirationMode(event.target.value as "never" | "custom");
                    markDirty();
                  }}
                  disabled={busy}
                >
                  <option value="never">Never</option>
                  <option value="custom">Choose a date</option>
                </select>
              </label>
              {expirationMode === "custom" && (
                <label>
                  Expires on
                  <input
                    value={expiresAt}
                    onChange={(event) => {
                      setExpiresAt(event.target.value);
                      markDirty();
                    }}
                    type="datetime-local"
                    required
                    disabled={busy}
                  />
                </label>
              )}
              <label className="full">
                Recipient email
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(event) => {
                    setRecipientEmail(event.target.value);
                    markDirty();
                  }}
                  placeholder="Optional client email"
                  disabled={busy}
                />
                <small>
                  Delivery and access notifications will be sent here. Access
                  codes are never emailed.
                </small>
              </label>
              <label className="full">
                Access code
                <div className="access-code-field">
                  <input
                    value={accessCode}
                    onChange={(event) => {
                      setAccessCode(event.target.value);
                      setGenerated(false);
                      setRemoveCode(false);
                      markDirty();
                    }}
                    minLength={8}
                    disabled={busy || removeCode}
                    autoComplete="off"
                    placeholder={
                      shown?.passwordProtected && !removeCode
                        ? "Leave blank to keep the existing code"
                        : "Optional, 8+ characters"
                    }
                  />
                  {accessCode && (
                    <button
                      className="button-ghost button-small"
                      type="button"
                      disabled={busy || removeCode}
                      onClick={() =>
                        void navigator.clipboard.writeText(accessCode)
                      }
                    >
                      Copy
                    </button>
                  )}
                </div>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={generated}
                  disabled={busy || removeCode}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setGenerated(checked);
                    setRemoveCode(false);
                    setAccessCode(checked ? generateSecureAccessCode() : "");
                    markDirty();
                  }}
                />{" "}
                Generate a secure code in the field above
              </label>
              {shown?.passwordProtected && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={removeCode}
                    disabled={busy}
                    onChange={(event) => {
                      setRemoveCode(event.target.checked);
                      setGenerated(false);
                      setAccessCode("");
                      markDirty();
                    }}
                  />{" "}
                  Remove the existing access code
                </label>
              )}
              {shown && codeWillChange && (
                <div className="notice full">
                  <strong>The current link will be replaced.</strong> Changing
                  its access-code protection invalidates the old URL
                  immediately.
                </div>
              )}
              <ErrorLine error={error} />
              <div className="full actions">
                <button className="button-orange" disabled={busy}>
                  {busy ? "Saving…" : shown ? "Save changes" : "Create link"}
                </button>
                {shown && canRevoke && (
                  <button
                    className="button-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void unshare()}
                  >
                    Unshare folder
                  </button>
                )}
              </div>
            </form>
            {result && (
              <div className="share-result">
                <strong>
                  {result.lifecycle === "reused"
                    ? "Existing link ready"
                    : result.lifecycle === "rotated"
                      ? "New link created; old link disabled"
                      : result.lifecycle === "updated"
                        ? "Link updated"
                        : "Link created"}
                </strong>
                <div>
                  <code>
                    <a href={result.shareUrl} target="_blank" rel="noreferrer">
                      {result.shareUrl}
                    </a>
                  </code>
                  <button
                    className="button-ghost button-small"
                    onClick={() =>
                      void navigator.clipboard.writeText(result.shareUrl)
                    }
                  >
                    Copy link
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
function FilePreview({
  item,
  items: providedItems,
  select: providedSelect,
  close,
}: {
  item: DeliveryItem;
  items?: DeliveryItem[];
  select?: (item: DeliveryItem) => void;
  close: () => void;
}) {
  const items = providedItems ?? [item],
    select = providedSelect ?? (() => {});
  const [streamUrl, setStreamUrl] = useState<string | null>(null),
    [ticketLoading, setTicketLoading] = useState(false);
  const index = items.findIndex(
    (candidate) => itemRef(candidate) === itemRef(item),
  );
  const previous = index > 0 ? items[index - 1] : undefined,
    next =
      index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const filmstripItems =
    index < 0
      ? []
      : items.slice(Math.max(0, index - 4), Math.min(items.length, index + 5));
  const activeFilmstripItem = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow,
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    activeFilmstripItem.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [item.id]);
  useEffect(() => {
    let cancelled = false;
    setStreamUrl(null);
    setTicketLoading(item.kind === "video" && item.previewStatus === "ready");
    if (item.kind === "video" && item.previewStatus === "ready")
      api<{ url: string }>(
        `/api/delivery/items/${encodeURIComponent(item.id || "")}/stream-ticket`,
        { method: "POST", body: "{}" },
      )
        .then((value) => {
          if (!cancelled) setStreamUrl(value.url);
        })
        .catch(() => {
          if (!cancelled) setStreamUrl(null);
        })
        .finally(() => {
          if (!cancelled) setTicketLoading(false);
        });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.kind, item.previewStatus]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (event.target as HTMLElement)?.tagName,
        )
      )
        return;
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft" && previous) select(previous);
      if (event.key === "ArrowRight" && next) select(next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, next, previous, select]);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        className="preview"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${displayName(item)}`}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),audio[controls],video[controls],[tabindex]:not([tabindex="-1"])',
            ),
          );
          if (!focusable.length) {
            event.preventDefault();
            return;
          }
          const first = focusable[0]!,
            last = focusable[focusable.length - 1]!;
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <strong>{displayName(item)}</strong>
          {index >= 0 && (
            <span className="preview-position" aria-live="polite">
              {index + 1} of {items.length}
            </span>
          )}
          <a
            className="button button-orange button-small"
            href={item.downloadUrl}
          >
            Download
          </a>
          <button className="button-ghost button-small" onClick={close}>
            Close
          </button>
        </header>
        <div className="preview-stage-ops">
          <button
            className="preview-nav previous"
            disabled={!previous}
            aria-label="Previous file"
            onClick={() => previous && select(previous)}
          >
            ‹
          </button>
          <div className="preview-media">
            <OperationsMedia
              key={itemRef(item)}
              item={item}
              streamUrl={streamUrl}
              ticketLoading={ticketLoading}
            />
          </div>
          <button
            className="preview-nav next"
            disabled={!next}
            aria-label="Next file"
            onClick={() => next && select(next)}
          >
            ›
          </button>
        </div>
        {filmstripItems.length > 0 && (
          <div
            className="preview-filmstrip"
            aria-label="Nearby files in this folder"
          >
            {filmstripItems.map((candidate) => {
              const active = itemRef(candidate) === itemRef(item);
              return (
                <button
                  key={itemRef(candidate)}
                  ref={active ? activeFilmstripItem : null}
                  className={active ? "active" : ""}
                  aria-current={active ? "true" : undefined}
                  title={displayName(candidate)}
                  onClick={() => select(candidate)}
                >
                  <OperationsThumbnail item={candidate} />
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
function OperationsMedia({
  item,
  streamUrl,
  ticketLoading,
}: {
  item: DeliveryItem;
  streamUrl: string | null;
  ticketLoading: boolean;
}) {
  const [failed, setFailed] = useState(false),
    [loading, setLoading] = useState(true),
    [pdfReady, setPdfReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (item.kind !== "pdf" || !item.sourceUrl) {
      setPdfReady(null);
      return;
    }
    let cancelled = false;
    setPdfReady(null);
    fetch(item.sourceUrl, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((response) => {
        if (!cancelled)
          setPdfReady(
            response.ok &&
              response.headers
                .get("Content-Type")
                ?.startsWith("application/pdf") === true,
          );
      })
      .catch(() => {
        if (!cancelled) setPdfReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.kind, item.sourceUrl]);
  if (failed) return <OperationsPreviewPlaceholder item={item} />;
  if (item.kind === "image")
    return (
      <ZoomableOperationsImage
        src={item.previewUrl}
        alt={displayName(item)}
        loading={loading}
        loaded={() => setLoading(false)}
        failed={() => setFailed(true)}
      />
    );
  if (item.kind === "pdf") {
    if (!item.sourceUrl || pdfReady === false)
      return <OperationsPreviewPlaceholder item={item} />;
    if (pdfReady === null) return <ViewerSkeleton />;
    return (
      <>
        {loading && <ViewerSkeleton />}
        <iframe
          src={item.sourceUrl}
          title={displayName(item)}
          loading="lazy"
          onLoad={() => setLoading(false)}
          onError={() => setFailed(true)}
        />
      </>
    );
  }
  if (item.kind === "video") {
    if (streamUrl)
      return (
        <iframe
          src={streamUrl}
          title={displayName(item)}
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      );
    if (ticketLoading) return <ViewerSkeleton />;
    return item.sourceUrl ? (
      <video
        src={item.sourceUrl}
        controls
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
      />
    ) : (
      <OperationsPreviewPlaceholder item={item} />
    );
  }
  if (item.kind === "audio" && (item.sourceUrl || item.previewUrl))
    return <audio src={item.sourceUrl || item.previewUrl} controls />;
  if (item.kind === "text" && (item.sourceUrl || item.previewUrl))
    return (
      <iframe
        src={item.sourceUrl || item.previewUrl}
        title={displayName(item)}
        loading="lazy"
      />
    );
  return <OperationsPreviewPlaceholder item={item} />;
}
function ZoomableOperationsImage({ src, alt, loading, loaded, failed }: { src?: string; alt: string; loading: boolean; loaded: () => void; failed: () => void }) {
  const [scale, setScale] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>()), gesture = useRef<{ distance: number; scale: number } | null>(null);
  const fit = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
  useEffect(fit, [src]);
  // Orthomosaics often need inspection far beyond a normal photo viewer.  Keep
  // the lower bound fitted, but allow enough magnification for tile-level detail.
  const constrain = (value: number) => Math.min(20, Math.max(1, value));
  const pointDistance = () => {
    const [first, second] = [...pointers.current.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  };
  return <div
    className={`zoomable-operations-image ${scale > 1 ? "zoomed" : ""}`}
    onWheel={(event) => { event.preventDefault(); const next = constrain(scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18)); setScale(next); if (next === 1) setOffset({ x: 0, y: 0 }); }}
    onDoubleClick={fit}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pointers.current.size === 2) gesture.current = { distance: pointDistance(), scale }; }}
    onPointerMove={(event) => {
      const previous = pointers.current.get(event.pointerId); if (!previous) return;
      const current = { x: event.clientX, y: event.clientY }; pointers.current.set(event.pointerId, current);
      if (pointers.current.size === 2 && gesture.current) { const distance = pointDistance(); if (gesture.current.distance) setScale(constrain(gesture.current.scale * distance / gesture.current.distance)); }
      else if (scale > 1) setOffset((value) => ({ x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }));
    }}
    onPointerUp={(event) => { pointers.current.delete(event.pointerId); if (pointers.current.size < 2) gesture.current = null; }}
    onPointerCancel={(event) => { pointers.current.delete(event.pointerId); gesture.current = null; }}
  >
    {loading && <ViewerSkeleton />}
    <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onLoad={loaded} onError={failed} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
    {scale > 1 && <button type="button" className="image-fit-control button-ghost button-small" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); fit(); event.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus(); }}>Fit</button>}
  </div>;
}
function OperationsPreviewPlaceholder({ item }: { item: DeliveryItem }) {
  return (
    <div className="ops-preview-empty">
      <img src={BRAND.logoUrl} alt={BRAND.shortName} />
      <strong>This file could not be displayed</strong>
      <p>
        Your browser may not support this file format. The original remains
        available to download.
      </p>
      <a className="button button-orange button-small" href={item.downloadUrl}>
        Download
      </a>
    </div>
  );
}
function ShareHistory({
  session,
  revision,
}: {
  session: Session;
  revision: number;
}) {
  const { data, error, reload } = useLoad(
    () =>
      allowed(session.user, "delivery.share.audit")
        ? api<{ shares: any[] }>("/api/delivery/shares")
        : Promise.resolve({ shares: [] }),
    [revision],
  );
  if (!allowed(session.user, "delivery.share.audit")) return null;
  const canRevoke = allowed(session.user, "delivery.share.revoke");
  return (
    <Card
      title="Recent client links"
      action={
        <button
          className="button-ghost button-small"
          onClick={() => void reload()}
        >
          Refresh
        </button>
      }
    >
      <ErrorLine error={error} />
      {data?.shares.length ? (
        <table>
          <thead>
            <tr>
              <th>Folder</th>
              <th>Security</th>
              <th>Status</th>
              {canRevoke && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {data.shares.map((share) => {
              const status = share.revoked_at
                ? "revoked"
                : share.unavailable_since
                  ? "unavailable"
                  : "active";
              return (
                <tr key={share.id}>
                  <td>
                    <strong>{share.display_name || share.r2_prefix}</strong>
                    <small>
                      <code>{share.r2_prefix}</code>
                    </small>
                  </td>
                  <td>
                    {share.password_protected ? "Access code" : "Complete link"}
                  </td>
                  <td>
                    <StatusPill
                      tone={
                        status === "revoked"
                          ? "danger"
                          : status === "unavailable"
                            ? "warning"
                            : "success"
                      }
                    >
                      {status}
                    </StatusPill>
                  </td>
                  {canRevoke && (
                    <td>
                      {!share.revoked_at && (
                        <button
                          className="button-danger button-small"
                          onClick={async () => {
                            if (
                              !confirm(
                                "Unshare this folder? Anyone using the current link will lose access.",
                              )
                            )
                              return;
                            try {
                              await api(`/api/delivery/shares/${share.id}`, {
                                method: "DELETE",
                              });
                              await reload();
                            } catch (caught) {
                              alert((caught as Error).message);
                            }
                          }}
                        >
                          Unshare
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No delivery links"
          detail="Links created from the file browser appear here."
        />
      )}
    </Card>
  );
}

const STAFF_CONTROL_LABELS = {
  allOperations: "View all operations, projects, and tasks",
  deliveryBrowse: "Browse delivery files",
  deliveryLinkCreate: "Create client links",
  deliveryLinkRevoke: "Revoke client links",
  deliveryLinkAudit: "View client-link history",
  teamRoster: "View the team roster",
  administration: "View administration status",
} as const;
type StaffControl = keyof typeof STAFF_CONTROL_LABELS;
function Team({ session }: { session: Session }) {
  const { data, error, reload } = useLoad(
    () => api<{ staff: any[] }>("/api/team/staff"),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const update = async (
    person: any,
    control: StaffControl,
    enabled: boolean,
  ) => {
    if (busy) return;
    setBusy(person.id);
    try {
      const controls = { ...person.localControls, [control]: enabled };
      await api(
        `/api/admin/staff/${encodeURIComponent(person.id)}/access-controls`,
        { method: "PUT", body: JSON.stringify(controls) },
      );
      await reload();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ManagedNotice
        detail={
          session.user.isAdministrator
            ? "Project Alpha controls who can sign in. These controls show effective access; every saved unchecked control explicitly denies inherited grants."
            : "Project Alpha controls who can sign in. Your Operations access is granted locally and may be limited by assigned work."
        }
      />
      <ErrorLine error={error} />
      <div className="card-grid">
        {data?.staff.map((person) => (
          <Card key={person.id}>
            <div className="staff-card">
              <span>{person.display_name.slice(0, 1).toUpperCase()}</span>
              <div className="record-badges">
                <StatusPill
                  tone={person.status === "active" ? "success" : "danger"}
                >
                  {person.status}
                </StatusPill>
                {person.sync_protected || person.id === "staff-beau-koltz" ? (
                  <span className="protected-badge">Protected Owner</span>
                ) : (
                  <span className="managed-badge">
                    Managed in Project Alpha
                  </span>
                )}
              </div>
              <h3>{person.display_name}</h3>
              <p>{person.email}</p>
              <small>{person.roles || "No Project Alpha role"}</small>
              {session.user.isAdministrator &&
              person.id !== session.user.id &&
              !person.sync_protected &&
              person.id !== "staff-beau-koltz" ? (
                <>
                  <fieldset
                    className="local-access-toggle"
                    disabled={busy === person.id}
                  >
                    <legend>Operations access</legend>
                    {(Object.keys(STAFF_CONTROL_LABELS) as StaffControl[]).map(
                      (control) => (
                        <label key={control}>
                          <input
                            type="checkbox"
                            checked={Boolean(person.localControls?.[control])}
                            onChange={(event) =>
                              void update(person, control, event.target.checked)
                            }
                          />
                          {STAFF_CONTROL_LABELS[control]}
                        </label>
                      ),
                    )}
                  </fieldset>
                  {person.status !== "active" && (
                    <small>
                      Saved access will take effect only after Project Alpha
                      activates this staff member.
                    </small>
                  )}
                </>
              ) : (
                <small>Access is managed by a system administrator.</small>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Administration({ session }: { session: Session }) {
  const [message, setMessage] = useState("");
  const audit = useLoad(
    () =>
      allowed(session.user, "audit.view")
        ? api<{ events: any[] }>("/api/admin/audit")
        : Promise.resolve({ events: [] }),
    [],
  );
  return (
    <>
      <div className="dashboard-grid">
        <Card title="Project Alpha">
          <p>
            Receives signed operational changes as they happen and uses a daily
            full snapshot for reconciliation.
          </p>
          {allowed(session.user, "integrations.manage") && (
            <button
              className="button-orange"
              onClick={async () => {
                try {
                  const result = await api<any>(
                    "/api/admin/integrations/project-alpha/sync",
                    { method: "POST", body: "{}" },
                  );
                  setMessage(
                    `Sync complete: ${result.records} records processed.`,
                  );
                } catch (caught) {
                  setMessage((caught as Error).message);
                }
              }}
            >
              Sync now
            </button>
          )}
          {message && <div className="notice">{message}</div>}
        </Card>
        <Card title="Security model">
          <p>
            Cloudflare Access authenticates staff. LTDS roles, explicit grants,
            resource scopes, and explicit denies authorize every API request.
          </p>
          <ul>
            <li>Missing permissions deny by default.</li>
            <li>
              Assignment-scoped records return not found to other operators.
            </li>
            <li>Privileged mutations are audited.</li>
          </ul>
        </Card>
      </div>
      {allowed(session.user, "audit.view") && (
        <Card title="Audit history">
          <ErrorLine error={audit.error} />
          {audit.data?.events.length ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((event) => (
                  <tr key={event.id}>
                    <td>{date(event.created_at)}</td>
                    <td>
                      {event.actor_display_name ||
                        event.actor_email ||
                        event.actor_type}
                    </td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      {event.entity_type} · {event.entity_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No audit events"
              detail="Privileged changes will be recorded here."
            />
          )}
        </Card>
      )}
    </>
  );
}
function TrashPanel() {
  const { data, error, reload } = useLoad(
    () => api<{ items: any[] }>("/api/delivery/trash"),
    [],
  );
  return (
    <Card
      title="Trash"
      action={
        <button
          className="button-ghost button-small"
          onClick={() => void reload()}
        >
          Refresh
        </button>
      }
    >
      <ErrorLine error={error} />
      {data?.items.length ? (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Deleted</th>
              <th>Purge after</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.display_name}</strong>
                  <small>
                    <code>{item.physical_key}</code>
                  </small>
                </td>
                <td>{date(item.deleted_at)}</td>
                <td>{date(item.purge_after)}</td>
                <td>
                  <button
                    className="button-orange button-small"
                    onClick={async () => {
                      if (!confirm(`Restore ${item.display_name}?`)) return;
                      try {
                        await api(`/api/delivery/trash/${item.id}/restore`, {
                          method: "POST",
                          body: "{}",
                        });
                        await reload();
                      } catch (caught) {
                        alert((caught as Error).message);
                      }
                    }}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="Trash is empty"
          detail="Deleted delivery sources remain recoverable for 7 days."
        />
      )}
    </Card>
  );
}
