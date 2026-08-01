import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import type { PortalAreaGeoJson, PortalPoi } from "./portal-api";

type Point = [number, number];
type MapStyle = "satellite" | "streets";
type MapSuggestion = { id: string; label: string; detail: string; coordinates: Point };

export function neutralMapLocation([longitude, latitude]: Point): string {
  return `Near ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function area(vertices: Point[]): PortalAreaGeoJson | null {
  return vertices.length >= 3 ? { type: "Polygon", coordinates: [[...vertices, vertices[0]!]] } : null;
}

function featureData(pois: PortalPoi[], vertices: Point[], selectedPoiIndex: number | null = null): GeoJSON.FeatureCollection {
  const polygon = area(vertices);
  return {
    type: "FeatureCollection",
    features: [
      ...pois.map((poi, index) => ({ type: "Feature" as const, properties: { kind: "poi", index, selected: index === selectedPoiIndex }, geometry: { type: "Point" as const, coordinates: [poi.longitude, poi.latitude] } })),
      ...vertices.map((coordinates, index) => ({ type: "Feature" as const, properties: { kind: "vertex", index }, geometry: { type: "Point" as const, coordinates } })),
      ...(polygon ? [{ type: "Feature" as const, properties: {}, geometry: polygon }] : []),
    ],
  };
}

export function requestMapKml(areaGeoJson: PortalAreaGeoJson | null, pois: PortalPoi[]): string {
  const placemarks = pois.map((poi, index) => `<Placemark><name>Point ${index + 1}</name><Point><coordinates>${poi.longitude},${poi.latitude},0</coordinates></Point></Placemark>`).join("");
  const polygon = areaGeoJson ? `<Placemark><name>Requested area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${areaGeoJson.coordinates[0]!.map(([lng, lat]) => `${lng},${lat},0`).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>LTDS service request</name>${placemarks}${polygon}</Document></kml>`;
}

function locationError(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return "Location permission was declined. You can still search an address or add points on the map.";
  if (error.code === error.TIMEOUT) return "Location lookup timed out. Try again or search an address.";
  return "Your location could not be determined. Search an address or add a point instead.";
}

export function MapAreaSelector({ value, onChange, token, points, onPoints, locationLabel, onLocationLabel }: { value: PortalAreaGeoJson | null; onChange: (next: PortalAreaGeoJson | null) => void; token: string | null; points: PortalPoi[]; onPoints: (next: PortalPoi[]) => void; locationLabel: string; onLocationLabel: (next: string) => void }) {
  const element = useRef<HTMLDivElement | null>(null);
  const instance = useRef<mapboxgl.Map | null>(null);
  const pointsRef = useRef(points);
  const verticesRef = useRef<Point[]>(value?.coordinates[0]?.slice(0, -1) ?? []);
  const modeRef = useRef<"poi" | "area">("poi");
  const selectedPoiRef = useRef<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchSequenceRef = useRef(0);
  const locationLabelRef = useRef(locationLabel);
  const activeSuggestionRef = useRef(-1);
  const committedSearchRef = useRef<string | null>(null);
  const [vertices, setVertices] = useState<Point[]>(verticesRef.current);
  const [mode, setMode] = useState<"poi" | "area">("poi");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyle>("satellite");
  const [selectedPoiIndex, setSelectedPoiIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MapSuggestion[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [searching, setSearching] = useState(false);
  pointsRef.current = points;
  locationLabelRef.current = locationLabel;

  const updateSource = (nextPoints = pointsRef.current, nextVertices = verticesRef.current) => {
    (instance.current?.getSource("request-area") as mapboxgl.GeoJSONSource | undefined)?.setData(featureData(nextPoints, nextVertices, selectedPoiRef.current));
  };
  const selectPoi = (index: number | null) => {
    selectedPoiRef.current = index;
    setSelectedPoiIndex(index);
    updateSource();
  };
  const setPoiPoints = (next: PortalPoi[]) => {
    if (selectedPoiRef.current !== null && selectedPoiRef.current >= next.length) {
      selectedPoiRef.current = null;
      setSelectedPoiIndex(null);
    }
    pointsRef.current = next;
    onPoints(next);
    updateSource(next);
  };
  const setAreaVertices = (fn: (current: Point[]) => Point[]) => setVertices(current => {
    const next = fn(current);
    verticesRef.current = next;
    onChange(area(next));
    updateSource(pointsRef.current, next);
    return next;
  });
  const focus = (selected: Point) => instance.current?.flyTo({ center: selected, zoom: 15 });
  const resolveLocationLabel = async (selected: Point) => {
    if (!token || locationLabelRef.current.trim()) return;
    const fallback = neutralMapLocation(selected);
    locationLabelRef.current = fallback;
    onLocationLabel(fallback);
    try {
      const response = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${encodeURIComponent(selected[0])}&latitude=${encodeURIComponent(selected[1])}&types=street,place,locality,neighborhood&permanent=true&access_token=${encodeURIComponent(token)}`);
      const body = await response.json() as { features?: Array<{ properties?: { name?: string; place_formatted?: string }; text?: string; place_name?: string }> };
      const feature = body.features?.[0];
      const name = feature?.properties?.name || feature?.text;
      const context = feature?.properties?.place_formatted;
      const resolved = name ? `${name}${context && !name.includes(context) ? `, ${context}` : ""}` : feature?.place_name;
      if (response.ok && resolved && locationLabelRef.current === fallback) {
        locationLabelRef.current = resolved;
        onLocationLabel(resolved);
      }
    } catch {
      // The neutral coordinate label remains stable when reverse geocoding is unavailable.
    }
  };

  useEffect(() => {
    if (!token || !element.current || instance.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({ container: element.current, style: "mapbox://styles/mapbox/satellite-streets-v12", center: [-88.07, 44.5], zoom: 7 });
    instance.current = map;
    const ensureLayers = () => {
      if (!map.getSource("request-area")) map.addSource("request-area", { type: "geojson", data: featureData(pointsRef.current, verticesRef.current, selectedPoiRef.current) });
      if (!map.getLayer("request-fill")) map.addLayer({ id: "request-fill", type: "fill", source: "request-area", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#ee5007", "fill-opacity": .2 } });
      if (!map.getLayer("request-line")) map.addLayer({ id: "request-line", type: "line", source: "request-area", filter: ["==", "$type", "Polygon"], paint: { "line-color": "#ee5007", "line-width": 3 } });
      if (!map.getLayer("request-points")) map.addLayer({ id: "request-points", type: "circle", source: "request-area", filter: ["==", "$type", "Point"], paint: { "circle-radius": ["case", ["==", ["get", "selected"], true], 10, ["==", ["get", "kind"], "poi"], 7, 5], "circle-color": ["case", ["==", ["get", "selected"], true], "#ffd166", ["==", ["get", "kind"], "poi"], "#ee5007", "#171d23"], "circle-stroke-color": ["case", ["==", ["get", "selected"], true], "#171d23", "#fff"], "circle-stroke-width": ["case", ["==", ["get", "selected"], true], 3, 2] } });
    };
    map.on("style.load", ensureLayers);
    map.on("click", event => {
      if (map.getLayer("request-points")) {
        const rendered = map.queryRenderedFeatures(event.point, { layers: ["request-points"] })[0];
        const properties = rendered?.properties as { kind?: string; index?: number } | undefined;
        const index = Number(properties?.index);
        if (properties?.kind === "poi" && Number.isInteger(index)) selectPoi(index);
        if (rendered) return;
      }
      const selected: Point = [Number(event.lngLat.lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
      void resolveLocationLabel(selected);
      if (modeRef.current === "poi") {
        if (pointsRef.current.length < 20) setPoiPoints([...pointsRef.current, { longitude: selected[0], latitude: selected[1] }]);
      } else {
        setAreaVertices(current => current.length < 64 ? [...current, selected] : current);
      }
    });
    map.on("mousedown", "request-points", event => {
      const properties = event.features?.[0]?.properties as { kind?: string; index?: number } | undefined;
      const index = Number(properties?.index);
      if (!properties?.kind || !Number.isInteger(index)) return;
      if (properties.kind === "poi") selectPoi(index);
      event.preventDefault();
      map.dragPan.disable();
      const move = (nextEvent: mapboxgl.MapMouseEvent) => {
        const selected: Point = [Number(nextEvent.lngLat.lng.toFixed(6)), Number(nextEvent.lngLat.lat.toFixed(6))];
        if (properties.kind === "poi") {
          const next = pointsRef.current.map((poi, poiIndex) => poiIndex === index ? { ...poi, longitude: selected[0], latitude: selected[1] } : poi);
          setPoiPoints(next);
        } else {
          setAreaVertices(current => current.map((point, pointIndex) => pointIndex === index ? selected : point));
        }
      };
      const finish = () => { map.off("mousemove", move); map.dragPan.enable(); };
      map.on("mousemove", move);
      map.once("mouseup", finish);
    });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(element.current);
    return () => { resizeObserver.disconnect(); instance.current = null; map.remove(); };
  }, [token]);

  const chooseStyle = (next: MapStyle) => { if (next !== mapStyle) { setMapStyle(next); instance.current?.setStyle(next === "satellite" ? "mapbox://styles/mapbox/satellite-streets-v12" : "mapbox://styles/mapbox/streets-v12"); } };
  const chooseMode = (next: "poi" | "area") => { modeRef.current = next; setMode(next); };
  const removePoi = (index: number) => {
    const next = pointsRef.current.filter((_, pointIndex) => pointIndex !== index);
    const selected = selectedPoiRef.current;
    selectedPoiRef.current = selected === index ? null : selected !== null && selected > index ? selected - 1 : selected;
    setSelectedPoiIndex(selectedPoiRef.current);
    setPoiPoints(next);
  };
  const loadSuggestions = async (term: string, limit: number, signal: AbortSignal): Promise<MapSuggestion[]> => {
    const response = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(term)}&autocomplete=true&types=address,street,place,locality,neighborhood&limit=${limit}&permanent=true&access_token=${encodeURIComponent(token || "")}`, { signal });
    const body = await response.json() as { features?: Array<{ id?: string; geometry?: { coordinates?: unknown }; properties?: { full_address?: string; name?: string; place_formatted?: string }; place_name?: string; text?: string }> };
    if (!response.ok) throw new Error("search-failed");
    return (body.features || []).flatMap((feature, index) => {
      const coordinates = feature.geometry?.coordinates;
      if (!Array.isArray(coordinates) || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") return [];
      const label = feature.properties?.full_address || feature.place_name || feature.properties?.name || feature.text || term;
      const detail = feature.properties?.place_formatted || (feature.place_name && feature.place_name !== label ? feature.place_name : "");
      return [{ id: feature.id || `suggestion-${index}`, label, detail, coordinates: [coordinates[0], coordinates[1]] }];
    });
  };
  const selectSuggestion = (suggestion: MapSuggestion) => {
    committedSearchRef.current = suggestion.label;
    setQuery(suggestion.label);
    setSuggestions([]);
    activeSuggestionRef.current = -1;
    setActiveSuggestion(-1);
    setMessage(`Map centered on ${suggestion.label}.`);
    locationLabelRef.current = suggestion.label;
    onLocationLabel(suggestion.label);
    focus(suggestion.coordinates);
  };
  useEffect(() => {
    const term = query.trim();
    searchAbortRef.current?.abort();
    if (committedSearchRef.current === term) {
      committedSearchRef.current = null;
      setSuggestions([]);
      activeSuggestionRef.current = -1;
      setActiveSuggestion(-1);
      setSearching(false);
      return;
    }
    if (!token || term.length < 3) {
      setSuggestions([]);
      activeSuggestionRef.current = -1;
      setActiveSuggestion(-1);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const sequence = ++searchSequenceRef.current;
    searchAbortRef.current = controller;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void loadSuggestions(term, 5, controller.signal)
        .then(results => {
          if (sequence !== searchSequenceRef.current) return;
          setSuggestions(results);
          activeSuggestionRef.current = -1;
          setActiveSuggestion(-1);
        })
        .catch(error => {
          if ((error as Error).name !== "AbortError" && sequence === searchSequenceRef.current) {
            setSuggestions([]);
            activeSuggestionRef.current = -1;
            setActiveSuggestion(-1);
          }
        })
        .finally(() => {
          if (sequence === searchSequenceRef.current) setSearching(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, token]);
  const find = async () => {
    if (!token || !query.trim()) return;
    if (suggestions[0]) {
      selectSuggestion(suggestions[0]);
      return;
    }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setMessage("");
    try {
      const result = (await loadSuggestions(query.trim(), 1, controller.signal))[0];
      if (!result) throw new Error("not-found");
      selectSuggestion(result);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setMessage("Address not found. Try a fuller address or add a point on the map.");
    } finally {
      setSearching(false);
    }
  };
  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setMessage("This browser does not support current location. Search an address instead."); return; }
    setLocating(true); setMessage("Finding your approximate location… You can keep using the map while this runs.");
    navigator.geolocation.getCurrentPosition(position => {
      const point: Point = [Number(position.coords.longitude.toFixed(6)), Number(position.coords.latitude.toFixed(6))];
      focus(point);
      void resolveLocationLabel(point);
      if (pointsRef.current.length < 20) setPoiPoints([...pointsRef.current, { longitude: point[0], latitude: point[1], label: "Current location" }]);
      setMessage("Current location found and added as a point of interest.");
      setLocating(false);
    }, error => { setMessage(locationError(error)); setLocating(false); }, { enableHighAccuracy: false, timeout: 8_000, maximumAge: 600_000 });
  };

  if (!token) return <p className="portal-map-unavailable">Map selection is temporarily unavailable. You can still submit the address details above.</p>;
  return (
    <section className="portal-map-selector" aria-labelledby="portal-site-map-title">
      <header className="portal-map-copy">
        <span>Define the site</span>
        <h3 id="portal-site-map-title">Site map</h3>
        <p>Search or use your current location, then add up to 20 points of interest and outline the service area. Drag any point to refine it.</p>
      </header>
      <div className="portal-map-toolbar">
        <div className="portal-map-search-shell">
          <div className="portal-map-search">
            <input
              role="combobox"
              aria-label="Search address or place"
              aria-autocomplete="list"
              aria-expanded={suggestions.length > 0}
              aria-controls="portal-map-suggestions"
              aria-activedescendant={activeSuggestion >= 0 ? `portal-map-suggestion-${activeSuggestion}` : undefined}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === "ArrowDown" && suggestions.length) {
                  event.preventDefault();
                  const next = (activeSuggestionRef.current + 1) % suggestions.length;
                  activeSuggestionRef.current = next;
                  setActiveSuggestion(next);
                } else if (event.key === "ArrowUp" && suggestions.length) {
                  event.preventDefault();
                  const next = activeSuggestionRef.current <= 0 ? suggestions.length - 1 : activeSuggestionRef.current - 1;
                  activeSuggestionRef.current = next;
                  setActiveSuggestion(next);
                } else if (event.key === "Escape") {
                  setSuggestions([]);
                  activeSuggestionRef.current = -1;
                  setActiveSuggestion(-1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const selectedIndex = activeSuggestionRef.current;
                  if (selectedIndex >= 0 && suggestions[selectedIndex]) selectSuggestion(suggestions[selectedIndex]);
                  else void find();
                }
              }}
              placeholder="Search address or place"
            />
            <button type="button" className="button-ghost button-small" onClick={() => void find()} disabled={searching}>{searching ? "Searching…" : "Find"}</button>
            <button type="button" className="button-ghost button-small" aria-busy={locating} onClick={useCurrentLocation} disabled={locating}>{locating ? "Locating…" : "Use current location"}</button>
          </div>
          {suggestions.length > 0 && (
            <ul id="portal-map-suggestions" className="portal-map-suggestions" role="listbox" aria-label="Address suggestions">
              {suggestions.map((suggestion, index) => (
                <li id={`portal-map-suggestion-${index}`} key={suggestion.id} role="option" aria-selected={activeSuggestion === index}>
                  <button type="button" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}>
                    <strong>{suggestion.label}</strong>
                    {suggestion.detail && <span>{suggestion.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="portal-map-controls">
          <div className="portal-map-mode" aria-label="Map selection mode">
            <button type="button" className={mode === "poi" ? "active" : ""} aria-pressed={mode === "poi"} onClick={() => chooseMode("poi")}>Add point</button>
            <button type="button" className={mode === "area" ? "active" : ""} aria-pressed={mode === "area"} onClick={() => chooseMode("area")}>Draw area</button>
          </div>
          <div className="portal-map-style" aria-label="Map style">
            <button type="button" className={mapStyle === "satellite" ? "active" : ""} aria-pressed={mapStyle === "satellite"} onClick={() => chooseStyle("satellite")}>Satellite</button>
            <button type="button" className={mapStyle === "streets" ? "active" : ""} aria-pressed={mapStyle === "streets"} onClick={() => chooseStyle("streets")}>Streets</button>
          </div>
        </div>
      </div>
      {message && <small className="portal-map-error" role="status">{message}</small>}
      <div ref={element} className="portal-map-canvas" aria-label="Service area and points of interest map" />
      <div className="portal-map-actions">
        <span>{points.length} of 20 points · {vertices.length ? `${vertices.length} area vertices` : "No area drawn"}</span>
        <button type="button" className="button-ghost button-small" onClick={() => setPoiPoints(points.slice(0, -1))} disabled={!points.length}>Undo point</button>
        <button type="button" className="button-ghost button-small" onClick={() => setAreaVertices(current => current.slice(0, -1))} disabled={!vertices.length}>Undo area</button>
        <button type="button" className="button-ghost button-small" onClick={() => { selectPoi(null); setPoiPoints([]); setAreaVertices(() => []); }} disabled={!points.length && !vertices.length}>Clear map</button>
      </div>
      {points.length > 0 && (
        <section className="portal-poi-roster" aria-labelledby="portal-poi-title">
          <header>
            <div><strong id="portal-poi-title">Points of interest</strong><span>Select a point on the map or in this list to review or remove it.</span></div>
            {selectedPoiIndex !== null && <span className="portal-poi-selected" role="status">Point {selectedPoiIndex + 1} selected</span>}
          </header>
          <ul>
            {points.map((point, index) => (
              <li key={`${point.longitude}:${point.latitude}:${index}`} className={selectedPoiIndex === index ? "selected" : ""}>
                <button type="button" className="portal-poi-focus" aria-pressed={selectedPoiIndex === index} onClick={() => { selectPoi(index); focus([point.longitude, point.latitude]); }}>
                  <strong>{point.label || `Point ${index + 1}`}</strong>
                  <span>{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</span>
                </button>
                <button type="button" className="portal-poi-remove" aria-label={`Remove ${point.label || `point ${index + 1}`}`} onClick={() => removePoi(index)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
