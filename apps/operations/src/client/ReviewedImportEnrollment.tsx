import { useEffect, useId, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { confirmAction } from "./confirm-action";

type Kind = "client" | "organization";
type Source = Readonly<{ sourceId: string; enrolled: boolean }>;
type Review = Readonly<{ recordId: string; kind: Kind; recordVersion: number; enrollmentVersion: number; sources: readonly Source[] }>;
type Attempt = Readonly<{ mutationId: string; body: string; sourceIds: readonly string[]; expectedEnrollmentVersion: number }>;
const BASE = "/api/native-directory/reviewed-import-enrollment";
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function validVersion(value: unknown, minimum = 0) { return Number.isSafeInteger(value) && Number(value) >= minimum; }
function validReview(value: unknown, kind: Kind, recordId: string): value is { review: Review } {
  if (!exact(value, ["review"]) || !exact(value.review, ["recordId", "kind", "recordVersion", "enrollmentVersion", "sources"])) return false;
  const review = value.review;
  if (review.recordId !== recordId || review.kind !== kind || !validVersion(review.recordVersion, 1)
    || !validVersion(review.enrollmentVersion) || !Array.isArray(review.sources) || review.sources.length > 64) return false;
  const ids = new Set<string>();
  let enrolled = 0;
  return review.sources.every(source => {
    if (!exact(source, ["sourceId", "enrolled"]) || typeof source.sourceId !== "string" || !SOURCE.test(source.sourceId)
      || typeof source.enrolled !== "boolean" || ids.has(source.sourceId) || source.enrolled && ++enrolled > 16) return false;
    ids.add(source.sourceId); return true;
  });
}
function validSession(value: unknown): value is { csrfToken: string; verifiedUntil: string } {
  if (!exact(value, ["csrfToken", "verifiedUntil"]) || typeof value.csrfToken !== "string" || !CSRF.test(value.csrfToken)
    || typeof value.verifiedUntil !== "string") return false;
  const until = Date.parse(value.verifiedUntil);
  return Number.isFinite(until) && new Date(until).toISOString() === value.verifiedUntil && until > Date.now();
}
function validOutcome(value: unknown, attempt: Attempt, recordId: string): boolean {
  if (!exact(value, ["outcome"]) || !exact(value.outcome, ["status", "replayed", "recordId", "enrollmentVersion", "sourceIds"])) return false;
  const outcome = value.outcome;
  return outcome.status === "written" && typeof outcome.replayed === "boolean" && outcome.recordId === recordId
    && outcome.enrollmentVersion === attempt.expectedEnrollmentVersion + 1 && Array.isArray(outcome.sourceIds)
    && outcome.sourceIds.length === attempt.sourceIds.length
    && outcome.sourceIds.every((sourceId, index) => sourceId === attempt.sourceIds[index]);
}
async function json(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw new Error("invalid response");
  return response.json();
}

export function ReviewedImportEnrollment({ enabled, recordId, kind, onChanged }: {
  enabled: boolean; recordId: string; kind: Kind; onChanged?: () => void;
}) {
  return enabled ? <ReviewedImportEnrollmentBound key={`${kind}\0${recordId}`} recordId={recordId} kind={kind} onChanged={onChanged} /> : null;
}

function ReviewedImportEnrollmentBound({ recordId, kind, onChanged }: {
  recordId: string; kind: Kind; onChanged?: () => void;
}) {
  const id = useId(), mounted = useRef(true), claimed = useRef(false), controllers = useRef(new Set<AbortController>());
  const [review, setReview] = useState<Review | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [refreshRequired, setRefreshRequired] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);
  const requestJson = async (path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { const response = await fetch(path, { credentials: "same-origin", ...init, signal: controller.signal });
      try { return { response, value: await json(response), parseError: false }; }
      catch { return { response, value: undefined, parseError: true }; } }
    finally { controllers.current.delete(controller); }
  };
  const load = async () => {
    if (claimed.current) return;
    claimed.current = true; setBusy(true); setError(""); setMessage(""); setReview(null); setSelected([]); setAttempt(null); setRefreshRequired(false);
    try {
      const route = kind === "client" ? "clients" : "organizations";
      const { response, value, parseError } = await requestJson(`${BASE}/${route}/${encodeURIComponent(recordId)}/review`, { headers: { "X-Native-Staff-Request": "1" } });
      if (!response.ok || parseError) throw new Error("review unavailable");
      if (!validReview(value, kind, recordId)) throw new Error("invalid review");
      if (mounted.current) { setReview(Object.freeze({ ...value.review, sources: Object.freeze(value.review.sources.map(source => Object.freeze({ ...source }))) }));
        setSelected(value.review.sources.filter(source => source.enrolled).map(source => source.sourceId)); }
    } catch (caught) {
      if (mounted.current && !(caught instanceof DOMException && caught.name === "AbortError")) setError("Enrollment review is unavailable. No Project Alpha sync enrollment was requested.");
    } finally { claimed.current = false; if (mounted.current) setBusy(false); }
  };
  const execute = async () => {
    const hasNewSelection = !!review?.sources.some(source => !source.enrolled && selected.includes(source.sourceId));
    if (claimed.current || !review || refreshRequired || selected.length < 1 || selected.length > 16 || (!attempt && !hasNewSelection)) return;
    claimed.current = true; setError(""); setMessage("");
    const frozen = attempt ?? (() => {
      const mutationId = crypto.randomUUID(), sourceIds = review.sources.filter(source => selected.includes(source.sourceId)).map(source => source.sourceId).sort();
      return Object.freeze({ mutationId, sourceIds: Object.freeze(sourceIds), expectedEnrollmentVersion: review.enrollmentVersion, body: JSON.stringify({ mutationId,
        expectedRecordVersion: review.recordVersion, expectedEnrollmentVersion: review.enrollmentVersion, sourceIds }) });
    })();
    try {
      const accepted = await confirmAction(`Enroll only the selected imported ${kind} sources in Project Alpha synchronization? This does not activate portal access or grant files.`);
      if (!accepted || !mounted.current) return;
      setAttempt(frozen); setBusy(true);
      const { response: sessionResponse, value: session, parseError: sessionParseError } = await requestJson(`${BASE}/session`, { headers: { "X-Native-Staff-Request": "1" } });
      if (!sessionResponse.ok || sessionParseError) throw new Error("session unavailable");
      if (!validSession(session)) throw new Error("invalid session");
      const route = kind === "client" ? "clients" : "organizations";
      const { response, value, parseError } = await requestJson(`${BASE}/${route}/${encodeURIComponent(recordId)}`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": frozen.mutationId }, body: frozen.body });
      if (response.status === 409) {
        if (mounted.current) { setAttempt(null); setReview(null); setSelected([]); setRefreshRequired(true);
          setError("The enrollment review is stale. Refresh the review before submitting another enrollment."); }
        return;
      }
      if (!response.ok || parseError || !validOutcome(value, frozen, recordId)) throw new Error("uncertain result");
      if (mounted.current) { setAttempt(null); setReview(null); setSelected([]); setMessage("The reviewed imported record was enrolled for Project Alpha synchronization."); onChanged?.(); }
    } catch (caught) {
      if (mounted.current && !(caught instanceof DOMException && caught.name === "AbortError"))
        setError("The enrollment outcome is uncertain. Retry only this same frozen enrollment request.");
    } finally { claimed.current = false; if (mounted.current) setBusy(false); }
  };
  return <Card title="Reviewed import enrollment">
    <p>Explicitly enroll an acquired imported {kind} in Project Alpha synchronization. This does not activate portal access or grant file access.</p>
    {!review && !message && <button type="button" className="button-ghost" disabled={busy} onClick={() => void load()}>
      {busy ? "Loading enrollment review…" : refreshRequired ? "Refresh enrollment review" : "Review sync enrollment"}</button>}
    {review && <section aria-label="Reviewed import enrollment sources">
      <dl><dt>Reviewed record version</dt><dd>{review.recordVersion}</dd><dt>Reviewed enrollment version</dt><dd>{review.enrollmentVersion}</dd></dl>
      <p>Choose newly eligible sources. Sources already enrolled are checked and locked.</p>
      {review.sources.length === 0 && <p>No Project Alpha sources are eligible for enrollment.</p>}
      {review.sources.map(source => <label key={source.sourceId} htmlFor={`${id}-${source.sourceId}`}>
        <input id={`${id}-${source.sourceId}`} type="checkbox" checked={selected.includes(source.sourceId)}
          disabled={busy || !!attempt || source.enrolled || !selected.includes(source.sourceId) && selected.length >= 16}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, source.sourceId] : previous.filter(value => value !== source.sourceId))} />
        {source.sourceId}{source.enrolled ? " (already enrolled)" : ""}
      </label>)}
      <button type="button" className="button-orange" disabled={busy || (!attempt
        && !review.sources.some(source => !source.enrolled && selected.includes(source.sourceId)))} onClick={() => void execute()}>
        {busy ? "Waiting for confirmation or enrollment…" : attempt ? "Retry same enrollment" : "Confirm reviewed enrollment"}</button>
    </section>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </Card>;
}
