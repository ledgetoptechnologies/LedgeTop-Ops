'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const MAX_CHILDREN = 4;
let active = 0;
function runImportInspection(input, { timeoutMs = 10000, workerFile = path.join(__dirname, 'taskPhotoInspectionWorker.js') } = {}) {
  if (active >= MAX_CHILDREN) return Promise.reject(Object.assign(new Error('Import inspection is busy.'), { code: 'import_inspection_busy' }));
  active++;
  return new Promise((resolve, reject) => {
    let child, settled = false, timer, forceTimer, reply, closed = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(value); };
    try { child = fork(workerFile, [], { stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json', execArgv: [], windowsHide: true }); }
    catch (error) { active--; finish(error); return; }
    const stopChild = () => {
      if (closed || forceTimer) return;
      try { child.kill(); } catch {}
      forceTimer = setTimeout(() => { if (!closed) try { child.kill('SIGKILL'); } catch {} }, 500);
    };
    child.once('close', code => {
      closed = true; active--; clearTimeout(forceTimer);
      if (code === 0 && reply?.ok === true) finish(null, reply.value);
      else if (code === 0 && reply?.ok === false) finish(Object.assign(new Error('Import inspection failed.'), { code: typeof reply.code === 'string' && /^[a-z_]{1,80}$/.test(reply.code) ? reply.code : 'import_inspection_failed' }));
      else finish(Object.assign(new Error('Import inspection ended.'), { code: 'import_inspection_failed' }));
    });
    child.once('error', () => { finish(Object.assign(new Error('Import inspection failed.'), { code: 'import_inspection_failed' })); stopChild(); });
    child.once('message', message => {
      reply = message;
    });
    timer = setTimeout(() => {
      finish(Object.assign(new Error('Import inspection timed out.'), { code: 'import_inspection_timeout' }));
      stopChild();
    }, timeoutMs);
    child.send(input, error => { if (error) { finish(Object.assign(new Error('Import inspection failed.'), { code: 'import_inspection_failed' })); stopChild(); } });
  });
}
module.exports = { runImportInspection };
