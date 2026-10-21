'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');

const SENTINEL_NAME = '.ltds-viewer-processing-scale.json';
const TARGET_PATTERN = /^ltds-viewer-scale-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PRODUCTION_IMAGE_PATTERN = /^ghcr\.io\/ledgetoptechnologies\/ledgetop-ops-viewer@sha256:[0-9a-f]{64}$/;
const MAX_FILE_COUNT = 1_000_000;
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024;
const DEFAULT_PRODUCTION_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;
const MIN_PRODUCTION_SAFETY_MARGIN_BYTES = 1024 * 1024 * 1024;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function elapsedMs(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function currentPeakRss() { return Math.max(process.memoryUsage().rss, Number(process.resourceUsage().maxRSS || 0) * 1024); }
function manifestHash(files) { return crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex'); }

function readBuildSourceIdentity() {
  const file = path.resolve(__dirname, '..', 'source-commit.txt');
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail('runtime_source_identity_unavailable', 'runtime image source identity is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('runtime_source_identity_unavailable', 'runtime image source identity is invalid');
  const value = fs.readFileSync(file, 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) fail('runtime_source_identity_unavailable', 'runtime image source identity is invalid');
  return value;
}

function filesystemEvidence(root, injected = null) {
  if (injected) return injected;
  const rootStat = fs.statSync(root), stat = fs.statfsSync(root);
  const blockSize = Number(stat.bsize), availableBlocks = Number(stat.bavail), totalBlocks = Number(stat.blocks);
  if (![blockSize, availableBlocks, totalBlocks].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      availableBlocks > Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, blockSize)) ||
      totalBlocks > Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, blockSize))) fail('filesystem_size_unsupported', 'filesystem size cannot be represented safely');
  return { device: String(rootStat.dev), type: String(stat.type), blockSize, totalBytes: totalBlocks * blockSize, availableBytes: availableBlocks * blockSize };
}

function validateOptions(input, dependencies = {}) {
  const root = path.resolve(String(input.root || ''));
  const fileCount = Number(input.fileCount);
  const bytesPerFile = Number(input.bytesPerFile);
  const production = Boolean(input.production);
  if (!input.root) fail('root_required', 'an explicit rehearsal root is required');
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) fail('invalid_file_count', 'file count must be a positive safe integer');
  if (!Number.isSafeInteger(bytesPerFile) || bytesPerFile < 1) fail('invalid_file_size', 'bytes per file must be a positive safe integer');
  if (fileCount > Math.floor(Number.MAX_SAFE_INTEGER / bytesPerFile)) fail('requested_bytes_overflow', 'requested rehearsal bytes exceed safe arithmetic bounds');
  if (fileCount > MAX_FILE_COUNT || bytesPerFile > MAX_BYTES_PER_FILE) fail('scale_upper_bound_exceeded', 'rehearsal count or file size exceeds the supported upper bound');
  if (production && fileCount < 100_000) fail('production_file_count_too_small', 'production rehearsal requires at least 100000 files');
  const sourceCommit = String(input.sourceCommit || '');
  const image = String(input.image || '');
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) fail('invalid_source_commit', 'source commit must be a full 40-character Git SHA');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/.test(image)) fail('invalid_image', 'image must be a bounded tag or digest without credentials');
  if (production && !PRODUCTION_IMAGE_PATTERN.test(image)) fail('production_image_not_immutable', 'production image must be the immutable LTDS GHCR Viewer digest');
  const normalizedCommit = sourceCommit.toLowerCase();
  const runtimeSourceCommit = production ? String(dependencies.runtimeSourceCommit || readBuildSourceIdentity()).toLowerCase() : null;
  if (production && (!/^[0-9a-f]{40}$/.test(runtimeSourceCommit) || runtimeSourceCommit !== normalizedCommit)) fail('source_identity_mismatch', 'claimed source commit does not match the runtime image identity');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_root', 'rehearsal root must be a real directory, not a symbolic link');
  const resolvedRoot = fs.realpathSync.native(root);
  const reserveBytes = input.reserveBytes === undefined || input.reserveBytes === null || input.reserveBytes === '' ? (production ? DEFAULT_PRODUCTION_RESERVE_BYTES : 0) : Number(input.reserveBytes);
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) fail('invalid_reserve_bytes', 'reserve bytes must be a non-negative safe integer');
  const requestedBytes = fileCount * bytesPerFile;
  const safetyMarginBytes = production ? Math.max(MIN_PRODUCTION_SAFETY_MARGIN_BYTES, Math.ceil(requestedBytes / 20)) : 0;
  if (requestedBytes > Number.MAX_SAFE_INTEGER - reserveBytes || requestedBytes + reserveBytes > Number.MAX_SAFE_INTEGER - safetyMarginBytes) fail('requested_bytes_overflow', 'requested bytes, reserve, and safety margin exceed safe arithmetic bounds');
  const requiredBytes = requestedBytes + reserveBytes + safetyMarginBytes;
  const filesystem = filesystemEvidence(resolvedRoot, dependencies.filesystem || null);
  if (!Number.isSafeInteger(filesystem.availableBytes) || filesystem.availableBytes < 0) fail('filesystem_size_unsupported', 'filesystem available bytes cannot be represented safely');
  const preflight = { requestedBytes, reserveBytes, safetyMarginBytes, requiredBytes, availableBytes: filesystem.availableBytes, sufficient: filesystem.availableBytes >= requiredBytes };
  if (!preflight.sufficient) fail('insufficient_rehearsal_space', 'rehearsal root lacks requested bytes plus reserve and safety margin');
  return { root: resolvedRoot, fileCount, bytesPerFile, production, sourceCommit: normalizedCommit, runtimeSourceCommit, image, reserveBytes, requestedBytes, filesystem, preflight };
}

function createDisposableTarget(root) {
  const runId = crypto.randomUUID();
  const targetName = `ltds-viewer-scale-${runId}`;
  const target = path.join(root, targetName);
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  const sentinel = { schemaVersion: 1, purpose: 'ltds-viewer-processing-scale-rehearsal', runId, targetName };
  const sentinelBody = `${JSON.stringify(sentinel)}\n`;
  fs.writeFileSync(path.join(target, SENTINEL_NAME), sentinelBody, { flag: 'wx', mode: 0o600 });
  return { root, target, targetName, runId, sentinel, sentinelBody };
}

function validateCleanupTarget(context) {
  const root = fs.realpathSync.native(context.root);
  const match = TARGET_PATTERN.exec(context.targetName);
  if (!match || match[1].toLowerCase() !== context.runId.toLowerCase()) fail('cleanup_target_invalid', 'cleanup target name does not match the run identifier');
  const expected = path.join(root, context.targetName);
  if (path.resolve(context.target) !== expected || path.dirname(expected) !== root) fail('cleanup_target_invalid', 'cleanup target is not a direct child of the supplied root');
  const targetStat = fs.lstatSync(expected);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || fs.realpathSync.native(expected) !== expected) fail('cleanup_target_invalid', 'cleanup target is not the exact real directory created for this run');
  const sentinelPath = path.join(expected, SENTINEL_NAME);
  const sentinelStat = fs.lstatSync(sentinelPath);
  if (!sentinelStat.isFile() || sentinelStat.isSymbolicLink() || fs.readFileSync(sentinelPath, 'utf8') !== context.sentinelBody) fail('cleanup_sentinel_invalid', 'cleanup sentinel does not exactly match this run');
  return expected;
}

function cleanupDisposableTarget(context) {
  const exact = validateCleanupTarget(context);
  fs.rmSync(exact, { recursive: true, force: false });
  if (fs.existsSync(exact)) fail('cleanup_failed', 'disposable rehearsal target still exists after cleanup');
}

function makeStorageConfig(target, reserveBytes = 0) {
  return {
    datasetsMount: path.join(target, 'datasets'), modelsMount: path.join(target, 'models'),
    cacheMount: path.join(target, 'cache'), trashMount: path.join(target, 'trash'),
    datasetImportMount: path.join(target, 'imports'), storageReserveBytes: reserveBytes, storageReservePercent: 0,
  };
}

async function runProcessingScaleRehearsal(input, dependencies = {}) {
  const options = validateOptions(input, dependencies);
  const context = createDisposableTarget(options.root);
  const started = process.hrtime.bigint();
  const phases = {};
  let peakRssBytes = currentPeakRss();
  let database = null;
  let failure = null;
  const report = {
    schemaVersion: 1, ok: false, mode: options.production ? 'production' : 'development',
    inputs: { fileCount: options.fileCount, bytesPerFile: options.bytesPerFile, reserveBytes: options.reserveBytes, image: options.image, sourceCommit: options.sourceCommit },
    run: { targetName: context.targetName }, phases,
    preflight: options.preflight,
  };
  const phase = async (name, operation) => {
    const phaseStarted = process.hrtime.bigint();
    const result = await operation();
    peakRssBytes = Math.max(peakRssBytes, currentPeakRss());
    phases[name] = { elapsedMs: Number(elapsedMs(phaseStarted).toFixed(3)), rssAfterBytes: process.memoryUsage().rss };
    return result;
  };
  try {
    report.filesystem = {
      device: String(options.filesystem.device), type: String(options.filesystem.type), blockSize: Number(options.filesystem.blockSize),
      totalBytes: Number(options.filesystem.totalBytes), availableBytesAtStart: Number(options.filesystem.availableBytes),
    };
    const config = makeStorageConfig(context.target);
    const storage = new StorageManager(config);
    storage.initialize();
    fs.mkdirSync(config.datasetImportMount, { recursive: true });
    fs.mkdirSync(path.join(context.target, 'data'), { recursive: true });
    const source = path.join(config.datasetImportMount, 'source');
    await phase('generate', async () => {
      fs.mkdirSync(source);
      const body = Buffer.alloc(options.bytesPerFile, 0x5a);
      for (let index = 0; index < options.fileCount; index += 1) {
        if (body.length >= 4) body.writeUInt32LE(index >>> 0, 0); else body[0] = index & 0xff;
        const directory = path.join(source, String(Math.floor(index / 1000)).padStart(6, '0'));
        if (index % 1000 === 0) fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, `${String(index).padStart(9, '0')}.jpg`), body, { flag: 'wx' });
      }
    });
    const preview = await phase('scan_and_full_fingerprint', () => storage.previewImport('dataset_import', 'source', { maxFiles: options.fileCount }));
    if (preview.fileCount !== options.fileCount || preview.byteSize !== options.fileCount * options.bytesPerFile || !/^[0-9a-f]{64}$/.test(preview.treeFingerprint)) fail('preview_mismatch', 'authoritative preview counts or fingerprint do not match generated input');
    database = openDatabase(path.join(context.target, 'data', 'viewer.sqlite'));
    const processing = new ProcessingRepository(database);
    const project = processing.createProject({ displayName: `Scale rehearsal ${context.runId}`, createdBy: 'scale-rehearsal' });
    const datasetId = crypto.randomUUID();
    processing.createDataset({ id: datasetId, projectId: project.id, displayName: 'Disposable scale dataset', sourceType: 'server_import', storageMode: 'adopted', rootKey: 'datasets', relativePath: datasetId, status: 'finalizing', createdBy: 'scale-rehearsal' });
    const finalized = await phase('adopt_and_finalize', async () => {
      const adopted = await storage.adoptImport('dataset_import', 'source', datasetId, { expectedFingerprint: preview.treeFingerprint, maxFiles: options.fileCount });
      const files = adopted.scan.files.map((file) => ({ id: crypto.randomUUID(), relativePath: file.relativePath, byteSize: file.byteSize, sha256: file.sha256, metadata: file.metadata || {} }));
      return processing.finalizeDataset(datasetId, files, manifestHash(files));
    });
    const accounting = await phase('storage_accounting', async () => processing.projectStorage(project.id));
    if (finalized.fileCount !== options.fileCount || finalized.byteSize !== preview.byteSize || accounting.project.datasetBytes !== preview.byteSize || accounting.project.totalBytes !== preview.byteSize) fail('accounting_mismatch', 'finalized dataset accounting does not match authoritative input');
    database.close(); database = null;
    const reopened = await phase('restart_and_reopen', async () => {
      const reopenedDatabase = openDatabase(path.join(context.target, 'data', 'viewer.sqlite'));
      try {
        const reopenedProcessing = new ProcessingRepository(reopenedDatabase);
        const dataset = reopenedProcessing.getDataset(datasetId);
        const counts = reopenedDatabase.prepare('SELECT COUNT(*) count,COALESCE(SUM(byte_size),0) bytes FROM dataset_files WHERE dataset_id=?').get(datasetId);
        const reopenedAccounting = reopenedProcessing.projectStorage(project.id);
        const reopenedStorage = new StorageManager(config); reopenedStorage.initialize();
        const scan = reopenedStorage.scanTree('datasets', datasetId, { maxFiles: options.fileCount });
        const fingerprint = await reopenedStorage.treeFingerprint(scan);
        return { dataset, count: Number(counts.count), bytes: Number(counts.bytes), accountedBytes: reopenedAccounting.project.totalBytes, fingerprint };
      } finally { reopenedDatabase.close(); }
    });
    if (reopened.dataset.status !== 'finalized' || reopened.count !== options.fileCount || reopened.bytes !== preview.byteSize || reopened.accountedBytes !== preview.byteSize || reopened.fingerprint !== preview.treeFingerprint) fail('restart_integrity_mismatch', 'reopened database or filesystem integrity does not match the finalized dataset');
    const lowSpace = await phase('low_space_admission', async () => {
      const constrained = new StorageManager(makeStorageConfig(context.target, Number.MAX_SAFE_INTEGER)); constrained.initialize();
      try { constrained.requireProcessingHeadroom(preview.byteSize, []); } catch (error) { if (error.code === 'insufficient_storage') return { refused: true, code: error.code }; throw error; }
      return { refused: false, code: null };
    });
    if (!lowSpace.refused) fail('low_space_not_refused', 'injected low-space admission was not refused');
    report.counts = { generatedFiles: options.fileCount, previewFiles: preview.fileCount, finalizedFiles: finalized.fileCount, reopenedFiles: reopened.count };
    report.totalBytes = preview.byteSize;
    report.treeFingerprint = preview.treeFingerprint;
    report.manifestSha256 = finalized.manifestSha256;
    report.storageAccountingBytes = accounting.project.totalBytes;
    report.lowSpaceAdmission = lowSpace;
    report.ok = true;
  } catch (error) { failure = error; }
  finally {
    if (database) { try { database.close(); } catch { /* cleanup validation remains authoritative */ } }
    const cleanupStarted = process.hrtime.bigint();
    try { cleanupDisposableTarget(context); report.cleanup = { verified: true, removed: true }; }
    catch (cleanupError) { report.cleanup = { verified: false, removed: false, code: cleanupError.code || 'cleanup_failed' }; if (!failure) failure = cleanupError; else failure.cleanupError = cleanupError; }
    phases.cleanup = { elapsedMs: Number(elapsedMs(cleanupStarted).toFixed(3)), rssAfterBytes: process.memoryUsage().rss };
    peakRssBytes = Math.max(peakRssBytes, currentPeakRss());
    report.peakRssBytes = peakRssBytes;
    report.elapsedMs = Number(elapsedMs(started).toFixed(3));
  }
  if (failure) { failure.rehearsal = report; throw failure; }
  return report;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--production') values.production = true;
    else if (['--root', '--files', '--bytes-per-file', '--reserve-bytes', '--image', '--source-commit'].includes(arg)) {
      if (index + 1 >= argv.length) fail('invalid_arguments', `${arg} requires a value`);
      values[arg.slice(2)] = argv[++index];
    } else fail('invalid_arguments', 'unknown rehearsal argument');
  }
  return { root: values.root, fileCount: Number(values.files), bytesPerFile: Number(values['bytes-per-file']), reserveBytes: values['reserve-bytes'] === undefined ? undefined : Number(values['reserve-bytes']), image: values.image, sourceCommit: values['source-commit'], production: Boolean(values.production) };
}

if (require.main === module) {
  runProcessingScaleRehearsal(parseArguments(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'rehearsal_failed', cleanup: error.rehearsal?.cleanup || null })}\n`);process.exitCode = 1; });
}

module.exports = { SENTINEL_NAME, cleanupDisposableTarget, createDisposableTarget, readBuildSourceIdentity, runProcessingScaleRehearsal, validateCleanupTarget, validateOptions };
