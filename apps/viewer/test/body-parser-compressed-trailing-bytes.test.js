'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { gzipSync } = require('node:zlib');
const test = require('node:test');

test('compressed JSON with trailing bytes cannot crash the Viewer request process', async t => {
  assert.equal(require('body-parser/package.json').version, '1.20.9', 'the patched body-parser release is locked');
  const source = [
    "const express=require('express');",
    'const app=express(); app.use(express.json()); app.post("/",(_req,res)=>res.status(204).end());',
    'const server=app.listen(0,"127.0.0.1",()=>process.stdout.write(`READY ${server.address().port}\\n`));',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && !child.killed) child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  });
  const port = await new Promise((resolve, reject) => {
    lines.on('line', line => {
      const match = /^READY (\d+)$/.exec(line);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`isolated Viewer process exited before ready (${code})`)));
  });
  const compressed = gzipSync(Buffer.from('{}'));
  const body = Buffer.concat([compressed, Buffer.from([0xff, 0x00, 0x7f])]);
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body,
  });
  await response.arrayBuffer();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, 'the parser must not crash the isolated process after the response');
  assert.equal(child.signalCode, null);
});
