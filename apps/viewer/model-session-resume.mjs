// A model tab that the browser reloaded after its session lapsed (sleep,
// memory saver) asks the workspace tab that opened it for a fresh one-use
// grant on the same channel it used before. Only routing hints are stored:
// the workspace re-checks access, and the grant is redeemed with this tab's
// own bearer, so nothing here grants access by itself.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT=/^[0-9a-f-]{36}$/i;
const key=controllerId=>`ltds-viewer-model-session:${controllerId}`;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join('\n')===[...keys].sort().join('\n');

export function rememberModelSession(storage,controllerId,session){
  if(!UUID.test(controllerId||'')||typeof session?.model?.id!=='string'||!Number.isFinite(Date.parse(session?.expiresAt||'')))return false;
  try{storage.setItem(key(controllerId),JSON.stringify({modelId:session.model.id,expiresAt:session.expiresAt}));return true;}catch{return false;}
}

function remembered(storage,controllerId){
  if(!UUID.test(controllerId||''))return null;
  let value;try{value=JSON.parse(storage.getItem(key(controllerId))||'null');}catch{return null;}
  return exactKeys(value,['modelId','expiresAt'])&&typeof value.modelId==='string'&&value.modelId.length<=200
    &&Number.isFinite(Date.parse(value.expiresAt))?value:null;
}

export function resumeExpiredModelSession({channel,storage,controllerId,redeem,randomUUID=()=>crypto.randomUUID(),
  setTimer=(handler,delay)=>setTimeout(handler,delay),clearTimer=timer=>clearTimeout(timer),timeoutMs=30_000}){
  const stored=channel&&storage?remembered(storage,controllerId):null;
  if(!stored)return Promise.resolve(null);
  const requestId=randomUUID();
  return new Promise(resolve=>{
    let finished=false,redeeming=false,timer=null;
    const done=value=>{if(finished)return;finished=true;channel.removeEventListener('message',onMessage);if(timer!==null)clearTimer(timer);resolve(value);};
    const post=message=>{try{channel.postMessage(message);}catch{}};
    async function onMessage(event){
      const data=event?.data;
      if(finished||redeeming)return;
      if(exactKeys(data,['version','type','requestId','modelId','reason'])&&data.version===1&&data.type==='ltds-viewer:session-unavailable'
        &&data.requestId===requestId&&data.modelId===stored.modelId)return done(null);
      if(!exactKeys(data,['version','type','requestId','grant'])||data.version!==1||data.type!=='ltds-viewer:renew-session'
        ||data.requestId!==requestId||!GRANT.test(data.grant||''))return;
      redeeming=true;
      try{
        const session=await redeem(data.grant);
        if(session?.model?.id!==stored.modelId)throw new Error('renewal grant is scoped to a different model');
        post({version:1,type:'ltds-viewer:session-renewed',requestId,modelId:session.model.id,expiresAt:session.expiresAt});
        done(session);
      }catch{
        post({version:1,type:'ltds-viewer:session-renewal-failed',requestId,modelId:stored.modelId,retryable:false});
        done(null);
      }
    }
    channel.addEventListener('message',onMessage);
    timer=setTimer(()=>done(null),timeoutMs);
    post({version:1,type:'ltds-viewer:session-expiring',requestId,modelId:stored.modelId,expiresAt:stored.expiresAt});
  });
}
