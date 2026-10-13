import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadOperationsNativeData,
  loadOperationsNativeFolder,
  type OperationsNativeDataDiscovery,
  type OperationsNativeDataListing,
} from "./operations-native-data-api";

type BrowserView =
  | { kind: "deliveries"; data: OperationsNativeDataDiscovery }
  | { kind: "folder"; data: OperationsNativeDataListing };

type BrowserPhase = "idle" | "loading" | "ready" | "denied" | "error";

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "status");
    return descriptor && "value" in descriptor && typeof descriptor.value === "number"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function sameBreadcrumbs(left: OperationsNativeDataListing["breadcrumbs"], right: OperationsNativeDataListing["breadcrumbs"]): boolean {
  return left.length === right.length && left.every((crumb, index) => {
    const other = right[index];
    // Opaque selectors are freshly encrypted for each response. Names and
    // depth describe the same path; the newest response supplies fresh IDs.
    return other?.name === crumb.name;
  });
}

function appendDiscovery(current: OperationsNativeDataDiscovery, page: OperationsNativeDataDiscovery): OperationsNativeDataDiscovery {
  return { ...page, items: [...current.items, ...page.items] };
}

function appendListing(current: OperationsNativeDataListing, page: OperationsNativeDataListing): OperationsNativeDataListing {
  if (page.folderId !== current.folderId || !sameBreadcrumbs(current.breadcrumbs, page.breadcrumbs))
    throw new Error("folder-page-mismatch");
  return {
    ...page,
    folders: [...current.folders, ...page.folders],
    files: [...current.files, ...page.files],
  };
}

export function OperationsNativeDataBrowser() {
  const [activated, setActivated] = useState(false);
  const [phase, setPhase] = useState<BrowserPhase>("idle");
  const [view, setView] = useState<BrowserView | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const clearPrivateData = useCallback(() => {
    setView(null);
    setLoadingMore(false);
    setPageError(false);
  }, []);

  const startRequest = useCallback(() => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    return { controller, sequence: ++requestSequence.current };
  }, []);

  const isCurrent = useCallback((sequence: number, controller: AbortController) =>
    requestSequence.current === sequence && activeController.current === controller && !controller.signal.aborted, []);

  const fail = useCallback((error: unknown, append: boolean, sequence: number, controller: AbortController) => {
    if (!isCurrent(sequence, controller)) return;
    activeController.current = null;
    setLoadingMore(false);
    const status = errorStatus(error);
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      clearPrivateData();
      setPhase("denied");
    } else if (append) {
      setPageError(true);
    } else {
      clearPrivateData();
      setPhase("error");
    }
  }, [clearPrivateData, isCurrent]);

  const openDeliveries = useCallback(async (current?: OperationsNativeDataDiscovery) => {
    const append = current !== undefined;
    const cursor = current?.page.nextCursor;
    if (append && cursor === null) return;
    const { controller, sequence } = startRequest();
    setPageError(false);
    if (append) setLoadingMore(true);
    else {
      clearPrivateData();
      setPhase("loading");
    }
    try {
      const page = await loadOperationsNativeData(cursor, controller.signal);
      if (!isCurrent(sequence, controller)) return;
      const data = current ? appendDiscovery(current, page) : page;
      activeController.current = null;
      setView({ kind: "deliveries", data });
      setLoadingMore(false);
      setPhase("ready");
    } catch (error) {
      fail(error, append, sequence, controller);
    }
  }, [clearPrivateData, fail, isCurrent, startRequest]);

  const openFolder = useCallback(async (folderId: string, current?: OperationsNativeDataListing) => {
    const append = current !== undefined;
    const cursor = current?.cursor;
    if (append && cursor === null) return;
    const { controller, sequence } = startRequest();
    setPageError(false);
    if (append) setLoadingMore(true);
    else {
      setView(null);
      setPhase("loading");
    }
    try {
      const page = await loadOperationsNativeFolder(folderId, cursor, controller.signal);
      if (!isCurrent(sequence, controller)) return;
      const data = current ? appendListing(current, page) : page;
      activeController.current = null;
      setView({ kind: "folder", data });
      setLoadingMore(false);
      setPhase("ready");
    } catch (error) {
      fail(error, append, sequence, controller);
    }
  }, [fail, isCurrent, startRequest]);

  const begin = useCallback(() => {
    setActivated(true);
    void openDeliveries();
  }, [openDeliveries]);

  useEffect(() => {
    if (!activated) return;
    const revalidate = () => {
      clearPrivateData();
      setPhase("loading");
      void openDeliveries();
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [activated, clearPrivateData, openDeliveries]);

  useEffect(() => () => {
    ++requestSequence.current;
    activeController.current?.abort();
    activeController.current = null;
  }, []);

  const delivery = view?.kind === "deliveries" ? view.data : null;
  const listing = view?.kind === "folder" ? view.data : null;

  return <section className="portal-card" aria-labelledby="operations-shared-deliveries-heading">
    <h2 id="operations-shared-deliveries-heading">Shared deliveries</h2>
    {phase === "idle" && <>
      <p>Browse files shared through your current Operations access.</p>
      <button type="button" className="button-orange" onClick={begin}>Browse shared deliveries</button>
    </>}
    {phase === "loading" && <p role="status" aria-live="polite">Checking your current delivery access…</p>}
    {phase === "denied" && <div className="portal-inline-error" role="alert">
      <p>Your shared delivery access could not be verified. Sign in again or refresh access.</p>
      <button type="button" className="button-ghost" onClick={begin}>Refresh access</button>
    </div>}
    {phase === "error" && <div className="portal-inline-error" role="alert">
      <p>Shared deliveries are temporarily unavailable.</p>
      <button type="button" className="button-ghost" onClick={begin}>Retry</button>
    </div>}
    {phase === "ready" && delivery && <div className="portal-file-list">
      <div className="portal-page-heading-action">
        <p>{delivery.items.length === 0 ? "No shared deliveries are currently available." : "Choose a delivery to browse its folders and files."}</p>
        <button type="button" className="button-ghost" onClick={begin}>Refresh</button>
      </div>
      {delivery.items.map((item, index) => <button type="button" className="portal-folder-row" key={`${item.id}:${index}`} onClick={() => void openFolder(item.id)}>
        <span className="portal-file-icon" aria-hidden="true">DIR</span>
        <span><strong>{item.displayName}</strong><small>Shared delivery</small></span>
        <span aria-hidden="true">›</span>
      </button>)}
      {delivery.page.nextCursor && <div className="portal-load-more">
        <button type="button" className="button-ghost" disabled={loadingMore} onClick={() => void openDeliveries(delivery)}>
          {loadingMore ? "Loading…" : "Load more deliveries"}
        </button>
      </div>}
      {pageError && <div className="portal-inline-error" role="alert">
        <p>More deliveries could not be loaded.</p>
        <button type="button" className="button-ghost" onClick={() => void openDeliveries(delivery)}>Retry page</button>
      </div>}
    </div>}
    {phase === "ready" && listing && <div className="portal-file-list">
      <div className="portal-page-heading-action">
        <p>Files in your selected shared delivery.</p>
        <button type="button" className="button-ghost" onClick={begin}>Refresh access</button>
      </div>
      <nav className="portal-file-breadcrumbs" aria-label="Shared delivery folders">
        <ol>
          <li><button type="button" onClick={begin}>All deliveries</button></li>
          {listing.breadcrumbs.map((crumb, index) => <li key={`${crumb.id}:${index}`}>
            {index === listing.breadcrumbs.length - 1
              ? <span aria-current="page">{crumb.name}</span>
              : <button type="button" onClick={() => void openFolder(crumb.id)}>{crumb.name}</button>}
          </li>)}
        </ol>
      </nav>
      {listing.folders.length === 0 && listing.files.length === 0 && <p>No files are available in this folder.</p>}
      {listing.folders.map((folder, index) => <button type="button" className="portal-folder-row" key={`${folder.id}:${index}`} onClick={() => void openFolder(folder.id)}>
        <span className="portal-file-icon" aria-hidden="true">DIR</span>
        <span><strong>{folder.name}</strong><small>Folder</small></span>
        <span aria-hidden="true">›</span>
      </button>)}
      {listing.files.map((file, index) => <div className="portal-file-row" key={`${file.id}:${index}`}>
        <span className="portal-file-icon" aria-hidden="true">{file.kind.slice(0, 4).toUpperCase()}</span>
        <div><strong>{file.name}</strong><span>{file.size.toLocaleString()} bytes</span></div>
        <div className="portal-file-actions">
          {file.previewPath && <a className="button-ghost" href={file.previewPath}>Preview</a>}
          {file.downloadPath && <a className="button-ghost" href={file.downloadPath} download>Download</a>}
        </div>
      </div>)}
      {listing.cursor && <div className="portal-load-more">
        <button type="button" className="button-ghost" disabled={loadingMore} onClick={() => void openFolder(listing.folderId, listing)}>
          {loadingMore ? "Loading…" : "Load more files"}
        </button>
      </div>}
      {pageError && <div className="portal-inline-error" role="alert">
        <p>More files could not be loaded.</p>
        <button type="button" className="button-ghost" onClick={() => void openFolder(listing.folderId, listing)}>Retry page</button>
      </div>}
    </div>}
  </section>;
}
