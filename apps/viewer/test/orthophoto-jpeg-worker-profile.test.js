'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {validateJpegWorkerProfile:validate,validateDatabaseFilesystemType:filesystem,
  sameJpegWorkerBaseline:same}=require('../server/orthophotoJpegWorkerProfile');

function observation(){
  return {selfPid:8,uid:568,uids:[568,568,568,568],capEff:'0000000000000000',noNewPrivs:1,
    memoryMax:'2147483648',memorySwapMax:'0',pidsMax:'64',cpuMax:'100000 100000',interfaces:['lo'],
    cgroupPath:'/',mount:{id:80,device:'0:26',type:'cgroup2',root:'/',readOnly:true},
    cgroupInode:'12345',cgroupType:'domain',nrDescendants:0,
    members:[{pid:8,startTicks:'9000',comm:'node'},{pid:1,startTicks:'8000',comm:'docker-init'}],
    procMembers:[{pid:1,startTicks:'8000',comm:'docker-init'},{pid:8,startTicks:'9000',comm:'node'}],
    identitiesAfter:[{pid:8,startTicks:'9000',comm:'node'},{pid:1,startTicks:'8000',comm:'docker-init'}]};
}

test('valid dedicated fixture normalizes stable baseline without image or host proof',()=>{
  const baseline=validate(observation());assert.equal(baseline.members[0].pid,1);
  assert.equal(baseline.uid,568);assert.equal(baseline.imageVerified,false);
  assert.equal(baseline.kernelProfileObserved,false); // Pure fixture validation is not observation.
  assert.equal(baseline.hostEngineVerified,false);assert.equal(baseline.initBinaryVerified,false);
  assert.equal(baseline.hostPrivateNamespaceEstablished,false);
  assert.equal(same(baseline,validate(observation())),true);
  const half=observation();half.cpuMax='50000 100000';assert.equal(validate(half).cpuMax,'50000 100000');
});

test('memory swap PID CPU privileges and network violations reject',()=>{
  for(const [key,value] of [['uid',0],['uids',[568,0,568,568]],['memoryMax','max'],
    ['memoryMax','4294967296'],['memorySwapMax','1'],['pidsMax','128'],
    ['cpuMax','max 100000'],['cpuMax','200000 100000'],['cpuMax','0 100000'],
    ['capEff','0000000000000001'],['noNewPrivs',0],['interfaces',['lo','eth0']]]){
    const o=observation();o[key]=value;
    assert.throws(()=>validate(o),undefined,key);
  }
});

test('extra live child zombie TGID mismatched membership and unknown init reject',()=>{
  for(const modify of [o=>o.members.push({pid:9,startTicks:'9001',comm:'python'}),
    o=>o.procMembers.push({pid:9,startTicks:'9001',comm:'zombie'}),
    o=>o.procMembers[1].startTicks='other',o=>o.procMembers[1].startTicks='9001',
    o=>o.members[1].comm='arbitrary-parent',o=>o.members.push(o.members[0]),
    o=>o.procMembers=[]]){
    const o=observation();modify(o);assert.throws(()=>validate(o));
  }
  const nodeOnly=observation();nodeOnly.members=[nodeOnly.members[0]];
  nodeOnly.procMembers=[nodeOnly.procMembers[1]];nodeOnly.identitiesAfter=[nodeOnly.identitiesAfter[0]];
  assert.equal(validate(nodeOnly).members.length,1);
});

test('changed PID lifetime extra member or nested cgroup cannot match pre-job baseline',()=>{
  const baseline=validate(observation());
  const changed=observation();changed.members[0].startTicks='9999';changed.procMembers[1].startTicks='9999';
  changed.identitiesAfter[0].startTicks='9999';
  assert.equal(same(baseline,validate(changed)),false);
  const inode=observation();inode.cgroupInode='9999';assert.equal(same(baseline,validate(inode)),false);
  for(const modify of [o=>o.nrDescendants=1,o=>o.mount.readOnly=false,
    o=>o.mount.type='cgroup',o=>o.cgroupPath='/shared',o=>o.mount.root='/shared',
    o=>o.cgroupType='threaded']){
    const o=observation();modify(o);assert.throws(()=>validate(o));
  }
  assert.equal(same(null,baseline),false);assert.equal(same({},{}),false);
});

test('same PID set with a reused lifetime during observation rejects',()=>{
  for(const modify of [o=>o.identitiesAfter[0].startTicks='9001',
    o=>o.identitiesAfter[1].startTicks='8001',o=>o.identitiesAfter.pop()]){
    const o=observation();modify(o);
    assert.throws(()=>validate(o),{code:'jpeg_worker_pid_lifetime_changed'});
  }
});

test('known local filesystem magic is allowed without claiming WAL colocation',()=>{
  for(const type of [0x2fc12fc1,0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630]){
    const result=filesystem(type);assert.equal(result.localTypeAllowed,true);assert.equal(result.colocationVerified,false);
    assert.deepEqual(filesystem(BigInt(type)),result);
  }
  assert.equal(filesystem(0x9123683e-2**32).name,'btrfs');
  for(const type of [0x6969,0xff534d42,0xfe534d42,0x65735546,'zfs',NaN,2**40,{},null])
    assert.throws(()=>filesystem(type));
});
