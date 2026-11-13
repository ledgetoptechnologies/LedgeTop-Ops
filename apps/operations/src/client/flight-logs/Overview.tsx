import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BASEMAPS } from "./basemaps";
import { api } from "../api";
import { duration, equipmentLabel, feet, filterQuery, flightTitle, masked, miles, mph, shortDate, type Filters } from "./format";

interface OverviewData {
  totals: { flights: number; durationSeconds: number; distanceMeters: number; dataPoints: number; maxAltitudeMeters: number | null; maxSpeedMetersPerSecond: number | null;
    photos: number; videos: number; averageDistanceMeters: number | null; averageDurationSeconds: number | null; averageSpeedMetersPerSecond: number | null };
  activity: Array<{ day: string; flights: number; durationSeconds: number }>; byHour: Array<{ hour: number; flights: number }>;
  byAircraft: Array<{ id: string; serial: string; model: string | null; name: string | null; flights: number; durationSeconds: number }>;
  byBattery: Array<{ id: string; serial: string; flights: number; durationSeconds: number }>;
  byDuration: { short: number; mid: number; long: number };
  locations: Array<{ id: string; displayName: string | null; startedAt: string | null; latitude: number; longitude: number }>;
  batteryHealth: Array<{ id: string; serial: string; cycles: number | null; lifePercent: number | null; flights: number; durationSeconds: number }>;
  longest: Array<{ id: string; displayName: string | null; startedAt: string | null; value: number }>;
  furthest: Array<{ id: string; displayName: string | null; startedAt: string | null; value: number }>;
}
const PALETTE = ["#ee5007", "#0e7fc0", "#2bb673", "#f5b301", "#a855f7", "#e11d48", "#14b8a6", "#64748b"];

export function Overview({ filters, onOpenFlight }: { filters: Filters; onOpenFlight: (id: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState(false);
  const query = filterQuery(filters);
  useEffect(() => {
    let active = true; setError(false);
    api<OverviewData>(`/api/flight-logs/overview${query ? `?${query}` : ""}`).then(value => { if (active) setData(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [query]);

  if (error) return <p className="flight-logs-status error" role="alert">The overview couldn’t be loaded. Try again.</p>;
  if (!data) return <p className="flight-logs-status" role="status">Loading overview…</p>;
  const t = data.totals;
  if (!t.flights) return <p className="flight-logs-status">No flights match these filters.</p>;
  return <section className="flight-overview" aria-label="Fleet overview">
    <div className="flight-stats large">
      <Tile label="Flights" value={t.flights.toLocaleString()} />
      <Tile label="Distance" value={miles(t.distanceMeters)} />
      <Tile label="Flight time" value={duration(t.durationSeconds, true)} />
      <Tile label="Data points" value={t.dataPoints.toLocaleString()} />
    </div>
    <div className="flight-stats">
      <Tile label="Max height" value={feet(t.maxAltitudeMeters)} />
      <Tile label="Max speed" value={mph(t.maxSpeedMetersPerSecond)} />
      <Tile label="Avg distance / flight" value={miles(t.averageDistanceMeters)} />
      <Tile label="Avg duration / flight" value={duration(t.averageDurationSeconds, true)} />
      <Tile label="Photos · videos" value={`${t.photos.toLocaleString()} · ${t.videos.toLocaleString()}`} />
    </div>
    <div className="flight-overview-grid">
      <Panel title="Flight activity" wide><Heatmap activity={data.activity} /></Panel>
      <Panel title="Flight time by aircraft"><Bars items={data.byAircraft.map(item => ({ label: equipmentLabel(item), value: item.durationSeconds, detail: `${duration(item.durationSeconds, true)} · ${item.flights} flights` }))} /></Panel>
      <Panel title="Flights by aircraft"><Donut items={data.byAircraft.map(item => ({ label: equipmentLabel(item), value: item.flights }))} /></Panel>
      <Panel title="Flights by battery"><Donut items={data.byBattery.slice(0, 8).map(item => ({ label: `Battery ${masked(item.serial)}`, value: item.flights }))} /></Panel>
      <Panel title="Flights by duration"><Donut items={[{ label: "Short (under 10 min)", value: data.byDuration.short }, { label: "Medium (10–20 min)", value: data.byDuration.mid }, { label: "Long (over 20 min)", value: data.byDuration.long }]} /></Panel>
      <Panel title="Time of day"><HourBars byHour={data.byHour} /></Panel>
      <Panel title="Flight locations" wide><Locations points={data.locations} onOpenFlight={onOpenFlight} /></Panel>
      <Panel title="Battery health">
        {data.batteryHealth.length ? <ul className="flight-battery-health">{data.batteryHealth.map(item => <li key={item.id}>
          <span>Battery {masked(item.serial)}</span>
          <meter min={0} max={100} low={60} high={80} optimum={100} value={item.lifePercent ?? 0} aria-label={`Battery ${masked(item.serial)} health`} />
          <small>{item.lifePercent == null ? "Health unknown" : `${item.lifePercent}%`} · {item.cycles ?? "—"} cycles · {item.flights} flights · {duration(item.durationSeconds, true)}</small>
        </li>)}</ul> : <p className="flight-logs-status">No battery serials were recorded.</p>}
      </Panel>
      <Panel title="Top flights">
        <h4>Longest</h4><TopList items={data.longest} value={item => duration(item.value, true)} onOpenFlight={onOpenFlight} />
        <h4>Furthest</h4><TopList items={data.furthest} value={item => miles(item.value)} onOpenFlight={onOpenFlight} />
      </Panel>
    </div>
  </section>;
}

function Tile({ label, value }: { label: string; value: string }) { return <div className="flight-stat"><strong>{value}</strong><span>{label}</span></div>; }
function Panel({ title, wide, children }: { title: string; wide?: boolean; children: React.ReactNode }) {
  return <section className={`flight-panel${wide ? " wide" : ""}`}><h3>{title}</h3>{children}</section>;
}

/** One square per day for the last year (weeks as columns), shaded by flights that day. */
function Heatmap({ activity }: { activity: OverviewData["activity"] }) {
  const byDay = new Map(activity.map(item => [item.day, item]));
  const last = activity.length ? new Date(`${activity[activity.length - 1]!.day}T12:00:00`) : new Date();
  const end = new Date(Math.max(Date.now(), last.getTime())), start = new Date(end); start.setDate(start.getDate() - 364 - start.getDay());
  const days: Array<{ key: string; date: Date }> = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push({ key: d.toISOString().slice(0, 10), date: new Date(d) });
  const max = Math.max(1, ...activity.map(item => item.flights)), size = 12, gap = 3;
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const weeks = Math.ceil(days.length / 7);
  return <div className="flight-heatmap">
    <svg viewBox={`0 0 ${weeks * (size + gap) + 30} ${7 * (size + gap) + 18}`} role="img" aria-label={`Flights per day over the last year; busiest day had ${max} flights`}>
      {["Mon", "Wed", "Fri"].map((label, i) => <text key={label} x={0} y={18 + (i * 2 + 1) * (size + gap) + size - 2} className="axis">{label}</text>)}
      {days.map((day, i) => { const item = byDay.get(day.key), n = item?.flights ?? 0, week = Math.floor(i / 7);
        return <rect key={day.key} x={30 + week * (size + gap)} y={18 + day.date.getDay() * (size + gap)} width={size} height={size} rx={2} className={`level-${level(n)}`}>
          <title>{`${shortDate(`${day.key}T12:00:00`)}: ${n} ${n === 1 ? "flight" : "flights"}${item ? ` · ${duration(item.durationSeconds, true)}` : ""}`}</title>
        </rect>; })}
      {days.filter(day => day.date.getDate() === 1).map(day => { const week = Math.floor(days.indexOf(day) / 7);
        return <text key={`m${day.key}`} x={30 + week * (size + gap)} y={11} className="axis">{day.date.toLocaleDateString(undefined, { month: "short" })}</text>; })}
    </svg>
    <p className="flight-heatmap-legend">Less {[0, 1, 2, 3, 4].map(n => <i key={n} className={`level-${n}`} />)} More</p>
  </div>;
}

function Bars({ items }: { items: Array<{ label: string; value: number; detail: string }> }) {
  const max = Math.max(1, ...items.map(item => item.value));
  return <ul className="flight-bars">{items.map((item, i) => <li key={item.label + i}>
    <span>{item.label}</span><div><i style={{ width: `${(item.value / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></div><small>{item.detail}</small>
  </li>)}</ul>;
}

function Donut({ items }: { items: Array<{ label: string; value: number }> }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) return <p className="flight-logs-status">Nothing recorded.</p>;
  const radius = 42, circumference = 2 * Math.PI * radius;
  let offset = 0;
  return <div className="flight-donut">
    <svg viewBox="0 0 120 120" role="img" aria-label={items.map(item => `${item.label}: ${item.value}`).join(", ")}>
      {items.map((item, i) => { const length = (item.value / total) * circumference, dash = `${Math.max(0, length - 1.5)} ${circumference}`;
        const circle = <circle key={item.label} cx={60} cy={60} r={radius} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={16} strokeDasharray={dash} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />;
        offset += length; return circle; })}
      <text x={60} y={64} textAnchor="middle" className="total">{total.toLocaleString()}</text>
    </svg>
    <ul>{items.map((item, i) => <li key={item.label}><i style={{ background: PALETTE[i % PALETTE.length] }} />{item.label} <small>{item.value.toLocaleString()} ({Math.round((item.value / total) * 100)}%)</small></li>)}</ul>
  </div>;
}

function HourBars({ byHour }: { byHour: OverviewData["byHour"] }) {
  const counts = Array.from({ length: 24 }, (_, hour) => byHour.find(item => item.hour === hour)?.flights ?? 0), max = Math.max(1, ...counts);
  return <svg className="flight-hours" viewBox="0 0 240 90" role="img" aria-label="Flights by hour of day (log time)">
    {counts.map((n, hour) => <rect key={hour} x={hour * 10 + 1} y={70 - (n / max) * 64} width={8} height={(n / max) * 64} rx={1.5}><title>{`${hour}:00 – ${n} flights`}</title></rect>)}
    {[0, 6, 12, 18].map(hour => <text key={hour} x={hour * 10 + 1} y={84} className="axis">{hour === 0 ? "12a" : hour === 12 ? "12p" : hour < 12 ? `${hour}a` : `${hour - 12}p`}</text>)}
  </svg>;
}

function TopList({ items, value, onOpenFlight }: { items: OverviewData["longest"]; value: (item: OverviewData["longest"][number]) => string; onOpenFlight: (id: string) => void }) {
  return <ol className="flight-top">{items.map(item => <li key={item.id}><button type="button" onClick={() => onOpenFlight(item.id)}>
    <span>{flightTitle(item)}<small>{shortDate(item.startedAt)}</small></span><strong>{value(item)}</strong>
  </button></li>)}</ol>;
}

/** Home points on Esri imagery, grouped into counted circles that split apart as you zoom in. */
function Locations({ points, onOpenFlight }: { points: OverviewData["locations"]; onOpenFlight: (id: string) => void }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!node.current || !points.length) return;
    const map = L.map(node.current, { scrollWheelZoom: false, preferCanvas: true });
    map.on("focus", () => map.scrollWheelZoom.enable());
    map.on("blur", () => map.scrollWheelZoom.disable());
    L.tileLayer(BASEMAPS.topo.url, { maxZoom: 19, maxNativeZoom: BASEMAPS.topo.maxNativeZoom, attribution: BASEMAPS.topo.attribution }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    const draw = () => {
      layer.clearLayers();
      // Group points that fall within ~44 px of each other at this zoom.
      const cells = new Map<string, OverviewData["locations"]>();
      for (const point of points) {
        const p = map.project([point.latitude, point.longitude], map.getZoom());
        const key = `${Math.floor(p.x / 44)}:${Math.floor(p.y / 44)}`;
        cells.set(key, [...(cells.get(key) ?? []), point]);
      }
      for (const group of cells.values()) {
        const lat = group.reduce((sum, p) => sum + p.latitude, 0) / group.length, lon = group.reduce((sum, p) => sum + p.longitude, 0) / group.length;
        if (group.length === 1) {
          const only = group[0]!;
          const label = document.createElement("span");
          label.textContent = only.displayName ?? shortDate(only.startedAt);
          L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#0e7fc0", fillOpacity: 1 })
            .bindTooltip(label).on("click", () => onOpenFlight(only.id)).addTo(layer);
        } else {
          L.marker([lat, lon], { keyboard: false, title: `${group.length} flights`, icon: L.divIcon({ className: "",
            html: `<div class="flight-cluster" aria-hidden="true">${group.length}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) })
            .on("click", () => map.setView([lat, lon], Math.min(map.getZoom() + 2, 18))).addTo(layer);
        }
      }
    };
    map.on("zoomend", draw);
    map.fitBounds(L.latLngBounds(points.map(p => [p.latitude, p.longitude] as [number, number])), { padding: [28, 28], maxZoom: 12 });
    draw();
    return () => { map.remove(); };
  }, [points, onOpenFlight]);
  if (!points.length) return <p className="flight-logs-status">No flight locations were recorded.</p>;
  return <div ref={node} className="flight-locations" role="region" tabIndex={0} aria-label={`Map of ${points.length} flight home points`} />;
}
