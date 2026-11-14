'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stable } = require('../lod-converter-policy.cjs');
const { canonicalSupplement, relative, MAX_FILES, MAX_BYTES, MAX_MANIFEST_BYTES } = require('./derivativeSupplement');
const { immutableSupplementSlot } = require('./derivativeSupplementRegistration');
const { PinnedSupplementDirectory } = require('./derivativeSupplementFiles');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;
const CHUNK = 1024 * 1024;
const MAX_ENVELOPE = MAX_MANIFEST_BYTES;
const activeIntakes = new WeakMap();
function metadataHash(body, marker) { return sha(Buffer.concat([Buffer.from('ltds-recovery-intake-metadata-v1\0'), body, Buffer.from([0]), marker])); }
function mountId(fd) {
  const id = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^mnt_id:\s+(\d+)$/m)?.[1];
  if (!id) fail('supplement_mount_unbound');
  return id;
}
class IntakeRoot {
  constructor(root) {
    if (process.platform !== 'linux') fail('supplement_platform_unsupported');
    if (typeof root !== 'string' || !path.isAbsolute(root) || fs.realpathSync.native(root) !== path.resolve(root)) fail('supplement_root_unsafe');
    this.root = root; this.fd = fs.openSync(root, FLAGS | fs.constants.O_DIRECTORY);
    try { this.stat = fs.fstatSync(this.fd, { bigint: true }); this.mount = mountId(this.fd); }
    catch (error) { fs.closeSync(this.fd); throw error; }
  }
  check() {
    let fd;
    try {
      fd = fs.openSync(this.root, FLAGS | fs.constants.O_DIRECTORY);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev !== this.stat.dev || stat.ino !== this.stat.ino || mountId(fd) !== this.mount) fail('supplement_root_changed');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  directory(name, create = false) {
    relative(name); this.check();
    let fd = fs.openSync(`/proc/self/fd/${this.fd}/.`, FLAGS | fs.constants.O_DIRECTORY);
    try {
      for (const part of name.split('/')) {
        const entry = `/proc/self/fd/${fd}/${part}`;
        if (create) { try { fs.mkdirSync(entry, { mode: 0o700 }); fs.fsyncSync(fd); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
        const next = fs.openSync(entry, FLAGS | fs.constants.O_DIRECTORY);
        fs.closeSync(fd); fd = next;
        if (mountId(fd) !== this.mount) fail('supplement_mount_changed');
      }
      return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  close() { const fd = this.fd; this.fd = null; if (fd !== null) fs.closeSync(fd); }
}
function intakeLayout(operation, context, manifest, retainedPartBytes = 0) {
  if (!Number.isSafeInteger(retainedPartBytes) || retainedPartBytes < 0 || retainedPartBytes > MAX_BYTES) fail('supplement_intake_parts_limit');
  const parsed = canonicalSupplement(manifest), slot = immutableSupplementSlot(operation, context);
  if (parsed.supplementSha256 !== operation.supplement_sha256 || parsed.manifest.identity.attemptId !== context.attempt.id
    || parsed.manifest.identity.versionId !== context.version.id || parsed.manifest.identity.environment !== 'STAGING') fail('supplement_request_mismatch');
  const directories = new Set(), names = new Set(parsed.manifest.files.map(file => file.relativePath));
  for (const file of parsed.manifest.files) {
    const parts = file.relativePath.split('/');
    if (parts.length > 33) fail('supplement_intake_directory_limit');
    if (parts.some(part => Buffer.byteLength(part) > 255)) fail('supplement_intake_component_limit');
    if (parts.some((_, i) => i > 0 && names.has(parts.slice(0, i).join('/')))) fail('supplement_intake_path_conflict');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    if (directories.size + 1 > MAX_FILES * 2) fail('supplement_intake_directory_limit');
  }
  const body = Buffer.from(stable(parsed.manifest));
  if (body.length > MAX_ENVELOPE) fail('supplement_intake_manifest_limit');
  const parent = path.posix.dirname(slot), marker = Buffer.from(stable({ schemaVersion: 1,
    operationId: operation.id, leaseTokenSha256: sha(operation.lease_token), supplementSha256: parsed.supplementSha256,
    fileCount: parsed.manifest.files.length, byteSize: parsed.byteSize, retainedPartBytes }));
  return { ...parsed, slot, parent, body, marker, retainedPartBytes, partsPath: `${parent}/parts/${operation.lease_token}`,
    manifestPath: `${parent}/${operation.lease_token}.manifest.json`, markerPath: `${parent}/${operation.lease_token}.complete.json`,
    capacityBytes: parsed.byteSize + body.length + marker.length + (directories.size + parsed.manifest.files.length + 16) * 8192 };
}
async function write(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const count = await new Promise((resolve, reject) => fs.write(fd, data, offset, data.length - offset, null,
      (error, written) => error ? reject(error) : resolve(written)));
    if (!count) fail('supplement_intake_write_failed');
    offset += count;
  }
}
async function existingFile(parent, name, expected, check) {
  let fd;
  try { fd = fs.openSync(`/proc/self/fd/${parent}/${name}`, FLAGS | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || stat.size !== BigInt(expected.byteSize) || mountId(fd) !== mountId(parent)) fail('supplement_intake_existing_changed');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK); let offset = 0;
    while (offset < expected.byteSize) {
      check();
      const count = await new Promise((resolve, reject) => fs.read(fd, buffer, 0, Math.min(CHUNK, expected.byteSize - offset), offset,
        (error, read) => error ? reject(error) : resolve(read)));
      if (!count) fail('supplement_intake_existing_changed');
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(`/proc/self/fd/${parent}/${name}`, { bigint: true });
    if (hash.digest('hex') !== expected.sha256 || after.ino !== named.ino || after.dev !== named.dev || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) fail('supplement_intake_existing_changed');
    check(); return true;
  } finally { fs.closeSync(fd); }
}
async function immutableFile(root, relativePath, expected, load, check, partsPath) {
  const parent = root.directory(path.posix.dirname(relativePath), true), name = path.posix.basename(relativePath);
  let fd = null, temporary = null, identity = null, parts = null;
  try {
    if (await existingFile(parent, name, expected, check)) return;
    check();
    parts = root.directory(partsPath, true);
    temporary = `/proc/self/fd/${parts}/.receiver-${crypto.randomBytes(16).toString('hex')}.partial`;
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC, 0o600);
    identity = fs.fstatSync(fd, { bigint: true });
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const source = await load();
    for await (const chunk of source) {
      check();
      if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > CHUNK) fail('supplement_intake_chunk_limit');
      bytes += chunk.byteLength;
      if (bytes > expected.byteSize) fail('supplement_intake_size_mismatch');
      await write(fd, chunk); hash.update(chunk);
    }
    check();
    if (bytes !== expected.byteSize || hash.digest('hex') !== expected.sha256) fail('supplement_intake_hash_mismatch');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    // link is exclusive: unlike rename it cannot replace an existing final.
    fs.linkSync(temporary, `/proc/self/fd/${parent}/${name}`);
    fs.unlinkSync(temporary); temporary = null; fs.fsyncSync(parts); fs.fsyncSync(parent);
  } finally {
    try { if (fd !== null) fs.closeSync(fd); }
    finally {
      try {
        if (temporary && identity) {
          const stat = fs.lstatSync(temporary, { bigint: true });
          if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino) fs.unlinkSync(temporary);
          else fail('supplement_intake_cleanup_unbound');
        }
      } finally { try { if (parts !== null) fs.closeSync(parts); } finally { fs.closeSync(parent); } }
    }
  }
}

function retainedParts(root, layout, check) {
  const seen = new Set();
  for (const name of [...layout.manifest.files.map(file => `${layout.slot}/${file.relativePath}`), layout.manifestPath, layout.markerPath]) {
    let parent;
    try {
      parent = root.directory(path.posix.dirname(name));
      const stat = fs.lstatSync(`/proc/self/fd/${parent}/${path.posix.basename(name)}`, { bigint: true });
      if (!stat.isFile()) fail('supplement_intake_parts_unbound');
      seen.add(`${stat.dev}:${stat.ino}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { if (parent !== undefined) fs.closeSync(parent); }
  }
  const directory = root.directory(layout.partsPath, true); let bytes = 0;
  try {
    const entries = fs.readdirSync(`/proc/self/fd/${directory}`, { withFileTypes: true });
    if (entries.length > MAX_FILES * 2) fail('supplement_intake_parts_limit');
    for (const entry of entries) {
      check();
      if (!/^\.receiver-[a-f0-9]{32}\.partial$/.test(entry.name) || !entry.isFile()) fail('supplement_intake_parts_unbound');
      const fd = fs.openSync(`/proc/self/fd/${directory}/${entry.name}`, FLAGS | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || mountId(fd) !== root.mount) fail('supplement_intake_parts_unbound');
        const key = `${stat.dev}:${stat.ino}`;
        if (!seen.has(key)) { bytes += Number(stat.size); seen.add(key); }
        if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) fail('supplement_intake_parts_limit');
      } finally { fs.closeSync(fd); }
    }
    return bytes;
  } finally { fs.closeSync(directory); }
}

async function stageDerivativeSupplement({ service, storage, operationId, owner, leaseToken, manifest,
  readFile, assertWriteAdmission, environment, signal = null } = {}) {
  if (environment !== 'STAGING') fail('supplement_staging_only');
  if (!service || typeof readFile !== 'function' || typeof assertWriteAdmission !== 'function'
    || typeof storage?.requireSpace !== 'function') fail('supplement_intake_unavailable');
  signal?.throwIfAborted();
  const operation = service.heartbeat(operationId, owner, leaseToken), context = service.unchanged(operation);
  const layout = intakeLayout(operation, context, manifest);
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let active = activeIntakes.get(service.db);
  if (active?.has(operation.id)) fail('supplement_intake_busy');
  if (!active) { active = new Set(); activeIntakes.set(service.db, active); } active.add(operation.id);
  const heartbeat = setInterval(() => { try { service.heartbeat(operation.id, owner, leaseToken); } catch (error) { controller.abort(error); } }, 10000);
  const deadline = setTimeout(() => controller.abort(Object.assign(new Error('recovery intake deadline'), { code: 'recovery_deadline_exceeded' })), Math.max(1, Date.parse(operation.deadline_at) - Date.now()));
  let root, pinned;
  const check = () => {
    combined.throwIfAborted(); service.lease(operation.id, owner, leaseToken); service.authorize(operation.session_id, operation.subject);
    if (assertWriteAdmission({ operation, byteSize: layout.byteSize }) !== true) fail('supplement_intake_admission_lost');
    root?.check();
  };
  try {
    check(); const metadataReserve = layout.capacityBytes - layout.byteSize;
    storage.requireSpace('models', metadataReserve);
    root = new IntakeRoot(storage.roots.models);
    const output = root.directory(context.output.relative_path); fs.closeSync(output);
    const slot = root.directory(layout.slot, true);
    try {
      const stat = fs.fstatSync(slot, { bigint: true });
      if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n)) fail('supplement_intake_owner_mismatch');
    } finally { fs.closeSync(slot); }
    const existing = new Set(); let remaining = 0;
    for (const file of layout.manifest.files) {
      let parent;
      try {
        parent = root.directory(path.posix.dirname(`${layout.slot}/${file.relativePath}`));
        if (await existingFile(parent, path.posix.basename(file.relativePath), file, check)) existing.add(file.relativePath);
        else remaining += file.byteSize;
      } catch (error) { if (error.code === 'ENOENT') remaining += file.byteSize; else throw error; }
      finally { if (parent !== undefined) fs.closeSync(parent); }
    }
    check(); storage.requireSpace('models', metadataReserve + remaining);
    const metadata = (relativePath, body) => immutableFile(root, relativePath, { byteSize: body.length, sha256: sha(body) }, async function* () { for (let offset = 0; offset < body.length; offset += CHUNK) yield body.subarray(offset, offset + CHUNK); }, check, layout.partsPath);
    await metadata(layout.manifestPath, layout.body);
    for (const file of layout.manifest.files) {
      check(); storage.requireSpace('models', (existing.has(file.relativePath) ? 0 : file.byteSize) + 8192);
      await immutableFile(root, `${layout.slot}/${file.relativePath}`, file,
        () => { storage.requireSpace('models', file.byteSize + 8192); return readFile({ operation, file, signal: combined }); }, check, layout.partsPath);
    }
    service.unchanged(operation); check();
    pinned = new PinnedSupplementDirectory(storage.roots.models, layout.manifest.files, { relativeRoot: layout.slot });
    await pinned.verifyAll({ signal: combined, assertCurrent: check }); pinned.assertComplete({ signal: combined, assertCurrent: check });
    const retainedPartBytes = retainedParts(root, layout, check);
    const sealed = intakeLayout(operation, context, manifest, retainedPartBytes);
    await metadata(sealed.markerPath, sealed.marker); check();
    service.processing.transaction(() => {
      service.unchanged(operation); check();
      if (!service.db.prepare("SELECT 1 FROM audit_events WHERE actor_type='system' AND action='derivative_recovery.intake_complete' AND entity_id=? AND json_extract(details_json,'$.leaseTokenSha256')=? LIMIT 1").get(operation.id, sha(leaseToken)))
        service.processing.insertAudit({ actorType: 'system', action: 'derivative_recovery.intake_complete', entityType: 'derivative_recovery', entityId: operation.id,
          details: { leaseTokenSha256: sha(leaseToken), supplementSha256: operation.supplement_sha256, fileCount: layout.manifest.files.length, byteSize: layout.byteSize, retainedPartBytes,
            metadataBytes: layout.body.length + sealed.marker.length, metadataSha256: metadataHash(layout.body, sealed.marker) } });
    });
    return { id: operation.id, status: 'staged', fileCount: layout.manifest.files.length, byteSize: layout.byteSize, retainedPartBytes, metadataBytes: layout.body.length + sealed.marker.length };
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline);
    try { pinned?.close(); } finally { try { root?.close(); } finally { active.delete(operation.id); if (!active.size) activeIntakes.delete(service.db); } }
  }
}

async function readOwnedRecord(root, relativePath, maximum, check, partsPath) {
  const parent = root.directory(path.posix.dirname(relativePath)); let fd;
  try {
    check(); fd = fs.openSync(`/proc/self/fd/${parent}/${path.posix.basename(relativePath)}`, FLAGS | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || stat.size > BigInt(maximum)
      || mountId(fd) !== mountId(parent)) fail('supplement_intake_record_invalid');
    if (stat.nlink !== 1n) {
      if (stat.nlink !== 2n) fail('supplement_intake_record_invalid');
      const parts = root.directory(partsPath); let aliases = 0;
      try {
        const entries = fs.readdirSync(`/proc/self/fd/${parts}`, { withFileTypes: true });
        if (entries.length > MAX_FILES * 2) fail('supplement_intake_parts_limit');
        for (const entry of entries) {
          check();
          if (!/^\.receiver-[a-f0-9]{32}\.partial$/.test(entry.name) || !entry.isFile()) fail('supplement_intake_parts_unbound');
          const alias = fs.openSync(`/proc/self/fd/${parts}/${entry.name}`, FLAGS | fs.constants.O_NONBLOCK);
          try {
            const value = fs.fstatSync(alias, { bigint: true });
            if (!value.isFile() || value.uid !== BigInt(process.getuid()) || mountId(alias) !== root.mount) fail('supplement_intake_parts_unbound');
            if (value.dev === stat.dev && value.ino === stat.ino) aliases++;
          } finally { fs.closeSync(alias); }
        }
      } finally { fs.closeSync(parts); }
      if (aliases !== 1) fail('supplement_intake_record_invalid');
    }
    const body = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < body.length) {
      check();
      const count = await new Promise((resolve, reject) => fs.read(fd, body, offset, Math.min(CHUNK, body.length - offset), offset,
        (error, read) => error ? reject(error) : resolve(read)));
      if (!count) fail('supplement_intake_record_changed');
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(`/proc/self/fd/${parent}/${path.posix.basename(relativePath)}`, { bigint: true });
    if (after.dev !== named.dev || after.ino !== named.ino || stat.size !== after.size || stat.nlink !== after.nlink || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs)
      fail('supplement_intake_record_changed');
    check(); return body;
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } finally { fs.closeSync(parent); } }
}
function createStagedSupplementLoader({ service, storage, environment } = {}) {
  return async ({ operation, signal }) => {
    if (environment !== 'STAGING') fail('supplement_staging_only');
    const row = service.lease(operation.id, operation.lease_owner, operation.lease_token), context = service.unchanged(row);
    const slot = immutableSupplementSlot(row, context), parent = path.posix.dirname(slot), partsPath = `${parent}/parts/${row.lease_token}`;
    const root = new IntakeRoot(storage.roots.models);
    const check = () => { signal?.throwIfAborted(); service.lease(row.id, row.lease_owner, row.lease_token); service.authorize(row.session_id, row.subject); root.check(); };
    try {
      const body = await readOwnedRecord(root, `${parent}/${row.lease_token}.manifest.json`, MAX_ENVELOPE, check, partsPath);
      let manifest; try { manifest = JSON.parse(body.toString('utf8')); } catch { fail('supplement_intake_record_invalid'); }
      let layout = intakeLayout(row, context, manifest);
      if (!body.equals(layout.body)) fail('supplement_intake_record_changed');
      const marker = await readOwnedRecord(root, layout.markerPath, 4096, check, partsPath);
      let markerRecord; try { markerRecord = JSON.parse(marker.toString('utf8')); } catch { fail('supplement_intake_record_invalid'); }
      layout = intakeLayout(row, context, manifest, markerRecord.retainedPartBytes);
      if (!marker.equals(layout.marker)) fail('supplement_intake_not_complete');
      const receipt = service.db.prepare(`SELECT details_json FROM audit_events WHERE actor_type='system'
        AND action='derivative_recovery.intake_complete' AND entity_id=? AND json_extract(details_json,'$.leaseTokenSha256')=?`).all(row.id, sha(row.lease_token));
      if (receipt.length !== 1) fail('supplement_intake_not_complete');
      const details = JSON.parse(receipt[0].details_json);
      if (details.supplementSha256 !== row.supplement_sha256 || details.fileCount !== layout.manifest.files.length || details.byteSize !== layout.byteSize || details.retainedPartBytes !== layout.retainedPartBytes || details.metadataBytes !== body.length + marker.length
        || details.metadataSha256 !== metadataHash(body, marker))
        fail('supplement_intake_not_complete');
      service.unchanged(row); check(); return layout.manifest;
    } finally { root.close(); }
  };
}

module.exports = { intakeLayout, stageDerivativeSupplement, createStagedSupplementLoader };
