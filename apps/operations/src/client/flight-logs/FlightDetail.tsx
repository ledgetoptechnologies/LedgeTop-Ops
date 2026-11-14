import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, sessionScope } from "../api";
import { requestChoice } from "@ltds/ui";
import { withOperationKey } from "./operation-keys";
import { reviewAction } from "./review-model";
import { FlightMap } from "./FlightMap";
import { indexAt, TelemetryChart, type ChartSeries } from "./TelemetryChart";
import { clock, date, duration, equipmentLabel, FEET, flightTitle, masked, miles, MPH, mph, feet, series, type FlightDetail as Detail, type Track } from "./format";

const SPEEDS = [1, 2, 4, 8, 16];
const LEVEL_LABEL = { tip: "Note", caution: "Caution", warn: "Warning" } as const;

function isTrack(value: unknown): value is Track {
  const columns = (value as { columns?: unknown } | null)?.columns;
  return !!columns && typeof columns === "object" && !Array.isArray(columns) && Object.values(columns).every(Array.isArray);
}

/**
 * Administrators: move this flight to another active pilot. Confirmed first, keyed so a retry is applied once, and
 * written to the audit log (the controller account that uploaded it, if any, stays on record separately).
 */
function ReassignFlight({ flightId, pilotName, onDone }: { flightId: string; pilotName: string | null; onDone: () => void }) {
  const [people, setPeople] = useState<Array<{ id: string; displayName: string }> | null>(null);
  const [pilotId, setPilotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function open() {
    try { setPeople((await api<{ items: Array<{ id: string; displayName: string }> }>("/api/admin/flight-logs/usernames")).items); }
    catch { setMessage("The pilot list couldn’t be loaded. Try again."); }
  }
  async function save() {
    const person = people?.find(p => p.id === pilotId);
    if (!person) return;
    const answer = await requestChoice({ title: `Move this flight to ${person.displayName}?`,
      description: `It is ${pilotName ?? "someone else"}’s flight now. Moving it is written to the audit log and can be changed again by an administrator.`,
      choices: [{ value: "move", label: "Move flight" }] });
    if (answer !== "move") return;
    setBusy(true); setMessage("");
    try {
      await withOperationKey(sessionScope(), reviewAction.reassign(flightId, person.id), key =>
        api(`/api/admin/flight-logs/flights/${encodeURIComponent(flightId)}/reassign`, { method: "POST",
          headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ pilotId: person.id }) }));
      setMessage(`Moved to ${person.displayName}.`); setPeople(null); onDone();
    } catch (error) { setMessage(error instanceof Error ? error.message : "That didn’t work. Try again."); }
    setBusy(false);
  }
  return <span className="flight-reassign">
    {people ? <>
      <select aria-label="New pilot" value={pilotId} onChange={e => setPilotId(e.currentTarget.value)}>
        <option value="">Choose a pilot</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
      <button type="button" className="button-orange button-small" disabled={busy || !pilotId} onClick={() => void save()}>Move</button>
      <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => setPeople(null)}>Cancel</button>
    </> : <button type="button" className="button-ghost button-small" onClick={() => void open()}>Change pilot</button>}
    {message && <small role="status">{message}</small>}
  </span>;
}

export function FlightDetail({ flightId, canReassign = false }: { flightId: string; canReassign?: boolean }) {
  const [reloaded, setReloaded] = useState(0);
  const [flight, setFlight] = useState<Detail | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [trackState, setTrackState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [cursor, setCursor] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [replayAt, setReplayAt] = useState(0);

  useEffect(() => {
    let active = true;
    setFlight(null); setTrack(null); setState("loading"); setTrackState("loading"); setZoom(null); setCursor(null); setPlaying(false); setReplayAt(0);
    api<Detail>(`/api/flight-logs/flights/${encodeURIComponent(flightId)}`)
      .then(value => { if (!active) return; setFlight(value); setState("ready");
        if (!value.hasTrack) { setTrackState("none"); return; }
        return api<Track>(`/api/flight-logs/flights/${encodeURIComponent(flightId)}/track`)
          // A response that isn't a track (columns of arrays) is shown as a load error, never handed to the charts.
          .then(data => { if (!active) return; if (isTrack(data)) { setTrack(data); setTrackState("ready"); } else setTrackState("error"); }); })
      .catch(error => { if (!active) return;
        if (error instanceof ApiError && error.status === 404) setTrackState("none"); else setTrackState("error");
        setState(current => (current === "ready" ? current : "error")); });
    return () => { active = false; };
  }, [flightId, reloaded]);

  const time = useMemo(() => (series(track, "offsetMs") ?? []).map((value, i) => value ?? i * 100), [track]);
  const end = time.length ? time[time.length - 1]! : 0;
  const range: [number, number] = zoom ?? [0, Math.max(1, end)];

  const charts = useMemo(() => buildCharts(track), [track]);
  const minBattery = useMemo(() => { const values = series(track, "batteryPercent")?.filter((v): v is number => v != null && v > 0); return values?.length ? Math.min(...values) : null; }, [track]);

  // Replay: advance the shared position in real time multiplied by the chosen speed.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) { last.current = null; return; }
    let frame = 0;
    const step = (now: number) => {
      const delta = last.current == null ? 0 : now - last.current; last.current = now;
      setReplayAt(current => { const next = current + delta * speed; if (next >= end) { setPlaying(false); return end; } return next; });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, end]);

  const position = cursor ?? replayAt;
  const at = time.length ? indexAt(time, position) : -1;
  const value = (name: string) => { const values = track?.columns[name]; const v = at >= 0 ? values?.[at] : null; return typeof v === "number" ? v : null; };

  if (state === "loading") return <section className="flight-detail" aria-busy="true"><p className="flight-logs-status" role="status">Loading flight…</p></section>;
  if (state === "error" || !flight) return <section className="flight-detail"><p className="flight-logs-status error" role="alert">This flight couldn’t be loaded. Try again.</p></section>;

  return <section className="flight-detail" aria-label={flightTitle(flight)}>
    <header className="flight-detail-header">
      <div>
        <h2>{flightTitle(flight)}</h2>
        <p className="flight-detail-meta">{date(flight.startedAt)}
          {flight.pilotName && <span className="flight-chip">Pilot: {flight.pilotName}</span>}
          {canReassign && <ReassignFlight flightId={flight.id} pilotName={flight.pilotName ?? null} onDone={() => setReloaded(n => n + 1)} />}
          <span className="flight-chip">{equipmentLabel(flight.aircraft)}</span>
          {flight.aircraft && <span className="flight-chip">SN {masked(flight.aircraft.serial)}</span>}
          {flight.battery && <span className="flight-chip">Battery {masked(flight.battery.serial)}</span>}
          {flight.tags.map(tag => <span key={tag.tag} className={`flight-chip tag ${tag.kind}`}>{tag.tag}</span>)}
        </p>
      </div>
      {track && <ExportMenu flight={flight} track={track} />}
    </header>

    <div className="flight-stats">
      <Stat label="Duration" value={duration(flight.durationSeconds, true)} />
      <Stat label="Distance" value={miles(flight.distanceMeters)} />
      <Stat label="Max height" value={feet(flight.maxAltitudeMeters)} />
      <Stat label="Max speed" value={mph(flight.maxSpeedMetersPerSecond)} />
      <Stat label="Min battery" value={minBattery == null ? "—" : `${Math.round(minBattery)}%`} />
      <Stat label="Media" value={`${flight.media.photos} photos · ${flight.media.videos} videos`} />
    </div>

    {trackState === "loading" && <p className="flight-logs-status" role="status">Loading telemetry…</p>}
    {trackState === "none" && <p className="flight-logs-status">This flight has no telemetry track, so there’s no map or charts.</p>}
    {trackState === "error" && <p className="flight-logs-status error" role="alert">The telemetry track couldn’t be loaded.</p>}
    {track && <div className="flight-detail-body">
      <div className="flight-detail-charts">
        <div className="flight-chart-tools">
          <span>Drag across a chart to zoom</span>
          {zoom && <button type="button" className="button-ghost button-small" onClick={() => setZoom(null)}>Reset zoom</button>}
        </div>
        {charts.map(chart => <TelemetryChart key={chart.title} {...chart} time={time} cursor={cursor ?? (playing || replayAt ? replayAt : null)} onCursor={setCursor} range={range} onRange={setZoom} />)}
      </div>
      <div className="flight-detail-map">
        <FlightMap latitude={series(track, "latitude") ?? []} longitude={series(track, "longitude") ?? []} position={at} home={flight.home} />
        <div className="flight-replay" role="group" aria-label="Flight replay">
          <button type="button" className="button-orange button-small" onClick={() => { if (replayAt >= end) setReplayAt(0); setPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button>
          <input type="range" min={0} max={end} step={100} value={Math.round(replayAt)} aria-label="Replay position"
            onChange={event => { setPlaying(false); setReplayAt(Number(event.currentTarget.value)); }} />
          <span className="flight-replay-time">{clock(replayAt)} / {clock(end)}</span>
          <select value={speed} aria-label="Replay speed" onChange={event => setSpeed(Number(event.currentTarget.value))}>
            {SPEEDS.map(option => <option key={option} value={option}>{option}×</option>)}
          </select>
        </div>
        <dl className="flight-readout" aria-label="Telemetry at the current position">
          <div><dt>Time</dt><dd>{clock(position)}</dd></div>
          <div><dt>Height</dt><dd>{feet(value("heightMeters") ?? value("altitudeMeters"))}</dd></div>
          <div><dt>Speed</dt><dd>{mph(value("speedMetersPerSecond"))}</dd></div>
          <div><dt>Battery</dt><dd>{value("batteryPercent") == null ? "—" : `${Math.round(value("batteryPercent")!)}%`}</dd></div>
          <div><dt>Voltage</dt><dd>{value("batteryVoltage") == null ? "—" : `${value("batteryVoltage")!.toFixed(2)} V`}</dd></div>
          <div><dt>Satellites</dt><dd>{value("satellites") ?? "—"}</dd></div>
          <div><dt>Pitch / roll</dt><dd>{value("pitch") == null ? "—" : `${value("pitch")!.toFixed(1)}° / ${value("roll")?.toFixed(1) ?? "—"}°`}</dd></div>
          <div><dt>Heading</dt><dd>{value("yaw") == null ? "—" : `${Math.round(value("yaw")!)}°`}</dd></div>
        </dl>
      </div>
    </div>}

    {flight.messages.length > 0 && <section className="flight-messages" aria-label="In-flight app messages">
      <h3>App messages <small>{flight.messages.length.toLocaleString()}</small></h3>
      <ol>{flight.messages.slice(0, 500).map((message, i) => <li key={i} className={message.level}>
        <button type="button" onClick={() => { if (message.offsetMs != null) { setPlaying(false); setReplayAt(message.offsetMs); } }}>
          <time>{message.offsetMs == null ? "—" : clock(message.offsetMs)}</time><span className="level">{LEVEL_LABEL[message.level]}</span>{message.text}
        </button>
      </li>)}</ol>
      {flight.messages.length > 500 && <p className="flight-logs-status">Showing the first 500 of {flight.messages.length.toLocaleString()} messages.</p>}
    </section>}
    {flight.notes && <section className="flight-notes"><h3>Notes</h3><p>{flight.notes}</p></section>}
  </section>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flight-stat"><strong>{value}</strong><span>{label}</span></div>;
}

function buildCharts(track: Track | null): Array<{ title: string; series: ChartSeries[]; leftLabel?: string; rightLabel?: string }> {
  if (!track) return [];
  const ft = (v: number) => `${Math.round(v)} ft`, speed = (v: number) => `${v.toFixed(1)} mph`;
  const scale = (name: string, factor: number) => series(track, name)?.map(v => (v == null ? null : v * factor)) ?? null;
  const charts = [
    { title: "Height and speed", leftLabel: "ft", rightLabel: "mph", series: [
      { label: "Height", color: "#0e7fc0", values: scale("heightMeters", FEET) ?? scale("altitudeMeters", FEET), format: ft },
      { label: "VPS height", color: "#ee5007", values: scale("vpsHeightMeters", FEET), format: ft },
      { label: "Speed", color: "#2bb673", values: scale("speedMetersPerSecond", MPH), axis: "right" as const, format: speed },
    ] },
    { title: "Battery", leftLabel: "%", rightLabel: "V / °F", series: [
      { label: "Battery", color: "#f5b301", values: series(track, "batteryPercent"), format: (v: number) => `${Math.round(v)}%` },
      { label: "Voltage", color: "#0e7fc0", values: series(track, "batteryVoltage"), axis: "right" as const, format: (v: number) => `${v.toFixed(2)} V` },
      { label: "Temperature", color: "#a855f7", values: series(track, "batteryTemperatureC")?.map(v => (v == null ? null : v * 9 / 5 + 32)) ?? null, axis: "right" as const, format: (v: number) => `${Math.round(v)}°F` },
    ] },
    { title: "Attitude", leftLabel: "°", series: [
      { label: "Pitch", color: "#a855f7", values: series(track, "pitch"), format: (v: number) => `${v.toFixed(1)}°` },
      { label: "Roll", color: "#e11d48", values: series(track, "roll"), format: (v: number) => `${v.toFixed(1)}°` },
      { label: "Yaw", color: "#14b8a6", values: series(track, "yaw"), format: (v: number) => `${v.toFixed(0)}°` },
    ] },
    { title: "Signal", leftLabel: "%", rightLabel: "satellites", series: [
      { label: "RC signal", color: "#0e7fc0", values: series(track, "rcSignal"), format: (v: number) => `${Math.round(v)}%` },
      { label: "Satellites", color: "#2bb673", values: series(track, "satellites"), axis: "right" as const, format: (v: number) => `${Math.round(v)}` },
    ] },
  ];
  return charts.map(chart => ({ ...chart, series: chart.series.filter(item => item.values != null) as ChartSeries[] }))
    .filter(chart => chart.series.length > 0);
}

function ExportMenu({ flight, track }: { flight: Detail; track: Track }) {
  const name = flightTitle(flight).replace(/[^\w.-]+/g, "_");
  const save = (content: string, type: string, extension: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a"); link.href = url; link.download = `${name}.${extension}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const points = () => {
    const lat = series(track, "latitude") ?? [], lon = series(track, "longitude") ?? [], alt = series(track, "altitudeAbsMeters") ?? series(track, "altitudeMeters") ?? [], t = series(track, "offsetMs") ?? [];
    const start = flight.startedAt ? Date.parse(flight.startedAt) : 0;
    return lat.map((la, i) => ({ la, lo: lon[i], alt: alt[i], at: new Date(start + (t[i] ?? 0)).toISOString() })).filter(p => p.la != null && p.lo != null && !(p.la === 0 && p.lo === 0));
  };
  const gpx = () => save(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Ledge Top" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(flightTitle(flight))}</name><trkseg>\n${
    points().map(p => `<trkpt lat="${p.la}" lon="${p.lo}">${p.alt != null ? `<ele>${p.alt}</ele>` : ""}<time>${p.at}</time></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`, "application/gpx+xml", "gpx");
  const kml = () => save(`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(flightTitle(flight))}</name><Placemark><LineString><altitudeMode>absolute</altitudeMode><coordinates>\n${
    points().map(p => `${p.lo},${p.la},${p.alt ?? 0}`).join("\n")}\n</coordinates></LineString></Placemark></Document></kml>\n`, "application/vnd.google-earth.kml+xml", "kml");
  const csv = () => {
    const names = Object.keys(track.columns), rows = [names.join(",")];
    for (let i = 0; i < track.rowCount; i++) rows.push(names.map(n => { const v = track.columns[n]?.[i]; return v == null ? "" : typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v); }).join(","));
    save(rows.join("\n"), "text/csv", "csv");
  };
  return <div className="flight-export" role="group" aria-label="Export this flight">
    <span>Export</span>
    <button type="button" className="button-ghost button-small" onClick={gpx}>GPX</button>
    <button type="button" className="button-ghost button-small" onClick={kml}>KML</button>
    <button type="button" className="button-ghost button-small" onClick={csv}>CSV</button>
  </div>;
}

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
