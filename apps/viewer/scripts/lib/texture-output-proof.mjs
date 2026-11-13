import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ASSOCIATION_LIMITS, inspectEmbeddedTile, matchDeclaredFaces, renderContents } from './lod-texture-association.mjs';
import { createPinnedBasisDecoder, BASIS_PINS } from './pinned-basis-decoder.mjs';
import { compareAtlasLevelZero, streamRawAtlasRows } from './raw-atlas-rows.mjs';
import { TEXTURE_RELATION_POLICY } from './texture-relation-policy.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code: `lod_texture_${code}` }); };
const require = (value, code) => { if (!value) fail(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const base = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && !['.','..'].includes(value);
const relative = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\\')
  && !value.includes(':') && !/[\x00-\x20\x7f]/.test(value) && !path.posix.isAbsolute(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const identity = value => [value.dev,value.ino,value.mode,value.size,value.mtimeNs,value.ctimeNs].map(String).join(':');
const ascii = (a,b) => a < b ? -1 : a > b ? 1 : 0;

// This is a relation component, not a recovery admission API. Tests may supply
// small decoder/row iterators here; the real filesystem entrypoint below always
// constructs the SHA-pinned decoder and actual, reaped GDAL row subprocesses.
export async function compareUsedTileImages({ tile, fullDetail, atlases, decoder, rows, checkpoint = () => {}, onMetric = () => {} }) {
  require(tile?.images instanceof Map && tile.images.size > 0 && typeof decoder?.levels === 'function', 'image_inputs');
  require(typeof fullDetail === 'boolean' && typeof rows === 'function', 'image_inputs');
  if (fullDetail) require(atlases instanceof Map && atlases.size === tile.images.size
    && [...tile.images.keys()].every(name => atlases.has(name)), 'raw_image_closure');
  let images = 0, mips = 0, comparedPixels = 0;
  for (const [name,image] of tile.images) {
    checkpoint(); let next = 0, metric = null;
    for await (const decoded of decoder.levels(image)) {
      checkpoint();
      const width = Math.max(1,image.width >> next), height = Math.max(1,image.height >> next);
      require(next < image.levels && decoded?.level === next && decoded.width === width && decoded.height === height
        && decoded.rgba instanceof Uint8Array && decoded.rgba.byteLength === width * height * 4, 'decoded_mip_sequence');
      if (fullDetail && next === 0) {
        const atlas = atlases.get(name);
        require(atlas.width === width && atlas.height === height && digest(atlas.sha256), 'raw_image_dimensions');
        metric = await compareAtlasLevelZero({ rows: rows(atlas), rgba: decoded.rgba, width,height,checkpoint });
        require(metric.candidatePass === true && metric.calibrationRequired === true, 'photographic_relation_failed');
        comparedPixels += width * height;
      }
      next++; mips++;
    }
    require(next === image.levels && (!fullDetail || metric), 'decoded_mips_incomplete');
    // Publish a metric only after the whole image iterator closed/deleted its
    // native texture. A failed/abandoned lower mip cannot become a pass.
    await onMetric({ imageIdentity: name, encodedSha256: image.sha256, width: image.width,
      height: image.height, decodedMips: next, fullDetail, ...(metric ? { metric } : {}) });
    checkpoint(); images++;
  }
  return { images, mips, comparedPixels };
}

// Immutable source/slot mounts and an externally enforced memory/time/process
// budget are REQUIRED. Run this in a one-shot child, never the lease owner or a
// long-lived web process. It reads data only; no provenance or ready flag is written.
export async function proveTextureOutput({ output, basisJavascript, basisWasm, signal = null,
  checkpoint = () => {}, python = '/usr/bin/python3' } = {}) {
  const check = () => { signal?.throwIfAborted(); checkpoint(); signal?.throwIfAborted(); };
  check();
  require(typeof output === 'string' && path.isAbsolute(output) && path.resolve(output) === output
    && await fs.promises.realpath(output) === output && (await fs.promises.lstat(output)).isDirectory(), 'output_path');
  const tracked = new Map();
  const absolute = name => { require(relative(name), 'output_relative'); return path.join(output,...name.split('/')); };
  async function open(name, maximum) {
    check(); const filename = absolute(name);
    require(await fs.promises.realpath(filename) === filename, 'output_link');
    const file = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const stat = await file.stat({ bigint: true });
      require(stat.isFile() && stat.size > 0n && stat.size <= BigInt(maximum), 'output_file_budget');
      const id = identity(stat), previous = tracked.get(name);
      require(!previous || previous.id === id, 'output_changed');
      require(previous || tracked.size < 100000, 'output_inventory_budget');
      tracked.set(name, { id, byteLength: Number(stat.size) });
      return { file, stat, filename, id };
    } catch (error) { await file.close(); throw error; }
  }
  async function read(name, maximum) {
    const current = await open(name,maximum);
    try {
      const bytes = Buffer.alloc(Number(current.stat.size)); let at = 0;
      while (at < bytes.length) { check(); const got = await current.file.read(bytes,at,Math.min(1024 ** 2,bytes.length-at),at);
        require(got.bytesRead > 0, 'output_short_read'); at += got.bytesRead; }
      require(identity(await current.file.stat({ bigint:true })) === current.id, 'output_changed');
      check(); const hash = sha(bytes), old = tracked.get(name);
      require(!old.sha256 || old.sha256 === hash, 'output_changed'); old.sha256 = hash;
      return bytes;
    } finally { await current.file.close(); }
  }
  async function* records(name, expectedSha, maximumRecords = 5_000_000) {
    require(digest(expectedSha), 'proof_digest');
    const current = await open(name,2 * 1024 ** 3);
    try {
      const hash = crypto.createHash('sha256'); let tail = Buffer.alloc(0), count = 0, offset = 0;
      const block = Buffer.alloc(64 * 1024);
      while (offset < Number(current.stat.size)) {
          check(); const got = await current.file.read(block,0,Math.min(block.length,Number(current.stat.size)-offset),offset);
          require(got.bytesRead > 0, 'output_short_read'); offset += got.bytesRead;
          const chunk = block.subarray(0,got.bytesRead);
          check(); hash.update(chunk); tail = Buffer.concat([tail,chunk]); let end;
          while ((end = tail.indexOf(10)) >= 0) {
            require(end > 0 && end <= 1024 ** 2 && ++count <= maximumRecords, 'proof_record_budget');
            const line = tail.subarray(0,end); tail = tail.subarray(end+1);
            let value; try { value = JSON.parse(line.toString('utf8')); } catch { fail('proof_json'); }
            require(value && typeof value === 'object' && !Array.isArray(value), 'proof_json');
            yield value;
          }
          require(tail.length <= 1024 ** 2, 'proof_record_budget'); tail = Buffer.from(tail);
      }
      require(tail.length === 0 && count > 0 && hash.digest('hex') === expectedSha, 'proof_digest_or_framing');
      require(identity(await current.file.stat({ bigint:true })) === current.id, 'output_changed');
      tracked.get(name).sha256 = expectedSha; check();
    } finally { await current.file.close(); }
  }
  const tilesetBytes = await read('tileset.json',ASSOCIATION_LIMITS.jsonBytes);
  const contents = renderContents(JSON.parse(tilesetBytes));
  require(contents.length <= 8192, 'render_inventory_budget');
  require(contents.filter(value => value.fullDetail).length <= 4096, 'lod0_inventory_budget');
  // Reject aliases before decoding or producing a host inventory.
  require(new Set(contents.map(value => value.uri.toLowerCase())).size === contents.length, 'content_alias');
  async function library(filename, maximum) {
    require(typeof filename === 'string' && path.isAbsolute(filename), 'basis_path');
    const file = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const before = await file.stat({ bigint:true });
      require(before.isFile() && before.size > 0n && before.size <= BigInt(maximum), 'basis_file_budget');
      const bytes = Buffer.alloc(Number(before.size)); let at = 0;
      while (at < bytes.length) { check(); const got = await file.read(bytes,at,bytes.length-at,at);
        require(got.bytesRead > 0, 'basis_short_read'); at += got.bytesRead; }
      require(identity(before) === identity(await file.stat({ bigint:true })), 'basis_changed');
      return bytes;
    } finally { await file.close(); }
  }
  const javascript = await library(basisJavascript,128 * 1024), wasm = await library(basisWasm,1024 ** 2);
  const decoder = await createPinnedBasisDecoder({ javascript,wasm,signal,checkpoint:check });
  const renderArtifacts = [{ uri:'tileset.json', sha256:sha(tilesetBytes), byteLength:tilesetBytes.length }];
  const inventory = { schemaVersion:1,scope:'reachable-lod0-b3dm-v1',tiles:[] };
  const metrics = crypto.createHash('sha256').update('ltds-texture-image-metrics-v1\0');
  let images = 0, mips = 0, comparedPixels = 0, declaredTriangles = 0;
  for (const content of [...contents].sort((a,b) => ascii(a.uri,b.uri))) {
    check(); const bytes = await read(content.uri,ASSOCIATION_LIMITS.fileBytes), b3dmSha256 = sha(bytes);
    const tile = inspectEmbeddedTile(bytes,{ checkpoint:check });
    require(images + tile.images.size <= 100000, 'image_inventory_budget');
    renderArtifacts.push({ uri:content.uri,sha256:b3dmSha256,byteLength:bytes.length });
    let atlases = null;
    if (content.fullDetail) {
      const directory = path.posix.dirname(content.uri), stem = path.posix.basename(content.uri,'.b3dm');
      const manifestRelativePath = `${directory}/${stem}.texture-mapping-manifest.json`;
      const descriptor = JSON.parse(await read(manifestRelativePath,1024 ** 2));
      require(descriptor.schemaVersion === 1 && descriptor.policy === 'bounded-texture-mapping-candidate-v1'
        && descriptor.b3dmIdentity === `${stem}.b3dm` && descriptor.b3dmSha256 === b3dmSha256
        && descriptor.mappingIdentity === `${stem}.texture-mapping.jsonl` && relative(descriptor.proofRelativePath)
        && digest(descriptor.mappingSha256) && digest(descriptor.proofManifestSha256), 'descriptor_binding');
      const mappingPath = `${directory}/${descriptor.mappingIdentity}`;
      const relation = await matchDeclaredFaces(tile,records(mappingPath,descriptor.mappingSha256),{checkpoint:check});
      declaredTriangles += relation.declaredTriangles;
      require(declaredTriangles <= 10_000_000, 'candidate_triangle_budget');
      const proofPath = `${directory}/${descriptor.proofRelativePath}`; atlases = new Map();
      for await (const record of records(proofPath,descriptor.proofManifestSha256,4096)) {
        require(record.schemaVersion === 1 && base(record.identity) && record.identity.endsWith('.png')
          && !atlases.has(record.identity) && digest(record.sha256) && Number.isSafeInteger(record.byteSize)
          && record.byteSize > 0 && record.byteSize <= 2 * 1024 ** 3
          && [record.width,record.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384), 'raw_atlas_record');
        const relativePath = `${path.posix.dirname(proofPath)}/${record.identity}`;
        const raw = await open(relativePath,record.byteSize);
        try { require(Number(raw.stat.size) === record.byteSize, 'raw_atlas_size'); }
        finally { await raw.file.close(); }
        atlases.set(record.identity,{...record,relativePath,filename:absolute(relativePath)});
      }
      inventory.tiles.push({b3dmRelativePath:content.uri,manifestRelativePath,b3dmSha256});
    }
    const result = await compareUsedTileImages({ tile,fullDetail:content.fullDetail,atlases,decoder,checkpoint:check,
      rows: atlas => streamRawAtlasRows({ filename:atlas.filename,sha256:atlas.sha256,width:atlas.width,height:atlas.height,
        signal,checkpoint:check,python }),
      onMetric: metric => { metrics.update(JSON.stringify({ content:content.uri,...metric })).update('\n'); } });
    images += result.images; mips += result.mips; comparedPixels += result.comparedPixels;
  }
  // Whole operation fence: files from early tiles remain the same through the
  // final decode. Parent custody additionally rehashes the sealed manifest.
  for (const [name,before] of tracked) {
    check(); const filename = absolute(name);
    require(await fs.promises.realpath(filename) === filename
      && identity(await fs.promises.lstat(filename,{ bigint:true })) === before.id, 'output_changed');
  }
  const receipt = { schemaVersion:1,scope:'full-render-mip-decode-and-lod0-photographic-relation-v1',
    tilesetSha256:sha(tilesetBytes),renderArtifacts,expectedLod0Inventory:inventory,
    expectedLod0InventorySha256:sha(Buffer.from(JSON.stringify(inventory))),
    renderContents:contents.length,lod0Contents:inventory.tiles.length,declaredTriangles,images,mips,comparedPixels,
    orderedImageMetricsSha256:metrics.digest('hex'),basisPins:{...BASIS_PINS},policy:{...TEXTURE_RELATION_POLICY},
    candidatePass:true,calibrationRequired:true,sourceUvAssociationVerified:false,
    rawAtlasSourcePixelEqualityVerified:false,geometryVerified:false,ready:false };
  require(Buffer.byteLength(JSON.stringify(receipt)) <= 4 * 1024 ** 2, 'receipt_budget');
  return receipt;
}
