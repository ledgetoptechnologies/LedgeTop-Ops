'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { safeRelativePath, publicDerivativeKind } = require('./processingSecurity');
const { CUTLINE_PATTERN } = require('./orthophotoCutline');

const PRODUCTS = {
  ortho: ['Orthophoto', ['.tif', '.tiff']],
  orthoCutline: ['Orthophoto cutline', ['.geojson', '.gpkg']],
  dsm: ['Surface model (DSM)', ['.tif', '.tiff']],
  dtm: ['Terrain model (DTM)', ['.tif', '.tiff']],
  pointCloud: ['Original point cloud', ['.las', '.laz', '.ply']],
  glb: ['Textured model (GLB)', ['.glb']],
  obj: ['Mesh geometry (OBJ, without textures)', ['.obj']],
  texturedModel: ['Textured model package', ['.zip']],
  cameraParameters: ['Camera parameters', ['.json', '.txt', '.xml']],
  shots: ['Camera positions', ['.geojson', '.json']],
  report: ['Model report — processing & quality', ['.pdf']],
  allAssets: ['All assets archive', ['.zip']],
  backup: ['Backup archive', ['.zip']],
};

// A manifest is not its product. EPT, 3D Tiles and loose glTF/OBJ texture
// dependencies must never be presented as complete original downloads.
function productDescriptor(asset, { staff = false, review = false, cameras = true, modelReport = false } = {}) {
  const spec = PRODUCTS[asset?.kind];
  if (asset?.kind === 'orthoCutline' && !CUTLINE_PATTERN.test(asset.relativePath || '')) return null;
  // Only the download-capability routes opt into the original report. It stays
  // outside the public asset allowlist and does not require publishing raw files.
  const originalReport = modelReport && asset?.kind === 'report'
    && asset.format === 'pdf' && asset.contentType === 'application/pdf';
  if (!spec || (!staff && !originalReport && (!publicDerivativeKind(asset.kind) || (!review && !asset.published)))) return null;
  if (asset.kind === 'shots' && !cameras) return null;
  if (!asset.sha256 || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0
    || safeRelativePath(asset.relativePath) !== asset.relativePath) return null;
  const extension = path.posix.extname(asset.relativePath).toLowerCase();
  if (!spec[1].includes(extension)) return null;
  return { kind: asset.kind, label: spec[0], format: extension.slice(1).toUpperCase(), byteSize: asset.byteSize,
    fileName: `${asset.kind}${extension}` };
}

function registeredProducts(assets, options) {
  return Object.keys(PRODUCTS).flatMap(kind => {
    const descriptor = productDescriptor((assets || []).find(asset => asset.kind === kind), options);
    return descriptor ? [descriptor] : [];
  });
}

// Opaque narrow capabilities retain the original authorization only in this
// process. Every request (including Range/HEAD) reruns its live authorization.
// Restart deliberately invalidates tickets; the menu can issue another one.
function createDownloadCapabilities({ ttlMs = 5 * 60_000, maxEntries = 5000, now = Date.now } = {}) {
  const tickets = new Map();
  function prune() { for (const [key, value] of tickets) if (value.expiresAt <= now()) tickets.delete(key); }
  async function acquire(token) {
    prune();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const ticket = tickets.get(token);
    if (!ticket) return null;
    const value = await ticket.resolve();
    if (!value) { tickets.delete(token); return null; }
    // Ticket expiry controls admission, not the duration of an already admitted
    // request. Revalidation still checks live source/session permissions after
    // slow large-file integrity reads. A new Range request needs a live ticket.
    return { value, revalidate: ticket.resolve };
  }
  return {
    issue(resolve, expiresAt = Infinity) {
      prune();
      if (tickets.size >= maxEntries) throw Object.assign(new Error('Too many pending downloads. Try again shortly.'), { status: 429 });
      const deadline = Math.min(now() + ttlMs, expiresAt);
      if (!Number.isFinite(deadline) || deadline <= now()) throw Object.assign(new Error('Download authorization expired'), { status: 403 });
      const token = crypto.randomBytes(32).toString('base64url');
      tickets.set(token, { resolve, expiresAt: deadline });
      return { token, expiresAt: new Date(deadline).toISOString() };
    },
    acquire,
    async resolve(token) { return (await acquire(token))?.value || null; },
  };
}

module.exports = { productDescriptor, registeredProducts, createDownloadCapabilities };
