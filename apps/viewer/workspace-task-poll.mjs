// One timer per current active task; redraws do not restart its cadence.
export function createWorkspaceTaskPoll({poll,intervalMs=5000,setIntervalFn=setInterval,clearIntervalFn=clearInterval}) {
  let timer=null,taskId=null,paused=false,generation=0;const pending=new Set();
  function stopTimer(){generation++;if(timer!==null)clearIntervalFn(timer);timer=null}
  function start(){if(paused||!taskId||timer!==null)return;const current=taskId,epoch=generation;timer=setIntervalFn(()=>{if(paused||taskId!==current||generation!==epoch||pending.has(current))return;pending.add(current);Promise.resolve().then(()=>{if(!paused&&taskId===current&&generation===epoch)return poll(current)}).catch(()=>{}).finally(()=>pending.delete(current))},intervalMs)}
  return {
    sync(next){next=next||null;if(next===taskId){start();return}stopTimer();taskId=next;start()},
    pause(){paused=true;stopTimer()},
    resume(){paused=false;start()},
    stop(){stopTimer();taskId=null},
  };
}
