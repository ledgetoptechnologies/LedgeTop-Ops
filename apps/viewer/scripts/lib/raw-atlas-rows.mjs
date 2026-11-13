import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { TextureRelationAccumulator } from './texture-relation-policy.mjs';
const SCRIPT = fileURLToPath(new URL('../stream_atlas_rows.py', import.meta.url));
const fail = code => Object.assign(new Error(code), { code: `lod_texture_${code}` });
function dimensions(width, height) {
  if (![width,height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) throw fail('raw_dimensions');
}

// Pure framing parser. Bounded chunks/one partial row; no full-image buffering.
export async function* parseAtlasRows(chunks, { width, height, sha256, checkpoint = () => {} }) {
  dimensions(width, height);
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw fail('raw_digest');
  let pending = Buffer.alloc(0), header = null, row = 0;
  for await (const chunk of chunks) {
    checkpoint();
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 ** 2) throw fail('raw_chunk_budget');
    pending = Buffer.concat([pending, chunk]);
    if (!header) {
      const end = pending.indexOf(10);
      if (end < 0) { if (pending.length > 4096) throw fail('raw_header'); continue; }
      if (end > 4096) throw fail('raw_header');
      try { header = JSON.parse(pending.subarray(0,end).toString('utf8')); } catch { throw fail('raw_header'); }
      const keys = ['protocol','schemaVersion','width','height','rowBytes','sha256','interpretation','gdalVersion'].sort();
      if (!header || Array.isArray(header) || Object.keys(header).sort().join('|') !== keys.join('|')
        || header.protocol !== 'ltds-rgba-rows-v1' || header.schemaVersion !== 1
        || header.width !== width || header.height !== height || header.rowBytes !== width * 4 || header.sha256 !== sha256
        || header.interpretation !== 'rgba8-straight-srgb-byte-values-no-transform'
        || typeof header.gdalVersion !== 'string' || header.gdalVersion.length > 64) throw fail('raw_header');
      pending = pending.subarray(end + 1);
    }
    while (pending.length >= width * 4) {
      checkpoint(); if (row >= height) throw fail('raw_extra_bytes');
      const rgba = pending.subarray(0,width * 4); pending = pending.subarray(width * 4);
      yield { y: row++, rgba, header };
    }
    // Avoid a tiny tail retaining a large stdout chunk across the next read.
    pending = Buffer.from(pending);
  }
  if (!header || pending.length || row !== height) throw fail('raw_incomplete');
  checkpoint();
}

// Trusted host configuration supplies python, never a request/model field.
// Child has no network/PAM/sidecar discovery, keeps bounded stderr, and is
// awaited/reaped on success, error, cancellation and early iterator return.
export async function* streamRawAtlasRows({ filename, sha256, width, height, signal = null,
  checkpoint = () => {}, python = '/usr/bin/python3', timeoutMs = 300000 } = {}) {
  dimensions(width, height);
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')
    || !/^[a-f0-9]{64}$/.test(sha256 || '') || typeof python !== 'string' || !path.isAbsolute(python)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw fail('raw_input');
  const check = () => { signal?.throwIfAborted(); checkpoint(); signal?.throwIfAborted(); };
  check();
  const child = spawn(python, [SCRIPT,'--input',filename,'--sha256',sha256,'--width',String(width),'--height',String(height)],
    { stdio: ['ignore','pipe','pipe'], windowsHide: true, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE:'1',
      PYTHONDONTWRITEBYTECODE:'1', GDAL_PAM_ENABLED:'NO', GDAL_DISABLE_READDIR_ON_OPEN:'EMPTY_DIR', GDAL_NUM_THREADS:'1',
      OMP_NUM_THREADS:'1', OPENBLAS_NUM_THREADS:'1' } });
  let closed = false, problem = null, stderrBytes = 0, killTimer;
  const completion = new Promise(resolve => {
    child.once('error', () => { problem ||= fail('raw_unavailable'); });
    child.once('close', (code, killedBy) => { closed = true; resolve({ code, killedBy }); });
  });
  const stop = error => {
    problem ||= error;
    if (!closed) { child.kill('SIGTERM'); killTimer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000); }
  };
  const abort = () => stop(signal.reason || fail('raw_cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => stop(fail('raw_timeout')), timeoutMs);
  child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 4096) stop(fail('raw_stderr_budget')); });
  let finished = false;
  try {
    for await (const row of parseAtlasRows(child.stdout, { width,height,sha256,checkpoint: check })) {
      if (problem) throw problem;
      yield row;
    }
    const result = await completion;
    check(); if (problem) throw problem;
    if (result.code !== 0 || result.killedBy) throw fail('raw_child_failed');
    finished = true;
  } catch (error) {
    throw problem || error;
  } finally {
    if (!finished && !closed) stop(problem || fail('raw_reader_stopped'));
    await completion;
    clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
  }
}

export async function compareAtlasLevelZero({ rows, rgba, width, height, checkpoint = () => {} }) {
  dimensions(width, height);
  if (!(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4) throw fail('raw_decoded_size');
  const value = new TextureRelationAccumulator({ width,height });
  let rawDecoder = null;
  for await (const row of rows) {
    checkpoint(); rawDecoder = { interpretation: row.header.interpretation,
      gdalVersion: row.header.gdalVersion, sourceSha256: row.header.sha256 };
    const start = row.y * width * 4;
    value.addRows(row.y,row.rgba,rgba.subarray(start,start + width * 4));
  }
  // streamRawAtlasRows must first observe Python's final hash check/exit0 and
  // reap the child. Consuming the last row alone is not success.
  checkpoint(); return { ...value.finish(), rawDecoder };
}
