'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const zlib = require('node:zlib');
const readline = require('node:readline');

test('trailing compressed request bytes do not crash the JSON parser', { timeout: 10000 }, async (t) => {
  const code = `const express=require('express'); const app=express();
    app.use(express.json({limit:'100kb'}));
    app.post('/test',(req,res)=>res.json(req.body));
    app.get('/health',(_req,res)=>res.send('ok'));
    app.use((err,_req,res,_next)=>res.status(400).send('bad'));
    const s=app.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', code], { cwd: process.env.VIEWER_TEST_EXPRESS_ROOT || require('node:path').resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        let forceTimer;
        const timer = setTimeout(() => {
          if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
            reject(new Error('unable to terminate owned test server'));
            return;
          }
          forceTimer = setTimeout(() => reject(new Error('owned test server did not close after termination')), 2000);
        }, 2000);
        child.once('close', () => { clearTimeout(timer); clearTimeout(forceTimer); resolve(); });
        if (!child.kill() && child.exitCode === null && child.signalCode === null) {
          clearTimeout(timer);
          reject(new Error('unable to signal owned test server'));
        }
      });
    }
  });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited before ready: ${code}`)));
    readline.createInterface({ input: child.stdout }).once('line', (line) => resolve(Number(line)));
  });
  const body = zlib.gzipSync(Buffer.from('{"ok":true}'));
  const validStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/test', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(validStatus, 200);
  const first = Buffer.concat([body, Buffer.from([0])]);
  const trailing = Buffer.alloc(100 * 1024, 0x58);
  const malformedStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/test', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': first.length + trailing.length } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(first);
    setTimeout(() => req.end(trailing), 50);
  });
  assert.ok([200, 400].includes(malformedStatus), `unexpected status ${malformedStatus}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, 'server exited after malformed compressed request');
  const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject));
  assert.equal(status, 200);
});
