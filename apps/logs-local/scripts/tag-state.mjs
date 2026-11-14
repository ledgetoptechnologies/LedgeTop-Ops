// CI only: classify the result of `docker buildx imagetools inspect <tag>` for the immutable-tag check, failing closed.
//   node tag-state.mjs <exit-code> <stderr-file>   prints present | absent | unknown; exits 0 only for "absent"
// "absent" requires a positive not-found answer from the registry (MANIFEST_UNKNOWN / NAME_UNKNOWN / "not found").
// Anything else (auth, rate limit, timeout, 5xx, network) is "unknown", and the workflow stops: an unproven absence
// never lets a push overwrite an existing tag.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOT_FOUND = /\b(MANIFEST_UNKNOWN|NAME_UNKNOWN)\b|:\s*not found\s*$/im;
const OTHER_FAILURE = /\b(unauthorized|denied|forbidden|DENIED|UNAUTHORIZED|TOOMANYREQUESTS|timeout|timed out|i\/o timeout|connection (refused|reset)|no such host|EOF|5\d\d|internal server error|service unavailable|bad gateway)\b/i;

export function tagState(exitCode, stderr) {
  if (exitCode === 0) return 'present';
  const text = String(stderr ?? '');
  if (!NOT_FOUND.test(text) || OTHER_FAILURE.test(text)) return 'unknown';
  return 'absent';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const code = Number(process.argv[2]);
  const stderr = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : '';
  const state = Number.isInteger(code) ? tagState(code, stderr) : 'unknown';
  console.log(state);
  process.exitCode = state === 'absent' ? 0 : 1;
}
