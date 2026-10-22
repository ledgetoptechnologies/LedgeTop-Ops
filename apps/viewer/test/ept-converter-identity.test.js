'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { captureEptConverterIdentity, assertEptConverterIdentity } = require('../server/eptConverterIdentity');
const { EPT_CONVERTER_COMMAND, EPT_CONVERTER_COMMAND_SHA256 } = require('../server/eptConversionReceipt');
const linux = { skip: process.platform === 'win32' };
function fixture(t, code = "process.stdout.write('Entwine synthetic-test 1.0\\n')") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ept-converter-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'entwine');
  const bytes = Buffer.from(`#!${process.execPath}\nif(process.argv.length!==3||process.argv[2]!=='--version')process.exit(99);\n${code}\n`);
  fs.writeFileSync(file, bytes, { mode: 0o755 });
  return { root, file, bytes };
}

test('resolves explicit and PATH executables and hashes the exact bounded version probe', linux, async t => {
  const f = fixture(t);
  for (const [bin, options] of [[f.file, {}], ['entwine', { env: { ...process.env, PATH: f.root } }],
    ['./entwine', { cwd: f.root }]]) {
    const identity = await captureEptConverterIdentity(bin, options);
    assert.equal(identity.executablePath, fs.realpathSync(f.file));
    assert.equal(identity.version, 'Entwine synthetic-test 1.0');
    assert.equal(identity.executableSha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
    assert.deepEqual(identity.command, EPT_CONVERTER_COMMAND);
    assert.equal(identity.commandSha256, EPT_CONVERTER_COMMAND_SHA256);
    assert.equal(await assertEptConverterIdentity(identity), true);
  }
});

test('PATH lookup honors the first executable and captures a symlink target as the invoked path', linux, async t => {
  const first = fixture(t), second = fixture(t, "process.stdout.write('Second version')");
  fs.chmodSync(first.file, 0o644);
  const identity = await captureEptConverterIdentity('entwine', { env: { ...process.env, PATH: `${first.root}:${second.root}` } });
  assert.equal(identity.executablePath, second.file);
  const alias = path.join(first.root, 'alias'); fs.symlinkSync(second.file, alias);
  assert.equal((await captureEptConverterIdentity(alias)).executablePath, second.file);
});

test('native Entwine 2.2.0 usage banner yields a canonical version and exact executable identity', linux, async t => {
  const banner = 'Invalid app type\n    Version: 2.2.0\n    Usage: entwine <app> <options>\n    Apps:\n        build\n            Build an EPT dataset\n        merge\n            Merge colocated entwine subsets\n        info\n            Gather metadata information about point cloud files\n        convert\n            Convert an entwine dataset to a different format\n\n';
  const f = fixture(t, `process.stdout.write(${JSON.stringify(banner)})`);
  const identity = await captureEptConverterIdentity(f.file);
  assert.equal(identity.version, 'Entwine 2.2.0');
  assert.equal(identity.executableSha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
  for (const invalid of [banner.replace('Usage: entwine', 'Usage: other'), banner.replace('        build', '        unknown'), `${banner}unexpected`, banner.replace('Version: 2.2.0', 'Version: unknown')]) {
    const bad = fixture(t, `process.stdout.write(${JSON.stringify(invalid)})`);
    await assert.rejects(captureEptConverterIdentity(bad.file), { code: 'ept_converter_identity_invalid' });
  }
});

test('same-path changed bytes and identical-byte replacement both invalidate captured execution identity', linux, async t => {
  for (const replace of [false, true]) {
    const f = fixture(t), identity = await captureEptConverterIdentity(f.file);
    if (replace) {
      const replacement = `${f.file}.new`; fs.writeFileSync(replacement, f.bytes, { mode: 0o755 }); fs.renameSync(replacement, f.file);
    } else fs.appendFileSync(f.file, '\n// changed');
    await assert.rejects(assertEptConverterIdentity(identity), { code: 'ept_converter_identity_invalid' });
  }
});

test('converter mutation during version probing cannot be captured as stable identity', linux, async t => {
  const f = fixture(t, "require('node:fs').appendFileSync(process.argv[1], '\\n// modified');process.stdout.write('Entwine synthetic 1.0')");
  await assert.rejects(captureEptConverterIdentity(f.file), { code: 'ept_converter_identity_invalid' });
});

test('failed, oversized, malformed and hanging version probes fail closed', linux, async t => {
  const cases = [
    ["process.exit(1)", 'ept_converter_identity_invalid'],
    ["process.stdout.write('x'.repeat(5000))", 'ept_converter_probe_limit'],
    ["process.stderr.write('Entwine\\nextra line')", 'ept_converter_identity_invalid'],
    ["process.stdout.write('')", 'ept_converter_identity_invalid'],
    ["setInterval(()=>{},1000)", 'ept_converter_probe_timeout'],
  ];
  for (const [code, expected] of cases) {
    const f = fixture(t, code);
    await assert.rejects(captureEptConverterIdentity(f.file, { timeoutMs: expected.endsWith('timeout') ? 100 : 3000 }), { code: expected });
  }
});

test('missing executables and cancellation never yield converter proof', linux, async t => {
  const f = fixture(t);
  await assert.rejects(captureEptConverterIdentity(path.join(f.root, 'missing')), { code: 'ept_converter_unavailable' });
  await assert.rejects(captureEptConverterIdentity(f.file, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const hanging = fixture(t, "setInterval(()=>{},1000)"), controller = new AbortController();
  const pending = captureEptConverterIdentity(hanging.file, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { name: 'AbortError' });
});
