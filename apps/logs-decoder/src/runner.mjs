// The decode loop. Raw logs and the queue live in Logs (D1 + R2), not here: if this machine or the server is down,
// nothing is lost. One log at a time, claimed just in time. Every report is fenced by the lease; a lost reply is
// reconciled, never blindly repeated; outages back off without using up a log's parse attempts.
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LogsRejected, LogsUnavailable } from './client.mjs';
import { DecodeOutputError, toFlight } from './frames.mjs';
import { DECODER_VERSION, ParserError } from './parser.mjs';

export const TRACK_GZIP_MAX_BYTES = 8 * 1024 * 1024;   // same as Logs
const DEFER_SECONDS = { keychain_unavailable: 1800, dji_unavailable: 600, network_unavailable: 300, rate_limited: 900, raw_missing: 3600 };

export function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function report(client, lease, action, code, log, label) {
  const result = action === 'defer' ? await client.defer(lease, code, DEFER_SECONDS[code] ?? 600)
    : action === 'retry' ? await client.retry(lease, code) : await client.fail(lease, code);
  log(`${label} ${action} ${result.status} ${result.errorCode ?? code}`);
  return `${action}:${code}`;
}

/** Report the result; if the reply is lost, ask Logs what happened instead of guessing. */
async function completeOrReconcile(client, lease, result, { sleep, log, label, attempts = 6 }) {
  let wait = 2_000;
  for (let i = 0; i < attempts; i++) {
    try {
      const done = await client.complete(lease, result);
      log(`${label} ${done.status}${done.replayed ? ' (receipt)' : ''}${done.errorCode ? ` ${done.errorCode}` : ''}`);
      return done.status;
    } catch (error) {
      if (!(error instanceof LogsUnavailable)) throw error;
    }
    // The reply was lost or Logs is down: find out whether the result committed before trying again.
    for (;;) {
      await sleep(wait); wait = Math.min(60_000, wait * 2);
      let state;
      try { state = await client.reconcile(lease); } catch (error) { if (error instanceof LogsUnavailable) continue; throw error; }
      if (state.status === 'decoded') { log(`${label} decoded (reconciled)`); return 'decoded'; }
      if (state.status === 'lost') { log(`${label} lost its lease; it will be offered again`); return 'lost'; }
      break;   // still held: send the same result again (identical replays get the original receipt)
    }
  }
  return 'unreported';
}

/** Decodes one leased log and reports the outcome. Returns a short, safe label (no paths, keys or data). */
export async function decodeOne(lease, { client, parser, workRoot, log = () => {}, heartbeatMs = 60_000, sleep = defaultSleep }) {
  const workDir = await fs.mkdtemp(path.join(workRoot, 'job-'));
  const label = lease.sha256.slice(0, 12);
  let lost = false;
  const beat = setInterval(() => {
    client.heartbeat(lease).catch(error => { if (error instanceof LogsRejected) lost = true; });
  }, heartbeatMs);
  try {
    let bytes;
    try { bytes = await client.raw(lease); }
    catch (error) {
      if (error instanceof LogsRejected && error.code === 'raw_missing') return report(client, lease, 'defer', 'raw_missing', log, label);
      if (error instanceof LogsRejected && error.code === 'raw_too_large') return report(client, lease, 'fail', 'log_too_large', log, label);
      throw error;
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    if (contentSha256 !== lease.sha256) return report(client, lease, 'defer', 'raw_missing', log, label);
    const inputFile = path.join(workDir, 'input.txt');
    await fs.writeFile(inputFile, bytes);
    bytes = null;

    let flight;
    try { flight = toFlight(await parser({ inputFile, workDir })); }
    catch (error) {
      if (lost) return 'lost';
      if (error instanceof ParserError) return report(client, lease, error.action, error.code, log, label);
      if (error instanceof DecodeOutputError) return report(client, lease, 'fail', error.code, log, label);
      throw error;
    }
    if (lost) { log(`${label} lost its lease while decoding; it will be offered again`); return 'lost'; }
    const trackGzip = gzipSync(JSON.stringify(flight.track));
    if (trackGzip.byteLength > TRACK_GZIP_MAX_BYTES) return report(client, lease, 'fail', 'log_too_large', log, label);
    return completeOrReconcile(client, lease, { contentSha256, summary: flight.summary, trackGzip, decoderVersion: DECODER_VERSION }, { sleep, log, label });
  } finally {
    clearInterval(beat);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs until `signal` aborts. A claim's request id is reused until the claim gets an answer, so a lost claim reply
 * never takes a second log. Backs off (up to maxBackoffMs) while the bridge or Logs is unreachable, closed or
 * refusing, and picks up where it left off. A refused report is logged and skipped; Logs offers the log again.
 */
export async function run({ client, parser, workRoot, signal, log = () => {}, idleMs = 30_000, maxBackoffMs = 300_000, sleep = defaultSleep,
  newRequestId = () => randomUUID(), heartbeatMs = 60_000 }) {
  let backoff = 5_000, requestId = newRequestId();
  while (!signal.aborted) {
    let lease;
    try { lease = await client.claim(requestId); backoff = 5_000; requestId = newRequestId(); }
    catch (error) {
      if (!(error instanceof LogsUnavailable || error instanceof LogsRejected)) throw error;
      log(`logs unavailable (${error.message}); retrying in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff, signal); backoff = Math.min(maxBackoffMs, backoff * 2);
      continue;
    }
    if (!lease) { await sleep(idleMs, signal); continue; }
    try { await decodeOne(lease, { client, parser, workRoot, log, sleep, heartbeatMs }); }
    catch (error) {
      if (error instanceof LogsUnavailable || error instanceof LogsRejected) { log(`${lease.sha256.slice(0, 12)} not reported (${error.message}); it will be offered again`); continue; }
      throw error;
    }
  }
}
