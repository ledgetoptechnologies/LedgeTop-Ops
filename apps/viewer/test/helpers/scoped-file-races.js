'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Changes that happen while one file is being proven. `outside` is an absent
// path next to, but not inside, the storage root. Linux only: renaming an open
// file and creating links need privileges or fail on Windows.
const RACES = {
  'a link to outside the root': { at: 'resolve', run(file, outside) { fs.renameSync(file, outside); fs.symlinkSync(outside, file); } },
  'a link swapped in after the check': { at: 'open', run(file, outside) { fs.renameSync(file, outside); fs.symlinkSync(outside, file); } },
  'a directory swapped for a link to outside after the check': { at: 'open', run(file, outside) { fs.renameSync(path.dirname(file), outside); fs.symlinkSync(outside, path.dirname(file)); } },
  'another file swapped in after the check': { at: 'open', run(file) { const bytes = Buffer.from(fs.readFileSync(file)); bytes[0] ^= 1; fs.rmSync(file); fs.writeFileSync(file, bytes); } },
  'the name replaced after the open': { at: 'read', run(file) { fs.copyFileSync(file, `${file}.new`); fs.renameSync(`${file}.new`, file); } },
  'growth during the read': { at: 'read', run(file) { fs.appendFileSync(file, 'x'); } },
  'truncation during the read': { at: 'read', run(file) { fs.truncateSync(file, 4 * 1024 * 1024 + 1); } },
  'growth and shrinking back during the read': { at: 'read', run(file) { const { size } = fs.statSync(file); fs.appendFileSync(file, 'x'); fs.truncateSync(file, size); } },
};

// Runs the change once, when `file` is next proven. `fired` shows it happened.
function race(t, { at, run }, file, outside) {
  const { realpath, open } = fs.promises, state = { fired: 0, bytesRead: 0 };
  fs.chmodSync(file, 0o600);
  const fire = moment => { if (at === moment && !state.fired) { state.fired = 1; run(file, outside); } };
  t.after(() => { fs.promises.realpath = realpath; fs.promises.open = open; });
  fs.promises.realpath = async (...args) => { fire('resolve'); return realpath.apply(fs.promises, args); };
  fs.promises.open = async (target, ...rest) => {
    if (target !== file) return open.call(fs.promises, target, ...rest);
    fire('open');
    const handle = await open.call(fs.promises, target, ...rest), read = handle.read.bind(handle);
    handle.read = async (...args) => { const result = await read(...args); state.bytesRead += result.bytesRead; fire('read'); return result; };
    return handle;
  };
  return state;
}

module.exports = { RACES, race };
