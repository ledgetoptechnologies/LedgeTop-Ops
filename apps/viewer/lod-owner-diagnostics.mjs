import { Matrix4, Sphere, Vector3 } from 'three';

const finite = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const EVENTS = ['tile-download-start', 'load-model', 'dispose-model', 'tile-visibility-change'];
const DISTANCE_REASONS = new Set(['disabled', 'bootstrap-target', 'unknown-bounds',
  'maximum-detail', 'locked-quality-cut', 'near-surface', 'medium-surface', 'far-surface']);

// Opt-in snapshots and a bounded event ring. Never retain a tile/scene in the
// trace or emit asset URLs: signed query strings and model paths are private.
export function createLodOwnerDiagnostics(tiles, {
  camera,
  retentionProvider = () => ({}),
  now = () => performance.now(),
  eventLimit = 512,
} = {}) {
  const ids = new WeakMap();
  const sceneIds = new WeakMap();
  let nextId = 1;
  let nextSceneId = 1;
  const events = [];
  const limit = Math.max(1, Math.min(2048, Number(eventLimit) || 512));
  const id = value => {
    if (!value || typeof value !== 'object') return null;
    if (!ids.has(value)) ids.set(value, nextId++);
    return ids.get(value);
  };
  const sceneId = scene => {
    if (!scene || typeof scene !== 'object') return null;
    if (!sceneIds.has(scene)) sceneIds.set(scene, nextSceneId++);
    return sceneIds.get(scene);
  };
  const record = event => {
    const tile = event?.tile;
    if (!tile) return;
    events.push({
      at: Math.round(now()),
      frame: finite(tiles.frameCount),
      type: event.type,
      tile: id(tile),
      parent: id(tile.parent),
      scene: sceneId(event.scene || tile.engineData?.scene),
      visible: event.type === 'tile-visibility-change' ? event.visible === true : null,
      kicked: tile.traversal?.kicked === true,
      loadingState: finite(tile.internal?.loadingState),
      owner: id(tile.__ltdsFallbackOwner),
      sse: finite(tile.traversal?.error),
      target: finite(tile.__ltdsPeripheralErrorTarget ?? tiles.errorTarget),
      conservativeRaw: tile.__ltdsConservativeRawSse === true,
      bytes: Math.max(0, Number(tiles.lruCache?.bytesMap?.get?.(tile)) || 0),
    });
    if (events.length > limit) events.splice(0, events.length - limit);
  };
  for (const type of EVENTS) tiles.addEventListener?.(type, record);

  return {
    trace: () => events.map(event => ({ ...event })),
    snapshot({ maxTiles = 512 } = {}) {
      const rowLimit = Math.max(1, Math.min(2048, Number(maxTiles) || 512));
      const retention = retentionProvider() || {};
      const cache = tiles.lruCache;
      const rows = [];
      const stack = tiles.root ? [tiles.root] : [];
      const seen = new Set();
      const sphere = new Sphere();
      const viewSphere = new Sphere();
      const ndc = new Vector3();
      const groupWorld = tiles.group?.matrixWorld?.isMatrix4
        ? tiles.group.matrixWorld : new Matrix4();
      const worldToCamera = camera?.matrixWorld?.isMatrix4
        ? new Matrix4().copy(camera.matrixWorld).invert() : null;
      while (stack.length && seen.size < 16384) {
        const tile = stack.pop();
        if (!tile || seen.has(tile)) continue;
        seen.add(tile);
        for (const child of tile.children || []) stack.push(child);
        const traversal = tile.traversal || {};
        const scene = tile.engineData?.scene;
        const currentFrame = traversal.lastFrameVisited === tiles.frameCount;
        const selected = currentFrame && traversal.used === true;
        const cached = cache?.has?.(tile) === true;
        const fallback = tiles.lodFallbackTiles?.has?.(tile) === true;
        // Include root/owners and every resident or selected candidate, but
        // omit untouched manifest leaves from the default useful report.
        if (tile !== tiles.root && !selected && !cached && !fallback
          && tile.internal?.loadingState !== 1 && tile.internal?.loadingState !== 2
          && tile.internal?.loadingState !== 3) continue;
        let projected = null;
        if (worldToCamera && tile.engineData?.boundingVolume?.getSphere) {
          tile.engineData.boundingVolume.getSphere(sphere);
          sphere.applyMatrix4(groupWorld);
          viewSphere.copy(sphere).applyMatrix4(worldToCamera);
          ndc.copy(sphere.center).project(camera);
          projected = {
            approximation: 'bounding-sphere-not-occlusion',
            centerNdc: ndc.toArray().map(finite),
            nearDepth: finite(-viewSphere.center.z - viewSphere.radius),
            farDepth: finite(-viewSphere.center.z + viewSphere.radius),
            radius: finite(viewSphere.radius),
          };
        }
        rows.push({
          id: id(tile), parent: id(tile.parent),
          owner: id(tile.__ltdsFallbackOwner),
          depth: finite(tile.internal?.depth),
          geometricError: finite(tile.geometricError),
          sse: finite(traversal.error),
          target: finite(tile.__ltdsPeripheralErrorTarget ?? tiles.errorTarget),
          distance: finite(traversal.distanceFromCamera),
          currentFrame, selected,
          inFrustum: currentFrame && traversal.inFrustum === true,
          visible: tiles.visibleTiles?.has?.(tile) === true,
          active: tiles.activeTiles?.has?.(tile) === true,
          kicked: currentFrame && traversal.kicked === true,
          loadingState: finite(tile.internal?.loadingState),
          scene: sceneId(scene),
          attached: Boolean(scene && tiles.group?.children?.includes(scene)),
          cached,
          bytes: Math.max(0, Number(cache?.bytesMap?.get?.(tile)) || 0),
          cacheUsed: cache?.usedSet?.has?.(tile) === true,
          fallback,
          overview: retention.overview?.has?.(tile) === true,
          recent: retention.recent?.has?.(tile) === true,
          focusOverlap: finite(tile.__ltdsFocusOverlap),
          foregroundOverlap: finite(tile.__ltdsForegroundOverlap),
          conservativeRaw: tile.__ltdsConservativeRawSse === true,
          distanceDemand: tile.__ltdsDistanceDemand ? {
            enabled: tile.__ltdsDistanceDemand.enabled === true,
            ready: tile.__ltdsDistanceDemand.ready === true,
            protected: tile.__ltdsDistanceDemand.protected === true,
            distance: finite(tile.__ltdsDistanceDemand.distance),
            modelRadius: finite(tile.__ltdsDistanceDemand.modelRadius),
            nearRadius: finite(tile.__ltdsDistanceDemand.nearRadius),
            farRadius: finite(tile.__ltdsDistanceDemand.farRadius),
            target: finite(tile.__ltdsDistanceDemand.target),
            reason: DISTANCE_REASONS.has(tile.__ltdsDistanceDemand.reason) ? tile.__ltdsDistanceDemand.reason : null,
          } : null,
          focalLocked: tile.__ltdsFocalOwnerLocked === true,
          regionalReady: tile.__ltdsRegionalCoverReady === true,
          regionalPreparing: tile.__ltdsRegionalCoverPreparing === true,
          regionalFocus: id(tile.__ltdsRegionalFocusRegion),
          ownerRank: finite(tile.__ltdsOwnerRank),
          pendingBlockers: finite(tile.__ltdsOwnerPendingBlockers),
          projected,
        });
      }
      rows.sort((a, b) => Number(b.visible) - Number(a.visible)
        || Number(b.selected) - Number(a.selected) || a.id - b.id);
      return {
        version: 1, at: Math.round(now()), frame: finite(tiles.frameCount),
        requestedTarget: finite(tiles.errorTarget),
        distanceDemandEnabled: tiles.__ltdsDistanceDemand?.enabled === true,
        pressure: finite(tiles.__ltdsPeripheralPressureScale),
        camera: camera ? {
          world: Array.from(camera.matrixWorld.elements).map(finite),
          projection: Array.from(camera.projectionMatrix.elements).map(finite),
          groupWorld: Array.from(groupWorld.elements).map(finite),
        } : null,
        visited: seen.size,
        candidates: rows.length,
        truncated: stack.length > 0 || rows.length > rowLimit,
        tiles: rows.slice(0, rowLimit),
        events: events.map(event => ({ ...event })),
      };
    },
    dispose() {
      for (const type of EVENTS) tiles.removeEventListener?.(type, record);
      events.length = 0;
    },
  };
}
