// The DJI log decoder, run inside the local Logs host. It reuses the reviewed runner, parser wrapper and decode
// contract (ported from #584); instead of an HTTPS bridge, a LocalClient calls the contract directly.
//
// Keyless first boot: with no DJI key configured the decoder is in 'waiting_for_key'. It makes NO claim at all, so
// no lease is taken, and no parse attempt or reclaim is ever counted; uploads, history and the Ops API work as
// normal and every original waits in the queue. Entering the key (in the app config) and sending SIGHUP, or
// restarting, starts decoding. The key is copied only to a 0600 file in the RAM-only scratch directory, for the
// parser wrapper to read; it is never logged, put in argv or in the environment, and the file is removed on stop.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as decode from '../../logs/src/worker/decode-contract.mjs';
import * as decoderService from '../../logs/src/worker/decoder-service.mjs';
import { LogsError } from '../../logs/src/worker/errors.mjs';
import { LogsRejected, LogsUnavailable } from '../../logs-decoder/src/client.mjs';
import { LIMITS } from '../../logs-decoder/src/limits.mjs';
import { run as runDecoder } from '../../logs-decoder/src/runner.mjs';
import { runParser } from '../../logs-decoder/src/parser.mjs';

export const DECODER_STATES = Object.freeze(['waiting_for_key', 'parser_unavailable', 'scratch_not_ram', 'running', 'stopped', 'crashed']);
/** The only scratch directory: the container's RAM tmpfs. Raw logs and the key copy never touch persistent disk. */
export const WORK_ROOT = '/work';
const TMPFS_MAGIC = 0x01021994;

/** FileHandle.write may write less than asked: finish the chunk, and treat no progress as a local outage. */
async function writeAll(handle, chunk, write = (h, c, o) => h.write(c, o, c.byteLength - o)) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await write(handle, chunk, offset);
    // A local scratch failure is an outage, not a verdict on the log: no attempt is used, the lease simply expires.
    if (!(bytesWritten > 0)) throw new LogsUnavailable('scratch_write_failed');
    offset += bytesWritten;
  }
}

/** The runner's client interface, implemented in-process over the decode contract. */
export function createLocalClient(env, { runnerId = 'local-host', write } = {}) {
  const call = async fn => {
    try { return await fn(); } catch (error) {
      if (error instanceof LogsError) {
        if (error.status >= 500 || error.status === 429) throw new LogsUnavailable(error.code);
        throw new LogsRejected(error.status, error.code);
      }
      // Anything unexpected (e.g. the database is busy) is an outage for the runner: back off, keep the lease rules.
      throw new LogsUnavailable('internal_error');
    }
  };
  return {
    claim: requestId => call(() => decode.claimRawLog(env, { runnerId, requestId })),
    heartbeat: lease => call(() => decode.heartbeatLease(env, lease)),
    async rawToFile(lease, file) {
      const raw = await call(() => decoderService.readRaw(env, lease));
      if (raw.size > LIMITS.rawBytes) { await raw.body?.cancel?.(); throw new LogsRejected(413, 'raw_too_large'); }
      const hash = createHash('sha256'), out = await fsp.open(file, 'wx', 0o600);
      let size = 0;
      try {
        for await (const chunk of raw.body) {
          size += chunk.byteLength;
          if (size > LIMITS.rawBytes) throw new LogsRejected(413, 'raw_too_large');
          hash.update(chunk);
          await writeAll(out, chunk, write);
        }
      } finally { await out.close(); }
      return hash.digest('hex');
    },
    complete: (lease, { contentSha256, summary, trackGzip, decoderVersion }) =>
      call(() => decoderService.completeWithTrack(env, lease, { contentSha256, summary, track: new Uint8Array(trackGzip), decoderVersion })),
    defer: (lease, errorCode, retryAfterSeconds) => call(() => decode.deferDecode(env, lease, errorCode, { retryAfterSeconds })),
    retry: (lease, errorCode) => call(() => decode.retryDecode(env, lease, errorCode)),
    suspend: (lease, errorCode) => call(() => decode.suspendDecode(env, lease, errorCode)),
    fail: (lease, errorCode) => call(() => decode.failDecode(env, lease, errorCode)),
    reconcile: lease => call(() => decode.reconcileDecode(env, lease)),
  };
}

/**
 * Owns the decoder's lifecycle. `readKey()` returns the current DJI key from the app config ('' when blank).
 * @param {{ env: object, readKey: () => string, workRoot: string, parserBinary: string, timeoutMs?: number,
 *   log?: Function, client?: object, parser?: Function, runner?: Function }} options
 */
export function createDecoderSupervisor({ env, readKey, workRoot = WORK_ROOT, parserBinary, timeoutMs = 240_000, log = () => {},
  client = createLocalClient(env), parser, runner = runDecoder,
  requireRamScratch = process.platform === 'linux', statfs = fs.statfsSync }) {
  let state = 'stopped', controller = null, running = null;
  const keyFile = path.join(workRoot, '.dji-api-key');
  // start, stop and reload run one at a time, in order: overlapping signals can never start two runners or race
  // the key file. A failure inside one step is recorded, never left as an unhandled rejection.
  let chain = Promise.resolve();
  const serial = step => {
    const next = chain.then(step, step).catch(error => { state = 'crashed'; log('decoder', `lifecycle_failed ${error?.code ?? 'error'}`); return state; });
    chain = next;
    return next;
  };

  function ramScratch() {
    if (!requireRamScratch) return true;
    try { return Number(statfs(workRoot).type) === TMPFS_MAGIC; } catch { return false; }
  }

  async function doStart() {
    if (running) return state;
    const key = String(readKey() ?? '').trim();
    if (!key) { state = 'waiting_for_key'; log('decoder', 'waiting_for_key'); return state; }
    if (!parser && !fs.existsSync(parserBinary)) { state = 'parser_unavailable'; log('decoder', 'parser_unavailable'); return state; }
    if (!ramScratch()) { state = 'scratch_not_ram'; log('decoder', 'scratch_not_ram'); return state; }
    try {
      await fsp.mkdir(workRoot, { recursive: true, mode: 0o700 });
      await fsp.rm(keyFile, { force: true });
      await fsp.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' });
      const parse = parser ?? (({ inputFile, workDir, signal }) => runParser({ binary: parserBinary, inputFile, workDir, keyFile, timeoutMs, signal }));
      controller = new AbortController();
      // Promise.resolve().then keeps a synchronous throw from the runner inside this promise chain.
      running = Promise.resolve().then(() => runner({ client, parser: parse, workRoot, signal: controller.signal,
        log: line => log('decoder', String(line).slice(0, 200)) }))
        .then(() => { state = 'stopped'; }, () => { state = 'crashed'; log('decoder', 'crashed'); })
        .finally(async () => { running = null; await fsp.rm(keyFile, { force: true }).catch(() => {}); });
      state = 'running';
      log('decoder', 'running');
      return state;
    } catch (error) {
      // Any failure before the runner owns the key copy removes it again.
      controller = null;
      await fsp.rm(keyFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function doStop() {
    controller?.abort();
    await running;
    controller = null;
    await fsp.rm(keyFile, { force: true }).catch(() => {});
    if (!['waiting_for_key', 'parser_unavailable', 'scratch_not_ram'].includes(state)) state = 'stopped';
    return state;
  }

  return {
    start: () => serial(doStart),
    stop: () => serial(doStop),
    /** Re-reads the key (e.g. after SIGHUP) and restarts the decoder accordingly. */
    reload: () => serial(async () => { await doStop(); state = 'stopped'; return doStart(); }),
    get state() { return state; },
  };
}
