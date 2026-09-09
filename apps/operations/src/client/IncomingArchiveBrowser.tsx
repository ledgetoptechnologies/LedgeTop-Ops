import { useEffect, useRef, useState } from "react";

export type ArchiveEntry = { path: string; name: string; kind: "folder" | "file"; size?: number };
export type ArchivePage = { status: "ready" | "unavailable" | "pending" | "failed"; entries: ArchiveEntry[]; nextCursor?: string };
export type ArchiveLoader = (input: { path: string; cursor?: string; query: string; signal: AbortSignal }) => Promise<ArchivePage>;

export function IncomingArchiveBrowser({ uploadId, active, loader }: { uploadId: string; active: boolean; loader: ArchiveLoader }) {
  const [path, setPath] = useState(""), [query, setQuery] = useState(""), [page, setPage] = useState<ArchivePage>({ status: "pending", entries: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const pending = useRef<AbortController | null>(null), sequence = useRef(0);
  useEffect(() => { pending.current?.abort(); sequence.current++; setPath(""); setQuery(""); setLoadingMore(false); setPage({ status: active ? "pending" : "unavailable", entries: [] }); }, [uploadId, active]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!active) return;
    pending.current?.abort(); const current = ++sequence.current;
    setLoadingMore(false); setPage({ status: "pending", entries: [] });
    const timer = window.setTimeout(() => { const controller = new AbortController(); pending.current = controller;
      loader({ path, query, signal: controller.signal }).then(value => { if (current === sequence.current) setPage(value); }).catch(error => { if (current === sequence.current && error?.name !== "AbortError") setPage({ status: "failed", entries: [] }); });
    }, 250);
    return () => { window.clearTimeout(timer); pending.current?.abort(); sequence.current++; };
  }, [active, uploadId, path, query, loader]);
  const more = async () => { if (!page.nextCursor || loadingMore) return; setLoadingMore(true); pending.current?.abort(); const controller = new AbortController(), current = ++sequence.current; pending.current = controller; try { const value = await loader({ path, query, cursor: page.nextCursor, signal: controller.signal }); if (current === sequence.current) setPage(p => ({ ...value, entries: value.status === "ready" ? [...p.entries, ...value.entries] : [] })); } catch (error) { if (current === sequence.current && (error as Error)?.name !== "AbortError") setPage({ status: "failed", entries: [] }); } finally { if (current === sequence.current) setLoadingMore(false); } };
  if (!active || page.status === "unavailable") return <section aria-label="Incoming archive"><p role="status">Archive unavailable.</p></section>;
  const crumbs = path ? path.split("/").filter(Boolean) : [];
  return <section aria-label="Incoming archive" className="incoming-archive-browser">
    <h3>Archive contents</h3><p className="muted">Names and sizes only. Download the verified archive to open its files.</p>
    <nav aria-label="Archive breadcrumb"><button type="button" className="button-ghost button-small" onClick={() => setPath("")}>Root</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}> / <button type="button" className="button-ghost button-small" onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button></span>)}</nav>
    <label style={{ display: "grid", gap: "0.5rem", marginBlock: "1rem" }}>Search archive names <input value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>
    {page.status === "pending" && <p role="status">Loading archive…</p>}{page.status === "failed" && <p role="alert">Archive could not be loaded.</p>}
    {page.status === "ready" && <><p role="status">{page.entries.length} items shown in this folder{page.nextCursor ? " · more available" : ""}</p><ul>{page.entries.map(entry => <li key={entry.path} style={{ overflowWrap: "anywhere" }}>{entry.kind === "folder" ? <button type="button" className="button-ghost button-small" onClick={() => setPath(entry.path.replace(/\/$/, ""))}>{entry.name}/</button> : <span>{entry.name}{entry.size === undefined ? "" : ` (${entry.size} bytes)`}</span>}</li>)}</ul>{page.nextCursor && <button type="button" className="button-ghost" onClick={more} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button>}</>}
  </section>;
}
