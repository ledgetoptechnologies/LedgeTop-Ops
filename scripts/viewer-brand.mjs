// Writes the Viewer's copy of the shared Ledge Top mark from packages/ui/src/brand.ts.
// The Viewer image is built from apps/viewer alone, so it cannot import packages/ui at build or run time.
//   node scripts/viewer-brand.mjs --write   regenerate
//   node scripts/viewer-brand.mjs --check   exit 1 when the copy drifted (also covered by viewer-brand.test.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LT_FAVICON_SVG, LT_MARK_SVG } from '../packages/ui/src/brand.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Generated files, relative to the repo root, and the exact content each must hold. */
export const GENERATED = {
  'apps/viewer/public/lt-mark.svg': LT_MARK_SVG,
  'apps/viewer/public/favicon.svg': LT_FAVICON_SVG,
  'apps/operations/public/favicon.svg': LT_FAVICON_SVG,
  'apps/client/public/favicon.svg': LT_FAVICON_SVG,
};

export function drift() {
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
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
