import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeliveryItem, DeliveryManifest } from "@ltds/shared";
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
    {preview && <Preview item={preview} publicId={publicId} onClose={() => setPreview(null)} />}
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
  return <section className="delivery-loading" aria-label="Loading delivery"><div className="skeleton skeleton-heading" /><div className="skeleton-toolbar"><span className="skeleton skeleton-control" /><span className="skeleton skeleton-control" /></div><div className="skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index}><span className="skeleton skeleton-media" /><span className="skeleton skeleton-line wide" /><span className="skeleton skeleton-line" /></div>)}</div></section>;
}

function BulkProgress({ progress }: { progress: { status: string; percent: number | null; message?: string } }) {
  return <div className="bulk-progress" role="status"><div><strong>{progress.status}</strong><span>{progress.message || (progress.percent === null ? "Large downloads may take a moment." : `${progress.percent}%`)}</span></div><div className="progress-track"><span style={{ width: `${progress.percent === null ? 35 : progress.percent}%` }} /></div></div>;
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

function Preview({ item, publicId, onClose }: { item: DeliveryItem; publicId: string; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section className="preview-dialog"><header><strong>{item.name}</strong>{item.downloadUrl && <a className="button button-orange button-small" href={item.downloadUrl}>Download</a>}<button className="button-ghost button-small" onClick={onClose}>Close</button></header><div className="preview-stage">
    {item.kind === "image" && item.previewUrl ? <ImagePreview item={item} /> : item.kind === "video" ? <VideoPreview item={item} publicId={publicId} /> : item.kind === "audio" && item.previewUrl ? <audio src={item.previewUrl} controls autoPlay /> : (item.kind === "pdf" || item.kind === "text") && item.previewUrl ? <iframe src={item.previewUrl} title={item.name} /> : <EmptyState title="Preview unavailable" detail="Download this file to open it in its original application." />}
  </div></section></div>;
}

function ImagePreview({ item }: { item: DeliveryItem }) {
  const [original, setOriginal] = useState(false); const [loaded, setLoaded] = useState(false);
  const media = item as DeliveryItem & { originalUrl?: string; sourceUrl?: string };
  const originalUrl = media.originalUrl || media.sourceUrl || item.downloadUrl;
  const large = (item.size || 0) >= 25 * 1024 * 1024;
  function viewOriginal() { if (!originalUrl) return; if (large && !window.confirm("This original image is 25 MB or larger and may load slowly. View it anyway?")) return; setOriginal(true); }
  return <div className="image-preview">{!loaded && <SkeletonViewer />}<img src={original ? originalUrl : item.previewUrl} alt={item.name} loading="eager" decoding="async" onLoad={() => setLoaded(true)} />{originalUrl && !original && <button className="viewer-action" onClick={viewOriginal}>View original anyway{large ? ` (${formatBytes(item.size)})` : ""}</button>}</div>;
}

function SkeletonViewer() { return <span className="skeleton-viewer" aria-label="Loading preview" />; }

function VideoPreview({ item, publicId }: { item: DeliveryItem; publicId: string }) {
  const [loading, setLoading] = useState(true); const [buffered, setBuffered] = useState(0);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; requestJson<{ streamUrl?: string; url?: string }>(`/api/public/shares/${encodeURIComponent(publicId)}/items/${encodeURIComponent(item.id)}/stream-ticket`, { method: "POST" }).then(result => { if (!cancelled) setStreamUrl(result.streamUrl || result.url || null); }).catch(() => { if (!cancelled) setStreamUrl(item.streamUrl || null); }); return () => { cancelled = true; }; }, [item.id, item.streamUrl, publicId]);
  if (streamUrl) return <div className="video-preview">{loading && <span className="media-status">Opening video preview…</span>}<iframe src={streamUrl} title={item.name} onLoad={() => setLoading(false)} allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowFullScreen /></div>;
  if (!item.previewUrl) return <EmptyState title={item.previewStatus === "processing" ? "Video preview is being prepared" : "Preview unavailable"} detail="You can still download the original video." />;
  return <div className="video-preview">{(loading || item.previewStatus === "processing") && <span className="media-status">{buffered ? `Buffering preview… ${buffered}%` : "Preparing video preview…"}</span>}<video src={item.previewUrl} poster={item.thumbnailUrl} controls autoPlay playsInline preload="metadata" onLoadStart={() => setLoading(true)} onCanPlay={() => setLoading(false)} onPlaying={() => setLoading(false)} onProgress={event => { const video = event.currentTarget; if (video.duration && video.buffered.length) setBuffered(Math.min(100, Math.round((video.buffered.end(video.buffered.length - 1) / video.duration) * 100))); }} /></div>;
}

function Thumbnail({ item }: { item: DeliveryItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="file-kind">{iconFor(item)}</span>;
  return <img src={item.thumbnailUrl} loading="lazy" decoding="async" alt="" onError={() => setFailed(true)} />;
}
