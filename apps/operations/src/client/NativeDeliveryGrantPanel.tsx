import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Loading } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./NativeDeliveryGrantPanel.css";

type Target = { sourceId: string; sourceName: string; workspaceId: string; workspaceName: string; projectId: string; projectName: string };
type Recipient = { principalPublicId: string; displayName: string; email: string | null };
type Grant = Target & { id: string; grantId: string; version: number; principalPublicId: string; recipientName: string; recipientEmail: string | null; status: "active" | "revoked" | "expired"; publicationState: "pending" | "active" | "suspended" | "revoked"; expiresAt: string | null; createdAt: string; canRevoke: boolean };
type Input = { folderRef: string; sourceId: string; workspaceId: string; projectId: string; principalPublicId: string; reasonCode: string; expiresAt: string | null };
type Preview = { operation: Input; contextVersion: string; sourceName: string; workspaceName: string; projectName: string; recipientName: string; recipientEmail: string | null; folderName: string; expiresAt: string | null };
type Operation = { path: string; body: string; key: string; action: "create" | "revoke"; target: Target; principalPublicId: string; grantId?: string; version?: number; cancelUnpublished?: boolean };
const base = "/api/delivery/native-grants";
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const optionalString = (value: unknown) => value === null || typeof value === "string";
const validTarget = (value: Target) => !!value && [value.sourceId, value.sourceName, value.workspaceId, value.workspaceName, value.projectId, value.projectName].every(string);
const validRecipient = (value: Recipient) => !!value && string(value.principalPublicId) && string(value.displayName) && optionalString(value.email);
const validGrant = (value: Grant) => validTarget(value) && string(value.id) && string(value.grantId) && Number.isSafeInteger(value.version) && value.version > 0 && string(value.principalPublicId) && string(value.recipientName) && optionalString(value.recipientEmail) && ["active", "revoked", "expired"].includes(value.status) && ["pending", "active", "suspended", "revoked"].includes(value.publicationState) && optionalString(value.expiresAt) && typeof value.createdAt === "string" && typeof value.canRevoke === "boolean";
const targetKey = (value: Target) => JSON.stringify([value.sourceId, value.workspaceId, value.projectId]);
const invalidResponse = () => new Error("The server response could not be verified. Refresh this folder before continuing.");
const validReason = (value: string) => value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_. -]+$/.test(value);
const errorMessage = (caught: unknown) => {
  const message = caught instanceof Error ? caught.message : "";
  if (message === "native_delivery_unavailable") return "Connected workspace access is unavailable. Its database update or portal registration may not be ready.";
  if (message === "native_delivery_expiry_invalid") return "Choose a future expiry within the next 366 days, or leave expiry empty.";
  if (message === "native_delivery_invalid") return "Check the selected project, recipient, reason, and expiry, then review access again.";
  return message || "Connected workspace access could not be loaded. Try again.";
};

export function NativeDeliveryGrantPanel({ folder, onBusyChange }: { folder: { id: string }; onBusyChange?: (busy: boolean) => void }) {
  const [grants, setGrants] = useState<Grant[]>([]), [historyReady, setHistoryReady] = useState(false), [historyBusy, setHistoryBusy] = useState(true), [historyError, setHistoryError] = useState("");
  const [targetQuery, setTargetQuery] = useState(""), [targets, setTargets] = useState<Target[]>([]), [target, setTarget] = useState<Target | null>(null), [targetBusy, setTargetBusy] = useState(false), [targetMessage, setTargetMessage] = useState("");
  const [recipientQuery, setRecipientQuery] = useState(""), [recipients, setRecipients] = useState<Recipient[]>([]), [recipient, setRecipient] = useState<Recipient | null>(null), [recipientBusy, setRecipientBusy] = useState(false), [recipientMessage, setRecipientMessage] = useState("");
  const [reasonCode, setReasonCode] = useState("client_delivery_access"), [expiresAt, setExpiresAt] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [blocked, setBlocked] = useState(false), [uncertain, setUncertain] = useState(false);
  const alive = useRef(false), epoch = useRef(0), operation = useRef<Operation | null>(null), mutationBusy = useRef(false);
  const historyRead = useRef<AbortController | null>(null), targetRead = useRef<AbortController | null>(null), recipientRead = useRef<AbortController | null>(null), previewRead = useRef<AbortController | null>(null), mutationRead = useRef<AbortController | null>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const abortReads = useCallback(() => { historyRead.current?.abort(); targetRead.current?.abort(); recipientRead.current?.abort(); previewRead.current?.abort(); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; abortReads(); mutationRead.current?.abort(); }; }, [folder.id, abortReads]);
  useEffect(() => { if (preview) reviewTitle.current?.focus(); }, [preview]);
  useEffect(() => { onBusyChange?.(busy || uncertain); return () => onBusyChange?.(false); }, [busy, uncertain, onBusyChange]);
  const invalidate = useCallback((caught: unknown): boolean => {
    if (!(caught instanceof ApiError) || ![401, 403, 404, 409].includes(caught.status)) return false;
    epoch.current++; abortReads(); setGrants([]); setHistoryReady(false); setHistoryBusy(false); setTargets([]); setTarget(null); setTargetBusy(false); setRecipients([]); setRecipient(null); setRecipientBusy(false); setPreview(null); operation.current = null; mutationBusy.current = false; setBusy(false); setUncertain(false); setMessage(""); setBlocked(true);
    setError(caught.status === 401 ? "Your session expired. Sign in again, then refresh folder access."
      : caught.message === "native_delivery_reconciliation_required" ? "This grant needs administrator review because publication could not be confirmed. Do not create another grant. Refresh folder access after the issue is resolved."
      : caught.message === "native_delivery_list_too_large" ? "This folder has too many connected grants to display safely. Ask an administrator to review its access records."
      : "Folder access or the selected workspace changed. Refresh folder access and review the selection again."); return true;
  }, [abortReads]);
  const loadHistory = useCallback(async () => {
    historyRead.current?.abort(); const controller = new AbortController(); historyRead.current = controller;
    setHistoryBusy(true); setHistoryReady(false); setHistoryError("");
    try {
      const result = await api<{grants: Grant[]}>(`${base}?folderRef=${encodeURIComponent(folder.id)}`, {signal: controller.signal});
      if (controller.signal.aborted || !alive.current) return;
      if (!Array.isArray(result.grants) || result.grants.some(item => !validGrant(item))) throw invalidResponse();
      setGrants(result.grants); setHistoryReady(true);
    } catch (caught) { if (!controller.signal.aborted && alive.current && !invalidate(caught)) { setGrants([]); setHistoryError(errorMessage(caught)); } }
    finally { if (!controller.signal.aborted && alive.current) setHistoryBusy(false); }
  }, [folder.id, invalidate]);
  useEffect(() => { void loadHistory(); return () => historyRead.current?.abort(); }, [loadHistory]);
  const clearReview = () => { epoch.current++; previewRead.current?.abort(); setPreview(null); setError(""); setMessage(""); };
  const clearRecipient = () => { recipientRead.current?.abort(); setRecipients([]); setRecipient(null); setRecipientQuery(""); setRecipientMessage(""); setRecipientBusy(false); clearReview(); };
  const selectTarget = (next: Target) => { targetRead.current?.abort(); setTargetBusy(false); setTarget(next); clearRecipient(); };
  const searchTargets = async (event: FormEvent) => {
    event.preventDefault(); const q = targetQuery.trim(); if (q.length < 2 || q.length > 100 || busy || uncertain || blocked) return;
    targetRead.current?.abort(); clearRecipient(); setTarget(null); setTargets([]); setTargetMessage(""); setTargetBusy(true);
    const controller = new AbortController(), version = epoch.current; targetRead.current = controller;
    try {
      const result = await api<{targets: Target[]; truncated: boolean}>(`${base}/targets?${new URLSearchParams({folderRef: folder.id, q})}`, {signal: controller.signal});
      if (controller.signal.aborted || !alive.current || version !== epoch.current) return;
      if (!Array.isArray(result.targets) || result.targets.some(item => !validTarget(item)) || typeof result.truncated !== "boolean") throw invalidResponse();
      setTargets(result.targets); setTargetMessage(result.truncated ? "More projects match. Refine the search to find the exact connected workspace." : result.targets.length ? "Select the exact source, workspace, and project." : "No authorized connected workspace projects match this search.");
    } catch (caught) { if (!controller.signal.aborted && alive.current && version === epoch.current && !invalidate(caught)) setTargetMessage(errorMessage(caught)); }
    finally { if (!controller.signal.aborted && alive.current && version === epoch.current) setTargetBusy(false); }
  };
  const searchRecipients = async (event: FormEvent) => {
    event.preventDefault(); const q = recipientQuery.trim(); if (!target || q.length < 2 || q.length > 100 || busy || uncertain || blocked) return;
    recipientRead.current?.abort(); clearReview(); setRecipients([]); setRecipient(null); setRecipientMessage(""); setRecipientBusy(true);
    const controller = new AbortController(), version = epoch.current; recipientRead.current = controller;
    try {
      const result = await api<{recipients: Recipient[]; truncated: boolean}>(`${base}/recipients?${new URLSearchParams({folderRef: folder.id, sourceId: target.sourceId, workspaceId: target.workspaceId, projectId: target.projectId, q})}`, {signal: controller.signal});
      if (controller.signal.aborted || !alive.current || version !== epoch.current) return;
      if (!Array.isArray(result.recipients) || result.recipients.some(item => !validRecipient(item)) || typeof result.truncated !== "boolean") throw invalidResponse();
      setRecipients(result.recipients); setRecipientMessage(result.truncated ? "More people match. Refine the search to choose one exact recipient." : result.recipients.length ? "Choose one verified person. Matching a name or email does not grant access." : "No eligible verified recipients match this project.");
    } catch (caught) { if (!controller.signal.aborted && alive.current && version === epoch.current && !invalidate(caught)) setRecipientMessage(errorMessage(caught)); }
    finally { if (!controller.signal.aborted && alive.current && version === epoch.current) setRecipientBusy(false); }
  };
  const review = async () => {
    if (!target || !recipient || busy || uncertain || blocked || mutationBusy.current) return;
    const expiry = expiresAt ? new Date(expiresAt) : null;
    const reason = reasonCode.trim();
    if (!validReason(reason) || expiry && !Number.isFinite(expiry.valueOf())) { setError("Enter a reason using letters, numbers, spaces, dots, underscores, or hyphens, and a valid expiry date."); return; }
    const input: Input = {folderRef: folder.id, sourceId: target.sourceId, workspaceId: target.workspaceId, projectId: target.projectId, principalPublicId: recipient.principalPublicId, reasonCode: reason, expiresAt: expiry?.toISOString() ?? null};
    previewRead.current?.abort(); const controller = new AbortController(), version = ++epoch.current; previewRead.current = controller; setBusy(true); setError(""); setPreview(null);
    try {
      const result = await api<{preview: Preview}>(`${base}/preview`, {method: "POST", body: JSON.stringify(input), signal: controller.signal});
      if (controller.signal.aborted || !alive.current || version !== epoch.current) return;
      const value = result.preview;
      if (!value?.operation || Object.entries(input).some(([key, field]) => value.operation[key as keyof Input] !== field) || value.expiresAt !== input.expiresAt || typeof value.contextVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.contextVersion) || ![value.sourceName, value.workspaceName, value.projectName, value.recipientName, value.folderName].every(string) || !optionalString(value.recipientEmail)) throw invalidResponse();
      setPreview(value);
    } catch (caught) { if (!controller.signal.aborted && alive.current && version === epoch.current && !invalidate(caught)) setError(errorMessage(caught)); }
    finally { if (!controller.signal.aborted && alive.current) setBusy(false); }
  };
  const execute = async (pending: Operation) => {
    if (mutationBusy.current || blocked || !alive.current) return;
    mutationBusy.current = true; operation.current = pending; abortReads(); const controller = new AbortController(), version = ++epoch.current; mutationRead.current = controller;
    setBusy(true); setError(""); setMessage(""); setUncertain(false);
    try {
      const result = await api<{grant: Grant; replayed: boolean}>(pending.path, {method: "POST", body: pending.body, headers: {"Idempotency-Key": pending.key}, signal: controller.signal});
      if (controller.signal.aborted || !alive.current || version !== epoch.current) return;
      if (!validGrant(result.grant) || typeof result.replayed !== "boolean" || targetKey(result.grant) !== targetKey(pending.target) || result.grant.principalPublicId !== pending.principalPublicId || result.grant.status !== (pending.action === "create" ? "active" : "revoked") || result.grant.publicationState !== (pending.action === "create" ? "active" : "revoked") || result.grant.version !== (pending.action === "create" ? 1 : pending.version) || pending.grantId && result.grant.grantId !== pending.grantId) throw invalidResponse();
      operation.current = null; setPreview(null); setRecipient(null); setRecipients([]); setRecipientQuery(""); setMessage(pending.action === "create" ? "Connected workspace access granted to the selected person. No email or public link was created." : pending.cancelUnpublished ? "Unpublished access cancelled. It was not made available, and files were not changed." : "Connected workspace access revoked. Files were not changed.");
      await loadHistory();
    } catch (caught) {
      if (controller.signal.aborted || !alive.current || version !== epoch.current) return;
      if (invalidate(caught)) return;
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && caught.status !== 429) { operation.current = null; setPreview(null); setError(errorMessage(caught)); }
      else { setUncertain(true); setError("The result is not confirmed. Retry the same operation to check it safely; do not create another grant."); }
    } finally { mutationBusy.current = false; if (!controller.signal.aborted && alive.current) setBusy(false); }
  };
  const create = () => {
    if (!preview || !target || !recipient) return;
    const input = preview.operation;
    void execute({path: base, body: JSON.stringify({...input, expectedContextVersion: preview.contextVersion}), key: crypto.randomUUID(), action: "create", target, principalPublicId: recipient.principalPublicId});
  };
  const revoke = (grant: Grant) => {
    if (!grant.canRevoke || busy || mutationBusy.current || uncertain && (operation.current?.action !== "create" || grant.publicationState !== "pending")) return;
    const reason = reasonCode.trim();
    if (!validReason(reason)) { setError("Enter a reason using letters, numbers, spaces, dots, underscores, or hyphens."); return; }
    const cancelUnpublished = grant.publicationState === "pending";
    if (!confirm(cancelUnpublished ? `Cancel unpublished access for ${grant.recipientName} in ${grant.sourceName} / ${grant.workspaceName} / ${grant.projectName}? This stops this pending grant; it does not publish access or change files. Any unconfirmed create operation in this panel will no longer be retried.` : `Revoke ${grant.recipientName}'s access to this folder in ${grant.sourceName} / ${grant.workspaceName} / ${grant.projectName}? Files and other grants will not change.`)) return;
    void execute({path: `${base}/${encodeURIComponent(grant.grantId)}/revoke`, body: JSON.stringify({folderRef: folder.id, expectedVersion: grant.version, reasonCode: reason}), key: crypto.randomUUID(), action: "revoke", target: grant, principalPublicId: grant.principalPublicId, grantId: grant.grantId, version: grant.version, cancelUnpublished});
  };
  const refresh = () => { if (busy || historyBusy) return; if (uncertain) { void loadHistory(); return; } epoch.current++; abortReads(); setBlocked(false); setError(""); setPreview(null); setTarget(null); setTargets([]); clearRecipient(); void loadHistory(); };
  const disabled = busy || uncertain || blocked || !historyReady;

  return <section className="native-grant-panel" aria-label="Connected workspace folder access">
    <h3>Connected workspace access</h3><p>Share this folder with one verified person in an explicitly selected source, workspace, and project. This does not create a public link or send a notification.</p>
    {historyBusy && !blocked && <Loading />}
    {historyError && <p role="alert">{historyError}</p>}
    <button className="button-ghost button-small" disabled={busy || historyBusy} onClick={refresh}>Refresh folder access</button>
    {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {uncertain && operation.current && <><p>Refreshing only checks current grant records. It does not confirm the earlier operation or create access. You can cancel an unpublished grant after reviewing its exact recipient.</p><button className="button-orange" disabled={busy || historyBusy} onClick={() => void execute(operation.current!)}>Retry same operation</button></>}
    {!blocked && historyReady && <>
      <form className="form-grid" role="search" aria-label="Find connected workspace project" onSubmit={searchTargets}><label>Find a connected project<input type="search" value={targetQuery} minLength={2} maxLength={100} disabled={disabled} onChange={event => { targetRead.current?.abort(); setTargetBusy(false); setTargetQuery(event.target.value); setTargets([]); setTarget(null); setTargetMessage(""); clearRecipient(); }} /></label><button className="button-ghost" disabled={disabled || targetBusy || targetQuery.trim().length < 2}>Search connected projects</button></form>
      {targetBusy && <Loading />}{targetMessage && <p role="status">{targetMessage}</p>}
      {targets.length > 0 && <fieldset disabled={disabled}><legend>Source, workspace, and project</legend>{targets.map(item => <label className="native-grant-choice" key={targetKey(item)}><input type="radio" name="native-grant-project" checked={target !== null && targetKey(target) === targetKey(item)} onChange={() => selectTarget(item)} /><span><strong>{item.projectName}</strong><small>{item.sourceName} · {item.workspaceName}</small></span></label>)}</fieldset>}
      {target && <>
        <p className="native-grant-selection">Selected: {target.sourceName} / {target.workspaceName} / {target.projectName}</p>
        <form className="form-grid" role="search" aria-label="Find verified recipient" onSubmit={searchRecipients}><label>Find a verified recipient<input type="search" value={recipientQuery} minLength={2} maxLength={100} disabled={disabled} onChange={event => { recipientRead.current?.abort(); setRecipientBusy(false); setRecipientQuery(event.target.value); setRecipients([]); setRecipient(null); setRecipientMessage(""); clearReview(); }} /></label><button className="button-ghost" disabled={disabled || recipientBusy || recipientQuery.trim().length < 2}>Search verified recipients</button></form>
        {recipientBusy && <Loading />}{recipientMessage && <p role="status">{recipientMessage}</p>}
        {recipients.length > 0 && <fieldset disabled={disabled}><legend>Exact recipient</legend>{recipients.map(item => <label className="native-grant-choice" key={item.principalPublicId}><input type="radio" name="native-grant-person" checked={recipient?.principalPublicId === item.principalPublicId} onChange={() => { clearReview(); setRecipient(item); }} /><span><strong>{item.displayName}</strong><small>{item.email || "No email displayed"}</small></span></label>)}</fieldset>}
      </>}
      <div className="form-grid authenticated-grant-fields"><label>Connected access reason<input value={reasonCode} maxLength={80} disabled={disabled} onChange={event => { setReasonCode(event.target.value); clearReview(); }} /></label><label>Connected access expires (optional)<input type="datetime-local" value={expiresAt} disabled={disabled} onChange={event => { setExpiresAt(event.target.value); clearReview(); }} /></label></div>
      {!preview && <button className="button-orange" disabled={disabled || !recipient || !target} onClick={() => void review()}>Review connected workspace access</button>}
      {preview && <section className="native-grant-review" aria-label="Review connected workspace access"><h4 ref={reviewTitle} tabIndex={-1}>Confirm exact folder access</h4><dl>{[["Folder", preview.folderName], ["Source", preview.sourceName], ["Workspace", preview.workspaceName], ["Project", preview.projectName], ["Recipient", `${preview.recipientName}${preview.recipientEmail ? ` (${preview.recipientEmail})` : ""}`], ["Expiry", preview.expiresAt ? new Date(preview.expiresAt).toLocaleString() : "No expiry"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>Only this verified person receives this folder grant. It does not merge accounts, grant project administration, or send an email.</p><div className="actions"><button className="button-orange" disabled={disabled} onClick={create}>Grant connected workspace access</button><button className="button-ghost" disabled={disabled} onClick={() => setPreview(null)}>Cancel review</button></div></section>}
    </>}
    {historyReady && <section aria-label="Connected workspace grant history"><h4>Current connected workspace grants</h4>{grants.length === 0 ? <p>No connected workspace grants are recorded for this folder.</p> : <div className="authenticated-grant-list">{grants.map(grant => <section className="authenticated-grant-row" key={grant.id}><span><strong>{grant.recipientName}</strong><small>{grant.sourceName} · {grant.workspaceName} · {grant.projectName}</small><small>{grant.publicationState === "pending" ? "Not published — access is not available" : grant.publicationState === "suspended" ? "Revoked — publication was not confirmed" : grant.status} · {grant.expiresAt ? `expires ${new Date(grant.expiresAt).toLocaleString()}` : "no expiry"}</small></span>{grant.canRevoke && <button className="button-danger button-small" disabled={busy || blocked || uncertain && (operation.current?.action !== "create" || grant.publicationState !== "pending")} onClick={() => revoke(grant)}>{grant.publicationState === "pending" ? "Cancel unpublished access" : "Revoke connected access"}<span className="sr-only">: {grant.recipientName}</span></button>}</section>)}</div>}</section>}
  </section>;
}
