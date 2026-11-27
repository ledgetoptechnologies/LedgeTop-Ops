import {providerSubmissionState,selectSubmissionProvider} from './server/providerSelection.mjs';
import {mountTaskOptions} from './workspace-task-options.mjs';

// Reprocess: a new run of an existing task on the photos already on the server, with the node, preset and options
// changed here. The task's published model stays published until a new run is published.
export const REPROCESSABLE_STATUSES=new Set(['failed','cancelled','published','ready_for_review']);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const compatiblePreset=(preset,provider)=>Boolean(provider&&preset.enabled&&(!preset.providerType||preset.providerType===provider.type)&&(!preset.capabilityFingerprint||preset.capabilityFingerprint===provider.capabilityFingerprint));

export function mountTaskReprocess({container,task,attempt={},providers=[],presets=[],api,onComplete=()=>{},onCancel=()=>{}}){
  const controller=new AbortController(),{signal}=controller;let busy=false,currentProviders=providers,currentPresets=presets,firstSync=true;
  container.insertAdjacentHTML('beforeend',`<form class="manage-form new-task-form reprocess-form">
    <label>Processing node<select name="providerId" required></select></label>
    <label>Processing preset (optional)<select name="presetId"><option value="">Node defaults</option></select></label>
    <div data-task-options></div>
    <p data-status role="status" aria-live="polite"></p>
    <div class="row-actions"><button type="button" data-cancel>Cancel</button><button class="primary-button" type="submit">Reprocess</button></div>
  </form>`);
  const form=container.querySelector('.reprocess-form'),node=form.elements.providerId,preset=form.elements.presetId,status=form.querySelector('[data-status]');
  const taskOptions=mountTaskOptions({container:form.querySelector('[data-task-options]'),title:'Processing options',helpText:''});
  const say=message=>{if(!signal.aborted)status.textContent=message;};
  function sync(){
    const provider=currentProviders.find(item=>item.id===node.value),selected=preset.value;
    preset.innerHTML='<option value="">Node defaults</option>'+currentPresets.filter(item=>compatiblePreset(item,provider)).map(item=>`<option value="${escape(item.id)}">${escape(item.displayName)}</option>`).join('');
    preset.value=currentPresets.some(item=>item.id===selected&&compatiblePreset(item,provider))?selected:'';
    taskOptions.update({provider,presetOptions:currentPresets.find(item=>item.id===preset.value)?.options||{},preserveOverrides:!firstSync});firstSync=false;
  }
  function fillNodes(){
    const previous=node.value||attempt.providerId||'',eligible=currentProviders.filter(item=>providerSubmissionState(item).eligible);
    node.innerHTML='<option value="">Choose available node</option>'+currentProviders.map(item=>{const state=providerSubmissionState(item);return`<option value="${escape(item.id)}" ${state.eligible?'':'disabled'}>${escape(item.displayName)} — ${escape(state.label)}</option>`;}).join('');
    node.value=eligible.some(item=>item.id===previous)?previous:selectSubmissionProvider(currentProviders,'')||'';
  }
  fillNodes();if(attempt.presetId)preset.innerHTML+=`<option value="${escape(attempt.presetId)}"></option>`;preset.value=attempt.presetId||'';sync();
  // The last run's options are its preset plus one-time changes: restore only the changes on top of that preset.
  const inherited=currentPresets.find(item=>item.id===attempt.presetId)?.options||{};
  taskOptions.setOverrides(Object.fromEntries(Object.entries(attempt.options||{}).filter(([name,value])=>!(Object.hasOwn(inherited,name)&&JSON.stringify(inherited[name])===JSON.stringify(value)))));
  const editor=form.querySelector('.task-options-editor');if(editor)editor.open=true;
  node.onchange=()=>sync();preset.onchange=()=>sync();
  form.querySelector('[data-cancel]').onclick=()=>{dispose();onCancel();};
  form.onsubmit=async event=>{event.preventDefault();if(busy)return;
    const providerId=node.value,presetId=preset.value;if(!providerId)return say('Choose an available processing node.');
    if(!taskOptions.validate().valid)return say('Check the highlighted processing options.');
    let options;try{options=taskOptions.getOptions();}catch(error){return say(error.message);}
    busy=true;for(const element of form.querySelectorAll('select,button'))element.disabled=true;taskOptions.setDisabled(true);say('');
    try{const result=await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/attempts`,{method:'POST',body:{providerId,...(presetId?{presetId}:{}),options},signal});if(signal.aborted)return;dispose();await onComplete(result);}
    catch(error){if(!signal.aborted){say(error.message);busy=false;for(const element of form.querySelectorAll('select,button'))element.disabled=false;taskOptions.setDisabled(false);}}
  };
  // Fresh node options, without blocking the form.
  void(async()=>{try{if(node.value)await api(`/api/v1/processing/providers/${encodeURIComponent(node.value)}/capabilities/refresh`,{method:'POST',body:{},signal});const [nodes,result]=await Promise.all([api('/api/v1/processing/providers?limit=100',{signal}),api('/api/v1/processing/presets',{signal})]);if(signal.aborted||busy)return;currentProviders=nodes.providers||currentProviders;currentPresets=result.presets||currentPresets;fillNodes();sync();}catch{/* Cached nodes stay usable; the server checks again on submit. */}})();
  function dispose(){if(signal.aborted)return;controller.abort();taskOptions.dispose();}
  return{dispose};
}
