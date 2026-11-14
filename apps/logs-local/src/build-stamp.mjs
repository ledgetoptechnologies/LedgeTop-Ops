// The image's build stamp: which exact commit and target this runtime was built from. Written by the publishing
// workflow (scripts/write-build-stamp.mjs) into src/build-stamp.json before the image build; read-only at runtime.
// Absent in a source checkout (local runs and tests): readBuildStamp() then returns null, never a guess.
//   node apps/logs-local/src/build-stamp.mjs check <commit> <target>   exits 0 only on an exact match
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_STAMP_FILE = fileURLToPath(new URL('./build-stamp.json', import.meta.url));
const COMMIT = /^[0-9a-f]{40}$/;
const TARGETS = ['keyless', 'full'];

/** A validated stamp, or null when there is none. A malformed stamp throws (never silently ignored). */
export function readBuildStamp(file = BUILD_STAMP_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const stamp = JSON.parse(text);
  if (stamp?.schemaVersion !== 1 || !COMMIT.test(stamp.revision ?? '') || !TARGETS.includes(stamp.target) || typeof stamp.source !== 'string'
    || Object.keys(stamp).sort().join() !== 'revision,schemaVersion,source,target') throw new Error('build_stamp_invalid');
  return Object.freeze(stamp);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === 'check') {
  const [, , , commit, target] = process.argv;
  const stamp = readBuildStamp();
  const ok = stamp && stamp.revision === commit && stamp.target === target;
  console.log(JSON.stringify({ ok: Boolean(ok), revision: stamp?.revision ?? null, target: stamp?.target ?? null }));
  process.exitCode = ok ? 0 : 1;
}
