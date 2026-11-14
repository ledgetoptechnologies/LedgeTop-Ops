'use strict';

// Only for an owner-admitted, isolated, one-shot recovery controller. The outer
// owner MUST supply fresh CID/cgroup admission, --init, an isolated PID namespace
// with no other execs, and a hard container deadline. Group disappearance cannot
// prove descendants did not escape an unqualified namespace. Never mount this
// adapter in an ordinary API/worker or treat its evidence as readiness.
const fs = require('node:fs');
const path = require('node:path').posix;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const {RECOVERY_RUNTIME}=require('./recoveryProofRuntimePins');

const SOURCE_COMMIT = RECOVERY_RUNTIME.sourceCommit;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_REQUEST = 65536, MAX_STDOUT = 8 * 1024 * 1024, MAX_STDERR = 4096;
const PINNED = Object.freeze({
  converterBinarySha256: RECOVERY_RUNTIME.converterBinarySha256,
  basisJavascriptSha256: RECOVERY_RUNTIME.basisJavascriptSha256,
  basisWasmSha256: RECOVERY_RUNTIME.basisWasmSha256,
});
const failure = code => Object.assign(new Error(code), { code });
const privateFailure = error => /^recovery_executor_[a-z0-9_]{1,80}$/.test(error?.code || '')
  ? error : failure('recovery_executor_failed');
const requireValue = (value, code) => { if (!value) throw failure(code); };
const absolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
  && path.resolve(value) === value && !value.includes('\0');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => candidate === root || candidate.startsWith(root === '/' ? '/' : root + '/');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function frozenJson(value) {
  let raw, result;
  try { raw = JSON.stringify(value); result = JSON.parse(raw); } catch { throw failure('recovery_executor_configuration'); }
  requireValue(Buffer.byteLength(raw) <= MAX_REQUEST, 'recovery_executor_configuration');
  function freeze(item, depth = 0) {
    requireValue(depth <= 32, 'recovery_executor_configuration');
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child, depth + 1); Object.freeze(item); }
  }
  freeze(result); return result;
}

function requestBytes(request) {
  const keys = ['schemaVersion', 'mode', 'output', 'sourceObj', 'sourceGlb', 'converterBinary',
    'basisJavascript', 'basisWasm', 'sourceObjSha256', 'sourceGlbSha256', 'converterBinarySha256', 'converterSerialRetry'];
  requireValue(request && typeof request === 'object' && !Array.isArray(request)
    && [Object.prototype, null].includes(Object.getPrototypeOf(request))
    && Object.keys(request).sort().join('|') === [...keys].sort().join('|')
    && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(request, key) || {}, 'value')),
  'recovery_executor_request');
  requireValue(request.schemaVersion === 1 && request.mode === 'verify'
    && ['output', 'sourceObj', 'sourceGlb', 'converterBinary', 'basisJavascript', 'basisWasm'].every(key => absolute(request[key]))
    && ['sourceObjSha256', 'sourceGlbSha256'].every(key => typeof request[key] === 'string' && /^[a-f0-9]{64}$/.test(request[key]))
    && request.converterBinarySha256 === PINNED.converterBinarySha256 && typeof request.converterSerialRetry === 'boolean',
  'recovery_executor_request');
  const bytes = Buffer.from(JSON.stringify(request));
  requireValue(bytes.length > 0 && bytes.length <= MAX_REQUEST, 'recovery_executor_request');
  return bytes;
}

const nativeGroup = Object.freeze({
  exists(pgid) {
    try { process.kill(-pgid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  },
  signal(pgid, signal) { process.kill(-pgid, signal); },
});

function createRecoveryProofExecutor(options) {
  requireValue(options && typeof options === 'object', 'recovery_executor_configuration');
  const { nodePath, scriptPath, workRoot, assertRuntimeQualified, assertResourceAdmission, onCleanupStall } = options;
  requireValue([nodePath, scriptPath, workRoot].every(absolute)
    && [assertRuntimeQualified, assertResourceAdmission, onCleanupStall].every(value => typeof value === 'function'),
  'recovery_executor_configuration');
  const testKeys = ['spawnFn', 'fsPromises', 'processGroup', 'now', 'wait', 'platform', 'getuid'];
  if (testKeys.some(key => Object.hasOwn(options, key))) {
    // A mocked PID must never fall through to the host process-group adapter.
    requireValue(testKeys.every(key => Object.hasOwn(options, key))
      && ['spawnFn', 'now', 'wait', 'getuid'].every(key => typeof options[key] === 'function')
      && typeof options.platform === 'string'
      && options.fsPromises && ['realpath', 'lstat', 'mkdtemp', 'open', 'rm'].every(key => typeof options.fsPromises[key] === 'function')
      && options.processGroup && ['exists', 'signal'].every(key => typeof options.processGroup[key] === 'function'),
    'recovery_executor_test_adapter_incomplete');
  }
  const runtimeBinding = frozenJson(options.runtimeBinding);
  const runtimeKeys = ['schemaVersion', 'sourceCommit', 'imageId', 'nodeVersion', 'nodeAbi', 'pythonVersion',
    'gdalVersion', ...Object.keys(PINNED)];
  requireValue(runtimeBinding && runtimeBinding.schemaVersion === 1 && runtimeBinding.sourceCommit === SOURCE_COMMIT
    && Object.entries(RECOVERY_RUNTIME).every(([key,value])=>runtimeBinding[key]===value)
    && /^sha256:[a-f0-9]{64}$/.test(runtimeBinding.imageId || '')
    && typeof runtimeBinding.nodeVersion === 'string' && /^v24\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9_.-]+)?$/.test(runtimeBinding.nodeVersion)
    && typeof runtimeBinding.nodeAbi === 'string' && /^[0-9]{1,8}$/.test(runtimeBinding.nodeAbi)
    && ['pythonVersion', 'gdalVersion'].every(key => typeof runtimeBinding[key] === 'string'
      && /^[A-Za-z0-9_.+-]{1,80}$/.test(runtimeBinding[key]))
    && Object.entries(PINNED).every(([key, value]) => runtimeBinding[key] === value)
    && Object.keys(runtimeBinding).every(key => runtimeKeys.includes(key)
      || (/^[A-Za-z][A-Za-z0-9]{0,63}Sha256$/.test(key) && typeof runtimeBinding[key] === 'string'
        && /^[a-f0-9]{64}$/.test(runtimeBinding[key]))), 'recovery_executor_configuration');
  // All adapters below are trusted construction-time dependencies, never JSON
  // request fields. Tests inject metadata/child/group fakes, not real processes.
  const io = options.fsPromises || fs.promises, spawnFn = options.spawnFn || spawn;
  const group = options.processGroup || nativeGroup, now = options.now || Date.now;
  const wait = options.wait || sleep, platform = options.platform || process.platform;
  const uid = options.getuid || (() => process.getuid());
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS, pollMs = options.pollMs ?? 100;
  const termGraceMs = options.termGraceMs ?? 2000, killGraceMs = options.killGraceMs ?? 5000;
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS
    && Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 1000
    && Number.isSafeInteger(termGraceMs) && termGraceMs >= 0 && termGraceMs <= 10000
    && Number.isSafeInteger(killGraceMs) && killGraceMs >= 0 && killGraceMs <= 60000
    && typeof group.exists === 'function' && typeof group.signal === 'function', 'recovery_executor_configuration');
  let busy = false;

  return async function executeProof(input) {
    requireValue(!busy, 'recovery_executor_busy');
    requireValue(input && typeof input === 'object'
      && Object.keys(input).every(key => ['request', 'signal', 'deadline', 'assertCurrent'].includes(key))
      && typeof input.assertCurrent === 'function' && Number.isSafeInteger(input.deadline), 'recovery_executor_request');
    requireValue(platform === 'linux', 'recovery_executor_platform');
    const bytes = requestBytes(input.request), request = JSON.parse(bytes.toString('utf8'));
    const deadline = Math.min(input.deadline, now() + timeoutMs);
    const signal = input.signal || null, assertCurrent = input.assertCurrent;
    let problem = null, scratch = null, scratchIdentity = null, rootIdentity = null;
    let child = null, childClosed = false, spawned = false, exitCode = null, exitSignal = null;
    let retired = false, reaped = false, termAt = null, killAt = null, stallNotice = null, uncertaintyAt = null;
    const chunks = []; let stdoutBytes = 0, stderrBytes = 0;
    const setProblem = code => { problem ||= failure(code); };
    function checkpoint() {
      try {
        const result = assertCurrent();
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw failure('recovery_executor_async_current_guard');
        }
        if (result === false) throw failure('recovery_executor_stale');
      } catch (error) { problem ||= error?.code === 'recovery_executor_async_current_guard'
        ? error : failure('recovery_executor_stale'); }
      if (signal?.aborted) setProblem('recovery_executor_cancelled');
      if (!(now() < deadline)) setProblem('recovery_executor_timeout');
    }
    function current() { checkpoint(); if (problem) throw problem; }
    async function step(promise) { try { return await promise; } finally { current(); } }
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino
      && left.uid === right.uid && left.mode === right.mode;
    async function directory(filename) {
      requireValue(await step(io.realpath(filename)) === filename, 'recovery_executor_private_path');
      const info = await step(io.lstat(filename));
      requireValue(info.isDirectory() && info.uid === uid() && (info.mode & 0o7777) === 0o700,
        'recovery_executor_private_path'); return info;
    }
    function signalGroup(pgid, name) {
      if (retired) return;
      try { group.signal(pgid, name); }
      catch (error) { if (error.code === 'ESRCH') retired = true; else setProblem('recovery_executor_group_signal'); }
    }
    function observeGroup(pgid) {
      if (retired) return;
      try {
        const present = group.exists(pgid);
        if (present === false) retired = true;
        else if (present !== true) setProblem('recovery_executor_group_unknown');
      } catch (error) { if (error.code === 'ESRCH') retired = true; else setProblem('recovery_executor_group_unknown'); }
    }
    function stalled() {
      if (stallNotice) return;
      // The notice is not permission to release custody. Reaping continues even
      // when the trusted status hook rejects. A hung hook also retains custody.
      try { stallNotice = Promise.resolve(onCleanupStall(Object.freeze({
        code: 'recovery_executor_cleanup_stalled', sourceCommit: SOURCE_COMMIT, runtimeBinding,
      }))).catch(() => {}); } catch { stallNotice = Promise.resolve(); }
    }
    async function reap() {
      let pgid = null;
      for (;;) {
        try {
          checkpoint();
          if (problem && uncertaintyAt === null) uncertaintyAt = now();
          if (pgid === null && (spawned || childClosed) && Number.isSafeInteger(child?.pid) && child.pid > 1) pgid = child.pid;
          if ((spawned || childClosed) && Number.isSafeInteger(pgid) && pgid > 1) {
            observeGroup(pgid);
            if (childClosed && !retired && !problem) setProblem('recovery_executor_descendants_remaining');
            if (problem && !retired) {
              if (termAt === null) { termAt = now(); signalGroup(pgid, 'SIGTERM'); }
              if (!retired && now() - termAt >= termGraceMs && killAt === null) {
                killAt = now(); signalGroup(pgid, 'SIGKILL');
              }
            }
          } else if (childClosed && !spawned && !Number.isSafeInteger(child?.pid)) retired = true;
          else if ((spawned || childClosed) && (!Number.isSafeInteger(pgid) || pgid <= 1)) {
            setProblem('recovery_executor_group_unknown'); stalled();
          }
          if (childClosed && retired) { reaped = true; break; }
          if (killAt !== null && now() - killAt >= killGraceMs) stalled();
          if (uncertaintyAt !== null && now() - uncertaintyAt >= termGraceMs + killGraceMs) stalled();
        } catch { setProblem('recovery_executor_cleanup_unknown'); stalled(); }
        // Ref'ed waits deliberately keep the controller alive after leader close.
        // Never reject/release custody if existence/reap remains uncertain.
        try { await wait(pollMs); } catch { setProblem('recovery_executor_reap_wait'); await sleep(pollMs); }
        try { checkpoint(); } catch { setProblem('recovery_executor_cleanup_unknown'); stalled(); }
      }
      if (stallNotice) { await stallNotice; checkpoint(); }
    }
    async function ensureReaped() {
      // Even an unexpected adapter/wait failure cannot reject the outer custody
      // promise before physical retirement. The external owner may kill the
      // entire admitted cgroup; this controller never declares that as success.
      while (!reaped) {
        try { await reap(); checkpoint(); }
        catch {
          setProblem('recovery_executor_cleanup_unknown'); stalled();
          if (!reaped) { try { await sleep(pollMs); } catch { /* retain custody */ } }
        }
      }
    }
    async function cleanupScratch() {
      if (!scratch) return;
      // Cleanup is allowed only after direct-child close AND group retirement.
      requireValue(!child || reaped, 'recovery_executor_cleanup_unsafe');
      const root = await io.lstat(workRoot); checkpoint();
      const actualRoot = await io.realpath(workRoot); checkpoint();
      const owned = await io.lstat(scratch); checkpoint();
      const actualScratch = await io.realpath(scratch); checkpoint();
      requireValue(actualRoot === workRoot && actualScratch === scratch && same(root, rootIdentity)
        && same(owned, scratchIdentity) && path.dirname(scratch) === workRoot
        && /^recovery-proof-[A-Za-z0-9]+$/.test(path.basename(scratch)), 'recovery_executor_cleanup_identity');
      await io.rm(scratch, { recursive: true, force: false }); checkpoint();
    }

    busy = true;
    try {
      current();
      requireValue(await step(assertRuntimeQualified(runtimeBinding)) === true, 'recovery_executor_runtime_unqualified');
      requireValue(await step(assertResourceAdmission(runtimeBinding)) === true, 'recovery_executor_admission_denied');
      for (const root of [request.output, path.dirname(request.sourceObj), path.dirname(request.sourceGlb)]) {
        requireValue(!inside(root, workRoot) && !inside(workRoot, root), 'recovery_executor_work_root_overlap');
      }
      rootIdentity = await directory(workRoot); current();
      for (const filename of [nodePath, scriptPath]) {
        requireValue(await step(io.realpath(filename)) === filename, 'recovery_executor_runtime_path');
        requireValue((await step(io.lstat(filename))).isFile(), 'recovery_executor_runtime_path');
      }
      // Capture resource handles BEFORE testing freshness, so cancellation after
      // acquisition cannot orphan a directory or an open request descriptor.
      scratch = await io.mkdtemp(path.join(workRoot, 'recovery-proof-')); checkpoint();
      requireValue(path.dirname(scratch) === workRoot && /^recovery-proof-[A-Za-z0-9]+$/.test(path.basename(scratch)),
        'recovery_executor_private_path');
      scratchIdentity = await io.lstat(scratch); checkpoint();
      const canonicalScratch = await io.realpath(scratch); checkpoint();
      requireValue(canonicalScratch === scratch && scratchIdentity.isDirectory() && scratchIdentity.uid === uid()
        && (scratchIdentity.mode & 0o7777) === 0o700, 'recovery_executor_private_path');
      current();
      const filename = path.join(scratch, 'request.json');
      const handle = await io.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW, 0o600); checkpoint();
      try { current(); await step(handle.writeFile(bytes)); await step(handle.sync()); }
      finally { await handle.close(); checkpoint(); }
      const requestStat = await step(io.lstat(filename));
      requireValue(requestStat.isFile() && requestStat.uid === uid() && (requestStat.mode & 0o7777) === 0o600
        && requestStat.size === bytes.length, 'recovery_executor_request_file');
      current();
      child = spawnFn(nodePath, [scriptPath, '--request', filename], {
        cwd: scratch, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', TMPDIR: scratch, LANG: 'C.UTF-8',
          PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', GDAL_PAM_ENABLED: 'NO',
          GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR', GDAL_NUM_THREADS: '1', OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1' },
      });
      child.once('spawn', () => { spawned = true; });
      child.once('error', () => setProblem('recovery_executor_spawn_failed'));
      child.once('close', (code, killedBy) => {
        childClosed = true; exitCode = code; exitSignal = killedBy;
        if (code !== 0 || killedBy) setProblem('recovery_executor_exit_failed');
      });
      child.stdout.on('data', bytes => {
        stdoutBytes += bytes.length;
        if (stdoutBytes > MAX_STDOUT) setProblem('recovery_executor_stdout_limit');
        else chunks.push(Buffer.from(bytes));
      });
      child.stderr.on('data', bytes => {
        stderrBytes += bytes.length; if (stderrBytes > MAX_STDERR) setProblem('recovery_executor_stderr_limit');
      });
      child.stdout.once('error', () => setProblem('recovery_executor_stdout_failed'));
      child.stderr.once('error', () => setProblem('recovery_executor_stderr_failed'));
      await ensureReaped(); checkpoint();
      if (problem) throw problem;
      requireValue(spawned && exitCode === 0 && !exitSignal && childClosed && retired, 'recovery_executor_exit_failed');
      let proof, text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
        proof = JSON.parse(text);
        requireValue(proof && typeof proof === 'object' && !Array.isArray(proof)
          && JSON.stringify(proof) === text, 'recovery_executor_invalid_json');
      } catch { throw failure('recovery_executor_invalid_json'); }
      current();
      return { proof, execution: { requestSha256: hash(bytes), sourceCommit: SOURCE_COMMIT, runtimeBinding,
        exitCode: 0, childClosed: true, processGroupGone: true } };
    } catch (error) {
      problem ||= privateFailure(error); throw problem;
    } finally {
      try {
        if (child && !reaped) { setProblem('recovery_executor_interrupted'); await ensureReaped(); checkpoint(); }
        await cleanupScratch(); checkpoint();
        if (problem) throw problem;
      } catch (error) {
        throw privateFailure(error);
      } finally { busy = false; }
    }
  };
}

module.exports = { createRecoveryProofExecutor, SOURCE_COMMIT };
