import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ViewerAssetOwnership,
  ViewerCatalogImportCandidate,
  ViewerCatalogImportMapResult,
  ViewerCatalogImportProvider,
  ViewerCatalogImportScanResult,
  ViewerDisplayUnits,
  ViewerDurableOperation,
  ViewerProcessingProject,
} from "@ltds/shared";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { ViewerAdminClient } from "./viewer-admin-client";
import {
  pollViewerOperation,
  readViewerOperationCheckpoints,
  removeViewerOperationCheckpoint,
  startViewerOperation,
  type ViewerOperationCheckpoint,
} from "./viewer-operation";

type CandidatePage = { candidates: ViewerCatalogImportCandidate[]; nextCursor: string | null };

export function ViewerCatalogImports({ client, projects, units, canImport }: {
  client: ViewerAdminClient | null;
  projects: ViewerProcessingProject[];
  units: ViewerDisplayUnits;
  canImport: boolean;
}): ReactElement {
  const [provider, setProvider] = useState<ViewerCatalogImportProvider>("webodm");
  const [state, setState] = useState<"unmapped" | "mapped" | "stale">("unmapped");
  const [candidates, setCandidates] = useState<ViewerCatalogImportCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [operation, setOperation] = useState<ViewerOperationCheckpoint | null>(() =>
    readViewerOperationCheckpoints().find(item => item.type === "catalog_scan" || item.type === "catalog_map") || null,
  );
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const requestGeneration = useRef(0), requestAbort = useRef<AbortController | null>(null);
  const query = useMemo(() => new URLSearchParams({ provider, state, limit: "50" }).toString(), [provider, state]);
  const load = useCallback(async (cursor?: string) => {
    if (!client || !canImport) return;
    const generation = ++requestGeneration.current;
    requestAbort.current?.abort(); const controller = new AbortController(); requestAbort.current = controller;
    const page = await client.request<CandidatePage>(`/api/v1/processing/catalog-imports/candidates?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
    if (generation !== requestGeneration.current) return;
    setCandidates(current => cursor ? [...current, ...page.candidates] : page.candidates);
    setNextCursor(page.nextCursor);
  }, [canImport, client, query]);
  useEffect(() => {
    setCandidates([]); setNextCursor(null);
    void load().catch(caught => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => { requestGeneration.current += 1; requestAbort.current?.abort(); };
  }, [load]);

  const watch = async (checkpoint: ViewerOperationCheckpoint) => {
    if (!client) return;
    const terminal = await pollViewerOperation(client, checkpoint, current => {
      setMessage(`${current.type === "catalog_scan" ? "Scanning" : "Importing"}: ${Math.round(current.progress * 100)}% · ${current.status}`);
    });
    if (terminal.status !== "succeeded") throw new Error(terminal.errorMessage || `Catalog operation ${terminal.status}`);
    removeViewerOperationCheckpoint(checkpoint.operationId); setOperation(null);
    if (terminal.type === "catalog_scan") {
      const result = terminal.result as ViewerCatalogImportScanResult;
      setMessage(`Scan ${result.scan.generation} found ${result.candidatesSeen} candidate${result.candidatesSeen === 1 ? "" : "s"}.`);
    } else {
      const result = terminal.result as ViewerCatalogImportMapResult;
      setMessage(`${result.task.displayName} is registered for review in ${result.project.displayName}.`);
    }
    await load();
  };
  const start = async (path: string, type: "catalog_scan" | "catalog_map", body: unknown) => {
    if (!client || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const started = await startViewerOperation(client, path, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body),
      }, type, { datasetId: null, uploadId: null });
      setOperation(started.checkpoint);
      if (!started.checkpointStored) setMessage("The import continues, but browser storage denied automatic recovery after this page closes.");
      await watch(started.checkpoint);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const resume = async () => {
    if (!operation || busy) return;
    setBusy(true); setError("");
    try { await watch(operation); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  if (!canImport) return <Card title="Existing model migration"><EmptyState title="Import permission required" detail="Existing WebODM and DJI Terra catalogs remain read-only." /></Card>;
  return <Card title="Existing model migration">
    <p>Scan approved read-only roots for models that are not yet in the LTDS catalog. Repeated scans and mapping requests are duplicate-safe; large WebODM assets remain referenced in place.</p>
    <div className="viewer-processing-form">
      <label>Source<select value={provider} onChange={event => setProvider(event.target.value as ViewerCatalogImportProvider)}><option value="webodm">Existing WebODM</option><option value="terra">DJI Terra exports</option></select></label>
      <label>Catalog state<select value={state} onChange={event => setState(event.target.value as typeof state)}><option value="unmapped">Unmapped</option><option value="mapped">Mapped</option><option value="stale">Changed or not seen</option></select></label>
      <button type="button" className="button-orange" disabled={busy || Boolean(operation)} onClick={() => void start("/api/v1/processing/catalog-imports/scans", "catalog_scan", { provider })}>Scan {provider === "webodm" ? "WebODM" : "Terra"}</button>
    </div>
    {operation && <p className="viewer-upload-resume" role="status">Durable {operation.type === "catalog_scan" ? "scan" : "model import"} {operation.operationId} can be resumed without duplication. <button type="button" className="button-orange button-small" disabled={busy} onClick={() => void resume()}>Resume status</button></p>}
    {message && <p role="status">{message}</p>}{error && <p className="viewer-processing-error" role="alert">{error}</p>}
    {!candidates.length ? <EmptyState title={`No ${state} ${provider === "webodm" ? "WebODM" : "Terra"} candidates`} detail="Run a scan after placing or mounting outputs in the configured source root." /> : <div className="viewer-processing-list">{candidates.map(candidate => <Candidate key={candidate.id} candidate={candidate} projects={projects} units={units} busy={busy || Boolean(operation)} map={(body) => start(`/api/v1/processing/catalog-imports/candidates/${encodeURIComponent(candidate.id)}/map`, "catalog_map", body)} />)}</div>}
    {nextCursor && <button type="button" className="button-ghost viewer-load-more" disabled={busy} onClick={() => void load(nextCursor).catch(caught => setError((caught as Error).message))}>Load 50 more</button>}
  </Card>;
}

function Candidate({ candidate, projects, units, busy, map }: {
  candidate: ViewerCatalogImportCandidate;
  projects: ViewerProcessingProject[];
  units: ViewerDisplayUnits;
  busy: boolean;
  map: (body: unknown) => Promise<void>;
}): ReactElement {
  const [destination, setDestination] = useState<"existing" | "new">(projects.length ? "existing" : "new");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [projectName, setProjectName] = useState(candidate.suggestedProjectName);
  const [taskName, setTaskName] = useState(candidate.suggestedTaskName);
  const [storageMode, setStorageMode] = useState<Exclude<ViewerAssetOwnership, "managed">>(candidate.provider === "webodm" ? "external_reference" : "adopted");
  const changedSource = candidate.state === "stale" && candidate.staleReason === "source_changed";
  const actionable = candidate.state === "unmapped" || changedSource;
  return <article className="viewer-catalog-candidate"><div><StatusPill tone={candidate.state === "mapped" ? "success" : candidate.state === "stale" ? "warning" : "neutral"}>{candidate.state === "stale" ? candidate.staleReason === "source_changed" ? "source changed" : "not seen" : candidate.state}</StatusPill><h3>{candidate.suggestedTaskName}</h3><p>{candidate.provider} project {candidate.externalProjectId} · task {candidate.externalTaskId}</p><p>{candidate.assetKinds.join(", ") || "Detected model assets"} · source fingerprint {candidate.sourceFingerprint.slice(0, 12)}…</p>{candidate.mapping && <p>Mapped to project {candidate.mapping.projectId}, task {candidate.mapping.taskId}, model {candidate.mapping.modelId}</p>}{candidate.staleReason === "source_changed" && <p className="viewer-processing-warning">The full source fingerprint changed. Importing creates a new immutable dataset snapshot, attempt, and model version while preserving the existing project, task, and model identities.</p>}{candidate.staleReason === "not_seen" && <p>This source was not present in the latest scan and cannot be imported until it is detected again.</p>}</div>
    {actionable && <details className="viewer-task-catalog"><summary>{changedSource ? "Import changed source as a new version" : "Map into LTDS"}</summary><form onSubmit={event => { event.preventDefault(); void map({ ...(changedSource ? { projectId: candidate.mapping!.projectId } : destination === "existing" ? { projectId } : { newProject: { displayName: projectName.trim(), defaultUnits: units } }), taskDisplayName: taskName.trim(), storageMode }); }}>
      {changedSource ? <p><strong>Existing catalog identity is preserved.</strong> Project {candidate.mapping?.projectId}, task {candidate.mapping?.taskId}, and model {candidate.mapping?.modelId} remain fixed. LTDS creates a new immutable dataset, attempt, and model version.</p> : <>
      <label>Project destination<select value={destination} onChange={event => setDestination(event.target.value as typeof destination)}><option value="existing" disabled={!projects.length}>Existing LTDS project</option><option value="new">Create new LTDS project</option></select></label>
      {destination === "existing" ? <label>LTDS project<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.filter(project => project.status === "active").map(project => <option key={project.id} value={project.id}>{project.displayName}</option>)}</select></label> : <label>New project name<input maxLength={160} value={projectName} onChange={event => setProjectName(event.target.value)} /></label>}
      </>}
      <label>Friendly task name<input maxLength={160} value={taskName} onChange={event => setTaskName(event.target.value)} /></label>
      <label>Asset ownership<select value={storageMode} onChange={event => setStorageMode(event.target.value as typeof storageMode)}><option value="external_reference">Reference source in place</option>{candidate.provider === "terra" && <option value="adopted">Adopt into LTDS storage</option>}</select></label>
      <button className="button-orange button-small" disabled={busy || !taskName.trim() || (!changedSource && (destination === "existing" ? !projectId : !projectName.trim()))}>{changedSource ? "Register new dataset and version" : "Map and register model"}</button>
    </form></details>}
  </article>;
}
