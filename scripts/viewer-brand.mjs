// Writes the Viewer's copy of the shared Ledge Top mark from packages/ui/src/brand.ts.
// The Viewer image is built from apps/viewer alone, so it cannot import packages/ui at build or run time.
//   node scripts/viewer-brand.mjs --write   regenerate
//   node scripts/viewer-brand.mjs --check   exit 1 when the copy drifted (also covered by viewer-brand.test.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_COLORS, LT_FAVICON_SVG, LT_MARK_SVG } from '../packages/ui/src/brand.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Colour constants for Viewer code that cannot use CSS variables (canvas, three.js and Leaflet styles). */
export const VIEWER_BRAND_COLORS_MODULE = `// Generated from packages/ui/src/brand.ts by scripts/viewer-brand.mjs. Do not edit.
export const BRAND_COLORS = Object.freeze(${JSON.stringify(BRAND_COLORS, null, 2)});
`;

/** Generated files, relative to the repo root, and the exact content each must hold. */
export const GENERATED = {
  'apps/viewer/public/lt-mark.svg': LT_MARK_SVG,
  'apps/viewer/brand-colors.mjs': VIEWER_BRAND_COLORS_MODULE,
  'apps/viewer/public/favicon.svg': LT_FAVICON_SVG,
  'apps/operations/public/favicon.svg': LT_FAVICON_SVG,
  'apps/client/public/favicon.svg': LT_FAVICON_SVG,
};

export function drift() {
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };
  return Object.entries(GENERATED).filter(([file, content]) => read(file) !== content).map(([file]) => file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    for (const [file, content] of Object.entries(GENERATED)) {
      fs.writeFileSync(path.join(root, file), content);
    }
  }
  const stale = drift();
  if (stale.length) {
    console.error(`Out of date with packages/ui/src/brand.ts: ${stale.join(', ')}. Run node scripts/viewer-brand.mjs --write.`);
    process.exit(1);
  }
  console.log('Viewer brand copy matches packages/ui/src/brand.ts.');
}
