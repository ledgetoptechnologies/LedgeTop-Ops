// Runs the pinned ltds-dji-decode wrapper (parser/, over dji-log-parser 0.5.7) on one raw log. No shell, fixed
// arguments (input and output paths only), a time limit, an output size limit, and it is killed if the runner stops.
// The DJI key is never on the command line: the wrapper reads it from the file named by DJI_API_KEY_FILE. The wrapper
// prints nothing; its exit code is the whole outcome, mapped here to the decode contract's closed vocabulary.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from './limits.mjs';

export const DECODER_VERSION = 'ltds-dji-decode/1.0.0+dji-log-parser/0.5.7@e2e07756';

export class ParserError extends Error {
  /** action: 'defer' (outside the log, no attempt), 'retry' (uses an attempt), 'suspend' (visible, for review) or 'fail'. */
  constructor(action, code) { super(`${action} ${code}`); this.action = action; this.code = code; }
}

const EXIT = new Map([
  [10, ['defer', 'keychain_unavailable']],   // key file missing or empty
  [11, ['defer', 'keychain_unavailable']],   // DJI rejected the key: a configuration problem, not the log's fault
  [12, ['defer', 'dji_unavailable']],        // DJI API error, 429 or 5xx
  [13, ['defer', 'network_unavailable']],
  [20, ['fail', 'corrupt_log']],
  [30, ['suspend', 'resource_capacity']],    // couldn't write its output: scratch (tmpfs) full
  [137, ['suspend', 'resource_capacity']],   // killed by the container's memory limit
]);

/**
 * Exit code / signal -> [action, contract code]. Our own timeout is a retryable decoder error; a SIGKILL we didn't
 * send is the memory limit (resource_capacity, suspended for review, never a retry loop). Unknown -> retryable.
 */
export function classifyExit({ exitCode = null, signal = null, timedOut = false, missing = false } = {}) {
  if (missing || timedOut) return ['retry', 'decoder_error'];
  if (signal === 'SIGKILL') return ['suspend', 'resource_capacity'];
  return EXIT.get(exitCode) ?? ['retry', 'decoder_error'];
}

export async function runParser({ binary, inputFile, workDir, keyFile, timeoutMs = 240_000, maxOutputBytes = LIMITS.parserOutputBytes, signal }) {
  const outputFile = path.join(workDir, 'frames.json');
  const env = { PATH: process.env.PATH ?? '' };
  if (keyFile) env.DJI_API_KEY_FILE = keyFile;
  let timedOut = false;
  const result = await new Promise(resolve => {
    const child = execFile(binary, [inputFile, outputFile], { killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, env, signal },
      error => { clearTimeout(timer); resolve(error); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  });
  if (signal?.aborted) throw new ParserError('stopped', 'stopped');
  if (result) {
    const missing = result.code === 'ENOENT';
    const [action, code] = classifyExit({ exitCode: typeof result.code === 'number' ? result.code : null, signal: result.signal ?? null, timedOut, missing });
    throw new ParserError(action, code);
  }
  const stat = await fs.stat(outputFile).catch(() => null);
  if (!stat) throw new ParserError('retry', 'decoder_error');
  if (stat.size > maxOutputBytes) throw new ParserError('suspend', 'log_too_large');
  let text;
  try { text = await fs.readFile(outputFile, 'utf8'); } finally { await fs.rm(outputFile, { force: true }); }
  try { return JSON.parse(text); }
  catch { throw new ParserError('retry', 'decoder_error'); }
}
