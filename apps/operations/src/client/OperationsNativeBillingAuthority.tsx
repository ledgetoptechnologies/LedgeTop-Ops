import { useEffect, useState, type FormEvent } from "react";
import { Card, Loading } from "@ltds/ui";
import { grantNativeBillingAuthority, NativeBillingOwnerApiError, readNativeBillingAuthority,
  readNativeBillingOwnerSession, revokeNativeBillingAuthority, reviewNativeBillingSelection,
  type NativeBillingAuthority, type NativeBillingGrant, type NativeBillingReview, type NativeBillingSelection }
  from "./operations-native-billing-owner-api";
import { confirmAction } from "./confirm-action";
import "./ClientOnboardingStaff.css";

type Session = Awaited<ReturnType<typeof readNativeBillingOwnerSession>>;
type Attempt = Readonly<{ kind: "grant"; input: NativeBillingGrant }> |
  Readonly<{ kind: "revoke"; input: Readonly<{ operationId: string; grantId: string; expectedRevision: number }> }>;
const uuid = () => crypto.randomUUID();
const denied = (error: unknown) => error instanceof NativeBillingOwnerApiError && [401, 403, 404, 410].includes(error.status);

export function OperationsNativeBillingAuthority() {
  const [session, setSession] = useState<Session | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let mounted = true;
    void readNativeBillingOwnerSession().then(value => { if (mounted) setSession(value); })
      .catch(() => { if (mounted) setUnavailable(true); });
    return () => { mounted = false; };
  }, []);
  if (unavailable) return <main className="onboarding-staff-gate"><Card><h1>Native billing authority unavailable</h1>
    <p role="alert">The staging-only owner capability is unavailable or your access was denied.</p></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <BillingAuthorityWorkspace initialSession={session} />;
}

function BillingAuthorityWorkspace({ initialSession }: { initialSession: Session }) {
  const [session, setSession] = useState(initialSession);
  const [targetId, setTargetId] = useState("");
  const [recipientBindingId, setRecipientBindingId] = useState("");
  const [entityKind, setEntityKind] = useState<NativeBillingSelection["entity"]["kind"]>("project");
  const [nativeId, setNativeId] = useState("");
  const [expiryInput, setExpiryInput] = useState("");
  const [review, setReview] = useState<NativeBillingReview | null>(null);
  const [authorityId, setAuthorityId] = useState("");
  const [authority, setAuthority] = useState<NativeBillingAuthority | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const locked = busy || attempt !== null;
  const selectionFromForm = (): NativeBillingSelection | null => {
    let expiresAt: string | null = null;
    if (expiryInput) {
      const date = new Date(expiryInput);
      if (!Number.isFinite(date.getTime())) return null;
      expiresAt = date.toISOString();
    }
    return { targetId: targetId.trim(), recipientBindingId: recipientBindingId.trim(),
      entity: { kind: entityKind, nativeId: nativeId.trim() }, expiresAt };
  };
  const invalidateReview = () => { setReview(null); setMessage(""); setError(""); };
  const selectionChanged = <T extends string>(set: (value: T) => void) => (value: T) => { set(value); invalidateReview(); };
  const reviewSelection = async (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    const requestedSelection = selectionFromForm();
    if (!requestedSelection) { setError("Enter a valid expiry time or leave expiry empty."); return; }
    setBusy(true); setError(""); setMessage(""); setReview(null); setAuthority(null);
    try {
      const value = await reviewNativeBillingSelection(session.csrfToken, requestedSelection);
      setReview(value);
      setMessage("Exact selection reviewed. Compare every identifier and revision before confirming a grant.");
    } catch (caught) {
      setError(denied(caught) ? "Owner access was denied. No billing authority was changed."
        : "The exact selection could not be reviewed. No billing authority was changed.");
    } finally { setBusy(false); }
  };
  const runAttempt = async (current: Attempt, retrying = false) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const activeSession = retrying ? await readNativeBillingOwnerSession() : session;
      if (retrying) setSession(activeSession);
      const result = current.kind === "grant"
        ? await grantNativeBillingAuthority(activeSession.csrfToken, current.input)
        : await revokeNativeBillingAuthority(activeSession.csrfToken, current.input);
      setAttempt(null); setReview(null);
      if (result.status === "conflict") {
        setError("The reviewed authority changed or is no longer valid. Reload its current status and review again.");
        return;
      }
      setAuthority(result.authority); setAuthorityId(result.authority.grantId);
      setMessage(result.status === "replayed"
        ? `The exact operation was replayed. Current ledger state is ${result.authority.state}; live is ${result.authority.live ? "yes" : "no"}.`
        : `The operation was applied. Current ledger state is ${result.authority.state}; live is ${result.authority.live ? "yes" : "no"}.`);
    } catch (caught) {
      // A failed refresh or denied retry cannot establish the original outcome.
      // Keep its operation identity locked until an authoritative result arrives.
      if (retrying || caught instanceof NativeBillingOwnerApiError && caught.uncertain) {
        setAttempt(current);
        setError(`The ${current.kind} outcome is uncertain. Retry only this frozen operation; do not change its identifiers or create another operation.`);
      } else {
        setAttempt(null); setReview(null);
        setError(denied(caught) ? "Owner access was denied. No further mutation was attempted. Reload and review current status."
          : "The operation was rejected. Reload current status and perform a fresh review before another mutation.");
      }
    } finally { setBusy(false); }
  };
  const confirmGrant = async () => {
    if (!review || locked) return;
    const currentSelection = selectionFromForm();
    if (!currentSelection) { setError("Enter a valid expiry time or leave expiry empty."); return; }
    const exactGrantId = review.grantId ?? uuid();
    const input: NativeBillingGrant = { ...currentSelection, operationId: uuid(), grantId: exactGrantId,
      expectedRevision: review.expectedRevision, reviewFingerprint: review.reviewFingerprint };
    if (!await confirmAction(`Grant billing authority to ${input.entity.kind} ${input.entity.nativeId} for recipient ${input.recipientBindingId}?`)) return;
    setAuthorityId(exactGrantId); void runAttempt({ kind: "grant", input });
  };
  const loadAuthority = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setMessage(""); setAuthority(null);
    try {
      const value = await readNativeBillingAuthority(authorityId.trim());
      setAuthority(value); setAuthorityId(value.grantId);
      setMessage("Exact current ledger status loaded. Ledger state and live status are shown separately.");
    } catch (caught) {
      setError(denied(caught) ? "Owner access was denied. No billing authority was changed."
        : "The exact grant status could not be loaded.");
    } finally { setBusy(false); }
  };
  const confirmRevoke = async () => {
    if (!authority || locked || authority.state === "revoked") return;
    const input = { operationId: uuid(), grantId: authority.grantId, expectedRevision: authority.revision };
    if (!await confirmAction(`Revoke billing authority ${authority.grantId} at revision ${authority.revision}?`)) return;
    void runAttempt({ kind: "revoke", input });
  };

  return <main className="onboarding-staff-gate"><Card><h1>Operations-native billing authority</h1>
    <p>This owner tool is staging-only. It does not grant manual staff permissions or establish remote client acknowledgement.</p>
    <form className="onboarding-staff-form" onSubmit={reviewSelection}>
      <h2 className="wide">Review an exact billing selection</h2>
      <label>Exact native portal target ID<input value={targetId} disabled={locked} onChange={event => selectionChanged(setTargetId)(event.target.value)} /></label>
      <label>Exact recipient binding ID<input value={recipientBindingId} disabled={locked} onChange={event => selectionChanged(setRecipientBindingId)(event.target.value)} /></label>
      <label>Entity kind<select value={entityKind} disabled={locked} onChange={event => { setEntityKind(event.target.value as typeof entityKind); invalidateReview(); }}>
        <option value="organization">Organization</option><option value="client">Client</option><option value="project">Project</option>
      </select></label>
      <label>Exact native entity ID<input value={nativeId} disabled={locked} onChange={event => selectionChanged(setNativeId)(event.target.value)} /></label>
      <label>Expiry (optional)<input type="datetime-local" value={expiryInput} disabled={locked} onChange={event => selectionChanged(setExpiryInput)(event.target.value)} /></label>
      <button className="wide" type="submit" disabled={locked}>Review exact selection</button>
    </form>
    {review && <section className="onboarding-created" aria-labelledby="billing-review-heading"><h2 id="billing-review-heading">Reviewed selection</h2>
      <dl><div><dt>Target</dt><dd>{review.targetId}</dd></div><div><dt>Recipient binding</dt><dd>{review.recipientBindingId}</dd></div>
        <div><dt>Entity</dt><dd>{review.entity.kind}: {review.entity.nativeId}</dd></div><div><dt>Expiry</dt><dd>{review.expiresAt ?? "No expiry"}</dd></div>
        <div><dt>Expected revision</dt><dd>{review.expectedRevision}</dd></div><div><dt>Current grant</dt><dd>{review.grantId ?? "New grant"}</dd></div>
        <div><dt>Review fingerprint</dt><dd>{review.reviewFingerprint}</dd></div></dl>
      <button type="button" disabled={locked} onClick={confirmGrant}>Confirm exact billing grant</button>
    </section>}
    <form className="onboarding-staff-form" onSubmit={loadAuthority}><h2 className="wide">Read or revoke an exact grant</h2>
      <label>Exact billing grant ID<input value={authorityId} disabled={locked} onChange={event => { setAuthorityId(event.target.value); setAuthority(null); }} /></label>
      <button className="wide" type="submit" disabled={busy}>{attempt ? "Load frozen grant current status" : "Load exact grant status"}</button>
    </form>
    {authority && <section className="onboarding-created" aria-labelledby="billing-status-heading"><h2 id="billing-status-heading">Current billing authority</h2>
      <dl><div><dt>Grant ID</dt><dd>{authority.grantId}</dd></div><div><dt>Ledger state</dt><dd>{authority.state}</dd></div>
        <div><dt>Live</dt><dd>{authority.live ? "Yes" : "No"}</dd></div><div><dt>Revision</dt><dd>{authority.revision}</dd></div>
        <div><dt>Target</dt><dd>{authority.targetId}</dd></div><div><dt>Recipient binding</dt><dd>{authority.recipientBindingId}</dd></div>
        <div><dt>Entity</dt><dd>{authority.entity.kind}: {authority.entity.nativeId}</dd></div><div><dt>Expiry</dt><dd>{authority.expiresAt ?? "No expiry"}</dd></div></dl>
      <p>Ledger status is local authority state, not remote client acknowledgement.</p>
      <button type="button" disabled={locked || authority.state === "revoked"} onClick={confirmRevoke}>Confirm exact billing revocation</button>
    </section>}
    {attempt && <button type="button" disabled={busy} onClick={async () => {
      if (busy) return;
      const confirmed = await confirmAction(`Retry the exact frozen ${attempt.kind} operation with its original identifiers and body?`);
      if (confirmed) void runAttempt(attempt, true);
    }}>Retry same frozen {attempt.kind}</button>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </Card></main>;
}
