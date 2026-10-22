import fs from 'node:fs';
import path from 'node:path';
import { patchLodLoadingBudget } from './lib/patch-lod-loading-budget.mjs';
import { patchLodMaterialArrays } from './lib/patch-lod-material-arrays.mjs';

const root = path.resolve(import.meta.dirname, '..');
const packageRoot = path.join(root, 'node_modules', '3d-tiles-renderer');
const metadataPath = path.join(packageRoot, 'package.json');
const expectedVersion = '0.5.1';

if (!fs.existsSync(metadataPath)) {
  throw new Error('3d-tiles-renderer is not installed; cannot apply the LTDS traversal patch');
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
if (metadata.version !== expectedVersion) {
  throw new Error(`LTDS traversal patch requires 3d-tiles-renderer ${expectedVersion}; found ${metadata.version}`);
}

function patchExact(file, upstream, patched, label) {
  const source = fs.readFileSync(file, 'utf8');
  const upstreamOccurrences = source.split(upstream).length - 1;
  const patchedOccurrences = source.split(patched).length - 1;
  if (patchedOccurrences === 1 && upstreamOccurrences === 0) return false;
  if (upstreamOccurrences !== 1 || patchedOccurrences !== 0) {
    throw new Error(`${label}: expected upstream=1/patched=0 or upstream=0/patched=1; found upstream=${upstreamOccurrences}/patched=${patchedOccurrences}`);
  }
  const result = source.replace(upstream, patched);
  if ((result.split(upstream).length - 1) !== 0 || (result.split(patched).length - 1) !== 1) {
    throw new Error(`${label}: replacement did not produce one exact patched block`);
  }
  fs.writeFileSync(file, result);
  return true;
}

function restoreExact(file, desired, legacy, label) {
  const source = fs.readFileSync(file, 'utf8');
  const desiredOccurrences = source.split(desired).length - 1;
  const legacyOccurrences = source.split(legacy).length - 1;
  if (desiredOccurrences === 1 && legacyOccurrences === 0) return false;
  if (desiredOccurrences !== 0 || legacyOccurrences !== 1) {
    throw new Error(`${label}: expected desired=1/legacy=0 or desired=0/legacy=1; found desired=${desiredOccurrences}/legacy=${legacyOccurrences}`);
  }
  const result = source.replace(legacy, desired);
  if ((result.split(desired).length - 1) !== 1 || (result.split(legacy).length - 1) !== 0) {
    throw new Error(`${label}: restoration did not produce one exact desired block`);
  }
  fs.writeFileSync(file, result);
  return true;
}

const sourceFile = path.join(packageRoot, 'src', 'core', 'renderer', 'tiles', 'traverseFunctions.js');
// A failed download is terminal for scheduling, but is never a renderable
// replacement. Keep the resident REPLACE fallback until real content is ready.
patchExact(
  sourceFile,
  'return ! canUnconditionallyRefine( tile ) && ( ! tile.internal.hasContent || isDownloadFinished( tile.internal.loadingState ) );',
  'return ! canUnconditionallyRefine( tile ) && ( ! tile.internal.hasContent || tile.internal.loadingState === LOADED );',
  '3d-tiles-renderer source failed replacement readiness',
);
patchExact(
  sourceFile,
  '( renderer.loadSiblings || renderer.loadAncestors )',
  '( renderer.loadSiblings || ( renderer.loadAncestors && renderer.loadAncestorSiblings !== false ) )',
  '3d-tiles-renderer source',
);

restoreExact(
  sourceFile,
  `\t\tif ( renderer.loadAncestors && tile.internal.hasContent ) {

\t\t\trenderer.markTileUsed( tile );
\t\t\trenderer.queueTileForDownload( tile );

\t\t}`,
  `\t\tif ( renderer.loadAncestors && tile.internal.hasContent && ! isDownloadFinished( tile.internal.loadingState ) ) {

\t\t\trenderer.markTileUsed( tile );
\t\t\trenderer.queueTileForDownload( tile );

\t\t}`,
  '3d-tiles-renderer source loaded replacement retention',
);

patchExact(
  sourceFile,
  `\t\t\t\tconst childCanDisplay = ! canUnconditionallyRefine( c );
\t\t\t\tconst childContentReady = ! c.internal.hasContent || isDownloadFinished( c.internal.loadingState );
\t\t\t\tconst childIsReady = ( childCanDisplay && childContentReady ) || c.traversal.allChildrenLoaded;`,
  `\t\t\t\tconst childIsReady = c.internal.hasRenderableContent
\t\t\t\t\t? c.internal.loadingState === LOADED
\t\t\t\t\t: c.traversal.allChildrenLoaded;`,
  '3d-tiles-renderer source branch-local readiness',
);

patchExact(
  sourceFile,
  `\tif ( tile.refine === 'REPLACE' && ! allChildrenReady && tile.traversal.wasSetActive && isChildReady( tile ) ) {`,
  `\tif ( tile.refine === 'REPLACE' && ! allChildrenReady && ( tile.traversal.wasSetActive || renderer.lodFallbackTiles?.has( tile ) ) && isChildReady( tile ) ) {`,
  '3d-tiles-renderer source scoped overview fallback',
);

patchExact(
  sourceFile,
  `\tif ( tile.traversal.error <= renderer.errorTarget && ! canUnconditionallyRefine( tile ) ) {`,
  `\tconst tileErrorTarget = Number.isFinite( tile.__ltdsPeripheralErrorTarget )
\t\t? Math.max( renderer.errorTarget, tile.__ltdsPeripheralErrorTarget )
\t\t: renderer.errorTarget;
\tif ( tile.traversal.error <= tileErrorTarget && ! canUnconditionallyRefine( tile ) ) {`,
  '3d-tiles-renderer source per-tile foveated traversal target',
);

const rendererSourceFile = path.join(packageRoot, 'src', 'core', 'renderer', 'tiles', 'TilesRendererBase.js');
// A bounded optional regional cover is acquired before exposing its first fine
// cut. Stop only at its loaded REPLACE owner; the coordinator explicitly loads
// the cover and clears this flag on completion, refusal, timeout, or disposal.
patchExact(
  sourceFile,
  `function canTraverse( tile, renderer ) {\n\n\t// If we've met`,
  `function canTraverse( tile, renderer ) {\n\n\tif ( tile.__ltdsRegionalCoverPreparing === true && tile.refine === 'REPLACE' && tile.internal.loadingState === LOADED ) return false;\n\n\t// If we've met`,
  '3d-tiles-renderer source bounded regional preparation',
);
// A re-requested tile can carry its last decoded estimate before the new parse
// starts. LRUCache.add checks only current residency, so registering that known
// allocation immediately afterward can cross maxBytesSize by one complete tile.
// Guard the reservation before the item enters the cache and give the
// application one exact, synchronous eviction opportunity.
patchExact(
  rendererSourceFile,
  `\t\tconst extension = getUrlExtension( url );

\t\t// track an abort controller and pass-through the below conditions if aborted`,
  `\t\tconst extension = getUrlExtension( url );
\t\tconst queuedBytesUsed = this.getBytesUsed( tile );
\t\tif ( queuedBytesUsed > 0 && lruCache.cachedBytes + queuedBytesUsed > lruCache.maxBytesSize ) {

\t\t\tthis.dispatchEvent( { type: 'tile-memory-pressure', tile, bytesUsed: queuedBytesUsed } );
\t\t\tif ( lruCache.cachedBytes + queuedBytesUsed > lruCache.maxBytesSize ) {

\t\t\t\treturn;

\t\t\t}

\t\t}

\t\t// track an abort controller and pass-through the below conditions if aborted`,
  '3d-tiles-renderer source queued byte admission and recovery',
);
patchExact(
  rendererSourceFile,
  `\t\tlruCache.setMemoryUsage( tile, this.getBytesUsed( tile ) );
\t\tthis.cachedSinceLoadComplete.add( tile );`,
  `\t\tlruCache.setMemoryUsage( tile, queuedBytesUsed );
\t\tthis.cachedSinceLoadComplete.add( tile );`,
  '3d-tiles-renderer source queued byte reservation',
);

// The decoded estimate may grow from a prior nonzero reservation. Compare only
// the positive incremental allocation with remaining headroom; checking for an
// exact zero misses estimate growth, while adding the full total double-counts
// bytes already reserved. Dispatch the delta so recovery frees exactly enough.
patchOneOf(
  rendererSourceFile,
  [
    `\t\t\t\tif ( lruCache.getMemoryUsage( tile ) === 0 && bytesUsed > 0 && lruCache.isFull() ) {

\t\t\t\t\t// And if the cache is full due to newly loaded memory then lets discard this tile - it will
\t\t\t\t\t// be loaded again later from the disk cache if needed.
\t\t\t\t\tlruCache.remove( tile );
\t\t\t\t\treturn;

\t\t\t\t}`,
    `\t\t\t\tif ( lruCache.getMemoryUsage( tile ) === 0 && bytesUsed > 0
\t\t\t\t\t&& lruCache.cachedBytes + bytesUsed > lruCache.maxBytesSize ) {

\t\t\t\t\t// Give applications one synchronous chance to evict enough stale content
\t\t\t\t\t// for the complete decoded allocation before discarding foreground work.
\t\t\t\t\tthis.dispatchEvent( { type: 'tile-memory-pressure', tile, bytesUsed } );
\t\t\t\t\tif ( lruCache.cachedBytes + bytesUsed > lruCache.maxBytesSize ) {

\t\t\t\t\t\tlruCache.remove( tile );
\t\t\t\t\t\treturn;

\t\t\t\t\t}

\t\t\t\t}`,
  ],
  `\t\t\t\tconst previousBytesUsed = lruCache.getMemoryUsage( tile );
\t\t\t\tconst additionalBytesUsed = Math.max( 0, bytesUsed - previousBytesUsed );
\t\t\t\tif ( additionalBytesUsed > 0
\t\t\t\t\t&& lruCache.cachedBytes + additionalBytesUsed > lruCache.maxBytesSize ) {

\t\t\t\t\t// Give applications one synchronous chance to evict enough stale content
\t\t\t\t\t// for only the unreserved decoded allocation before discarding foreground work.
\t\t\t\t\tthis.dispatchEvent( { type: 'tile-memory-pressure', tile, bytesUsed: additionalBytesUsed } );
\t\t\t\t\tif ( lruCache.cachedBytes + additionalBytesUsed > lruCache.maxBytesSize ) {

\t\t\t\t\t\tlruCache.remove( tile );
\t\t\t\t\t\treturn;

\t\t\t\t\t}

\t\t\t\t}`,
  '3d-tiles-renderer source decoded byte delta admission and recovery',
);

const buildDirectory = path.join(packageRoot, 'build');
const chunks = fs.readdirSync(buildDirectory)
  .filter((name) => /^renderer-[A-Za-z0-9_-]+\.js$/.test(name));
let matchingChunks = 0;
let ancestorRetentionChunks = 0;
let branchLocalReadinessChunks = 0;
let scopedOverviewFallbackChunks = 0;
let queuedAdmissionGuardChunks = 0;
let queuedAdmissionReservationChunks = 0;
let prospectiveAdmissionChunks = 0;
let foveatedTraversalChunks = 0;
let failedReplacementReadinessChunks = 0;
for (const name of chunks) {
  const file = path.join(buildDirectory, name);
  let source = fs.readFileSync(file, 'utf8');
  const originalSource = source;
  const failedReadinessUpstream = /return !([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\) && \(!\2\.internal\.hasContent \|\| ([A-Za-z_$][\w$]*)\(\2\.internal\.loadingState\)\);/g;
  const failedReadinessPatched = /return !([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\) && \(!\2\.internal\.hasContent \|\| \2\.internal\.loadingState === 4\);/g;
  const failedUpstreamMatches = [...source.matchAll(failedReadinessUpstream)];
  const failedPatchedMatches = [...source.matchAll(failedReadinessPatched)];
  if (failedPatchedMatches.length === 1 && failedUpstreamMatches.length === 0) {
    failedReplacementReadinessChunks += 1;
  } else if (failedUpstreamMatches.length === 1 && failedPatchedMatches.length === 0) {
    const [match, refineFunction, tileVariable] = failedUpstreamMatches[0];
    source = source.replace(match, `return !${refineFunction}(${tileVariable}) && (!${tileVariable}.internal.hasContent || ${tileVariable}.internal.loadingState === 4);`);
    failedReplacementReadinessChunks += 1;
  } else if (failedUpstreamMatches.length || failedPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built failed replacement readiness block`);
  }
  const upstream = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \1\.loadAncestors\)/g;
  const patched = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \(\1\.loadAncestors && \1\.loadAncestorSiblings !== false\)\)/g;
  const upstreamMatches = [...source.matchAll(upstream)];
  const patchedMatches = [...source.matchAll(patched)];
  if (patchedMatches.length === 1 && upstreamMatches.length === 0) {
    matchingChunks += 1;
  } else if (upstreamMatches.length !== 1 || patchedMatches.length !== 0) {
    if (upstreamMatches.length || patchedMatches.length) {
      throw new Error(`${name}: ambiguous ancestor/sibling traversal condition`);
    }
  } else {
    const variable = upstreamMatches[0][1];
    source = source.replace(
      upstream,
      `(${variable}.loadSiblings || (${variable}.loadAncestors && ${variable}.loadAncestorSiblings !== false))`,
    );
    matchingChunks += 1;
  }

  const ancestorUpstream = /([A-Za-z_$][\w$]*)\.loadAncestors && ([A-Za-z_$][\w$]*)\.internal\.hasContent && \(\1\.markTileUsed\(\2\), \1\.queueTileForDownload\(\2\)\)/g;
  const ancestorPatched = /([A-Za-z_$][\w$]*)\.loadAncestors && ([A-Za-z_$][\w$]*)\.internal\.hasContent && ![A-Za-z_$][\w$]*\(\2\.internal\.loadingState\) && \(\1\.markTileUsed\(\2\), \1\.queueTileForDownload\(\2\)\)/g;
  const ancestorUpstreamMatches = [...source.matchAll(ancestorUpstream)];
  const ancestorPatchedMatches = [...source.matchAll(ancestorPatched)];
  if (ancestorUpstreamMatches.length === 1 && ancestorPatchedMatches.length === 0) {
    ancestorRetentionChunks += 1;
  } else if (ancestorPatchedMatches.length === 1 && ancestorUpstreamMatches.length === 0) {
    const [match, rendererVariable, tileVariable] = ancestorPatchedMatches[0];
    source = source.replace(match,
      `${rendererVariable}.loadAncestors && ${tileVariable}.internal.hasContent && (${rendererVariable}.markTileUsed(${tileVariable}), ${rendererVariable}.queueTileForDownload(${tileVariable}))`);
    ancestorRetentionChunks += 1;
  } else if (ancestorUpstreamMatches.length || ancestorPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built ancestor-retention block`);
  }

  const readinessUpstream = /let ([A-Za-z_$][\w$]*) = !([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\), ([A-Za-z_$][\w$]*) = !\3\.internal\.hasContent \|\| ([A-Za-z_$][\w$]*)\(\3\.internal\.loadingState\);\s*\1 && \4 \|\| \3\.traversal\.allChildrenLoaded \|\| \(([A-Za-z_$][\w$]*) = !1\);/g;
  const readinessPatched = /let ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\.internal\.hasRenderableContent \? \2\.internal\.loadingState === 4 : \2\.traversal\.allChildrenLoaded;\s*\1 \|\| \(([A-Za-z_$][\w$]*) = !1\);/g;
  const readinessUpstreamMatches = [...source.matchAll(readinessUpstream)];
  const readinessPatchedMatches = [...source.matchAll(readinessPatched)];
  if (readinessPatchedMatches.length === 1 && readinessUpstreamMatches.length === 0) {
    branchLocalReadinessChunks += 1;
  } else if (readinessUpstreamMatches.length === 1 && readinessPatchedMatches.length === 0) {
    const [match, readyVariable, , tileVariable, , , readyAccumulator] = readinessUpstreamMatches[0];
    source = source.replace(match,
      `let ${readyVariable} = ${tileVariable}.internal.hasRenderableContent ? ${tileVariable}.internal.loadingState === 4 : ${tileVariable}.traversal.allChildrenLoaded;\n\t\t\t\t${readyVariable} || (${readyAccumulator} = !1);`);
    branchLocalReadinessChunks += 1;
  } else if (readinessUpstreamMatches.length || readinessPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built branch-local readiness block`);
  }

  const fallbackUpstream = /([A-Za-z_$][\w$]*)\.refine === "REPLACE" && !([A-Za-z_$][\w$]*) && \1\.traversal\.wasSetActive && ([A-Za-z_$][\w$]*)\(\1\) && \(\1\.traversal\.active = !0, ([A-Za-z_$][\w$]*)\(\1, ([A-Za-z_$][\w$]*)\)\)/g;
  const fallbackPatched = /([A-Za-z_$][\w$]*)\.refine === "REPLACE" && !([A-Za-z_$][\w$]*) && \(\1\.traversal\.wasSetActive \|\| ([A-Za-z_$][\w$]*)\.lodFallbackTiles\?\.has\(\1\)\) && ([A-Za-z_$][\w$]*)\(\1\) && \(\1\.traversal\.active = !0, ([A-Za-z_$][\w$]*)\(\1, \3\)\)/g;
  const fallbackUpstreamMatches = [...source.matchAll(fallbackUpstream)];
  const fallbackPatchedMatches = [...source.matchAll(fallbackPatched)];
  if (fallbackPatchedMatches.length === 1 && fallbackUpstreamMatches.length === 0) {
    scopedOverviewFallbackChunks += 1;
  } else if (fallbackUpstreamMatches.length === 1 && fallbackPatchedMatches.length === 0) {
    const [match, tileVariable, readyVariable, readyFunction, kickFunction, rendererVariable] = fallbackUpstreamMatches[0];
    source = source.replace(match,
      `${tileVariable}.refine === "REPLACE" && !${readyVariable} && (${tileVariable}.traversal.wasSetActive || ${rendererVariable}.lodFallbackTiles?.has(${tileVariable})) && ${readyFunction}(${tileVariable}) && (${tileVariable}.traversal.active = !0, ${kickFunction}(${tileVariable}, ${rendererVariable}))`);
    scopedOverviewFallbackChunks += 1;
  } else if (fallbackUpstreamMatches.length || fallbackPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built scoped overview fallback block`);
  }

  const foveatedUpstream = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*), ([A-Za-z_$][\w$]*)\) \{\s*return !\(\2\.traversal\.error <= \3\.errorTarget && !([A-Za-z_$][\w$]*)\(\2\) \|\|/g;
  const foveatedPatched = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*), ([A-Za-z_$][\w$]*)\) \{\s*let ([A-Za-z_$][\w$]*) = Number\.isFinite\(\2\.__ltdsPeripheralErrorTarget\) \? Math\.max\(\3\.errorTarget, \2\.__ltdsPeripheralErrorTarget\) : \3\.errorTarget;\s*(?:if \(\2\.__ltdsRegionalCoverPreparing === true && \2\.refine === "REPLACE" && \2\.internal\.loadingState === 4\) return false;\s*)?return !\(\2\.traversal\.error <= \4 && !([A-Za-z_$][\w$]*)\(\2\) \|\|/g;
  const foveatedUpstreamMatches = [...source.matchAll(foveatedUpstream)];
  const foveatedPatchedMatches = [...source.matchAll(foveatedPatched)];
  if (foveatedPatchedMatches.length === 1 && foveatedUpstreamMatches.length === 0) {
    foveatedTraversalChunks += 1;
  } else if (foveatedUpstreamMatches.length === 1 && foveatedPatchedMatches.length === 0) {
    const [match, functionName, tileVariable, rendererVariable, unconditionalFunction] = foveatedUpstreamMatches[0];
    source = source.replace(match,
      `function ${functionName}(${tileVariable}, ${rendererVariable}) {\n\tlet tileErrorTarget = Number.isFinite(${tileVariable}.__ltdsPeripheralErrorTarget) ? Math.max(${rendererVariable}.errorTarget, ${tileVariable}.__ltdsPeripheralErrorTarget) : ${rendererVariable}.errorTarget;\n\treturn !(${tileVariable}.traversal.error <= tileErrorTarget && !${unconditionalFunction}(${tileVariable}) ||`);
    foveatedTraversalChunks += 1;
  } else if (foveatedUpstreamMatches.length || foveatedPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built foveated-traversal block`);
  }
  // LOADED is the pinned renderer's public constant (4), checked by tests.
  const regionalMatches = [...source.matchAll(foveatedPatched)];
  if (regionalMatches.length === 1) {
    const [match, , tileVariable] = regionalMatches[0];
    const gate = `if (${tileVariable}.__ltdsRegionalCoverPreparing === true && ${tileVariable}.refine === "REPLACE" && ${tileVariable}.internal.loadingState === 4) return false;`;
    if (!match.includes(gate)) {
      source = source.replace(match, match.replace('return !(', `${gate}\n\treturn !(`));
    }
  }

  const requestFunction = /requestTileContents\(([A-Za-z_$][\w$]*)\) \{/g;
  const requestFunctionMatches = [...source.matchAll(requestFunction)];
  const queuedGuardUpstream = /let [^\r\n]+ = this\.stats, [^\r\n]+ = this\.lruCache, [^\r\n]+ = this\.downloadQueue, [^\r\n]+ = this\.parseQueue, [^\r\n]+ = this\.loadingTiles, [^\r\n]+, [^\r\n]+ = new AbortController\(\), [^\r\n]+\.signal;/g;
  const queuedGuardPatched = /const ltdsQueuedBytes = this\.getBytesUsed\(([A-Za-z_$][\w$]*)\);/g;
  const queuedGuardUpstreamMatches = [...source.matchAll(queuedGuardUpstream)];
  const queuedGuardPatchedMatches = [...source.matchAll(queuedGuardPatched)];
  if (queuedGuardPatchedMatches.length === 1 && queuedGuardUpstreamMatches.length === 1
    && source.includes('bytesUsed: ltdsQueuedBytes')
    && source.includes('cachedBytes + ltdsQueuedBytes >')) {
    queuedAdmissionGuardChunks += 1;
  } else if (queuedGuardUpstreamMatches.length === 1 && queuedGuardPatchedMatches.length === 0
    && requestFunctionMatches.length === 1) {
    const match = queuedGuardUpstreamMatches[0][0];
    const tileVariable = requestFunctionMatches[0][1];
    const cacheVariable = match.match(/([A-Za-z_$][\w$]*) = this\.lruCache/)?.[1];
    if (!cacheVariable) throw new Error(`${name}: queued-admission cache variable was not found`);
    source = source.replace(match,
      `${match}\n\t\tconst ltdsQueuedBytes = this.getBytesUsed(${tileVariable});\n\t\tif (ltdsQueuedBytes > 0 && ${cacheVariable}.cachedBytes + ltdsQueuedBytes > ${cacheVariable}.maxBytesSize) {\n\t\t\tthis.dispatchEvent({ type: "tile-memory-pressure", tile: ${tileVariable}, bytesUsed: ltdsQueuedBytes });\n\t\t\tif (${cacheVariable}.cachedBytes + ltdsQueuedBytes > ${cacheVariable}.maxBytesSize) return;\n\t\t}`);
    queuedAdmissionGuardChunks += 1;
  } else if (queuedGuardUpstreamMatches.length || queuedGuardPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built queued-admission guard`);
  }

  const queuedReservationUpstream = /([A-Za-z_$][\w$]*)\.setMemoryUsage\(([A-Za-z_$][\w$]*), this\.getBytesUsed\(\2\)\), this\.cachedSinceLoadComplete\.add\(\2\)/g;
  const queuedReservationPatched = /([A-Za-z_$][\w$]*)\.setMemoryUsage\(([A-Za-z_$][\w$]*), ltdsQueuedBytes\), this\.cachedSinceLoadComplete\.add\(\2\)/g;
  const queuedReservationUpstreamMatches = [...source.matchAll(queuedReservationUpstream)];
  const queuedReservationPatchedMatches = [...source.matchAll(queuedReservationPatched)];
  if (queuedReservationPatchedMatches.length === 1 && queuedReservationUpstreamMatches.length === 0) {
    queuedAdmissionReservationChunks += 1;
  } else if (queuedReservationUpstreamMatches.length === 1 && queuedReservationPatchedMatches.length === 0) {
    const [match, cacheVariable, tileVariable] = queuedReservationUpstreamMatches[0];
    source = source.replace(match,
      `${cacheVariable}.setMemoryUsage(${tileVariable}, ltdsQueuedBytes), this.cachedSinceLoadComplete.add(${tileVariable})`);
    queuedAdmissionReservationChunks += 1;
  } else if (queuedReservationUpstreamMatches.length || queuedReservationPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built queued-admission reservation`);
  }

  const prospectiveUpstream = /if \(([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\) === 0 && ([A-Za-z_$][\w$]*) > 0 && \1\.isFull\(\)\) \{\s*\1\.remove\(\2\);\s*return;\s*\}/g;
  const prospectiveLegacy = /if \(([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\) === 0 && ([A-Za-z_$][\w$]*) > 0 && \1\.cachedBytes \+ \3 > \1\.maxBytesSize\) \{\s*this\.dispatchEvent\(\{ type: "tile-memory-pressure", tile: \2, bytesUsed: \3 \}\);\s*if \(\1\.cachedBytes \+ \3 > \1\.maxBytesSize\) \{\s*\1\.remove\(\2\);\s*return;\s*\}\s*\}/g;
  const prospectivePatched = /const ltdsPreviousBytes = ([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\);\s*const ltdsAdditionalBytes = Math\.max\(0, ([A-Za-z_$][\w$]*) - ltdsPreviousBytes\);\s*if \(ltdsAdditionalBytes > 0 && \1\.cachedBytes \+ ltdsAdditionalBytes > \1\.maxBytesSize\) \{\s*this\.dispatchEvent\(\{ type: "tile-memory-pressure", tile: \2, bytesUsed: ltdsAdditionalBytes \}\);\s*if \(\1\.cachedBytes \+ ltdsAdditionalBytes > \1\.maxBytesSize\) \{\s*\1\.remove\(\2\);\s*return;\s*\}\s*\}/g;
  const prospectiveUpstreamMatches = [...source.matchAll(prospectiveUpstream)];
  const prospectiveLegacyMatches = [...source.matchAll(prospectiveLegacy)];
  const prospectivePatchedMatches = [...source.matchAll(prospectivePatched)];
  if (prospectivePatchedMatches.length === 1
    && prospectiveUpstreamMatches.length === 0 && prospectiveLegacyMatches.length === 0) {
    prospectiveAdmissionChunks += 1;
  } else if (prospectivePatchedMatches.length === 0
    && prospectiveUpstreamMatches.length + prospectiveLegacyMatches.length === 1) {
    const [match, cacheVariable, tileVariable, bytesVariable] = prospectiveUpstreamMatches[0]
      || prospectiveLegacyMatches[0];
    source = source.replace(match,
      `const ltdsPreviousBytes = ${cacheVariable}.getMemoryUsage(${tileVariable});\n\t\t\tconst ltdsAdditionalBytes = Math.max(0, ${bytesVariable} - ltdsPreviousBytes);\n\t\t\tif (ltdsAdditionalBytes > 0 && ${cacheVariable}.cachedBytes + ltdsAdditionalBytes > ${cacheVariable}.maxBytesSize) {\n\t\t\t\tthis.dispatchEvent({ type: "tile-memory-pressure", tile: ${tileVariable}, bytesUsed: ltdsAdditionalBytes });\n\t\t\t\tif (${cacheVariable}.cachedBytes + ltdsAdditionalBytes > ${cacheVariable}.maxBytesSize) {\n\t\t\t\t\t${cacheVariable}.remove(${tileVariable});\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}`);
    prospectiveAdmissionChunks += 1;
  } else if (prospectiveUpstreamMatches.length || prospectiveLegacyMatches.length || prospectivePatchedMatches.length) {
    throw new Error(`${name}: ambiguous built prospective-admission block`);
  }

  if (source !== originalSource) fs.writeFileSync(file, source);
}

if (matchingChunks !== 1) {
  throw new Error(`expected one built renderer traversal chunk, patched ${matchingChunks}`);
}
if (ancestorRetentionChunks !== 1) {
  throw new Error(`expected one built renderer ancestor-retention chunk, patched ${ancestorRetentionChunks}`);
}
if (branchLocalReadinessChunks !== 1) {
  throw new Error(`expected one built renderer branch-local readiness chunk, patched ${branchLocalReadinessChunks}`);
}
if (scopedOverviewFallbackChunks !== 1) {
  throw new Error(`expected one built renderer scoped overview fallback chunk, patched ${scopedOverviewFallbackChunks}`);
}
if (queuedAdmissionGuardChunks !== 1) {
  throw new Error(`expected one built renderer queued-admission guard chunk, patched ${queuedAdmissionGuardChunks}`);
}
if (queuedAdmissionReservationChunks !== 1) {
  throw new Error(`expected one built renderer queued-admission reservation chunk, patched ${queuedAdmissionReservationChunks}`);
}
if (prospectiveAdmissionChunks !== 1) {
  throw new Error(`expected one built renderer decoded-delta admission chunk, patched ${prospectiveAdmissionChunks}`);
}

function patchOneOf(file, legacyVariants, patched, label) {
  const source = fs.readFileSync(file, 'utf8');
  const patchedOccurrences = source.split(patched).length - 1;
  const legacyOccurrences = legacyVariants.map(legacy => source.split(legacy).length - 1);
  const legacyTotal = legacyOccurrences.reduce((total, count) => total + count, 0);
  if (patchedOccurrences === 1 && legacyTotal === 0) return false;
  if (patchedOccurrences !== 0 || legacyTotal !== 1) {
    throw new Error(`${label}: expected patched=1/legacy=0 or patched=0/legacy=1; found patched=${patchedOccurrences}/legacy=${legacyOccurrences.join(',')}`);
  }
  const legacyIndex = legacyOccurrences.findIndex(count => count === 1);
  const result = source.replace(legacyVariants[legacyIndex], patched);
  if ((result.split(patched).length - 1) !== 1
    || legacyVariants.some(legacy => (result.split(legacy).length - 1) !== 0)) {
    throw new Error(`${label}: replacement did not produce one exact patched block`);
  }
  fs.writeFileSync(file, result);
  return true;
}
if (foveatedTraversalChunks !== 1) {
  throw new Error(`expected one built renderer foveated-traversal chunk, patched ${foveatedTraversalChunks}`);
}
if (failedReplacementReadinessChunks !== 1) {
  throw new Error(`expected one built failed replacement readiness chunk, patched ${failedReplacementReadinessChunks}`);
}
patchLodLoadingBudget(packageRoot);
patchLodMaterialArrays(packageRoot, patchExact);
