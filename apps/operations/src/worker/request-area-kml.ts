type Position = [number, number];

type StoredArea = {
  type: "Polygon";
  coordinates: Position[][];
};

type StoredPoi = {
  longitude: number;
  latitude: number;
  label?: string | null;
};

const MAX_VERTICES = 64;
const MAX_POIS = 20;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function finitePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) return null;
  return [longitude, latitude];
}

function storedArea(value: string | null): StoredArea | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as { type?: unknown; coordinates?: unknown };
  if (
    candidate.type !== "Polygon" ||
    !Array.isArray(candidate.coordinates) ||
    candidate.coordinates.length !== 1
  ) return null;
  const rawRing = candidate.coordinates[0];
  if (!Array.isArray(rawRing) || rawRing.length < 4 || rawRing.length > MAX_VERTICES + 1) return null;
  const ring = rawRing.map(finitePosition);
  if (ring.some((position) => position === null)) return null;
  const positions = ring as Position[];
  const first = positions[0]!;
  const last = positions.at(-1)!;
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  return { type: "Polygon", coordinates: [positions] };
}

function storedPois(value: string | null): StoredPoi[] | null {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_POIS) return null;
  const pois: StoredPoi[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as { longitude?: unknown; latitude?: unknown; label?: unknown };
    const position = finitePosition([candidate.longitude, candidate.latitude]);
    if (!position) return null;
    if (candidate.label !== undefined && candidate.label !== null && typeof candidate.label !== "string") return null;
    const label = typeof candidate.label === "string" ? candidate.label.trim().slice(0, 100) : null;
    pois.push({ longitude: position[0], latitude: position[1], label: label || null });
  }
  return pois;
}

function coordinate(value: number): string {
  return Number(value.toFixed(7)).toString();
}

export function requestAreaKml(input: {
  title: string;
  revisionLabel: string;
  areaGeoJson: string | null;
  poiPointsJson: string | null;
}): string | null {
  const area = storedArea(input.areaGeoJson);
  const pois = storedPois(input.poiPointsJson);
  if (pois === null || (!area && !pois.length)) return null;
  const placemarks = pois.map((poi, index) => {
    const name = poi.label || `Point ${index + 1}`;
    return `<Placemark><name>${escapeXml(name)}</name><Point><coordinates>${coordinate(poi.longitude)},${coordinate(poi.latitude)},0</coordinates></Point></Placemark>`;
  }).join("");
  const polygon = area
    ? `<Placemark><name>Work area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${area.coordinates[0]!
        .map(([longitude, latitude]) => `${coordinate(longitude)},${coordinate(latitude)},0`)
        .join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(input.title)}</name><description>${escapeXml(input.revisionLabel)}</description>${placemarks}${polygon}</Document></kml>`;
}

export function requestAreaKmlFilename(title: string, revision: "original" | "effective"): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80) || "service-request";
  return `${base}-${revision}-work-area.kml`;
}
