import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";
import { decideInvitationRequest, invitationAdministrationPath, invitationRequestHref, invitationRequestPage, loadInvitationRequestDetail, type InvitationAdministrationAccess, type InvitationRequest, type InvitationRequestDetail } from "./invitation-administration-api";
import { invitationCapabilitiesLabel, invitationRequestStatus, invitationTermsLabel } from "../../../client/src/client/invitation-request-api";
import "./InvitationAdministration.css";

interface Route {id: string | null; sourceId: string; workspaceId: string; status: string; q: string; invalid: boolean}
export function readInvitationApprovalRoute(path = location.pathname, search = location.search): Route {
  const parts = path.split("/").filter(Boolean), params = new URLSearchParams(search);
  let id: string | null = null, invalid = parts[0] !== "operations" || parts[1] !== "invitation-requests" || parts.length > 3;
  try {id = parts[2] ? decodeURIComponent(parts[2]) : null;} catch {invalid = true;}
  const sourceId = params.get("sourceId") ?? "", workspaceId = params.get("workspaceId") ?? "", status = params.get("status") ?? "open", q = params.get("q") ?? "";
  invalid ||= Boolean(id && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) || Boolean(sourceId && !/^project-alpha:[A-Za-z0-9_-]+$/.test(sourceId)) || Boolean(workspaceId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) || Boolean(id && (!sourceId || !workspaceId)) || Boolean(sourceId) !== Boolean(workspaceId)
    || !["open", "pending", "approving", "approved", "rejected", "cancelled", "stale", "all"].includes(status) || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || ["sourceId", "workspaceId", "status", "q"].some(key => params.getAll(key).length > 1);
  return {id, sourceId, workspaceId, status, q, invalid};
}
function listPath(route: Route) {const params = new URLSearchParams({status: route.status}); if (route.q) params.set("q", route.q); if (route.workspaceId) {params.set("workspaceId", route.workspaceId); params.set("sourceId", route.sourceId);} return `${invitationAdministrationPath}?${params}`;}
export function InvitationApprovals({access}: {access: InvitationAdministrationAccess}) {
  const [route, setRoute] = useState(readInvitationApprovalRoute);
  useEffect(() => {const pop = () => setRoute(readInvitationApprovalRoute()); addEventListener("popstate", pop); return () => removeEventListener("popstate", pop);}, []);
  if (!access.enabled || !access.canReview) return <Card><h2>Invitation approvals unavailable</h2><p role={access.error ? "alert" : undefined}>{access.error || "Administrator invitation-review access is required."}</p>{access.error && <button className="button-ghost" onClick={() => location.reload()}>Retry invitation approval access</button>}</Card>;
  if (route.invalid) return <Card><h2>Invitation request link invalid</h2><p>The exact source and workspace are required.</p><a className="button button-ghost" href={invitationAdministrationPath}>Open invitation approvals</a></Card>;
  return <ApprovalView key={JSON.stringify(route)} route={route} navigate={next => {history.pushState(null, "", listPath(next)); setRoute(next);}} />;
}
function ApprovalView({route, navigate}: {route: Route; navigate: (route: Route) => void}) {
  const [rows, setRows] = useState<InvitationRequest[]>([]), [detail, setDetail] = useState<InvitationRequestDetail | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState(route.q), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const read = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), epoch = useRef(0), retry = useRef<string | null>(null);
  const intent = useRef<{current: InvitationRequestDetail; decision: "approve" | "reject"; reason: string; key: string} | null>(null);
  function clearContext(message: string) {epoch.current++; read.current?.abort(); mutation.current?.abort(); read.current = mutation.current = null; intent.current = null; setRows([]); setDetail(null); setCursor(null); setDecision(null); setUncertain(false); setBusy(false); setLoading(false); retry.current = null; setError(message);}
  async function load(next: string | null = null) {
    if (intent.current || next && read.current) return;
    read.current?.abort(); const controller = new AbortController(), run = ++epoch.current; read.current = controller; retry.current = next; setLoading(true); setError("");
    if (!next) {setRows([]); setDetail(null); setCursor(null); setDecision(null);}
    try {
      if (route.id) {const result = await loadInvitationRequestDetail(route.id, route.sourceId, route.workspaceId, controller.signal); if (!controller.signal.aborted && run === epoch.current) setDetail(result);}
      else {
        const params = new URLSearchParams({status: route.status, limit: "25"}); if (route.q) params.set("q", route.q); if (route.workspaceId) {params.set("workspaceId", route.workspaceId); params.set("sourceId", route.sourceId);} if (next) params.set("cursor", next);
        const result = invitationRequestPage.parse(await api<unknown>(`/api/client-portal/invitation-requests?${params}`, {signal: controller.signal}));
        if (controller.signal.aborted || run !== epoch.current) return;
        if (!result.capabilities.canReview || result.page.hasMore !== Boolean(result.page.nextCursor) || result.page.nextCursor && result.page.nextCursor === next || route.workspaceId && result.items.some(row => row.workspaceId !== route.workspaceId || row.sourceId !== route.sourceId)) throw new ApiError("Invitation request context changed", 409, {});
        setRows(previous => [...new Map((next ? [...previous, ...result.items] : result.items).map(row => [`${row.sourceId}:${row.workspaceId}:${row.id}`, row])).values()]); setCursor(result.page.nextCursor);
      }
    } catch (caught) {if (!controller.signal.aborted && run === epoch.current) {
      if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) clearContext("Invitation requests or your access changed. Refresh before reviewing another decision.");
      else setError("Invitation requests could not be loaded. Retry to check current state.");
    }} finally {if (!controller.signal.aborted && run === epoch.current) {read.current = null; setLoading(false);}}
  }
  useEffect(() => {void load(); return () => {epoch.current++; read.current?.abort(); mutation.current?.abort();};}, []);
  const search = (event: FormEvent) => {event.preventDefault(); navigate({...route, q: draft.trim(), id: null});};
  async function confirm() {
    if (!detail || !decision || mutation.current || !(decision === "approve" ? detail.capabilities.canApprove : detail.capabilities.canReject)) return;
    const operation = intent.current ?? {current: detail, decision, reason: reason.trim(), key: crypto.randomUUID()}; intent.current = operation;
    read.current?.abort(); read.current = null; setLoading(false); const controller = new AbortController(), run = ++epoch.current; mutation.current = controller; setBusy(true); setError("");
    try {
      const result = await decideInvitationRequest(operation.current, operation.decision, operation.reason, operation.key, controller.signal);
      if (controller.signal.aborted || run !== epoch.current) return;
      setDetail({...detail, request: result.request, capabilities: {canApprove: false, canReject: false}}); setDecision(null); intent.current = null; setUncertain(false); setNotice(operation.decision === "reject" ? "Invitation request rejected. No access was granted." : "Invitation published. Email delivery and acceptance are separate; access is not confirmed by this approval.");
    } catch (caught) {if (!controller.signal.aborted && run === epoch.current) {
      if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) clearContext("The decision or its authorization changed. Refresh and review current state; nothing will be retried automatically.");
      else if (caught instanceof ApiError && caught.status === 400) {intent.current = null; setDecision(null); setError(caught.message);}
      else {setUncertain(true); setError("The decision is not confirmed. Retry the same decision before making another change.");}
    }} finally {if (!controller.signal.aborted && run === epoch.current) {mutation.current = null; setBusy(false);}}
  }
  return <section className="invitation-administration" aria-label="Invitation approvals"><header><div><h2>{route.id ? "Review invitation request" : "Invitation approvals"}</h2><p>Review the exact proposed access. Approval requests are not invitations or memberships.</p></div><a className="button button-ghost" href={route.id ? listPath(route) : "/operations/inbox"}>{route.id ? "Back to invitation approvals" : "Back to inbox"}</a></header>
    {!route.id && <form className="invitation-administration-search" onSubmit={search}><label>Search invitation requests<input value={draft} maxLength={100} onChange={event => setDraft(event.target.value)} /></label><label>Request status<select value={route.status} onChange={event => navigate({...route, status: event.target.value})}>{["open", "pending", "approving", "approved", "rejected", "cancelled", "stale", "all"].map(status => <option key={status} value={status}>{status === "open" ? "Needs review" : status === "all" ? "All" : invitationRequestStatus(status as InvitationRequest["status"])}</option>)}</select></label><button className="button-orange">Search</button></form>}
    <button className="button-ghost" disabled={loading || busy || uncertain} onClick={() => void load()}>Refresh invitation requests</button>
    {loading && <p role="status">Loading invitation requests…</p>}{notice && <p role="status">{notice}</p>}
    {error && <div role="alert"><p>{error}</p>{!uncertain && <button className="button-ghost" disabled={loading || busy} onClick={() => void load(retry.current)}>Retry invitation requests</button>}</div>}
    {!route.id && <><div className="invitation-administration-list">{rows.map(row => <Card key={row.id}><a href={invitationRequestHref(row)}><h3>{row.email}</h3></a><RequestFacts row={row} /></Card>)}</div>{!loading && !error && !rows.length && <p>{cursor ? "No matching requests in this page. Load more to continue checking." : "No invitation requests match this view."}</p>}{cursor && <button className="button-ghost" disabled={loading || Boolean(error)} onClick={() => void load(cursor)}>Load more invitation requests</button>}</>}
    {detail && <Card><RequestFacts row={detail.request} />{detail.unavailableReason && <p role="status">Review unavailable: {detail.unavailableReason}</p>}
      {!decision && <div className="invitation-administration-actions">{detail.capabilities.canApprove && <button className="button-orange" onClick={() => {setDecision("approve"); setReason("");}}>Approve request</button>}{detail.capabilities.canReject && <button className="button-ghost" onClick={() => {setDecision("reject"); setReason("");}}>Reject request</button>}</div>}
      {decision && <section className="invitation-administration-confirm" aria-label="Confirm invitation decision"><h3>{decision === "approve" ? "Approve this exact invitation?" : "Reject this invitation request?"}</h3><p>{detail.request.email} · {detail.request.workspaceName} · {detail.request.sourceName}</p><p>{decision === "approve" ? "The server rechecks current policy, requester authority, recipient, scope and duration before publishing an invitation. This does not bypass denies or confirm email delivery or acceptance." : "No invitation or access will be created. The requester can see the decision."}</p>{decision === "reject" && <label>Rejection reason (optional)<textarea rows={3} maxLength={500} value={reason} readOnly={busy || uncertain} onChange={event => setReason(event.target.value)} /></label>}<div className="invitation-administration-actions"><button className="button-orange" disabled={busy} onClick={() => void confirm()}>{busy ? "Saving…" : uncertain ? "Retry same decision" : decision === "approve" ? "Confirm approval" : "Confirm rejection"}</button><button className="button-ghost" disabled={busy || uncertain} onClick={() => setDecision(null)}>Cancel</button></div></section>}
    </Card>}
  </section>;
}
function RequestFacts({row}: {row: InvitationRequest}) {
  return <dl className="invitation-administration-facts"><div><dt>Request state</dt><dd>{invitationRequestStatus(row.status)}</dd></div><div><dt>Recipient</dt><dd>{row.email}</dd></div><div><dt>Workspace and source</dt><dd>{row.workspaceName} · {row.sourceName}</dd></div><div><dt>Requester</dt><dd>{row.requesterEmail ?? "Verified portal identity"}</dd></div><div><dt>Exact scope</dt><dd>{row.scope.type} · {row.scope.publicId}</dd></div><div><dt>Proposed access</dt><dd>{invitationCapabilitiesLabel(row.capabilities)} · {invitationTermsLabel(row.accessTerms)}</dd></div><div><dt>Submitted</dt><dd>{new Date(row.createdAt).toLocaleString()}</dd></div>{row.reasonCode && <div><dt>Decision reason</dt><dd>{row.reasonCode}</dd></div>}{row.invitationId && <div><dt>Invitation</dt><dd>Published. Email delivery and acceptance are not confirmed here.</dd></div>}</dl>;
}
