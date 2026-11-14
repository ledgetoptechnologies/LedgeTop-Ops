// The parser wrapper runs a real child process: Node itself stands in for dji-log, with a script as the "log",
// so the exact argument list, timeout and output handling are exercised without the Rust binary or a DJI key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, runParser } from '../src/parser.mjs';

const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
// runParser calls: <binary> <inputFile> --output <file> [--api-key <key>]. With binary = node, inputFile is a script.
function stand(source) { const dir = work(); const file = path.join(dir, 'stand-in.mjs'); fs.writeFileSync(file, source); return { dir, file }; }

test('runs the parser with fixed arguments, passes the key only as the parser argument, and reads its JSON output', async () => {
  const { dir, file } = stand(`import fs from 'node:fs';
const args = process.argv.slice(2), out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out, JSON.stringify({ version: 14, frames: [{}], seenKey: args[args.indexOf('--api-key') + 1], argCount: args.length, envKeys: Object.keys(process.env) }));`);
  // Anything in the runner's own environment (its token file path, for example) must not reach the parser.
  process.env.LT_RUNNER_ONLY = 'runner-environment-value';
  try {
    const output = await runParser({ binary: process.execPath, inputFile: file, workDir: dir, apiKey: 'stand-in-key' });
    assert.equal(output.seenKey, 'stand-in-key');
    assert.equal(output.argCount, 4);
    assert.equal(output.envKeys.includes('LT_RUNNER_ONLY'), false, 'the parser gets only PATH from the runner (the OS may add its own defaults)');
  } finally { delete process.env.LT_RUNNER_ONLY; }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failures map to closed codes and never pass the parser’s own text on', async () => {
  const { dir, file } = stand(`console.error('thread main panicked: Unable to fetch keychain: secret detail'); process.exit(101);`);
  await assert.rejects(runParser({ binary: process.execPath, inputFile: file, workDir: dir, apiKey: 'k' }),
    error => error.code === 'keychain_unavailable' && !String(error.message).includes('secret detail'));
  const slow = stand('setTimeout(() => {}, 60_000);');
  await assert.rejects(runParser({ binary: process.execPath, inputFile: slow.file, workDir: slow.dir, timeoutMs: 300 }), error => error.code === 'decoder_error');
  const noOutput = stand('process.exit(0);');
  await assert.rejects(runParser({ binary: process.execPath, inputFile: noOutput.file, workDir: noOutput.dir }), error => error.code === 'decoder_error');
  const notJson = stand(`import fs from 'node:fs'; const a = process.argv.slice(2); fs.writeFileSync(a[a.indexOf('--output') + 1], 'not json');`);
  await assert.rejects(runParser({ binary: process.execPath, inputFile: notJson.file, workDir: notJson.dir }), error => error.code === 'decoder_error');
  await assert.rejects(runParser({ binary: path.join(dir, 'no-such-parser'), inputFile: file, workDir: dir }), error => error.code === 'decoder_error');
  for (const d of [dir, slow.dir, noOutput.dir, notJson.dir]) fs.rmSync(d, { recursive: true, force: true });
});

test('classification is closed: only contract codes come out', () => {
  assert.equal(classifyFailure({ stderr: 'API Key is required for version 13 and above' }), 'keychain_unavailable');
  assert.equal(classifyFailure({ stderr: 'Unable to read file' }), 'raw_missing');
  assert.equal(classifyFailure({ timedOut: true }), 'decoder_error');
  assert.equal(classifyFailure({ stderr: 'anything else at all' }), 'decoder_error');
});
