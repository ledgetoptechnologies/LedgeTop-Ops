// Runs the pinned ltds-dji-decode wrapper (parser/, over dji-log-parser 0.5.7) on one raw log. No shell, fixed
// arguments (input and output paths only), a time limit and an output size limit. The DJI key is never on the
// command line: the wrapper reads it from the file named by DJI_API_KEY_FILE. The wrapper prints nothing; its exit
// code is the whole outcome, mapped here to the decode contract's closed vocabulary.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DECODER_VERSION = 'ltds-dji-decode/1.0.0+dji-log-parser/0.5.7@e2e07756';

export class ParserError extends Error {
  /** action: 'defer' (outside the log, no attempt used), 'retry' (uses an attempt) or 'fail' (permanent). */
  constructor(action, code) { super(`${action} ${code}`); this.action = action; this.code = code; }
}

const EXIT = new Map([
  [10, ['defer', 'keychain_unavailable']],   // key file missing or empty
  [11, ['defer', 'keychain_unavailable']],   // DJI rejected the key: a configuration problem, not the log's fault
  [12, ['defer', 'dji_unavailable']],        // DJI API error, 429 or 5xx
  [13, ['defer', 'network_unavailable']],
  [20, ['fail', 'corrupt_log']],
]);

/** Exit code / signal -> [action, contract code]. Unknown outcomes are retryable decoder errors (bounded by the cap). */
export function classifyExit({ exitCode = null, timedOut = false, missing = false } = {}) {
  if (missing || timedOut) return ['retry', 'decoder_error'];
  return EXIT.get(exitCode) ?? ['retry', 'decoder_error'];
}

export async function runParser({ binary, inputFile, workDir, keyFile, timeoutMs = 240_000, maxOutputBytes = 192 * 1024 * 1024 }) {
  const outputFile = path.join(workDir, 'frames.json');
  const env = { PATH: process.env.PATH ?? '' };
  if (keyFile) env.DJI_API_KEY_FILE = keyFile;
  const result = await new Promise(resolve => {
    execFile(binary, [inputFile, outputFile], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, env },
      error => resolve(error));
  });
  if (result) {
    const timedOut = result.killed === true || result.signal === 'SIGKILL';
    const missing = result.code === 'ENOENT';
    const [action, code] = classifyExit({ exitCode: typeof result.code === 'number' ? result.code : null, timedOut, missing });
    throw new ParserError(action, code);
  }
  const stat = await fs.stat(outputFile).catch(() => null);
  if (!stat) throw new ParserError('retry', 'decoder_error');
  if (stat.size > maxOutputBytes) throw new ParserError('fail', 'log_too_large');
  try { return JSON.parse(await fs.readFile(outputFile, 'utf8')); }
  catch { throw new ParserError('retry', 'decoder_error'); }
}
