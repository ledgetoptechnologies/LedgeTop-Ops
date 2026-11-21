import {providerSubmissionState} from './server/providerSelection.mjs';

// New tasks always go to the orchestrator. Its identity comes from the server
// (orchestratorProviderId in the providers listing), which also enforces it
// on submission; names and types are never guessed here.
// The picker shows only that provider, by name, with no status text. If it has
// a problem it stays visible but cannot be chosen, and the message says why.
// When the orchestrator changes after the user accepted one, the selection is
// cleared so the user must choose it again.
export function orchestratorPicker(providers,orchestratorId,{previousId='',...options}={}){
  const provider=orchestratorId?(Array.isArray(providers)?providers:[]).find(item=>item?.id===orchestratorId):null;
  if(!provider)return{options:[{id:'',label:'Orchestrator',disabled:true}],selectedId:'',usable:false,message:'No orchestrator is configured'};
  const state=providerSubmissionState(provider,options),option={id:provider.id,label:String(provider.displayName||'Orchestrator'),disabled:!state.eligible};
  if(!state.eligible)return{options:[option],selectedId:provider.id,usable:false,message:`Orchestrator unavailable: ${state.label.toLowerCase()}`};
  if(previousId&&previousId!==provider.id)return{options:[{id:'',label:'Select orchestrator',disabled:true},option],selectedId:'',usable:true,message:'The orchestrator changed. Select it again'};
  return{options:[option],selectedId:provider.id,usable:true,message:''};
}
