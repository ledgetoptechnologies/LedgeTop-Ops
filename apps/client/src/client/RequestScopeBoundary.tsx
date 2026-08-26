import { useEffect, useState, type ReactNode } from "react";
import { loadPortalServiceDraft, type PortalProject, type PortalServiceDraft } from "./portal-api";
import { canBeginRequest, RequestAvailabilityMessage, useRequestAvailability, type RequestAvailability } from "./RequestAvailability";

function savedTarget(): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("request_scope") === "general" ? "" : params.get("request_scope") === "project" ? params.get("request_project") : null;
}
function SavedDraftSummary({ draft }: { draft: PortalServiceDraft }) {
  const answerText = (value: unknown): string => typeof value === "boolean" ? value ? "Yes" : "No"
    : typeof value === "string" || typeof value === "number" ? String(value)
      : Array.isArray(value) ? value.filter(item => typeof item === "string" || typeof item === "number").join(", ") : "Not recorded";
  return <section className="portal-saved-draft-summary" aria-labelledby="saved-draft-title">
    <h3 id="saved-draft-title">Saved draft — read only</h3>
    <p>Your saved answers are preserved. Editing and submission are unavailable until this request context is ready.</p>
    <h4>{draft.title || "Untitled request"}</h4><p>{draft.details || "No description saved."}</p>
    {draft.location && <p><strong>Location:</strong> {draft.location}</p>}
    {draft.services.map(service => <article key={service.publicId}><h4>{service.name}</h4><dl>
      {service.questions.map(question => <div key={question.id}><dt>{question.label}</dt><dd>{answerText(service.answers[question.id])}</dd></div>)}
    </dl></article>)}
  </section>;
}
function allowsReadOnlySnapshot(availability: RequestAvailability): boolean {
  return availability.state === "ready" && Boolean(availability.data
    && ["catalog_unavailable", "request_unavailable"].includes(availability.data.reason));
}
export function RequestScopeBoundary({ contextKey, workspaceId, availability, projects, fixedProjectId, draftId, children }: {
  contextKey: string; workspaceId: string | null; availability: RequestAvailability; projects: PortalProject[];
  fixedProjectId?: string; draftId?: string | null; children: (projectId: string | null, mode: "catalog" | "legacy") => ReactNode;
}) {
  const [target, setTarget] = useState<string | null>(() => fixedProjectId ?? (draftId ? null : savedTarget()));
  const [started, setStarted] = useState(Boolean(fixedProjectId) || (!draftId && savedTarget() !== null));
  const [draftState, setDraftState] = useState<"loading" | "ready" | "error">(draftId ? "loading" : "ready");
  const [draftRevision, setDraftRevision] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState<PortalServiceDraft | null>(null);
  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    setDraftState("loading");
    setSavedSnapshot(null);
    loadPortalServiceDraft(draftId, undefined, controller.signal).then(draft => {
      if (controller.signal.aborted) return;
      if (draft.state !== "draft" || fixedProjectId && draft.projectId !== fixedProjectId) throw new Error("Draft context unavailable");
      setSavedSnapshot(draft); setTarget(draft.projectId || ""); setStarted(true); setDraftState("ready");
    }).catch(() => { if (!controller.signal.aborted) setDraftState("error"); });
    return () => controller.abort();
  }, [draftId, draftRevision, fixedProjectId]);
  useEffect(() => {
    if (draftId || fixedProjectId) return;
    const sync = () => { const next = savedTarget(); setTarget(next); setStarted(next !== null); };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, [draftId, fixedProjectId]);
  const project = target ? projects.find(item => item.id === target && item.canRequestService) : null;
  const targetKnown = target === "" ? availability.data?.root.canStartRequest === true : Boolean(project);
  const exact = useRequestAvailability(target !== null && targetKnown && availability.state === "ready" ? contextKey : null, workspaceId, target || null);
  if (draftState === "loading") return <p role="status">Checking the saved request context…</p>;
  if (draftState === "error") return <div className="portal-inline-error" role="alert"><p>This saved draft could not be opened. It has not been moved or replaced.</p><button type="button" className="button-ghost" onClick={() => setDraftRevision(value => value + 1)}>Retry saved draft</button></div>;
  if (availability.state !== "ready" || !canBeginRequest(availability, projects)) return <><RequestAvailabilityMessage availability={availability} />{savedSnapshot && allowsReadOnlySnapshot(availability) && <SavedDraftSummary draft={savedSnapshot} />}</>;
  if (started && !targetKnown) return <div className="portal-inline-error" role="alert"><p>This request context is no longer available in your current access. Saved drafts have not been moved to another project.</p></div>;
  if (started) return exact.state === "ready" && exact.data?.canStartRequest
    ? <><p className="portal-request-target"><strong>Request context:</strong> {target ? project?.projectName : "New or one-off service"}</p>{children(target || null, exact.data.mode)}</>
    : <><RequestAvailabilityMessage availability={exact} />{savedSnapshot && allowsReadOnlySnapshot(exact) && <SavedDraftSummary draft={savedSnapshot} />}</>;
  return <section className="portal-request-scope" aria-labelledby="request-scope-title">
    <h3 id="request-scope-title">Choose the request context</h3><p>Select where this request belongs before choosing services. Existing drafts keep their saved project.</p>
    <label>Request context<select aria-label="Request context" value={target === null ? "choose" : target ? `project:${target}` : "general"} onChange={event => {
      const value = event.target.value; setTarget(value === "choose" ? null : value === "general" ? "" : value.slice("project:".length));
    }}><option value="choose">Choose a context</option>{availability.data?.root.canStartRequest && <option value="general">New or one-off service</option>}
      {availability.data?.projectRequestsSupported && projects.filter(item => item.canRequestService).map(item => <option key={item.id} value={`project:${item.id}`}>{item.projectName}</option>)}
    </select></label>
    {target !== null && (exact.state !== "ready" || !exact.data?.canStartRequest) && <RequestAvailabilityMessage availability={exact} />}
    <button type="button" className="button-orange" disabled={target === null || exact.state !== "ready" || !exact.data?.canStartRequest} onClick={() => {
      if (target === null || exact.state !== "ready" || !exact.data?.canStartRequest) return;
      const url = new URL(location.href); url.searchParams.set("request_scope", target ? "project" : "general");
      if (target) url.searchParams.set("request_project", target); else url.searchParams.delete("request_project");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); setStarted(true);
    }}>Start request</button>
  </section>;
}
