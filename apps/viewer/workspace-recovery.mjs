import {validateWorkspaceSessionEnvelope} from './workspace-renewal.mjs';

const STATE_KEY='ltds-viewer-reauthorization-state';
const GRANT=/^[A-Za-z0-9_-]{32,128}$/;

// Recovery exchanges a fresh, one-use Ops grant. It never extends authority
// using an expired token alone, and never navigates the working tab.
export function createWorkspaceRecovery({windowRef=window,documentRef=document,fetchImpl=fetch,
  getSession,install,onFatal,onPaused=()=>{},onResumed=()=>{},now=()=>Date.now()}){
  let pending=null;
  function resetLaunch(record){
    try{record.channel?.close();}catch{}
    record.channel=null;record.popup=null;record.nonce=null;record.createdAt=0;
    try{windowRef.sessionStorage.removeItem(STATE_KEY);}catch{}
  }
  function closeDialog(record){
    try{record.dialog.close();}catch{}
    try{record.dialog.remove();}catch{}
  }
  function pause(){
    if(pending)return pending.promise;
    const previous=getSession();
    if(!previous?.session||!previous.accessToken)return Promise.reject(new Error('Open Viewer from Operations to sign in.'));
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    // A timer-driven pause may have no waiting request yet.
    promise.catch(()=>{});
    const dialog=documentRef.createElement('dialog');dialog.className='workspace-modal workspace-recovery';
    dialog.innerHTML='<h2>Sign in to continue</h2><p>Your workspace and selected photos are kept in this tab. Transfers pause until access is restored. Keep this tab open.</p><p role="status"></p><button type="button">Continue in Operations</button>';
    const status=dialog.querySelector('[role="status"]'),button=dialog.querySelector('button');
    pending={previous,promise,resolve,reject,dialog,status,button,popup:null,channel:null,nonce:null,createdAt:0,busy:false};
    dialog.addEventListener('cancel',event=>event.preventDefault());
    button.onclick=()=>{
      const record=pending;if(!record||record.busy)return;
      let origin;try{origin=new URL(previous.controllerOrigin);if(origin.protocol!=='https:'||origin.origin!==previous.controllerOrigin)throw new Error();}catch{status.textContent='Open Viewer from Operations to restore access.';return;}
      if(record.popup&&!record.popup.closed&&now()>=record.createdAt&&now()-record.createdAt<=5*60_000){try{record.popup.focus();return;}catch{}}
      resetLaunch(record);
      try{
        record.nonce=windowRef.crypto.randomUUID().replaceAll('-','');record.createdAt=now();
        // BroadcastChannel is optional: direct opener messaging remains available.
        try{if(windowRef.BroadcastChannel){record.channel=new windowRef.BroadcastChannel(`ltds-workspace-recovery:${record.nonce}`);record.channel.onmessage=event=>message(event,record);}}catch{record.channel=null;}
        windowRef.sessionStorage.setItem(STATE_KEY,JSON.stringify({nonce:record.nonce,createdAt:record.createdAt}));
        record.popup=windowRef.open(`${origin.origin}/viewer/reauthorize?state=${encodeURIComponent(record.nonce)}`,'_blank');
        if(!record.popup){resetLaunch(record);status.textContent='Your browser blocked the sign-in tab. Allow pop-ups, then try again.';return;}
        status.textContent='Complete sign-in in the new tab. This tab will resume automatically.';
      }catch{resetLaunch(record);status.textContent='Unable to open sign-in. Allow pop-ups and browser storage, then try again. Your work is still here.';}
    };
    documentRef.body.append(dialog);dialog.showModal();onPaused();return promise;
  }
  async function message(event,channelRecord=null){
    const record=pending,data=event.data;
    if(!record||record.busy||(channelRecord!==record&&event.source!==record.popup)||event.origin!==windowRef.location.origin
      ||!data||Object.keys(data).sort().join(',')!=='grant,nonce,type,version'
      ||data.type!=='ltds-viewer:workspace-recovery-grant'||data.version!==1
      ||data.nonce!==record.nonce||!GRANT.test(data.grant||''))return;
    if(now()-record.createdAt>5*60_000||now()<record.createdAt){resetLaunch(record);record.status.textContent='This sign-in attempt expired. Continue in Operations again; your work is still here.';return;}
    record.busy=true;record.button.disabled=true;record.status.textContent='Restoring access…';
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10_000);
    try{
      const response=await fetchImpl('/api/v1/admin-sessions/redeem',{method:'POST',headers:{Authorization:`Bearer ${record.previous.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({grant:data.grant}),signal:abort.signal});
      const body=await response.json().catch(()=>({}));if(pending!==record)return;
      if(!response.ok){const error=new Error('Sign-in could not restore this workspace.');error.fatal=response.status===401||response.status===403;throw error;}
      try{validateWorkspaceSessionEnvelope(body,{origin:record.previous.controllerOrigin,sessionId:record.previous.session.id,subject:record.previous.session.subject,accessToken:record.previous.accessToken});}
      catch{const error=new Error('Sign-in identity changed. Open a new workspace for that account.');error.fatal=true;throw error;}
      install(body);pending=null;
      const complete={version:1,type:'ltds-viewer:workspace-recovery-complete',nonce:record.nonce};
      try{record.popup?.postMessage(complete,windowRef.location.origin);}catch{}
      try{record.channel?.postMessage(complete);}catch{}
      resetLaunch(record);closeDialog(record);
      // A successful authority exchange must release waiting uploads even if
      // optional UI/storage/ack cleanup is unavailable in this browser.
      try{onResumed();}finally{record.resolve();}
    }catch(error){
      if(pending!==record)return;
      if(error.fatal){pending=null;resetLaunch(record);closeDialog(record);record.reject(error);onFatal();}
      else{record.busy=false;record.button.disabled=false;record.popup=null;record.status.textContent='Access could not be restored. Your work is still here; try signing in again.';}
    }finally{clearTimeout(timer);}
  }
  windowRef.addEventListener('message',message);
  function wait(signal){
    if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
    if(!pending)return Promise.resolve();
    if(!signal)return pending.promise;
    return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});pending.promise.then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});});
  }
  return{pause,wait,isPaused:()=>Boolean(pending),dispose(){windowRef.removeEventListener('message',message);if(pending){const record=pending;pending=null;resetLaunch(record);closeDialog(record);record.reject(new Error('Workspace closed'));}}};
}

export function relayWorkspaceRecoveryGrant({windowRef=window,documentRef=document,now=()=>Date.now()}={}){
  const url=new URL(windowRef.location.href),grant=url.pathname.match(/^\/workspace\/([A-Za-z0-9_-]{32,128})$/)?.[1],nonce=new URLSearchParams(url.hash.slice(1)).get('reauthorize');
  let state;try{state=JSON.parse(windowRef.sessionStorage.getItem(STATE_KEY)||'null');}catch{}
  if(!grant||!nonce||state?.nonce!==nonce||!Number.isFinite(state.createdAt)||now()-state.createdAt<0||now()-state.createdAt>5*60_000)return false;
  let channel=null;
  try{if(windowRef.BroadcastChannel)channel=new windowRef.BroadcastChannel(`ltds-workspace-recovery:${nonce}`);}catch{}
  if(!channel&&(!windowRef.opener||windowRef.opener.closed))return false;
  // Only the original same-origin Viewer tab can accept this capability.
  const message={version:1,type:'ltds-viewer:workspace-recovery-grant',nonce,grant};
  try{windowRef.opener?.postMessage(message,url.origin);}catch{}
  channel?.postMessage(message);
  windowRef.history.replaceState(null,'','/workspace');
  documentRef.body.textContent='Returning access to your existing Viewer tab. You can go back to it now.';
  const complete=(event,fromChannel=false)=>{if((fromChannel||event.source===windowRef.opener)&&event.origin===url.origin&&event.data?.version===1&&event.data?.type==='ltds-viewer:workspace-recovery-complete'&&event.data.nonce===nonce){windowRef.removeEventListener('message',complete);channel?.close();windowRef.sessionStorage.removeItem(STATE_KEY);windowRef.close();}};
  if(channel)channel.onmessage=event=>complete(event,true);
  windowRef.addEventListener('message',complete);return true;
}
