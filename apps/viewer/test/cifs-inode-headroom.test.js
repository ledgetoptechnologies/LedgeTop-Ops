'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inodeHeadroom, recheckInodeHeadroom, guardDerivativeStorage, CIFS_MAGIC } = require('../server/inodeHeadroom');
const { StorageManager } = require('../server/storageManager');
const { spawnSync } = require('node:child_process');
const unknown = { fsType:CIFS_MAGIC, files:0, ffree:0 };
const low = { fsType:CIFS_MAGIC, files:100000, ffree:10000 };
const healthy = { fsType:CIFS_MAGIC, files:100000, ffree:50000 };
const fails = fn => assert.throws(fn, { code:'insufficient_storage' });

test('configuration defaults off and requires explicit opt-in', () => {
  const check = value => {
    const env = { ...process.env };
    if (value === undefined) delete env.VIEWER_ALLOW_CIFS_UNKNOWN_INODES;
    else env.VIEWER_ALLOW_CIFS_UNKNOWN_INODES=value;
    const child=spawnSync(process.execPath,['-e',"process.stdout.write(String(require('./server/config').config.allowCifsUnknownInodes))"],
      {cwd:path.join(__dirname,'..'),env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    return child.stdout;
  };
  assert.equal(check(undefined),'false');
  assert.equal(check('false'),'false');
  assert.equal(check('true'),'true');
});

test('unknown CIFS inode information requires explicit opt-in and remains unavailable', () => {
  fails(() => inodeHeadroom(unknown));
  fails(() => inodeHeadroom(unknown,{allowCifsUnknown:1}));
  assert.deepEqual(inodeHeadroom(unknown,{allowCifsUnknown:true,expectedFiles:10000}),
    {inodeCapacity:'unavailable',inodeReserve:null});
});

test('other filesystems, malformed counts, and low known capacity fail closed', () => {
  for (const s of [{...unknown,fsType:0x794c7630}, {...unknown,files:null},
    {...unknown,ffree:1}, {...unknown,files:1}, {...unknown,files:100,ffree:101},
    {...unknown,files:-1}, {...unknown,files:Infinity}, low]) {
    fails(() => inodeHeadroom(s,{allowCifsUnknown:true,expectedFiles:1}));
  }
  assert.equal(inodeHeadroom(healthy,{allowCifsUnknown:true,expectedFiles:10000}).inodeCapacity,'measured');
});

test('runtime rechecks reject measured-to-unknown, low, anomalous and other-fs transitions', () => {
  const measured=inodeHeadroom(healthy,{allowCifsUnknown:true});
  const unavailable=inodeHeadroom(unknown,{allowCifsUnknown:true});
  fails(() => recheckInodeHeadroom(unknown,measured,true));
  fails(() => recheckInodeHeadroom({...unknown,fsType:1},unavailable,true));
  fails(() => recheckInodeHeadroom(low,unavailable,true));
  fails(() => recheckInodeHeadroom({...unknown,ffree:1},unavailable,true));
  fails(() => recheckInodeHeadroom(unknown,unavailable,false));
  assert.equal(recheckInodeHeadroom(unknown,unavailable,true).inodeCapacity,'unavailable');
  assert.equal(recheckInodeHeadroom(healthy,unavailable,true).inodeCapacity,'measured');
});

test('runtime guard still stops below byte reserve even with unknown-inode opt-in', () => {
  const admission=inodeHeadroom(unknown,{allowCifsUnknown:true}),gib=1024**3;
  assert.equal(guardDerivativeStorage({...unknown,available:20*gib,reserve:10*gib},admission,true).inodeCapacity,'unavailable');
  fails(()=>guardDerivativeStorage({...unknown,available:15*gib,reserve:10*gib},admission,true));
  fails(()=>guardDerivativeStorage({...unknown,available:NaN,reserve:10*gib},admission,true));
  fails(()=>guardDerivativeStorage({...low,available:20*gib,reserve:10*gib},admission,true));
});

test('runtime preserves the highest measured reserve when inode totals shrink', () => {
  const high={fsType:CIFS_MAGIC,files:2_000_000,ffree:400_000};
  const smaller={fsType:CIFS_MAGIC,files:100_000,ffree:50_000};
  const admission=inodeHeadroom(high,{expectedFiles:10000});
  assert.equal(admission.inodeReserve,100_000);
  fails(()=>recheckInodeHeadroom(smaller,admission,true));
  const lowReserve=inodeHeadroom({fsType:CIFS_MAGIC,files:100_000,ffree:90_000});
  const raised=recheckInodeHeadroom(high,lowReserve,true);
  assert.equal(raised.inodeReserve,100_000);
  fails(()=>recheckInodeHeadroom(smaller,raised,true));
});

test('real admission preserves byte and concurrency reservations with explicit unknown policy', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cifs-inode-policy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config={modelsMount:root,cacheMount:root,allowCifsUnknownInodes:true};
  const storage=new StorageManager(config),gib=1024**3;
  storage.space=(_root,required)=>({available:100*gib,total:200*gib,reserve:20*gib,
    required,ok:100*gib-required>=20*gib,...unknown});
  const result=storage.requireDerivativeSpace('models',{sourceBytes:gib,expectedFiles:10000,
    reservedBytes:8*gib,otherReservedBytes:2*gib,reservedDatasetBytes:[gib]});
  assert.equal(result.required,14*gib);
  assert.equal(result.inodeCapacity,'unavailable');
  fails(()=>storage.requireDerivativeSpace('models',{sourceBytes:gib,reservedBytes:81*gib}));
  config.allowCifsUnknownInodes=false;
  fails(()=>storage.requireDerivativeSpace('models',{sourceBytes:gib}));
});
