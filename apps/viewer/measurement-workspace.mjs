import { measurementCollection, measurementMetrics, measurementValue, validateMeasurementGeometry, exportMeasurements, changeMeasurementVertex, measurementEditHandles } from './measurement-document.mjs';
import { createMeasurementStore } from './measurement-store.mjs';
import './measurement-workspace.css';
import './measurement-report-document.css';
import {renderMeasurementReport} from './measurement-report-document.mjs';
import {openSurfaceDialog} from './measurement-volume-dialog.mjs';
import {openAdminCalculationDialog,availableAdminSources} from './measurement-admin-dialog.mjs';
import {createServerSurfaceCalculator} from './measurement-server-surface.mjs';
import {createServerProfileCalculator} from './measurement-server-profile.mjs';
import {createMeasurementListLayout} from './measurement-list-layout.mjs';
import {retainedDisplayBoundary} from './measurement-display-elevations.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = event => event.target?.closest?.('input,textarea,select,[contenteditable=true]');
const interactive = event => event.target?.closest?.('input,textarea,select,button,a,[contenteditable=true],.leaflet-control,[role=button]');
const savedUnits = {imperial:'imperial',feet:'ft',yards:'yd',metric:'m',centimeters:'cm'};
const restoredUnits = {imperial:'imperial','ft-in':'imperial',ft:'feet',yd:'yards',metric:'metric',m:'metric',cm:'centimeters'};
const DISPLAY_SURFACE_RETRY_MS=500;

export function createMeasurementWorkspace({ panel, context, token, permitted, toolChanged, coordinateReference, toLonLat, calculateSurface, resolveDisplayVertices, adminRequest, surfaceRequest, preferServerSurface=()=>false, onAccessLost=()=>{}, onBeforeAccessLost=()=>{}, accessGeneration=()=>0, reportMetadata=()=>({}), captureReportOrtho=null }) {
  let units='imperial',draft=null,selected=null,editing=false,cursor=null,bound=null,gesture=null,space=false,shift=false,lastSvg='',disposed=false,volumeAbort=null,ready=!token(),lastCollection=null;
  const selectedExports=new Set(),reportDialogs=new Set(),reportCaptures=new Set();
  const metricCache=new WeakMap();
  let recordSnapshot=[],orderedRecords=[],lastOverlayFrame=null,loadFailed=false;
  const displayCache=new Map();
  let displayRequests=0;
  let adminAllowed=false,specialistAllowed=false,activeDialog=null,invalidated=false,viewGeneration=0,dialogGeneration=0,capabilitiesReady=Promise.resolve();
  const store=createMeasurementStore({token,accessGeneration,changed:renderPanel,beforeUnauthorized:onBeforeAccessLost});
  let pendingPick=null,lastPickAt=0,cursorOwner=null,previousCursor='';
  // A map outline remains E/N/0 while its 3D editing handles follow the visible
  // surface. Never serialize these approximate display heights into the record.
  let selectedVertex=-1,editBaseline=null,draftDisplayVertices=null,hoverHandle=false,initialLoad=null;
  const allowed=()=>permitted()&&!invalidated&&!store.isInvalidated?.();
  const message=document.createElement('p');message.className='measurement-message';message.setAttribute('role','status');
  const controls=document.createElement('div');controls.className='measurement-workspace';
  controls.innerHTML=`<label class="measurement-units">Units <select data-m="units"><option value="imperial">Feet / inches</option><option value="feet">Decimal feet</option><option value="yards">Yards</option><option value="metric">Meters</option><option value="centimeters">Centimeters</option></select></label>
    <div class="measurement-actions measurement-edit-actions" role="group" aria-label="Edit measurement"><button data-m="finish">Finish</button><button data-m="undo">Undo point</button><button data-m="edit">Edit selected</button><button data-m="focus">Focus selected</button></div>
    <details class="measurement-help"><summary>Controls &amp; accuracy</summary><p class="hint">Drawing: Shift to navigate; right-click to finish. Editing: drag away from handles to navigate normally. Enter / Esc / Finish saves and exits. Delete / Backspace removes the selected point.</p><p class="hint">Finish a polygon to see its area immediately. Choose Calculate volume when you need volume and a side view relative to a reference base.</p><p class="hint">Measurements are private to you. Public-link changes reset on refresh. Display precision is not survey accuracy.</p></details>
    <div class="measurement-list-heading"><h4><span data-m-list-title>Saved measurements</span> <span data-m-count>0</span></h4><span class="hint">Newest first</span></div>
    <p class="hint measurement-list-caption" data-m-list-caption>Click a name to rename. Edit changes its points. Exports include all saved measurements.</p>
    <div data-m-list role="region" aria-label="Saved measurements" tabindex="-1"></div><button class="measurement-reload" data-m="reload" hidden>Retry loading measurements</button>
    <section class="measurement-export-section" aria-label="Export measurements"><label class="measurement-units">Export format <select data-m="format"><option value="csv">CSV summary</option><option value="json">JSON data</option><option value="dxf">DXF (meters)</option><option value="geojson">GeoJSON</option></select></label><button data-m="export">Export all measurements</button>
    <div class="measurement-actions measurement-capture-actions" hidden><button data-m="screenshot">Save view PNG</button><button data-m="report">Print / PDF report</button></div></section>`;
  const listLayout=createMeasurementListLayout(controls.querySelector('[data-m-list]'));
  panel.append(controls,message);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('measurement-overlay');svg.setAttribute('aria-hidden','true');
  const densityNotice=document.createElement('p');densityNotice.className='hint';controls.append(densityNotice);
  function metrics(record){if(record===draft)return measurementMetrics(record);let value=metricCache.get(record);if(!value){value=measurementMetrics(record);metricCache.set(record,value);}return value;}
  function tell(text){message.textContent=text;}
  function records(){
    if(!allowed())return [];
    const snapshot=[...store.records.values()];
    if(snapshot.length!==recordSnapshot.length||snapshot.some((record,index)=>record!==recordSnapshot[index])){
      recordSnapshot=snapshot;
      orderedRecords=snapshot.slice().reverse().sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
      for(const [id,entry]of displayCache)if(store.records.get(id)!==entry.record){entry.controller.abort();displayCache.delete(id);}
    }
    return orderedRecords;
  }
  function summary(record){const m=metrics(record);return record.kind==='distance'?`${measurementValue(m.lengthM,1,units)} ${record.collection==='map'?'horizontal':'3D'}`:`${measurementValue(m.horizontalAreaM2,2,units)} horizontal · ${measurementValue(m.lengthM,1,units)} ${record.collection==='map'?'horizontal':'3D'} perimeter${m.planarAreaM2!==null&&record.collection!=='map'?` · ${measurementValue(m.planarAreaM2,2,units)} planar`:''}`;}
  function matchingReference(record){
    const current=coordinateReference()?.crs,saved=record.coordinateReference?.crs;
    if(record.collection!==measurementCollection(context()?.mode))return /^EPSG:\d+$/.test(current||'')&&saved===current;
    return typeof current==='string'&&current.length>0&&saved===current;
  }
  function displayStatus(record){
    if(!matchingReference(record))return 'Overlay unavailable: coordinate reference does not match this view.';
    if(record.collection!=='map'||measurementCollection(context()?.mode)==='map')return '';
    const entry=displayCache.get(record.id);
    return entry?.record===record?(entry.error||entry.basis||'Placing map measurement on the elevation surface…'):'Map measurement: 3D placement requires an elevation surface.';
  }
  function surfaceRevision(){
    const value=context()?.getDisplaySurfaceRevision?.();
    return typeof value==='string'&&value?value:Number.isFinite(value)?String(value):null;
  }
  function renderedDisplayRecord(record){
    return {
      id:record.id,revision:record.revision,modelVersionId:record.modelVersionId,
      collection:record.collection,kind:record.kind,
      vertices:record.vertices.map(point=>[point[0],point[1],0]),
      coordinateReference:record.coordinateReference?structuredClone(record.coordinateReference):undefined,
    };
  }
  function cancellableDisplayRequest(value,signal){
    if(signal.aborted)return Promise.reject(new DOMException('Display placement cancelled','AbortError'));
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(callback,result)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);callback(result);};
      const abort=()=>finish(reject,new DOMException('Display placement cancelled','AbortError'));
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(value).then(result=>finish(resolve,result),error=>finish(reject,error));
    });
  }
  function queueDisplayRequest(entry,revision=surfaceRevision()){
    if(entry.state==='queued'||entry.state==='pending')return false;
    entry.controller.abort();entry.controller=new AbortController();entry.generation=viewGeneration;
    entry.state='queued';entry.error='';entry.waitingSurface=false;entry.requestSurfaceRevision=revision;lastOverlayFrame=null;pumpDisplayRequests();return true;
  }
  function observeDisplaySurface(){
    let watched=false;for(const entry of displayCache.values())if(entry.placement==='rendered'||entry.waitingSurface){watched=true;break;}
    if(!watched)return;
    const revision=surfaceRevision();
    if(!revision)return;
    const now=performance.now();
    for(const entry of displayCache.values()){
      if(entry.placement!=='rendered'&&!entry.waitingSurface)continue;
      if(entry.surfaceRevision===revision&&!entry.waitingSurface)continue;
      if(entry.attemptedSurfaceRevision===revision||entry.state==='queued'||entry.state==='pending')continue;
      if(now<(entry.nextSurfaceRetryAt||0))continue;
      queueDisplayRequest(entry,revision);
    }
  }
  function clearDisplayRequests({all=false}={}){
    for(const [id,entry]of displayCache)if(all||entry.state==='pending'||entry.state==='queued'){entry.controller.abort();displayCache.delete(id);}
    lastOverlayFrame=null;
  }
  function pumpDisplayRequests(){
    if(disposed||!allowed())return;
    for(const entry of displayCache.values()){
      if(displayRequests>=2)break;
      if(entry.state!=='queued')continue;
      entry.state='pending';displayRequests++;entry.lastSurfaceAttemptAt=performance.now();entry.nextSurfaceRetryAt=entry.lastSurfaceAttemptAt+DISPLAY_SURFACE_RETRY_MS;entry.attemptedSurfaceRevision=entry.requestSurfaceRevision||surfaceRevision();
      const controller=entry.controller,generation=entry.generation;
      const current=()=>!disposed&&allowed()&&(!entry.staffAuthority||adminAllowed)&&!controller.signal.aborted&&generation===viewGeneration&&displayCache.get(entry.record.id)===entry&&store.records.get(entry.record.id)===entry.record;
      Promise.resolve().then(async()=>{
        if(!current())throw new Error('View or measurement access changed.');
        const renderedFallback=async originalError=>{
          const view=context(),resolver=view?.resolveRenderedDisplayVertices;
          if(typeof resolver!=='function')throw originalError||new Error('No verified elevation surface is available.');
          // This resolver is authorized by the current visible view, not by an
          // old calculation attachment. Never keep a staff-job requirement on
          // the independent display-only request.
          entry.renderedOnly=true;entry.staffAuthority=false;entry.awaitingStaff=false;
          if(!current())throw new Error('View or measurement access changed.');
          try{
            const result=await cancellableDisplayRequest(resolver.call(view,renderedDisplayRecord(entry.record),{signal:controller.signal}),controller.signal);
            if(result?.renderedSurface!==true||result?.displayOnly!==true)throw new Error('The rendered surface did not return an explicit display-only placement.');
            return result;
          }catch(error){
            if(controller.signal.aborted||error?.name==='AbortError')throw error;
            if(error?.code==='measurement_display_surface_pending'){entry.waitingSurface=true;throw error;}
            if(error?.code==='measurement_display_reference_mismatch')throw error;
            if(originalError)throw originalError;
            throw error;
          }
        };
        const fallback=async(originalError,{discardResults=false}={})=>{
          if(!current())throw new Error('View or measurement access changed.');
          if(typeof resolveDisplayVertices!=='function')return renderedFallback(originalError);
          const displayRecord=structuredClone(entry.record);if(discardResults)delete displayRecord.results;
          try{return await cancellableDisplayRequest(resolveDisplayVertices(displayRecord,{signal:controller.signal}),controller.signal);}
          catch(error){
            if(controller.signal.aborted||error?.name==='AbortError')throw error;
            if(error?.code==='measurement_display_surface_pending'){
              // The application-level resolver already reached its rendered
              // fallback. Retry only that bounded display adapter when a new
              // visible-surface generation becomes available.
              entry.renderedOnly=true;entry.staffAuthority=false;entry.awaitingStaff=false;entry.waitingSurface=true;throw error;
            }
            if(error?.code==='measurement_display_reference_mismatch')throw error;
            return renderedFallback(originalError||error);
          }
        };
        if(entry.renderedOnly||entry.placement==='rendered')return renderedFallback();
        const saved=entry.record.results;
        if(saved?.method==='point-surface-cut-fill'&&saved.calculationJobId){
          const declared=saved.source?.verticalUnitBasis==='administrator-declared';
          if(declared&&(!adminAllowed||typeof adminRequest!=='function')){entry.awaitingStaff=true;return fallback(undefined,{discardResults:true});}
          entry.staffAuthority=declared;
          const request=declared?adminRequest:surfaceRequest;
          if(typeof request!=='function')return fallback(undefined,{discardResults:true});
          let job;
          try{job=(await cancellableDisplayRequest(request('status',{measurementId:entry.record.id,jobId:saved.calculationJobId},entry.record),controller.signal))?.calculation;}
          catch(error){if(controller.signal.aborted||error?.name==='AbortError')throw error;return fallback(undefined,{discardResults:true});}
          if(!current())throw new Error('View or measurement access changed.');
          if(job?.id!==saved.calculationJobId||job.measurementId!==entry.record.id||job.status!=='complete'||job.method!=='point-surface-cut-fill'||job.attachmentRevision!==entry.record.revision)return renderedFallback(new Error('The saved point-surface calculation does not match this measurement revision.'));
          if(!job.result?.boundaryVertices)return fallback(undefined,{discardResults:true}); // Legacy/custom bases may have no retained boundary.
          // The saved document remains untrusted and unchanged. Only the
          // authorized, bound server result can supply display-only heights.
          const retained=retainedDisplayBoundary({...structuredClone(entry.record),results:structuredClone(job.result)},entry.record.modelVersionId);
          if(!retained)return renderedFallback(new Error('The saved point-surface calculation has no matching retained boundary elevations.'));
          return retained;
        }
        return fallback();
      }).then(result=>{
        if(!current())return;
        const vertices=result?.vertices;
        if(!Array.isArray(vertices)||vertices.length!==entry.record.vertices.length||!vertices.every((p,i)=>Array.isArray(p)&&p.length===3&&p.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9)&&p[0]===entry.record.vertices[i][0]&&p[1]===entry.record.vertices[i][1]))throw new Error('The elevation source did not return matching, finite measurement vertices.');
        const rendered=result?.renderedSurface===true;
        const revision=rendered?String(result.surfaceRevision||entry.attemptedSurfaceRevision||''):null;
        if(rendered&&result?.displayOnly!==true)throw new Error('The rendered surface placement was not marked display-only.');
        if(rendered&&!revision)throw new Error('The rendered surface placement did not identify its surface generation.');
        const latestRevision=rendered?surfaceRevision():null;
        if(rendered&&latestRevision&&revision!==latestRevision){entry.attemptedSurfaceRevision=revision;entry.waitingSurface=true;throw Object.assign(new Error('The displayed surface changed while the outline was being placed.'),{code:'measurement_display_surface_pending'});}
        entry.vertices=vertices.map(p=>p.slice());entry.basis=String(result.basis||'Elevation surface placement; display only');entry.state='ready';entry.error='';entry.placement=rendered?'rendered':'native';entry.renderedOnly=rendered;entry.surfaceRevision=revision;entry.attemptedSurfaceRevision=revision;entry.waitingSurface=false;entry.awaitingStaff=false;if(rendered)entry.staffAuthority=false;
      }).catch(error=>{if(current()){
        const waiting=entry.waitingSurface||error?.code==='measurement_display_surface_pending';
        const terminal=error?.code==='measurement_display_reference_mismatch';
        entry.state='error';entry.waitingSurface=waiting&&!terminal;
        if(terminal||(!waiting&&entry.placement==='rendered')){entry.vertices=null;entry.placement=null;entry.surfaceRevision=null;}
        entry.error=entry.vertices&&waiting?`Using the previous 3D overlay while the current rendered surface loads: ${error.message||'Surface coverage is pending.'}`:`3D overlay unavailable: ${error.message||'Elevation sampling failed.'}`;
      }}).finally(()=>{
        displayRequests--;if(current()){lastOverlayFrame=null;renderPanel();}pumpDisplayRequests();
      });
    }
  }
  function displayGeometry(record){
    if(!matchingReference(record))return null;
    if(record===draft)return draftDisplayVertices||record.vertices;
    if(record.collection!=='map'||measurementCollection(context()?.mode)==='map')return record.vertices;
    let entry=displayCache.get(record.id);
    if(entry?.record!==record){entry?.controller.abort();entry={record,state:'queued',controller:new AbortController(),generation:viewGeneration,requestSurfaceRevision:surfaceRevision()};displayCache.set(record.id,entry);pumpDisplayRequests();}
    return entry.vertices||null;
  }
  function calculationSummary(record){
    const r=record.results;if(!r||r.status==='geometry-only')return 'Vertex geometry only; no surface or object volume calculated.';
    const quantity=Number.isFinite(r.volumeM3)?`${r.estimated||r.status==='estimate'||r.method==='reconstructed-estimate'?'Estimated ':''}Volume ${measurementValue(r.volumeM3,3,units)}`:`Cut ${measurementValue(r.cutM3,3,units)} · Fill ${measurementValue(r.fillM3,3,units)} · Net ${measurementValue(r.netM3,3,units)}`;
    return [quantity,`${r.method||'Calculation'} · ${r.status||'result'}`,r.reference?`Base: ${r.reference.type}; offset ${measurementValue(r.reference.offsetM||0,1,units)}${Number.isFinite(r.reference.elevationM)?`; elevation ${measurementValue(r.reference.elevationM,1,units)}`:''}`:'',Number.isFinite(r.coverage)?`Coverage ${(r.coverage*100).toFixed(3)}%`:'',...(r.warnings||[])].filter(Boolean).join('\n');
  }
  function renderPanel(){
    if(disposed)return;
    if(store.isInvalidated?.()&&!invalidated){invalidate('Personal measurements unavailable. Restore access and reload your measurements.');return;}
    const list=controls.querySelector('[data-m-list]');
    const visibleRecords=records();
    const temporary=!token()||(ready&&!store.persistent());
    const listTitle=temporary?'Temporary measurements':'Saved measurements';
    controls.querySelector('[data-m-list-title]').textContent=listTitle;
    controls.querySelector('[data-m-list-caption]').textContent=temporary
      ?'Measurements stay in this page only and reset on refresh or closing the tab. They are not saved to the project. Click a name to rename; Edit changes its points. Export all measurements to keep a copy.'
      :'Click a name to rename. Edit changes its points. Exports include all saved measurements.';
    controls.querySelector('[data-m-count]').textContent=String(visibleRecords.length);
    const focused=controls.ownerDocument?.activeElement;
    const focusedRecord=focused?.closest?.('[data-record]')?.dataset.record;
    const focusedAction=focusedRecord&&focused?.dataset.m;
    const scrollTop=list.scrollTop;
    list.innerHTML=visibleRecords.map(r=>`<article class="measurement-row ${selected===r.id?'selected':''} ${r.visible===false?'measurement-hidden':''}" data-record="${escape(r.id)}"><div class="measurement-row-heading"><button data-m="rename" title="Rename ${escape(r.name)}">${escape(r.name)}</button></div><small class="measurement-row-summary">${escape(summary(r))}</small><small class="measurement-row-status" role="status">${escape([r.visible===false?'Hidden from view':'',store.statuses.get(r.id),displayStatus(r)].filter(Boolean).join(' · '))}</small><div class="measurement-actions measurement-row-actions"><button data-m="visibility" title="${r.visible===false?'Show':'Hide'} ${escape(r.name)} on the view">${r.visible===false?'Show':'Hide'}</button><button data-m="edit-record">Edit</button><button data-m="delete">Delete</button>${r.kind==='polygon'?`<button data-m="volume">${Number.isFinite(r.results?.cutM3)||Number.isFinite(r.results?.volumeM3)?'View volume':r.results?.volumeInvalidated?'Recalculate volume':'Calculate volume'}</button>`:''}</div>${Number.isFinite(r.results?.cutM3)?`<small class="measurement-row-result">Net volume: ${escape(measurementValue(r.results.netM3,3,units))}</small>`:Number.isFinite(r.results?.volumeM3)?`<small class="measurement-row-result">Volume: ${escape(measurementValue(r.results.volumeM3,3,units))}</small>`:''}</article>`).join('')||'<p class="hint measurement-list-empty">No saved measurements yet.<br>Choose Distance or Polygon to start.</p>';
    if(!visibleRecords.length&&temporary)list.innerHTML='<p class="hint measurement-list-empty">No temporary measurements yet.<br>Choose Distance or Polygon to start.</p>';
    listLayout.update(visibleRecords.length,listTitle);
    list.scrollTop=scrollTop;
    if(focusedAction){const row=[...(list.querySelectorAll?.('[data-record]')||[])].find(node=>node.dataset.record===focusedRecord);[...(row?.querySelectorAll('[data-m]')||[])].find(node=>node.dataset.m===focusedAction)?.focus({preventScroll:true});}
    for(const action of ['finish','undo'])controls.querySelector(`[data-m="${action}"]`).disabled=!draft;
    for(const action of ['edit','focus'])controls.querySelector(`[data-m="${action}"]`).disabled=!store.records.has(selected);
    const chosen=store.records.get(selected),crossFamily=chosen?.collection==='spatial3d'&&measurementCollection(context()?.mode)==='map';
    const edit=controls.querySelector('[data-m="edit"]');
    edit.textContent=crossFamily?(chosen.collection==='map'?'Edit in map view':'Edit in 3D view'):'Edit selected';
    edit.title=crossFamily?'Switch to the original view type to move vertices without changing the meaning of measured heights.':'Move the selected measurement’s vertices';
    controls.querySelector('[data-m="reload"]').hidden=!token()||!loadFailed;
  }
  function draftRecord(){return {...draft,vertices:draft.vertices.map(p=>p.slice())};}
  function releaseCursor(){if(cursorOwner){cursorOwner.style.cursor=previousCursor;cursorOwner=null;}}
  function updateCursor(){if(!bound?.element)return;const element=bound.element,handle=!!draft&&!shift&&(editing?(hoverHandle||gesture?.index>=0):space);element.classList.toggle('measurement-placing',!!draft&&!editing&&!shift&&!space);element.classList.toggle('measurement-navigating',!!draft&&shift);element.classList.toggle('measurement-editing',handle);if(draft&&(!editing||shift||handle)){if(cursorOwner!==element){releaseCursor();cursorOwner=element;previousCursor=element.style.cursor||'';}element.style.cursor=shift?'grab':handle?'move':'crosshair';}else releaseCursor();}
  function disarm(){draft=null;editing=false;selectedVertex=-1;editBaseline=null;draftDisplayVertices=null;cursor=null;gesture=null;space=false;pendingPick=null;updateCursor();toolChanged('none');renderPanel();}
  function closeReports(){for(const capture of reportCaptures)capture.abort();reportCaptures.clear();for(const dialog of [...reportDialogs])dialog.retire();}
  function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;closeReports();}
  function invalidate(reason='Personal measurements unavailable.',{notify=true}={}){
    if(invalidated)return;invalidated=true;viewGeneration++;clearDisplayRequests({all:true});recordSnapshot=[];orderedRecords=[];ready=false;adminAllowed=false;selected=null;selectedExports.clear();disarm();closeDialogs();store.invalidate?.();svg.innerHTML='';lastSvg='';controls.hidden=true;tell(reason);if(notify)onAccessLost();
  }
  function showSurface(record,{autoCalculate=false}={}){
    if(!record||record.kind!=='polygon'||!allowed()||disposed||typeof calculateSurface!=='function')return;
    let snapshot=structuredClone(record);
    closeDialogs();
    const generation=viewGeneration,dialogId=dialogGeneration;
    const isCurrent=()=>!disposed&&allowed()&&generation===viewGeneration&&dialogId===dialogGeneration;
    let attachmentPending=null;
    const attach=async results=>{
      if(!isCurrent())throw new Error('Measurement access or view changed.');
      const pending=store.attachResults(snapshot,results);attachmentPending=pending;
      try{await pending;if(isCurrent())snapshot=structuredClone(store.records.get(record.id));}
      finally{if(attachmentPending===pending)attachmentPending=null;}
    };
    // Server routing is independent of the asynchronous capability indicator.
    // Missing/expired authority must produce an error, never a browser fallback.
    const server=typeof surfaceRequest==='function'||preferServerSurface()||adminAllowed;
    const calculate=server?createServerSurfaceCalculator({request:surfaceRequest||adminRequest,isCurrent,getRecord:()=>snapshot}):calculateSurface;
    activeDialog=openSurfaceDialog({record,units,autoCalculate,advancedSettings:adminAllowed,areaM2:measurementMetrics(record).horizontalAreaM2,execution:server?'server':'browser',getRecord:()=>snapshot,
      loadPreviousVolume:server?async()=>{
        await capabilitiesReady;if(!isCurrent())throw new Error('Measurement access or view changed.');
        const request=adminAllowed&&typeof adminRequest==='function'?adminRequest:surfaceRequest;
        if(typeof request!=='function')return null;
        const response=await request('list',{measurementId:snapshot.id},snapshot);
        if(!isCurrent())throw new Error('Measurement access or view changed.');
        // Historical values are display-only. They cannot authorize a profile,
        // attach a result, or stand in for this outline's current volume.
        const jobs=Array.isArray(response?.calculations)?response.calculations:[];
        const job=jobs.filter(j=>snapshot.modelVersionId&&j.measurementId===snapshot.id&&j.status==='complete'&&['surface-cut-fill','point-surface-cut-fill','closed-mesh'].includes(j.method)&&j.result?.method===j.method&&j.result?.source?.modelVersionId===snapshot.modelVersionId&&Number.isSafeInteger(j.revision)&&j.revision<=snapshot.revision).sort((a,b)=>b.revision-a.revision||String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
        return job?previousVolume({results:job.result,revision:job.revision,updatedAt:job.updatedAt}):null;
      }:null,
      calculateProfile:server?async(...args)=>{
        if(attachmentPending)await attachmentPending;
        await capabilitiesReady;
        if(!isCurrent())throw new Error('Measurement access or view changed.');
        // Declared-unit point results retain their staff authorization boundary.
        // Result metadata selects transport only after verified staff capability;
        // it never grants authority or retries ordinary failures with elevation.
        const staffProfile=snapshot.results?.method==='point-surface-cut-fill'&&snapshot.results?.source?.verticalUnitBasis==='administrator-declared'&&adminAllowed&&typeof adminRequest==='function';
        return createServerProfileCalculator({request:staffProfile?adminRequest:surfaceRequest||adminRequest,isCurrent:()=>isCurrent()&&(!staffProfile||adminAllowed),getRecord:()=>snapshot})(...args);
      }:null,
      openSpecialist:adminAllowed&&specialistAllowed?async({host,isCurrent:panelCurrent,onOpened,onClose})=>{
        const current=()=>isCurrent()&&panelCurrent()&&adminAllowed&&specialistAllowed;
        if(attachmentPending)await attachmentPending;
        if(!current())throw new Error('Measurement access changed.');
        return openAdminCalculationDialog({record:structuredClone(snapshot),units,host,request:adminRequest,isCurrent:current,onOpened,onClose,onResult:async({calculation})=>{
          if(!current())throw new Error('Measurement access changed.');
          const {preview,...results}=calculation.result;
          await attach({...results,calculationJobId:calculation.id});
          if(!current())throw new Error('Measurement access changed.');
          return snapshot;
        }});
      }:null,
      calculate:async(...args)=>{if(attachmentPending)await attachmentPending;if(!isCurrent())throw new Error('Measurement access or view changed.');const result=await calculate(...args);if(!isCurrent())throw new Error('Measurement access or view changed.');return result;},
      save:async r=>attach(r.results),
      onClose:()=>{if(dialogId===dialogGeneration)activeDialog=null;}
    });
  }
  function previousVolume(record){
    const r=record.results||{},candidate=['cutM3','volumeM3','netM3'].some(k=>Number.isFinite(r[k]))?r:r.previousVolume;
    if(!candidate||!['cutM3','volumeM3','netM3'].some(k=>Number.isFinite(candidate[k])))return null;
    const summary={status:'historical',unit:'m3'};
    for(const key of ['cutM3','fillM3','netM3','volumeM3','coverage'])if(Number.isFinite(candidate[key]))summary[key]=candidate[key];
    if(typeof candidate.method==='string')summary.method=candidate.method.slice(0,80);
    const revision=candidate===r?record.revision:candidate.revision;if(Number.isSafeInteger(revision)&&revision>0)summary.revision=revision;
    const timestamp=candidate===r?record.updatedAt:candidate.recordedAt;if(typeof timestamp==='string'&&Number.isFinite(Date.parse(timestamp)))summary.recordedAt=timestamp;
    return summary;
  }
  async function finish({openVolume=false}={}){
    if(!draft)return;
    if(disposed||!allowed()){disarm();return;}
    if(draft.vertices.length<(draft.kind==='polygon'?3:2)){disarm();tell('Incomplete measurement cancelled.');return;}
    const record={...draftRecord(),displayPreferences:{...draft.displayPreferences,units:savedUnits[units]}},generation=viewGeneration,dialogId=dialogGeneration,mode=context()?.mode;
    const geometryChanged=!editing||editBaseline!==JSON.stringify(record.vertices),hadVolume=['cutM3','volumeM3','netM3'].some(key=>Number.isFinite(record.results?.[key]));
    if(editing&&!geometryChanged){disarm();tell('No point changes to save. Your saved measurement and volume are unchanged.');return;}
    const historical=previousVolume(record);
    try{if(geometryChanged)record.results={...measurementMetrics(record),status:'geometry-only',method:'vertex-geometry',...(hadVolume||record.results?.volumeInvalidated?{volumeInvalidated:true}:{}),...(historical?{previousVolume:historical}:{}),...(record.collection==='map'?{elevationBasis:'not-sampled',warnings:['Map geometry is two-dimensional; stored Z=0 is a placeholder, not measured elevation. Surface calculations sample native elevations separately.']}:{} )};validateMeasurementGeometry(record);selected=record.id;disarm();await store.save(record);if(disposed||!allowed()||generation!==viewGeneration)return;tell(hadVolume&&geometryChanged?'Outline saved. Calculate volume again for the changed outline.':store.persistent()?'Measurement saved privately.':'Temporary measurement — resets on refresh.');
      if(openVolume&&record.kind==='polygon'&&!draft&&selected===record.id&&dialogId===dialogGeneration&&mode===context()?.mode)showSurface(store.records.get(record.id),{autoCalculate:false});}
    catch(error){tell(error.message);}
  }
  function setTool(tool){
    if(!allowed())return;
    if(!ready){tell('Wait for your saved measurements to load.');return;}
    if(tool==='clear'){tell('Select an individual measurement and use Delete.');return;}
    if(tool==='none'){void finish();return;}
    if(draft){tell('Finish the current measurement before starting another.');return;}
    closeDialogs();
    const family=measurementCollection(context()?.mode),kind=tool==='distance'?'distance':'polygon';
    const sourceMode=context()?.mode;
    draft={id:crypto.randomUUID(),name:`${kind==='distance'?'Distance':'Polygon'} ${records().length+1}`,kind,collection:family,vertices:[],coordinateReference:coordinateReference(),visible:true,source:{kind:sourceMode==='model'?'mesh':sourceMode==='cloud'?'pointCloud':sourceMode}};
    editing=false;updateCursor();renderPanel();toolChanged(tool==='volume'?'area':tool);tell('Click to place points. Hold Shift to navigate.');
  }
  function editRecord(record){
    if(!record||!allowed())return;
    if(draft){tell('Finish the current measurement before editing another.');return;}
    if(!matchingReference(record)){tell('Cannot edit this measurement: its coordinate reference does not match this view.');return;}
    const mapIn3D=record.collection==='map'&&measurementCollection(context()?.mode)==='spatial3d';
    if(record.collection==='spatial3d'&&measurementCollection(context()?.mode)==='map'){tell('Edit these vertices in the 3D model or point cloud to preserve measured heights.');return;}
    const placed=mapIn3D?displayGeometry(record):null;
    if(mapIn3D&&!placed){tell('Wait for the outline to appear on the 3D surface, then choose Edit again.');return;}
    closeDialogs();draft=structuredClone(record);draftDisplayVertices=placed?.map(p=>p.slice())||null;editing=true;selectedVertex=-1;editBaseline=JSON.stringify(record.vertices);selected=record.id;cursor=null;pendingPick=null;updateCursor();renderPanel();toolChanged('edit');
    hoverHandle=false;updateCursor();tell('Drag a point; click + to insert. Drag elsewhere to navigate normally. Select a point then Delete or Backspace to remove it. Enter, Esc or Finish saves and exits editing.'+(mapIn3D?' This stays a horizontal outline; surface heights are used only to position its handles.':'')+(['cutM3','volumeM3','netM3'].some(key=>Number.isFinite(record.results?.[key]))?' Changing the outline makes its old volume historical until you recalculate.':''));
  }
  function editHandles(){const rect=bound.element.getBoundingClientRect();return measurementEditHandles(draft,(displayGeometry(draft)||[]).map(p=>bound.project(p,rect)),selectedVertex,rect.width,rect.height);}
  function moveDraftVertex(index,point){
    if(!Array.isArray(point)||point.length!==3||!point.every(Number.isFinite))return;
    if(draftDisplayVertices)draftDisplayVertices[index]=point.slice();
    draft.vertices[index]=draft.collection==='map'?[point[0],point[1],0]:point.slice();
  }
  function removeSelectedVertex(){try{draft.vertices=changeMeasurementVertex(draft,{type:'delete',index:selectedVertex});draftDisplayVertices?.splice(selectedVertex,1);selectedVertex=Math.min(selectedVertex,draft.vertices.length-1);cursor=null;pendingPick=null;tell('Point removed. Finish to save your outline.');}catch(error){tell(error.message);}}
  function nearest(event){if(!draft)return -1;const rect=bound.element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;let best=-1,d=18;(displayGeometry(draft)||[]).forEach((p,i)=>{const q=bound.project(p,rect);if(q){const n=Math.hypot(q[0]-x,q[1]-y);if(n<d){best=i;d=n;}}});return best;}
  function overEditHandle(event){if(!editing||!draft)return false;if(nearest(event)>=0)return true;const rect=bound.element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,{midpoints,deletion:d}=editHandles();return midpoints.some(p=>Math.hypot(x-p.x,y-p.y)<=12)||!!(d&&x>=d.x&&x<=d.x+d.width&&y>=d.y&&y<=d.y+d.height);}
  function stop(event){event.preventDefault();event.stopImmediatePropagation();}
  function pointerDown(event){
    if(!allowed()||!draft||event.shiftKey||interactive(event))return;
    if(event.button!==0&&event.button!==2)return;
    // In edit mode only a left-button handle gesture belongs to measurements.
    // Let each viewer retain its ordinary orbit, pan, zoom and context controls.
    if(editing&&(event.button!==0||!overEditHandle(event)))return;
    let index=(space||editing)?nearest(event):-1;
    if(editing&&event.button===0){const rect=bound.element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,handles=editHandles(),d=handles.deletion;
      if(d&&x>=d.x&&x<=d.x+d.width&&y>=d.y&&y<=d.y+d.height){removeSelectedVertex();stop(event);return;}
      if(index<0){const mid=handles.midpoints.find(p=>Math.hypot(x-p.x,y-p.y)<=12);if(mid){try{draft.vertices=changeMeasurementVertex(draft,{type:'insert',index:mid.index});if(draftDisplayVertices){const a=draftDisplayVertices[mid.index],b=draftDisplayVertices[(mid.index+1)%draftDisplayVertices.length];draftDisplayVertices.splice(mid.index+1,0,a.map((v,i)=>(v+b[i])/2));}index=mid.index+1;pendingPick=null;tell('Point inserted. Drag it to adjust; Finish saves.');}catch(error){tell(error.message);stop(event);return;}}}
      selectedVertex=index;
    }
    gesture={x:event.clientX,y:event.clientY,button:event.button,index,original:draft.vertices.map(p=>p.slice()),originalDisplay:draftDisplayVertices?.map(p=>p.slice())||null};
    if(event.button===0)bound.element.setPointerCapture?.(event.pointerId);
    stop(event);
  }
  function pointerMove(event){
    if(editing){hoverHandle=allowed()&&(!event.buttons||!!gesture)&&!event.shiftKey&&!interactive(event)&&overEditHandle(event);updateCursor();}
    if(!allowed()||!draft||event.shiftKey||shift||interactive(event))return;
    if(editing&&!gesture)return;
    if(event.buttons && !gesture)return;
    pendingPick={clientX:event.clientX,clientY:event.clientY};
    if(gesture)stop(event);
  }
  function pointerUp(event){
    if(!allowed()){disarm();return;}
    if(!gesture)return;
    const g=gesture;gesture=null;stop(event);
    pendingPick=null;
    if(g.index>=0){if(Math.hypot(event.clientX-g.x,event.clientY-g.y)<=2){draft.vertices=g.original;draftDisplayVertices=g.originalDisplay;}else{const point=bound.pick(event);if(point)moveDraftVertex(g.index,point);}if(editing||draft.vertices.length>=(draft.kind==='polygon'?3:2)){try{validateMeasurementGeometry(draft);}catch(error){draft.vertices=g.original;draftDisplayVertices=g.originalDisplay;tell(error.message);}}}
    try{bound.element.releasePointerCapture?.(event.pointerId);}catch{}
    if(event.shiftKey||Math.hypot(event.clientX-g.x,event.clientY-g.y)>6||g.index>=0)return;
    if(g.button===2){void finish();return;}
    if(editing)return;
    if(draft.vertices.length>=2000){tell('Maximum 2000 vertices. Finish this measurement before adding another.');return;}
    const point=bound.pick(event);
    if(point && (!draft.vertices.length||Math.hypot(...point.map((v,i)=>v-draft.vertices.at(-1)[i]))>1e-8))draft.vertices.push(point);
    if(draft.kind==='distance'&&draft.vertices.length===2)void finish();
  }
  function keyDown(event){
    if(field(event))return;
    if(event.key==='Shift'){shift=true;pendingPick=null;updateCursor();}
    if(!draft)return;
    if(event.code==='Space'){space=true;updateCursor();stop(event);}
    else if(event.key==='Backspace'||(editing&&event.key==='Delete')){if(editing){if(selectedVertex>=0)removeSelectedVertex();else tell('Select a point to remove it.');}else{draft.vertices.pop();cursor=null;}stop(event);}
    else if(event.key==='Escape'||event.key==='Enter'){stop(event);void finish();}
  }
  function keyUp(event){if(event.code==='Space')space=false;if(event.key==='Shift')shift=false;updateCursor();}
  function cancelGesture(){if(gesture?.index>=0&&draft){draft.vertices=gesture.original;draftDisplayVertices=gesture.originalDisplay;}gesture=null;pendingPick=null;}
  function blur(){cancelGesture();space=false;shift=false;cursor=null;updateCursor();}
  const contextMenu=e=>{if(draft&&!editing&&!e.shiftKey)stop(e);};
  function bind(next){
    if(bound?.element===next?.element){bound=next;return;}
    if(bound){for(const [event,fn]of handlers)bound.element.removeEventListener(event,fn,true);bound.element.ownerDocument.defaultView.removeEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.removeEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.removeEventListener('blur',blur);}
    bound?.element.classList.remove('measurement-placing','measurement-navigating','measurement-editing');
    releaseCursor();svg.remove();svg.innerHTML='';bound=next;lastSvg=null;pendingPick=null;
    if(!bound)return;
    bound.host.append(svg);
    updateCursor();
    for(const [event,fn]of handlers)bound.element.addEventListener(event,fn,true);
    bound.element.ownerDocument.defaultView.addEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.addEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.addEventListener('blur',blur);
  }
  const handlers=[['pointerdown',pointerDown],['pointermove',pointerMove],['pointerup',pointerUp],['pointerleave',()=>{hoverHandle=false;updateCursor();}],['pointercancel',blur],['contextmenu',contextMenu],['dblclick',e=>{if(draft&&(!editing||overEditHandle(e)))stop(e);}]];
  function draw({force=false}={}){
    if(disposed)return;
    bind(context());
    const collection=measurementCollection(bound?.mode);
    if(collection!==lastCollection){lastCollection=collection;renderPanel();}
    if(!permitted()){if(!invalidated&&!store.isInvalidated?.())try{onBeforeAccessLost();}catch{}invalidate('Personal measurements are hidden until access is restored.');return;}
    if(!bound||!allowed()){if(!allowed()&&draft)disarm();if(lastSvg!=='')svg.innerHTML='';lastSvg='';lastOverlayFrame=null;return;}
    observeDisplaySurface();
    if(pendingPick&&draft&&!shift&&performance.now()-lastPickAt>=66){const event=pendingPick;pendingPick=null;lastPickAt=performance.now();const point=bound.pick(event);if(point){if(gesture?.index>=0)moveDraftVertex(gesture.index,point);else if(!editing)cursor=point;}}
    const all=records().filter(r=>r.visible!==false&&r.id!==draft?.id).sort((a,b)=>Number(b.id===selected)-Number(a.id===selected));if(draft)all.unshift(draft);
    // Empty collections still check access above, but must not force layout,
    // camera projection or SVG mutation alongside a dense Potree render.
    if(!all.length){if(lastSvg!=='')svg.innerHTML='';lastSvg='';lastOverlayFrame=null;if(densityNotice.textContent) densityNotice.textContent='';return;}
    const signature=bound.viewSignature?.();
    const draftSignature=draft?JSON.stringify([draft.id,draft.vertices,draftDisplayVertices,cursor,editing,selectedVertex]):null;
    if(!force&&typeof signature==='string'&&lastOverlayFrame&&lastOverlayFrame.element===bound.element&&lastOverlayFrame.mode===bound.mode&&lastOverlayFrame.generation===viewGeneration&&lastOverlayFrame.signature===signature&&lastOverlayFrame.units===units&&lastOverlayFrame.selected===selected&&lastOverlayFrame.draft===draftSignature&&lastOverlayFrame.records.length===all.length&&all.every((record,index)=>record===lastOverlayFrame.records[index]))return;
    const rect=bound.element.getBoundingClientRect(),viewBox=`0 0 ${rect.width} ${rect.height}`;
    if(svg.getAttribute?.('viewBox')!==viewBox)svg.setAttribute('viewBox',viewBox);
    lastOverlayFrame={element:bound.element,mode:bound.mode,generation:viewGeneration,signature,units,selected,draft:draftSignature,records:all};
    let markup='',displayVertices=0,labelCount=0,decluttered=false;const labelBoxes=[];
    for(const r of all){
      if(displayVertices+r.vertices.length>5000){decluttered=true;continue;}
      displayVertices+=r.vertices.length;
      const geometry=displayGeometry(r);if(!geometry)continue;
      const vertices=geometry.slice();if(r===draft&&cursor&&!editing)vertices.push(cursor);
      const closed=r.kind==='polygon'&&vertices.length>=3,clipped=bound.projectBoundary?.(vertices,rect,{closed});
      const positions=clipped?.positions||vertices.map(p=>bound.project(p,rect));
      if(clipped){
        if(!clipped.segments.length&&!clipped.fill.length)continue;
        if(clipped.fill.length>=3)markup+=`<polygon points="${clipped.fill.map(p=>`${p[0]},${p[1]}`).join(' ')}" fill="#ee5007" fill-opacity="0.12" fill-rule="evenodd" stroke="none"/>`;
        for(const edge of clipped.segments)markup+=`<line data-measurement-edge="${edge.index}" x1="${edge.start[0]}" y1="${edge.start[1]}" x2="${edge.end[0]}" y2="${edge.end[1]}" stroke="${r.id===selected?'#fff':'#f8cb2e'}" stroke-width="2"/>`;
      }else{
        if(!positions.length||positions.some(p=>!p))continue;
        if(positions.every(p=>p[0]<0)||positions.every(p=>p[0]>rect.width)||positions.every(p=>p[1]<0)||positions.every(p=>p[1]>rect.height))continue;
        const points=positions.map(p=>`${p[0]},${p[1]}`).join(' ');
        markup+=`<${closed?'polygon':'polyline'} points="${points}" fill="${closed?'#ee5007':'none'}" fill-opacity="0.12" stroke="${r.id===selected?'#fff':'#f8cb2e'}" stroke-width="2"/>`;
      }
      for(let i=0;i<r.vertices.length;i++){const p=positions[i];if(p)markup+=`<circle data-measurement-vertex="${i}" cx="${p[0]}" cy="${p[1]}" r="${r===draft&&editing&&i===selectedVertex?6:4}" fill="#ee5007" stroke="#fff" stroke-width="${r===draft&&editing&&i===selectedVertex?2:1}"/>`;}
      if(r===draft&&editing){const handles=measurementEditHandles(r,positions,selectedVertex,rect.width,rect.height);for(const p of handles.midpoints)markup+=`<g data-measurement-insert="${p.index}"><circle cx="${p.x}" cy="${p.y}" r="9" fill="#162029" stroke="#ff8a45"/><text x="${p.x}" y="${p.y+4}" text-anchor="middle" fill="white" font-size="15">+</text></g>`;const d=handles.deletion;if(d)markup+=`<g data-measurement-delete="${selectedVertex}"><rect x="${d.x}" y="${d.y}" width="${d.width}" height="${d.height}" rx="5" fill="#282026" stroke="#ff8a45"/><text x="${d.x+d.width/2}" y="${d.y+17}" text-anchor="middle" fill="white" font-family="sans-serif" font-size="12">Delete point</text></g>`;}
      const text=(x,y,value)=>{const lines=Array.isArray(value)?value:[value],half=Math.max(...lines.map(v=>String(v).length))*3.5+5,box=[x-half,y-13,x+half,y+4+(lines.length-1)*17];if(++labelCount>200||labelBoxes.some(b=>box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1])){decluttered=true;return '';}labelBoxes.push(box);return `<text x="${x}" y="${y}" text-anchor="middle" fill="white" stroke="#121212" stroke-width="4" paint-order="stroke" font-size="12" font-family="sans-serif">${lines.map((line,i)=>i?`<tspan x="${x}" dy="17">${escape(line)}</tspan>`:escape(line)).join('')}</text>`;};
      const allVerticesVisible=positions.length&&positions.every(p=>p);
      if(r!==draft&&allVerticesVisible){
        const center=positions.reduce((s,p)=>[s[0]+p[0]/positions.length,s[1]+p[1]/positions.length],[0,0]);
        const result=r.results||{},volume=Number.isFinite(result.volumeM3)?result.volumeM3:Number.isFinite(result.netM3)?result.netM3:Number.isFinite(result.cutM3)?result.cutM3-(result.fillM3||0):null;
        const detail=volume!==null?`${result.estimated||result.status==='estimate'||result.method==='reconstructed-estimate'?'Estimated ':''}Volume ${measurementValue(volume,3,units)}`:closed?`${measurementValue(metrics(r).horizontalAreaM2,2,units)} horizontal`:null;
        markup+=text(center[0],center[1]+15,detail?[r.name,detail]:r.name);
      }
      if(vertices.length>=2){const lengths=(r===draft?measurementMetrics({...r,vertices:draftDisplayVertices?r.vertices:vertices}):metrics(r)).edgeLengthsM;for(let i=0;i<lengths.length;i++){const a=positions[i],b=positions[(i+1)%positions.length];if(!a||!b)continue;if(Math.hypot(a[0]-b[0],a[1]-b[1])<90&&r!==draft&&r.id!==selected){decluttered=true;continue;}markup+=text((a[0]+b[0])/2,(a[1]+b[1])/2-7,measurementValue(lengths[i],1,units));}}
    }
    const densityText=decluttered?'Display decluttered for responsiveness. Select a measurement to prioritize it, or hide others. Saved geometry and calculations are unchanged.':'';
    if(densityNotice.textContent!==densityText)densityNotice.textContent=densityText;
    if(markup!==lastSvg){svg.innerHTML=markup;lastSvg=markup;}
  }
  const timer=setInterval(draw,33);
  function download(content,name,type){const url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function exportRecords(){return records();}
  async function screenshot({allowIncomplete=false}={}){
    draw({force:true});if(!bound||!allowed())throw new Error('View is not ready or access is unavailable.');
    const unavailable=records().find(record=>record.visible!==false&&!displayGeometry(record));
    if(unavailable&&!allowIncomplete)throw new Error(`Cannot capture all visible measurements yet. ${displayStatus(unavailable)} Wait for placement, switch to a map view, or hide that measurement before capturing.`);
    const view=bound,generation=viewGeneration,displayUnits=units,crs=coordinateReference().crs,serialized=new XMLSerializer().serializeToString(svg);
    const assertCurrent=()=>{if(disposed||!allowed()||generation!==viewGeneration||view.element!==bound?.element||view.mode!==bound?.mode||displayUnits!==units)throw new Error('The view changed during capture. Capture the current view again.');};
    const canvas=await view.capture();assertCurrent();const ctx=canvas.getContext('2d');
    const image=new Image();const source=new Blob([serialized],{type:'image/svg+xml'});const url=URL.createObjectURL(source);
    try{image.src=url;await image.decode();assertCurrent();ctx.drawImage(image,0,0,canvas.width,canvas.height);}finally{URL.revokeObjectURL(url);}
    ctx.fillStyle='#101010';ctx.fillRect(0,canvas.height-28,canvas.width,28);ctx.fillStyle='white';ctx.font='12px sans-serif';ctx.fillText(`${unavailable?'Current view only · some measurement overlays unavailable · ':''}Measurements · ${displayUnits} · ${crs} · source accuracy not implied by display precision`,10,canvas.height-10);
    return canvas;
  }
  async function report(){
    const generation=viewGeneration,reportUnits=units,chosen=structuredClone(exportRecords()),metadata=reportMetadata();let reportImage=null,captureWarning='',ortho=null;
    const capture=new AbortController();reportCaptures.add(capture);
    tell('Preparing measurements report and overview images…');
    try{const canvas=await screenshot({allowIncomplete:true});reportImage=canvas.toDataURL('image/png');}catch(error){captureWarning=`View image unavailable: ${error.message}. The saved measurement tables are included below.`;}
    try{if(captureReportOrtho&&!capture.signal.aborted&&allowed()&&generation===viewGeneration)ortho=await captureReportOrtho({records:chosen,signal:capture.signal});}
    catch{captureWarning+=(captureWarning?' ':'')+'Orthophoto overview unavailable. Your saved measurements are still included.';}
    finally{reportCaptures.delete(capture);}
    if(disposed||!allowed()||generation!==viewGeneration||capture.signal.aborted||reportUnits!==units)throw new Error('Access or view changed during report capture.');
    const dialog=document.createElement('dialog');dialog.className='measurement-report';
    const reportWarnings=[captureWarning,...(!ortho?.dataUrl?(ortho?.warnings||[]):[])].filter(Boolean);
    dialog.innerHTML=renderMeasurementReport({records:chosen,units:reportUnits,modelName:metadata.modelName,coordinateReference:coordinateReference(),currentView:reportImage?{src:reportImage}:null,orthographicView:ortho?.dataUrl?{src:ortho.dataUrl,caption:[ortho.caption,...new Set(ortho.warnings||[])].filter(Boolean).join(' ')}:null,captureWarning:[...new Set(reportWarnings)].join(' ')});
    dialog.retire=()=>{if(!reportDialogs.delete(dialog))return;for(const img of dialog.querySelectorAll('img'))img.removeAttribute('src');dialog.innerHTML='';dialog.remove();};
    if(reportImage)dialog.querySelector('img').src=reportImage;else dialog.querySelector('img').hidden=true;
    const print=dialog.querySelector('[data-print]');let reportReady=false;
    print.disabled=true;print.textContent='Preparing report…';
    const current=()=>!disposed&&allowed()&&generation===viewGeneration&&reportUnits===units&&reportDialogs.has(dialog);
    reportDialogs.add(dialog);document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.retire();dialog.onclose=()=>dialog.retire();
    for(const toggle of dialog.querySelectorAll('[data-report-toggle]'))toggle.onchange=()=>{if(!current()){dialog.retire();return;}const figure=dialog.querySelector(`[data-report-figure="${toggle.dataset.reportToggle}"]`);if(figure)figure.hidden=!toggle.checked;};
    print.onclick=()=>{if(!current()){dialog.retire();return;}if(!reportReady)return;window.print();};
    // The captured data URL can still be decoding when the modal first opens.
    // Fonts may also load asynchronously. Never open print automatically: make
    // the user's explicit button available only once printable content is ready.
    dialog.getBoundingClientRect?.(); // Trigger layout/font discovery before awaiting FontFaceSet.ready.
    const imageReady=Promise.all([...dialog.querySelectorAll('img')].filter(img=>img.getAttribute('src')).map(img=>img.decode().catch(()=>{
      if(!current())return;img.hidden=true;img.removeAttribute('src');
      const warning=document.createElement('p');warning.textContent='View image unavailable. The saved measurement tables are included below.';dialog.querySelector('h1').after(warning);
    })));
    try{await Promise.all([imageReady,document.fonts?.ready||Promise.resolve()]);}
    catch{if(current())print.textContent='Report preparation unavailable';return;}
    if(!current()){dialog.retire();return;}
    dialog.getBoundingClientRect?.();reportReady=true;print.disabled=false;print.textContent='Print / Save as PDF';
    tell('Measurements report ready. Choose images to include, then print or save as PDF.');
  }
  controls.addEventListener('change',event=>{if(event.target.dataset.m==='units'){units=event.target.value;const record=store.records.get(selected);if(record&&!draft)void store.patch(record,{displayPreferences:{...record.displayPreferences,units:savedUnits[units]}}).catch(error=>tell(error.message));renderPanel();}if(event.target.dataset.m==='export-check'){const id=event.target.closest('[data-record]').dataset.record;event.target.checked?selectedExports.add(id):selectedExports.delete(id);}});
  controls.addEventListener('click',async event=>{
    if(!allowed()){tell('Access to these personal measurements is unavailable.');return;}
    const action=event.target.closest('[data-m]')?.dataset.m,id=event.target.closest('[data-record]')?.dataset.record,record=store.records.get(id);
    try{
      if(action==='finish')await finish();
      if(action==='undo'&&draft){draft.vertices.pop();draftDisplayVertices?.pop();}
      if(action==='edit')editRecord(store.records.get(selected));
      if(action==='edit-record'){selected=id;editRecord(record);}
      if(action==='focus'){const chosen=store.records.get(selected);if(chosen){const vertices=displayGeometry(chosen);if(vertices)context()?.focus?.(vertices);else tell(displayStatus(chosen));}else tell('Select a measurement name first.');}
      if(action==='select'){selected=id;if(restoredUnits[record.displayPreferences?.units]){units=restoredUnits[record.displayPreferences.units];controls.querySelector('[data-m="units"]').value=units;}renderPanel();}
      if(action==='reload'){clearDisplayRequests({all:true});try{const notice=await store.load();ready=true;loadFailed=false;renderPanel();tell(notice||'Saved measurements reloaded.');}catch(error){loadFailed=true;renderPanel();throw error;}}
      if(action==='visibility')await store.patch(record,{visible:record.visible===false});
      if(action==='delete'){await store.remove(id);selectedExports.delete(id);if(draft?.id===id)disarm();}
      if(action==='rename'){
        selected=id;
        const row=event.target.closest('[data-record]'),editor=document.createElement('form');editor.className='measurement-rename';editor.innerHTML='<label>Measurement name <input name="name" maxlength="160" required></label><div class="measurement-actions"><button type="submit">Save name</button><button type="button" data-cancel>Cancel</button></div>';
        const input=editor.querySelector('input');input.value=record.name;row.append(editor);input.focus();input.select();
        editor.querySelector('[data-cancel]').onclick=()=>renderPanel();editor.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();renderPanel();}};
        editor.onsubmit=async e=>{e.preventDefault();const name=input.value.trim();if(!name)return;editor.querySelector('[type=submit]').disabled=true;try{await store.patch(record,{name});tell('Measurement name saved.');}catch(error){tell(error.message);editor.querySelector('[type=submit]').disabled=false;}};
      }
      if(action==='export'){const format=controls.querySelector('[data-m="format"]').value;download(exportMeasurements(exportRecords(),format,{toLonLat,units}),`measurements.${format}`,format==='json'||format==='geojson'?'application/json':'text/plain');}
      if(action==='screenshot'){const generation=viewGeneration,displayUnits=units;const canvas=await screenshot({allowIncomplete:true});const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(disposed||!allowed()||generation!==viewGeneration||displayUnits!==units)throw new Error('The view changed during capture. Capture the current view again.');if(!blob)throw new Error('View capture unavailable.');download(blob,'measured-view.png');tell('View PNG download requested.');}
      if(action==='report')await report();
      if(action==='volume')showSurface(record);
    }catch(error){tell(error.message);}
  });
  initialLoad=store.load().then(notice=>{ready=true;loadFailed=false;renderPanel();if(notice)tell(notice);}).catch(error=>{loadFailed=true;renderPanel();tell(`Personal measurements unavailable: ${error.message}. Retry loading measurements when access is restored.`);});
  if(adminRequest)capabilitiesReady=adminRequest('capabilities',{}).then(result=>{if(!disposed&&allowed()){const newlyAllowed=!adminAllowed&&result.capabilities?.serverCalculations===true;adminAllowed=result.capabilities?.serverCalculations===true;if(newlyAllowed){for(const [id,entry]of displayCache)if(entry.awaitingStaff){entry.controller.abort();displayCache.delete(id);}lastOverlayFrame=null;}specialistAllowed=adminAllowed&&availableAdminSources(result).some(source=>source.methods.some(method=>method!=='surface-cut-fill'));renderPanel();}}).catch(()=>{adminAllowed=false;specialistAllowed=false;});
  renderPanel();
  function exportDraft({recoverExpiredSession=false}={}){
    // Only the authenticated session controller may request the expiry path;
    // it must fence identity/model/version before restoring this memory snapshot.
    if(!draft||disposed||invalidated||store.isInvalidated?.()||(!recoverExpiredSession&&!allowed()))return null;
    // An unfinished drag is not a completed edit. Preserve its starting point.
    const saved=store.records.get(draft.id);
    return structuredClone({draft:{...draftRecord(),vertices:gesture?.index>=0?gesture.original:draft.vertices},editing,baseline:editBaseline,displayVertices:gesture?.index>=0?gesture.originalDisplay:draftDisplayVertices,mode:context()?.mode,coordinateReference:coordinateReference(),savedRevision:saved?.revision??null,savedVertices:saved?.vertices??null});
  }
  async function restoreDraft(snapshot){
    await initialLoad;
    if(!snapshot||disposed||!allowed())return false;
    if(loadFailed){try{await store.load();ready=true;loadFailed=false;renderPanel();}catch(error){if(error.status===401||error.status===403||store.isInvalidated?.())return false;throw Object.assign(new Error('Saved measurements could not be loaded yet. The unfinished draft remains in this tab.'),{code:'measurement_draft_restore_retry'});}}
    if(!ready)throw Object.assign(new Error('Saved measurements are still loading.'),{code:'measurement_draft_restore_retry'});
    if(disposed||!allowed()||draft||snapshot.mode!==context()?.mode||JSON.stringify(snapshot.coordinateReference)!==JSON.stringify(coordinateReference()))return false;
    const candidate=snapshot.draft,points=candidate?.vertices;
    if(!candidate||!['map','spatial3d'].includes(candidate.collection)||!['distance','polygon'].includes(candidate.kind)||!Array.isArray(points)||points.length>2000||!points.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))||!matchingReference(candidate))return false;
    if(snapshot.editing){const saved=store.records.get(candidate.id);if(!saved||(saved.revision??null)!==snapshot.savedRevision||JSON.stringify(saved.vertices)!==JSON.stringify(snapshot.savedVertices)||snapshot.baseline!==JSON.stringify(saved.vertices)||saved.collection!==candidate.collection||saved.kind!==candidate.kind)return false;}
    else if(store.records.has(candidate.id))return false;
    const display=snapshot.displayVertices;
    if(display!==null&&display!==undefined&&(!Array.isArray(display)||display.length!==points.length||!display.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))))return false;
    if(candidate.collection==='map'&&measurementCollection(context()?.mode)==='spatial3d'&&!display)return false;
    draft=structuredClone(candidate);editing=snapshot.editing===true;editBaseline=editing?snapshot.baseline:null;draftDisplayVertices=display?structuredClone(display):null;selected=draft.id;selectedVertex=-1;gesture=null;pendingPick=null;cursor=null;hoverHandle=false;updateCursor();renderPanel();toolChanged(editing?'edit':draft.kind==='distance'?'distance':'area');tell('Your unfinished measurement was restored after access renewed. Enter, Esc or Finish saves and exits.');return true;
  }
  return {setTool,store,tick:draw,invalidate,exportDraft,restoreDraft,showRecoveryNotice:retry=>{if(!disposed&&allowed())tell(retry?'Your unfinished measurement is kept in this tab, but could not be restored while saved measurements are unavailable. It will retry on the next access renewal. Keep this tab open; nothing has been saved.':'Your unfinished measurement could not be restored because the saved outline or view changed. No draft changes were saved; review the current measurement before editing again.');},captureView:()=>controls.querySelector('[data-m="screenshot"]').click(),openReport:()=>controls.querySelector('[data-m="report"]').click(),isInvalidated:()=>invalidated||store.isInvalidated?.(),modeChanged(){cancelGesture();viewGeneration++;clearDisplayRequests({all:true});void finish({openVolume:false});closeDialogs();volumeAbort?.abort();bind(null);renderPanel();},isDrawing:()=>!!draft,dispose(){disposed=true;clearDisplayRequests({all:true});listLayout.dispose();viewGeneration++;clearInterval(timer);closeDialogs();volumeAbort?.abort();bind(null);controls.remove();message.remove();store.invalidate?.();},getDraft:()=>draft&&draftRecord()};
}
