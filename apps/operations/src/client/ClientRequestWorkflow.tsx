import { useEffect, useMemo, useState } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api } from "./api";
import { RequestMapViewer } from "./RequestMapViewer";
import { RequestMapEditor, type EditableRequestArea, type EditableRequestPoi } from "./RequestMapEditor";
import { ClientRequestAttachments } from "./ClientRequestAttachments";

type RequestStatus =
  | "submitted"
  | "under_review"
  | "accepted_pending_pa_linkage"
  | "accepted_linked"
  | "declined"
  | "cancelled"
  | "completed";
export interface ClientRequestRecord {
  id: string;
  account_name: string;
  project_name: string | null;
  client_name: string | null;
  parent_request_id: string | null;
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
  poi_points_json: string | null;
  status: RequestStatus;
  quote_document_number?: string | null;
  quote_total_minor?: number | null;
  quote_currency?: string | null;
  quote_scope_stale_at?: string | null;
  created_at: string;
  updated_at: string;
}
interface DetailResponse {
  request: ClientRequestRecord;
  services: Array<{
    publicId: string;
    sourceVersion: string;
    name: string;
    summary: string | null;
    category: string;
    geometryRequirement: "none" | "optional" | "required" | null;
    answers: Array<{ questionId: string; label: string; displayValue: string }>;
    integrity: "verified" | "invalid";
  }>;
  revisions: Array<{
    revision_number: number;
    author_type: string;
    action: string;
    snapshot_json: string;
    note: string | null;
    created_at: string;
  }>;
  estimates: Array<{
    id: string;
    version: number;
    scope_text: string;
    estimate_amount_minor: number | null;
    currency: string | null;
    status: string;
    client_response_note: string | null;
    updated_at: string;
  }>;
  history: Array<{
    actor_id: string;
    action: string;
    details_json: string | null;
    created_at: string;
  }>;
  children: Array<{
    id: string;
    title: string;
    status: string;
    created_at: string;
  }>;
  areaRevisions: Array<{
    id: string;
    revision_number: number;
    reason: string;
    change_summary: string;
    created_by: string;
    created_at: string;
  }>;
  effectiveWorkArea: {
    revisionNumber: number;
    areaGeoJson: string | null;
    poiPointsJson: string | null;
    reason: string | null;
    changeSummary: string | null;
    createdBy: string | null;
    createdAt: string | null;
  };
}

interface ProjectAlphaDraftState {
  capability: { enabled: boolean; reason: string | null };
  receipt: {
    requestRevision: number;
    areaRevision: number;
    createdAt: string;
    editorUrl: string | null;
    receiptId: string;
    draftQuote: {
      publicId: string;
      documentNumber: string | null;
      status: "draft";
      version: number;
      editorPath: string;
    };
  } | null;
}

function date(value: string | null | undefined) {
  if (!value) return "Not provided";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function links(value: string) {
  return [...value.matchAll(/https?:\/\/[^\s<>"]+/g)]
    .map((match) => match[0]!)
    .slice(0, 20);
}
function tone(status: string): "neutral" | "success" | "warning" | "danger" {
  return status === "accepted_linked" ||
    status === "completed" ||
    status === "accepted"
    ? "success"
    : status === "declined" || status === "cancelled"
      ? "danger"
      : status === "submitted" ||
          status === "accepted_pending_pa_linkage" ||
          status === "change_requested"
        ? "warning"
        : "neutral";
}

export function ClientRequestWorkflow({
  mapToken,
}: {
  mapToken: string | null;
}) {
  const [requests, setRequests] = useState<ClientRequestRecord[] | null>(null),
    [error, setError] = useState(""),
    [selectedId, setSelectedId] = useState(
      () => location.pathname.split("/").filter(Boolean)[2] || null,
    );
  const pendingOnly =
    new URLSearchParams(location.search).get("status") === "submitted";
  const load = () =>
    api<{ requests: ClientRequestRecord[] }>("/api/client-service-requests")
      .then((value) => setRequests(value.requests))
      .catch((caught) => setError(caught.message));
  useEffect(() => {
    void load();
    const pop = () =>
      setSelectedId(location.pathname.split("/").filter(Boolean)[2] || null);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const visible = useMemo(
    () =>
      pendingOnly
        ? requests?.filter((request) => request.status === "submitted")
        : requests,
    [requests, pendingOnly],
  );
  const open = (id: string) => {
    history.pushState(
      null,
      "",
      `/operations/client-requests/${encodeURIComponent(id)}`,
    );
    setSelectedId(id);
    window.scrollTo(0, 0);
  };
  const back = () => {
    history.pushState(null, "", "/operations/client-requests");
    setSelectedId(null);
  };
  if (selectedId)
    return (
      <ClientRequestDetail
        requestId={selectedId}
        mapToken={mapToken}
        back={back}
        changed={load}
      />
    );
  if (!requests && !error) return <Loading />;
  return (
    <>
      <div className="notice managed-notice">
        <strong>Operational review only</strong>
        <span>
          LTDS estimates are non-binding. Quotes, contracts, invoices, and
          financial notices remain owned by Project Alpha.
        </span>
      </div>
      {error && <div className="notice error">{error}</div>}
      <Card title={pendingOnly ? "Pending review" : "Client request queue"}>
        {visible?.length ? (
          <div className="client-request-review-list">
            {visible.map((request) => (
              <article key={request.id}>
                <div>
                  <strong>{request.title}</strong>
                  <small>
                    {request.account_name} ·{" "}
                    {request.project_name || "On-demand request"} ·{" "}
                    {request.request_type}
                  </small>
                  <p>{request.details}</p>
                  <small>
                    {request.location_text || "No location"} · Submitted{" "}
                    {date(request.created_at)}
                  </small>
                </div>
                <div>
                  <StatusPill tone={tone(request.status)}>
                    {request.status.replaceAll("_", " ")}
                  </StatusPill>
                  <button
                    className="button-orange button-small"
                    onClick={() => open(request.id)}
                  >
                    Review details
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No client requests"
            detail={
              pendingOnly
                ? "There are no submitted requests awaiting review."
                : "Submitted client requests will appear here."
            }
          />
        )}
      </Card>
    </>
  );
}

function ClientRequestDetail({
  requestId,
  mapToken,
  back,
  changed,
}: {
  requestId: string;
  mapToken: string | null;
  back: () => void;
  changed: () => Promise<void> | void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editingWorkArea, setEditingWorkArea] = useState(false),
    [paDraft, setPaDraft] = useState<ProjectAlphaDraftState | null>(null),
    [scope, setScope] = useState("");
  const load = () =>
    api<DetailResponse>(
      `/api/client-service-requests/${encodeURIComponent(requestId)}`,
    )
      .then((value) => {
        setData(value);
        setEditingWorkArea(false);
        const draft = value.estimates.find((item) => ["draft", "change_requested"].includes(item.status));
        if (draft) {
          setScope(draft.scope_text);
        }
      })
      .catch((caught) => setError(caught.message));
  useEffect(() => {
    void load();
    void api<ProjectAlphaDraftState>(
      `/api/client-service-requests/${encodeURIComponent(requestId)}/pa-draft`,
    ).then(setPaDraft).catch(() => setPaDraft({
      capability: {
        enabled: false,
        reason: "Project Alpha draft integration status is unavailable",
      },
      receipt: null,
    }));
  }, [requestId]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      await changed();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!data && !error) return <Loading />;
  if (!data)
    return (
      <>
        <button className="portal-back" onClick={back}>
          ← Request queue
        </button>
        <div className="notice error">{error}</div>
      </>
    );
  const request = data.request,
    effectiveWorkArea = data.effectiveWorkArea || {
      revisionNumber: 0,
      areaGeoJson: request.area_geojson,
      poiPointsJson: request.poi_points_json,
      reason: null,
      changeSummary: null,
      createdBy: null,
      createdAt: null,
    },
    currentEstimate = data.estimates.find((item) =>
      ["draft", "ready", "accepted", "change_requested"].includes(item.status),
    );
  const transition = (
    status:
      "under_review" | "accepted_pending_pa_linkage" | "declined" | "completed",
  ) =>
    run(() =>
      api(`/api/client-service-requests/${encodeURIComponent(requestId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    );
  const saveEstimate = (status: "draft" | "ready") =>
    run(() =>
      api(
        `/api/client-service-requests/${encodeURIComponent(requestId)}/estimate`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            version:
              currentEstimate && ["draft", "change_requested"].includes(currentEstimate.status)
                ? currentEstimate.version
                : undefined,
            scope,
            amount: null,
            currency: null,
            proposedFields: null,
            status,
          }),
        },
      ),
    );
  const linkQuote = () => {
    const raw = prompt("Project Alpha accepted quote ID");
    if (!raw) return;
    return run(() =>
      api(
        `/api/client-service-requests/${encodeURIComponent(requestId)}/pa-quote`,
        { method: "POST", body: JSON.stringify({ artifactId: Number(raw) }) },
      ),
    );
  };
  const createProjectAlphaDraft = () => run(async () => {
    const receipt = await api<ProjectAlphaDraftState["receipt"] & { idempotentReplay: boolean }>(
      `/api/client-service-requests/${encodeURIComponent(requestId)}/pa-draft`,
      { method: "POST" },
    );
    setPaDraft(current => ({
      capability: current?.capability || { enabled: true, reason: null },
      receipt,
    }));
  });
  const saveWorkArea = (next: {
    areaGeoJson: EditableRequestArea | null;
    poiPoints: EditableRequestPoi[];
    reason: string;
  }) => run(() => api(
    `/api/client-service-requests/${encodeURIComponent(requestId)}/work-area`,
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        expectedUpdatedAt: request.updated_at,
        expectedRevision: effectiveWorkArea.revisionNumber,
        ...next,
      }),
    },
  ));
  return (
    <section className="client-request-detail">
      <button className="portal-back" onClick={back}>
        ← Request queue
      </button>
      {error && <div className="notice error">{error}</div>}
      <div className="request-detail-heading">
        <div>
          <span className="eyebrow">Client request review</span>
          <h2>{request.title}</h2>
          <p>
            {request.account_name} ·{" "}
            {request.project_name || "On-demand request"}
          </p>
        </div>
        <StatusPill tone={tone(request.status)}>
          {request.status.replaceAll("_", " ")}
        </StatusPill>
      </div>
      {request.parent_request_id && (
        <div className="notice">
          <strong>Linked change request</strong>
          <span>
            This request revises parent thread {request.parent_request_id}.
          </span>
        </div>
      )}
      <div className="request-review-grid">
        <Card title="Submitted request">
          <dl className="request-review-fields">
            <div>
              <dt>Type</dt>
              <dd>{request.request_type}</dd>
            </div>
            <div>
              <dt>Service category</dt>
              <dd>{request.service_category || "Not provided"}</dd>
            </div>
            <div>
              <dt>Details</dt>
              <dd>{request.details}</dd>
            </div>
            <div>
              <dt>Deliverables</dt>
              <dd>{request.deliverables_text || "Not provided"}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{request.location_text || "Not provided"}</dd>
            </div>
            <div>
              <dt>Preferred start</dt>
              <dd>{date(request.preferred_start_at)}</dd>
            </div>
            <div>
              <dt>Desired completion</dt>
              <dd>{date(request.desired_completion_at)}</dd>
            </div>
            <div>
              <dt>Site contact</dt>
              <dd>
                {[
                  request.site_contact_name,
                  request.site_contact_email,
                  request.site_contact_phone,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Not provided"}
              </dd>
            </div>
          </dl>
          {links(`${request.details}\n${request.deliverables_text || ""}`)
            .length > 0 && (
            <div className="request-links">
              <strong>Submitted links</strong>
              {links(
                `${request.details}\n${request.deliverables_text || ""}`,
              ).map((link) => (
                <a key={link} href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
              ))}
            </div>
          )}
        </Card>
        {!!data.services?.length && (
          <Card title={`Selected services (${data.services.length})`} className="request-services-card">
            <p className="muted">
              Read-only service names, questions, and answers captured with the submitted request.
            </p>
            <div className="request-service-review-list">
              {data.services.map((service, index) => (
                <article key={`${service.publicId}:${service.sourceVersion}:${index}`}>
                  <header>
                    <div>
                      <span className="eyebrow">{service.category}</span>
                      <h3>{service.name}</h3>
                    </div>
                    {service.geometryRequirement && (
                      <StatusPill tone={service.geometryRequirement === "required" ? "warning" : "neutral"}>
                        {service.geometryRequirement === "required"
                          ? "Work area required"
                          : service.geometryRequirement === "optional"
                            ? "Work area optional"
                            : "No work area required"}
                      </StatusPill>
                    )}
                  </header>
                  {service.summary && <p>{service.summary}</p>}
                  {service.integrity === "invalid" ? (
                    <div className="notice error" role="alert">
                      This service snapshot could not be verified. Do not create a quote until the request audit record is reviewed.
                    </div>
                  ) : service.answers.length ? (
                    <dl className="request-service-answers">
                      {service.answers.map(answer => (
                        <div key={answer.questionId}>
                          <dt>{answer.label}</dt>
                          <dd>{answer.displayValue}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="muted">No additional service questions were submitted.</p>
                  )}
                </article>
              ))}
            </div>
          </Card>
        )}
        <Card title="Work area">
          {editingWorkArea ? (
            <RequestMapEditor
              token={mapToken}
              areaJson={effectiveWorkArea.areaGeoJson}
              poiJson={effectiveWorkArea.poiPointsJson}
              busy={busy}
              onCancel={() => setEditingWorkArea(false)}
              onSave={(next) => void saveWorkArea(next)}
            />
          ) : (
            <>
              {effectiveWorkArea.revisionNumber > 0 && (
                <div className="notice request-work-area-revision-notice">
                  <strong>Staff revision {effectiveWorkArea.revisionNumber} is effective</strong>
                  <span>{effectiveWorkArea.changeSummary}</span>
                </div>
              )}
              <RequestMapViewer
                token={mapToken}
                areaJson={effectiveWorkArea.areaGeoJson}
                poiJson={effectiveWorkArea.poiPointsJson}
                latitude={request.latitude}
                longitude={request.longitude}
                locationLabel={request.location_text}
              />
              <button
                type="button"
                className="button-orange button-small"
                disabled={busy || ["declined", "cancelled", "completed"].includes(request.status)}
                onClick={() => setEditingWorkArea(true)}
              >
                Edit work area
              </button>
            </>
          )}
          {(effectiveWorkArea.areaGeoJson || effectiveWorkArea.poiPointsJson) && (
            <div className="client-request-actions">
              <a
                className="button-ghost button-small"
                href={`/api/client-service-requests/${encodeURIComponent(requestId)}/area.kml?revision=original`}
                download
              >
                Download original KML
              </a>
              <a
                className="button-ghost button-small"
                href={`/api/client-service-requests/${encodeURIComponent(requestId)}/area.kml?revision=effective`}
                download
              >
                Download current KML
              </a>
            </div>
          )}
        </Card>
      </div>
      <ClientRequestAttachments requestId={requestId} />
      {request.quote_scope_stale_at && (
        <div className="notice stale-notice" role="status">
          <strong>Project Alpha scope needs review</strong>
          <span>The linked commercial artifact predates the effective work-area revision and is no longer treated as current.</span>
        </div>
      )}
      <Card title="Operational estimate / scope proposal">
        <p className="muted">
          This is a non-binding planning estimate, not a Project Alpha quote,
          contract, or invoice.
        </p>
        {currentEstimate && !["draft", "change_requested"].includes(currentEstimate.status) ? (
          <div className="estimate-current">
            <StatusPill tone={tone(currentEstimate.status)}>
              {currentEstimate.status === "ready"
                ? "Estimate ready"
                : currentEstimate.status.replaceAll("_", " ")}
            </StatusPill>
            <p>{currentEstimate.scope_text}</p>
            {currentEstimate.estimate_amount_minor !== null && (
              <strong>
                {new Intl.NumberFormat(undefined, {
                  style: "currency",
                  currency: currentEstimate.currency || "USD",
                }).format(currentEstimate.estimate_amount_minor / 100)}
              </strong>
            )}
            {currentEstimate.client_response_note && (
              <p>
                <strong>Client response:</strong>{" "}
                {currentEstimate.client_response_note}
              </p>
            )}
          </div>
        ) : (
          <div className="estimate-editor">
            <label>
              Scope proposal
              <textarea
                rows={5}
                maxLength={5000}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              />
            </label>
            <p className="muted">
              Pricing is created and reviewed in Project Alpha. This proposal
              covers scope, timing, assumptions, and deliverables only.
            </p>
            <div>
              <button
                className="button-ghost"
                disabled={busy || !scope.trim()}
                onClick={() => void saveEstimate("draft")}
              >
                Save draft
              </button>
              <button
                className="button-orange"
                disabled={busy || !scope.trim()}
                onClick={() => void saveEstimate("ready")}
              >
                Send for client confirmation
              </button>
            </div>
          </div>
        )}
      </Card>
      <Card title="Review actions">
        <div className="client-request-actions">
          {request.status === "submitted" && (
            <button
              className="button-orange"
              disabled={busy}
              onClick={() => void transition("under_review")}
            >
              Begin review
            </button>
          )}
          {request.status === "under_review" && (
            <button
              className="button-orange"
              disabled={busy || currentEstimate?.status !== "accepted"}
              onClick={() => void transition("accepted_pending_pa_linkage")}
            >
              Approve current revision
            </button>
          )}
          {request.status === "accepted_pending_pa_linkage" && (
            <button
              className="button-orange"
              disabled={busy || !paDraft?.capability.enabled}
              onClick={() => void createProjectAlphaDraft()}
            >
              Create Project Alpha draft
            </button>
          )}
          {request.status === "under_review" && (
            <button
              className="button-orange"
              disabled={busy || !paDraft?.capability.enabled}
              onClick={() => void createProjectAlphaDraft()}
            >
              Create Project Alpha draft
            </button>
          )}
          {request.status === "accepted_pending_pa_linkage" && (
            <button
              className="button-ghost"
              disabled={busy}
              onClick={() => void linkQuote()}
            >
              Link approved Project Alpha quote manually
            </button>
          )}
          {["submitted", "under_review"].includes(request.status) && (
            <button
              className="button-danger"
              disabled={busy}
              onClick={() => void transition("declined")}
            >
              Decline
            </button>
          )}
          {request.status === "accepted_linked" && (
            <button
              className="button-orange"
              disabled={busy}
              onClick={() => void transition("completed")}
            >
              Complete
            </button>
          )}
        </div>
        {(["under_review", "accepted_pending_pa_linkage"] as string[]).includes(request.status) &&
          paDraft && !paDraft.capability.enabled && (
            <p className="muted">{paDraft.capability.reason}</p>
          )}
        {paDraft?.receipt && (
          <div className="notice" role="status">
            <strong>
              Private Project Alpha draft {paDraft.receipt.draftQuote.documentNumber || paDraft.receipt.draftQuote.publicId}
            </strong>
            <span>
              Project Alpha owns pricing, approval, sending, invoicing, and payment.
            </span>
            {paDraft.receipt.editorUrl ? (
              <a
                className="button-ghost button-small"
                href={paDraft.receipt.editorUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open draft in Project Alpha
              </a>
            ) : (
              <span className="muted">Project Alpha editor link unavailable</span>
            )}
          </div>
        )}
        {request.status === "accepted_pending_pa_linkage" && (
          <p className="muted">
            Manual fallback verifies an already approved Project Alpha quote; it does not create or price one in LTDS.
          </p>
        )}
        {request.quote_document_number && (
          <p>
            <strong>Verified Project Alpha quote:</strong>{" "}
            {request.quote_document_number}
          </p>
        )}
      </Card>
      <div className="request-review-grid">
        <Card title="Linked change requests">
          {data.children.length ? (
            <ol className="request-history">
              {data.children.map((child) => (
                <li key={child.id}>
                  <button
                    className="button-ghost button-small"
                    onClick={() => {
                      history.pushState(
                        null,
                        "",
                        `/operations/client-requests/${encodeURIComponent(child.id)}`,
                      );
                      dispatchEvent(new PopStateEvent("popstate"));
                    }}
                  >
                    {child.title}
                  </button>
                  <span>
                    {child.status.replaceAll("_", " ")} · {date(child.created_at)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title="No linked changes"
              detail="Post-review change requests will appear here as child revisions."
            />
          )}
        </Card>
        <Card title="Revision history">
          {data.revisions.length ? (
            <ol className="request-history">
              {data.revisions.map((item) => (
                <li key={item.revision_number}>
                  <strong>
                    Revision {item.revision_number} ·{" "}
                    {item.action.replaceAll("_", " ")}
                  </strong>
                  <span>
                    {item.author_type} · {date(item.created_at)}
                  </span>
                  {item.note && <p>{item.note}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title="No revisions"
              detail="Revision records will appear here."
            />
          )}
        </Card>
        <Card title="Work-area revisions">
          {(data.areaRevisions || []).length ? (
            <ol className="request-history">
              {(data.areaRevisions || []).map((revision) => (
                <li key={revision.id}>
                  <strong>Staff revision {revision.revision_number}</strong>
                  <span>{revision.change_summary}</span>
                  <small>{revision.reason} · {date(revision.created_at)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No staff work-area revisions. The client submission is effective.</p>
          )}
        </Card>
        <Card title="Status & audit history">
          {data.history.length ? (
            <ol className="request-history">
              {data.history.map((item, index) => (
                <li key={`${item.created_at}-${index}`}>
                  <strong>{item.action.replaceAll("_", " ")}</strong>
                  <span>{date(item.created_at)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title="No staff history"
              detail="Staff review actions will appear here."
            />
          )}
        </Card>
      </div>
    </section>
  );
}
