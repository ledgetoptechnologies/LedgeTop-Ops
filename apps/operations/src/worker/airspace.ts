import type { Env } from "./types";

const TFR_LIST = "https://tfr.faa.gov/tfrapi/getTfrList";
const TFR_NO_SHAPE = "https://tfr.faa.gov/tfrapi/noShapeTfrList";
const TFR_WFS = "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&outputFormat=application%2Fjson&srsname=EPSG:4326";
const SUA_WFS = "https://sua.faa.gov/geoserver/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=SUA:schedule&outputFormat=application%2Fjson&srsName=EPSG%3A4326";
const WI = { minLat: 42.49, minLon: -92.89, maxLat: 47.31, maxLon: -86.25 };
type JsonRow = Record<string, unknown>;
interface Geometry { type: string; coordinates: unknown }
interface Feature { type: string; id?: string; geometry?: Geometry; properties: JsonRow }
interface FeatureCollection { type: string; features: Feature[]; totalFeatures?: number | string; numberMatched?: number | string; numberReturned?: number | string }
interface Interval { start: string; end: string }

function normalizeNotam(value: unknown): string { return String(value || "").toUpperCase().replace(/\s+/g, "").match(/\d+\/\d+/)?.[0] || String(value || "").trim(); }
function tag(xml: string, name: string): string | null { const match = new RegExp(`<[^>]*${name}[^>]*>([^<]+)<\\/[^>]*${name}>`, "i").exec(xml); return match ? match[1]!.trim() : null; }
function iso(value: string | null): string | null { if (!value) return null; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); }

export function bbox(geometry: Geometry | undefined): { minLat: number; minLon: number; maxLat: number; maxLon: number } | null {
  if (!geometry) return null; const values: number[][] = [];
  const visit = (node: unknown) => { if (Array.isArray(node) && node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") values.push([node[0], node[1]]); else if (Array.isArray(node)) node.forEach(visit); };
  visit(geometry.coordinates); if (!values.length) return null;
  return { minLon: Math.min(...values.map(value => value[0]!)), maxLon: Math.max(...values.map(value => value[0]!)), minLat: Math.min(...values.map(value => value[1]!)), maxLat: Math.max(...values.map(value => value[1]!)) };
}
export function intersectsWI(box: ReturnType<typeof bbox>): boolean { return Boolean(box && box.minLon <= WI.maxLon && box.maxLon >= WI.minLon && box.minLat <= WI.maxLat && box.maxLat >= WI.minLat); }
export function tfrStatus(start: string | null, end: string | null): "scheduled" | "active" | "expired" | "unknown" { const now = Date.now(), a = start ? new Date(start).getTime() : NaN, b = end ? new Date(end).getTime() : NaN; if (Number.isFinite(b) && b < now) return "expired"; if (Number.isFinite(a) && a > now) return "scheduled"; if (Number.isFinite(a) && Number.isFinite(b) && a <= now && b >= now) return "active"; return "unknown"; }
export function suaStatus(value: unknown, start: string | null, end: string | null): "active" | "upcoming" | "pending" | "not_listed" | "expired" | "unknown" { if (!start && !end) return "not_listed"; if (end && new Date(end).getTime() < Date.now()) return "expired"; const status = String(value || "").toUpperCase(); if (status === "H" || status.includes("HOT")) return "active"; if (status === "W" || status.includes("WAITING")) return "upcoming"; if (status === "P" || status.includes("PENDING")) return "pending"; return "unknown"; }

function statusForIntervals(intervals: Interval[]): "scheduled" | "active" | "expired" | "unknown" { if (!intervals.length) return "unknown"; const statuses = intervals.map(value => tfrStatus(value.start, value.end)); if (statuses.includes("active")) return "active"; if (statuses.includes("scheduled")) return "scheduled"; if (statuses.every(value => value === "expired")) return "expired"; return "unknown"; }
function detailIntervals(xml: string): Interval[] {
  const groups = [...xml.matchAll(/<[^>]*ScheduleGroup[^>]*>([\s\S]*?)<\/[^>]*ScheduleGroup>/gi)].map(match => match[1]!);
  const sources = groups.length ? groups : [xml]; const result: Interval[] = [];
  for (const source of sources) { const start = iso(tag(source, "dateEffective")), end = iso(tag(source, "dateExpire")); if (start && end && !result.some(value => value.start === start && value.end === end)) result.push({ start, end }); }
  return result;
}
async function fetchJson(url: string): Promise<unknown> { const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "LTDS-Ops/1.0 airspace-awareness" } }); if (!response.ok) throw new Error(`http-${response.status}`); return response.json(); }
function asRows(value: unknown): JsonRow[] { if (Array.isArray(value)) return value as JsonRow[]; if (value && typeof value === "object") { for (const key of ["data", "items", "tfrList", "results"]) { const rows = (value as JsonRow)[key]; if (Array.isArray(rows)) return rows as JsonRow[]; } } throw new Error("invalid-list-schema"); }

export function regionalWfsUrl(source: string): string {
  const url = new URL(source);
  url.searchParams.set("bbox", `${WI.minLon},${WI.minLat},${WI.maxLon},${WI.maxLat},EPSG:4326`);
  url.searchParams.set("maxFeatures", "1000");
  return url.toString();
}
async function fetchWfs(source: string): Promise<Feature[]> {
  const raw = await fetchJson(regionalWfsUrl(source)) as FeatureCollection;
  if (raw?.type !== "FeatureCollection" || !Array.isArray(raw.features)) throw new Error("invalid-wfs-schema");
  const total = Number(raw.totalFeatures ?? raw.numberMatched);
  if (Number.isFinite(total) && total > raw.features.length) throw new Error("wfs-truncated");
  return raw.features;
}
async function detail(notam: string): Promise<{ issued: string | null; intervals: Interval[]; start: string | null; end: string | null }> {
  const response = await fetch(`https://tfr.faa.gov/download/detail_${notam.replace("/", "_")}.xml`, { headers: { Accept: "application/xml" } });
  if (!response.ok) return { issued: null, intervals: [], start: null, end: null };
  const xml = await response.text(), intervals = detailIntervals(xml);
  return { issued: iso(tag(xml, "dateIssued")), intervals, start: intervals.length ? intervals.map(value => value.start).sort()[0]! : iso(tag(xml, "dateEffective")), end: intervals.length ? intervals.map(value => value.end).sort().at(-1)! : iso(tag(xml, "dateExpire")) };
}
async function batches(db: D1Database, statements: D1PreparedStatement[]) { for (let index = 0; index < statements.length; index += 75) await db.batch(statements.slice(index, index + 75)); }
async function health(env: Env, source: string, status: "fresh" | "error", error?: string) {
  await env.OPS_DB.prepare(`INSERT INTO airspace_source_health (source,last_attempt_at,last_success_at,status,consecutive_failures,last_error_code,updated_at) VALUES (?,datetime('now'),${status === "fresh" ? "datetime('now')" : "NULL"},?,${status === "fresh" ? "0" : "1"},?,datetime('now')) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=${status === "fresh" ? "datetime('now')" : "last_success_at"},status=?,consecutive_failures=${status === "fresh" ? "0" : "consecutive_failures+1"},last_error_code=?,updated_at=datetime('now')`).bind(source, status, error || null, status, error || null).run();
}

export async function refreshTfrs(env: Env): Promise<number> {
  try {
    const [listedRaw, noShapeRaw, features] = await Promise.all([fetchJson(TFR_LIST), fetchJson(TFR_NO_SHAPE), fetchWfs(TFR_WFS)]);
    const geometryByNotam = new Map<string, Feature[]>();
    for (const feature of features) { const key = normalizeNotam(feature.properties.NOTAM_KEY ?? feature.properties.notam_id); if (!key) continue; const current = geometryByNotam.get(key) || []; current.push(feature); geometryByNotam.set(key, current); }
    const rows = new Map<string, JsonRow>();
    for (const row of [...asRows(listedRaw), ...asRows(noShapeRaw)]) { const key = normalizeNotam(row.notam_id ?? row.NOTAM_KEY); if (key) rows.set(key, row); }
    for (const [key, values] of geometryByNotam) if (!rows.has(key)) rows.set(key, values[0]!.properties);
    const selected = [...rows.entries()].filter(([key, row]) => { const state = String(row.state ?? row.STATE ?? "").toUpperCase(); return state === "WI" || state === "USA" || (geometryByNotam.get(key) || []).some(feature => intersectsWI(bbox(feature.geometry))); });
    const details = new Map<string, Awaited<ReturnType<typeof detail>>>();
    for (let index = 0; index < selected.length; index += 8) { const chunk = selected.slice(index, index + 8), values = await Promise.all(chunk.map(([key]) => detail(key))); chunk.forEach(([key], item) => details.set(key, values[item]!)); }
    const statements: D1PreparedStatement[] = [env.OPS_DB.prepare("UPDATE tfr_notices SET missing_snapshots=missing_snapshots+1")];
    for (const [key, row] of selected) {
      const id = `tfr-${key.replace(/[^a-z0-9]/gi, "-")}`, info = details.get(key)!, geometries = geometryByNotam.get(key) || [], status = info.intervals.length ? statusForIntervals(info.intervals) : tfrStatus(info.start, info.end);
      statements.push(env.OPS_DB.prepare(`INSERT INTO tfr_notices (id,notam_id,facility,state,type,title,description,status,issued_at,effective_at,expires_at,official_url,geometry_available,missing_snapshots,source_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(notam_id) DO UPDATE SET facility=excluded.facility,state=excluded.state,type=excluded.type,title=excluded.title,description=excluded.description,status=excluded.status,issued_at=excluded.issued_at,effective_at=excluded.effective_at,expires_at=excluded.expires_at,official_url=excluded.official_url,geometry_available=excluded.geometry_available,missing_snapshots=0,source_updated_at=excluded.source_updated_at,updated_at=datetime('now')`).bind(id, key, row.facility ?? null, row.state ?? row.STATE ?? null, row.type ?? null, row.description ?? row.TITLE ?? key, row.description ?? null, status, info.issued, info.start, info.end, `https://tfr.faa.gov/tfr3/?page=detail_${key.replace("/", "_")}`, geometries.length ? 1 : 0, row.mod_date ?? row.LAST_MODIFICATION_DATETIME ?? null));
      statements.push(env.OPS_DB.prepare("DELETE FROM tfr_effective_intervals WHERE tfr_id=?").bind(id), env.OPS_DB.prepare("DELETE FROM tfr_geometries WHERE tfr_id=?").bind(id));
      for (const interval of info.intervals) statements.push(env.OPS_DB.prepare("INSERT INTO tfr_effective_intervals (id,tfr_id,starts_at,ends_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(), id, interval.start, interval.end));
      if (!info.intervals.length && info.start && info.end) statements.push(env.OPS_DB.prepare("INSERT INTO tfr_effective_intervals (id,tfr_id,starts_at,ends_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(), id, info.start, info.end));
      for (const feature of geometries) { const box = bbox(feature.geometry); statements.push(env.OPS_DB.prepare("INSERT INTO tfr_geometries (id,tfr_id,geojson,min_lat,min_lon,max_lat,max_lon) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), id, JSON.stringify(feature.geometry), box?.minLat ?? null, box?.minLon ?? null, box?.maxLat ?? null, box?.maxLon ?? null)); }
    }
    statements.push(env.OPS_DB.prepare("UPDATE tfr_notices SET status='withdrawn' WHERE missing_snapshots>=2 AND status NOT IN ('expired','withdrawn')")); await batches(env.OPS_DB, statements); await health(env, "faa-tfr", "fresh"); return selected.length;
  } catch (error) { await health(env, "faa-tfr", "error", error instanceof Error ? error.message.slice(0, 100) : "unknown"); throw error; }
}

export async function refreshSua(env: Env): Promise<number> {
  try {
    const features = await fetchWfs(SUA_WFS), statements: D1PreparedStatement[] = [env.OPS_DB.prepare("UPDATE sua_reservations SET missing_snapshots=missing_snapshots+1")]; let count = 0;
    for (const feature of features) {
      const properties = feature.properties, box = bbox(feature.geometry); if (!intersectsWI(box) || !feature.geometry) continue;
      const airspaceId = String(properties.airspace_id ?? feature.id ?? ""), gid = String(properties.gid ?? feature.id ?? ""); if (!airspaceId) continue;
      const areaId = `${airspaceId}:${gid || airspaceId}`, start = iso(String(properties.start_time ?? "") || null), end = iso(String(properties.end_time ?? "") || null), schedule = String(properties.sched_id ?? "0"), reservationId = `${areaId}:${schedule}`;
      statements.push(env.OPS_DB.prepare(`INSERT INTO sua_areas (id,gid,name,airspace_type,geojson,low_altitude,high_altitude,min_lat,min_lon,max_lat,max_lon) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET gid=excluded.gid,name=excluded.name,airspace_type=excluded.airspace_type,geojson=excluded.geojson,low_altitude=excluded.low_altitude,high_altitude=excluded.high_altitude,min_lat=excluded.min_lat,min_lon=excluded.min_lon,max_lat=excluded.max_lat,max_lon=excluded.max_lon,updated_at=datetime('now')`).bind(areaId, gid, String(properties.airspace_name ?? airspaceId), String(properties.airspace_type ?? "unknown"), JSON.stringify(feature.geometry), properties.low_altitude ?? null, properties.high_altitude ?? null, box!.minLat, box!.minLon, box!.maxLat, box!.maxLon));
      statements.push(env.OPS_DB.prepare(`INSERT INTO sua_reservations (id,area_id,status,starts_at,ends_at,low_altitude,high_altitude,remarks,source_updated_at,missing_snapshots) VALUES (?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET area_id=excluded.area_id,status=excluded.status,starts_at=excluded.starts_at,ends_at=excluded.ends_at,low_altitude=excluded.low_altitude,high_altitude=excluded.high_altitude,remarks=excluded.remarks,source_updated_at=excluded.source_updated_at,missing_snapshots=0,updated_at=datetime('now')`).bind(reservationId, areaId, suaStatus(properties.status_id, start, end), start, end, properties.low_altitude ?? null, properties.high_altitude ?? null, properties.remarks ?? null, properties.update_date ?? null)); count += 1;
    }
    statements.push(env.OPS_DB.prepare("UPDATE sua_reservations SET status='expired',updated_at=datetime('now') WHERE missing_snapshots>=2 AND status<>'expired'"));
    await batches(env.OPS_DB, statements); await health(env, "faa-sua", "fresh"); return count;
  } catch (error) { await health(env, "faa-sua", "error", error instanceof Error ? error.message.slice(0, 100) : "unknown"); throw error; }
}

function pointInRing(lon: number, lat: number, ring: unknown): boolean { if (!Array.isArray(ring)) return false; let inside = false; for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) { const a = ring[index], b = ring[previous]; if (!Array.isArray(a) || !Array.isArray(b)) continue; const ax = Number(a[0]), ay = Number(a[1]), bx = Number(b[0]), by = Number(b[1]); if ((ay > lat) !== (by > lat) && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) inside = !inside; } return inside; }
function pointInGeometry(lon: number, lat: number, geometry: Geometry): boolean { if (geometry.type === "Polygon") return Array.isArray(geometry.coordinates) && pointInRing(lon, lat, geometry.coordinates[0]); if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) return geometry.coordinates.some(polygon => Array.isArray(polygon) && pointInRing(lon, lat, polygon[0])); return false; }
function distanceToBoxNm(lat: number, lon: number, box: NonNullable<ReturnType<typeof bbox>>): number { const clampedLat = Math.max(box.minLat, Math.min(box.maxLat, lat)), clampedLon = Math.max(box.minLon, Math.min(box.maxLon, lon)); const latNm = (lat - clampedLat) * 60, lonNm = (lon - clampedLon) * 60 * Math.cos(lat * Math.PI / 180); return Math.hypot(latNm, lonNm); }

export async function rebuildOperationAirspaceMatches(env: Env): Promise<number> {
  const [operations, tfrs, suas] = await Promise.all([
    env.OPS_DB.prepare("SELECT id,latitude,longitude,scheduled_start,scheduled_end FROM operations WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND status IN ('scheduled','ready','blocked','in_progress')").all<{ id: string; latitude: number; longitude: number; scheduled_start: string | null; scheduled_end: string | null }>(),
    env.OPS_DB.prepare("SELECT n.id,n.effective_at,n.expires_at,g.geojson,g.min_lat,g.min_lon,g.max_lat,g.max_lon FROM tfr_notices n JOIN tfr_geometries g ON g.tfr_id=n.id WHERE n.status IN ('active','scheduled')").all<any>(),
    env.OPS_DB.prepare("SELECT r.id,r.starts_at,r.ends_at,a.geojson,a.min_lat,a.min_lon,a.max_lat,a.max_lon FROM sua_reservations r JOIN sua_areas a ON a.id=r.area_id WHERE r.status IN ('active','upcoming','pending')").all<any>(),
  ]);
  const statements: D1PreparedStatement[] = [env.OPS_DB.prepare("DELETE FROM operation_airspace_matches")]; let count = 0;
  for (const operation of operations.results) {
    const opStart = operation.scheduled_start ? new Date(operation.scheduled_start).getTime() : Date.now(), opEnd = operation.scheduled_end ? new Date(operation.scheduled_end).getTime() : opStart;
    for (const item of [...tfrs.results.map(value => ({ ...value, source: "tfr", start: value.effective_at, end: value.expires_at })), ...suas.results.map(value => ({ ...value, source: "sua", start: value.starts_at, end: value.ends_at }))]) {
      const start = item.start ? new Date(item.start).getTime() : Number.NEGATIVE_INFINITY, end = item.end ? new Date(item.end).getTime() : Number.POSITIVE_INFINITY; if (end < opStart || start > opEnd) continue;
      const box = { minLat: item.min_lat, minLon: item.min_lon, maxLat: item.max_lat, maxLon: item.max_lon }; if (Object.values(box).some(value => typeof value !== "number")) continue;
      const geometry = JSON.parse(item.geojson) as Geometry, intersects = pointInGeometry(operation.longitude, operation.latitude, geometry), nearby = !intersects && distanceToBoxNm(operation.latitude, operation.longitude, box) <= 5; if (!intersects && !nearby) continue;
      statements.push(env.OPS_DB.prepare("INSERT INTO operation_airspace_matches (operation_id,source_type,source_id,match_type) VALUES (?,?,?,?)").bind(operation.id, item.source, item.id, intersects ? "intersects" : "nearby")); count += 1;
    }
  }
  await batches(env.OPS_DB, statements); return count;
}

export async function markAirspaceStaleAndPurge(env: Env): Promise<void> {
  await env.OPS_DB.batch([env.OPS_DB.prepare("UPDATE airspace_source_health SET status='stale',updated_at=datetime('now') WHERE status='fresh' AND last_success_at<datetime('now','-15 minutes')"), env.OPS_DB.prepare("DELETE FROM tfr_effective_intervals WHERE tfr_id IN (SELECT id FROM tfr_notices WHERE status IN ('expired','withdrawn') AND COALESCE(expires_at,updated_at)<datetime('now','-24 hours'))"), env.OPS_DB.prepare("DELETE FROM tfr_geometries WHERE tfr_id IN (SELECT id FROM tfr_notices WHERE status IN ('expired','withdrawn') AND COALESCE(expires_at,updated_at)<datetime('now','-24 hours'))"), env.OPS_DB.prepare("DELETE FROM tfr_notices WHERE status IN ('expired','withdrawn') AND COALESCE(expires_at,updated_at)<datetime('now','-24 hours')"), env.OPS_DB.prepare("DELETE FROM sua_reservations WHERE status='expired' AND COALESCE(ends_at,updated_at)<datetime('now','-24 hours')")]);
}

export async function airspaceView(env: Env) {
  const [healthRows, tfrs, sua, matches] = await Promise.all([env.OPS_DB.prepare("SELECT * FROM airspace_source_health ORDER BY source").all(), env.OPS_DB.prepare("SELECT id,notam_id,title,description,status,effective_at,expires_at,official_url,geometry_available,state,type FROM tfr_notices WHERE status IN ('active','scheduled','unknown') ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,effective_at LIMIT 200").all(), env.OPS_DB.prepare("SELECT r.id,r.status,r.starts_at,r.ends_at,r.low_altitude,r.high_altitude,r.remarks,a.name,a.airspace_type FROM sua_reservations r JOIN sua_areas a ON a.id=r.area_id WHERE r.status IN ('active','upcoming','pending','not_listed','unknown') ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,r.starts_at LIMIT 250").all(), env.OPS_DB.prepare("SELECT m.operation_id,m.source_type,m.source_id,m.match_type,o.title operation_title,CASE m.source_type WHEN 'tfr' THEN COALESCE((SELECT n.notam_id || ' · ' || n.title FROM tfr_notices n WHERE n.id=m.source_id),'TFR') ELSE COALESCE((SELECT a.name FROM sua_reservations r JOIN sua_areas a ON a.id=r.area_id WHERE r.id=m.source_id),'SUA / MOA') END source_title FROM operation_airspace_matches m JOIN operations o ON o.id=m.operation_id ORDER BY o.scheduled_start").all()]);
  return { sources: healthRows.results, tfrs: tfrs.results, sua: sua.results, operationMatches: matches.results, disclaimer: "Situational awareness only. Verify current NOTAMs, TFRs, SUA status, and authorization with official FAA sources before flight. No listed restriction is not a clearance." };
}
