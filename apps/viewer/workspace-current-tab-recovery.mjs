import {validateWorkspaceSessionEnvelope} from './workspace-renewal.mjs';

const STATE_KEY='ltds-viewer-reauthorization-state';
const OPS_ORIGIN_KEY='ltds-viewer-ops-origin';
const TOKEN=/^[A-Za-z0-9_-]{32,128}$/;
const SESSION=/^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT=/^ops:[A-Za-z0-9._:@-]{1,196}$/;
const MAX_AGE=5*60_000;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const origin=value=>{try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value?value:null;}catch{return null;}};
const failure=(status=400)=>Object.assign(new Error('This workspace sign-in return could not be verified. Open Viewer from Operations again.'),{status,fatal:true});

function viewHint(value){
  if(value==null)return null;
  if(!exactKeys(value,['section','selectedProjectId','expandedTaskId','taskPage'])
    ||!['dashboard','providers','background','trash','diagnostics'].includes(value.section)
    ||![value.selectedProjectId,value.expandedTaskId].every(id=>id===null||(typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)))
    ||!(value.taskPage===null||['gcp','settings','files'].includes(value.taskPage)))throw failure();
  return {...value};
}

/** Explicit user action only. Normal location navigation retains all registered
 * beforeunload guards. Only non-secret correlation/view hints are persisted;
 * File objects, upload promises and unsaved form/measurement drafts are not. */
export function beginCurrentTabWorkspaceRecovery({windowRef=window,previous,view=null,now=()=>Date.now()}){
  const viewerOrigin=origin(windowRef.location.origin),controllerOrigin=origin(previous?.controllerOrigin);
  if(!viewerOrigin||!controllerOrigin||!TOKEN.test(previous?.accessToken||'')
    ||!SESSION.test(previous?.session?.id||'')||!SUBJECT.test(previous?.session?.subject||'')
    ||windowRef.sessionStorage.getItem(OPS_ORIGIN_KEY)!==controllerOrigin)throw failure();
  const nonce=windowRef.crypto.randomUUID().replaceAll('-',''),createdAt=now();
  if(!TOKEN.test(nonce)||!Number.isSafeInteger(createdAt))throw failure();
  const record={version:1,mode:'same-tab',nonce,createdAt,viewerOrigin,controllerOrigin,
    sessionId:previous.session.id,subject:previous.session.subject,view:viewHint(view)};
  const serialized=JSON.stringify(record);
  windowRef.sessionStorage.setItem(STATE_KEY,serialized);
  if(windowRef.sessionStorage.getItem(STATE_KEY)!==serialized)throw failure();
  const destination=new URL('/viewer/reauthorize',controllerOrigin);
  destination.search=new URLSearchParams({state:nonce,recoveryMode:'same-tab'}).toString();
  // Never remove a pending-upload guard or bypass beforeunload here.
  windowRef.location.assign(destination.href);
  return Object.freeze({mode:'same-tab',nonce,navigationAttempted:true});
}

/** Runs before the popup relay/initial grant path. A same-tab nonce is consumed
 * synchronously before any await, so concurrent starts and replay mint nothing. */
export async function resumeCurrentTabWorkspaceRecovery({windowRef=window,accessToken,install,
  restoreView=()=>{},fetchImpl=fetch,now=()=>Date.now(),timeoutMs=10_000}){
  const url=new URL(windowRef.location.href),hash=new URLSearchParams(url.hash.slice(1));
  let record;
  try{record=JSON.parse(windowRef.sessionStorage.getItem(STATE_KEY)||'null');}catch{record=null;}
  if(!hash.has('recoveryMode')&&!(record?.mode==='same-tab'&&hash.has('reauthorize')))return false;
  // Clear both the one-use browser nonce and URL capability even on a bad return.
  // Either browser facility can fail independently. Still attempt both so a
  // denied storage operation cannot leave the one-use capability in history.
  let cleanupFailed=false;
  try{windowRef.history.replaceState(null,'','/workspace');}catch{cleanupFailed=true;}
  try{
    windowRef.sessionStorage.removeItem(STATE_KEY);
    if(windowRef.sessionStorage.getItem(STATE_KEY)!=null)cleanupFailed=true;
  }catch{cleanupFailed=true;}
  if(cleanupFailed)throw failure();
  const match=url.pathname.match(/^\/workspace\/([A-Za-z0-9_-]{32,128})$/);
  if(hash.getAll('recoveryMode').length!==1||hash.get('recoveryMode')!=='same-tab'
    ||hash.getAll('reauthorize').length!==1||[...hash.keys()].some(key=>!['reauthorize','recoveryMode'].includes(key))
    ||url.search||!match||!exactKeys(record,['version','mode','nonce','createdAt','viewerOrigin','controllerOrigin','sessionId','subject','view'])
    ||record.version!==1||record.mode!=='same-tab'||!TOKEN.test(record.nonce||'')||hash.get('reauthorize')!==record.nonce
    ||!origin(record.viewerOrigin)||url.origin!==record.viewerOrigin||windowRef.location.origin!==record.viewerOrigin
    ||!origin(record.controllerOrigin)||windowRef.sessionStorage.getItem(OPS_ORIGIN_KEY)!==record.controllerOrigin
    ||!Number.isSafeInteger(record.createdAt)||now()<record.createdAt||now()-record.createdAt>MAX_AGE
    ||!SESSION.test(record.sessionId||'')||!SUBJECT.test(record.subject||'')||!TOKEN.test(accessToken||''))throw failure();
  const view=viewHint(record.view),abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),Math.max(1,Math.min(timeoutMs,10_000)));
  try{
    const response=await fetchImpl('/api/v1/admin-sessions/redeem',{method:'POST',redirect:'error',cache:'no-store',
      headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({grant:match[1]}),signal:abort.signal});
    if(abort.signal.aborted||response.redirected||(response.url&&response.url!==url.origin+'/api/v1/admin-sessions/redeem'))throw failure();
    const body=await response.json();
    if(abort.signal.aborted)throw failure();
    if(!response.ok)throw failure(response.status===401||response.status===403?response.status:400);
    try{validateWorkspaceSessionEnvelope(body,{origin:record.controllerOrigin,sessionId:record.sessionId,
      subject:record.subject,accessToken});}catch{throw failure(403);}
    install(body);restoreView(view);return true;
  }catch(error){throw error?.fatal?error:failure();
  }finally{clearTimeout(timer);}
}
