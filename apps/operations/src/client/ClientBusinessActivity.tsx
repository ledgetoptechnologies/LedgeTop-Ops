import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";
import { businessTimestamp, type ClientKind, type ClientRootNamespace } from "./ClientDirectory";
import { clientWorkspaceFilters } from "./business-project-route";
import "./ClientBusinessActivity.css";

interface ActivityRoot { sourceId: string; rootNamespace: ClientRootNamespace; kind: ClientKind; publicId: string }
interface ActivityItem {
  id: string; sourceId: string; recordKind: "organization" | "client" | "project"; recordId: string; recordName: string;
  action: "upsert" | "revoke" | "source_record_updated"; origin: "projection_event" | "source_observation";
  occurredAt: string; observedAt: string; detailPath: string | null;
}
interface ActivityPage { available: boolean; reason: string | null; nextCursor: string | null; hasMore: boolean; returned: number; limit: number }
interface ActivityResponse { canonicalRoot: ActivityRoot; contextVersion: string; refreshedAt: string; asOf: string;
  coverage: "source_records_only"; items: ActivityItem[]; page: ActivityPage }
const rootKey = (root: ActivityRoot) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const itemKey = (item: ActivityItem) => JSON.stringify([item.sourceId, item.id]);
const recordLabel = (kind: ActivityItem["recordKind"]) => kind === "organization" ? "Organization" : kind === "project" ? "Project" : "Client record";
const actionLabel = (action: ActivityItem["action"]) => action === "revoke" ? "Record removed or deactivated" : "Record updated";
function validItems(items: ActivityItem[], root: ActivityRoot, asOf: string, projectId?: string): boolean {
  return Array.isArray(items) && items.every(item => {
    if (!item || typeof item.id !== "string" || !item.id || item.sourceId !== root.sourceId || typeof item.recordId !== "string" || !item.recordId
      || typeof item.recordName !== "string" || item.recordName.length > 4000 || !["organization", "client", "project"].includes(item.recordKind)
      || !["upsert", "revoke", "source_record_updated"].includes(item.action) || !["projection_event", "source_observation"].includes(item.origin)
      || !(item.detailPath === null || typeof item.detailPath === "string")
      || (projectId !== undefined && (item.recordKind !== "project" || item.recordId !== projectId))) return false;
    const occurred = businessTimestamp(item.occurredAt), observed = businessTimestamp(item.observedAt);
    return Boolean(occurred && observed && occurred <= asOf);
  });
}

/** Read-only, source-specific history. A changed context invalidates the whole parent workspace. */
export function ClientBusinessActivity({ root, contextVersion, contextSignal, projectId, onInvalidated }: {
  root: ActivityRoot; contextVersion: string; contextSignal: AbortSignal; projectId?: string;
  onInvalidated: (message: string, status?: number) => void;
}) {
  const [items, setItems] = useState<ActivityItem[]>([]), [page, setPage] = useState<ActivityPage | null>(null);
  const [busy, setBusy] = useState(false), [requested, setRequested] = useState(false), [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null), sequence = useRef(0), failedCursor = useRef<string | null>(null);
  const identity = rootKey(root), routeKind = root.kind === "organization" ? "organizations" : "standalone";
  const sourcePath = `/clients/sources/${encodeURIComponent(root.sourceId)}/business/${routeKind}/${encodeURIComponent(root.publicId)}`;
  useEffect(() => {
    const abort = () => { pending.current?.abort(); pending.current = null; sequence.current += 1; };
    setItems([]); setPage(null); setRequested(false); setBusy(false); setError(""); failedCursor.current = null;
    contextSignal.addEventListener("abort", abort);
    return () => { contextSignal.removeEventListener("abort", abort); abort(); };
  }, [identity, contextVersion, contextSignal, projectId]);
  const load = async (cursor: string | null) => {
    if (contextSignal.aborted || pending.current || root.rootNamespace !== "business" || !contextVersion) return;
    const controller = new AbortController(), request = ++sequence.current; pending.current = controller;
    setRequested(true); setBusy(true); setError("");
    if (!cursor) { setItems([]); setPage(null); }
    try {
      const params = new URLSearchParams({ expectedContextVersion: contextVersion, limit: cursor ? "25" : "5" });
      if (cursor) params.set("cursor", cursor);
      if (projectId !== undefined) params.set("projectId", projectId);
      const result = await api<ActivityResponse>(`/api${sourcePath.replace("/clients/", "/client-hub/")}/activity?${params}`, { signal: controller.signal });
      if (contextSignal.aborted || controller.signal.aborted || sequence.current !== request) return;
      if (!result.canonicalRoot || rootKey(result.canonicalRoot) !== identity || result.contextVersion !== contextVersion)
        throw new ApiError("This client's business record context changed. Refresh the workspace.", 409, {});
      const asOf = businessTimestamp(result.asOf), next = result.page;
      if (result.coverage !== "source_records_only" || !asOf || !businessTimestamp(result.refreshedAt) || !next || typeof next.available !== "boolean"
        || typeof next.hasMore !== "boolean" || !(next.nextCursor === null || typeof next.nextCursor === "string")
        || !Number.isInteger(next.returned) || !Number.isInteger(next.limit) || next.limit < 1 || next.limit > 100
        || !validItems(result.items, root, asOf, projectId) || next.returned !== result.items.length || result.items.length > next.limit
        || (!next.available && result.items.length > 0)
        || (next.hasMore && (!next.nextCursor || next.nextCursor === cursor))) throw new Error("These business updates could not be verified. Retry this section.");
      if (cursor && !next.available) throw new ApiError("Access to business updates changed. Refresh the workspace.", 403, {});
      setItems(previous => [...new Map([...(cursor ? previous : []), ...result.items].map(item => [itemKey(item), item])).values()]);
      setPage(next); failedCursor.current = null;
    } catch (caught) {
      if (contextSignal.aborted || controller.signal.aborted || sequence.current !== request) return;
      const message = caught instanceof Error ? caught.message : "Business updates could not be loaded.";
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) {
        setItems([]); setPage(null); onInvalidated(message, caught.status);
      } else { setError(message); failedCursor.current = cursor; }
    } finally { if (!contextSignal.aborted && !controller.signal.aborted && sequence.current === request) { pending.current = null; setBusy(false); } }
  };
  function projectHref(item: ActivityItem): string | null {
    if (projectId || item.recordKind !== "project" || !item.detailPath || /[\\\u0000-\u001f\u007f]/.test(item.detailPath)) return null;
    const expected = `${sourcePath}/projects/${encodeURIComponent(item.recordId)}`;
    try { const url = new URL(item.detailPath, location.origin); return url.origin === location.origin && url.pathname === expected
      ? `${expected}${clientWorkspaceFilters(location.search)}` : null; } catch { return null; }
  }
  if (root.rootNamespace !== "business") return null;
  const canContinue = Boolean(page?.available && page.hasMore && page.nextCursor), finished = requested && page && !canContinue && !error;
  return <Card title="Business record updates"><section className="client-business-activity" aria-label="Business record updates" aria-busy={busy}>
    <p>Updates to source business records you can access, not a complete activity or audit history.</p>
    {page?.available === false && <p>{page.reason === "permission_required" ? "Permission is required to view these updates." : "Business updates are not available for this record."}</p>}
    {items.length > 0 && <ol>{items.map(item => {
      const href = projectHref(item), timestamp = businessTimestamp(item.occurredAt)!;
      return <li key={itemKey(item)}><div><strong>{item.recordName}</strong><small>{recordLabel(item.recordKind)} · {actionLabel(item.action)}</small></div>
        <time dateTime={timestamp}>{new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
        <small>{item.origin === "source_observation" ? "Update time reported by the source" : "Recorded source change"}</small>
        {href && <a href={href}>Open project</a>}
      </li>;
    })}</ol>}
    {requested && !busy && !error && page?.available && !items.length && <p>{canContinue ? "No updates on this page. Continue checking for more." : "No business record updates are recorded yet."}</p>}
    {requested && <p role="status">{items.length} updates shown{busy ? " · Loading…" : ""}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="client-business-activity-actions"><button type="button" className="button-ghost" aria-disabled={busy || Boolean(finished)}
      onClick={() => { if (!busy && !finished) void load(error ? failedCursor.current : requested ? page?.nextCursor || null : null); }}>
      {busy ? "Loading business updates…" : error ? "Retry business updates" : !requested ? "Show business updates" : canContinue ? "Load more business updates" : "Business updates loaded"}</button>
      {requested && !busy && <button type="button" className="button-ghost" onClick={() => void load(null)}>Refresh business updates</button>}
    </div>
  </section></Card>;
}
