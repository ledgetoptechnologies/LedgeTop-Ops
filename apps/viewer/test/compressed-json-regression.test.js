'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const zlib = require('node:zlib');

test('trailing compressed request bytes do not crash the JSON parser', { timeout: 10000 }, async (t) => {
  const code = `const express=require('express'); const app=express();
    app.use(express.json({limit:'100kb'}));
    app.post('/test',(req,res)=>res.json(req.body));
    app.get('/health',(_req,res)=>res.send('ok'));
    app.use((err,_req,res,_next)=>res.status(400).send('bad'));
    const s=app.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', code], { cwd: require('node:path').resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
  });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited before ready: ${code}`)));
    child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
  });
  const body = zlib.gzipSync(Buffer.from('{"ok":true}'));
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/test', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); res.once('end', resolve); });
    req.on('error', reject);
    req.write(body);
    setTimeout(() => req.end(Buffer.from([0xff, 0xff, 0xff, 0xff])), 50);
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, 'server exited after malformed compressed request');
  const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject));
  assert.equal(status, 200);
});
