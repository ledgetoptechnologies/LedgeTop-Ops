import { useCallback, useEffect, useState } from "react";
import { requestChoice } from "@ltds/ui";
import { api, ApiError, sessionScope } from "../api";
import { withOperationKey } from "./operation-keys";

interface Status {
  decoder: string;
  raw: { retained: number; waiting: number; waitingReason: string | null; decoding: number; decoded: number; failed: number; failedByCode: Record<string, number>; lastUploadAt: string | null };
  review: { unassigned: number; conflict: number; linked: number; assigned: number };
  flights: { total: number; withoutOriginal: number };
}
interface QueueItem {
  rawSha256: string; fileName: string | null; uploadedAt: string; parseStatus: string; errorCode: string | null; attempts: number;
  uploader: { pilotId: string; pilotName: string | null; deviceName: string | null; deviceModel: string | null };
  summary: { displayName: string | null; startedAt: string | null; durationSeconds: number | null; distanceM: number | null; photoCount: number | null } | null;
  conflict: { flightId: string; pilotId: string | null; pilotName: string | null } | null;
}
interface Person { id: string; displayName: string }
type Queue = "unassigned" | "conflict" | "waiting" | "failed";

const WAITING_REASON: Record<string, string> = {
  waiting_for_key: "waiting for the DJI key to be entered on the Logs host",
  parser_unavailable: "waiting for the log reader to be installed",
  scratch_not_ram: "waiting: the Logs host’s working space isn’t set up yet",
  stopped: "waiting: decoding is stopped",
  crashed: "waiting: decoding stopped after a problem and needs attention",
  queued: "queued for decoding",
};
const FAILED_REASON: Record<string, string> = {
  raw_missing: "original file missing", corrupt_log: "unreadable log", unsupported_version: "log version not supported",
  attempts_exhausted: "gave up after repeated errors", keychain_unavailable: "DJI couldn’t unlock it", log_too_large: "too large",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const minutes = (s: number | null) => (s == null ? "" : `${Math.round(s / 60)} min`);

/**
 * Administrators only (the panel hides itself for everyone else). Shows, truthfully, which uploaded logs are safely
 * stored but waiting (for example for the DJI key) and which failed, and lets an administrator decide whose a
 * decoded log is. Every decision is audited.
 */
export function ReviewPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [queue, setQueue] = useState<Queue>("unassigned");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (before?: string) => {
    try {
      const [s, page] = await Promise.all([
        api<Status>("/api/admin/flight-logs/review/status"),
        api<{ items: QueueItem[]; next: string | null }>(`/api/admin/flight-logs/review/queue?queue=${queue}&limit=25${before ? `&before=${encodeURIComponent(before)}` : ""}`),
      ]);
      setStatus(s); setItems(existing => (before ? [...existing, ...page.items] : page.items)); setNext(page.next);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 503 || error.status === 404)) setStatus(null);
    }
  }, [queue]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ items: Person[] }>("/api/admin/flight-logs/usernames").then(list => setPeople(list.items), () => setPeople([]));
  }, []);

  async function act(item: QueueItem, action: string, path: string, body: object, done: string) {
    setBusy(item.rawSha256); setMessage("");
    try {
      await withOperationKey(sessionScope(), `${action}:${item.rawSha256}`, key =>
        api(path, { method: "POST", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setMessage(done);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That didn’t work. Try again.");
    }
    setBusy(""); void load();
  }

  async function assign(item: QueueItem) {
    const pilotId = choice[item.rawSha256];
    const person = people.find(p => p.id === pilotId);
    if (!person) { setMessage("Choose who flew it first."); return; }
    const answer = await requestChoice({ title: `Assign this flight to ${person.displayName}?`,
      description: `It becomes ${person.displayName}’s flight. This is recorded in the audit log and can be changed later by an administrator.`,
      choices: [{ value: "assign", label: "Assign flight" }] });
    if (answer !== "assign") return;
    await act(item, `assign:${pilotId}`, `/api/admin/flight-logs/review/logs/${item.rawSha256}/assign`, { pilotId }, `Assigned to ${person.displayName}.`);
  }

  async function resolve(item: QueueItem) {
    const owner = item.conflict?.pilotName ?? "the current owner";
    const uploader = item.uploader.pilotName ?? "the controller’s pilot";
    const answer = await requestChoice({ title: "Whose flight is this?",
      description: `This log matches a flight that belongs to ${owner}, but it was uploaded from ${uploader}’s controller. Either choice is recorded in the audit log.`,
      choices: [{ value: "keep", label: `Keep it with ${owner}` }, ...(item.uploader.pilotId !== item.conflict?.pilotId ? [{ value: "move", label: `Move it to ${uploader}` }] : [])] });
    if (answer === "keep") await act(item, "resolve:keep", `/api/admin/flight-logs/review/logs/${item.rawSha256}/resolve`, { resolution: "keep_existing" }, `Kept with ${owner}.`);
    if (answer === "move") await act(item, `resolve:move:${item.uploader.pilotId}`, `/api/admin/flight-logs/review/logs/${item.rawSha256}/resolve`,
      { resolution: "reassign_existing", pilotId: item.uploader.pilotId }, `Moved to ${uploader}.`);
  }

  if (!status) return null;
  const { raw, review } = status;
  const waitingText = raw.waitingReason ? WAITING_REASON[raw.waitingReason] ?? "waiting" : "";
  return <section className="flight-review" aria-label="Flight log review">
    <div className="flight-review-banner" role="status">
      <strong>Uploaded logs</strong>
      <span>{raw.retained.toLocaleString()} stored safely</span>
      {raw.waiting > 0 && <span className="flight-review-waiting">{raw.waiting.toLocaleString()} {waitingText}</span>}
      {raw.decoding > 0 && <span>{raw.decoding} decoding now</span>}
      {raw.failed > 0 && <span className="flight-review-failed">{raw.failed.toLocaleString()} couldn’t be read ({Object.entries(raw.failedByCode).map(([code, n]) => `${n} ${FAILED_REASON[code] ?? code}`).join(", ")})</span>}
      {review.unassigned > 0 && <span>{review.unassigned} to assign</span>}
      {review.conflict > 0 && <span>{review.conflict} to check</span>}
      <small>Last upload {when(raw.lastUploadAt)}</small>
    </div>
    <details className="flight-review-queue">
      <summary>Review flight logs</summary>
      <div className="flight-tabs" role="tablist" aria-label="Review list">
        {(["unassigned", "conflict", "waiting", "failed"] as const).map(q => <button key={q} type="button" role="tab" aria-selected={queue === q} onClick={() => setQueue(q)}>
          {{ unassigned: "To assign", conflict: "To check", waiting: "Waiting", failed: "Couldn’t read" }[q]}
        </button>)}
      </div>
      {message && <p className="flight-logs-status" role="status">{message}</p>}
      {items.length ? <ul>{items.map(item => <li key={item.rawSha256}>
        <span>
          <strong>{item.summary?.displayName ?? item.fileName ?? "Flight log"}</strong>
          <small>{item.summary?.startedAt ? when(item.summary.startedAt) : `Uploaded ${when(item.uploadedAt)}`}{item.summary ? ` · ${minutes(item.summary.durationSeconds)}` : ""}
            {" · "}uploaded from {item.uploader.deviceName ?? item.uploader.deviceModel ?? "a controller"} signed in as {item.uploader.pilotName ?? "a former account"}</small>
          {queue === "failed" && <small>{FAILED_REASON[item.errorCode ?? ""] ?? "Couldn’t be read"} · the original is kept</small>}
          {queue === "waiting" && <small>Stored safely · {waitingText || "waiting"}</small>}
          {item.conflict && <small>Matches a flight owned by {item.conflict.pilotName ?? "someone no longer active"}</small>}
        </span>
        {queue === "unassigned" && <span className="flight-review-actions">
          <select aria-label="Who flew it" value={choice[item.rawSha256] ?? ""} onChange={e => { const value = e.currentTarget.value; setChoice(c => ({ ...c, [item.rawSha256]: value })); }}>
            <option value="">Who flew it?</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <button type="button" className="button-orange button-small" disabled={!!busy} onClick={() => void assign(item)}>Assign</button>
        </span>}
        {queue === "conflict" && <button type="button" className="button-ghost button-small" disabled={!!busy} onClick={() => void resolve(item)}>Decide</button>}
      </li>)}</ul> : <p className="flight-logs-status">Nothing here.</p>}
      {next && <button type="button" className="button-ghost flight-logs-more" onClick={() => void load(next)}>Show more</button>}
    </details>
  </section>;
}
