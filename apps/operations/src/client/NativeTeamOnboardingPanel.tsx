import { useEffect, useRef, useState, type FormEvent } from "react";
import { createNativeTeamApi, NativeTeamApiError } from "./native-team-api";
import { nativeStaffInvitationUrl } from "./native-staff-onboarding-link";

type CreateBody = Readonly<{ commandId: string; loginEmail: string; displayName: string; expiresAt: string; reason: string }>;
type ApproveBody = Readonly<{ commandId: string; onboardingId: string; expectedVersion: 2; proposalSha256: string; claimEvidenceSha256: string; reason: string }>;
type CancelBody = Readonly<{ commandId: string; onboardingId: string; expectedVersion: 1 | 2; reason: string }>;
type Operation = Readonly<{ kind: "create"; body: CreateBody } | { kind: "approve"; body: ApproveBody } | { kind: "cancel"; body: CancelBody }>;
type OnboardingState = "pending" | "claimed" | "approved" | "cancelled" | "expired";
type ActiveInvite = { commandId?: string; onboardingId: string; proposedStaffId: string; state: OnboardingState; version: 1 | 2 | 3 };
type Review = {
  onboardingId: string; proposedStaffId: string; state: "claimed"; version: 2; loginEmail: string;
  displayName: string; expiresAt: string; claimedAccessSubject: string; claimEvidenceSha256: string;
  proposalSha256: string; proposal: { memberships: readonly unknown[]; directoryGrants: readonly unknown[]; managementGrants: readonly unknown[] };
  createdByStaffId: string; reason: string;
};

const api = createNativeTeamApi();
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const localDateTime = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const messageFor = (cause: unknown, action: string) => {
  if (!(cause instanceof NativeTeamApiError)) return `${action} could not be completed. Check the current state before starting another operation.`;
  if (cause.code === "setup_required") return "Native staff onboarding is unavailable or turned off for this account.";
  if (cause.code === "not_found") return "The invitation could not be found, or this onboarding operation is unavailable.";
  if (cause.code === "denied" || cause.code === "ended") return "Access was denied or your staff session ended. No permission fallback was attempted.";
  if (cause.code === "conflict") return "The onboarding record changed. Reload or review the current record before creating a new command.";
  return `${action} could not be completed. Check the current state before starting another operation.`;
};

export function NativeTeamOnboardingPanel({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [expiresAt, setExpiresAt] = useState(() => localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [createReason, setCreateReason] = useState("");
  const [reviewId, setReviewId] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [activeInvite, setActiveInvite] = useState<ActiveInvite | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [invitationLink, setInvitationLink] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const pending = useRef<Operation | null>(null);
  const uncertain = useRef(false);
  const activeOperation = useRef(false);
  const revealFlight = useRef(false);
  const reviewFlight = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const secret = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; epoch.current++;
      secret.current = null;
    };
  }, []);

  const clearInvitation = () => {
    secret.current = null;
    setInvitationLink("");
  };

  const notifyChanged = async () => {
    try { await onChanged(); } catch { /* The committed receipt is authoritative; callers may refresh separately. */ }
  };

  const run = async (operation: Operation) => {
    if (activeOperation.current || revealFlight.current || reviewFlight.current || !mounted.current) return;
    activeOperation.current = true;
    const currentEpoch = epoch.current;
    const current = () => mounted.current && epoch.current === currentEpoch;
    setBusy(true); setError(""); setStatus(operation.kind === "create" ? "Creating invitation…" : operation.kind === "approve" ? "Approving claimed invitation…" : "Cancelling invitation…");
    try {
      if (operation.kind === "create") {
        const result = await api.onboardingCreate(operation.body, undefined, uncertain.current);
        if (!current()) return;
        pending.current = null; uncertain.current = false;
        const state = result.receipt.state;
        setActiveInvite({ commandId: result.receipt.commandId, onboardingId: result.receipt.onboardingId, proposedStaffId: result.receipt.proposedStaffId,
          state, version: state === "claimed" ? 2 : state === "approved" || state === "cancelled" || state === "expired" ? 3 : 1 });
        setReview(null); setReviewId(result.receipt.onboardingId); clearInvitation();
        setCreateReason("");
        setStatus(Date.parse(operation.body.expiresAt) <= Date.now()
          ? "The original invitation was found, but its expiry has passed. No duplicate was created or renewed. An authorized administrator must review its retained record."
          : result.receipt.replayed ? `This command is already ${state}. No permissions were granted.`
          : "Invitation created. No permissions were granted. Reveal the invitation link only when you are ready to share it.");
      } else if (operation.kind === "approve") {
        const result = await api.onboardingApprove(operation.body);
        if (!current()) return;
        pending.current = null; uncertain.current = false;
        setActiveInvite(currentInvite => currentInvite?.onboardingId === result.receipt.onboardingId
          ? { ...currentInvite, state: "approved", version: 3 } : currentInvite);
        setReview(null); setReviewReason(""); clearInvitation();
        setStatus("Invitation approved. No operational permissions were granted; access reconciliation is pending.");
      } else {
        const result = await api.onboardingCancel(operation.body);
        if (!current()) return;
        pending.current = null; uncertain.current = false;
        setActiveInvite(currentInvite => currentInvite?.onboardingId === result.receipt.onboardingId
          ? { ...currentInvite, state: "cancelled", version: result.receipt.resultVersion } : currentInvite);
        setReview(null); clearInvitation();
        setStatus("Invitation cancelled. No permissions were granted.");
      }
      await notifyChanged();
    } catch (cause) {
      if (!current()) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      if (e?.outcome === "unknown" || uncertain.current) {
        pending.current = operation; uncertain.current = true;
        setStatus("");
        setError("The outcome is unresolved. Reload or review the invitation, then retry only this exact command with the original ID and details. A read-only reload does not prove whether it committed.");
      } else {
        pending.current = null;
        setStatus("");
        setError(messageFor(cause, operation.kind === "create" ? "Invitation creation" : operation.kind === "approve" ? "Approval" : "Cancellation"));
      }
    } finally {
      if (current()) { activeOperation.current = false; setBusy(false); }
    }
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (activeOperation.current || reviewFlight.current || revealFlight.current || pending.current
      || activeInvite?.state === "pending" || activeInvite?.state === "claimed") return;
    const expiry = new Date(expiresAt).getTime(), now = Date.now();
    if (!displayName.trim() || !loginEmail.trim() || !createReason.trim() || !Number.isFinite(expiry)
      || expiry < now + 60_000 || expiry > now + MAX_AGE_MS) {
      setError("Enter a name, login email, reason, and expiry at least one minute from now and within the next seven days."); return;
    }
    const body = Object.freeze({ commandId: crypto.randomUUID(), loginEmail: loginEmail.trim().toLowerCase(), displayName: displayName.trim(),
      expiresAt: new Date(expiry).toISOString(), reason: createReason.trim() });
    const operation: Operation = Object.freeze({ kind: "create", body });
    pending.current = operation; uncertain.current = false;
    void run(operation);
  };

  const reveal = async () => {
    if (!activeInvite?.commandId || revealFlight.current || reviewFlight.current || activeOperation.current || busy || pending.current) return;
    const requestEpoch = epoch.current;
    revealFlight.current = true;
    setRevealing(true); setRevealError("");
    try {
      const value = await api.onboardingReveal(activeInvite.commandId);
      if (!mounted.current || epoch.current !== requestEpoch) return;
      if (value.onboardingId !== activeInvite.onboardingId) throw new Error("Invitation identity did not match.");
      const link = nativeStaffInvitationUrl(window.location.origin, { onboardingId: value.onboardingId, invitationSecret: value.invitationSecret });
      secret.current = value.invitationSecret;
      setInvitationLink(link);
      setRevealError("");
    } catch {
      if (mounted.current && epoch.current === requestEpoch) setRevealError("The invitation link could not be revealed. Try revealing again for this same invitation command.");
    } finally { revealFlight.current = false; if (mounted.current && epoch.current === requestEpoch) setRevealing(false); }
  };

  const loadReview = async () => {
    const id = reviewId.trim();
    const pendingId = pending.current?.kind === "approve" || pending.current?.kind === "cancel" ? pending.current.body.onboardingId : null;
    if (!id || busy || activeOperation.current || revealFlight.current || reviewFlight.current || unresolved && (!pendingId || id !== pendingId)
      || (activeInvite?.state === "pending" || activeInvite?.state === "claimed") && id !== activeInvite.onboardingId) return;
    const requestEpoch = epoch.current;
    reviewFlight.current = true;
    setReviewLoading(true); setReview(null); setError(""); setStatus("");
    try {
      const value = await api.onboardingReview(id);
      if (!mounted.current || epoch.current !== requestEpoch) return;
      const aclEmpty = value.proposal.memberships.length === 0 && value.proposal.directoryGrants.length === 0 && value.proposal.managementGrants.length === 0;
      setReview(value);
      if (!aclEmpty) setError("This invitation does not have an empty permission proposal, so approval is disabled.");
      setActiveInvite({ onboardingId: value.onboardingId, proposedStaffId: value.proposedStaffId, state: "claimed", version: 2 });
      setReviewReason(""); setCancelReason(""); clearInvitation();
    } catch (cause) {
      if (!mounted.current || epoch.current !== requestEpoch) return;
      setError(messageFor(cause, "Invitation review"));
    } finally { reviewFlight.current = false; if (mounted.current && epoch.current === requestEpoch) setReviewLoading(false); }
  };

  const submitApprove = () => {
    if (!review || busy || activeOperation.current || reviewFlight.current || revealFlight.current || pending.current || !reviewReason.trim()) return;
    const emptyAcl = review.proposal.memberships.length === 0 && review.proposal.directoryGrants.length === 0 && review.proposal.managementGrants.length === 0;
    if (!emptyAcl) { setError("Approval is disabled because the permission proposal is not empty."); return; }
    const body: ApproveBody = Object.freeze({ commandId: crypto.randomUUID(), onboardingId: review.onboardingId,
      expectedVersion: 2, proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256, reason: reviewReason.trim() });
    const operation: Operation = Object.freeze({ kind: "approve", body });
    pending.current = operation; uncertain.current = false;
    void run(operation);
  };

  const submitCancel = () => {
    if (!activeInvite || busy || activeOperation.current || reviewFlight.current || revealFlight.current || pending.current || !cancelReason.trim()
      || activeInvite.state !== "pending" && activeInvite.state !== "claimed") return;
    const body: CancelBody = Object.freeze({ commandId: crypto.randomUUID(), onboardingId: activeInvite.onboardingId,
      expectedVersion: activeInvite.state === "pending" ? 1 : 2, reason: cancelReason.trim() });
    const operation: Operation = Object.freeze({ kind: "cancel", body });
    pending.current = operation; uncertain.current = false;
    void run(operation);
  };

  const retry = () => { if (pending.current) void run(pending.current); };
  const unresolved = pending.current !== null;
  const pendingOnboardingId = pending.current?.kind === "approve" || pending.current?.kind === "cancel" ? pending.current.body.onboardingId : null;
  const canReview = !unresolved || !!pendingOnboardingId && reviewId.trim() === pendingOnboardingId;
  const activeUnresolvedInvite = activeInvite?.state === "pending" || activeInvite?.state === "claimed";
  const maxExpiry = localDateTime(new Date(Date.now() + MAX_AGE_MS));
  const closePanel = () => {
    if (busy || activeOperation.current || revealFlight.current || reviewFlight.current) return;
    clearInvitation(); epoch.current++; revealFlight.current = false; reviewFlight.current = false;
    setRevealing(false); setReviewLoading(false); setOpen(false);
  };

  return <section aria-label="Native staff onboarding" aria-busy={busy || reviewLoading || revealing}>
    <h3>Employee onboarding</h3>
    <p>Test employee invitations in staging. Creating an invitation reserves a pending record; a verified email claim must be reviewed and approved separately. No operational permissions are granted.</p>
    {!open && <button type="button" className="button-orange" onClick={() => { clearInvitation(); setOpen(true); }}>Add employee</button>}
    {open && <div>
      <button type="button" className="button-ghost" disabled={busy || revealing || reviewLoading || activeOperation.current || revealFlight.current || reviewFlight.current} onClick={() => { closePanel(); setRevealError(""); }}>Close onboarding panel</button>
      <form onSubmit={submitCreate}>
        <h4>Create invitation</h4>
        <label>Employee display name<input value={displayName} maxLength={160} required disabled={busy || unresolved || activeUnresolvedInvite} onChange={event => setDisplayName(event.target.value)} /></label>
        <label>Login email<input type="email" value={loginEmail} maxLength={254} required disabled={busy || unresolved || activeUnresolvedInvite} onChange={event => setLoginEmail(event.target.value)} /></label>
        <label>Invitation expires
          <input type="datetime-local" value={expiresAt} max={maxExpiry} required disabled={busy || unresolved || activeUnresolvedInvite} onChange={event => setExpiresAt(event.target.value)} />
        </label>
        <label>Reason<textarea value={createReason} maxLength={500} required disabled={busy || unresolved || activeUnresolvedInvite} onChange={event => setCreateReason(event.target.value)} /></label>
        <button type="submit" className="button-orange" disabled={busy || unresolved || activeUnresolvedInvite || !displayName.trim() || !loginEmail.trim() || !createReason.trim()}>Create invitation</button>
      </form>

      <h4>Review claimed invitation</h4>
      <label>Onboarding ID<input value={reviewId} maxLength={64} disabled={busy || reviewLoading || unresolved || activeUnresolvedInvite && reviewId.trim() !== activeInvite?.onboardingId} onChange={event => setReviewId(event.target.value)} /></label>
      <button type="button" className="button-ghost" disabled={busy || reviewLoading || !reviewId.trim() || !canReview
        || activeUnresolvedInvite && reviewId.trim() !== activeInvite?.onboardingId} onClick={() => void loadReview()}>
        {reviewLoading ? "Loading review…" : "Review invitation"}
      </button>

      {activeInvite && <div>
        <h4>Invitation status</h4>
        <dl><dt>Onboarding ID</dt><dd>{activeInvite.onboardingId}</dd><dt>Proposed staff ID</dt><dd>{activeInvite.proposedStaffId}</dd><dt>Status</dt><dd>{activeInvite.state}</dd></dl>
        {activeInvite.state === "pending" && <>
          {!invitationLink
            ? <button type="button" className="button-orange" disabled={busy || revealing || unresolved || !activeInvite.commandId} onClick={() => void reveal()}>{revealing ? "Revealing invitation…" : "Reveal invitation link"}</button>
            : <div><label>Invitation link (sensitive)<input readOnly value={invitationLink} /></label>
              <button type="button" className="button-ghost" onClick={clearInvitation}>Hide invitation link</button></div>}
        </>}
        {(activeInvite.state === "pending" || activeInvite.state === "claimed") && <>
          <label>Reason for cancellation<textarea value={cancelReason} maxLength={500} required disabled={busy || unresolved} onChange={event => setCancelReason(event.target.value)} /></label>
          <button type="button" className="button-ghost" disabled={busy || unresolved || !cancelReason.trim()} onClick={submitCancel}>Cancel invitation</button>
        </>}
      </div>}

      {review && <div>
        <h4>Verified claim review</h4>
        <dl>
          <dt>Display name</dt><dd>{review.displayName}</dd>
          <dt>Verified login email</dt><dd>{review.loginEmail}</dd>
          <dt>Expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd>
          <dt>Invitation reason</dt><dd>{review.reason}</dd>
          <dt>Permission proposal</dt><dd>{review.proposal.memberships.length === 0 && review.proposal.directoryGrants.length === 0 && review.proposal.managementGrants.length === 0 ? "Empty: no memberships or grants" : "Not empty; approval disabled"}</dd>
        </dl>
        <p>Approval creates no operational permissions. Access reconciliation remains a separate pending step.</p>
        <label>Reason for approval<textarea value={reviewReason} maxLength={500} required disabled={busy || unresolved} onChange={event => setReviewReason(event.target.value)} /></label>
        <button type="button" className="button-orange" disabled={busy || unresolved || !reviewReason.trim()
          || review.proposal.memberships.length !== 0 || review.proposal.directoryGrants.length !== 0 || review.proposal.managementGrants.length !== 0}
          onClick={submitApprove}>Approve verified claim</button>
      </div>}

      {unresolved && <div className="notice error" role="alert">
        <p>This exact command is unresolved. Do not edit or replace it. Read-only review does not prove whether it committed.</p>
        <button type="button" className="button-orange" disabled={busy} onClick={retry}>Retry same command</button>
      </div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {revealError && <div className="notice error" role="alert">{revealError}</div>}
      {status && <div className="notice" role="status">{status}</div>}
    </div>}
  </section>;
}
