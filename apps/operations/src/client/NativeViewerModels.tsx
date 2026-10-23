import { projectAlphaSourceName, type ViewerModelSummary } from "@ltds/shared";
import { Card, EmptyState, Skeleton, StatusPill, openViewerShell } from "@ltds/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { operationsViewerShellPath, validNativeViewerTarget, type NativeViewerTarget } from "./OperationsViewerShell";

export type NativeViewerProject = NativeViewerTarget & { workspaceName: string; projectName: string; clientName: string };
export type NativeViewerAssociation = {
  id: string; projectId: string; projectAlphaProjectId: string; projectSourceVersion: string;
  projectName: string; clientName: string; viewerModelId: string; viewerModelVersionId: string;
  modelTitle: string; modelProvider: string; state: "active" | "revoked" | "source_stale"; updatedAt: string;
};
type NativeViewerData = { enabled: boolean; projects: NativeViewerProject[]; models: ViewerModelSummary[]; associations: NativeViewerAssociation[] };
type Failure = Error & { status?: number };

const targetOf = (project: NativeViewerTarget): NativeViewerTarget => ({ sourceId: project.sourceId, workspaceId: project.workspaceId,
  projectPublicId: project.projectPublicId, projectId: project.projectId, generationId: project.generationId, sourceVersion: project.sourceVersion });
const targetKey = (target: NativeViewerTarget) => [target.sourceId, target.workspaceId, target.projectPublicId, target.projectId, target.generationId, target.sourceVersion].join("\u0000");
/** A definite answer from the server; anything else may already have been applied. */
const uncertain = (caught: unknown) => { const status = (caught as Failure | null)?.status ?? 0; return !status || status >= 500; };

export function validNativeViewerData(value: unknown): value is NativeViewerData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return typeof data.enabled === "boolean" && Array.isArray(data.projects) && Array.isArray(data.models) && Array.isArray(data.associations)
    && data.projects.every(project => project && typeof project === "object" && validNativeViewerTarget(project as Record<string, unknown>)
      && typeof (project as NativeViewerProject).projectName === "string" && typeof (project as NativeViewerProject).workspaceName === "string")
    && data.associations.every(item => item && typeof item === "object" && typeof (item as NativeViewerAssociation).id === "string"
      && typeof (item as NativeViewerAssociation).projectId === "string" && typeof (item as NativeViewerAssociation).viewerModelId === "string");
}

/** Every current native target an association can be opened through (a shared project may appear in several client accounts). */
export function associationTargets(association: NativeViewerAssociation, projects: NativeViewerProject[]): NativeViewerProject[] {
  return projects.filter(project => project.projectId === association.projectId && project.projectPublicId === association.projectAlphaProjectId
    && project.sourceVersion === association.projectSourceVersion);
}

/**
 * Native client-project model links for general Ledge Top use. Staff open a linked model
 * against the exact returned target; linking reuses the published model's assets and
 * grants no client access by itself.
 */
export function NativeViewerModels({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<NativeViewerData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  // An uncertain link request is retried with the identical body and key; any change of selection needs a new key.
  // It is kept independently of later catalog reads, so a refreshed generation can't strand it.
  const pending = useRef<{ body: string; key: string; modelTitle: string; projectName: string } | null>(null);
  const [uncertainLink, setUncertainLink] = useState(false);
  const run = useRef(0);

  const load = useCallback(async () => {
    const current = ++run.current;
    setLoadError("");
    try {
      const value = await api<unknown>("/api/viewer/native-associations");
      if (current !== run.current) return;
      if (!validNativeViewerData(value)) throw new Error("invalid_response");
      setData(value);
    } catch (caught) {
      if (current !== run.current) return;
      setData(null);
      setLoadError((caught as Failure).status === 403 ? "You don't have access to the client model catalog." : "Client models couldn't be loaded. Try again.");
    }
  }, []);
  useEffect(() => { void load(); return () => { run.current += 1; }; }, [load]);

  const projects = data?.projects ?? [];
  const readyModels = useMemo(() => (data?.models ?? []).filter(model => model.available && model.status === "ready" && model.activeVersion), [data?.models]);
  const selectedProject = projects.find(project => targetKey(project) === projectKey) ?? null;
  const selectedModel = readyModels.find(model => model.id === modelId) ?? null;
  const filter = query.trim().toLowerCase();
  const associations = (data?.associations ?? []).filter(item => !filter || [item.modelTitle, item.projectName, item.clientName].some(text => text.toLowerCase().includes(filter)));
  const select = (apply: () => void) => { if (uncertainLink || busy) return; apply(); pending.current = null; setMessage(""); setError(""); };

  const link = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!uncertainLink) {
      if (!selectedProject || !selectedModel) return;
      const body = JSON.stringify({ ...targetOf(selectedProject), viewerModelId: selectedModel.id });
      if (!pending.current || pending.current.body !== body)
        pending.current = { body, key: crypto.randomUUID(), modelTitle: selectedModel.title, projectName: selectedProject.projectName };
    }
    // An unconfirmed link is retried exactly as sent, whatever the catalog shows now.
    const request = pending.current;
    if (!request) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ replayed?: boolean }>("/api/viewer/native-associations", { method: "POST", headers: { "Idempotency-Key": request.key }, body: request.body });
      pending.current = null; setUncertainLink(false);
      setMessage(result.replayed ? "This link was already saved." : `${request.modelTitle} is linked to ${request.projectName}.`);
      setProjectKey(""); setModelId("");
      await load();
    } catch (caught) {
      if (uncertain(caught)) { setUncertainLink(true); setError("The link result isn't confirmed. Retrying sends exactly the same link."); return; }
      pending.current = null; setUncertainLink(false);
      if ((caught as Failure).status === 409) {
        // The project changed under the selection: reload and let the operator choose again; never substitute another target.
        setProjectKey(""); await load();
        setError("That client project changed or is no longer available. Review the current list and choose again.");
      } else setError((caught as Failure).status === 403 ? "You don't have permission to link models." : (caught as Error).message || "The model couldn't be linked.");
    } finally { setBusy(false); }
  };

  const open = (association: NativeViewerAssociation, target: NativeViewerProject) => {
    setError("");
    try { openViewerShell(operationsViewerShellPath({ associationId: association.id, modelId: association.viewerModelId, native: targetOf(target) })); }
    catch (caught) { setError((caught as Error).message); }
  };

  if (loadError) return <Card title="Client models"><p className="notice error" role="alert">{loadError}</p><button type="button" className="button-ghost" onClick={() => void load()}>Try again</button></Card>;
  if (!data) return <Card title="Client models"><Skeleton variant="list" rows={3} label="Loading client models…" /></Card>;
  if (!data.enabled) return <Card title="Client models"><EmptyState title="The 3D Viewer is off" detail="Client models appear here once the Viewer integration is enabled." /></Card>;

  return <div className="viewer-native-models">
    {canManage && <Card title="Link a model to a client project">
      <p className="viewer-association-help">Links a published, ready model to one client project. The model's existing files are reused, nothing is reprocessed, and the client still can't see it until they're separately given access.</p>
      <form className="viewer-association-form" onSubmit={event => void link(event)}>
        <label>Client project<select value={projectKey} disabled={busy || uncertainLink} required onChange={event => select(() => setProjectKey(event.target.value))}>
          <option value="">{projects.length ? "Choose a client project" : "No client projects are available"}</option>
          {[...new Set(projects.map(project => project.sourceId))].map(sourceId => <optgroup key={sourceId} label={projectAlphaSourceName(sourceId)}>
            {projects.filter(project => project.sourceId === sourceId).map(project => <option key={targetKey(project)} value={targetKey(project)}>{project.workspaceName} · {project.projectName}</option>)}
          </optgroup>)}
        </select></label>
        <label>Model<select value={modelId} disabled={busy || uncertainLink} required onChange={event => select(() => setModelId(event.target.value))}>
          <option value="">{readyModels.length ? "Choose a ready model" : "No ready models"}</option>
          {readyModels.map(model => <option key={model.id} value={model.id}>{model.title}</option>)}
        </select></label>
        <button type="submit" className="button-orange" disabled={busy || (uncertainLink ? !pending.current : !selectedProject || !selectedModel)}>{busy ? "Linking…" : uncertainLink ? "Retry same link" : "Link model"}</button>
      </form>
    </Card>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    <Card title="Linked client models" action={<button type="button" className="button-ghost button-small" disabled={busy || uncertainLink} onClick={() => void load()}>Refresh</button>}>
      {data.associations.length > 6 && <label className="viewer-native-search">Find a model<input type="search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} placeholder="Model, project or client" /></label>}
      {!data.associations.length ? <EmptyState title="No client models yet" detail={canManage ? "Link a ready model to a client project above." : "Models appear here once they're linked to a client project."} />
        : !associations.length ? <p>No linked models match “{query}”.</p>
        : <div className="viewer-association-list">{associations.map(association => {
          const targets = association.state === "active" ? associationTargets(association, projects) : [];
          return <article key={association.id}>
            <div><StatusPill tone={association.state === "active" ? "success" : association.state === "source_stale" ? "warning" : "danger"}>
              {association.state === "active" ? "Linked" : association.state === "source_stale" ? "Project changed" : "Removed"}</StatusPill>
              <h3>{association.modelTitle}</h3><p>{association.clientName} · {association.projectName}</p>
              {association.state === "source_stale" && <small>The project changed since this model was linked. Link it again to keep it available.</small>}
              {association.state === "active" && !targets.length && <small>This project isn't currently available in any client account.</small>}</div>
            <div className="viewer-native-open">{targets.map(target => <button key={targetKey(target)} type="button" className="button-orange button-small" onClick={() => open(association, target)}>
              {targets.length > 1 ? `Open for ${target.workspaceName}` : "Open model"}</button>)}</div>
          </article>;
        })}</div>}
    </Card>
  </div>;
}
