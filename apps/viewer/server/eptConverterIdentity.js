'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EPT_CONVERTER_COMMAND, EPT_CONVERTER_COMMAND_SHA256 } = require('./eptConversionReceipt');
const fail = (code = 'ept_converter_identity_invalid') => {
  throw Object.assign(new Error('EPT converter identity could not be verified'), { code });
};
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

async function resolveExecutable(bin, { env = process.env, cwd = process.cwd(), signal } = {}) {
  signal?.throwIfAborted();
  if (typeof bin !== 'string' || !bin || /[\x00-\x1f]/.test(bin)) fail();
  const explicit = path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\');
  const directories = explicit ? [''] : String(env.PATH || env.Path || '').split(path.delimiter);
  // spawn uses no shell; .cmd/.bat wrappers cannot identify a directly executed
  // converter and are deliberately not resolved through PATHEXT.
  const extensions = process.platform === 'win32' && !path.extname(bin) ? ['', '.exe', '.com'] : [''];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.resolve(cwd, directory, `${bin}${extension}`);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      const resolved = await fs.promises.realpath(candidate);
      if ((await fs.promises.stat(resolved)).isFile()) return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return fail('ept_converter_unavailable');
}

async function executableIdentity(executablePath, { signal } = {}) {
  signal?.throwIfAborted();
  const before = await fs.promises.lstat(executablePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 1024n ** 3n ||
    await fs.promises.realpath(executablePath) !== executablePath) fail();
  const handle = await fs.promises.open(executablePath, 'r');
  try {
    if (fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))) fail();
    const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (!bytesRead) fail();
      digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await fs.promises.lstat(executablePath, { bigint: true });
    if (fingerprint(before) !== fingerprint(after) || fingerprint(before) !== fingerprint(await handle.stat({ bigint: true })) ||
      await fs.promises.realpath(executablePath) !== executablePath) fail();
    return { executableSha256: digest.digest('hex'), executableFingerprint: fingerprint(before) };
  } finally { await handle.close(); }
}

function probeVersion(executablePath, { signal, timeoutMs = 10000, env = process.env, cwd = process.cwd() } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32', env, cwd });
    let length = 0, chunks = [], settled = false, failure = null;
    const stop = error => {
      if (failure || settled) return;
      failure = error;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const invalid = code => Object.assign(new Error('EPT converter version could not be verified'), { code });
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : invalid('ept_converter_probe_aborted'));
    const timer = setTimeout(() => stop(invalid('ept_converter_probe_timeout')), Math.max(1, Math.min(Number(timeoutMs) || 10000, 10000)));
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const read = chunk => {
      if (failure) return;
      length += chunk.length;
      if (length > 4096) return stop(invalid('ept_converter_probe_limit'));
      chunks.push(chunk);
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', () => finish(invalid('ept_converter_unavailable')));
    child.once('close', code => {
      if (failure) return finish(failure);
      const output = Buffer.concat(chunks).toString('utf8').trim();
      // Entwine 2.2.0 treats --version as an app name and returns its native
      // usage banner with exit code zero. Accept that bounded, recognizable
      // banner and persist only the version, never arbitrary multiline output.
      const native = /^(?:Invalid app type\n)?\s*Version: (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\n {4}Usage: entwine <app> <options>\n {4}Apps:\n(?: {8}(?:build|merge|info|convert)\n {12}[^\n\x00-\x1f\x7f\ufffd]+\n?)+$/.exec(output);
      const version = native ? `Entwine ${native[1]}` : output;
      if (code !== 0 || !version || version.length > 200 || /[\x00-\x1f\x7f\ufffd]/.test(version)) return finish(invalid('ept_converter_identity_invalid'));
      finish(null, version);
    });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

// Worker-only runtime capture. Invoke the returned absolute executablePath for
// the build, then assert the same identity after success. Paths/fingerprints are
// internal; converter receipt serialization selects only the named proof fields.
async function captureEptConverterIdentity(bin, options = {}) {
  const executablePath = await resolveExecutable(bin, options);
  const identity = await executableIdentity(executablePath, options);
  const version = await probeVersion(executablePath, options);
  const result = { name: 'entwine', executablePath, ...identity, version,
    command: [...EPT_CONVERTER_COMMAND], commandSha256: EPT_CONVERTER_COMMAND_SHA256 };
  await assertEptConverterIdentity(result, options);
  return result;
}

async function assertEptConverterIdentity(identity, options = {}) {
  if (!identity || typeof identity.executablePath !== 'string' || !path.isAbsolute(identity.executablePath)) fail();
  const actual = await executableIdentity(identity.executablePath, options);
  if (actual.executableSha256 !== identity.executableSha256 || actual.executableFingerprint !== identity.executableFingerprint) fail();
  return true;
}

module.exports = { captureEptConverterIdentity, assertEptConverterIdentity };
