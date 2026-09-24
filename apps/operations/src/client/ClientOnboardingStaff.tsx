import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading } from "@ltds/ui";
import "./ClientOnboardingStaff.css";

type StaffSession = { csrfToken: string; verifiedUntil: string };
type Scope = { businessAreaId: string; divisionId: string };
type Created = { invitationId: string; expiresAt: string; requestSha256: string; state: string };
type Revealed = { commandId: string; invitationId: string; expiresAt: string; invitationSecret: string };
type Review = { invitationId: string; submissionId: string; fieldsSha256: string; submittedAt: string;
  targetClientRecordId: string | null; scopes: Array<{ businessAreaId: string; divisionId: string | null }>;
  fields: { clientType: "consumer" | "business"; name: string; email: string; phone: string;
    organizationName: string; organizationEmail: string; organizationPhone: string; addressLine1: string;
    addressLine2: string; city: string; state: string; postalCode: string; country: string } };
type TargetMode = "proposed-scopes" | "existing-client";

const endpoint = "/api/client-onboarding/staff";
const MAX_UI_SCOPES = 16;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const uuid = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const localDateTime = (date: Date) => {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};
const defaultExpiry = () => {
  const date = new Date(Date.now() + (7 * 24 - 1) * 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return localDateTime(date);
};

async function json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(record(payload) && typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`), { status: response.status });
  if (!record(payload)) throw new Error("invalid_response");
  return payload;
}

function validSession(value: Record<string, unknown>): value is StaffSession & Record<string, unknown> {
  return typeof value.csrfToken === "string" && /^[0-9a-f]{64}$/.test(value.csrfToken)
    && typeof value.verifiedUntil === "string" && Number.isFinite(Date.parse(value.verifiedUntil));
}
function validCreated(value: Record<string, unknown>): value is Created & Record<string, unknown> {
  return typeof value.invitationId === "string" && typeof value.expiresAt === "string"
    && typeof value.requestSha256 === "string" && /^[0-9a-f]{64}$/.test(value.requestSha256)
    && typeof value.state === "string";
}
function validRevealed(value: Record<string, unknown>): value is Revealed & Record<string, unknown> {
  return typeof value.commandId === "string" && typeof value.invitationId === "string"
    && typeof value.expiresAt === "string" && typeof value.invitationSecret === "string";
}
function validReview(value: Record<string, unknown>): value is Review & Record<string, unknown> {
  return typeof value.invitationId === "string" && typeof value.submissionId === "string"
    && typeof value.fieldsSha256 === "string" && /^[0-9a-f]{64}$/.test(value.fieldsSha256)
    && typeof value.submittedAt === "string" && Number.isFinite(Date.parse(value.submittedAt))
    && (value.targetClientRecordId === null || typeof value.targetClientRecordId === "string")
    && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 128
    && record(value.fields) && typeof value.fields.name === "string" && typeof value.fields.email === "string";
}

export function ClientOnboardingStaff() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [accessError, setAccessError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    json(`${endpoint}/session`, { method: "GET", signal: controller.signal,
      headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!validSession(value)) throw new Error("invalid_response"); setSession(value); })
      .catch(error => { if (!controller.signal.aborted) setAccessError(error instanceof Error && "status" in error && error.status === 404
        ? "This administrator-only capability is not enabled." : "Administrator onboarding access could not be verified."); });
    return () => controller.abort();
  }, []);

  if (accessError) return <main className="onboarding-staff-gate"><Card><h1>Client onboarding unavailable</h1><p role="alert">{accessError}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <ClientOnboardingIssuer session={session} />;
}

export function ClientOnboardingIssuer({ session }: { session: StaffSession }) {
  const [commandId] = useState(uuid);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [targetMode, setTargetMode] = useState<TargetMode>("proposed-scopes");
  const [targetClientRecordId, setTargetClientRecordId] = useState("");
  const [scopes, setScopes] = useState<Scope[]>([{ businessAreaId: "", divisionId: "" }]);
  const [created, setCreated] = useState<Created | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState<"create" | "reveal" | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"create" | "reveal" | null>(null);
  const [copied, setCopied] = useState(false);
  const revealAttempted = useRef(false);

  const mutateScope = (index: number, patch: Partial<Scope>) => setScopes(current => current.map((scope, position) => position === index ? { ...scope, ...patch } : scope));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || created || uncertain) return;
    setError(""); setBusy("create");
    try {
      const parsedExpiry = new Date(expiresAt);
      if (!Number.isFinite(parsedExpiry.valueOf()) || parsedExpiry <= new Date()) throw new Error("Choose a future expiration time.");
      if (targetMode === "existing-client" && !targetClientRecordId.trim()) throw new Error("Enter the existing client record ID.");
      if (targetMode === "proposed-scopes" && scopes.some(scope => !scope.businessAreaId.trim())) throw new Error("Every scope needs a business area ID.");
      const value = await json(`${endpoint}/create`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ commandId, expiresAt: parsedExpiry.toISOString(),
          targetClientRecordId: targetMode === "existing-client" ? targetClientRecordId.trim() : null,
          scopes: targetMode === "existing-client" ? null : scopes.map(scope => ({ businessAreaId: scope.businessAreaId.trim(), divisionId: scope.divisionId.trim() || null })) }) });
      if (!validCreated(value)) throw new Error("invalid_response");
      setCreated(value);
    } catch (caught) {
      const status = caught instanceof Error && "status" in caught ? Number(caught.status) : 0;
      if (!status || status >= 500 || (caught instanceof Error && caught.message === "invalid_response")) setUncertain("create");
      else setError(caught instanceof Error && !caught.message.startsWith("client_onboarding_") ? caught.message : "Issuance was denied. Confirm your current grant and inputs.");
    } finally { setBusy(null); }
  };
  const reveal = async () => {
    if (!created || busy || revealed || uncertain || revealAttempted.current) return;
    revealAttempted.current = true; setBusy("reveal"); setError("");
    try {
      const value = await json(`${endpoint}/reveal`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ commandId }) });
      if (!validRevealed(value) || value.commandId !== commandId || value.invitationId !== created.invitationId) throw new Error("invalid_response");
      setRevealed(value);
    } catch (caught) {
      const status = caught instanceof Error && "status" in caught ? Number(caught.status) : 0;
      if (!status || status >= 500 || (caught instanceof Error && caught.message === "invalid_response")) setUncertain("reveal");
      else setError("Reveal was denied. It will not be attempted again from this page.");
    } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!revealed) return;
    try { await navigator.clipboard.writeText(revealed.invitationSecret); setCopied(true); }
    catch { setCopied(false); setError("Copy was blocked. Select the secret and copy it manually."); }
  };

  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" /><a href="/">Exit onboarding</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Administrator tool</p><h1>Issue client profile onboarding</h1>
      <p>Create a bounded onboarding invitation, then reveal its secret once. This does not grant active client access.</p></div>
    <aside className="onboarding-staff-warning" role="status"><strong>Recipient flow is separately controlled</strong><span>This page reveals an invitation secret, not a recipient URL or client access. The recipient route must be enabled independently.</span></aside>
    <Card><form className="onboarding-staff-form" onSubmit={submit}>
      <label>Command ID<input value={commandId} readOnly /></label>
      <label>Expires at<input type="datetime-local" value={expiresAt} min={localDateTime(new Date(Date.now() + 60_000))} disabled={Boolean(created || uncertain)} onChange={event => setExpiresAt(event.target.value)} required /></label>
      <fieldset className="wide onboarding-target-mode"><legend>Invitation target</legend>
        <label><input type="radio" name="target-mode" value="proposed-scopes" checked={targetMode === "proposed-scopes"} disabled={Boolean(created || uncertain)} onChange={() => { setTargetMode("proposed-scopes"); setTargetClientRecordId(""); }} />Proposed scopes for a new client profile</label>
        <label><input type="radio" name="target-mode" value="existing-client" checked={targetMode === "existing-client"} disabled={Boolean(created || uncertain)} onChange={() => setTargetMode("existing-client")} />Existing client record</label>
      </fieldset>
      {targetMode === "existing-client" && <label className="wide">Existing client record ID<input value={targetClientRecordId} maxLength={191} disabled={Boolean(created || uncertain)} onChange={event => setTargetClientRecordId(event.target.value)} required /></label>}
      {targetMode === "proposed-scopes" && <fieldset className="wide"><legend>Authorized scopes</legend>{scopes.map((scope, index) => <div className="onboarding-scope" key={index}>
        <label>Business area ID<input value={scope.businessAreaId} maxLength={128} disabled={Boolean(created || uncertain)} onChange={event => mutateScope(index, { businessAreaId: event.target.value })} required /></label>
        <label>Division ID <small>Optional</small><input value={scope.divisionId} maxLength={128} disabled={Boolean(created || uncertain)} onChange={event => mutateScope(index, { divisionId: event.target.value })} /></label>
        {scopes.length > 1 && !created && !uncertain && <button type="button" className="button-ghost" onClick={() => setScopes(current => current.filter((_, position) => position !== index))}>Remove scope</button>}
      </div>)}{!created && !uncertain && <button type="button" className="button-ghost" disabled={scopes.length >= MAX_UI_SCOPES} onClick={() => setScopes(current => current.length >= MAX_UI_SCOPES ? current : [...current, { businessAreaId: "", divisionId: "" }])}>Add scope</button>}
        {scopes.length >= MAX_UI_SCOPES && <p role="status">Maximum {MAX_UI_SCOPES} scopes per invitation.</p>}</fieldset>}
      {error && <p className="wide onboarding-staff-error" role="alert">{error}</p>}
      {uncertain === "create" && <p className="wide onboarding-staff-error" role="alert"><strong>Issuance outcome is uncertain.</strong> Do not issue another command from this page. Record command ID <code>{commandId}</code> and have an administrator verify the audit state.</p>}
      {!created && !uncertain && <button className="button-orange wide" disabled={Boolean(busy)}>{busy === "create" ? "Issuing…" : "Issue invitation metadata"}</button>}
    </form></Card>
    {created && <Card><section className="onboarding-created"><h2>Invitation metadata issued</h2><dl><div><dt>Invitation ID</dt><dd>{created.invitationId}</dd></div><div><dt>State</dt><dd>{created.state}</dd></div><div><dt>Expires</dt><dd>{new Date(created.expiresAt).toLocaleString()}</dd></div><div><dt>Request fingerprint</dt><dd><code>{created.requestSha256}</code></dd></div></dl>
      {!revealed && !uncertain && <><p>The next action consumes the one-time reveal. Be ready to transfer the secret through the approved secure channel.</p><button className="button-orange" type="button" disabled={Boolean(busy)} onClick={reveal}>{busy === "reveal" ? "Revealing once…" : "Reveal secret once"}</button></>}
      {uncertain === "reveal" && <p className="onboarding-staff-error" role="alert"><strong>Reveal outcome is uncertain.</strong> Do not reveal again. The server may have consumed the one-time reveal; have an administrator inspect the audit state.</p>}
      {revealed && <div className="onboarding-secret"><h3>One-time secret</h3><p>This page will not reveal it again. No recipient URL or client access has been created.</p><output aria-label="Invitation secret">{revealed.invitationSecret}</output><button type="button" className="button-ghost" onClick={copy}>{copied ? "Copied" : "Copy secret"}</button></div>}
    </section></Card>}
    <ClientOnboardingReview session={session} />
  </main></div>;
}

function ClientOnboardingReview({ session }: { session: StaffSession }) {
  const [submissionId, setSubmissionId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setReview(null);
    try {
      const value = await json(`${endpoint}/review`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ submissionId: submissionId.trim() }) });
      if (!validReview(value) || value.submissionId !== submissionId.trim()) throw new Error("invalid_response");
      setReview(value);
    } catch { setError("Submission was not found or is outside your current authorized scope."); }
    finally { setBusy(false); }
  };
  const fieldEntries = review ? [
    ["Client type", review.fields.clientType], ["Name", review.fields.name], ["Email", review.fields.email],
    ["Phone", review.fields.phone], ["Organization", review.fields.organizationName],
    ["Organization email", review.fields.organizationEmail], ["Organization phone", review.fields.organizationPhone],
    ["Address line 1", review.fields.addressLine1], ["Address line 2", review.fields.addressLine2],
    ["City", review.fields.city], ["State", review.fields.state], ["Postal code", review.fields.postalCode],
    ["Country", review.fields.country],
  ] : [];
  return <Card><section className="onboarding-created"><h2>Review submitted profile</h2>
    <p>Read-only lookup. Approval and rejection are intentionally unavailable here.</p>
    <form className="onboarding-staff-form" onSubmit={load}>
      <label className="wide">Submission ID<input value={submissionId} required maxLength={36}
        onChange={event => setSubmissionId(event.target.value)} /></label>
      <button className="button-orange wide" disabled={busy}>{busy ? "Loading…" : "Load authorized submission"}</button>
    </form>
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
    {review && <div className="onboarding-review-detail"><dl>
      <div><dt>Submission ID</dt><dd>{review.submissionId}</dd></div>
      <div><dt>Invitation ID</dt><dd>{review.invitationId}</dd></div>
      <div><dt>Submitted</dt><dd>{new Date(review.submittedAt).toLocaleString()}</dd></div>
      <div><dt>Fields fingerprint</dt><dd><code>{review.fieldsSha256}</code></dd></div>
      <div><dt>Target</dt><dd>{review.targetClientRecordId ?? "New client profile"}</dd></div>
      {fieldEntries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
    </dl><h3>Authorized scope</h3><ul>{review.scopes.map(scope =>
      <li key={`${scope.businessAreaId}:${scope.divisionId ?? ""}`}>{scope.businessAreaId}{scope.divisionId ? ` / ${scope.divisionId}` : ""}</li>)}</ul>
    </div>}
  </section></Card>;
}
