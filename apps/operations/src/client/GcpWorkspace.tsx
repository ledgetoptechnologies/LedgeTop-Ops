import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import mapboxgl from "mapbox-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { ViewerDatasetSummary, ViewerDisplayUnits, ViewerProcessingTask } from "@ltds/shared";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import type { ViewerAdminClient } from "./viewer-admin-client";
import {
  formatGcpDistance,
  formatGcpElevation,
  gcpElevationDisplayValue,
  gcpElevationToMeters,
  gcpElevationUnitName,
  validateGcpImportSize,
  type GcpInterchangeFormat,
  type ViewerGcpCorrespondence,
  type ViewerGcpImage,
  type ViewerGcpPoint,
  type ViewerGcpSet,
} from "./gcp-contract";

type SetDetail = { set: ViewerGcpSet; points: ViewerGcpPoint[] };
type ImageResponse = {
  images: ViewerGcpImage[];
  selectedPoint: ViewerGcpPoint | null;
  ranking: { basis: "adaptive_camera_proximity" | "capture_time"; radiusM: number | null; visibilityConfirmed: false; notice: string };
  pagination: { hasMore: boolean; nextOffset: number | null };
};

function GcpReviewDialog({ children, title, onClose }: { children: ReactElement; title: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="gcp-review-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="gcp-review-dialog-header"><div><p>GROUND CONTROL</p><h2>{title}</h2></div><button type="button" autoFocus onClick={onClose}>Close review</button></header>
    {children}
  </dialog>;
}

function GcpMap({ token, points, images, selectedPointId, onSelectPoint }: {
  token: string | null;
  points: ViewerGcpPoint[];
  images: ViewerGcpImage[];
  selectedPointId: string | null;
  onSelectPoint: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef(onSelectPoint);
  selectRef.current = onSelectPoint;
  useEffect(() => {
    if (!token || !container.current || (!points.length && !images.length)) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: container.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-88.07, 44.5], zoom: 7, interactive: true,
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    const pointFeatures: Feature<Point>[] = points.map((point) => ({
      type: "Feature", properties: { id: point.id, selected: point.id === selectedPointId, label: point.label },
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    }));
    const imageFeatures: Feature<Point>[] = images.map((image) => ({
      type: "Feature", properties: { id: image.id },
      geometry: { type: "Point", coordinates: [image.longitude, image.latitude] },
    }));
    map.on("load", () => {
      map.addSource("gcp-points", { type: "geojson", data: { type: "FeatureCollection", features: pointFeatures } as FeatureCollection });
      map.addSource("gcp-images", { type: "geojson", data: { type: "FeatureCollection", features: imageFeatures } as FeatureCollection });
      map.addLayer({ id: "gcp-image-locations", type: "circle", source: "gcp-images", paint: {
        "circle-radius": 4, "circle-color": "#2563eb", "circle-opacity": 0.68, "circle-stroke-color": "#fff", "circle-stroke-width": 1,
      } });
      map.addLayer({ id: "gcp-markers", type: "circle", source: "gcp-points", paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 10, 7],
        "circle-color": ["case", ["boolean", ["get", "selected"], false], "#f97316", "#facc15"],
        "circle-stroke-color": "#111827", "circle-stroke-width": 2,
      } });
      map.on("click", "gcp-markers", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") selectRef.current(id);
      });
      map.on("mouseenter", "gcp-markers", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "gcp-markers", () => { map.getCanvas().style.cursor = ""; });
      const bounds = new mapboxgl.LngLatBounds();
      for (const point of points) bounds.extend([point.longitude, point.latitude]);
      for (const image of images) bounds.extend([image.longitude, image.latitude]);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 18, duration: 0 });
    });
    return () => map.remove();
  }, [token, points, images, selectedPointId]);
  if (!token) return <div className="gcp-map-state">Map unavailable because the Mapbox public token is not configured.</div>;
  if (!points.length && !images.length) return <div className="gcp-map-state">Import a GCP set to populate the map.</div>;
  return <div ref={container} className="gcp-map" role="img" aria-label="Ground control points and dataset image GPS positions" />;
}

function ImageMarker({ client, datasetId, image, initial, saving, onSave, onRemove }: {
  client: ViewerAdminClient;
  datasetId: string;
  image: ViewerGcpImage;
  initial: ViewerGcpCorrespondence | null;
  saving: boolean;
  onSave: (pixelX: number, pixelY: number) => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pixelX, setPixelX] = useState(initial?.pixelX ?? 0);
  const [pixelY, setPixelY] = useState(initial?.pixelY ?? 0);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const imageElement = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setError(""); setUrl(null); setNaturalSize(null);
    client.requestBlob(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-images/${encodeURIComponent(image.id)}/content`, { signal: controller.signal })
      .then((blob) => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, datasetId, image.id]);
  useEffect(() => { setPixelX(initial?.pixelX ?? 0); setPixelY(initial?.pixelY ?? 0); }, [initial]);
  const mark = (event: MouseEvent<HTMLImageElement>) => {
    const element = imageElement.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setPixelX(Math.max(0, (event.clientX - bounds.left) * element.naturalWidth / bounds.width));
    setPixelY(Math.max(0, (event.clientY - bounds.top) * element.naturalHeight / bounds.height));
  };
  return <section className="gcp-image-marker" aria-label={`Mark ${image.relativePath}`}>
    <header><div><strong>{image.relativePath}</strong><small>Click the visible target, then save. Numeric inputs allow keyboard correction.</small></div></header>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!url && !error && <div className="gcp-image-loading" role="status">Loading private dataset image…</div>}
    {url && <div className="gcp-image-stage">
      <img ref={imageElement} src={url} alt={`Private dataset image ${image.relativePath}; select the GCP pixel`} onClick={mark} onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} draggable={false} />
      {naturalSize ? <span className="gcp-pixel-indicator" style={{
        left: `${100 * pixelX / naturalSize.width}%`, top: `${100 * pixelY / naturalSize.height}%`,
      }} aria-hidden="true" /> : null}
    </div>}
    <div className="gcp-pixel-form">
      <label>Pixel X<input type="number" min="0" step="0.01" value={Number.isFinite(pixelX) ? pixelX : ""} onChange={(event) => setPixelX(event.target.valueAsNumber)} /></label>
      <label>Pixel Y<input type="number" min="0" step="0.01" value={Number.isFinite(pixelY) ? pixelY : ""} onChange={(event) => setPixelY(event.target.valueAsNumber)} /></label>
      <button type="button" className="button-orange" disabled={saving || !Number.isFinite(pixelX) || !Number.isFinite(pixelY)} onClick={() => onSave(pixelX, pixelY)}>{initial ? "Update mark" : "Save mark"}</button>
      {initial && <button type="button" className="button-danger" disabled={saving} onClick={onRemove}>Remove mark</button>}
    </div>
  </section>;
}

export function GcpWorkspace({ client, datasets, tasks, mapToken, units, canRead, canWrite, onReturnToTasks }: {
  client: ViewerAdminClient;
  datasets: ViewerDatasetSummary[];
  tasks: ViewerProcessingTask[];
  mapToken: string | null;
  units: ViewerDisplayUnits;
  canRead: boolean;
  canWrite: boolean;
  onReturnToTasks?: () => void;
}): ReactElement {
  const fileId = useId();
  const availableDatasets = datasets.filter((dataset) => dataset.status === "finalized");
  const [datasetId, setDatasetId] = useState(availableDatasets[0]?.id || "");
  const availableTasks = tasks.filter((task) => task.datasetId === datasetId && task.status !== "archived");
  const [taskId, setTaskId] = useState("");
  const [sets, setSets] = useState<ViewerGcpSet[]>([]);
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [images, setImages] = useState<ViewerGcpImage[]>([]);
  const [imageHasMore, setImageHasMore] = useState(false);
  const [nextImageOffset, setNextImageOffset] = useState<number | null>(null);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [radiusFeet, setRadiusFeet] = useState(50);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rankingNotice, setRankingNotice] = useState("");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [correspondences, setCorrespondences] = useState<ViewerGcpCorrespondence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [format, setFormat] = useState<GcpInterchangeFormat>("generic-csv-v1");
  const [file, setFile] = useState<File | null>(null);
  const setRequestId = useRef(0);
  const imageRequestId = useRef(0);

  useEffect(() => {
    if (!availableDatasets.some((dataset) => dataset.id === datasetId)) setDatasetId(availableDatasets[0]?.id || "");
  }, [availableDatasets, datasetId]);
  useEffect(() => { setTaskId((current) => availableTasks.some((task) => task.id === current) ? current : availableTasks[0]?.id || ""); }, [datasetId, tasks]);

  const loadSets = useCallback(async (nextDatasetId: string) => {
    const requestId = ++setRequestId.current;
    if (!nextDatasetId || !canRead) { setSets([]); setDetail(null); return; }
    const endpoint = `/api/v1/datasets/${encodeURIComponent(nextDatasetId)}/gcp-sets`;
    const value = canWrite
      ? await client.request<{ sets: ViewerGcpSet[]; imported?: number; ignoredInvalid?: number; limited?: boolean }>(`${endpoint}/auto-import`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}",
      })
      : await client.request<{ sets: ViewerGcpSet[] }>(endpoint);
    if (requestId !== setRequestId.current) return;
    setSets(value.sets);
    const importMessages: string[] = [];
    if (value.imported) importMessages.push(`Automatically imported ${value.imported} recognized GCP CSV ${value.imported === 1 ? "file" : "files"} from raw data. The original CSV${value.imported === 1 ? " remains" : "s remain"} unchanged in the dataset.`);
    if (value.ignoredInvalid) importMessages.push(`${value.ignoredInvalid} unrecognized or invalid GCP CSV ${value.ignoredInvalid === 1 ? "file was" : "files were"} left untouched in raw data.`);
    if (value.limited) importMessages.push("Only the first 20 CSV files were checked; more CSV files are present, so review the raw data for additional GCP files.");
    setMessage(importMessages.join(" "));
    const selected = value.sets[0];
    if (!selected) { setDetail(null); setSelectedPointId(null); return; }
    const loaded = await client.request<SetDetail>(`/api/v1/gcp-sets/${encodeURIComponent(selected.id)}`);
    if (requestId !== setRequestId.current) return;
    setDetail(loaded); setSelectedPointId(loaded.points[0]?.id || null);
  }, [canRead, canWrite, client]);
  useEffect(() => { setError(""); loadSets(datasetId).catch((caught) => setError((caught as Error).message)); }, [datasetId, loadSets]);

  const loadPointImages = useCallback(async (pointId: string | null, offset = 0, append = false) => {
    if (!datasetId || !pointId) { imageRequestId.current += 1; setImages([]); setImageHasMore(false); setNextImageOffset(null); setImagesLoading(false); setRankingNotice(""); return; }
    const requestId = ++imageRequestId.current;
    setImagesLoading(true);
    try {
      const radiusM = radiusFeet * 0.3048;
      const value = await client.request<ImageResponse>(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-images?pointId=${encodeURIComponent(pointId)}&mode=radius&radiusM=${radiusM.toFixed(4)}&limit=200&offset=${offset}`);
      if (requestId !== imageRequestId.current) return;
      setImages((current) => append ? [...current, ...value.images.filter((image) => !current.some((existing) => existing.id === image.id))] : value.images);
      setImageHasMore(value.pagination.hasMore);
      setNextImageOffset(value.pagination.nextOffset);
      setRankingNotice(value.ranking.notice);
      if (!append) setSelectedImageId(value.images[0]?.id || null);
    } catch (caught) {
      if (requestId === imageRequestId.current) throw caught;
    } finally {
      if (requestId === imageRequestId.current) setImagesLoading(false);
    }
  }, [client, datasetId, radiusFeet]);
  useEffect(() => {
    // Invalidate any in-flight response as soon as the point, dataset, or radius changes,
    // before the debounce timer gives an older request time to finish.
    imageRequestId.current += 1;
    setImages([]);
    setImageHasMore(false);
    setNextImageOffset(null);
    setImagesLoading(false);
    setSelectedImageId(null);
    const timer = window.setTimeout(() => {
      loadPointImages(selectedPointId).catch((caught) => setError((caught as Error).message));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [loadPointImages, selectedPointId]);
  useEffect(() => {
    if (!taskId) { setCorrespondences([]); return; }
    client.request<{ correspondences: ViewerGcpCorrespondence[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/gcp-correspondences`)
      .then((value) => setCorrespondences(value.correspondences)).catch((caught) => setError((caught as Error).message));
  }, [client, taskId]);

  const selectedPoint = detail?.points.find((point) => point.id === selectedPointId) || null;
  const selectedImage = images.find((image) => image.id === selectedImageId) || null;
  const selectedCorrespondence = correspondences.find((item) => item.pointId === selectedPointId && item.imageFileId === selectedImageId) || null;
  const markedImageIds = useMemo(() => new Set(correspondences.filter((item) => item.pointId === selectedPointId).map((item) => item.imageFileId)), [correspondences, selectedPointId]);

  const run = async (action: () => Promise<void>, success: string) => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); setMessage(success); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (!canRead) return <Card title="Ground control"><EmptyState title="Ground control is unavailable" detail="Your current administrative grant does not include GCP access." /></Card>;
  if (!availableDatasets.length) return <Card title="Ground control"><EmptyState title="No finalized datasets" detail="Finalize a dataset before importing and matching ground control points." /></Card>;
  return <section className="gcp-workspace" aria-label="Ground control point workspace">
    <Card title="Ground control workspace">
      <div className="gcp-context-selectors">
        <label>Dataset<select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>{availableDatasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.displayName}</option>)}</select></label>
        <label>Processing task<select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">Select a task to save marks</option>{availableTasks.map((task) => <option key={task.id} value={task.id}>{task.displayName}</option>)}</select></label>
        <label>GCP set<select value={detail?.set.id || ""} onChange={(event) => {
          const id = event.target.value;
          client.request<SetDetail>(`/api/v1/gcp-sets/${encodeURIComponent(id)}`).then((loaded) => { setDetail(loaded); setSelectedPointId(loaded.points[0]?.id || null); }).catch((caught) => setError((caught as Error).message));
        }}><option value="">No imported sets</option>{sets.map((set) => <option key={set.id} value={set.id}>{set.displayName} ({set.pointCount})</option>)}</select></label>
      </div>
      <p className="viewer-processing-warning">GCP files, source imagery, and pixel correspondences are private administrative inputs. They are never eligible for client or public shares.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}{taskId && tasks.find(task => task.id === taskId)?.status === "draft" && onReturnToTasks && <> <button type="button" className="button-orange button-small" onClick={onReturnToTasks}>Return to Tasks and start first attempt</button></>}</div>}
      {detail && <button type="button" className="button-orange gcp-review-open" onClick={() => setReviewOpen(true)}>Open large GCP photo review</button>}
    </Card>

    {canWrite && <Card title="Import generic GCP interchange">
      <form className="gcp-import-form" onSubmit={(event) => { event.preventDefault(); if (!file || !displayName.trim()) return; const sizeError = validateGcpImportSize(file.size); if (sizeError) { setError(sizeError); return; } void run(async () => {
        const content = await file.text();
        const result = await client.request<{ set: ViewerGcpSet; points: ViewerGcpPoint[] }>(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-sets/import`, {
          method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ displayName: displayName.trim(), format, fileName: file.name, content }),
        });
        setSets((current) => [result.set, ...current]); setDetail({ set: result.set, points: result.points }); setSelectedPointId(result.points[0]?.id || null);
        setDisplayName(""); setFile(null); const input = document.getElementById(fileId) as HTMLInputElement | null; if (input) input.value = "";
      }, "GCP set imported and associated with the dataset."); }}>
        <label>Set name<input maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
        <label>Generic format<select value={format} onChange={(event) => setFormat(event.target.value as GcpInterchangeFormat)}><option value="generic-csv-v1">Generic CSV v1</option><option value="generic-geojson-v1">Generic GeoJSON v1</option></select></label>
        <label>GCP file<input id={fileId} type="file" accept={format === "generic-csv-v1" ? ".csv,text/csv" : ".geojson,.json,application/geo+json,application/json"} onChange={(event) => {
          const selected = event.target.files?.[0] || null;
          const sizeError = selected ? validateGcpImportSize(selected.size) : null;
          if (sizeError) { setFile(null); setError(sizeError); event.currentTarget.value = ""; return; }
          setError(""); setFile(selected);
        }} required /></label>
        <button className="button-orange" disabled={busy || !file || !displayName.trim()}>Import points</button>
        <p>CSV columns: <code>point_id,label,latitude,longitude,elevation_m,description</code>. GeoJSON must contain 3D Point features with <code>point_id</code> and <code>label</code>. Coordinates are EPSG:4326; elevations are meters.</p>
        <p><strong>Emlid Flow:</strong> recognized all-columns CSVs attached to this dataset's raw data import automatically when the GCP workspace opens. Ambiguous or unsupported CSVs are ignored and left unchanged; the original source CSV is retained and never sent to ODM.</p>
      </form>
    </Card>}

    {reviewOpen && detail && <GcpReviewDialog title={selectedPoint ? `Photo match · ${selectedPoint.label}` : "Photo matching"} onClose={() => setReviewOpen(false)}>
      <div className="gcp-review-body">
        <section className="gcp-review-column gcp-review-reference" aria-label="Ground control point map and list">
          <Card title="Ground control points">
            <div className="gcp-point-list gcp-review-point-list">{detail.points.map((point) => <button key={point.id} type="button" aria-pressed={point.id === selectedPointId} onClick={() => setSelectedPointId(point.id)}>
              <strong>{point.label}</strong><span>{point.externalId} · {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</span><small>{formatGcpElevation(point.elevationM, units)}</small>
            </button>)}</div>
            {selectedPoint && canWrite && <details className="gcp-point-editor"><summary>Edit or remove selected point</summary><form key={`${selectedPoint.id}:${units}`} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(async () => {
              const value = await client.request<{ point: ViewerGcpPoint }>(`/api/v1/gcp-points/${encodeURIComponent(selectedPoint.id)}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
                label: String(data.get("label")), latitude: Number(data.get("latitude")), longitude: Number(data.get("longitude")), elevationM: gcpElevationToMeters(Number(data.get("elevation")), units), description: String(data.get("description")) || null,
              }) });
              setDetail((current) => current && ({ ...current, points: current.points.map((point) => point.id === value.point.id ? value.point : point) }));
            }, "GCP point updated."); }}>
              <label>Label<input name="label" defaultValue={selectedPoint.label} required /></label><label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={selectedPoint.latitude} required /></label><label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={selectedPoint.longitude} required /></label><label>Elevation ({gcpElevationUnitName(units)})<input name="elevation" type="number" step="any" defaultValue={gcpElevationDisplayValue(selectedPoint.elevationM,units)} required /></label><label>Description<input name="description" defaultValue={selectedPoint.description || ""} /></label>
              <button className="button-orange" disabled={busy}>Save point</button><button type="button" className="button-danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${selectedPoint.label} and all of its image marks?`)) void run(async () => {
                await client.request(`/api/v1/gcp-points/${encodeURIComponent(selectedPoint.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } });
                setDetail((current) => current && ({ ...current, points: current.points.filter((point) => point.id !== selectedPoint.id) })); setSelectedPointId(null);
              }, "GCP point removed."); }}>Remove point</button>
            </form></details>}
          </Card>
          <Card title="GCP and image locations" className="gcp-review-map-card">
            <div className="gcp-map-legend"><span><i className="gcp-legend-point" /> GCP</span><span><i className="gcp-legend-image" /> Photos within search radius</span></div>
            <GcpMap token={mapToken} points={detail.points} images={images} selectedPointId={selectedPointId} onSelectPoint={setSelectedPointId} />
          </Card>
        </section>
        <section className="gcp-review-column gcp-review-photos" aria-label="Nearby photos and pixel correspondence">
          <Card title={selectedPoint ? `Photos near ${selectedPoint.label}` : "Photos near GCP"}>
            <div className="gcp-radius-control">
              <label>Search radius (feet)<input aria-label="Search radius in feet" type="number" min="1" max="328083" step="1" value={radiusFeet} onChange={(event) => {
                const next = event.target.valueAsNumber;
                if (Number.isFinite(next) && next >= 1 && next <= 328083) setRadiusFeet(next);
              }} /></label>
              <p>Default: 50 feet. The map and photo list include only images inside this radius.</p>
            </div>
            <p className="gcp-ranking-notice"><strong>Review each photo:</strong> {rankingNotice || "Select a GCP to find nearby images."}</p>
            {imagesLoading && <p role="status">Finding nearby photos…</p>}
            {!imagesLoading && selectedPoint && !images.length && <EmptyState title="No photos in this radius" detail="Try a larger search radius. Only geotagged photos can be ranked by location." />}
            {images.length > 0 && <div className="gcp-image-list gcp-review-image-list">{images.map((image, index) => <button key={image.id} type="button" aria-pressed={image.id === selectedImageId} onClick={() => setSelectedImageId(image.id)}>
              <span><strong>#{index + 1} {image.relativePath}</strong><small>{formatGcpDistance(image.distanceM, units)} · {image.capturedAt || "capture time unavailable"}</small></span>
              {markedImageIds.has(image.id) ? <StatusPill tone="success">Marked</StatusPill> : <StatusPill tone="warning">Review</StatusPill>}
            </button>)}</div>}
            {imageHasMore && nextImageOffset !== null && <button type="button" className="secondary-button" disabled={imagesLoading} onClick={() => void loadPointImages(selectedPointId, nextImageOffset, true).catch((caught) => setError((caught as Error).message))}>Load more nearby photos</button>}
          </Card>
          <Card title="Click the GCP target in the selected photo">
            {!selectedPoint || !selectedImage ? <EmptyState title="Select a GCP and nearby photo" detail="Choose a point, then select a photo within the search radius. The map is only a proximity guide; confirm the physical target in the image." /> : !taskId ? <div className="notice">Create a draft task for this dataset in Tasks, then select it in the workspace before saving marks. Starting an attempt first freezes its GCP snapshot.{onReturnToTasks && <> <button type="button" className="button-orange button-small" onClick={() => { setReviewOpen(false); onReturnToTasks(); }}>Go to Tasks</button></>}</div> : <ImageMarker
              client={client} datasetId={datasetId} image={selectedImage} initial={selectedCorrespondence} saving={busy}
              onSave={(pixelX, pixelY) => void run(async () => {
                if (selectedCorrespondence) {
                  const value = await client.request<{ correspondence: ViewerGcpCorrespondence }>(`/api/v1/gcp-correspondences/${encodeURIComponent(selectedCorrespondence.id)}`, {
                    method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ pixelX, pixelY }),
                  }); setCorrespondences((current) => current.map((item) => item.id === value.correspondence.id ? value.correspondence : item));
                } else {
                  const value = await client.request<{ correspondence: ViewerGcpCorrespondence }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/gcp-correspondences`, {
                    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ pointId: selectedPoint.id, imageFileId: selectedImage.id, pixelX, pixelY }),
                  }); setCorrespondences((current) => [...current, value.correspondence]);
                }
              }, "Pixel correspondence saved.")}
              onRemove={() => { if (selectedCorrespondence && window.confirm("Remove this image mark?")) void run(async () => {
                await client.request(`/api/v1/gcp-correspondences/${encodeURIComponent(selectedCorrespondence.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } });
                setCorrespondences((current) => current.filter((item) => item.id !== selectedCorrespondence.id));
              }, "Pixel correspondence removed."); }}
            />}
          </Card>
        </section>
      </div>
    </GcpReviewDialog>}
  </section>;
}
