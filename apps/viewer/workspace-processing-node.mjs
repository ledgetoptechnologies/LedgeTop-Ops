import {providerSubmissionState} from './server/providerSelection.mjs';

// New tasks always go to the orchestrator (the ClusterODM front end, or a node
// named for it). Individual workers are not offered here.
export function isOrchestrator(provider){
  return provider?.type==='clusterodm'||/orchestrator/i.test(String(provider?.displayName||''));
}

// The picker shows only orchestrators, by name, with no status text. An
// unavailable orchestrator stays visible but cannot be chosen, and the
// message says why; the message is empty when it is usable.
export function orchestratorPicker(providers,options={}){
  const list=(Array.isArray(providers)?providers:[]).filter(isOrchestrator).map(provider=>({provider,state:providerSubmissionState(provider,options)}));
  if(!list.length)return{options:[{id:'',label:'Orchestrator',disabled:true}],selectedId:'',usable:false,message:'No orchestrator is configured'};
  const ready=list.find(item=>item.state.eligible),chosen=ready||list[0];
  return{
    options:list.map(({provider,state})=>({id:provider.id,label:String(provider.displayName||'Orchestrator'),disabled:!state.eligible})),
    selectedId:chosen.provider.id,
    usable:Boolean(ready),
    message:ready?'':`Orchestrator unavailable: ${chosen.state.label.toLowerCase()}`,
  };
}
