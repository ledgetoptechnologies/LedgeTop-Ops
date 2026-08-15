import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BRAND, type DeliveryItem, type DeliveryLocationCollection, type DeliveryManifest } from "@ltds/shared";
import { Brand, EmptyState, Loading } from "@ltds/ui";
import {
  pollBulkDownload,
  requestJson,
  type BulkDownloadResponse,
  type RequestError,
} from "./bulk-download";
import { deliveryApiBase, deliveryBrowsePath, openDeliveryRoute, parseDeliveryBrowseState, parseDeliveryRoute, type DeliveryBrowseView, type DeliveryNamespace } from "./route";
import { CloudTransferDialog } from "./CloudTransferDialog";
import { notifyCloudTransferOpener, parseCloudTransferCallback, type CloudTransferProvider, type CloudTransferScope } from "./cloud-transfer";
import { constrainViewerOffset, pointerAnchoredOffset } from "./viewer-zoom";
import { ImageLocationMap, type ImageLocationMapAsset } from "./ImageLocationMap";

type Gate = "landing" | "loading" | "code" | "ready" | "error";
type ErrorView = "unavailable" | "invalid-link";
type DownloadSummaryState = { status: "loading" | "ready" | "unavailable"; fileCount?: number; totalBytes?: number | null; knownBytes?: number; unknownSizeCount?: number };
type MediaPatch = Partial<Pick<DeliveryItem, "thumbnailUrl" | "thumbnailState" | "thumbnailFallbackKind" | "previewStatus">> & { id: string };

const invalidLinkDetail = "This folder has been moved, removed, or is no longer being shared. Contact your Ledge Top Drone Services representative for a current delivery link.";

function isProtectedDeliveryFailure(caught: unknown): boolean {
  const status = (caught as RequestError).status;
  return status === 401 || status === 403 || status === 404 || status === 410;
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

function downloadSummaryText(summary: DownloadSummaryState): string {
  if (summary.status === "loading") return "Calculating file count and size…";
  if (summary.status === "unavailable" || typeof summary.fileCount !== "number") return "File count and size unavailable";
  const count = `${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"}`;
  if (typeof summary.totalBytes === "number") return `${count} · ${formatBytes(summary.totalBytes)}`;
  const unknown = summary.unknownSizeCount || 0;
  return `${count} · Total size unavailable${unknown ? ` (${unknown} unknown)` : ""}`;
}

function iconFor(item: DeliveryItem): string {
  if (item.kind === "folder") return "Folder";
  if (item.kind === "image") return "Image";
  if (item.kind === "video") return "Video";
  if (item.kind === "pdf") return "PDF";
  return item.kind === "other" ? "File" : item.kind;
}

export function DeliveryApp({ namespace = "staff", initialRoute: consumedRoute }: {
  namespace?: DeliveryNamespace;
  initialRoute?: { publicId: string; secret: string };
}) {
  const initialRoute = useMemo(
    () => consumedRoute ?? parseDeliveryRoute(location.pathname, location.hash, namespace),
    [consumedRoute, namespace],
  );
  const initialBrowse = useMemo(() => parseDeliveryBrowseState(location.search, localStorage.getItem("ltds-delivery-view") === "list" ? "list" : "grid"), []);
  const [publicId, setPublicId] = useState(initialRoute.publicId);
  const [secret, setSecret] = useState(initialRoute.secret);
  const [gate, setGate] = useState<Gate>(initialRoute.publicId ? "loading" : "landing");
  const [error, setError] = useState("");
  const [errorView, setErrorView] = useState<ErrorView>("unavailable");
  const [manifest, setManifest] = useState<DeliveryManifest | null>(null);
  const [folder, setFolder] = useState(initialBrowse.folderId);
  const [view, setView] = useState<DeliveryBrowseView>(initialBrowse.view);
  const [preview, setPreview] = useState<DeliveryItem | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [downloadSummary, setDownloadSummary] = useState<DownloadSummaryState>({ status: "loading" });
  const [locationData, setLocationData] = useState<{ locations: DeliveryLocationCollection; mapboxPublicToken: string | null } | null>(null);
  const [locationLoaded, setLocationLoaded] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkRequestActive = useRef(false);
  // Keep recent folder manifests only for this open share session. This makes
  // back-navigation immediate without persisting any client delivery data.
  const manifestCache = useRef(new Map<string, DeliveryManifest>());
  const authorizedItems = useRef(new Map<string, DeliveryItem>());
  const navigationVersion = useRef(0);
  const navigationRequest = useRef<AbortController | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const mediaRequests = useRef(new Set<AbortController>());
  const [bulkError, setBulkError] = useState("");
  const [bulkProgress, setBulkProgress] = useState<{ status: string; percent: number | null; message?: string } | null>(null);
  const [cloudTransferScope, setCloudTransferScope] = useState<CloudTransferScope | null>(null);
  const cloudProviders = useMemo<CloudTransferProvider[]>(() => {
    const capabilities = manifest?.capabilities?.cloudTransfer;
    return [...(capabilities?.dropbox ? ["dropbox" as const] : []), ...(capabilities?.googleDrive ? ["google-drive" as const] : [])];
  }, [manifest]);
  const apiBase = useCallback((id: string) => deliveryApiBase(id, namespace), [namespace]);

  const fetchManifest = useCallback(async (id: string, folderId = "", cursor: string | null = null, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (folderId) params.set("folder", folderId);
    if (cursor) params.set("cursor", cursor);
    const query = params.size ? `?${params.toString()}` : "";
    return requestJson<DeliveryManifest>(`${apiBase(id)}/manifest${query}`, { signal });
  }, [apiBase]);

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

  const clearProtectedDelivery = useCallback((caught: unknown) => {
    navigationVersion.current += 1;
    navigationRequest.current?.abort();
    pageRequest.current?.abort();
    for (const request of mediaRequests.current) request.abort();
    mediaRequests.current.clear();
    manifestCache.current.clear();
    authorizedItems.current.clear();
    setManifest(null);
    setPreview(null);
    setLocationData(null);
    setLocationLoaded(false);
    setDownloadSummary({ status: "unavailable" });
    setFolderLoading(false);
    setPageLoading(false);
    showRequestError(caught);
  }, [showRequestError]);

  const cacheKey = useCallback((id: string, folderId = "") => `${id}\u0000${folderId}`, []);

  const rememberManifest = useCallback((id: string, folderId: string, data: DeliveryManifest) => {
    const key = cacheKey(id, folderId);
    const cache = manifestCache.current;
    // Bound memory use while retaining enough recently visited folders to make
    // normal browse/back navigation feel immediate.
    if (cache.has(key)) cache.delete(key);
    cache.set(key, data);
    data.items.forEach(item => { if (item.kind !== "folder") authorizedItems.current.set(item.id, item); });
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  }, [cacheKey]);

  const hydrateMedia = useCallback(async (id: string, folderId: string, cursor: string | null, version: number) => {
    const params = new URLSearchParams(); if (folderId) params.set("folder", folderId); if (cursor) params.set("cursor", cursor);
    const controller = new AbortController();
    mediaRequests.current.add(controller);
    try {
      const result = await requestJson<{ items: MediaPatch[] }>(`${apiBase(id)}/manifest/media?${params.toString()}`, { signal: controller.signal });
      if (version !== navigationVersion.current) return;
      setManifest(current => {
        if (!current || current.folder.id !== folderId) return current;
        const patches = new Map(result.items.map(item => [item.id, item]));
        const next = { ...current, items: current.items.map(item => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item) };
        rememberManifest(id, folderId, next);
        setPreview(active => active ? next.items.find(item => item.id === active.id) || null : null);
        return next;
      });
    } catch (caught) {
      if (!controller.signal.aborted && isProtectedDeliveryFailure(caught)) clearProtectedDelivery(caught);
      // Thumbnail and stream readiness are advisory; the authoritative listing remains usable.
    } finally {
      mediaRequests.current.delete(controller);
    }
  }, [apiBase, clearProtectedDelivery, rememberManifest]);

  const loadManifest = useCallback(async (id: string, folderId = "", fileId = "") => {
    const version = ++navigationVersion.current;
    const data = await fetchManifest(id, folderId);
    rememberManifest(id, folderId, data);
    setManifest(data); setFolder(folderId); setPreview(data.items.find(item => item.id === fileId && item.kind !== "folder") || null); setGate("ready");
    history.replaceState({ ltdsDelivery: true }, "", deliveryBrowsePath(id, { folderId, fileId: data.items.some(item => item.id === fileId && item.kind !== "folder") ? fileId : "", view: initialBrowse.view }, namespace));
    void hydrateMedia(id, folderId, null, version);
  }, [fetchManifest, hydrateMedia, initialBrowse.fileId, initialBrowse.view, namespace, rememberManifest]);

  const exchange = useCallback(async (accessCode?: string) => {
    if (accessCode === undefined) setGate("loading");
    setError("");
    try {
      const result = await openDeliveryRoute({ publicId, secret, accessCode }, {
        createSession: route => requestJson<{ publicId: string; canonicalPath: string }>(`${apiBase(route.publicId)}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: route.secret, accessCode: route.accessCode }),
        }),
        loadManifest: id => loadManifest(id, initialBrowse.folderId, initialBrowse.fileId),
      });
      if (!result) return;
      setPublicId(result.publicId); setSecret("");
    } catch (caught) {
      const value = caught as RequestError;
      if (value.status === 401 && (value.body?.code === "ACCESS_CODE_REQUIRED" || value.body?.code === "ACCESS_CODE_INVALID")) {
        setError(accessCode === undefined && value.body.code === "ACCESS_CODE_REQUIRED" ? "" : value.message);
        setGate("code");
        return;
      }
      showRequestError(caught);
    }
  }, [apiBase, initialBrowse.fileId, initialBrowse.folderId, initialBrowse.view, loadManifest, publicId, secret, showRequestError]);

  useEffect(() => {
    if (parseCloudTransferCallback(location.href)) {
      if (notifyCloudTransferOpener(location.href)) window.close();
      return;
    }
    if (publicId) void exchange();
  }, []); // Exchange the URL fragment once on first load, or complete an OAuth popup.

  const navigateToFolder = useCallback(async (folderId = "", options: { history?: "push" | "none"; fileId?: string; scroll?: boolean } = {}) => {
    const version = ++navigationVersion.current;
    navigationRequest.current?.abort();
    pageRequest.current?.abort();
    setPageLoading(false);
    for (const request of mediaRequests.current) request.abort();
    mediaRequests.current.clear();
    const controller = new AbortController();
    navigationRequest.current = controller;
    const cached = manifestCache.current.get(cacheKey(publicId, folderId));
    const historyMode = options.history ?? "push";
    const commitHistory = (data: DeliveryManifest) => {
      const authorized = data.items.find(item => item.id === options.fileId && item.kind !== "folder") || (options.fileId ? authorizedItems.current.get(options.fileId) : undefined);
      const fileId = authorized ? options.fileId || "" : "";
      if (historyMode === "push") history.pushState({ ltdsDelivery: true }, "", deliveryBrowsePath(publicId, { folderId, fileId, view }, namespace));
      setPreview(authorized || null);
    };
    setPreview(null);
    setSelectedItems(new Set());
    setNavigationError("");
    if (cached) {
      setManifest(cached); setFolder(folderId); setGate("ready");
      setFolderLoading(false); commitHistory(cached);
    } else {
      setFolderLoading(true);
    }
    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      // Revalidate even cached folders in the background. The current view is
      // shown right away, then updated if a sync changed the folder contents.
      const fresh = await fetchManifest(publicId, folderId, null, controller.signal);
      rememberManifest(publicId, folderId, fresh);
      if (version === navigationVersion.current) {
        setManifest(fresh); setFolder(folderId); setGate("ready"); setFolderLoading(false);
        if (!cached) commitHistory(fresh);
        else setPreview(fresh.items.find(item => item.id === options.fileId && item.kind !== "folder") || (options.fileId ? authorizedItems.current.get(options.fileId) : undefined) || null);
        void hydrateMedia(publicId, folderId, null, version);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      // A transient refresh failure should not blank a folder we already have.
      if (isProtectedDeliveryFailure(caught) && version === navigationVersion.current) {
        clearProtectedDelivery(caught);
      } else if (!cached && version === navigationVersion.current) {
        setFolderLoading(false);
        if (manifest) setNavigationError("That folder could not be opened. Please try again."); else showRequestError(caught);
      }
    } finally {
      if (navigationRequest.current === controller) navigationRequest.current = null;
    }
  }, [cacheKey, clearProtectedDelivery, fetchManifest, hydrateMedia, manifest, namespace, publicId, rememberManifest, showRequestError, view]);

  const loadMore = useCallback(async () => {
    const cursor = manifest?.nextCursor;
    if (!cursor || pageLoading || pageRequest.current) return;
    const folderId = manifest.folder.id;
    const version = navigationVersion.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setPageLoading(true);
    setNavigationError("");
    try {
      const page = await fetchManifest(publicId, folderId, cursor, controller.signal);
      if (controller.signal.aborted || version !== navigationVersion.current) return;
      setManifest(current => {
        if (!current || current.folder.id !== folderId || current.nextCursor !== cursor) return current;
        const ids = new Set(current.items.map(item => item.id));
        const next = { ...current, items: [...current.items, ...page.items.filter(item => !ids.has(item.id))], nextCursor: page.nextCursor };
        rememberManifest(publicId, folderId, next);
        next.items.forEach(item => { if (item.kind !== "folder") authorizedItems.current.set(item.id, item); });
        return next;
      });
      void hydrateMedia(publicId, folderId, cursor, version);
    } catch (caught) {
      if (controller.signal.aborted || version !== navigationVersion.current) return;
      if (isProtectedDeliveryFailure(caught)) clearProtectedDelivery(caught);
      else setNavigationError("More items could not be loaded. Please try again.");
    } finally {
      if (pageRequest.current === controller) pageRequest.current = null;
      if (!controller.signal.aborted && version === navigationVersion.current) setPageLoading(false);
    }
  }, [clearProtectedDelivery, fetchManifest, hydrateMedia, manifest, pageLoading, publicId, rememberManifest]);

  useEffect(() => {
    const pop = () => {
      const route = parseDeliveryRoute(location.pathname, location.hash, namespace);
      if (!publicId || route.publicId !== publicId) return;
      const next = parseDeliveryBrowseState(location.search, view);
      setView(next.view); localStorage.setItem("ltds-delivery-view", next.view);
      void navigateToFolder(next.folderId, { history: "none", fileId: next.fileId, scroll: false });
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [namespace, navigateToFolder, publicId, view]);

  useEffect(() => {
    if (gate !== "ready" || !publicId) return;
    const controller = new AbortController(); setDownloadSummary({ status: "loading" });
    const params = manifest?.folder.id ? `?folder=${encodeURIComponent(manifest.folder.id)}` : "";
    requestJson<{ fileCount: number; totalBytes: number | null; knownBytes: number; unknownSizeCount: number }>(`${apiBase(publicId)}/download-summary${params}`, { signal: controller.signal })
      .then(summary => setDownloadSummary({ status: "ready", ...summary }))
      .catch(error => {
        if (controller.signal.aborted) return;
        if (isProtectedDeliveryFailure(error)) clearProtectedDelivery(error);
        else setDownloadSummary({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [apiBase, clearProtectedDelivery, gate, manifest?.folder.id, publicId]);

  useEffect(() => {
    if (gate !== "ready" || !publicId) return;
    const controller = new AbortController(); setLocationData(null); setLocationLoaded(false);
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    requestJson<{ locations: DeliveryLocationCollection; mapboxPublicToken: string | null }>(`${apiBase(publicId)}/locations${params}`, { signal: controller.signal })
      .then(setLocationData)
      .catch(error => {
        if (controller.signal.aborted) return;
        if (isProtectedDeliveryFailure(error)) clearProtectedDelivery(error);
        else setLocationData({ locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null });
      })
      .finally(() => { if (!controller.signal.aborted) setLocationLoaded(true); });
    return () => controller.abort();
  }, [apiBase, clearProtectedDelivery, folder, gate, publicId]);

  function changeView(next: DeliveryBrowseView) {
    setView(next); localStorage.setItem("ltds-delivery-view", next);
    history.pushState({ ltdsDelivery: true }, "", deliveryBrowsePath(publicId, { folderId: folder, fileId: preview?.id || "", view: next }, namespace));
  }
  async function openFolder(item: DeliveryItem) { await navigateToFolder(item.id); }
  function openPreview(item: DeliveryItem) {
    authorizedItems.current.set(item.id, item);
    setPreview(item);
    history.pushState({ ltdsDelivery: true }, "", deliveryBrowsePath(publicId, { folderId: folder, fileId: item.id, view }, namespace));
  }
  function closePreview() {
    setPreview(null);
    history.pushState({ ltdsDelivery: true }, "", deliveryBrowsePath(publicId, { folderId: folder, fileId: "", view }, namespace));
  }

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
    if (bulkRequestActive.current || (!all && selectedItems.size === 0)) return;
    bulkRequestActive.current = true;
    setBulkBusy(true); setBulkError(""); setBulkProgress({ status: "Preparing download", percent: null });
    try {
      let body = await requestJson<BulkDownloadResponse>(`${apiBase(publicId)}/bulk-download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(all ? (manifest?.folder.id ? { items: [manifest.folder.id] } : { all: true }) : { items: [...selectedItems] }),
      });
      const statusUrl = body.statusUrl || body.progressUrl;
      if (!body.downloadUrl && statusUrl) {
        body = await pollBulkDownload(body, statusUrl, { onProgress: status => {
          const calculated = status.totalBytes && typeof status.processedBytes === "number" ? Math.min(100, Math.round(status.processedBytes / status.totalBytes * 100)) : null;
          const percent = typeof status.progress === "number" ? status.progress : typeof status.percent === "number" ? status.percent : calculated;
          setBulkProgress({ status: status.message || (status.status === "ready" || status.status === "complete" ? "Download ready" : "Building ZIP"), percent });
        } });
      }
      const ticket = body.ticket || body.downloadTicket;
      const downloadUrl = body.downloadUrl || (ticket ? `${apiBase(publicId)}/bulk-download/${encodeURIComponent(ticket)}` : "");
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
      bulkRequestActive.current = false;
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
    {locationData && locationData.locations.points.length > 0 && <ImageLocationMap
      token={locationData?.mapboxPublicToken || null}
      locations={locationLoaded ? locationData?.locations || { points: [], imageCount: 0, truncated: false } : null}
      scopeLabel="this shared delivery"
      loadAsset={async assetRef => {
        const params = folder ? `?folder=${encodeURIComponent(folder)}` : "";
        const result = await requestJson<{ item: ImageLocationMapAsset }>(`${apiBase(publicId)}/locations/${encodeURIComponent(assetRef)}${params}`);
        authorizedItems.current.set(result.item.id, result.item);
        return result.item;
      }}
      openAsset={asset => openPreview(asset)}
    />}
    <section className="delivery-browser">
      {folderLoading && <div className="folder-loading" role="status" aria-live="polite">Opening folder…</div>}
      <div className="browser-toolbar">
        <nav className="breadcrumbs" aria-label="Folder path">
          <button onClick={() => void navigateToFolder()}>All files</button>
          {manifest.folder.breadcrumbs.map(crumb => <span key={crumb.id}><b>/</b><button onClick={() => void navigateToFolder(crumb.id)}>{crumb.name}</button></span>)}
        </nav>
        <div className="view-switch" aria-label="View style"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")}>Grid</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")}>List</button></div>
      </div>
      {namespace === "staff" && <div className={`download-toolbar${selectionMode ? " selection-mode" : ""}`} aria-label="Download files">
        <button className={selectionMode ? "button-orange button-small" : "button-ghost button-small"} onClick={toggleSelectionMode}>{selectionMode ? "Done" : "Select"}</button>
        {selectionMode && <label className="select-current"><input type="checkbox" checked={manifest.items.length > 0 && manifest.items.every(item => selectedItems.has(item.id))} onChange={toggleCurrentList} /> Select current list</label>}
        <span className="selection-count">{selectionMode ? (selectedItems.size ? `${selectedItems.size} selected` : "Click any card to select") : ""}</span>
        <div className="download-actions">
          {selectionMode && cloudProviders.length > 0 && <button className="button-ghost button-small" disabled={selectedItems.size === 0} onClick={() => setCloudTransferScope({ items: [...selectedItems] })}>Copy selected to cloud</button>}
          {!selectionMode && cloudProviders.length > 0 && <button className="button-ghost button-small" onClick={() => setCloudTransferScope({ all: true })}>Copy all to cloud</button>}
          {selectionMode && <button className="button-ghost button-small" disabled={bulkBusy || selectedItems.size === 0} onClick={() => void downloadBulk()}> {bulkBusy ? "Preparing…" : "Download selected"}</button>}
          <button className="button-orange button-small download-all-control" disabled={bulkBusy} onClick={() => void downloadBulk(true)}><span>{bulkBusy ? "Preparing…" : "Download all"}</span><small>{downloadSummaryText(downloadSummary)}</small></button>
        </div>
      </div>}
      {namespace === "client-delegated" && <div className="download-toolbar" role="note" aria-label="Bulk download availability">
        <span><strong>Download individual files</strong><small>Download all is not yet available for client-created links. Open or focus a file and use its Download action.</small></span>
      </div>}
      {navigationError && <p className="bulk-error" role="alert">{navigationError}</p>}
      {bulkError && <p className="bulk-error" role="alert">{bulkError}</p>}
      {bulkProgress && <BulkProgress progress={bulkProgress} />}
      {manifest.items.length === 0 ? <EmptyState title="This folder is empty" detail="New synced files will appear here automatically." /> : view === "grid" ?
        <div className="item-grid">{manifest.items.map(item => <ItemCard key={item.id} item={item} selectionMode={selectionMode} selected={selectedItems.has(item.id)} onToggle={toggleSelected} onFolder={openFolder} onPreview={openPreview} />)}</div> :
        <div className="item-list">{manifest.items.map(item => <ItemRow key={item.id} item={item} selectionMode={selectionMode} selected={selectedItems.has(item.id)} onToggle={toggleSelected} onFolder={openFolder} onPreview={openPreview} />)}</div>}
      {manifest.nextCursor && <div className="public-delivery-pagination"><button type="button" className="button-ghost" disabled={pageLoading} onClick={() => void loadMore()}>{pageLoading ? "Loading more..." : "Load more"}</button></div>}
      <footer>{manifest.items.length} item{manifest.items.length === 1 ? "" : "s"}{manifest.nextCursor ? " · More items are available" : ""}</footer>
    </section>
    {cloudTransferScope && <CloudTransferDialog publicId={publicId} scope={cloudTransferScope} enabledProviders={cloudProviders} onClose={() => setCloudTransferScope(null)} />}
    {preview && <Preview item={preview} items={manifest.items.filter(item => item.kind !== "folder")} publicId={publicId} namespace={namespace} onSelect={openPreview} onClose={closePreview} />}
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
    {item.kind === "video" && <span className="play">▶</span>}{item.kind === "video" && !item.thumbnailUrl && item.previewStatus === "processing" && <span className="media-status">Preparing preview…</span>}
  </button><div className="item-info"><strong title={item.name}>{item.name}</strong><span>{formatBytes(item.size)}{item.uploadedAt ? ` · ${new Date(item.uploadedAt).toLocaleDateString()}` : ""}</span></div>
    {!selectionMode && item.downloadUrl && <a className="download-chip" href={item.downloadUrl} aria-label={`Download ${item.name}`}>Download</a>}
  </article>;
}

function ItemRow({ item, selectionMode, selected, onToggle, onFolder, onPreview }: { item: DeliveryItem; selectionMode: boolean; selected: boolean; onToggle: (itemId: string) => void; onFolder: (item: DeliveryItem) => void; onPreview: (item: DeliveryItem) => void }) {
  return <div className={`item-row${selected ? " selected" : ""}${selectionMode ? " selectable" : ""}`} onClick={selectionMode ? () => onToggle(item.id) : undefined}><button className="row-name" onClick={event => { event.stopPropagation(); selectionMode ? onToggle(item.id) : item.kind === "folder" ? void onFolder(item) : onPreview(item); }}><span>{item.kind === "folder" ? "▰" : "▧"}</span><strong>{item.name}</strong></button><span>{formatBytes(item.size)}</span><span>{item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : "—"}</span>{!selectionMode && item.downloadUrl ? <a href={item.downloadUrl} aria-label={`Download ${item.name}`}>Download</a> : <span />}</div>;
}

function Preview({ item, items, publicId, namespace, onSelect, onClose }: { item: DeliveryItem; items: DeliveryItem[]; publicId: string; namespace: DeliveryNamespace; onSelect: (item: DeliveryItem) => void; onClose: () => void }) {
  const index = items.findIndex(candidate => candidate.id === item.id);
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const filmstripItems = index < 0 ? [] : items.slice(Math.max(0, index - 4), Math.min(items.length, index + 5));
  const activeFilmstripItem = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);
  useEffect(() => { activeFilmstripItem.current?.scrollIntoView({ block: "nearest", inline: "center" }); }, [item.id]);
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
  return <div className="preview-backdrop" onPointerDown={event => { if (event.currentTarget === event.target) onClose(); }}><section ref={dialog} tabIndex={-1} className="preview-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),audio[controls],video[controls],[tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><header><strong>{item.name}</strong>{index >= 0 && <span className="preview-position" aria-live="polite">{index + 1} of {items.length}</span>}<DownloadOriginal item={item} compact /><button className="button-ghost button-small" onClick={onClose}>Close</button></header><div className="preview-stage">
    <button className="preview-nav previous" disabled={!previous} aria-label="Previous file" onClick={() => previous && onSelect(previous)}>‹</button>
    <div className="preview-media">{item.kind === "image" ? <ImagePreview key={item.id} item={item} /> : item.kind === "pdf" ? <PdfPreview key={item.id} item={item} /> : item.kind === "video" ? <VideoPreview key={item.id} item={item} publicId={publicId} namespace={namespace} /> : item.kind === "audio" && (item.sourceUrl || item.previewUrl) ? <audio src={item.sourceUrl || item.previewUrl} controls /> : item.kind === "text" && (item.sourceUrl || item.previewUrl) ? <iframe src={item.sourceUrl || item.previewUrl} title={item.name} loading="lazy" /> : <PreparedPlaceholder item={item} />}</div>
    <button className="preview-nav next" disabled={!next} aria-label="Next file" onClick={() => next && onSelect(next)}>›</button>
  </div>{filmstripItems.length > 0 && <div className="preview-filmstrip" aria-label="Nearby files in this folder">{filmstripItems.map(candidate => {const active=candidate.id===item.id;return <button key={candidate.id} ref={active?activeFilmstripItem:null} className={active?"active":""} aria-current={active?"true":undefined} title={candidate.name} onClick={() => onSelect(candidate)}>{candidate.thumbnailUrl ? <Thumbnail item={candidate} /> : <span className="file-kind">{iconFor(candidate)}</span>}</button>})}</div>}</section></div>;
}

function ImagePreview({ item }: { item: DeliveryItem }) {
  const [failed, setFailed] = useState(!item.previewUrl); const [loaded, setLoaded] = useState(false);
  if (failed) return <PreparedPlaceholder item={item} />;
  return <ZoomableDeliveryImage src={item.previewUrl} alt={item.name} loading={!loaded} loaded={() => setLoaded(true)} failed={() => setFailed(true)} />;
}

function ZoomableDeliveryImage({ src, alt, loading, loaded, failed }: { src?: string; alt: string; loading: boolean; loaded: () => void; failed: () => void }) {
  const [scale, setScale] = useState(1); const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>()); const gesture = useRef<{ distance: number; scale: number } | null>(null);
  const fit = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
  useEffect(fit, [src]);
  const constrain = (value: number) => Math.min(20, Math.max(1, value));
  const pointDistance = () => {
    const [first, second] = [...pointers.current.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  };
  return <div className={`zoomable-delivery-image ${scale > 1 ? "zoomed" : ""}${loading ? " loading" : ""}`} aria-busy={loading}
    onWheel={event => {
      event.preventDefault();
      const next = constrain(scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18)); const bounds = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
      setScale(next); setOffset(value => constrainViewerOffset(next, pointerAnchoredOffset(scale, next, value, point), bounds));
    }}
    onDoubleClick={fit}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pointers.current.size === 2) gesture.current = { distance: pointDistance(), scale }; }}
    onPointerMove={event => {
      const previous = pointers.current.get(event.pointerId); if (!previous) return;
      const current = { x: event.clientX, y: event.clientY }; const bounds = event.currentTarget.getBoundingClientRect(); pointers.current.set(event.pointerId, current);
      if (pointers.current.size === 2 && gesture.current) {
        const distance = pointDistance(); if (gesture.current.distance) { const next = constrain(gesture.current.scale * distance / gesture.current.distance); setScale(next); setOffset(value => constrainViewerOffset(next, value, bounds)); }
      } else if (scale > 1) {
        setOffset(value => constrainViewerOffset(scale, { x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }, bounds));
      }
    }}
    onPointerUp={event => { pointers.current.delete(event.pointerId); if (pointers.current.size < 2) gesture.current = null; }}
    onPointerCancel={event => { pointers.current.delete(event.pointerId); gesture.current = null; }}>
    {loading && <SkeletonViewer />}
    <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onLoad={loaded} onError={failed} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
    {scale > 1 && <button type="button" className="image-fit-control button-ghost button-small" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); fit(); event.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus(); }}>Fit</button>}
  </div>;
}

function PdfPreview({ item }: { item: DeliveryItem }) {
  const [status, setStatus] = useState<"checking" | "ready" | "failed">(item.sourceUrl ? "checking" : "failed"); const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!item.sourceUrl) { setStatus("failed"); return; }
    const controller = new AbortController();
    setStatus("checking"); setLoaded(false);
    fetch(item.sourceUrl, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then(response => setStatus(response.ok && response.headers.get("Content-Type")?.startsWith("application/pdf") ? "ready" : "failed"))
      .catch(error => { if (error instanceof DOMException && error.name === "AbortError") return; setStatus("failed"); });
    return () => controller.abort();
  }, [item.sourceUrl]);
  if (status === "failed" || !item.sourceUrl) return <PreparedPlaceholder item={item} />;
  if (status === "checking") return <div className="pdf-preview" aria-busy="true"><SkeletonViewer /></div>;
  return <div className="pdf-preview" aria-busy={!loaded}>{!loaded && <SkeletonViewer />}<iframe src={item.sourceUrl} title={item.name} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setStatus("failed")} /></div>;
}

function SkeletonViewer() { return <span className="skeleton-viewer" role="status" aria-label="Loading preview" />; }

function DownloadOriginal({ item, compact = false }: { item: DeliveryItem; compact?: boolean }) {
  if (!item.downloadUrl) return null;
  return <a className={compact ? "button button-orange button-small viewer-download-action" : "viewer-download"} href={item.downloadUrl} aria-label={`Download ${item.name}`}>Download original</a>;
}

function PreparedPlaceholder({ item }: { item: DeliveryItem }) {
  const rawExts = new Set(["dng","arw","cr2","cr3","crw","nef","raf","rw2","orf","pef","srw","3fr","rwl","srf","sr2","x3f"]);
  const ext = (item.name || "").split(".").pop()?.toLowerCase() || "";
  const isRaw = rawExts.has(ext);
  return <div className="prepared-placeholder"><img className="preview-brand-logo" src={BRAND.logoUrl} alt={BRAND.shortName} /><strong>{isRaw ? "This file type cannot be viewed in the browser" : "This file could not be displayed"}</strong><p>{isRaw ? "RAW photo files (DNG, ARW, etc.) require specialized software to view. Please download the file to open it." : "Your browser may not support this file format. The original file is still available to download."}</p><DownloadOriginal item={item} /></div>;
}

function VideoPreview({ item, publicId, namespace }: { item: DeliveryItem; publicId: string; namespace: DeliveryNamespace }) {
  const [loading, setLoading] = useState(true); const [ticketLoading, setTicketLoading] = useState(item.previewStatus === "ready");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; if (item.previewStatus !== "ready") { setTicketLoading(false); return () => { cancelled = true; }; } requestJson<{ streamUrl?: string; url?: string }>(`${deliveryApiBase(publicId, namespace)}/items/${encodeURIComponent(item.id)}/stream-ticket`, { method: "POST" }).then(result => { if (!cancelled) setStreamUrl(result.streamUrl || result.url || null); }).catch(() => { if (!cancelled) setStreamUrl(null); }).finally(() => { if (!cancelled) setTicketLoading(false); }); return () => { cancelled = true; }; }, [item.id, item.previewStatus, namespace, publicId]);
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
  if (failed) return <span className="media-placeholder file-type-placeholder" aria-label={`${iconFor(item)} preview unavailable`}><span className="file-kind" aria-hidden="true">{iconFor(item)}</span><small>No preview generated yet</small></span>;
  return <>{!loaded && <span className="thumbnail-skeleton" aria-hidden="true" />}<img src={item.thumbnailUrl} loading="lazy" decoding="async" alt="" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} /></>;
}
