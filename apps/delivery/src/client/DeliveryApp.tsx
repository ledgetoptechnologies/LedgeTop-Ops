import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeliveryItem, DeliveryManifest } from "@ltds/shared";
import { Brand, EmptyState, Loading } from "@ltds/ui";
import { openDeliveryRoute, parseDeliveryRoute } from "./route";

type Gate = "landing" | "loading" | "code" | "ready" | "error";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
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
  const [manifest, setManifest] = useState<DeliveryManifest | null>(null);
  const [folder, setFolder] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("ltds-delivery-view") === "list" ? "list" : "grid");
  const [preview, setPreview] = useState<DeliveryItem | null>(null);

  const loadManifest = useCallback(async (id: string, folderId = "") => {
    const query = folderId ? `?folder=${encodeURIComponent(folderId)}` : "";
    const data = await requestJson<DeliveryManifest>(`/api/public/shares/${encodeURIComponent(id)}/manifest${query}`);
    setManifest(data); setFolder(folderId); setGate("ready");
  }, []);

  const exchange = useCallback(async (accessCode?: string) => {
    setGate("loading"); setError("");
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
      const value = caught as Error & { status?: number; body?: { code?: string } };
      if (value.status === 401 && value.body?.code === "ACCESS_CODE_REQUIRED") { setGate("code"); return; }
      setError(value.message); setGate("error");
    }
  }, [loadManifest, publicId, secret]);

  useEffect(() => { if (publicId) void exchange(); }, []); // Exchange the URL fragment once on first load.

  function changeView(next: "grid" | "list") { setView(next); localStorage.setItem("ltds-delivery-view", next); }
  async function openFolder(item: DeliveryItem) { await loadManifest(publicId, item.id); window.scrollTo({ top: 0, behavior: "smooth" }); }

  if (gate === "landing") return <PublicFrame><DeliveryLanding /></PublicFrame>;
  if (gate === "loading") return <PublicFrame><Loading /></PublicFrame>;
  if (gate === "code") return <PublicFrame><AccessCodeForm onSubmit={exchange} error={error} /></PublicFrame>;
  if (gate === "error" || !manifest) return <PublicFrame><EmptyState title="Delivery unavailable" detail={error || "This link is invalid, expired, or has been revoked."} /></PublicFrame>;

  return <PublicFrame>
    <section className="delivery-heading">
      <div><span className="eyebrow">Secure client delivery</span><h1>{manifest.share.projectName}</h1><p>{manifest.share.clientName}</p></div>
      {manifest.share.expiresAt && <div className="expiry">Available through {new Date(manifest.share.expiresAt).toLocaleDateString()}</div>}
    </section>
    <section className="delivery-browser">
      <div className="browser-toolbar">
        <nav className="breadcrumbs" aria-label="Folder path">
          <button onClick={() => void loadManifest(publicId)}>All files</button>
          {manifest.folder.breadcrumbs.map(crumb => <span key={crumb.id}><b>/</b><button onClick={() => void loadManifest(publicId, crumb.id)}>{crumb.name}</button></span>)}
        </nav>
        <div className="view-switch" aria-label="View style"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")}>Grid</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")}>List</button></div>
      </div>
      {manifest.items.length === 0 ? <EmptyState title="This folder is empty" detail="New synced files will appear here automatically." /> : view === "grid" ?
        <div className="item-grid">{manifest.items.map(item => <ItemCard key={item.id} item={item} onFolder={openFolder} onPreview={setPreview} />)}</div> :
        <div className="item-list">{manifest.items.map(item => <ItemRow key={item.id} item={item} onFolder={openFolder} onPreview={setPreview} />)}</div>}
      <footer>{manifest.items.length} item{manifest.items.length === 1 ? "" : "s"}{manifest.nextCursor ? " · More items are available" : ""}</footer>
    </section>
    {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
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

function AccessCodeForm({ onSubmit, error }: { onSubmit: (code: string) => Promise<void>; error: string }) {
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="code-gate" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit(code); setBusy(false); }}>
    <span className="eyebrow">Confidential delivery</span><h1>Enter your access code</h1><p>This delivery requires the code supplied by Ledge Top Drone Services.</p>
    <label htmlFor="access-code">Access code</label><input id="access-code" autoComplete="one-time-code" minLength={8} required value={code} onChange={event => setCode(event.target.value)} />
    {error && <p className="form-error">{error}</p>}<button className="button-orange" disabled={busy}>{busy ? "Checking…" : "Open delivery"}</button>
  </form>;
}

function ItemCard({ item, onFolder, onPreview }: { item: DeliveryItem; onFolder: (item: DeliveryItem) => void; onPreview: (item: DeliveryItem) => void }) {
  const action = item.kind === "folder" ? () => void onFolder(item) : () => onPreview(item);
  return <article className="item-card"><button className="item-visual" onClick={action} aria-label={`${item.kind === "folder" ? "Open" : "Preview"} ${item.name}`}>
    {item.thumbnailUrl ? <img src={item.thumbnailUrl} loading="lazy" alt="" /> : item.kind === "folder" ? <span className="folder-shape" /> : <span className="file-kind">{iconFor(item)}</span>}
    {item.kind === "video" && <span className="play">▶</span>}
  </button><div className="item-info"><strong title={item.name}>{item.name}</strong><span>{formatBytes(item.size)}{item.uploadedAt ? ` · ${new Date(item.uploadedAt).toLocaleDateString()}` : ""}</span></div>
    {item.downloadUrl && <a className="download-chip" href={item.downloadUrl}>Download</a>}
  </article>;
}

function ItemRow({ item, onFolder, onPreview }: { item: DeliveryItem; onFolder: (item: DeliveryItem) => void; onPreview: (item: DeliveryItem) => void }) {
  return <div className="item-row"><button className="row-name" onClick={() => item.kind === "folder" ? void onFolder(item) : onPreview(item)}><span>{item.kind === "folder" ? "▰" : "▧"}</span><strong>{item.name}</strong></button><span>{formatBytes(item.size)}</span><span>{item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : "—"}</span>{item.downloadUrl ? <a href={item.downloadUrl}>Download</a> : <span />}</div>;
}

function Preview({ item, onClose }: { item: DeliveryItem; onClose: () => void }) {
  return <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section className="preview-dialog"><header><strong>{item.name}</strong>{item.downloadUrl && <a className="button button-orange button-small" href={item.downloadUrl}>Download</a>}<button className="button-ghost button-small" onClick={onClose}>Close</button></header><div className="preview-stage">
    {item.kind === "image" && item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : item.kind === "video" && item.streamUrl ? <iframe src={item.streamUrl} title={item.name} allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowFullScreen /> : item.kind === "video" && item.previewUrl ? <video src={item.previewUrl} controls autoPlay playsInline /> : item.kind === "audio" && item.previewUrl ? <audio src={item.previewUrl} controls autoPlay /> : (item.kind === "pdf" || item.kind === "text") && item.previewUrl ? <iframe src={item.previewUrl} title={item.name} /> : <EmptyState title="Preview unavailable" detail="Download this file to open it in its original application." />}
  </div></section></div>;
}
