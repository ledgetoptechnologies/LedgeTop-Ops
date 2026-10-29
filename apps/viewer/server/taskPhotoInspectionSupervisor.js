'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const MAX_CHILDREN = 4;
let active = 0;
function runImportInspection(input, { timeoutMs = 10000, workerFile = path.join(__dirname, 'taskPhotoInspectionWorker.js') } = {}) {
  if (active >= MAX_CHILDREN) return Promise.reject(Object.assign(new Error('Import inspection is busy.'), { code: 'import_inspection_busy' }));
  active++;
  return new Promise((resolve, reject) => {
    let child, settled = false, timer;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(value); };
    try { child = fork(workerFile, [], { stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json', execArgv: [], windowsHide: true }); }
    catch (error) { active--; finish(error); return; }
    child.once('close', () => { active--; finish(Object.assign(new Error('Import inspection ended.'), { code: 'import_inspection_failed' })); });
    child.once('error', () => { finish(Object.assign(new Error('Import inspection failed.'), { code: 'import_inspection_failed' })); try { child.kill(); } catch {} });
    child.once('message', message => {
      if (message?.ok === true) finish(null, message.value);
      else finish(Object.assign(new Error('Import inspection failed.'), { code: typeof message?.code === 'string' && /^[a-z_]{1,80}$/.test(message.code) ? message.code : 'import_inspection_failed' }));
      if (child.connected) child.disconnect();
    });
    timer = setTimeout(() => { finish(Object.assign(new Error('Import inspection timed out.'), { code: 'import_inspection_timeout' })); try { child.kill(); } catch {} }, timeoutMs);
    child.send(input, error => { if (error) { finish(Object.assign(new Error('Import inspection failed.'), { code: 'import_inspection_failed' })); try { child.kill(); } catch {} } });
  });
}
module.exports = { runImportInspection };
