'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};
const INIT_NAMES=new Set(['docker-init','tini','dumb-init']);
const LOCAL_FILESYSTEMS=new Map([[0x2fc12fc1,'zfs'],[0xef53,'ext4'],[0x58465342,'xfs'],
  [0x9123683e,'btrfs'],[0x01021994,'tmpfs'],[0x794c7630,'overlay']]);
const numeric=raw=>typeof raw==='string'&&/^[0-9]+$/.test(raw);

function validateDatabaseFilesystemType(type){
  need(typeof type==='bigint'||Number.isSafeInteger(type),'jpeg_database_filesystem_unknown');
  const n=BigInt(type);need(n>=-(2n**31n)&&n<=0xffffffffn,'jpeg_database_filesystem_unknown');
  const magic=Number(BigInt.asUintN(32,n)),name=LOCAL_FILESYSTEMS.get(magic);
  need(name,'jpeg_database_filesystem_not_local');
  // A local magic is NOT proof of API/worker WAL colocation or durable storage.
  return {name,magic:'0x'+magic.toString(16),localTypeAllowed:true,colocationVerified:false};
}

function members(value,selfPid){
  need(Array.isArray(value)&&value.length>=1&&value.length<=64,'jpeg_worker_member_bound');
  const sorted=value.map(row=>{
    need(row&&Number.isSafeInteger(row.pid)&&row.pid>0&&numeric(row.startTicks)&&
      row.startTicks.length<=24&&typeof row.comm==='string'&&row.comm.length<=64,'jpeg_worker_pid_identity');
    need(row.pid===selfPid||row.pid===1&&INIT_NAMES.has(row.comm),'jpeg_worker_not_dedicated');
    return {pid:row.pid,startTicks:row.startTicks,comm:row.comm};
  }).sort((a,b)=>a.pid-b.pid);
  need(sorted.length<=2&&sorted.some(row=>row.pid===selfPid)&&
    new Set(sorted.map(row=>row.pid)).size===sorted.length,'jpeg_worker_not_dedicated');
  return sorted;
}

function validateJpegWorkerProfile(o){
  need(o&&Number.isSafeInteger(o.selfPid)&&o.selfPid>0&&o.uid===568&&
    Array.isArray(o.uids)&&o.uids.length===4&&o.uids.every(value=>value===568),'jpeg_worker_uid');
  need(typeof o.capEff==='string'&&/^[a-fA-F0-9]{1,16}$/.test(o.capEff)&&
    BigInt('0x'+o.capEff)===0n&&o.noNewPrivs===1,'jpeg_worker_privileges');
  need(o.memoryMax==='2147483648'&&o.memorySwapMax==='0'&&o.pidsMax==='64','jpeg_worker_resource_limits');
  const cpu=typeof o.cpuMax==='string'?o.cpuMax.split(/\s+/):[];
  need(cpu.length===2&&cpu.every(numeric)&&cpu.every(value=>Number.isSafeInteger(Number(value)))&&
    Number(cpu[0])>0&&Number(cpu[1])>0&&Number(cpu[0])<=Number(cpu[1]),'jpeg_worker_cpu');
  need(Array.isArray(o.interfaces)&&o.interfaces.length===1&&o.interfaces[0]==='lo','jpeg_worker_network');
  need(o.cgroupPath==='/'&&o.mount&&o.mount.type==='cgroup2'&&o.mount.root==='/'&&
    o.mount.readOnly===true&&Number.isSafeInteger(o.mount.id)&&o.mount.id>0&&
    typeof o.mount.device==='string'&&/^\d+:\d+$/.test(o.mount.device)&&
    typeof o.cgroupInode==='string'&&numeric(o.cgroupInode)&&o.cgroupType==='domain'&&
    o.nrDescendants===0,'jpeg_worker_cgroup');
  const baseline=members(o.members,o.selfPid),proc=members(o.procMembers,o.selfPid);
  need(JSON.stringify(baseline)===JSON.stringify(proc),'jpeg_worker_proc_membership_mismatch');
  const after=members(o.identitiesAfter,o.selfPid);
  need(JSON.stringify(baseline)===JSON.stringify(after),'jpeg_worker_pid_lifetime_changed');
  return {schemaVersion:1,kind:'dedicated-jpeg-kernel-profile',selfPid:o.selfPid,uid:568,
    capEff:'0',noNewPrivs:1,memoryMax:o.memoryMax,memorySwapMax:o.memorySwapMax,pidsMax:o.pidsMax,
    cpuMax:cpu.join(' '),interfaces:['lo'],cgroupPath:'/',cgroupType:'domain',
    mount:{id:o.mount.id,device:o.mount.device,type:'cgroup2',root:'/',readOnly:true},
    cgroupInode:o.cgroupInode,nrDescendants:0,members:baseline,
    kernelProfileObserved:false,imageVerified:false,hostEngineVerified:false,
    hostPrivateNamespaceEstablished:false,initBinaryVerified:false};
}

async function read(path,maximum){
  need(Number.isInteger(constants.O_NOFOLLOW)&&Number.isInteger(constants.O_NONBLOCK),'jpeg_worker_nofollow_required');
  const fd=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const buffer=Buffer.alloc(maximum+1),{bytesRead}=await fd.read(buffer,0,buffer.length,0);
    need(bytesRead<=maximum,'jpeg_worker_kernel_read_bound');return buffer.subarray(0,bytesRead).toString('utf8').trim();
  }finally{await fd.close();}
}

function pids(raw){
  const values=raw?raw.split(/\s+/):[];
  need(values.length<=64&&values.every(numeric),'jpeg_worker_member_bound');
  const result=values.map(Number).sort((a,b)=>a-b);
  need(result.every(value=>Number.isSafeInteger(value)&&value>0)&&new Set(result).size===result.length,
    'jpeg_worker_pid_identity');return result;
}

async function procPids(){
  const directory=await fs.opendir('/proc');let entries=0;const result=[];
  try{
    for(;;){
      const entry=await directory.read();if(!entry)break;
      need(++entries<=256,'jpeg_worker_proc_entry_bound');
      if(!numeric(entry.name))continue;
      need(entry.isDirectory()&&result.length<64,'jpeg_worker_member_bound');result.push(Number(entry.name));
    }
  }finally{await directory.close();}
  return pids(result.join(' '));
}

async function identity(pid){
  const raw=await read('/proc/'+pid+'/stat',8192),opening=raw.indexOf(' ('),closing=raw.lastIndexOf(') ');
  need(opening>0&&closing>opening&&Number(raw.slice(0,opening))===pid,'jpeg_worker_proc_stat');
  const fields=raw.slice(closing+2).split(/\s+/);
  need(fields.length>=20&&numeric(fields[19]),'jpeg_worker_proc_stat');
  return {pid,startTicks:fields[19],comm:raw.slice(opening+2,closing)};
}

async function inspectJpegWorkerProfile({signal=null,assertCurrent=()=>{}}={}){
  const check=()=>{signal?.throwIfAborted();assertCurrent();};check();
  need(process.platform==='linux','jpeg_worker_linux_required');
  const [status,cgroup,mountinfo,net,cgstat,memoryMax,memorySwapMax,pidsMax,cpuMax,cgroupType,cgprocs]=await Promise.all([
    read('/proc/self/status',16384),read('/proc/self/cgroup',4096),read('/proc/self/mountinfo',65536),
    read('/proc/net/dev',4096),read('/sys/fs/cgroup/cgroup.stat',4096),
    ...['memory.max','memory.swap.max','pids.max','cpu.max','cgroup.type','cgroup.procs'].map(name=>read('/sys/fs/cgroup/'+name,4096))]);
  need(cgroup==='0::/','jpeg_worker_cgroup_namespace_required');
  const fields=Object.fromEntries(status.split('\n').filter(line=>line.includes(':')).map(line=>{const i=line.indexOf(':');return [line.slice(0,i),line.slice(i+1).trim()];}));
  const mounts=mountinfo.split('\n').map(line=>line.split(' ')).filter(row=>row[4]==='/sys/fs/cgroup');
  need(mounts.length===1,'jpeg_worker_cgroup_mount');const m=mounts[0],separator=m.indexOf('-');
  need(separator>=6,'jpeg_worker_cgroup_mount');
  const interfaces=net.split('\n').slice(2).filter(Boolean).map(line=>line.split(':')[0].trim()).sort();
  const stats=Object.fromEntries(cgstat.split('\n').map(line=>line.trim().split(/\s+/)));
  const procBefore=await procPids(),groupBefore=pids(cgprocs);
  const identities=await Promise.all([...new Set([...procBefore,...groupBefore])].map(identity));
  const procAfter=await procPids(),groupAfter=pids(await read('/sys/fs/cgroup/cgroup.procs',4096));
  need(JSON.stringify(procBefore)===JSON.stringify(procAfter)&&JSON.stringify(groupBefore)===JSON.stringify(groupAfter),
    'jpeg_worker_membership_changed_during_observation');
  const afterStats=Object.fromEntries((await read('/sys/fs/cgroup/cgroup.stat',4096)).split('\n').map(line=>line.trim().split(/\s+/)));
  need(stats.nr_descendants===afterStats.nr_descendants&&afterStats.nr_descendants==='0',
    'jpeg_worker_cgroup_children_changed');
  // Equal PID sets alone cannot exclude exit/reuse during the observation.
  // Re-read start ticks for every observed TGID before accepting the baseline.
  const identitiesAfter=await Promise.all([...new Set([...procAfter,...groupAfter])].map(identity));
  const directory=await fs.stat('/sys/fs/cgroup',{bigint:true});
  const uids=(fields.Uid||'').split(/\s+/).map(Number);
  const profile=validateJpegWorkerProfile({selfPid:process.pid,uid:process.getuid(),uids,capEff:fields.CapEff,
    noNewPrivs:Number(fields.NoNewPrivs),memoryMax,memorySwapMax,pidsMax,cpuMax,interfaces,cgroupPath:'/',
    mount:{id:Number(m[0]),device:m[2],root:m[3],type:m[separator+1],readOnly:m[5].split(',').includes('ro')&&!m[5].split(',').includes('rw')},
    cgroupInode:String(directory.ino),cgroupType,nrDescendants:numeric(stats.nr_descendants)?Number(stats.nr_descendants):null,
    members:groupBefore.map(pid=>identities.find(row=>row.pid===pid)),procMembers:procBefore.map(pid=>identities.find(row=>row.pid===pid)),
    identitiesAfter});
  check();return {...profile,kernelProfileObserved:true};
}

async function observeClosure(baseline,context){
  try{
    const observed=await inspectJpegWorkerProfile(context);
    need(sameJpegWorkerBaseline(baseline,observed),'jpeg_worker_closure_changed');
    return {closureObserved:true,observed,physicalHostClosureEstablished:false};
  }catch(error){return {closureObserved:false,errorCode:error.code||'jpeg_worker_closure_unknown',physicalHostClosureEstablished:false};}
}

// Pure comparison only; no kernel-observation/closure claim is returned here.
function sameJpegWorkerBaseline(baseline,observed){
  return Boolean(baseline?.schemaVersion===1&&baseline.kind==='dedicated-jpeg-kernel-profile'&&
    observed?.schemaVersion===1&&observed.kind==='dedicated-jpeg-kernel-profile'&&
    JSON.stringify(observed)===JSON.stringify(baseline));
}

module.exports={validateJpegWorkerProfile,inspectJpegWorkerProfile,observeClosure,
  validateDatabaseFilesystemType,sameJpegWorkerBaseline};
