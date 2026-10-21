import {measurementValue} from './measurement-document.mjs';
import {profileLine, profileStation, exportNativeProfile, validateNativeProfile} from './measurement-native-profile.mjs';

export function mountNativeProfile(host, {record, getRecord = () => record, units = 'imperial', calculate}) {
  const pointProfile=record.results?.source?.kind==='ept';
  host.innerHTML = `<section class="surface-section native-profile"><div class="surface-section-header"><h3>Elevation cross-section</h3><p>Inspect the original elevation cells along a line through this polygon, using the same reference base as its saved volume.</p></div>
  <div class="section-controls"><div><label>Direction <output data-direction>0° · east → west axis</output><input data-azimuth type="range" min="0" max="179" value="0" aria-label="Native section direction"></label><label class="profile-number">Degrees<input data-direction-number type="number" min="0" max="179" step="1" value="0" aria-label="Section direction in degrees"></label></div><div><label>Position <output data-position>Center</output><input data-position-input type="range" min="-100" max="100" value="0" aria-label="Native section position"></label><label class="profile-number">Offset (%)<input data-position-number type="number" min="-100" max="100" step="1" value="0" aria-label="Section position percentage"></label></div><div class="profile-actions"><button data-reset>Reset section</button><button data-update>Retry profile</button><button data-cancel hidden>Cancel</button></div></div>
  <p data-profile-status role="status" class="section-provenance">Loading the section automatically. The saved polygon and volume will not change.</p>
  <p data-profile-previous hidden role="status" class="section-provenance">Showing the previous completed section. The chart and plan below belong to that section, not the new slider settings. Exports are unavailable until the requested section is ready.</p>
  <div class="section-charts"><canvas data-profile-plan width="300" height="300" aria-label="Polygon boundary and selected section line, viewed from above"></canvas><canvas data-profile-chart width="850" height="300" tabindex="0" aria-label="Native elevation section. Use left and right arrows to inspect cells; Home and End go to the endpoints."></canvas></div>
  <div class="section-readout" data-profile-readout role="status">Elevations will appear when this section is ready.</div>
  <p class="section-provenance" data-profile-provenance>Orange: above base · Blue: below base · Gray: reference base. Gaps are missing data, not zero elevation. Section area is not volume.</p>
  <div class="profile-export"><button data-profile-csv disabled>Export profile CSV</button><button data-profile-png disabled>Save profile PNG</button><span class="hint">Unrounded source values in CSV · vertical datum unverified</span></div></section>`;
  const find = selector => host.querySelector(selector), chart = find('[data-profile-chart]'), plan = find('[data-profile-plan]');
  find('[data-update]').hidden=true;
  if(pointProfile){host.querySelector('.surface-section-header p').textContent='Inspect the saved volume’s maximum-height point grid along a line, using its same reference base. Empty cells remain gaps.';chart.setAttribute('aria-label','Point surface section. Use left and right arrows to inspect grid cells; Home and End go to the endpoints.');}
  const ctx = chart.getContext('2d'), pc = plan.getContext('2d'), status = find('[data-profile-status]'), readout = find('[data-profile-readout]');
  const chartImage=document.createElement('canvas'),planImage=document.createElement('canvas');chartImage.width=chart.width;chartImage.height=chart.height;planImage.width=plan.width;planImage.height=plan.height;
  const factor = {imperial: .3048, feet: .3048, metric: 1, yards: .9144, centimeters: .01}[units] || .3048;
  const suffix = {imperial: 'ft', feet: 'ft', metric: 'm', yards: 'yd', centimeters: 'cm'}[units] || 'ft';
  const format = v => measurementValue(v, 1, units), tick = v => (v / factor).toLocaleString('en-US', {maximumFractionDigits: 1});
  let retired = false, controller = null, generation = 0, result = null, stale = false, inspected = null, scales = null, line = null, cancelJob = null, cancelling = false, cachedResult = null, pendingUpdate = false, debounce = null;
  const initialRecord = structuredClone(getRecord() || record);
  const vertices = initialRecord.vertices;
  const xs = vertices.map(p => p[0]), ys = vertices.map(p => p[1]);
  const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), .001);
  const project = p => {const size=Math.max(1,Math.min(plan.width-40,plan.height-50));return[plan.width/2+(p[0]-center[0])/span*size,plan.height/2+5-(p[1]-center[1])/span*size];};
  function resize(){for(const [canvas,image]of [[chart,chartImage],[plan,planImage]]){const width=Math.round(canvas.clientWidth||canvas.width),height=Math.round(canvas.clientHeight||canvas.height);if(width>0&&height>0&&(canvas.width!==width||canvas.height!==height)){canvas.width=image.width=width;canvas.height=image.height=height;cachedResult=null;}}}
  function plot() {
    resize();
    if(result&&cachedResult===result&&scales){ctx.drawImage(chartImage,0,0);pc.drawImage(planImage,0,0);paintInspection();return;}
    pc.clearRect(0, 0, plan.width, plan.height); pc.fillStyle = '#0d141d'; pc.fillRect(0, 0, plan.width, plan.height);
    pc.beginPath(); vertices.forEach((p, i) => { const xy = project(p); i ? pc.lineTo(...xy) : pc.moveTo(...xy); }); pc.closePath(); pc.fillStyle = '#5b6b7b24'; pc.fill(); pc.strokeStyle = '#8fa1b5'; pc.lineWidth = 1.4; pc.stroke();
    const displayedLine=result?.line||line;
    if (displayedLine) { pc.beginPath(); pc.moveTo(...project(displayedLine.start)); pc.lineTo(...project(displayedLine.end)); pc.strokeStyle = '#f37523'; pc.lineWidth = 2; pc.stroke(); }
    pc.fillStyle = '#bac9d8'; pc.font = '12px system-ui'; pc.fillText('Polygon · north ↑', 14, 20);
    ctx.clearRect(0, 0, chart.width, chart.height); ctx.fillStyle = '#0d141d'; ctx.fillRect(0, 0, chart.width, chart.height); scales = null;
    if (!result) { ctx.fillStyle = '#adbbcb'; ctx.font = '12px system-ui'; ctx.fillText(controller||pendingUpdate?'Loading this section…':'No section data to display. See the status above.', 16, chart.height/2,chart.width-32); return; }
    let min = Infinity, max = -Infinity;
    for (const s of result.segments) if (s.status === 'sample') { min = Math.min(min, s.surfaceM, s.baseStartM, s.baseEndM); max = Math.max(max, s.surfaceM, s.baseStartM, s.baseEndM); }
    if (!Number.isFinite(min)) { ctx.fillStyle = '#adbbcb'; ctx.font = '12px system-ui'; ctx.fillText('No valid cells here. Move the section.', 16, chart.height/2,chart.width-32); return; }
    if (max - min < 1e-6) { min -= .5; max += .5; } const padding = (max - min) * .08; min -= padding; max += padding;
    const left=64,right=chart.width-16,bottom=chart.height-42,top=28;
    const x = station => left + station / result.lengthM * (right-left), y = z => bottom - (z - min) / (max - min) * (bottom-top);
    scales = {x, y,left,right,top,bottom}; ctx.font = '11px system-ui';
    const divisions=chart.width<500?2:4;
    for (let i = 0; i <= divisions; i++) { const z = min + (max - min) * i / divisions, yy = y(z); ctx.strokeStyle = '#273240'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillStyle = '#adbbcb'; ctx.fillText(tick(z), 5, yy + 4,left-10);ctx.textAlign=i===divisions?'right':i===0?'left':'center';ctx.fillText(tick(result.lengthM*i/divisions),x(result.lengthM*i/divisions),bottom+19);ctx.textAlign='left'; }
    ctx.fillStyle = '#bdcbdc'; ctx.fillText(`Elevation (${suffix})`, 6, 14);ctx.textAlign='center';ctx.fillText(`Distance along section (${suffix})`,(left+right)/2,chart.height-5,chart.width-20);ctx.textAlign='left';
    let previousSample=null;
    for (const s of result.segments) {
      if (s.status !== 'sample') {previousSample=null;continue;}
      // Each native cell is a constant-height step. Never bridge a missing cell.
      // Split above/below fill at the true base crossing, not the cell midpoint.
      const difference0 = s.surfaceM - s.baseStartM, difference1 = s.surfaceM - s.baseEndM;
      const slices = difference0 * difference1 < 0 ? [0, difference0 / (difference0 - difference1), 1] : [0, 1];
      for (let i = 1; i < slices.length; i++) {
        const a = slices[i - 1], b = slices[i], left = s.startM + (s.endM - s.startM) * a, right = s.startM + (s.endM - s.startM) * b, baseA = s.baseStartM + (s.baseEndM - s.baseStartM) * a, baseB = s.baseStartM + (s.baseEndM - s.baseStartM) * b;
        ctx.fillStyle = s.surfaceM >= (baseA + baseB) / 2 ? '#ff963e38' : '#5cccf738'; ctx.beginPath(); ctx.moveTo(x(left), y(s.surfaceM)); ctx.lineTo(x(right), y(s.surfaceM)); ctx.lineTo(x(right), y(baseB)); ctx.lineTo(x(left), y(baseA)); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = (difference0 + difference1) / 2 >= 0 ? '#ff963e' : '#5cccf7'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x(s.startM), y(s.surfaceM)); ctx.lineTo(x(s.endM), y(s.surfaceM)); ctx.stroke();
      if(previousSample&&Math.abs(previousSample.endM-s.startM)<1e-7){ctx.beginPath();ctx.moveTo(x(s.startM),y(previousSample.surfaceM));ctx.lineTo(x(s.startM),y(s.surfaceM));ctx.stroke();}previousSample=s;
      ctx.strokeStyle = '#bcc6d2'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(s.startM), y(s.baseStartM)); ctx.lineTo(x(s.endM), y(s.baseEndM)); ctx.stroke();
    }
    chartImage.getContext('2d').drawImage(chart,0,0);planImage.getContext('2d').drawImage(plan,0,0);cachedResult=result;paintInspection();
  }
  function paintInspection(){if(!inspected||!scales)return;const{x,y,top,bottom}=scales;ctx.strokeStyle='#ffd0ad';ctx.beginPath();ctx.moveTo(x(inspected.station),top);ctx.lineTo(x(inspected.station),bottom);ctx.stroke();if(inspected.segment.status==='sample'){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x(inspected.station),y(inspected.segment.surfaceM),3,0,2*Math.PI);ctx.fill();}pc.fillStyle='#fff';pc.beginPath();pc.arc(...project([inspected.x,inspected.y]),4,0,Math.PI*2);pc.fill();}
  const gapNames = {nodata: 'NoData · elevation missing', 'outside-raster': 'Outside elevation raster', 'outside-surface': 'Outside point surface', 'outside-selection': 'Outside selected polygon'};
  function inspect(station) {
    inspected = station === null ? null : profileStation(result, station);
    if (!inspected) readout.textContent = result ? 'Hover the profile, or focus it and use arrow keys to inspect each elevation cell.' : 'Elevations will appear when this section is ready.';
    else { const p = inspected, s = p.segment; readout.textContent = `Distance ${format(p.station)} · ${s.status === 'sample' ? `Surface ${format(s.surfaceM)} · Base ${format(p.base)} · Δ ${format(p.difference)}` : gapNames[s.status]} · X ${p.x.toFixed(3)}, Y ${p.y.toFixed(3)} (source coordinates, m)`; }
    plot();
  }
  function markPending() { stale=Boolean(result);inspected=null;find('[data-profile-previous]').hidden=!stale;find('[data-profile-csv]').disabled=true;find('[data-profile-png]').disabled=true; }
  function changeLine() {
    if(retired)return;generation++;markPending();
    const angle = Number(find('[data-azimuth]').value), offset = Number(find('[data-position-input]').value);
    line = profileLine(vertices, angle, offset); find('[data-direction]').textContent = `${angle}° from east`; find('[data-position]').textContent = offset === 0 ? 'Center' : `${offset > 0 ? '+' : ''}${offset}%`;
    find('[data-direction-number]').value=String(angle);find('[data-position-number]').value=String(offset);find('[data-direction-number]').setCustomValidity('');find('[data-position-number]').setCustomValidity('');
    status.textContent = controller?'Updating section after the current calculation finishes…':'Updating section…';pendingUpdate=true;inspect(null);
    clearTimeout(debounce);debounce=setTimeout(()=>{debounce=null;if(!controller&&!cancelling)runUpdate();},350);
  }
  find('[data-azimuth]').oninput = changeLine; find('[data-position-input]').oninput = changeLine;
  for(const [number,slider,min,max] of [['[data-direction-number]','[data-azimuth]',0,179],['[data-position-number]','[data-position-input]',-100,100]])find(number).oninput=()=>{
    const input=find(number),value=Number(input.value);if(!input.value.trim()||!Number.isFinite(value)||value<min||value>max){input.setCustomValidity('Enter a value between '+min+' and '+max+'.');return;}input.setCustomValidity('');find(slider).value=String(value);changeLine();
  };
  find('[data-reset]').onclick=()=>{find('[data-azimuth]').value='0';find('[data-position-input]').value='0';changeLine();};
  chart.onpointermove = event => { if (!result || !scales) return; const bounds = chart.getBoundingClientRect(), x = (event.clientX - bounds.left) / Math.max(1, bounds.width) * chart.width; inspect((x - scales.left) / (scales.right-scales.left) * result.lengthM); };
  chart.onpointerleave = () => inspect(null);
  chart.onkeydown = event => {
    if (!result || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); let index = inspected?.index ?? -1;
    if (event.key === 'Home') index = 0; else if (event.key === 'End') index = result.segments.length - 1; else index = Math.max(0, Math.min(result.segments.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    const s = result.segments[index]; inspect((s.startM + s.endM) / 2);
  };
  async function runUpdate() {
    if (retired || controller || cancelling) return;
    clearTimeout(debounce);debounce=null;pendingUpdate=false;
    controller = new AbortController(); const mine = controller, key = ++generation, selectedLine = structuredClone(line); cancelling = false;
    find('[data-update]').hidden=true;
    const current = () => !retired && generation === key && !mine.signal.aborted;
    markPending(); plot(); find('[data-update]').disabled = true; host.setAttribute('aria-busy', 'true'); cancelJob = null; find('[data-cancel]').hidden = true;
    try {
      status.textContent='Loading elevation cross-section…';
      const next = await calculate(getRecord() || record, {line: selectedLine, signal: mine.signal, onProgress: text => { if (current()) status.textContent = text; }, onJob: job => { if (!retired && controller===mine && !cancelling) { cancelJob = job; find('[data-cancel]').hidden = !job; find('[data-cancel]').disabled = false; } }});
      if (!current() || cancelling) return;
      result = validateNativeProfile(next, {line: selectedLine}); status.textContent = `Native section ready · ${result.cellCount.toLocaleString('en-US')} crossed cells. Your saved volume is unchanged.`;
      stale=false;find('[data-profile-previous]').hidden=true;cancelJob=null;
      const point=result.source.kind==='ept';
      find('[data-profile-provenance]').textContent = `${point?'Every crossed cell of the saved maximum-height point grid':'Every crossed native cell'} is represented without interpolation; gaps remain missing data. Source: ${result.source.kind.toUpperCase()} · ${result.source.crs} · cell size ${point?format(result.source.samplingGrid.cellSizeM):result.source.resolutionM?.map(format).join(' × ') || 'unavailable'}. Height-unit basis: ${result.source.verticalUnitBasis || 'unspecified'}. Vertical datum unverified. Orange: above base · Blue: below base · Gray: saved reference. Section area is not volume.`;
      find('[data-profile-csv]').disabled = false; find('[data-profile-png]').disabled = false; inspect(null);
    } catch (error) { if (current() && !cancelling) { markPending(); plot();find('[data-update]').hidden=false; status.textContent = `Profile unavailable. ${error.message}`; } }
    finally { const owns=controller===mine;if(owns)controller=null;if (owns && !retired && !cancelling) {host.removeAttribute('aria-busy');find('[data-update]').disabled=false;find('[data-cancel]').hidden=!cancelJob;if(!result&&!pendingUpdate)plot();if(pendingUpdate&&!debounce)runUpdate();} }
  }
  find('[data-update]').onclick=()=>runUpdate();
  find('[data-cancel]').onclick = async () => {
    const pending = cancelJob, mine = controller;
    if (retired || !pending || cancelling) return; cancelling=true;find('[data-cancel]').disabled = true;find('[data-update]').disabled = true;
    clearTimeout(debounce);debounce=null;pendingUpdate=false;
    try { await pending.cancel(); if (retired || (controller&&controller!==mine)) return; mine?.abort();controller=null;generation++;cancelling=false;cancelJob = null; find('[data-cancel]').hidden = true; find('[data-update]').disabled = false;find('[data-update]').hidden=false; host.removeAttribute('aria-busy');plot(); status.textContent = 'Cancellation requested. The saved polygon and volume are unchanged.'; }
    catch (error) { if (!retired && (!controller||controller===mine)) { cancelling=false;find('[data-cancel]').disabled = false;find('[data-update]').disabled=!!controller;find('[data-update]').hidden=!!controller;host.removeAttribute('aria-busy');status.textContent = `Could not cancel the section calculation. ${error.message} Retry the profile to resume or retrieve its result.`; } }
  };
  const links = new Set();
  function download(blob, filename) { if (retired) return; const url = URL.createObjectURL(blob); links.add(url); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => { URL.revokeObjectURL(url); links.delete(url); }, 1000); }
  find('[data-profile-csv]').onclick = () => { if (!retired && result && !stale && !controller && !pendingUpdate) download(new Blob([exportNativeProfile(result)], {type: 'text/csv;charset=utf-8'}), 'elevation-profile.csv'); };
  find('[data-profile-png]').onclick = () => {
    if (retired || !result || stale || controller || pendingUpdate) return; const snapshot = result, key = generation, output = document.createElement('canvas'); output.width = plan.width+chart.width; output.height = Math.max(plan.height,chart.height)+105;
    const c = output.getContext('2d'); c.fillStyle = '#0d141d'; c.fillRect(0,0,output.width,output.height); c.fillStyle = '#ecf2f9'; c.font = 'bold 17px system-ui'; c.fillText(`${initialRecord.name} · ${pointProfile?'point surface':'native elevation'} section`,18,27,output.width-36); c.drawImage(plan,0,40); c.drawImage(chart,plan.width,40);
    c.fillStyle = '#b9c6d6'; c.font = '11px system-ui'; c.fillText(`${snapshot.source.kind.toUpperCase()} · ${snapshot.source.crs} · elevations (${suffix}) · vertical datum unverified · missing cells are gaps`,18,output.height-42,output.width-36); c.fillText(`Source SHA-256 ${snapshot.source.sha256} · section is not volume`,18,output.height-22,output.width-36);
    output.toBlob(blob => { if (blob && !retired && generation === key && result === snapshot) download(blob, 'elevation-profile.png'); }, 'image/png');
  };
  changeLine();
  clearTimeout(debounce);debounce=null;runUpdate();
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(!retired)plot();}):null;resizeObserver?.observe(chart);resizeObserver?.observe(plan);
  return {dispose() { if (retired) return; retired = true;generation++;clearTimeout(debounce);pendingUpdate=false;resizeObserver?.disconnect(); controller?.abort(); result = null;cachedResult=null; inspected = null; for (const url of links) URL.revokeObjectURL(url); links.clear(); chartImage.width=chartImage.height=planImage.width=planImage.height=0;chart.onpointermove = chart.onpointerleave = chart.onkeydown = null; host.replaceChildren(); }};
}
