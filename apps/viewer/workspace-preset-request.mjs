// The API remains authoritative; this builder prevents accidental preset edits
// when the user meant to save a separate copy of a task draft.
export function presetSaveRequest({provider,selectedPreset,overrides={},name='',update=false}) {
  if(!provider?.id)throw new Error('Choose a processing node first.');
  if(update&&(!selectedPreset?.id||selectedPreset.builtIn))throw new Error('Choose a custom preset to update, or save a new preset.');
  if(selectedPreset&&((selectedPreset.providerType&&selectedPreset.providerType!==provider.type)||(selectedPreset.capabilityFingerprint&&selectedPreset.capabilityFingerprint!==provider.capabilityFingerprint)))throw new Error('The selected preset no longer matches this node. Review it before saving.');
  const displayName=update?selectedPreset.displayName:String(name).trim();
  if(!displayName)throw new Error('Enter a name for the new preset.');
  const body={displayName,providerId:provider.id,options:{...(selectedPreset?.options||{}),...overrides},enabled:update?selectedPreset.enabled!==false:true};
  if(update)body.description=selectedPreset.description||'';
  return {path:update?`/api/v1/processing/presets/${encodeURIComponent(selectedPreset.id)}`:'/api/v1/processing/presets',method:update?'PATCH':'POST',body};
}
