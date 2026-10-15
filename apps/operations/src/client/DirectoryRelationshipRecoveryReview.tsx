import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

export type RelationshipRecoveryCapability = Readonly<{ available: true; status: "needs_review"; sourceIds: readonly string[] }>;
type Review = Readonly<{ reviewId: string; recordId: string; sourceId: string; predecessorCommandId: string;
  evidenceSha256: string; clientRevision: string; organizationRevision: string; organizationRecordId: string;
  remoteParentPublicId: null; observedAuthorizationGeneration: string; expiresAt: string }>;
export type FrozenRecoveryAuthorizationAttempt = Readonly<{ authorizationId: string; successorCommandId: string;
  path: string; body: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_INT64 = "9223372036854775807";
const signedInt64 = (value: unknown): value is string => typeof value === "string" && DECIMAL.test(value)
  && (value.length < MAX_SIGNED_INT64.length || value <= MAX_SIGNED_INT64);

export function usableRelationshipRecoveryCapability(value: unknown): value is RelationshipRecoveryCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && row.available === true && row.status === "needs_review" && Array.isArray(row.sourceIds)
    && row.sourceIds.length > 0 && row.sourceIds.length <= 64
    && row.sourceIds.every(source => typeof source === "string" && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source))
    && new Set(row.sourceIds).size === row.sourceIds.length;
}

function usableReview(value: unknown, recordId: string, sourceId: string, intendedOrganizationRecordId: string): value is Review {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 11 && typeof row.reviewId === "string" && UUID.test(row.reviewId)
    && row.recordId === recordId && row.sourceId === sourceId
    && typeof row.predecessorCommandId === "string" && UUID.test(row.predecessorCommandId)
    && typeof row.evidenceSha256 === "string" && SHA256.test(row.evidenceSha256)
    && signedInt64(row.clientRevision) && signedInt64(row.organizationRevision)
    && row.organizationRecordId === intendedOrganizationRecordId
    && row.remoteParentPublicId === null && signedInt64(row.observedAuthorizationGeneration)
    && typeof row.expiresAt === "string" && Number.isFinite(Date.parse(row.expiresAt));
}

export function freezeRecoveryAuthorizationAttempt(recordId: string, review: Review, reason: string,
  randomUUID: () => string = crypto.randomUUID.bind(crypto)): FrozenRecoveryAuthorizationAttempt {
  const authorizationId = randomUUID(), successorCommandId = randomUUID();
  return Object.freeze({ authorizationId, successorCommandId,
    path: `/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship-generation-recovery/reviews/${review.reviewId}/authorize`,
    body: JSON.stringify({ evidenceSha256: review.evidenceSha256, authorizationId, successorCommandId, reason: reason.trim() }) });
}

function frozenAttemptMatchesReview(attempt: FrozenRecoveryAuthorizationAttempt, recordId: string, review: Review): boolean {
  const expectedPath = `/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship-generation-recovery/reviews/${review.reviewId}/authorize`;
  if (attempt.path !== expectedPath) return false;
  try {
    const body = JSON.parse(attempt.body) as Record<string, unknown>;
    return body.evidenceSha256 === review.evidenceSha256 && body.authorizationId === attempt.authorizationId
      && body.successorCommandId === attempt.successorCommandId;
  } catch { return false; }
}

export function DirectoryRelationshipRecoveryReview({ recordId, intendedOrganizationName, intendedOrganizationRecordId, capability }:
  { recordId: string; intendedOrganizationName: string; intendedOrganizationRecordId: string; capability: RelationshipRecoveryCapability | null }) {
  const id = useId(), [sourceId, setSourceId] = useState(capability?.sourceIds[0] ?? ""), [review, setReview] = useState<Review | null>(null);
  const [reviewBody, setReviewBody] = useState<string | null>(null), [authorization, setAuthorization] = useState<FrozenRecoveryAuthorizationAttempt | null>(null);
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [serverStatus, setServerStatus] = useState("none"), [statusLoaded, setStatusLoaded] = useState(false);
  const identity = `${recordId}\u0000${intendedOrganizationRecordId}`;
  const [activeIdentity, setActiveIdentity] = useState(identity);
  const requestGeneration = useRef(0);
  const refreshStatus = async (requestedSource = sourceId, force = false) => {
    if (busy && !force) return;
    const generation = requestGeneration.current;
    setBusy(true); setError("");
    try {
      const query = requestedSource ? `?sourceId=${encodeURIComponent(requestedSource)}` : "";
      const result = await api<unknown>(`/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship-generation-recovery/status${query}`);
      if (generation !== requestGeneration.current) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).status !== "string")
        throw new Error("Recovery status could not be verified.");
      const status = (result as Record<string, unknown>).status as string;
      if (status === "review_ready") {
        const candidate = (result as Record<string, unknown>).review;
        const candidateSource = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          && typeof (candidate as Record<string, unknown>).sourceId === "string" ? (candidate as Record<string, unknown>).sourceId as string : "";
        if (!usableReview(candidate, recordId, candidateSource, intendedOrganizationRecordId))
          throw new Error("Recovery status could not be verified.");
        setSourceId(candidateSource);
        setReview(authorization && !frozenAttemptMatchesReview(authorization, recordId, candidate) ? null : candidate);
        setServerStatus("review_ready");
      } else if (["none", "review_expired", "evidence_changed", "authority_revoked", "prepared", "dispatch_pending", "acknowledged", "terminal"].includes(status)) {
        setReview(null);
        setServerStatus(status);
      } else throw new Error("Recovery status could not be verified.");
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      if (caught instanceof ApiError && caught.status === 403) { setReview(null); setServerStatus("authority_revoked"); }
      else if (caught instanceof ApiError && caught.status === 404) { setReview(null); setServerStatus("none"); }
      else setError(caught instanceof Error ? caught.message : "Recovery status could not be loaded.");
    } finally { if (generation === requestGeneration.current) { setStatusLoaded(true); setBusy(false); } }
  };
  useEffect(() => {
    const generation = ++requestGeneration.current;
    const initialSource = capability?.sourceIds[0] ?? "";
    setActiveIdentity(identity);
    setSourceId(initialSource); setReview(null); setReviewBody(null); setAuthorization(null); setReason(""); setConfirmed(false);
    setBusy(false); setError(""); setServerStatus("none"); setStatusLoaded(false);
    void refreshStatus(initialSource, true);
    return () => { if (requestGeneration.current === generation) requestGeneration.current += 1; };
  }, [identity]);
  const openReview = async () => {
    if (busy || !sourceId) return;
    const generation = requestGeneration.current;
    const frozenBody = reviewBody ?? JSON.stringify({ sourceId });
    if (!reviewBody) setReviewBody(frozenBody);
    setBusy(true); setError("");
    try {
      const result = await api<unknown>(`/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship-generation-recovery/reviews`,
        { method: "POST", body: frozenBody });
      if (generation !== requestGeneration.current) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || (result as Record<string, unknown>).status !== "review"
        || !usableReview((result as Record<string, unknown>).review, recordId, sourceId, intendedOrganizationRecordId)) throw new Error("Recovery evidence could not be verified.");
      setReview((result as { review: Review }).review);
    } catch (caught) { if (generation === requestGeneration.current) setError(caught instanceof Error ? caught.message : "Recovery evidence could not be loaded."); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  };
  const authorize = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!review || busy || !confirmed || (!authorization && !reason.trim())) return;
    const generation = requestGeneration.current;
    const frozen = authorization ?? freezeRecoveryAuthorizationAttempt(recordId, review, reason);
    if (!authorization) setAuthorization(frozen);
    setBusy(true); setError("");
    try {
      const result = await api<unknown>(frozen.path, { method: "POST", headers: { "Idempotency-Key": frozen.authorizationId }, body: frozen.body });
      if (generation !== requestGeneration.current) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || (result as Record<string, unknown>).status !== "prepared"
        || (result as Record<string, unknown>).successorCommandId !== frozen.successorCommandId)
        throw new Error("Recovery reservation could not be verified.");
      setServerStatus("prepared");
    } catch (caught) { if (generation === requestGeneration.current) setError(caught instanceof Error ? caught.message : "Recovery could not be reserved."); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  };
  if (activeIdentity !== identity) return null;
  if (statusLoaded && !capability && serverStatus === "none" && !review && !error) return null;
  const finalStatus = ["prepared", "dispatch_pending", "acknowledged", "terminal"].includes(serverStatus);
  return <section aria-labelledby={`${id}-title`}><h3 id={`${id}-title`}>Project Alpha relationship delivery needs review</h3>
    {!review && !authorization && capability && !finalStatus && serverStatus !== "authority_revoked" && <><p>This recovery review performs fresh remote reads. It does not change the local organization relationship.</p>
      {capability.sourceIds.length > 1 && <label htmlFor={`${id}-source`}>Project Alpha destination<select id={`${id}-source`} value={sourceId}
        disabled={busy || reviewBody !== null} onChange={event => setSourceId(event.target.value)}>{capability.sourceIds.map(source => <option key={source} value={source}>{source}</option>)}</select></label>}
      <button type="button" className="button-ghost" disabled={busy} onClick={() => void openReview()}>{busy ? "Reviewing evidence…" : reviewBody ? "Retry same evidence review" : "Review generation conflict"}</button></>}
    {review && !finalStatus && <form onSubmit={event => void authorize(event)} className="client-directory-profile-form">
      <p>Local intended organization: <strong>{intendedOrganizationName}</strong> (<code>{review.organizationRecordId}</code>)</p>
      <p>Current remote organization: <strong>None</strong></p>
      <dl><dt>Client revision</dt><dd>{review.clientRevision}</dd><dt>Organization revision</dt><dd>{review.organizationRevision}</dd>
        <dt>Authorization generation</dt><dd>{review.observedAuthorizationGeneration}</dd><dt>Evidence expires</dt><dd>{review.expiresAt}</dd></dl>
      <p>Authorizing reserves a successor delivery command. It does not mutate the local profile or organization relationship.</p>
      <label htmlFor={`${id}-reason`}>Reason<textarea id={`${id}-reason`} required maxLength={500} value={reason} disabled={Boolean(authorization)} onChange={event => setReason(event.target.value)} /></label>
      <label><input type="checkbox" checked={confirmed} disabled={Boolean(authorization)} onChange={event => setConfirmed(event.target.checked)} /> I confirm the local relationship must remain unchanged and this exact recovery command may be queued.</label>
      <button className="button-orange" disabled={busy || !confirmed || (!authorization && !reason.trim())}>{busy ? "Reserving recovery…" : authorization ? "Retry same recovery reservation" : "Authorize recovery"}</button>
    </form>}
    {serverStatus === "prepared" && <p role="status">Recovery is prepared and queued for delivery. This is not a Project Alpha acknowledgement.</p>}
    {serverStatus === "dispatch_pending" && <p role="status">Recovery delivery is pending. No acknowledgement has been received.</p>}
    {serverStatus === "acknowledged" && <p role="status">Project Alpha acknowledged the recovery delivery.</p>}
    {serverStatus === "terminal" && <p role="alert">Recovery delivery ended without acknowledgement. Review current server status before taking further action.</p>}
    {serverStatus === "review_expired" && <p role="status">The sealed review expired. Start a fresh review before authorization.</p>}
    {serverStatus === "evidence_changed" && <p role="status">The sealed recovery evidence changed. A fresh review is required.</p>}
    {serverStatus === "authority_revoked" && <p role="status">Current recovery authority is no longer available.</p>}
    {authorization && !review && !finalStatus && <p role="alert">The previous authorization attempt remains frozen and cannot be retried against stale evidence. Refresh the page to resolve current server status before starting another review.</p>}
    {statusLoaded && (serverStatus !== "none" || Boolean(review) || Boolean(authorization)) && <button type="button" className="button-ghost" disabled={busy}
      onClick={() => void refreshStatus()}>{busy ? "Refreshing status…" : "Refresh recovery status"}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
