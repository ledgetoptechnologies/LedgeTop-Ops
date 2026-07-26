import { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND, type DeliveryItem, type DeliveryManifest } from "@ltds/shared";
import { Brand, EmptyState, Loading } from "@ltds/ui";
import { openDeliveryRoute, parseDeliveryRoute } from "./route";

type Gate = "landing" | "loading" | "code" | "ready" | "error";
type ErrorView = "unavailable" | "invalid-link";

interface RequestErrorBody {
  error?: string;
  code?: string;
}

type RequestError = Error & { status?: number; body?: RequestErrorBody };

interface BulkDownloadResponse {
  downloadUrl?: string;
  ticket?: string;
  downloadTicket?: string;
  statusUrl?: string;
  progressUrl?: string;
  status?: "queued" | "processing" | "running" | "ready" | "failed" | "complete";
  progress?: number;
  percent?: number;
  message?: string;
  processedBytes?: number;
  totalBytes?: number;
  error?: { code?: string; message?: string } | null;
}

const invalidLinkDetail = "This folder has been moved, removed, or is no longer being shared. Contact your Ledge Top Drone Services representative for a current delivery link.";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({})) as RequestErrorBody & T;
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed"), { status: response.status, body });
  return body;
}

function formatBytes(size: number | null): string {
  if (size === null) return "Folder";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function iconFor(item: DeliveryItem): string {
  if (item.kind === "folder") return "Folder";
  if (item.kind === "image") return "Image";
  if (item.kind === "video") return "Video";
  if (item.kind === "pdf") return "PDF";
  return item.kind === "other" ? "File" : item.kind;
}

export function DeliveryApp() {
  const initialRoute = useMemo(() => parseDeliveryRoute(location.pathname, location.hash), []);
  const [publicId, setPublicId] = useState(initialRoute.publicId);
  const [secret, setSecret] = useState(initialRoute.secret);
  const [gate, setGate] = useState<Gate>(initialRoute.publicId ? "loading" : "landing");
  const [error, setError] = useState("");
  const [errorView, setErrorView] = useState<ErrorView>("unavailable");
  const [manifest, setManifest] = useState<DeliveryManifest | null>(null);
  const [folder, setFolder] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("ltds-delivery-view") === "list" ? "list" : "grid");
  const [preview, setPreview] = useState<DeliveryItem | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [bulkProgress, setBulkProgress] = useState<{ status: string; percent: number | null; message?: string } | null>(null);

  const loadManifest = useCallback(async (id: string, folderId = "") => {
    const query = folderId ? `?folder=${encodeURIComponent(folderId)}` : "";
    const data = await requestJson<DeliveryManifest>(`/api/public/shares/${encodeURIComponent(id)}/manifest${query}`);
    setManifest(data); setFolder(folderId); setGate("ready");
  }, []);

  const showRequestError = useCallback((caught: unknown) => {
    const value = caught as RequestError;
    if (value.status === 410 || value.body?.code === "SHARED_FOLDER_UNAVAILABLE") {
      setErrorView("invalid-link");
      setError(invalidLinkDetail);
    } else {
      setErrorView("unavailable");
      setError(value.message || "This delivery could not be opened.");
    }
    setGate("error");
  }, []);

  const exchange = useCallback(async (accessCode?: string) => {
    if (accessCode === undefined) setGate("loading");
    setError("");
    try {
      const result = await openDeliveryRoute({ publicId, secret, accessCode }, {
        createSession: route => requestJson<{ publicId: string; canonicalPath: string }>(`/api/public/shares/${encodeURIComponent(route.publicId)}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: route.secret, accessCode: route.accessCode }),
        }),
        loadManifest,
      });
      if (!result) return;
      setPublicId(result.publicId); setSecret("");
      history.replaceState(null, "", result.canonicalPath);
    } catch (caught) {
      const value = caught as RequestError;
      if (value.status === 401 && (value.body?.code === "ACCESS_CODE_REQUIRED" || value.body?.code === "ACCESS_CODE_INVALID")) {
        setError(accessCode === undefined && value.body.code === "ACCESS_CODE_REQUIRED" ? "" : value.message);
        setGate("code");
        return;
      }
      showRequestError(caught);
    }
  }, [loadManifest, publicId, secret, showRequestError]);

  useEffect(() => { if (publicId) void exchange(); }, []); // Exchange the URL fragment once on first load.

  function changeView(next: "grid" | "list") { setView(next); localStorage.setItem("ltds-delivery-view", next); }
  async function navigateToFolder(folderId = "") {
    setGate("loading");
    try {
      await loadManifest(publicId, folderId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (caught) {
      showRequestError(caught);
    }
  }
  async function openFolder(item: DeliveryItem) { await navigateToFolder(item.id); }

  function toggleSelected(itemId: string) {
    setSelectedItems(current => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  function toggleCurrentList() {
    const currentIds = manifest?.items.map(item => item.id) || [];
    setSelectedItems(current => {
      const next = new Set(current);
      const allSelected = currentIds.length > 0 && currentIds.every(id => next.has(id));
      currentIds.forEach(id => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function toggleSelectionMode() {
    setSelectionMode(current => {
      if (current) setSelectedItems(new Set());
      return !current;
    });
  }

  async function downloadBulk(all = false) {
    if (!all && selectedItems.size === 0) return;
    setBulkBusy(true); setBulkError(""); setBulkProgress({ status: "Preparing download", percent: null });
    try {
      const response = await fetch(`/api/public/shares/${encodeURIComponent(publicId)}/bulk-download`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(all ? { all: true } : { items: [...selectedItems] }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as RequestErrorBody;
        throw new Error(body.error || "The download could not be prepared.");
      }
      let body = await response.json() as BulkDownloadResponse;
      const statusUrl = body.statusUrl || body.progressUrl;
      if (!body.downloadUrl && statusUrl) {
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 2000));
          const status = await requestJson<BulkDownloadResponse>(statusUrl);
          body = { ...body, ...status };
          const calculated = body.totalBytes && typeof body.processedBytes === "number" ? Math.min(100, Math.round(body.processedBytes / body.totalBytes * 100)) : null;
          const percent = typeof body.progress === "number" ? body.progress : typeof body.percent === "number" ? body.percent : calculated;
          setBulkProgress({ status: body.status === "ready" || body.status === "complete" ? "Download ready" : "Building ZIP", percent, message: body.message });
          if (body.status === "failed") throw new Error(body.error?.message || body.message || "The download could not be prepared.");
          if (body.downloadUrl || body.ticket || body.downloadTicket || body.status === "ready" || body.status === "complete") break;
        }
      }
      const ticket = body.ticket || body.downloadTicket;
      const downloadUrl = body.downloadUrl || (ticket ? `/api/public/shares/${encodeURIComponent(publicId)}/bulk-download/${encodeURIComponent(ticket)}` : "");
      if (!downloadUrl) throw new Error("The download could not be prepared.");
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.rel = "noreferrer";
      const safeName = (manifest?.share.projectName || "delivery").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "delivery";
      anchor.download = `${safeName}.zip`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch (caught) {
      setBulkError(caught instanceof Error ? caught.message : "The download could not be prepared.");
      setBulkProgress({ status: "Download failed", percent: null });
    } finally {
      setBulkBusy(false);
      window.setTimeout(() => setBulkProgress(null), 1800);
    }
  }

  if (gate === "landing") return <PublicFrame><DeliveryLanding /></PublicFrame>;
  if (gate === "loading") return <PublicFrame><DeliveryLoadingSkeleton /></PublicFrame>;
  if (gate === "code") return <PublicFrame><AccessCodeForm onSubmit={exchange} error={error} /></PublicFrame>;
  if (gate === "error" || !manifest) return <PublicFrame><EmptyState
    title={errorView === "invalid-link" ? "This link is no longer valid" : "Delivery unavailable"}
    detail={error || "This link is invalid, expired, or has been revoked."}
  /></PublicFrame>;

  return <PublicFrame>
    <section className="delivery-heading">
      <div><span className="eyebrow">Secure client delivery</span><h1>{manifest.share.projectName}</h1><p>{manifest.share.clientName}</p></div>
      {manifest.share.expiresAt && <div className="expiry">Available through {new Date(manifest.share.expiresAt).toLocaleDateString()}</div>}
    </section>
    <section className="delivery-browser">
      <div className="browser-toolbar">
        <nav className="breadcrumbs" aria-label="Folder path">
          <button onClick={() => void navigateToFolder()}>All files</button>
          {manifest.folder.breadcrumbs.map(crumb => <span key={crumb.id}><b>/</b><button onClick={() => void navigateToFolder(crumb.id)}>{crumb.name}</button></span>)}
        </nav>
        <div className="view-switch" aria-label="View style"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")}>Grid</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")}>List</button></div>
      </div>
      <div className={`download-toolbar${selectionMode ? " selection-mode" : ""}`} aria-label="Download files">
        <button className={selectionMode ? "button-orange button-small" : "button-ghost button-small"} onClick={toggleSelectionMode}>{selectionMode ? "Done" : "Select"}</button>
        {selectionMode && <label className="select-current"><input type="checkbox" checked={manifest.items.length > 0 && manifest.items.every(item => selectedItems.has(item.id))} onChange={toggleCurrentList} /> Select current list</label>}
        <span className="selection-count">{selectionMode ? (selectedItems.size ? `${selectedItems.size} selected` : "Click any card to select") : ""}</span>
        <div className="download-actions">
          {selectionMode && <button className="button-ghost button-small" disabled={bulkBusy || selectedItems.size === 0} onClick={() => void downloadBulk()}> {bulkBusy ? "Preparing…" : "Download selected"}</button>}
          <button className="button-orange button-small" disabled={bulkBusy} onClick={() => void downloadBulk(true)}>{bulkBusy ? "Preparing…" : "Download all"}</button>
        </div>
      </div>
      {bulkError && <p className="bulk-error" role="alert">{bulkError}</p>}
      {bulkProgress && <BulkProgress progress={bulkProgress} />}
      {manifest.items.length === 0 ? <EmptyState title="This folder is empty" detail="New synced files will appear here automatically." /> : view === "grid" ?
        <div className="item-grid">{manifest.items.map(item => <ItemCard key={item.id} item={item} selectionMode={selectionMode} selected={selectedItems.has(item.id)} onToggle={toggleSelected} onFolder={openFolder} onPreview={setPreview} />)}</div> :
        <div className="item-list">{manifest.items.map(item => <ItemRow key={item.id} item={item} selectionMode={selectionMode} selected={selectedItems.has(item.id)} onToggle={toggleSelected} onFolder={openFolder} onPreview={setPreview} />)}</div>}
      <footer>{manifest.items.length} item{manifest.items.length === 1 ? "" : "s"}{manifest.nextCursor ? " · More items are available" : ""}</footer>
    </section>
    {preview && <Preview item={preview} items={manifest.items.filter(item => item.kind !== "folder")} publicId={publicId} onSelect={setPreview} onClose={() => setPreview(null)} />}
  </PublicFrame>;
}

function DeliveryLanding() {
  return <section className="delivery-landing">
    <span className="eyebrow">Secure client delivery</span>
    <h1>Open your delivery from the link we sent you.</h1>
    <p>Each client delivery has a private, unique link. Use that link to view, preview, and download your files.</p>
    <small>If your link has expired or is not opening, contact your Ledge Top Drone Services project representative.</small>
  </section>;
}

function PublicFrame({ children }: { children: React.ReactNode }) {
  return <><header className="public-header"><Brand product="Client Delivery" /></header><main className="delivery-main">{children}</main><footer className="public-footer">Secure delivery by Ledge Top Drone Services</footer></>;
}

function DeliveryLoadingSkeleton() {
  return <section className="delivery-loading" role="status" aria-label="Loading delivery"><div className="skeleton skeleton-heading" /><div className="skeleton-toolbar"><span className="skeleton skeleton-control" /><span className="skeleton skeleton-control" /></div><div className="skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index}><span className="skeleton skeleton-media" /><span className="skeleton skeleton-line wide" /><span className="skeleton skeleton-line" /></div>)}</div></section>;
}

function BulkProgress({ progress }: { progress: { status: string; percent: number | null; message?: string } }) {
  return <div className="bulk-progress" role="status" aria-live="polite"><div><strong>{progress.status}</strong><span>{progress.message || (progress.percent === null ? "Large downloads may take a moment." : `${progress.percent}%`)}</span></div><div className={`progress-track${progress.percent === null ? " pending" : ""}`}><span style={{ width: `${progress.percent === null ? 35 : progress.percent}%` }} /></div></div>;
}

function AccessCodeForm({ onSubmit, error }: { onSubmit: (code: string) => Promise<void>; error: string }) {
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="code-gate" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit(code); setBusy(false); }}>
    <span className="eyebrow">Confidential delivery</span><h1>Enter your access code</h1><p>This delivery requires the code supplied by Ledge Top Drone Services.</p>
    <label htmlFor="access-code">Access code</label><input id="access-code" autoComplete="one-time-code" minLength={8} required value={code} onChange={event => setCode(event.target.value)} />
    {error && <p className="form-error">{error}</p>}<button className="button-orange" disabled={busy}>{busy ? "Checking…" : "Open delivery"}</button>
  </form>;
}

function ItemCard({ item, selectionMode, selected, onToggle, onFolder, onPreview }: { item: DeliveryItem; selectionMode: boolean; selected: boolean; onToggle: (itemId: string) => void; onFolder: (item: DeliveryItem) => void; onPreview: (item: DeliveryItem) => void }) {
  const action = selectionMode ? () => onToggle(item.id) : item.kind === "folder" ? () => void onFolder(item) : () => onPreview(item);
  return <article className={`item-card${selected ? " selected" : ""}${selectionMode ? " selectable" : ""}`} onClick={selectionMode ? action : undefined}
    tabIndex={selectionMode ? 0 : undefined} role={selectionMode ? "button" : undefined} aria-pressed={selectionMode ? selected : undefined}
    onKeyDown={selectionMode ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); } } : undefined}>
    <button className="item-visual" onClick={event => { event.stopPropagation(); if (selectionMode) event.preventDefault(); action(); }} aria-label={`${selectionMode ? selected ? "Deselect" : "Select" : item.kind === "folder" ? "Open" : "Preview"} ${item.name}`}>
    {selectionMode && <span className="selection-checkbox" aria-hidden="true">{selected ? "✓" : ""}</span>}
    {item.thumbnailUrl ? <Thumbnail item={item} /> : item.kind === "folder" ? <span className="folder-shape" /> : <span className="file-kind">{iconFor(item)}</span>}
    {item.kind === "video" && <span className="play">▶</span>}{item.kind === "video" && item.previewStatus === "processing" && <span className="media-status">Preparing preview…</span>}
  </button><div className="item-info"><strong title={item.name}>{item.name}</strong><span>{formatBytes(item.size)}{item.uploadedAt ? ` · ${new Date(item.uploadedAt).toLocaleDateString()}` : ""}</span></div>
    {!selectionMode && item.downloadUrl && <a className="download-chip" href={item.downloadUrl}>Download</a>}
  </article>;
}

function ItemRow({ item, selectionMode, selected, onToggle, onFolder, onPreview }: { item: DeliveryItem; selectionMode: boolean; selected: boolean; onToggle: (itemId: string) => void; onFolder: (item: DeliveryItem) => void; onPreview: (item: DeliveryItem) => void }) {
  return <div className={`item-row${selected ? " selected" : ""}${selectionMode ? " selectable" : ""}`} onClick={selectionMode ? () => onToggle(item.id) : undefined}><button className="row-name" onClick={event => { event.stopPropagation(); selectionMode ? onToggle(item.id) : item.kind === "folder" ? void onFolder(item) : onPreview(item); }}><span>{item.kind === "folder" ? "▰" : "▧"}</span><strong>{item.name}</strong></button><span>{formatBytes(item.size)}</span><span>{item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : "—"}</span>{!selectionMode && item.downloadUrl ? <a href={item.downloadUrl}>Download</a> : <span />}</div>;
}

function Preview({ item, items, publicId, onSelect, onClose }: { item: DeliveryItem; items: DeliveryItem[]; publicId: string; onSelect: (item: DeliveryItem) => void; onClose: () => void }) {
  const index = items.findIndex(candidate => candidate.id === item.id);
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const filmstripItems = index < 0 ? [] : items.slice(Math.max(0, index - 4), Math.min(items.length, index + 5));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement)?.tagName)) return;
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && previous) onSelect(previous);
      if (event.key === "ArrowRight" && next) onSelect(next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [next, onClose, onSelect, previous]);
  return <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section className="preview-dialog"><header><strong>{item.name}</strong>{index >= 0 && <span className="preview-position" aria-live="polite">{index + 1} of {items.length}</span>}<DownloadOriginal item={item} compact /><button className="button-ghost button-small" onClick={onClose}>Close</button></header><div className="preview-stage">
    <button className="preview-nav previous" disabled={!previous} aria-label="Previous file" onClick={() => previous && onSelect(previous)}>‹</button>
    <div className="preview-media">{item.kind === "image" ? <ImagePreview key={item.id} item={item} /> : item.kind === "pdf" ? <PdfPreview key={item.id} item={item} /> : item.kind === "video" ? <VideoPreview key={item.id} item={item} publicId={publicId} /> : item.kind === "audio" && (item.sourceUrl || item.previewUrl) ? <audio src={item.sourceUrl || item.previewUrl} controls /> : item.kind === "text" && (item.sourceUrl || item.previewUrl) ? <iframe src={item.sourceUrl || item.previewUrl} title={item.name} loading="lazy" /> : <PreparedPlaceholder item={item} />}</div>
    <button className="preview-nav next" disabled={!next} aria-label="Next file" onClick={() => next && onSelect(next)}>›</button>
  </div>{items.length > 1 && <div className="preview-filmstrip" aria-label="Nearby files in this folder">{filmstripItems.map(candidate => <button key={candidate.id} className={candidate.id === item.id ? "active" : ""} aria-current={candidate.id === item.id ? "true" : undefined} title={candidate.name} onClick={() => onSelect(candidate)}>{candidate.thumbnailUrl ? <Thumbnail item={candidate} /> : <span className="file-kind">{iconFor(candidate)}</span>}</button>)}</div>}</section></div>;
}

function ImagePreview({ item }: { item: DeliveryItem }) {
  const [failed, setFailed] = useState(!item.previewUrl); const [loaded, setLoaded] = useState(false);
  if (failed) return <PreparedPlaceholder item={item} />;
  return <div className="image-preview" aria-busy={!loaded}>{!loaded && <SkeletonViewer />}<img src={item.previewUrl} alt={item.name} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} /></div>;
}

function PdfPreview({ item }: { item: DeliveryItem }) {
  const [preparedFailed, setPreparedFailed] = useState(!item.previewUrl); const [loaded, setLoaded] = useState(false);
  if (preparedFailed) return item.sourceUrl ? <iframe src={item.sourceUrl} title={item.name} loading="lazy" /> : <PreparedPlaceholder item={item} />;
  return <div className="image-preview" aria-busy={!loaded}>{!loaded && <SkeletonViewer />}<img src={item.previewUrl} alt={`${item.name} first page`} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setPreparedFailed(true)} /></div>;
}

function SkeletonViewer() { return <span className="skeleton-viewer" role="status" aria-label="Loading preview" />; }

function DownloadOriginal({ item, compact = false }: { item: DeliveryItem; compact?: boolean }) {
  if (!item.downloadUrl) return null;
  return <a className={compact ? "button button-orange button-small" : "viewer-download"} href={item.downloadUrl}>Download original</a>;
}

function PreparedPlaceholder({ item }: { item: DeliveryItem }) {
  return <div className="prepared-placeholder"><img className="preview-brand-logo" src={BRAND.logoUrl} alt={BRAND.shortName} /><strong>This file could not be displayed</strong><p>Your browser may not support this file format. The original file is still available to download.</p><DownloadOriginal item={item} /></div>;
}

function VideoPreview({ item, publicId }: { item: DeliveryItem; publicId: string }) {
  const [loading, setLoading] = useState(true); const [ticketLoading, setTicketLoading] = useState(item.previewStatus === "ready");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; if (item.previewStatus !== "ready") { setTicketLoading(false); return () => { cancelled = true; }; } requestJson<{ streamUrl?: string; url?: string }>(`/api/public/shares/${encodeURIComponent(publicId)}/items/${encodeURIComponent(item.id)}/stream-ticket`, { method: "POST" }).then(result => { if (!cancelled) setStreamUrl(result.streamUrl || result.url || null); }).catch(() => { if (!cancelled) setStreamUrl(null); }).finally(() => { if (!cancelled) setTicketLoading(false); }); return () => { cancelled = true; }; }, [item.id, item.previewStatus, publicId]);
  if (streamUrl) return <div className="video-preview">{loading && <span className="media-status">Opening video preview…</span>}<iframe src={streamUrl} title={item.name} onLoad={() => setLoading(false)} allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowFullScreen /></div>;
  if (ticketLoading) return <div className="video-preview" aria-busy="true"><SkeletonViewer /><span className="media-status">Opening video preview…</span></div>;
  return item.sourceUrl ? <OriginalVideo item={item} /> : <PreparedPlaceholder item={item} />;
}

function OriginalVideo({ item }: { item: DeliveryItem }) {
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  if (failed) return <PreparedPlaceholder item={item} />;
  return <div className="video-preview" aria-busy={loading}>{loading && <><SkeletonViewer /><span className="media-status">Opening original video…</span></>}<video src={item.sourceUrl} controls playsInline preload="metadata" onLoadedMetadata={() => setLoading(false)} onError={() => setFailed(true)} /></div>;
}

function Thumbnail({ item }: { item: DeliveryItem }) {
  const [failed, setFailed] = useState(false); const [loaded, setLoaded] = useState(false);
  if (failed) return <span className="media-placeholder branded-media-placeholder" aria-label={`${iconFor(item)} preview unavailable`}><img src={BRAND.logoUrl} alt="" loading="lazy" decoding="async" /><small>No preview generated yet</small></span>;
  return <>{!loaded && <span className="thumbnail-skeleton" aria-hidden="true" />}<img src={item.thumbnailUrl} loading="lazy" decoding="async" alt="" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} /></>;
}
