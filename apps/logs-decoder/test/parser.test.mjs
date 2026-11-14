// The parser wrapper call runs a real child process: Node itself stands in for ltds-dji-decode, with a script as the
// "log", so the exact arguments, environment, exit-code mapping and limits are exercised without the Rust binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyExit, runParser, ParserError } from '../src/parser.mjs';

const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
// runParser calls: <binary> <inputFile> <outputFile>. With binary = node, inputFile is the stand-in script.
function stand(source) { const dir = work(); const file = path.join(dir, 'stand-in.mjs'); fs.writeFileSync(file, source); return { dir, file }; }

test('only input and output paths are on the command line; the key reaches the parser as a file path, never its value', async () => {
  const { dir, file } = stand(`import fs from 'node:fs';
const [out] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({ version: 14, frames: [{}], argv: process.argv.slice(2), keyFile: process.env.DJI_API_KEY_FILE, envKeys: Object.keys(process.env) }));`);
  const keyFile = path.join(dir, 'dji_api_key_staging');
  fs.writeFileSync(keyFile, 'stand-in-key-value');
  process.env.LT_RUNNER_ONLY = 'runner-environment-value';
  try {
    const output = await runParser({ binary: process.execPath, inputFile: file, workDir: dir, keyFile });
    assert.deepEqual(output.argv, [path.join(dir, 'frames.json')], 'one argument after the input: the output path');
    assert.equal(JSON.stringify(output).includes('stand-in-key-value'), false, 'the key value never appears');
    assert.equal(output.keyFile, keyFile);
    assert.equal(output.envKeys.includes('LT_RUNNER_ONLY'), false, 'only PATH and the key file path come from the runner');
  } finally { delete process.env.LT_RUNNER_ONLY; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exit codes map to defer, retry or fail with contract codes; no parser text is used', async () => {
  const cases = [[10, 'defer', 'keychain_unavailable'], [11, 'defer', 'keychain_unavailable'], [12, 'defer', 'dji_unavailable'], [13, 'defer', 'network_unavailable'],
    [20, 'fail', 'corrupt_log'], [30, 'suspend', 'resource_capacity'], [40, 'retry', 'decoder_error'], [2, 'retry', 'decoder_error']];
  for (const [exit, action, code] of cases) {
    const { dir, file } = stand(`console.error('secret detail'); process.exit(${exit});`);
    await assert.rejects(runParser({ binary: process.execPath, inputFile: file, workDir: dir }),
      error => error instanceof ParserError && error.action === action && error.code === code && !error.message.includes('secret'), `exit ${exit}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const slow = stand('setTimeout(() => {}, 60_000);');
  await assert.rejects(runParser({ binary: process.execPath, inputFile: slow.file, workDir: slow.dir, timeoutMs: 300 }), error => error.action === 'retry' && error.code === 'decoder_error');
  const big = stand(`import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'x'.repeat(2048));`);
  await assert.rejects(runParser({ binary: process.execPath, inputFile: big.file, workDir: big.dir, maxOutputBytes: 1024 }), error => error.action === 'suspend' && error.code === 'log_too_large');
  const notJson = stand(`import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'not json');`);
  await assert.rejects(runParser({ binary: process.execPath, inputFile: notJson.file, workDir: notJson.dir }), error => error.code === 'decoder_error');
  await assert.rejects(runParser({ binary: path.join(notJson.dir, 'no-such-parser'), inputFile: notJson.file, workDir: notJson.dir }), error => error.code === 'decoder_error');
  for (const d of [slow.dir, big.dir, notJson.dir]) fs.rmSync(d, { recursive: true, force: true });
  assert.deepEqual(classifyExit({ timedOut: true }), ['retry', 'decoder_error']);
  assert.deepEqual(classifyExit({ signal: 'SIGKILL' }), ['suspend', 'resource_capacity'], 'a kill we didn’t send is the memory limit');
  assert.deepEqual(classifyExit({ exitCode: 137 }), ['suspend', 'resource_capacity']);
});

test('stopping the runner kills a running parser promptly', async () => {
  const { dir, file } = stand('setTimeout(() => {}, 60_000);');
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(runParser({ binary: process.execPath, inputFile: file, workDir: dir, signal: controller.signal }), error => error.code === 'stopped');
  assert.ok(Date.now() - started < 10_000);
  fs.rmSync(dir, { recursive: true, force: true });
});
