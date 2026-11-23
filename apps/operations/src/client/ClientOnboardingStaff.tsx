import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, Loading, Skeleton } from "@ltds/ui";
import { ClientOnboardingInbox } from "./ClientOnboardingReview";
import { ClientOnboardingTargetPicker, type TargetKind, type TargetProof } from "./ClientOnboardingTargetPicker";
import { authorityLost, endpoint, json, post, record, refusalStatus, uncertainFailure, UUID, uuid, validSession, type RequestFailure, type StaffSession } from "./onboarding-staff-api";
import "./ClientOnboardingStaff.css";

type ScopeChoice = { businessAreaId: string; name: string; allowAreaWide: boolean; divisions: Array<{ divisionId: string; name: string }> };
/** divisionId "" means not yet chosen; null means the whole business area. */
type ScopeRow = { businessAreaId: string; divisionId: string | null | "" };
type Created = { invitationId: string; expiresAt: string; requestSha256: string; state: string };
const mailMessages = {
  queued: "Invitation created. Email is queued.",
  sent: "Invitation created. The email provider accepted the message.",
  failed: "Invitation created. Email delivery failed.",
  unknown: "Invitation created. Email delivery status is unknown.",
} as const;
type MailStatus = keyof typeof mailMessages;
/** The recipient link carries the one-time secret in its #fragment: it lives only in
 * memory, is never rendered as text, and is never rebuilt from the secret. */
type Revealed = { invitationId: string; link: string | null; secret: string };

const MAX_UI_SCOPES = 16;
const SESSION_REFRESH_MS = 8 * 60 * 1000;
const MAX_TIMER_MS = 2_147_000_000;
const AREA_WIDE = "__area__";
const inviteDestinations = [
  { sourceId: "project-alpha:secondary", name: "Ledge Top Technologies", style: "technologies" },
  { sourceId: "project-alpha:primary", name: "Ledge Top Drone Services", style: "drone" },
] as const;
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
  return typeof value.invitationId === "string" && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    && typeof value.requestSha256 === "string" && /^[0-9a-f]{64}$/.test(value.requestSha256) && typeof value.state === "string";
}
function readMailStatus(value: Record<string, unknown>, expiresAt: string): MailStatus {
  if (!validCreated(value) || Object.keys(value).length !== 5 || !UUID.test(value.invitationId) || value.expiresAt !== expiresAt
    || (value.state !== "pending" && value.state !== "submitted")
    || typeof value.mailStatus !== "string" || !Object.hasOwn(mailMessages, value.mailStatus)) throw new Error("invalid_response");
  return value.mailStatus as MailStatus;
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
/** Accepts only an HTTPS onboarding link for the revealed invitation and secret. */
export function safeRecipientLink(value: unknown, invitationId: string, invitationSecret: string): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search
      && url.pathname === `/onboarding/${invitationId}` && url.hash === `#${invitationSecret}` ? url.href : null;
  } catch { return null; }
}
export function ClientOnboardingStaff({ embedded = false, onBusyChange, canUseDialog }: {
  embedded?: boolean; onBusyChange?: (busy: boolean) => void; canUseDialog?: () => boolean;
} = {}) {
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
        if (controller.signal.aborted) return;
        if (!validSession(value)) throw new Error("invalid_response");
        const current = sessionRef.current;
        if (!first && !current) return;
        if (current && embedded && current.verifiedUntil !== value.verifiedUntil) {
          close("Your onboarding access changed. Reload the page to continue.");
          return;
        }
        if (current) Object.assign(current, { csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil });
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
    return () => { controller.abort(); window.clearInterval(timer); verify.current = null; sessionRef.current = null; };
  }, [close, embedded]);
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
  if (accessError) return <Card><h2>Client onboarding unavailable</h2><p role="alert">{accessError}</p></Card>;
  if (!session || !verifiedUntil) return <Loading />;
  const canUseSession = () => sessionRef.current === session && Date.parse(session.verifiedUntil) > Date.now();
  if (embedded) return <ClientOnboardingIssuer session={session} onRefused={refused} onBusyChange={onBusyChange}
    canUseSession={canUseSession} canUseDialog={canUseDialog} />;
  return <div className="onboarding-review-surface">
    <ClientOnboardingInbox session={session} onRefused={refused} onAuthorityLost={lost} />
    <ClientOnboardingIssuer session={session} onRefused={refused} canUseSession={canUseSession} />
  </div>;
}

export function ClientOnboardingIssuer({ session, onRefused, onBusyChange, canUseSession, canUseDialog }: {
  session: StaffSession; onRefused: (caught: unknown) => void; onBusyChange?: (busy: boolean) => void;
  canUseSession: () => boolean; canUseDialog?: () => boolean;
}) {
  const inviteTitle = useId();
  const canUseControls = () => canUseSession() && (canUseDialog?.() ?? true);
  const [commandId] = useState(uuid);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [choices, setChoices] = useState<ScopeChoice[] | null | "unavailable">(null);
  const [rows, setRows] = useState<ScopeRow[]>([{ businessAreaId: "", divisionId: "" }]);
  const [offeredDestinations, setOfferedDestinations] = useState<string[] | null>(null);
  const [selectedDestinations, setSelectedDestinations] = useState<string[]>([]);
  const [targetDestinations, setTargetDestinations] = useState<string[]>([]);
  const [targetKind, setTargetKind] = useState<TargetKind | null>(null);
  const [targetProofs, setTargetProofs] = useState<Partial<Record<string, TargetProof>>>({});
  const targetGeneration = useRef(0);
  const [mailAvailable, setMailAvailable] = useState(false);
  const [emailMode, setEmailMode] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [mailStatus, setMailStatus] = useState<MailStatus | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [expired, setExpired] = useState(false);
  const expiryLatched = useRef(false);
  const [busy, setBusy] = useState<"create" | "email" | "reveal" | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"create" | "email" | "reveal" | null>(null);
  const [notice, setNotice] = useState("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const revealAttempted = useRef(false);
  const issuanceInFlight = useRef(false);
  const frozen = Boolean(created || mailStatus || uncertain || busy);

  useEffect(() => {
    let active = true;
    void post(session, "scope-choices", {}).then(value => {
      const parsed = validScopeChoices(value);
      if (!active) return;
      if (Object.hasOwn(value, "destinationSourceIds")) {
        const ids = value.destinationSourceIds;
        const eligible = Array.isArray(ids) && ids.length <= 2 && new Set(ids).size === ids.length
          && ids.every(id => inviteDestinations.some(destination => destination.sourceId === id)) ? ids : [];
        setOfferedDestinations(eligible);
        const targetIds = value.targetDestinationSourceIds;
        setTargetDestinations(parsed?.length && Array.isArray(targetIds) && targetIds.length <= 2
          && new Set(targetIds).size === targetIds.length && targetIds.every(id => eligible.includes(id)) ? targetIds : []);
        setMailAvailable(Boolean(parsed?.length && eligible.length && value.inviteMailIssuanceAvailable === true));
      }
      setChoices(parsed ?? "unavailable");
    }).catch(caught => { if (!active) return; setChoices("unavailable"); onRefused(caught); });
    return () => { active = false; };
    // Business areas are read once per staff session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const expireInvitation = useCallback(() => {
    expiryLatched.current = true;
    setExpired(true);
    setRevealed(null);
  }, []);
  const invitationExpired = expired || (created !== null && Date.parse(created.expiresAt) <= Date.now());
  useEffect(() => {
    if (!created || expired) return;
    let timer: number | undefined;
    const check = () => {
      const remaining = Date.parse(created.expiresAt) - Date.now();
      if (remaining <= 0) expireInvitation();
      else timer = window.setTimeout(check, Math.min(remaining, MAX_TIMER_MS));
    };
    check();
    return () => window.clearTimeout(timer);
  }, [created, expired, expireInvitation]);
  const stopIfExpired = () => {
    if (!expiryLatched.current && (!created || Date.parse(created.expiresAt) > Date.now())) return false;
    expireInvitation();
    return true;
  };
  const available = Array.isArray(choices) ? choices : [];
  const area = (id: string) => available.find(choice => choice.businessAreaId === id);
  const rowKey = (row: ScopeRow) => `${row.businessAreaId}\u0000${row.divisionId ?? AREA_WIDE}`;
  const completeScope = offeredDestinations === null
    ? rows.length > 0 && rows.every(row => row.businessAreaId && row.divisionId !== "") && new Set(rows.map(rowKey)).size === rows.length
    : selectedDestinations.length > 0 && selectedDestinations.every(id => offeredDestinations.includes(id));
  const unavailableTargets = selectedDestinations.filter(id => !targetDestinations.includes(id));
  const canPickTargets = selectedDestinations.length > 0 && unavailableTargets.length === 0;
  const selectedProofs = selectedDestinations.flatMap(id => {
    const proof = targetProofs[id];
    return proof && proof.kind === targetKind ? [proof] : [];
  });
  const complete = completeScope && (targetKind === null || (canPickTargets && selectedProofs.length === selectedDestinations.length));
  const canEmail = mailAvailable && targetKind === null;
  const update = (index: number, patch: Partial<ScopeRow>) => setRows(current => current.map((row, position) => position === index ? { ...row, ...patch } : row));
  const clearTargetProofs = () => { targetGeneration.current++; setTargetProofs({}); };
  const changeTargetKind = (kind: TargetKind | null) => {
    clearTargetProofs();
    setTargetKind(kind);
    setEmailMode(false);
    setRecipient("");
    setRecipientConfirmed(false);
  };
  const generation = targetGeneration.current;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canUseControls() || frozen || issuanceInFlight.current || !Array.isArray(choices)) return;
    if (emailMode && (!canEmail || !offeredDestinations?.length || !recipient.trim() || !recipientConfirmed)) return;
    const parsedExpiry = new Date(expiresAt);
    const invalid = !Number.isFinite(parsedExpiry.valueOf()) || parsedExpiry <= new Date() ? "Choose a future expiration time."
      : !completeScope ? offeredDestinations ? "Choose at least one available business." : "Choose a business area and division for every row, without repeating one."
      : !complete ? "Verify a selection for every chosen business." : "";
    setError(invalid);
    if (invalid) return;
    issuanceInFlight.current = true;
    onBusyChange?.(true); setBusy(emailMode ? "email" : "create");
    let retryAllowed = false;
    try {
      if (emailMode) {
        const expiry = parsedExpiry.toISOString();
        const value = await post(session, "create-email", { commandId, expiresAt: expiry,
          destinationSourceIds: selectedDestinations, recipient: recipient.trim(), recipientConfirmed: true });
        setMailStatus(readMailStatus(value, expiry));
        setRecipient("");
        setRecipientConfirmed(false);
        return;
      }
      const selection = offeredDestinations === null ? { targetClientRecordId: null,
        scopes: rows.map(row => ({ businessAreaId: row.businessAreaId, divisionId: row.divisionId === "" ? null : row.divisionId })) }
        : { destinationSourceIds: selectedDestinations, ...(targetKind ? { targetChoices: selectedProofs } : {}) };
      const value = await post(session, "create", { commandId, expiresAt: parsedExpiry.toISOString(), ...selection });
      if (!validCreated(value)) throw new Error("invalid_response");
      setCreated(value);
    } catch (caught) {
      if (emailMode) {
        const status = (caught as RequestFailure | null)?.status;
        if (status === 400 || status === 429) {
          retryAllowed = true;
          setError(status === 400 ? "Check the recipient address and invitation details." : "Too many invitation attempts. Try again later.");
          return;
        }
        // The handler can return a generic denial after committing but before reading the receipt.
        setUncertain("email");
        setRecipient("");
        setRecipientConfirmed(false);
        onRefused(caught);
      } else if (refusalStatus(caught) === 403) {
        // Generic denial does not say whether the write committed before its receipt could be read.
        setUncertain("create");
        onRefused(caught);
      } else if (uncertainFailure(caught)) setUncertain("create");
      else { retryAllowed = true; setError("The invitation was refused. Check your permissions and the details, then try again."); onRefused(caught); }
    } finally { if (retryAllowed) issuanceInFlight.current = false; setBusy(null); onBusyChange?.(false); }
  };
  const copyValue = async (value: string, isLink: boolean) => {
    if (!canUseControls() || stopIfExpired()) return;
    try {
      await navigator.clipboard.writeText(value);
      setError("");
      setNotice(isLink ? "Link copied. Send it to the client through a secure channel." : "Invitation code copied.");
    } catch {
      setNotice("");
      setError(isLink
        ? "Copying was blocked by the browser. Use “Copy link” to try again, or open the form."
        : "Copying was blocked by the browser. Use “Copy invitation code” to try again.");
    }
  };
  const reveal = async (copyOnSuccess = false) => {
    if (!canUseControls() || !created || busy || revealed || uncertain || revealAttempted.current || stopIfExpired()) return;
    revealAttempted.current = true; onBusyChange?.(true); setBusy("reveal"); setError("");
    try {
      const value = await post(session, "reveal", { commandId });
      if (!record(value) || value.commandId !== commandId || value.invitationId !== created.invitationId
        || typeof value.invitationSecret !== "string" || !/^[0-9a-f]{64}$/.test(value.invitationSecret) || value.expiresAt !== created.expiresAt)
        throw new Error("invalid_response");
      if (!canUseSession() || stopIfExpired()) return;
      const link = safeRecipientLink(value.recipientUrl, created.invitationId, value.invitationSecret);
      setRevealed({ invitationId: created.invitationId, link, secret: value.invitationSecret });
      if (copyOnSuccess && link) await copyValue(link, true);
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("reveal");
      else { setError("The link couldn't be created. It won't be attempted again from this page."); onRefused(caught); }
    } finally { setBusy(null); onBusyChange?.(false); }
  };
  const copyLink = async () => {
    if (!revealed) return;
    await copyValue(revealed.link ?? revealed.secret, Boolean(revealed.link));
  };
  const openForm = (currentTab: boolean) => {
    if (!canUseControls() || !revealed?.link || stopIfExpired()) return;
    if (currentTab) { window.location.assign(revealed.link); return; }
    const opened = window.open(revealed.link, "_blank", "noopener,noreferrer");
    // With noopener the handle is usually null even on success; a blocked popup is
    // indistinguishable, so always offer the same-tab fallback.
    setPopupBlocked(true);
    if (opened) opened.opener = null;
  };

  return <Card><section className="onboarding-created" aria-labelledby={inviteTitle}>
    <h2 id={inviteTitle}>Invite a new client</h2>
    <form className="onboarding-staff-form" onSubmit={submit}>
      <label>Link expires<input type="datetime-local" value={expiresAt} min={localDateTime(new Date(Date.now() + 60_000))} disabled={frozen} onChange={event => setExpiresAt(event.target.value)} required /></label>
      {offeredDestinations !== null && <fieldset className="wide onboarding-destinations"><legend>Businesses</legend>
        {inviteDestinations.map(({ sourceId, name, style }) => <div className={`onboarding-destination onboarding-destination--${style}`} key={sourceId}>
          <label className="onboarding-destination-toggle"><input type="checkbox" checked={selectedDestinations.includes(sourceId)}
            disabled={frozen || !Array.isArray(choices) || !offeredDestinations.includes(sourceId)}
            onChange={event => {
              const checked = event.target.checked;
              clearTargetProofs();
              setSelectedDestinations(current => checked ? [...current, sourceId] : current.filter(id => id !== sourceId));
            }} />{name}</label>
          {!offeredDestinations.includes(sourceId) && <p className="onboarding-hint">Unavailable</p>}
        </div>)}
      </fieldset>}
      {(targetDestinations.length > 0 || targetKind) && <fieldset className="wide onboarding-target-mode" disabled={frozen}>
        <legend>Client details</legend>
        <label><input type="radio" name="invitation-target" checked={targetKind === null} onChange={() => changeTargetKind(null)} />New client</label>
        <label><input type="radio" name="invitation-target" checked={targetKind === "client"} disabled={!canPickTargets}
          onChange={() => changeTargetKind("client")} />Existing client</label>
        <label><input type="radio" name="invitation-target" checked={targetKind === "organization"} disabled={!canPickTargets}
          onChange={() => changeTargetKind("organization")} />New client with an existing organization</label>
        {unavailableTargets.length > 0 && <p className="onboarding-hint">Existing records are unavailable for {inviteDestinations
          .filter(destination => unavailableTargets.includes(destination.sourceId)).map(destination => destination.name).join(" and ")}.</p>}
      </fieldset>}
      {targetKind && canPickTargets && inviteDestinations.filter(destination => selectedDestinations.includes(destination.sourceId))
        .map(({ sourceId, name }) => <ClientOnboardingTargetPicker key={`${sourceId}:${generation}`} sourceId={sourceId} kind={targetKind}
          business={name} session={session} disabled={frozen} onRefused={onRefused} onChoice={proof => {
            if (generation !== targetGeneration.current) return;
            setTargetProofs(current => ({ ...current, [sourceId]: proof ?? undefined }));
          }} />)}
      {offeredDestinations === null && <fieldset className="wide onboarding-scopes"><legend>Business areas</legend>
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
      </fieldset>}
      {error && <p className="wide onboarding-staff-error" role="alert">{error}</p>}
      {uncertain === "create" && <p className="wide onboarding-staff-error" role="alert"><strong>The invitation result isn't confirmed.</strong> Don't create another one from this page. Reference <code>{commandId}</code> if an administrator needs to check it.</p>}
      {uncertain === "email" && <p className="wide onboarding-staff-error" role="alert"><strong>The email invitation result isn't confirmed.</strong> Ask an administrator to check reference <code>{commandId}</code> before trying again.</p>}
      {!created && !mailStatus && !uncertain && canEmail && <fieldset className="wide onboarding-email-delivery" disabled={frozen}>
        <legend>Delivery method</legend>
        <label><input type="radio" name="invitation-delivery" checked={!emailMode} onChange={() => setEmailMode(false)} />Copy a link</label>
        <label><input type="radio" name="invitation-delivery" checked={emailMode} onChange={() => setEmailMode(true)} />Email the client</label>
        {emailMode && <>
          <label>Recipient email<input type="email" maxLength={254} required value={recipient}
            onChange={event => { setRecipient(event.target.value); setRecipientConfirmed(false); }} /></label>
          <label><input type="checkbox" checked={recipientConfirmed} onChange={event => setRecipientConfirmed(event.target.checked)} />I confirmed the recipient address</label>
        </>}
      </fieldset>}
      {!created && !mailStatus && !uncertain && <button className="button-orange wide" disabled={Boolean(busy) || !Array.isArray(choices)
        || choices.length === 0 || !complete || (emailMode && (!recipient.trim() || !recipientConfirmed))}>
        {busy === "email" ? "Creating email invitation…" : busy === "create" ? "Creating…" : emailMode ? "Generate and Email" : "Create invitation"}
      </button>}
    </form>
    {mailStatus && <p role="status">{mailMessages[mailStatus]}</p>}
    {created && <div className="onboarding-invite-ready">
      {invitationExpired ? <p role="status">This invitation has expired. Reference <code>{commandId}</code>.</p>
        : <p>Invitation created. It expires {new Date(created.expiresAt).toLocaleString()}.</p>}
      {!invitationExpired && !revealed && !uncertain && <><p>The link can be created only once. Be ready to send it to the client.</p>
        <div className="onboarding-secret-actions">
          <button className="button-orange" type="button" disabled={Boolean(busy)} onClick={() => void reveal(offeredDestinations !== null)}>{busy === "reveal" ? "Creating link…" : offeredDestinations === null ? "Create one-time link" : "Generate and Copy"}</button>
          {offeredDestinations !== null && targetKind === null && !mailAvailable && <button className="button-ghost" type="button" disabled>Generate and Email</button>}
        </div></>}
      {!invitationExpired && uncertain === "reveal" && <p className="onboarding-staff-error" role="alert"><strong>The link result isn't confirmed.</strong> It may already have been used up; have an administrator check before issuing another invitation.</p>}
      {!invitationExpired && revealed && <div className="onboarding-secret">
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
