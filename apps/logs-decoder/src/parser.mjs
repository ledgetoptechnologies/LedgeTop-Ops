// Runs the pinned dji-log CLI on one raw log. No shell, fixed arguments, a time limit and an output size limit.
// Parser messages stay on this machine: callers only ever see a closed error code from the decode contract.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class ParserError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

/** Closed mapping from what dji-log reports to the contract's error codes. Unknown failures are retryable. */
export function classifyFailure({ stderr = '', timedOut = false, missing = false } = {}) {
  if (missing) return 'decoder_error';
  if (timedOut) return 'decoder_error';
  if (/API Key is required|Unable to fetch keychain|keychain/i.test(stderr)) return 'keychain_unavailable';
  if (/Unable to read file/i.test(stderr)) return 'raw_missing';
  return 'decoder_error';
}

/**
 * Decode `inputFile` into parsed JSON. `apiKey` is the environment's own DJI key (logs v13+ need it for
 * keychains); it is passed only to the parser process and never logged.
 */
export async function runParser({ binary, inputFile, workDir, apiKey, timeoutMs = 240_000, maxOutputBytes = 512 * 1024 * 1024 }) {
  const outputFile = path.join(workDir, 'frames.json');
  const args = [inputFile, '--output', outputFile];
  if (apiKey) args.push('--api-key', apiKey);
  const result = await new Promise(resolve => {
    execFile(binary, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH ?? '' } },
      (error, _stdout, stderr) => resolve({ error, stderr: String(stderr ?? '') }));
  });
  if (result.error) {
    const timedOut = result.error.killed === true || result.error.signal === 'SIGKILL';
    const missing = result.error.code === 'ENOENT';
    throw new ParserError(classifyFailure({ stderr: result.stderr, timedOut, missing }), missing ? 'parser binary not found' : `exit ${result.error.code ?? result.error.signal}`);
  }
  const stat = await fs.stat(outputFile).catch(() => null);
  if (!stat) throw new ParserError('decoder_error', 'no output file');
  if (stat.size > maxOutputBytes) throw new ParserError('decoder_error', 'output too large');
  try { return JSON.parse(await fs.readFile(outputFile, 'utf8')); }
  catch { throw new ParserError('decoder_error', 'output is not JSON'); }
}
