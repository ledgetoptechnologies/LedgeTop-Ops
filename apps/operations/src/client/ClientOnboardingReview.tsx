import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Card, Skeleton, StatusPill } from "@ltds/ui";
import {
  activationText, authorityLost, destinationList, destinationName, existingReasonText, post, sharedReasonText, uncertainFailure, uuid, UUID,
  validActivation, validApproval, validChoices, validExistingCompanies, validInbox, validReview, validSharedApproval,
  validSharedCompanies, validSharedPlan,
  type Activation, type ExistingCompany, type InboxCursor, type InboxItem, type OrganizationSelection, type Review,
  type SharedCompany, type SharedPlan, type SharedSelection, type StaffSession,
} from "./onboarding-staff-api";

type CompanyMode = "new" | "existing" | "shared";
type Decided = { clientRecordId: string; organizationRecordId?: string; sourceIds: string[]; replayed: boolean };
const ACTIVATION_POLL_MS = 10_000, ACTIVATION_POLL_LIMIT = 30;

/** Reads ?submission= from an owner email link; only an exact submission UUID is accepted. */
export function submissionFromLocation(search: string): string | null {
  const value = new URLSearchParams(search).get("submission");
  return value && UUID.test(value) ? value : null;
}

export function ClientOnboardingInbox({ session, onAuthorityLost }: { session: StaffSession; onAuthorityLost: () => void }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => submissionFromLocation(window.location.search));
  const generation = useRef(0);
  const load = useCallback(async (next: InboxCursor | null) => {
    const run = ++generation.current;
    setLoading(true); setError("");
    try {
      const value = await post(session, "inbox", { cursor: next });
      if (!validInbox(value)) throw new Error("invalid_response");
      if (run !== generation.current) return;
      setItems(current => {
        const merged = new Map((next ? current : []).map(item => [item.submissionId, item]));
        for (const item of value.submissions) merged.set(item.submissionId, item);
        return [...merged.values()];
      });
      setCursor(value.nextCursor);
    } catch (caught) {
      if (run !== generation.current) return;
      // Denied or revoked reviewers see no rows and no open review at all.
      setItems([]); setCursor(null); setSelected(null);
      if (authorityLost(caught)) { onAuthorityLost(); return; }
      setError("Submissions awaiting review couldn't be loaded. Your review access may have changed.");
    } finally { if (run === generation.current) setLoading(false); }
  }, [session, onAuthorityLost]);
  useEffect(() => { void load(null); }, [load]);
  const open = (submissionId: string) => {
    setSelected(submissionId);
    const url = new URL(window.location.href); url.searchParams.set("submission", submissionId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const decided = (submissionId: string) => setItems(current => current.filter(item => item.submissionId !== submissionId));

  return <>
    <Card><section className="onboarding-inbox" aria-labelledby="onboarding-inbox-title">
      <div className="onboarding-inbox-heading"><h2 id="onboarding-inbox-title">Submissions awaiting review</h2>
        <button type="button" className="button-ghost button-small" disabled={loading} onClick={() => void load(null)}>Refresh</button></div>
      {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <Skeleton variant="list" rows={3} label="Loading submissions…" />}
      {!loading && !error && items.length === 0 && <p>No submissions are waiting for your review.</p>}
      {items.length > 0 && <ul className="onboarding-inbox-list">{items.map(item => <li key={item.submissionId}>
        <button type="button" aria-current={selected === item.submissionId ? "true" : undefined} onClick={() => open(item.submissionId)}>
          <strong>{item.name || "Unnamed client"}</strong>
          <span>{item.clientType === "business" ? item.organizationName || "Business" : "Individual"}{item.existingClient ? " · Existing client" : ""}</span>
          <small>Submitted {new Date(item.submittedAt).toLocaleString()}</small>
        </button></li>)}</ul>}
      {cursor && <button type="button" className="button-ghost" disabled={loading} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Load more submissions"}</button>}
    </section></Card>
    {selected && <ClientOnboardingReviewPanel key={selected} session={session} submissionId={selected} onDecided={decided} onAuthorityLost={onAuthorityLost} />}
  </>;
}

export function ClientOnboardingReviewPanel({ session, submissionId, onDecided, onAuthorityLost }: {
  session: StaffSession; submissionId: string; onDecided: (submissionId: string) => void; onAuthorityLost: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loadError, setLoadError] = useState("");
  const [available, setAvailable] = useState<string[] | null>(null);
  const [sourceNote, setSourceNote] = useState("");
  const [activation, setActivation] = useState<Activation | null | undefined>(undefined);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [companyMode, setCompanyMode] = useState<CompanyMode>("new");
  const [decided, setDecided] = useState<Decided | null>(null);
  // From the moment an approval or plan is sent until it settles (and while its result
  // is uncertain or a plan is held) the reviewed choices are frozen, so a retry sends the
  // identical request. The ref closes the gap before React re-renders.
  const [locked, setLocked] = useState(false);
  const lockRef = useRef(false);
  const lock = useCallback((value: boolean) => { lockRef.current = value; setLocked(value); }, []);
  const chooseSource = (sourceId: string, checked: boolean) => { if (!lockRef.current) setSelectedSources(current => checked ? [...new Set([...current, sourceId])].sort() : current.filter(value => value !== sourceId)); };
  const chooseMode = (mode: CompanyMode) => { if (!lockRef.current) setCompanyMode(mode); };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await post(session, "review", { submissionId });
        if (!validReview(value) || value.submissionId !== submissionId) throw new Error("invalid_response");
        if (!active) return;
        setReview(value);
        const [choices, status] = await Promise.allSettled([
          post(session, "enrollment-choices", { submissionId }), post(session, "activation-status", { submissionId })]);
        if (!active) return;
        if (choices.status === "fulfilled" && validChoices(choices.value)) setAvailable([...choices.value.sourceIds].sort());
        else { setAvailable([]); setSourceNote("The available businesses couldn't be checked. You can still approve in Operations only, or reload this submission."); }
        setActivation(status.status === "fulfilled" && validActivation(status.value) ? status.value.activation : null);
      } catch (caught) {
        if (!active) return;
        if ((caught as { status?: number } | null)?.status === 401) { onAuthorityLost(); return; }
        setLoadError("This submission wasn't found, or it's outside your review access.");
      }
    })();
    return () => { active = false; };
  }, [session, submissionId, onAuthorityLost]);

  if (loadError) return <Card><p className="onboarding-staff-error" role="alert">{loadError}</p></Card>;
  if (!review) return <Card><Skeleton variant="form" rows={4} label="Loading submission…" /></Card>;
  const f = review.fields, business = f.clientType === "business";
  const rows: Array<[string, string]> = [["Client type", business ? "Business" : "Individual"], ["Name", f.name], ["Email", f.email],
    ["Phone", f.phone], ...(business ? [["Company", f.organizationName], ["Company email", f.organizationEmail], ["Company phone", f.organizationPhone]] as Array<[string, string]> : []),
    ["Address", [f.addressLine1, f.addressLine2].filter(Boolean).join(", ")], ["City", f.city], ["State", f.state], ["Postal code", f.postalCode], ["Country", f.country]];
  const finished = decided !== null || (activation !== undefined && activation !== null);

  return <Card><section className="onboarding-created onboarding-review" aria-labelledby="onboarding-review-title">
    <h2 id="onboarding-review-title">Review {f.name || "submission"}</h2>
    <p className="onboarding-review-meta">Submitted {new Date(review.submittedAt).toLocaleString()}</p>
    <dl className="onboarding-review-fields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
    {review.targetClientRecordId !== null && <p className="onboarding-staff-error" role="status"><strong>Can't be approved here.</strong> This submission updates an existing client, which this review doesn't support yet.</p>}
    {review.targetClientRecordId === null && activation === undefined && <Skeleton variant="text" lines={2} label="Checking review status…" />}
    {review.targetClientRecordId === null && !finished && activation === null && available !== null && <>
      <fieldset className="onboarding-destinations"><legend>Which Ledge Top businesses is this client for?</legend>
        {available.length === 0 && <p>No Project Alpha businesses are available for this submission.</p>}
        {available.map(sourceId => <label key={sourceId}><input type="checkbox" checked={selectedSources.includes(sourceId)} disabled={locked}
          onChange={event => chooseSource(sourceId, event.target.checked)} />
          {destinationName(sourceId)}</label>)}
        {sourceNote && <p role="status">{sourceNote}</p>}
        <p className="onboarding-hint">{selectedSources.length === 0 ? "No business selected: the client is approved in Operations only."
          : `A client record is created in ${destinationList(selectedSources)}. Project Alpha stays the owner of documents and finances.`}</p>
      </fieldset>
      {business && <fieldset className="onboarding-company-mode"><legend>Company</legend>
        <label><input type="radio" name={`company-${submissionId}`} disabled={locked} checked={companyMode === "new"} onChange={() => chooseMode("new")} />New company “{f.organizationName}”</label>
        <label><input type="radio" name={`company-${submissionId}`} disabled={locked} checked={companyMode === "existing"} onChange={() => chooseMode("existing")} />An existing company in Operations</label>
        <label><input type="radio" name={`company-${submissionId}`} disabled={locked} checked={companyMode === "shared"} onChange={() => chooseMode("shared")} />An existing company shared by both businesses</label>
      </fieldset>}
      {!business || companyMode !== "shared"
        ? <DirectApproval session={session} review={review} sourceIds={selectedSources} locked={locked}
            companyMode={business && companyMode !== "shared" ? companyMode : null} onLock={lock} onApproved={result => { setDecided(result); onDecided(submissionId); }} />
        : <SharedCompanyApproval session={session} review={review} sourceIds={selectedSources} onLock={lock}
            onApproved={result => { setDecided(result); onDecided(submissionId); }} />}
    </>}
    {finished && <ActivationStatus session={session} submissionId={submissionId} initial={activation ?? null} decided={decided} />}
  </section></Card>;
}

/** Approval for an individual, a new company, or one existing company. A definite
 * denial releases the request; an uncertain result retries the identical body. */
function DirectApproval({ session, review, sourceIds, companyMode, locked, onLock, onApproved }: {
  session: StaffSession; review: Review; sourceIds: string[]; companyMode: Exclude<CompanyMode, "shared"> | null;
  locked: boolean; onLock: (locked: boolean) => void; onApproved: (result: Decided) => void;
}) {
  const [company, setCompany] = useState<ExistingCompany | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const frozen = useRef<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const sourcesKey = sourceIds.join(",");
  // A changed business or company mode (only possible while unfrozen) invalidates the chosen company.
  useEffect(() => { if (!frozen.current) setCompany(null); }, [sourcesKey, companyMode]);
  const selection: OrganizationSelection | null = companyMode === "new" ? { kind: "new" }
    : companyMode === "existing" && company ? { kind: "existing", recordId: company.recordId, expectedVersion: company.expectedVersion } : null;
  const ready = companyMode === null || selection !== null;
  const approve = async () => {
    if (busy || !ready || (locked && !frozen.current)) return;
    onLock(true); setBusy(true); setError("");
    const body = frozen.current ?? JSON.stringify({ submissionId: review.submissionId, fieldsSha256: review.fieldsSha256, sourceIds,
      ...(companyMode ? { organizationSelection: selection } : {}) });
    frozen.current = body;
    try {
      const value = await post(session, "approve", JSON.parse(body));
      if (!validApproval(value) || value.submissionId !== review.submissionId) throw new Error("invalid_response");
      setUncertain(false);
      onApproved({ clientRecordId: value.clientRecordId, organizationRecordId: value.organizationRecordId, sourceIds, replayed: value.replayed });
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain(true);
      else { frozen.current = null; setUncertain(false); onLock(false); setError("Approval was refused. Check your review permissions, the selected businesses and the company, then try again."); }
    } finally { setBusy(false); }
  };
  return <div className="onboarding-approval-action">
    {companyMode === "existing" && <ExistingCompanyPicker key={sourcesKey} session={session} review={review} sourceIds={sourceIds} selected={company} onSelect={setCompany} locked={locked || busy} />}
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
    <button type="button" className="button-orange" disabled={busy || !ready} onClick={() => void approve()}>
      {busy ? "Approving…" : uncertain ? "Retry same approval" : `Approve for ${destinationList(sourceIds)}`}</button>
    {uncertain && <p className="onboarding-staff-error" role="alert">The approval result isn't confirmed. Retrying sends exactly the same approval.</p>}
    {!ready && companyMode === "existing" && <p className="onboarding-hint">Choose the existing company first.</p>}
    <p className="onboarding-hint">After approval the client gets portal sign-in and can edit their own profile once the business records are ready. Files are never shared automatically.</p>
  </div>;
}

function ExistingCompanyPicker({ session, review, sourceIds, selected, onSelect, locked }: {
  session: StaffSession; review: Review; sourceIds: string[]; selected: ExistingCompany | null; onSelect: (company: ExistingCompany | null) => void; locked: boolean;
}) {
  const [query, setQuery] = useState(review.fields.organizationName.slice(0, 150));
  const [results, setResults] = useState<ExistingCompany[] | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = async (event: FormEvent | null, more = false) => {
    event?.preventDefault();
    if (busy || locked) return;
    setBusy(true); setError(""); if (!more) { onSelect(null); setResults(null); }
    try {
      const value = await post(session, "existing-companies", { submissionId: review.submissionId, sourceIds, query: query.trim(), afterRecordId: more ? after : null });
      if (!validExistingCompanies(value)) throw new Error("invalid_response");
      setResults(current => [...(more ? current ?? [] : []), ...value.companies]); setAfter(value.nextAfterRecordId);
    } catch { setError("Companies couldn't be searched. Check your directory permissions and try again."); }
    finally { setBusy(false); }
  };
  return <div className="onboarding-company-picker">
    <form onSubmit={event => void search(event)} className="onboarding-company-search">
      <label>Search companies<input value={query} maxLength={150} disabled={locked} onChange={event => setQuery(event.target.value)} /></label>
      <button className="button-ghost" disabled={busy || locked}>{busy ? "Searching…" : "Search"}</button></form>
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
    {results && results.length === 0 && <p>No matching companies.</p>}
    {results && results.length > 0 && <fieldset><legend>Matching companies</legend>{results.map(company => <label key={company.recordId} className={company.reusable ? "" : "is-unavailable"}>
      <input type="radio" name={`existing-${review.submissionId}`} disabled={!company.reusable || locked} checked={selected?.recordId === company.recordId} onChange={() => onSelect(company)} />
      <span><strong>{company.name}</strong><small>{company.sourceIds.length ? destinationList(company.sourceIds) : "Operations only"}</small>
        {company.reason && <small>{existingReasonText[company.reason]}</small>}</span></label>)}</fieldset>}
    {after && <button type="button" className="button-ghost" disabled={busy || locked} onClick={() => void search(null, true)}>Load more companies</button>}
  </div>;
}

/** Shared company: search, then a server-prepared plan, then approval of exactly that plan. */
function SharedCompanyApproval({ session, review, sourceIds, onLock, onApproved }: {
  session: StaffSession; review: Review; sourceIds: string[]; onLock: (locked: boolean) => void; onApproved: (result: Decided) => void;
}) {
  const [query, setQuery] = useState(review.fields.organizationName.slice(0, 150));
  const [results, setResults] = useState<SharedCompany[] | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [company, setCompany] = useState<SharedCompany | null>(null);
  const [plan, setPlan] = useState<SharedPlan | null>(null);
  const [busy, setBusy] = useState<"search" | "plan" | "approve" | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"plan" | "approve" | null>(null);
  const planCommand = useRef<{ commandId: string; body: string } | null>(null);
  const searchRun = useRef(0);
  const sourcesKey = sourceIds.join(",");
  // Changed businesses (only possible while unfrozen) invalidate earlier search results.
  useEffect(() => { if (planCommand.current) return; searchRun.current += 1; setCompany(null); setResults(null); setAfter(null); }, [sourcesKey]);
  const release = () => { setPlan(null); planCommand.current = null; onLock(false); };
  const frozen = Boolean(busy === "plan" || busy === "approve" || uncertain || plan);
  const search = async (event: FormEvent | null, more = false) => {
    event?.preventDefault();
    if (busy || uncertain || plan) return;
    const run = ++searchRun.current;
    setBusy("search"); setError(""); if (!more) { setCompany(null); setResults(null); }
    try {
      const value = await post(session, "shared-company-choices", { submissionId: review.submissionId, sourceIds, query: query.trim(), afterGroupId: more ? after : null });
      if (!validSharedCompanies(value)) throw new Error("invalid_response");
      if (run !== searchRun.current) return;
      setResults(current => [...(more ? current ?? [] : []), ...value.companies]); setAfter(value.nextAfterGroupId);
    } catch { if (run === searchRun.current) setError("Shared companies couldn't be searched. Check your directory permissions and try again."); }
    finally { setBusy(null); }
  };
  const prepare = async () => {
    if (!company || busy) return;
    onLock(true); setBusy("plan"); setError("");
    const selection: SharedSelection = { kind: "shared_existing", groupId: company.groupId, expectedVersion: company.expectedVersion,
      members: company.members.map(member => ({ recordId: member.recordId, expectedVersion: member.expectedVersion }))
        .sort((left, right) => left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0) };
    const command = planCommand.current ?? { commandId: uuid(), body: JSON.stringify({ submissionId: review.submissionId,
      fieldsSha256: review.fieldsSha256, sourceIds, organizationSelection: selection }) };
    planCommand.current = command;
    try {
      const value = await post(session, "shared-company-plan", { commandId: command.commandId, ...JSON.parse(command.body) });
      if (!validSharedPlan(value, { planId: command.commandId, submissionId: review.submissionId, groupId: company.groupId })) throw new Error("invalid_response");
      setPlan(value); setUncertain(null);
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("plan");
      else { setUncertain(null); release(); setError("The plan was refused. The company may have changed; search again and choose it again."); }
    } finally { setBusy(null); }
  };
  const approve = async () => {
    if (!plan || busy) return;
    if (Date.parse(plan.expiresAt) <= Date.now() && uncertain !== "approve") { release(); setError("The plan expired. Prepare it again."); return; }
    setBusy("approve"); setError("");
    try {
      const value = await post(session, "approve-shared-company", { planId: plan.planId, submissionId: review.submissionId, fieldsSha256: review.fieldsSha256 });
      if (!validSharedApproval(value, plan.planId, review.submissionId)) throw new Error("invalid_response");
      setUncertain(null);
      onApproved({ clientRecordId: value.clientRecordId, organizationRecordId: value.organizationRecordId, sourceIds: plan.sourceIds, replayed: value.replayed });
    } catch (caught) {
      if (uncertainFailure(caught)) setUncertain("approve");
      else { setUncertain(null); release(); setError("Approval was refused. The plan may have expired or the company changed; prepare a new plan."); }
    } finally { setBusy(null); }
  };
  if (sourceIds.length === 0) return <p className="onboarding-hint">Choose at least one business above to use a shared company.</p>;
  return <div className="onboarding-approval-action">
    {!plan && <>
      <form onSubmit={event => void search(event)} className="onboarding-company-search">
        <label>Search shared companies<input value={query} maxLength={150} disabled={frozen} onChange={event => setQuery(event.target.value)} /></label>
        <button className="button-ghost" disabled={Boolean(busy) || frozen}>{busy === "search" ? "Searching…" : "Search"}</button></form>
      {results && results.length === 0 && <p>No matching shared companies.</p>}
      {results && results.length > 0 && <fieldset><legend>Shared companies</legend>{results.map(item => <label key={item.groupId} className={item.reviewAvailable ? "" : "is-unavailable"}>
        <input type="radio" name={`shared-${review.submissionId}`} disabled={!item.reviewAvailable || frozen} checked={company?.groupId === item.groupId} onChange={() => { if (!planCommand.current) setCompany(item); }} />
        <span><strong>{item.name}</strong><small>{destinationList([...new Set(item.members.flatMap(member => member.sourceIds))].sort())}</small>
          {item.reason && <small>{sharedReasonText[item.reason]}</small>}</span></label>)}</fieldset>}
      {after && <button type="button" className="button-ghost" disabled={Boolean(busy) || frozen} onClick={() => void search(null, true)}>Load more companies</button>}
      <button type="button" className="button-orange" disabled={!company || Boolean(busy)} onClick={() => void prepare()}>
        {busy === "plan" ? "Preparing…" : uncertain === "plan" ? "Retry same plan" : "Review approval plan"}</button>
      {uncertain === "plan" && <p className="onboarding-staff-error" role="alert">The plan result isn't confirmed. Retrying asks for exactly the same plan.</p>}
    </>}
    {plan && <div className="onboarding-plan" role="region" aria-label="Approval plan">
      <h3>Approval plan</h3>
      <p>The client is added to {company?.name ?? "the shared company"} in {destinationList(plan.sourceIds)}:</p>
      <ul>{plan.children.map(child => <li key={child.clientRecordId}>{destinationList(child.sourceIds)}</li>)}</ul>
      <p className="onboarding-hint">This plan is valid until {new Date(plan.expiresAt).toLocaleTimeString()}. Nothing changes until you approve.</p>
      {!plan.approvalAvailable && <p className="onboarding-staff-error" role="status">Approval isn't available for this plan with your current permissions.</p>}
      <button type="button" className="button-orange" disabled={Boolean(busy) || !plan.approvalAvailable} onClick={() => void approve()}>
        {busy === "approve" ? "Approving…" : uncertain === "approve" ? "Retry same approval" : "Approve this plan"}</button>
      {uncertain !== "approve" && <button type="button" className="button-ghost" disabled={Boolean(busy)} onClick={release}>Change company</button>}
      {uncertain === "approve" && <p className="onboarding-staff-error" role="alert">The approval result isn't confirmed. Retrying approves exactly the same plan.</p>}
    </div>}
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
  </div>;
}

function ActivationStatus({ session, submissionId, initial, decided }: {
  session: StaffSession; submissionId: string; initial: Activation | null; decided: Decided | null;
}) {
  const [activation, setActivation] = useState<Activation | null>(initial);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const polls = useRef(0);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const value = await post(session, "activation-status", { submissionId });
      if (!validActivation(value)) throw new Error("invalid_response");
      setActivation(value.activation); setError("");
    } catch { setError("The activation status couldn't be checked right now."); }
    finally { setChecking(false); }
  }, [session, submissionId]);
  useEffect(() => {
    if (activation && activation.state !== "pending") return;
    if (polls.current >= ACTIVATION_POLL_LIMIT) return;
    const timer = window.setTimeout(() => { polls.current += 1; void check(); }, activation === null && polls.current === 0 ? 0 : ACTIVATION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [activation, check, decided]);
  const tone = activation?.state === "active" ? "success" : activation?.state === "blocked" ? "danger" : "warning";
  return <div className="onboarding-approval-success" role="status" aria-live="polite">
    <h3>{decided ? "Approved" : "Already reviewed"}</h3>
    {decided && <p>{decided.sourceIds.length ? `Client records are being created in ${destinationList(decided.sourceIds)}.` : "Approved in Operations only."}
      {decided.replayed ? " This approval had already been recorded." : ""}</p>}
    <div className="onboarding-activation"><StatusPill tone={tone}>{activation ? activation.state === "active" ? "Portal active" : activation.state === "blocked" ? "Needs attention" : "In progress" : "Starting"}</StatusPill>
      <span>{activation ? activationText[activation.reason] : "Waiting for portal activation to start."}</span></div>
    {error && <p className="onboarding-staff-error">{error}</p>}
    {(!activation || activation.state === "pending") && <button type="button" className="button-ghost button-small" disabled={checking} onClick={() => { polls.current = 0; void check(); }}>{checking ? "Checking…" : "Check status now"}</button>}
  </div>;
}
