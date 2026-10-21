import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading, Skeleton } from "@ltds/ui";
import { ClientOnboardingInbox } from "./ClientOnboardingReview";
import { authorityLost, endpoint, json, post, record, refusalStatus, uncertainFailure, uuid, validSession, type RequestFailure, type StaffSession } from "./onboarding-staff-api";
import "./ClientOnboardingStaff.css";

type ScopeChoice = { businessAreaId: string; name: string; allowAreaWide: boolean; divisions: Array<{ divisionId: string; name: string }> };
/** divisionId "" means not yet chosen; null means the whole business area. */
type ScopeRow = { businessAreaId: string; divisionId: string | null | "" };
type Created = { invitationId: string; expiresAt: string; requestSha256: string; state: string };
/** The recipient link carries the one-time secret in its #fragment: it lives only in
 * memory, is never rendered as text, and is never rebuilt from the secret. */
type Revealed = { invitationId: string; expiresAt: string; link: string | null; secret: string };

const MAX_UI_SCOPES = 16;
const SESSION_REFRESH_MS = 8 * 60 * 1000;
const MAX_TIMER_MS = 2_147_000_000;
const AREA_WIDE = "__area__";
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
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
export function validScopeChoices(value: Record<string, unknown>): ScopeChoice[] | null {
  if (!Array.isArray(value.scopes) || value.scopes.length > 256) return null;
  const areas = new Set<string>();
  for (const scope of value.scopes) {
    if (!record(scope) || typeof scope.businessAreaId !== "string" || !ID.test(scope.businessAreaId) || areas.has(scope.businessAreaId)
      || typeof scope.name !== "string" || !scope.name.trim() || scope.name.length > 300 || typeof scope.allowAreaWide !== "boolean"
      || !Array.isArray(scope.divisions) || scope.divisions.length > 256) return null;
    areas.add(scope.businessAreaId);
    const divisions = new Set<string>();
    for (const division of scope.divisions) {
      if (!record(division) || typeof division.divisionId !== "string" || !ID.test(division.divisionId) || divisions.has(division.divisionId)
        || typeof division.name !== "string" || !division.name.trim() || division.name.length > 300) return null;
      divisions.add(division.divisionId);
    }
    if (!scope.allowAreaWide && scope.divisions.length === 0) return null;
  }
  return value.scopes as ScopeChoice[];
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
  // One stable session object: a refresh rotates the token in place, so open reviews,
  // inbox pages and in-flight retries are not reloaded or remounted.
  const sessionRef = useRef<StaffSession | null>(null);
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  const [accessError, setAccessError] = useState("");
  const close = useCallback((message: string) => { sessionRef.current = null; setVerifiedUntil(null); setAccessError(message); }, []);
  const verify = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // A refusal that arrives while a check is running queues one fresh check: the
    // running one may have been authorized before the revocation.
    let checking = false, pending = false;
    const load = (first: boolean) => { checking = true; return json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => {
        if (!validSession(value)) throw new Error("invalid_response");
        if (!first && !sessionRef.current) return;
        if (sessionRef.current) Object.assign(sessionRef.current, { csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil });
        else sessionRef.current = { csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil };
        setVerifiedUntil(value.verifiedUntil);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        // On a refresh, a definite refusal closes everything; a transient failure
        // keeps the page only until the current verification deadline.
        if (!first && !authorityLost(error)) return;
        close((error as RequestFailure | null)?.status === 404 && first ? "This administrator-only capability is not enabled."
          : first ? "Administrator onboarding access could not be verified." : "Your onboarding access changed. Reload the page to continue.");
      }).finally(() => {
        checking = false;
        if (pending && !controller.signal.aborted && sessionRef.current) { pending = false; void load(false); }
      }); };
    void load(true);
    // A refused request elsewhere on the page re-verifies the session at once.
    verify.current = () => { if (checking) pending = true; else void load(false); };
    // The request token rotates every ten minutes; refresh it so long reviews keep working.
    const timer = window.setInterval(() => void load(false), SESSION_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); verify.current = null; };
  }, [close]);
  useEffect(() => {
    if (!verifiedUntil) return;
    const remaining = Date.parse(verifiedUntil) - Date.now();
    const expire = () => close("Your onboarding session expired. Reload the page to continue.");
    if (!(remaining > 0)) { expire(); return; }
    const timer = window.setTimeout(expire, Math.min(remaining, MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [verifiedUntil, close]);
  // The staff API answers every authentication, CSRF, expiry, capability and resource
  // denial with 403 and a disabled capability with 404. A 401 or 404 closes the page
  // at once; a 403 closes the view that asked (callers do that) and re-verifies the
  // session, which closes everything if the staff authority itself is gone.
  const refused = useCallback((caught: unknown) => {
    const status = refusalStatus(caught);
    if (status === 401 || status === 404) close("Your onboarding access changed. Reload the page to continue.");
    else if (status === 403) verify.current?.();
  }, [close]);
  // Stable, so a successful refresh never re-runs the inbox or review loads.
  const lost = useCallback(() => close("Your onboarding access changed. Reload the page to continue."), [close]);

  const session = sessionRef.current;
  if (accessError) return <main className="onboarding-staff-gate"><Card><h1>Client onboarding unavailable</h1><p role="alert">{accessError}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session || !verifiedUntil) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" /><a href="/">Exit onboarding</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Client onboarding</p><h1>Client onboarding</h1>
      <p>Invite a client to fill in their profile, then review what they submit and choose which Ledge Top businesses they belong to.</p></div>
    <ClientOnboardingInbox session={session} onRefused={refused} onAuthorityLost={lost} />
    <ClientOnboardingIssuer session={session} onRefused={refused} />
  </main></div>;
}

export function ClientOnboardingIssuer({ session, onRefused }: { session: StaffSession; onRefused: (caught: unknown) => void }) {
  const [commandId] = useState(uuid);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [choices, setChoices] = useState<ScopeChoice[] | null | "unavailable">(null);
  const [rows, setRows] = useState<ScopeRow[]>([{ businessAreaId: "", divisionId: "" }]);
  const [created, setCreated] = useState<Created | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState<"create" | "reveal" | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"create" | "reveal" | null>(null);
  const [notice, setNotice] = useState("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const revealAttempted = useRef(false);
  const frozen = Boolean(created || uncertain || busy);

  useEffect(() => {
    let active = true;
    void post(session, "scope-choices", {}).then(value => {
      const parsed = validScopeChoices(value);
      if (active) setChoices(parsed ?? "unavailable");
    }).catch(caught => { if (!active) return; setChoices("unavailable"); onRefused(caught); });
    return () => { active = false; };
    // Business areas are read once per staff session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const available = Array.isArray(choices) ? choices : [];
  const area = (id: string) => available.find(choice => choice.businessAreaId === id);
  const rowKey = (row: ScopeRow) => `${row.businessAreaId}\u0000${row.divisionId ?? AREA_WIDE}`;
  const complete = rows.length > 0 && rows.every(row => row.businessAreaId && row.divisionId !== "") && new Set(rows.map(rowKey)).size === rows.length;
  const update = (index: number, patch: Partial<ScopeRow>) => setRows(current => current.map((row, position) => position === index ? { ...row, ...patch } : row));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || created || uncertain || !Array.isArray(choices)) return;
    const parsedExpiry = new Date(expiresAt);
    const invalid = !Number.isFinite(parsedExpiry.valueOf()) || parsedExpiry <= new Date() ? "Choose a future expiration time."
      : !complete ? "Choose a business area and division for every row, without repeating one." : "";
    setError(invalid);
    if (invalid) return;
    setBusy("create");
    try {
      const value = await post(session, "create", { commandId, expiresAt: parsedExpiry.toISOString(), targetClientRecordId: null,
        scopes: rows.map(row => ({ businessAreaId: row.businessAreaId, divisionId: row.divisionId === "" ? null : row.divisionId })) });
      if (!validCreated(value)) throw new Error("invalid_response");
      setCreated(value);
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("create");
      else { setError("The invitation was refused. Check your permissions and the details, then try again."); onRefused(caught); }
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
      else { setError("The link couldn't be created. It won't be attempted again from this page."); onRefused(caught); }
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
    <h2 id="onboarding-invite-title">Invite a new client</h2>
    <p>Creates a one-time link where the client fills in their profile. It doesn't give the client any access until you review and approve their submission.</p>
    <form className="onboarding-staff-form" onSubmit={submit}>
      <label>Link expires<input type="datetime-local" value={expiresAt} min={localDateTime(new Date(Date.now() + 60_000))} disabled={frozen} onChange={event => setExpiresAt(event.target.value)} required /></label>
      <fieldset className="wide onboarding-scopes"><legend>Business areas</legend>
        {choices === null && <Skeleton variant="text" lines={2} label="Loading business areas…" />}
        {choices === "unavailable" && <p className="onboarding-staff-error" role="alert">Business areas couldn't be loaded, so invitations can't be created right now.</p>}
        {Array.isArray(choices) && choices.length === 0 && <p role="status">You don't have any business areas you can invite clients into.</p>}
        {Array.isArray(choices) && choices.length > 0 && <>{rows.map((row, index) => {
          const selected = area(row.businessAreaId);
          return <div className="onboarding-scope" key={index}>
            <label>Business area<select value={row.businessAreaId} disabled={frozen} required
              onChange={event => update(index, { businessAreaId: event.target.value, divisionId: "" })}>
              <option value="">Choose a business area</option>
              {available.map(choice => <option key={choice.businessAreaId} value={choice.businessAreaId}>{choice.name}</option>)}
            </select></label>
            <label>Division<select value={row.divisionId === null ? AREA_WIDE : row.divisionId} disabled={frozen || !selected} required
              onChange={event => update(index, { divisionId: event.target.value === AREA_WIDE ? null : event.target.value })}>
              <option value="">{selected ? "Choose a division" : "Choose a business area first"}</option>
              {selected?.allowAreaWide && <option value={AREA_WIDE}>Whole business area</option>}
              {selected?.divisions.map(division => <option key={division.divisionId} value={division.divisionId}>{division.name}</option>)}
            </select></label>
            {rows.length > 1 && !frozen && <button type="button" className="button-ghost" onClick={() => setRows(current => current.filter((_, position) => position !== index))}>Remove</button>}
          </div>;
        })}
          {!frozen && <button type="button" className="button-ghost" disabled={rows.length >= MAX_UI_SCOPES} onClick={() => setRows(current => current.length >= MAX_UI_SCOPES ? current : [...current, { businessAreaId: "", divisionId: "" }])}>Add business area</button>}
          {rows.length >= MAX_UI_SCOPES && <p role="status">Up to {MAX_UI_SCOPES} business areas per invitation.</p>}</>}
      </fieldset>
      {error && <p className="wide onboarding-staff-error" role="alert">{error}</p>}
      {uncertain === "create" && <p className="wide onboarding-staff-error" role="alert"><strong>The invitation result isn't confirmed.</strong> Don't create another one from this page. Reference <code>{commandId}</code> if an administrator needs to check it.</p>}
      {!created && !uncertain && <button className="button-orange wide" disabled={Boolean(busy) || !Array.isArray(choices) || choices.length === 0 || !complete}>{busy === "create" ? "Creating…" : "Create invitation"}</button>}
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
