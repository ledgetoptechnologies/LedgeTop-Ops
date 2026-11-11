import { useEffect, useRef, useState } from "react";
import { Card, EmptyState } from "@ltds/ui";
import { api, ApiError } from "./api";
import type { DryRunReport, OdlBackup } from "../../../logs/src/odl/browser.mjs";
import "./FlightLogsPage.css";

interface FlightSummary {
  id: string; displayName: string | null; startedAt: string | null; durationSeconds: number | null; distanceMeters: number | null;
  maxAltitudeMeters: number | null; pilotId: string; pilotName?: string | null; media: { photos: number; videos: number };
  aircraft: { serial: string; model: string | null; name: string | null } | null; hasTrack: boolean; rawLog: "missing" | "stored";
}
interface Pilot { id: string; displayName: string }

const feet = (meters: number | null) => (meters == null ? "—" : `${Math.round(meters * 3.28084).toLocaleString()} ft`);
const miles = (meters: number | null) => (meters == null ? "—" : `${(meters / 1609.344).toFixed(meters < 1609 ? 2 : 1)} mi`);
const duration = (seconds: number | null) => {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const aircraftLabel = (aircraft: FlightSummary["aircraft"]) => (aircraft ? aircraft.name || aircraft.model || `Aircraft …${aircraft.serial.slice(-4)}` : "Unknown aircraft");

export function FlightLogsPage({ canImport }: { canImport: boolean }) {
  const [flights, setFlights] = useState<FlightSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);

  async function load(before?: string) {
    try {
      const page = await api<{ items: FlightSummary[]; next: string | null }>(`/api/admin/flight-logs/flights?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setFlights(current => (before ? [...current, ...page.items] : page.items));
      setNext(page.next); setState("ready");
    } catch (error) {
      setState(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setMessage(error instanceof Error ? error.message : "Flight logs could not be loaded.");
    }
  }
  useEffect(() => { void load(); }, []);

  return <section className="flight-logs" aria-label="Fleet and flight logs">
    {canImport && <div className="flight-logs-actions">
      <button type="button" className="button" onClick={() => setImporting(true)} disabled={importing || state === "unavailable"}>Import from OpenDroneLog</button>
    </div>}
    {importing && <OdlImport onClose={() => setImporting(false)} onImported={() => { void load(); }} />}
    {state === "loading" && <p className="flight-logs-status" role="status">Loading flights…</p>}
    {state === "unavailable" && <EmptyState title="Flight logs aren’t connected yet" detail="The flight-log service hasn’t been switched on for Operations. Nothing is lost; flights will appear here once it is." />}
    {state === "error" && <p className="flight-logs-status error" role="alert">{message}</p>}
    {state === "ready" && !flights.length && <EmptyState title="No flights yet" detail={canImport ? "Import an OpenDroneLog backup to bring in your existing flights." : "Flights appear here once a pilot’s logs are imported."} />}
    {state === "ready" && !!flights.length && <Card title="Flights">
      <div className="flight-logs-table-wrap">
        <table className="flight-logs-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Flight</th><th scope="col">Aircraft</th><th scope="col">Pilot</th><th scope="col">Duration</th><th scope="col">Distance</th><th scope="col">Max altitude</th><th scope="col">Track</th></tr></thead>
          <tbody>{flights.map(flight => <tr key={flight.id}>
            <td>{date(flight.startedAt)}</td>
            <td>{flight.displayName || "Untitled flight"}</td>
            <td>{aircraftLabel(flight.aircraft)}</td>
            <td>{flight.pilotName || "Unknown pilot"}</td>
            <td>{duration(flight.durationSeconds)}</td>
            <td>{miles(flight.distanceMeters)}</td>
            <td>{feet(flight.maxAltitudeMeters)}</td>
            <td>{flight.hasTrack ? "Yes" : "No"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {next && <button type="button" className="button-ghost flight-logs-more" onClick={() => void load(next)}>Show more</button>}
    </Card>}
  </section>;
}

function OdlImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [pilots, setPilots] = useState<Pilot[]>([]);
  const [pilotId, setPilotId] = useState("");
  const [backup, setBackup] = useState<OdlBackup | null>(null);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ flightsCreated: number; flightsExisting: number; tracksStored: number; messagesDropped: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = progress != null && progress.phase !== "done" && !result;

  useEffect(() => {
    api<{ items: Pilot[] }>("/api/admin/flight-logs/import/pilots").then(page => setPilots(page.items)).catch(failure => setError(failure.message));
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    if (!backup || !pilotId) { setReport(null); return; }
    let current = true;
    setStatus("Checking what this backup would add…");
    import("./flight-logs-import").then(module => module.previewBackup(backup, pilotId))
      .then(value => { if (current) { setReport(value); setStatus(""); } })
      .catch(failure => { if (current) { setError(failure.message); setStatus(""); } });
    return () => { current = false; };
  }, [backup, pilotId]);

  async function choose(file: File | undefined) {
    setBackup(null); setReport(null); setResult(null); setError("");
    if (!file) return;
    setStatus(`Reading ${file.name} on this computer…`);
    try {
      const module = await import("./flight-logs-import");
      setBackup(await module.openBackup(file)); setStatus("");
    } catch (failure) { setStatus(""); setError(failure instanceof Error ? failure.message : "This file could not be read."); }
  }

  async function start() {
    if (!backup || !pilotId || !report?.validation.ok) return;
    controller.current = new AbortController(); setError(""); setResult(null);
    setProgress({ phase: "flights", done: 0, total: report.flights?.total ?? 0 });
    try {
      const module = await import("./flight-logs-import");
      const outcome = await module.runImport(backup, pilotId, setProgress, controller.current.signal);
      setResult(outcome); onImported();
    } catch (failure) {
      setProgress(null);
      setError(controller.current.signal.aborted ? "Import stopped. Flights already sent are kept; importing the same backup again adds only the rest."
        : `${failure instanceof Error ? failure.message : "The import failed."} Flights already sent are kept; you can safely run the import again.`);
    }
  }

  const pilotName = pilots.find(pilot => pilot.id === pilotId)?.displayName;
  const percent = progress && progress.total ? Math.round((100 * progress.done) / progress.total) : 0;
  return <Card title="Import from OpenDroneLog" className="odl-import" action={<button type="button" className="button-ghost" onClick={() => { controller.current?.abort(); onClose(); }}>{running ? "Stop import" : "Close"}</button>}>
    <p className="form-note">Choose a backup exported from OpenDroneLog (a <code>.db.backup</code> file). It’s read on this computer; the file itself isn’t uploaded. Each backup belongs to one pilot, so import Kollin’s backup separately with Kollin as the pilot.</p>
    <div className="odl-import-fields">
      <label>Backup file<input type="file" accept=".backup,.gz,.tar" disabled={running} onChange={event => void choose(event.target.files?.[0])} /></label>
      <label>Pilot<select value={pilotId} disabled={running} onChange={event => setPilotId(event.target.value)}>
        <option value="">Choose the pilot who flew these flights</option>
        {pilots.map(pilot => <option key={pilot.id} value={pilot.id}>{pilot.displayName}</option>)}
      </select></label>
    </div>
    {status && <p className="flight-logs-status" role="status">{status}</p>}
    {error && <p className="flight-logs-status error" role="alert">{error}</p>}
    {report && <DryRun report={report} pilotName={pilotName} />}
    {progress && !result && <div className="odl-import-progress">
      <progress max={100} value={percent} aria-label="Import progress" />
      <p role="status">{progress.phase === "flights" ? `Adding flights: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : `Saving flight tracks: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`}</p>
    </div>}
    {result && <p className="flight-logs-status success" role="status">Import finished: {result.flightsCreated.toLocaleString()} flight{result.flightsCreated === 1 ? "" : "s"} added{result.flightsExisting ? `, ${result.flightsExisting.toLocaleString()} already here` : ""}, {result.tracksStored.toLocaleString()} track{result.tracksStored === 1 ? "" : "s"} saved.{result.messagesDropped ? ` ${result.messagesDropped.toLocaleString()} in-flight app messages were over the per-flight limit and were not saved.` : ""}</p>}
    {report?.validation.ok && !progress && !result && <div className="odl-import-confirm">
      <button type="button" className="button" disabled={!report.flights?.new} onClick={() => void start()}>
        {report.flights?.new ? `Import ${report.flights.new.toLocaleString()} flight${report.flights.new === 1 ? "" : "s"} for ${pilotName ?? "this pilot"}` : "Nothing new to import"}
      </button>
    </div>}
  </Card>;
}

function DryRun({ report, pilotName }: { report: DryRunReport; pilotName?: string }) {
  const f = report.flights, e = report.equipment;
  return <div className="odl-dry-run" aria-label="What this import will add">
    {report.validation.errors.map(item => <p key={item} className="flight-logs-status error" role="alert">{item}</p>)}
    {f && <dl className="odl-dry-run-facts">
      <div><dt>Flights</dt><dd>{f.total.toLocaleString()} <small>{f.new.toLocaleString()} new · {f.alreadyImported.toLocaleString()} already here</small></dd></div>
      <div><dt>Flight time</dt><dd>{f.hours.toLocaleString()} h <small>{f.firstFlightAt?.slice(0, 10)} to {f.lastFlightAt?.slice(0, 10)}</small></dd></div>
      {e && <div><dt>Equipment</dt><dd>{e.aircraft.total} aircraft · {e.batteries.total} batteries · {e.controllers.total} controllers <small>{e.aircraft.new + e.batteries.new + e.controllers.new} new to Ledge Top</small></dd></div>}
      {report.telemetry && <div><dt>Tracks</dt><dd>{report.telemetry.flightsWithTrack.toLocaleString()} flights <small>{report.telemetry.rows.toLocaleString()} points</small></dd></div>}
      <div><dt>Pilot</dt><dd>{pilotName ?? "—"} <small>every flight in this backup</small></dd></div>
    </dl>}
    {e && !!e.aircraft.items.length && <details className="odl-dry-run-aircraft"><summary>Aircraft in this backup ({e.aircraft.total})</summary>
      <ul>{e.aircraft.items.map(item => <li key={`${item.serial}-${item.name}`}>{item.name || item.model || "Aircraft"} <small>{item.serial} · {item.flights} flights · {item.hours} h{item.existing ? " · already in Ledge Top" : ""}</small></li>)}</ul>
    </details>}
    {!!report.validation.warnings.length && <details className="odl-dry-run-warnings"><summary>Notes ({report.validation.warnings.length})</summary>
      <ul>{report.validation.warnings.map(item => <li key={item}>{item}</li>)}</ul>
    </details>}
    {report.rawLogCoverage && <p className="form-note">OpenDroneLog backups don’t include the original DJI log files. These flights are imported from OpenDroneLog’s data; original logs you find later attach to the same flights automatically.</p>}
  </div>;
}
