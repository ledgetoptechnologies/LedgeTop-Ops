import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import mapboxgl from "mapbox-gl";
import type { DeliveryLocationCollection, DeliveryLocationPoint } from "@ltds/shared";

export interface ImageLocationMapProps {
  token: string | null;
  locations: DeliveryLocationCollection | null;
  scopeLabel: string;
  loadAsset?: (assetRef: string) => Promise<ImageLocationMapAsset>;
  openAsset?: (asset: ImageLocationMapAsset) => void;
}

export interface ImageLocationMapAsset {
  id: string;
  kind: "image";
  name: string;
  size: number | null;
  uploadedAt: string | null;
  thumbnailUrl?: string;
  thumbnailState?: "pending" | "ready" | "failed" | "not_applicable";
  previewUrl?: string;
  sourceUrl?: string;
  downloadUrl?: string;
}

function mapData(points: DeliveryLocationPoint[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: points.map(point => ({
    type: "Feature" as const,
    properties: { imageCount: point.imageCount, assetRef: point.assetRef || "" },
    geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] },
  })) };
}

function fitPoints(map: mapboxgl.Map, points: DeliveryLocationPoint[]): void {
  if (points.length === 1) {
    map.jumpTo({ center: [points[0]!.longitude, points[0]!.latitude], zoom: 14 });
    return;
  }
  const firstLongitude = points[0]!.longitude;
  const bounds = new mapboxgl.LngLatBounds();
  for (const point of points) {
    let longitude = point.longitude;
    while (longitude - firstLongitude > 180) longitude -= 360;
    while (longitude - firstLongitude < -180) longitude += 360;
    bounds.extend([longitude, point.latitude]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 0 });
}

function LocationCanvas({ token, points, expanded, scopeLabel, onPointSelect }: {
  token: string;
  points: DeliveryLocationPoint[];
  expanded: boolean;
  scopeLabel: string;
  onPointSelect?: (assetRef: string) => void;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef(onPointSelect); selectRef.current = onPointSelect;
  useEffect(() => {
    if (!element.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: element.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-88.07, 44.5],
      zoom: 7,
      interactive: expanded,
      attributionControl: true,
    });
    if (expanded) map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("image-locations", { type: "geojson", data: mapData(points) });
      map.addLayer({
        id: "image-location-points",
        type: "circle",
        source: "image-locations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "imageCount"], 1, expanded ? 7 : 6, 25, expanded ? 15 : 11],
          "circle-color": "#ee5007",
          "circle-opacity": 0.9,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      fitPoints(map, points);
      map.on("click", "image-location-points", event => {
        const assetRef = event.features?.[0]?.properties?.assetRef;
        if (typeof assetRef === "string" && assetRef) selectRef.current?.(assetRef);
      });
      map.on("mouseenter", "image-location-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "image-location-points", () => { map.getCanvas().style.cursor = ""; });
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); map.remove(); };
  }, [expanded, points, token]);
  return <div ref={element} className={`image-location-map-canvas${expanded ? " expanded" : ""}`} role={expanded ? "region" : "img"} aria-label={`Image locations for ${scopeLabel}`} />;
}

function LocationSelection({ asset, loading, error, open, close, showBackToMap = true }: { asset: ImageLocationMapAsset | null; loading: boolean; error: string; open: () => void; close: () => void; showBackToMap?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false); useEffect(() => setImageFailed(false), [asset?.id]);
  return <aside className="image-location-selection" aria-label="Selected mapped image" aria-live="polite">
    {showBackToMap && <button type="button" className="image-location-selection-close" aria-label="Back to map" onClick={close}>Back to map</button>}
    {loading ? <span role="status">Loading thumbnail…</span> : error ? <span className="error">{error}</span> : asset ? <button type="button" className="image-location-selection-preview" onClick={open} aria-label="Open selected image">
      {asset.thumbnailUrl && !imageFailed ? <img src={asset.thumbnailUrl} alt="Selected mapped image thumbnail" loading="lazy" decoding="async" onError={() => setImageFailed(true)} /> : <span className="file-type-placeholder"><span className="file-kind" aria-hidden="true">Image</span><small>{asset.thumbnailState === "pending" ? "Thumbnail processing…" : "Thumbnail unavailable"}</small></span>}
      <strong>Open full-resolution image</strong>
    </button> : null}
  </aside>;
}

export function ImageLocationMap({ token, locations, scopeLabel, loadAsset, openAsset }: ImageLocationMapProps) {
  const titleId = useId(), dialogTitleId = useId();
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(null); const [selectedAsset, setSelectedAsset] = useState<ImageLocationMapAsset | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false); const [selectionError, setSelectionError] = useState(""); const selectedRefState = useRef<string | null>(null); selectedRefState.current = selectedRef;
  const points = locations?.points ?? [];

  const clearSelection = useCallback(() => { selectedRefState.current = null; setSelectedRef(null); setSelectedAsset(null); setSelectionLoading(false); setSelectionError(""); }, []);
  const selectPoint = useCallback(async (assetRef: string) => {
    if (!loadAsset) return; selectedRefState.current = assetRef; setSelectedRef(assetRef); setSelectedAsset(null); setSelectionError(""); setSelectionLoading(true);
    try { const asset = await loadAsset(assetRef); if (selectedRefState.current === assetRef) setSelectedAsset(asset); }
    catch (error) { if (selectedRefState.current === assetRef) setSelectionError((error as Error).message || "Mapped image is no longer available."); }
    finally { if (selectedRefState.current === assetRef) setSelectionLoading(false); }
  }, [loadAsset]);

  useEffect(() => {
    if (!enlarged) return;
    const priorOverflow = document.body.style.overflow;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (selectedRefState.current) clearSelection(); else setEnlarged(false); } };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      priorFocus?.focus();
    };
  }, [clearSelection, enlarged]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) { event.preventDefault(); dialog.current?.focus(); return; }
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <section className="image-location-map" aria-labelledby={titleId}>
    <header className="image-location-map-header">
      <div><span>Photo map</span><h3 id={titleId}>Image locations from available photo metadata</h3><p>{scopeLabel}</p></div>
      {token && points.length > 0 && <button type="button" className="button-ghost button-small" onClick={() => setEnlarged(true)}>Enlarge map</button>}
    </header>
    {locations === null
      ? <div className="image-location-map-state" role="status">Loading image locations...</div>
      : points.length === 0
        ? <div className="image-location-map-state">No image locations are available for {scopeLabel}.</div>
        : !token
          ? <div className="image-location-map-state">Map preview is unavailable because the map service is not configured.</div>
          : <><LocationCanvas token={token} points={points} expanded={false} scopeLabel={scopeLabel} onPointSelect={selectPoint} />
            {!enlarged && selectedRef && <LocationSelection asset={selectedAsset} loading={selectionLoading} error={selectionError} close={clearSelection} open={() => selectedAsset && openAsset?.(selectedAsset)} />}
            <p className="image-location-map-summary">{locations.imageCount} image{locations.imageCount === 1 ? "" : "s"} at {points.length} mapped location{points.length === 1 ? "" : "s"}.{locations.truncated ? " The preview is limited to the first 500 authorized images." : ""}</p></>}
    {enlarged && token && points.length > 0 && <div className="image-location-map-backdrop" onPointerDown={event => { if (event.currentTarget === event.target) setEnlarged(false); }}>
      <section ref={dialog} className="image-location-map-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId} tabIndex={-1} onKeyDown={trapFocus}>
        <header><div><span>Photo map</span><h2 id={dialogTitleId}>Image locations from available photo metadata</h2><p>{scopeLabel}</p></div><button ref={closeButton} type="button" className="button-ghost" onClick={() => setEnlarged(false)}>Close</button></header>
        <div className="image-location-map-expanded-stage"><LocationCanvas token={token} points={points} expanded scopeLabel={scopeLabel} onPointSelect={selectPoint} />
          {selectedRef && <LocationSelection asset={selectedAsset} loading={selectionLoading} error={selectionError} close={clearSelection} showBackToMap={false} open={() => selectedAsset && openAsset?.(selectedAsset)} />}
        </div>
      </section>
    </div>}
  </section>;
}
