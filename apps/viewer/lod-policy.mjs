import * as THREE from 'three';
import { resolveLodMemoryProfile } from './lod-memory-profile.mjs';

export const MIN_LOD_DETAIL = 2;
export const MAX_LOD_DETAIL = 24;
export const LOD_WARMUP_DETAIL = 13;
export const DEFAULT_LOD_DETAIL = 20;
export const LOD_REFINEMENT_STEP = 3;
export const LOW_MEMORY_MAX_LOD_DETAIL = 13;
export const LOD_ADMISSION_RECOVERY_SAMPLES = 2;
export const LOD_PRESSURE_FALLBACK_SAMPLES = 4;
export const LOD_MAX_PERIPHERAL_PRESSURE_SCALE = 4;
export const LOD_BOOTSTRAP_ROOT_MIN_ERROR_TARGET = 4096;
export const LOD_BOOTSTRAP_COVERAGE_MIN_ERROR_TARGET = 1024;
export const LOD_PREFETCH_MAX_MS = 3_000;
export const LOD_PREFETCH_MAX_DEPTH = 2;
// 1.25 GiB is the preferred shell target, not a universal safety boundary.
// Real decoded texture footprints vary slightly by browser and GPU; the
// production church shell measures about 1.30 GiB. Allow a bounded expansion
// only when the configured cache can still reserve more than half of its 3 GiB
// desktop budget for the camera-selected detail frontier.
export const LOD_FALLBACK_TARGET_BYTES = 1.25 * 1024 * 1024 * 1024;
export const LOD_FALLBACK_HARD_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
export const LOD_FALLBACK_MIN_DETAIL_BYTES = 1.625 * 1024 * 1024 * 1024;
export const LOD_FOCUS_IDLE_MS = 250;
export const LOD_FOCUS_DECAY_MS = 500;
// Focus-owner retention is intentionally wider than the 1-8 px motion range
// used by browser acceptance. The snapshot remains anchored at acquisition so
// many individually small moves still release a stale owner after a bounded
// cumulative 3 degree turn or 5% camera-to-owner translation.
export const LOD_FOCUS_OWNER_MAX_ANGLE_DEGREES = 3;
export const LOD_FOCUS_OWNER_MAX_TRANSLATION_RATIO = 0.05;
// Queue ordering uses a broad region so nearby work completes smoothly, while
// pressure-driven selection reserves raw SSE for the central fifth-width
// foreground region. Internal tiles inherit that narrower classification from
// visited descendants, so a loose parent bound cannot label the entire view as
// foreground or hide a genuinely centered child.
export const LOD_FOCUS_PRIORITY_CONE_RADIUS = 0.65;
export const LOD_FOREGROUND_CONE_RADIUS = 0.2;
export const LOD_QUALITY_STABLE_FRAMES = 2;

// Experimental demand policy, deliberately disabled unless the renderer opts
// in. Ratios are fractions of the transformed root bounding-sphere radius, not
// assumed metres. These defaults need real-dataset visual calibration.
export const LOD_DISTANCE_DEMAND_NEAR_RADIUS_RATIO = 0.25;
export const LOD_DISTANCE_DEMAND_FAR_RADIUS_RATIO = 0.5;
export const LOD_DISTANCE_DEMAND_FAR_TARGET_AT_DETAIL20 = 512;

export function lodDistanceDemandTarget(rawTarget, {
  distance = Infinity, modelRadius = 0, unknown = false, locked = false,
} = {}, config = null) {
  const raw = Number(rawTarget);
  const enabled = config?.enabled === true;
  const nearRatio = Number.isFinite(config?.nearRadiusRatio) && config.nearRadiusRatio > 0
    ? config.nearRadiusRatio : LOD_DISTANCE_DEMAND_NEAR_RADIUS_RATIO;
  const farRatio = Number.isFinite(config?.farRadiusRatio) && config.farRadiusRatio > nearRatio
    ? config.farRadiusRatio : Math.max(LOD_DISTANCE_DEMAND_FAR_RADIUS_RATIO, nearRatio * 2);
  const nearRadius = modelRadius * nearRatio;
  const farRadius = modelRadius * farRatio;
  const ready = Number.isFinite(modelRadius) && modelRadius > 0 && Number.isFinite(distance) && distance >= 0 && !unknown;
  const result = { enabled, ready, distance, modelRadius, nearRadius, farRadius, target: rawTarget, protected: false, reason: 'disabled' };
  if (!enabled) return result;
  if (raw > detailToErrorTarget(MIN_LOD_DETAIL)) return { ...result, protected: true, reason: 'bootstrap-target' };
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(modelRadius) || modelRadius <= 0
    || !Number.isFinite(distance) || distance < 0 || unknown) {
    return { ...result, protected: true, reason: 'unknown-bounds' };
  }
  // Maximum quality is an explicit user override, not another distance band.
  if (raw <= detailToErrorTarget(MAX_LOD_DETAIL)) return { ...result, protected: true, reason: 'maximum-detail' };
  if (locked) return { ...result, protected: true, reason: 'locked-quality-cut' };
  if (distance <= nearRadius) return { ...result, protected: true, reason: 'near-surface' };
  const progress = Math.min(1, Math.max(0, (distance - nearRadius) / (farRadius - nearRadius)));
  const smooth = progress * progress * (3 - 2 * progress);
  const cap = Math.max(raw, LOD_DISTANCE_DEMAND_FAR_TARGET_AT_DETAIL20 * raw / detailToErrorTarget(DEFAULT_LOD_DETAIL));
  return { ...result, target: raw + (cap - raw) * smooth, reason: progress === 1 ? 'far-surface' : 'medium-surface' };
}
const CONTROLLED_CONVERTER_BINARY_SHA256 = new Set(['40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274','c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1']);
const CONTROLLED_CONVERTER_COMMAND_SHA256 = new Set([
  '7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681',
  '8d0931aa44aae76b48832212cd6c649b73e9b9843d5d5f07462f167d0e8d5752',
]);

export function detailToErrorTarget(value) {
  const parsed = Number.parseInt(value, 10);
  const detail = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : DEFAULT_LOD_DETAIL;
  const coarseFraction = (MAX_LOD_DETAIL - detail) / (MAX_LOD_DETAIL - MIN_LOD_DETAIL);
  return Number((2 * Math.pow(256, coarseFraction)).toFixed(3));
}

export function lodBootstrapRootErrorTarget(rootScreenSpaceError) {
  const error = Number(rootScreenSpaceError);
  const target = Number.isFinite(error) && error > 0
    ? Math.max(LOD_BOOTSTRAP_ROOT_MIN_ERROR_TARGET, error * 1.10)
    : LOD_BOOTSTRAP_ROOT_MIN_ERROR_TARGET;
  return Number(target.toFixed(3));
}

export function lodBootstrapCoverageErrorTarget(rootScreenSpaceError, childScreenSpaceErrors = []) {
  const rootError = Number(rootScreenSpaceError);
  const childErrors = Array.from(childScreenSpaceErrors || [], Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  const maximumChildError = childErrors.length ? Math.max(...childErrors) : 0;
  let target = Math.max(LOD_BOOTSTRAP_COVERAGE_MIN_ERROR_TARGET, maximumChildError * 1.05);
  // A valid REPLACE hierarchy normally leaves a clean target band between a
  // parent and its direct children. When a small fixture or unusual converter
  // puts the minimum coverage target above the root error, use that band rather
  // than leaving the root selected forever.
  if (Number.isFinite(rootError) && rootError > maximumChildError && target >= rootError) {
    target = (rootError + maximumChildError) / 2;
  }
  return Number(Math.max(1, target).toFixed(3));
}

export function lodErrorScaleForCoverage(coverageErrorTarget) {
  const coverage = Number(coverageErrorTarget);
  if (!Number.isFinite(coverage) || coverage <= 0) return 1;
  return coverage / detailToErrorTarget(DEFAULT_LOD_DETAIL);
}

export function scaledDetailToErrorTarget(detail, scale = 1) {
  const parsedScale = Number(scale);
  const multiplier = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
  return Number((detailToErrorTarget(detail) * multiplier).toFixed(3));
}

// Start steady refinement one hierarchy step beyond the completed overview.
// Using the raw Detail target here selects the full church tree at Home and
// exhausts branch-completion headroom; keeping the full coverage scale never
// leaves coarse mode. Half the measured scale preserves the captured fallback
// while allowing nearby descendants to complete as the camera approaches.
export function steadyStateLodErrorTarget(detail, coverageScale = 1) {
  return detailToErrorTarget(detail);
}

// A renderable root covers the whole model, so it cannot remain a permanent
// REPLACE fallback after detail streaming begins: one cold child would make it
// hide every ready descendant. Promotion is safe only after the complete
// spatial shell immediately below the root is attached and fits the reserved
// fallback budget. The caller may still retain the root briefly in the LRU,
// but it must not include it in the steady-state fallback set.
export function lodFallbackShellMaxBytes(cacheMaxBytes, {
  targetBytes = LOD_FALLBACK_TARGET_BYTES,
  hardMaxBytes = LOD_FALLBACK_HARD_MAX_BYTES,
  minimumDetailBytes = LOD_FALLBACK_MIN_DETAIL_BYTES,
  bootstrapResidentBytes = 0,
} = {}) {
  const cache = Number(cacheMaxBytes);
  const target = Math.max(0, Number(targetBytes) || 0);
  const hardMaximum = Math.max(target, Number(hardMaxBytes) || 0);
  const detailReserve = Math.max(0, Number(minimumDetailBytes) || 0);
  const bootstrapResident = Math.max(0, Number(bootstrapResidentBytes) || 0);
  if (!Number.isFinite(cache) || cache <= 0) return 0;

  // Never grow the fallback beyond the absolute bound or consume the detail
  // reserve. On the normal 3 GiB cache this yields a 1.375 GiB shell ceiling;
  // smaller custom caches fail closed earlier instead of silently starving
  // refinement. Reduced-memory clients bypass shell promotion entirely.
  return Math.max(0, Math.min(
    hardMaximum,
    cache - detailReserve,
    cache - bootstrapResident,
  ));
}

export function lodFallbackShellPlan(root, {
  isReady = () => false,
  getBytes = () => 0,
  softMaxBytes = LOD_FALLBACK_TARGET_BYTES,
  maxBytes = LOD_FALLBACK_TARGET_BYTES,
} = {}) {
  const children = Array.isArray(root?.children) ? root.children : [];
  const unsupported = children.some((tile) => tile?.internal?.hasUnrenderableContent === true
    || (tile?.internal?.hasRenderableContent !== true && !Boolean(contentUri(tile))));
  const shell = children.filter((tile) => tile?.internal?.hasUnrenderableContent !== true
    && (tile?.internal?.hasRenderableContent === true || Boolean(contentUri(tile))));
  const bytes = shell.reduce((total, tile) => total + Math.max(0, Number(getBytes(tile)) || 0), 0);
  // Off-frustum sibling content is decoded but deliberately not attached by
  // the renderer. A ready scene can be attached synchronously when selected,
  // so scene readiness—not current visibility—is the safe promotion gate.
  const ready = shell.filter(tile => isReady(tile));
  const softBudget = Number(softMaxBytes);
  const budget = Number(maxBytes);
  const overSoftBudget = Number.isFinite(softBudget) && softBudget >= 0 && bytes > softBudget;
  const overBudget = Number.isFinite(budget) && budget >= 0 && bytes > budget;
  return {
    shell,
    ready,
    bytes,
    complete: shell.length > 0 && ready.length === shell.length && !overBudget && !unsupported,
    overSoftBudget,
    overBudget,
    unsupported,
    pending: Math.max(0, shell.length - ready.length),
  };
}

function lodTileFocusOverlap(tile) {
  return Math.min(1, Math.max(0, Number(tile?.__ltdsFocusOverlap) || 0));
}

function lodTileCameraDistance(tile) {
  const value = Number(tile?.traversal?.distanceFromCamera);
  return Number.isFinite(value) ? value : Infinity;
}

function lodQueueCameraDistance(tile) {
  const distance = tile?.traversal?.distanceFromCamera;
  return Number.isFinite(distance) && distance >= 0 ? distance : Infinity;
}

function lodTileFocusReferenceDistance(tile) {
  const surfaceDistance = lodTileCameraDistance(tile);
  if (surfaceDistance > 0 && Number.isFinite(surfaceDistance)) return surfaceDistance;

  // distanceFromCamera is distance to the bounding-volume surface and is zero
  // while the camera is inside a broad owner. Keep translation hysteresis
  // bounded in that case with the positive world-space bound scale captured by
  // the projection plugin. Positive geometric error is a final conservative
  // scale for malformed or not-yet-projected owner bounds.
  const boundScale = Number(tile?.__ltdsFocusReferenceDistance);
  if (Number.isFinite(boundScale) && boundScale > 0) return boundScale;
  const geometricError = Number(tile?.geometricError);
  return Number.isFinite(geometricError) && geometricError > 0
    ? geometricError
    : null;
}

function validLodFocusView(view) {
  return Array.isArray(view?.position) && view.position.length === 3
    && view.position.every(Number.isFinite)
    && Array.isArray(view?.forward) && view.forward.length === 3
    && view.forward.every(Number.isFinite);
}

function copyLodFocusView(view) {
  if (!validLodFocusView(view)) return null;
  return {
    frameCount: Number.isFinite(Number(view.frameCount)) ? Number(view.frameCount) : null,
    position: [...view.position],
    forward: [...view.forward],
  };
}

function lodFocusOwnerViewExceeded(focusState) {
  const acquired = focusState?.ownerView;
  const current = focusState?.currentView;
  if (!validLodFocusView(acquired) || !validLodFocusView(current)) return false;

  const dot = Math.min(1, Math.max(-1,
    acquired.forward[0] * current.forward[0]
    + acquired.forward[1] * current.forward[1]
    + acquired.forward[2] * current.forward[2]));
  const minimumDirectionDot = Math.cos(
    THREE.MathUtils.degToRad(LOD_FOCUS_OWNER_MAX_ANGLE_DEGREES),
  );
  if (dot < minimumDirectionDot) return true;

  const translation = Math.hypot(
    current.position[0] - acquired.position[0],
    current.position[1] - acquired.position[1],
    current.position[2] - acquired.position[2],
  );
  const ownerDistance = Number(focusState?.ownerDistance);
  return Number.isFinite(ownerDistance) && ownerDistance > 0
    && translation > ownerDistance * LOD_FOCUS_OWNER_MAX_TRANSLATION_RATIO;
}

export function lodTileInLockedFocalOwner(tile) {
  const assignedOwner = tile?.__ltdsFallbackOwner;
  if (assignedOwner?.__ltdsFocalOwnerLocked === true) return true;

  let current = tile;
  // A valid 3D Tiles tree cannot contain a parent cycle. Keep a defensive
  // bound so malformed runtime metadata cannot wedge request prioritization.
  for (let depth = 0; current && depth < 256; depth += 1) {
    if (current.__ltdsFocalOwnerLocked === true) return true;
    current = current.parent;
  }
  return false;
}

// A complete regional cover may protect more than one nearby surface. Charge
// whole terminal cuts, not only currently loaded/visible leaves: otherwise an
// apparently cheap neighbor can expand into an unaffordable atomic REPLACE cut.
// Unknown decoded allocations are estimates, never permission to exceed the
// renderer's prospective hard cap.
export function selectLodNearRegions(regions, {
  primary = null,
  previous = new Map(),
  now = 0,
  maxBytes = 0,
  maxRegions = 4,
  entryRatio = 1.35,
  exitRatio = 1.75,
  exitDelayMs = 2_000,
  getBytes = () => 0,
  getDistance = lodTileCameraDistance,
  isInView = tile => tile?.traversal?.inFrustum === true,
} = {}) {
  const candidates = Array.from(new Set(regions || []));
  const finiteBytes = tile => Math.max(0, Number(getBytes(tile)) || 0);
  const cuts = new Map();
  let largestKnownLeaf = 0;
  for (const region of candidates) {
    const leaves = [];
    const stack = [...(region.children || [])];
    const seen = new Set();
    let valid = stack.length > 0;
    while (stack.length && valid) {
      const tile = stack.pop();
      if (!tile || seen.has(tile) || seen.size >= 4_096) { valid = false; break; }
      seen.add(tile);
      if (tile.children?.length) stack.push(...tile.children);
      else {
        if (Number(tile.geometricError) !== 0 || !contentUri(tile)) { valid = false; break; }
        const known = finiteBytes(tile);
        largestKnownLeaf = Math.max(largestKnownLeaf, known);
        leaves.push({ tile, known });
      }
    }
    cuts.set(region, { leaves, valid });
  }
  const costs = new Map();
  for (const region of candidates) {
    const cut = cuts.get(region);
    // Use the larger observed leaf/proxy allocation with a 2x heuristic for
    // unknown leaves; this is not a guaranteed upper bound. Actual admission
    // still enforces the hard cap. No byte evidence means no expansion.
    const unknownEstimate = 2 * Math.max(finiteBytes(region), largestKnownLeaf);
    const knownBytes = cut.leaves.reduce((sum, leaf) => sum + leaf.known, 0);
    const unknownLeaves = cut.leaves.filter(leaf => leaf.known <= 0).length;
    const estimatedBytes = unknownLeaves * unknownEstimate;
    const cost = cut.valid && (!unknownLeaves || unknownEstimate > 0)
      ? knownBytes + estimatedBytes : Infinity;
    costs.set(region, { cost, knownBytes, estimatedBytes, unknownLeaves });
  }
  const distance = region => {
    const measured = Number(getDistance(region));
    return Number.isFinite(measured) && measured >= 0 ? measured : Infinity;
  };
  const visible = candidates.filter(region => isInView(region) && Number.isFinite(distance(region)))
    .sort((a, b) => distance(a) - distance(b));
  const nearest = visible[0] || null;
  const nearestDistance = nearest ? distance(nearest) : Infinity;
  // Bounding-volume distance can be zero inside a tile. Use that nearest
  // region's measured bound scale, not a world-unit constant, for the band.
  const distanceScale = nearestDistance > 0 ? nearestDistance
    : Math.max(0, Number(nearest?.__ltdsFocusReferenceDistance) || 0,
      Number(nearest?.geometricError) || 0);
  const entryDistance = distanceScale * Math.max(1, Number(entryRatio) || 1);
  const exitDistance = distanceScale * Math.max(Number(entryRatio) || 1, Number(exitRatio) || 1);
  const eligible = new Map();
  for (const region of candidates) {
    if (isInView(region) && distance(region) <= (previous.has(region) ? exitDistance : entryDistance)) {
      eligible.set(region, Number(now));
    } else if (previous.has(region) && Number(now) - Number(previous.get(region)) < exitDelayMs) {
      eligible.set(region, previous.get(region));
    }
  }
  const selected = new Map();
  let totalBytes = 0, knownBytes = 0, estimatedBytes = 0, unknownLeaves = 0;
  const include = region => {
    selected.set(region, eligible.get(region) ?? Number(now));
    const cost = costs.get(region);
    totalBytes += cost.cost;
    knownBytes += cost.knownBytes;
    estimatedBytes += cost.estimatedBytes;
    unknownLeaves += cost.unknownLeaves;
  };
  // Preserve the existing acquired primary even when an unusually large cut
  // cannot fit. Expansion must not secretly lower its requested quality.
  if (candidates.includes(primary)) include(primary);
  const budget = Math.max(0, Number(maxBytes) || 0);
  const limit = Math.max(1, Math.min(candidates.length, Number(maxRegions) || 1));
  const ranked = [...eligible.keys()].filter(region => region !== primary).sort((a, b) => (
    Number(previous.has(b)) - Number(previous.has(a)) || distance(a) - distance(b)
  ));
  for (const region of ranked) {
    const cost = costs.get(region).cost;
    if (selected.size >= limit || !Number.isFinite(cost) || totalBytes + cost > budget) continue;
    include(region);
  }
  return {
    selected,
    totalBytes, knownBytes, estimatedBytes, unknownLeaves,
    maxBytes: budget,
    primaryOverBudget: totalBytes > budget,
  };
}

function lodTileInLockedQualityOwner(tile) {
  let current = tile;
  let child = null;
  // A complete, resident regional cover separates the coarse owner's quality
  // dependency into independent child regions. Preserve its acquired near cut
  // (including when it moves off center), but do not make every distant region
  // raw merely because their shared coarse ancestor still owns queue priority.
  for (let depth = 0; current && depth < 256; depth += 1) {
    if (child && current.__ltdsRegionalCoverReady === true
      && current.__ltdsRegionalFocusRegion !== child
      && current.__ltdsRegionalNearRegions?.has?.(child) !== true) return false;
    if (current.__ltdsFocalOwnerLocked === true) return true;
    child = current;
    current = current.parent;
  }
  const assignedOwner = tile?.__ltdsFallbackOwner;
  // Historical assignments without a linked ancestor retain the legacy lock,
  // unless that owner has explicitly split its quality dependency by region.
  return assignedOwner?.__ltdsFocalOwnerLocked === true
    && assignedOwner.__ltdsRegionalCoverReady !== true;
}

// A visible positive-error REPLACE tile is the spatial fallback owner for the
// cold cut immediately below it. Treating every cold tile as one global queue
// caused wide views to spread cache admission across every fallback branch,
// so no one branch completed and all refined content remained hidden. Keep the
// public flat cut for compatibility, but attach an explicit nearest-owner group
// to every blocker so request scheduling can complete one useful spatial cut.
export function lodBranchBlockerGroups(visibleTiles, {
  isReady = () => false,
  focusState = null,
} = {}) {
  const visible = Array.from(visibleTiles || []);
  const owners = visible.filter(fallback => (
    String(fallback?.refine || '').toUpperCase() === 'REPLACE'
    && Number(fallback?.geometricError) > 0
  ));
  const groupsByOwner = new Map(owners.map((owner, index) => [owner, {
    owner,
    ownerIndex: index,
    blockers: [],
    queueDistanceFromCamera: Infinity,
    focusOverlap: lodTileFocusOverlap(owner),
    distanceFromCamera: lodTileCameraDistance(owner),
    focusActivityTime: Number(owner?.__ltdsFocusActivityTime) || 0,
  }]));
  const assignmentByTile = new Map();
  const frontierAssignmentByTile = new Map();
  let encounterIndex = 0;

  for (const owner of owners) {
    const stack = (owner.children || []).map(tile => ({ tile, depth: 1 }));
    while (stack.length) {
      const { tile, depth } = stack.pop();
      if (!tile?.traversal?.used || !tile?.traversal?.inFrustum) continue;
      if (tile.internal?.hasUnrenderableContent === true) {
        stack.push(...(tile.children || []).map(child => ({ tile: child, depth: depth + 1 })));
        continue;
      }
      if (tile.internal?.hasRenderableContent || contentUri(tile)) {
        // Scheduling needs the whole selected replacement frontier, including
        // ready siblings. Do not reuse the owner sphere or cold-only minimum:
        // either can make a far owner win or demote a nearly completed cut.
        const frontierOwner = frontierAssignmentByTile.get(tile);
        if (!frontierOwner || depth < frontierOwner.depth) {
          frontierAssignmentByTile.set(tile, { owner, depth });
        }
        if (!isReady(tile)) {
          const existing = assignmentByTile.get(tile);
          if (!existing || depth < existing.depth) {
            assignmentByTile.set(tile, {
              owner,
              depth,
              encounterIndex: existing?.encounterIndex ?? encounterIndex++,
            });
          }
        }
        continue;
      }
      stack.push(...(tile.children || []).map(child => ({ tile: child, depth: depth + 1 })));
    }
  }

  for (const [tile, assignment] of frontierAssignmentByTile) {
    const group = groupsByOwner.get(assignment.owner);
    if (group) group.queueDistanceFromCamera = Math.min(
      group.queueDistanceFromCamera, lodQueueCameraDistance(tile),
    );
  }

  for (const [tile, assignment] of assignmentByTile) {
    const group = groupsByOwner.get(assignment.owner);
    if (!group) continue;
    group.blockers.push({ tile, encounterIndex: assignment.encounterIndex });
    group.focusOverlap = Math.max(group.focusOverlap, lodTileFocusOverlap(tile));
    group.distanceFromCamera = Math.min(group.distanceFromCamera, lodTileCameraDistance(tile));
    group.focusActivityTime = Math.max(
      group.focusActivityTime,
      Number(tile?.__ltdsFocusActivityTime) || 0,
    );
  }

  const pendingGroups = Array.from(groupsByOwner.values())
    .filter(group => group.blockers.length > 0)
    .map(group => ({
      ...group,
      blockers: group.blockers
        .sort((a, b) => a.encounterIndex - b.encounterIndex)
        .map(entry => entry.tile),
    }));
  const naturallyRanked = pendingGroups.sort((a, b) => (
    b.focusOverlap - a.focusOverlap
    || a.distanceFromCamera - b.distanceFromCamera
    || a.ownerIndex - b.ownerIndex
  ));

  // Focus identity is separate from atomic load completion. Once the focused
  // owner's replacement cut attaches it leaves the visible fallback list, but
  // its descendants still identify their historical owner. Keep that owner at
  // raw requested SSE until a newer camera interaction deliberately selects a
  // different camera-centered owner. Otherwise peripheral queue work would
  // immediately take the focus lock and coarsen the sharp foreground again.
  const focusOwners = new Set();
  const focusMetrics = new Map();
  const addFocusOwner = (owner) => {
    if (!owner) return null;
    focusOwners.add(owner);
    let metric = focusMetrics.get(owner);
    if (!metric) {
      metric = {
        owner,
        ownerIndex: focusMetrics.size,
        focusOverlap: lodTileFocusOverlap(owner),
        distanceFromCamera: lodTileCameraDistance(owner),
        focusActivityTime: Number(owner?.__ltdsFocusActivityTime) || 0,
      };
      focusMetrics.set(owner, metric);
    }
    return metric;
  };
  for (const owner of owners) addFocusOwner(owner);
  for (const tile of visible) {
    if (tile?.__ltdsFallbackOwner) {
      const metric = addFocusOwner(tile.__ltdsFallbackOwner);
      metric.focusOverlap = Math.max(metric.focusOverlap, lodTileFocusOverlap(tile));
      metric.distanceFromCamera = Math.min(metric.distanceFromCamera, lodTileCameraDistance(tile));
      metric.focusActivityTime = Math.max(
        metric.focusActivityTime,
        Number(tile?.__ltdsFocusActivityTime) || 0,
      );
    }
    let ancestor = tile?.parent;
    for (let depth = 0; ancestor && depth < 256; depth += 1) {
      if (Number.isFinite(Number(ancestor.__ltdsFocalOwnerEpoch))) addFocusOwner(ancestor);
      ancestor = ancestor.parent;
    }
  }
  for (const [owner, pendingGroup] of groupsByOwner) {
    const metric = addFocusOwner(owner);
    metric.focusOverlap = Math.max(metric.focusOverlap, Number(pendingGroup.focusOverlap) || 0);
    metric.distanceFromCamera = Math.min(
      metric.distanceFromCamera,
      Number.isFinite(Number(pendingGroup.distanceFromCamera))
        ? Number(pendingGroup.distanceFromCamera)
        : Infinity,
    );
    metric.focusActivityTime = Math.max(
      metric.focusActivityTime,
      Number(pendingGroup.focusActivityTime) || 0,
    );
  }
  const focusCandidates = Array.from(focusMetrics.values()).sort((a, b) => (
    b.focusOverlap - a.focusOverlap
    || a.distanceFromCamera - b.distanceFromCamera
    || a.ownerIndex - b.ownerIndex
  ));
  const latestActivityTime = focusCandidates.reduce(
    (latest, candidate) => Math.max(latest, candidate.focusActivityTime),
    0,
  );
  const sharedFocusState = focusState && typeof focusState === 'object' ? focusState : null;
  const previousFocusedOwner = sharedFocusState?.owner || null;
  const previousMetric = previousFocusedOwner
    ? focusMetrics.get(previousFocusedOwner) || null
    : null;
  // Keep an already-completed focal cut sharp through small camera motion while
  // it still intersects the centered foreground region. Once the owner leaves
  // that region (or the view entirely), release it even though it is absent
  // from the current visible-owner set. Without the explicit shared pointer an
  // off-view owner could keep __ltdsFocalOwnerLocked forever and pin the prior
  // camera angle in the recent-frontier cache.
  const ownerViewExceeded = sharedFocusState
    ? lodFocusOwnerViewExceeded(sharedFocusState)
    : false;
  let focusedOwner = previousMetric?.focusOverlap > 0 && !ownerViewExceeded
    ? previousFocusedOwner
    : null;
  if (!focusedOwner && !sharedFocusState) {
    focusedOwner = focusCandidates.find(candidate => (
      candidate.owner?.__ltdsFocalOwnerLocked === true
      && (Number(candidate.owner?.__ltdsFocalOwnerEpoch) || 0) >= latestActivityTime
    ))?.owner || null;
  }
  if (!focusedOwner) focusedOwner = focusCandidates[0]?.owner || null;

  if (previousFocusedOwner) focusOwners.add(previousFocusedOwner);
  for (const owner of focusOwners) {
    owner.__ltdsFocalOwnerLocked = false;
    owner.__ltdsFocalOwnerPending = false;
  }
  const focalGroup = naturallyRanked.find(group => group.owner === focusedOwner) || null;
  if (focusedOwner) {
    focusedOwner.__ltdsFocalOwnerLocked = true;
    focusedOwner.__ltdsFocalOwnerPending = Boolean(focalGroup);
    focusedOwner.__ltdsFocalOwnerEpoch = latestActivityTime;
  }
  if (sharedFocusState) {
    const ownerChanged = focusedOwner !== previousFocusedOwner;
    sharedFocusState.owner = focusedOwner;
    if (ownerChanged || (focusedOwner && !validLodFocusView(sharedFocusState.ownerView))) {
      sharedFocusState.ownerView = focusedOwner
        ? copyLodFocusView(sharedFocusState.currentView)
        : null;
      const selectedMetric = focusedOwner ? focusMetrics.get(focusedOwner) : null;
      sharedFocusState.ownerDistance = focusedOwner
        ? (lodTileFocusReferenceDistance(focusedOwner)
          ?? (Number.isFinite(selectedMetric?.distanceFromCamera)
            && selectedMetric.distanceFromCamera > 0
            ? selectedMetric.distanceFromCamera
            : null))
        : null;
    }
  }

  const ranked = focalGroup
    ? [focalGroup, ...naturallyRanked.filter(group => group !== focalGroup)]
    : naturallyRanked;
  for (let rank = 0; rank < ranked.length; rank += 1) {
    const group = ranked[rank];
    group.rank = rank;
    group.focal = group === focalGroup;
    group.owner.__ltdsOwnerRank = rank;
    group.owner.__ltdsOwnerQueueDistance = group.queueDistanceFromCamera;
    group.owner.__ltdsOwnerPendingBlockers = group.blockers.length;
    for (const tile of group.blockers) {
      tile.__ltdsBranchBlocker = true;
      tile.__ltdsFallbackOwner = group.owner;
      tile.__ltdsOwnerRank = rank;
      tile.__ltdsOwnerQueueDistance = group.queueDistanceFromCamera;
      tile.__ltdsOwnerFocusOverlap = group.focusOverlap;
      tile.__ltdsFocalOwnerPending = group.focal;
      tile.__ltdsFocusPending = true;
    }
  }

  return ranked;
}

export function lodBranchBlockerCut(visibleTiles, options = {}) {
  return lodBranchBlockerGroups(visibleTiles, options).flatMap(group => group.blockers);
}

export function lodFocusPriorityPenalty(tile, interactionState, now = performance.now()) {
  // Keep the acquired owner's scheduling priority. Quality locking is scoped
  // separately when a complete regional cover makes its children independent.
  if (lodTileInLockedFocalOwner(tile)) return 1;
  const age = Math.max(0, Number(now) - (Number(interactionState?.lastActivityTime) || 0));
  const focalCutPending = interactionState?.focusPending === true
    || (tile?.__ltdsBranchBlocker === true && tile?.__ltdsFocusPending === true);
  let strength = interactionState?.activeMotion || focalCutPending ? 1 : 0;
  if (!focalCutPending && !interactionState?.activeMotion && age > LOD_FOCUS_IDLE_MS) {
    strength = Math.max(0, 1 - (age - LOD_FOCUS_IDLE_MS) / LOD_FOCUS_DECAY_MS);
  } else if (!focalCutPending && !interactionState?.activeMotion && age <= LOD_FOCUS_IDLE_MS) {
    strength = 1;
  }
  const overlap = Math.min(1, Math.max(0, Number(tile?.__ltdsFocusOverlap) || 0));
  return 1 + 3 * strength * (1 - overlap);
}

// Per-tile traversal may use this raised target only after the adaptive memory
// governor explicitly reports persistent pressure. Camera motion affects queue
// priority through lodFocusPriorityPenalty, but never selection: otherwise a
// one-pixel pan would immediately replace decoded detail with a coarse parent.
// The focal ray always receives raw requested SSE and strict REPLACE remains
// entirely renderer-controlled.
export function lodPeripheralErrorTarget(
  errorTarget,
  tile,
  interactionState,
  now = performance.now(),
  memoryPressureScale = 1,
) {
  const rawTarget = Number(errorTarget);
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) return errorTarget;
  if (lodTileInLockedQualityOwner(tile)) return rawTarget;
  // Only a branch with still-unclassified descendant bounds needs conservative
  // raw SSE. Camera motion itself must not expand every peripheral branch: the
  // current-frame relevance pass classifies known descendants before traversal.
  if (tile?.__ltdsConservativeRawSse === true) return rawTarget;
  const pressure = Math.min(
    LOD_MAX_PERIPHERAL_PRESSURE_SCALE,
    Math.max(1, Number(memoryPressureScale) || 1),
  );
  const overlap = Math.min(
    1,
    Math.max(0, Number(tile?.__ltdsForegroundOverlap) || 0),
  );
  // Foreground membership is binary for selection. Internal tiles consume
  // current-frame descendant relevance rather than their own often-loose bound.
  // Wider focus overlap remains independent, for smooth queue ordering only.
  if (overlap > 0) return rawTarget;
  // Persistent cache pressure may keep the periphery coarse even after the
  // motion delay expires. The camera-centered focal branch remains exactly at
  // the requested SSE, while only tiles outside that cone are relaxed.
  const pressurePenalty = 1 + (pressure - 1) * (1 - overlap);
  return rawTarget * pressurePenalty;
}

function projectedSphereFocusOverlap(camera, sphere, coneRadius, scratch) {
  if (!camera || !sphere?.center) return 0;
  const radius = Math.max(0, Number(sphere.radius) || 0);
  const cone = Math.max(1e-6, Number(coneRadius) || 0.65);

  const {
    centerNdc, edgeNdc, cameraPosition, cameraRight, cameraUp,
    cameraForward, cameraToCenter,
  } = scratch;
  cameraPosition.setFromMatrixPosition(camera.matrixWorld);
  if (cameraPosition.distanceTo(sphere.center) <= radius) return 1;
  cameraForward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
  cameraToCenter.subVectors(sphere.center, cameraPosition);
  // Vector3.project returns finite x/y values for geometry behind a perspective
  // camera. Reject a sphere only when its complete extent is behind the camera
  // plane; a sphere crossing the plane can still cover the centered view.
  if (cameraToCenter.dot(cameraForward) + radius <= 0) return 0;

  centerNdc.copy(sphere.center).project(camera);
  if (![centerNdc.x, centerNdc.y, centerNdc.z].every(Number.isFinite)) return 0;

  let projectedRadius = 0;
  if (radius > 0) {
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    edgeNdc.copy(sphere.center).addScaledVector(cameraRight, radius).project(camera);
    if (Number.isFinite(edgeNdc.x) && Number.isFinite(edgeNdc.y)) {
      projectedRadius = Math.max(
        projectedRadius,
        Math.hypot(edgeNdc.x - centerNdc.x, edgeNdc.y - centerNdc.y),
      );
    }
    edgeNdc.copy(sphere.center).addScaledVector(cameraUp, radius).project(camera);
    if (Number.isFinite(edgeNdc.x) && Number.isFinite(edgeNdc.y)) {
      projectedRadius = Math.max(
        projectedRadius,
        Math.hypot(edgeNdc.x - centerNdc.x, edgeNdc.y - centerNdc.y),
      );
    }
  }

  // Foveated quality is anchored to the stable camera view center. Pointer
  // position is intentionally irrelevant: moving a cursor over an unchanged
  // camera view must not reshuffle owner groups or alter effective tile SSE.
  const centerDistance = Math.hypot(centerNdc.x, centerNdc.y);
  const distanceFromProjectedExtent = Math.max(0, centerDistance - projectedRadius);
  return Math.min(1, Math.max(0, 1 - distanceFromProjectedExtent / cone));
}

export function lodProjectedSphereFocusOverlap(camera, sphere, coneRadius = 0.65) {
  return projectedSphereFocusOverlap(camera, sphere, coneRadius, {
    centerNdc: new THREE.Vector3(),
    edgeNdc: new THREE.Vector3(),
    cameraPosition: new THREE.Vector3(),
    cameraRight: new THREE.Vector3(),
    cameraUp: new THREE.Vector3(),
    cameraForward: new THREE.Vector3(),
    cameraToCenter: new THREE.Vector3(),
  });
}

function projectedTileFocusOverlaps(camera, tile, sphere, scratch) {
  const cache = scratch.tileOverlapCache;
  if (cache.has(tile)) return cache.get(tile);
  const volume = tile?.engineData?.boundingVolume;
  const overlaps = { priority: 0, foreground: 0 };
  if (volume?.getSphere) {
    volume.getSphere(sphere);
    // Tile bounds are authored in TilesRenderer.group root space. The viewer
    // deliberately parents that group under a rotated and translated frame,
    // while the camera is a world-space camera. Projecting the raw local sphere
    // makes foreground selection depend on camera angle. Convert the sphere to
    // world space once per visited tile/frame before comparing or projecting.
    sphere.applyMatrix4(scratch.groupWorldMatrix);
    const centerDistance = scratch.cameraPosition.distanceTo(sphere.center);
    const boundScale = Math.max(
      Number.isFinite(centerDistance) ? centerDistance : 0,
      Number.isFinite(sphere.radius) ? Math.max(0, sphere.radius) : 0,
      Number.isFinite(Number(tile?.geometricError)) ? Math.max(0, Number(tile.geometricError)) : 0,
    );
    tile.__ltdsFocusReferenceDistance = boundScale > 0 ? boundScale : null;
    overlaps.priority = projectedSphereFocusOverlap(
      camera,
      sphere,
      LOD_FOCUS_PRIORITY_CONE_RADIUS,
      scratch,
    );
    overlaps.foreground = projectedSphereFocusOverlap(
      camera,
      sphere,
      LOD_FOREGROUND_CONE_RADIUS,
      scratch,
    );
  } else {
    tile.__ltdsFocusReferenceDistance = null;
  }
  cache.set(tile, overlaps);
  return overlaps;
}

function lodCameraProjectionSnapshot(camera, scratch, frameCount, tilesRenderer) {
  const group = tilesRenderer?.group;
  group?.updateWorldMatrix?.(true, false);
  if (group?.matrixWorld?.isMatrix4) scratch.groupWorldMatrix.copy(group.matrixWorld);
  else scratch.groupWorldMatrix.identity();
  scratch.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
  scratch.cameraForward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
  if (tilesRenderer?.__ltdsDistanceDemand?.enabled === true) {
    const elements = scratch.groupWorldMatrix.elements;
    const x = new THREE.Vector3(elements[0], elements[1], elements[2]);
    const y = new THREE.Vector3(elements[4], elements[5], elements[6]);
    const z = new THREE.Vector3(elements[8], elements[9], elements[10]);
    const lengths = [x.length(), y.length(), z.length()];
    const scale = Math.max(...lengths);
    const tolerance = scale * scale * 1e-10;
    const orthogonal = Math.abs(x.dot(y)) <= tolerance && Math.abs(x.dot(z)) <= tolerance && Math.abs(y.dot(z)) <= tolerance;
    const similarity = scale > 0 && orthogonal && lengths.every(value => Math.abs(value - scale) <= scale * 1e-10);
    scratch.distanceWorldScale = similarity ? scale : null;
    // Frobenius norm safely encloses a sphere under shear; maximum column
    // length is sufficient only for orthogonal scaled axes.
    scratch.distanceSphereScale = orthogonal ? scale : Math.hypot(...lengths);
    scratch.distanceCameraLocal.copy(scratch.cameraPosition).applyMatrix4(scratch.distanceGroupInverse.copy(scratch.groupWorldMatrix).invert());
  }
  return {
    frameCount: Number.isFinite(frameCount) ? frameCount : null,
    position: scratch.cameraPosition.toArray(),
    forward: scratch.cameraForward.toArray(),
    projection: Array.from(camera.projectionMatrix?.elements || []),
    groupWorld: Array.from(scratch.groupWorldMatrix.elements),
  };
}

function tileForegroundRelevance(camera, tile, sphere, scratch) {
  const cache = scratch.tileRelevanceCache;
  if (cache.has(tile)) return cache.get(tile);

  // Classify the known hierarchy bottom-up before its ancestor chooses an SSE.
  // Memoization makes this linear in the known nodes, not a subtree scan for
  // every ancestor. Use an explicit stack for deep authored trees. Stop at the
  // lazy preprocessing frontier: never preprocess nodes or request content here.
  const pending = [{ tile, visited: false }];
  const visiting = new Set();
  while (pending.length) {
    const entry = pending.pop();
    const current = entry.tile;
    if (cache.has(current)) continue;
    if (!entry.visited) {
      if (visiting.has(current)
        || typeof current?.engineData?.boundingVolume?.getSphere !== 'function') {
        cache.set(current, { foreground: 0, unknown: true });
        continue;
      }
      const direct = projectedTileFocusOverlaps(camera, current, sphere, scratch);
      const children = Array.isArray(current.children) ? current.children : [];
      if (children.length === 0) {
        cache.set(current, { foreground: direct.foreground, unknown: false });
        continue;
      }
      visiting.add(current);
      pending.push({ tile: current, visited: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child && typeof child === 'object' && !cache.has(child)) {
          pending.push({ tile: child, visited: false });
        }
      }
    } else {
      let foreground = 0;
      let unknown = false;
      for (const child of current.children) {
        const relevance = child && typeof child === 'object' ? cache.get(child) : null;
        if (relevance?.foreground > 0) foreground = 1;
        if (!relevance || relevance.unknown) unknown = true;
      }
      cache.set(current, { foreground, unknown });
      visiting.delete(current);
    }
  }
  return cache.get(tile);
}

function distanceDemandBound(tile, scratch) {
  if (scratch.distanceBoundCache.has(tile)) return scratch.distanceBoundCache.get(tile);
  const getSphere = tile?.engineData?.boundingVolume?.getSphere;
  if (typeof getSphere !== 'function') return { distance: Infinity, radius: 0, unknown: true };
  const sphere = scratch.distanceSphere;
  sphere.makeEmpty();
  try {
    getSphere.call(tile.engineData.boundingVolume, sphere);
    if (![sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius].every(Number.isFinite)
      || sphere.radius < 0) return { distance: Infinity, radius: 0, unknown: true };
    sphere.center.applyMatrix4(scratch.groupWorldMatrix);
    sphere.radius *= scratch.distanceSphereScale;
  } catch {
    return { distance: Infinity, radius: 0, unknown: true };
  }
  let distance = Math.max(0, scratch.cameraPosition.distanceTo(sphere.center) - sphere.radius);
  // A tight OBB gives useful distance where its circumscribing sphere covers
  // half the site. Distances transform exactly under uniform scale + rigid
  // transforms. Nonuniform/sheared groups use the conservative world sphere.
  const volume = tile.engineData.boundingVolume;
  if (scratch.distanceWorldScale !== null && typeof volume.distanceToPoint === 'function') {
    try {
      const localDistance = volume.distanceToPoint(scratch.distanceCameraLocal);
      if (Number.isFinite(localDistance) && localDistance >= 0) distance = localDistance * scratch.distanceWorldScale;
    } catch { /* malformed optional tight bound retains conservative sphere distance */ }
  }
  const result = {
    distance,
    radius: sphere.radius,
    unknown: false,
  };
  scratch.distanceBoundCache.set(tile, result);
  return result;
}

function tileDistanceDemandRelevance(tile, scratch) {
  const cache = scratch.distanceRelevanceCache;
  const pending = [{ tile, visited: false }];
  const visiting = new Set();
  while (pending.length) {
    const entry = pending.pop();
    const current = entry.tile;
    if (!current || typeof current !== 'object') continue;
    if (cache.has(current)) continue;
    if (!entry.visited) {
      const own = distanceDemandBound(current, scratch);
      if (own.unknown || visiting.has(current)) {
        cache.set(current, { ...own, unknown: true });
        continue;
      }
      const children = Array.isArray(current.children) ? current.children : [];
      if (!children.length) { cache.set(current, own); continue; }
      visiting.add(current);
      pending.push({ tile: current, visited: true, own });
      for (const child of children) if (child && typeof child === 'object' && !cache.has(child)) {
        pending.push({ tile: child, visited: false });
      }
    } else {
      let distance = entry.own.distance;
      let unknown = false;
      for (const child of current.children) {
        const relevance = cache.get(child);
        if (!relevance || relevance.unknown) unknown = true;
        if (relevance) distance = Math.min(distance, relevance.distance);
      }
      // Own bound plus every known descendant: even a malformed non-enclosing
      // parent cannot relax away a nearby surface. Loose bounds intentionally
      // over-protect. No occlusion or screen-center visibility guess is made.
      cache.set(current, { ...entry.own, distance, unknown });
      visiting.delete(current);
    }
  }
  return cache.get(tile) || { distance: Infinity, radius: 0, unknown: true };
}

export function createLodFocusPriorityPlugin(camera, interactionStateProvider) {
  const sphere = new THREE.Sphere();
  const focusScratch = {
    centerNdc: new THREE.Vector3(),
    edgeNdc: new THREE.Vector3(),
    cameraPosition: new THREE.Vector3(),
    cameraRight: new THREE.Vector3(),
    cameraUp: new THREE.Vector3(),
    cameraForward: new THREE.Vector3(),
    cameraToCenter: new THREE.Vector3(),
    groupWorldMatrix: new THREE.Matrix4(),
    tileOverlapCache: new WeakMap(),
    tileOverlapCacheFrame: null,
    tileRelevanceCache: new WeakMap(),
    distanceRelevanceCache: new WeakMap(),
    distanceSphere: new THREE.Sphere(),
    distanceCameraLocal: new THREE.Vector3(),
    distanceGroupInverse: new THREE.Matrix4(),
    distanceWorldScale: null,
    distanceSphereScale: 1,
    distanceBoundCache: new WeakMap(),
  };
  let tilesRenderer = null;
  return {
    name: 'LTDS_FOCUS_REQUEST_PRIORITY',
    init(tiles) {
      tilesRenderer = tiles;
      focusScratch.tileOverlapCache = new WeakMap();
      focusScratch.tileOverlapCacheFrame = null;
      focusScratch.tileRelevanceCache = new WeakMap();
      focusScratch.distanceRelevanceCache = new WeakMap();
      focusScratch.distanceBoundCache = new WeakMap();
    },
    preprocessNode(tile, _tilesetDir, parentTile = null) {
      // The engine installs this node's transformed bounds after this hook.
      // Invalidate only the changed ancestor path; other same-frame branches
      // retain their memoized classification and never become globally raw.
      if (!tile || typeof tile !== 'object') return;
      focusScratch.tileOverlapCache.delete(tile);
      focusScratch.tileRelevanceCache.delete(tile);
      focusScratch.distanceRelevanceCache.delete(tile);
      focusScratch.distanceBoundCache.delete(tile);
      const seen = new Set();
      let ancestor = parentTile || tile.parent;
      while (ancestor && !seen.has(ancestor)) {
        seen.add(ancestor);
        focusScratch.tileRelevanceCache.delete(ancestor);
        focusScratch.distanceRelevanceCache.delete(ancestor);
        ancestor = ancestor.parent;
      }
    },
    calculateTileViewError(tile) {
      let overlap = 0;
      const state = interactionStateProvider?.();
      if (camera) {
        const frameCount = Number(tilesRenderer?.frameCount);
        const frameChanged = !Number.isFinite(frameCount)
          ? focusScratch.tileOverlapCacheFrame === null
          : frameCount !== focusScratch.tileOverlapCacheFrame;
        if (frameChanged) {
          const cameraSnapshot = lodCameraProjectionSnapshot(
            camera,
            focusScratch,
            frameCount,
            tilesRenderer,
          );
          focusScratch.tileOverlapCache = new WeakMap();
          focusScratch.tileRelevanceCache = new WeakMap();
          focusScratch.distanceRelevanceCache = new WeakMap();
          focusScratch.distanceBoundCache = new WeakMap();
          focusScratch.tileOverlapCacheFrame = Number.isFinite(frameCount)
            ? frameCount
            : 0;
          const focusState = tilesRenderer?.__ltdsFocusOwnerState;
          if (focusState && typeof focusState === 'object') {
            focusState.currentView = {
              frameCount: cameraSnapshot.frameCount,
              position: [...cameraSnapshot.position],
              forward: [...cameraSnapshot.forward],
            };
          }
        }
        const directOverlaps = projectedTileFocusOverlaps(camera, tile, sphere, focusScratch);
        const relevance = tileForegroundRelevance(camera, tile, sphere, focusScratch);
        const internal = Array.isArray(tile?.children) && tile.children.length > 0;
        overlap = Math.max(directOverlaps.priority, internal && relevance.foreground > 0 ? 1 : 0);
        tile.__ltdsConservativeRawSse = relevance.unknown;
        tile.__ltdsForegroundOverlap = relevance.foreground;
      }
      tile.__ltdsFocusOverlap = overlap;
      tile.__ltdsFocusActivityTime = Number(state?.lastActivityTime) || 0;
      tile.__ltdsPeripheralSelectionPenalty = lodFocusPriorityPenalty(tile, state);
      tile.__ltdsPeripheralErrorTarget = lodPeripheralErrorTarget(
        tilesRenderer?.errorTarget,
        tile,
        state,
        performance.now(),
        tilesRenderer?.__ltdsPeripheralPressureScale,
      );
      if (tilesRenderer?.__ltdsDistanceDemand?.enabled === true) {
        const rootBound = distanceDemandBound(tilesRenderer.root, focusScratch);
        const relevance = tileDistanceDemandRelevance(tile, focusScratch);
        const demand = lodDistanceDemandTarget(tilesRenderer.errorTarget, {
          distance: relevance.distance,
          modelRadius: rootBound.radius,
          unknown: !camera || rootBound.unknown || relevance.unknown,
          locked: lodTileInLockedQualityOwner(tile),
        }, tilesRenderer.__ltdsDistanceDemand);
        tile.__ltdsDistanceDemand = demand;
        // This is a separate opt-in selection experiment. Do not multiply its
        // target by motion, cone overlap, or the peripheral pressure multiplier.
        tile.__ltdsPeripheralErrorTarget = demand.target;
      } else {
        tile.__ltdsDistanceDemand = null;
      }
      // Returning false leaves camera visibility and the authored REPLACE
      // hierarchy under renderer control. The pinned traversal patch consumes
      // the per-tile target above without mutating the global requested SSE.
      return false;
    },
    dispose() {
      const focusState = tilesRenderer?.__ltdsFocusOwnerState;
      const owner = focusState?.owner;
      if (owner) {
        owner.__ltdsFocalOwnerLocked = false;
        owner.__ltdsFocalOwnerPending = false;
        focusState.owner = null;
      }
      if (focusState) {
        focusState.ownerView = null;
        focusState.ownerDistance = null;
        focusState.currentView = null;
      }
      tilesRenderer = null;
    },
  };
}

export function createLodFocusPriorityCallback(interactionStateProvider, nowProvider = () => performance.now()) {
  const structuralPriority = tile => {
    if (tile?.internal?.hasRenderableContent !== true
      || tile.internal.hasUnrenderableContent === true) return 0;
    if (tile.parent == null && tile.internal.depth === 0) return 2;
    const owner = tile.parent;
    // This flag is held only for a validated, bounded regional cover whose
    // owner has no existing fine cut. Only its immediate children are needed;
    // treating every descendant as structural recreates global demand bias.
    return owner?.__ltdsRegionalCoverPreparing === true
      && String(owner.refine).toUpperCase() === 'REPLACE'
      && owner.children?.includes(tile) ? 1 : 0;
  };
  const ownerRank = tile => Number.isFinite(tile?.__ltdsOwnerRank)
    ? tile.__ltdsOwnerRank : Infinity;
  const schedulingDistance = (tile, blocker) => blocker
    && Number.isFinite(tile?.__ltdsOwnerQueueDistance)
    && tile.__ltdsOwnerQueueDistance >= 0
    ? tile.__ltdsOwnerQueueDistance : lodQueueCameraDistance(tile);
  return (a, b) => {
    const base = screenSpaceErrorPriority(a, b);
    if ((a?.priority ?? 0) !== (b?.priority ?? 0)) return base;
    const at = a?.traversal;
    const bt = b?.traversal;
    if (!at || !bt) return !at && !bt ? base : at ? 1 : -1;
    const aStructural = structuralPriority(a);
    const bStructural = structuralPriority(b);
    if (aStructural !== bStructural) return aStructural > bStructural ? 1 : -1;
    if (at.inFrustum !== bt.inFrustum || at.used !== bt.used) return base;
    if (Boolean(a?.internal?.hasUnrenderableContent)
      !== Boolean(b?.internal?.hasUnrenderableContent)) return base;
    const aBlocker = a?.__ltdsBranchBlocker === true;
    const bBlocker = b?.__ltdsBranchBlocker === true;
    const aDistance = schedulingDistance(a, aBlocker);
    const bDistance = schedulingDistance(b, bBlocker);
    if (aDistance !== bDistance) return aDistance < bDistance ? 1 : -1;
    // Finish a useful nearby atomic cut before unrelated medium-distance
    // work, without allowing a distant screen-center owner to monopolize the
    // queue. Existing focus/quality locks and owner ranks are not changed.
    if (aBlocker !== bBlocker) return aBlocker ? 1 : -1;
    if (aBlocker && bBlocker) {
      const aOwnerRank = ownerRank(a);
      const bOwnerRank = ownerRank(b);
      if (aOwnerRank !== bOwnerRank) return aOwnerRank < bOwnerRank ? 1 : -1;
    }
    const state = interactionStateProvider?.();
    const now = nowProvider();
    // Focus still breaks equal-distance ties, but never expands selected
    // quality or lets farther peripheral work outrank a nearer surface.
    const aScore = aBlocker ? 1 : lodFocusPriorityPenalty(a, state, now);
    const bScore = bBlocker ? 1 : lodFocusPriorityPenalty(b, state, now);
    if (aScore !== bScore) return aScore > bScore ? -1 : 1;
    const aMemberDistance = lodQueueCameraDistance(a);
    const bMemberDistance = lodQueueCameraDistance(b);
    if (aMemberDistance !== bMemberDistance) return aMemberDistance < bMemberDistance ? 1 : -1;
    return base;
  };
}

// With loadAncestors disabled, selected zero-error leaves are the actual
// replacement work. Sorting by SSE first starves those leaves behind farther
// positive-error parents, so distant regions sharpen while the foreground
// never completes. Match the renderer's optimized traversal: in-frustum and
// camera distance first, then shallower content for stable ties.
export function screenSpaceErrorPriority(a, b) {
  const aPriority = a?.priority ?? 0;
  const bPriority = b?.priority ?? 0;
  if (aPriority !== bPriority) return aPriority > bPriority ? 1 : -1;

  const at = a?.traversal;
  const bt = b?.traversal;
  if (!at || !bt) return 0;
  if (at.used !== bt.used) return at.used ? 1 : -1;
  if (at.inFrustum !== bt.inFrustum) return at.inFrustum ? 1 : -1;

  const aExternal = Boolean(a?.internal?.hasUnrenderableContent);
  const bExternal = Boolean(b?.internal?.hasUnrenderableContent);
  if (aExternal !== bExternal) return aExternal ? 1 : -1;

  const aDistance = Number.isFinite(at.distanceFromCamera) ? at.distanceFromCamera : Infinity;
  const bDistance = Number.isFinite(bt.distanceFromCamera) ? bt.distanceFromCamera : Infinity;
  if (aDistance !== bDistance) return aDistance > bDistance ? -1 : 1;

  const aDepth = a?.internal?.depthFromRenderedParent ?? 0;
  const bDepth = b?.internal?.depthFromRenderedParent ?? 0;
  if (aDepth !== bDepth) return aDepth > bDepth ? -1 : 1;
  return 0;
}

export function retainLodOverviewTiles(tilesRenderer, overviewTiles) {
  const cache = tilesRenderer?.lruCache;
  if (!cache || typeof cache.has !== 'function'
    || typeof tilesRenderer?.markTileUsed !== 'function'
    || !Array.isArray(overviewTiles)) return 0;

  let retained = 0;
  for (const tile of overviewTiles) {
    if (!tile || !cache.has(tile)) continue;
    tilesRenderer.markTileUsed(tile);
    retained += 1;
  }
  return retained;
}

function lodRecentFrontierOwner(tile) {
  if (tile?.__ltdsFallbackOwner) return tile.__ltdsFallbackOwner;
  let current = tile?.parent;
  for (let depth = 0; current && depth < 256; depth += 1) {
    if (Number.isFinite(Number(current.__ltdsFocalOwnerEpoch))) return current;
    current = current.parent;
  }
  return tile;
}

// A REPLACE cut is useful only when every tile in the cut remains available.
// Retain recent detail as whole historical fallback-owner groups, ranked by
// the current focal ray, instead of a tile FIFO that can preserve 14/15 leaves
// and force the renderer back to the coarse parent after a one-pixel motion.
export function selectLodRecentFrontier(entries, {
  now = 0,
  maxTiles = Infinity,
  maxBytes = Infinity,
  getBytes = () => 0,
  reservedTiles = null,
} = {}) {
  const tileLimit = Number.isFinite(Number(maxTiles))
    ? Math.max(0, Number(maxTiles))
    : Infinity;
  const byteLimit = Number.isFinite(Number(maxBytes))
    ? Math.max(0, Number(maxBytes))
    : Infinity;
  const groups = new Map();
  for (const entry of entries || []) {
    const [tile, expiresAt] = entry || [];
    // Regional/base fallback residency has already been subtracted from this
    // budget by the caller. Do not count historical proxy entries a second
    // time or let them make an otherwise complete fine cut appear oversized.
    if (!tile || reservedTiles?.has(tile) || Number(expiresAt) <= Number(now)) continue;
    const owner = lodRecentFrontierOwner(tile);
    let group = groups.get(owner);
    if (!group) {
      group = {
        owner,
        entries: [],
        bytes: 0,
        focusOverlap: Math.min(1, Math.max(0,
          Number(owner?.__ltdsFocusOverlap) || Number(tile?.__ltdsOwnerFocusOverlap) || 0)),
        distanceFromCamera: lodTileCameraDistance(owner),
      };
      groups.set(owner, group);
    }
    const bytes = Math.max(0, Number(getBytes(tile)) || 0);
    group.entries.push([tile, expiresAt]);
    group.bytes += bytes;
    group.focusOverlap = Math.max(
      group.focusOverlap,
      Math.min(1, Math.max(0,
        Number(tile?.__ltdsFocusOverlap)
          || Number(tile?.__ltdsOwnerFocusOverlap)
          || 0)),
    );
    group.distanceFromCamera = Math.min(
      group.distanceFromCamera,
      lodTileCameraDistance(tile),
    );
  }

  const ranked = Array.from(groups.values()).sort((a, b) => (
    Number(b.owner?.__ltdsFocalOwnerLocked === true)
      - Number(a.owner?.__ltdsFocalOwnerLocked === true)
    || b.focusOverlap - a.focusOverlap
    || a.distanceFromCamera - b.distanceFromCamera
  ));
  const selected = new Map();
  let selectedBytes = 0;
  for (const group of ranked) {
    // Never retain a partial replacement cut. If the whole group does not fit,
    // its already-pinned coarse owner remains the stable fallback.
    if (selected.size + group.entries.length > tileLimit
      || selectedBytes + group.bytes > byteLimit) continue;
    for (const [tile, expiresAt] of group.entries) selected.set(tile, expiresAt);
    selectedBytes += group.bytes;
  }
  return selected;
}

export function installLodOverviewRetention(tilesRenderer, overviewTilesProvider) {
  const cache = tilesRenderer?.lruCache;
  const original = cache?.scheduleUnload;
  if (!cache || typeof original !== 'function'
    || typeof overviewTilesProvider !== 'function') return () => false;

  let installed = true;
  const wrapped = function (...args) {
    const overviewTiles = overviewTilesProvider();
    retainLodOverviewTiles(tilesRenderer, overviewTiles);
    return original.apply(cache, args);
  };
  cache.scheduleUnload = wrapped;

  return () => {
    if (!installed) return false;
    installed = false;
    if (cache.scheduleUnload === wrapped) cache.scheduleUnload = original;
    return true;
  };
}

// Keep a bounded warm cache, but leave most of the budget available for the
// camera-selected frontier. The previous 3.25 GiB soft floor combined with
// loadAncestors pinned obsolete replacement paths and made an ordinary camera
// move look like unrecoverable memory pressure. This restores the cache shape
// from the known-good streaming implementation: recently viewed content stays
// warm, while stale off-view tiles can actually be evicted for the next view.
function hasResolvedLodMemoryProfile(profile) {
  return profile
    && Number.isFinite(Number(profile.cacheSoftBytes))
    && Number(profile.cacheSoftBytes) > 0
    && Number.isFinite(Number(profile.cacheHardBytes))
    && Number(profile.cacheHardBytes) >= Number(profile.cacheSoftBytes);
}

export function lodCacheBudget(deviceMemoryGiB, memoryProfile = null) {
  if (hasResolvedLodMemoryProfile(memoryProfile)) {
    const softBytes = Number(memoryProfile.cacheSoftBytes);
    const hardBytes = Number(memoryProfile.cacheHardBytes);
    const recentBytes = Math.max(0, Number(memoryProfile.recentFrontierBytes) || 0);
    const constrained = memoryProfile.policyKey === 'constrained';
    return {
      // The LRU's minimum is only a warm floor. Explicit overview and recent
      // frontier retention decide which tiles are protected.
      minBytesSize: Math.min(recentBytes, softBytes * 0.20),
      // `softBytesSize` is an LTDS scheduling threshold. The renderer's
      // `maxBytesSize` remains the absolute prospective-admission boundary.
      softBytesSize: softBytes,
      maxBytesSize: hardBytes,
      minSize: constrained ? 256 : 8,
      maxSize: constrained ? 512 : 1024,
      unloadPercent: 0.20,
    };
  }

  const memory = Number(deviceMemoryGiB);
  if (Number.isFinite(memory) && memory <= 4) {
    // Low-memory clients intentionally retain a coarse/fallback profile. The
    // measured full-detail frontier for the large Rome Dam fixture is over
    // 2.3 GiB, which is not safe to promise inside a 4 GiB browser process.
    return {
      minBytesSize: 640 * 1024 * 1024,
      maxBytesSize: 768 * 1024 * 1024,
      minSize: 256,
      maxSize: 512,
      unloadPercent: 0.20,
    };
  }

  return {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    // Retain at most 1.25 GiB of root/direct-child fallback while preserving
    // 1.75 GiB for the actively selected focal REPLACE frontier.
    maxBytesSize: 3 * 1024 * 1024 * 1024,
    minSize: 8,
    // Item count is not a memory budget. A valid camera-selected frontier can
    // contain dozens of fine leaves plus their branch parents while remaining
    // far below the byte ceiling. A 48-item cap wedged that frontier with idle
    // queues and unused byte headroom, so keep bytes as the real admission
    // guard and reserve the item cap only as a runaway-hierarchy failsafe.
    maxSize: 1024,
    unloadPercent: 0.20,
  };
}

export function lodCacheMaxBytesForOverview(currentMaxBytes, overviewBytes, reduced = false) {
  const current = Number(currentMaxBytes);
  if (!Number.isFinite(current) || current <= 0 || reduced) return currentMaxBytes;

  const overview = Number(overviewBytes);
  const GiB = 1024 * 1024 * 1024;
  if (!Number.isFinite(overview) || overview < 0.75 * GiB) return current;

  // The measured church overview is about 1.27 GiB. A 1.75 GiB hard cap
  // leaves too little room to complete a foreground REPLACE branch, so loaded
  // leaves stay hidden behind their parent. Add bounded, dataset-driven
  // headroom while keeping small and reduced-memory models on the normal cap.
  return Math.max(current, Math.min(3 * GiB, overview + 1.75 * GiB));
}

export function lodCacheRetentionMinBytes(budget, recoveryActive = false, cache = null) {
  const configured = Number(budget?.minBytesSize);
  const retainedFloor = Number.isFinite(configured) && configured >= 0 ? configured : 0;
  if (!recoveryActive) return retainedFloor;

  // 3d-tiles-renderer refuses to cross minBytesSize when the oldest unused
  // tile is larger than the remaining admission gap. Lower the floor only far
  // enough to release one recent LRU tile (or a bounded 20% reserve when cache
  // details are unavailable). This makes room for the selected foreground
  // branch without the old recovery behavior purging unused content toward 0.
  const maxBytesSize = Number(budget?.maxBytesSize);
  const cachedBytes = Number(cache?.cachedBytes);
  let largestUnusedBytes = 0;
  const itemSet = cache?.itemSet;
  const bytesMap = cache?.bytesMap;
  const usedSet = cache?.usedSet;
  if (itemSet && bytesMap && usedSet && typeof itemSet[Symbol.iterator] === 'function') {
    for (const [item] of itemSet) {
      if (usedSet.has(item)) continue;
      largestUnusedBytes = Math.max(largestUnusedBytes, Number(bytesMap.get(item)) || 0);
    }
  }

  const fallbackReserve = Number.isFinite(maxBytesSize) && maxBytesSize > 0
    ? Math.max(128 * 1024 * 1024, maxBytesSize * 0.20)
    : 128 * 1024 * 1024;
  const reserve = largestUnusedBytes > 0 ? largestUnusedBytes : fallbackReserve;
  const referenceBytes = Number.isFinite(maxBytesSize) && maxBytesSize > 0
    ? maxBytesSize
    : cachedBytes;
  const recoveryFloor = Number.isFinite(referenceBytes) && referenceBytes > 0
    ? Math.max(0, referenceBytes - reserve)
    : 0;
  return Math.min(retainedFloor, recoveryFloor);
}

export function recoverLodCacheAdmission(cache, budget, incomingBytes = 0, maxPasses = 8) {
  if (!cache || typeof cache?.unloadUnusedContent !== 'function') return false;
  const incoming = Math.max(0, Number(incomingBytes) || 0);
  const hardBytes = Number(budget?.maxBytesSize ?? cache.maxBytesSize);
  const maxItems = Number(budget?.maxSize ?? cache.maxSize);
  const prospectiveBytes = () => Math.max(0, Number(cache.cachedBytes) || 0) + incoming;
  const overBytes = () => Number.isFinite(hardBytes) && prospectiveBytes() > hardBytes;
  const overItems = () => Number.isFinite(maxItems)
    && Number(cache.itemSet?.size) >= maxItems;
  if (!overBytes() && !overItems() && !cache.isFull?.()) return false;
  const recoveryFloor = lodCacheRetentionMinBytes(budget, true, cache);
  const currentFloor = Number(cache.minBytesSize);
  if (!Number.isFinite(recoveryFloor) || recoveryFloor < 0) return false;
  if (!Number.isFinite(currentFloor) || recoveryFloor < currentFloor) {
    cache.minBytesSize = recoveryFloor;
  }
  // Run synchronously even when the existing floor is already low enough. A
  // single unloadPercent pass can leave less free space than the incoming
  // decoded tile needs, after which renderer 0.5.1 discards that foreground
  // parse. Iterate only while each pass makes progress; LRUCache itself never
  // removes used/pinned content.
  const boundedPasses = Math.min(16, Math.max(1, Number.parseInt(maxPasses, 10) || 8));
  for (let pass = 0; pass < boundedPasses; pass += 1) {
    const beforeBytes = Number(cache.cachedBytes) || 0;
    const beforeItems = Number(cache.itemSet?.size) || 0;
    cache.unloadUnusedContent();
    const afterBytes = Number(cache.cachedBytes) || 0;
    const afterItems = Number(cache.itemSet?.size) || 0;
    const fitsBytes = !Number.isFinite(hardBytes) || prospectiveBytes() <= hardBytes;
    const fitsItems = !Number.isFinite(maxItems) || afterItems < maxItems;
    if (fitsBytes && fitsItems && !cache.isFull?.()) break;
    if (afterBytes >= beforeBytes && afterItems >= beforeItems) break;
  }
  return true;
}

export function lodViewChangeRequiresRetry(previous, current, {
  translationFraction = 0.10,
  rotationRadians = Math.PI / 18,
  zoomLogRatio = Math.log(1.20),
} = {}) {
  const aPosition = previous?.position;
  const bPosition = current?.position;
  const aQuaternion = previous?.quaternion;
  const bQuaternion = current?.quaternion;
  if (!Array.isArray(aPosition) || aPosition.length !== 3
    || !Array.isArray(bPosition) || bPosition.length !== 3
    || !Array.isArray(aQuaternion) || aQuaternion.length !== 4
    || !Array.isArray(bQuaternion) || bQuaternion.length !== 4) return false;
  const numbers = [...aPosition, ...bPosition, ...aQuaternion, ...bQuaternion];
  if (!numbers.every(Number.isFinite)) return false;

  const translation = Math.hypot(
    bPosition[0] - aPosition[0],
    bPosition[1] - aPosition[1],
    bPosition[2] - aPosition[2],
  );
  const aDistance = Math.max(1e-6, Number(previous?.focusDistance) || 0);
  const bDistance = Math.max(1e-6, Number(current?.focusDistance) || 0);
  const translationScale = Math.max(1, aDistance, bDistance);
  const quaternionDot = Math.min(1, Math.abs(
    aQuaternion[0] * bQuaternion[0]
    + aQuaternion[1] * bQuaternion[1]
    + aQuaternion[2] * bQuaternion[2]
    + aQuaternion[3] * bQuaternion[3]
  ));
  const rotation = 2 * Math.acos(quaternionDot);
  const zoom = Math.abs(Math.log(bDistance / aDistance));
  return translation / translationScale >= translationFraction
    || rotation >= rotationRadians
    || zoom >= zoomLogRatio;
}

export function lodRuntimeProfile(requestedDetail, deviceMemoryGiB, memoryProfile = null) {
  const parsed = Number.parseInt(requestedDetail, 10);
  const requested = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : DEFAULT_LOD_DETAIL;
  const memory = Number(deviceMemoryGiB);
  const resolvedMemoryProfile = hasResolvedLodMemoryProfile(memoryProfile)
    ? memoryProfile
    : null;
  const reduced = resolvedMemoryProfile
    ? resolvedMemoryProfile.policyKey === 'constrained'
    : Number.isFinite(memory) && memory <= 4;
  const maximumDetail = reduced ? LOW_MEMORY_MAX_LOD_DETAIL : MAX_LOD_DETAIL;
  const cappedRequest = Math.min(requested, maximumDetail);
  const result = {
    budget: lodCacheBudget(deviceMemoryGiB, resolvedMemoryProfile),
    requestedDetail: requested,
    activeDetail: cappedRequest,
    maximumDetail,
    reduced,
  };
  // Preserve the legacy return shape for callers that have not opted into
  // the new policy module yet.
  if (resolvedMemoryProfile) result.memoryProfile = resolvedMemoryProfile;
  return result;
}

export function lodDetailRequestPending(profile) {
  const requested = Number.parseInt(profile?.requestedDetail, 10);
  const active = Number.parseInt(profile?.activeDetail, 10);
  const maximum = Number.parseInt(profile?.maximumDetail, 10);
  if (!Number.isFinite(requested) || !Number.isFinite(active)) return false;
  const cappedMaximum = Number.isFinite(maximum)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, maximum))
    : MAX_LOD_DETAIL;
  const effectiveRequest = Math.min(
    cappedMaximum,
    Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, requested)),
  );
  return active < effectiveRequest;
}

export function lodWarmupSatisfiedByDetail(activeDetail) {
  const parsed = Number.parseInt(activeDetail, 10);
  return Number.isFinite(parsed) && parsed >= LOD_WARMUP_DETAIL;
}

export function resolveLodDetailRequest(profile, warmupComplete, requestedDetail) {
  const parsed = Number.parseInt(requestedDetail, 10);
  const requested = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : MAX_LOD_DETAIL;
  const maximumDetail = Number.isFinite(Number(profile?.maximumDetail))
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, Number(profile.maximumDetail)))
    : MAX_LOD_DETAIL;
  const targetDetail = Math.min(requested, maximumDetail);
  return { requestedDetail: requested, activeDetail: targetDetail, warmupComplete: true };
}

export function resolveLodWarmupAdvance(profile) {
  if (profile?.reduced || !lodDetailRequestPending(profile)
    || !lodWarmupSatisfiedByDetail(profile?.activeDetail)) return null;
  const parsedRequested = Number.parseInt(profile?.requestedDetail, 10);
  const parsedActive = Number.parseInt(profile?.activeDetail, 10);
  const maximumDetail = Number.isFinite(Number(profile?.maximumDetail))
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, Number(profile.maximumDetail)))
    : MAX_LOD_DETAIL;
  const requestedDetail = Number.isFinite(parsedRequested)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedRequested))
    : MAX_LOD_DETAIL;
  const activeDetail = Math.min(maximumDetail, Math.max(MIN_LOD_DETAIL, parsedActive));
  return {
    requestedDetail,
    activeDetail: Math.min(requestedDetail, maximumDetail, activeDetail + LOD_REFINEMENT_STEP),
    warmupComplete: true,
  };
}

export function configureLodRenderer(tilesRenderer, {
  camera,
  renderer,
  detail = DEFAULT_LOD_DETAIL,
  deviceMemoryGiB,
  memoryProfile,
  interactionStateProvider,
} = {}) {
  tilesRenderer.setCamera(camera);
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  const resolvedMemoryProfile = memoryProfile
    ? (hasResolvedLodMemoryProfile(memoryProfile)
      ? memoryProfile
      : resolveLodMemoryProfile({ mode: memoryProfile, deviceMemoryGiB }))
    : null;
  const profile = lodRuntimeProfile(detail, deviceMemoryGiB, resolvedMemoryProfile);
  tilesRenderer.errorTarget = detailToErrorTarget(profile.activeDetail);
  tilesRenderer.__ltdsPeripheralPressureScale = 1;
  tilesRenderer.__ltdsFocusOwnerState = {
    owner: null,
    ownerView: null,
    ownerDistance: null,
    currentView: null,
  };
  // Let normal REPLACE traversal keep the currently displayed parent until its
  // selected children are ready, but do not pin every traversed ancestor in the
  // cache. Ancestor pinning made a small camera move retain the old frontier
  // while downloading the new one and exhausted even a multi-gigabyte budget.
  tilesRenderer.loadAncestors = false;
  tilesRenderer.loadSiblings = false;
  tilesRenderer.loadAncestorSiblings = false;
  tilesRenderer.maxDepth = Infinity;
  const focusPriorityCallback = createLodFocusPriorityCallback(interactionStateProvider);
  const focusPriorityPlugin = createLodFocusPriorityPlugin(camera, interactionStateProvider);
  tilesRenderer.registerPlugin?.(focusPriorityPlugin);
  if (tilesRenderer.downloadQueue) {
    tilesRenderer.downloadQueue.priorityCallback = focusPriorityCallback;
    const current = Number(tilesRenderer.downloadQueue.maxJobs);
    const limit = resolvedMemoryProfile?.downloadConcurrency ?? 6;
    tilesRenderer.downloadQueue.maxJobs = Number.isFinite(current) && current > 0 ? Math.min(current, limit) : limit;
  }
  if (tilesRenderer.parseQueue) {
    tilesRenderer.parseQueue.priorityCallback = focusPriorityCallback;
    const current = Number(tilesRenderer.parseQueue.maxJobs);
    const limit = resolvedMemoryProfile?.parseConcurrency ?? 2;
    tilesRenderer.parseQueue.maxJobs = Number.isFinite(current) && current > 0 ? Math.min(current, limit) : limit;
  }

  Object.assign(tilesRenderer.lruCache, profile.budget);
  return profile;
}

export function refreshLodResolution(tilesRenderer, camera, renderer) {
  if (!tilesRenderer) return false;
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  return true;
}

export function lodQueuesSettled(tilesRenderer) {
  return !tilesRenderer?.downloadQueue?.running
    && !tilesRenderer?.parseQueue?.running
    && !tilesRenderer?.processNodeQueue?.running;
}

export function detectLodStarvation(snapshot, consecutiveSamples = 0, threshold = 2) {
  const previousCount = Number.isInteger(consecutiveSamples) && consecutiveSamples > 0
    ? consecutiveSamples
    : 0;
  const parsedThreshold = Number.parseInt(threshold, 10);
  const requiredSamples = Number.isFinite(parsedThreshold) && parsedThreshold > 0
    ? parsedThreshold
    : 1;
  const queues = snapshot?.queues;
  const pendingRequiredTiles = snapshot?.pendingRequiredTiles ?? snapshot?.pendingRequiredLeaves;
  const blocked = snapshot?.cache?.full === true
    && Number(pendingRequiredTiles) > 0
    && queues?.download !== true
    && queues?.parse !== true
    && queues?.process !== true;
  const count = blocked ? previousCount + 1 : 0;
  return { count, starved: blocked && count >= requiredSamples };
}

export function resolveLodMemoryPressure(profile, starvedAtDetail = null, lastSettledDetail = null) {
  const parsedActiveDetail = Number.parseInt(profile?.activeDetail, 10);
  if (!Number.isFinite(parsedActiveDetail)) return null;
  const activeDetail = Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedActiveDetail));

  // `Number(null)` is zero, so an unset ceiling must be handled before any
  // numeric conversion. The lowest detail that has failed remains the ceiling
  // until an explicit user action clears it.
  const hasCeiling = starvedAtDetail !== null && starvedAtDetail !== undefined;
  const parsedCeiling = hasCeiling ? Number.parseInt(starvedAtDetail, 10) : null;
  const ceiling = Number.isFinite(parsedCeiling)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedCeiling))
    : activeDetail;
  const effectiveCeiling = Math.min(activeDetail, ceiling);
  const parsedSettled = Number.parseInt(lastSettledDetail, 10);
  const settledDetail = Number.isFinite(parsedSettled)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedSettled))
    : null;
  const stagedFallback = Math.max(MIN_LOD_DETAIL, effectiveCeiling - LOD_REFINEMENT_STEP);
  const nextActiveDetail = settledDetail !== null && settledDetail < effectiveCeiling
    ? settledDetail
    : stagedFallback;
  if (nextActiveDetail >= activeDetail) return null;

  return {
    ...profile,
    activeDetail: nextActiveDetail,
    starvedAtDetail: effectiveCeiling,
  };
}

export function advanceLodMemoryPressure(snapshot, profile, {
  consecutiveSamples = 0,
  clearSamples = 0,
  starvedAtDetail = null,
  lastSettledDetail = null,
} = {}) {
  const starvation = detectLodStarvation(
    snapshot,
    consecutiveSamples,
    LOD_ADMISSION_RECOVERY_SAMPLES,
  );
  if (!starvation.starved) {
    const currentScale = Math.min(
      LOD_MAX_PERIPHERAL_PRESSURE_SCALE,
      Math.max(1, Number(profile?.peripheralPressureScale) || 1),
    );
    const queues = snapshot?.queues;
    const settled = snapshot?.cache?.full !== true
      && Number(snapshot?.pendingRequiredTiles ?? snapshot?.pendingRequiredLeaves) === 0
      && queues?.download !== true
      && queues?.parse !== true
      && queues?.process !== true;
    const nextClearSamples = settled && currentScale > 1
      ? Math.max(0, Number.parseInt(clearSamples, 10) || 0) + 1
      : 0;
    const shouldRecover = currentScale > 1
      && nextClearSamples >= LOD_PRESSURE_FALLBACK_SAMPLES;
    const nextScale = shouldRecover ? Math.max(1, currentScale / 2) : currentScale;
    const changed = nextScale !== currentScale;
    return {
      changed,
      recoveryRequired: false,
      profile: changed ? { ...profile, peripheralPressureScale: nextScale } : profile,
      consecutiveSamples: starvation.count,
      clearSamples: changed ? 0 : nextClearSamples,
      starvedAtDetail: null,
    };
  }

  // First give stale, unpinned content a bounded synchronous eviction chance.
  // If the same idle/full state persists, relax only camera-peripheral
  // selection. Never lower the requested/global SSE or blur the locked focal
  // branch. Once the relaxed frontier settles, the scale automatically halves
  // back toward one so the full view can converge when there is headroom.
  const currentScale = Math.min(
    LOD_MAX_PERIPHERAL_PRESSURE_SCALE,
    Math.max(1, Number(profile?.peripheralPressureScale) || 1),
  );
  const nextScale = starvation.count >= LOD_PRESSURE_FALLBACK_SAMPLES
    ? Math.min(LOD_MAX_PERIPHERAL_PRESSURE_SCALE, currentScale * 2)
    : currentScale;
  const changed = nextScale !== currentScale;
  return {
    changed,
    recoveryRequired: true,
    profile: changed ? { ...profile, peripheralPressureScale: nextScale } : profile,
    consecutiveSamples: starvation.count,
    clearSamples: 0,
    starvedAtDetail: null,
  };
}

export function visibleLodTargetSatisfied(root, errorTarget) {
  const target = Number(errorTarget);
  if (!root || !Number.isFinite(target)) return false;
  let visibleCount = 0;
  let satisfied = true;
  const stack = [root];
  while (stack.length) {
    const tile = stack.pop();
    const children = Array.isArray(tile?.children) ? tile.children : [];
    if (tile?.traversal?.visible === true) {
      visibleCount += 1;
      const error = Number(tile.traversal.error);
      const terminalZeroErrorLeaf = children.length === 0 && tile?.geometricError === 0;
      if (!terminalZeroErrorLeaf && (!Number.isFinite(error) || error > target)) satisfied = false;
    }
    stack.push(...children);
  }
  return visibleCount > 0 && satisfied;
}

function contentUri(tile) {
  return tile?.content?.uri || tile?.content?.url || '';
}

function isExternalTileset(uri) {
  return /\.json(?:[?#].*)?$/i.test(uri);
}

export function inspectLodProvenance(provenance, fullMeshUrl, {
  serverVerified = false,
} = {}) {
  const errors = [];
  if (!provenance || typeof provenance !== 'object') {
    return { verified: false, errors: ['lod-provenance.json is required'] };
  }

  const exactV2 = provenance.schemaVersion === 2 && provenance.audit?.algorithm === 'ltds-glb-leaf-equivalence-v2';
  const controlledV3 = provenance.schemaVersion === 3 && provenance.audit?.algorithm === 'ltds-obj2tiles-surface-equivalence-v3';
  const controlledV4 = provenance.schemaVersion === 4 && provenance.audit?.algorithm === 'ltds-obj2tiles-surface-equivalence-v4';
  const controlled = controlledV3 || controlledV4;
  if (!exactV2 && !controlled) errors.push('recognized exact v2 or controlled Obj2Tiles v3/v4 audit evidence is required');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  const expectedGeometry = controlled ? 'controlled-bidirectional-surface-equivalence' : 'bounded-triangle-equivalence';
  const expectedTextures = controlled ? 'controlled-atlas-material-equivalence' : 'byte-identical-material-equivalence';
  if (provenance.geometry !== expectedGeometry) errors.push(`geometry must be ${expectedGeometry}`);
  if (provenance.textures !== expectedTextures) errors.push(`textures must be ${expectedTextures}`);
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');
  if (exactV2 && (!Number.isInteger(provenance.audit?.triangleCount) || provenance.audit.triangleCount < 1)) errors.push('audit triangleCount must be a positive integer');
  if (controlled && (!Number.isInteger(provenance.audit?.sourceTriangleCount) || provenance.audit.sourceTriangleCount < 1 || !Number.isInteger(provenance.audit?.leafTriangleCount) || provenance.audit.leafTriangleCount < 1)) errors.push('controlled audit triangle counts must be positive integers');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.audit?.equivalenceSha256 || ''))) {
    errors.push('audit equivalenceSha256 must be a SHA-256 digest');
  }
  if (exactV2) {
    const tolerance = provenance.audit?.coordinateTolerance;
    const maxDelta = provenance.audit?.maxNumericDelta;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e-3) errors.push('audit coordinateTolerance must be between 0 and 0.001');
    if (!Number.isFinite(maxDelta) || maxDelta < 0 || maxDelta > tolerance) errors.push('audit maxNumericDelta must not exceed coordinateTolerance');
  }
  if (controlled) {
    const serverAuthorizedContract = serverVerified === true;
    if (provenance.converter?.name !== 'OpenDroneMap/Obj2Tiles'
      || provenance.converter?.version !== '1.6.2'
      || (!serverAuthorizedContract
        && (!CONTROLLED_CONVERTER_COMMAND_SHA256.has(String(provenance.converter?.commandSha256||'').toLowerCase())
          || !CONTROLLED_CONVERTER_BINARY_SHA256.has(String(provenance.converter?.binarySha256||'').toLowerCase())))) errors.push('controlled audit converter contract is invalid');
    if (!Number.isFinite(provenance.audit?.surfaceTolerance) || provenance.audit.surfaceTolerance <= 0 || !Number.isFinite(provenance.audit?.maximumSurfaceDistance) || provenance.audit.maximumSurfaceDistance < 0 || provenance.audit.maximumSurfaceDistance > provenance.audit.surfaceTolerance || !Number.isFinite(provenance.audit?.minimumNormalDot) || !Number.isFinite(provenance.audit?.maximumReversedNormalFraction) || provenance.audit.maximumReversedNormalFraction < 0 || provenance.audit.maximumReversedNormalFraction > 0.01) errors.push('controlled audit surface evidence is invalid');
    if (controlledV4 && (provenance.audit?.policyRevision !== 'ltds-controlled-surface-policy-v4'
      || !['normal', 'gray-zone'].includes(provenance.audit?.acceptance)
      || !Number.isFinite(provenance.audit?.areaRelativeDelta)
      || provenance.audit.areaRelativeDelta < 0
      || provenance.audit.areaRelativeDelta > 1.2e-5
      || (provenance.audit.acceptance === 'normal' && provenance.audit.areaRelativeDelta > 1e-5)
      || (provenance.audit.acceptance === 'gray-zone' && provenance.audit.areaRelativeDelta <= 1e-5))) errors.push('controlled v4 audit policy summary is invalid');
  }
  if (!Number.isInteger(provenance.audit?.artifactCount) || provenance.audit.artifactCount < 2) {
    errors.push('audit artifactCount must bind the tileset and leaf artifacts');
  }

  let expectedSource = '';
  try {
    expectedSource = decodeURIComponent(new URL(fullMeshUrl, 'https://viewer.invalid').pathname.split('/').pop() || '');
  } catch {
    expectedSource = '';
  }
  if (!expectedSource || provenance.sourceAsset !== expectedSource) {
    errors.push('sourceAsset must name the active full-resolution mesh');
  }
  if (!/\.glb$/i.test(String(provenance.sourceAsset || ''))) {
    errors.push('audited sourceAsset must be a GLB');
  }

  return { verified: errors.length === 0, errors };
}

export function decideLodStartup(tilesetReport, provenanceReport, hasFullMesh) {
  if (!tilesetReport?.valid) {
    return {
      action: hasFullMesh ? 'fallback-full-mesh' : 'disable-lod',
      reason: `LOD manifest cannot reach a valid full-detail frontier: ${tilesetReport?.errors?.[0] || 'invalid manifest'}`,
    };
  }
  if (!provenanceReport?.verified) {
    return {
      action: hasFullMesh ? 'fallback-full-mesh' : 'disable-lod',
      reason: `LOD full-resolution provenance is not verified: ${provenanceReport?.errors?.[0] || 'missing provenance'}`,
    };
  }
  return { action: 'stream-lod', reason: null };
}

// This verifies that selection can reach a zero-geometric-error REPLACE
// frontier. It cannot prove that an external converter preserved the source
// mesh's triangles and textures; that requires derivative provenance.
export function inspectLodTileset(tileset) {
  const errors = [];
  const warnings = [];
  let nodeCount = 0;
  let terminalLeafCount = 0;
  let externalTilesetCount = 0;
  let maxDepth = 0;

  if (!tileset || !tileset.root || typeof tileset.root !== 'object') {
    return {
      valid: false,
      canConvergeToZeroError: false,
      nodeCount,
      terminalLeafCount,
      externalTilesetCount,
      maxDepth,
      errors: ['tileset.root is required'],
      warnings,
    };
  }

  function walk(tile, parentError, inheritedRefine, depth, path) {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);

    const error = tile.geometricError;
    if (typeof error !== 'number' || !Number.isFinite(error) || error < 0) {
      errors.push(`${path}.geometricError must be a finite non-negative number`);
    } else if (Number.isFinite(parentError) && error > parentError) {
      errors.push(`${path}.geometricError must not exceed its parent's error`);
    }

    const refine = String(tile.refine || inheritedRefine || 'ADD').toUpperCase();
    const children = Array.isArray(tile.children) ? tile.children : [];
    const uri = contentUri(tile);
    const external = Boolean(uri) && isExternalTileset(uri);

    if (children.length > 0 && refine !== 'REPLACE') {
      errors.push(`${path} must use REPLACE refinement for full-resolution substitution`);
    }
    // A zero-error internal node already satisfies every possible screen-space
    // error target, so a conforming renderer has no reason to select its
    // children. Calling such a hierarchy convergent would be false even when
    // those unreachable terminal children themselves declare zero error.
    if (children.length > 0 && error === 0) {
      errors.push(`${path}.geometricError must be greater than zero while the tile has children`);
    }

    if (external) {
      externalTilesetCount += 1;
      warnings.push(`${path} references an external tileset; validate that manifest separately`);
    }

    if (children.length === 0 && !external) {
      terminalLeafCount += 1;
      if (!uri) errors.push(`${path} is a terminal leaf without renderable content`);
      if (typeof error === 'number' && Number.isFinite(error) && error !== 0) {
        errors.push(`${path} is terminal but declares non-zero geometricError (${error})`);
      }
    }

    children.forEach((child, index) => {
      walk(child, error, refine, depth + 1, `${path}.children[${index}]`);
    });
  }

  walk(tileset.root, Infinity, null, 0, 'root');
  const canConvergeToZeroError = errors.length === 0 && terminalLeafCount > 0 && externalTilesetCount === 0;
  return {
    valid: errors.length === 0,
    canConvergeToZeroError,
    nodeCount,
    terminalLeafCount,
    externalTilesetCount,
    maxDepth,
    errors,
    warnings,
  };
}

export function lodDebugSnapshot(tilesRenderer, runtimeProfile, warmupComplete) {
  const root = tilesRenderer?.root;
  const attachedScenes = tilesRenderer?.group?.children || [];
  const visible = { root: 0, lod0: 0, lod1: 0, other: 0 };
  const visibleDepths = {};
  let requiredLeaves = 0;
  let attachedRequiredLeaves = 0;
  let pendingRequiredLeaves = 0;
  let requiredTiles = 0;
  let attachedRequiredTiles = 0;
  let pendingRequiredTiles = 0;
  let attachedVisibleTiles = 0;
  let positiveErrorFallbackTiles = 0;
  let pendingHierarchyNodes = 0;
  const safeLabel = (tile) => {
    const raw = String(contentUri(tile) || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
    const match = raw.match(/(?:^|\/)(LOD-\d+\/[A-Za-z0-9._-]+\.b3dm)$/i);
    return match ? match[1] : 'tile';
  };
  const visit = (tile) => {
    if (!tile) return;
    const children = Array.isArray(tile.children) ? tile.children : [];
    for (const child of children) visit(child);
    const label = safeLabel(tile);
    if (tile?.traversal?.visible === true) {
      const depth = String(Number(tile?.internal?.depth) || 0);
      visibleDepths[depth] = (visibleDepths[depth] || 0) + 1;
      if (tile === root) visible.root += 1;
      else if (/^LOD-0\//i.test(label)) visible.lod0 += 1;
      else if (/^LOD-1\//i.test(label)) visible.lod1 += 1;
      else visible.other += 1;
      if (tile?.engineData?.scene && attachedScenes.includes?.(tile.engineData.scene)) attachedVisibleTiles += 1;
      if (Number.isFinite(Number(tile?.geometricError)) && Number(tile.geometricError) > 0) {
        positiveErrorFallbackTiles += 1;
      }
    }
    if (tile?.traversal?.used === true && tile?.traversal?.inFrustum === true
      && children.some(child => !child?.traversal)) pendingHierarchyNodes += 1;
    const isRequiredTile = tile?.traversal?.used === true
      && tile?.traversal?.inFrustum === true
      && tile?.traversal?.isLeaf === true
      && Boolean(contentUri(tile))
      && tile?.internal?.hasUnrenderableContent !== true;
    const attached = Boolean(tile?.engineData?.scene && attachedScenes.includes?.(tile.engineData.scene));
    if (isRequiredTile) {
      requiredTiles += 1;
      if (attached) attachedRequiredTiles += 1;
      else pendingRequiredTiles += 1;
    }
    if (children.length || Number(tile.geometricError) !== 0
      || tile?.traversal?.used !== true || tile?.traversal?.inFrustum !== true) return;
    requiredLeaves += 1;
    if (attached) attachedRequiredLeaves += 1;
    else pendingRequiredLeaves += 1;
  };
  visit(root);

  const toMiB = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) / (1024 * 1024)) : null;
  const cache = tilesRenderer?.lruCache;
  const cachedBytes = Number(cache?.cachedBytes);
  const softBytesSize = Number(runtimeProfile?.budget?.softBytesSize);
  const maxBytesSize = Number(cache?.maxBytesSize);
  const maxSize = Number(cache?.maxSize);
  const itemSet = cache?.itemSet;
  const itemCount = Number(itemSet?.size);
  const pendingAdmissionBytes = Math.max(0, Number(runtimeProfile?.pendingAdmissionBytes) || 0);
  const prospectiveFull = runtimeProfile?.prospectiveAdmissionBlocked === true
    && pendingAdmissionBytes > 0;

  const peripheralPressureScale = Math.max(1, Number(runtimeProfile?.peripheralPressureScale) || 1);
  const memoryLimited = peripheralPressureScale > 1
    || (runtimeProfile?.starvedAtDetail !== null
      && runtimeProfile?.starvedAtDetail !== undefined
      && Number(runtimeProfile?.activeDetail) < Number(runtimeProfile?.requestedDetail));
  const bootstrapPhase = runtimeProfile?.bootstrapPhase;
  const detailPending = lodDetailRequestPending(runtimeProfile);
  return {
    phase: bootstrapPhase === 'root'
      ? 'overview'
      : bootstrapPhase === 'prefetch'
        ? 'prefetch'
        : bootstrapPhase === 'root-only'
          ? 'root-only'
        : memoryLimited
      ? 'memory-limited'
      : runtimeProfile?.reduced ? 'reduced-memory' : detailPending ? 'warmup' : 'requested-detail',
    requestedDetail: Number(runtimeProfile?.requestedDetail) || null,
    activeDetail: Number(runtimeProfile?.activeDetail) || null,
    maximumDetail: Number(runtimeProfile?.maximumDetail) || null,
    errorTarget: Number.isFinite(Number(tilesRenderer?.errorTarget)) ? Number(tilesRenderer.errorTarget) : null,
    rawErrorTarget: detailToErrorTarget(runtimeProfile?.activeDetail),
    peripheralPressureScale,
    prefetch: {
      elapsedMs: Number.isFinite(Number(runtimeProfile?.prefetchElapsedMs)) ? Number(runtimeProfile.prefetchElapsedMs) : null,
      exitReason: runtimeProfile?.prefetchExitReason || null,
      fallbackTiles: Number(runtimeProfile?.fallbackTileCount) || 0,
      fallbackMiB: toMiB(runtimeProfile?.fallbackBytes),
      shellMiB: toMiB(runtimeProfile?.prefetchShellBytes),
      overSoftBudget: runtimeProfile?.shellOverSoftBudget === true,
      shellSoftLimitMiB: toMiB(runtimeProfile?.fallbackSoftBudgetBytes),
      shellLimitMiB: toMiB(runtimeProfile?.fallbackBudgetBytes),
      detailReserveMiB: toMiB(runtimeProfile?.fallbackDetailReserveBytes),
    },
    focusPriority: runtimeProfile?.focusPriority || null,
    visible,
    visibleDepths,
    requiredLeaves,
    attachedRequiredLeaves,
    pendingRequiredLeaves,
    requiredTiles,
    attachedRequiredTiles,
    pendingRequiredTiles,
    attachedVisibleTiles,
    positiveErrorFallbackTiles,
    pendingHierarchyNodes,
    queues: {
      download: Boolean(tilesRenderer?.downloadQueue?.running),
      parse: Boolean(tilesRenderer?.parseQueue?.running),
      process: Boolean(tilesRenderer?.processNodeQueue?.running),
    },
    queueCounts: {
      download: {
        queued: Number(tilesRenderer?.downloadQueue?.items?.length) || 0,
        running: Number(tilesRenderer?.downloadQueue?.currJobs) || 0,
      },
      parse: {
        queued: Number(tilesRenderer?.parseQueue?.items?.length) || 0,
        running: Number(tilesRenderer?.parseQueue?.currJobs) || 0,
      },
      process: {
        queued: Number(tilesRenderer?.processNodeQueue?.items?.length) || 0,
        running: Number(tilesRenderer?.processNodeQueue?.currJobs) || 0,
      },
    },
    cache: {
      usedMiB: toMiB(cachedBytes),
      softMiB: toMiB(softBytesSize),
      maxMiB: toMiB(maxBytesSize),
      full: Boolean(cache?.isFull?.()) || prospectiveFull,
      fullByBytes: Number.isFinite(cachedBytes) && Number.isFinite(maxBytesSize) && cachedBytes >= maxBytesSize,
      fullByItems: Number.isFinite(itemCount) && Number.isFinite(maxSize) && itemCount >= maxSize,
      prospectiveFull,
      pendingAdmissionMiB: toMiB(pendingAdmissionBytes),
    },
  };
}

export function classifyLodQuality({
  bootstrapPhase,
  runtimeProfile,
  snapshot,
  frontier,
  queuesSettled = false,
  targetSatisfied = false,
  stableFrames = 0,
} = {}) {
  const requestedDetail = Number(runtimeProfile?.requestedDetail);
  const activeDetail = Number(runtimeProfile?.activeDetail);
  const queueCounts = snapshot?.queueCounts || {};
  const queuedWork = ['download', 'parse', 'process'].some((name) => (
    (Number(queueCounts?.[name]?.queued) || 0) > 0
    || (Number(queueCounts?.[name]?.running) || 0) > 0
  ));
  const reasons = [];
  if (bootstrapPhase !== 'complete') reasons.push('bootstrap');
  if (!Number.isFinite(requestedDetail) || !Number.isFinite(activeDetail) || activeDetail < requestedDetail) reasons.push('detail-pending');
  if ((Number(snapshot?.pendingRequiredTiles) || 0) > 0) reasons.push('required-content-pending');
  if ((Number(snapshot?.requiredTiles) || 0) === 0) reasons.push('no-required-content');
  if ((Number(snapshot?.attachedRequiredTiles) || 0) !== (Number(snapshot?.requiredTiles) || 0)) {
    reasons.push('required-content-detached');
  }
  if ((Number(snapshot?.pendingHierarchyNodes) || 0) > 0) reasons.push('hierarchy-pending');
  if ((Number(snapshot?.positiveErrorFallbackTiles) || 0) > 0) reasons.push('fallback-visible');
  if ((Number(snapshot?.attachedVisibleTiles) || 0) !== (Number(frontier?.visibleCount) || 0)) {
    reasons.push('visible-content-detached');
  }
  if (!queuesSettled || queuedWork) reasons.push('queues-active');
  if (!targetSatisfied) reasons.push('target-unsatisfied');
  if (!frontier?.fullDetail) reasons.push('frontier-coarse');
  if ((Number(stableFrames) || 0) < LOD_QUALITY_STABLE_FRAMES) reasons.push('not-stable');
  return { fullDetail: reasons.length === 0, reasons };
}

export function visibleLodFrontier(root) {
  const visible = [];
  if (!root) return { visibleCount: 0, fullDetail: false, maximumGeometricError: null };

  const stack = [root];
  while (stack.length) {
    const tile = stack.pop();
    if (tile?.traversal?.visible) visible.push(tile);
    if (Array.isArray(tile?.children)) stack.push(...tile.children);
  }

  // A runtime-only ADD root is a coarse backdrop, not part of the currently
  // selected REPLACE frontier. Count it by itself when it is all that is
  // visible, but ignore it whenever a more detailed descendant is rendering.
  const hasBackdropRoot = String(root.refine || '').toUpperCase() === 'ADD';
  const visibleDescendants = hasBackdropRoot ? visible.filter((tile) => tile !== root) : [];
  const frontier = visibleDescendants.length ? visibleDescendants : visible;

  let maximumGeometricError = 0;
  for (const tile of frontier) {
    const error = tile.geometricError;
    if (typeof error !== 'number' || !Number.isFinite(error)) return {
      visibleCount: frontier.length,
      fullDetail: false,
      maximumGeometricError: null,
    };
    maximumGeometricError = Math.max(maximumGeometricError, error);
  }

  return {
    visibleCount: frontier.length,
    fullDetail: frontier.length > 0 && maximumGeometricError === 0,
    maximumGeometricError: frontier.length ? maximumGeometricError : null,
  };
}
