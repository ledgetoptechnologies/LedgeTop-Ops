import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

interface Props {
  token: string | null; latitude: Array<number | null>; longitude: Array<number | null>;
  /** Index of the sample under the shared cursor or replay position, or -1. */
  position: number; home: { latitude: number; longitude: number } | null;
}

const STREETS = "mapbox://styles/mapbox/outdoors-v12", SATELLITE = "mapbox://styles/mapbox/satellite-streets-v12";

/** Flight path from start (orange) to end, with home and the aircraft at the cursor or replay position. */
export function FlightMap({ token, latitude, longitude, position, home }: Props) {
  const node = useRef<HTMLDivElement>(null), map = useRef<mapboxgl.Map | null>(null), aircraft = useRef<mapboxgl.Marker | null>(null);
  const [satellite, setSatellite] = useState(true);
  const coordinates = useRef<Array<[number, number]>>([]);
  const indexFor = useRef<number[]>([]);

  useEffect(() => {
    const points: Array<[number, number]> = [], index: number[] = [];
    for (let i = 0; i < latitude.length; i++) {
      const lat = latitude[i], lon = longitude[i];
      if (lat == null || lon == null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      points.push([lon, lat]); index.push(i);
    }
    coordinates.current = points; indexFor.current = index;
  }, [latitude, longitude]);

  useEffect(() => {
    if (!token || !node.current || coordinates.current.length < 2) return;
    mapboxgl.accessToken = token;
    const instance = new mapboxgl.Map({ container: node.current, style: satellite ? SATELLITE : STREETS, attributionControl: true, cooperativeGestures: true });
    map.current = instance;
    instance.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    instance.on("load", () => {
      const line = coordinates.current;
      instance.addSource("track", { type: "geojson", lineMetrics: true, data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } });
      instance.addLayer({ id: "track-casing", type: "line", source: "track", paint: { "line-color": "#070707", "line-width": 6, "line-opacity": 0.45 }, layout: { "line-cap": "round", "line-join": "round" } });
      instance.addLayer({ id: "track", type: "line", source: "track", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": 3.5, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#ee5007", 0.5, "#f5b301", 1, "#2bb673"] } });
      const bounds = line.reduce((box, point) => box.extend(point), new mapboxgl.LngLatBounds(line[0], line[0]));
      instance.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 18 });
      if (home) new mapboxgl.Marker({ element: dot("flight-map-home", "H") }).setLngLat([home.longitude, home.latitude]).addTo(instance);
      aircraft.current = new mapboxgl.Marker({ element: dot("flight-map-aircraft", "") }).setLngLat(line[0]!).addTo(instance);
    });
    return () => { aircraft.current = null; instance.remove(); map.current = null; };
  }, [token, satellite, latitude, longitude, home]);

  useEffect(() => {
    const marker = aircraft.current, index = indexFor.current, line = coordinates.current;
    if (!marker || !line.length) return;
    let lo = 0, hi = index.length - 1, target = position < 0 ? 0 : position;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (index[mid]! <= target) lo = mid; else hi = mid - 1; }
    marker.setLngLat(line[lo]!);
  }, [position]);

  if (!token) return <div className="flight-map flight-map-empty"><p>The map isn’t available: Operations has no map key configured.</p></div>;
  if (latitude.every(value => value == null)) return <div className="flight-map flight-map-empty"><p>This flight has no GPS track.</p></div>;
  return <div className="flight-map">
    <div ref={node} className="flight-map-canvas" aria-label="Flight path map" role="region" />
    <label className="flight-map-toggle"><input type="checkbox" checked={satellite} onChange={event => setSatellite(event.currentTarget.checked)} /> Satellite</label>
  </div>;
}

function dot(className: string, label: string) {
  const element = document.createElement("div");
  element.className = className; element.textContent = label; element.setAttribute("aria-hidden", "true");
  return element;
}
