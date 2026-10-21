// Native integration runs outside the interaction/render thread. Neither this
// wrapper nor its worker can start server processing or fetch another asset.
export function calculateBrowserSurface(options, {signal, WorkerClass}={}) {
  if(signal?.aborted)return Promise.reject(new DOMException('Calculation cancelled','AbortError'));
  return new Promise((resolve,reject)=>{
    const worker=WorkerClass ? new WorkerClass() : new Worker(new URL('./measurement-surface-worker.mjs',import.meta.url),{type:'module'});
    let complete=false;
    const finish=(error,result)=>{if(complete)return;complete=true;signal?.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(result);};
    const abort=()=>finish(new DOMException('Calculation cancelled','AbortError'));
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=event=>event.data?.ok?finish(null,event.data.result):finish(new Error(event.data?.error||'Surface calculation failed.'));
    worker.onerror=()=>finish(new Error('The browser calculation worker could not run. No reduced-resolution substitute was used.'));
    try{worker.postMessage(options);}catch(error){finish(error);}
  });
}
