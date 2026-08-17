import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ViewerDatasetImportPreview,
  ViewerDatasetSummary,
  ViewerDatasetUploadGrant,
  ViewerDisplayUnits,
  ViewerDurableOperationResponse,
  ViewerProcessingAttempt,
  ViewerProcessingAttemptDetail,
  ViewerProcessingAttemptPage,
  ViewerProcessingPreset,
  ViewerProcessingProject,
  ViewerProcessingTask,
  ViewerOutputSummary,
  ViewerProjectStorageResponse,
  ViewerProviderSummary,
  ViewerReviewSessionGrant,
  ViewerStorageSummary,
  ViewerTaskStorageResponse,
} from "@ltds/shared";
import { Card, EmptyState, Loading, StatusPill, ViewerEmbed } from "@ltds/ui";
import { api } from "./api";
import { hashFileOffThread } from "./file-hash";
import {
  canonicalUploadPath,
  clearUploadCheckpoint,
  readUploadCheckpoint,
  uploadManifestSignature,
  writeUploadCheckpoint,
  type ViewerUploadCheckpoint,
} from "./upload-checkpoint";
import { ViewerAdminClient } from "./viewer-admin-client";
import { GcpWorkspace } from "./GcpWorkspace";
import { ViewerCatalogImports } from "./ViewerCatalogImports";
import { AdvancedJsonEditor, OptionEditor, ViewerPresetSettings } from "./ViewerPresetSettings";
import { providerCredentialError } from "./provider-credential";
import { defaultViewerProviderOverrides } from "./provider-options";
import {
  clearViewerTaskSubmissionCheckpoint,
  newViewerTaskSubmissionCheckpoint,
  readViewerTaskSubmissionCheckpoint,
  resumeViewerTaskSubmission,
  writeViewerTaskSubmissionCheckpoint,
  type ViewerTaskSubmissionCheckpoint,
} from "./viewer-task-submission";
import {
  clearViewerTaskDraftCheckpoint,
  newViewerTaskDraftCheckpoint,
  readViewerTaskDraftCheckpoint,
  resumeViewerTaskDraft,
  writeViewerTaskDraftCheckpoint,
  type ViewerTaskDraftCheckpoint,
} from "./viewer-task-draft";
import {
  assertViewerOperation,
  pollViewerOperation,
  readViewerOperationCheckpoints,
  readViewerPendingOperationRequests,
  recoverViewerPendingOperations,
  removeViewerOperationCheckpoint,
  startViewerOperation,
  type ViewerOperationCheckpoint,
} from "./viewer-operation";

type ProcessingEvent = {
  event_id: string; event_type: string; project_id: string; project_display_name: string | null; task_id: string; task_display_name: string | null; attempt_id: string;
  status: string; error_message: string | null; review_url: string | null;
  acknowledged_at: string | null; received_at: string;
};
type Bootstrap = {
  enabled: boolean;
  viewerBaseUrl: string | null;
  permissions: string[];
  units: { default: ViewerDisplayUnits; resolved: ViewerDisplayUnits };
  events: ProcessingEvent[];
};
type Tab = "projects" | "datasets" | "gcp" | "tasks" | "outputs" | "imports" | "providers" | "storage" | "shares" | "settings";
type PagedKind = "projects" | "datasets" | "tasks" | "outputs" | "providers";
type PageCursors = Record<PagedKind, string | null>;

function firstArray<T>(payload: unknown, key: string): T[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}

function pageCursor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).nextCursor;
  return typeof value === "string" && value ? value : null;
}

async function chunkHash(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

type UploadProcessingRole = "image" | "gcp_source" | "provider_input" | "administrative";
type UploadManifestFile = { id: string; relativePath: string; byteSize: number; sha256: string; contentType?: string; processingRole: UploadProcessingRole; file: File };

function uploadExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").split(".").at(-1) || "";
}

function processingRoleForUpload(path: string): UploadProcessingRole {
  const extension = uploadExtension(path);
  if (["jpg", "jpeg", "png", "tif", "tiff", "dng", "raw", "heic"].includes(extension)) return "image";
  if (extension === "csv") return "gcp_source";
  return "administrative";
}

function selectableProcessingRoles(path: string): UploadProcessingRole[] {
  const extension = uploadExtension(path);
  if (extension === "csv") return ["gcp_source", "administrative"];
  if (["txt", "geojson", "json", "zip", "las", "laz"].includes(extension)) return ["administrative", "provider_input"];
  return [processingRoleForUpload(path)];
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function retryUpload<T>(action: () => Promise<T>, signal: AbortSignal, attempts = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    try { return await action(); }
    catch (error) {
      last = error;
      if (signal.aborted || attempt === attempts - 1) throw error;
      const delay = Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, delay);
        signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new DOMException("Upload cancelled", "AbortError")); }, { once: true });
      });
    }
  }
  throw last;
}

export function ViewerProcessingPanel({ mapToken }: { mapToken: string | null }): ReactElement {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [projects, setProjects] = useState<ViewerProcessingProject[]>([]);
  const [datasets, setDatasets] = useState<ViewerDatasetSummary[]>([]);
  const [tasks, setTasks] = useState<ViewerProcessingTask[]>([]);
  const [providers, setProviders] = useState<ViewerProviderSummary[]>([]);
  const [outputs, setOutputs] = useState<ViewerOutputSummary[]>([]);
  const [outputTotals, setOutputTotals] = useState({ count: 0, bytes: 0 });
  const [presets, setPresets] = useState<ViewerProcessingPreset[]>([]);
  const [storage, setStorage] = useState<ViewerStorageSummary | null>(null);
  const [reviewAttempt, setReviewAttempt] = useState<ViewerProcessingAttemptDetail | null>(null);
  const [pendingGcpDraftId, setPendingGcpDraftId] = useState<string | null>(null);
  const [projectContext, setProjectContext] = useState<string | null>(null);
  const [cursors, setCursors] = useState<PageCursors>({ projects: null, datasets: null, tasks: null, outputs: null, providers: null });
  const [tab, setTab] = useState<Tab>(() => {
    const pending = readViewerOperationCheckpoints()[0];
    return pending?.type === "upload_finalize" ? "datasets" :
      pending?.type === "import_adopt" || pending?.type === "import_preview" || pending?.type === "catalog_scan" || pending?.type === "catalog_map" ? "imports" : "projects";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pendingReceiptCount, setPendingReceiptCount] = useState(() => readViewerPendingOperationRequests().length);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const clientRef = useRef<ViewerAdminClient | null>(null);
  const loadGeneration = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const reviewTabSelected = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    loadAbort.current?.abort();
    const controller = new AbortController(); loadAbort.current = controller;
    const config = await api<Bootstrap>("/api/viewer/processing");
    if (generation !== loadGeneration.current) return;
    setBootstrap(config);
    if (!config.enabled || !config.viewerBaseUrl) return;
    const client = clientRef.current?.origin === config.viewerBaseUrl
      ? clientRef.current
      : new ViewerAdminClient(config.viewerBaseUrl);
    clientRef.current = client;
    const requestedAttempt = new URLSearchParams(window.location.search).get("attemptId");
    const safeAttempt = requestedAttempt && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestedAttempt) ? requestedAttempt : null;
    const [projectData, datasetData, taskData, outputData, providerData, presetData, storageData, reviewData] = await Promise.all([
      client.request("/api/v1/projects?limit=50", { signal: controller.signal }), client.request("/api/v1/datasets?limit=50", { signal: controller.signal }),
      client.request("/api/v1/tasks?limit=50", { signal: controller.signal }), client.request("/api/v1/processing/outputs?limit=50", { signal: controller.signal }),
      client.request("/api/v1/processing/providers?limit=50", { signal: controller.signal }),
      client.request("/api/v1/processing/presets", { signal: controller.signal }),
      client.request<ViewerStorageSummary>("/api/v1/storage?limit=50", { signal: controller.signal }),
      safeAttempt ? client.request<ViewerProcessingAttemptDetail>(`/api/v1/attempts/${encodeURIComponent(safeAttempt)}`, { signal: controller.signal }) : Promise.resolve(null),
    ]);
    if (generation !== loadGeneration.current) return;
    setProjects(firstArray(projectData, "projects"));
    setDatasets(firstArray(datasetData, "datasets"));
    // The task list contract includes latestAttempt; never fan out one detail
    // request per row because a real catalog would create an unbounded N+1.
    setTasks(firstArray(taskData, "tasks"));
    setOutputs(firstArray(outputData, "outputs"));
    setOutputTotals({
      count: typeof (outputData as Record<string, unknown>)?.totalCount === "number" ? (outputData as { totalCount: number }).totalCount : 0,
      bytes: typeof (outputData as Record<string, unknown>)?.totalBytes === "number" ? (outputData as { totalBytes: number }).totalBytes : 0,
    });
    setProviders(firstArray(providerData, "providers"));
    setPresets(firstArray(presetData, "presets"));
    setStorage(storageData);
    setReviewAttempt(reviewData);
    if (reviewData && !reviewTabSelected.current) {
      reviewTabSelected.current = true;
      setTab("tasks");
    }
    setCursors({ projects: pageCursor(projectData), datasets: pageCursor(datasetData), tasks: pageCursor(taskData), outputs: pageCursor(outputData), providers: pageCursor(providerData) });
  }, []);

  useEffect(() => { load().catch(caught => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); }); return () => loadAbort.current?.abort(); }, [load]);
  useEffect(() => {
    if (pendingGcpDraftId && tasks.some(task => task.id === pendingGcpDraftId && task.status === "draft")) {
      clearViewerTaskDraftCheckpoint(); setPendingGcpDraftId(null); setTab("gcp");
    }
  }, [pendingGcpDraftId, tasks]);
  const loadMore = async (kind: PagedKind) => {
    const client = clientRef.current, cursor = cursors[kind];
    if (!client || !cursor || busy) return;
    setBusy(true); setError("");
    try {
      const path = kind === "providers" ? "/api/v1/processing/providers" : kind === "outputs" ? "/api/v1/processing/outputs" : `/api/v1/${kind}`;
      const payload = await client.request(`${path}?limit=50&cursor=${encodeURIComponent(cursor)}`);
      if (kind === "projects") setProjects(current => [...current, ...firstArray<ViewerProcessingProject>(payload, kind)]);
      if (kind === "datasets") setDatasets(current => [...current, ...firstArray<ViewerDatasetSummary>(payload, kind)]);
      if (kind === "tasks") setTasks(current => [...current, ...firstArray<ViewerProcessingTask>(payload, kind)]);
      if (kind === "outputs") {
        setOutputs(current => [...current, ...firstArray<ViewerOutputSummary>(payload, kind)]);
        const totals = payload as { totalCount?: number; totalBytes?: number };
        setOutputTotals(current => ({ count: totals.totalCount ?? current.count, bytes: totals.totalBytes ?? current.bytes }));
      }
      if (kind === "providers") setProviders(current => [...current, ...firstArray<ViewerProviderSummary>(payload, kind)]);
      setCursors(current => ({ ...current, [kind]: pageCursor(payload) }));
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const loadMoreTrash = async () => {
    const client = clientRef.current, cursor = storage?.trash.nextCursor;
    if (!client || !cursor || busy) return;
    setBusy(true); setError("");
    try {
      const page = await client.request<ViewerStorageSummary>(`/api/v1/storage?limit=50&cursor=${encodeURIComponent(cursor)}`);
      setStorage(current => current ? { storage: page.storage, trash: {
        items: [...current.trash.items, ...page.trash.items], nextCursor: page.trash.nextCursor,
        totalCount: page.trash.totalCount, totalBytes: page.trash.totalBytes,
      } } : page);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const mutate = async (action: (client: ViewerAdminClient) => Promise<unknown>, success: string) => {
    const client = clientRef.current;
    if (!client || busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(client); await load(); setMessage(success); }
    catch (caught) { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const query = async (action: (client: ViewerAdminClient) => Promise<unknown>) => {
    const client = clientRef.current;
    if (!client || busy) return;
    setBusy(true); setError("");
    try { await action(client); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const can = (permission: string) => bootstrap?.permissions.includes(permission) === true;
  const recoverAcceptedRequests = async () => {
    const client = clientRef.current;
    if (!client || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await recoverViewerPendingOperations(client);
      setPendingReceiptCount(readViewerPendingOperationRequests().length);
      if (result.recovered.length) {
        const first = result.recovered[0]!;
        setTab(first.type === "upload_finalize" ? "datasets" : "imports");
        setRecoveryVersion(value => value + 1);
      }
      const parts = [
        result.recovered.length ? `${result.recovered.length} accepted operation${result.recovered.length === 1 ? "" : "s"} restored` : "",
        result.stillPending ? `${result.stillPending} request${result.stillPending === 1 ? " is" : "s are"} still reconciling in Viewer` : "",
        result.unknown ? `${result.unknown} request${result.unknown === 1 ? " was" : "s were"} confirmed not accepted` : "",
      ].filter(Boolean);
      setMessage(parts.length ? `${parts.join("; ")}.` : "There are no accepted requests waiting for recovery.");
    } catch (caught) {
      setError((caught as Error).message);
    } finally { setBusy(false); }
  };

  if (!bootstrap) return <Card title="Processing platform"><Loading /></Card>;
  if (!bootstrap.enabled) return <Card title="Processing platform"><EmptyState
    title="Dataset processing is disabled"
    detail="The catalog and existing published 3D models remain available. Enable processing only after Viewer storage, provider, callback, and recovery checks pass."
  /></Card>;
  return <section className="viewer-processing" aria-label="3D processing platform">
    <Card title="Processing platform">
      <div className="viewer-processing-toolbar">
        <div><StatusPill tone="success">Direct to Viewer</StatusPill><p>Metadata and resumable chunks go directly to Viewer. Delivery R2 uploads remain separate.</p></div>
        <label>Measurement units<select value={bootstrap.units.resolved} onChange={event => {
          const displayUnits = event.target.value as ViewerDisplayUnits;
          void api("/api/viewer/preferences", { method: "PATCH", body: JSON.stringify({ displayUnits }) })
            .then(() => load()).catch(caught => setError((caught as Error).message));
        }}><option value="imperial">Imperial</option><option value="metric">Metric</option></select></label>
      </div>
      <nav className="viewer-processing-tabs" aria-label="Processing sections">
        {(["projects","datasets","gcp","tasks","outputs","imports","providers","storage","shares","settings"] as Tab[]).map(value =>
          <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => { setProjectContext(null); setTab(value); }}>{value === "gcp" ? "Ground control" : value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </nav>
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {pendingReceiptCount > 0 && <div className="notice" role="status">Viewer may already have accepted {pendingReceiptCount} request{pendingReceiptCount === 1 ? "" : "s"} whose response was interrupted. No upload token, preview token, or request body is stored here. <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void recoverAcceptedRequests()}>Recover accepted requests</button></div>}
      {clientRef.current?.status().renewalError && <div className="notice" role="status">Viewer authorization renewal will retry; the current session remains active until expiry.</div>}
    </Card>

    {tab === "projects" && <Projects projects={projects} datasets={datasets} tasks={tasks} canWrite={can("viewer.projects.write")} busy={busy} mutate={mutate} query={query} units={bootstrap.units.resolved} nextCursor={cursors.projects} loadMore={() => loadMore("projects")} navigate={(next, projectId) => { setProjectContext(projectId); setTab(next); }} />}
    {tab === "datasets" && <Datasets key={`datasets-${recoveryVersion}`} projects={projects} datasets={datasets} preferredProjectId={projectContext} canWrite={can("viewer.datasets.write")} canTrash={can("viewer.storage.purge")} busy={busy} mutate={mutate} nextCursor={cursors.datasets} loadMore={() => loadMore("datasets")} />}
    {tab === "gcp" && clientRef.current && <GcpWorkspace client={clientRef.current} datasets={datasets} tasks={tasks} mapToken={mapToken} units={bootstrap.units.resolved} canRead={can("viewer.gcp.read")} canWrite={can("viewer.gcp.write")} onReturnToTasks={() => setTab("tasks")} />}
    {tab === "tasks" && <Tasks client={clientRef.current} tasks={tasks} datasets={datasets} preferredProjectId={projectContext} providers={providers} presets={presets} canWrite={can("viewer.processing.write")} canPublish={can("viewer.processing.publish")} busy={busy} mutate={mutate} query={query} nextCursor={cursors.tasks} loadMore={() => loadMore("tasks")} onDraftCreated={setPendingGcpDraftId} />}
    {tab === "outputs" && <Outputs outputs={outputs} totals={outputTotals} canPublish={can("viewer.processing.publish")} busy={busy} mutate={mutate} nextCursor={cursors.outputs} loadMore={() => loadMore("outputs")} />}
    {tab === "imports" && <><ViewerCatalogImports key={`catalog-${recoveryVersion}`} client={clientRef.current} projects={projects} preferredProjectId={projectContext} units={bootstrap.units.resolved} canImport={can("viewer.datasets.import")} /><Imports key={`imports-${recoveryVersion}`} client={clientRef.current} projects={projects} preferredProjectId={projectContext} canImport={can("viewer.datasets.import")} busy={busy} mutate={mutate} /></>}
    {tab === "providers" && <Providers providers={providers} canWrite={can("viewer.providers.write")} busy={busy} mutate={mutate} nextCursor={cursors.providers} loadMore={() => loadMore("providers")} />}
    {tab === "storage" && <Storage summary={storage} canPurge={can("viewer.storage.purge")} busy={busy} mutate={mutate} loadMore={loadMoreTrash} />}
    {tab === "shares" && <Card title="Shares"><p>Published-model demo links, expiry, revocation, passwords, units, and download policy are managed in Public demo links below. Raw dataset inputs and processing logs are never share candidates.</p><a className="button-orange button-small" href="#viewer-public-shares">Go to public demo links</a></Card>}
    {tab === "settings" && <><ViewerPresetSettings presets={presets} providers={providers} canWrite={can("viewer.providers.write")} busy={busy} mutate={mutate} /><Card title="Viewer settings"><p>Installation units default to imperial. Each staff member may override measurement display without changing canonical stored values. Provider endpoints, admission limits, credentials, and health are managed in Providers.</p></Card></>}

    {reviewAttempt && <Card title="Requested processing review"><StatusPill tone={reviewAttempt.attempt.status === "ready_for_review" ? "success" : reviewAttempt.attempt.status === "failed" ? "danger" : "warning"}>{reviewAttempt.attempt.status}</StatusPill><p>Attempt {reviewAttempt.attempt.id} · task {reviewAttempt.attempt.taskId} · dataset {reviewAttempt.attempt.datasetId} · {Math.round((reviewAttempt.attempt.progress || 0) * 100)}%</p>{reviewAttempt.attempt.errorMessage && <p className="viewer-processing-error">{reviewAttempt.attempt.errorMessage}</p>}<details><summary>Sanitized processing logs</summary><ol>{reviewAttempt.logs.map((log, index) => <li key={`${log.created_at}-${index}`}>{log.created_at} · {log.level} · {log.message}</li>)}</ol></details></Card>}

    {!!bootstrap.events.length && <Card title="Processing notifications"><div className="viewer-processing-list">
      {bootstrap.events.map(event => <article key={event.event_id}>
        <div><StatusPill tone={event.event_type === "processing.failed" ? "danger" : "success"}>{event.status}</StatusPill>
          <h3>{event.task_display_name || `Task ${event.task_id}`}</h3><p>{event.project_display_name || `Project ${event.project_id}`} · {event.error_message || `Attempt ${event.attempt_id} is ready for review.`}</p></div>
        <div>{event.review_url && <a className="button-orange button-small" href={`/operations/processing?attemptId=${encodeURIComponent(event.attempt_id)}`}>Review</a>}
          {!event.acknowledged_at && <button className="button-ghost button-small" type="button" onClick={() => void api(`/api/viewer/events/${encodeURIComponent(event.event_id)}/acknowledge`, { method: "POST" }).then(load)}>Acknowledge</button>}</div>
      </article>)}
    </div></Card>}
  </section>;
}

type Mutate = (action: (client: ViewerAdminClient) => Promise<unknown>, success: string) => Promise<void>;
type Query = (action: (client: ViewerAdminClient) => Promise<unknown>) => Promise<void>;
function Pager({ nextCursor, busy, loadMore }: { nextCursor: string | null; busy: boolean; loadMore: () => void }) {
  return nextCursor ? <button type="button" className="button-ghost viewer-load-more" disabled={busy} onClick={loadMore}>Load 50 more</button> : <></>;
}
function normalizedTags(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(tag => tag.trim()).filter(Boolean))];
}
function Projects({ projects, datasets, tasks, canWrite, busy, mutate, query, units, nextCursor, loadMore, navigate }: { projects: ViewerProcessingProject[]; datasets: ViewerDatasetSummary[]; tasks: ViewerProcessingTask[]; canWrite: boolean; busy: boolean; mutate: Mutate; query: Query; units: ViewerDisplayUnits; nextCursor: string | null; loadMore: () => void; navigate: (tab: Tab, projectId: string) => void }) {
  const [name, setName] = useState("");
  return <Card title="Projects">{canWrite && <form className="viewer-processing-form" onSubmit={event => {
    event.preventDefault(); const displayName = name.trim(); if (!displayName) return;
    void mutate(client => client.request("/api/v1/projects", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName, defaultUnits: units }) }), "Project created.").then(() => setName(""));
  }}><label>Friendly project name<input maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label><button className="button-orange" disabled={busy || !name.trim()}>Create project</button></form>}
    {!projects.length ? <EmptyState title="No processing projects" detail="Create a project to organize reusable datasets and tasks." /> : <div className="viewer-processing-list">{projects.map(project => {
      const projectDatasets = datasets.filter(dataset => dataset.projectId === project.id);
      const projectTasks = tasks.filter(task => task.projectId === project.id);
      return <article key={project.id}><div><h3>{project.displayName}</h3><p>{project.description || "No description"}</p><p>{project.defaultUnits} · {project.status} · stable ID {project.id}</p>{project.tags.length > 0 && <p>Tags: {project.tags.join(", ")}</p>}
        <details className="viewer-project-contents"><summary>Tasks, datasets, and actions</summary>
          <p>{projectDatasets.length} loaded dataset{projectDatasets.length === 1 ? "" : "s"} · {projectTasks.length} loaded task{projectTasks.length === 1 ? "" : "s"}</p>
          <div className="viewer-project-columns"><section><h4>Datasets</h4>{projectDatasets.length ? <ul>{projectDatasets.map(dataset => <li key={dataset.id}>{dataset.displayName} · {dataset.status}</li>)}</ul> : <p>No loaded datasets.</p>}</section><section><h4>Tasks</h4>{projectTasks.length ? <ul>{projectTasks.map(task => <li key={task.id}>{task.displayName} · {task.status}</li>)}</ul> : <p>No loaded tasks.</p>}</section></div>
          <div className="viewer-project-actions"><button type="button" className="button-ghost button-small" onClick={() => navigate("datasets", project.id)}>Add dataset to {project.displayName}</button><button type="button" className="button-ghost button-small" onClick={() => navigate("tasks", project.id)}>Create task in {project.displayName}</button><button type="button" className="button-ghost button-small" onClick={() => navigate("imports", project.id)}>Import model into {project.displayName}</button><button type="button" className="button-ghost button-small" onClick={() => navigate("shares", project.id)}>Open share management</button></div>
        </details><ProjectStorageDetails project={project} busy={busy} query={query} /></div><div>{canWrite && <ProjectCatalogControls project={project} busy={busy} mutate={mutate} />}{canWrite && project.status === "active" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/projects/${encodeURIComponent(project.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Project archived; stable IDs and published model links are unchanged.")}>Archive</button>}</div></article>;
    })}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function ProjectCatalogControls({ project, busy, mutate }: { project: ViewerProcessingProject; busy: boolean; mutate: Mutate }) {
  const [displayName, setDisplayName] = useState(project.displayName), [description, setDescription] = useState(project.description || "");
  const [tags, setTags] = useState(project.tags.join(", ")), [defaultUnits, setDefaultUnits] = useState(project.defaultUnits);
  return <details className="viewer-task-catalog"><summary>Edit project</summary><form onSubmit={event => {
    event.preventDefault();
    void mutate(client => client.request(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ displayName: displayName.trim(), description: description.trim() || null, tags: normalizedTags(tags), defaultUnits }),
    }), "Project catalog updated without changing its stable ID.");
  }}><label>Friendly name<input maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
    <label>Description<textarea maxLength={1000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <label>Tags (comma or line separated)<textarea rows={2} value={tags} onChange={event => setTags(event.target.value)} /></label>
    <label>Default units<select value={defaultUnits} onChange={event => setDefaultUnits(event.target.value as ViewerDisplayUnits)}><option value="imperial">Imperial</option><option value="metric">Metric</option></select></label>
    <button type="submit" className="button-orange button-small" disabled={busy || !displayName.trim()}>Save project</button>
  </form></details>;
}

function ProjectStorageDetails({ project, busy, query }: { project: ViewerProcessingProject; busy: boolean; query: Query }) {
  const [usage, setUsage] = useState<ViewerProjectStorageResponse | null>(null);
  const fetchPage = (cursor?: string) => query(async client => {
    const page = await client.request<ViewerProjectStorageResponse>(`/api/v1/projects/${encodeURIComponent(project.id)}/storage?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    setUsage(current => cursor && current ? { project: page.project, tasks: [...current.tasks, ...page.tasks], nextCursor: page.nextCursor } : page);
  });
  return <details className="viewer-storage-details" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && !usage && !busy) void fetchPage(); }}><summary>Storage accounting</summary>
    {!usage ? <p>Open to load bounded project and task usage.</p> : <><p>{formatBytes(usage.project.datasetBytes)} datasets · {formatBytes(usage.project.outputBytes)} outputs · {formatBytes(usage.project.totalBytes)} total</p>
      {usage.tasks.length > 0 && <ul>{usage.tasks.map(task => <li key={task.taskId}>Task {task.taskId}: {formatBytes(task.totalBytes)} total ({formatBytes(task.outputBytes)} outputs)</li>)}</ul>}
      {usage.nextCursor && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void fetchPage(usage.nextCursor!)}>Load more task usage</button>}</>}
  </details>;
}

function Datasets({ projects, datasets, preferredProjectId, canWrite, canTrash, busy, mutate, nextCursor, loadMore }: { projects: ViewerProcessingProject[]; datasets: ViewerDatasetSummary[]; preferredProjectId: string | null; canWrite: boolean; canTrash: boolean; busy: boolean; mutate: Mutate; nextCursor: string | null; loadMore: () => void }) {
  const [projectId, setProjectId] = useState(""); const [name, setName] = useState(""); const [files, setFiles] = useState<File[]>([]); const [progress, setProgress] = useState("");
  const [fileRoles, setFileRoles] = useState<Record<string, UploadProcessingRole>>({});
  const [resumeAvailable, setResumeAvailable] = useState(() => Boolean(readUploadCheckpoint()));
  const [resumeDurabilityWarning, setResumeDurabilityWarning] = useState("");
  const [savedOperation, setSavedOperation] = useState<ViewerOperationCheckpoint | null>(() =>
    readViewerOperationCheckpoints().find(item => item.type === "upload_finalize") || null,
  );
  const checkpointRef = useRef<ViewerUploadCheckpoint | null>(null);
  const cancellation = useRef<AbortController | null>(null);
  const operationResumeStarted = useRef(false);
  useEffect(() => {
    if (preferredProjectId && projects.some(project => project.id === preferredProjectId && project.status === "active")) setProjectId(preferredProjectId);
    else if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [preferredProjectId, projectId, projects]);
  const watchOperation = async (client: ViewerAdminClient, checkpoint: ViewerOperationCheckpoint, controller: AbortController) => {
    const terminal = await pollViewerOperation(client, checkpoint, operation => {
      setProgress(`Finalizing immutable manifest: ${Math.round(operation.progress * 100)}% · ${operation.status}`);
    }, controller.signal);
    if (terminal.status !== "succeeded")
      throw new Error(terminal.errorMessage || `Dataset finalization ${terminal.status}. The durable operation is saved for review.`);
    removeViewerOperationCheckpoint(checkpoint.operationId); setSavedOperation(null);
    clearUploadCheckpoint(); checkpointRef.current = null; setResumeAvailable(false); setResumeDurabilityWarning("");
    setProgress(""); setFiles([]); setFileRoles({}); setName(""); cancellation.current = null;
  };
  useEffect(() => {
    if (!savedOperation || operationResumeStarted.current) return;
    operationResumeStarted.current = true;
    const controller = new AbortController(); cancellation.current = controller;
    void mutate(client => watchOperation(client, savedOperation, controller), "Dataset finalized. The source manifest is now immutable.");
  // Resume exactly once on mount; a visible action below handles later retries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const upload = async (client: ViewerAdminClient) => {
    const controller = new AbortController(); cancellation.current = controller;
    let manifest: UploadManifestFile[] = [];
    for (const [index, file] of files.entries()) {
      setProgress(`Hashing ${index + 1} of ${files.length}: ${file.name}`);
      const relativePath = canonicalUploadPath(file.webkitRelativePath || file.name);
      manifest.push({ id: crypto.randomUUID(), relativePath, byteSize: file.size, sha256: await hashFileOffThread(file, completed => setProgress(`Hashing ${index + 1} of ${files.length}: ${file.name} · ${file.size ? Math.round(completed / file.size * 100) : 100}%`), controller.signal), contentType: file.type || undefined, processingRole: fileRoles[relativePath] || processingRoleForUpload(relativePath), file });
    }
    manifest.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    const foldedPaths = new Set<string>();
    for (const item of manifest) {
      const folded = item.relativePath.toLocaleLowerCase("en-US");
      if (foldedPaths.has(folded)) throw new Error(`Duplicate or case-colliding dataset path: ${item.relativePath}`);
      foldedPaths.add(folded);
    }
    const displayName = name.trim(), signature = await uploadManifestSignature(projectId, displayName, manifest);
    const saved = checkpointRef.current || readUploadCheckpoint();
    let datasetId: string;
    if (saved?.signature === signature && saved.projectId === projectId && saved.displayName === displayName) {
      const ids = new Map(saved.files.map(item => [`${item.relativePath}\0${item.byteSize}\0${item.sha256}`, item.id]));
      manifest = manifest.map(item => ({ ...item, id: ids.get(`${item.relativePath}\0${item.byteSize}\0${item.sha256}`) || item.id }));
      datasetId = saved.datasetId;
      setProgress("Verified matching files. Resuming the existing Viewer upload.");
    } else {
      if (saved) throw new Error("A different unfinished upload is saved in this tab. Reselect its matching project, name, and files, or explicitly discard that checkpoint before starting another dataset.");
      const created = await client.request<{ dataset: ViewerDatasetSummary }>("/api/v1/datasets", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ projectId, displayName, sourceType: "upload", storageMode: "managed" }) });
      datasetId = created.dataset.id;
      const checkpoint: ViewerUploadCheckpoint = { version: 1, signature, projectId, displayName, datasetId, files: manifest.map(({ file: _file, ...item }) => item), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
      checkpointRef.current = checkpoint;
      if (!writeUploadCheckpoint(checkpoint)) setResumeDurabilityWarning("Browser storage denied the durable checkpoint. This upload can resume only while this page remains open.");
      setResumeAvailable(true);
    }
    const manifestBody = manifest.map(({ file: _file, ...item }) => item);
    const grant = await client.request<ViewerDatasetUploadGrant>(`/api/v1/datasets/${encodeURIComponent(datasetId)}/uploads`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ files: manifestBody }) });
    const serverFiles = new Map(grant.upload.files.map(item => [item.id, item]));
    for (const [fileIndex, item] of manifest.entries()) for (let offset = 0, index = 0; offset < Math.max(item.file.size, 1); offset += grant.upload.chunkSize, index += 1) {
      const serverFile = serverFiles.get(item.id);
      if (serverFile && !serverFile.missingChunks.includes(index)) continue;
      const chunk = item.file.slice(offset, Math.min(item.file.size, offset + grant.upload.chunkSize));
      setProgress(`Uploading ${fileIndex + 1} of ${files.length}: ${item.file.name} · ${item.file.size ? Math.round((offset + chunk.size) / item.file.size * 100) : 100}%`);
      const sha256 = await chunkHash(chunk);
      await retryUpload(() => client.uploadChunk({ uploadId: grant.upload.id, fileId: item.id, index, uploadToken: grant.uploadToken, sha256, body: chunk, signal: controller.signal }), controller.signal);
    }
    setProgress("Viewer accepted every chunk. Queuing durable manifest finalization.");
    const started = await startViewerOperation(client, `/api/v1/admin/uploads/${encodeURIComponent(grant.upload.id)}/finalize`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ uploadToken: grant.uploadToken }), signal: controller.signal,
    }, "upload_finalize", { datasetId, uploadId: grant.upload.id });
    setSavedOperation(started.checkpoint);
    if (!started.checkpointStored) setResumeDurabilityWarning("Browser storage denied the operation checkpoint. Finalization continues, but automatic recovery after closing this page is unavailable.");
    await watchOperation(client, started.checkpoint, controller);
  };
  return <Card title="Datasets">{canWrite && <form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); if (projectId && name.trim() && files.length) void mutate(upload, "Dataset finalized. The source manifest is now immutable."); }}>
    <label>Project<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.displayName}</option>)}</select></label>
    <label>Dataset name<input maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Drone dataset folder<input type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={event => {
      const selected = [...event.target.files || []];
      const saved = checkpointRef.current || readUploadCheckpoint();
      const savedRoles = new Map(saved?.files.map(file => [`${file.relativePath}\0${file.byteSize}`, file.processingRole]) || []);
      const nextRoles: Record<string, UploadProcessingRole> = {};
      for (const file of selected) {
        const relativePath = canonicalUploadPath(file.webkitRelativePath || file.name);
        const savedRole = savedRoles.get(`${relativePath}\0${file.size}`);
        nextRoles[relativePath] = savedRole && savedRole !== "auto" ? savedRole as UploadProcessingRole : processingRoleForUpload(relativePath);
      }
      setFiles(selected); setFileRoles(nextRoles);
    }} /></label>
    {files.some(file => selectableProcessingRoles(canonicalUploadPath(file.webkitRelativePath || file.name)).length > 1) && <fieldset className="viewer-processing-wide viewer-file-roles"><legend>Auxiliary processing roles</legend><p>GCP source and administrative files remain private and are never sent upstream. Mark only a supported boundary, mask, point-cloud, or provider option file as provider input.</p>{files.map(file => {
      const relativePath = canonicalUploadPath(file.webkitRelativePath || file.name), roles = selectableProcessingRoles(relativePath);
      if (roles.length < 2) return null;
      return <label key={relativePath}>Role for {relativePath}<select value={fileRoles[relativePath] || processingRoleForUpload(relativePath)} onChange={event => setFileRoles(current => ({ ...current, [relativePath]: event.target.value as UploadProcessingRole }))}>{roles.map(role => <option key={role} value={role}>{role === "gcp_source" ? "GCP source (private)" : role === "administrative" ? "Administrative (private)" : "Provider input (sent upstream)"}</option>)}</select></label>;
    })}</fieldset>}
    <button className="button-orange" disabled={busy || !projectId || !name.trim() || !files.length}>{busy ? "Working…" : resumeAvailable ? "Resume upload" : "Upload dataset"}</button>
    {busy && cancellation.current && <button type="button" className="button-danger" onClick={() => cancellation.current?.abort()}>{savedOperation ? "Stop watching (finalization continues)" : "Cancel upload"}</button>}
    {resumeDurabilityWarning && <p className="viewer-processing-warning" role="alert">{resumeDurabilityWarning}</p>}
    {resumeAvailable && !busy && <p className="viewer-upload-resume" role="status">An unfinished upload is saved without credentials or file bytes. Select the same project, dataset name, and folder, then choose Resume upload. <button type="button" className="button-ghost button-small" onClick={() => { if (window.confirm("Discard only the local resume checkpoint? The server draft remains until its retention cleanup.")) { clearUploadCheckpoint(); checkpointRef.current = null; setResumeAvailable(false); setResumeDurabilityWarning(""); } }}>Discard local checkpoint</button></p>}
    {savedOperation && !busy && <p className="viewer-upload-resume" role="status">Durable finalization {savedOperation.operationId} continues in Viewer; no files or credentials are stored here. <button type="button" className="button-ghost button-small" onClick={() => { const controller = new AbortController(); cancellation.current = controller; void mutate(client => watchOperation(client, savedOperation, controller), "Dataset finalized. The source manifest is now immutable."); }}>Resume status check</button> <button type="button" className="button-ghost button-small" onClick={() => { removeViewerOperationCheckpoint(savedOperation.operationId); setSavedOperation(null); }}>Dismiss local status</button></p>}
    {progress && <p role="status">{progress}</p>}<p className="viewer-processing-warning">Source imagery is administrative input. Publishing never shares raw photos, GCP files, logs, or processing internals.</p>
  </form>}
  {!datasets.length ? <EmptyState title="No datasets" detail="Upload or adopt an immutable source manifest. Existing delivery uploads are unaffected." /> : <div className="viewer-processing-list">{datasets.map(dataset => <article key={dataset.id}><div><StatusPill tone={dataset.status === "finalized" ? "success" : "warning"}>{dataset.status}</StatusPill><h3>{dataset.displayName}</h3><p>{dataset.description || "No description"}</p><p>{dataset.fileCount} files · {dataset.storageMode} · {dataset.sourceType} · {formatBytes(dataset.byteSize)}</p>{dataset.tags.length > 0 && <p>Tags: {dataset.tags.join(", ")}</p>}</div><div>
    {canWrite && <DatasetCatalogControls dataset={dataset} projects={projects} busy={busy} mutate={mutate} />}
    {canWrite && dataset.status === "finalized" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/datasets/${encodeURIComponent(dataset.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Dataset archived.")}>Archive</button>}
    {canTrash && !dataset.trashedAt && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => { if (window.confirm(`Move ${dataset.displayName} to recoverable trash?`)) void mutate(client => client.request(`/api/v1/datasets/${encodeURIComponent(dataset.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Dataset moved to recoverable trash."); }}>Trash</button>}
  </div></article>)}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function DatasetCatalogControls({ dataset, projects, busy, mutate }: { dataset: ViewerDatasetSummary; projects: ViewerProcessingProject[]; busy: boolean; mutate: Mutate }) {
  const [displayName, setDisplayName] = useState(dataset.displayName), [description, setDescription] = useState(dataset.description || "");
  const [tags, setTags] = useState(dataset.tags.join(", ")), [projectId, setProjectId] = useState(dataset.projectId);
  const changedProject = projectId !== dataset.projectId;
  return <details className="viewer-task-catalog"><summary>Edit dataset catalog</summary><form onSubmit={event => {
    event.preventDefault();
    if (changedProject && !window.confirm("Reassociate this dataset with the selected active project? This changes catalog ownership only; immutable source files, manifest, storage location, and task history are not moved.")) return;
    void mutate(client => client.request(`/api/v1/datasets/${encodeURIComponent(dataset.id)}`, {
      method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ displayName: displayName.trim(), description: description.trim() || null, tags: normalizedTags(tags), ...(changedProject ? { projectId } : {}) }),
    }), changedProject ? "Dataset catalog reassociated; immutable source storage and manifest are unchanged." : "Dataset catalog updated without changing immutable source contents.");
  }}><label>Friendly name<input maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
    <label>Description<textarea maxLength={1000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <label>Tags (comma or line separated)<textarea rows={2} value={tags} onChange={event => setTags(event.target.value)} /></label>
    <label>Catalog project<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.filter(project => project.status === "active").map(project => <option key={project.id} value={project.id}>{project.displayName}</option>)}</select></label>
    {changedProject && <p className="viewer-processing-warning">Reassociation is blocked while this dataset has active operations, lifecycle mutations, or any non-archived task. It never moves or rewrites immutable source files.</p>}
    <button type="submit" className="button-orange button-small" disabled={busy || !displayName.trim() || !projectId}>Save dataset</button>
  </form></details>;
}

function Tasks({ client, tasks, datasets, preferredProjectId, providers, presets, canWrite, canPublish, busy, mutate, query, nextCursor, loadMore, onDraftCreated }: { client: ViewerAdminClient | null; tasks: ViewerProcessingTask[]; datasets: ViewerDatasetSummary[]; preferredProjectId: string | null; providers: ViewerProviderSummary[]; presets: ViewerProcessingPreset[]; canWrite: boolean; canPublish: boolean; busy: boolean; mutate: Mutate; query: Query; nextCursor: string | null; loadMore: () => void; onDraftCreated: (taskId: string) => void }) {
  const [datasetId, setDatasetId] = useState(""); const [providerId, setProviderId] = useState(""); const [presetId, setPresetId] = useState(""); const [name, setName] = useState(""); const [options, setOptions] = useState<Record<string, unknown>>(() => defaultViewerProviderOverrides(null));
  const [pendingSubmission, setPendingSubmission] = useState<ViewerTaskSubmissionCheckpoint | null>(() => readViewerTaskSubmissionCheckpoint());
  const [pendingDraft, setPendingDraft] = useState<ViewerTaskDraftCheckpoint | null>(() => readViewerTaskDraftCheckpoint());
  const [submissionWarning, setSubmissionWarning] = useState("");
  const eligibleDatasets = useMemo(() => datasets.filter(dataset => dataset.status === "finalized" && (!preferredProjectId || dataset.projectId === preferredProjectId)), [datasets, preferredProjectId]);
  useEffect(() => {
    if (!eligibleDatasets.some(dataset => dataset.id === datasetId)) setDatasetId(eligibleDatasets[0]?.id || "");
    if (!providerId) setProviderId(providers.find(provider => provider.enabled)?.id || "");
  }, [datasetId, eligibleDatasets, providerId, providers]);
  const selectedProvider = providers.find(item => item.id === providerId);
  const compatiblePresets = presets.filter(preset => preset.enabled && (!preset.providerType || (preset.providerType === selectedProvider?.type && preset.capabilityFingerprint === selectedProvider.capabilityFingerprint)));
  return <Card title="Tasks and attempts">{canWrite && <form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter; const mode = submitter instanceof HTMLButtonElement ? submitter.value : "process"; void (async () => {
    const projectId = datasets.find(item => item.id === datasetId)?.projectId;
    if (!projectId) throw new Error("Choose a finalized dataset in an active project");
    if (mode === "draft") {
      const checkpoint = newViewerTaskDraftCheckpoint({ projectId, datasetId, displayName: name });
      setPendingDraft(checkpoint);
      if (!writeViewerTaskDraftCheckpoint(checkpoint)) setSubmissionWarning("Browser storage denied the draft checkpoint. Keep this page open until draft creation completes.");
      let taskId = "";
      await mutate(async client => { const result = await resumeViewerTaskDraft(client, checkpoint); taskId = result.task.id; return result; }, "Draft task created. Add GCP correspondences before starting its first immutable attempt.");
      if (taskId) onDraftCreated(taskId);
      return;
    }
    await mutate(async client => {
    const checkpoint = newViewerTaskSubmissionCheckpoint({ projectId, datasetId, taskDisplayName: name, providerId, presetId, options });
    setPendingSubmission(checkpoint);
    if (!writeViewerTaskSubmissionCheckpoint(checkpoint)) setSubmissionWarning("Browser storage denied the task checkpoint. Keep this page open until submission completes.");
    const result = await resumeViewerTaskSubmission(client, checkpoint, updated => {
      setPendingSubmission(updated); writeViewerTaskSubmissionCheckpoint(updated);
    });
    clearViewerTaskSubmissionCheckpoint(); setPendingSubmission(null); setSubmissionWarning("");
      return result;
    }, "Task submitted to the LTDS queue.");
  })().catch(caught => setSubmissionWarning((caught as Error).message)); }}>
    <label>Task name<input value={name} onChange={event => setName(event.target.value)} /></label><label>Dataset<select value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">{preferredProjectId && !eligibleDatasets.length ? "No finalized datasets in this project" : "Choose a finalized dataset"}</option>{eligibleDatasets.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label>Provider<select value={providerId} onChange={event => { setProviderId(event.target.value); setPresetId(""); setOptions({}); }}>{providers.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label>Preset<select value={presetId} onChange={event => setPresetId(event.target.value)}><option value="">Provider default</option>{compatiblePresets.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <div className="viewer-processing-wide"><h4>Processing options</h4><p>Choose explicit overrides from the provider's live capability probe. Unset controls keep the provider default.</p><OptionEditor provider={selectedProvider} value={options} onChange={setOptions} /></div>
    <div className="viewer-processing-wide"><AdvancedJsonEditor label="Advanced provider options (expert fallback)" value={options} onApply={setOptions} /></div>
    <div className="viewer-processing-wide viewer-task-submit-actions"><button type="submit" name="mode" value="process" className="button-orange" disabled={busy || !name.trim() || !datasetId || !providerId || !selectedProvider?.capabilities}>Create and process</button><button type="submit" name="mode" value="draft" className="button-ghost" disabled={busy || !name.trim() || !datasetId}>Create draft for GCP</button></div>
    <p>Use a draft when this dataset needs ground-control marks. The first attempt snapshots only correspondences that already exist.</p></form>}
    {submissionWarning && <p className="viewer-processing-warning" role="alert">{submissionWarning}</p>}
    {pendingDraft && <p className="viewer-upload-resume" role="status">A recoverable draft creation for <strong>{pendingDraft.displayName}</strong> is saved. Replay uses the same subject-scoped submission ID and cannot create a duplicate after reload or Viewer renewal. Keep this recovery record until Viewer confirms the draft in its refreshed task catalog. <button type="button" className="button-orange button-small" disabled={busy} onClick={() => void (async () => { let taskId = ""; await mutate(async client => { const result = await resumeViewerTaskDraft(client, pendingDraft); taskId = result.task.id; return result; }, "Draft task recovered. Its refreshed catalog entry is ready for GCP marks."); if (taskId) onDraftCreated(taskId); })()}>Resume draft creation</button></p>}
    {pendingSubmission && <p className="viewer-upload-resume" role="status">A recoverable processing submission for <strong>{pendingSubmission.taskDisplayName}</strong> is saved. Its stable submission ID replays atomically across Viewer authorization renewals. <button type="button" className="button-orange button-small" disabled={busy} onClick={() => void mutate(async client => {
      const result = await resumeViewerTaskSubmission(client, pendingSubmission, updated => { setPendingSubmission(updated); writeViewerTaskSubmissionCheckpoint(updated); });
      clearViewerTaskSubmissionCheckpoint(); setPendingSubmission(null); setSubmissionWarning(""); return result;
    }, "Task submission resumed without creating a duplicate.")}>Resume submission</button></p>}
    {!tasks.length ? <EmptyState title="No processing tasks" detail="Each retry creates a new immutable attempt." /> : <div className="viewer-processing-list">{tasks.map(task => <TaskRow key={task.id} client={client} task={task} providers={providers} presets={presets} canWrite={canWrite} canPublish={canPublish} busy={busy} mutate={mutate} query={query} />)}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

const REVIEW_ASSET_KINDS = new Set(["glb", "tiles", "ept", "ortho", "dsm", "dtm"]);
function validatedReviewSession(value: ViewerReviewSessionGrant, client: ViewerAdminClient, attempt: NonNullable<ViewerProcessingTask["latestAttempt"]>): ViewerReviewSessionGrant {
  const redeem = new URL(value.redeemUrl), embed = new URL(value.embedUrl);
  if (value.sessionMode !== "review" || value.attemptId !== attempt.id || value.modelId !== attempt.resultModelId ||
    value.modelVersionId !== attempt.resultModelVersionId || typeof value.modelId !== "string" || !value.modelId ||
    typeof value.modelVersionId !== "string" || !value.modelVersionId || typeof value.grant !== "string" || value.grant.length < 32 ||
    typeof value.grantExpiresAt !== "string" || !Number.isFinite(Date.parse(value.grantExpiresAt)) || Date.parse(value.grantExpiresAt) <= Date.now() ||
    !Number.isInteger(value.sessionTtlSeconds) || value.sessionTtlSeconds < 60 || value.sessionTtlSeconds > 3600 ||
    redeem.origin !== client.origin || redeem.pathname !== "/api/v1/sessions/redeem" || redeem.search || redeem.hash ||
    embed.origin !== client.origin || embed.pathname !== `/session/${encodeURIComponent(value.grant)}` || embed.search || embed.hash ||
    !Array.isArray(value.assetKinds) ||
    !value.assetKinds.length || value.assetKinds.some(kind => !REVIEW_ASSET_KINDS.has(kind)))
    throw new Error("3D Viewer returned an invalid unpublished review session");
  return value;
}

function TaskRow({ client, task, providers, presets, canWrite, canPublish, busy, mutate, query }: { client: ViewerAdminClient | null; task: ViewerProcessingTask; providers: ViewerProviderSummary[]; presets: ViewerProcessingPreset[]; canWrite: boolean; canPublish: boolean; busy: boolean; mutate: Mutate; query: Query }) {
  const [detail, setDetail] = useState<ViewerProcessingAttemptDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [history, setHistory] = useState<ViewerProcessingAttemptPage | null>(null);
  const [reviewSession, setReviewSession] = useState<ViewerReviewSessionGrant | null>(null);
  const [reviewAssetKinds, setReviewAssetKinds] = useState<ViewerReviewSessionGrant["assetKinds"]>([]);
  const [reviewBusy, setReviewBusy] = useState(false), [reviewError, setReviewError] = useState("");
  const attempt = task.latestAttempt;
  useEffect(() => { setReviewSession(null); setReviewAssetKinds([]); }, [attempt?.id, attempt?.resultModelVersionId]);
  const active = Boolean(attempt && ["pending","admitted","initializing","uploading","committed","queued_upstream","running","ingesting","derivatives"].includes(attempt.status));
  const issueReviewSession = async (): Promise<ViewerReviewSessionGrant> => {
    if (!client || !attempt) throw new Error("Viewer review is unavailable");
    const value = await client.request<ViewerReviewSessionGrant>(`/api/v1/attempts/${encodeURIComponent(attempt.id)}/review-sessions`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}",
    });
    return validatedReviewSession(value, client, attempt);
  };
  const openReview = async () => {
    if (reviewBusy) return;
    setReviewBusy(true); setReviewError("");
    try { const session = await issueReviewSession(); setReviewSession(session); setReviewAssetKinds(session.assetKinds); }
    catch (caught) { setReviewError((caught as Error).message); }
    finally { setReviewBusy(false); }
  };
  const closeReview = async () => {
    if (!client || !attempt) { setReviewSession(null); return; }
    setReviewSession(null); setReviewError("");
    try { await client.request(`/api/v1/attempts/${encodeURIComponent(attempt.id)}/review-sessions`, {
      method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}",
    }); }
    catch { setReviewError("The preview is closed locally. Viewer authorization cleanup will retry at expiry."); }
  };
  return <article><div><StatusPill tone={attempt?.status === "failed" ? "danger" : attempt?.status === "ready_for_review" ? "success" : "warning"}>{attempt?.status || task.status}</StatusPill><h3>{task.displayName}</h3><p>Stable task ID {task.id}{attempt ? ` · dataset ${attempt.datasetId} · attempt ${attempt.attemptNumber} · ${Math.round((attempt.progress || 0) * 100)}%` : ""}</p>
    {attempt?.errorMessage && <p className="viewer-processing-error">{attempt.errorCode ? `${attempt.errorCode}: ` : ""}{attempt.errorMessage}</p>}
    {detailError && <p className="viewer-processing-error">{detailError}</p>}
    {reviewError && <p className="viewer-processing-error" role="alert">{reviewError}</p>}
    {detail && <details open className="viewer-attempt-detail"><summary>Attempt logs</summary><progress max={1} value={detail.attempt.progress || 0} />{detail.logs.length ? <ol>{detail.logs.map((log, index) => <li key={`${log.created_at}-${index}`}><time>{log.created_at}</time> <strong>{log.level}</strong> {log.message}</li>)}</ol> : <p>No provider logs yet.</p>}</details>}
    {history && <details open className="viewer-attempt-history"><summary>Attempt and model-version history</summary>{history.attempts.length ? <ol>{history.attempts.map(item => <AttemptHistoryItem key={item.id} attempt={item} provider={providers.find(provider => provider.id === item.providerId)} />)}</ol> : <p>No attempts have been created.</p>}{history.nextCursor && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void query(async viewer => { const next = await viewer.request<ViewerProcessingAttemptPage>(`/api/v1/tasks/${encodeURIComponent(task.id)}/attempts?limit=20&cursor=${encodeURIComponent(history.nextCursor!)}`); setHistory(current => current ? { attempts: [...current.attempts, ...next.attempts], nextCursor: next.nextCursor } : next); })}>Load older attempts</button>}</details>}
    {reviewSession && <ViewerEmbed modelId={reviewSession.modelId} title={`${task.displayName} — unpublished review`} session={reviewSession} renew={issueReviewSession} onClose={() => void closeReview()} />}
    <TaskStorageDetails task={task} busy={busy} query={query} />
  </div><div>
    {attempt && <button type="button" className="button-ghost button-small" onClick={() => void clientFor(mutate, async client => { try { setDetail(await client.request<ViewerProcessingAttemptDetail>(`/api/v1/attempts/${encodeURIComponent(attempt.id)}`)); setDetailError(""); } catch (caught) { setDetailError((caught as Error).message); } })}>Progress & logs</button>}
    <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void query(async viewer => setHistory(await viewer.request<ViewerProcessingAttemptPage>(`/api/v1/tasks/${encodeURIComponent(task.id)}/attempts?limit=20`)))}>Attempt history</button>
    {canPublish && attempt?.status === "ready_for_review" && !reviewSession && <button type="button" className="button-orange button-small" disabled={busy || reviewBusy || !client} onClick={() => void openReview()}>{reviewBusy ? "Opening review…" : "Preview unpublished model"}</button>}
    {canWrite && task.status === "draft" && !task.activeAttemptId && <DraftAttemptControls task={task} providers={providers} presets={presets} busy={busy} mutate={mutate} />}
    {canWrite && attempt?.status === "failed" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/attempts/${encodeURIComponent(attempt.id)}/retry`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "A new retry attempt was created.")}>Retry</button>}
    {canWrite && active && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/attempts/${encodeURIComponent(attempt!.id)}/cancel`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Cancellation requested.")}>Cancel</button>}
    {canPublish && attempt?.status === "ready_for_review" && <PublishButton task={task} availableKinds={reviewAssetKinds} busy={busy} mutate={mutate} />}
    {canWrite && <TaskCatalogControls task={task} active={active} busy={busy} mutate={mutate} />}
  </div></article>;
}

function AttemptHistoryItem({ attempt, provider }: { attempt: ViewerProcessingAttempt; provider: ViewerProviderSummary | undefined }) {
  return <li><strong>Attempt {attempt.attemptNumber}</strong> · {attempt.status} · {provider?.displayName || attempt.providerId}<br /><small>Dataset {attempt.datasetId} · created {attempt.createdAt}{attempt.completedAt ? ` · completed ${attempt.completedAt}` : ""}</small>{attempt.resultModelId && <small className="viewer-history-version">Model {attempt.resultModelId} · version {attempt.resultModelVersionId}</small>}{Object.keys(attempt.options).length > 0 && <details><summary>Immutable option snapshot</summary><pre>{JSON.stringify(attempt.options, null, 2)}</pre></details>}</li>;
}

function DraftAttemptControls({ task, providers, presets, busy, mutate }: { task: ViewerProcessingTask; providers: ViewerProviderSummary[]; presets: ViewerProcessingPreset[]; busy: boolean; mutate: Mutate }) {
  const enabled = providers.filter(provider => provider.enabled);
  const [providerId, setProviderId] = useState(enabled[0]?.id || "");
  const [presetId, setPresetId] = useState("");
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const provider = providers.find(item => item.id === providerId);
  const compatiblePresets = presets.filter(preset => preset.enabled && (!preset.providerType || (preset.providerType === provider?.type && preset.capabilityFingerprint === provider.capabilityFingerprint)));
  return <details className="viewer-task-catalog"><summary>{task.latestAttempt ? "Start new attempt" : "Start processing"}</summary><form onSubmit={event => { event.preventDefault(); void mutate(client =>
    client.request(`/api/v1/tasks/${encodeURIComponent(task.id)}/attempts`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ providerId, ...(presetId ? { presetId } : {}), options }) }),
  "Draft task submitted to the LTDS queue. Its immutable attempt includes the GCP correspondences saved before this moment."); }}><label>Provider<select value={providerId} onChange={event => { setProviderId(event.target.value); setPresetId(""); setOptions({}); }}>{enabled.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label><label>Preset<select value={presetId} onChange={event => setPresetId(event.target.value)}><option value="">Provider default</option>{compatiblePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.displayName}</option>)}</select></label><p>Confirm all ground-control marks before starting. The attempt snapshots them and later edits apply only to a new attempt.</p><OptionEditor provider={provider} value={options} onChange={setOptions} /><AdvancedJsonEditor label={`Advanced options for ${task.displayName} (expert fallback)`} value={options} onApply={setOptions} /><button type="submit" className="button-orange button-small" disabled={busy || !providerId || !provider?.capabilities}>{task.latestAttempt ? "Start new attempt" : "Start first attempt"}</button></form></details>;
}

function TaskCatalogControls({ task, active, busy, mutate }: { task: ViewerProcessingTask; active: boolean; busy: boolean; mutate: Mutate }) {
  const [displayName, setDisplayName] = useState(task.displayName), [description, setDescription] = useState(task.description || "");
  return <details className="viewer-task-catalog"><summary>Edit catalog</summary><form onSubmit={event => { event.preventDefault(); void mutate(client => client.request(`/api/v1/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: displayName.trim(), description: description.trim() || null }) }), "Task catalog metadata updated; its stable ID and model/provider mappings are unchanged."); }}>
    <label>Friendly task name<input maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
    <label>Description<textarea maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} rows={3} /></label>
    <button type="submit" className="button-orange button-small" disabled={busy || !displayName.trim()}>Save metadata</button>
    <button type="button" className="button-danger button-small" disabled={busy || active || task.status === "archived"} onClick={() => { if (window.confirm(`Archive ${task.displayName}? Stable IDs, model/provider mappings, and existing published links remain unchanged.`)) void mutate(client => client.request(`/api/v1/tasks/${encodeURIComponent(task.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Task archived without changing its stable ID or published model mapping."); }}>Archive task</button>
    {active && <small>Cancel or finish the active attempt before archiving.</small>}
  </form></details>;
}

function TaskStorageDetails({ task, busy, query }: { task: ViewerProcessingTask; busy: boolean; query: Query }) {
  const [usage, setUsage] = useState<ViewerTaskStorageResponse | null>(null);
  const fetchPage = (cursor?: string) => query(async client => {
    const page = await client.request<ViewerTaskStorageResponse>(`/api/v1/tasks/${encodeURIComponent(task.id)}/storage?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    setUsage(current => cursor && current ? { task: page.task, outputs: [...current.outputs, ...page.outputs], nextCursor: page.nextCursor } : page);
  });
  return <details className="viewer-storage-details" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && !usage && !busy) void fetchPage(); }}><summary>Task storage & model outputs</summary>
    {!usage ? <p>Open to load bounded output accounting.</p> : <><p>{formatBytes(usage.task.datasetBytes)} dataset · {formatBytes(usage.task.outputBytes)} outputs · {formatBytes(usage.task.totalBytes)} total</p>
      {usage.outputs.length > 0 && <ul>{usage.outputs.map(output => <li key={output.id}>{output.displayName}: {formatBytes(output.byteSize)} · {output.status}</li>)}</ul>}
      {usage.nextCursor && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void fetchPage(usage.nextCursor!)}>Load more outputs</button>}</>}
  </details>;
}

async function clientFor(mutate: Mutate, action: (client: ViewerAdminClient) => Promise<void>): Promise<void> {
  await mutate(async client => action(client), "Attempt detail refreshed.");
}

const PUBLISHABLE_DERIVATIVES = ["glb","tiles","ept","ortho","dsm","dtm"] as const;
function PublishButton({ task, availableKinds, busy, mutate }: { task: ViewerProcessingTask; availableKinds: ViewerReviewSessionGrant["assetKinds"]; busy: boolean; mutate: Mutate }) {
  const [selected, setSelected] = useState<string[]>([]);
  const offered = PUBLISHABLE_DERIVATIVES.filter(kind => availableKinds.includes(kind));
  if (!offered.length) return <p className="viewer-processing-warning">Preview the unpublished model before choosing outputs. Viewer will return only the derivatives that passed integrity review.</p>;
  return <details className="viewer-publish-picker"><summary>Choose reviewed outputs</summary><fieldset><legend>Available derived outputs only</legend>
    {offered.map(kind => <label key={kind}><input type="checkbox" checked={selected.includes(kind)} onChange={event => setSelected(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} /> {kind}</label>)}
    <button type="button" className="button-orange button-small" disabled={busy || !selected.length} onClick={() => {
      if (window.confirm(`Publish ${selected.join(", ")}? Raw datasets, GCP files, logs, and processing internals remain private.`))
        void mutate(client => client.request(`/api/v1/attempts/${encodeURIComponent(task.latestAttempt!.id)}/publish`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: task.displayName, selectedAssetKinds: selected }) }), "Selected derived outputs published.");
    }}>Publish selected</button>
  </fieldset></details>;
}

function Outputs({ outputs, totals, canPublish, busy, mutate, nextCursor, loadMore }: {
  outputs: ViewerOutputSummary[]; totals: { count: number; bytes: number }; canPublish: boolean;
  busy: boolean; mutate: Mutate; nextCursor: string | null; loadMore: () => void;
}) {
  return <Card title="Model output lifecycle"><p>{totals.count} output version{totals.count === 1 ? "" : "s"} · {formatBytes(totals.bytes)} managed output storage</p>
    <p>Archiving is reversible and preserves stable IDs. Managed output bytes stay in recoverable trash for 14 days; external-reference lifecycle changes remove only LTDS catalog metadata and never delete provider source files. Active publications, shares, sessions, and processing remain protected.</p>
    {!outputs.length ? <EmptyState title="No model outputs" detail="Published or review-ready derivative versions appear here. Raw source imagery and logs never do." /> : <div className="viewer-processing-list">{outputs.map(output => <article key={output.id}><div>
      <StatusPill tone={output.status === "published" ? "success" : output.status === "ready" ? "warning" : output.status === "trashed" ? "danger" : "warning"}>{output.status}</StatusPill>
      <h3>{output.displayName}</h3><p>{output.assetCount} derivative asset{output.assetCount === 1 ? "" : "s"} · {formatBytes(output.byteSize)}</p><small>Version {output.id} · model {output.modelId} · task {output.taskId}</small>
    </div><div>
      {canPublish && (output.status === "ready" || output.status === "published") && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => { if (window.confirm(`Archive ${output.displayName}? Active publications, shares, or sessions will block this safely.`)) void mutate(client => client.request(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Model output archived; stable version and model IDs are unchanged."); }}>Archive output</button>}
      {canPublish && output.status === "archived" && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => { if (window.confirm(`Remove archived output ${output.displayName} from the LTDS catalog? Managed bytes use recoverable 14-day trash; external provider source files are never deleted.`)) void mutate(client => client.request(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Archived output removed from the active catalog; managed bytes remain recoverable for 14 days and external source files are unchanged."); }}>Trash output</button>}
    </div></article>)}</div>}
    <Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function Imports({ client, projects, preferredProjectId, canImport, busy, mutate }: { client: ViewerAdminClient | null; projects: ViewerProcessingProject[]; preferredProjectId: string | null; canImport: boolean; busy: boolean; mutate: Mutate }) {
  const [rootKey, setRootKey] = useState<"dataset_import" | "terra_import" | "webodm">("dataset_import"); const [relativePath, setRelativePath] = useState(""); const [projectId, setProjectId] = useState(""); const [preview, setPreview] = useState<ViewerDatasetImportPreview | null>(null); const [storageMode, setStorageMode] = useState<"adopted" | "external_reference">("adopted");
  const [operationProgress, setOperationProgress] = useState("");
  const [operationWarning, setOperationWarning] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewExpired, setPreviewExpired] = useState(false);
  const [previewOperation, setPreviewOperation] = useState<ViewerOperationCheckpoint | null>(() =>
    readViewerOperationCheckpoints().find(item => item.type === "import_preview") || null,
  );
  const [adoptOperation, setAdoptOperation] = useState<ViewerOperationCheckpoint | null>(() =>
    readViewerOperationCheckpoints().find(item => item.type === "import_adopt") || null,
  );
  const previewWatcher = useRef<AbortController | null>(null), adoptWatcher = useRef<AbortController | null>(null);
  const previewGeneration = useRef(0), operationResumeStarted = useRef(false);
  useEffect(() => {
    if (preferredProjectId && projects.some(project => project.id === preferredProjectId && project.status === "active")) setProjectId(preferredProjectId);
    else if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [preferredProjectId, projectId, projects]);
  useEffect(() => {
    if (!preview) { setPreviewExpired(false); return; }
    const delay = Date.parse(preview.expiresAt) - Date.now();
    if (delay <= 0) { setPreviewExpired(true); return; }
    setPreviewExpired(false);
    const timeout = window.setTimeout(() => setPreviewExpired(true), Math.min(delay + 25, 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [preview]);
  const watchPreview = async (viewer: ViewerAdminClient, checkpoint: ViewerOperationCheckpoint, controller: AbortController, generation: number) => {
    const terminal = await pollViewerOperation(viewer, checkpoint, operation => {
      if (generation === previewGeneration.current)
        setOperationProgress(`Inspecting source content: ${Math.round(operation.progress * 100)}% · ${operation.status}`);
    }, controller.signal);
    if (generation !== previewGeneration.current) return;
    previewWatcher.current = null;
    if (terminal.status !== "succeeded")
      throw new Error(terminal.errorMessage || `Import preview ${terminal.status}. The durable operation is saved for review.`);
    const result = terminal.result as ViewerDatasetImportPreview;
    setRootKey(result.preview.rootKey); setRelativePath(result.preview.relativePath); setPreview(result);
    setOperationProgress("Import preview ready. Review before adoption."); setOperationWarning("");
  };
  const watchAdopt = async (viewer: ViewerAdminClient, checkpoint: ViewerOperationCheckpoint, controller: AbortController) => {
    const terminal = await pollViewerOperation(viewer, checkpoint, operation => {
      setOperationProgress(`Importing verified dataset: ${Math.round(operation.progress * 100)}% · ${operation.status}`);
    }, controller.signal);
    if (terminal.status !== "succeeded")
      throw new Error(terminal.errorMessage || `Dataset import ${terminal.status}. The durable operation is saved for review.`);
    removeViewerOperationCheckpoint(checkpoint.operationId); setAdoptOperation(null); setPreview(null);
    setOperationProgress(""); setOperationWarning(""); adoptWatcher.current = null;
  };
  useEffect(() => {
    const saved = adoptOperation || previewOperation;
    if (!canImport || !client || !saved || operationResumeStarted.current) return;
    operationResumeStarted.current = true;
    const controller = new AbortController();
    if (saved.type === "import_adopt") {
      adoptWatcher.current = controller;
      void mutate(viewer => watchAdopt(viewer, saved, controller), "Dataset import completed and indexed.");
    } else {
      previewWatcher.current = controller;
      const generation = ++previewGeneration.current;
      setPreviewBusy(true);
      void watchPreview(client, saved, controller, generation)
        .catch(caught => { if ((caught as Error).name !== "AbortError") setOperationWarning((caught as Error).message); })
        .finally(() => { if (generation === previewGeneration.current) setPreviewBusy(false); });
    }
  // Resume exactly once on mount; a visible action below handles later retries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    previewGeneration.current += 1;
    operationResumeStarted.current = false;
    previewWatcher.current?.abort(); adoptWatcher.current?.abort();
  }, []);
  const discardPreview = () => {
    previewGeneration.current += 1;
    previewWatcher.current?.abort(); previewWatcher.current = null;
    if (previewOperation) removeViewerOperationCheckpoint(previewOperation.operationId);
    setPreviewOperation(null); setPreview(null); setOperationProgress(""); setOperationWarning("");
  };
  const startPreview = async () => {
    if (!client || busy || previewBusy || !relativePath) return;
    const controller = new AbortController(); previewWatcher.current = controller;
    const generation = ++previewGeneration.current;
    setPreviewBusy(true); setPreview(null); setOperationProgress("Starting durable source inspection…"); setOperationWarning("");
    try {
      const started = await startViewerOperation(client, "/api/v1/dataset-imports/preview", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ rootKey, relativePath }), signal: controller.signal,
      }, "import_preview", { datasetId: null, uploadId: null });
      if (generation !== previewGeneration.current) return;
      setPreviewOperation(started.checkpoint);
      if (!started.checkpointStored) setOperationWarning("Browser storage denied the preview checkpoint. Inspection continues, but automatic recovery after closing this page is unavailable.");
      await watchPreview(client, started.checkpoint, controller, generation);
    } catch (caught) {
      if ((caught as Error).name !== "AbortError" && generation === previewGeneration.current)
        setOperationWarning((caught as Error).message);
    } finally {
      if (generation === previewGeneration.current) setPreviewBusy(false);
    }
  };
  const resumePreview = async () => {
    if (!client || !previewOperation || busy || previewBusy) return;
    const controller = new AbortController(); previewWatcher.current = controller;
    const generation = ++previewGeneration.current;
    setPreviewBusy(true); setOperationWarning("");
    try { await watchPreview(client, previewOperation, controller, generation); }
    catch (caught) {
      if ((caught as Error).name !== "AbortError" && generation === previewGeneration.current)
        setOperationWarning((caught as Error).message);
    } finally {
      if (generation === previewGeneration.current) setPreviewBusy(false);
    }
  };
  const cancelPreview = async () => {
    if (!client || !previewOperation) return;
    const checkpoint = previewOperation;
    previewGeneration.current += 1;
    previewWatcher.current?.abort(); previewWatcher.current = null;
    setPreviewBusy(true); setOperationWarning("");
    try {
      const payload = await client.request<ViewerDurableOperationResponse>(`/api/v1/operations/${encodeURIComponent(checkpoint.operationId)}/cancel`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}",
      });
      const cancelled = assertViewerOperation(payload.operation, checkpoint);
      if (cancelled.status !== "cancelled") throw new Error("3D Viewer did not cancel the import preview operation");
      removeViewerOperationCheckpoint(checkpoint.operationId); setPreviewOperation(null); setPreview(null);
      setOperationProgress("Import preview cancelled.");
    } catch (caught) {
      setOperationWarning(`${(caught as Error).message} The saved operation can still be resumed.`);
    } finally { setPreviewBusy(false); }
  };
  if (!canImport) return <Card title="Server imports"><EmptyState title="Import permission required" detail="Server paths are never accepted directly; imports use configured root aliases." /></Card>;
  return <Card title="Server imports"><form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); void startPreview(); }}>
    <label>Configured root<select disabled={busy || previewBusy} value={rootKey} onChange={event => { discardPreview(); setRootKey(event.target.value as typeof rootKey); }}><option value="dataset_import">Dataset staging</option><option value="terra_import">DJI Terra staging</option><option value="webodm">WebODM read-only</option></select></label><label>Relative path<input disabled={busy || previewBusy} value={relativePath} onChange={event => { discardPreview(); setRelativePath(event.target.value); }} placeholder="project/flight" /></label><button className="button-ghost" disabled={busy || previewBusy || !relativePath || Boolean(previewOperation)}>Preview import</button></form>
    {preview && !previewExpired && <div className="viewer-import-preview"><p>{preview.preview.fileCount} files. {preview.preview.sameFilesystem ? "Atomic adoption is available." : "Verified copy is required."} {preview.preview.destinationSpace.sufficient ? "Storage reserve passes." : "Insufficient safe free space."}</p><p>{formatBytes(preview.preview.destinationSpace.requiredBytes)} required · {formatBytes(preview.preview.destinationSpace.availableBytes)} available of {formatBytes(preview.preview.destinationSpace.totalBytes)} · {formatBytes(preview.preview.destinationSpace.reserveBytes)} reserved</p><label>Project<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.displayName}</option>)}</select></label><label>Storage ownership<select value={storageMode} onChange={event => setStorageMode(event.target.value as typeof storageMode)}><option value="adopted">Adopt into LTDS storage</option><option value="external_reference">Reference read-only source</option></select></label><button className="button-orange" type="button" disabled={busy || !projectId || !preview.preview.destinationSpace.sufficient} onClick={() => void mutate(async client => {
      if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error("Import preview expired. Scan the source again before adoption.");
      const controller = new AbortController(); adoptWatcher.current = controller;
      const started = await startViewerOperation(client, "/api/v1/dataset-imports/adopt", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ previewToken: preview.previewToken, projectId, displayName: relativePath.split(/[\\/]/).at(-1) || "Imported dataset", storageMode }), signal: controller.signal,
      }, "import_adopt");
      if (previewOperation) removeViewerOperationCheckpoint(previewOperation.operationId);
      setPreviewOperation(null); setAdoptOperation(started.checkpoint);
      if (!started.checkpointStored) setOperationWarning("Browser storage denied the operation checkpoint. Import continues, but automatic recovery after closing this page is unavailable.");
      await watchAdopt(client, started.checkpoint, controller);
    }, "Dataset import completed and indexed.")}>Confirm import</button></div>}
    {preview && previewExpired && <p className="viewer-processing-warning" role="alert">Import preview expired. The source must be inspected again before adoption. <button type="button" className="button-ghost button-small" disabled={busy || previewBusy} onClick={() => { discardPreview(); void startPreview(); }}>Preview again</button></p>}
    {operationProgress && <p role="status">{operationProgress}</p>}
    {operationWarning && <p className="viewer-processing-warning" role="alert">{operationWarning}</p>}
    {previewBusy && previewOperation && <button type="button" className="button-ghost button-small" onClick={() => void cancelPreview()}>Cancel preview scan</button>}
    {busy && adoptWatcher.current && <button type="button" className="button-ghost button-small" onClick={() => adoptWatcher.current?.abort()}>Stop watching (import continues)</button>}
    {previewOperation && !previewBusy && <p className="viewer-upload-resume" role="status">Durable preview {previewOperation.operationId} {preview ? "is ready for this session" : "continues in Viewer"}; no preview token or credentials are stored in the browser. {!preview && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void resumePreview()}>Resume preview</button>} <button type="button" className="button-ghost button-small" disabled={busy} onClick={discardPreview}>Dismiss preview</button></p>}
    {adoptOperation && !busy && <p className="viewer-upload-resume" role="status">Durable import {adoptOperation.operationId} continues in Viewer; no preview token or credentials are stored here. <button type="button" className="button-ghost button-small" onClick={() => { const controller = new AbortController(); adoptWatcher.current = controller; void mutate(viewer => watchAdopt(viewer, adoptOperation, controller), "Dataset import completed and indexed."); }}>Resume status check</button> <button type="button" className="button-ghost button-small" onClick={() => { removeViewerOperationCheckpoint(adoptOperation.operationId); setAdoptOperation(null); }}>Dismiss local status</button></p>}
  </Card>;
}

function Providers({ providers, canWrite, busy, mutate, nextCursor, loadMore }: { providers: ViewerProviderSummary[]; canWrite: boolean; busy: boolean; mutate: Mutate; nextCursor: string | null; loadMore: () => void }) {
  const [name, setName] = useState(""); const [endpoint, setEndpoint] = useState(""); const [providerType, setProviderType] = useState<"nodeodm" | "clusterodm">("clusterodm"); const [credential, setCredential] = useState("");
  const credentialIssue = credential ? providerCredentialError(credential) : null;
  return <Card title="Processing providers">{canWrite && <form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); const token = credential; void mutate(async client => {
    try { return await client.request("/api/v1/processing/providers", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: name.trim(), endpoint, type: providerType, enabled: false, admissionLimit: providerType === "nodeodm" ? 1 : 4, ...(token ? { credential: { token } } : {}) }) }); }
    finally { setCredential(""); }
  }, token ? "Provider credential stored. Probe it before enabling admission." : "Provider saved disabled. Add a credential, then probe it before enabling admission."); }}><label>Name<input value={name} onChange={event => setName(event.target.value)} /></label><label>Type<select value={providerType} onChange={event => setProviderType(event.target.value as typeof providerType)}><option value="clusterodm">ClusterODM</option><option value="nodeodm">NodeODM</option></select></label><label>HTTPS or private endpoint<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label><label>Provider token (optional)<input type="password" autoComplete="new-password" spellCheck={false} value={credential} onChange={event => setCredential(event.target.value)} aria-invalid={credentialIssue ? "true" : undefined} />{credentialIssue && <small className="viewer-processing-error">{credentialIssue}</small>}</label><p className="viewer-processing-wide">The token goes directly to Viewer over the authenticated admin session. It is cleared from this form after submission and is never returned by the API.</p><button className="button-orange" disabled={busy || !name.trim() || !endpoint || Boolean(credentialIssue)}>Add disabled provider</button></form>}
    {!providers.length ? <EmptyState title="No providers configured" detail="Published model viewing remains fully operational without a provider." /> : <div className="viewer-processing-list viewer-provider-list">{providers.map(provider => <ProviderCard key={provider.id} provider={provider} canWrite={canWrite} busy={busy} mutate={mutate} />)}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function ProviderCard({ provider, canWrite, busy, mutate }: { provider: ViewerProviderSummary; canWrite: boolean; busy: boolean; mutate: Mutate }) {
  const [credential, setCredential] = useState("");
  const [displayName, setDisplayName] = useState(provider.displayName), [endpoint, setEndpoint] = useState(provider.endpoint), [admissionLimit, setAdmissionLimit] = useState(provider.admissionLimit);
  const credentialIssue = providerCredentialError(credential);
  const credentialPath = `/api/v1/processing/providers/${encodeURIComponent(provider.id)}/credential`;
  const credentialStatus = provider.credential || { configured: false, updatedAt: null };
  const credentialDate = credentialStatus.updatedAt ? new Date(credentialStatus.updatedAt).toLocaleString() : null;
  const currentProbe = credentialStatus.configured && provider.lastHealth === "healthy" && Boolean(provider.lastHealthAt) &&
    (!credentialStatus.updatedAt || Date.parse(provider.lastHealthAt!) >= Date.parse(credentialStatus.updatedAt));
  return <article className="viewer-provider-card"><div><StatusPill tone={provider.lastHealth === "healthy" ? "success" : provider.lastHealth === "degraded" || provider.lastHealth === null ? "warning" : "danger"}>{provider.lastHealth || "not probed"}</StatusPill><h3>{provider.displayName}</h3><p>{provider.type} · admission limit {provider.admissionLimit} · {provider.activeAttempts} active · {provider.enabled ? "enabled" : "disabled"}</p>{provider.runtimeHealth && <p>Scheduled runtime health: {provider.runtimeHealth}{provider.runtimeHealthAt ? ` · checked ${new Date(provider.runtimeHealthAt).toLocaleString()}` : ""}{provider.runtimeHealthError ? ` · ${provider.runtimeHealthError}` : ""}</p>}<p><strong>{credentialStatus.configured ? "Credential configured" : "Credential missing"}</strong>{credentialDate ? ` · updated ${credentialDate}` : ""}</p>{provider.capabilities && <p>{provider.capabilities.engine} {provider.capabilities.engineVersion}{provider.capabilities.compatibilityWarning ? ` · ${provider.capabilities.compatibilityWarning}` : ""}</p>}</div><div className="viewer-provider-controls">
    {canWrite && <form className="viewer-provider-credential-form" onSubmit={event => { event.preventDefault(); const token = credential; if (providerCredentialError(token)) return; void mutate(async client => {
      try { return await client.request(credentialPath, { method: "PUT", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ token }) }); }
      finally { setCredential(""); }
    }, credentialStatus.configured ? "Provider credential rotated. Probe it before re-enabling admission." : "Provider credential stored. Probe it before enabling admission."); }}><label>{credentialStatus.configured ? "Replacement provider token" : "Provider token"}<input type="password" autoComplete="new-password" spellCheck={false} value={credential} onChange={event => setCredential(event.target.value)} aria-invalid={credential && credentialIssue ? "true" : undefined} />{credential && credentialIssue && <small className="viewer-processing-error">{credentialIssue}</small>}</label><button type="submit" className="button-ghost button-small" disabled={busy || provider.activeAttempts > 0 || Boolean(credentialIssue)}>{credentialStatus.configured ? "Rotate credential" : "Store credential"}</button></form>}
    {canWrite && credentialStatus.configured && <button type="button" className="button-danger button-small" disabled={busy || provider.activeAttempts > 0} onClick={() => { if (window.confirm(`Clear the stored credential for ${provider.displayName}? The provider will be disabled and must be configured and probed again.`)) void mutate(client => client.request(credentialPath, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Provider credential cleared and admission disabled."); }}>Clear credential</button>}
    {canWrite && <button type="button" className="button-ghost button-small" disabled={busy || !credentialStatus.configured} onClick={() => void mutate(client => client.request(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}/capabilities/probe`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Provider capability and health probe completed.")}>Probe capabilities</button>}
    {canWrite && <details className="viewer-task-catalog"><summary>Edit provider settings</summary><form onSubmit={event => { event.preventDefault(); void mutate(client => client.request(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: displayName.trim(), endpoint, admissionLimit }) }), "Provider settings saved. Probe again before admission if the endpoint changed."); }}><label>Name<input maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label><label>Endpoint<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label><label>Admission limit<input type="number" min={1} max={100} step={1} value={admissionLimit} onChange={event => setAdmissionLimit(Number(event.target.value))} /></label><button type="submit" className="button-orange button-small" disabled={busy || provider.activeAttempts > 0 || !displayName.trim() || !endpoint || !Number.isInteger(admissionLimit) || admissionLimit < 1}>Save settings</button>{provider.activeAttempts > 0 && <small>Wait for active attempts before changing provider routing.</small>}</form></details>}
    {canWrite && <button type="button" className={provider.enabled ? "button-danger button-small" : "button-orange button-small"} disabled={busy || (!provider.enabled && !currentProbe)} onClick={() => void mutate(client => client.request(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ enabled: !provider.enabled }) }), provider.enabled ? "Provider disabled. Published viewing is unaffected." : "Provider enabled for admission.")}>{provider.enabled ? "Disable" : "Enable"}</button>}
  </div></article>;
}

function Storage({ summary, canPurge, busy, mutate, loadMore }: { summary: ViewerStorageSummary | null; canPurge: boolean; busy: boolean; mutate: Mutate; loadMore: () => void }) {
  if (!summary) return <Card title="Storage and recoverable trash"><Loading /></Card>;
  return <Card title="Storage and recoverable trash"><div className="viewer-storage-grid">
    {Object.entries(summary.storage).map(([name, volume]) => <article key={name}><h3>{name}</h3><p>{formatBytes(volume.available)} available of {formatBytes(volume.total)}</p><p>Reserve {formatBytes(volume.reserve)} · required {formatBytes(volume.required)}</p><StatusPill tone={volume.ok ? "success" : "danger"}>{volume.ok ? "preflight passes" : "capacity blocked"}</StatusPill></article>)}
  </div><p>Dataset and output trash is recoverable until its purge date. Restore and permanent purge require owner-only storage permission; permanent purge also requires typing the stable entity ID.</p><p>{summary.trash.totalCount} trashed item{summary.trash.totalCount === 1 ? "" : "s"} · {formatBytes(summary.trash.totalBytes)}</p>
  {!summary.trash.items.length ? <EmptyState title="Trash is empty" detail="Archived data remains cataloged; trashed data appears here for restore or explicit purge." /> : <div className="viewer-processing-list">{summary.trash.items.filter(item => !item.permanentlyDeletedAt).map(item => <article key={item.id}><div><h3>{item.entityType === "output" ? "Model output" : "Dataset"} {item.entityId}</h3><p>{formatBytes(item.byteSize)} · purge after {new Date(item.purgeAfter).toLocaleString()}</p></div><div>
    {canPurge && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/storage/trash/${encodeURIComponent(item.id)}/restore`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), `${item.entityType === "output" ? "Model output" : "Dataset"} restored from trash.`)}>Restore</button>}
    {canPurge && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => { const typedId = window.prompt(`Permanent deletion cannot be undone. Type ${item.entityType} ID ${item.entityId} to continue.`); if (typedId === item.entityId) void mutate(client => client.request(`/api/v1/storage/trash/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ typedId }) }), `${item.entityType === "output" ? "Model output" : "Dataset"} permanently purged.`); }}>Permanently purge</button>}
  </div></article>)}</div>}<Pager nextCursor={summary.trash.nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}
