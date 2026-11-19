// CI only: classify the result of `docker buildx imagetools inspect <ref>` for the immutable-tag check, failing closed.
//   node tag-state.mjs <exit-code> <stderr-file> <ref>   prints present | absent | unknown; exits 0 only for "absent"
// "absent" needs ALL of: the tool's ordinary failure exit (1, never a timeout, signal or missing-tool exit), no HTTP
// failure status anywhere, and EVERY non-empty stderr line being a recognised not-found answer for exactly this
// reference. Anything else is "unknown" and stops the run: an unproven absence never lets a push overwrite a tag.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAILURE_MARKER = /\b(40[13]|429|5\d\d)\b|unauthori[sz]ed|denied|forbidden|toomanyrequests|rate.?limit|timeout|timed out|deadline|connection|refused|reset|no such host|\beof\b|tls|certificate|internal server error|service unavailable|bad gateway|terminated|killed|command not found|no such file/i;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function tagState(exitCode, stderr, ref) {
  if (exitCode === 0) return 'present';
  if (exitCode !== 1 || typeof ref !== 'string' || !ref) return 'unknown';
  const lines = String(stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.some(line => FAILURE_MARKER.test(line))) return 'unknown';
  const exactNotFound = new RegExp(`^(ERROR: )?${escape(ref)}: not found$`);
  const registryNotFound = /^(ERROR: )?.*\b(MANIFEST_UNKNOWN|NAME_UNKNOWN)\b[^]*$/;
  return lines.every(line => exactNotFound.test(line) || (registryNotFound.test(line) && line.includes(ref))) ? 'absent' : 'unknown';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const code = Number(process.argv[2]);
  let stderr = '';
  try { stderr = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : ''; } catch { stderr = ''; }
  const state = Number.isInteger(code) ? tagState(code, stderr, process.argv[4]) : 'unknown';
  console.log(state);
  process.exitCode = state === 'absent' ? 0 : 1;
}
