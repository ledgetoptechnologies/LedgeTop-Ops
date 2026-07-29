import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface DropboxImportDialogProps {
  /** Current R2 prefix where files will be imported to */
  destinationPrefix: string;
  /** Whether the user has upload permission */
  canUpload: boolean;
  onClose: () => void;
  /** Called when an import job is successfully started */
  onStarted?: () => void;
}

interface BrowseResult {
  entries: Array<{
    name: string;
    pathDisplay?: string;
    ".tag": "file" | "folder";
    size?: number;
  }>;
  cursor?: string;
  hasMore: boolean;
}

interface ImportJobStatus {
  job: {
    id: string;
    status: string;
    file_count: number;
    processed_files: number;
    succeeded_files: number;
    failed_files: number;
    total_bytes: number;
    processed_bytes: number;
    error_message: string | null;
  };
  items: Array<{
    id: string;
    dropbox_path: string;
    destination_key: string;
    size: number;
    status: string;
    downloaded_bytes: number;
    uploaded_bytes: number;
    error_message: string | null;
  }>;
}

export function DropboxImportDialog({ destinationPrefix, canUpload, onClose, onStarted }: DropboxImportDialogProps) {
  const [phase, setPhase] = useState<"connect" | "browse" | "importing" | "done">("connect");
  const [authorizationId, setAuthorizationId] = useState<string>("");
  const [browsePath, setBrowsePath] = useState("");
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [conflictMode, setConflictMode] = useState<"autorename" | "skip" | "replace" | "fail">("autorename");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobStatus, setJobStatus] = useState<ImportJobStatus | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  // Check for OAuth callback in URL (delivered via redirect from the Worker callback)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const auth = params.get("dropboxImportAuthorization");
    if (auth) {
      setAuthorizationId(auth);
      setPhase("browse");
      // Clean the URL
      const url = new URL(location.href);
      url.searchParams.delete("dropboxImportAuthorization");
      history.replaceState(null, "", url.toString());
    }
  }, []);

  async function connect() {
    setBusy(true); setError("");
    try {
      const result = await api<{ authorizationUrl: string }>("/api/dropbox-import/oauth/start", { method: "POST", body: "{}" });
      // Open OAuth in a popup
      const popup = window.open(result.authorizationUrl, "ltds-dropbox-import", "popup,width=620,height=720");
      if (!popup) throw new Error("Your browser blocked the authorization window. Allow pop-ups and try again.");
      // Poll for the popup to be redirected back to our app with the authorization parameter
      const checkInterval = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkInterval);
          setBusy(false);
          // If we didn't get the auth ID from the popup, the user may have closed it
          if (!authorizationId) {
            // Stay on connect phase, don't show error (user may have just closed it)
          }
        }
        try {
          const popupUrl = popup.location.href;
          if (popupUrl && popupUrl.includes("dropboxImportAuthorization=")) {
            const params = new URLSearchParams(popup.location.search);
            const auth = params.get("dropboxImportAuthorization");
            if (auth) {
              clearInterval(checkInterval);
              setAuthorizationId(auth);
              setPhase("browse");
              try { popup.close(); } catch { /* cross-origin */ }
              setBusy(false);
            }
          }
        } catch {
          // Cross-origin -- popup is still on Dropbox's domain, keep waiting
        }
      }, 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect to Dropbox.");
      setBusy(false);
    }
  }

  async function browse(path: string) {
    setBusy(true); setError(""); setBrowsePath(path);
    try {
      const result = await api<BrowseResult>("/api/dropbox-import/browse", {
        method: "POST",
        body: JSON.stringify({ authorizationId, path }),
      });
      setBrowseResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not browse Dropbox.");
    } finally { setBusy(false); }
  }

  async function startImport() {
    if (!selectedPath) { setError("Select a Dropbox folder to import."); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ id: string; status: string }>("/api/dropbox-import/jobs", {
        method: "POST",
        body: JSON.stringify({
          authorizationId,
          dropboxPath: selectedPath,
          destinationPrefix,
          conflictMode,
        }),
      });
      setJobId(result.id);
      setPhase("importing");
      onStarted?.();
      // Start polling for status
      void pollStatus(result.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the import.");
    } finally { setBusy(false); }
  }

  async function pollStatus(id: string) {
    for (let attempt = 0; attempt < 1440; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const status = await api<ImportJobStatus>(`/api/dropbox-import/jobs/${encodeURIComponent(id)}`);
        setJobStatus(status);
        if (["completed", "failed", "cancelled", "partial", "expired"].includes(status.job.status)) {
          setPhase("done");
          return;
        }
      } catch { /* transient error, keep polling */ }
    }
  }

  async function cancelJob() {
    if (!jobId) return;
    setBusy(true); setError("");
    try {
      await api(`/api/dropbox-import/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel the import.");
    } finally { setBusy(false); }
  }

  const percent = jobStatus && jobStatus.job.total_bytes > 0
    ? Math.min(100, Math.round(jobStatus.job.processed_bytes / jobStatus.job.total_bytes * 100))
    : jobStatus && jobStatus.job.file_count > 0
    ? Math.min(100, Math.round(jobStatus.job.processed_files / jobStatus.job.file_count * 100))
    : null;

  return <div className="cloud-transfer-backdrop" onMouseDown={event => {
    if (event.currentTarget === event.target && !busy) onClose();
  }}>
    <div ref={dialog} className="cloud-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="dropbox-import-title" tabIndex={-1}>
      <header>
        <div><span className="eyebrow">Dropbox import</span><h2 id="dropbox-import-title">Import from Dropbox</h2></div>
        <button type="button" className="button-ghost button-small" onClick={onClose} disabled={busy} aria-label="Close">Close</button>
      </header>

      {phase === "connect" && <div className="cloud-transfer-setup">
        <p>Connect your Dropbox account to import files directly into R2. Files are copied server-side without downloading to your device.</p>
        <p className="cloud-transfer-note">Destination: <code>{destinationPrefix}</code></p>
        <button type="button" className="button-orange" disabled={busy || !canUpload} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect Dropbox"}
        </button>
        {!canUpload && <p className="bulk-error">You need upload permission to import files.</p>}
      </div>}

      {phase === "browse" && <div className="cloud-transfer-setup">
        <p>Connected to Dropbox. Browse and select a folder to import.</p>
        <div className="dropbox-browse-bar">
          <input value={browsePath} onChange={e => setBrowsePath(e.target.value)} placeholder="Dropbox path (e.g. /Projects/Client A)" />
          <button className="button-ghost button-small" disabled={busy} onClick={() => void browse(browsePath)}>Browse</button>
        </div>
        {browseResult && <div className="dropbox-browse-results">
          {browseResult.entries.map(entry => (
            <label key={entry.pathDisplay || entry.name} className={entry[".tag"] === "folder" ? "dropbox-folder" : "dropbox-file"}>
              <input
                type="radio"
                name="dropbox-selection"
                checked={selectedPath === (entry.pathDisplay || entry.name)}
                onChange={() => setSelectedPath(entry.pathDisplay || entry.name)}
                disabled={entry[".tag"] !== "folder"}
              />
              <span>{entry[".tag"] === "folder" ? "📁" : "📄"} {entry.name}</span>
              {entry.size && <small>{formatBytes(entry.size)}</small>}
            </label>
          ))}
          {browseResult.hasMore && <button className="button-ghost button-small" disabled={busy} onClick={() => void browse(browsePath)}>Load more</button>}
        </div>}
        <label className="cloud-conflict-policy">If a file already exists
          <select value={conflictMode} onChange={e => setConflictMode(e.target.value as typeof conflictMode)}>
            <option value="autorename">Keep both files</option>
            <option value="skip">Skip existing</option>
            <option value="replace">Replace existing</option>
            <option value="fail">Stop on conflict</option>
          </select>
        </label>
        <button type="button" className="button-orange" disabled={busy || !selectedPath} onClick={() => void startImport()}>
          {busy ? "Starting…" : `Import ${selectedPath ? `"${selectedPath.split("/").pop()}"` : ""}`}
        </button>
      </div>}

      {phase === "importing" && <div className="cloud-transfer-status" aria-live="polite">
        <div className="cloud-transfer-summary"><strong>Importing files</strong><span>Destination: {destinationPrefix}</span></div>
        <div className={`progress-track${percent === null ? " pending" : ""}`}>
          <span style={{ width: `${percent ?? 35}%` }} />
        </div>
        <p>{jobStatus ? `${jobStatus.job.processed_files || 0} of ${jobStatus.job.file_count || 0} files processed` : "Preparing your files…"}</p>
        {jobStatus && jobStatus.items.length > 0 && <ul className="cloud-transfer-results">
          {jobStatus.items.slice(0, 20).map(item => <li key={item.id} data-status={item.status}>
            <span>{item.dropbox_path.split("/").pop()}</span>
            <strong>{item.status}</strong>
            {item.error_message && <small>{item.error_message}</small>}
          </li>)}
        </ul>}
        <button type="button" className="button-ghost" disabled={busy} onClick={() => void cancelJob()}>Cancel remaining</button>
      </div>}

      {phase === "done" && <div className="cloud-transfer-status">
        <div className="cloud-transfer-summary">
          <strong>{jobStatus?.job.status === "completed" ? "Import complete" : jobStatus?.job.status === "partial" ? "Partially complete" : jobStatus?.job.status === "cancelled" ? "Import cancelled" : "Import failed"}</strong>
          <span>{jobStatus ? `${jobStatus.job.succeeded_files} succeeded, ${jobStatus.job.failed_files} failed` : ""}</span>
        </div>
        {jobStatus?.job.error_message && <p className="bulk-error">{jobStatus.job.error_message}</p>}
        <button type="button" className="button-orange" onClick={onClose}>Done</button>
      </div>}

      {error && <p className="bulk-error" role="alert">{error}</p>}
    </div>
  </div>;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}