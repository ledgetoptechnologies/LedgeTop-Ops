// Shared browser/server submission policy. Busy healthy nodes may queue work;
// enabled alone is never evidence that a node can accept a new submission.
export const PROVIDER_HEALTH_MAX_AGE_MS = 10 * 60_000;
export function providerSubmissionState(provider, {now=Date.now(),maxHealthAgeMs=PROVIDER_HEALTH_MAX_AGE_MS}={}) {
  const blocked=(status,label,reason)=>({eligible:false,status,label,reason});
  if(!provider?.enabled)return blocked('disabled','Disabled','provider_not_enabled');
  if(!Array.isArray(provider.capabilities?.options)||!provider.capabilityFingerprint)
    return blocked('unknown','Not checked','provider_capabilities_required');
  const names=new Set(provider.capabilities.options.map(option=>option.name));
  if(['pc-ept','gltf','3d-tiles'].some(name=>!names.has(name)))
    return blocked('unsupported','Required outputs unavailable','provider_missing_viewer_outputs');
  const runtimeAt=Date.parse(provider.runtimeHealthAt||''),probeAt=Date.parse(provider.lastHealthAt||'');
  // A successful explicit recheck supersedes an older background failure, and
  // a newer background failure supersedes an earlier enablement probe.
  const runtime=Number.isFinite(runtimeAt)&&(!Number.isFinite(probeAt)||runtimeAt>=probeAt);
  const at=runtime?runtimeAt:probeAt,health=runtime?provider.runtimeHealth:provider.lastHealth;
  if(!Number.isFinite(at)||!Number.isFinite(now)||at>now+60_000||!health)
    return blocked('unknown','Health not checked','provider_health_required');
  if(now-at>maxHealthAgeMs)return blocked('stale','Health check needed','provider_health_stale');
  if(!['healthy','ready'].includes(health))return blocked('unavailable','Unavailable','provider_unavailable');
  const queued=Number(provider.capabilities.taskQueueCount)>0||Number(provider.activeAttempts)>0;
  return {eligible:true,status:queued?'busy':'ready',label:queued?'Available · queues work':'Ready',reason:null};
}
export function selectSubmissionProvider(providers,currentId='',options={}) {
  const eligible=(Array.isArray(providers)?providers:[]).filter(provider=>providerSubmissionState(provider,options).eligible);
  if(eligible.some(provider=>provider.id===currentId))return currentId;
  return eligible.length===1?eligible[0].id:'';
}
