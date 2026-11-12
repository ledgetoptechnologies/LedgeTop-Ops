/** Mandatory candidate-map proof. Cloudflare exposes maps only with
 * include=modules,sourcemaps and may normalize their serialization/paths.
 * Runtime and ledger bytes remain independently hash-pinned by the callers. */
import { createHash } from 'node:crypto';
import { verifySourceMap } from './production-deploy.mjs';

export const PRODUCTION_AUTO_SOURCE_MAP_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(PRODUCTION_AUTO_SOURCE_MAP_MAX_BYTES / 3);
const fail = () => { throw Error('production_auto_source_map_readback_refused'); };
export function verifyProductionAutoSourceMap(modules, original) {
  if (!Array.isArray(modules)) fail();
  const maps = modules.filter(row => row?.name === 'index.js.map');
  if (maps.length !== 1 || maps[0].content_type !== 'application/source-map') fail();
  const encoded = maps[0].content_base64;
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_BASE64
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > PRODUCTION_AUTO_SOURCE_MAP_MAX_BYTES
      || bytes.toString('base64') !== encoded) fail();
  let actual;
  try {
    actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    verifySourceMap(actual, original);
  } catch { fail(); }
  return { sourceMapSHA256: createHash('sha256').update(bytes).digest('hex') };
}
