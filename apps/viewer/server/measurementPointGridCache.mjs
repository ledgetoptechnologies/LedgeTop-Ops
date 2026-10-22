import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// A fixed number of slots bounds committed AND interrupted temporary files.
// Collisions only evict an optimization; exact keys are checked on every read.
export const POINT_GRID_CACHE_SLOTS = 8;
export const POINT_GRID_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function pointGridCacheKey(root, request, files, vertical) {
  return digest(JSON.stringify(stable({ version: 1, root, source: request.source,
    modelId: request.modelId, modelVersionId: request.modelVersionId,
    coordinateReference: request.coordinateReference, vertical,
    sourceVerticalUnit: request.sourceVerticalUnit || null,
    sourceUnitEvidence: request.sourceUnitEvidence || null,
    requireEncodedVerticalUnits: request.requireEncodedVerticalUnits === true,
    vertices: request.vertices.map(p => p.slice(0, 2)), cellSizeM: request.cellSizeM,
    classFilter: request.classFilter || 'all', reduction: 'maximum-z',
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, f]) => [name, f.byteSize, f.sha256]),
  })));
}
async function slotPath(cacheRoot, key) {
  if (!cacheRoot || !/^[a-f0-9]{64}$/.test(key)) return null;
  const root = path.resolve(cacheRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // Cache is an internal worker path, never a user-supplied asset location.
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) return null;
  return path.join(root, `${parseInt(key.slice(0, 8), 16) % POINT_GRID_CACHE_SLOTS}.grid`);
}
export async function readPointGridCache(cacheRoot, key, grid) {
  try {
    const file = await slotPath(cacheRoot, key); if (!file) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > POINT_GRID_CACHE_MAX_BYTES || stat.size < 4) return null;
    const bytes = await fs.readFile(file); if(bytes.length < 4 || bytes.length > POINT_GRID_CACHE_MAX_BYTES) return null;
    const headerSize = bytes.readUInt32LE(0);
    if (headerSize > 4096 || headerSize < 1 || 4 + headerSize > bytes.length) return null;
    const header = JSON.parse(bytes.subarray(4, 4 + headerSize).toString('utf8'));
    const values = bytes.subarray(4 + headerSize);
    if (header.key !== key || header.width !== grid.width || header.height !== grid.height
      || JSON.stringify(header.bounds) !== JSON.stringify(grid.bounds)
      || values.length !== grid.width * grid.height * 8 || digest(values) !== header.sha256
      || !Number.isSafeInteger(header.pointsUsed) || header.pointsUsed < 0) return null;
    const decoded = new Float64Array(grid.width * grid.height);
    for (let i = 0; i < decoded.length; i++) { const z = values.readDoubleLE(i * 8); if (!Number.isFinite(z) && !Number.isNaN(z)) return null; decoded[i] = z; }
    return { values: decoded, pointsUsed: header.pointsUsed };
  } catch { return null; } // Cache loss/corruption never makes a valid source unavailable.
}
export async function writePointGridCache(cacheRoot, key, grid, pointsUsed) {
  let temporary, handle;
  try {
    if (!cacheRoot || grid.values.byteLength + 4100 > POINT_GRID_CACHE_MAX_BYTES) return false;
    const file = await slotPath(cacheRoot, key); if (!file) return false;
    temporary = `${file}.tmp`;
    // Exclusive fixed temporary slots bound storage even if a child is killed.
    // Old abandoned writes can be reclaimed after twice the maximum job time.
    try { const old = await fs.lstat(temporary); if (old.isFile() && !old.isSymbolicLink() && Date.now() - old.mtimeMs > 30 * 60_000) await fs.unlink(temporary); } catch {}
    try { handle = await fs.open(temporary, 'wx', 0o600); } catch { return false; }
    const values = Buffer.alloc(grid.values.byteLength);
    for (let i = 0; i < grid.values.length; i++) values.writeDoubleLE(grid.values[i], i * 8);
    const header = Buffer.from(JSON.stringify({ key, width: grid.width, height: grid.height, bounds: grid.bounds, pointsUsed, sha256: digest(values) }));
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
    await handle.writeFile(Buffer.concat([length, header, values])); await handle.close(); handle = null;
    await fs.rename(temporary, file); temporary = null;
    return true;
  } catch { return false; }
  finally { if (handle) await handle.close().catch(() => {}); if (temporary && handle !== undefined) await fs.unlink(temporary).catch(() => {}); }
}
