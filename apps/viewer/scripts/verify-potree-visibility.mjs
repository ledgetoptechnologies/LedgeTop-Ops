import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchPotreeVisibilitySelection} from './patch-potree-ept.mjs';

// Read-only attestation, not repair. The pinned patcher validates every expected
// selection/demand signature; any replacement needed means the image is wrong.
export function assertInstalledPotreeVisibility(source){
  assert.ok(patchPotreeVisibilitySelection(source)===source,
    'Installed Potree visibility/demand patch is missing or incomplete; verification will not repair the bundle.');
  return source;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw new Error('Installed Potree bundle path is required');
  assertInstalledPotreeVisibility(fs.readFileSync(process.argv[2],'utf8'));
  process.stdout.write('Installed Potree visibility and eligible-demand patch verified without modification.\n');
}
