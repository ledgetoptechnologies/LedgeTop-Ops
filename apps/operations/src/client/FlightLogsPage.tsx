import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState } from "@ltds/ui";
import { api, ApiError } from "./api";
import type { DryRunReport, OdlBackup } from "../../../logs/src/odl/browser.mjs";
import { ControllersPanel } from "./flight-logs/ControllersPanel";
import { UsernamesPanel } from "./flight-logs/UsernamesPanel";
import { FlightDetail } from "./flight-logs/FlightDetail";
import { Overview } from "./flight-logs/Overview";
import { duration, equipmentLabel, FEET, filterQuery, flightTitle, masked, miles, MILE, shortDate, type Facets, type Filters, type FlightItem } from "./flight-logs/format";
import "./FlightLogsPage.css";

interface Pilot { id: string; displayName: string }
type View = { kind: "flight"; id: string } | { kind: "overview" };

/**
 * Fleet and flight logs: a flight list with filters on the left and the open flight (map, telemetry,
 * replay) or the fleet overview on the right. Same filters drive the list and the overview.
 */
export function FlightLogsPage({ canImport, canViewAll = false }: { canImport: boolean; canViewAll?: boolean }) {
  const [flights, setFlights] = useState<FlightItem[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [view, setView] = useState<View>({ kind: "overview" });
  const [panelOpen, setPanelOpen] = useState(true);
  const query = filterQuery(filters);
  const generation = useRef(0);

  const load = useCallback(async (before?: string) => {
    const current = ++generation.current;
    try {
      const page = await api<{ items: FlightItem[]; next: string | null; total: number }>(
        `/api/flight-logs/flights?limit=50${query ? `&${query}` : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      if (current !== generation.current) return;
      setFlights(existing => (before ? [...existing, ...page.items] : page.items));
      setNext(page.next); setTotal(page.total ?? page.items.length); setState("ready");
    } catch (error) {
      if (current !== generation.current) return;
      setState(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setMessage(error instanceof Error ? error.message : "Flight logs could not be loaded.");
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<Facets>("/api/flight-logs/facets").then(setFacets, () => setFacets(null)); }, [state === "ready"]);

  const openFlight = useCallback((id: string) => { setView({ kind: "flight", id }); if (window.matchMedia("(max-width: 900px)").matches) setPanelOpen(false); }, []);
  const set = (patch: Partial<Filters>) => setFilters(current => ({ ...current, ...patch }));
  const filtered = Object.keys(filters).some(key => filters[key as keyof Filters] !== undefined && filters[key as keyof Filters] !== "");

  if (state === "unavailable") return <section className="flight-logs" aria-label="Fleet and flight logs">
    <EmptyState title="Flight logs aren’t connected yet" detail="The flight-log service hasn’t been switched on for Operations. Nothing is lost; flights will appear here once it is." />
  </section>;

  return <section className={`flight-logs flight-workspace${panelOpen ? "" : " panel-closed"}`} aria-label="Fleet and flight logs">
    <aside className="flight-panel-left" aria-label="Flights and filters">
      <div className="flight-tabs" role="tablist" aria-label="Flight logs view">
        <button type="button" role="tab" aria-selected={view.kind === "flight"} onClick={() => { const first = flights[0]; if (view.kind !== "flight" && first) openFlight(first.id); }}>Flights</button>
        <button type="button" role="tab" aria-selected={view.kind === "overview"} onClick={() => setView({ kind: "overview" })}>Overview</button>
      </div>
      {!canViewAll && <p className="flight-logs-scope">These are your flights. Only you and Ledge Top admins can see them.</p>}
      {canImport && <button type="button" className="button-ghost flight-import-button" onClick={() => setImporting(true)} disabled={importing}>Import from OpenDroneLog</button>}
      <details className="flight-filters" open>
        <summary>Filters{filtered && <span className="flight-filter-count"> · on</span>}</summary>
        <label>Search<input type="search" value={filters.q ?? ""} placeholder="Name, file or notes" onChange={event => set({ q: event.currentTarget.value || undefined })} /></label>
        <div className="flight-filter-dates">
          <label>From<input type="date" value={filters.from ?? ""} onChange={event => set({ from: event.currentTarget.value || undefined })} /></label>
          <label>To<input type="date" value={filters.to ?? ""} onChange={event => set({ to: event.currentTarget.value || undefined })} /></label>
        </div>
        <label>Aircraft<select value={filters.aircraft ?? ""} onChange={event => set({ aircraft: event.currentTarget.value || undefined })}>
          <option value="">All aircraft</option>{facets?.aircraft.map(item => <option key={item.id} value={item.id}>{equipmentLabel(item)} · {masked(item.serial)} ({item.flights})</option>)}
        </select></label>
        <label>Battery<select value={filters.battery ?? ""} onChange={event => set({ battery: event.currentTarget.value || undefined })}>
          <option value="">All batteries</option>{facets?.batteries.map(item => <option key={item.id} value={item.id}>Battery {masked(item.serial)} ({item.flights})</option>)}
        </select></label>
        {facets && facets.pilots.length > 1 && <label>Pilot<select value={filters.pilot ?? ""} onChange={event => set({ pilot: event.currentTarget.value || undefined })}>
          <option value="">All pilots</option>{facets.pilots.map(item => <option key={item.id} value={item.id}>{item.pilotName ?? "Unknown pilot"} ({item.flights})</option>)}
        </select></label>}
        <label>Tag<select value={filters.tag ?? ""} onChange={event => set({ tag: event.currentTarget.value || undefined })}>
          <option value="">All tags</option>{facets?.tags.map(item => <option key={`${item.kind}:${item.tag}`} value={item.tag}>{item.tag} ({item.flights})</option>)}
        </select></label>
        <RangeFilter label="Duration" unit="min" max={Math.ceil((facets?.ranges.durationSeconds ?? 3600) / 60)} toFilter={v => v * 60}
          min={filters.minDuration} maxValue={filters.maxDuration} onChange={(a, b) => set({ minDuration: a, maxDuration: b })} fromFilter={v => Math.round(v / 60)} />
        <RangeFilter label="Max height" unit="ft" max={Math.ceil((facets?.ranges.altitudeMeters ?? 120) * FEET)} toFilter={v => v / FEET}
          min={filters.minAltitude} maxValue={filters.maxAltitude} onChange={(a, b) => set({ minAltitude: a, maxAltitude: b })} fromFilter={v => Math.round(v * FEET)} />
        <RangeFilter label="Distance" unit="mi" step={0.1} max={Math.ceil(((facets?.ranges.distanceMeters ?? MILE) / MILE) * 10) / 10} toFilter={v => v * MILE}
          min={filters.minDistance} maxValue={filters.maxDistance} onChange={(a, b) => set({ minDistance: a, maxDistance: b })} fromFilter={v => Math.round((v / MILE) * 10) / 10} />
        {filtered && <button type="button" className="portal-text-action" onClick={() => setFilters({})}>Clear filters</button>}
      </details>
      <p className="flight-list-count" role="status">{state === "loading" ? "Loading flights…" : `${total.toLocaleString()} ${total === 1 ? "flight" : "flights"}${filtered ? " match" : ""}`}</p>
      {state === "error" && <p className="flight-logs-status error" role="alert">{message}</p>}
      <ol className="flight-list">{flights.map(flight => <li key={flight.id}>
        <button type="button" aria-current={view.kind === "flight" && view.id === flight.id ? "true" : undefined} onClick={() => openFlight(flight.id)}>
          <strong>{flightTitle(flight)}</strong>
          <small>{shortDate(flight.startedAt)} · {duration(flight.durationSeconds, true)} · {miles(flight.distanceMeters)}</small>
          <small>{equipmentLabel(flight.aircraft)}{flight.pilotName ? ` · ${flight.pilotName}` : ""}{flight.hasTrack ? "" : " · no track"}</small>
        </button>
      </li>)}</ol>
      {next && <button type="button" className="button-ghost flight-logs-more" onClick={() => void load(next)}>Show more</button>}
      {state === "ready" && !flights.length && !filtered && <EmptyState title="No flights yet" detail={canImport ? "Import an OpenDroneLog backup to bring in your existing flights." : canViewAll ? "Flights appear here once a pilot’s logs are imported." : "Your flights appear here once your controller uploads them. Sign in on the controller with your username."} />}
    </aside>
    <button type="button" className="flight-panel-toggle" aria-expanded={panelOpen} aria-label={panelOpen ? "Hide flight list" : "Show flight list"} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? "‹" : "›"}</button>
    <div className="flight-main">
      <ControllersPanel canManageAll={canImport} />
      <UsernamesPanel />
      {importing && <OdlImport onClose={() => setImporting(false)} onImported={() => { void load(); }} />}
      {view.kind === "overview"
        ? <Overview filters={filters} onOpenFlight={openFlight} />
        : <FlightDetail flightId={view.id} />}
    </div>
  </section>;
}

/** Two number inputs for a min/max filter, shown in friendly units and sent in metric. */
function RangeFilter({ label, unit, max, step = 1, min, maxValue, onChange, toFilter, fromFilter }: {
  label: string; unit: string; max: number; step?: number; min?: number; maxValue?: number;
  onChange: (min?: number, max?: number) => void; toFilter: (value: number) => number; fromFilter: (value: number) => number;
}) {
  const parse = (value: string) => (value === "" ? undefined : toFilter(Number(value)));
  return <fieldset className="flight-filter-range"><legend>{label} ({unit})</legend>
    <input type="number" min={0} max={max} step={step} aria-label={`Minimum ${label.toLowerCase()} in ${unit}`} placeholder="Any" value={min == null ? "" : fromFilter(min)}
      onChange={event => onChange(parse(event.currentTarget.value), maxValue)} />
    <span>to</span>
    <input type="number" min={0} max={max} step={step} aria-label={`Maximum ${label.toLowerCase()} in ${unit}`} placeholder={`${max}`} value={maxValue == null ? "" : fromFilter(maxValue)}
      onChange={event => onChange(min, parse(event.currentTarget.value))} />
  </fieldset>;
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
      <button type="button" className="button" disabled={!report.flights?.new && !report.flights?.resumable} onClick={() => void start()}>
        {importLabel(report.flights?.new ?? 0, report.flights?.resumable ?? 0, pilotName)}
      </button>
    </div>}
  </Card>;
}

/** New flights, and flights an earlier interrupted import by you stored without their track. */
function importLabel(fresh: number, resumable: number, pilotName?: string): string {
  const who = pilotName ?? "this pilot", flights = (n: number) => `${n.toLocaleString()} flight${n === 1 ? "" : "s"}`;
  if (fresh && resumable) return `Import ${flights(fresh)} and finish ${resumable.toLocaleString()} from an interrupted import for ${who}`;
  if (fresh) return `Import ${flights(fresh)} for ${who}`;
  if (resumable) return `Finish the interrupted import: ${flights(resumable)} for ${who}`;
  return "Nothing new to import";
}

function DryRun({ report, pilotName }: { report: DryRunReport; pilotName?: string }) {
  const f = report.flights, e = report.equipment;
  return <div className="odl-dry-run" aria-label="What this import will add">
    {report.validation.errors.map(item => <p key={item} className="flight-logs-status error" role="alert">{item}</p>)}
    {f && <dl className="odl-dry-run-facts">
      <div><dt>Flights</dt><dd>{f.total.toLocaleString()} <small>{f.new.toLocaleString()} new · {f.alreadyImported.toLocaleString()} already here{f.resumable ? ` · ${f.resumable.toLocaleString()} still need their track from an interrupted import` : ""}</small></dd></div>
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
