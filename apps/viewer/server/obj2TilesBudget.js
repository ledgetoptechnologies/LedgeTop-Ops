'use strict';
// Opt-in ceiling only, not an admission guarantee. Unknown/nested cgroups stay at 2.
// A cgroup namespace may hide tighter host ancestor limits: activation requires
// independent operator qualification of the host hierarchy and peak workload.
const fs=require('node:fs'),os=require('node:os');
const GIB=1024**3;
function selectObj2TilesParallelism(requested,{cpu,limit,current,requiredBytes,pidsMax,pidsCurrent,requiredPids}={}){
 if(!Number.isSafeInteger(requested)||requested<2||requested>14)return 2;
 if(!Number.isSafeInteger(cpu)||cpu<2||!Number.isSafeInteger(limit)||!Number.isSafeInteger(current)||!Number.isSafeInteger(requiredBytes)||requiredBytes<=0||limit<=0||current<0||current>=limit||limit-current<4*GIB||limit-current-4*GIB<requiredBytes)return 2;
 if(!Number.isSafeInteger(pidsMax)||!Number.isSafeInteger(pidsCurrent)||!Number.isSafeInteger(requiredPids)||pidsMax<=0||pidsCurrent<0||requiredPids<=0||pidsCurrent>=pidsMax||pidsMax-pidsCurrent<requiredPids)return 2;
 return Math.max(2,Math.min(requested,cpu));
}
function effectiveCpu(affinity,cpuMax){
 if(!Number.isSafeInteger(affinity)||affinity<1||typeof cpuMax!=='string')return 0;const match=/^(max|[1-9][0-9]*) ([1-9][0-9]*)$/.exec(cpuMax.trim());if(!match)return 0;if(match[1]==='max')return affinity;const quota=Number(match[1]),period=Number(match[2]);if(!Number.isSafeInteger(quota)||!Number.isSafeInteger(period))return 0;return Math.min(affinity,Math.floor(quota/period));
}
function parseMemoryLimit(value){
 if(typeof value!=='string')return NaN;const text=value.trim();if(text==='max')return Infinity;if(!/^(?:0|[1-9][0-9]*)$/.test(text))return NaN;const number=Number(text);return Number.isSafeInteger(number)?number:NaN;
}
function runtimeObj2TilesParallelism(requested,requiredBytes,requiredPids,{read=fs.readFileSync,affinity=()=>os.availableParallelism(),platform=process.platform}={}){
 if(requested===2||platform!=='linux')return 2;
 try{if(read('/proc/self/cgroup','utf8').trim()!=='0::/')return 2;const max=parseMemoryLimit(read('/sys/fs/cgroup/memory.max','utf8')),high=parseMemoryLimit(read('/sys/fs/cgroup/memory.high','utf8')),current=parseMemoryLimit(read('/sys/fs/cgroup/memory.current','utf8')),limit=Math.min(max,high);const cpu=effectiveCpu(affinity(),read('/sys/fs/cgroup/cpu.max','utf8')),pidsMax=parseMemoryLimit(read('/sys/fs/cgroup/pids.max','utf8')),pidsCurrent=parseMemoryLimit(read('/sys/fs/cgroup/pids.current','utf8'));return selectObj2TilesParallelism(requested,{cpu,limit,current,requiredBytes,pidsMax,pidsCurrent,requiredPids});}catch{return 2;}
}
module.exports={selectObj2TilesParallelism,runtimeObj2TilesParallelism,effectiveCpu,parseMemoryLimit};
