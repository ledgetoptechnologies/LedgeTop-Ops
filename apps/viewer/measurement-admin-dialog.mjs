import { measurementValue } from './measurement-document.mjs';
import { mountMeasurementRegionPreview } from './measurement-region-preview.mjs';

const METHODS = Object.freeze({'surface-cut-fill':'Native raster surface cut / fill','point-surface-cut-fill':'Point-cloud surface cut / fill','closed-mesh':'Validated closed-mesh volume','reconstructed-estimate':'Reconstructed object estimate (inferred geometry)'});
const REFERENCES = Object.freeze({'boundary-triangulated':'Triangulated boundary','fitted-plane':'Fitted sloping plane','lowest-boundary':'Lowest boundary elevation','highest-boundary':'Highest boundary elevation','average-boundary':'Average boundary elevation','custom':'Custom horizontal elevation'});
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function adminLengthUnit(units='metric'){return({imperial:{label:'ft',metresPerUnit:0.3048},feet:{label:'ft',metresPerUnit:0.3048},yards:{label:'yd',metresPerUnit:0.9144},metric:{label:'m',metresPerUnit:1},centimeters:{label:'cm',metresPerUnit:0.01}})[units]||{label:'m',metresPerUnit:1};}
export function acceptAdminAttachmentRecord(previous,updated){
  if(!updated)return previous;
  const geometry=value=>JSON.stringify([value.kind,value.collection,value.vertices,value.coordinateReference?.crs,value.coordinateReference?.verticalUnit,value.source?.kind,value.source?.assetId]);
  if(updated.id!==previous.id||!Number.isSafeInteger(updated.revision)||updated.revision!==previous.revision+1||geometry(updated)!==geometry(previous)||(previous.modelId&&updated.modelId!==previous.modelId)||(previous.modelVersionId&&updated.modelVersionId!==previous.modelVersionId))throw new Error('The measurement changed while attaching this result. Close and reopen the calculation dialog before starting another job.');
  return structuredClone(updated);
}
export function createAdminPreviewController(host,{units='imperial',mount=mountMeasurementRegionPreview}={}){
  let instance=null,key=null,disposed=false;
  return{show(job){if(disposed)return false;const source=job?.result?.preview;if(!source){instance?.dispose();instance=null;key=null;return false;}const nextKey=`${job.id}:${job.revision}`;if(instance&&key===nextKey)return true;const inferred=source.inferred===true||job.result.method==='reconstructed-estimate';const preview={...source,...(inferred?{inferred:true}:{})};if(instance)instance.update(preview,{displayUnits:units});else instance=mount(host,{preview,units});key=nextKey;return true;},dispose(){if(disposed)return;disposed=true;instance?.dispose();instance=null;key=null;}};
}

export function availableAdminSources(envelope) {
  if (envelope?.capabilities?.serverCalculations !== true || !Array.isArray(envelope.calculationSources)) return [];
  return envelope.calculationSources.flatMap(source => {
    if (!source || typeof source.assetId !== 'string' || !source.assetId || source.assetId.length > 200) return [];
    const declared = Array.isArray(source.methods) ? source.methods : ['dsm','dtm'].includes(source.kind) ? ['surface-cut-fill'] : [];
    const methods = declared.filter(method => Object.hasOwn(METHODS,method) && (!Array.isArray(envelope.calculationMethods) || envelope.calculationMethods.includes(method)));
    return methods.length ? [{...source,methods}] : [];
  });
}
export function priorMeterDeclaration(record,source,jobs){
  if(!record?.modelVersionId||source?.modelVersionId!==record.modelVersionId||!/^[a-f0-9]{64}$/i.test(source.sha256||''))return false;
  const evidence=source.unitEvidence;
  if(evidence&&evidence.verticalUnit==='m'&&(['administrator-reviewed-source','verified-odm-source'].includes(evidence.basis)
    ||(evidence.basis==='server-verified-ept-conversion'&&source.kind==='ept'&&evidence.verticalFactor===1))
    &&evidence.assetId===source.assetId&&evidence.modelVersionId===record.modelVersionId&&evidence.modelId===record.modelId
    &&evidence.crs===record.coordinateReference?.crs&&evidence.kind===source.kind&&evidence.sha256===source.sha256
    &&evidence.byteSize===source.byteSize&&(source.kind!=='ept'||evidence.manifestSha256===source.manifestSha256))return true;
  return (jobs||[]).some(job=>{
    const result=job?.result,evidence=result?.source;
    return job.measurementId===record.id&&job.status==='complete'&&['surface-cut-fill','point-surface-cut-fill'].includes(job.method)
      &&job.parameters?.sourceAssetId===source.assetId&&job.parameters.sourceVerticalUnit==='m'
      &&evidence?.assetId===source.assetId&&evidence.modelVersionId===source.modelVersionId&&evidence.sha256===source.sha256
      &&evidence.kind===source.kind&&evidence.verticalUnit==='m'&&evidence.verticalUnitBasis==='administrator-declared'
      &&(source.kind!=='ept'||(/^[a-f0-9]{64}$/i.test(source.manifestSha256||'')&&evidence.manifestSha256===source.manifestSha256));
  });
}
export function adminCalculationRequest(record, fields, sources) {
  if (record?.kind !== 'polygon' || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Save this polygon before starting a server calculation.');
  const source = sources.find(value => value.assetId === fields.sourceAssetId);
  if (!source?.methods.includes(fields.method)) throw new Error('This calculation method is unavailable for the selected source.');
  const body = {revision:record.revision,method:fields.method,sourceAssetId:source.assetId};
  const factor=adminLengthUnit(fields.displayUnits).metresPerUnit,toMetres=value=>Number(value)*factor;
  if (['surface-cut-fill','point-surface-cut-fill'].includes(fields.method)) {
    if (!Object.hasOwn(REFERENCES,fields.reference)) throw new Error('Choose a supported reference base.');
    const offsetM = toMetres(fields.offsetM),elevationM = toMetres(fields.elevationM);
    if (fields.offsetM==='' || !Number.isFinite(offsetM) || Math.abs(offsetM)>1e9 || (fields.reference === 'custom' && (fields.elevationM==='' || !Number.isFinite(elevationM) || Math.abs(elevationM)>1e9))) throw new Error('Enter finite base elevations and offsets in the displayed units.');
    body.reference={type:fields.reference,offsetM,...(fields.reference==='custom'?{elevationM}:{})};
    if (fields.confirmMeters) body.sourceVerticalUnit='m';
    if(fields.method==='point-surface-cut-fill'){
      // Without a staff declaration the server must verify encoded height units.
      // A provider name alone is not a unit declaration.
      const cellSizeM=toMetres(fields.cellSizeM);
      if(!Number.isFinite(cellSizeM)||cellSizeM<0.001||cellSizeM>100||!['all','ground'].includes(fields.classFilter))throw new Error('Choose a point-surface cell size equivalent to 0.001–100 meters and a supported classification filter.');
      body.cellSizeM=cellSizeM;body.classFilter=fields.classFilter;
    }
  } else {
    const reconstructed=fields.method==='reconstructed-estimate',pointSource=reconstructed&&source.kind==='ept';
    const seed=[Number(fields.seedE),Number(fields.seedN),toMetres(fields.seedZ)],minElevationM=toMetres(fields.minElevationM),maxElevationM=toMetres(fields.maxElevationM);
    if(!fields.confirmObjectSelection||(!pointSource&&!['projected','local-enu'].includes(fields.sourceCoordinateFrame))||[fields.seedE,fields.seedN,fields.seedZ,fields.minElevationM,fields.maxElevationM].some(value=>value===''||value===undefined)||seed.some(value=>!Number.isFinite(value)||Math.abs(value)>1e9)||!Number.isFinite(minElevationM)||!Number.isFinite(maxElevationM)||minElevationM>=maxElevationM||seed[2]<minElevationM||seed[2]>maxElevationM)throw new Error('Confirm the source coordinate frame and enter a seed inside the object with valid lower/upper elevation bounds.');
    if(!pointSource)body.sourceCoordinateFrame=fields.sourceCoordinateFrame;
    body.selection={seed,minElevationM,maxElevationM};
    if(reconstructed){
      const depth=Number(fields.depth),normalRadiusM=toMetres(fields.normalRadiusM),supportDistanceM=toMetres(fields.supportDistanceM);
      if(fields.acknowledgeInferredGeometry!==true)throw new Error('Explicitly acknowledge that reconstruction infers missing geometry and produces an estimate, not an observed solid volume.');
      if(!Number.isInteger(depth)||depth<6||depth>9||!Number.isFinite(normalRadiusM)||normalRadiusM<=0||normalRadiusM>100||!Number.isFinite(supportDistanceM)||supportDistanceM<=0||supportDistanceM>100)throw new Error('Choose reconstruction depth 6–9 and positive normal/support distances no larger than 100 meters.');
      body.reconstruction={depth,normalRadiusM,supportDistanceM,acknowledgeInferredGeometry:true};
      if(pointSource){if(!fields.confirmReconstructionMeters||!['all','ground'].includes(fields.reconstructionClassFilter))throw new Error('Confirm point-cloud elevations are meters and choose a supported classification filter.');body.sourceVerticalUnit='m';body.classFilter=fields.reconstructionClassFilter;}
    }
  }
  return body;
}
export function adminResultSummary(calculation, units='imperial') {
  if (!calculation) return 'No calculation selected.';
  if (calculation.status === 'failed') return `Calculation failed: ${String(calculation.errorCode || 'unavailable').replaceAll('_',' ')}.`;
  if (calculation.status !== 'complete') return `Calculation ${calculation.status}.`;
  const result=calculation.result;
  if (!result) return 'Calculation completed without a usable result.';
  const values = Number.isFinite(result.cutM3) ? `Cut ${measurementValue(result.cutM3,3,units)} · Fill ${measurementValue(result.fillM3,3,units)} · Net ${measurementValue(result.netM3,3,units)}` : `Volume ${measurementValue(result.volumeM3,3,units)}`;
  const area=Number.isFinite(result.surfaceAreaM2)?` Surface area ${measurementValue(result.surfaceAreaM2,2,units)}.`:Number.isFinite(result.footprintM2)?` Footprint ${measurementValue(result.footprintM2,2,units)}.`:'';
  return `${result.status || 'Complete'}: ${values}.${area}${Number.isFinite(result.coverage)?` Coverage ${(result.coverage*100).toFixed(3)}%.`:''} ${(result.warnings || []).filter(v=>typeof v==='string').join(' ')}`.trim();
}

export async function openAdminCalculationDialog({record,request,units='imperial',onResult=()=>{},onClose=()=>{},onOpened=()=>{},isCurrent=()=>true,documentRef=document,host=null}) {
  const accessChanged=()=>new Error('Measurement access or view changed. Reopen the calculation dialog from the current authorized view.');
  if(!isCurrent())throw accessChanged();
  if (typeof request !== 'function') throw new Error('Open this model from your authorized Viewer workspace to use administrative calculations.');
  const capabilities=await request('capabilities',{});
  if(!isCurrent())throw accessChanged();
  if (capabilities?.capabilities?.serverCalculations !== true) throw new Error('Your current access does not allow server calculations.');
  const sources=availableAdminSources(capabilities).map(source=>({...source,methods:source.methods.filter(method=>!host||method!=='surface-cut-fill')})).filter(source=>source.methods.length),methods=[...new Set(sources.flatMap(source=>source.methods))],lengthUnit=adminLengthUnit(units),unit=lengthUnit.label;
  const dialog=documentRef.createElement(host?'section':'dialog');dialog.className=host?'measurement-admin-dialog measurement-specialist-panel':'measurement-volume-dialog measurement-admin-dialog';
  dialog.innerHTML=`<h2>${host?'Specialist calculation':'Administrative calculation'}</h2><p data-name></p><p>Specialist methods require separate staff authorization. Select the method explicitly and review its assumptions. This uses the saved polygon revision and native source data, not currently visible tiles.</p>
    <label>Calculation <select name="method">${methods.map(method=>`<option value="${method}">${METHODS[method]}</option>`).join('')}</select></label>
    <label>Registered source <select name="source"></select></label>
    <fieldset data-surface><legend>Surface reference</legend><label>Reference base <select name="reference">${Object.entries(REFERENCES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label>
    <label data-custom hidden>Custom elevation (${unit})<input name="elevation" type="number" step="any" value="0"></label>
    <label>Base offset (${unit})<input name="offset" type="number" step="any" value="0"></label>
    <label><input name="meters" type="checkbox">Only if source height units are missing: I have verified the elevations are meters.</label><p data-unit-note>Encoded height units are checked automatically. Do not select this merely because the files came from WebODM or NodeODX.</p>
    <p>This measures space above/below a reference surface. It does not infer solid material inside a vehicle, building, or hollow object.</p></fieldset>
    <fieldset data-point hidden><legend>Point-surface construction</legend><label>Grid cell size (${unit})<input name="cellSize" type="number" min="${0.001/lengthUnit.metresPerUnit}" max="${100/lengthUnit.metresPerUnit}" step="any" value="${0.1/lengthUnit.metresPerUnit}"></label><label>Points <select name="classFilter"><option value="all">All classes</option><option value="ground">Ground only</option></select></label><p>This deliberately derives a sampled surface. Grid size and source coverage are retained with the result.</p></fieldset>
    <fieldset data-object hidden><legend>Object selection</legend><p data-observed>Use a seed inside the desired object and vertical limits that contain it. Only observed closed geometry qualifies; open/clipped objects are rejected, never automatically sealed.</p><label data-frame>Source coordinates <select name="coordinateFrame"><option value="">Choose source coordinate frame</option><option value="projected">Projected coordinates (E/N/Z meters)</option><option value="local-enu">Local ENU with registered origin</option></select></label>
    <label>Seed easting (CRS meters)<input name="seedE" type="number" step="any"></label><label>Seed northing (CRS meters)<input name="seedN" type="number" step="any"></label><label>Seed elevation (${unit})<input name="seedZ" type="number" step="any"></label><label>Lower elevation (${unit})<input name="minZ" type="number" step="any"></label><label>Upper elevation (${unit})<input name="maxZ" type="number" step="any"></label><label><input name="confirmObject" type="checkbox">I have verified the coordinate frame, seed, and vertical selection.</label></fieldset>
    <fieldset data-reconstruction hidden><legend>Explicit reconstructed estimate</legend><p>Reconstruction infers surfaces across missing observations. Pink geometry is inferred, not measured material. Even a closed reconstructed shell does not establish a vehicle's, building's, or hollow object's solid material volume.</p>
    <label>Reconstruction depth <select name="depth"><option value="6">6</option><option value="7">7</option><option value="8">8</option><option value="9">9 (more resources)</option></select></label>
    <label>Normal neighborhood radius (${unit})<input name="normalRadius" type="number" step="any" placeholder="Required"></label><label>Observation support distance (${unit})<input name="supportDistance" type="number" step="any" placeholder="Required"></label>
    <div data-reconstruction-point><label><input name="reconstructionMeters" type="checkbox">I confirm the point-cloud elevations are meters.</label><label>Source points <select name="reconstructionClass"><option value="all">All classes</option><option value="ground">Ground only</option></select></label></div>
    <label><input name="acknowledgeInferred" type="checkbox">I explicitly accept inferred geometry and an estimated enclosed volume. This is not an observed-solid measurement.</label></fieldset>
    <div class="measurement-actions"><button data-create>Start calculation</button><button data-refresh>Refresh jobs</button><button data-close>Close</button></div>
    <p data-status role="status" aria-live="polite"></p><div data-jobs></div><pre data-result style="white-space:pre-wrap;max-height:25vh;overflow:auto"></pre><div data-region></div>
    <p>Closing this dialog does not cancel an accepted job. Use Cancel job explicitly. Displayed decimals do not guarantee source accuracy.</p>`;
  dialog.querySelector('[data-name]').textContent=record.name;
  const status=dialog.querySelector('[data-status]'),create=dialog.querySelector('[data-create]'),history=dialog.querySelector('[data-jobs]'),result=dialog.querySelector('[data-result]');
  const regionPreview=createAdminPreviewController(dialog.querySelector('[data-region]'),{units});
  let closed=false,busy=false,poll=null,selectedId=null,submittedId=null,calculations=[],attachmentPending=0,attachmentConflict=false;const delivered=new Set();
  const field=name=>dialog.querySelector(`[name="${name}"]`);
  let unitChoiceTouched=false;
  function restoreUnitChoice(){if(unitChoiceTouched)return;const reused=priorMeterDeclaration(record,sources.find(source=>source.assetId===field('source').value),calculations);field('meters').checked=reused;const note=dialog.querySelector('[data-unit-note]');if(note)note.textContent=reused?'Reusing the earlier staff meter declaration for this exact source. This is not an independent accuracy verification.':'Encoded height units are checked automatically. A WebODM or NodeODX label alone does not establish height units.';}
  field('meters').onchange=()=>{unitChoiceTouched=true;};
  function cleanup(){if(closed)return;closed=true;clearTimeout(poll);regionPreview.dispose();dialog.remove();onClose();}
  function current(){if(closed)return false;if(isCurrent())return true;try{if(dialog.open)dialog.close();}finally{cleanup();}return false;}
  function announce(message){if(current())status.textContent=message;}
  function updateButtons(){create.disabled=busy||attachmentPending>0||attachmentConflict||!sources.length||!Number.isSafeInteger(record.revision)||record.kind!=='polygon';}
  function display(job,{attach=!host}={}){if(!current())return;selectedId=job?.id||null;result.textContent=(host&&job?`${METHODS[job.method||job.result?.method]||'Specialist result'}\n`:'')+adminResultSummary(job,units)+(job&&job.revision!==record.revision?' This result belongs to an earlier polygon revision.':'');regionPreview.show(job);if(attach&&job?.status==='complete'&&job.result&&job.revision===record.revision&&!delivered.has(job.id)){delivered.add(job.id);attachmentPending++;updateButtons();const snapshot=structuredClone(record);void Promise.resolve().then(()=>{if(!current())throw accessChanged();return onResult({calculation:job,measurementId:snapshot.id,revision:job.revision});}).then(updated=>{if(!current())return;try{record=acceptAdminAttachmentRecord(snapshot,updated);}catch(error){attachmentConflict=true;throw error;}}).catch(error=>{delivered.delete(job.id);announce(`Result could not be added to this measurement: ${error?.message||'Save failed.'}`);}).finally(()=>{attachmentPending--;if(current())updateButtons();});}}
  function renderJobs(){history.replaceChildren();for(const job of calculations){const row=documentRef.createElement('div');row.className='measurement-actions';const open=documentRef.createElement('button');open.textContent=`${job.status} · revision ${job.revision} · ${new Date(job.createdAt).toLocaleString()}`;open.onclick=()=>{submittedId=job.id;display(job,{attach:true});};row.append(open);if(['queued','running'].includes(job.status)){const cancel=documentRef.createElement('button');cancel.textContent='Cancel job';cancel.onclick=async()=>{if(!current())return;cancel.disabled=true;try{await request('cancel',{measurementId:record.id,jobId:job.id});if(!current())return;await refresh();}catch(error){announce(error.message);if(current())cancel.disabled=false;}};row.append(cancel);}history.append(row);}const selected=calculations.find(job=>job.id===selectedId)||calculations[0];if(selected)display(selected,{attach:!host||selected.id===submittedId});}
  function schedule(){clearTimeout(poll);if(!closed&&calculations.some(job=>['queued','running'].includes(job.status)))poll=setTimeout(()=>{void refresh();},3000);}
  async function refresh(){if(!current()||busy)return;busy=true;let success=false;updateButtons();try{const response=await request('list',{measurementId:record.id});if(!current())return;calculations=Array.isArray(response.calculations)?response.calculations.filter(job=>!host||methods.includes(job.method||job.result?.method)):[];restoreUnitChoice();renderJobs();announce(calculations.length?`${calculations.length} recent calculation(s).`:'No calculations saved for this polygon.');success=true;}catch(error){announce(error.message);}finally{busy=false;if(current()){updateButtons();if(success)schedule();}}}
  function sourceChanged(){const reconstructed=field('method').value==='reconstructed-estimate',pointSource=reconstructed&&sources.find(s=>s.assetId===field('source').value)?.kind==='ept';dialog.querySelector('[data-frame]').hidden=pointSource;dialog.querySelector('[data-reconstruction-point]').hidden=!pointSource;field('acknowledgeInferred').checked=false;field('confirmObject').checked=false;unitChoiceTouched=false;restoreUnitChoice();}
  function methodChanged(){const method=field('method').value,compatible=sources.filter(source=>source.methods.includes(method)),object=['closed-mesh','reconstructed-estimate'].includes(method);field('source').innerHTML=compatible.map(source=>`<option value="${escape(source.assetId)}">${escape(String(source.kind).toUpperCase())} · ${escape(source.format || 'native source')}</option>`).join('');dialog.querySelector('[data-surface]').hidden=object;dialog.querySelector('[data-point]').hidden=method!=='point-surface-cut-fill';dialog.querySelector('[data-object]').hidden=!object;dialog.querySelector('[data-reconstruction]').hidden=method!=='reconstructed-estimate';dialog.querySelector('[data-observed]').hidden=method==='reconstructed-estimate';sourceChanged();}
  field('source').onchange=sourceChanged;
  field('method').onchange=methodChanged;methodChanged();
  field('reference').onchange=()=>{dialog.querySelector('[data-custom]').hidden=field('reference').value!=='custom';};
  create.onclick=async()=>{if(!current()||busy||attachmentPending>0||attachmentConflict)return;busy=true;let errorMessage=null;updateButtons();clearTimeout(poll);try{const body=adminCalculationRequest(record,{displayUnits:units,method:field('method').value,sourceAssetId:field('source').value,reference:field('reference').value,elevationM:field('elevation').value,offsetM:field('offset').value,confirmMeters:field('meters').checked,cellSizeM:field('cellSize').value,classFilter:field('classFilter').value,sourceCoordinateFrame:field('coordinateFrame').value,seedE:field('seedE').value,seedN:field('seedN').value,seedZ:field('seedZ').value,minElevationM:field('minZ').value,maxElevationM:field('maxZ').value,confirmObjectSelection:field('confirmObject').checked,depth:field('depth').value,normalRadiusM:field('normalRadius').value,supportDistanceM:field('supportDistance').value,acknowledgeInferredGeometry:field('acknowledgeInferred').checked,confirmReconstructionMeters:field('reconstructionMeters').checked,reconstructionClassFilter:field('reconstructionClass').value},sources);announce('Submitting authorized calculation…');const response=await request('create',{measurementId:record.id,request:body});if(!current())return;selectedId=response.calculation?.id||null;submittedId=selectedId;announce('Calculation queued.');}catch(error){errorMessage=error.message;}finally{busy=false;if(current()){updateButtons();if(!errorMessage)await refresh();else announce(errorMessage);}}};
  dialog.querySelector('[data-refresh]').onclick=()=>{void refresh();};dialog.querySelector('[data-close]').onclick=()=>host?cleanup():dialog.close();
  if(host)dialog.querySelector('[data-close]').textContent='Back to surface measurement';
  dialog.onclose=cleanup;
  const handle={close:()=>{try{if(dialog.open)dialog.close();}finally{cleanup();}},refresh,element:dialog};
  // Register ownership before any private content is attached to the DOM.
  // A caller can immediately close this handle while initial jobs are loading.
  try{onOpened(handle);}catch(error){cleanup();throw error;}
  if(!current())throw accessChanged();
  (host||documentRef.body).append(dialog);if(!host)dialog.showModal();updateButtons();
  await refresh();
  if(!current())throw accessChanged();
  if(!sources.length)announce('No supported registered source is available for administrative calculation.');
  else if(!Number.isSafeInteger(record.revision))announce('Save this polygon before starting a server calculation.');
  return handle;
}
