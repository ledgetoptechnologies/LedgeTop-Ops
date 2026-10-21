import {measurementValue} from './measurement-document.mjs';
import {mountMeasurementRegionPreview} from './measurement-region-preview.mjs';
import {buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent} from './measurement-cross-section.mjs';
import {mountNativeProfile} from './measurement-profile-panel.mjs';
import './measurement-volume-dialog.css';

// Calculation is injected: scoped server work or an isolated browser fixture.
// A sampled corridor is not a native-resolution elevation transect.
export function openSurfaceDialog({record,units,calculate,save,onClose=()=>{},autoCalculate=false,execution='browser',openSpecialist=null,advancedSettings=false,areaM2=null,getRecord=()=>record,calculateProfile=null,loadPreviousVolume=null}){
  const unit={imperial:['ft',0.3048],feet:['ft',0.3048],yards:['yd',0.9144],metric:['m',1],centimeters:['cm',0.01]}[units]||['ft',0.3048];
  const dialog=document.createElement('dialog');dialog.className='measurement-volume-dialog surface-inspector';
  dialog.innerHTML=`<header class="surface-heading"><div><p class="surface-eyebrow">Measurement inspector</p><h2>Calculate volume</h2><p data-name></p></div><button data-close aria-label="Close measurement inspector">Close</button></header><div data-surface-content>
  <p class="surface-description">Draw around the bottom of the pile on surrounding ground, then calculate its volume above a reference ground surface. This does not measure solid material inside a car or building.</p>
  <div class="surface-area"><span>Outline area</span><strong data-area></strong></div>
  <details class="surface-settings" ${advancedSettings?'':'hidden'}><summary>Advanced settings · staff only</summary><div class="surface-settings-grid">
  <label>Elevation surface<select name="source"><option value="auto">Current surface</option><option value="dsm">DSM · objects and ground</option><option value="dtm">DTM · ground</option><option value="ept" hidden>Original point surface</option></select></label>
  <label>Reference base<select name="reference"><option value="boundary-triangulated">Ground from boundary</option><option value="fitted-plane">Fitted sloping plane</option><option value="lowest-boundary">Lowest boundary</option><option value="highest-boundary">Highest boundary</option><option value="average-boundary">Average boundary</option><option value="custom">Custom horizontal elevation</option></select></label>
  <label data-custom hidden>Custom elevation (${unit[0]})<input name="elevation" type="number" step="any" value="0"></label><label>Base offset (${unit[0]})<input name="offset" type="number" step="any" value="0"></label></div>
  <p class="hint">For Ground from boundary, place the outline around the pile toe on surrounding ground. This estimates a base; it is not surveyed ground. Choose a custom elevation only when that height is known. A DTM may remove the pile itself.</p>
  <p class="hint">Volume requires established elevation units in the source data. If these are unavailable, your outline and horizontal area remain available; contact the model owner to review the source.</p></details>
  <div class="surface-action-bar"><button data-calculate>Calculate volume</button><button data-cancel-job hidden>Cancel calculation</button><span class="hint">Original elevation data · your selected outline</span></div><p data-status role="status" data-state="idle">Your polygon area is already available. Choose a surface and base, then calculate volume. No volume has been calculated yet.</p>
  <div data-results class="surface-results" hidden><div class="surface-result"><span>Above base · cut</span><strong data-result="cut">—</strong></div><div class="surface-result"><span>Below base · fill</span><strong data-result="fill">—</strong></div><div class="surface-result"><span>Net volume</span><strong data-result="net">—</strong></div><div class="surface-result"><span>Source coverage</span><strong data-result="coverage">—</strong></div></div>
  <aside data-previous-volume hidden role="note"><h3>Previous outline — not current</h3><p data-previous-values></p><p>This is the last saved volume before the outline changed. It does not describe the current boundary. Recalculate to get an updated volume and cross-section.</p></aside>
  <div data-native-profile hidden></div><p data-preview-empty>The isolated surface and reference-base preview will appear after a successful calculation.</p><div data-preview-content hidden>
  <section class="surface-section" data-sampled-section><div class="surface-section-header"><h3>Sampled cross-section preview</h3><p>A narrow corridor through the selected region. Hover or focus the chart and use arrow keys to inspect real retained samples.</p></div>
  <div class="section-controls"><label>Direction <output data-angle>0°</output><input name="azimuth" type="range" min="0" max="360" value="0" aria-label="Section direction in degrees"></label><label>Position <output data-offset></output><input name="sectionOffset" type="range" min="-100" max="100" value="0" aria-label="Section corridor position"></label><label>Corridor width <output data-width></output><input name="sectionWidth" type="range" min="1" max="100" value="10" aria-label="Section corridor width"></label></div>
  <div class="section-charts"><canvas data-section-plan width="300" height="300" aria-label="Selected region from above with section corridor and inspected sample"></canvas><canvas data-section-chart width="850" height="300" tabindex="0" aria-label="Sampled section. Left and right arrow keys inspect samples; Home and End select the first and last sample."></canvas></div>
  <div class="section-readout" data-readout role="status">Hover the chart to inspect a sample.</div><p class="section-provenance" data-provenance></p></section>
  <details class="region-disclosure"><summary>Explore the isolated region in 3D</summary><div data-region-preview></div></details></div></div>${typeof openSpecialist==='function'?'<details class="surface-specialist"><summary>Specialist methods · staff only</summary><p class="hint">Point-cloud surfaces and object methods use different assumptions. Opening these options does not start a calculation or cancel a running job.</p><p data-specialist-status role="status"></p><div data-specialist-host></div></details>':''}`;
  dialog.querySelector('[data-name]').textContent=record.name;
  // Keep technical controls below the result/profile, next to staff-only tools.
  dialog.querySelector('[data-surface-content]').append(dialog.querySelector('.surface-settings'));
  const help={cut:'Material above the reference ground surface inside your outline.',fill:'Space below the reference ground surface inside your outline.',net:'Above-base volume minus below-base volume. This can be negative.',coverage:'The percentage of your outline with usable elevation data. Missing data is not treated as zero.'};
  for(const [name,text]of Object.entries(help)){
    const card=dialog.querySelector(`[data-result=${name}]`).parentElement;
    if(card){const tip=document.createElement('details');tip.className='volume-help';tip.innerHTML=`<summary aria-label="Explain ${name}" title="${text}">?</summary><p>${text}</p>`;card.append(tip);}
  }
  dialog.querySelector('[data-area]').textContent=Number.isFinite(areaM2)&&areaM2>=0?measurementValue(areaM2,2,units):'Available in your measurement list';
  if(!advancedSettings){
    // New client stockpiles use the pile-containing surface in every view.
    // restoreSavedResult below still preserves an explicitly saved source/base.
    dialog.querySelector('[name=source]').value='auto';
    for(const name of ['source','reference','elevation','offset'])dialog.querySelector(`[name=${name}]`).disabled=true;
    dialog.querySelector('[data-status]').textContent='Your outline is ready. Calculate volume when you are ready; your area is already available.';
  }
  if(execution==='server'){
    dialog.querySelector('[data-calculate]').textContent='Calculate volume';
    dialog.querySelector('.surface-action-bar .hint').textContent='Original elevation data · your selected outline';
    dialog.querySelector('[data-status]').textContent=advancedSettings?'Your polygon area is already available. Review advanced settings only if needed, then calculate volume. You can close this inspector while it works.':'Your outline is ready. Calculate volume when you are ready. You can close this window while it works and return to your measurement later.';
  }
  let abort=null,preview=null,regionPreview=null,section=null,selected=null,chartBounds=null,retired=false,closed=false,specialist=null,specialistGeneration=0,nativeProfile=null;
  let jobNotice=null,jobNoticeTimer=null,historyGeneration=0;
  function showPreviousVolume(previous){
    if(!previous||previous.status!=='historical'||previous.unit!=='m3')return;
    const labels=[['cutM3','Above base'],['fillM3','Below base'],['netM3','Net volume'],['volumeM3','Object volume']],values=labels.filter(([key])=>Number.isFinite(previous[key])).map(([key,label])=>`${label}: ${measurementValue(previous[key],3,units)}`);
    if(!values.length)return;
    if(Number.isSafeInteger(previous.revision))values.push(`Saved revision ${previous.revision}`);
    if(typeof previous.recordedAt==='string'&&Number.isFinite(Date.parse(previous.recordedAt)))values.push(`Saved ${new Date(previous.recordedAt).toLocaleString()}`);
    dialog.querySelector('[data-previous-values]').textContent=values.join(' · ');dialog.querySelector('[data-previous-volume]').hidden=false;
  }
  function clearJobNotice(){clearTimeout(jobNoticeTimer);jobNoticeTimer=null;jobNotice?.remove();jobNotice=null;}
  function announceJob(){clearJobNotice();jobNotice=document.createElement('div');jobNotice.className='measurement-job-notice';jobNotice.setAttribute('role','status');jobNotice.setAttribute('aria-live','polite');jobNotice.textContent='Volume calculation accepted. You can close this window and return later; work continues while your access remains valid.';document.body.append(jobNotice);jobNoticeTimer=setTimeout(clearJobNotice,8000);jobNoticeTimer?.unref?.();}
  const status=dialog.querySelector('[data-status]'),canvas=dialog.querySelector('[data-section-chart]'),plan=dialog.querySelector('[data-section-plan]');
  const field=name=>dialog.querySelector(`[name=${name}]`),value=name=>Number(field(name).value),format=v=>measurementValue(v,1,units);
  function savedSurfaceIsCurrent(current){const r=current?.results;return ['calculated','complete'].includes(r?.status)&&['surface-cut-fill','point-surface-cut-fill'].includes(r.method)&&typeof r.calculationJobId==='string'&&r.calculationJobId.length>0&&[r.cutM3,r.fillM3,r.netM3,r.coverage].every(Number.isFinite)&&r.coverage>=0&&r.coverage<=1&&r.source?.modelVersionId===current.modelVersionId&&!!current.modelVersionId&&!r.volumeInvalidated;}
  function setResultMode(valid){dialog.querySelector('h2').textContent=valid?'View volume':'Calculate volume';dialog.querySelector('[data-calculate]').hidden=valid;dialog.querySelector('.surface-action-bar').hidden=valid;}
  function clearNativeProfile(){nativeProfile?.dispose();nativeProfile=null;dialog.querySelector('[data-native-profile]').hidden=true;}
  function showNativeProfile(){
    clearNativeProfile();
    const current=getRecord()||record;
    if(typeof calculateProfile!=='function'||!['surface-cut-fill','point-surface-cut-fill'].includes(current.results?.method)||!current.results?.calculationJobId)return;
    const host=dialog.querySelector('[data-native-profile]');host.hidden=false;
    nativeProfile=mountNativeProfile(host,{record:current,getRecord,units,calculate:calculateProfile});
    dialog.querySelector('[data-preview-empty]').hidden=true;
  }
  dialog.querySelector('[data-sampled-section]').hidden=typeof calculateProfile==='function';
  function restoreSavedResult(){
    const history=++historyGeneration;dialog.querySelector('[data-previous-volume]').hidden=true;
    clearNativeProfile();
    record=structuredClone(getRecord()||record);
    const saved=record.results;
    if(!saved||saved.status==='geometry-only'){setResultMode(false);if(saved?.volumeInvalidated){status.dataset.state='stale';status.textContent='The outline changed. Calculate volume again to update its volume and cross-section. The old volume is no longer current.';showPreviousVolume(saved.previousVolume);if(!saved.previousVolume&&typeof loadPreviousVolume==='function')Promise.resolve().then(loadPreviousVolume).then(previous=>{if(!retired&&history===historyGeneration)showPreviousVolume(previous);}).catch(()=>{});}return;}
    const hasSurface=Number.isFinite(saved.cutM3)||Number.isFinite(saved.fillM3)||Number.isFinite(saved.netM3);
    if(!hasSurface&&!Number.isFinite(saved.volumeM3))return;
    const reference=saved.reference||{},referenceTypes=['boundary-triangulated','fitted-plane','lowest-boundary','highest-boundary','average-boundary','custom'];
    if(referenceTypes.includes(reference.type)&&(reference.type!=='custom'||Number.isFinite(reference.elevationM))){
      field('reference').value=reference.type;dialog.querySelector('[data-custom]').hidden=reference.type!=='custom';
      if(reference.type==='custom')field('elevation').value=String(reference.elevationM/unit[1]);
    }
    if(Number.isFinite(reference.offsetM))field('offset').value=String(reference.offsetM/unit[1]);
    const source=saved.sourceKind||saved.source?.kind;if(['dsm','dtm','ept'].includes(source))field('source').value=source;
    if(hasSurface){
      for(const [name,key]of [['cut','cutM3'],['fill','fillM3'],['net','netM3']])dialog.querySelector(`[data-result=${name}]`).textContent=Number.isFinite(saved[key])?measurementValue(saved[key],3,units):'Unavailable';
      dialog.querySelector('[data-result=coverage]').textContent=Number.isFinite(saved.coverage)&&saved.coverage>=0&&saved.coverage<=1?`${(saved.coverage*100).toFixed(3)}%`:'Unavailable';dialog.querySelector('[data-results]').hidden=false;
    }
    const warnings=Array.isArray(saved.warnings)?saved.warnings.filter(w=>typeof w==='string').join(' '):'';
    status.dataset.state='saved';status.textContent=hasSurface?`Previously saved ${saved.status||'surface'} result. These totals have not been recalculated or revalidated against the current source. ${warnings}`:`Previously saved object volume: ${measurementValue(saved.volumeM3,3,units)}. This is a different calculation from surface cut/fill. ${warnings}`;
    const valid=savedSurfaceIsCurrent(record);setResultMode(valid);
    if(!valid){dialog.querySelector('h2').textContent='View volume';dialog.querySelector('[data-calculate]').textContent='Recalculate volume';}
    if(valid)status.textContent=`Saved volume for this outline. Explore the cross-section below without changing the volume. ${warnings}`;
    dialog.querySelector('[data-preview-content]').hidden=true;dialog.querySelector('[data-preview-empty]').hidden=false;
    dialog.querySelector('[data-preview-empty]').textContent=valid?'Your saved result is shown above.':'This historical result may need recalculation. Calculate volume to update it using the saved calculation settings.';
    dialog.querySelector('.surface-settings').open=false;dialog.setAttribute('data-calculated','true');showNativeProfile();
  }
  function plot(){
    const ctx=canvas.getContext('2d'),pc=plan.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);pc.clearRect(0,0,plan.width,plan.height);if(!section)return;
    const span=section.extent[1]-section.extent[0],crossSpan=section.crossExtent[1]-section.crossExtent[0];
    const px=p=>20+p.distance/Math.max(span,1e-9)*(plan.width-40),py=v=>plan.height-30-(v-section.crossExtent[0])/Math.max(crossSpan,1e-9)*(plan.height-60);
    pc.fillStyle='#687b91';for(const p of section.projected)pc.fillRect(px(p)-1,py(p.cross)-1,2,2);
    pc.fillStyle='#f3752328';pc.fillRect(20,py(section.offset+section.width/2),plan.width-40,Math.max(1,py(section.offset-section.width/2)-py(section.offset+section.width/2)));
    pc.strokeStyle='#f37523';pc.setLineDash([5,4]);pc.beginPath();pc.moveTo(20,py(section.offset));pc.lineTo(plan.width-20,py(section.offset));pc.stroke();pc.setLineDash([]);pc.fillStyle='#bac9d8';pc.font='12px system-ui';pc.fillText('Region · plan view',15,18);
    let bottom=Infinity,top=-Infinity;for(const p of section.points){bottom=Math.min(bottom,p.elevation,p.base);top=Math.max(top,p.elevation,p.base);}
    if(!section.points.length){ctx.fillStyle='#aebccc';ctx.font='15px system-ui';ctx.fillText('No retained samples in this corridor.',55,135);ctx.font='12px system-ui';ctx.fillText('Move or widen the corridor. Missing data is not zero.',55,160);chartBounds=null;return;}
    if(top-bottom<1e-6){bottom-=.5;top+=.5;}const pad=(top-bottom)*.08;bottom-=pad;top+=pad;
    const sx=v=>64+v/Math.max(span,1e-9)*(canvas.width-90),sy=v=>canvas.height-42-(v-bottom)/(top-bottom)*(canvas.height-68);
    chartBounds={sx,sy,span,bottom,top,left:64,right:canvas.width-26};ctx.font='11px system-ui';
    for(let i=0;i<=4;i++){const y=bottom+(top-bottom)*i/4,yy=sy(y);ctx.strokeStyle='#273240';ctx.beginPath();ctx.moveTo(64,yy);ctx.lineTo(canvas.width-26,yy);ctx.stroke();ctx.fillStyle='#aebccc';ctx.fillText((y/unit[1]).toLocaleString(undefined,{maximumFractionDigits:1}),5,yy+4);const x=span*i/4;ctx.fillText((x/unit[1]).toLocaleString(undefined,{maximumFractionDigits:1}),sx(x)-8,canvas.height-23);}
    ctx.fillStyle='#bdcbdc';ctx.fillText(`Elevation (${unit[0]})`,8,14);ctx.fillText(`Distance along corridor (${unit[0]})`,canvas.width/2-90,canvas.height-5);
    for(const p of section.points){ctx.fillStyle=p.difference>=0?'#ff963e':'#5cccf7';ctx.fillRect(sx(p.distance)-1.5,sy(p.elevation)-1.5,3,3);ctx.fillStyle='#bcc6d2';ctx.fillRect(sx(p.distance)-1,sy(p.base)-1,2,2);}
    if(selected){const x=sx(selected.distance),y=sy(selected.elevation);ctx.strokeStyle='#ffb47b';ctx.beginPath();ctx.moveTo(x,23);ctx.lineTo(x,canvas.height-42);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();pc.fillStyle='#fff';pc.beginPath();pc.arc(px(selected),py(selected.cross),5,0,Math.PI*2);pc.fill();}
  }
  function inspect(point){if(point===selected)return;selected=point;dialog.querySelector('[data-readout]').textContent=point?`Distance ${format(point.distance)} · Surface ${format(point.elevation)} · Base ${format(point.base)} · Δ ${format(point.difference)} · X ${point.x.toFixed(3)}, Y ${point.y.toFixed(3)} (source coordinates, m)`:'No nearby retained sample. Move along the chart or widen the corridor.';plot();}
  function rebuild({initial=false}={}){
    if(!preview?.samples?.length)return;const azimuth=value('azimuth'),all=buildSampledCrossSection(preview.samples,{azimuth,width:1});
    if(initial){field('sectionOffset').step='any';field('sectionOffset').value=String(initialSectionOffsetPercent(all));}
    const crossSpan=Math.max(all.crossExtent[1]-all.crossExtent[0],.01),offset=(all.crossExtent[0]+all.crossExtent[1])/2+value('sectionOffset')/100*crossSpan/2,width=crossSpan*value('sectionWidth')/100;
    section=buildSampledCrossSection(preview.samples,{azimuth,offset,width});selected=null;dialog.querySelector('[data-angle]').textContent=`${azimuth}°`;dialog.querySelector('[data-offset]').textContent=format(offset);dialog.querySelector('[data-width]').textContent=format(width);
    dialog.querySelector('[data-provenance]').textContent=`${section.points.length.toLocaleString()} of ${preview.samples.length.toLocaleString()} reduced samples inside the corridor. Orange: above base · Blue: below base · Gray: reference. Points are not joined: spaces may contain unsampled cells or NoData. This preview does not change the native-cell volume or establish a continuous terrain profile.`;
    dialog.querySelector('[data-readout]').textContent=section.points.length?'Hover the chart or use arrow keys to inspect a retained sample.':'No retained samples here. Adjust position or width; absence is not a measured zero.';plot();
  }
  for(const name of ['azimuth','sectionOffset','sectionWidth'])field(name).oninput=rebuild;
  canvas.onpointermove=event=>{if(!chartBounds)return;const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/Math.max(rect.width,1),y=(event.clientY-rect.top)*canvas.height/Math.max(rect.height,1),distance=(x-chartBounds.left)/(chartBounds.right-chartBounds.left)*chartBounds.span,elevation=chartBounds.bottom+(canvas.height-42-y)/(canvas.height-68)*(chartBounds.top-chartBounds.bottom);inspect(nearestSectionSample(section,distance,{tolerance:Math.max(chartBounds.span*12/(chartBounds.right-chartBounds.left),1e-9),elevation,verticalTolerance:(chartBounds.top-chartBounds.bottom)*14/(canvas.height-68)}));};
  canvas.onpointerleave=()=>inspect(null);
  canvas.onkeydown=event=>{if(!section?.points.length||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let index=selected?section.points.indexOf(selected):-1;if(event.key==='Home')index=0;else if(event.key==='End')index=section.points.length-1;else index=Math.max(0,Math.min(section.points.length-1,index+(event.key==='ArrowRight'?1:-1)));inspect(section.points[index]);};
  function invalidateSettings(){
    setResultMode(false);
    clearNativeProfile();
    abort?.abort();preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;
    dialog.querySelector('[data-cancel-job]').hidden=true;
    dialog.removeAttribute('aria-busy');dialog.removeAttribute('data-calculated');dialog.querySelector('[data-calculate]').disabled=false;dialog.querySelector('[data-results]').hidden=true;dialog.querySelector('[data-preview-content]').hidden=true;dialog.querySelector('[data-preview-empty]').hidden=false;
    dialog.querySelector('[data-preview-empty]').textContent='Settings changed. Calculate again to show a matching result and preview.';status.dataset.state='idle';status.textContent='Settings changed. The previously saved volume is unchanged; calculate to update it.';
  }
  if(typeof openSpecialist==='function'){
    const disclosure=dialog.querySelector('.surface-specialist'),host=dialog.querySelector('[data-specialist-host]'),notice=dialog.querySelector('[data-specialist-status]');
    disclosure.ontoggle=async()=>{
      const generation=++specialistGeneration;specialist?.close();specialist=null;
      if(retired)return;
      dialog.querySelector('[data-surface-content]').hidden=disclosure.open;
      if(!disclosure.open){notice.textContent='';restoreSavedResult();return;}
      invalidateSettings();status.textContent='Surface calculation paused while viewing specialist methods. Return here and calculate with the same settings to resume or retrieve a server result.';dialog.querySelector('[data-preview-empty]').textContent='Return to the surface measurement and calculate to rebuild its preview. Accepted server work is not cancelled.';notice.textContent='Checking specialist access and registered sources…';
      const current=()=>!retired&&disclosure.open&&generation===specialistGeneration;
      try{
        const opened=await openSpecialist({host,isCurrent:current,onOpened:handle=>{if(current())specialist=handle;else handle.close();},onClose:()=>{if(current())disclosure.open=false;}});
        if(!current()){opened?.close();return;}specialist=opened;notice.textContent='';
      }catch(error){if(current())notice.textContent=`Specialist methods unavailable. ${error.message}`;}
    };
  }
  field('reference').onchange=()=>{dialog.querySelector('[data-custom]').hidden=field('reference').value!=='custom';invalidateSettings();};
  field('source').onchange=invalidateSettings;
  for(const name of ['offset','elevation'])field(name).oninput=invalidateSettings;
  dialog.querySelector('.region-disclosure').ontoggle=()=>{if(!retired&&dialog.querySelector('.region-disclosure').open&&preview&&!regionPreview)regionPreview=mountMeasurementRegionPreview(dialog.querySelector('[data-region-preview]'),{preview,units});};
  dialog.querySelector('[data-calculate]').onclick=async()=>{
    if(retired||(typeof openSpecialist==='function'&&dialog.querySelector('.surface-specialist').open))return;
    historyGeneration++;dialog.querySelector('[data-previous-volume]').hidden=true;
    abort?.abort();abort=new AbortController();const mine=abort;let cancelPending=false,jobAnnounced=false;clearJobNotice();dialog.querySelector('[data-cancel-job]').hidden=true;status.textContent='Checking source units and calculating the surface…';status.dataset.state='loading';dialog.setAttribute('aria-busy','true');dialog.querySelector('[data-calculate]').disabled=true;
    clearNativeProfile();preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;dialog.removeAttribute('data-calculated');dialog.querySelector('[data-results]').hidden=true;dialog.querySelector('[data-preview-content]').hidden=true;dialog.querySelector('[data-preview-empty]').hidden=false;dialog.querySelector('[data-preview-empty]').textContent='Calculating. The preview will appear only when a valid result is available.';
    const reference={type:field('reference').value,offsetM:value('offset')*unit[1]};if(reference.type==='custom')reference.elevationM=value('elevation')*unit[1];
    try{
      if(!String(field('offset').value).trim()||!Number.isFinite(reference.offsetM)||(reference.type==='custom'&&(!String(field('elevation').value).trim()||!Number.isFinite(reference.elevationM))))throw new Error('Enter a finite reference elevation and base offset.');
      const result=await calculate(record,{signal:mine.signal,reference,sourceKind:field('source').value,confirmMeters:false,onProgress:message=>{if(!retired&&!mine.signal.aborted)status.textContent=message;},onJob:job=>{
        if(retired||mine.signal.aborted||cancelPending)return;
        if(job&&!jobAnnounced){jobAnnounced=true;announceJob();}else if(!job)clearJobNotice();
        const button=dialog.querySelector('[data-cancel-job]');button.hidden=!job;button.disabled=false;
        button.onclick=async()=>{
          if(retired||mine.signal.aborted||!job||cancelPending)return;cancelPending=true;button.disabled=true;
          try{await job.cancel();if(retired||mine.signal.aborted)return;clearJobNotice();mine.abort();button.hidden=true;dialog.removeAttribute('aria-busy');dialog.querySelector('[data-calculate]').disabled=false;status.dataset.state='idle';status.textContent='Cancellation requested. Your outline and previously saved result are unchanged. You can calculate again with new settings.';}
          catch(error){if(!retired&&!mine.signal.aborted){cancelPending=false;status.textContent=`Could not cancel the calculation. ${error.message}`;button.disabled=false;dialog.removeAttribute('aria-busy');dialog.querySelector('[data-calculate]').disabled=false;}}
        };
      }});if(mine.signal.aborted||cancelPending)return;
      if(result.preview?.samples?.length)buildSampledCrossSection(result.preview.samples,{width:1});
      const{preview:nextPreview,...persisted}=result;await save({...record,results:persisted});if(mine.signal.aborted)return;preview=nextPreview;
      setResultMode(savedSurfaceIsCurrent({...record,results:persisted}));
      status.dataset.state='success';status.textContent=`${result.status}: cut ${measurementValue(result.cutM3,3,units)}; fill ${measurementValue(result.fillM3,3,units)}; net ${measurementValue(result.netM3,3,units)}. Coverage ${(result.coverage*100).toFixed(3)}%. ${(result.warnings||[]).join(' ')}`;
      for(const [name,key] of [['cut','cutM3'],['fill','fillM3'],['net','netM3']])dialog.querySelector(`[data-result=${name}]`).textContent=measurementValue(result[key],3,units);dialog.querySelector('[data-result=coverage]').textContent=`${(result.coverage*100).toFixed(3)}%`;dialog.querySelector('[data-results]').hidden=false;
      dialog.querySelector('[data-preview-content]').hidden=!preview?.samples?.length;dialog.querySelector('[data-preview-empty]').hidden=!!preview?.samples?.length;dialog.querySelector('[data-preview-empty]').textContent='Calculation complete; no preview samples are available for this region.';
      if(preview?.samples?.length){rebuild({initial:true});if(dialog.querySelector('.region-disclosure').open)regionPreview=mountMeasurementRegionPreview(dialog.querySelector('[data-region-preview]'),{preview,units});}dialog.querySelector('.surface-settings').open=false;dialog.setAttribute('data-calculated','true');showNativeProfile();
    }catch(error){if(!mine.signal.aborted){status.dataset.state='error';status.textContent=`No new volume was saved. ${error.message}`;dialog.querySelector('[data-preview-empty]').textContent='Preview unavailable. Resolve the source or calculation issue above and try again.';dialog.querySelector('.surface-settings').open=true;}}
    finally{if(!mine.signal.aborted&&!cancelPending){clearJobNotice();dialog.removeAttribute('aria-busy');dialog.querySelector('[data-calculate]').disabled=false;}}
  };
  function retire(){if(retired)return;retired=true;specialistGeneration++;specialist?.close();specialist=null;abort?.abort();clearNativeProfile();preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;}
  function close(){retire();dialog.close();}
  dialog.querySelector('[data-close]').onclick=close;
  // Native close events are queued. Retire synchronously before their dispatch
  // so a result settling in the intervening microtask cannot save private data.
  dialog.oncancel=()=>retire();
  dialog.onclose=()=>{retire();if(closed)return;closed=true;dialog.remove();onClose();};if(!autoCalculate)restoreSavedResult();document.body.append(dialog);dialog.showModal();
  // Never autocheck units or guess a reference height. Missing metadata reopens settings.
  if(autoCalculate)dialog.querySelector('[data-calculate]').onclick();
  return {close};
}
