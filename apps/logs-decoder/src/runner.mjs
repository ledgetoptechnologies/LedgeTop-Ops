// The decode loop. Raw logs and the queue live in Logs (D1 + R2), not here: if this machine or the server is down,
// nothing is lost. One log at a time, claimed just in time, all scratch in tmpfs. Every report is fenced by the lease;
// a lost reply is reconciled for at most one lease period, never retried forever; outages back off without using up
// a log's parse attempts; anything over the limits is suspended visibly for review, never spilled to disk.
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LogsRejected, LogsUnavailable } from './client.mjs';
import { DecodeOutputError, toFlight } from './frames.mjs';
import { LIMITS } from './limits.mjs';
import { DECODER_VERSION, ParserError } from './parser.mjs';

/** Scratch couldn't be verified clean: stop instead of taking another log (a container restart gives fresh tmpfs). */
export class ScratchError extends Error {}

const DEFER_SECONDS = { keychain_unavailable: 1800, dji_unavailable: 600, network_unavailable: 300, rate_limited: 900, raw_missing: 3600 };

export function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function report(client, lease, action, code, { log, label, signal }) {
  const result = action === 'defer' ? await client.defer(lease, code, DEFER_SECONDS[code] ?? 600, signal)
    : action === 'retry' ? await client.retry(lease, code, signal)
    : action === 'suspend' ? await client.suspend(lease, code, signal)
    : await client.fail(lease, code, signal);
  log(`${label} ${action} ${result.status} ${result.errorCode ?? code}`);
  return `${action}:${code}`;
}

/**
 * Report the result; if the reply is lost, ask Logs what happened instead of guessing. Bounded: after one lease period
 * (or on shutdown) it gives up and lets the lease expire; Logs' durable receipt and the lease expiry recover from there.
 */
async function completeOrReconcile(client, lease, result, { sleep, log, label, signal, now = Date.now }) {
  const deadline = now() + LIMITS.leaseSeconds * 1000;
  let wait = 2_000;
  while (!signal.aborted && now() < deadline) {
    try {
      const done = await client.complete(lease, result, signal);
      log(`${label} ${done.status}${done.replayed ? ' (receipt)' : ''}${done.errorCode ? ` ${done.errorCode}` : ''}`);
      return done.status;
    } catch (error) {
      if (error instanceof LogsRejected && error.status === 413) return report(client, lease, 'suspend', 'log_too_large', { log, label, signal });
      if (!(error instanceof LogsUnavailable)) throw error;
    }
    // The reply was lost or Logs is down: find out whether the result committed before sending it again.
    while (!signal.aborted && now() < deadline) {
      await sleep(wait, signal); wait = Math.min(60_000, wait * 2);
      let state;
      try { state = await client.reconcile(lease, signal); } catch (error) { if (error instanceof LogsUnavailable) continue; throw error; }
      if (state.status === 'decoded') { log(`${label} decoded (reconciled)`); return 'decoded'; }
      if (state.status === 'lost') { log(`${label} lost its lease; it will be offered again`); return 'lost'; }
      break;   // still held: send the same result again (an identical replay gets the original receipt)
    }
  }
  log(`${label} not confirmed; the lease will expire and the log will be offered again`);
  return 'unreported';
}

/** Decodes one leased log and reports the outcome. Returns a short, safe label (no paths, keys or data). */
export async function decodeOne(lease, { client, parser, workRoot, log = () => {}, heartbeatMs = 60_000, sleep = defaultSleep, signal = new AbortController().signal }) {
  const job = new AbortController();
  const stop = () => job.abort();
  signal.addEventListener('abort', stop, { once: true });
  const label = lease.sha256.slice(0, 12), ctx = { log, label, signal: job.signal };
  let workDir = null, lost = false;
  const beat = setInterval(() => {
    client.heartbeat(lease, job.signal).catch(error => { if (error instanceof LogsRejected) { lost = true; job.abort(); } });
  }, heartbeatMs);
  try {
    workDir = await fs.mkdtemp(path.join(workRoot, 'job-'));
    const inputFile = path.join(workDir, 'input.txt');
    let contentSha256;
    try { contentSha256 = await client.rawToFile(lease, inputFile, job.signal); }
    catch (error) {
      if (error instanceof LogsRejected && error.code === 'raw_missing') return report(client, lease, 'defer', 'raw_missing', ctx);
      if (error instanceof LogsRejected && error.code === 'raw_too_large') return report(client, lease, 'suspend', 'log_too_large', ctx);
      if (error?.code === 'ENOSPC') return report(client, lease, 'suspend', 'resource_capacity', ctx);
      throw error;
    }
    if (contentSha256 !== lease.sha256) return report(client, lease, 'defer', 'raw_missing', ctx);

    let flight;
    try { flight = toFlight(await parser({ inputFile, workDir, signal: job.signal })); }
    catch (error) {
      if (lost || job.signal.aborted) { log(`${label} stopped before reporting; it will be offered again`); return 'stopped'; }
      if (error instanceof ParserError) return report(client, lease, error.action, error.code, ctx);
      if (error instanceof DecodeOutputError) return report(client, lease, error.code === 'log_too_large' ? 'suspend' : 'fail', error.code, ctx);
      if (error?.code === 'ENOSPC') return report(client, lease, 'suspend', 'resource_capacity', ctx);
      throw error;
    }
    await fs.rm(inputFile, { force: true });
    if (lost || job.signal.aborted) { log(`${label} stopped before reporting; it will be offered again`); return 'stopped'; }
    // The same limits Logs enforces, checked here so a result is never refused silently after the work is done.
    const json = JSON.stringify(flight.track);
    flight.track = null;
    if (Buffer.byteLength(json) > LIMITS.trackJsonBytes) return report(client, lease, 'suspend', 'log_too_large', ctx);
    const trackGzip = gzipSync(json);
    if (trackGzip.byteLength > LIMITS.trackGzipBytes) return report(client, lease, 'suspend', 'log_too_large', ctx);
    return await completeOrReconcile(client, lease, { contentSha256, summary: flight.summary, trackGzip, decoderVersion: DECODER_VERSION }, { sleep, ...ctx });
  } finally {
    clearInterval(beat);
    signal.removeEventListener('abort', stop);
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      if (await fs.stat(workDir).then(() => true, () => false)) throw new ScratchError('scratch not cleaned');
    }
  }
}

/**
 * Runs until `signal` aborts. A claim's request id is reused until the claim gets an answer; the bridge adds this
 * runner's configured identity, so after a restart the runner resumes its own live lease rather than waiting for it to
 * expire. Backs off (up to maxBackoffMs) while the bridge or Logs is unreachable, closed or refusing.
 */
export async function run({ client, parser, workRoot, signal, log = () => {}, idleMs = 30_000, maxBackoffMs = 300_000, sleep = defaultSleep,
  newRequestId = () => randomUUID(), heartbeatMs = 60_000 }) {
  let backoff = 5_000, requestId = newRequestId();
  while (!signal.aborted) {
    let lease;
    try { lease = await client.claim(requestId, signal); backoff = 5_000; requestId = newRequestId(); }
    catch (error) {
      if (!(error instanceof LogsUnavailable || error instanceof LogsRejected)) throw error;
      if (signal.aborted) break;
      log(`bridge unavailable (${error.message}); retrying in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff, signal); backoff = Math.min(maxBackoffMs, backoff * 2);
      continue;
    }
    if (!lease) { await sleep(idleMs, signal); continue; }
    try { await decodeOne(lease, { client, parser, workRoot, log, sleep, heartbeatMs, signal }); }
    catch (error) {
      if (error instanceof LogsUnavailable || error instanceof LogsRejected) { log(`${lease.sha256.slice(0, 12)} not reported (${error.message}); it will be offered again`); continue; }
      throw error;
    }
  }
}
