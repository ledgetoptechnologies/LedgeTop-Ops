import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, Skeleton } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import { MapAreaSelector } from "./MapAreaSelector";
import type { PortalAreaGeoJson, PortalPoi } from "./portal-api";
import { loadRequestServices, submitInquiryBody, submitQuickRequestBody, type InquiryKind, type RequestServiceChoice, type RequestServices } from "./request-services-api";
import { createRequestAttempt, markRequestAttemptUncertain, requestAttemptFailureIsDefinite, type RequestAttempt } from "./request-retry-state";
import { ServiceQuestionField, questionIsAnswered } from "./service-questions";

type Load = { state: "loading" } | { state: "ready"; value: RequestServices } | { state: "error"; message: string };

/** General choices for work that isn't a listed service; Ledge Top's team picks it up from there. */
const GENERAL: Record<InquiryKind, { name: string; another: string; summary: string }> = {
  website: { name: "Website work", another: "Other website work", summary: "A new site, changes to your site, or anything web-related." },
  drone: { name: "Drone work", another: "Other drone work", summary: "Aerial photos, video, mapping or inspections." },
  other: { name: "Something else", another: "Something else", summary: "Describe the work and we'll take it from there." },
};

/**
 * The whole request on one page: pick a service, say what's needed, send. The client never chooses a business
 * or account; the server works that out from the service. Work that isn't a listed service can still be asked
 * for through a general choice, which goes to Ledge Top's team. Calls `onUnavailable` when this portal doesn't
 * offer the one-step form, so the per-account request path can be used instead.
 */
export function QuickRequest({ mapboxPublicToken, onSubmitted, onCancel, onUnavailable }: {
  mapboxPublicToken: string | null;
  onSubmitted: () => void;
  onCancel: () => void;
  onUnavailable: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [inquiryKind, setInquiryKind] = useState<InquiryKind | null>(null);
  // Set when the server says general requests aren't offered after all, so their choices go away.
  const [inquiriesOff, setInquiriesOff] = useState(false);
  const [title, setTitle] = useState(""), [details, setDetails] = useState(""), [location, setLocation] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [area, setArea] = useState<PortalAreaGeoJson | null>(null), [points, setPoints] = useState<PortalPoi[]>([]);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<{ message: string; stale?: boolean } | null>(null);
  const [pendingAttempt, setPendingAttempt] = useState<RequestAttempt | null>(null);
  const pendingAttemptRef = useRef<RequestAttempt | null>(null);
  const busyRef = useRef(false);
  const locked = busy || pendingAttempt !== null;
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const headingId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    loadRequestServices(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value === null) { unavailable.current(); return; }
      setLoad({ state: "ready", value });
      setChoiceId(current => current && value.services.some(item => item.serviceChoiceId === current) ? current
        : value.services.length === 1 ? value.services[0]!.serviceChoiceId : null);
    }, (caught: RequestError) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: caught.status === 401 || caught.status === 403
        ? "Your access changed. Refresh the portal to continue." : "Services couldn't be loaded right now." });
    });
    return () => controller.abort();
  }, [reload]);

  const services = load.state === "ready" ? load.value.services : [];
  const kinds = load.state === "ready" && !inquiriesOff ? load.value.inquiryKinds : [];
  const selected = services.find(item => item.serviceChoiceId === choiceId) ?? null;
  const kind = inquiryKind !== null && kinds.includes(inquiryKind) ? inquiryKind : null;
  // "Other website work" when a website service is already listed, so the two don't read as the same thing.
  const generalName = (value: InquiryKind) => services.some(item => item.category === value) ? GENERAL[value].another : GENERAL[value].name;
  // A client name appears only to tell apart two services that would otherwise look the same.
  const label = (item: RequestServiceChoice) => services.filter(other => other.name === item.name).length > 1 ? `${item.name} · ${item.clientName}` : item.name;
  const changed = <T,>(set: (value: T) => void) => (value: T) => {
    if (busyRef.current || pendingAttemptRef.current) return;
    setProblem(null); set(value);
  };
  const pick = (id: string) => {
    if (busyRef.current || pendingAttemptRef.current || id === choiceId) return;
    changed(setChoiceId)(id); setInquiryKind(null); setAnswers({}); setArea(null); setPoints([]);
  };
  const pickKind = (value: InquiryKind) => {
    if (busyRef.current || pendingAttemptRef.current || value === kind) return;
    changed(setInquiryKind)(value); setChoiceId(null); setAnswers({}); setArea(null); setPoints([]);
  };
  const mapNeeded = selected?.geometryRequirement === "required";
  const mapShown = selected !== null && selected.geometryRequirement !== "none";
  const ready = kind !== null ? details.trim().length > 0
    : selected !== null && details.trim().length > 0 && selected.questions.every(item => questionIsAnswered(item, answers[item.id])) && (!mapNeeded || area !== null);

  const retainAttempt = (attempt: RequestAttempt | null) => {
    pendingAttemptRef.current = attempt;
    setPendingAttempt(attempt);
  };

  const sendAttempt = async (attempt: RequestAttempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setProblem(null);
    try {
      if (attempt.kind === "inquiry") await submitInquiryBody(attempt.body, attempt.key);
      else await submitQuickRequestBody(attempt.body, attempt.key);
    } catch (caught) {
      const failure = caught as RequestError;
      const status = failure.status ?? 0;
      const code = typeof failure.body?.code === "string" ? failure.body.code
        : typeof failure.body?.error === "object" && typeof failure.body.error?.code === "string" ? failure.body.error.code : undefined;
      if (requestAttemptFailureIsDefinite(attempt, status, code)) {
        retainAttempt(null);
        busyRef.current = false; setBusy(false);
        if (attempt.kind === "inquiry" && (status === 404 || status === 405)) {
          setInquiriesOff(true); setInquiryKind(null);
          setProblem({ message: "General requests can't be sent online right now. Choose a listed service, or ask your Ledge Top contact." });
        } else if (status === 400 || status === 422) {
          setProblem({ message: failure.message || "Some details are missing. Check the form and send again." });
        } else if (status === 404 || status === 405 || code === "catalog_changed") {
          setProblem({ message: "This service changed since the form opened. Reload the services, check your choice, then send again.", stale: true });
        } else if (code === "idempotency_conflict") {
          setProblem({ message: "This request key was already used for different details. Review the form and send again." });
        } else {
          setProblem({ message: "This request couldn't be sent with the current access. Refresh the services and try again.", stale: true });
        }
        return;
      }
      retainAttempt(markRequestAttemptUncertain(attempt));
      busyRef.current = false; setBusy(false);
      setProblem({ message: "We couldn't confirm your request was received. Retry this exact request to check; don't edit or cancel it while its outcome is unknown." });
      return;
    }
    retainAttempt(null);
    busyRef.current = false; setBusy(false);
    // Parent navigation is outside transport error handling: a callback error
    // after a verified server response must not be presented as a lost ACK.
    onSubmitted();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || pendingAttemptRef.current || (!selected && !kind) || !ready) return;
    const key = crypto.randomUUID();
    const attempt = kind
      ? createRequestAttempt("inquiry", key, JSON.stringify({
        kind, title: title.trim() || null, details: details.trim(), location: location.trim() || null,
      }))
      : createRequestAttempt("service", key, JSON.stringify({
        serviceChoiceId: selected!.serviceChoiceId, title: title.trim() || selected!.name, details: details.trim(), projectId: null,
        answers, location: location.trim() || null, areaGeoJson: mapShown ? area : null, poiPoints: mapShown ? points : [],
      }));
    void sendAttempt(attempt);
  };

  const retryPending = () => {
    const attempt = pendingAttemptRef.current;
    if (!attempt || attempt.state !== "uncertain" || busyRef.current) return;
    void sendAttempt(attempt);
  };

  return <Card className="quick-request" title="New request">
    {load.state === "loading" && <Skeleton variant="list" rows={3} label="Loading services…" />}
    {load.state === "error" && <div className="quick-request-problem" role="alert"><p>{load.message}</p>
      <button type="button" className="button-ghost" disabled={locked} onClick={() => setReload(value => value + 1)}>Try again</button></div>}
    {load.state === "ready" && services.length === 0 && kinds.length === 0 && <div className="quick-request-problem" role="alert">
      <p>No services are available to request right now. Contact Ledge Top and we'll help directly.</p></div>}
    {load.state === "ready" && (services.length > 0 || kinds.length > 0) && <form className="quick-request-form" onSubmit={event => void submit(event)} aria-labelledby={headingId}>
      {load.value.unavailable.length > 0 && <p className="quick-request-note">Some services couldn't be listed right now. If you don't see what you need, try again shortly.</p>}
      <fieldset className="quick-request-services" disabled={locked}>
        <legend id={headingId}>What do you need?</legend>
        {services.map(item => <label key={item.serviceChoiceId} className={`quick-request-service${item.serviceChoiceId === choiceId ? " is-selected" : ""}`}>
          <input type="radio" name="quick-request-service" value={item.serviceChoiceId} checked={item.serviceChoiceId === choiceId} onChange={() => pick(item.serviceChoiceId)} />
          <span><strong>{label(item)}</strong>{item.summary && <small>{item.summary}</small>}</span>
        </label>)}
        {kinds.map(value => <label key={`general:${value}`} className={`quick-request-service quick-request-general${value === kind ? " is-selected" : ""}`}>
          <input type="radio" name="quick-request-service" value={`general:${value}`} checked={value === kind} onChange={() => pickKind(value)} />
          <span><strong>{generalName(value)}</strong><small>{GENERAL[value].summary}</small></span>
        </label>)}
      </fieldset>
      {(selected || kind) && <div className="quick-request-details">
        <label>Tell us what you need<textarea required rows={4} maxLength={4000} value={details} disabled={locked} onChange={event => changed(setDetails)(event.target.value)} /></label>
        <label>Short title (optional)<input maxLength={160} value={title} placeholder={selected?.name ?? generalName(kind!)} disabled={locked} onChange={event => changed(setTitle)(event.target.value)} /></label>
        {selected && selected.questions.map(item => <ServiceQuestionField key={`${selected.serviceChoiceId}:${item.id}`} serviceId={selected.serviceChoiceId.replace(/[^A-Za-z0-9_-]/g, "_")} question={item}
          value={answers[item.id]} disabled={locked} onChange={value => changed(setAnswers)({ ...answers, [item.id]: value })} />)}
        {mapShown ? <div className="quick-request-map">
          <p>{mapNeeded ? "Show us the work area on the map." : "Add the work area on the map if it helps (optional)."}</p>
          {mapboxPublicToken
            ? <div className="portal-request-map" aria-disabled={locked} inert={locked} style={locked ? { pointerEvents: "none" } : undefined}><MapAreaSelector value={area} onChange={changed(setArea)} token={mapboxPublicToken} points={points} onPoints={changed(setPoints)} locationLabel={location} onLocationLabel={changed(setLocation)} /></div>
            : <p className="quick-request-note" role={mapNeeded ? "alert" : undefined}>The map can't load right now.{mapNeeded ? " This service needs a work area, so try again shortly or contact Ledge Top." : ""}</p>}
        </div> : <label>Location (optional)<input maxLength={300} value={location} disabled={locked} onChange={event => changed(setLocation)(event.target.value)} /></label>}
      </div>}
      {problem && <div className="quick-request-problem" role="alert"><p>{problem.message}</p>
        {pendingAttempt && <>
          <p>Keep this form open while you retry. If your access changed, contact Ledge Top before starting another request.</p>
          <button type="button" className="button-ghost" disabled={busy} onClick={retryPending}>Retry same request</button>
        </>}
        {problem.stale && !pendingAttempt && <button type="button" className="button-ghost" disabled={locked} onClick={() => { setProblem(null); setReload(value => value + 1); }}>Reload services</button>}</div>}
      <div className="quick-request-actions">
        {!pendingAttempt && <button type="submit" className="button-orange" disabled={!ready || locked}>{busy ? "Sending…" : "Send request"}</button>}
        <button type="button" className="button-ghost" disabled={locked} onClick={onCancel}>Cancel</button>
      </div>
    </form>}
  </Card>;
}
