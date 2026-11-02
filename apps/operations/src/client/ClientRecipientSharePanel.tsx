import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import "./ClientRecipientSharePanel.css";

// One list of Ops clients for sharing a folder. Business divisions only decide who invoices a client, so
// they're resolved by the server and never shown or chosen here; nothing here needs a Project Alpha project.
type RecipientType = "client" | "organization";
type PortalState = "ready" | "no_members" | "not_set_up";
type Recipient = { recipientId: string; recipientVersion: string; type: RecipientType; displayName: string; organizationName: string | null;
  portal: { state: PortalState }; memberCount: number | null; lastActivityAt: string | null };
type Grant = { grantId: string; version: number; recipientId: string; recipientLabel: string; recipientType: RecipientType; audienceLabel: string;
  recipientCount: number | null; status: "active" | "revoked" | "expired"; expiresAt: string | null; updatedAt: string; canRevoke: boolean };
type Input = { folderRef: string; recipientId: string; recipientVersion: string; audience: "all_members"; expiresAt: string | null };
type Preview = { operation: Input; previewVersion: string; recipientLabel: string; audienceLabel: string; recipientCount: number; expiresAt: string | null };
type Operation = { path: string; body: string; key: string; action: "create" | "revoke"; recipientId: string; grantId?: string; version?: number };

const base = "/api/delivery/client-recipients";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const names = Object.keys(value);
  return names.length === keys.length && names.every(name => keys.includes(name)) ? value as Record<string, unknown> : null;
}
const RECIPIENT_KEYS = ["recipientId", "recipientVersion", "type", "displayName", "organizationName", "portal", "memberCount", "lastActivityAt"];
function recipient(value: unknown): Recipient | null {
  const row = exact(value, RECIPIENT_KEYS), portal = row && exact(row.portal, ["state"]);
  if (!row || !portal || !text(row.recipientId) || !text(row.recipientVersion) || (row.type !== "client" && row.type !== "organization")
    || !text(row.displayName) || !(row.organizationName === null || text(row.organizationName))
    || !["ready", "no_members", "not_set_up"].includes(String(portal.state))
    || !(row.memberCount === null || count(row.memberCount)) || !(row.lastActivityAt === null || date(row.lastActivityAt))) return null;
  return row as unknown as Recipient;
}
const GRANT_KEYS = ["grantId", "version", "recipientId", "recipientLabel", "recipientType", "audienceLabel", "recipientCount", "status", "expiresAt", "updatedAt", "canRevoke"];
function grant(value: unknown): Grant | null {
  const row = exact(value, GRANT_KEYS);
  if (!row || !text(row.grantId) || !count(row.version) || row.version < 1 || !text(row.recipientId) || !text(row.recipientLabel)
    || (row.recipientType !== "client" && row.recipientType !== "organization") || !text(row.audienceLabel)
    || !(row.recipientCount === null || count(row.recipientCount)) || !["active", "revoked", "expired"].includes(String(row.status))
    || !(row.expiresAt === null || date(row.expiresAt)) || !date(row.updatedAt) || typeof row.canRevoke !== "boolean") return null;
  return row as unknown as Grant;
}
const invalid = () => new Error("The server response could not be verified. Refresh this folder before continuing.");
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const portalNote = (item: Recipient) => item.portal.state === "ready"
  ? item.memberCount === null ? "Portal ready" : `Portal ready · ${item.memberCount} ${item.memberCount === 1 ? "person" : "people"}`
  : item.portal.state === "no_members" ? "No one in their portal yet" : "Portal not set up yet";
const errorMessage = (caught: unknown) => {
  const message = caught instanceof Error ? caught.message : "";
  if (caught instanceof ApiError && caught.status === 409) return "This client's access changed since you reviewed it. Review it again before sharing.";
  return message || "Client sharing could not be loaded. Try again.";
};

/** Renders nothing until the server confirms the unified recipient list exists for this folder; `onUnavailable` hands back
 * to the older panels, both before the endpoint ships and for project folders, which keep their project grant flow. */
export function ClientRecipientSharePanel({ folder, creationEnabled, onUnavailable, onBusyChange }: {
  folder: { id: string }; creationEnabled: boolean; onUnavailable: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [query, setQuery] = useState(""), [recipients, setRecipients] = useState<Recipient[]>([]), [listMode, setListMode] = useState<"recent" | "search">("recent");
  const [listBusy, setListBusy] = useState(false), [listError, setListError] = useState("");
  const [selected, setSelected] = useState<Recipient | null>(null), [expiry, setExpiry] = useState<"none" | "date">("none"), [expiresOn, setExpiresOn] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [grants, setGrants] = useState<Grant[]>([]), [historyError, setHistoryError] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<Grant | null>(null);
  const pending = useRef<Operation | null>(null), listController = useRef<AbortController | null>(null), reviewTitle = useRef<HTMLHeadingElement | null>(null);
  const locked = busy || uncertain;
  useEffect(() => { onBusyChange?.(locked); return () => onBusyChange?.(false); }, [locked, onBusyChange]);
  useEffect(() => { if (preview) reviewTitle.current?.focus(); }, [preview]);

  const loadGrants = useCallback(async () => {
    setHistoryError("");
    try {
      const response = await api<{ grants: unknown[] }>(`${base}/grants?folderRef=${encodeURIComponent(folder.id)}`);
      const rows = exact(response, ["grants"]) && Array.isArray(response.grants) ? response.grants.map(grant) : null;
      if (!rows || rows.some(row => row === null)) throw invalid();
      setGrants(rows as Grant[]);
    } catch (caught) { setHistoryError(errorMessage(caught)); }
  }, [folder.id]);

  const search = useCallback((value: string) => {
    listController.current?.abort(); const controller = new AbortController(); listController.current = controller;
    setListBusy(true); setListError("");
    api<{ mode: string; projectFolder: boolean; recipients: unknown[] }>(`${base}?folderRef=${encodeURIComponent(folder.id)}&q=${encodeURIComponent(value.trim())}&limit=20`, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const mode = value.trim() ? "search" : "recent";
        const shape = exact(response, ["mode", "projectFolder", "recipients"]);
        if (!shape || typeof response.projectFolder !== "boolean") throw invalid();
        // A project folder keeps the project grant flow and its customer/collaborator terms.
        if (response.projectFolder) { if (available === null) { setAvailable(false); onUnavailable(); return; } throw invalid(); }
        const rows = response.mode === mode && Array.isArray(response.recipients) && response.recipients.length <= 20
          ? response.recipients.map(recipient) : null;
        if (!rows || rows.some(row => row === null) || new Set(rows.map(row => row!.recipientId)).size !== rows.length) throw invalid();
        setAvailable(true); setListMode(mode); setRecipients(rows as Recipient[]);
      })
      .catch(caught => {
        if ((caught as Error).name === "AbortError") return;
        // Before the backend ships the endpoint isn't there: fall back without showing an error.
        if (available === null && caught instanceof ApiError && caught.status === 404) { setAvailable(false); onUnavailable(); return; }
        setAvailable(current => current ?? true); setListError(errorMessage(caught));
      })
      .finally(() => { if (!controller.signal.aborted) setListBusy(false); });
  }, [folder.id, available, onUnavailable]);

  useEffect(() => {
    const timer = window.setTimeout(() => search(query), query.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); listController.current?.abort(); };
    // Re-run only for the folder and what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, folder.id]);
  useEffect(() => { if (available) void loadGrants(); }, [available, loadGrants]);

  const choose = (item: Recipient) => { setSelected(item); setPreview(null); setError(""); setMessage(""); };
  const review = async () => {
    if (!selected || locked) return;
    let expiresAt: string | null = null;
    if (expiry === "date") {
      const end = new Date(`${expiresOn}T23:59:59`);
      if (!expiresOn || !Number.isFinite(end.valueOf()) || end <= new Date()) { setError("Choose a future date, or share until revoked."); return; }
      expiresAt = end.toISOString();
    }
    const operation: Input = { folderRef: folder.id, recipientId: selected.recipientId, recipientVersion: selected.recipientVersion, audience: "all_members", expiresAt };
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await api<Record<string, unknown>>(`${base}/grants/preview`, { method: "POST", body: JSON.stringify(operation) });
      const row = exact(response, ["previewVersion", "recipientId", "recipientLabel", "audienceLabel", "recipientCount", "expiresAt"]);
      if (!row || !text(row.previewVersion) || row.recipientId !== operation.recipientId || !text(row.recipientLabel) || !text(row.audienceLabel)
        || !count(row.recipientCount) || row.expiresAt !== operation.expiresAt) throw invalid();
      setPreview({ operation, previewVersion: row.previewVersion, recipientLabel: row.recipientLabel, audienceLabel: row.audienceLabel,
        recipientCount: row.recipientCount, expiresAt: operation.expiresAt });
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  };

  const run = async (operation = pending.current) => {
    if (!operation || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await api<Record<string, unknown>>(operation.path, { method: "POST", headers: { "Idempotency-Key": operation.key }, body: operation.body });
      const row = exact(response, ["grant", "replayed"]), result = row && grant(row.grant);
      // A 2xx may already be committed, so a mismatched echo is an unknown outcome kept for the same retry.
      if (!row || !result || typeof row.replayed !== "boolean" || result.recipientId !== operation.recipientId
        || (operation.action === "create" ? result.status !== "active"
          : result.grantId !== operation.grantId || result.status !== "revoked" || result.version !== operation.version! + 1))
        throw Object.assign(new Error("The outcome could not be verified."), { unverified: true });
      pending.current = null; setUncertain(false); setPreview(null); setConfirmRevoke(null);
      if (operation.action === "create") { setSelected(null); setMessage(`Shared with ${result.recipientLabel}.`); }
      else setMessage(`Access for ${result.recipientLabel} was revoked.`);
      void loadGrants();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status < 500 && caught.status !== 429) {
        pending.current = null; setUncertain(false); setError(errorMessage(caught));
        if (caught.status === 409) setPreview(null);
      } else { setUncertain(true); setError("The outcome isn't confirmed yet. Retry the same action to confirm it; don't choose another client."); }
    } finally { setBusy(false); }
  };
  const share = () => {
    if (!preview || locked) return;
    pending.current = { path: `${base}/grants`, key: crypto.randomUUID(), action: "create", recipientId: preview.operation.recipientId,
      body: JSON.stringify({ ...preview.operation, previewVersion: preview.previewVersion }) };
    void run();
  };
  const revoke = (item: Grant) => {
    if (locked) return;
    pending.current = { path: `${base}/grants/${encodeURIComponent(item.grantId)}/revoke`, key: crypto.randomUUID(), action: "revoke",
      recipientId: item.recipientId, grantId: item.grantId, version: item.version, body: JSON.stringify({ expectedVersion: item.version }) };
    void run();
  };

  if (!available) return null;
  return <section className="client-recipient-share" aria-label="Share with a client">
    {creationEnabled && <>
      <label htmlFor="client-recipient-search">Search clients</label>
      <input id="client-recipient-search" type="search" value={query} placeholder="Type a client name" autoComplete="off" disabled={locked}
        onChange={event => { setQuery(event.target.value); setSelected(null); setPreview(null); setError(""); setMessage(""); }} />
      {listBusy && <small role="status">Loading clients…</small>}
      {listError && <small className="error" role="alert">{listError}</small>}
      {!listBusy && !listError && <small className="client-recipient-list-label">{listMode === "search" ? "Matching clients" : "Recent clients"}</small>}
      {!listBusy && !listError && recipients.length === 0 && <small role="status">{listMode === "search" ? "No client matches that name." : "No clients yet."}</small>}
      {recipients.length > 0 && <div className="client-workspace-typeahead" role="listbox" aria-label="Clients">{recipients.map(item => <button
        type="button" role="option" key={item.recipientId} aria-selected={selected?.recipientId === item.recipientId} disabled={locked}
        onClick={() => choose(item)}><strong>{item.displayName}</strong><small>{[item.type === "organization" ? "Whole organization" : item.organizationName, portalNote(item)]
          .filter(Boolean).join(" · ")}</small></button>)}</div>}
      {selected && !preview && <div className="client-recipient-terms">
        <fieldset disabled={locked}><legend>How long</legend>
          <label><input type="radio" name="client-recipient-expiry" checked={expiry === "none"} onChange={() => setExpiry("none")} /> Until revoked</label>
          <label><input type="radio" name="client-recipient-expiry" checked={expiry === "date"} onChange={() => setExpiry("date")} /> Until a date</label>
          {expiry === "date" && <label>Access ends on<input type="date" value={expiresOn} onChange={event => setExpiresOn(event.target.value)} /></label>}
        </fieldset>
        <button type="button" className="button-orange button-small" disabled={locked || selected.portal.state !== "ready"} onClick={() => void review()}>Review sharing</button>
        {selected.portal.state !== "ready" && <small>{selected.displayName} can't receive files until someone is in their portal.</small>}
      </div>}
      {preview && <section className="primary-authenticated-grant-review" role="region" aria-label="Review sharing with a client">
        <h4 ref={reviewTitle} tabIndex={-1}>Confirm sharing</h4>
        <dl><div><dt>Client</dt><dd>{preview.recipientLabel}</dd></div><div><dt>Who can see it</dt><dd>{preview.audienceLabel} ({preview.recipientCount} {preview.recipientCount === 1 ? "person" : "people"} now)</dd></div>
          <div><dt>Access</dt><dd>This folder and everything in it</dd></div><div><dt>Ends</dt><dd>{preview.expiresAt ? when(preview.expiresAt) : "When revoked"}</dd></div></dl>
        <p>People added to or removed from this client's portal later gain or lose access automatically. This doesn't create a public link.</p>
        <div className="actions"><button type="button" className="button-orange" disabled={locked} onClick={share}>{busy ? "Sharing…" : "Share folder"}</button>
          <button type="button" className="button-ghost" disabled={locked} onClick={() => setPreview(null)}>Back</button></div>
      </section>}
    </>}
    {message && <small role="status">{message}</small>}{error && <small className="error" role="alert">{error}</small>}
    {uncertain && pending.current && <button type="button" className="button-orange button-small" disabled={busy} onClick={() => void run()}>Retry the same action</button>}
    <section aria-label="Client access to this folder"><h4>Who has access</h4>
      {historyError ? <small className="error" role="alert">{historyError}</small>
        : grants.length === 0 ? <small>No client has access to this folder yet.</small>
          : <ul className="client-recipient-grants">{grants.map(item => <li key={item.grantId}>
            <strong>{item.recipientLabel}</strong> <small>{item.audienceLabel}{item.recipientCount === null ? "" : ` · ${item.recipientCount} ${item.recipientCount === 1 ? "person" : "people"}`}
              {" · "}{item.status === "active" ? item.expiresAt ? `until ${when(item.expiresAt)}` : "until revoked" : item.status === "revoked" ? "revoked" : "expired"}</small>
            {item.status === "active" && item.canRevoke && (confirmRevoke?.grantId === item.grantId
              ? <span className="actions"><button type="button" className="button-danger button-small" disabled={locked} onClick={() => revoke(item)}>Revoke access</button>
                <button type="button" className="button-ghost button-small" disabled={locked} onClick={() => setConfirmRevoke(null)}>Keep access</button></span>
              : <button type="button" className="button-ghost button-small" disabled={locked} onClick={() => setConfirmRevoke(item)}>Revoke…</button>)}
          </li>)}</ul>}
    </section>
  </section>;
}
