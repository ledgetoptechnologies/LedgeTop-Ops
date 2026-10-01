import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading } from "@ltds/ui";
import { OperationsNativeRecipientApiError, issueOperationsNativeRecipientIntent,
  mutateOperationsNativeRecipientIntent, newOperationsNativeRecipientOperationId,
  mutateOperationsNativeWorkspaceCleanup, openOperationsNativeRecipientOwnerSession,
  readOperationsNativeRecipientIntent, readOperationsNativeWorkspaceCleanup,
  type OperationsNativeRecipientIssueInput, type OperationsNativeRecipientMutationAction,
  type OperationsNativeRecipientMutationInput, type OperationsNativeRecipientOwnerSession,
  type OperationsNativeRecipientReview, type OperationsNativeWorkspaceCleanupAction,
  type OperationsNativeWorkspaceCleanupInput, type OperationsNativeWorkspaceCleanupReview } from "./operations-native-recipient-owner-api";
import "./ClientOnboardingStaff.css";

type MutationAttempt = Readonly<{ action: OperationsNativeRecipientMutationAction;
  intent: OperationsNativeRecipientReview; input: OperationsNativeRecipientMutationInput }>;
type CleanupAttempt = Readonly<{ action: OperationsNativeWorkspaceCleanupAction;
  workspace: OperationsNativeWorkspaceCleanupReview; input: OperationsNativeWorkspaceCleanupInput }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localDateTime = (date: Date) => {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};
const defaultExpiry = () => localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

export function OperationsNativeRecipientEnrollment() {
  const [session, setSession] = useState<OperationsNativeRecipientOwnerSession | null>(null);
  const [fatal, setFatal] = useState("");
  useEffect(() => {
    let mounted = true;
    void openOperationsNativeRecipientOwnerSession()
      .then(value => { if (mounted) setSession(value); })
      .catch(() => { if (mounted) setFatal("This staging-only native recipient capability is unavailable."); });
    return () => { mounted = false; };
  }, []);
  if (fatal) return <main className="onboarding-staff-gate"><Card><h1>Native recipient enrollment unavailable</h1>
    <p role="alert">{fatal}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <NativeRecipientWorkspace initialSession={session} />;
}

function NativeRecipientWorkspace({ initialSession }: { initialSession: OperationsNativeRecipientOwnerSession }) {
  const [session, setSession] = useState(initialSession);
  const [targetId, setTargetId] = useState("");
  const [clientRecordId, setClientRecordId] = useState("");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [targetReviewed, setTargetReviewed] = useState(false);
  const [issueAttempt, setIssueAttempt] = useState<OperationsNativeRecipientIssueInput | null>(null);
  const [issueKnown, setIssueKnown] = useState(false);
  const [issuedLink, setIssuedLink] = useState("");
  const [intentId, setIntentId] = useState("");
  const [review, setReview] = useState<OperationsNativeRecipientReview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [mutationAttempt, setMutationAttempt] = useState<MutationAttempt | null>(null);
  const [workspaceTargetId, setWorkspaceTargetId] = useState("");
  const [workspace, setWorkspace] = useState<OperationsNativeWorkspaceCleanupReview | null>(null);
  const [workspaceReviewed, setWorkspaceReviewed] = useState(false);
  const [cleanupReason, setCleanupReason] = useState("");
  const [cleanupAttempt, setCleanupAttempt] = useState<CleanupAttempt | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const renewSession = async () => {
    const value = await openOperationsNativeRecipientOwnerSession();
    if (mounted.current) setSession(value);
    return value;
  };
  const load = async (requestedIntentId = intentId.trim()) => {
    if (mutationAttempt) {
      setError(`Resolve the uncertain ${mutationAttempt.action} with its same operation before loading another review.`);
      return null;
    }
    if (busy || !UUID.test(requestedIntentId)) {
      setError("Enter the exact native enrollment intent ID."); return null;
    }
    setBusy("load"); setError(""); setMessage(""); setReviewed(false);
    try {
      const current = await readOperationsNativeRecipientIntent(requestedIntentId);
      setIntentId(current.intentId); setReview(current);
      setMessage("Current native recipient intent loaded after owner authorization was revalidated.");
      return current;
    } catch {
      setReview(null); setError("The exact intent could not be loaded with your current authority."); return null;
    } finally { setBusy(""); }
  };
  const issue = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || issueKnown || (!issueAttempt && !targetReviewed)) return;
    const retrying = issueAttempt !== null;
    let attempt = issueAttempt;
    if (!attempt) {
      const expiry = new Date(expiresAt);
      if (!UUID.test(targetId.trim()) || !clientRecordId.trim() || clientRecordId.trim().length > 191
        || !Number.isFinite(expiry.valueOf()) || expiry <= new Date()) {
        setError("Enter an exact target ID, bounded client record ID, and future expiration."); return;
      }
      attempt = Object.freeze({ operationId: newOperationsNativeRecipientOperationId(), targetId: targetId.trim(),
        targetClientRecordId: clientRecordId.trim(), expiresAt: expiry.toISOString() });
      setIssueAttempt(attempt);
    }
    setBusy("issue"); setError(""); setMessage("");
    try {
      const active = retrying ? await renewSession() : session;
      const result = await issueOperationsNativeRecipientIntent(active.csrfToken, attempt);
      setIssueKnown(true); setReview(result.review); setIntentId(result.review.intentId); setReviewed(false);
      if (result.opaqueToken) {
        setIssuedLink(`${active.recipientOrigin}/portal/operations-recipient-enrollment/${result.review.intentId}#${result.opaqueToken}`);
        setMessage("One-time native confirmation link issued. It grants nothing until the recipient confirms and an owner approves the exact request.");
      } else {
        setIssuedLink("");
        setError("This exact issuance is already durable, but its one-time link cannot be revealed again.");
      }
    } catch (caught) {
      if (!(caught instanceof OperationsNativeRecipientApiError) || !caught.uncertain) setIssueAttempt(null);
      setError(caught instanceof OperationsNativeRecipientApiError && caught.uncertain
        ? "Issuance outcome is uncertain. Retry the same frozen issuance; do not create another operation."
        : "Issuance was denied. Recheck the exact target, client record, and current authority.");
    } finally { setBusy(""); }
  };
  const resetIssue = () => {
    if (busy || !issueKnown) return;
    setIssueAttempt(null); setIssueKnown(false); setIssuedLink(""); setTargetId(""); setClientRecordId("");
    setExpiresAt(defaultExpiry()); setTargetReviewed(false); setError(""); setMessage("");
  };
  const act = async (action: OperationsNativeRecipientMutationAction) => {
    if (!review || busy) return;
    const retrying = mutationAttempt?.intent.intentId === review.intentId && mutationAttempt.action === action;
    if (!retrying && !reviewed) return;
    let attempt = mutationAttempt;
    if (!retrying) {
      const operationId = action === "recover" ? review.recoveryOperationId : newOperationsNativeRecipientOperationId();
      if (!operationId) {
        setError("Reload this intent to obtain its exact recoverable operation before retrying delivery."); return;
      }
      attempt = Object.freeze({ action, intent: review,
        input: Object.freeze({ operationId, expectedRevision: review.revision }) });
      setMutationAttempt(attempt);
    }
    if (!attempt) return;
    setBusy(action); setError(""); setMessage("");
    try {
      const active = retrying ? await renewSession() : session;
      const result = await mutateOperationsNativeRecipientIntent(active.csrfToken,
        attempt.intent, attempt.action, attempt.input);
      setMutationAttempt(null); setReviewed(false);
      if (result.kind === "cancel") {
        setReview(result.review);
        setMessage("The exact native enrollment intent was canceled. No recipient authority was granted.");
      } else if (result.status === "pending") {
        setReview(result.intent);
        setMessage("The durable authority command is recorded, but delivery is still pending. Reload the intent before recovery.");
        try {
          const current = await readOperationsNativeRecipientIntent(result.intent.intentId);
          setReview(current);
        } catch { /* The pending result remains visible; a later explicit load revalidates recovery. */ }
      } else {
        setReview(result.intent);
        setMessage(result.intent.state === "revoked"
          ? "The exact revocation was acknowledged by the recipient authority service."
          : "The exact recipient authority command was acknowledged. Review the current state below.");
      }
    } catch (caught) {
      const uncertain = caught instanceof OperationsNativeRecipientApiError && caught.uncertain;
      if (!uncertain) { setMutationAttempt(null); setReviewed(false); }
      setError(uncertain
        ? `The ${attempt.action} outcome is uncertain. Retry the same operation and body; its operation ID will not change.`
        : "The action was denied. Reload the exact intent and recheck your current authority.");
    } finally { setBusy(""); }
  };
  const loadWorkspace = async () => {
    const requestedTargetId = workspaceTargetId.trim();
    if (cleanupAttempt) {
      setError(`Resolve the uncertain workspace ${cleanupAttempt.action} with its same operation before loading another target.`);
      return;
    }
    if (busy || !UUID.test(requestedTargetId)) {
      setError("Enter the exact native workspace target ID."); return;
    }
    setBusy("workspace-load"); setError(""); setMessage(""); setWorkspaceReviewed(false);
    try {
      const current = await readOperationsNativeWorkspaceCleanup(requestedTargetId);
      setWorkspace(current); setWorkspaceTargetId(current.targetId);
      setMessage("Current native workspace cleanup state loaded after owner authorization was revalidated.");
    } catch {
      setWorkspace(null); setError("The exact workspace target could not be loaded with your current authority.");
    } finally { setBusy(""); }
  };
  const actWorkspace = async (action: OperationsNativeWorkspaceCleanupAction) => {
    if (!workspace || busy) return;
    const retrying = cleanupAttempt?.workspace.targetId === workspace.targetId && cleanupAttempt.action === action;
    if (!retrying && !workspaceReviewed) return;
    let attempt = cleanupAttempt;
    if (!retrying) {
      const operationId = action === "recover" ? workspace.recoveryOperationId : newOperationsNativeRecipientOperationId();
      if (!operationId) {
        setError("Reload this workspace to obtain its exact stored cleanup operation. This tool will not invent one."); return;
      }
      const reason = cleanupReason.trim();
      if (action === "revoke" && (reason.length < 1 || reason.length > 500 || reason !== cleanupReason || /\p{C}/u.test(reason))) {
        setError("Enter an exact cleanup reason of 1 to 500 characters without leading or trailing spaces."); return;
      }
      attempt = Object.freeze({ action, workspace,
        input: Object.freeze({ operationId, expectedOwnershipEpoch: workspace.ownershipEpoch,
          ...(action === "revoke" ? { reason } : {}) }) });
      setCleanupAttempt(attempt);
    }
    if (!attempt) return;
    setBusy(`workspace-${action}`); setError(""); setMessage("");
    try {
      const active = retrying ? await renewSession() : session;
      const result = await mutateOperationsNativeWorkspaceCleanup(active.csrfToken,
        attempt.workspace, attempt.action, attempt.input);
      setCleanupAttempt(null); setWorkspaceReviewed(false); setWorkspace(result.workspace);
      setMessage(result.status === "pending"
        ? "The exact workspace cleanup command is durable, but remote cleanup is still pending. Use only the stored recovery operation shown below."
        : "The exact workspace cleanup was acknowledged. This control did not create, activate, or revoke individual recipient intents.");
    } catch (caught) {
      const uncertain = caught instanceof OperationsNativeRecipientApiError && caught.uncertain;
      if (!uncertain) { setCleanupAttempt(null); setWorkspaceReviewed(false); }
      setError(uncertain
        ? `The workspace ${attempt.action} outcome is uncertain. Retry the same operation and frozen body; its operation ID will not change.`
        : "Workspace cleanup was denied. Reload the exact target and recheck your current owner authority.");
    } finally { setBusy(""); }
  };

  const heading = review ? ({ issued: "Issued native confirmation", pending: "Review native recipient",
    confirming: "Grant delivery pending", active: "Current native recipient authority",
    revoking: "Revocation delivery pending", revoked: "Revoked native recipient authority",
    cancelled: "Canceled native enrollment" } as const)[review.state] : "Load a native recipient intent";
  const pending = mutationAttempt?.intent.intentId === review?.intentId ? mutationAttempt : null;
  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" />
    <a href="/">Exit native recipient enrollment</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Staging native protocol</p>
      <h1>Operations-native recipient enrollment</h1>
      <p>Issue and review only exact existing portal targets and client records. This tool never matches a person by name or email.</p></div>
    <aside className="onboarding-staff-warning" role="status"><strong>Exact-target owner review required</strong>
      <span>Every command is pinned to one target revision, client record, recipient binding, Access issuer, and Access subject.</span></aside>

    <Card><form className="onboarding-staff-form" onSubmit={event => { event.preventDefault(); void loadWorkspace(); }}>
      <h2 className="wide">Review native workspace cleanup</h2>
      <p className="wide">This is a target-scoped cleanup control. It does not enumerate or automatically revoke recipient intents, and it cannot activate client data.</p>
      <label className="wide">Exact native workspace target ID<input value={workspaceTargetId} maxLength={36}
        disabled={Boolean(cleanupAttempt)} onChange={event => setWorkspaceTargetId(event.currentTarget.value)} required /></label>
      <button className="button-ghost wide" disabled={Boolean(busy)}>{busy === "workspace-load" ? "Loading…" : "Load exact workspace"}</button>
    </form></Card>

    {workspace && <Card><section className="onboarding-created"><h2>Native workspace cleanup state</h2>
      <dl><div><dt>Target ID</dt><dd>{workspace.targetId}</dd></div>
        <div><dt>State</dt><dd>{workspace.state}</dd></div>
        <div><dt>Ownership epoch</dt><dd>{workspace.ownershipEpoch}</dd></div>
        <div><dt>Stored recovery operation</dt><dd>{workspace.recoveryOperationId ?? "Not available"}</dd></div></dl>
      {workspace.state === "active" && !cleanupAttempt && <label>Exact cleanup reason<input value={cleanupReason} maxLength={500}
        onChange={event => setCleanupReason(event.currentTarget.value)} /></label>}
      <label><input type="checkbox" checked={workspaceReviewed} disabled={Boolean(busy) || Boolean(cleanupAttempt)}
        onChange={event => setWorkspaceReviewed(event.currentTarget.checked)} />
        I reviewed this exact target, state, ownership epoch, and stored recovery operation. I understand cleanup does not activate client data.</label>
      {cleanupAttempt
        ? <button type="button" className="button-orange" disabled={Boolean(busy)}
          onClick={() => void actWorkspace(cleanupAttempt.action)}>{busy ? "Retrying…" : `Retry same workspace ${cleanupAttempt.action}`}</button>
        : <div className="project-operational-actions">
          {workspace.state === "active" && <button type="button" className="button-danger"
            disabled={Boolean(busy) || !workspaceReviewed || cleanupReason.length < 1}
            onClick={() => void actWorkspace("revoke")}>Revoke exact native workspace</button>}
          {(workspace.state === "revoking" || workspace.state === "revoked") && workspace.recoveryOperationId
            && <button type="button" className="button-orange" disabled={Boolean(busy) || !workspaceReviewed}
              onClick={() => void actWorkspace("recover")}>Recover stored workspace cleanup</button>}
        </div>}
      {(workspace.state === "revoking" || workspace.state === "revoked") && !workspace.recoveryOperationId
        && <p>Reload after the stored cleanup operation becomes available. Recovery never creates a replacement command.</p>}
    </section></Card>}

    <Card><form className="onboarding-staff-form" onSubmit={issue}>
      <h2 className="wide">Issue native confirmation</h2>
      <label>Exact portal target ID<input value={targetId} maxLength={36} disabled={Boolean(issueAttempt)}
        onChange={event => setTargetId(event.currentTarget.value)} required /></label>
      <label>Exact client record ID<input value={clientRecordId} maxLength={191} disabled={Boolean(issueAttempt)}
        onChange={event => setClientRecordId(event.currentTarget.value)} required /></label>
      <label>Link expires at<input type="datetime-local" value={expiresAt} disabled={Boolean(issueAttempt)}
        onChange={event => setExpiresAt(event.currentTarget.value)} required /></label>
      <fieldset className="wide onboarding-target-mode"><legend>Exact target acknowledgment</legend><label>
        <input type="checkbox" checked={targetReviewed} disabled={Boolean(issueAttempt)}
          onChange={event => setTargetReviewed(event.currentTarget.checked)} />
        I verified this existing client record belongs to this exact existing portal target.</label></fieldset>
      {!issueKnown && <button className="button-orange wide" disabled={Boolean(busy) || (!issueAttempt && !targetReviewed)}>
        {busy === "issue" ? "Issuing…" : issueAttempt ? "Retry same native issuance" : "Issue native confirmation link"}</button>}
      {issueKnown && <button type="button" className="button-ghost wide" disabled={Boolean(busy)} onClick={resetIssue}>Start new native intent</button>}
    </form></Card>
    {issuedLink && <Card><section className="onboarding-created"><h2>One-time native confirmation link</h2>
      <p>This in-memory link is shown only from the first successful issuance response. Transfer it only through the approved private channel.</p>
      <div className="onboarding-secret"><output aria-label="Native portal confirmation link">{issuedLink}</output>
        <button type="button" className="button-ghost" onClick={() => void navigator.clipboard.writeText(issuedLink)}>Copy private link</button></div>
    </section></Card>}

    <Card><form className="onboarding-staff-form" onSubmit={event => { event.preventDefault(); void load(); }}>
      <h2 className="wide">Review known native intent</h2>
      <label className="wide">Exact enrollment intent ID<input value={intentId} maxLength={36}
        onChange={event => setIntentId(event.currentTarget.value)} required /></label>
      <button className="button-ghost wide" disabled={Boolean(busy)}>{busy === "load" ? "Loading…" : "Load exact intent"}</button>
    </form></Card>

    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {review && <Card><section className="onboarding-created"><h2>{heading}</h2>
      <dl><div><dt>Intent ID</dt><dd>{review.intentId}</dd></div>
        <div><dt>Target ID</dt><dd>{review.target.targetId}</dd></div>
        <div><dt>Target revision</dt><dd>{review.target.targetRevision}</dd></div>
        <div><dt>Client record</dt><dd>{review.target.clientRecordId}</dd></div>
        <div><dt>Recipient display label</dt><dd>{review.recipientLabel}</dd></div>
        <div><dt>Access issuer</dt><dd>{review.principal?.issuer ?? "Not supplied"}</dd></div>
        <div><dt>Access subject</dt><dd>{review.principal?.subject ?? "Not supplied"}</dd></div>
        <div><dt>Recipient binding</dt><dd>{review.recipientBindingId ?? "Not assigned"}</dd></div>
        <div><dt>Revision</dt><dd>{review.revision}</dd></div></dl>
      {review.state !== "revoked" && review.state !== "cancelled" && <label><input type="checkbox" checked={reviewed}
        disabled={Boolean(busy) || Boolean(pending)} onChange={event => setReviewed(event.currentTarget.checked)} />
        I reviewed the exact target, client record, recipient binding, issuer, subject, state, and revision shown above.
        The Access-asserted email label is for display only and never selects or identifies authority.</label>}
      {pending
        ? <button type="button" className="button-orange" disabled={Boolean(busy)} onClick={() => void act(pending.action)}>
          {busy ? "Retrying…" : `Retry same ${pending.action}`}</button>
        : <div className="project-operational-actions">
          {review.state === "pending" && <button type="button" className="button-orange" disabled={Boolean(busy) || !reviewed}
            onClick={() => void act("confirm")}>Confirm exact native recipient</button>}
          {(review.state === "issued" || review.state === "pending") && <button type="button" className="button-danger"
            disabled={Boolean(busy) || !reviewed} onClick={() => void act("cancel")}>Cancel native confirmation</button>}
          {review.state === "active" && <button type="button" className="button-danger" disabled={Boolean(busy) || !reviewed}
            onClick={() => void act("revoke")}>Revoke exact native recipient</button>}
          {(review.state === "confirming" || review.state === "revoking") && review.recoveryOperationId
            && <button type="button" className="button-orange" disabled={Boolean(busy) || !reviewed}
              onClick={() => void act("recover")}>Recover exact pending delivery</button>}
        </div>}
      {(review.state === "confirming" || review.state === "revoking") && !review.recoveryOperationId
        && <p>Reload after the durable recovery operation becomes available. This tool will not invent a replacement operation.</p>}
      {(review.state === "revoked" || review.state === "cancelled")
        && <p>This is a read-only audit state. Start a separately reviewed intent for any future authority change.</p>}
    </section></Card>}
  </main></div>;
}
