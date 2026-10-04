import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Card, Loading } from "@ltds/ui";
import { grantOperationsNativeDeliveryAuthority, listOperationsNativeDeliveryAuthorities,
  listOperationsNativeDeliveryCandidates,
  newOperationsNativeDeliveryOperationId, openOperationsNativeDeliveryOwnerSession,
  OPERATIONS_NATIVE_DELIVERY_FEATURES, OperationsNativeDeliveryOwnerApiError,
  readOperationsNativeDeliveryAuthority, recoverOperationsNativeDeliveryAuthority,
  revokeOperationsNativeDeliveryAuthority, type OperationsNativeDeliveryAuthority,
  type OperationsNativeDeliveryCandidate, type OperationsNativeDeliveryFeature,
  type OperationsNativeDeliveryGrantInput, type OperationsNativeDeliveryOwnerSession,
  type OperationsNativeDeliveryRecoverInput, type OperationsNativeDeliveryRevokeInput }
  from "./operations-native-delivery-owner-api";
import "./ClientOnboardingStaff.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type Attempt = Readonly<
  | { kind: "grant"; candidate: OperationsNativeDeliveryCandidate; input: OperationsNativeDeliveryGrantInput }
  | { kind: "revoke"; authority: OperationsNativeDeliveryAuthority; input: OperationsNativeDeliveryRevokeInput }
  | { kind: "recover"; authority: OperationsNativeDeliveryAuthority; input: OperationsNativeDeliveryRecoverInput }
>;

function localDateTime(date: Date) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}
const defaultExpiry = () => localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

export function OperationsNativeDeliveryAuthority() {
  const [session, setSession] = useState<OperationsNativeDeliveryOwnerSession | null>(null);
  const [fatal, setFatal] = useState("");
  useEffect(() => {
    let mounted = true;
    void openOperationsNativeDeliveryOwnerSession()
      .then(value => { if (mounted) setSession(value); })
      .catch(() => { if (mounted) setFatal("This staging-only native delivery authority capability is unavailable."); });
    return () => { mounted = false; };
  }, []);
  if (fatal) return <main className="onboarding-staff-gate"><Card><h1>Native delivery authority unavailable</h1>
    <p role="alert">{fatal}</p><a className="button-ghost" href="/">Return to Operations</a></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <NativeDeliveryAuthorityWorkspace initialSession={session} />;
}

function NativeDeliveryAuthorityWorkspace({ initialSession }: { initialSession: OperationsNativeDeliveryOwnerSession }) {
  const [session, setSession] = useState(initialSession);
  const [targetId, setTargetId] = useState("");
  const [candidates, setCandidates] = useState<readonly OperationsNativeDeliveryCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<OperationsNativeDeliveryCandidate | null>(null);
  const [authorities, setAuthorities] = useState<readonly OperationsNativeDeliveryAuthority[]>([]);
  const [nextAuthorityCursor, setNextAuthorityCursor] = useState<string | null>(null);
  const [features, setFeatures] = useState<readonly OperationsNativeDeliveryFeature[]>([...OPERATIONS_NATIVE_DELIVERY_FEATURES]);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [grantReason, setGrantReason] = useState("");
  const [grantReviewed, setGrantReviewed] = useState(false);
  const [authorityId, setAuthorityId] = useState("");
  const [authority, setAuthority] = useState<OperationsNativeDeliveryAuthority | null>(null);
  const [authorityRead, setAuthorityRead] = useState(false);
  const [authorityReviewed, setAuthorityReviewed] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [recoveryReason, setRecoveryReason] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const renewSession = async () => {
    const value = await openOperationsNativeDeliveryOwnerSession();
    if (mounted.current) setSession(value);
    return value;
  };
  const clearPrivateReview = () => {
    setCandidates([]); setNextCursor(null); setCandidate(null); setAuthorities([]); setNextAuthorityCursor(null);
    setAuthority(null); setAuthorityId(""); setAuthorityRead(false);
    setGrantReviewed(false); setAuthorityReviewed(false);
  };
  const isScopeDenial = (caught: unknown) => caught instanceof OperationsNativeDeliveryOwnerApiError
    && [401, 403, 404, 410].includes(caught.status);
  const blockedByAttempt = () => {
    if (!attempt) return false;
    setError(`Resolve the uncertain ${attempt.kind} with its exact frozen operation before changing the reviewed scope.`);
    return true;
  };
  const loadCandidates = async (cursor: string | null = null) => {
    const requestedTargetId = targetId.trim();
    if (blockedByAttempt()) return;
    if (busy || !UUID.test(requestedTargetId)) {
      setError("Enter the exact lowercase native portal target ID."); return;
    }
    setBusy(cursor ? "candidate-more" : "candidate-load"); setError(""); setMessage("");
    if (!cursor) {
      setCandidates([]); setNextCursor(null); setCandidate(null); setAuthorities([]); setNextAuthorityCursor(null);
      setAuthority(null); setAuthorityRead(false); setGrantReviewed(false); setAuthorityReviewed(false);
    }
    try {
      const [page, authorityPage] = await Promise.all([listOperationsNativeDeliveryCandidates(requestedTargetId, cursor),
        cursor ? Promise.resolve(null) : listOperationsNativeDeliveryAuthorities(requestedTargetId)]);
      const combined = cursor ? [...candidates, ...page.items] : [...page.items];
      const pairs = new Set<string>(), fingerprints = new Set<string>();
      for (const item of combined) {
        const pair = `${item.recipientBindingId}\u0000${item.folderReservationId}`;
        if (pairs.has(pair) || fingerprints.has(item.candidateFingerprint))
          throw new OperationsNativeDeliveryOwnerApiError(503, true);
        pairs.add(pair); fingerprints.add(item.candidateFingerprint);
      }
      setCandidates(combined);
      setNextCursor(page.page.nextCursor);
      if (authorityPage) {
        setAuthorities(authorityPage.items); setNextAuthorityCursor(authorityPage.page.nextCursor);
      }
      setMessage(page.items.length
        ? "Current candidate pairs loaded. Select and review one exact recipient binding and folder reservation."
        : "No currently grantable recipient-binding and folder-reservation pair was returned.");
    } catch (caught) {
      if (isScopeDenial(caught)) clearPrivateReview();
      setError("Current candidates could not be loaded with your owner authority.");
    }
    finally { setBusy(""); }
  };
  const loadMoreAuthorities = async () => {
    const requestedTargetId = targetId.trim(), cursor = nextAuthorityCursor;
    if (!cursor || blockedByAttempt() || busy || !UUID.test(requestedTargetId)) return;
    setBusy("authority-more"); setError(""); setMessage("");
    try {
      const page = await listOperationsNativeDeliveryAuthorities(requestedTargetId, cursor);
      const combined = [...authorities, ...page.items], ids = new Set<string>();
      for (const item of combined) {
        if (ids.has(item.authorityId)) throw new OperationsNativeDeliveryOwnerApiError(503, true);
        ids.add(item.authorityId);
      }
      setAuthorities(combined); setNextAuthorityCursor(page.page.nextCursor);
    } catch (caught) {
      if (isScopeDenial(caught)) clearPrivateReview();
      setError("Current authorities could not be loaded with your owner authority.");
    } finally { setBusy(""); }
  };
  const selectCandidate = (value: OperationsNativeDeliveryCandidate) => {
    if (attempt) return;
    setCandidate(value); setAuthority(null); setAuthorityRead(false); setAuthorityId(""); setGrantReviewed(false);
    setFeatures([...OPERATIONS_NATIVE_DELIVERY_FEATURES]); setExpiresAt(defaultExpiry()); setGrantReason("");
    setMessage("Exact candidate selected. Review every identifier, feature, expiry, and reason before granting.");
    setError("");
  };
  const loadAuthority = async (event?: FormEvent) => {
    event?.preventDefault();
    const requestedAuthorityId = authorityId.trim();
    if (blockedByAttempt()) return;
    if (busy || !UUID.test(requestedAuthorityId)) { setError("Enter the exact native delivery authority ID."); return; }
    setBusy("authority-load"); setError(""); setMessage(""); setAuthorityReviewed(false);
    try {
      const value = await readOperationsNativeDeliveryAuthority(requestedAuthorityId);
      setAuthority(value); setAuthorityRead(true); setAuthorityId(value.authorityId);
      setMessage("Current authority and transport state loaded after owner authorization was revalidated.");
    } catch (caught) {
      if (isScopeDenial(caught)) clearPrivateReview(); else { setAuthority(null); setAuthorityRead(false); }
      setError("The exact authority could not be loaded with your current owner authority.");
    }
    finally { setBusy(""); }
  };
  const selectAuthority = async (value: OperationsNativeDeliveryAuthority) => {
    if (blockedByAttempt() || busy) return;
    setAuthorityId(value.authorityId); setBusy("authority-load"); setError(""); setMessage("");
    setAuthorityReviewed(false);
    try {
      const current = await readOperationsNativeDeliveryAuthority(value.authorityId);
      setAuthority(current); setAuthorityRead(true);
      setMessage("The selected current authority was reread after owner authorization was revalidated.");
    } catch (caught) {
      if (isScopeDenial(caught)) clearPrivateReview(); else { setAuthority(null); setAuthorityRead(false); }
      setError("The selected authority could not be reread with your current owner authority.");
    } finally { setBusy(""); }
  };
  const execute = async (current: Attempt, retrying: boolean) => {
    setBusy(current.kind); setError(""); setMessage("");
    try {
      const active = retrying ? await renewSession() : session;
      const result = current.kind === "grant"
        ? await grantOperationsNativeDeliveryAuthority(active.csrfToken, current.input)
        : current.kind === "revoke"
          ? await revokeOperationsNativeDeliveryAuthority(active.csrfToken, current.authority, current.input)
          : await recoverOperationsNativeDeliveryAuthority(active.csrfToken, current.authority, current.input);
      setAttempt(null); setGrantReviewed(false); setAuthorityReviewed(false);
      if (result.status === "rejected") {
        if (current.kind === "grant") { setCandidate(null); setCandidates([]); setNextCursor(null); }
        else { setAuthority(null); setAuthorityRead(false); setAuthorities([]); setNextAuthorityCursor(null); }
        setError("The frozen operation was rejected. Reload current review state; this tool will not silently replace it.");
        return;
      }
      setAuthority(result.authority); setAuthorityRead(false); setAuthorityId(result.authority.authorityId);
      setAuthorities(current => current.some(item => item.authorityId === result.authority.authorityId)
        ? current.map(item => item.authorityId === result.authority.authorityId ? result.authority : item)
        : [result.authority, ...current]);
      setMessage(result.status === "pending"
        ? "The operation is durable, but delivery is pending. Reload this authority before an explicit recovery."
        : `${current.kind === "revoke" ? "Revocation" : current.kind === "recover" ? "Recovery" : "Grant"} delivery was acknowledged.`);
    } catch (caught) {
      const uncertain = caught instanceof OperationsNativeDeliveryOwnerApiError && caught.uncertain;
      if (!uncertain) { setAttempt(null); setGrantReviewed(false); setAuthorityReviewed(false); }
      if (isScopeDenial(caught)) clearPrivateReview();
      if (caught instanceof OperationsNativeDeliveryOwnerApiError && caught.status === 409 && current.kind === "grant") {
        setCandidate(null); setCandidates([]); setNextCursor(null);
      }
      setError(uncertain
        ? `The ${current.kind} outcome is uncertain. Retry the same frozen operation and body; no replacement ID will be created.`
        : caught instanceof OperationsNativeDeliveryOwnerApiError && caught.status === 409 && current.kind === "grant"
          ? "The reviewed candidate is stale. Reload candidates and perform a new explicit review; no grant was substituted."
          : `The ${current.kind} was denied. Reload current state and recheck owner authority.`);
    } finally { setBusy(""); }
  };
  const grant = async () => {
    if (!candidate || busy || (!attempt && !grantReviewed)) return;
    if (attempt) { if (attempt.kind === "grant") await execute(attempt, true); return; }
    const expiry = new Date(expiresAt), reasonCode = grantReason.trim();
    if (!features.length || !Number.isFinite(expiry.valueOf()) || expiry <= new Date()
      || expiry.valueOf() > Date.now() + 30 * 86_400_000 || reasonCode !== grantReason
      || reasonCode.length < 1 || reasonCode.length > 200 || /\p{C}/u.test(reasonCode)) {
      setError("Select at least one feature, a future expiry within 30 days, and an exact reason of 1 to 200 characters."); return;
    }
    const current = Object.freeze({ kind: "grant", candidate,
      input: Object.freeze({ operationId: newOperationsNativeDeliveryOperationId(),
        authorityId: newOperationsNativeDeliveryOperationId(), recipientBindingId: candidate.recipientBindingId,
        folderReservationId: candidate.folderReservationId, expectedRevision: 0 as const,
        expectedCandidateFingerprint: candidate.candidateFingerprint, features: Object.freeze([...features]),
        expiresAt: expiry.toISOString(), reasonCode }) }) satisfies Attempt;
    setAttempt(current); await execute(current, false);
  };
  const actAuthority = async (kind: "revoke" | "recover") => {
    if (!authority || busy || (!attempt && !authorityReviewed)) return;
    if (attempt) { if (attempt.kind === kind) await execute(attempt, true); return; }
    const reason = (kind === "revoke" ? revokeReason : recoveryReason).trim();
    const maximum = kind === "revoke" ? 200 : 500;
    if (reason.length < 1 || reason.length > maximum
      || reason !== (kind === "revoke" ? revokeReason : recoveryReason) || /\p{C}/u.test(reason)) {
      setError(`Enter an exact ${kind} reason of 1 to ${maximum} characters.`); return;
    }
    if (kind === "recover" && !authority.recoveryOperationId) {
      setError("Reload this authority to obtain its exact server-stored recovery operation."); return;
    }
    const current: Attempt = kind === "revoke"
      ? Object.freeze({ kind, authority, input: Object.freeze({ operationId: newOperationsNativeDeliveryOperationId(),
        expectedRevision: authority.revision, reasonCode: reason }) })
      : Object.freeze({ kind, authority, input: Object.freeze({ invocationId: newOperationsNativeDeliveryOperationId(),
        operationId: authority.recoveryOperationId!, expectedRevision: authority.revision, reason }) });
    setAttempt(current); await execute(current, false);
  };
  const toggleFeature = (feature: OperationsNativeDeliveryFeature, checked: boolean) => {
    if (attempt) return;
    setFeatures(OPERATIONS_NATIVE_DELIVERY_FEATURES.filter(value => value === feature ? checked : features.includes(value)));
    setGrantReviewed(false);
  };

  return <div className="onboarding-staff-shell"><header><Brand product="Operations" name="Ledge Top" />
    <a href="/">Exit native delivery authority</a></header><main>
    <div className="onboarding-staff-heading"><p className="eyebrow">Staging native protocol</p>
      <h1>Operations-native delivery authority</h1>
      <p>Review an exact recipient-binding and folder-reservation pair. This tool never grants financial authority and never reveals storage or identity credentials.</p></div>
    <aside className="onboarding-staff-warning" role="status"><strong>Explicit review and immutable retry</strong>
      <span>Pending, acknowledged, and dead transport states are reported honestly. Feature changes require explicit revoke and separate reissue.</span></aside>

    <Card><form className="onboarding-staff-form" onSubmit={event => { event.preventDefault(); void loadCandidates(); }}>
      <h2 className="wide">Find current candidate pairs</h2>
      <label className="wide">Exact native portal target ID<input value={targetId} maxLength={36}
        disabled={Boolean(attempt)} onChange={event => { setTargetId(event.currentTarget.value); clearPrivateReview(); }} required /></label>
      <button className="button-ghost wide" disabled={Boolean(busy)}>{busy === "candidate-load" ? "Loading…" : "Load current candidates"}</button>
    </form></Card>
    {candidates.length > 0 && <Card><section className="onboarding-created"><h2>Candidate recipient and folder pairs</h2>
      {candidates.map(item => <article key={item.candidateFingerprint}><h3>{item.recipientLabel} · {item.folderLabel}</h3>
        <dl><div><dt>Client</dt><dd>{item.clientLabel} ({item.targetClientRecordId})</dd></div>
          <div><dt>Recipient binding</dt><dd>{item.recipientBindingId}</dd></div>
          <div><dt>Project</dt><dd>{item.projectLabel} ({item.externalProjectId})</dd></div>
          <div><dt>Folder reservation</dt><dd>{item.folderReservationId}</dd></div>
          <div><dt>Portal target / revision</dt><dd>{item.targetId} / {item.targetRevision}</dd></div>
          <div><dt>Publication / folder revision</dt><dd>{item.publicationRevision} / {item.folderReservationRevision}</dd></div></dl>
        <button type="button" className="button-ghost" disabled={Boolean(busy) || Boolean(attempt)}
          onClick={() => selectCandidate(item)}>Review this exact pair</button></article>)}
      {nextCursor && <button type="button" className="button-ghost" disabled={Boolean(busy) || Boolean(attempt)}
        onClick={() => void loadCandidates(nextCursor)}>{busy === "candidate-more" ? "Loading…" : "Load more candidates"}</button>}
    </section></Card>}

    {authorities.length > 0 && <Card><section className="onboarding-created"><h2>Current delivery authorities</h2>
      <p>Select a labeled authority to reread its exact current revision and transport state before any action.</p>
      {authorities.map(item => <article key={item.authorityId}><h3>{item.recipientLabel} · {item.folderLabel}</h3>
        <dl><div><dt>Client</dt><dd>{item.clientLabel} ({item.targetClientRecordId})</dd></div>
          <div><dt>Project</dt><dd>{item.projectLabel} ({item.externalProjectId})</dd></div>
          <div><dt>Authority / revision</dt><dd>{item.authorityId} / {item.revision}</dd></div>
          <div><dt>Recipient / folder</dt><dd>{item.recipientBindingId} / {item.folderReservationId}</dd></div>
          <div><dt>State / transport</dt><dd>{item.state} / {item.transportStatus}</dd></div></dl>
        <button type="button" className="button-ghost" disabled={Boolean(busy) || Boolean(attempt)}
          onClick={() => void selectAuthority(item)}>Review current authority</button></article>)}
      {nextAuthorityCursor && <button type="button" className="button-ghost" disabled={Boolean(busy) || Boolean(attempt)}
        onClick={() => void loadMoreAuthorities()}>{busy === "authority-more" ? "Loading…" : "Load more authorities"}</button>}
    </section></Card>}

    {candidate && <Card><section className="onboarding-created"><h2>Review exact delivery grant</h2>
      <p><strong>{candidate.recipientLabel}</strong> ({candidate.recipientBindingId}) to <strong>{candidate.folderLabel}</strong> ({candidate.folderReservationId})</p>
      <fieldset><legend>Permitted delivery features</legend>{OPERATIONS_NATIVE_DELIVERY_FEATURES.map(feature => <label key={feature}>
        <input type="checkbox" checked={features.includes(feature)} disabled={Boolean(attempt)}
          onChange={event => toggleFeature(feature, event.currentTarget.checked)} />{feature}</label>)}</fieldset>
      <label>Authority expires at<input type="datetime-local" value={expiresAt} disabled={Boolean(attempt)}
        onChange={event => { setExpiresAt(event.currentTarget.value); setGrantReviewed(false); }} /></label>
      <label>Exact grant reason code<input value={grantReason} maxLength={200} disabled={Boolean(attempt)}
        onChange={event => { setGrantReason(event.currentTarget.value); setGrantReviewed(false); }} /></label>
      <label><input type="checkbox" checked={grantReviewed} disabled={Boolean(attempt) || Boolean(busy)}
        onChange={event => setGrantReviewed(event.currentTarget.checked)} />
        I reviewed this exact recipient binding, folder reservation, labels and IDs, feature set, expiry, and reason.</label>
      <button type="button" className="button-orange" disabled={Boolean(busy)
        || Boolean(attempt && attempt.kind !== "grant") || (!attempt && !grantReviewed)}
        onClick={() => void grant()}>{busy === "grant" ? "Submitting…" : attempt?.kind === "grant" ? "Retry same frozen grant" : "Grant exact delivery authority"}</button>
    </section></Card>}

    <Card><form className="onboarding-staff-form" onSubmit={loadAuthority}>
      <h2 className="wide">Review known delivery authority</h2>
      <label className="wide">Exact delivery authority ID<input value={authorityId} maxLength={36}
        disabled={Boolean(attempt)} onChange={event => { setAuthorityId(event.currentTarget.value);
          setAuthority(null); setAuthorityRead(false); setAuthorityReviewed(false); }} required /></label>
      <button className="button-ghost wide" disabled={Boolean(busy)}>{busy === "authority-load" ? "Loading…" : "Load exact authority"}</button>
    </form></Card>
    {authority && <Card><section className="onboarding-created"><h2>Current native delivery authority</h2>
      <dl><div><dt>Authority ID / revision</dt><dd>{authority.authorityId} / {authority.revision}</dd></div>
        <div><dt>State</dt><dd>{authority.state}</dd></div><div><dt>Transport</dt><dd>{authority.transportStatus}</dd></div>
        <div><dt>Recipient binding</dt><dd>{authority.recipientBindingId}</dd></div>
        <div><dt>Folder reservation</dt><dd>{authority.folderReservationId}</dd></div>
        <div><dt>Target / client record</dt><dd>{authority.targetId} / {authority.targetClientRecordId}</dd></div>
        <div><dt>Features</dt><dd>{authority.features.length ? authority.features.join(", ") : "None"}</dd></div>
        <div><dt>Expires</dt><dd>{authority.expiresAt ?? "Revoked"}</dd></div>
        <div><dt>Latest operation / action</dt><dd>{authority.latestOperationId} / {authority.latestAction}</dd></div>
        <div><dt>Recovery operation</dt><dd>{authority.recoveryOperationId ?? "Not available"}</dd></div></dl>
      {authority.transportStatus === "dead" && <p role="alert">Delivery is dead and cannot be recovered. Explicitly revoke an active local authority, then separately review a current candidate before any reissue.</p>}
      {authority.state === "active" && !attempt && <label>Exact revocation reason code<input value={revokeReason} maxLength={200}
        onChange={event => { setRevokeReason(event.currentTarget.value); setAuthorityReviewed(false); }} /></label>}
      {authority.transportStatus === "pending" && authority.recoveryOperationId && authorityRead && !attempt
        && <label>Exact recovery reason<input value={recoveryReason} maxLength={500}
          onChange={event => { setRecoveryReason(event.currentTarget.value); setAuthorityReviewed(false); }} /></label>}
      <label><input type="checkbox" checked={authorityReviewed} disabled={Boolean(attempt) || Boolean(busy)}
        onChange={event => setAuthorityReviewed(event.currentTarget.checked)} />
        I reviewed this exact authority, revision, state, latest action, and transport status.</label>
      {attempt?.kind === "revoke" && <button type="button" className="button-danger" disabled={Boolean(busy)}
        onClick={() => void actAuthority("revoke")}>Retry same frozen revoke</button>}
      {attempt?.kind === "recover" && <button type="button" className="button-orange" disabled={Boolean(busy)}
        onClick={() => void actAuthority("recover")}>Retry same frozen recovery</button>}
      {!attempt && authority.state === "active" && <button type="button" className="button-danger"
        disabled={Boolean(busy) || !authorityReviewed || !revokeReason}
        onClick={() => void actAuthority("revoke")}>Revoke exact delivery authority</button>}
      {!attempt && authority.transportStatus === "pending" && authority.recoveryOperationId && authorityRead
        && <button type="button" className="button-orange" disabled={Boolean(busy) || !authorityReviewed || !recoveryReason}
          onClick={() => void actAuthority("recover")}>Recover exact pending delivery</button>}
      {authority.transportStatus === "pending" && !authorityRead
        && <p>Reload this exact authority before recovery so the stored operation and current owner authority are revalidated.</p>}
      {authority.state === "active" && <p>Features and expiry are immutable here. Revoke explicitly, then separately review and reissue a current candidate.</p>}
    </section></Card>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </main></div>;
}
