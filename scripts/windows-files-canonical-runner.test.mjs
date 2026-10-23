import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertCanonicalFileRunner} from './windows-files-canonical-runner.mjs';

test('file runner guard rejects both inherited input-type forms without echoing arguments', () => {
  for (const argv of [['--input-type=module'], ['--input-type', 'module'], ['--input-type=commonjs'], ['--input-type=private-value']])
    assert.throws(() => assertCanonicalFileRunner(argv), {message:'canonical_replay_use_file_runner'});
  for (const argv of [[], ['--enable-source-maps'], ['--import', 'file:///owned/local.mjs']])
    assert.doesNotThrow(() => assertCanonicalFileRunner(argv));
});

test('actual generator refuses eval module invocation before engine loading; file invocation reaches option validation', () => {
  const generator = new URL('./windows-files-canonical-baseline.mjs', import.meta.url).href;
  // Any engine import is a test failure, stronger than merely checking that no
  // workerd child appeared. Neither subprocess executes a replay or SQL.
  const script = `import Module from 'node:module';
const load=Module._load;
Module._load=function(name,...args){if(name==='miniflare'||name==='wrangler')throw Error('unexpected_engine_load');return load.call(this,name,...args);};
const {generateWindowsCanonicalBaseline}=await import(${JSON.stringify(generator)});
try{await generateWindowsCanonicalBaseline({baselineOnly:'invalid'});process.exitCode=2;}catch(error){process.stdout.write(error.message);}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(name.toUpperCase())));
  for (const flags of [['--input-type=module'], ['--input-type','module']]) {
    const result = spawnSync(process.execPath, [...flags, '-e', script], {encoding:'utf8', timeout:5000, windowsHide:true, env:environment});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'canonical_replay_use_file_runner');
  }
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'canonical-file-runner-'));
  try {
    const runner = path.join(directory, 'runner.mjs');
    fs.writeFileSync(runner, script);
    const result = spawnSync(process.execPath, [runner], {encoding:'utf8', timeout:5000, windowsHide:true, env:environment});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'canonical_replay_options_invalid');
  } finally {
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^canonical-file-runner-[A-Za-z0-9]{6}$/);
    fs.rmSync(resolved, {recursive:true, force:true});
  }
});
