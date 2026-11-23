'use strict';

// Integrity-checked file responses served from the descriptor that was
// verified.
//
// Before this module, routes verified an asset's bytes by path and then
// res.sendFile() reopened the path, so a file replaced or rewritten between
// the check and the send could be served unverified. Here the file is opened
// once; every registered byte that is sent is verified through that descriptor
// (assetIntegrityCache keys on its fstat identity) and the descriptor identity
// is re-checked before the first byte. Then:
//
// - Assets with registered regions (4 MiB chunks, or a whole file small enough
//   to buffer: tiles, EPT nodes, small photos) send exactly the bytes that were
//   hashed: each region is read once into memory through the descriptor,
//   hashed, and that buffer (sliced to the range) is what gets written. Only
//   the first region of the body is hashed before the headers: a mismatch
//   there is a clean error. Every other region is hashed right before its own
//   bytes are written, so a mismatch in it aborts the response: the client
//   gets a broken transfer, never a complete one. Where results are not
//   remembered (non-POSIX or network filesystems), the pre-header check hands
//   its buffer to the same response through a per-request carry, so each
//   region is still read and hashed once per request. The carry is reserved
//   whole, once, before anything is read; a response never waits for buffer
//   budget while holding some (see assetIntegrityCache.createCarry).
// - Responses that send no file bytes (304, 412, 416 and every HEAD) hash
//   nothing. They still require a valid registered record: it exists, the size
//   matches, and its chunk rows cover the requested range or the whole file.
// - Large whole-file assets with no chunk records (legacy rasters) are
//   OUTSIDE the byte-integrity guarantee above, by decision: they keep the
//   behaviour inherited from before (the whole file is hashed on every
//   request, then the bytes are streamed, so streamed bytes are not the hashed
//   bytes). None of the new optimisations apply to them (no remembered result,
//   no shared check, no kept bytes; see assetIntegrityCache.isLegacyWholeFile).
//   The stream reads the descriptor that was hashed and a closing fstat aborts
//   on a visible change, which is no weaker than res.sendFile reopening the
//   path. Backfilling chunk records is the fix and a separate follow-up.
//
// Busy handling: when buffer budget or the check queue is exhausted
// (integrity_busy), a request that has not sent any body byte gets 503 with
// Retry-After: 1 and none of the response headers set for the file. Once body
// bytes have been sent, the status line is committed: the response waits for
// budget in a longer bounded queue (it holds none meanwhile) and, only if that
// is full too, is aborted (socket destroyed) and the client retries.
//
// Response headers and statuses mirror send@0.19 (what res.sendFile uses):
// Accept-Ranges, Cache-Control default, Last-Modified, weak ETag, Content-Type
// from the extension, 304/412 conditional handling, If-Range, single-range 206
// with Content-Range, multi/invalid ranges served as 200, and 416 with
// `Content-Range: bytes */size` reported through the route's error callback.

const fs = require('node:fs');
const express = require('express');
const { fileIdentity, assetIntegrityCache } = require('./assetIntegrityCache');

const mime = express.static.mime;
const BYTES_RANGE_REGEXP = /^ *bytes=/;
const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;
const CHUNK_BYTES = 64 * 1024; // fs.ReadStream default, as send uses
const STATUS_TEXT = { 412: 'Precondition Failed', 416: 'Range Not Satisfiable' };

// Test seam: awaited after verification and before any byte is sent.
const hooks = { afterVerify: null };

function parseHttpDate(date) {
  const timestamp = date && Date.parse(date);
  return typeof timestamp === 'number' ? timestamp : NaN;
}

function parseTokenList(str) {
  const list = [];
  let start = 0, end = 0;
  for (let i = 0; i < str.length; i += 1) {
    switch (str.charCodeAt(i)) {
      case 0x20: if (start === end) { start = end = i + 1; } break;
      case 0x2c: list.push(str.substring(start, end)); start = end = i + 1; break;
      default: end = i + 1; break;
    }
  }
  list.push(str.substring(start, end));
  return list;
}

function fresh(reqHeaders, etag, lastModified) {
  const modifiedSince = reqHeaders['if-modified-since'];
  const noneMatch = reqHeaders['if-none-match'];
  if (!modifiedSince && !noneMatch) return false;
  const cacheControl = reqHeaders['cache-control'];
  if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) return false;
  if (noneMatch && noneMatch !== '*') {
    if (!etag) return false;
    if (parseTokenList(noneMatch).every((match) => match !== etag && match !== `W/${etag}` && `W/${match}` !== etag)) return false;
  }
  if (modifiedSince && (!lastModified || !(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince)))) return false;
  return true;
}

function preconditionFailed(reqHeaders, etag, lastModified) {
  const match = reqHeaders['if-match'];
  if (match) {
    return !etag || (match !== '*' && parseTokenList(match).every((value) => value !== etag && value !== `W/${etag}` && `W/${value}` !== etag));
  }
  const unmodifiedSince = parseHttpDate(reqHeaders['if-unmodified-since']);
  if (!Number.isNaN(unmodifiedSince)) {
    const modified = parseHttpDate(lastModified);
    return Number.isNaN(modified) || modified > unmodifiedSince;
  }
  return false;
}

function rangeFresh(reqHeaders, etag, lastModified) {
  const ifRange = reqHeaders['if-range'];
  if (!ifRange) return true;
  // A strong route ETag needs the strong comparison If-Range asks for; the
  // default weak ETag keeps send's behaviour.
  if (ifRange.indexOf('"') !== -1) return Boolean(etag && (etag.startsWith('W/') ? ifRange.indexOf(etag) !== -1 : ifRange.trim() === etag));
  return parseHttpDate(lastModified) <= parseHttpDate(ifRange);
}

function httpError(status) {
  return Object.assign(new Error(STATUS_TEXT[status] || String(status)), { status, statusCode: status, expose: true });
}

async function openForDelivery(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Resolves on drain, on close, or on cancellation, including when the
// response already closed before this was called (no further events come).
function waitForDrain(res, signal) {
  if (signal?.aborted || res.destroyed || res.closed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { res.removeListener('drain', done); res.removeListener('close', done); signal?.removeEventListener('abort', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Streams [start, start+len) from `handle`, holding back the last chunk until
// the descriptor identity is re-confirmed. Throws on change or truncation.
async function pump(res, handle, identity, start, len, signal) {
  const end = start + len;
  let position = start;
  let held = null;
  while (position < end) {
    if (signal.aborted) return;
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error('asset truncated during delivery');
    position += bytesRead;
    if (held && !res.write(held)) await waitForDrain(res, signal);
    held = buffer.subarray(0, bytesRead);
  }
  if (signal.aborted) return;
  if (fileIdentity(await handle.stat({ bigint: true })) !== identity) throw new Error('asset changed during delivery');
  res.end(held || undefined);
}

// Writes [start, end] from registered regions, each one exactly-verified
// bytes (see assetIntegrityCache.verifiedSlice). Throws on mismatch or gap.
async function sendRegions(res, cache, filePath, stat, handle, regions, start, end, signal, carry) {
  let position = start;
  for (const region of regions) {
    if (signal.aborted) return;
    if (region.offset > position || region.offset + region.size <= position) throw new Error('asset region table does not cover the response');
    const sliceEnd = Math.min(end + 1, region.offset + region.size);
    const piece = await cache.verifiedSlice(filePath, stat, region, position, sliceEnd, { handle, signal, carry, started: res.headersSent });
    if (!piece) throw new Error('asset bytes failed verification during delivery');
    try {
      if (!res.write(piece.bytes)) await waitForDrain(res, signal);
    } finally {
      piece.release();
    }
    position = sliceEnd;
    if (position > end) break;
  }
  if (signal.aborted) return;
  if (position !== end + 1) throw new Error('asset region table does not cover the response');
  res.end();
}

function busyError(error) { return error?.code === 'integrity_busy'; }
function abortError(error) { return error?.name === 'AbortError'; }

// Delivers an opened file. Ownership of `handle` passes to this function.
//   check(range|null) -> boolean; the registered record exists, matches the
//     file size and covers the range (null: the whole file). Hashes nothing.
//   verify(range|null, signal, carry) -> Promise<boolean>; hashes the regions
//     of `range` (null: the whole file). With `regions`, it is called for the
//     part of the body inside the first region only. Without `check` it also
//     decides responses that send no file bytes.
//   onFailure()      -> route response for failed integrity (before any byte)
//   beforeSend()     -> optional; re-checks authorization after the (possibly
//                       slow) verification; returns false after responding.
//   onError(error)   -> route response for 412/416, like a sendFile callback.
//   headers          -> route headers applied once verification has passed.
//   cacheControl()   -> optional; Cache-Control for 200, 206 and 304 only,
//                       evaluated right before they are sent. Every other
//                       response keeps the route's own value.
//   regions(start,end) -> registered regions covering the body, in order, to
//                       send exactly-hashed bytes; null to stream (see top).
async function deliverVerified(req, res, { handle, stat, filePath, verify, check = null, onFailure, onError, beforeSend = null, headers = {}, cacheControl = null, regions = null, cache = assetIntegrityCache }) {
  const identity = fileIdentity(stat);
  const size = Number(stat.size);
  const controller = new AbortController();
  let carry = null;
  const onClose = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', onClose);
  try {
    if (res.headersSent) return;
    // Last-Modified and ETag come from a regular (non-bigint) fstat so they use
    // the exact Date conversion send@0.19/etag apply to fs.Stats.
    const plain = await handle.stat();
    const routeHeaders = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), [name, value]]));
    const has = (name) => res.getHeader(name) !== undefined || routeHeaders.has(name.toLowerCase());
    const get = (name) => (routeHeaders.get(name.toLowerCase()) || [])[1] ?? res.getHeader(name);
    const defaults = [];
    if (!has('Accept-Ranges')) defaults.push(['Accept-Ranges', 'bytes']);
    if (!has('Cache-Control')) defaults.push(['Cache-Control', 'public, max-age=0']);
    if (!has('Last-Modified')) defaults.push(['Last-Modified', plain.mtime.toUTCString()]);
    if (!has('ETag')) defaults.push(['ETag', `W/"${plain.size.toString(16)}-${plain.mtime.getTime().toString(16)}"`]);
    if (!has('Content-Type')) {
      const type = mime.lookup(filePath);
      if (type) { const charset = mime.charsets.lookup(type); defaults.push(['Content-Type', type + (charset ? `; charset=${charset}` : '')]); }
    }
    const etag = get('ETag') ?? defaults.find(([name]) => name === 'ETag')?.[1];
    const lastModified = get('Last-Modified') ?? defaults.find(([name]) => name === 'Last-Modified')?.[1];

    let outcome = 200, range = null, unsatisfiable = false;
    const h = req.headers;
    if (typeof h.range === 'string' && BYTES_RANGE_REGEXP.test(h.range)) {
      let ranges = req.range(size, { combine: true });
      if (!rangeFresh(h, etag, lastModified)) ranges = -2;
      if (ranges === -1) unsatisfiable = true;
      else if (ranges !== -2 && ranges !== undefined && ranges.length === 1) range = { start: ranges[0].start, end: ranges[0].end };
    }
    if (h['if-match'] || h['if-unmodified-since'] || h['if-none-match'] || h['if-modified-since']) {
      const statusCode = res.statusCode;
      if (preconditionFailed(h, etag, lastModified)) outcome = 412;
      else if (((statusCode >= 200 && statusCode < 300) || statusCode === 304) && fresh(h, etag, lastModified)) outcome = 304;
    }
    if (outcome === 200) outcome = unsatisfiable ? 416 : range ? 206 : 200;

    // The body this response will send, and its registered regions.
    const bodyRange = req.method === 'HEAD' ? null
      : outcome === 206 ? range
        : outcome === 200 && size > 0 ? { start: 0, end: size - 1 } : null;
    const plan = bodyRange && typeof regions === 'function' ? regions(bodyRange.start, bodyRange.end) : null;
    const noBody = req.method === 'HEAD' || outcome === 304 || outcome === 412 || outcome === 416;
    // The part of the body to hash before the headers.
    let verifyRange = outcome === 206 ? range : null;
    if (plan?.length && plan[0].offset <= bodyRange.start && plan[0].offset + plan[0].size > bodyRange.start) {
      verifyRange = { start: bodyRange.start, end: Math.min(bodyRange.end, plan[0].offset + plan[0].size - 1) };
    }

    let verified;
    try {
      verified = check ? await check(range) : true;
      if (verified && !(check && noBody)) {
        if (plan && !await cache.filesystemCacheable(filePath, stat.dev)) {
          carry = cache.createCarry();
          await cache.reserveCarry(carry, cache.carryBytesFor(plan.slice(0, 1)), controller.signal);
        }
        verified = await verify(verifyRange, controller.signal, carry);
      }
    } catch (error) {
      if (abortError(error) || controller.signal.aborted) return;
      if (busyError(error)) {
        if (!res.headersSent) res.set('Retry-After', '1').status(503).json({ error: 'asset delivery busy', code: 'integrity_busy' });
        return;
      }
      verified = false;
    }
    if (controller.signal.aborted || res.headersSent) return;
    if (verified && hooks.afterVerify) await hooks.afterVerify({ filePath, range });
    if (!verified || fileIdentity(await handle.stat({ bigint: true })) !== identity) return onFailure();
    if (beforeSend && !await beforeSend()) return;
    if (controller.signal.aborted || res.headersSent) return;

    const replaced = [...[...routeHeaders.values()].map(([name]) => name), ...defaults.map(([name]) => name), 'Cache-Control', 'Content-Range', 'Content-Length']
      .map((name) => [name, res.getHeader(name)]);
    for (const [name, value] of routeHeaders.values()) res.setHeader(name, value);
    for (const [name, value] of defaults) res.setHeader(name, value);
    if (outcome === 412) return onError(httpError(412));
    if (cacheControl && outcome !== 416) res.setHeader('Cache-Control', cacheControl());
    if (outcome === 304) {
      for (const name of ['Content-Encoding', 'Content-Language', 'Content-Length', 'Content-Range', 'Content-Type']) res.removeHeader(name);
      res.statusCode = 304;
      return res.end();
    }
    if (outcome === 416) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return onError(httpError(416));
    }
    let start = 0, len = size;
    if (outcome === 206) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      start = range.start;
      len = range.end - range.start + 1;
    }
    res.setHeader('Content-Length', len);
    if (req.method === 'HEAD') return res.end();
    try {
      if (plan) await sendRegions(res, cache, filePath, stat, handle, plan, start, start + len - 1, controller.signal, carry);
      else if (carry?.deferred) throw new Error('deferred region checks need a region plan');
      else await pump(res, handle, identity, start, len, controller.signal);
    } catch (error) {
      if (busyError(error) && !res.headersSent && !controller.signal.aborted) {
        for (const [name, value] of replaced) { if (value === undefined) res.removeHeader(name); else res.setHeader(name, value); }
        res.statusCode = 200;
        res.set('Retry-After', '1').status(503).json({ error: 'asset delivery busy', code: 'integrity_busy' });
        return;
      }
      res.destroy(error);
    }
  } finally {
    res.removeListener('close', onClose);
    cache.releaseCarry(carry);
    await handle.close().catch(() => {});
  }
}

module.exports = { deliverVerified, openForDelivery, hooks };
