import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { Feature } from "geojson";
import { buildNavigationDestination } from "@ltds/shared";
import { NavigationActions } from "./NavigationActions";

type Area = { type: "Polygon"; coordinates: [number, number][][] };
type Poi = { longitude: number; latitude: number; label?: string | null };

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function RequestMapViewer({
  token,
  areaJson,
  poiJson,
  latitude,
  longitude,
  locationLabel,
}: {
  token: string | null;
  areaJson?: string | null;
  poiJson?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationLabel?: string | null;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const area = parse<Area | null>(areaJson, null);
  const pois = parse<Poi[]>(poiJson, []);
  const allPois = pois.length
    ? pois
    : latitude != null && longitude != null
      ? [{ latitude, longitude, label: "Requested location" }]
      : [];
  const destinationGeometry = area || (allPois.length > 1
    ? { type: "MultiPoint" as const, coordinates: allPois.map(poi => [poi.longitude, poi.latitude]) }
    : allPois.length === 1
      ? { type: "Point" as const, coordinates: [allPois[0]!.longitude, allPois[0]!.latitude] }
      : null);
  const destination = buildNavigationDestination({
    geometry: destinationGeometry,
    latitude,
    longitude,
    label: locationLabel,
  });
  useEffect(() => {
    if (!token || !element.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: element.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-88.07, 44.5],
      zoom: 7,
      interactive: true,
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("load", () => {
      const features: Feature[] = [
        ...(area
          ? [{ type: "Feature" as const, properties: {}, geometry: area }]
          : []),
        ...allPois.map((poi, index) => ({
          type: "Feature" as const,
          properties: { label: poi.label || `Point ${index + 1}` },
          geometry: {
            type: "Point" as const,
            coordinates: [poi.longitude, poi.latitude],
          },
        })),
      ];
      map.addSource("request-geometry", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      map.addLayer({
        id: "request-area-fill",
        type: "fill",
        source: "request-geometry",
        filter: ["==", "$type", "Polygon"],
        paint: { "fill-color": "#ee5007", "fill-opacity": 0.22 },
      });
      map.addLayer({
        id: "request-area-line",
        type: "line",
        source: "request-geometry",
        filter: ["==", "$type", "Polygon"],
        paint: { "line-color": "#ee5007", "line-width": 4 },
      });
      map.addLayer({
        id: "request-pois",
        type: "circle",
        source: "request-geometry",
        filter: ["==", "$type", "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#ee5007",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      if (features.length) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const poi of allPois) bounds.extend([poi.longitude, poi.latitude]);
        for (const ring of area?.coordinates || [])
          for (const point of ring) bounds.extend(point);
        if (!bounds.isEmpty())
          map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
      }
    });
    return () => map.remove();
  }, [token, areaJson, poiJson, latitude, longitude]);
  return (
    <div className="request-map-review">
      {!token ? (
        <div className="notice">
          Map preview is unavailable because the Mapbox token is not configured.
        </div>
      ) : !area && !allPois.length ? (
        <div className="notice">
          No map geometry or points of interest were submitted.
        </div>
      ) : (
        <div
          ref={element}
          className="request-review-map"
          role="img"
          aria-label="Submitted service request geometry and points of interest"
        />
      )}
      {allPois.length > 0 && (
        <section className="request-poi-list" aria-labelledby="request-poi-heading">
          <strong id="request-poi-heading">Points of interest ({allPois.length})</strong>
          <ol>
            {allPois.map((poi, index) => (
              <li key={`${poi.longitude}:${poi.latitude}:${index}`}>
                <span>{poi.label?.trim() || `Point ${index + 1}`}</span>
                <code>{poi.latitude.toFixed(6)}, {poi.longitude.toFixed(6)}</code>
              </li>
            ))}
          </ol>
        </section>
      )}
      <NavigationActions destination={destination} />
    </div>
  );
}
