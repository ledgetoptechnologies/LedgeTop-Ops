import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";

type Point = [number, number];
export type EditableRequestArea = { type: "Polygon"; coordinates: Point[][] };
export type EditableRequestPoi = { longitude: number; latitude: number; label: string | null };

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function polygon(vertices: Point[]): EditableRequestArea | null {
  return vertices.length >= 3
    ? { type: "Polygon", coordinates: [[...vertices, vertices[0]!]] }
    : null;
}

function features(pois: EditableRequestPoi[], vertices: Point[]): GeoJSON.FeatureCollection {
  const area = polygon(vertices);
  return {
    type: "FeatureCollection",
    features: [
      ...pois.map((poi, index) => ({
        type: "Feature" as const,
        properties: { kind: "poi", index },
        geometry: { type: "Point" as const, coordinates: [poi.longitude, poi.latitude] },
      })),
      ...vertices.map((coordinates, index) => ({
        type: "Feature" as const,
        properties: { kind: "vertex", index },
        geometry: { type: "Point" as const, coordinates },
      })),
      ...(area ? [{ type: "Feature" as const, properties: {}, geometry: area }] : []),
    ],
  };
}

export function RequestMapEditor({
  token,
  areaJson,
  poiJson,
  busy,
  onCancel,
  onSave,
}: {
  token: string | null;
  areaJson: string | null;
  poiJson: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (value: { areaGeoJson: EditableRequestArea | null; poiPoints: EditableRequestPoi[]; reason: string }) => void;
}) {
  const initialArea = parse<EditableRequestArea | null>(areaJson, null);
  const [vertices, setVertices] = useState<Point[]>(initialArea?.coordinates[0]?.slice(0, -1) || []);
  const [pois, setPois] = useState<EditableRequestPoi[]>(parse<EditableRequestPoi[]>(poiJson, []));
  const [mode, setMode] = useState<"poi" | "area">("area");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const container = useRef<HTMLDivElement | null>(null), mapRef = useRef<mapboxgl.Map | null>(null),
    verticesRef = useRef(vertices), poisRef = useRef(pois), modeRef = useRef(mode);
  verticesRef.current = vertices;
  poisRef.current = pois;
  modeRef.current = mode;

  const refresh = (nextPois = poisRef.current, nextVertices = verticesRef.current) =>
    (mapRef.current?.getSource("staff-request-area") as mapboxgl.GeoJSONSource | undefined)
      ?.setData(features(nextPois, nextVertices));
  const updateVertices = (next: Point[]) => {
    verticesRef.current = next;
    setVertices(next);
    refresh(poisRef.current, next);
  };
  const updatePois = (next: EditableRequestPoi[]) => {
    poisRef.current = next;
    setPois(next);
    refresh(next, verticesRef.current);
  };

  useEffect(() => {
    if (!token || !container.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: container.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-88.07, 44.5],
      zoom: 7,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("staff-request-area", { type: "geojson", data: features(poisRef.current, verticesRef.current) });
      map.addLayer({ id: "staff-request-fill", type: "fill", source: "staff-request-area", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#ee5007", "fill-opacity": .22 } });
      map.addLayer({ id: "staff-request-line", type: "line", source: "staff-request-area", filter: ["==", "$type", "Polygon"], paint: { "line-color": "#ee5007", "line-width": 4 } });
      map.addLayer({ id: "staff-request-points", type: "circle", source: "staff-request-area", filter: ["==", "$type", "Point"], paint: { "circle-radius": ["case", ["==", ["get", "kind"], "poi"], 8, 6], "circle-color": ["case", ["==", ["get", "kind"], "poi"], "#ee5007", "#18202a"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      const bounds = new mapboxgl.LngLatBounds();
      for (const poi of poisRef.current) bounds.extend([poi.longitude, poi.latitude]);
      for (const vertex of verticesRef.current) bounds.extend(vertex);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
    });
    map.on("click", event => {
      const rendered = map.getLayer("staff-request-points")
        ? map.queryRenderedFeatures(event.point, { layers: ["staff-request-points"] })[0]
        : undefined;
      if (rendered) return;
      const point: Point = [Number(event.lngLat.lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
      if (modeRef.current === "poi") {
        if (poisRef.current.length >= 20) setMessage("A request can contain at most 20 points of interest.");
        else updatePois([...poisRef.current, { longitude: point[0], latitude: point[1], label: null }]);
      } else if (verticesRef.current.length >= 64) {
        setMessage("A service-area boundary can contain at most 64 vertices.");
      } else updateVertices([...verticesRef.current, point]);
    });
    map.on("mousedown", "staff-request-points", event => {
      const properties = event.features?.[0]?.properties as { kind?: string; index?: number } | undefined;
      const index = Number(properties?.index);
      if (!properties?.kind || !Number.isInteger(index)) return;
      event.preventDefault();
      map.dragPan.disable();
      const move = (nextEvent: mapboxgl.MapMouseEvent) => {
        const point: Point = [Number(nextEvent.lngLat.lng.toFixed(6)), Number(nextEvent.lngLat.lat.toFixed(6))];
        if (properties.kind === "poi")
          updatePois(poisRef.current.map((poi, poiIndex) => poiIndex === index ? { ...poi, longitude: point[0], latitude: point[1] } : poi));
        else updateVertices(verticesRef.current.map((vertex, vertexIndex) => vertexIndex === index ? point : vertex));
      };
      const finish = () => { map.off("mousemove", move); map.dragPan.enable(); };
      map.on("mousemove", move);
      map.once("mouseup", finish);
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); mapRef.current = null; map.remove(); };
  }, [token]);

  return (
    <section className="request-map-editor" aria-labelledby="staff-work-area-heading">
      <header>
        <div>
          <strong id="staff-work-area-heading">Edit effective work area</strong>
          <p>The client submission stays immutable. This saved revision becomes the operational work area.</p>
        </div>
        <div className="request-map-editor-mode" aria-label="Map editing mode">
          <button type="button" aria-pressed={mode === "area"} className={mode === "area" ? "active" : ""} onClick={() => setMode("area")}>Draw area</button>
          <button type="button" aria-pressed={mode === "poi"} className={mode === "poi" ? "active" : ""} onClick={() => setMode("poi")}>Add point</button>
        </div>
      </header>
      {token ? <div ref={container} className="request-map-editor-canvas" aria-label="Editable service request work area" /> : (
        <div className="notice error">Map editing is unavailable because the Mapbox token is not configured.</div>
      )}
      {message && <p className="notice" role="status">{message}</p>}
      <div className="request-map-editor-actions">
        <span>{vertices.length} of 64 vertices · {pois.length} of 20 points</span>
        <button type="button" className="button-ghost button-small" disabled={!vertices.length} onClick={() => updateVertices(vertices.slice(0, -1))}>Undo area point</button>
        <button type="button" className="button-ghost button-small" disabled={!pois.length} onClick={() => updatePois(pois.slice(0, -1))}>Undo point</button>
        <button type="button" className="button-ghost button-small" disabled={!vertices.length && !pois.length} onClick={() => { updateVertices([]); updatePois([]); }}>Clear</button>
      </div>
      {pois.length > 0 && (
        <ol className="request-map-editor-pois" aria-label="Editable points of interest">
          {pois.map((poi, index) => (
            <li key={`${poi.longitude}:${poi.latitude}:${index}`}>
              <input aria-label={`Point ${index + 1} label`} maxLength={100} placeholder={`Point ${index + 1}`} value={poi.label || ""}
                onChange={event => updatePois(pois.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value || null } : item))} />
              <code>{poi.latitude.toFixed(6)}, {poi.longitude.toFixed(6)}</code>
              <button type="button" className="button-ghost button-small" onClick={() => updatePois(pois.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      <label className="request-map-editor-reason">
        Reason for change
        <textarea rows={3} minLength={3} maxLength={2000} required value={reason} onChange={event => setReason(event.target.value)}
          placeholder="Explain why Operations adjusted the submitted work area." />
      </label>
      <div className="request-map-editor-footer">
        <button type="button" className="button-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="button-orange" disabled={busy || !token || reason.trim().length < 3 || (!polygon(vertices) && !pois.length)}
          onClick={() => onSave({ areaGeoJson: polygon(vertices), poiPoints: pois.map(poi => ({ ...poi, label: poi.label?.trim() || null })), reason: reason.trim() })}>
          {busy ? "Saving revision…" : "Save work-area revision"}
        </button>
      </div>
    </section>
  );
}
