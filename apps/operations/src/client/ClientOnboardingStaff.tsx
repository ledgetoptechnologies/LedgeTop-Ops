import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading } from "@ltds/ui";
import { ClientOnboardingInbox } from "./ClientOnboardingReview";
import { endpoint, json, post, uncertainFailure, uuid, validSession, record, type StaffSession } from "./onboarding-staff-api";
import "./ClientOnboardingStaff.css";

type Scope = { businessAreaId: string; divisionId: string };
type Created = { invitationId: string; expiresAt: string; requestSha256: string; state: string };
/** The recipient link carries the one-time secret in its #fragment: it lives only in
 * memory, is never rendered as text, and is never rebuilt from the secret. */
type Revealed = { invitationId: string; expiresAt: string; link: string | null; secret: string };
type TargetMode = "proposed-scopes" | "existing-client";

const MAX_UI_SCOPES = 16;
const SESSION_REFRESH_MS = 8 * 60 * 1000;
const localDateTime = (date: Date) => {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};
const defaultExpiry = () => {
  const date = new Date(Date.now() + (7 * 24 - 1) * 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return localDateTime(date);
};
function validCreated(value: Record<string, unknown>): value is Created & Record<string, unknown> {
  return typeof value.invitationId === "string" && typeof value.expiresAt === "string"
    && typeof value.requestSha256 === "string" && /^[0-9a-f]{64}$/.test(value.requestSha256) && typeof value.state === "string";
}
/** Accepts only an https onboarding link for exactly this invitation. */
export function safeRecipientLink(value: unknown, invitationId: string): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search
      && url.pathname === `/onboarding/${invitationId}` && /^#[0-9a-f]{64}$/.test(url.hash) ? url.href : null;
  } catch { return null; }
}

export function ClientOnboardingStaff() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [accessError, setAccessError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = (first: boolean) => json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!validSession(value)) throw new Error("invalid_response"); setSession({ csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil }); })
      .catch(error => { if (controller.signal.aborted || !first) return; setAccessError(error instanceof Error && "status" in error && error.status === 404
        ? "This administrator-only capability is not enabled." : "Administrator onboarding access could not be verified."); });
    void load(true);
    // The request token rotates every ten minutes; refresh it so long reviews keep working.
    const timer = window.setInterval(() => void load(false), SESSION_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  if (accessError) return <main className="onboarding-staff-gate"><Card><h1>Client onboarding unavailable</h1><p role="alert">{accessError}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" /><a href="/">Exit onboarding</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Client onboarding</p><h1>Client onboarding</h1>
      <p>Invite a client to fill in their profile, then review what they submit and choose which Ledge Top businesses they belong to.</p></div>
    <ClientOnboardingInbox session={session} />
    <ClientOnboardingIssuer session={session} />
  </main></div>;
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
  const [notice, setNotice] = useState("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const revealAttempted = useRef(false);

  const mutateScope = (index: number, patch: Partial<Scope>) => setScopes(current => current.map((scope, position) => position === index ? { ...scope, ...patch } : scope));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || created || uncertain) return;
    const parsedExpiry = new Date(expiresAt);
    const invalid = !Number.isFinite(parsedExpiry.valueOf()) || parsedExpiry <= new Date() ? "Choose a future expiration time."
      : targetMode === "existing-client" && !targetClientRecordId.trim() ? "Enter the existing client record ID."
      : targetMode === "proposed-scopes" && scopes.some(scope => !scope.businessAreaId.trim()) ? "Every business area needs an ID." : "";
    setError(invalid);
    if (invalid) return;
    setBusy("create");
    try {
      const value = await post(session, "create", { commandId, expiresAt: parsedExpiry.toISOString(),
        targetClientRecordId: targetMode === "existing-client" ? targetClientRecordId.trim() : null,
        scopes: targetMode === "existing-client" ? null : scopes.map(scope => ({ businessAreaId: scope.businessAreaId.trim(), divisionId: scope.divisionId.trim() || null })) });
      if (!validCreated(value)) throw new Error("invalid_response");
      setCreated(value);
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("create");
      else setError("The invitation was refused. Check your permissions and the details, then try again.");
    } finally { setBusy(null); }
  };
  const reveal = async () => {
    if (!created || busy || revealed || uncertain || revealAttempted.current) return;
    revealAttempted.current = true; setBusy("reveal"); setError("");
    try {
      const value = await post(session, "reveal", { commandId });
      if (!record(value) || value.commandId !== commandId || value.invitationId !== created.invitationId
        || typeof value.invitationSecret !== "string" || !/^[0-9a-f]{64}$/.test(value.invitationSecret) || typeof value.expiresAt !== "string")
        throw new Error("invalid_response");
      setRevealed({ invitationId: created.invitationId, expiresAt: value.expiresAt,
        link: safeRecipientLink(value.recipientUrl, created.invitationId), secret: value.invitationSecret });
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("reveal");
      else setError("The link couldn't be created. It won't be attempted again from this page.");
    } finally { setBusy(null); }
  };
  const copyLink = async () => {
    if (!revealed) return;
    const value = revealed.link ?? revealed.secret;
    try { await navigator.clipboard.writeText(value); setNotice(revealed.link ? "Link copied. Send it to the client through a secure channel." : "Invitation code copied."); }
    catch { setNotice(""); setError("Copying was blocked by the browser. Use “Open form” instead."); }
  };
  const openForm = (currentTab: boolean) => {
    if (!revealed?.link) return;
    if (currentTab) { window.location.assign(revealed.link); return; }
    const opened = window.open(revealed.link, "_blank", "noopener,noreferrer");
    // With noopener the handle is usually null even on success; a blocked popup is
    // indistinguishable, so always offer the same-tab fallback.
    setPopupBlocked(true);
    if (opened) opened.opener = null;
  };

  return <Card><section className="onboarding-created" aria-labelledby="onboarding-invite-title">
    <h2 id="onboarding-invite-title">Invite a client</h2>
    <p>Creates a one-time link where the client fills in their profile. It doesn't give the client any access until you review and approve their submission.</p>
    <form className="onboarding-staff-form" onSubmit={submit}>
      <label>Link expires<input type="datetime-local" value={expiresAt} min={localDateTime(new Date(Date.now() + 60_000))} disabled={Boolean(created || uncertain)} onChange={event => setExpiresAt(event.target.value)} required /></label>
      <fieldset className="wide onboarding-target-mode"><legend>Who is this for?</legend>
        <label><input type="radio" name="target-mode" value="proposed-scopes" checked={targetMode === "proposed-scopes"} disabled={Boolean(created || uncertain)} onChange={() => { setTargetMode("proposed-scopes"); setTargetClientRecordId(""); }} />A new client</label>
        <label><input type="radio" name="target-mode" value="existing-client" checked={targetMode === "existing-client"} disabled={Boolean(created || uncertain)} onChange={() => setTargetMode("existing-client")} />An existing client record</label>
      </fieldset>
      {targetMode === "existing-client" && <label className="wide">Existing client record ID<input value={targetClientRecordId} maxLength={191} disabled={Boolean(created || uncertain)} onChange={event => setTargetClientRecordId(event.target.value)} required /></label>}
      {targetMode === "proposed-scopes" && <fieldset className="wide"><legend>Business areas</legend>{scopes.map((scope, index) => <div className="onboarding-scope" key={index}>
        <label>Business area ID<input value={scope.businessAreaId} maxLength={128} disabled={Boolean(created || uncertain)} onChange={event => mutateScope(index, { businessAreaId: event.target.value })} required /></label>
        <label>Division ID <small>Optional</small><input value={scope.divisionId} maxLength={128} disabled={Boolean(created || uncertain)} onChange={event => mutateScope(index, { divisionId: event.target.value })} /></label>
        {scopes.length > 1 && !created && !uncertain && <button type="button" className="button-ghost" onClick={() => setScopes(current => current.filter((_, position) => position !== index))}>Remove</button>}
      </div>)}{!created && !uncertain && <button type="button" className="button-ghost" disabled={scopes.length >= MAX_UI_SCOPES} onClick={() => setScopes(current => current.length >= MAX_UI_SCOPES ? current : [...current, { businessAreaId: "", divisionId: "" }])}>Add business area</button>}
        {scopes.length >= MAX_UI_SCOPES && <p role="status">Up to {MAX_UI_SCOPES} business areas per invitation.</p>}</fieldset>}
      {error && <p className="wide onboarding-staff-error" role="alert">{error}</p>}
      {uncertain === "create" && <p className="wide onboarding-staff-error" role="alert"><strong>The invitation result isn't confirmed.</strong> Don't create another one from this page. Reference <code>{commandId}</code> if an administrator needs to check it.</p>}
      {!created && !uncertain && <button className="button-orange wide" disabled={Boolean(busy)}>{busy === "create" ? "Creating…" : "Create invitation"}</button>}
    </form>
    {created && <div className="onboarding-invite-ready">
      <p>Invitation created. It expires {new Date(created.expiresAt).toLocaleString()}.</p>
      {!revealed && !uncertain && <><p>The link can be created only once. Be ready to send it to the client.</p>
        <button className="button-orange" type="button" disabled={Boolean(busy)} onClick={() => void reveal()}>{busy === "reveal" ? "Creating link…" : "Create one-time link"}</button></>}
      {uncertain === "reveal" && <p className="onboarding-staff-error" role="alert"><strong>The link result isn't confirmed.</strong> It may already have been used up; have an administrator check before issuing another invitation.</p>}
      {revealed && <div className="onboarding-secret">
        <h3>{revealed.link ? "One-time link ready" : "Invitation code ready"}</h3>
        <p>{revealed.link ? "Copy it to send to the client, or open the form yourself to fill it in with them. This page won't show it again."
          : "The client link isn't configured for this environment. Copy the invitation code for the approved channel; this page won't show it again."}</p>
        <div className="onboarding-secret-actions">
          <button type="button" className="button-orange" onClick={() => void copyLink()}>{revealed.link ? "Copy link" : "Copy invitation code"}</button>
          {revealed.link && <button type="button" className="button-ghost" onClick={() => openForm(false)}>Open form in a new tab</button>}
          {revealed.link && popupBlocked && <button type="button" className="button-ghost" onClick={() => openForm(true)}>Open form in this tab</button>}
        </div>
        {popupBlocked && <p className="onboarding-hint">If no new tab appeared, your browser blocked it. Use “Open form in this tab”.</p>}
        {notice && <p role="status">{notice}</p>}
      </div>}
    </div>}
  </section></Card>;
}
