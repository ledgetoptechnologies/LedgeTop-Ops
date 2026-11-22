import { Dialog, Skeleton } from "@ltds/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalFilePage, PortalOperationsHomeResponse } from "./portal-api";
import { loadDirectWorkspaceFolderFiles, loadDirectWorkspaceFolders, loadOperationsDirectFolderCapability, type DirectWorkspaceFolder } from "./direct-folder-api";
import { VideoPlayer } from "./VideoPlayer";

type FolderTarget = { workspaceId: string; folder: DirectWorkspaceFolder };
type OpenFolder = { workspaceId: string; folderId: string; page: PortalFilePage };
type Phase = "idle" | "loading" | "ready" | "denied" | "error";
const deniedStatus = (error: unknown) => [401, 403, 404, 410].includes((error as {status?: number})?.status ?? 0);

/**
 * Lists direct-folder grants reached through verified Operations service homes.
 * This surface never creates or selects a PA-v2 Client workspace.
 */
export function OperationsDirectFolderBrowser({ response }: { response: PortalOperationsHomeResponse }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [capability, setCapability] = useState<"checking" | "enabled" | "disabled" | "error">("checking");
  const [folders, setFolders] = useState<FolderTarget[]>([]), [openFolder, setOpenFolder] = useState<OpenFolder | null>(null);
  const [videoPreview, setVideoPreview] = useState<{file: NonNullable<OpenFolder["page"]["files"][number]>} | null>(null);
  const [loadingMore, setLoadingMore] = useState(false), [pageError, setPageError] = useState(false);
  const sequence = useRef(0), activeController = useRef<AbortController | null>(null), capabilityController = useRef<AbortController | null>(null);
  const activatedRef = useRef(false);

  const clearPrivate = useCallback(() => { setFolders([]); setOpenFolder(null); setVideoPreview(null); setLoadingMore(false); setPageError(false); }, []);
  const start = useCallback(() => {
    activeController.current?.abort();
    const controller = new AbortController(), current = ++sequence.current;
    activeController.current = controller;
    return { controller, current, isCurrent: () => sequence.current === current && activeController.current === controller && !controller.signal.aborted };
  }, []);

  const loadRoots = useCallback(async () => {
    const request = start(); clearPrivate(); setPhase("loading");
    const queue = [...response.homes]; let next = 0, failed: unknown = null;
    const results: FolderTarget[] = [];
    const worker = async () => {
      while (request.isCurrent()) {
        const home = queue[next++]; if (!home) return;
        try {
          const page = await loadDirectWorkspaceFolders(home.workspaceId, request.controller.signal);
          if (!request.isCurrent()) return;
          results.push(...page.items.map(folder => ({ workspaceId: home.workspaceId, folder })));
        } catch (caught) {
          if (!request.isCurrent()) return;
          failed ??= caught;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(2, queue.length)}, worker));
    if (!request.isCurrent()) return;
    activeController.current = null;
    if (failed) { clearPrivate(); setPhase(deniedStatus(failed) ? "denied" : "error"); return; }
    results.sort((left, right) => left.folder.name.localeCompare(right.folder.name) || left.folder.id.localeCompare(right.folder.id));
    setFolders(results); setPhase("ready");
  }, [clearPrivate, response.homes, start]);

  const open = useCallback(async (workspaceId: string, folderId: string, current?: OpenFolder) => {
    if (current && current.page.cursor === null) return;
    const request = start(); setPageError(false);
    if (current) setLoadingMore(true); else { clearPrivate(); setPhase("loading"); }
    try {
      const page = await loadDirectWorkspaceFolderFiles(workspaceId, folderId, current?.page.cursor ?? null, request.controller.signal);
      if (!request.isCurrent()) return;
      const nextPage = current ? {
        ...page,
        files: [...current.page.files, ...page.files.filter(file => !current.page.files.some(old => old.id === file.id))],
        folders: [...(current.page.folders ?? []), ...(page.folders ?? []).filter(folder => !(current.page.folders ?? []).some(old => old.id === folder.id))],
      } : page;
      setOpenFolder({workspaceId, folderId, page: nextPage}); setFolders([]); setLoadingMore(false); setPhase("ready"); activeController.current = null;
    } catch (caught) {
      if (!request.isCurrent()) return;
      activeController.current = null; setLoadingMore(false);
      if (current && deniedStatus(caught)) { clearPrivate(); setPhase("denied"); }
      else if (current) setPageError(true);
      else { clearPrivate(); setPhase(deniedStatus(caught) ? "denied" : "error"); }
    }
  }, [clearPrivate, start]);

  const checkCapability = useCallback(async (refreshReadState: boolean) => {
    capabilityController.current?.abort();
    activeController.current?.abort(); activeController.current = null; ++sequence.current;
    clearPrivate(); setPhase("idle"); setCapability("checking");
    const controller = new AbortController(); capabilityController.current = controller;
    try {
      const enabled = await loadOperationsDirectFolderCapability(controller.signal);
      if (controller.signal.aborted || capabilityController.current !== controller) return;
      capabilityController.current = null;
      setCapability(enabled ? "enabled" : "disabled");
      if (!enabled) activatedRef.current = false;
      else if (refreshReadState && activatedRef.current) void loadRoots();
    } catch {
      if (controller.signal.aborted || capabilityController.current !== controller) return;
      capabilityController.current = null; setCapability("error");
    }
  }, [clearPrivate, loadRoots]);

  const browse = () => {
    if (capability !== "enabled") return;
    activatedRef.current = true; void loadRoots();
  };
  useEffect(() => {
    void checkCapability(false);
  }, [checkCapability]);
  useEffect(() => {
    const revalidate = () => { if (document.visibilityState === "visible") void checkCapability(activatedRef.current); };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") revalidate();
      else {
        ++sequence.current; activeController.current?.abort(); activeController.current = null;
        capabilityController.current?.abort(); capabilityController.current = null;
        clearPrivate(); setPhase("idle"); setCapability("checking");
      }
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => { window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [checkCapability, clearPrivate]);
  useEffect(() => () => { ++sequence.current; activeController.current?.abort(); activeController.current = null; capabilityController.current?.abort(); capabilityController.current = null; }, []);

  const listing = openFolder?.page;
  if (capability === "disabled") return null;
  return <section className="portal-card" aria-labelledby="operations-direct-folders-heading">
    <h2 id="operations-direct-folders-heading">Shared folders</h2>
    {(capability === "checking" || phase === "loading") && <Skeleton variant="text" lines={2} label={capability === "checking" ? "Checking folder sharing availability…" : "Checking shared folders…"} />}
    {capability === "error" && <div className="portal-inline-error" role="alert">
      <p>Folder sharing availability could not be checked.</p>
      <button type="button" className="button-ghost" onClick={() => void checkCapability(activatedRef.current)}>Retry availability check</button>
    </div>}
    {capability === "enabled" && phase === "idle" && <>
      <p>Files Ledge Top has shared with you.</p>
      <button type="button" className="button-orange" onClick={browse}>Browse shared folders</button>
    </>}
    {capability === "enabled" && phase === "denied" && <div className="portal-inline-error" role="alert">
      <p>Your shared folders could not be verified. Refresh access before opening them.</p>
      <button type="button" className="button-ghost" onClick={browse}>Refresh access</button>
    </div>}
    {capability === "enabled" && phase === "error" && <div className="portal-inline-error" role="alert">
      <p>Shared folders are temporarily unavailable.</p>
      <button type="button" className="button-ghost" onClick={browse}>Retry</button>
    </div>}
    {capability === "enabled" && phase === "ready" && !listing && <div className="portal-file-list">
      <div className="portal-page-heading-action">
        <p>{folders.length === 0 ? "No folders are currently shared with you." : "Choose a folder to browse its files."}</p>
        <button type="button" className="button-ghost" onClick={() => void loadRoots()}>Refresh</button>
      </div>
      {folders.map(({workspaceId, folder}) => <button type="button" className="portal-folder-row" key={`${workspaceId}:${folder.id}`}
        onClick={() => void open(workspaceId, folder.id)}>
        <span className="portal-file-icon" aria-hidden="true">DIR</span><span><strong>{folder.name}</strong><small>Shared folder</small></span><span aria-hidden="true">›</span>
      </button>)}
    </div>}
    {capability === "enabled" && phase === "ready" && listing && openFolder && <div className="portal-file-list">
      <div className="portal-page-heading-action">
        <p>Files in this shared folder.</p>
        <button type="button" className="button-ghost" onClick={() => void loadRoots()}>All shared folders</button>
      </div>
      <nav className="portal-file-breadcrumbs" aria-label="Shared folders"><ol>
        <li><button type="button" onClick={() => void loadRoots()}>All shared folders</button></li>
        {listing.breadcrumbs?.map((crumb, index, rows) => <li key={`${crumb.id}:${index}`}>
          {index === rows.length - 1 ? <span aria-current="page">{crumb.name}</span>
            : crumb.id && <button type="button" onClick={() => void open(openFolder.workspaceId, crumb.id!)}>{crumb.name}</button>}
        </li>)}
      </ol></nav>
      {(listing.folders?.length ?? 0) === 0 && listing.files.length === 0 && <p>No files are available in this folder.</p>}
      {listing.folders?.map((folder, index) => <button type="button" className="portal-folder-row" key={`${folder.id}:${index}`}
        onClick={() => void open(openFolder.workspaceId, folder.id)}>
        <span className="portal-file-icon" aria-hidden="true">DIR</span><span><strong>{folder.name}</strong><small>Folder</small></span><span aria-hidden="true">›</span>
      </button>)}
      {listing.files.map((file, index) => <div className="portal-file-row" key={`${file.id}:${index}`}>
        <span className="portal-file-icon" aria-hidden="true">{file.kind.slice(0, 4).toUpperCase()}</span>
        <div><strong>{file.name}</strong><span>{file.size.toLocaleString()} bytes</span></div>
        <div className="portal-file-actions">
          {file.previewPath && (file.kind === "video"
            ? <button type="button" className="button-ghost" onClick={() => setVideoPreview({file})}>Preview</button>
            : <a className="button-ghost" href={file.previewPath} target="_blank" rel="noopener noreferrer">Preview</a>)}
          <a className="button-ghost" href={file.downloadPath} download>Download</a>
        </div>
      </div>)}
      {listing.cursor && <div className="portal-load-more">
        <button type="button" className="button-ghost" disabled={loadingMore} onClick={() => void open(openFolder.workspaceId, openFolder.folderId, openFolder)}>
          {loadingMore ? "Loading…" : "Load more files"}
        </button>
      </div>}
      {pageError && <div className="portal-inline-error" role="alert"><p>More files could not be loaded.</p>
        <button type="button" className="button-ghost" onClick={() => void open(openFolder.workspaceId, openFolder.folderId, openFolder)}>Retry page</button>
      </div>}
    </div>}
    {videoPreview && <Dialog open onClose={() => setVideoPreview(null)} title={videoPreview.file.name} size="lg"
      footer={<a className="button-orange" href={videoPreview.file.downloadPath} download>Download</a>}>
      <VideoPlayer src={videoPreview.file.previewPath!} name={videoPreview.file.name} />
    </Dialog>}
  </section>;
}
