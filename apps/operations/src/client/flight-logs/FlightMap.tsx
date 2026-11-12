import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BASEMAPS, type BasemapId } from "./basemaps";

interface Props {
  latitude: Array<number | null>; longitude: Array<number | null>;
  /** Index of the sample under the shared cursor or replay position, or -1. */
  position: number; home: { latitude: number; longitude: number } | null;
}

const TRACK_COLORS = ["#ee5007", "#f28a1c", "#f5b301", "#9cc23b", "#2bb673"];

/**
 * Flight path on Esri imagery (the same keyless basemap the Viewer uses), coloured from start (orange)
 * to end (green), with home and the aircraft at the cursor or replay position.
 */
export function FlightMap({ latitude, longitude, position, home }: Props) {
  const node = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), aircraft = useRef<L.Marker | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("imagery");
  const { points, index } = useMemo(() => {
    const points: Array<[number, number]> = [], index: number[] = [];
    for (let i = 0; i < latitude.length; i++) {
      const lat = latitude[i], lon = longitude[i];
      if (lat == null || lon == null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      points.push([lat, lon]); index.push(i);
    }
    return { points, index };
  }, [latitude, longitude]);

  useEffect(() => {
    if (!node.current || points.length < 2) return;
    const instance = L.map(node.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, preferCanvas: true });
    map.current = instance;
    instance.on("focus", () => instance.scrollWheelZoom.enable());
    instance.on("blur", () => instance.scrollWheelZoom.disable());
    // Colour the path in a few segments from start to end, over a dark casing so it reads on any imagery.
    L.polyline(points, { color: "#070707", weight: 7, opacity: 0.45 }).addTo(instance);
    const step = Math.ceil(points.length / TRACK_COLORS.length);
    TRACK_COLORS.forEach((color, i) => {
      const segment = points.slice(i * step, Math.min(points.length, (i + 1) * step + 1));
      if (segment.length > 1) L.polyline(segment, { color, weight: 3.5, opacity: 1 }).addTo(instance);
    });
    if (home) L.marker([home.latitude, home.longitude], { icon: dot("flight-map-home", "H"), keyboard: false, title: "Home point" }).addTo(instance);
    aircraft.current = L.marker(points[0]!, { icon: dot("flight-map-aircraft", ""), keyboard: false, title: "Aircraft" }).addTo(instance);
    instance.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 19 });
    return () => { aircraft.current = null; tiles.current = null; instance.remove(); map.current = null; };
  }, [points, home]);

  useEffect(() => {
    const instance = map.current; if (!instance) return;
    tiles.current?.remove();
    const choice = BASEMAPS[basemap];
    tiles.current = L.tileLayer(choice.url, { maxZoom: 19, maxNativeZoom: choice.maxNativeZoom, attribution: choice.attribution }).addTo(instance);
  }, [basemap, points, home]);

  useEffect(() => {
    const marker = aircraft.current; if (!marker || !points.length) return;
    let lo = 0, hi = index.length - 1;
    const target = position < 0 ? 0 : position;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (index[mid]! <= target) lo = mid; else hi = mid - 1; }
    marker.setLatLng(points[lo]!);
  }, [position, points, index]);

  if (points.length < 2) return <div className="flight-map flight-map-empty"><p>This flight has no GPS track.</p></div>;
  return <div className="flight-map">
    <div ref={node} className="flight-map-canvas" aria-label="Flight path map" role="region" tabIndex={0} />
    <label className="flight-map-toggle"><input type="checkbox" checked={basemap === "imagery"}
      onChange={event => setBasemap(event.currentTarget.checked ? "imagery" : "topo")} /> Satellite</label>
  </div>;
}

function dot(className: string, label: string) {
  return L.divIcon({ className: "", html: `<div class="${className}" aria-hidden="true">${label}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}
