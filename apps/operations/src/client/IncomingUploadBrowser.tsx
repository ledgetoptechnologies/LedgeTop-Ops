import { useEffect, useRef, useState } from "react";

export type IncomingBrowseRow = { id: string; name: string; contributor: string; status: string };
export type IncomingBrowseLoader = (query: string, cursor: string | undefined, signal: AbortSignal) => Promise<{ items: IncomingBrowseRow[]; nextCursor?: string }>;

export function IncomingUploadBrowser({ load, onInspect }: { load: IncomingBrowseLoader; onInspect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<IncomingBrowseRow[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = ++sequence.current;
    controller.current?.abort(); setRows([]); setCursor(undefined); setError(false); setBusy(true);
    const timer = window.setTimeout(() => {
      const request = new AbortController(); controller.current = request;
      load(query, undefined, request.signal).then(page => {
        if (current === sequence.current) { setRows(page.items); setCursor(page.nextCursor); }
      }).catch(cause => { if (current === sequence.current && cause?.name !== "AbortError") setError(true); })
        .finally(() => { if (current === sequence.current) setBusy(false); });
    }, 250);
    return () => { sequence.current++; window.clearTimeout(timer); controller.current?.abort(); };
  }, [query, revision, load]);
  const more = async () => {
    if (!cursor || busy) return;
    const current = ++sequence.current, request = new AbortController();
    controller.current?.abort(); controller.current = request; setBusy(true); setError(false);
    try {
      const page = await load(query, cursor, request.signal);
      if (current === sequence.current) { setRows(previous => [...previous, ...page.items]); setCursor(page.nextCursor); }
    } catch (cause) { if (current === sequence.current && (cause as Error)?.name !== "AbortError") setError(true); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  return <section aria-label="Browse incoming uploads">
    <h3>Browse uploads</h3>
    <p className="muted">Uploads for the current incoming link. Inspect a record to check availability and download options.</p>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: "0.75rem", marginBlock: "1rem" }}>
      <label style={{ display: "grid", gap: "0.5rem", flex: "1 1 16rem" }}>Search files or contributors<input value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="button-ghost" onClick={() => setRevision(value => value + 1)}>Refresh uploads</button>
    </div>
    {error && <p role="alert">Uploads could not be loaded. Refresh or retry loading more.</p>}
    <p role="status">{busy ? "Loading uploads…" : `${rows.length} uploads shown${cursor ? " · more available" : ""}`}</p>
    {!busy && !error && !rows.length && <p>No matching uploads.</p>}
    <div className="incoming-upload-list">{rows.map(row => <div key={row.id}>
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>{row.name}</strong><small>{row.contributor} · {row.status}</small></div>
      <button type="button" className="button-ghost button-small" onClick={() => onInspect(row.id)}>Inspect upload</button>
    </div>)}</div>
    {cursor && <button type="button" className="button-ghost" disabled={busy} onClick={more}>Load more uploads</button>}
  </section>;
}
