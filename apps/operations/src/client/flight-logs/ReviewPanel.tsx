import { useCallback, useEffect, useRef, useState } from "react";
import { requestChoice } from "@ltds/ui";
import { api, sessionScope } from "../api";
import { withOperationKey } from "./operation-keys";
import { bannerSummary, createGenerations, failedItemText, mergeQueue, reviewAction, reviewErrorState, type ReviewItem, type ReviewStatus } from "./review-model";

interface Person { id: string; displayName: string }
type Queue = "unassigned" | "conflict" | "waiting" | "failed";
const QUEUE_LABEL: Record<Queue, string> = { unassigned: "To assign", conflict: "To check", waiting: "Waiting", failed: "Couldn’t read" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const minutes = (s: number | null) => (s == null ? "" : `${Math.round(s / 60)} min`);

/**
 * Administrators only: hidden only when the server says you are not allowed. Shows, truthfully, which uploaded logs
 * are stored and waiting (for example for the DJI key), which originals are missing and which could not be read, and
 * lets an administrator decide whose a decoded log is. Every decision is audited.
 */
export function ReviewPanel() {
  const [access, setAccess] = useState<"loading" | "ready" | "unavailable" | "forbidden">("loading");
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [queue, setQueue] = useState<Queue>("unassigned");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const generations = useRef(createGenerations());

  const load = useCallback(async (before?: string) => {
    const generation = generations.current.next();
    setListing(true);
    try {
      const [s, page] = await Promise.all([
        api<ReviewStatus>("/api/admin/flight-logs/review/status"),
        api<{ items: ReviewItem[]; next: string | null }>(`/api/admin/flight-logs/review/queue?queue=${queue}&limit=25${before ? `&before=${encodeURIComponent(before)}` : ""}`),
      ]);
      if (!generations.current.isCurrent(generation)) return;
      setStatus(s); setItems(existing => mergeQueue(existing, page.items, Boolean(before))); setNext(page.next); setAccess("ready");
    } catch (error) {
      if (!generations.current.isCurrent(generation)) return;
      // Keep the last known status on screen, marked as out of date.
      setAccess(reviewErrorState(error));
    } finally {
      if (generations.current.isCurrent(generation)) setListing(false);
    }
  }, [queue]);
  useEffect(() => { setItems([]); setNext(null); void load(); }, [load]);
  useEffect(() => {
    api<{ items: Person[] }>("/api/admin/flight-logs/usernames").then(list => setPeople(list.items), () => setPeople([]));
  }, []);

  async function act(item: ReviewItem, action: string, path: string, body: object, done: string) {
    setBusy(item.rawSha256); setMessage("");
    try {
      await withOperationKey(sessionScope(), action, key =>
        api(path, { method: "POST", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setMessage(done);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That didn’t work. Try again.");
    }
    setBusy(""); void load();
  }

  async function assign(item: ReviewItem) {
    const pilotId = choice[item.rawSha256];
    const person = people.find(p => p.id === pilotId);
    if (!person) { setMessage("Choose who flew it first."); return; }
    const answer = await requestChoice({ title: `Assign this flight to ${person.displayName}?`,
      description: `It becomes ${person.displayName}’s flight. The controller account that uploaded it stays on record. This is written to the audit log and an administrator can change it later.`,
      choices: [{ value: "assign", label: "Assign flight" }] });
    if (answer !== "assign") return;
    await act(item, reviewAction.assign(item.rawSha256, person.id), `/api/admin/flight-logs/review/logs/${item.rawSha256}/assign`, { pilotId: person.id }, `Assigned to ${person.displayName}.`);
  }

  async function resolve(item: ReviewItem) {
    const owner = item.conflict?.pilotName ?? "the current owner";
    const uploader = item.uploader.pilotName ?? "the controller’s account";
    const answer = await requestChoice({ title: "Whose flight is this?",
      description: `This log matches a flight that belongs to ${owner}, but it was uploaded from a controller signed in as ${uploader}. Either choice is written to the audit log.`,
      choices: [{ value: "keep", label: `Keep it with ${owner}` }, ...(item.uploader.pilotId !== item.conflict?.pilotId ? [{ value: "move", label: `Move it to ${uploader}` }] : [])] });
    if (answer === "keep") await act(item, reviewAction.keep(item.rawSha256), `/api/admin/flight-logs/review/logs/${item.rawSha256}/resolve`, { resolution: "keep_existing" }, `Kept with ${owner}.`);
    if (answer === "move") await act(item, reviewAction.move(item.rawSha256, item.uploader.pilotId), `/api/admin/flight-logs/review/logs/${item.rawSha256}/resolve`,
      { resolution: "reassign_existing", pilotId: item.uploader.pilotId }, `Moved to ${uploader}.`);
  }

  if (access === "forbidden") return null;
  if (access === "loading" && !status) return <section className="flight-review" aria-busy="true"><p className="flight-logs-status" role="status">Loading flight log review…</p></section>;
  const banner = status ? bannerSummary(status) : null;
  return <section className="flight-review" aria-label="Flight log review">
    {access === "unavailable" && <p className="flight-logs-status error" role="alert">
      Flight log review is unavailable right now (the Logs host isn’t connected or didn’t answer).{status ? " The numbers below may be out of date." : ""}{" "}
      <button type="button" className="button-ghost button-small" onClick={() => void load()}>Try again</button>
    </p>}
    {banner && <div className={`flight-review-banner${access === "unavailable" ? " stale" : ""}`} role="status">
      <strong>Uploaded logs</strong>
      <span>{banner.received.toLocaleString()} received</span>
      {banner.waiting > 0 && <span className="flight-review-waiting">{banner.waiting.toLocaleString()} {banner.waitingText}</span>}
      {banner.decoding > 0 && <span>{banner.decoding} decoding now</span>}
      {banner.missingOriginals > 0 && <span className="flight-review-failed">{banner.missingOriginals} original {banner.missingOriginals === 1 ? "file is" : "files are"} missing</span>}
      {banner.unreadableTotal > 0 && <span className="flight-review-failed">{banner.unreadableTotal} couldn’t be read ({banner.unreadable.map(u => `${u.count} ${u.label}`).join(", ")})</span>}
      {banner.toAssign > 0 && <span>{banner.toAssign} to assign</span>}
      {banner.toCheck > 0 && <span>{banner.toCheck} to check</span>}
      {banner.flightsWithoutOriginal > 0 && <span>{banner.flightsWithoutOriginal.toLocaleString()} flights have no original log (imported history)</span>}
      <small>Last upload {when(banner.lastUploadAt)}</small>
    </div>}
    <details className="flight-review-queue">
      <summary>Review flight logs</summary>
      <div className="flight-tabs" role="tablist" aria-label="Review list">
        {(Object.keys(QUEUE_LABEL) as Queue[]).map(q => <button key={q} type="button" role="tab" aria-selected={queue === q} onClick={() => setQueue(q)}>{QUEUE_LABEL[q]}</button>)}
      </div>
      {message && <p className="flight-logs-status" role="status">{message}</p>}
      {listing && !items.length ? <p className="flight-logs-status" role="status">Loading…</p>
        : items.length ? <ul>{items.map(item => <li key={item.rawSha256}>
          <span>
            <strong>{item.summary?.displayName ?? item.fileName ?? "Flight log"}</strong>
            <small>{item.summary?.startedAt ? when(item.summary.startedAt) : `Uploaded ${when(item.uploadedAt)}`}{item.summary ? ` · ${minutes(item.summary.durationSeconds)}` : ""}
              {" · "}uploaded from {item.uploader.deviceName ?? item.uploader.deviceModel ?? "a controller"} signed in as {item.uploader.pilotName ?? "an account no longer active"}</small>
            {queue === "failed" && <small>{failedItemText(item)}</small>}
            {queue === "waiting" && <small>{banner?.waitingText || "Waiting"}</small>}
            {item.conflict && <small>Matches a flight owned by {item.conflict.pilotName ?? "someone no longer active"}</small>}
          </span>
          {queue === "unassigned" && <span className="flight-review-actions">
            <select aria-label="Who flew it" value={choice[item.rawSha256] ?? ""} onChange={e => { const value = e.currentTarget.value; setChoice(c => ({ ...c, [item.rawSha256]: value })); }}>
              <option value="">Who flew it?</option>
              {people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <button type="button" className="button-orange button-small" disabled={!!busy || access !== "ready"} onClick={() => void assign(item)}>Assign</button>
          </span>}
          {queue === "conflict" && <button type="button" className="button-ghost button-small" disabled={!!busy || access !== "ready"} onClick={() => void resolve(item)}>Decide</button>}
        </li>)}</ul>
        : access === "ready" && <p className="flight-logs-status">Nothing here.</p>}
      {next && <button type="button" className="button-ghost flight-logs-more" disabled={listing} onClick={() => void load(next)}>{listing ? "Loading…" : "Show more"}</button>}
    </details>
  </section>;
}
