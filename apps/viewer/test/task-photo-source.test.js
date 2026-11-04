'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openPinnedImportRoot, openPinnedImportEntry } = require('../server/taskPhotoSource');
const linux = { skip: process.platform !== 'linux' && 'Linux descriptor traversal required' };
test('renaming an ancestor and replacing it with an outside symlink cannot redirect a pinned open', linux, t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'photo-anchor-')); t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const root=path.join(tmp,'root'),outside=path.join(tmp,'outside');fs.mkdirSync(path.join(root,'flight'),{recursive:true});fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root,'flight','point.csv'),'inside');fs.writeFileSync(path.join(outside,'point.csv'),'outside');
  const rootFd=openPinnedImportRoot(root);t.after(()=>fs.closeSync(rootFd));
  const fd=openPinnedImportEntry(rootFd,'flight/point.csv',{afterParentOpen(){fs.renameSync(path.join(root,'flight'),path.join(root,'old'));fs.symlinkSync(outside,path.join(root,'flight'));}});
  try { assert.equal(fs.readFileSync(fd,'utf8'),'inside'); } finally { fs.closeSync(fd); }
  assert.throws(()=>openPinnedImportEntry(rootFd,'flight/point.csv'));
  assert.throws(()=>openPinnedImportEntry(rootFd,'../outside/point.csv'),{code:'invalid_import_path'});
});
test('rejects FIFOs without blocking and final symlinks', linux, t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'photo-anchor-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  fs.writeFileSync(path.join(tmp,'regular'),'inside');fs.symlinkSync('regular',path.join(tmp,'link'));
  const rootFd=openPinnedImportRoot(tmp);t.after(()=>fs.closeSync(rootFd));
  assert.throws(()=>openPinnedImportEntry(rootFd,'link'));
  const {spawnSync}=require('node:child_process');assert.equal(spawnSync('mkfifo',[path.join(tmp,'pipe')]).status,0);
  assert.throws(()=>openPinnedImportEntry(rootFd,'pipe'),{code:'invalid_import_path'});
});
