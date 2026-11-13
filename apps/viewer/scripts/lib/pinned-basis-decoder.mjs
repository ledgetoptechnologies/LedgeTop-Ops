import crypto from 'node:crypto';
import vm from 'node:vm';
import { inspectKtx } from './lod-texture-association.mjs';

export const BASIS_PINS = Object.freeze({
  javascript: '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
  wasm: '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a',
});
const fail = code => { throw Object.assign(new Error(code), { code: `lod_texture_${code}` }); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function inspectKtxSampling(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('basis_input');
  const metadata = inspectKtx(bytes);
  const ranges = [], addRange = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 80 + metadata.levels * 24
      || length < 1 || offset + length > bytes.length) fail('ktx_metadata_bounds');
    ranges.push([offset, offset + length]);
  };
  if (bytes.readUInt32LE(12) !== 0 || bytes.readUInt32LE(16) !== 1 || bytes.readUInt32LE(44) !== 1) fail('ktx_codec_profile');
  const dfd = bytes.readUInt32LE(48), dfdLength = bytes.readUInt32LE(52);
  addRange(dfd,dfdLength);
  if (![44,60].includes(dfdLength) || bytes.readUInt32LE(dfd) !== dfdLength || bytes.readUInt32LE(dfd + 4) !== 0
    || bytes.readUInt16LE(dfd + 8) !== 2 || bytes.readUInt16LE(dfd + 10) !== dfdLength - 4
    || bytes[dfd + 12] !== 163 || bytes[dfd + 13] !== 1 || bytes[dfd + 14] !== 2 || bytes[dfd + 15] !== 0) fail('ktx_color_alpha_profile');
  const kv = bytes.readUInt32LE(56), kvLength = bytes.readUInt32LE(60), keys = new Set();
  if (kvLength) {
    addRange(kv,kvLength); let at = kv;
    while (at < kv + kvLength) {
      if (at + 4 > kv + kvLength) fail('ktx_key_value');
      const length = bytes.readUInt32LE(at); at += 4;
      if (!length || length > 2048 || at + length > kv + kvLength) fail('ktx_key_value');
      const entry = bytes.subarray(at,at + length), zero = entry.indexOf(0);
      if (zero < 1) fail('ktx_key_value');
      const key = entry.subarray(0,zero).toString('utf8'), value = entry.subarray(zero + 1).toString('utf8').replace(/\0$/, '');
      if (keys.has(key) || !['KTXwriter','KTXwriterScParams','KTXorientation','KTXswizzle'].includes(key)) fail('ktx_key_value');
      keys.add(key);
      if (key === 'KTXorientation' && value !== 'rd' || key === 'KTXswizzle' && value !== 'rgba') fail('ktx_orientation_swizzle');
      at += Math.ceil(length / 4) * 4;
    }
    if (at !== kv + kvLength) fail('ktx_key_value');
  }
  addRange(Number(bytes.readBigUInt64LE(64)),Number(bytes.readBigUInt64LE(72)));
  for (let level = 0; level < metadata.levels; level++)
    addRange(Number(bytes.readBigUInt64LE(80 + level * 24)),Number(bytes.readBigUInt64LE(88 + level * 24)));
  ranges.sort((a,b) => a[0] - b[0]);
  if (ranges.some((range,index) => index && range[0] < ranges[index - 1][1])) fail('ktx_metadata_overlap');
  return { ...metadata, colorDomain: 'srgb-byte-values', alphaMode: 'straight', orientation: 'rd', swizzle: 'rgba' };
}
function copyPinned(value, maximum, expected) {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum
    || typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) fail('basis_input');
  const copy = Buffer.from(value);
  if (sha(copy) !== expected) fail('basis_pin');
  return copy;
}

// Isolated proof child only. No untrusted model text is evaluated: both library
// payloads are copied and SHA-pinned before trusted Emscripten code is compiled.
export async function createPinnedBasisDecoder({ javascript, wasm, signal = null, checkpoint = () => {} } = {}) {
  const check = () => { signal?.throwIfAborted(); checkpoint(); signal?.throwIfAborted(); };
  check();
  const source = copyPinned(javascript, 128 * 1024, BASIS_PINS.javascript);
  const wasmBinary = copyPinned(wasm, 1024 * 1024, BASIS_PINS.wasm);
  check();
  const quiet = Object.freeze({ log() {}, warn() {}, error() {} });
  const context = vm.createContext({ console: quiet, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance },
    { codeGeneration: { strings: true, wasm: true } });
  vm.runInContext(source.toString('utf8'), context, { timeout: 5000 });
  if (typeof context.BASIS !== 'function') fail('basis_factory');
  let timer, module;
  try {
    module = await Promise.race([context.BASIS({ wasmBinary }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('basis timeout'), { code: 'lod_texture_basis_timeout' })), 10000);
    })]);
    check(); module.initializeBasis();
  } finally { clearTimeout(timer); }
  if (typeof module.KTX2File !== 'function') fail('basis_factory');
  let active = false;
  return Object.freeze({
    async *levels(image) {
      check(); if (active) fail('basis_busy');
      const metadata = inspectKtxSampling(image.bytes);
      if (['width','height','levels'].some(key => image[key] !== metadata[key])) fail('basis_metadata');
      active = true; let texture;
      try {
        // A view avoids the fixture decoder's full encoded-data JS copy. The
        // native KTX object owns its encoded input until close/delete below.
        texture = new module.KTX2File(new Uint8Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
        if (!texture.isValid() || !texture.startTranscoding() || texture.getLevels() !== metadata.levels
          || texture.isUASTC() || texture.getDFDColorModel() !== 163 || texture.getDFDColorPrimaries() !== 1
          || texture.getDFDTransferFunc() !== 2 || texture.getDFDFlags() !== 0) fail('basis_decode');
        for (let level = 0; level < metadata.levels; level++) {
          check();
          const width = Math.max(1, metadata.width >> level), height = Math.max(1, metadata.height >> level);
          const info = texture.getImageLevelInfo(level, 0, 0);
          if (info.origWidth !== width || info.origHeight !== height) fail('basis_dimensions');
          const size = texture.getImageTranscodedSizeInBytes(level, 0, 0, 13);
          if (size !== width * height * 4 || size > 1024 ** 3) fail('basis_rgba_budget');
          // At most one mip buffer is retained by this generator. Consumers
          // must finish/release it before requesting the next mip.
          const rgba = new Uint8Array(size);
          if (!texture.transcodeImage(rgba, level, 0, 0, 13, 0, -1, -1)) fail('basis_transcode');
          check(); yield { level, width, height, rgba };
        }
      } finally {
        try { texture?.close(); } finally { try { texture?.delete(); } finally { active = false; } }
      }
    },
  });
}
