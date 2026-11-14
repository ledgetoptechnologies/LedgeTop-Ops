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
 *
 * The Leaflet map is built once per flight path. Moving the chart cursor or replaying only moves the
 * aircraft marker, and switching the basemap only swaps the tile layer; neither rebuilds the map.
 */
export function FlightMap({ latitude, longitude, position, home }: Props) {
  const node = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), aircraft = useRef<L.Marker | null>(null);
  const tiles = useRef<{ id: BasemapId; layer: L.TileLayer } | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("imagery");
  const basemapRef = useRef(basemap);
  basemapRef.current = basemap;
  const { points, index } = useMemo(() => {
    const points: Array<[number, number]> = [], index: number[] = [];
    for (let i = 0; i < latitude.length; i++) {
      const lat = latitude[i], lon = longitude[i];
      if (lat == null || lon == null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      points.push([lat, lon]); index.push(i);
    }
    return { points, index };
  }, [latitude, longitude]);
  // Compare the home point by value: a fresh object with the same coordinates must not rebuild the map.
  const homeLat = home?.latitude ?? null, homeLon = home?.longitude ?? null;

  useEffect(() => {
    if (!node.current || points.length < 2) return;
    const instance = L.map(node.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, preferCanvas: true });
    map.current = instance;
    instance.on("focus", () => instance.scrollWheelZoom.enable());
    instance.on("blur", () => instance.scrollWheelZoom.disable());
    tiles.current = { id: basemapRef.current, layer: tileLayer(basemapRef.current).addTo(instance) };
    // Colour the path in a few segments from start to end, over a dark casing so it reads on any imagery.
    L.polyline(points, { color: "#070707", weight: 7, opacity: 0.45 }).addTo(instance);
    const step = Math.ceil(points.length / TRACK_COLORS.length);
    TRACK_COLORS.forEach((color, i) => {
      const segment = points.slice(i * step, Math.min(points.length, (i + 1) * step + 1));
      if (segment.length > 1) L.polyline(segment, { color, weight: 3.5, opacity: 1 }).addTo(instance);
    });
    if (homeLat != null && homeLon != null) L.marker([homeLat, homeLon], { icon: dot("flight-map-home", "H"), keyboard: false, title: "Home point" }).addTo(instance);
    aircraft.current = L.marker(points[0]!, { icon: dot("flight-map-aircraft", ""), keyboard: false, title: "Aircraft" }).addTo(instance);
    instance.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 19 });
    return () => { aircraft.current = null; tiles.current = null; instance.remove(); map.current = null; };
  }, [points, homeLat, homeLon]);

  useEffect(() => {
    const instance = map.current; if (!instance || tiles.current?.id === basemap) return;
    tiles.current?.layer.remove();
    tiles.current = { id: basemap, layer: tileLayer(basemap).addTo(instance) };
  }, [basemap]);

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
    <div className="flight-map-basemap" role="radiogroup" aria-label="Map style">
      {(["imagery", "topo"] as const).map(id => <button key={id} type="button" role="radio" aria-checked={basemap === id}
        onClick={() => setBasemap(id)}>{id === "imagery" ? "Satellite" : "Map"}</button>)}
    </div>
  </div>;
}

function tileLayer(id: BasemapId) {
  const choice = BASEMAPS[id];
  return L.tileLayer(choice.url, { maxZoom: 19, maxNativeZoom: choice.maxNativeZoom, attribution: choice.attribution });
}

function dot(className: string, label: string) {
  return L.divIcon({ className: "", html: `<div class="${className}" aria-hidden="true">${label}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}
