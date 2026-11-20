// Shared types and units for the flight-log workspace. Values arrive in metric (as logged) and are shown
// in US units, which is what Ledge Top pilots work in (Part 107: feet, mph).
export interface Equipment { id: string; serial: string; model?: string | null; name?: string | null }
export interface FlightItem {
  id: string; displayName: string | null; fileName: string | null; startedAt: string | null; durationSeconds: number | null;
  distanceMeters: number | null; maxAltitudeMeters: number | null; maxSpeedMetersPerSecond: number | null; pilotId: string; pilotName?: string | null;
  media: { photos: number; videos: number }; hasTrack: boolean; rawLog: "missing" | "stored"; color: string | null;
  home: { latitude: number; longitude: number } | null; aircraft: Equipment | null; battery: (Equipment & { lifePercent: number | null }) | null; tags: string[];
}
export interface FlightDetail extends Omit<FlightItem, "tags"> {
  endedAt: string | null; notes: string | null; telemetryPoints: number; batteryCycleCount: number | null; controller: { serial: string } | null;
  tags: Array<{ tag: string; kind: "auto" | "manual" }>; messages: Array<{ offsetMs: number | null; level: "tip" | "caution" | "warn"; text: string }>;
}
export interface Track { rowCount: number; columns: Record<string, Array<number | string | boolean | null>> }
export interface Facets {
  aircraft: Array<Equipment & { flights: number }>; batteries: Array<Equipment & { flights: number }>;
  tags: Array<{ tag: string; kind: string; flights: number }>; pilots: Array<{ id: string; pilotName: string | null; flights: number }>;
  ranges: { durationSeconds: number; altitudeMeters: number; distanceMeters: number; firstFlightAt: string | null; lastFlightAt: string | null };
}
export interface Filters {
  from?: string; to?: string; aircraft?: string; battery?: string; pilot?: string; tag?: string; q?: string;
  minDuration?: number; maxDuration?: number; minAltitude?: number; maxAltitude?: number; minDistance?: number; maxDistance?: number;
}

export const FEET = 3.28084, MPH = 2.236936, MILE = 1609.344;
export const feet = (meters: number | null | undefined) => (meters == null ? "—" : `${Math.round(meters * FEET).toLocaleString()} ft`);
export const mph = (mps: number | null | undefined) => (mps == null ? "—" : `${(mps * MPH).toFixed(1)} mph`);
export const miles = (meters: number | null | undefined) => {
  if (meters == null) return "—";
  return meters < 304.8 ? `${Math.round(meters * FEET).toLocaleString()} ft` : `${(meters / MILE).toFixed(meters < MILE * 10 ? 2 : 1)} mi`;
};
export function duration(seconds: number | null | undefined, long = false) {
  if (seconds == null) return "—";
  const total = Math.round(seconds), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (long) return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
export const clock = (ms: number) => duration(ms / 1000);
export const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
export const equipmentLabel = (item: Equipment | null | undefined, kind = "Aircraft") =>
  item ? item.name || item.model || `${kind} …${item.serial.slice(-4)}` : `Unknown ${kind.toLowerCase()}`;
export const masked = (serial: string | null | undefined) => (serial ? `…${serial.slice(-4)}` : "—");
/** OpenDroneLog prefixes uploaded file names with an upload ID; that's noise to a pilot, so it's dropped. */
const UPLOAD_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[-_]/i;
const clean = (name: string | null | undefined) => name?.replace(UPLOAD_PREFIX, "").replace(/\.txt$/i, "").trim() || null;
export const flightTitle = (flight: { displayName: string | null; fileName?: string | null; startedAt: string | null }) =>
  clean(flight.displayName) || clean(flight.fileName) || `Flight ${shortDate(flight.startedAt)}`;

/** Query string for the list and overview endpoints; empty values are left out. */
export function filterQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "" && value !== null) params.set(key, String(value));
  return params.toString();
}

/** Numbers for one telemetry column, or null when the track doesn't carry it. */
export function series(track: Track | null, name: string): Array<number | null> | null {
  const values = track?.columns?.[name];
  if (!values || !values.some(value => typeof value === "number")) return null;
  return values.map(value => (typeof value === "number" && Number.isFinite(value) ? value : null));
}
