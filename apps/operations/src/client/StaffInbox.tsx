import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "./api";
import { inboxDate, inboxEndpoint, inboxLabels, inboxSources, parseInboxPage, type InboxAccess, type InboxItem, type InboxSource } from "./staff-inbox";
import "./StaffInbox.css";

function route() {
  const params = new URLSearchParams(location.search), q = params.get("q") ?? "";
  return { q, invalid: params.getAll("q").length > 1 || q.length > 200 || /[\u0000-\u001f\u007f]/.test(q) };
}

export function StaffInbox({ access }: { access: InboxAccess }) {
  const [view, setView] = useState(route), [draft, setDraft] = useState(view.q), [refresh, setRefresh] = useState(0), [signedOut, setSignedOut] = useState(false);
  const sources = inboxSources(access), permissionKey = JSON.stringify(access);
  useEffect(() => { const pop = () => { setView(route()); }; addEventListener("popstate", pop); return () => removeEventListener("popstate", pop); }, []);
  useEffect(() => { setDraft(view.q); }, [view.q]);
  const search = (event: FormEvent) => {
    event.preventDefault();
    const q = draft.normalize("NFC").trim(), params = new URLSearchParams();
    if (q) params.set("q", q);
    history.pushState(null, "", `/operations/inbox${params.size ? `?${params}` : ""}`);
    setView(route()); setRefresh(value => value + 1);
  };
  return <section className="staff-inbox" aria-label="Staff inbox">
    <header className="staff-inbox-heading"><div><h2>Needs attention</h2><p>Review current work and open its next action. Each queue uses your existing permissions.</p></div>
      <button className="button-ghost" type="button" onClick={() => { setSignedOut(false); setRefresh(value => value + 1); }}>Refresh inbox</button></header>
    <form className="staff-inbox-search" role="search" aria-label="Search inbox" onSubmit={search}>
      <label>Search inbox<input value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} placeholder="Client, project, folder, or request" /></label>
      <button className="button-orange" type="submit">Search</button>
      {view.q && <a className="button button-ghost" href="/operations/inbox">Clear search</a>}
    </form>
    {access.invitationError && !signedOut && <p role="alert">Invitation approvals unavailable: {access.invitationError}</p>}
    <details className="staff-inbox-coverage"><summary>What is included?</summary><p>Open client requests and feedback, invitation approval requests, pending folder-change and explicit Project Alpha portal delivery notices, and reported failures from active Project Alpha connections. Queues load independently; shown counts are not unread counts or a combined total.</p>
      <p>Staff-created portal grants and uploads without an explicit recipient policy are not included. Opening this page never sends mail, dismisses work, or changes access.</p></details>
    {signedOut ? <div role="alert"><p>Your session expired. Sign in again, then refresh the inbox.</p></div> : view.invalid ? <p role="alert">This inbox search is invalid. Clear the search to try again.</p>
      : sources.length ? <div className="staff-inbox-grid">{sources.map(source => <InboxSection key={`${source}:${permissionKey}:${view.q}:${refresh}`} source={source} q={view.q} onSignedOut={() => setSignedOut(true)} />)}</div>
      : <p>No inbox sources are available with your current permissions.</p>}
  </section>;
}

function InboxSection({ source, q, onSignedOut }: { source: InboxSource; q: string; onSignedOut: () => void }) {
  const [rows, setRows] = useState<InboxItem[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [updated, setUpdated] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null), run = useRef(0), retry = useRef<string | null>(null);
  const label = inboxLabels[source];
  async function load(next: string | null = null) {
    if (pending.current) return;
    if (source === "invitations" && q.length > 100) {setRows([]); setCursor(null); setLoading(false); setError("Invitation approval searches support up to 100 characters. Shorten this search to include this queue."); return;}
    const controller = new AbortController(), current = ++run.current;
    pending.current = controller; retry.current = next; setLoading(true); setError("");
    if (!next) { setRows([]); setCursor(null); setUpdated(null); setNotice(""); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      const result = await api<unknown>(inboxEndpoint(source, q, next), { signal: controller.signal });
      if (controller.signal.aborted || current !== run.current) return;
      const page = parseInboxPage(source, result, q);
      if (page.nextCursor && page.nextCursor === next) throw new Error("Non-advancing inbox cursor");
      setRows(previous => [...new Map((next ? [...previous, ...page.items] : page.items).map(item => [item.id, item])).values()]);
      setCursor(page.nextCursor); setUpdated(new Date().toLocaleTimeString());
      setNotice(page.notice ?? "");
    } catch (caught) {
      if (current !== run.current || (controller.signal.aborted && !timedOut)) return;
      if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) {
        setRows([]); setCursor(null); setUpdated(null); setNotice(""); retry.current = null;
        if (caught.status === 401) { onSignedOut(); return; }
        setError(caught.status === 403 ? "You no longer have access to this queue, or it requires a wider permission scope." : "This queue or your access changed. Retry to load its current state.");
      } else setError(timedOut ? "This queue took too long to respond. Retry when ready." : "This queue could not be loaded. It may need its database upgrade or be temporarily unavailable.");
    } finally {
      clearTimeout(timer);
      if (current === run.current) { pending.current = null; setLoading(false); }
    }
  }
  useEffect(() => { void load(); return () => { run.current++; pending.current?.abort(); pending.current = null; }; }, []);
  return <section className="staff-inbox-section" aria-label={label.title}>
    <header><h3>{label.title}</h3><p>{label.description}</p></header>
    {error && <div className="staff-inbox-error" role="alert"><p>{error}</p><button className="button-ghost" disabled={loading} onClick={() => void load(retry.current)}>Retry {label.title.toLowerCase()}</button></div>}
    {loading && <p role="status">Loading {label.title.toLowerCase()}…</p>}
    {notice && <p role="status">{notice}</p>}
    {updated && <p className="staff-inbox-freshness">{rows.length.toLocaleString("en-US")} shown{cursor ? " · More available" : ""} · Updated {updated}{error ? " · Not refreshed" : ""}</p>}
    <div className="staff-inbox-items">{rows.map(item => <article key={item.id}>
      <div className="staff-inbox-item-title"><h4>{item.title}</h4><span>{item.status}</span></div><p>{item.detail}</p>
      {item.date && <time dateTime={inboxDate(item.date)}>{new Date(inboxDate(item.date)).toLocaleString()}</time>}
      <a href={item.href}>{item.action}<span className="staff-inbox-sr-only">: {item.title}</span></a>
    </article>)}</div>
    {!loading && !error && !rows.length && <p>{cursor ? "No matching items in this page. Load more to continue checking." : `No ${source === "connections" ? "reported connection failures" : "items needing attention"}${q ? " match this search" : " in this queue"}.`}</p>}
    {cursor && <button className="button-ghost" disabled={loading || Boolean(error)} onClick={() => void load(cursor)}>Load more {label.title.toLowerCase()}</button>}
  </section>;
}
