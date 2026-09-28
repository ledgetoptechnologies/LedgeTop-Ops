import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading } from "@ltds/ui";
import { EnrollmentApiError, issueEnrollmentIntent, listEnrollmentIntents, mutateEnrollmentIntent,
  newEnrollmentOperationId, openEnrollmentOwnerSession, type EnrollmentReview, type OwnerSession }
  from "./client-portal-recipient-enrollment-owner-api";
import "./ClientOnboardingStaff.css";

type PendingMutation = { intent: EnrollmentReview; action: "confirm" | "revoke" | "reconcile" | "cancel"; operationId: string };
type IssueAttempt = { operationId: string; selectionId: string; clientRecordId: string; expiresAt: string };
const localDateTime = (date: Date) => {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};
const defaultExpiry = () => localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

export function ClientPortalRecipientEnrollment() {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let active = true;
    void openEnrollmentOwnerSession().then(value => { if (active) setSession(value); })
      .catch(() => { if (active) setError("This staging-only administrator capability is unavailable."); });
    return () => { active = false; }; }, []);
  if (error) return <main className="onboarding-staff-gate"><Card><h1>Portal account enrollment unavailable</h1>
    <p role="alert">{error}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <EnrollmentWorkspace session={session} />;
}

function EnrollmentWorkspace({ session }: { session: OwnerSession }) {
  const [activeSession, setActiveSession] = useState(session);
  const [selectionId, setSelectionId] = useState("");
  const [clientRecordId, setClientRecordId] = useState("");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [targetAcknowledged, setTargetAcknowledged] = useState(false);
  const [intents, setIntents] = useState<EnrollmentReview[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [issuedLink, setIssuedLink] = useState("");
  const [issueAttempt, setIssueAttempt] = useState<IssueAttempt | null>(null);
  const [issueKnown, setIssueKnown] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const mutation = useRef<Map<string, string>>(new Map());
  const uncertain = useRef<PendingMutation | null>(null);

  const refresh = async () => {
    setError("");
    try { setIntents(await listEnrollmentIntents()); }
    catch { setError("Portal account requests could not be loaded."); }
  };
  useEffect(() => { void refresh(); }, []);
  const issue = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || issueKnown || (!issueAttempt && !targetAcknowledged)) return;
    const retrying = issueAttempt !== null;
    let attempt = issueAttempt;
    if (!attempt) {
      const expiry = new Date(expiresAt);
      if (!selectionId.trim() || !clientRecordId.trim() || !Number.isFinite(expiry.valueOf()) || expiry <= new Date()) {
        setError("Choose an exact client record, acknowledged workspace selection, and future expiration."); return;
      }
      attempt = { operationId: newEnrollmentOperationId(), selectionId: selectionId.trim(),
        clientRecordId: clientRecordId.trim(), expiresAt: expiry.toISOString() };
      setIssueAttempt(attempt);
    }
    setBusy("issue"); setError(""); setMessage("");
    try {
      const requestSession = retrying ? await openEnrollmentOwnerSession() : activeSession;
      if (retrying) setActiveSession(requestSession);
      const result = await issueEnrollmentIntent(requestSession.csrfToken, attempt);
      setIssueKnown(true);
      await refresh();
      if (!result.opaqueToken) {
        setError("The same issuance was already recorded, but its one-time link cannot be revealed again. Create a new intent only after reviewing this outcome.");
      } else {
        const path = `/portal/recipient-enrollment/${result.review.intentId}#${result.opaqueToken}`;
        setIssuedLink(`${requestSession.recipientOrigin}${path}`);
        setMessage("One-time portal confirmation link issued. It has not granted access.");
      }
    } catch (caught) {
      if (caught instanceof EnrollmentApiError && !caught.uncertain && !retrying) setIssueAttempt(null);
      setError(caught instanceof EnrollmentApiError && caught.uncertain
        ? "Issuance outcome is uncertain. Retry this same issuance to inspect its immutable result; do not create another operation yet."
        : "Issuance was denied. Verify the exact client and workspace selection.");
    } finally { setBusy(""); }
  };
  const startNewIntent = () => {
    if (!issueKnown || busy) return;
    setIssueAttempt(null); setIssueKnown(false); setIssuedLink(""); setClientRecordId(""); setSelectionId("");
    setExpiresAt(defaultExpiry()); setTargetAcknowledged(false); setError(""); setMessage("");
  };
  const act = async (intent: EnrollmentReview, action: PendingMutation["action"]) => {
    const key = `${intent.intentId}:${action}`;
    const reviewKey = `${intent.intentId}:${intent.revision}:${action}`;
    const retrying = uncertain.current?.intent.intentId === intent.intentId && uncertain.current.action === action;
    if (busy || (!retrying && action !== "reconcile" && !reviewed.has(reviewKey))) return;
    const operationId = mutation.current.get(key) ?? newEnrollmentOperationId();
    mutation.current.set(key, operationId); setBusy(key); setError(""); setMessage("");
    try {
      const requestSession = retrying ? await openEnrollmentOwnerSession() : activeSession;
      if (retrying) setActiveSession(requestSession);
      const result = await mutateEnrollmentIntent(requestSession.csrfToken, intent, action, operationId);
      uncertain.current = result.status === "pending" ? { intent, action, operationId } : null;
      setMessage(result.status === "pending"
        ? "The durable change is recorded, but delivery is still pending. Retry the same action to check delivery."
        : action === "confirm" ? "Portal access confirmation was acknowledged."
        : action === "revoke" ? "Full revocation was acknowledged; reconcile it to close the local binding."
        : action === "cancel" ? "The confirmation was canceled. Issue a fresh intent if access is still required."
        : "Revocation was reconciled and the local binding is closed.");
      if (!result.review) { uncertain.current = null; await refresh(); return; }
      setIntents(current => current.map(item => item.intentId === intent.intentId ? result.review : item)
        .filter((item): item is EnrollmentReview => item !== null && item.state !== "revoked"));
    } catch (caught) {
      if (caught instanceof EnrollmentApiError && caught.uncertain) uncertain.current = { intent, action, operationId };
      else {
        uncertain.current = null; mutation.current.delete(key);
        setReviewed(current => { const next = new Set(current); next.delete(reviewKey); return next; });
      }
      setError(caught instanceof EnrollmentApiError && caught.uncertain
        ? "The mutation outcome is uncertain. Retry the same action; the operation ID will not change."
        : action === "reconcile" ? "The exact revocation receipt is not ready or current authority was denied. Retry the same reconciliation after reviewing status."
        : "The action was denied. Recheck your current authority and the exact recipient target.");
    } finally { setBusy(""); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(issuedLink); setMessage("Link copied. Transfer it only through the approved private channel."); }
    catch { setError("Copy was blocked. Select and copy the link manually."); } };

  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" />
    <a href="/">Exit portal enrollment</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Staging administrator tool</p><h1>Client portal account enrollment</h1>
      <p>Issue a private, one-time confirmation link for an existing client and acknowledged workspace selection. A recipient confirmation still requires owner review.</p></div>
    <aside className="onboarding-staff-warning" role="status"><strong>No identity matching or automatic activation</strong>
      <span>This workflow never matches by name or email. Every grant and revocation uses the exact client record, selection, Access issuer, and Access subject.</span></aside>
    <Card><form className="onboarding-staff-form" onSubmit={issue}>
      <label>Client record ID<input value={clientRecordId} maxLength={200} disabled={Boolean(issueAttempt)} onChange={event => setClientRecordId(event.target.value)} required /></label>
      <label>Acknowledged workspace selection ID<input value={selectionId} maxLength={36} disabled={Boolean(issueAttempt)} onChange={event => setSelectionId(event.target.value)} required /></label>
      <label>Link expires at<input type="datetime-local" value={expiresAt} disabled={Boolean(issueAttempt)} onChange={event => setExpiresAt(event.target.value)} required /></label>
      <fieldset className="wide onboarding-target-mode"><legend>Exact target acknowledgment</legend><label>
        <input type="checkbox" checked={targetAcknowledged} disabled={Boolean(issueAttempt)} onChange={event => setTargetAcknowledged(event.target.checked)} />
        I verified that this client record belongs to this acknowledged workspace selection.</label></fieldset>
      {!issueKnown && <button className="button-orange wide" disabled={Boolean(busy) || (!issueAttempt && !targetAcknowledged)}>
        {busy === "issue" ? "Issuing…" : issueAttempt ? "Retry same issuance" : "Issue one-time confirmation link"}</button>}
      {issueKnown && <button type="button" className="button-ghost wide" disabled={Boolean(busy)} onClick={startNewIntent}>Start new intent</button>}
    </form></Card>
    {issuedLink && <Card><section className="onboarding-created"><h2>One-time confirmation link</h2>
      <p>This link is shown only from the first successful response. It grants nothing until the recipient confirms and an owner approves.</p>
      <div className="onboarding-secret"><output aria-label="Portal confirmation link">{issuedLink}</output>
        <button type="button" className="button-ghost" onClick={() => void copy()}>Copy private link</button></div></section></Card>}
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <Card><section className="onboarding-created"><div><h2>Recipient requests</h2>
      <button type="button" className="button-ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh requests</button></div>
      {intents.length === 0 ? <p>No recipient confirmations currently require action.</p> : intents.map(intent => {
        const pendingMutation = uncertain.current?.intent.intentId === intent.intentId ? uncertain.current : null;
        const pending = Boolean(pendingMutation);
        const reviewedIntent = pendingMutation?.intent ?? intent;
        const action = pendingMutation?.action ?? (intent.state === "issued" ? "cancel" : intent.state === "pending" ? "confirm" : intent.state === "active" ? "revoke" : intent.state === "revoking" ? "reconcile" : null);
        const cancelAction = intent.state === "pending" && !pending ? "cancel" : null;
        const reviewKey = `${reviewedIntent.intentId}:${reviewedIntent.revision}:${action}`;
        const cancelReviewKey = `${intent.intentId}:${intent.revision}:cancel`;
        return <article key={intent.intentId} className="onboarding-secret"><h3>{intent.state === "issued" ? "Issued confirmation" : intent.state === "pending" ? "Review recipient" : intent.state === "active" ? "Active portal identity" : intent.state === "revoking" ? "Revocation pending receipt" : "Canceled enrollment"}</h3>
          <dl><div><dt>Client record</dt><dd>{intent.target.clientRecordId}</dd></div><div><dt>Workspace selection</dt><dd>{intent.target.selectionId}</dd></div>
            <div><dt>Access issuer</dt><dd>{intent.principal?.issuer ?? "Not supplied"}</dd></div><div><dt>Access subject</dt><dd>{intent.principal?.subject ?? "Not supplied"}</dd></div>
            <div><dt>Revision</dt><dd>{intent.revision}</dd></div></dl>
          {intent.state === "cancelled" && <p>This is a read-only audit record. The prior link cannot be reused; issue a fresh intent to restart enrollment.</p>}
          {action !== "reconcile" && action !== null && <label><input type="checkbox" checked={reviewed.has(reviewKey)} onChange={event => setReviewed(current => {
             const next = new Set(current); if (event.target.checked) next.add(reviewKey); else next.delete(reviewKey); return next; })} />
            {action === "cancel" ? "I reviewed the exact client and selection and authorize cancellation." : `I reviewed the exact client, selection${intent.principal ? ", issuer, and subject" : ""}.`}</label>}
          {cancelAction && <label><input type="checkbox" checked={reviewed.has(cancelReviewKey)} onChange={event => setReviewed(current => {
             const next = new Set(current); if (event.target.checked) next.add(cancelReviewKey); else next.delete(cancelReviewKey); return next; })} />
            I reviewed the exact client and selection and authorize cancellation.</label>}
          {action !== null && <button type="button" className={action === "revoke" || action === "cancel" ? "button-danger" : "button-orange"}
            disabled={Boolean(busy) || (!pending && action !== "reconcile" && !reviewed.has(reviewKey))}
            onClick={() => void act(pendingMutation?.intent ?? intent, action)}>
            {pending ? `Retry same ${action}` : action === "confirm" ? "Confirm portal access" : action === "revoke" ? "Revoke all portal access" : action === "cancel" ? "Cancel confirmation" : "Reconcile acknowledged revocation"}</button>}
          {cancelAction && <button type="button" className="button-danger"
            disabled={Boolean(busy) || !reviewed.has(cancelReviewKey)}
            onClick={() => void act(intent, cancelAction)}>Cancel confirmation</button>}
        </article>;
      })}
    </section></Card>
  </main></div>;
}
