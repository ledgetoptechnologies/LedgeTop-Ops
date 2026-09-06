import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import { businessTimestamp, type ClientKind, type ClientRootNamespace } from "./ClientDirectory";
import "./ClientAuditTimeline.css";

const categories = ["all", "project", "request", "feedback", "access", "delivery", "notification"] as const;
const coveredCategories = categories.slice(1) as Exclude<(typeof categories)[number], "all">[];
const actorTypes = ["all", "staff", "client", "system", "integration", "public", "source"] as const;
const results = ["all", "succeeded", "failed", "denied", "informational"] as const;
const coverageReasons = ["permission_required", "unsupported_source", "not_applicable", "not_collected"] as const;
const producers = ["project_alpha", "operations", "service_requests", "portal_access", "client_delivery", "client_feedback"] as const;
const projectAdapters = ["source_record_activity", "operational_project_activity", "organization_contact_activity"] as const;
const accessAdapters = ["workspace_membership", "workspace_invitation_request", "workspace_peer_administrator",
  "portal_identity_denial", "authenticated_delivery_grant", "delegated_client_share", "viewer_client_grant", "project_access"] as const;
const notificationAdapters = ["delivery_share_notification", "project_access_collaborator_notice", "project_access_companion_notice"] as const;
const contentAdapters=["authenticated_content_activity"] as const;
type Category = (typeof categories)[number];
type CoveredCategory = (typeof coveredCategories)[number];
type ActorType = (typeof actorTypes)[number];
type EventActorType = Exclude<ActorType, "all">;
type AuditResult = (typeof results)[number];
type EventResult = Exclude<AuditResult, "all">;
type CoverageReason = (typeof coverageReasons)[number];

interface AuditRoot { sourceId: string; rootNamespace: ClientRootNamespace; kind: ClientKind; publicId: string }
interface AuditFilters { category: Category; actorType: ActorType; result: AuditResult; from: string | null; to: string | null }
interface AuditItem {
  id: string; sourceId: string; producer: string; producerEventId: string; category: CoveredCategory; action: string;
  actor: { type: EventActorType; label: string } | null;
  resource: { type: string; id?: string; label: string; detailPath?: string };
  result: EventResult; occurredAt: string;
}
interface Coverage { available: boolean; reason: CoverageReason | null; collectedSince?: string | null }
interface AuditResponse {
  canonicalRoot: AuditRoot; projectId: string | null; contextVersion: string; refreshedAt: string; asOf: string;
  coverage: Record<CoveredCategory, Coverage>; filters: AuditFilters; items: AuditItem[];
  projectCoverage: Record<(typeof projectAdapters)[number], Coverage>;
  accessCoverage: Record<(typeof accessAdapters)[number], Coverage>;
  notificationCoverage: Record<(typeof notificationAdapters)[number], Coverage>;
  contentCoverage:Record<(typeof contentAdapters)[number],Coverage>;
  page: { nextCursor: string | null; hasMore: boolean; returned: number; limit: number };
}
interface FilterDraft { category: Category; actorType: ActorType; result: AuditResult; from: string; to: string }

const defaults: FilterDraft = { category: "all", actorType: "all", result: "all", from: "", to: "" };
const accessDefaults: FilterDraft = { ...defaults, category: "access" };
const auditParams = ["audit.active", "audit.category", "audit.actor", "audit.result", "audit.from", "audit.to"] as const;
const labels: Record<CoveredCategory, string> = {
  project: "Projects", request: "Requests", feedback: "Feedback", access: "Access", delivery: "Delivery", notification: "Notifications",
};
const rootKey = (root: AuditRoot) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const itemKey = (item: AuditItem) => JSON.stringify([item.sourceId, item.producer, item.producerEventId, item.id]);
const isValue = <T extends readonly string[]>(values: T, value: unknown): value is T[number] => typeof value === "string" && values.includes(value);
const scalar = (value: unknown, maximum: number, optional = false): value is string | undefined =>
  (optional && value === undefined) || (typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value));

function isoDate(value: string, end = false): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`;
  return businessTimestamp(timestamp);
}

function requestedFilters(value: FilterDraft): AuditFilters | null {
  const from = isoDate(value.from), to = isoDate(value.to, true);
  if ((value.from && !from) || (value.to && !to) || (from && to && from > to)) return null;
  return { category: value.category, actorType: value.actorType, result: value.result, from, to };
}

function validCoverage(value: unknown): value is Record<CoveredCategory, Coverage> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== coveredCategories.length) return false;
  return coveredCategories.every(category => {
    const entry = record[category];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const coverage = entry as Partial<Coverage>;
    return typeof coverage.available === "boolean" && (coverage.available
      ? coverage.reason === null : isValue(coverageReasons, coverage.reason));
  });
}

function validAccessCoverage(value: unknown): value is AuditResponse["accessCoverage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === accessAdapters.length && accessAdapters.every(adapter => {
    const entry = record[adapter];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Partial<Coverage>;
    const collectedSince=item.collectedSince===undefined||item.collectedSince===null?item.collectedSince:businessTimestamp(item.collectedSince);
    return typeof item.available === "boolean" && (item.available ? item.reason === null : isValue(coverageReasons, item.reason))
      && (adapter==='project_access'?(item.available?typeof collectedSince==='string'
        :item.collectedSince===undefined||item.collectedSince===null||typeof collectedSince==='string')
        :item.collectedSince===undefined);
  });
}

function validProjectCoverage(value: unknown): value is AuditResponse["projectCoverage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === projectAdapters.length && projectAdapters.every(adapter => {
    const entry = record[adapter];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Partial<Coverage>;
    return typeof item.available === "boolean" && (item.available ? item.reason === null : isValue(coverageReasons, item.reason));
  });
}

function validNotificationCoverage(value: unknown): value is AuditResponse["notificationCoverage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === notificationAdapters.length && notificationAdapters.every(adapter => {
    const entry = record[adapter];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Partial<Coverage>;
    return typeof item.available === "boolean" && (item.available ? item.reason === null : isValue(coverageReasons, item.reason));
  });
}

function validContentCoverage(value:unknown):value is AuditResponse["contentCoverage"]{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const record=value as Record<string,unknown>;
  return Object.keys(record).length===contentAdapters.length&&contentAdapters.every(adapter=>{
    const entry=record[adapter];if(!entry||typeof entry!=="object"||Array.isArray(entry))return false;
    const item=entry as Partial<Coverage>,collected=item.collectedSince==null?item.collectedSince:businessTimestamp(item.collectedSince);
    return typeof item.available==="boolean"&&(item.available?item.reason===null:isValue(coverageReasons,item.reason))
      &&(item.available?typeof collected==="string":item.collectedSince==null||typeof collected==="string");
  });
}

function draftFromUrl(): FilterDraft | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("audit.active") !== "1") return null;
  const category = params.get("audit.category") ?? "all", actorType = params.get("audit.actor") ?? "all",
    result = params.get("audit.result") ?? "all", from = params.get("audit.from") ?? "", to = params.get("audit.to") ?? "";
  if (!isValue(categories, category) || !isValue(actorTypes, actorType) || !isValue(results, result)) return null;
  const draft = { category, actorType, result, from, to };
  return requestedFilters(draft) ? draft : null;
}

function sameFilters(left: AuditFilters, right: AuditFilters): boolean {
  return left.category === right.category && left.actorType === right.actorType && left.result === right.result
    && left.from === right.from && left.to === right.to;
}

function validItems(items: unknown, root: AuditRoot, asOf: string, projectId?: string): items is AuditItem[] {
  return Array.isArray(items) && items.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const event = item as AuditItem;
    if (!scalar(event.id, 512) || event.sourceId !== root.sourceId || !isValue(producers, event.producer)
      || !scalar(event.producerEventId, 512) || !isValue(coveredCategories, event.category) || !scalar(event.action, 240)
      || !isValue(results.slice(1), event.result) || !event.resource || typeof event.resource !== "object"
      || !scalar(event.resource.type, 160) || !scalar(event.resource.label, 1000)
      || !scalar(event.resource.id, 512, true) || !scalar(event.resource.detailPath, 2048, true)) return false;
    if (event.actor !== null && (!event.actor || typeof event.actor !== "object" || !isValue(actorTypes.slice(1), event.actor.type)
      || !scalar(event.actor.label, 500))) return false;
    const occurred = businessTimestamp(event.occurredAt);
    if (!occurred || occurred > asOf) return false;
    if (projectId !== undefined && event.category === "project" && event.resource.id && event.resource.id !== projectId) return false;
    return true;
  });
}

function resultTone(result: EventResult): "success" | "warning" | "danger" | "neutral" {
  return result === "succeeded" ? "success" : result === "denied" || result === "failed" ? "danger"
    : result === "informational" ? "neutral" : "warning";
}

function detailHref(item: AuditItem): string | null {
  const path = item.resource.detailPath;
  if (!path || !path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
  try {
    const url = new URL(path, location.origin);
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}

function CoverageDisclosure({ coverage, projectCoverage, accessCoverage, notificationCoverage,contentCoverage }: { coverage: Record<CoveredCategory, Coverage>;
  projectCoverage: AuditResponse["projectCoverage"]; accessCoverage: AuditResponse["accessCoverage"];
  notificationCoverage: AuditResponse["notificationCoverage"];contentCoverage:AuditResponse["contentCoverage"] }) {
  const available = coveredCategories.filter(category => coverage[category].available);
  const unavailable = coveredCategories.filter(category => !coverage[category].available);
  const reason = (value: CoverageReason) => value === "permission_required" ? "permission required"
    : value === "unsupported_source" ? "unsupported by this source"
      : value === "not_applicable" ? "not applicable" : "not collected";
  return <details className="client-audit-coverage">
    <summary>Timeline coverage</summary>
    <p>This timeline only covers the categories listed as available. An empty result does not prove that no other activity occurred.</p>
    <dl>
      <div><dt>Available</dt><dd>{available.length ? available.map(category => labels[category]).join(", ") : "No categories"}</dd></div>
      {unavailable.map(category => <div key={category}><dt>{labels[category]}</dt><dd>{reason(coverage[category].reason!)}</dd></div>)}
      {projectAdapters.map(adapter => <div key={adapter}><dt>Projects · {adapter.replaceAll("_", " ")}</dt>
        <dd>{projectCoverage[adapter].available ? "available" : reason(projectCoverage[adapter].reason!)}</dd></div>)}
      {accessAdapters.map(adapter => <div key={adapter}><dt>Access · {adapter.replaceAll("_", " ")}</dt>
        <dd>{accessCoverage[adapter].available
          ? adapter==='project_access'&&accessCoverage[adapter].collectedSince
            ? <>available since <time dateTime={businessTimestamp(accessCoverage[adapter].collectedSince!)!}>
              {new Date(businessTimestamp(accessCoverage[adapter].collectedSince!)!).toLocaleString()}</time></>
            : "available"
          : reason(accessCoverage[adapter].reason!)}</dd></div>)}
      {notificationAdapters.map(adapter => <div key={adapter}><dt>Notifications · {adapter.replaceAll("_", " ")}</dt>
        <dd>{notificationCoverage[adapter].available ? "available" : reason(notificationCoverage[adapter].reason!)}</dd></div>)}
      {contentAdapters.map(adapter=><div key={adapter}><dt>Delivery · {adapter.replaceAll("_"," ")}</dt>
        <dd>{contentCoverage[adapter].available&&contentCoverage[adapter].collectedSince
          ?<>available since <time dateTime={businessTimestamp(contentCoverage[adapter].collectedSince!)!}>
            {new Date(businessTimestamp(contentCoverage[adapter].collectedSince!)!).toLocaleString()}</time></>
          :reason(contentCoverage[adapter].reason!)}</dd></div>)}
    </dl>
  </details>;
}

/** Staff-only read surface. It never turns an audit record into a grant or mutation authority. */
export function ClientAuditTimeline({ root, contextVersion, contextSignal, projectId, onInvalidated }: {
  root: AuditRoot; contextVersion: string; contextSignal: AbortSignal; projectId?: string;
  onInvalidated: (message: string, status?: number) => void;
}) {
  const [draft, setDraft] = useState<FilterDraft>(defaults), [applied, setApplied] = useState<AuditFilters | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]), [coverage, setCoverage] = useState<Record<CoveredCategory, Coverage> | null>(null);
  const [projectCoverage, setProjectCoverage] = useState<AuditResponse["projectCoverage"] | null>(null);
  const [accessCoverage, setAccessCoverage] = useState<AuditResponse["accessCoverage"] | null>(null);
  const [notificationCoverage, setNotificationCoverage] = useState<AuditResponse["notificationCoverage"] | null>(null);
  const [contentCoverage,setContentCoverage]=useState<AuditResponse["contentCoverage"]|null>(null);
  const [page, setPage] = useState<AuditResponse["page"] | null>(null), [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false), [error, setError] = useState(""), [filterError, setFilterError] = useState("");
  const pending = useRef<AbortController | null>(null), sequence = useRef(0), failedCursor = useRef<string | null>(null);
  const identity = rootKey(root);
  const routeKind = root.kind === "organization" ? "organizations" : "standalone";
  const base = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/${root.rootNamespace}/${routeKind}/${encodeURIComponent(root.publicId)}`;
  const endpoint = projectId === undefined ? `${base}/timeline` : `${base}/business-projects/${encodeURIComponent(projectId)}/timeline`;
  const title = projectId === undefined ? "Client audit timeline" : "Project audit timeline";
  const syncUrl = (value: FilterDraft | null, mode: "push" | "replace" = "push") => {
    const url = new URL(window.location.href);
    for (const key of auditParams) url.searchParams.delete(key);
    if (value) {
      url.searchParams.set("audit.active", "1"); url.searchParams.set("audit.category", value.category);
      url.searchParams.set("audit.actor", value.actorType); url.searchParams.set("audit.result", value.result);
      if (value.from) url.searchParams.set("audit.from", value.from);
      if (value.to) url.searchParams.set("audit.to", value.to);
    }
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  useEffect(() => {
    const abort = () => { pending.current?.abort(); pending.current = null; sequence.current += 1; };
    const restore = () => {
      abort(); const restored = draftFromUrl(), filters = restored ? requestedFilters(restored) : null;
      setDraft(restored ?? defaults); setApplied(null); setItems([]); setCoverage(null); setProjectCoverage(null); setAccessCoverage(null); setNotificationCoverage(null);setContentCoverage(null);
      setPage(null); setBusy(false); setRequested(false); setError(""); setFilterError(""); failedCursor.current = null;
      // Keep restored filters available for retry if this first URL/history read
      // fails before a response has had a chance to establish applied state.
      if (filters) { setApplied(filters); void load(filters, null); }
    };
    contextSignal.addEventListener("abort", abort);
    window.addEventListener("popstate", restore); restore();
    return () => { contextSignal.removeEventListener("abort", abort); window.removeEventListener("popstate", restore); abort(); };
  }, [identity, contextVersion, contextSignal, projectId]);

  async function load(filters: AuditFilters, cursor: string | null) {
    if (contextSignal.aborted || pending.current || !contextVersion) return;
    const controller = new AbortController(), request = ++sequence.current; pending.current = controller;
    setRequested(true); setBusy(true); setError(""); setFilterError("");
    if (!cursor) { setItems([]); setCoverage(null); setProjectCoverage(null); setAccessCoverage(null); setNotificationCoverage(null); setPage(null); }
    try {
      const params = new URLSearchParams({ expectedContextVersion: contextVersion, category: filters.category,
        actorType: filters.actorType, result: filters.result, limit: "10" });
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (cursor) params.set("cursor", cursor);
      const response = await api<AuditResponse>(`${endpoint}?${params}`, { signal: controller.signal });
      if (contextSignal.aborted || controller.signal.aborted || sequence.current !== request) return;
      const asOf = businessTimestamp(response.asOf), next = response.page;
      if (!response.canonicalRoot || rootKey(response.canonicalRoot) !== identity || response.contextVersion !== contextVersion
        || response.projectId !== (projectId ?? null) || !businessTimestamp(response.refreshedAt) || !asOf
        || !validCoverage(response.coverage) || !validProjectCoverage(response.projectCoverage) || !validAccessCoverage(response.accessCoverage)
        || !validNotificationCoverage(response.notificationCoverage)
        || !validContentCoverage(response.contentCoverage)
        || !response.filters || !sameFilters(response.filters, filters)
        || !next || typeof next.hasMore !== "boolean" || !(next.nextCursor === null || scalar(next.nextCursor, 4096))
        || !Number.isInteger(next.returned) || !Number.isInteger(next.limit) || next.limit < 1 || next.limit > 100
        || !validItems(response.items, root, asOf, projectId) || next.returned !== response.items.length || response.items.length > next.limit
        || next.hasMore !== Boolean(next.nextCursor) || (next.hasMore && next.nextCursor === cursor)) {
        throw new Error("This audit timeline could not be verified. Retry this section.");
      }
      setItems(previous => [...new Map([...(cursor ? previous : []), ...response.items].map(item => [itemKey(item), item])).values()]);
      setCoverage(response.coverage); setProjectCoverage(response.projectCoverage); setAccessCoverage(response.accessCoverage); setNotificationCoverage(response.notificationCoverage);setContentCoverage(response.contentCoverage);
      setPage(next); setApplied(filters); failedCursor.current = null;
    } catch (caught) {
      if (contextSignal.aborted || controller.signal.aborted || sequence.current !== request) return;
      const message = caught instanceof Error ? caught.message : "The audit timeline could not be loaded.";
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) {
        setItems([]); setCoverage(null); setProjectCoverage(null); setAccessCoverage(null); setNotificationCoverage(null); setPage(null); onInvalidated(message, caught.status);
      } else { setError(message); failedCursor.current = cursor; }
    } finally {
      if (!contextSignal.aborted && !controller.signal.aborted && sequence.current === request) { pending.current = null; setBusy(false); }
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const filters = requestedFilters(draft);
    if (!filters) { setFilterError("Choose valid dates with From on or before To."); return; }
    if (pending.current) return;
    syncUrl(draft);
    setApplied(filters); void load(filters, null);
  };
  const reset = () => {
    if (pending.current) { pending.current.abort(); pending.current = null; sequence.current += 1; }
    setDraft(defaults); setApplied(null); setItems([]); setCoverage(null); setProjectCoverage(null); setAccessCoverage(null); setNotificationCoverage(null); setPage(null); setRequested(false); setBusy(false);
    setError(""); setFilterError(""); failedCursor.current = null;
    syncUrl(null);
  };
  const openAccessHistory = () => {
    if (pending.current) return;
    const filters = requestedFilters(accessDefaults)!;
    syncUrl(accessDefaults); setDraft(accessDefaults); setApplied(filters); void load(filters, null);
  };
  const canContinue = Boolean(applied && page?.hasMore && page.nextCursor);

  return <Card title={title}><section className="client-audit-timeline" aria-label={title} aria-busy={busy}>
    <p className="client-audit-intro">Read-only events from the currently authorized client and project sources. Page views are not activity.</p>
    <div className="client-audit-shortcuts"><button type="button" className="button-ghost" disabled={busy}
      onClick={openAccessHistory}>View access history</button></div>
    <form onSubmit={submit} className="client-audit-filters">
      <label>Category<select value={draft.category} onChange={event => setDraft(value => ({ ...value, category: event.target.value as Category }))}>
        {categories.map(value => <option key={value} value={value}>{value === "all" ? "All categories" : labels[value]}</option>)}</select></label>
      <label>Actor<select value={draft.actorType} onChange={event => setDraft(value => ({ ...value, actorType: event.target.value as ActorType }))}>
        {actorTypes.map(value => <option key={value} value={value}>{value === "all" ? "All actors" : value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      <label>Result<select value={draft.result} onChange={event => setDraft(value => ({ ...value, result: event.target.value as AuditResult }))}>
        {results.map(value => <option key={value} value={value}>{value === "all" ? "All results" : value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      <label>From date (UTC)<input type="date" value={draft.from} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></label>
      <label>To date (UTC)<input type="date" value={draft.to} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></label>
      <div className="client-audit-filter-actions"><button type="submit" className="button-orange" disabled={busy}>{busy && !page ? "Loading timeline…" : "Apply timeline filters"}</button>
        <button type="button" className="button-ghost" disabled={busy && !requested} onClick={reset}>Reset timeline</button></div>
    </form>
    {filterError && <p role="alert">{filterError}</p>}
    {coverage && projectCoverage && accessCoverage && notificationCoverage&&contentCoverage && <CoverageDisclosure coverage={coverage}
      projectCoverage={projectCoverage} accessCoverage={accessCoverage} notificationCoverage={notificationCoverage} contentCoverage={contentCoverage} />}
    {items.length > 0 && <ol className="client-audit-events">{items.map(item => {
      const occurred = businessTimestamp(item.occurredAt)!, href = detailHref(item);
      return <li key={itemKey(item)}><div className="client-audit-event-heading"><div><strong>{item.resource.label}</strong><small>{labels[item.category]} · {item.action.replaceAll("_", " ")}</small></div>
        <StatusPill tone={resultTone(item.result)}>{item.result}</StatusPill></div>
        <dl><div><dt>When</dt><dd><time dateTime={occurred}>{new Date(occurred).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></dd></div>
          <div><dt>Actor</dt><dd>{item.actor ? `${item.actor.label} · ${item.actor.type}` : "Actor not available"}</dd></div>
          <div><dt>Source</dt><dd>{item.producer}</dd></div></dl>
        {href && <a href={href}>Open related record</a>}
      </li>;
    })}</ol>}
    {requested && !busy && !error && !items.length && <p>No matching events are available within the reported coverage.</p>}
    {requested && <p role="status">{items.length.toLocaleString()} events shown{busy ? " · Loading…" : ""}</p>}
    {error && <p role="alert">{error}</p>}
    {requested && <div className="client-audit-actions">
      {(error || canContinue) && <button type="button" className="button-ghost" disabled={busy || (!error && !canContinue)} onClick={() => {
        if (!busy && applied && (error || canContinue)) void load(applied, error ? failedCursor.current : page?.nextCursor || null);
      }}>{busy ? "Loading audit events…" : error ? "Retry audit timeline" : "Load more audit events"}</button>}
      {!error && !canContinue && <span>All matching audit events loaded</span>}
    </div>}
    {!requested && <p className="client-audit-prompt">Apply filters to load the timeline.</p>}
  </section></Card>;
}
