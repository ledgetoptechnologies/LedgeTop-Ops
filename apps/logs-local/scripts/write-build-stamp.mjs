// CI only (publishing workflow): writes src/build-stamp.json from GITHUB_SHA, TARGET and GITHUB_REPOSITORY, read-only.
// Refuses to overwrite an existing stamp and refuses anything but an exact 40-hex commit and a known target.
import fs from 'node:fs';
import { BUILD_STAMP_FILE, readBuildStamp } from '../src/build-stamp.mjs';

const revision = process.env.GITHUB_SHA ?? '', target = process.env.TARGET ?? '', repository = process.env.GITHUB_REPOSITORY ?? '';
if (!/^[0-9a-f]{40}$/.test(revision) || !['keyless', 'full'].includes(target) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  console.error('build stamp: GITHUB_SHA, TARGET and GITHUB_REPOSITORY must be set to exact values');
  process.exit(1);
}
const stamp = { schemaVersion: 1, revision, target, source: `https://github.com/${repository}` };
fs.writeFileSync(BUILD_STAMP_FILE, `${JSON.stringify(stamp)}\n`, { flag: 'wx', mode: 0o444 });
readBuildStamp(); // validates what was written
console.log(JSON.stringify(stamp));
