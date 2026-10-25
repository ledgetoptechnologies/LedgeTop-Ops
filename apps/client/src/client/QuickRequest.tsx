import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, Skeleton } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import { MapAreaSelector } from "./MapAreaSelector";
import type { PortalAreaGeoJson, PortalPoi, PortalServiceRequest } from "./portal-api";
import { loadRequestServices, submitQuickRequest, type RequestServiceChoice, type RequestServices } from "./request-services-api";
import { ServiceQuestionField, questionIsAnswered } from "./service-questions";

type Load = { state: "loading" } | { state: "ready"; value: RequestServices } | { state: "error"; message: string };

/**
 * The whole request on one page: pick a service, say what's needed, send. The client never chooses a business
 * or account; the server works that out from the service. Calls `onUnavailable` when this portal doesn't offer
 * the one-step form, so the per-account request path can be used instead.
 */
export function QuickRequest({ mapboxPublicToken, onSubmitted, onCancel, onUnavailable }: {
  mapboxPublicToken: string | null;
  onSubmitted: (request: PortalServiceRequest) => void;
  onCancel: () => void;
  onUnavailable: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [title, setTitle] = useState(""), [details, setDetails] = useState(""), [location, setLocation] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [area, setArea] = useState<PortalAreaGeoJson | null>(null), [points, setPoints] = useState<PortalPoi[]>([]);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<{ message: string; stale?: boolean } | null>(null);
  // Kept across a retry of the same content so an unclear failure replays instead of sending twice.
  const attemptKey = useRef<string | null>(null);
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
  const selected = services.find(item => item.serviceChoiceId === choiceId) ?? null;
  // A client name appears only to tell apart two services that would otherwise look the same.
  const label = (item: RequestServiceChoice) => services.filter(other => other.name === item.name).length > 1 ? `${item.name} · ${item.clientName}` : item.name;
  const changed = <T,>(set: (value: T) => void) => (value: T) => { attemptKey.current = null; setProblem(null); set(value); };
  const pick = (id: string) => { if (id === choiceId) return; changed(setChoiceId)(id); setAnswers({}); setArea(null); setPoints([]); };
  const mapNeeded = selected?.geometryRequirement === "required";
  const mapShown = selected !== null && selected.geometryRequirement !== "none";
  const ready = selected !== null && details.trim().length > 0 && selected.questions.every(item => questionIsAnswered(item, answers[item.id]))
    && (!mapNeeded || area !== null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !ready || busy) return;
    attemptKey.current ??= crypto.randomUUID();
    setBusy(true); setProblem(null);
    try {
      const request = await submitQuickRequest({
        serviceChoiceId: selected.serviceChoiceId, title: title.trim() || selected.name, details: details.trim(), projectId: null,
        answers, location: location.trim() || null, areaGeoJson: mapShown ? area : null, poiPoints: mapShown ? points : [],
      }, attemptKey.current);
      attemptKey.current = null;
      onSubmitted(request);
    } catch (caught) {
      const status = (caught as RequestError).status ?? 0;
      if (status === 409) { attemptKey.current = null; setProblem({ message: "This service changed since the form opened. Reload the services, check your choice, then send again.", stale: true }); }
      else if (status === 422 || status === 400) { attemptKey.current = null; setProblem({ message: (caught as Error).message || "Some details are missing. Check the form and send again." }); }
      else if (status === 401 || status === 403) setProblem({ message: "Your access changed. Refresh the portal before sending this request." });
      else setProblem({ message: "We couldn't confirm your request was received. Send again to check; it won't create a second request." });
    } finally { setBusy(false); }
  };

  return <Card className="quick-request" title="New request">
    {load.state === "loading" && <Skeleton variant="list" rows={3} label="Loading services…" />}
    {load.state === "error" && <div className="quick-request-problem" role="alert"><p>{load.message}</p>
      <button type="button" className="button-ghost" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
    {load.state === "ready" && services.length === 0 && <div className="quick-request-problem" role="alert">
      <p>No services are available to request right now. Contact Ledge Top and we'll help directly.</p></div>}
    {load.state === "ready" && services.length > 0 && <form className="quick-request-form" onSubmit={event => void submit(event)} aria-labelledby={headingId}>
      {load.value.unavailable.length > 0 && <p className="quick-request-note">Some services couldn't be listed right now. If you don't see what you need, try again shortly.</p>}
      <fieldset className="quick-request-services" disabled={busy}>
        <legend id={headingId}>What do you need?</legend>
        {services.map(item => <label key={item.serviceChoiceId} className={`quick-request-service${item.serviceChoiceId === choiceId ? " is-selected" : ""}`}>
          <input type="radio" name="quick-request-service" value={item.serviceChoiceId} checked={item.serviceChoiceId === choiceId} onChange={() => pick(item.serviceChoiceId)} />
          <span><strong>{label(item)}</strong>{item.summary && <small>{item.summary}</small>}</span>
        </label>)}
      </fieldset>
      {selected && <div className="quick-request-details">
        <label>Tell us what you need<textarea required rows={4} maxLength={4000} value={details} disabled={busy} onChange={event => changed(setDetails)(event.target.value)} /></label>
        <label>Short title (optional)<input maxLength={160} value={title} placeholder={selected.name} disabled={busy} onChange={event => changed(setTitle)(event.target.value)} /></label>
        {selected.questions.map(item => <ServiceQuestionField key={`${selected.serviceChoiceId}:${item.id}`} serviceId={selected.serviceChoiceId.replace(/[^A-Za-z0-9_-]/g, "_")} question={item}
          value={answers[item.id]} onChange={value => changed(setAnswers)({ ...answers, [item.id]: value })} />)}
        {mapShown ? <div className="quick-request-map">
          <p>{mapNeeded ? "Show us the work area on the map." : "Add the work area on the map if it helps (optional)."}</p>
          {mapboxPublicToken
            ? <div className="portal-request-map"><MapAreaSelector value={area} onChange={changed(setArea)} token={mapboxPublicToken} points={points} onPoints={changed(setPoints)} locationLabel={location} onLocationLabel={changed(setLocation)} /></div>
            : <p className="quick-request-note" role={mapNeeded ? "alert" : undefined}>The map can't load right now.{mapNeeded ? " This service needs a work area, so try again shortly or contact Ledge Top." : ""}</p>}
        </div> : <label>Location (optional)<input maxLength={300} value={location} disabled={busy} onChange={event => changed(setLocation)(event.target.value)} /></label>}
      </div>}
      {problem && <div className="quick-request-problem" role="alert"><p>{problem.message}</p>
        {problem.stale && <button type="button" className="button-ghost" onClick={() => { setProblem(null); setReload(value => value + 1); }}>Reload services</button>}</div>}
      <div className="quick-request-actions">
        <button type="submit" className="button-orange" disabled={!ready || busy}>{busy ? "Sending…" : "Send request"}</button>
        <button type="button" className="button-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>}
  </Card>;
}
