import { useEffect, useRef, useState } from "react";
import type { RequestError } from "./bulk-download";
import { cancelInvitationRequest, invitationCapabilitiesLabel, invitationRequestStatus, invitationTermsLabel, loadInvitationRequests, type PortalInvitationRequest } from "./invitation-request-api";
import "./PortalInvitationRequests.css";

export function PortalInvitationRequests({workspaceId, sourceId, supported, locked, onLock, onInvalidated}: {
  workspaceId: string; sourceId: string; supported: boolean; locked: boolean; onLock: (value: boolean) => void; onInvalidated: (message: string) => void;
}) {
  const [rows, setRows] = useState<PortalInvitationRequest[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [cancel, setCancel] = useState<PortalInvitationRequest | null>(null), [uncertain, setUncertain] = useState(false);
  const read = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), generation = useRef(0), retry = useRef<string | null>(null);
  const intent = useRef<{row: PortalInvitationRequest; key: string} | null>(null), callbacks = useRef({onLock, onInvalidated}); callbacks.current = {onLock, onInvalidated};
  const invalid = (caught: unknown) => [401, 403, 404, 409, 410].includes((caught as RequestError).status ?? 0);
  async function load(next: string | null = null) {
    if (!supported || mutation.current || intent.current || cancel || next && read.current) return;
    read.current?.abort(); const controller = new AbortController(), run = ++generation.current; read.current = controller; retry.current = next;
    setLoading(true); setError(""); if (!next) {setRows([]); setCursor(null);}
    try {
      const page = await loadInvitationRequests(workspaceId, next, controller.signal, sourceId);
      if (controller.signal.aborted || run !== generation.current) return;
      setRows(previous => [...new Map((next ? [...previous, ...page.items] : page.items).map(row => [row.id, row])).values()]); setCursor(page.nextCursor);
    } catch (caught) { if (!controller.signal.aborted && run === generation.current) {
      if (invalid(caught)) {setRows([]); setCursor(null); callbacks.current.onInvalidated("Invitation requests or your access changed. Refresh team access.");}
      else setError("Invitation requests could not be loaded. Retry to check their current state.");
    }} finally {if (!controller.signal.aborted && run === generation.current) {read.current = null; setLoading(false);}}
  }
  useEffect(() => {void load(); return () => {generation.current++; read.current?.abort(); mutation.current?.abort(); callbacks.current.onLock(false);};}, [workspaceId, supported]);
  async function confirmCancel() {
    if (!cancel || locked || mutation.current || !cancel.canCancel) return;
    const operation = intent.current ?? {row: cancel, key: crypto.randomUUID()}; intent.current = operation;
    read.current?.abort(); read.current = null; setLoading(false); const run = ++generation.current, controller = new AbortController(); mutation.current = controller;
    setBusy(true); setError(""); callbacks.current.onLock(true);
    try {
      const result = await cancelInvitationRequest(workspaceId, operation.row.id, operation.row.version, operation.key, controller.signal);
      if (controller.signal.aborted || run !== generation.current) return;
      if (result.request.sourceId !== sourceId || result.request.email !== operation.row.email || result.request.scope.type !== operation.row.scope.type || result.request.scope.publicId !== operation.row.scope.publicId) throw Object.assign(new Error("Cancellation context changed."), {status: 409});
      setRows(previous => previous.map(row => row.id === result.request.id ? result.request : row)); setCancel(null); setUncertain(false); intent.current = null;
      setNotice("Invitation request cancelled. This does not revoke any independent access."); callbacks.current.onLock(false);
    } catch (caught) {if (!controller.signal.aborted && run === generation.current) {
      if (invalid(caught)) {intent.current = null; callbacks.current.onLock(false); callbacks.current.onInvalidated("This request or your access changed. Refresh team access before another action.");}
      else if ((caught as RequestError).status === 400) {intent.current = null; setCancel(null); setUncertain(false); callbacks.current.onLock(false); setError("Cancellation was not accepted. Refresh these requests before trying again.");}
      else {setUncertain(true); setError("Cancellation is not confirmed. Retry the same cancellation before making another change.");}
    }} finally {if (!controller.signal.aborted && run === generation.current) {mutation.current = null; setBusy(false);}}
  }
  return <section className="portal-invitation-requests" aria-label="Your invitation requests"><header><h3>Your invitation requests</h3>{supported && <button className="button-ghost" disabled={loading || busy || uncertain || locked} onClick={() => void load()}>Refresh invitation requests</button>}</header>
    <p>Requests are separate from invitations and access. Only your requests in this workspace are shown.</p>
    {!supported ? <p role="status">Invitation request history is unavailable until its database update is ready.</p> : <>
      {loading && <p role="status">Loading invitation requests…</p>}{notice && <p role="status">{notice}</p>}
      {error && <div role="alert"><p>{error}</p>{!uncertain && <button className="button-ghost" disabled={loading || locked} onClick={() => void load(retry.current)}>Retry invitation requests</button>}</div>}
      <div className="portal-invitation-request-list">{rows.map(row => <article key={row.id}><h4>{row.email}</h4><strong>{invitationRequestStatus(row.status)}</strong>
        <p>{row.workspaceName} · {row.sourceName} · {row.scope.type} <span>{row.scope.publicId}</span></p><p>{invitationTermsLabel(row.accessTerms)}</p>
        <p>{invitationCapabilitiesLabel(row.capabilities)}</p>
        {row.status === "approved" && <p>{row.invitationId ? "Invitation issued. Email delivery and acceptance are separate; this does not confirm access." : "Approval recorded; invitation issuance is not confirmed."}</p>}
        {(row.status === "pending" || row.status === "approving") && <p>No invitation or usable access has been published by this request.</p>}
        {row.reasonCode && <p>Decision: {row.reasonCode}</p>}<small>Updated {new Date(row.updatedAt).toLocaleString()}</small>
        {row.canCancel && <button className="button-ghost" disabled={locked || busy || uncertain || Boolean(cancel)} onClick={() => {setCancel(row); setError(""); callbacks.current.onLock(true);}}>Cancel request</button>}
      </article>)}</div>
      {!loading && !error && !rows.length && <p>{cursor ? "No requests in this page. Load more to continue checking." : "No invitation requests yet."}</p>}
      {cursor && <button className="button-ghost" disabled={loading || busy || uncertain || locked || Boolean(error)} onClick={() => void load(cursor)}>Load more invitation requests</button>}
      {cancel && <section className="portal-info-notice" aria-label="Cancel invitation request"><h4>Cancel request for {cancel.email}?</h4><p>This stops this pending request, not any independent access or already accepted invitation.</p><div className="actions"><button className="button-primary" disabled={busy || locked} onClick={() => void confirmCancel()}>{busy ? "Cancelling…" : uncertain ? "Retry cancellation" : "Confirm cancellation"}</button><button className="button-ghost" disabled={busy || uncertain} onClick={() => {setCancel(null); callbacks.current.onLock(false);}}>Keep request</button></div></section>}
    </>}
  </section>;
}
