import { FAILED, LOADED, UNLOADED } from '3d-tiles-renderer/core';
import { selectLodNearRegions } from './lod-policy.mjs';

const finiteBytes = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const uri = tile => tile?.content?.uri || tile?.content?.url || '';
const label = tile => String(uri(tile)).split(/[?#]/, 1)[0].replace(/\\/g, '/')
  .split('/').slice(-2).join('/').slice(0, 160);

// Optional, bounded residency only. Authored REPLACE traversal still decides
// visibility; the complete base shell is always the caller's responsibility.
export function createLodRegionalFallbackCoordinator(renderer, {
  switchDelayMs = 2_000,
  retryCooldownMs = 10_000,
  requestTimeoutMs = 30_000,
  maxTiles = 16,
} = {}) {
  const cache = renderer?.lruCache;
  let current = null;
  let base = new Set();
  let registered = new Set();
  // Previous complete covers keep fallback eligibility only while naturally
  // resident. This is bounded metadata, never an additional pin/request budget.
  const historical = new Map();
  let candidate = null;
  let candidateSince = 0;
  let budget = 0;
  let clock = 0;
  let phase = 'disabled';
  let reason = 'disabled';
  let cooldownUntil = 0;
  let requests = 0;
  let disposed = false;
  const cooldowns = new WeakMap();

  const resident = tile => cache?.has?.(tile) === true;
  const ready = tile => resident(tile) && tile?.internal?.loadingState === LOADED
    && Boolean(tile?.engineData?.scene);
  const bytes = tile => {
    const measured = finiteBytes(cache?.getMemoryUsage?.(tile));
    if (measured > 0) return measured;
    try { return finiteBytes(renderer?.getBytesUsed?.(tile)); }
    catch { return 0; }
  };
  const pending = tile => tile?.internal?.loadingState > UNLOADED
    && tile.internal.loadingState < LOADED;
  const measurements = () => {
    const tiles = current?.tiles || [];
    return {
      tileCount: tiles.length,
      readyCount: tiles.filter(ready).length,
      pendingCount: tiles.filter(pending).length,
      residentBytes: tiles.filter(resident).reduce((sum, tile) => sum + bytes(tile), 0),
      knownBytes: tiles.reduce((sum, tile) => sum + bytes(tile), 0),
    };
  };
  const unregister = (owner, owned) => {
    if (owner) {
      delete owner.__ltdsRegionalCoverReady;
      delete owner.__ltdsRegionalFocusRegion;
      delete owner.__ltdsRegionalNearRegions;
    }
    for (const tile of owned) {
      if (!base.has(tile)) renderer?.lodFallbackTiles?.delete?.(tile);
    }
  };
  const removeRegistration = () => {
    unregister(current?.owner, registered);
    registered = new Set();
  };
  const discardHistorical = owner => {
    const cover = historical.get(owner);
    if (!cover) return;
    historical.delete(owner);
    unregister(owner, cover.registered);
  };
  const clearHistorical = () => {
    for (const owner of historical.keys()) discardHistorical(owner);
  };
  const pruneHistorical = () => {
    for (const [owner, cover] of historical) {
      if (!base.has(owner) || validCover(owner)
        || cover.tiles.length !== owner.children.length
        || cover.tiles.some((tile, index) => tile !== owner.children[index] || !ready(tile))) {
        discardHistorical(owner);
      }
    }
    let tileCount = [...historical.values()].reduce((sum, cover) => sum + cover.tiles.length, 0);
    while (historical.size > 4 || tileCount > 64) {
      const owner = historical.keys().next().value;
      tileCount -= historical.get(owner).tiles.length;
      discardHistorical(owner);
    }
  };
  const clearPreparationGate = () => {
    if (current?.gated && current.owner.__ltdsRegionalCoverPreparing === true) {
      delete current.owner.__ltdsRegionalCoverPreparing;
    }
    if (current) current.gated = false;
  };
  const release = ({ preserveReady = false } = {}) => {
    clearPreparationGate();
    if (preserveReady && current && phase === 'ready'
      && current.tiles.every(tile => ready(tile) && bytes(tile) > 0)) {
      historical.set(current.owner, {
        tiles: current.tiles, registered, focusRegion: current.focusRegion,
        nearSelection: current.nearSelection,
      });
      registered = new Set();
      pruneHistorical();
    } else removeRegistration();
    current = null;
  };
  const fail = failure => {
    if (current?.owner) {
      cooldownUntil = clock + Math.max(0, retryCooldownMs);
      cooldowns.set(current.owner, { until: cooldownUntil, reason: failure });
    }
    release();
    phase = 'cooldown';
    reason = failure;
  };

  function retainedTiles() {
    if (disposed || !current || measurements().knownBytes > budget) return [];
    return current.tiles.filter(tile => resident(tile) && (ready(tile) || pending(tile)));
  }

  function markRetained() {
    for (const tile of retainedTiles()) renderer.markTileUsed?.(tile);
  }

  const admissionState = tile => ({
    tile,
    bytes: finiteBytes(cache?.cachedBytes),
    items: cache?.itemSet?.size ?? null,
    used: cache?.usedSet?.size ?? renderer?.usedSet?.size ?? null,
    hardLimit: finiteBytes(cache?.maxBytesSize),
    itemLimit: cache?.maxSize ?? null,
    full: cache?.isFull?.() === true,
    additionalBytes: resident(tile) ? 0 : bytes(tile),
  });
  const sameAdmissionState = (a, b) => Boolean(a && b
    && Object.keys(a).every(key => a[key] === b[key]));

  function deferAdmission(tile) {
    // Only a branch which had no visible fine cut may hold its preparation
    // gate across refusal. A full cache often consists of that branch's still
    // hidden descendants; the *next* traversal must stop demanding them before
    // the normal LRU can reclaim them. Clearing the gate immediately prevents
    // that traversal from ever happening and repeats the same deadlock.
    if (!current?.gated) {
      fail('admission-refused');
      return;
    }
    if (clock - current.progressAt >= Math.max(1, requestTimeoutMs)) {
      fail('request-timeout');
      return;
    }
    current.request = null;
    current.admissionSince ??= clock;
    current.admissionDeferred = admissionState(tile);
    phase = 'prefetch';
    reason = 'awaiting-admission';
    markRetained();
    // Use the renderer/application retention hook. Do not directly evict here:
    // the coordinator does not own the other visible/recent frontier's pins.
    cache?.scheduleUnload?.();
  }

  function requestNextCoverTile() {
    if (!current || current.request || validCover(current.owner)) return;
    const measurement = measurements();
    if (measurement.knownBytes > budget) { fail('cover-over-budget'); return; }
    if (measurement.pendingCount > 0) return;
    const next = current.tiles.find(tile => !ready(tile));
    if (!next) return;
    if (next.internal.loadingState !== UNLOADED) {
      fail('tile-not-requestable');
      return;
    }
    const nextAdmission = admissionState(next);
    if (sameAdmissionState(current.admissionDeferred, nextAdmission)) return;
    if (cache.isFull?.() === true || !nextAdmission.hardLimit
      || nextAdmission.bytes >= nextAdmission.hardLimit
      || nextAdmission.bytes + nextAdmission.additionalBytes > nextAdmission.hardLimit) {
      deferAdmission(next);
      return;
    }
    current.admissionDeferred = null;
    current.admissionSince = null;
    current.request = next;
    current.requestAt = clock;
    requests += 1;
    try {
      const result = renderer.requestTileContents(next);
      // The renderer normally handles failures itself. Guard custom adapters'
      // rejected promises without resurrecting a released or replaced cover.
      if (result?.catch) result.catch(() => {
        if (current?.request === next) fail('tile-failed');
      });
    } catch {
      fail('tile-failed');
      return;
    }
    if (current?.request === next && (!resident(next) || next.internal.loadingState === UNLOADED)) {
      deferAdmission(next);
    }
    markRetained();
  }

  // The renderer clears its used set before traversal and prunes queued tiles
  // before the application's post-traversal update. Protect just this cover's
  // cache entries at that boundary, without changing traversal.used/inFrustum.
  const originalRemoveUnused = renderer?.removeUnusedPendingTiles;
  const removeUnusedWrapper = typeof originalRemoveUnused === 'function'
    ? function (...args) {
      pruneHistorical();
      markRetained();
      const result = originalRemoveUnused.apply(this, args);
      // After the gated traversal releases unused speculative work, give the
      // next bounded proxy first admission into any recovered headroom. Doing
      // this only in the application's later update lets ordinary fine queues
      // consume that space again before the cover can ever progress.
      if (current?.admissionDeferred && current.gated
        && current.owner.traversal?.inFrustum !== false) requestNextCoverTile();
      return result;
    }
    : null;
  if (removeUnusedWrapper) renderer.removeUnusedPendingTiles = removeUnusedWrapper;
  // Eviction can happen between application updates. Remove the whole old
  // cover's eligibility immediately, before another traversal sees a partial
  // historical cover. Do not touch the current coordinator's residency policy.
  const onDisposeModel = event => {
    for (const [owner, cover] of historical) {
      if (owner === event?.tile || cover.tiles.includes(event?.tile)) discardHistorical(owner);
    }
  };
  renderer?.addEventListener?.('dispose-model', onDisposeModel);

  function validCover(owner) {
    if (!owner || owner === renderer?.root || !base.has(owner)
      || owner.parent !== renderer.root || !ready(owner)) return 'owner-not-ready';
    if (String(owner.refine).toUpperCase() !== 'REPLACE') return 'unsupported-refinement';
    const children = owner.children;
    if (!Array.isArray(children) || !children.length || children.length > maxTiles
      || owner.internal?.virtualChildCount > 0) return 'unsupported-cover';
    for (const tile of children) {
      if (!tile?.internal || !tile?.traversal || !tile?.engineData?.boundingVolume
        || tile.parent !== owner || tile.internal.virtualChildCount > 0) return 'incomplete-metadata';
      if (!uri(tile) || tile.internal.hasRenderableContent !== true
        || tile.internal.hasUnrenderableContent === true) return 'non-renderable-cover';
      if (String(tile.refine || owner.refine).toUpperCase() !== 'REPLACE') return 'unsupported-refinement';
      if (!(Number(tile.geometricError) > 0)
        || !Array.isArray(tile.children) || !tile.children.length) return 'leaf-only-cover';
    }
    return null;
  }

  function snapshot() {
    return {
      phase,
      reason,
      owner: current ? label(current.owner) : null,
      focusRegion: current?.focusRegion ? label(current.focusRegion) : null,
      preparationGated: current?.gated === true,
      admissionDeferred: Boolean(current?.admissionDeferred),
      admissionWaitMs: current?.admissionSince === null || !current
        ? 0 : Math.max(0, clock - current.admissionSince),
      nearRegionCount: current?.nearSelection?.selected.size || 0,
      nearCutBytes: Number.isFinite(current?.nearSelection?.totalBytes)
        ? current.nearSelection.totalBytes : null,
      nearCutKnownBytes: current?.nearSelection?.knownBytes || 0,
      nearCutEstimatedBytes: current?.nearSelection?.estimatedBytes || 0,
      nearCutUnknownLeaves: current?.nearSelection?.unknownLeaves || 0,
      nearCutBudgetBytes: current?.nearSelection?.maxBytes || 0,
      nearCutOverBudget: current?.nearSelection?.primaryOverBudget === true,
      ...measurements(),
      maxBytes: budget,
      cooldownUntil,
      requests,
      historicalOwnerCount: historical.size,
      historicalTileCount: [...historical.values()].reduce((sum, cover) => sum + cover.tiles.length, 0),
    };
  }

  function update({ enabled = false, baseTiles = [], candidateOwner = null, maxBytes = 0, now = 0 } = {}) {
    if (disposed) return snapshot();
    clock = Math.max(clock, Number.isFinite(Number(now)) ? Number(now) : clock);
    budget = finiteBytes(maxBytes);
    base = new Set(baseTiles || []);
    if (!enabled || !budget || !renderer?.root || !cache
      || typeof renderer.requestTileContents !== 'function'
      || !base.size || base.has(renderer.root) || [...base].some(tile => !ready(tile))) {
      release();
      clearHistorical();
      candidate = null;
      phase = 'disabled';
      reason = !enabled ? 'disabled' : !budget ? 'no-budget' : 'base-shell-not-ready';
      return snapshot();
    }
    pruneHistorical();

    if (current && (!base.has(current.owner) || validCover(current.owner))) release();
    if (candidate !== candidateOwner) {
      candidate = candidateOwner;
      candidateSince = clock;
    }
    if (current && current.owner !== candidateOwner) {
      const clearlyOutside = current.owner.traversal?.inFrustum === false;
      if (clearlyOutside || clock - candidateSince >= Math.max(0, switchDelayMs)) {
        release({ preserveReady: true });
      }
    }
    if (!current) {
      const invalid = validCover(candidateOwner);
      if (invalid) {
        phase = 'idle';
        reason = invalid;
        return snapshot();
      }
      const cooling = cooldowns.get(candidateOwner);
      if (cooling && cooling.until > clock) {
        phase = 'cooldown';
        reason = cooling.reason;
        cooldownUntil = cooling.until;
        return snapshot();
      }
      cooldownUntil = 0;
      const previous = historical.get(candidateOwner);
      if (previous) {
        historical.delete(candidateOwner);
        registered = previous.registered;
      }
      const stack = [...candidateOwner.children];
      const visited = new Set();
      let existingCut = false;
      while (stack.length) {
        const tile = stack.pop();
        if (!tile || visited.has(tile)) continue;
        visited.add(tile);
        if (tile.traversal?.visible === true || renderer.visibleTiles?.has?.(tile)) {
          existingCut = true;
          break;
        }
        // Unknown or pathological topology must not impose a new detail gate.
        if (visited.size >= 4_096) { existingCut = true; break; }
        stack.push(...(tile.children || []));
      }
      current = {
        owner: candidateOwner, tiles: [...candidateOwner.children], request: null,
        requestAt: 0, progressAt: clock, readyCount: 0, gated: !existingCut, existingCut,
        focusRegion: previous?.focusRegion || null, regionOutsideSince: null,
        admissionDeferred: null, admissionSince: null,
        nearSelection: previous?.nearSelection || null,
      };
      phase = 'prefetch';
      if (current.gated) candidateOwner.__ltdsRegionalCoverPreparing = true;
    }

    if (current.tiles.length !== current.owner.children.length
      || current.tiles.some((tile, index) => tile !== current.owner.children[index])) {
      fail('hierarchy-changed');
      return snapshot();
    }
    const measurement = measurements();
    const regionInView = tile => tile?.traversal?.inFrustum === true
      && (!Number.isFinite(renderer.frameCount)
        || tile.traversal.lastFrameVisited === renderer.frameCount);
    const regionsInView = current.tiles.filter(regionInView).sort((a, b) => (
      (Number.isFinite(a.traversal.distanceFromCamera) ? a.traversal.distanceFromCamera : Infinity)
      - (Number.isFinite(b.traversal.distanceFromCamera) ? b.traversal.distanceFromCamera : Infinity)
    ));
    // Preserve the near surface even when a tilt places it below screen center.
    // This is a depth-priority hint, not an occlusion or visibility override.
    if (!current.focusRegion) current.focusRegion = regionsInView[0] || null;
    if (phase === 'ready') {
      if (current.focusRegion && regionInView(current.focusRegion)) current.regionOutsideSince = null;
      else if (current.regionOutsideSince === null) current.regionOutsideSince = clock;
      else if (clock - current.regionOutsideSince >= Math.max(0, switchDelayMs)) {
        current.focusRegion = regionsInView[0] || null;
        current.regionOutsideSince = null;
      }
    }
    if (measurement.readyCount !== current.readyCount) {
      current.readyCount = measurement.readyCount;
      current.progressAt = clock;
    }
    if (measurement.knownBytes > budget) {
      fail('cover-over-budget');
      return snapshot();
    }
    if (current.tiles.some(tile => tile.internal.loadingState === FAILED)) {
      fail('tile-failed');
      return snapshot();
    }
    if (current.request) {
      if (ready(current.request)) current.request = null;
      else if (!resident(current.request) || current.request.internal.loadingState === UNLOADED) {
        deferAdmission(current.request);
        return snapshot();
      } else if (clock - current.requestAt >= Math.max(1, requestTimeoutMs)) {
        fail('request-timeout');
        return snapshot();
      }
    }

    if (measurement.readyCount === current.tiles.length) {
      if (current.tiles.some(tile => bytes(tile) <= 0)) {
        fail('unknown-decoded-size');
        return snapshot();
      }
      if (!(renderer.lodFallbackTiles instanceof Set)) renderer.lodFallbackTiles = new Set(base);
      for (const tile of current.tiles) {
        if (!renderer.lodFallbackTiles.has(tile)) registered.add(tile);
        renderer.lodFallbackTiles.add(tile);
      }
      clearPreparationGate();
      // Base coverage and other visible surfaces must fit alongside this
      // owner's complete near cuts. Spare speculative residency is reclaimable;
      // charging the whole full cache would prevent any quality expansion.
      const reserved = new Set([...base, ...current.tiles]);
      for (const tile of renderer.visibleTiles || []) {
        let ancestor = tile;
        const seen = new Set();
        while (ancestor && ancestor !== current.owner && !seen.has(ancestor)) {
          seen.add(ancestor);
          ancestor = ancestor.parent;
        }
        if (ancestor !== current.owner) reserved.add(tile);
      }
      const reservedBytes = [...reserved].reduce((sum, tile) => sum + bytes(tile), 0);
      const hardBytes = finiteBytes(cache.maxBytesSize);
      const nearBudget = Math.max(0, hardBytes * 0.90 - reservedBytes);
      current.nearSelection = selectLodNearRegions(current.tiles, {
        primary: current.focusRegion,
        previous: current.nearSelection?.selected || new Map(),
        now: clock,
        maxBytes: nearBudget,
        getBytes: bytes,
        isInView: regionInView,
      });
      current.owner.__ltdsRegionalCoverReady = true;
      current.owner.__ltdsRegionalFocusRegion = current.focusRegion;
      current.owner.__ltdsRegionalNearRegions = new Set(current.nearSelection.selected.keys());
      phase = 'ready';
      reason = 'complete-cover';
      markRetained();
      return snapshot();
    }

    // Naturally selected requests may have started before this coordinator
    // acquired the branch. They must not pin an incomplete optional cover (or
    // hold initial promotion) indefinitely either.
    if (clock - current.progressAt >= Math.max(1, requestTimeoutMs)) {
      fail('request-timeout');
      return snapshot();
    }

    removeRegistration();
    phase = 'prefetch';
    reason = current.admissionDeferred ? 'awaiting-admission'
      : current.existingCut ? 'existing-cut' : 'building-cover';
    markRetained();
    // Serialize optional requests, including unknown decoded allocations. A
    // normal renderer request already in flight for this cover also counts.
    requestNextCoverTile();
    return snapshot();
  }

  function dispose() {
    if (disposed) return;
    release();
    clearHistorical();
    renderer?.removeEventListener?.('dispose-model', onDisposeModel);
    disposed = true;
    phase = 'disposed';
    reason = 'disposed';
    if (renderer?.removeUnusedPendingTiles === removeUnusedWrapper) {
      renderer.removeUnusedPendingTiles = originalRemoveUnused;
    }
  }

  return { update, retainedTiles, snapshot, dispose };
}
