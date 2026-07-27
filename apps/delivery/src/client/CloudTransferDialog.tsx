import { useEffect, useMemo, useRef, useState } from "react";
import {
  openCloudAuthorizationWindow,
  cancelCloudTransfer,
  cloudTransferBaseUrl,
  cloudTransferPercent,
  startCloudTransferAuthorization,
  failedCloudTransferItems,
  pollCloudTransfer,
  retryCloudTransfer,
  waitForCloudAuthorization,
  type CloudTransferConflictPolicy,
  type CloudTransferJob,
  type CloudTransferProvider,
  type CloudTransferScope,
} from "./cloud-transfer";

export interface CloudTransferDialogProps {
  publicId: string;
  scope: CloudTransferScope;
  enabledProviders: CloudTransferProvider[];
  onClose: () => void;
}

const PROVIDER_NAMES: Record<CloudTransferProvider, string> = {
  dropbox: "Dropbox",
  "google-drive": "Google Drive",
};

export function CloudTransferDialog({ publicId, scope, enabledProviders, onClose }: CloudTransferDialogProps) {
  const [provider, setProvider] = useState<CloudTransferProvider>(enabledProviders[0] || "dropbox");
  const [conflictPolicy, setConflictPolicy] = useState<CloudTransferConflictPolicy>("rename");
  const [job, setJob] = useState<CloudTransferJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement | null>(null);
  const percent = job ? cloudTransferPercent(job) : null;
  const failures = job ? failedCloudTransferItems(job) : [];
  const scopeLabel = "all" in scope ? "the full delivery" : `${scope.items.length} selected item${scope.items.length === 1 ? "" : "s"}`;
  const statusLabel = useMemo(() => {
    if (!job) return "";
    if (job.status === "authorization_required") return "Authorization required";
    if (job.status === "queued") return "Waiting to start";
    if (job.status === "running") return "Copying files";
    if (job.status === "completed") return "Copy complete";
    if (job.status === "cancelled") return "Remaining files cancelled";
    return "Copy failed";
  }, [job]);

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function follow(next: CloudTransferJob) {
    setJob(next);
    const final = await pollCloudTransfer(
      next,
      `${cloudTransferBaseUrl(publicId)}/${encodeURIComponent(next.id)}`,
      { onProgress: setJob },
    );
    setJob(final);
  }

  async function start() {
    setBusy(true); setError("");
    let popup: Window | null = null;
    try {
      popup = openCloudAuthorizationWindow();
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0" )).join("");
      const started = await startCloudTransferAuthorization(publicId, provider, { selection: scope, conflictMode: conflictPolicy, callbackNonce: nonce });
      popup.location.href = started.authorizationUrl;
      const authorized = await waitForCloudAuthorization(popup, { origin: window.location.origin, nonce, provider });
      try { popup.close(); } catch { /* The popup may already be closed. */ }
      await follow({ id: authorized.jobId, provider, status: "queued" });
    } catch (caught) {
      try { popup?.close(); } catch { /* Ignore cross-origin close failures. */ }
      setError(caught instanceof Error ? caught.message : "The copy could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true); setError("");
    try { setJob(await cancelCloudTransfer(publicId, job.id)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The copy could not be cancelled."); }
    finally { setBusy(false); }
  }

  async function retry() {
    if (!job) return;
    setBusy(true); setError("");
    try { await follow(await retryCloudTransfer(publicId, job.id)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The failed files could not be retried."); }
    finally { setBusy(false); }
  }

  return <div className="cloud-transfer-backdrop" onMouseDown={event => {
    if (event.currentTarget === event.target && !busy) onClose();
  }}>
    <div ref={dialog} className="cloud-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-transfer-title" tabIndex={-1}>
      <header>
        <div><span className="eyebrow">Cloud copy</span><h2 id="cloud-transfer-title">Copy {scopeLabel}</h2></div>
        <button type="button" className="button-ghost button-small" onClick={onClose} disabled={busy} aria-label="Close cloud copy">Close</button>
      </header>
      {!job ? <div className="cloud-transfer-setup">
        <fieldset>
          <legend>Choose a destination</legend>
          {enabledProviders.map(candidate => <label key={candidate}>
            <input type="radio" name="cloud-provider" value={candidate} checked={provider === candidate} onChange={() => setProvider(candidate)} />
            <span><strong>{PROVIDER_NAMES[candidate]}</strong><small>You will securely authorize your own account.</small></span>
          </label>)}
        </fieldset>
        <label className="cloud-conflict-policy">If a file already exists
          <select value={conflictPolicy} onChange={event => setConflictPolicy(event.target.value as CloudTransferConflictPolicy)}>
            <option value="rename">Keep both files</option>
            <option value="skip">Skip the existing file</option>
          </select>
        </label>
        <p className="cloud-transfer-note">Original files are copied individually and folders include their contents. Nothing is downloaded to this device.</p>
      </div> : <div className="cloud-transfer-status" aria-live="polite">
        <div className="cloud-transfer-summary"><strong>{statusLabel}</strong><span>{job.destinationName ? `Destination: ${job.destinationName}` : PROVIDER_NAMES[job.provider]}</span></div>
        <div className={`progress-track${percent === null ? " pending" : ""}`} aria-label={percent === null ? statusLabel : `${percent}% complete`}>
          <span style={{ width: `${percent ?? 35}%` }} />
        </div>
        <p>{job.message || (job.totalFiles ? `${job.processedFiles || 0} of ${job.totalFiles} files processed` : "Preparing your files…")}</p>
        {!!job.items?.length && <ul className="cloud-transfer-results">
          {job.items.map(item => <li key={item.id} data-status={item.status}><span>{item.name}</span><strong>{item.status}</strong>{item.message && <small>{item.message}</small>}</li>)}
        </ul>}
      </div>}
      {error && <p className="bulk-error" role="alert">{error}</p>}
      <footer>
        {!job && <button type="button" className="button-orange" disabled={busy || enabledProviders.length === 0} onClick={() => void start()}>{busy ? "Connecting…" : `Continue with ${PROVIDER_NAMES[provider]}`}</button>}
        {job && ["queued", "running"].includes(job.status) && <button type="button" className="button-ghost" disabled={busy} onClick={() => void cancel()}>Cancel remaining</button>}
        {job && failures.length > 0 && <button type="button" className="button-orange" disabled={busy} onClick={() => void retry()}>Retry failed files</button>}
        {job?.status === "completed" && <button type="button" className="button-orange" onClick={onClose}>Done</button>}
      </footer>
    </div>
  </div>;
}
