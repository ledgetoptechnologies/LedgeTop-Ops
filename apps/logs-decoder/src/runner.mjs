// The decode loop. Raw logs and the queue live in Logs (D1 + R2), not here: if this machine or the server is down,
// nothing is lost. Leases expire and are handed out again, and every report is fenced by its lease token, so a
// restart at any point is safe. One log at a time.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LogsRejected, LogsUnavailable } from './client.mjs';
import { DecodeOutputError, toFlight } from './frames.mjs';
import { ParserError, runParser } from './parser.mjs';

const RETRYABLE = new Set(['keychain_unavailable', 'decoder_error', 'raw_missing']);

/** Decodes one leased log and reports the outcome. Returns a short, safe outcome label (no paths, keys or data). */
export async function decodeOne(lease, { client, parser, workRoot, log = () => {} }) {
  const workDir = await fs.mkdtemp(path.join(workRoot, 'job-'));
  const label = lease.sha256.slice(0, 12);
  try {
    let bytes;
    try { bytes = await client.raw(lease); }
    catch (error) {
      if (error instanceof LogsRejected && error.code === 'raw_missing') return report(client, lease, 'raw_missing', log, label);
      throw error;
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    if (contentSha256 !== lease.sha256) return report(client, lease, 'raw_missing', log, label);
    const inputFile = path.join(workDir, 'input.txt');
    await fs.writeFile(inputFile, bytes);

    let flight;
    try { flight = toFlight(await parser({ inputFile, workDir })); }
    catch (error) {
      if (error instanceof ParserError || error instanceof DecodeOutputError) return report(client, lease, error.code, log, label);
      throw error;
    }
    const trackGzip = gzipSync(JSON.stringify(flight.track));
    const result = await client.complete(lease, { contentSha256, summary: flight.summary, trackGzip });
    log(`${label} ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}`);
    return result.status;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function report(client, lease, code, log, label) {
  const result = RETRYABLE.has(code) ? await client.retry(lease, code) : await client.fail(lease, code);
  log(`${label} ${result.status} ${result.errorCode}`);
  return result.status;
}

/**
 * Runs until `signal` aborts. Backs off (up to maxBackoffMs) while Logs is unreachable or switched off and picks
 * up where it left off when it's back. A refused report (for example a lease that expired meanwhile) is logged and
 * skipped: the server hands the log out again.
 */
export async function run({ client, parser, workRoot, signal, log = () => {}, idleMs = 30_000, maxBackoffMs = 300_000, sleep = defaultSleep }) {
  let backoff = 5_000;
  while (!signal.aborted) {
    let leases;
    try { leases = await client.lease(1); backoff = 5_000; }
    catch (error) {
      if (!(error instanceof LogsUnavailable || error instanceof LogsRejected)) throw error;
      log(`logs unavailable (${error.message}); retrying in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff, signal); backoff = Math.min(maxBackoffMs, backoff * 2);
      continue;
    }
    if (!leases.length) { await sleep(idleMs, signal); continue; }
    for (const lease of leases) {
      if (signal.aborted) break;
      try { await decodeOne(lease, { client, parser, workRoot, log }); }
      catch (error) {
        if (error instanceof LogsUnavailable || error instanceof LogsRejected) { log(`${lease.sha256.slice(0, 12)} not reported (${error.message}); it will be offered again`); continue; }
        throw error;
      }
    }
  }
}

function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export { runParser };
