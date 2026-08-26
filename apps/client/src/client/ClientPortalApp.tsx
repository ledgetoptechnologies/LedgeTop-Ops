import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { AccountMenu, Brand, Card, EmptyState, Loading, StatusPill, openViewerWindow } from "@ltds/ui";
import type { DeliveryLocationCollection } from "@ltds/shared";
import type { RequestError } from "./bulk-download";
import {
  createPortalChangeRequest,
  createPortalServiceRequest,
  createPortalServiceDraft,
  checkpointPortalAttachmentPart,
  completePortalRequestAttachment,
  initializePortalRequestAttachment,
  loadPortalBootstrap,
  loadPortalPastDeliveries,
  loadPortalPastDeliveryLocations,
  loadPortalProjectFileLocations,
  loadPortalProjectFolderFiles,
  loadPortalViewerModels,
  createPortalViewerSession,
  setPortalWorkspaceSelection,
  loadPortalPricingHint,
  listPortalRequestAttachments,
  loadPortalRequestAttachment,
  loadPortalServiceCatalogPage,
  loadPortalServiceDraft,
  loadPortalServiceDrafts,
  loadPortalWorkspaceAccess,
  loadPortalWorkspaceHierarchy,
  loadPortalWorkspaces,
  loadPortalDelegatedShares,
  loadPortalDelegatedShareTargets,
  createPortalDelegatedShare,
  revokePortalDelegatedShare,
  invitePortalWorkspaceMember,
  revokePortalWorkspaceInvitation,
  suspendPortalWorkspaceMember,
  respondToPortalEstimate,
  removePortalRequestAttachment,
  requestPortalAttachmentPartTicket,
  savePortalServiceDraft,
  submitPortalServiceDraft,
  uploadPortalAttachmentPart,
  updatePortalViewerUnits,
  loadPortalViewerShares,
  createPortalViewerShare,
  revokePortalViewerShare,
  updatePortalServiceRequest,
  type PortalBootstrap,
  type PortalFile,
  type PortalFolder,
  type PortalFileBreadcrumb,
  type PortalFilePage,
  type PortalPoi,
  type PortalAreaGeoJson,
  type PortalPricingHint,
  type PortalRequestAttachmentStatus,
  type PortalProject,
  type PortalViewerModel,
  type PortalViewerShare,
  type PortalServiceRequest,
  type PortalServiceCatalogItem,
  type PortalServiceDraft,
  type PortalServiceDraftSummary,
  type PortalServiceDraftInput,
  type PortalServiceQuestion,
  type PortalServiceRequestInput,
  type PortalServiceRequestStatus,
  type PortalWorkspace,
  type PortalWorkspaceEntry,
  type PortalHierarchyScopeType,
  type PortalWorkspaceInvitation,
  type PortalWorkspaceMember,
  type PortalWorkspaceAccess,
  type PortalWorkspaceInvitationInput,
  type PortalProjectAccessTermsInput,
  type PortalDelegatedShare,
  type PortalDelegatedShareCreated,
  type PortalDelegatedShareTarget,
} from "./portal-api";
import { readClientViewerUnits, writeClientViewerUnits } from "./viewer-units-preference";
import {
  clientPortalPath,
  clientProjectPath,
  clientRequestNewPath,
  parseClientPortalRoute,
  type ClientPortalPage,
} from "./portal-route";
import { MapAreaSelector } from "./MapAreaSelector";
import { ImageLocationMap } from "./ImageLocationMap";
import { ServiceLibrary } from "./ServiceLibrary";
import { canBeginRequest, RequestAvailabilityMessage, useRequestAvailability, type RequestAvailability } from "./RequestAvailability";
import { RequestScopeBoundary } from "./RequestScopeBoundary";
import { LeaveFeedback, PortalFeedback } from "./PortalFeedback";
import { PortalNotifications } from "./PortalNotifications";
import { loadFeedbackFile, withPortalWorkspace } from "./feedback-api";
import { NativeWorkspaceContent } from "./NativeWorkspaceContent";
import type { NativePortalBootstrap } from "./native-portal-api";

const PORTAL_FILE_RENDER_WINDOW = 450;
const PORTAL_FILE_RENDER_STEP = 150;

type TopPage = "dashboard" | "projects" | "deliveries" | "requests" | "feedback" | "account";
type WorkspaceTab = "overview" | "files" | "models" | "requests";
type PortalGate =
  | { status: "loading" }
  | { status: "blocked"; title: string; detail: string }
  | { status: "ready"; data: PortalBootstrap | NativePortalBootstrap };

const navigation: Array<{ page: TopPage; label: string }> = [
  { page: "dashboard", label: "Home" },
  { page: "projects", label: "Projects" },
  { page: "deliveries", label: "Deliveries" },
  { page: "requests", label: "Requests" },
  { page: "feedback", label: "Feedback" },
];

function blockedPortal(
  caught: unknown,
): Extract<PortalGate, { status: "blocked" }> {
  const error = caught as RequestError;
  if (error.body?.code === "CLIENT_PORTAL_SCHEMA_OUTDATED")
    return {
      status: "blocked",
      title: "Portal update in progress",
      detail:
        "Your access is valid, but the client portal database update has not finished. Retry shortly or contact LTDS if this continues.",
    };
  if (error.status === 404)
    return {
      status: "blocked",
      title: "Portal unavailable",
      detail: "The client portal is not enabled for this site.",
    };
  if (error.status === 401)
    return {
      status: "blocked",
      title: "Sign in required",
      detail: "Sign in with the client identity provided by LTDS to continue.",
    };
  if (error.status === 403)
    return {
      status: "blocked",
      title: "Access not provisioned",
      detail:
        "This workspace is not available to your verified identity. Contact your LTDS representative.",
    };
  if (error.status === 503)
    return {
      status: "blocked",
      title: "Portal configuration incomplete",
      detail: "Client portal access is not ready on this site.",
    };
  return {
    status: "blocked",
    title: "Portal temporarily unavailable",
    detail: "We could not load the client portal. Please try again later.",
  };
}

function formatDate(
  value: string | null | undefined,
  includeTime = true,
): string {
  if (!value) return "Not scheduled";
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        ...(includeTime ? { timeStyle: "short" as const } : {}),
      }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function statusLabel(status: PortalServiceRequestStatus): string {
  if (status === "accepted_pending_pa_linkage")
    return "Accepted · preparing paperwork";
  if (status === "accepted_linked") return "Accepted";
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(
  status: PortalServiceRequestStatus,
): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed" || status === "accepted_linked") return "success";
  if (status === "cancelled" || status === "declined") return "danger";
  if (status === "submitted" || status === "accepted_pending_pa_linkage")
    return "warning";
  return "neutral";
}

function projectStatusLabel(status: string | null): string {
  if (!status) return "Active";
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function PortalBoundary({ children }: { children: ReactNode }) {
  return (
    <div className="client-portal-boundary">
      <header className="client-portal-gate-header">
        <Brand product="Client portal" />
      </header>
      <main className="client-portal-gate-main">{children}</main>
    </div>
  );
}

function FileBrowser({
  load,
  loadLocations,
  folderId = null,
  onFolderChange,
  mapToken,
  locationScopeLabel,
  emptyTitle,
  emptyDetail,
  feedback = false,
  projectId = null,
  workspaceId = null,
  loadExactFile,
  onLinkedFileChange,
}: {
  load: (folderId: string | null, cursor: string | null, signal: AbortSignal) => Promise<PortalFilePage>;
  loadLocations?: () => Promise<DeliveryLocationCollection>;
  loadExactFile?: (fileId: string, signal: AbortSignal) => Promise<PortalFile>;
  onLinkedFileChange?: () => void;
  folderId?: string | null;
  onFolderChange?: (folderId: string | null) => void;
  mapToken: string | null;
  locationScopeLabel: string;
  emptyTitle: string;
  emptyDetail: string;
  feedback?: boolean;
  projectId?: string | null;
  workspaceId?: string | null;
}) {
  const [files, setFiles] = useState<PortalFile[]>([]);
  const [folders, setFolders] = useState<PortalFolder[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<PortalFileBreadcrumb[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [continuationFolderId, setContinuationFolderId] = useState<string | null>(folderId);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [renderStart, setRenderStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [locations, setLocations] = useState<DeliveryLocationCollection | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: PortalFile; trigger: HTMLElement | null } | null>(null);
  const [previewMediaError, setPreviewMediaError] = useState(false);
  const [linkedFileId, setLinkedFileId] = useState(() => new URLSearchParams(location.search).get("file"));
  const [linkedFileError, setLinkedFileError] = useState(""), [linkedFileLoading, setLinkedFileLoading] = useState(false), [fileRetry, setFileRetry] = useState(0);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const closePreview = () => {
    setPreview(null);
    if ((feedback || loadExactFile) && new URLSearchParams(location.search).has("file")) {
      const url = new URL(location.href); url.searchParams.delete("file"); history.pushState(null, "", `${url.pathname}${url.search}`); setLinkedFileId(null); onLinkedFileChange?.();
    }
  };
  const openPreview = (file: PortalFile, trigger: HTMLElement) => {
    if (!feedback && !loadExactFile) { setPreview({ file, trigger }); return; }
    previewTrigger.current = trigger;
    const url = new URL(withPortalWorkspace(`${location.pathname}${location.search}`), location.origin);
    url.searchParams.set("file", file.id); history.pushState(null, "", `${url.pathname}${url.search}`); setLinkedFileId(file.id); onLinkedFileChange?.();
  };
  useEffect(() => { const sync = () => setLinkedFileId(new URLSearchParams(location.search).get("file")); sync(); addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, [folderId]);
  useEffect(() => {
    setPreview(null); setLinkedFileError(""); setLinkedFileLoading(false);
    if ((!feedback && !loadExactFile) || !linkedFileId) return;
    const controller = new AbortController(); setLinkedFileLoading(true);
    void (loadExactFile ? loadExactFile(linkedFileId, controller.signal) : loadFeedbackFile(linkedFileId, projectId, workspaceId, controller.signal)).then(file => {
      if (!controller.signal.aborted) setPreview({ file, trigger: previewTrigger.current });
    }).catch(() => { if (!controller.signal.aborted) setLinkedFileError("This file could not be opened. It may have changed or no longer be shared with you."); })
      .finally(() => { if (!controller.signal.aborted) setLinkedFileLoading(false); });
    return () => controller.abort();
  }, [feedback, loadExactFile, linkedFileId, projectId, workspaceId, fileRetry]);
  const previewDialog = useRef<HTMLElement>(null);
  const pageRequest = useRef<{
    folderId: string | null;
    cursor: string;
    controller: AbortController;
    promise: Promise<PortalFilePage>;
  } | null>(null);
  const prefetchedPage = useRef<{ folderId: string | null; cursor: string; page: PortalFilePage } | null>(null);
  const loadMoreSentinel = useRef<HTMLDivElement | null>(null);
  const lastAutoCursor = useRef("");
  const browserVersion = useRef(0);
  useEffect(() => {
    const version = ++browserVersion.current;
    let active = true;
    const controller = new AbortController();
    pageRequest.current?.controller.abort();
    pageRequest.current = null;
    prefetchedPage.current = null;
    lastAutoCursor.current = "";
    setLoading(true);
    setLoadingMore(false);
    setRenderStart(0);
    setError(null);
    setFiles([]);
    setFolders([]);
    setBreadcrumbs([]);
    setCursor(null);
    setContinuationFolderId(folderId);
    void (async () => {
      try {
        const result = await load(folderId, null, controller.signal);
        if (!active || version !== browserVersion.current) return;
        setFiles(result.files);
        setFolders(result.folders ?? []);
        setBreadcrumbs(result.breadcrumbs ?? []);
        setContinuationFolderId(result.folderId ?? folderId);
        setCursor(result.cursor);
      } catch (caught) {
        if (!active || controller.signal.aborted || (caught as Error).name === "AbortError") return;
        const status = (caught as RequestError).status;
        if ([401, 403, 404, 410].includes(status ?? 0)) {
          setFiles([]);
          setFolders([]);
          setBreadcrumbs([]);
          setCursor(null);
        }
        setError("Files could not be loaded. Your access may have changed; try again.");
      } finally {
        if (active) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
      pageRequest.current?.controller.abort();
      pageRequest.current = null;
      prefetchedPage.current = null;
    };
  }, [folderId, load, retryVersion]);
  useEffect(() => {
    let active = true;
    setLocations(null);
    setLocationError(null);
    loadLocations?.()
      .then((result) => { if (active) setLocations(result); })
      .catch(() => { if (active) setLocationError("Image locations could not be loaded."); });
    return () => { active = false; };
  }, [loadLocations]);
  useEffect(() => {
    if (!preview) return;
    setPreviewMediaError(false);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    previewDialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closePreview(); }
      if (event.key === "Tab") {
        const focusable = [...(previewDialog.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, video[controls], audio[controls], iframe') || [])];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === previewDialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.body.style.overflow = priorOverflow;
      preview.trigger?.focus();
    };
  }, [preview]);
  const requestPage = useCallback((requestFolderId: string | null, requestCursor: string) => {
    const active = pageRequest.current;
    if (active?.folderId === requestFolderId && active.cursor === requestCursor) return active.promise;
    if (active) return null;
    const controller = new AbortController();
    const promise = load(requestFolderId, requestCursor, controller.signal);
    pageRequest.current = { folderId: requestFolderId, cursor: requestCursor, controller, promise };
    void promise.then(
      () => { if (pageRequest.current?.promise === promise) pageRequest.current = null; },
      () => { if (pageRequest.current?.promise === promise) pageRequest.current = null; },
    );
    return promise;
  }, [load]);
  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const requestCursor = cursor;
    const requestFolderId = continuationFolderId;
    const version = browserVersion.current;
    setLoadingMore(true);
    setError(null);
    try {
      const prepared = prefetchedPage.current;
      const result = prepared?.folderId === requestFolderId && prepared.cursor === requestCursor
        ? prepared.page
        : await requestPage(requestFolderId, requestCursor);
      if (!result || version !== browserVersion.current) return;
      if (prefetchedPage.current?.folderId === requestFolderId && prefetchedPage.current.cursor === requestCursor) prefetchedPage.current = null;
      setFiles(current => {
        const ids = new Set(current.map(file => file.id));
        return [...current, ...result.files.filter(file => !ids.has(file.id))];
      });
      setFolders(current => {
        const ids = new Set(current.map(folder => folder.id));
        return [...current, ...(result.folders ?? []).filter(folder => !ids.has(folder.id))];
      });
      setCursor(result.cursor);
    } catch (caught) {
      if ((caught as Error).name === "AbortError" || version !== browserVersion.current) return;
      const status = (caught as RequestError).status;
      if ([401, 403, 404, 410].includes(status ?? 0)) {
        setFiles([]);
        setFolders([]);
        setBreadcrumbs([]);
        setCursor(null);
      }
      setError("More files could not be loaded.");
    } finally {
      if (version === browserVersion.current) setLoadingMore(false);
    }
  }, [continuationFolderId, cursor, loadingMore, requestPage]);
  useEffect(() => {
    if (!cursor || loading) return;
    const requestCursor = cursor;
    const requestFolderId = continuationFolderId;
    const version = browserVersion.current;
    let cancelled = false;
    const prepare = () => {
      const request = requestPage(requestFolderId, requestCursor);
      if (!request) return;
      void request.then(page => {
        if (!cancelled && version === browserVersion.current) prefetchedPage.current = { folderId: requestFolderId, cursor: requestCursor, page };
      }).catch(caught => {
        if (!cancelled && version === browserVersion.current && (caught as Error).name !== "AbortError") setError("The next page could not be prepared. Use Load more to retry.");
      });
    };
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const requestIdle = idleWindow.requestIdleCallback;
    const cancelIdle = idleWindow.cancelIdleCallback;
    const handle = requestIdle
      ? requestIdle(prepare, { timeout: 1200 })
      : window.setTimeout(prepare, 120);
    return () => {
      cancelled = true;
      if (cancelIdle && requestIdle) cancelIdle(handle);
      else window.clearTimeout(handle);
    };
  }, [continuationFolderId, cursor, loading, requestPage]);
  useEffect(() => {
    const target = loadMoreSentinel.current;
    if (!cursor || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || lastAutoCursor.current === cursor) return;
      lastAutoCursor.current = cursor;
      void more();
    }, { rootMargin: "700px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, more]);
  const totalEntries = folders.length + files.length;
  const priorEntryCount = useRef(0);
  useEffect(() => {
    if (totalEntries < priorEntryCount.current) setRenderStart(0);
    else if (totalEntries > priorEntryCount.current && totalEntries > PORTAL_FILE_RENDER_WINDOW) {
      setRenderStart(totalEntries - PORTAL_FILE_RENDER_WINDOW);
    }
    priorEntryCount.current = totalEntries;
  }, [totalEntries]);
  const visibleFolders = folders.slice(renderStart, Math.min(folders.length, renderStart + PORTAL_FILE_RENDER_WINDOW));
  const visibleFileStart = Math.max(0, renderStart - folders.length);
  const visibleFiles = files.slice(visibleFileStart, visibleFileStart + PORTAL_FILE_RENDER_WINDOW - visibleFolders.length);
  return (
    <div>
      {loadLocations && <ImageLocationMap token={mapToken} locations={locations} scopeLabel={locationScopeLabel} />}
      {linkedFileLoading && <p role="status">Opening linked file…</p>}
      {linkedFileError && <div role="alert"><p>{linkedFileError}</p><button className="button-ghost" onClick={() => setFileRetry(value => value + 1)}>Retry linked file</button></div>}
      {feedback && !loading && !error && projectId && continuationFolderId && <LeaveFeedback key={continuationFolderId} target={{ kind: "folder", projectId, folderId: continuationFolderId }} label={breadcrumbs.at(-1)?.name || "Current folder"} />}
      {locationError && <p className="portal-message error" role="alert">{locationError}</p>}
      {breadcrumbs.length > 0 && onFolderChange && (
        <nav className="portal-file-breadcrumbs" aria-label="Project file folders">
          <ol>{breadcrumbs.map((crumb, index) => <li key={`${crumb.id ?? "root"}:${index}`}>
            {index === breadcrumbs.length - 1
              ? <span aria-current="page" title={crumb.name}>{crumb.name}</span>
              : <button type="button" title={crumb.name} onClick={() => onFolderChange(crumb.id)}>{crumb.name}</button>}
          </li>)}</ol>
        </nav>
      )}
      {loading ? <Loading /> : error && files.length === 0 && folders.length === 0 ? (
        <div className="portal-inline-error" role="alert"><p>{error}</p><button className="button-ghost button-small" onClick={() => setRetryVersion(current => current + 1)}>Try again</button></div>
      ) : files.length === 0 && folders.length === 0 ? (
        <EmptyState title={emptyTitle} detail={emptyDetail} />
      ) : <>
      {renderStart > 0 && <div className="portal-load-more"><button className="button-ghost" onClick={() => setRenderStart(current => Math.max(0, current - PORTAL_FILE_RENDER_STEP))}>Show earlier files</button></div>}
      <div className="portal-file-list">
        {visibleFolders.map((folder) => (
          <button key={folder.id} type="button" className="portal-folder-row" title={folder.name} onClick={() => onFolderChange?.(folder.id)}>
            <span className="portal-file-icon" aria-hidden="true">DIR</span>
            <span><strong>{folder.name}</strong><small>Open folder</small></span>
            <span aria-hidden="true">&gt;</span>
          </button>
        ))}
        {visibleFiles.map((file) => (
          <article key={file.id} className="portal-file-row">
            <PortalFileThumbnail file={file} />
            <div>
              <strong>{file.name}</strong>
              <span>
                {formatBytes(file.size)} · Added {formatDate(file.uploadedAt)}
              </span>
            </div>
            <div className="portal-file-actions">
              {file.previewPath && (
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={event => openPreview(file, event.currentTarget)}
                >
                  Preview
                </button>
              )}
              <a
                className="button button-orange button-small"
                href={file.downloadPath}
              >
                Download
              </a>
              {feedback && <LeaveFeedback target={{ kind: "file", projectId, fileId: file.id }} label={file.name} compact />}
            </div>
          </article>
        ))}
      </div>
      {renderStart + PORTAL_FILE_RENDER_WINDOW < totalEntries && <div className="portal-load-more"><button className="button-ghost" onClick={() => setRenderStart(current => Math.min(totalEntries - PORTAL_FILE_RENDER_WINDOW, current + PORTAL_FILE_RENDER_STEP))}>Show later files</button></div>}
      </>}
      {error && (files.length > 0 || folders.length > 0) && (
        <p className="portal-message error" role="alert">
          {error}
        </p>
      )}
      {cursor && (
        <div ref={loadMoreSentinel} className="portal-load-more">
          <button
            className="button-ghost"
            onClick={() => void more()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {preview && (
        <div
          className="portal-file-preview-backdrop"
          onMouseDown={event => { if (event.currentTarget === event.target) closePreview(); }}
        >
          <section
            ref={previewDialog}
            className="portal-file-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${preview.file.name}`}
            tabIndex={-1}
          >
            <header>
              <div><strong>{preview.file.name}</strong><span>{formatBytes(preview.file.size)}</span></div>
              <div className="portal-file-preview-actions">
                <a className="button button-orange button-small" href={preview.file.downloadPath}>Download</a>
                <button type="button" className="button-ghost button-small" onClick={closePreview} aria-label="Close preview">Close</button>
              </div>
            </header>
            {feedback && <LeaveFeedback key={preview.file.id} target={{ kind: "file", projectId, fileId: preview.file.id }} label={preview.file.name} />}
            <div className="portal-file-preview-stage">
              {loadExactFile && previewMediaError && <div role="alert"><p>The preview could not be loaded. The file or your access may have changed.</p><button className="button-ghost" onClick={() => setFileRetry(value => value + 1)}>Retry preview</button></div>}
              {preview.file.kind === "image" && <img src={preview.file.previewPath!} alt={preview.file.name} onError={loadExactFile ? () => setPreviewMediaError(true) : undefined} />}
              {preview.file.kind === "video" && <video src={preview.file.previewPath!} controls playsInline preload="metadata" onError={loadExactFile ? () => setPreviewMediaError(true) : undefined} />}
              {preview.file.kind === "audio" && <audio src={preview.file.previewPath!} controls preload="metadata" onError={loadExactFile ? () => setPreviewMediaError(true) : undefined} />}
              {(preview.file.kind === "pdf" || preview.file.kind === "text") && (
                <iframe src={preview.file.previewPath!} title={`Preview ${preview.file.name}`} />
              )}
              {!preview.file.previewPath && <p>No browser preview is available for this file. You can download it{feedback ? " or leave feedback" : ""}.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PortalFileThumbnail({ file }: { file: PortalFile }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.thumbnailPath]);
  const label = file.kind === "other"
    ? file.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"
    : file.kind.slice(0, 4).toUpperCase();
  return (
    <div className="portal-file-icon" aria-hidden="true">
      {file.thumbnailPath && !failed
        ? <img src={file.thumbnailPath} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : label}
    </div>
  );
}

function QuoteSummary({ request }: { request: PortalServiceRequest }) {
  const quote = request.acceptedQuote;
  if (!quote) return null;
  return (
    <aside className="portal-quote-summary">
      <span>Verified accepted quote</span>
      <strong>
        {quote.total === null
          ? "Amount unavailable"
          : new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: quote.currency || "USD",
            }).format(quote.total)}
      </strong>
      <small>
        {quote.documentNumber || "Document number unavailable"} · {quote.status} · Verified{" "}
        {formatDate(quote.verifiedAt)}
      </small>
    </aside>
  );
}

function EstimateSummary({
  request,
  onRespond,
}: {
  request: PortalServiceRequest;
  onRespond?: (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => void;
}) {
  const estimate = request.operationalEstimate;
  if (!estimate || estimate.status === "draft") return null;
  return (
    <aside className="portal-estimate-summary">
      <span>Non-binding LTDS operational estimate</span>
      <strong>Scope proposal</strong>
      <p>{estimate.scope}</p>
      <small>
        This is not a quote, contract, or invoice. Project Alpha remains the
        financial system of record.
      </small>
      <div>
        <StatusPill
          tone={
            estimate.status === "accepted"
              ? "success"
              : estimate.status === "change_requested"
                ? "warning"
                : "neutral"
          }
        >
          {estimate.status === "ready"
            ? "Estimate ready"
            : estimate.status.replaceAll("_", " ")}
        </StatusPill>
        {estimate.status === "ready" && onRespond && (
          <>
            <button
              className="button-orange button-small"
              onClick={() => onRespond(request, "accept")}
            >
              Accept estimate
            </button>
            <button
              className="button-ghost button-small"
              onClick={() => onRespond(request, "request_change")}
            >
              Request changes
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function RequestList({
  requests,
  projects,
  limit,
  onEdit,
  onChange,
  onEstimateRespond,
}: {
  requests: PortalServiceRequest[];
  projects: PortalProject[];
  limit?: number;
  onEdit?: (request: PortalServiceRequest) => void;
  onChange?: (request: PortalServiceRequest) => void;
  onEstimateRespond?: (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => void;
}) {
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.projectName])),
    [projects],
  );
  const visible = limit ? requests.slice(0, limit) : requests;
  if (visible.length === 0)
    return (
      <EmptyState
        title="No service requests"
        detail="Requests you submit will appear here."
      />
    );
  return (
    <div className="portal-request-list">
      {visible.map((request) => (
        <article key={request.id} className="portal-request-row">
          <div className="portal-request-main">
            <div>
              <strong>{request.title}</strong>
              <span>
                {request.projectId
                  ? projectNames.get(request.projectId) || "Authorized project"
                  : "New or one-off service"}{" "}
                · Service request
                {request.parentRequestId ? " · Linked change request" : ""}
              </span>
            </div>
            <EstimateSummary request={request} onRespond={onEstimateRespond} />
            <QuoteSummary request={request} />
            {request.workAreaRevision && (
              <aside className="portal-work-area-update" role="status">
                <strong>Operations updated the work area</strong>
                <span>{request.workAreaRevision.changeSummary}</span>
                <small>
                  Staff revision {request.workAreaRevision.revisionNumber} · {formatDate(request.workAreaRevision.updatedAt)}
                </small>
              </aside>
            )}
          </div>
          <div className="portal-request-state">
            <StatusPill tone={statusTone(request.status)}>
              {statusLabel(request.status)}
            </StatusPill>
            <time>{formatDate(request.createdAt)}</time>
          </div>
          {(onEdit || onChange) && (
            <div className="portal-request-actions">
              {request.status === "submitted" && onEdit && (
                <button
                  className="button-ghost button-small"
                  onClick={() => onEdit(request)}
                >
                  Edit
                </button>
              )}
              {request.status !== "submitted" &&
                !["declined", "cancelled", "completed"].includes(
                  request.status,
                ) &&
                onChange && (
                  <button
                    className="button-ghost button-small"
                    onClick={() => onChange(request)}
                  >
                    Request a change
                  </button>
                )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

const REQUEST_STEPS = ["services", "location", "details", "contact", "review"] as const;
type RequestStep = (typeof REQUEST_STEPS)[number];

function requestStepFromLocation(): RequestStep {
  const requested = new URLSearchParams(window.location.search).get("step");
  return REQUEST_STEPS.includes(requested as RequestStep) ? requested as RequestStep : "services";
}

function dateTimeLocalValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function questionIsAnswered(question: PortalServiceQuestion, value: unknown): boolean {
  if (!question.required) return true;
  if (question.type === "boolean") return typeof value === "boolean";
  if (question.type === "multi_select") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function ServiceQuestionField({
  serviceId,
  question,
  value,
  onChange,
}: {
  serviceId: string;
  question: PortalServiceQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `service-${serviceId}-${question.id}`;
  const helpId = question.helpText ? `${id}-help` : undefined;
  const shared = { id, required: question.required, "aria-describedby": helpId };
  let control: ReactNode;
  if (question.type === "text") {
    control = <input {...shared} value={typeof value === "string" ? value : ""} maxLength={question.maxLength} onChange={(event) => onChange(event.target.value)} />;
  } else if (question.type === "number") {
    control = <input {...shared} type="number" value={typeof value === "number" ? value : ""} min={question.minimum ?? undefined} max={question.maximum ?? undefined} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} />;
  } else if (question.type === "boolean") {
    control = <select {...shared} value={typeof value === "boolean" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Select an answer</option><option value="true">Yes</option><option value="false">No</option></select>;
  } else if (question.type === "select") {
    control = <select {...shared} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Select an option</option>{question.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  } else {
    const selected = Array.isArray(value) ? value as string[] : [];
    control = <div className="portal-service-options" id={id} aria-describedby={helpId}>{question.options.map(option => <label key={option.value} className="portal-check-option"><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} /> <span>{option.label}</span></label>)}</div>;
  }
  return <div className="portal-service-question"><label htmlFor={question.type === "multi_select" ? undefined : id}>{question.label}{question.required ? <span aria-hidden="true"> *</span> : <span> (optional)</span>}{control}</label>{question.helpText && <small id={helpId}>{question.helpText}</small>}</div>;
}

function formatRequestMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}

const REQUEST_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const requestAttachmentTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
};
type RequestAttachmentUi = {
  key: string; id?: string; clientUploadId: string; file?: File; name: string; size: number;
  status: PortalRequestAttachmentStatus | "queued" | "error"; uploadedBytes: number;
  completedParts: number; totalParts: number; error?: string;
};

function normalizedAttachmentType(file: File): string | null {
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const expected = requestAttachmentTypes[extension];
  if (!expected || (file.type && file.type.toLowerCase() !== expected)) return null;
  return expected;
}

function attachmentStatusLabel(status: RequestAttachmentUi["status"]): string {
  if (status === "queued") return "Waiting";
  if (status === "uploading") return "Uploading";
  if (status === "quarantined") return "Quarantined";
  if (status === "scanning") return "Scanning";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  if (status === "aborted") return "Removed";
  return "Needs attention";
}

function RequestReviewMap({ area, points }: { area: PortalAreaGeoJson | null; points: PortalPoi[] }) {
  const width = 640;
  const height = 280;
  const padding = 24;
  const rings = area?.coordinates ?? [];
  const coordinates = [
    ...rings.flat(),
    ...points.map(point => [point.longitude, point.latitude] as [number, number]),
  ];
  if (!coordinates.length) {
    return <div className="portal-review-map-empty">No boundary or points were added.</div>;
  }
  const longitudes = coordinates.map(point => point[0]);
  const latitudes = coordinates.map(point => point[1]);
  const minimumLongitude = Math.min(...longitudes);
  const maximumLongitude = Math.max(...longitudes);
  const minimumLatitude = Math.min(...latitudes);
  const maximumLatitude = Math.max(...latitudes);
  const longitudeSpan = Math.max(maximumLongitude - minimumLongitude, 0.000001);
  const latitudeSpan = Math.max(maximumLatitude - minimumLatitude, 0.000001);
  const scale = Math.min((width - padding * 2) / longitudeSpan, (height - padding * 2) / latitudeSpan);
  const renderedWidth = longitudeSpan * scale;
  const renderedHeight = latitudeSpan * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;
  const project = ([longitude, latitude]: [number, number]) => ({
    x: offsetX + (longitude - minimumLongitude) * scale,
    y: offsetY + (maximumLatitude - latitude) * scale,
  });
  const boundaryPath = rings.map(ring => ring.map((point, index) => {
    const projected = project(point);
    return `${index === 0 ? "M" : "L"}${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`;
  }).join(" ") + " Z").join(" ");

  return <figure className="portal-review-map-summary">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Read-only preview of the requested work boundary and points of interest">
      <rect className="portal-review-map-background" x="0" y="0" width={width} height={height} rx="12" />
      <path className="portal-review-map-grid" d={`M0 ${height / 3}H${width} M0 ${(height / 3) * 2}H${width} M${width / 3} 0V${height} M${(width / 3) * 2} 0V${height}`} />
      {boundaryPath && <path className="portal-review-boundary" d={boundaryPath} fillRule="evenodd" />}
      {points.map((point, index) => {
        const projected = project([point.longitude, point.latitude]);
        return <g key={`${point.longitude}:${point.latitude}:${index}`}>
          <circle className="portal-review-poi-marker" cx={projected.x} cy={projected.y} r="8" />
          <text className="portal-review-poi-number" x={projected.x} y={projected.y + 3}>{index + 1}</text>
        </g>;
      })}
    </svg>
    <figcaption>Read-only boundary preview for confirmation. Use Edit work area to make changes.</figcaption>
  </figure>;
}

function NewServiceRequestWizard({
  projects,
  projectId: fixedProjectId,
  onSaved,
  onCancel,
  mapboxPublicToken,
  attachmentsEnabled = false,
  initialDraftId,
  fixedScope = false,
}: {
  projects: PortalProject[];
  projectId?: string;
  onSaved: (request: PortalServiceRequest) => void;
  onCancel?: () => void;
  mapboxPublicToken: string | null;
  attachmentsEnabled?: boolean;
  initialDraftId?: string | null;
  fixedScope?: boolean;
}) {
  const eligibleProjects = projects.filter(project => project.canRequestService);
  const [step, setStepState] = useState<RequestStep>(requestStepFromLocation);
  const [catalog, setCatalog] = useState<PortalServiceCatalogItem[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogComplete, setCatalogComplete] = useState(false);
  const [catalogLegacy, setCatalogLegacy] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogPageError, setCatalogPageError] = useState("");
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [selectedServiceVersions, setSelectedServiceVersions] = useState<Record<string, string>>({});
  const [selectedSnapshots, setSelectedSnapshots] = useState<Record<string, PortalServiceCatalogItem>>({});
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>({});
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [location, setLocation] = useState("");
  const [preferredStartAt, setPreferredStartAt] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [siteContactName, setSiteContactName] = useState("");
  const [siteContactEmail, setSiteContactEmail] = useState("");
  const [siteContactPhone, setSiteContactPhone] = useState("");
  const [desiredCompletionAt, setDesiredCompletionAt] = useState("");
  const [points, setPoints] = useState<PortalPoi[]>([]);
  const [areaGeoJson, setAreaGeoJson] = useState<PortalAreaGeoJson | null>(null);
  const [draft, setDraft] = useState<PortalServiceDraft | null>(null);
  const [pricingHint, setPricingHint] = useState<PortalPricingHint | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<RequestAttachmentUi[]>([]);
  const [attachmentMessage, setAttachmentMessage] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(Boolean(initialDraftId));
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const mounted = useRef(true);
  const wizardLifetime = useRef(0);
  const draftRef = useRef<PortalServiceDraft | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastSaved = useRef("");
  const createKey = useRef(crypto.randomUUID());
  const pricingHintController = useRef<AbortController | null>(null);
  const pricingBasisRef = useRef("");
  const catalogController = useRef<AbortController | null>(null);
  const catalogSequence = useRef(0);
  const catalogSource = useRef<{ generation: string; sequence: number } | null>(null);

  const loadCatalogPage = (cursor: string | null = null) => {
    if (cursor && catalogController.current) return;
    catalogController.current?.abort();
    const controller = new AbortController();
    catalogController.current = controller;
    const sequence = ++catalogSequence.current;
    if (cursor) setCatalogLoadingMore(true);
    else { setCatalogState("loading"); setCatalog([]); setCatalogCursor(null); setCatalogComplete(false); setCatalogLegacy(false); catalogSource.current = null; }
    setCatalogPageError("");
    loadPortalServiceCatalogPage(cursor, controller.signal).then(result => {
      if (!mounted.current || controller.signal.aborted || sequence !== catalogSequence.current) return;
      if (cursor && (!result.source || !catalogSource.current || result.source.generation !== catalogSource.current.generation || result.source.sequence !== catalogSource.current.sequence)) {
        setCatalog([]); setCatalogCursor(null); setCatalogComplete(false); setCatalogState("error");
        setCatalogPageError("The service library changed while more services were loading. Refresh the library; your selected services and answers are preserved.");
        return;
      }
      // Published choices and saved snapshots are different sources of truth.
      setCatalog(current => [...new Map((cursor ? [...current, ...result.services] : result.services).map(item => [item.publicId, item])).values()]);
      catalogSource.current = result.source;
      setCatalogLegacy(result.legacy === true);
      setCatalogCursor(result.nextCursor); setCatalogComplete(result.complete);
      setCatalogState("ready");
    }).catch(caught => {
      if (!mounted.current || controller.signal.aborted || sequence !== catalogSequence.current) return;
      if (cursor && ![401, 403, 409].includes((caught as RequestError).status ?? 0)) {
        setCatalogPageError("More services could not be loaded. Your current selections and loaded categories are unchanged.");
      } else {
        setCatalog([]); setCatalogCursor(null); setCatalogComplete(false); setCatalogState("error");
        if ((caught as RequestError).status === 409) setCatalogPageError("The service library changed. Refresh it to continue; your selected services and answers are preserved.");
      }
    }).finally(() => {
      if (sequence === catalogSequence.current && !controller.signal.aborted) { catalogController.current = null; setCatalogLoadingMore(false); }
    });
  };
  const reloadCatalog = () => loadCatalogPage();

  useEffect(() => {
    mounted.current = true;
    wizardLifetime.current += 1;
    reloadCatalog();
    const onPopState = () => setStepState(requestStepFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => {
      mounted.current = false;
      wizardLifetime.current += 1;
      pricingHintController.current?.abort();
      catalogController.current?.abort();
      catalogSequence.current += 1;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!initialDraftId) return;
    let active = true;
    Promise.all([
      loadPortalServiceDraft(initialDraftId),
      attachmentsEnabled ? listPortalRequestAttachments(initialDraftId) : Promise.resolve([]),
    ]).then(([saved, savedAttachments]) => {
      if (!active) return;
      if (saved.state !== "draft") {
        setDraftLoadFailed(true);
        setMessage("This saved request is no longer available as a draft.");
        return;
      }
      const restoredInput: PortalServiceDraftInput = {
        projectId: saved.projectId,
        requestType: saved.requestType,
        title: saved.title,
        details: saved.details,
        location: saved.location,
        preferredStartAt: saved.preferredStartAt,
        deliverables: saved.deliverables,
        siteContactName: saved.siteContactName,
        siteContactEmail: saved.siteContactEmail,
        siteContactPhone: saved.siteContactPhone,
        desiredCompletionAt: saved.desiredCompletionAt,
        latitude: saved.latitude,
        longitude: saved.longitude,
        areaGeoJson: saved.areaGeoJson,
        poiPoints: saved.poiPoints,
        services: saved.services.map(service => ({ publicId: service.publicId, sourceVersion: service.sourceVersion, answers: service.answers })),
      };
      draftRef.current = saved;
      lastSaved.current = JSON.stringify(restoredInput);
      setDraft(saved);
      setProjectId(fixedProjectId ?? saved.projectId ?? "");
      setTitle(saved.title);
      setDetails(saved.details);
      setLocation(saved.location ?? "");
      setPreferredStartAt(dateTimeLocalValue(saved.preferredStartAt));
      setDeliverables(saved.deliverables ?? "");
      setSiteContactName(saved.siteContactName ?? "");
      setSiteContactEmail(saved.siteContactEmail ?? "");
      setSiteContactPhone(saved.siteContactPhone ?? "");
      setDesiredCompletionAt(dateTimeLocalValue(saved.desiredCompletionAt));
      setPoints(saved.poiPoints);
      setAreaGeoJson(saved.areaGeoJson);
      setSelectedServices(saved.services.map(service => service.publicId));
      setSelectedServiceVersions(Object.fromEntries(saved.services.map(service => [service.publicId, service.sourceVersion])));
      setSelectedSnapshots(Object.fromEntries(saved.services.map(service => [service.publicId, service])));
      setAnswers(Object.fromEntries(saved.services.map(service => [service.publicId, service.answers])));
      setAttachments(savedAttachments.filter(item => item.status !== "aborted").map(item => ({
        key: item.id,
        id: item.id,
        clientUploadId: crypto.randomUUID(),
        name: item.name,
        size: item.size,
        status: item.status,
        uploadedBytes: item.status === "accepted" ? item.size : 0,
        completedParts: 0,
        totalParts: 0,
        error: item.status === "rejected"
          ? "The security scan rejected this file. Remove it and upload a safe replacement before submitting."
          : item.status === "expired"
            ? "This upload expired before it was accepted. Remove it and upload the file again before submitting."
            : undefined,
      })));
      setSaveState("saved");
      setDirty(false);
      setMessage("");
      for (const item of savedAttachments) {
        if (["quarantined", "scanning"].includes(item.status)) void pollAttachment(item.id, saved.id, item.id).catch(() => undefined);
      }
    }).catch((caught) => {
      if (active) {
        setDraftLoadFailed(true);
        setMessage((caught as Error).message || "This draft could not be loaded.");
      }
    }).finally(() => {
      if (active) setLoadingDraft(false);
    });
    return () => { active = false; };
  }, [initialDraftId, attachmentsEnabled, fixedProjectId]);

  useEffect(() => {
    if (!pricingHint) return;
    const remaining = Date.parse(pricingHint.validUntil) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setPricingHint(null);
      return;
    }
    const timeout = window.setTimeout(() => setPricingHint(null), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [pricingHint]);

  const input = useMemo<PortalServiceDraftInput>(() => ({
    projectId: projectId || null,
    requestType: "service",
    title: title.trim(),
    details: details.trim(),
    location: location.trim() || null,
    preferredStartAt: preferredStartAt ? new Date(preferredStartAt).toISOString() : null,
    deliverables: deliverables.trim() || null,
    siteContactName: siteContactName.trim() || null,
    siteContactEmail: siteContactEmail.trim() || null,
    siteContactPhone: siteContactPhone.trim() || null,
    desiredCompletionAt: desiredCompletionAt ? new Date(desiredCompletionAt).toISOString() : null,
    latitude: points[0]?.latitude ?? null,
    longitude: points[0]?.longitude ?? null,
    areaGeoJson,
    poiPoints: points.map(point => ({ longitude: point.longitude, latitude: point.latitude, label: point.label?.trim() || null })),
    services: selectedServices.map(publicId => ({
      publicId,
      sourceVersion: selectedServiceVersions[publicId] ?? catalog.find(service => service.publicId === publicId)?.sourceVersion ?? "",
      answers: answers[publicId] ?? {},
    })),
  }), [projectId, title, details, location, preferredStartAt, deliverables, siteContactName, siteContactEmail, siteContactPhone, desiredCompletionAt, points, areaGeoJson, selectedServices, selectedServiceVersions, answers, catalog]);
  const inputJson = JSON.stringify(input);
  const pricingBasisJson = JSON.stringify({
    projectId: input.projectId,
    areaGeoJson: input.areaGeoJson,
    services: input.services,
  });
  pricingBasisRef.current = pricingBasisJson;

  const persist = (snapshot: PortalServiceDraftInput, serialized: string): Promise<void> => {
    const lifetime = wizardLifetime.current;
    const currentLifetime = () => mounted.current && wizardLifetime.current === lifetime;
    saveChain.current = saveChain.current.catch(() => undefined).then(async () => {
      if (!currentLifetime() || serialized === lastSaved.current) return;
      if (mounted.current) setSaveState("saving");
      try {
        const savedPricingBasis = JSON.stringify({
          projectId: snapshot.projectId,
          areaGeoJson: snapshot.areaGeoJson,
          services: snapshot.services,
        });
        const current = draftRef.current;
        const saved = current
          ? await savePortalServiceDraft(current.id, current.version, snapshot, crypto.randomUUID())
          : await createPortalServiceDraft(snapshot, createKey.current);
        if (!currentLifetime()) return;
        draftRef.current = saved;
        if (!current) {
          const url = new URL(window.location.href);
          url.searchParams.set("draft", saved.id);
          window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        }
        lastSaved.current = serialized;
        if (currentLifetime()) {
          setDraft(saved);
          setSaveState("saved");
          setDirty(false);
          pricingHintController.current?.abort();
          const controller = new AbortController();
          pricingHintController.current = controller;
          loadPortalPricingHint(saved.id, undefined, controller.signal).then(hint => {
            if (mounted.current && pricingHintController.current === controller && pricingBasisRef.current === savedPricingBasis) {
              setPricingHint(hint);
            }
          }).catch(() => {
            if (mounted.current && pricingHintController.current === controller && !controller.signal.aborted) setPricingHint(null);
          });
        }
      } catch (caught) {
        const error = caught as RequestError;
        if (currentLifetime()) {
          const catalogChanged = error.status === 409 && error.body?.code === "catalog_changed";
          setSaveState(error.status === 409 && !catalogChanged ? "conflict" : "error");
          if (catalogChanged) setDirty(false);
          setMessage(catalogChanged
            ? "The Project Alpha service library changed. Your saved selection was preserved; review the highlighted service and explicitly use its current version."
            : error.status === 409
              ? "This draft changed in another tab. Reload this page before making more changes."
              : "Your latest changes could not be saved. Check your connection and try again.");
          if (catalogChanged) reloadCatalog();
        }
        throw caught;
      }
    });
    return saveChain.current;
  };

  const updateAttachment = (key: string, update: Partial<RequestAttachmentUi>) =>
    setAttachments(current => current.map(item => item.key === key ? { ...item, ...update } : item));

  async function pollAttachment(key: string, draftId: string, attachmentId: string) {
    const lifetime = wizardLifetime.current;
    const currentLifetime = () => mounted.current && wizardLifetime.current === lifetime;
    for (let attempt = 0; attempt < 120 && currentLifetime(); attempt += 1) {
      const current = await loadPortalRequestAttachment(draftId, attachmentId);
      if (!currentLifetime()) return;
      updateAttachment(key, {
        status: current.status,
        error: current.status === "rejected"
          ? "The security scan rejected this file. Remove it and upload a safe replacement before submitting."
          : current.status === "expired"
            ? "This upload expired before it was accepted. Remove it and upload the file again before submitting."
            : undefined,
      });
      if (["accepted", "rejected", "expired", "aborted"].includes(current.status)) return;
      await new Promise(resolve => window.setTimeout(resolve, 1000));
    }
  }

  async function uploadAttachment(item: RequestAttachmentUi) {
    const lifetime = wizardLifetime.current;
    const currentLifetime = () => mounted.current && wizardLifetime.current === lifetime;
    if (!currentLifetime()) return;
    updateAttachment(item.key, { status: "uploading", error: undefined });
    try {
      const file = item.file;
      if (!file) throw new Error("Choose the file again to retry this upload.");
      await persist(input, inputJson);
      if (!currentLifetime()) return;
      const currentDraft = draftRef.current;
      if (!currentDraft) throw new Error("Save the request draft before adding files.");
      const contentType = normalizedAttachmentType(file);
      if (!contentType) throw new Error("Choose a JPEG, PNG, WebP, HEIC, HEIF, or PDF whose extension matches its file type.");
      const initialized = await initializePortalRequestAttachment(currentDraft.id, {
        clientUploadId: item.clientUploadId, name: item.name, contentType, size: item.size,
      });
      if (!currentLifetime()) return;
      const completed = new Map(initialized.completedParts.map(part => [part.partNumber, part]));
      const count = Math.ceil(item.size / initialized.partSize);
      updateAttachment(item.key, { id: initialized.attachmentId, totalParts: count, completedParts: completed.size,
        uploadedBytes: [...completed.values()].reduce((sum, part) => sum + part.size, 0), status: initialized.status });
      if (initialized.status !== "uploading") {
        await pollAttachment(item.key, currentDraft.id, initialized.attachmentId);
        return;
      }
      for (let partNumber = 1; partNumber <= count; partNumber += 1) {
        if (!currentLifetime()) return;
        if (completed.has(partNumber)) continue;
        const start = (partNumber - 1) * initialized.partSize;
        const blob = file.slice(start, Math.min(item.size, start + initialized.partSize), contentType);
        const priorBytes = [...completed.values()].reduce((sum, part) => sum + part.size, 0);
        const ticket = await requestPortalAttachmentPartTicket(currentDraft.id, initialized.attachmentId, partNumber);
        if (!currentLifetime()) return;
        if (ticket.contentLength !== blob.size || ticket.contentType !== contentType) throw new Error("The upload ticket does not match this file part.");
        const etag = await uploadPortalAttachmentPart(ticket, blob, loaded => { if (currentLifetime()) updateAttachment(item.key, { uploadedBytes: priorBytes + loaded }); });
        if (!currentLifetime()) return;
        const checkpoint = await checkpointPortalAttachmentPart(currentDraft.id, initialized.attachmentId, { partNumber, etag, size: blob.size });
        if (!currentLifetime()) return;
        completed.set(partNumber, checkpoint);
        updateAttachment(item.key, { completedParts: completed.size, uploadedBytes: priorBytes + blob.size });
      }
      const result = await completePortalRequestAttachment(currentDraft.id, initialized.attachmentId, [...completed.values()]);
      if (!currentLifetime()) return;
      updateAttachment(item.key, { status: result.status, uploadedBytes: item.size });
      await pollAttachment(item.key, currentDraft.id, initialized.attachmentId);
    } catch (caught) {
      if (currentLifetime()) updateAttachment(item.key, { status: "error", error: (caught as Error).message || "Upload failed." });
    }
  }

  function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const candidates = [...files];
    const active = attachments.filter(item => !["aborted", "expired", "rejected"].includes(item.status));
    if (active.length + candidates.length > 10) { setAttachmentMessage("A request can include at most 10 files."); return; }
    if (active.reduce((sum, item) => sum + item.size, 0) + candidates.reduce((sum, file) => sum + file.size, 0) > REQUEST_ATTACHMENT_MAX_TOTAL_BYTES) {
      setAttachmentMessage("Attachments can total at most 100 MiB per request."); return;
    }
    const invalid = candidates.find(file => file.size <= 0 || file.size > REQUEST_ATTACHMENT_MAX_FILE_BYTES || !normalizedAttachmentType(file));
    if (invalid) { setAttachmentMessage(`${invalid.name} is unsupported. Use JPEG, PNG, WebP, HEIC, HEIF, or PDF files up to 25 MiB each; archives are not allowed.`); return; }
    setAttachmentMessage("");
    const items = candidates.map(file => ({ key: crypto.randomUUID(), clientUploadId: crypto.randomUUID(), file, name: file.name, size: file.size,
      status: "queued" as const, uploadedBytes: 0, completedParts: 0, totalParts: Math.ceil(file.size / (8 * 1024 * 1024)) }));
    setAttachments(current => [...current, ...items]);
    for (const item of items) void uploadAttachment(item);
  }

  async function removeAttachment(item: RequestAttachmentUi) {
    const lifetime = wizardLifetime.current;
    const currentLifetime = () => mounted.current && wizardLifetime.current === lifetime;
    if (!currentLifetime()) return;
    try {
      const currentDraft = draftRef.current;
      if (currentDraft && item.id && item.status !== "aborted") await removePortalRequestAttachment(currentDraft.id, item.id);
      if (!currentLifetime()) return;
      setAttachments(current => current.filter(candidate => candidate.key !== item.key));
    } catch (caught) { if (currentLifetime()) updateAttachment(item.key, { error: (caught as Error).message || "The file could not be removed." }); }
  }

  useEffect(() => {
    if (!dirty || saveState === "conflict") return;
    const timer = window.setTimeout(() => void persist(input, inputJson).catch(() => undefined), 700);
    return () => window.clearTimeout(timer);
  }, [inputJson, dirty, saveState]);

  const change = (setter: () => void) => { setter(); setDirty(true); setSaveState("idle"); setMessage(""); };
  const changePricingBasis = (setter: () => void) => {
    pricingHintController.current?.abort();
    pricingHintController.current = null;
    setPricingHint(null);
    change(setter);
  };
  const selectedCatalog = selectedServices.map(id => {
    const version = selectedServiceVersions[id];
    return (selectedSnapshots[id]?.sourceVersion === version ? selectedSnapshots[id] : undefined)
      ?? catalog.find(service => service.publicId === id && (!version || service.sourceVersion === version))
      ?? draftRef.current?.services.find(service => service.publicId === id && (!version || service.sourceVersion === version));
  }).filter((service): service is PortalServiceCatalogItem => Boolean(service));
  const toggleService = (service: PortalServiceCatalogItem, selected: boolean) => {
    if (selected && (selectedServices.includes(service.publicId) || selectedServices.length >= 10 || catalogState !== "ready")) return;
    changePricingBasis(() => {
    setSelectedServices(current => selected ? [...current, service.publicId] : current.filter(id => id !== service.publicId));
    setSelectedSnapshots(current => {
      const next = { ...current };
      if (selected) next[service.publicId] = service;
      else delete next[service.publicId];
      return next;
    });
    setSelectedServiceVersions(current => {
      const next = { ...current };
      if (selected) next[service.publicId] = service.sourceVersion;
      else delete next[service.publicId];
      return next;
    });
    if (!selected) setAnswers(current => {
      const next = { ...current };
      delete next[service.publicId];
      return next;
    });
    });
  };
  const useCurrentServiceVersion = (service: PortalServiceCatalogItem) => {
    changePricingBasis(() => {
      setSelectedServiceVersions(current => ({ ...current, [service.publicId]: service.sourceVersion }));
      setSelectedSnapshots(current => ({ ...current, [service.publicId]: service }));
      setAnswers(current => ({ ...current, [service.publicId]: {} }));
    });
    setMessage("The current service version is selected. Review and answer its questions before continuing.");
  };
  const serviceVersionsCurrent = catalogState === "ready" && selectedCatalog.length === selectedServices.length
    && selectedCatalog.every(service => catalog.some(current => current.publicId === service.publicId && current.sourceVersion === service.sourceVersion));
  const servicesComplete = serviceVersionsCurrent && selectedCatalog.length > 0 && selectedCatalog.every(service => service.questions.every(question => questionIsAnswered(question, answers[service.publicId]?.[question.id])));
  const geometryRequired = selectedCatalog.some(service => service.geometryRequirement === "required");
  const geometryComplete = !geometryRequired || areaGeoJson !== null;

  function goTo(next: RequestStep, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("step", next);
    window.history[replace ? "replaceState" : "pushState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
    setStepState(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function next() {
    if (step === "services" && !servicesComplete) { setMessage(!serviceVersionsCurrent && selectedServices.length ? "Review the current service library and resolve every changed or unavailable selection before continuing." : "Select at least one service and answer its required questions."); return; }
    if (step === "location" && !geometryComplete) { setMessage("Draw the required work area on the map before continuing."); return; }
    if (step === "details" && (!title.trim() || !details.trim())) { setMessage("Add a request title and description before continuing."); return; }
    if (step === "contact" && siteContactEmail && !/^\S+@\S+\.\S+$/.test(siteContactEmail)) { setMessage("Enter a valid on-site contact email or leave it blank."); return; }
    setMessage("");
    const index = REQUEST_STEPS.indexOf(step);
    if (index < REQUEST_STEPS.length - 1) goTo(REQUEST_STEPS[index + 1]!);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rejectedAttachments = attachments.some(item => item.status === "rejected");
    const expiredAttachments = attachments.some(item => item.status === "expired");
    const pendingAttachments = attachments.some(item => ["queued", "uploading", "quarantined", "scanning", "error"].includes(item.status));
    if (step !== "review" || submitting || rejectedAttachments || expiredAttachments || pendingAttachments || !servicesComplete || !geometryComplete || !title.trim() || !details.trim()) {
      if (rejectedAttachments) setMessage("Remove every rejected attachment and upload a safe replacement before submitting.");
      else if (expiredAttachments) setMessage("Remove every expired attachment and upload it again before submitting.");
      else if (pendingAttachments) setMessage("Wait for every attachment to finish its security scan before submitting.");
      else if (!servicesComplete) { setMessage("Review your selected services and their current questions before submitting."); goTo("services"); }
      else if (!geometryComplete) setMessage("Return to Work area and draw the area required by the selected service.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    const lifetime = wizardLifetime.current;
    const currentLifetime = () => mounted.current && wizardLifetime.current === lifetime;
    try {
      await persist(input, inputJson);
      if (!currentLifetime()) return;
      const current = draftRef.current;
      if (!current) throw new Error("Draft was not saved");
      const request = await submitPortalServiceDraft(current.id, current.version, crypto.randomUUID());
      if (!currentLifetime()) return;
      onSaved(request);
    } catch (caught) {
      if (!currentLifetime()) return;
      const error = caught as RequestError;
      const code = error.body?.code;
      if (error.status === 422 && code === "catalog_changed") { reloadCatalog(); goTo("services"); }
      else if (error.status === 422 && ["answers_incomplete", "request_fields_incomplete"].includes(code ?? "")) goTo(code === "request_fields_incomplete" ? "details" : "services");
      else if (error.status === 422 && code === "geometry_required") goTo("location");
      else if (error.status === 422 && ["attachments_pending", "attachments_rejected", "attachments_expired"].includes(code ?? "")) goTo("contact");
      setMessage(error.message || "The request could not be submitted.");
    } finally { if (currentLifetime()) setSubmitting(false); }
  }

  if (loadingDraft) return <div className="portal-request-draft-loading" aria-label="Loading saved request"><Loading /></div>;
  if (draftLoadFailed) return <div className="portal-request-draft-error"><EmptyState title="Saved draft unavailable" detail={message || "This draft could not be opened in the selected workspace."} />{onCancel && <button type="button" className="button-ghost" onClick={onCancel}>Back to request history</button>}</div>;

  return <form className="portal-request-form portal-request-wizard" onSubmit={submit}>
    <nav className="portal-request-stepper" aria-label="Service request progress"><ol>{REQUEST_STEPS.map((item, index) => <li key={item} className={item === step ? "is-current" : REQUEST_STEPS.indexOf(step) > index ? "is-complete" : ""}><button type="button" onClick={() => index <= REQUEST_STEPS.indexOf(step) && goTo(item)} aria-current={item === step ? "step" : undefined}><span>{index + 1}</span>{item === "services" ? "Services" : item === "location" ? "Work area" : item === "details" ? "Details" : item === "contact" ? "Contact" : "Review"}</button></li>)}</ol></nav>
    <div className="portal-autosave-status" role="status" aria-live="polite"><span className={`save-dot ${saveState}`} aria-hidden="true" />{saveState === "saving" ? "Saving draft..." : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved" : saveState === "conflict" ? "Draft conflict" : dirty ? "Changes waiting to save" : "Your progress will save automatically"}</div>
    {step === "services" && <section className="portal-wizard-panel" aria-labelledby="request-services-title"><header><span>Step 1 of 5</span><h3 id="request-services-title">What services do you need?</h3><p>Select between 1 and 10 services from the current Project Alpha service library.</p></header>
      <ServiceLibrary catalog={catalog} selected={selectedCatalog} state={catalogState} onRetry={reloadCatalog}
        complete={catalogComplete} legacy={catalogLegacy} hasMore={catalogCursor !== null} loadingMore={catalogLoadingMore} pageError={catalogPageError} onLoadMore={() => { if (catalogCursor) loadCatalogPage(catalogCursor); }}
        onSelect={service => toggleService(service, true)} onRemove={service => toggleService(service, false)} onUseCurrent={useCurrentServiceVersion}
        renderQuestions={service => service.questions.length > 0 && <div className="portal-service-questions">{service.questions.map(question =>
          <ServiceQuestionField key={question.id} serviceId={service.publicId} question={question} value={answers[service.publicId]?.[question.id]}
            onChange={value => changePricingBasis(() => setAnswers(current => ({ ...current, [service.publicId]: { ...(current[service.publicId] ?? {}), [question.id]: value } })))} />)}</div>} />
    </section>}
    {step === "location" && <section className="portal-wizard-panel" aria-labelledby="request-location-title"><header><span>Step 2 of 5</span><h3 id="request-location-title">Show us the work area</h3><p>{geometryRequired ? "One or more selected services require a drawn work area. Search, add points, or draw the area directly on the secure map." : "The selected services do not require a work area, but you may add one when it helps explain the scope."} Clients cannot upload or import KML files.</p></header><div className="portal-request-map portal-request-map-step"><MapAreaSelector value={areaGeoJson} onChange={value => changePricingBasis(() => setAreaGeoJson(value))} token={mapboxPublicToken} points={points} onPoints={value => changePricingBasis(() => setPoints(value))} locationLabel={location} onLocationLabel={value => change(() => setLocation(value))} /></div>{draft?.areaAcres != null && <div className="portal-coverage-card"><span>Estimated coverage</span><strong>{draft.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres</strong><small>Calculated by LTDS from the area drawn above.</small></div>}</section>}
    {step === "details" && <section className="portal-wizard-panel" aria-labelledby="request-details-title"><header><span>Step 3 of 5</span><h3 id="request-details-title">Scope and timing</h3><p>Describe the outcome you need. LTDS will confirm feasibility and the final scope.</p></header>{!fixedProjectId && !fixedScope && <label>Project context<select value={projectId} onChange={event => changePricingBasis(() => setProjectId(event.target.value))}><option value="">New or one-off service</option>{eligibleProjects.map(project => <option key={project.id} value={project.id}>{project.projectName}</option>)}</select></label>}<label>Service request title<input value={title} onChange={event => change(() => setTitle(event.target.value))} maxLength={160} required /></label><label>What do you need?<textarea value={details} onChange={event => change(() => setDetails(event.target.value))} maxLength={5000} rows={6} required /></label><div className="portal-form-grid"><label>Location <span>(optional)</span><input value={location} onChange={event => change(() => setLocation(event.target.value))} maxLength={240} /></label><label>Preferred start <span>(optional)</span><input type="datetime-local" value={preferredStartAt} onChange={event => change(() => setPreferredStartAt(event.target.value))} /></label><label>Desired completion <span>(optional)</span><input type="datetime-local" value={desiredCompletionAt} onChange={event => change(() => setDesiredCompletionAt(event.target.value))} /></label></div><label>Requested deliverables <span>(optional)</span><textarea value={deliverables} onChange={event => change(() => setDeliverables(event.target.value))} maxLength={2000} rows={4} /></label></section>}
    {step === "contact" && <section className="portal-wizard-panel" aria-labelledby="request-contact-title"><header><span>Step 4 of 5</span><h3 id="request-contact-title">Contact and supporting files</h3><p>Add an optional on-site contact and any authorized reference photos or PDFs.</p></header><fieldset className="portal-contact-fields"><legend>Contact details <span>(optional)</span></legend><label>Name<input value={siteContactName} onChange={event => change(() => setSiteContactName(event.target.value))} maxLength={160} /></label><label>Email<input type="email" value={siteContactEmail} onChange={event => change(() => setSiteContactEmail(event.target.value))} maxLength={320} /></label><label>Phone<input type="tel" value={siteContactPhone} onChange={event => change(() => setSiteContactPhone(event.target.value))} maxLength={64} /></label></fieldset>{attachmentsEnabled ? <div className="portal-attachment-uploader"><header><div><strong>Supporting files</strong><p>Up to 10 JPEG, PNG, WebP, HEIC, HEIF, or PDF files; 25 MiB each and 100 MiB total. Archives are not allowed.</p></div><label className="button-ghost portal-file-picker">Add files<input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" onChange={event => { addAttachments(event.target.files); event.currentTarget.value = ""; }} /></label></header>{attachmentMessage && <p role="alert" className="portal-message error">{attachmentMessage}</p>}<div className="portal-attachment-list" aria-live="polite">{attachments.map(item => <article key={item.key}><div><strong>{item.name}</strong><span>{formatBytes(item.size)} / {attachmentStatusLabel(item.status)}</span></div><progress max={item.size} value={Math.min(item.uploadedBytes, item.size)} aria-label={`${item.name} upload progress`} /><small>{item.totalParts ? `${item.completedParts} of ${item.totalParts} parts` : "Preparing upload"}</small>{item.error && <p role="alert">{item.error}</p>}<div>{item.status === "error" && <button type="button" className="button-ghost button-small" onClick={() => void uploadAttachment(item)}>Retry</button>}{item.status !== "aborted" && <button type="button" className="button-ghost button-small" onClick={() => void removeAttachment(item)}>Remove</button>}</div></article>)}</div></div> : <div className="portal-attachments-coming"><strong>Supporting files are coming soon</strong><p>Secure request attachments are not enabled for this portal. Do not place sensitive file links in the description.</p></div>}</section>}
    {step === "review" && <section className="portal-wizard-panel portal-review" aria-labelledby="request-review-title"><header><span>Step 5 of 5</span><h3 id="request-review-title">Review your request</h3><p>Double-check every section below. Nothing is submitted until you select Submit request.</p></header><div className="portal-review-grid"><article><header><h4>Services</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("services")}>Edit services</button></header><ul>{selectedCatalog.map(service => <li key={service.publicId}><strong>{service.name}</strong>{service.questions.map(question => { const value = answers[service.publicId]?.[question.id]; if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null; const labels = question.type === "select" || question.type === "multi_select" ? question.options.filter(option => (Array.isArray(value) ? value : [value]).includes(option.value)).map(option => option.label).join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : String(value); return <span key={question.id}>{question.label}: {labels}</span>; })}</li>)}</ul></article><article className="portal-review-work-area"><header><h4>Work area</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("location")}>Edit work area</button></header><p>{location || "No location label provided"}</p><p>{draft?.areaAcres != null ? `${draft.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres` : areaGeoJson ? "Coverage is being calculated" : "No polygon drawn"} / {points.length} point{points.length === 1 ? "" : "s"}</p><RequestReviewMap area={areaGeoJson} points={points} />{points.length > 0 && <ol className="portal-review-pois" aria-label="Points of interest">{points.map((point, index) => <li key={`${point.longitude}:${point.latitude}:${index}`}><span>{index + 1}</span><div><strong>{point.label || `Point ${index + 1}`}</strong><small>{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</small></div></li>)}</ol>}</article><article><header><h4>Scope and timing</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("details")}>Edit details</button></header><strong>{title || "Title required"}</strong><p>{details || "Description required"}</p><p>{projectId ? eligibleProjects.find(project => project.id === projectId)?.projectName ?? "Authorized project" : "New or one-off service"}</p><p>{deliverables || "No separate deliverables noted"}</p><dl className="portal-review-timing"><div><dt>Preferred start</dt><dd>{input.preferredStartAt ? formatDate(input.preferredStartAt) : "Not specified"}</dd></div><div><dt>Desired completion</dt><dd>{input.desiredCompletionAt ? formatDate(input.desiredCompletionAt) : "Not specified"}</dd></div></dl></article><article><header><h4>Contact</h4><button type="button" className="button-ghost button-small" onClick={() => goTo("contact")}>Edit contact</button></header><p>{siteContactName || "No on-site contact"}</p>{siteContactEmail && <p>{siteContactEmail}</p>}{siteContactPhone && <p>{siteContactPhone}</p>}</article></div><aside className="portal-pricing-hint"><span>Planning guidance</span>{pricingHint ? <>{draft?.areaAcres != null && <p className="portal-pricing-coverage">Estimated coverage: {draft.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres</p>}<strong>{pricingHint.kind === "starting_at" ? `Starting at ${formatRequestMoney(pricingHint.startingAtMinor, pricingHint.currency)}` : `Typical range ${formatRequestMoney(pricingHint.minimumMinor, pricingHint.currency)} to ${formatRequestMoney(pricingHint.maximumMinor, pricingHint.currency)}`}</strong><p>{pricingHint.disclaimer}</p></> : <><strong>Final quote after review</strong><p>A reliable price hint is not available for this request. Submitting does not authorize work or create a charge. LTDS will review the scope and create the actual estimate in Project Alpha.</p></>}</aside></section>}
    {step === "review" && <section className="portal-review-attachments" aria-labelledby="review-attachments-title"><header><h3 id="review-attachments-title">Supporting files</h3><button type="button" className="button-ghost button-small" onClick={() => goTo("contact")}>Edit files</button></header>{attachments.some(item => item.status === "rejected") && <p className="portal-attachment-recovery" role="alert">A security scan rejected one or more files. Return to Edit files, remove each rejected file, and upload a safe replacement before submitting.</p>}{attachments.some(item => item.status === "expired") && <p className="portal-attachment-recovery" role="alert">One or more uploads expired before acceptance. Return to Edit files, remove each expired file, and upload it again before submitting.</p>}{attachments.length ? <ul>{attachments.filter(item => item.status !== "aborted").map(item => <li key={item.key}><div><strong>{item.name}</strong><span>{formatBytes(item.size)}</span></div><span className={`portal-attachment-status ${item.status}`}>{attachmentStatusLabel(item.status)}</span></li>)}</ul> : <p>No supporting files were added.</p>}</section>}
    {message && <p className="portal-message error" role="alert">{message}</p>}
    <div className="portal-form-actions portal-wizard-actions">{onCancel && <button type="button" className="button-ghost" onClick={onCancel}>Cancel</button>}{step !== "services" && <button type="button" className="button-ghost" onClick={() => goTo(REQUEST_STEPS[REQUEST_STEPS.indexOf(step) - 1]!)}>Back</button>}{step === "review" ? <button key="submit-request" type="submit" className="button-orange" disabled={submitting || saveState === "conflict" || !geometryComplete || attachments.some(item => ["queued", "uploading", "quarantined", "scanning", "rejected", "expired", "error"].includes(item.status))}>{submitting ? "Submitting..." : "Submit request"}</button> : <button key="continue-request" type="button" className="button-orange" onClick={() => void next()}>Continue</button>}</div>
  </form>;
}

function ServiceRequestForm(props: Parameters<typeof NewServiceRequestWizard>[0] & { initial?: PortalServiceRequest; changeOf?: PortalServiceRequest; requestV2?: boolean; requestAvailability?: RequestAvailability; requestContextKey?: string; requestWorkspaceId?: string | null }) {
  if (props.initial || props.changeOf) return <LegacyServiceRequestForm {...props} />;
  if (!props.requestAvailability || !props.requestContextKey) return <p role="status">Checking request availability…</p>;
  return <RequestScopeBoundary key={`${props.requestContextKey}:${props.initialDraftId || "new"}:${props.projectId || "root"}`}
    contextKey={props.requestContextKey} workspaceId={props.requestWorkspaceId ?? null} availability={props.requestAvailability}
    projects={props.projects} fixedProjectId={props.projectId} draftId={props.initialDraftId}>
    {(projectId, mode) => mode === "catalog"
      ? <NewServiceRequestWizard {...props} projectId={projectId ?? undefined} fixedScope />
      : <LegacyServiceRequestForm {...props} projectId={projectId ?? undefined} fixedScope />}
  </RequestScopeBoundary>;
}

function LegacyServiceRequestForm({
  projects,
  projectId: fixedProjectId,
  initial,
  changeOf,
  onSaved,
  onCancel,
  mapboxPublicToken,
  fixedScope = false,
}: {
  projects: PortalProject[];
  projectId?: string;
  initial?: PortalServiceRequest;
  changeOf?: PortalServiceRequest;
  onSaved: (request: PortalServiceRequest) => void;
  onCancel?: () => void;
  mapboxPublicToken: string | null;
  fixedScope?: boolean;
}) {
  const eligibleProjects = projects.filter(
    (project) => project.canRequestService,
  );
  const source = initial || changeOf;
  const [projectId, setProjectId] = useState<string>(
    fixedProjectId ?? source?.projectId ?? "",
  );
  const [requestType] = useState<"flight" | "service">(
    source?.requestType ?? "service",
  );
  const [title, setTitle] = useState(
    changeOf ? `Service update: ${changeOf.title}` : (source?.title ?? ""),
  );
  const [details, setDetails] = useState(
    changeOf ? "" : (source?.details ?? ""),
  );
  const [location, setLocation] = useState(source?.location ?? "");
  const [preferredStartAt, setPreferredStartAt] = useState(
    source?.preferredStartAt?.slice(0, 16) ?? "",
  );
  const [serviceCategory, setServiceCategory] = useState(
    source?.serviceCategory ?? "",
  );
  const [deliverables, setDeliverables] = useState(source?.deliverables ?? "");
  const [siteContactName, setSiteContactName] = useState(
    source?.siteContactName ?? "",
  );
  const [siteContactEmail, setSiteContactEmail] = useState(
    source?.siteContactEmail ?? "",
  );
  const [siteContactPhone, setSiteContactPhone] = useState(
    source?.siteContactPhone ?? "",
  );
  const [desiredCompletionAt, setDesiredCompletionAt] = useState(
    source?.desiredCompletionAt?.slice(0, 16) ?? "",
  );
  const [points, setPoints] = useState<PortalPoi[]>(
    source?.poiPoints ??
      (source?.longitude != null && source.latitude != null
        ? [{ longitude: source.longitude, latitude: source.latitude }]
        : []),
  );
  const [areaGeoJson, setAreaGeoJson] = useState(source?.areaGeoJson ?? null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const mode = initial ? "edit" : changeOf ? "change" : "create";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || saved) return;
    setSubmitting(true);
    setMessage(null);
    const input: PortalServiceRequestInput = {
      projectId: projectId || null,
      parentRequestId: changeOf?.id ?? null,
      requestType,
      title,
      details,
      location: location.trim() || null,
      preferredStartAt: preferredStartAt
        ? new Date(preferredStartAt).toISOString()
        : null,
      serviceCategory: serviceCategory.trim() || null,
      deliverables: deliverables.trim() || null,
      siteContactName: siteContactName.trim() || null,
      siteContactEmail: siteContactEmail.trim() || null,
      siteContactPhone: siteContactPhone.trim() || null,
      desiredCompletionAt: desiredCompletionAt
        ? new Date(desiredCompletionAt).toISOString()
        : null,
      latitude: points[0]?.latitude ?? null,
      longitude: points[0]?.longitude ?? null,
      poiPoints: points,
      areaGeoJson,
    };
    try {
      const saved =
        mode === "edit"
          ? await updatePortalServiceRequest(
              initial!.id,
              input,
              initial!.updatedAt,
              idempotencyKey,
            )
          : mode === "change"
            ? await createPortalChangeRequest(
                changeOf!.id,
                input,
                idempotencyKey,
              )
            : await createPortalServiceRequest(input, idempotencyKey);
      onSaved(saved);
      setSaved(true);
      setMessage({
        tone: "success",
        text:
          mode === "edit"
            ? "Request updated."
            : mode === "change"
              ? "Change request submitted."
              : "Request submitted. LTDS will review it shortly.",
      });
    } catch (caught) {
      const error = caught as RequestError;
      const retry =
        error.status === 429 && error.retryAfterMs
          ? ` Try again in about ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} seconds.`
          : "";
      setMessage({
        tone: "error",
        text: `${error.message || "The request could not be saved."}${retry}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="portal-request-form" onSubmit={submit}>
      <div className="portal-request-layout">
        <div className="portal-request-map">
          <MapAreaSelector
            value={areaGeoJson}
            onChange={setAreaGeoJson}
            token={mapboxPublicToken}
            points={points}
            onPoints={setPoints}
            locationLabel={location}
            onLocationLabel={setLocation}
          />
        </div>
        <div className="portal-request-fields">
          <header className="portal-request-section-heading">
            <span>Request details</span>
            <h3>Tell us what you need</h3>
          </header>
          {!fixedProjectId && !fixedScope && (
            <label>
              Project context
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">New or one-off service</option>
                {eligibleProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.projectName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="portal-project-context">
            {projectId
              ? `Existing project: ${eligibleProjects.find((project) => project.id === projectId)?.projectName || "authorized project"}. LTDS will triage this request in that project context.`
              : "New or one-off service. LTDS will review and triage this request before any project setup."}{" "}
            This screen does not create or change a Project Alpha project.
          </p>
          <label>
            Service request title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              required
              placeholder="Spring site progress imagery"
            />
          </label>
          <label>
            What do you need?
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              maxLength={5000}
              rows={5}
              required
              placeholder={
                changeOf
                  ? "Describe exactly what should change."
                  : "Scope, goals, and any site constraints."
              }
            />
          </label>
          <header className="portal-request-section-heading portal-request-section-divider">
            <span>Planning</span>
            <h3>Schedule and deliverables</h3>
          </header>
          <div className="portal-form-grid">
            <label>
              Location <span>(optional)</span>
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={240}
              />
            </label>
            <label>
              Preferred start <span>(optional)</span>
              <input
                type="datetime-local"
                value={preferredStartAt}
                onChange={(event) => setPreferredStartAt(event.target.value)}
              />
            </label>
            <label>
              Service category <span>(optional)</span>
              <input
                value={serviceCategory}
                onChange={(event) => setServiceCategory(event.target.value)}
                maxLength={100}
                placeholder="Aerial imaging"
              />
            </label>
            <label>
              Desired completion <span>(optional)</span>
              <input
                type="datetime-local"
                value={desiredCompletionAt}
                onChange={(event) => setDesiredCompletionAt(event.target.value)}
              />
            </label>
          </div>
          <label>
            Requested deliverables <span>(optional)</span>
            <textarea
              value={deliverables}
              onChange={(event) => setDeliverables(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Photos, video, orthomosaic, inspection notes…"
            />
          </label>
          <fieldset className="portal-contact-fields">
            <legend>
              On-site contact <span>(optional)</span>
            </legend>
            <label>
              Name
              <input
                value={siteContactName}
                onChange={(event) => setSiteContactName(event.target.value)}
                maxLength={160}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={siteContactEmail}
                onChange={(event) => setSiteContactEmail(event.target.value)}
                maxLength={320}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                value={siteContactPhone}
                onChange={(event) => setSiteContactPhone(event.target.value)}
                maxLength={64}
              />
            </label>
          </fieldset>
        </div>
      </div>
      <div className="portal-form-actions">
        <p
          className={
            message?.tone === "error"
              ? "portal-message error"
              : "portal-message"
          }
          aria-live="polite"
        >
          {message?.text}
        </p>
        {onCancel && (
          <button type="button" className="button-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="button-orange" disabled={submitting || saved}>
          {submitting
            ? "Saving…"
            : saved
              ? "Submitted"
              : mode === "edit"
                ? "Save changes"
                : mode === "change"
                  ? "Submit change request"
                  : "Submit request"}
        </button>
      </div>
    </form>
  );
}

function ProjectViewerModels({ projectId, initialDisplayUnits }: { projectId: string; initialDisplayUnits: "imperial" | "metric" }) {
  const [models, setModels] = useState<PortalViewerModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [displayUnits, setDisplayUnits] = useState<"imperial" | "metric">(initialDisplayUnits || readClientViewerUnits());

  useEffect(() => {
    let active = true;
    setModels(null); setError("");
    loadPortalViewerModels(projectId)
      .then(value => { if (active) setModels(value); })
      .catch(caught => { if (active) { setModels([]); setError((caught as Error).message); } });
    return () => { active = false; };
  }, [projectId]);

  const requestSession = useCallback((associationId: string) =>
    createPortalViewerSession(projectId, associationId, crypto.randomUUID(), displayUnits), [displayUnits, projectId]);

  const open = async (model: PortalViewerModel) => {
    setBusy(true); setError("");
    try {
      await openViewerWindow({
        modelId: model.modelId,
        title: model.title,
        issueSession: () => requestSession(model.associationId),
        onStatus: (status, message) => {
          if (status === "at-risk") setError(message);
        },
      });
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (!models) return <Card title="3D models"><Loading /></Card>;
  return <Card title="3D models">
    {error && <div className="notice error" role="alert">{error}</div>}
    <label className="portal-viewer-units">Measurement units<select value={displayUnits} onChange={event => {
      const next = event.target.value as "imperial" | "metric";
      setDisplayUnits(next); writeClientViewerUnits(next);
      void updatePortalViewerUnits(next).catch(caught => setError((caught as Error).message));
    }}><option value="imperial">Imperial</option><option value="metric">Metric</option></select></label>
    {!models.length ? <EmptyState title="No 3D models available" detail="Your LTDS team has not associated a 3D model with this project." /> :
      <div className="portal-viewer-model-grid">{models.map(model => <article key={model.associationId}>
        <div><span>Interactive model</span><h3>{model.title}</h3><p>{model.provider} · secure Viewer session</p></div>
        <div className="portal-form-actions"><button type="button" className="button-orange" disabled={busy} onClick={() => void open(model)}>
          {busy ? "Opening…" : "Open 3D model in new tab"}
        </button></div>
        {model.canShare && <PortalViewerShares projectId={projectId} model={model} displayUnits={displayUnits} />}
      </article>)}</div>}
  </Card>;
}

function PortalViewerShares({
  projectId,
  model,
  displayUnits,
}: {
  projectId: string;
  model: PortalViewerModel;
  displayUnits: "imperial" | "metric";
}) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<PortalViewerShare[]>([]);
  const [label, setLabel] = useState("");
  const [lifetime, setLifetime] = useState<"7" | "30" | "source">("7");
  const [password, setPassword] = useState("");
  const [createdUrl, setCreatedUrl] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try { setShares(await loadPortalViewerShares(projectId, model.associationId)); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }, [model.associationId, projectId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) { setPassword(""); setCreatedUrl(""); setCopyStatus(""); }
    if (next) void refresh();
  };

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setCreatedUrl(""); setCopyStatus("");
    const expiresAt = lifetime === "source" ? null : new Date(Date.now() + Number(lifetime) * 24 * 60 * 60 * 1000).toISOString();
    try {
      const result = await createPortalViewerShare(projectId, model.associationId, {
        label: label.trim() || null,
        expiresAt,
        ...(password ? { password } : {}),
        displayUnits,
      }, crypto.randomUUID());
      setCreatedUrl(result.viewUrl); setLabel(""); setPassword("");
      await refresh();
    } catch (caught) { setError((caught as Error).message); setBusy(false); }
  };

  const revoke = async (shareId: string) => {
    setBusy(true); setError("");
    try { await revokePortalViewerShare(projectId, model.associationId, shareId, crypto.randomUUID()); await refresh(); }
    catch (caught) { setError((caught as Error).message); setBusy(false); }
  };

  const now = Date.now();
  const activeShares = shares.filter(share => !share.revokedAt &&
    (share.expiresAt === null || Date.parse(share.expiresAt) > now) &&
    (share.sourceAuthorization?.expiresAt === null || share.sourceAuthorization?.expiresAt === undefined ||
      Date.parse(share.sourceAuthorization.expiresAt) > now));

  return <section className="portal-viewer-shares">
    <button type="button" className="button-ghost" aria-expanded={open} onClick={toggle}>Share public link</button>
    {open && <div>
      <p className="muted">Only this published model is shared. Source photos and processing files stay private.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {createdUrl && <div className="notice" role="status"><strong>Copy this link now.</strong><input readOnly value={createdUrl} aria-label="New public 3D model link" /><button type="button" className="button-ghost" onClick={() => {
        void navigator.clipboard.writeText(createdUrl).then(() => setCopyStatus("Link copied."), () => setCopyStatus("Copy failed. Select and copy the link manually."));
      }}>Copy</button>{copyStatus && <span>{copyStatus}</span>}</div>}
      <form onSubmit={event => void create(event)}>
        <label>Link label<input value={label} maxLength={120} onChange={event => setLabel(event.target.value)} placeholder="Optional" /></label>
        <label>Link lifetime<select value={lifetime} onChange={event => setLifetime(event.target.value as "7" | "30" | "source")}>
          <option value="7">7 days</option><option value="30">30 days</option><option value="source">Until source access ends</option>
        </select></label>
        <label>Access code<input type="password" autoComplete="new-password" value={password} minLength={8} maxLength={128} onChange={event => setPassword(event.target.value)} placeholder="Optional, 8+ characters" /></label>
        <button type="submit" className="button-orange" disabled={busy}>{busy ? "Creating…" : "Create link"}</button>
      </form>
      <h4>Your active links</h4>
      {!activeShares.length ? <p className="muted">No active links.</p> : <ul>{activeShares.map(share => <li key={share.id}>
        <span>{share.label || "3D model link"} · {share.expiresAt ? `expires ${new Date(share.expiresAt).toLocaleDateString()}` : "no fixed expiry"}</span>
        <button type="button" className="button-ghost" disabled={busy} onClick={() => void revoke(share.id)}>Revoke</button>
      </li>)}</ul>}
    </div>}
  </section>;
}

function ProjectWorkspace({
  project,
  requests,
  mapboxPublicToken,
  requestV2,
  requestAttachments,
  requestAvailability,
  requestContextKey,
  requestWorkspaceId,
  feedback,
  viewer,
  viewerDisplayUnits,
  onSaved,
  onBack,
}: {
  project: PortalProject;
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
  requestV2: boolean;
  requestAttachments: boolean;
  requestAvailability: RequestAvailability;
  requestContextKey: string;
  requestWorkspaceId: string | null;
  feedback: boolean;
  viewer: boolean;
  viewerDisplayUnits: "imperial" | "metric";
  onSaved: (request: PortalServiceRequest) => void;
  onBack: () => void;
}) {
  const readLocation = () => {
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get("tab");
    const nextTab: WorkspaceTab = requestedTab === "files" || requestedTab === "requests" ||
      (requestedTab === "models" && viewer) ? requestedTab : "overview";
    const candidateFolder = nextTab === "files" ? params.get("folder") : null;
    return { tab: nextTab, folderId: candidateFolder && candidateFolder.length <= 4096 ? candidateFolder : null };
  };
  const initialLocation = readLocation();
  const [tab, setTab] = useState<WorkspaceTab>(initialLocation.tab);
  const [folderId, setFolderId] = useState<string | null>(initialLocation.folderId);
  const projectRequests = requests.filter(
    (request) => request.projectId === project.id,
  );
  const loadFiles = useMemo(
    () => (nextFolderId: string | null, cursor: string | null, signal: AbortSignal) =>
      loadPortalProjectFolderFiles(project.id, nextFolderId, cursor, signal),
    [project.id],
  );
  const loadLocations = useMemo(
    () => () => loadPortalProjectFileLocations(project.id),
    [project.id],
  );
  useEffect(() => {
    const updateFromLocation = () => {
      const next = readLocation();
      setTab(next.tab);
      setFolderId(next.folderId);
    };
    updateFromLocation();
    window.addEventListener("popstate", updateFromLocation);
    return () => window.removeEventListener("popstate", updateFromLocation);
  }, [project.id, viewer]);
  const navigateTab = (nextTab: WorkspaceTab) => {
    const url = new URL(clientProjectPath(project.id), window.location.origin);
    if (nextTab !== "overview") url.searchParams.set("tab", nextTab);
    window.history.pushState({}, "", withPortalWorkspace(`${url.pathname}${url.search}`));
    setTab(nextTab);
    setFolderId(null);
  };
  const navigateFolder = (nextFolderId: string | null) => {
    const url = new URL(clientProjectPath(project.id), window.location.origin);
    url.searchParams.set("tab", "files");
    if (nextFolderId) url.searchParams.set("folder", nextFolderId);
    window.history.pushState({}, "", withPortalWorkspace(`${url.pathname}${url.search}`));
    setTab("files");
    setFolderId(nextFolderId);
  };
  return (
    <>
      <button className="portal-back" onClick={onBack}>
        ← All projects
      </button>
      <section className="portal-project-hero">
        <div>
          <span className="portal-project-ref">{project.externalRef}</span>
          <h1>{project.projectName}</h1>
          <p>{project.clientName}</p>
        </div>
        <StatusPill tone="success">
          {projectStatusLabel(project.status)}
        </StatusPill>
      </section>
      {feedback && <LeaveFeedback key={project.id} target={{ kind: "project", projectId: project.id }} label={project.projectName} />}
      <nav className="portal-workspace-tabs" aria-label="Project workspace">
        {(["overview", "files", ...(viewer ? ["models" as const] : []), "requests"] as WorkspaceTab[]).map((item) => (
          <button
            key={item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => navigateTab(item)}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <div className="portal-overview-grid">
          <Card title="Project overview">
            <p className="portal-summary">
              {project.summary ||
                "Your LTDS team will add a project summary as work progresses."}
            </p>
            <dl className="portal-detail-list">
              <div>
                <dt>Next milestone</dt>
                <dd>{project.nextMilestone || "To be scheduled"}</dd>
              </div>
              <div>
                <dt>Last update</dt>
                <dd>{formatDate(project.lastUpdateAt)}</dd>
              </div>
              <div>
                <dt>Service address</dt>
                <dd>
                  {project.serviceAddress ||
                    project.siteAddress ||
                    "Not provided"}
                </dd>
              </div>
            </dl>
          </Card>
          <Card title="Project contact">
            <dl className="portal-detail-list">
              <div>
                <dt>Name</dt>
                <dd>{project.projectContactName || "LTDS Operations"}</dd>
              </div>
              {project.projectContactEmail && (
                <div>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${project.projectContactEmail}`}>
                      {project.projectContactEmail}
                    </a>
                  </dd>
                </div>
              )}
              {project.projectContactPhone && (
                <div>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${project.projectContactPhone}`}>
                      {project.projectContactPhone}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </Card>
          <Card title="Recent requests" className="portal-overview-wide">
            <RequestList
              requests={projectRequests}
              projects={[project]}
              limit={3}
            />
          </Card>
        </div>
      )}
      {tab === "files" && (
        <Card title="Project files">
          <FileBrowser
            key={requestContextKey}
            feedback={feedback}
            projectId={project.id}
            workspaceId={requestWorkspaceId}
            load={loadFiles}
            loadLocations={loadLocations}
            folderId={folderId}
            onFolderChange={navigateFolder}
            mapToken={mapboxPublicToken}
            locationScopeLabel="this project's available files"
            emptyTitle="No project files yet"
            emptyDetail="Deliverables will appear here when your LTDS team publishes them."
          />
        </Card>
      )}
      {tab === "models" && viewer && <ProjectViewerModels projectId={project.id} initialDisplayUnits={viewerDisplayUnits} />}
      {tab === "requests" && (
        <>
          <Card title="Request additional service" className="portal-request-card">
            <ServiceRequestForm
              projects={[project]}
              projectId={project.id}
              onSaved={onSaved}
              mapboxPublicToken={mapboxPublicToken}
              requestV2={requestV2}
              attachmentsEnabled={requestAttachments}
              requestAvailability={requestAvailability}
              requestContextKey={requestContextKey}
              requestWorkspaceId={requestWorkspaceId}
            />
          </Card>
          <Card title="Project request history">
            <RequestList requests={projectRequests} projects={[project]} />
          </Card>
        </>
      )}
    </>
  );
}

function DelegatedSharePanel({ workspaceId }: { workspaceId: string }) {
  const [targets, setTargets] = useState<PortalDelegatedShareTarget[]>([]);
  const [shares, setShares] = useState<PortalDelegatedShare[]>([]);
  const [selected, setSelected] = useState("");
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [created, setCreated] = useState<PortalDelegatedShareCreated | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => {
    setBusy(true); setError("");
    try {
      const [nextTargets, nextShares] = await Promise.all([
        loadPortalDelegatedShareTargets(workspaceId), loadPortalDelegatedShares(workspaceId),
      ]);
      setTargets(nextTargets); setShares(nextShares);
      setSelected(current => nextTargets.some(target => `${target.delegationId}:${target.folderTargetId}` === current)
        ? current : nextTargets[0] ? `${nextTargets[0].delegationId}:${nextTargets[0].folderTargetId}` : "");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => { void refresh(); }, [workspaceId]);
  const target = targets.find(candidate => `${candidate.delegationId}:${candidate.folderTargetId}` === selected) ?? null;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true); setError(""); setCreated(null);
    try {
      const expiration = new Date(expiresAt);
      if (!Number.isFinite(expiration.getTime())) throw new Error("Choose a valid expiration date and time.");
      const maximum = Math.min(
        Date.now() + target.maximumLinkLifetimeSeconds * 1000,
        Date.parse(target.delegationExpiresAt),
      );
      if (expiration.getTime() > maximum) throw new Error("That expiration exceeds the approved sharing policy.");
      const result = await createPortalDelegatedShare(workspaceId, {
        delegationId: target.delegationId, folderTargetId: target.folderTargetId,
        label: label.trim() || null, expiresAt: expiration.toISOString(),
        ...(accessCode.trim() ? { accessCode: accessCode.trim() } : {}),
      });
      setCreated(result); setAccessCode("");
      setShares(await loadPortalDelegatedShares(workspaceId));
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  return <Card title="Client-created public links" className="portal-delegated-share-card">
    <p className="portal-copy">Create a separate client link only for a folder LTDS approved. Links never expand when a folder or account changes.</p>
    {error && <p className="portal-message" role="alert">{error}</p>}
    {created && <div className="portal-share-created" role="status">
      <strong>Link created — copy it now</strong>
      <p>The private fragment is shown only in this response. It is not available from link history.</p>
      <div><input readOnly aria-label="New client public link" value={created.shareUrl} /><button type="button" className="button-ghost button-small" onClick={() => void navigator.clipboard.writeText(created.shareUrl)}>Copy</button></div>
    </div>}
    {targets.length > 0 ? <form className="portal-delegated-share-form" onSubmit={create}>
      <label>Approved folder<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        {targets.map(option => <option key={`${option.delegationId}:${option.folderTargetId}`} value={`${option.delegationId}:${option.folderTargetId}`}>{option.displayName}</option>)}
      </select></label>
      <label>Link label (optional)<input maxLength={160} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
      <label>Expires<input type="datetime-local" required value={expiresAt} disabled={busy} onChange={event => setExpiresAt(event.target.value)} /></label>
      <label>Access code {target?.requirePassword ? "(required)" : "(optional)"}<input type="password" minLength={8} maxLength={128} required={target?.requirePassword === true} value={accessCode} disabled={busy} autoComplete="new-password" onChange={event => setAccessCode(event.target.value)} /></label>
      <small>Maximum lifetime: {Math.floor((target?.maximumLinkLifetimeSeconds ?? 0) / 86400)} day(s). The link stops immediately if LTDS or your workspace manager access is revoked.</small>
      <button className="button-orange" disabled={busy || !target}>{busy ? "Creating…" : "Create public link"}</button>
    </form> : !busy && <p className="portal-copy">No folders are currently approved for client-created links.</p>}
    <section className="portal-delegated-share-history"><h3>Link history</h3>
      {busy && !shares.length ? <Loading /> : shares.length ? shares.map(share => <div className="portal-team-row" key={share.id}>
        <span><strong>{share.label || "Client public link"}</strong><small>{share.status} · Expires {formatDate(share.expiresAt)}</small></span>
        {share.status === "active" && <button type="button" className="button-ghost button-small" disabled={busy} onClick={async () => {
          if (!window.confirm("Revoke this public link? Anyone using it will immediately lose access.")) return;
          setBusy(true); setError("");
          try { await revokePortalDelegatedShare(workspaceId, share.id); setShares(await loadPortalDelegatedShares(workspaceId)); }
          catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
        }}>Revoke</button>}
      </div>) : <p className="portal-copy">No client-created links yet.</p>}
    </section>
  </Card>;
}

const invitationScopeTypes = new Set<PortalWorkspaceEntry["type"]>(["organization", "department", "client", "project"]);

function hierarchyScopeLabel(type: PortalHierarchyScopeType | "workspace"): string {
  if (type === "workspace") return "Workspace-wide";
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} access`;
}

function hierarchyBrowserRows(entries: PortalWorkspaceEntry[]): Array<{ entry: PortalWorkspaceEntry & { type: PortalHierarchyScopeType }; depth: number }> {
  const visible = entries.filter((entry): entry is PortalWorkspaceEntry & { type: PortalHierarchyScopeType } => invitationScopeTypes.has(entry.type));
  const byId = new Map(visible.map(entry => [entry.publicId, entry]));
  const children = new Map<string | null, typeof visible>();
  for (const entry of visible) {
    const parent = entry.parentPublicId && byId.has(entry.parentPublicId) ? entry.parentPublicId : null;
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.displayName.localeCompare(right.displayName));
  const rows: Array<{ entry: (typeof visible)[number]; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (entry: (typeof visible)[number], depth: number) => {
    if (visited.has(entry.publicId)) return;
    visited.add(entry.publicId);
    rows.push({ entry, depth: Math.min(depth, 8) });
    for (const child of children.get(entry.publicId) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  for (const entry of visible) visit(entry, 0);
  return rows;
}

function WorkspaceTeamPanel({ invitationEmailDelivery, hierarchyScopedInvitations, initialWorkspaceId }: { invitationEmailDelivery: boolean; hierarchyScopedInvitations: boolean; initialWorkspaceId: string | null }) {
  const [workspaces, setWorkspaces] = useState<PortalWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [hierarchy, setHierarchy] = useState<PortalWorkspaceEntry[]>([]);
  const [members, setMembers] = useState<PortalWorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<PortalWorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [selectedScope, setSelectedScope] = useState<{ type: PortalHierarchyScopeType; publicId: string } | null>(null);
  const [scopeSearch, setScopeSearch] = useState("");
  const [organizationWide, setOrganizationWide] = useState(false);
  const [wideConfirmed, setWideConfirmed] = useState(false);
  const [canRequest, setCanRequest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [ready, setReady] = useState(false), [message, setMessage] = useState("");
  const [policy, setPolicy] = useState<PortalWorkspaceAccess["invitationPolicy"] | null>(null), [accessOptions, setAccessOptions] = useState<PortalWorkspaceAccess["projectAccessOptions"]>([]);
  const [termsSupported, setTermsSupported] = useState(false);
  const [accessMode, setAccessMode] = useState<PortalProjectAccessTermsInput["mode"] | "">(""), [accessExpires, setAccessExpires] = useState("");
  const [reviewed, setReviewed] = useState<PortalWorkspaceInvitationInput | null>(null), [uncertain, setUncertain] = useState(false);
  const lifetime = useRef(0), readController = useRef<AbortController | null>(null), mutationController = useRef<AbortController | null>(null), mutationBusy = useRef(false);
  const pendingInvite = useRef<{workspaceId: string; input: PortalWorkspaceInvitationInput; key: string} | null>(null);
  const clearReview = () => { setReviewed(null); setMessage(""); setError(""); };
  const clearProtected = () => { setReady(false); setPolicy(null); setTermsSupported(false); setHierarchy([]); setMembers([]); setInvitations([]); setAccessOptions([]); setSelectedScope(null); setReviewed(null); };
  const invitationError = (caught: unknown) => {
    const value = caught as RequestError, bodyCode = value.body?.code ?? (typeof value.body?.error === "object" ? value.body.error.code : value.body?.error), code = bodyCode || value.message;
    if (code === "invitation_approval_required") return "Staff approval is required before invitations can be issued. Contact LTDS; this page cannot approve access.";
    if (code === "invitation_policy_disabled") return "Invitations are disabled by this organization's policy. No invitation was issued.";
    if (code === "project_access_delegation_exceeds_authority" || code === "Requested access exceeds your delegation authority") return "These access terms exceed the access you can delegate. Choose a shorter duration or contact LTDS.";
    if (code === "project_access_completion_unavailable") return "Verified project completion is no longer available. Refresh team access and choose a specific date or until revoked.";
    if (code === "project_access_expiry_elapsed") return "This access duration has already ended. Refresh team access and review a new duration.";
    if (code === "project_access_terms_unavailable") return "Reviewed access terms are unavailable until the database update is ready. Refresh team access before trying again.";
    return value.message || "Access could not be loaded. Try again.";
  };

  const refreshAccess = async (id: string) => {
    readController.current?.abort(); const controller = new AbortController(), generation = lifetime.current; readController.current = controller;
    setLoading(true); clearProtected();
    try {
    const [entries, access] = await Promise.all([loadPortalWorkspaceHierarchy(id, undefined, controller.signal), loadPortalWorkspaceAccess(id, undefined, controller.signal)]);
    if (controller.signal.aborted || generation !== lifetime.current) return;
    if (!Array.isArray(entries) || !Array.isArray(access.members) || !Array.isArray(access.invitations) || !access.invitationPolicy || !["allowed", "disabled", "require_approval"].includes(access.invitationPolicy.mode) || !Number.isSafeInteger(access.invitationPolicy.version) || typeof access.projectAccessTermsSupported !== "boolean" || !Array.isArray(access.projectAccessOptions) || access.projectAccessOptions.some(option => typeof option.projectPublicId !== "string" || typeof option.projectEndSupported !== "boolean")) throw new Error("Invitation settings could not be verified. Refresh team access before continuing.");
    const availableScopes = entries.filter((entry): entry is PortalWorkspaceEntry & { type: PortalHierarchyScopeType } =>
      invitationScopeTypes.has(entry.type) && (entry.type === "project" || hierarchyScopedInvitations));
    setHierarchy(entries);
    const fallback = availableScopes.find(scope => scope.type === "project") ?? availableScopes[0];
    setSelectedScope(fallback ? { type: fallback.type, publicId: fallback.publicId } : null);
    setAccessMode(fallback?.type === "project" && access.projectAccessOptions.some(option => option.projectPublicId === fallback.publicId && option.projectEndSupported) ? "project_end" : ""); setAccessExpires("");
    setMembers(access.members);
    setInvitations(access.invitations);
    setPolicy(access.invitationPolicy); setTermsSupported(access.projectAccessTermsSupported); setAccessOptions(access.projectAccessOptions); setReady(true);
    if (pendingInvite.current?.workspaceId === id) setReviewed(pendingInvite.current.input);
    } catch (caught) { if (!controller.signal.aborted && generation === lifetime.current) { clearProtected(); setError(invitationError(caught)); } }
    finally { if (!controller.signal.aborted && generation === lifetime.current) setLoading(false); }
  };

  useEffect(() => {
    const generation = ++lifetime.current, controller = new AbortController();
    loadPortalWorkspaces(undefined, controller.signal).then(async allValues => {
      if (controller.signal.aborted || generation !== lifetime.current) return;
      const values = allValues.filter(value => value.resourceMode !== "native"); setWorkspaces(values);
      const first = values.find(value => value.id === initialWorkspaceId)?.id ?? values[0]?.id ?? "";
      setWorkspaceId(first);
      if (first) await refreshAccess(first); else { setLoading(false); setError("No workspace with team management is available."); }
    }).catch(caught => { if (!controller.signal.aborted && generation === lifetime.current) { setLoading(false); setError(invitationError(caught)); } });
    return () => { lifetime.current++; controller.abort(); readController.current?.abort(); mutationController.current?.abort(); };
  }, []);

  const selectWorkspace = async (id: string) => {
    if (mutationBusy.current || uncertain) return;
    lifetime.current++; readController.current?.abort(); setWorkspaceId(id); setError(""); setEmail(""); setOrganizationWide(false); setWideConfirmed(false); setCanRequest(false); clearReview(); await refreshAccess(id);
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!invitationEmailDelivery || !ready || policy?.mode !== "allowed" || !workspaceId || busy || uncertain || (!organizationWide && !selectedScope)) return;
    const confirmationRequired = organizationWide || selectedScope?.type === "organization";
    if (confirmationRequired && !wideConfirmed) return;
    let accessTerms: PortalProjectAccessTermsInput | undefined;
    if (!organizationWide && selectedScope?.type === "project") {
      if (!termsSupported) { setError("Reviewed project access terms are not available yet. Refresh team access after the database update."); return; }
      if (!accessMode || accessMode === "project_end" && !accessOptions.some(option => option.projectPublicId === selectedScope.publicId && option.projectEndSupported)) { setError("Choose an available access duration for this project."); return; }
      const date = accessMode === "specific_date" ? new Date(accessExpires) : null;
      if (date && (!Number.isFinite(date.valueOf()) || date.valueOf() <= Date.now())) { setError("Choose a valid future date for collaborator access."); return; }
      accessTerms = {kind: "collaborator", mode: accessMode, expiresAt: date?.toISOString() ?? null};
    }
    setError(""); setReviewed({
        email: email.trim(),
        ...(organizationWide
          ? { organizationWide: true, confirmOrganizationWide: true }
          : hierarchyScopedInvitations
            ? { targetScope: selectedScope!, ...(selectedScope!.type === "organization" ? { confirmOrganizationWide: true } : {}) }
            : { projectPublicId: selectedScope!.publicId }),
        capabilities: canRequest ? ["delivery.view", "request.create"] : ["delivery.view"],
        ...(accessTerms ? {accessTerms} : {}),
    });
  };
  const sendInvitation = async () => {
    if (mutationBusy.current || !ready || policy?.mode !== "allowed" || !invitationEmailDelivery) return;
    const operation = pendingInvite.current ?? (reviewed ? {workspaceId, input: reviewed, key: crypto.randomUUID()} : null);
    if (!operation || operation.workspaceId !== workspaceId) return;
    if (operation.input.accessTerms && !termsSupported) return;
    pendingInvite.current = operation; mutationBusy.current = true; readController.current?.abort(); const controller = new AbortController(), generation = lifetime.current; mutationController.current = controller;
    setBusy(true); setError(""); setUncertain(false);
    try {
      await invitePortalWorkspaceMember(operation.workspaceId, operation.input, undefined, {idempotencyKey: operation.key, signal: controller.signal});
      if (controller.signal.aborted || generation !== lifetime.current) return;
      pendingInvite.current = null; setReviewed(null); setEmail(""); setOrganizationWide(false); setWideConfirmed(false); setCanRequest(false); setMessage("Invitation issued. The sign-in link lasts seven days; access follows the reviewed terms."); await refreshAccess(operation.workspaceId);
    } catch (caught) {
      if (controller.signal.aborted || generation !== lifetime.current) return;
      const status = (caught as RequestError).status;
      if (status && [401, 403, 404, 409].includes(status)) { pendingInvite.current = null; clearProtected(); setError(invitationError(caught)); }
      else if (status && status < 500 && status !== 429) { pendingInvite.current = null; setReviewed(null); setError(invitationError(caught)); }
      else { setUncertain(true); setError("The invitation result is not confirmed. Retry the same invitation safely before making another change."); }
    } finally { mutationBusy.current = false; if (!controller.signal.aborted && generation === lifetime.current) setBusy(false); }
  };
  const removeAccess = async (kind: "member" | "invitation", id: string) => {
    if (mutationBusy.current || uncertain || !ready) return;
    mutationBusy.current = true; readController.current?.abort(); const controller = new AbortController(), generation = lifetime.current; mutationController.current = controller; setBusy(true); setError(""); setReviewed(null);
    try {
      if (kind === "member") await suspendPortalWorkspaceMember(workspaceId, id, undefined, controller.signal); else await revokePortalWorkspaceInvitation(workspaceId, id, undefined, controller.signal);
      if (!controller.signal.aborted && generation === lifetime.current) await refreshAccess(workspaceId);
    } catch (caught) { if (!controller.signal.aborted && generation === lifetime.current) { if ([401, 403, 404, 409].includes((caught as RequestError).status ?? 0)) clearProtected(); setError(invitationError(caught)); } }
    finally { mutationBusy.current = false; if (!controller.signal.aborted && generation === lifetime.current) setBusy(false); }
  };

  const rows = hierarchyBrowserRows(hierarchy);
  const normalizedSearch = scopeSearch.trim().toLocaleLowerCase();
  const filteredRows = normalizedSearch
    ? rows.filter(({ entry }) => `${entry.displayName} ${entry.type}`.toLocaleLowerCase().includes(normalizedSearch))
    : rows;
  const selectedEntry = selectedScope
    ? hierarchy.find(entry => entry.type === selectedScope.type && entry.publicId === selectedScope.publicId)
    : null;
  const broadConfirmationRequired = organizationWide || (!organizationWide && selectedScope?.type === "organization");
  const currentWorkspace = workspaces.find(workspace => workspace.id === workspaceId);
  const workspaceWideLabel = currentWorkspace?.rootType === "organization"
    ? "Give access across this entire organization workspace"
    : "Give access across this entire client workspace";
  const formDisabled = !invitationEmailDelivery || !ready || policy?.mode !== "allowed" || busy || uncertain;
  const projectScope = !organizationWide && selectedScope?.type === "project";
  const projectEndSupported = projectScope && accessOptions.some(option => option.projectPublicId === selectedScope?.publicId && option.projectEndSupported);
  const termDescription = (terms: PortalProjectAccessTermsInput | undefined | null) => !terms ? "Existing access — unclassified" : terms.kind === "customer" ? "Customer — until revoked" : terms.mode === "project_end" ? "Collaborator — project completion + 7 days" : terms.mode === "specific_date" ? `Collaborator — until ${formatDate(terms.expiresAt!)}` : "Collaborator — until revoked";
  const reviewedScope = reviewed?.targetScope ?? (reviewed?.projectPublicId ? {type: "project", publicId: reviewed.projectPublicId} : null);
  const reviewedScopeName = reviewed?.organizationWide ? currentWorkspace?.displayName : reviewedScope ? hierarchy.find(entry => entry.type === reviewedScope.type && entry.publicId === reviewedScope.publicId)?.displayName : null;

  return <div className="portal-team-panel">
    {workspaces.length > 1 && <label>Manage team workspace<select value={workspaceId} onChange={event => void selectWorkspace(event.target.value)} disabled={busy || uncertain}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.displayName}</option>)}</select></label>}
    {loading && <Loading />}
    {workspaceId && <button className="button-ghost" disabled={busy || loading} onClick={() => { setError(""); void refreshAccess(workspaceId); }}>Refresh team access</button>}
    {policy?.mode === "disabled" && <p className="portal-info-notice" role="status">Invitations are disabled by this organization's policy. Existing access can still be reviewed.</p>}
    {policy?.mode === "require_approval" && <p className="portal-info-notice" role="status">Staff approval is required before invitations can be issued. Contact LTDS; this page cannot approve access.</p>}
    {error && <p className="portal-form-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {uncertain && <button className="button-primary" disabled={busy || loading || !ready || policy?.mode !== "allowed" || !!pendingInvite.current?.input.accessTerms && !termsSupported} onClick={() => void sendInvitation()}>Retry same invitation</button>}
    <form onSubmit={invite} className="portal-team-invite-form">
      <h3>Invite a collaborator</h3>
      {!invitationEmailDelivery && <div className="portal-info-notice" role="status"><strong>Invitation email is not active yet.</strong><p>Existing access can be reviewed and revoked, but a new invitation cannot be created until LTDS finishes the email and sign-in rollout.</p></div>}
      <p className="portal-copy">Access defaults to one project. Invitees authenticate with the exact email address below.</p>
      <label>Email address<input type="email" required maxLength={320} disabled={formDisabled} value={email} onChange={event => { setEmail(event.target.value); clearReview(); }} /></label>
      <fieldset className="portal-hierarchy-picker" disabled={formDisabled || organizationWide}>
        <legend>Invitation scope</legend>
        <p className="portal-copy">Choose one authorized organization, department, client, or project. Project access is selected by default.</p>
        <label>Find a scope<input type="search" value={scopeSearch} onChange={event => setScopeSearch(event.target.value)} placeholder="Search the client hierarchy" /></label>
        <div className="portal-hierarchy-tree" role="radiogroup" aria-label="Client hierarchy">
          {filteredRows.map(({ entry, depth }) => {
            const selectable = entry.type === "project" || hierarchyScopedInvitations;
            const selected = selectedScope?.type === entry.type && selectedScope.publicId === entry.publicId;
            return <label className={`portal-hierarchy-treeitem${selected ? " is-selected" : ""}`} style={{ paddingInlineStart: `${0.75 + depth * 0.9}rem` }} key={`${entry.type}:${entry.publicId}`}>
              <input type="radio" name="invitation-scope" value={`${entry.type}:${entry.publicId}`} disabled={!selectable} checked={selected} onChange={() => { setSelectedScope({ type: entry.type, publicId: entry.publicId }); setWideConfirmed(false); setAccessMode(entry.type === "project" && accessOptions.some(option => option.projectPublicId === entry.publicId && option.projectEndSupported) ? "project_end" : ""); setAccessExpires(""); clearReview(); }} />
              <span className="portal-hierarchy-entry"><strong>{entry.displayName}</strong><small>{hierarchyScopeLabel(entry.type)}</small></span>
                <span className="portal-scope-state">{selected ? "Selected" : selectable ? "Choose" : "View only"}</span>
            </label>;
          })}
          {filteredRows.length === 0 && <p className="portal-copy">No matching invitation scopes.</p>}
        </div>
        {!hierarchyScopedInvitations && <small className="portal-hierarchy-note">Department, client, and organization invitation scopes will become selectable when hierarchy delegation is enabled. Projects remain available.</small>}
      </fieldset>
      {selectedEntry && !organizationWide && <p className="portal-selected-scope" role="status"><strong>Selected:</strong> {selectedEntry.displayName} ({selectedEntry.type})</p>}
      {projectScope && ready && !termsSupported && <p className="portal-info-notice" role="status">Reviewed project access terms are not available yet. New project invitations are unavailable until the database update is ready.</p>}
      {projectScope && <><label>Collaborator access duration<select disabled={formDisabled} value={accessMode} onChange={event => { setAccessMode(event.target.value as PortalProjectAccessTermsInput["mode"] | ""); setAccessExpires(""); clearReview(); }}><option value="">Choose access duration</option><option value="project_end" disabled={!projectEndSupported}>Project completion + 7 days</option><option value="specific_date">Specific date</option><option value="until_revoked">Until revoked</option></select></label>{!projectEndSupported && <p className="portal-copy">Verified project completion is not available. Choose a specific date or until revoked.</p>}{accessMode === "specific_date" && <label>Collaborator access expires<input type="datetime-local" required disabled={formDisabled} value={accessExpires} onChange={event => { setAccessExpires(event.target.value); clearReview(); }} /></label>}{accessMode === "project_end" && <p className="portal-copy">Access ends seven days after the first verified project completion. Reopening does not renew expired access.</p>}{accessMode === "until_revoked" && <p className="portal-copy">Access does not end automatically when the project completes. It remains until revoked.</p>}</>}
      <p className="portal-copy">The invitation sign-in link expires after seven days. That is separate from how long accepted access lasts.</p>
      <label className="portal-check"><input type="checkbox" disabled={formDisabled} checked={canRequest} onChange={event => { setCanRequest(event.target.checked); clearReview(); }} /> Allow this person to submit service requests for the selected scope</label>
      <label className="portal-check portal-wide-access"><input type="checkbox" disabled={formDisabled} checked={organizationWide} onChange={event => { setOrganizationWide(event.target.checked); setWideConfirmed(false); clearReview(); }} /> {workspaceWideLabel}</label>
      {broadConfirmationRequired && <div className="portal-danger-disclosure" role="alert"><strong>Broader access</strong><p>This person will be able to see current and future projects across {organizationWide ? "the workspace" : "this organization"}.</p><label className="portal-check"><input type="checkbox" required disabled={formDisabled} checked={wideConfirmed} onChange={event => { setWideConfirmed(event.target.checked); clearReview(); }} /> I understand and want to grant {organizationWide ? "workspace-wide" : "organization-wide"} access.</label></div>}
      {!reviewed && <button className="button-primary" disabled={formDisabled || (!organizationWide && !selectedScope) || (broadConfirmationRequired && !wideConfirmed) || projectScope && (!accessMode || !termsSupported)}>Review invitation</button>}
      {reviewed && <section className="portal-info-notice" aria-label="Review collaborator invitation"><h4>Review invitation</h4><p><strong>{reviewed.email}</strong> · {reviewedScopeName || "Selected authorized scope"}</p><p>{reviewed.accessTerms ? termDescription(reviewed.accessTerms) : "Selected hierarchy scope — existing access rules apply"}</p>{reviewed.accessTerms?.mode === "project_end" && <p>Reopening does not renew expired access.</p>}<p>Invitation link: seven days. Access duration is separate.</p><div className="actions"><button type="button" className="button-primary" disabled={formDisabled} onClick={() => void sendInvitation()}>{busy ? "Saving..." : "Send invitation"}</button><button type="button" className="button-ghost" disabled={busy || uncertain} onClick={() => setReviewed(null)}>Cancel review</button></div></section>}
    </form>
    <div className="portal-team-lists">
      <section><h3>People</h3>{members.map(member => <div className="portal-team-row" key={member.identityId}><span><strong>{member.email ?? "Verified portal user"}</strong><small>{member.manager ? "Manager" : "Member"} · {member.status}</small></span>{member.status === "active" && <button className="button-ghost button-small" disabled={busy || uncertain || !ready} onClick={() => void removeAccess("member", member.identityId)}>Suspend</button>}</div>)}</section>
      <section><h3>Invitations</h3>{ready && invitations.length === 0 ? <p className="portal-copy">No invitations yet.</p> : invitations.map(invitation => {
        const scopedEntry = invitation.scope.publicId ? hierarchy.find(entry => entry.type === invitation.scope.type && entry.publicId === invitation.scope.publicId) : null;
        return <div className="portal-team-row" key={invitation.id}><span><strong>{invitation.email}</strong><small>{scopedEntry ? `${scopedEntry.displayName} - ` : ""}{hierarchyScopeLabel(invitation.scope.type)} - {invitation.status}</small><small>{termDescription(invitation.accessTerms)}</small><small>Invitation link expires {formatDate(invitation.expiresAt)}</small>{invitation.accessTerms && <small>{invitation.accessTerms.expired ? "Access expired" : invitation.accessTerms.effectiveExpiresAt ? `Access expires ${formatDate(invitation.accessTerms.effectiveExpiresAt)}` : invitation.accessTerms.completionPending ? "Access awaits verified project completion, then 7 days" : "Access remains until revoked"}</small>}</span>{invitation.status === "pending" && <button className="button-ghost button-small" disabled={busy || uncertain || !ready} onClick={() => void removeAccess("invitation", invitation.id)}>Revoke</button>}</div>;
      })}</section>
    </div>
  </div>;
}

export function ClientPortalApp({
  initialPage,
}: {
  initialPage: ClientPortalPage;
}) {
  const initialRoute = parseClientPortalRoute(window.location.pathname);
  const [gate, setGate] = useState<PortalGate>({ status: "loading" });
  const gateRef = useRef(gate), bootstrapController = useRef<AbortController | null>(null);
  gateRef.current = gate;
  const [page, setPage] = useState<ClientPortalPage>(initialPage);
  const [projectId, setProjectId] = useState<string | null>(
    initialRoute.projectId,
  );
  const [feedbackId, setFeedbackId] = useState<string | null>(initialRoute.feedbackId ?? null);
  const [requests, setRequests] = useState<PortalServiceRequest[]>([]);
  const [drafts, setDrafts] = useState<PortalServiceDraftSummary[]>([]);
  const [requestDraftId, setRequestDraftId] = useState<string | null>(
    () => new URL(window.location.href).searchParams.get("draft"),
  );
  const [editing, setEditing] = useState<{
    request: PortalServiceRequest;
    change: boolean;
  } | null>(null);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const mobileNavTrigger = useRef<HTMLButtonElement>(null);
  const mobileNavPanel = useRef<HTMLDivElement>(null);
  const requestContextKey = gate.status === "ready" && gate.data.resourceMode !== "native" ? `${gate.data.account.id}:${gate.data.selectedWorkspaceId ?? "legacy"}` : null;
  const requestAvailability = useRequestAvailability(switchingWorkspace ? null : requestContextKey, gate.status === "ready" ? gate.data.selectedWorkspaceId ?? null : null);
  const pastDeliveryLoader = useMemo(
    () => (_folderId: string | null, cursor: string | null, signal: AbortSignal) => loadPortalPastDeliveries(cursor, undefined, signal),
    [],
  );
  const pastDeliveryLocationLoader = useMemo(
    () => () => loadPortalPastDeliveryLocations(),
    [],
  );

  useEffect(() => {
    let active = true;
    bootstrapController.current?.abort(); const controller = new AbortController(); bootstrapController.current = controller;
    loadPortalBootstrap(undefined, new URLSearchParams(location.search).get("workspace"), controller.signal)
      .then((data) => {
        if (active && !controller.signal.aborted) {
          history.replaceState(null, "", withPortalWorkspace(`${location.pathname}${location.search}`));
          setRequests(data.resourceMode === "native" ? [] : data.requests);
          setGate({ status: "ready", data });
        }
      })
      .catch((caught) => {
        if (active && !controller.signal.aborted) setGate(blockedPortal(caught));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [bootstrapRevision]);
  useEffect(() => {
    if (gate.status !== "ready" || !gate.data.capabilities.requestV2) {
      setDrafts([]);
      return;
    }
    let active = true;
    loadPortalServiceDrafts()
      .then(items => { if (active) setDrafts(items); })
      .catch(() => { if (active) setDrafts([]); });
    return () => { active = false; };
  }, [gate, page]);
  useEffect(() => {
    const onPopState = () => {
      const route = parseClientPortalRoute(window.location.pathname);
      if (!route.isPortal) window.location.reload();
      else {
        const hint = new URLSearchParams(location.search).get("workspace"), current = gateRef.current;
        if (hint !== null && (current.status !== "ready" || hint !== (current.data.selectedWorkspaceId ?? null))) {
          bootstrapController.current?.abort(); setSwitchingWorkspace(false); setGate({status: "loading"}); setBootstrapRevision(value => value + 1);
        }
        setPage(route.page);
        setProjectId(route.projectId);
        setFeedbackId(route.feedbackId ?? null);
        setRequestDraftId(new URL(window.location.href).searchParams.get("draft"));
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileNavPanel.current?.querySelector<HTMLElement>("a")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        mobileNavTrigger.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = [...(mobileNavPanel.current?.querySelectorAll<HTMLElement>('a, button:not([disabled])') || [])];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const resize = () => { if (window.innerWidth > 960) setMobileNavOpen(false); };
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", resize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
    };
  }, [mobileNavOpen]);

  function navigate(nextPage: TopPage) {
    window.history.pushState({}, "", withPortalWorkspace(clientPortalPath(nextPage)));
    setFeedbackId(null);
    setProjectId(null);
    setPage(nextPage);
    setRequestDraftId(null);
    setEditing(null);
    setMobileNavOpen(false);
  }
  function openProject(id: string) {
    window.history.pushState({}, "", withPortalWorkspace(clientProjectPath(id)));
    setProjectId(id);
    setPage("project");
  }
  function openNewRequest(draftId?: string) {
    const url = new URL(clientRequestNewPath(), window.location.origin);
    if (draftId) url.searchParams.set("draft", draftId);
    window.history.pushState({}, "", withPortalWorkspace(`${url.pathname}${url.search}`));
    setProjectId(null);
    setPage("request-new");
    setRequestDraftId(draftId ?? null);
    setEditing(null);
    setRequestNotice(null);
  }
  function finishNewRequest(saved: PortalServiceRequest) {
    onSaved(saved);
    setRequestNotice("Request submitted. LTDS will review it shortly.");
    window.history.pushState({}, "", withPortalWorkspace(clientPortalPath("requests")));
    setPage("requests");
    setRequestDraftId(null);
  }
  if (gate.status === "loading")
    return (
      <PortalBoundary>
        <Card>
          <Loading />
        </Card>
      </PortalBoundary>
    );
  if (gate.status === "blocked")
    return (
      <PortalBoundary>
        <Card>
          <EmptyState title={gate.title} detail={gate.detail} />
          <button
            type="button"
            className="button-orange"
            onClick={() => {
              setGate({ status: "loading" });
              setBootstrapRevision(value => value + 1);
            }}
          >
            Retry portal
          </button>
        </Card>
      </PortalBoundary>
    );

  const { capabilities } = gate.data;
  const native = gate.data.resourceMode === "native" ? gate.data : null;
  const account = gate.data.resourceMode === "native" ? null : gate.data.account;
  const projects = gate.data.resourceMode === "native" ? [] : gate.data.projects;
  const mapboxPublicToken = gate.data.resourceMode === "native" ? null : gate.data.mapboxPublicToken;
  const shellDisplayName = native ? native.workspace.displayName : account!.displayName;
  const workspaces = gate.data.workspaces ?? [];
  const selectedWorkspaceId = gate.data.selectedWorkspaceId ?? null;
  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === selectedWorkspaceId) return;
    bootstrapController.current?.abort(); const controller = new AbortController(); bootstrapController.current = controller;
    setSwitchingWorkspace(true);
    setPortalWorkspaceSelection(workspaceId);
    try {
      const data = await loadPortalBootstrap(undefined, workspaceId, controller.signal);
      if (controller.signal.aborted || bootstrapController.current !== controller) return;
      setRequests(data.resourceMode === "native" ? [] : data.requests);
      setProjectId(null);
      setPage("dashboard");
      setRequestDraftId(null);
      setFeedbackId(null);
      window.history.pushState({}, "", withPortalWorkspace(clientPortalPath("dashboard")));
      setGate({ status: "ready", data });
    } catch (caught) {
      if (controller.signal.aborted || bootstrapController.current !== controller) return;
      setPortalWorkspaceSelection(selectedWorkspaceId);
      window.alert((caught as Error).message || "This workspace could not be opened.");
    } finally {
      if (bootstrapController.current === controller) setSwitchingWorkspace(false);
    }
  };
  const onSaved = (saved: PortalServiceRequest) => {
    setRequests((current) => [
      saved,
      ...current.filter((request) => request.id !== saved.id),
    ]);
    setEditing(null);
  };
  const onEstimateRespond = async (
    request: PortalServiceRequest,
    response: "accept" | "request_change",
  ) => {
    const note =
      response === "request_change"
        ? window.prompt(
            "Describe what should change in the operational estimate",
          )
        : null;
    if (response === "request_change" && !note?.trim()) return;
    if (
      response === "accept" &&
      !window.confirm(
        "Accept this non-binding LTDS operational estimate? A separate Project Alpha quote will still be required before financial approval.",
      )
    )
      return;
    try {
      onSaved(
        await respondToPortalEstimate(
          request.id,
          request.operationalEstimate!.id,
          response,
          note?.trim() || null,
          crypto.randomUUID(),
        ),
      );
    } catch (caught) {
      window.alert((caught as Error).message);
    }
  };
  const selectedProject = projects.find((project) => project.id === projectId);
  let content: ReactNode;

  if (native)
    content = <NativeWorkspaceContent key={`${native.workspace.sourceId}:${native.workspace.id}:${native.contextVersion}`} context={native} page={page} projectId={projectId} openProject={openProject}
      onInvalid={caught => { bootstrapController.current?.abort(); const status = (caught as RequestError).status; setGate(status === 409 ? {status: "blocked", title: "Workspace changed", detail: "Your workspace changed. Refresh the portal before continuing."} : status === 404 || status === 410 ? {status: "blocked", title: "Shared item unavailable", detail: "This shared item or its access has changed. Refresh the portal to check your current workspace."} : blockedPortal(caught)); }}
      renderFiles={options => <FileBrowser key={options.folderId ?? "linked-file"} {...options} workspaceId={native.workspace.id} mapToken={null} locationScopeLabel="" emptyTitle="No files shown" emptyDetail={options.folderId ? "This shared folder has no files on this page." : "Open a delivery folder to browse its files."} />} />;
  else if (page === "project")
    content = selectedProject ? (
      <ProjectWorkspace
        key={`${requestContextKey}:${selectedProject.id}`}
        project={selectedProject}
        requests={requests}
        mapboxPublicToken={mapboxPublicToken}
        requestV2={capabilities.requestV2}
        requestAttachments={capabilities.requestAttachments}
        requestAvailability={requestAvailability}
        requestContextKey={requestContextKey!}
        requestWorkspaceId={selectedWorkspaceId}
        feedback={capabilities.feedback}
        viewer={capabilities.viewer}
        viewerDisplayUnits={gate.data.resourceMode === "native" ? "imperial" : gate.data.viewerDisplayUnits}
        onSaved={onSaved}
        onBack={() => navigate("projects")}
      />
    ) : (
      <Card>
        <EmptyState
          title="Project unavailable"
          detail="This project is not part of your current access grant."
        />
      </Card>
    );
  else if (page === "feedback")
    content = capabilities.feedback ? <PortalFeedback key={`${requestContextKey}:${feedbackId ?? "list"}`} id={feedbackId} /> : <Card title="Feedback unavailable"><p>Feedback is not enabled for this workspace.</p></Card>;
  else if (page === "not-found")
    content = (
      <Card>
        <EmptyState
          title="Page not found"
          detail="This client portal page does not exist."
        />
      </Card>
    );
  else if (page === "dashboard")
    content = (
      <>
        <section className="portal-welcome">
          <span className="eyebrow">Client portal</span>
          <h1>Welcome, {account!.displayName}</h1>
          <p>
            Project progress, files, and service requests—all in one secure
            workspace.
          </p>
        </section>
        <div className="portal-stat-grid">
          <Card>
            <span className="portal-stat">{projects.length}</span>
            <strong>Active projects</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("projects")}
            >
              View projects
            </button>
          </Card>
          <Card>
            <span className="portal-stat">
              {
                requests.filter(
                  (request) =>
                    !["completed", "cancelled", "declined"].includes(
                      request.status,
                    ),
                ).length
              }
            </span>
            <strong>Open requests</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("requests")}
            >
              View requests
            </button>
          </Card>
          <Card>
            <span className="portal-stat">
              {
                requests.filter(
                  (request) => request.status === "accepted_linked",
                ).length
              }
            </span>
            <strong>Accepted requests</strong>
            <button
              className="portal-text-action"
              onClick={() => navigate("requests")}
            >
              Review details
            </button>
          </Card>
        </div>
        <Card title="Your projects">
          {projects.length ? (
            <div className="portal-project-strip">
              {projects.slice(0, 3).map((project) => (
                <button
                  key={project.id}
                  onClick={() => openProject(project.id)}
                >
                  <span>{project.externalRef}</span>
                  <strong>{project.projectName}</strong>
                  <small>
                    {project.nextMilestone || "Open project workspace"}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No projects available"
              detail="Your client account has no active project grants."
            />
          )}
        </Card>
        <Card title="Recent requests">
          <RequestList requests={requests} projects={projects} limit={4} />
        </Card>
      </>
    );
  else if (page === "projects")
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Project workspaces</span>
          <h1>Projects</h1>
          <p>
            Track project details, download files, and request additional
            service.
          </p>
        </section>
        {projects.length === 0 ? (
          <Card>
            <EmptyState
              title="No projects available"
              detail="Your client account has no active project grants."
            />
          </Card>
        ) : (
          <div className="portal-project-grid">
            {projects.map((project) => (
              <button
                key={project.id}
                className="portal-project-card ltds-card"
                onClick={() => openProject(project.id)}
              >
                <div>
                  <span className="portal-project-ref">
                    {project.externalRef}
                  </span>
                  <StatusPill tone="success">
                    {projectStatusLabel(project.status)}
                  </StatusPill>
                </div>
                <h2>{project.projectName}</h2>
                <p>{project.summary || project.clientName}</p>
                <span className="portal-project-link">Open workspace →</span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  else if (page === "deliveries")
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Client archive</span>
          <h1>Past deliveries</h1>
          <p>
            Secure files granted to your client account across completed and
            historical work.
          </p>
        </section>
        <Card title="Delivery archive">
          <FileBrowser
            key={requestContextKey}
            feedback={capabilities.feedback}
            workspaceId={selectedWorkspaceId}
            load={pastDeliveryLoader}
            loadLocations={pastDeliveryLocationLoader}
            mapToken={mapboxPublicToken}
            locationScopeLabel="your available delivery files"
            emptyTitle="No past deliveries"
            emptyDetail="Files published to your client archive will appear here."
          />
        </Card>
        {capabilities.delegatedShares && selectedWorkspaceId && (
          <DelegatedSharePanel workspaceId={selectedWorkspaceId} />
        )}
      </>
    );
  else if (page === "requests")
    content = (
      <>
        <section className="portal-page-heading portal-page-heading-action">
          <div>
            <span className="eyebrow">Flight & service</span>
            <h1>Service requests</h1>
            <p>Review request status, scope, estimates, and prior activity.</p>
          </div>
          {!editing && canBeginRequest(requestAvailability, projects) && (
            <button className="button-orange" onClick={() => openNewRequest()}>
              Submit new request
            </button>
          )}
        </section>
        {requestNotice && <p className="portal-message portal-request-notice" role="status">{requestNotice}</p>}
        {!editing && !canBeginRequest(requestAvailability, projects) && <RequestAvailabilityMessage availability={requestAvailability} />}
        {!editing && drafts.length > 0 && (
          <Card title="Saved drafts" className="portal-request-drafts-card">
            <p className="portal-card-intro">Continue an autosaved request in this workspace. Nothing is submitted until you review and confirm it.</p>
            <div className="portal-request-drafts" role="list">
              {drafts.map(item => <article key={item.id} role="listitem">
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.serviceNames.length ? item.serviceNames.join(", ") : "Services not selected"}</span>
                  <small>{item.areaAcres != null ? `${item.areaAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres` : "No work area saved"} · Updated {formatDate(item.updatedAt)}</small>
                </div>
                <button type="button" className="button-ghost" onClick={() => openNewRequest(item.id)}>Continue draft</button>
              </article>)}
            </div>
          </Card>
        )}
        {editing ? (
          <Card
            className="portal-request-card"
            title={
              editing.change ? "Request a change" : "Edit submitted request"
            }
          >
            <ServiceRequestForm
              key={`${editing.change ? "change" : "edit"}:${editing.request.id}`}
              projects={projects}
              initial={editing.change ? undefined : editing.request}
              changeOf={editing.change ? editing.request : undefined}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
              mapboxPublicToken={mapboxPublicToken}
              requestV2={capabilities.requestV2}
              attachmentsEnabled={capabilities.requestAttachments}
            />
          </Card>
        ) : (
          <div className="portal-request-summary" aria-label="Request summary">
            <div><strong>{requests.length}</strong><span>Total requests</span></div>
            <div><strong>{requests.filter((request) => !["completed", "cancelled", "declined"].includes(request.status)).length}</strong><span>Open requests</span></div>
            <div><strong>{requests.filter((request) => request.operationalEstimate?.status === "ready").length}</strong><span>Estimates ready</span></div>
          </div>
        )}
        <Card title="Request history">
          <RequestList
            requests={requests}
            projects={projects}
            onEdit={(request) => setEditing({ request, change: false })}
            onChange={(request) => setEditing({ request, change: true })}
            onEstimateRespond={onEstimateRespond}
          />
        </Card>
      </>
    );
  else if (page === "request-new")
    content = (
      <>
        <section className="portal-page-heading portal-page-heading-action">
          <div>
            <span className="eyebrow">New flight & service request</span>
            <h1>Define your site and scope</h1>
            <p>
              Choose the request context, then add services, work area, timing, deliverables,
              and on-site details LTDS needs to review the work.
            </p>
          </div>
          <button className="button-ghost" onClick={() => navigate("requests")}>
            Back to request history
          </button>
        </section>
        <Card title="New request" className="portal-request-card">
          <ServiceRequestForm
            key={`new-request:${requestDraftId ?? "blank"}`}
            projects={projects}
            onSaved={finishNewRequest}
            onCancel={() => navigate("requests")}
            mapboxPublicToken={mapboxPublicToken}
            requestV2={capabilities.requestV2}
            attachmentsEnabled={capabilities.requestAttachments}
            initialDraftId={requestDraftId}
            requestAvailability={requestAvailability}
            requestContextKey={requestContextKey!}
            requestWorkspaceId={selectedWorkspaceId}
          />
        </Card>
      </>
    );
  else
    content = (
      <>
        <section className="portal-page-heading">
          <span className="eyebrow">Account</span>
          <h1>Your account</h1>
          <p>
            LTDS provisions and manages client access directly during the pilot.
          </p>
        </section>
        <div className="portal-account-grid">
          <Card title="Client account" className="portal-account-card">
            <div className="portal-avatar" aria-hidden="true">
              {account!.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{account!.displayName}</strong>
              {account!.email && <p>{account!.email}</p>}
              {account!.phone && <p>{account!.phone}</p>}
            </div>
          </Card>
          <Card title="Access & security">
            <p className="portal-copy">
              Your account uses a verified identity and server-managed project
              grants. Contact LTDS to add a colleague, update access, or change
              your account details.
            </p>
            <a
              className="button-ghost button-small portal-contact-action"
              href="mailto:info@ledgetopdroneservices.com"
            >
              Contact LTDS
            </a>
          </Card>
          {capabilities.workspaceMembershipManagement && <Card title="Team access" className="portal-team-card"><WorkspaceTeamPanel key={selectedWorkspaceId ?? "legacy"} initialWorkspaceId={selectedWorkspaceId} invitationEmailDelivery={capabilities.invitationEmailDelivery} hierarchyScopedInvitations={capabilities.hierarchyScopedInvitations} /></Card>}
        </div>
      </>
    );

  return (
    <div className="client-portal">
      <header className="client-portal-header">
        <Brand product="Client portal" />
        {capabilities.workspaceHierarchyV2 && workspaces.length > 1 && (
          <label className="portal-workspace-switcher">
            <span>Workspace</span>
            <select
              aria-label="Client workspace"
              value={selectedWorkspaceId ?? ""}
              disabled={switchingWorkspace}
              onChange={event => void switchWorkspace(event.target.value)}
            >
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.displayName}{workspace.resourceMode === "native" ? ` — ${workspace.sourceId}` : ""}</option>)}
            </select>
          </label>
        )}
        <nav className="client-portal-top-nav" aria-label="Client portal">
          {navigation.filter(item => (item.page !== "feedback" || capabilities.feedback) && (!native || item.page !== "requests")).map((item) => (
            <a
              key={item.page}
              href={withPortalWorkspace(clientPortalPath(item.page))}
              aria-current={
                page === item.page ||
                (item.page === "projects" && page === "project") ||
                (item.page === "requests" && page === "request-new")
                  ? "page"
                  : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                navigate(item.page);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {!switchingWorkspace && !native && <PortalNotifications key={requestContextKey} feedbackEnabled={capabilities.feedback} />}
        <button ref={mobileNavTrigger} className="portal-nav-trigger" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="portal-mobile-navigation" onClick={() => setMobileNavOpen(true)}><span className="nav-hamburger" aria-hidden="true"><i /><i /><i /></span></button>
        <AccountMenu className="portal-account-menu" displayName={shellDisplayName}
          avatar={shellDisplayName.slice(0, 2).toUpperCase()} accountHref={withPortalWorkspace(clientPortalPath("account"))}
          onAccount={() => navigate("account")} />
      </header>
      {mobileNavOpen && <div className="portal-mobile-nav-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setMobileNavOpen(false); mobileNavTrigger.current?.focus(); } }}>
        <div ref={mobileNavPanel} id="portal-mobile-navigation" className="portal-mobile-nav" role="dialog" aria-modal="true" aria-label="Navigation">
          <header><strong>Navigation</strong><button type="button" aria-label="Close navigation" onClick={() => { setMobileNavOpen(false); mobileNavTrigger.current?.focus(); }}>Close</button></header>
          <nav aria-label="Mobile client portal navigation">
            {[...navigation.filter(item => (item.page !== "feedback" || capabilities.feedback) && (!native || item.page !== "requests")), { page: "account" as const, label: "Account" }].map((item) => <a key={item.page} href={withPortalWorkspace(clientPortalPath(item.page))} aria-current={page === item.page || (item.page === "projects" && page === "project") || (item.page === "requests" && page === "request-new") ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(item.page); }}>{item.label}</a>)}
          </nav>
        </div>
      </div>}
      <main className="client-portal-main">{switchingWorkspace ? <Loading /> : content}</main>
    </div>
  );
}
