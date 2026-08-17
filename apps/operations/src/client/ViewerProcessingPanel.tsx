import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  ViewerDatasetImportPreview,
  ViewerDatasetSummary,
  ViewerDatasetUploadGrant,
  ViewerDisplayUnits,
  ViewerDurableOperationResponse,
  ViewerProcessingAttemptDetail,
  ViewerProcessingPreset,
  ViewerProcessingProject,
  ViewerProcessingTask,
  ViewerOutputSummary,
  ViewerProjectStorageResponse,
  ViewerProviderSummary,
  ViewerStorageSummary,
  ViewerTaskStorageResponse,
} from "@ltds/shared";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
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
import { providerCredentialError } from "./provider-credential";
import { defaultViewerProviderOverrides } from "./provider-options";
import {
  assertViewerOperation,
  pollViewerOperation,
  readViewerOperationCheckpoints,
  removeViewerOperationCheckpoint,
  startViewerOperation,
  type ViewerOperationCheckpoint,
} from "./viewer-operation";

type ProcessingEvent = {
  event_id: string; event_type: string; task_id: string; attempt_id: string;
  status: string; error_message: string | null; review_url: string | null;
  acknowledged_at: string | null; received_at: string;
};
type Bootstrap = {
  enabled: boolean;
  viewerBaseUrl: string | null;
  permissions: string[];
  units: { default: "imperial"; resolved: ViewerDisplayUnits };
  events: ProcessingEvent[];
};
type Tab = "projects" | "datasets" | "gcp" | "tasks" | "outputs" | "imports" | "providers" | "storage" | "shares";
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

type UploadManifestFile = { id: string; relativePath: string; byteSize: number; sha256: string; contentType?: string; file: File };

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
  const [cursors, setCursors] = useState<PageCursors>({ projects: null, datasets: null, tasks: null, outputs: null, providers: null });
  const [tab, setTab] = useState<Tab>(() => {
    const pending = readViewerOperationCheckpoints()[0];
    return pending?.type === "upload_finalize" ? "datasets" :
      pending?.type === "import_adopt" || pending?.type === "import_preview" ? "imports" : "projects";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
        {(["projects","datasets","gcp","tasks","outputs","imports","providers","storage","shares"] as Tab[]).map(value =>
          <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "gcp" ? "Ground control" : value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </nav>
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {clientRef.current?.status().renewalError && <div className="notice" role="status">Viewer authorization renewal will retry; the current session remains active until expiry.</div>}
    </Card>

    {tab === "projects" && <Projects projects={projects} canWrite={can("viewer.projects.write")} busy={busy} mutate={mutate} query={query} units={bootstrap.units.resolved} nextCursor={cursors.projects} loadMore={() => loadMore("projects")} />}
    {tab === "datasets" && <Datasets projects={projects} datasets={datasets} canWrite={can("viewer.datasets.write")} canTrash={can("viewer.storage.purge")} busy={busy} mutate={mutate} nextCursor={cursors.datasets} loadMore={() => loadMore("datasets")} />}
    {tab === "gcp" && clientRef.current && <GcpWorkspace client={clientRef.current} datasets={datasets} tasks={tasks} mapToken={mapToken} units={bootstrap.units.resolved} canRead={can("viewer.gcp.read")} canWrite={can("viewer.gcp.write")} />}
    {tab === "tasks" && <Tasks tasks={tasks} datasets={datasets} providers={providers} presets={presets} canWrite={can("viewer.processing.write")} canPublish={can("viewer.processing.publish")} busy={busy} mutate={mutate} query={query} nextCursor={cursors.tasks} loadMore={() => loadMore("tasks")} />}
    {tab === "outputs" && <Outputs outputs={outputs} totals={outputTotals} canPublish={can("viewer.processing.publish")} busy={busy} mutate={mutate} nextCursor={cursors.outputs} loadMore={() => loadMore("outputs")} />}
    {tab === "imports" && <Imports client={clientRef.current} projects={projects} canImport={can("viewer.datasets.import")} busy={busy} mutate={mutate} />}
    {tab === "providers" && <Providers providers={providers} canWrite={can("viewer.providers.write")} busy={busy} mutate={mutate} nextCursor={cursors.providers} loadMore={() => loadMore("providers")} />}
    {tab === "storage" && <Storage summary={storage} canPurge={can("viewer.storage.purge")} busy={busy} mutate={mutate} loadMore={loadMoreTrash} />}
    {tab === "shares" && <Card title="Shares"><p>Published-model demo links, expiry, revocation, passwords, units, and download policy are managed in Public demo links below. Raw dataset inputs and processing logs are never share candidates.</p><a className="button-orange button-small" href="#viewer-public-shares">Go to public demo links</a></Card>}

    {reviewAttempt && <Card title="Requested processing review"><StatusPill tone={reviewAttempt.attempt.status === "ready_for_review" ? "success" : reviewAttempt.attempt.status === "failed" ? "danger" : "warning"}>{reviewAttempt.attempt.status}</StatusPill><p>Attempt {reviewAttempt.attempt.id} · task {reviewAttempt.attempt.taskId} · {Math.round((reviewAttempt.attempt.progress || 0) * 100)}%</p>{reviewAttempt.attempt.errorMessage && <p className="viewer-processing-error">{reviewAttempt.attempt.errorMessage}</p>}<details><summary>Sanitized processing logs</summary><ol>{reviewAttempt.logs.map((log, index) => <li key={`${log.created_at}-${index}`}>{log.created_at} · {log.level} · {log.message}</li>)}</ol></details></Card>}

    {!!bootstrap.events.length && <Card title="Processing notifications"><div className="viewer-processing-list">
      {bootstrap.events.map(event => <article key={event.event_id}>
        <div><StatusPill tone={event.event_type === "processing.failed" ? "danger" : "success"}>{event.status}</StatusPill>
          <h3>Task {event.task_id}</h3><p>{event.error_message || `Attempt ${event.attempt_id} is ready for review.`}</p></div>
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
function Projects({ projects, canWrite, busy, mutate, query, units, nextCursor, loadMore }: { projects: ViewerProcessingProject[]; canWrite: boolean; busy: boolean; mutate: Mutate; query: Query; units: ViewerDisplayUnits; nextCursor: string | null; loadMore: () => void }) {
  const [name, setName] = useState("");
  return <Card title="Projects">{canWrite && <form className="viewer-processing-form" onSubmit={event => {
    event.preventDefault(); const displayName = name.trim(); if (!displayName) return;
    void mutate(client => client.request("/api/v1/projects", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName, defaultUnits: units }) }), "Project created.").then(() => setName(""));
  }}><label>Friendly project name<input maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label><button className="button-orange" disabled={busy || !name.trim()}>Create project</button></form>}
    {!projects.length ? <EmptyState title="No processing projects" detail="Create a project to organize reusable datasets and tasks." /> : <div className="viewer-processing-list">{projects.map(project => <article key={project.id}><div><h3>{project.displayName}</h3><p>{project.description || "No description"}</p><p>{project.defaultUnits} · {project.status} · stable ID {project.id}</p>{project.tags.length > 0 && <p>Tags: {project.tags.join(", ")}</p>}<ProjectStorageDetails project={project} busy={busy} query={query} /></div><div>{canWrite && <ProjectCatalogControls project={project} busy={busy} mutate={mutate} />}{canWrite && project.status === "active" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/projects/${encodeURIComponent(project.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Project archived; stable IDs and published model links are unchanged.")}>Archive</button>}</div></article>)}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
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

function Datasets({ projects, datasets, canWrite, canTrash, busy, mutate, nextCursor, loadMore }: { projects: ViewerProcessingProject[]; datasets: ViewerDatasetSummary[]; canWrite: boolean; canTrash: boolean; busy: boolean; mutate: Mutate; nextCursor: string | null; loadMore: () => void }) {
  const [projectId, setProjectId] = useState(""); const [name, setName] = useState(""); const [files, setFiles] = useState<File[]>([]); const [progress, setProgress] = useState("");
  const [resumeAvailable, setResumeAvailable] = useState(() => Boolean(readUploadCheckpoint()));
  const [resumeDurabilityWarning, setResumeDurabilityWarning] = useState("");
  const [savedOperation, setSavedOperation] = useState<ViewerOperationCheckpoint | null>(() =>
    readViewerOperationCheckpoints().find(item => item.type === "upload_finalize") || null,
  );
  const checkpointRef = useRef<ViewerUploadCheckpoint | null>(null);
  const cancellation = useRef<AbortController | null>(null);
  const operationResumeStarted = useRef(false);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projectId, projects]);
  const watchOperation = async (client: ViewerAdminClient, checkpoint: ViewerOperationCheckpoint, controller: AbortController) => {
    const terminal = await pollViewerOperation(client, checkpoint, operation => {
      setProgress(`Finalizing immutable manifest: ${Math.round(operation.progress * 100)}% · ${operation.status}`);
    }, controller.signal);
    if (terminal.status !== "succeeded")
      throw new Error(terminal.errorMessage || `Dataset finalization ${terminal.status}. The durable operation is saved for review.`);
    removeViewerOperationCheckpoint(checkpoint.operationId); setSavedOperation(null);
    clearUploadCheckpoint(); checkpointRef.current = null; setResumeAvailable(false); setResumeDurabilityWarning("");
    setProgress(""); setFiles([]); setName(""); cancellation.current = null;
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
      manifest.push({ id: crypto.randomUUID(), relativePath: canonicalUploadPath(file.webkitRelativePath || file.name), byteSize: file.size, sha256: await hashFileOffThread(file, completed => setProgress(`Hashing ${index + 1} of ${files.length}: ${file.name} · ${file.size ? Math.round(completed / file.size * 100) : 100}%`), controller.signal), contentType: file.type || undefined, file });
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
    <label>Drone dataset folder<input type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={event => setFiles([...event.target.files || []])} /></label>
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

function Tasks({ tasks, datasets, providers, presets, canWrite, canPublish, busy, mutate, query, nextCursor, loadMore }: { tasks: ViewerProcessingTask[]; datasets: ViewerDatasetSummary[]; providers: ViewerProviderSummary[]; presets: ViewerProcessingPreset[]; canWrite: boolean; canPublish: boolean; busy: boolean; mutate: Mutate; query: Query; nextCursor: string | null; loadMore: () => void }) {
  const [datasetId, setDatasetId] = useState(""); const [providerId, setProviderId] = useState(""); const [presetId, setPresetId] = useState(""); const [name, setName] = useState(""); const [advancedOptions, setAdvancedOptions] = useState(() => JSON.stringify(defaultViewerProviderOverrides(null)));
  useEffect(() => { if (!datasetId && datasets[0]) setDatasetId(datasets[0].id); if (!providerId && providers[0]) setProviderId(providers[0].id); }, [datasetId, datasets, providerId, providers]);
  const selectedProvider = providers.find(item => item.id === providerId);
  return <Card title="Tasks and attempts">{canWrite && <form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); void mutate(async client => {
    const created = await client.request<{ task: ViewerProcessingTask }>("/api/v1/tasks", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ datasetId, projectId: datasets.find(item => item.id === datasetId)?.projectId, displayName: name.trim() }) });
    let options: Record<string, unknown>; try { options = JSON.parse(advancedOptions) as Record<string, unknown>; } catch { throw new Error("Advanced provider options must be valid JSON."); }
    return client.request(`/api/v1/tasks/${encodeURIComponent(created.task.id)}/attempts`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ providerId, ...(presetId ? { presetId } : {}), options }) });
  }, "Task submitted to the LTDS queue."); }}>
    <label>Task name<input value={name} onChange={event => setName(event.target.value)} /></label><label>Dataset<select value={datasetId} onChange={event => setDatasetId(event.target.value)}>{datasets.filter(item => item.status === "finalized").map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label>Provider<select value={providerId} onChange={event => setProviderId(event.target.value)}>{providers.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label>Preset<select value={presetId} onChange={event => setPresetId(event.target.value)}><option value="">Provider default</option>{presets.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label className="viewer-processing-wide">Advanced provider options (overrides only)<textarea aria-label="Advanced provider options" value={advancedOptions} onChange={event => setAdvancedOptions(event.target.value)} rows={5} /></label>
    {!!selectedProvider?.capabilities?.options.length && <details className="viewer-processing-wide"><summary>Available {selectedProvider.capabilities.engine} options</summary><ul>{selectedProvider.capabilities.options.map(option => <li key={option.name}><code>{option.name}</code> ({option.type}) — {option.help}</li>)}</ul><p>Defaults are intentionally not copied into overrides because upstream NodeODM may report typed defaults as strings. Viewer validates only explicit overrides and injects required output flags.</p></details>}
    <button className="button-orange" disabled={busy || !name.trim() || !datasetId || !providerId}>Create and process</button></form>}
    {!tasks.length ? <EmptyState title="No processing tasks" detail="Each retry creates a new immutable attempt." /> : <div className="viewer-processing-list">{tasks.map(task => <TaskRow key={task.id} task={task} canWrite={canWrite} canPublish={canPublish} busy={busy} mutate={mutate} query={query} />)}</div>}<Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function TaskRow({ task, canWrite, canPublish, busy, mutate, query }: { task: ViewerProcessingTask; canWrite: boolean; canPublish: boolean; busy: boolean; mutate: Mutate; query: Query }) {
  const [detail, setDetail] = useState<ViewerProcessingAttemptDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const attempt = task.latestAttempt;
  const active = Boolean(attempt && ["pending","admitted","initializing","uploading","committed","queued_upstream","running","ingesting","derivatives"].includes(attempt.status));
  return <article><div><StatusPill tone={attempt?.status === "failed" ? "danger" : attempt?.status === "ready_for_review" ? "success" : "warning"}>{attempt?.status || task.status}</StatusPill><h3>{task.displayName}</h3><p>Stable task ID {task.id}{attempt ? ` · attempt ${attempt.attemptNumber} · ${Math.round((attempt.progress || 0) * 100)}%` : ""}</p>
    {attempt?.errorMessage && <p className="viewer-processing-error">{attempt.errorCode ? `${attempt.errorCode}: ` : ""}{attempt.errorMessage}</p>}
    {detailError && <p className="viewer-processing-error">{detailError}</p>}
    {detail && <details open className="viewer-attempt-detail"><summary>Attempt logs</summary><progress max={1} value={detail.attempt.progress || 0} />{detail.logs.length ? <ol>{detail.logs.map((log, index) => <li key={`${log.created_at}-${index}`}><time>{log.created_at}</time> <strong>{log.level}</strong> {log.message}</li>)}</ol> : <p>No provider logs yet.</p>}</details>}
    <TaskStorageDetails task={task} busy={busy} query={query} />
  </div><div>
    {attempt && <button type="button" className="button-ghost button-small" onClick={() => void clientFor(mutate, async client => { try { setDetail(await client.request<ViewerProcessingAttemptDetail>(`/api/v1/attempts/${encodeURIComponent(attempt.id)}`)); setDetailError(""); } catch (caught) { setDetailError((caught as Error).message); } })}>Progress & logs</button>}
    {canWrite && attempt?.status === "failed" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/attempts/${encodeURIComponent(attempt.id)}/retry`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "A new retry attempt was created.")}>Retry</button>}
    {canWrite && active && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => void mutate(client => client.request(`/api/v1/attempts/${encodeURIComponent(attempt!.id)}/cancel`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Cancellation requested.")}>Cancel</button>}
    {canPublish && attempt?.status === "ready_for_review" && <PublishButton task={task} busy={busy} mutate={mutate} />}
    {canWrite && <TaskCatalogControls task={task} active={active} busy={busy} mutate={mutate} />}
  </div></article>;
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

const PUBLISHABLE_DERIVATIVES = ["glb","tiles","ept","ortho","dsm","dtm","shots","pointCloud"] as const;
function PublishButton({ task, busy, mutate }: { task: ViewerProcessingTask; busy: boolean; mutate: Mutate }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <details className="viewer-publish-picker"><summary>Choose outputs</summary><fieldset><legend>Derived outputs only</legend>
    {PUBLISHABLE_DERIVATIVES.map(kind => <label key={kind}><input type="checkbox" checked={selected.includes(kind)} onChange={event => setSelected(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} /> {kind}</label>)}
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
    <p>Archiving is reversible and preserves stable IDs. Trash is retained for 14 days. Active publications, shares, sessions, processing, and non-managed layouts are protected from lifecycle changes.</p>
    {!outputs.length ? <EmptyState title="No model outputs" detail="Published or review-ready derivative versions appear here. Raw source imagery and logs never do." /> : <div className="viewer-processing-list">{outputs.map(output => <article key={output.id}><div>
      <StatusPill tone={output.status === "published" ? "success" : output.status === "ready" ? "warning" : output.status === "trashed" ? "danger" : "warning"}>{output.status}</StatusPill>
      <h3>{output.displayName}</h3><p>{output.assetCount} derivative asset{output.assetCount === 1 ? "" : "s"} · {formatBytes(output.byteSize)}</p><small>Version {output.id} · model {output.modelId} · task {output.taskId}</small>
    </div><div>
      {canPublish && (output.status === "ready" || output.status === "published") && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => { if (window.confirm(`Archive ${output.displayName}? Active publications, shares, or sessions will block this safely.`)) void mutate(client => client.request(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/archive`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Model output archived; stable version and model IDs are unchanged."); }}>Archive output</button>}
      {canPublish && output.status === "archived" && <button type="button" className="button-danger button-small" disabled={busy} onClick={() => { if (window.confirm(`Move archived output ${output.displayName} to recoverable 14-day trash?`)) void mutate(client => client.request(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/archive`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Archived output moved to recoverable trash."); }}>Trash output</button>}
    </div></article>)}</div>}
    <Pager nextCursor={nextCursor} busy={busy} loadMore={loadMore} />
  </Card>;
}

function Imports({ client, projects, canImport, busy, mutate }: { client: ViewerAdminClient | null; projects: ViewerProcessingProject[]; canImport: boolean; busy: boolean; mutate: Mutate }) {
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
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projectId, projects]);
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
  const credentialIssue = providerCredentialError(credential);
  const credentialPath = `/api/v1/processing/providers/${encodeURIComponent(provider.id)}/credential`;
  const credentialStatus = provider.credential || { configured: false, updatedAt: null };
  const credentialDate = credentialStatus.updatedAt ? new Date(credentialStatus.updatedAt).toLocaleString() : null;
  const currentProbe = credentialStatus.configured && provider.lastHealth === "healthy" && Boolean(provider.lastHealthAt) &&
    (!credentialStatus.updatedAt || Date.parse(provider.lastHealthAt!) >= Date.parse(credentialStatus.updatedAt));
  return <article className="viewer-provider-card"><div><StatusPill tone={provider.lastHealth === "healthy" ? "success" : provider.lastHealth === "degraded" || provider.lastHealth === null ? "warning" : "danger"}>{provider.lastHealth || "not probed"}</StatusPill><h3>{provider.displayName}</h3><p>{provider.type} · admission limit {provider.admissionLimit} · {provider.activeAttempts} active · {provider.enabled ? "enabled" : "disabled"}</p><p><strong>{credentialStatus.configured ? "Credential configured" : "Credential missing"}</strong>{credentialDate ? ` · updated ${credentialDate}` : ""}</p>{provider.capabilities && <p>{provider.capabilities.engine} {provider.capabilities.engineVersion}{provider.capabilities.compatibilityWarning ? ` · ${provider.capabilities.compatibilityWarning}` : ""}</p>}</div><div className="viewer-provider-controls">
    {canWrite && <form className="viewer-provider-credential-form" onSubmit={event => { event.preventDefault(); const token = credential; if (providerCredentialError(token)) return; void mutate(async client => {
      try { return await client.request(credentialPath, { method: "PUT", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ token }) }); }
      finally { setCredential(""); }
    }, credentialStatus.configured ? "Provider credential rotated. Probe it before re-enabling admission." : "Provider credential stored. Probe it before enabling admission."); }}><label>{credentialStatus.configured ? "Replacement provider token" : "Provider token"}<input type="password" autoComplete="new-password" spellCheck={false} value={credential} onChange={event => setCredential(event.target.value)} aria-invalid={credential && credentialIssue ? "true" : undefined} />{credential && credentialIssue && <small className="viewer-processing-error">{credentialIssue}</small>}</label><button type="submit" className="button-ghost button-small" disabled={busy || provider.activeAttempts > 0 || Boolean(credentialIssue)}>{credentialStatus.configured ? "Rotate credential" : "Store credential"}</button></form>}
    {canWrite && credentialStatus.configured && <button type="button" className="button-danger button-small" disabled={busy || provider.activeAttempts > 0} onClick={() => { if (window.confirm(`Clear the stored credential for ${provider.displayName}? The provider will be disabled and must be configured and probed again.`)) void mutate(client => client.request(credentialPath, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Provider credential cleared and admission disabled."); }}>Clear credential</button>}
    {canWrite && <button type="button" className="button-ghost button-small" disabled={busy || !credentialStatus.configured} onClick={() => void mutate(client => client.request(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}/capabilities/probe`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }), "Provider capability and health probe completed.")}>Probe capabilities</button>}
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
