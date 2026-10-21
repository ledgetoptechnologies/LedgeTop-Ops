import { measurementMetrics, measurementValue } from './measurement-document.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const imageSource = value => typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,[a-zA-Z0-9+/=\r\n]+$/.test(value) ? value : '';
const unitNames = { imperial: 'Feet & inches', feet: 'Feet', yards: 'Yards', metric: 'Metres', centimeters: 'Centimetres' };
const detail = (label, value) => value === undefined || value === null || value === '' ? '' : `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;

function calculationDetails(record, units) {
  const result = record.results;
  if (!result) return 'No volume calculation saved.';
  const parts = [];
  if (result.estimated || result.status === 'estimate' || result.method === 'reconstructed-estimate') parts.push('Estimated quantity; review calculation assumptions.');
  for (const [key, label] of [['cutM3','Cut'],['fillM3','Fill'],['netM3','Net'],['volumeM3','Enclosed volume']]) {
    if (Number.isFinite(result[key])) parts.push(`${label}: ${measurementValue(result[key], 3, units)}`);
  }
  for (const [key, label] of [['method','Method'],['status','Status'],['calculationOrigin','Origin'],['numericalModel','Numerical model']]) {
    if (result[key]) parts.push(`${label}: ${result[key]}`);
  }
  if (result.reference?.type) parts.push(`Base method: ${result.reference.type}`);
  for (const [key, label] of [['offsetM','Base offset'],['elevationM','Base elevation']]) {
    if (Number.isFinite(result.reference?.[key])) parts.push(`${label}: ${measurementValue(result.reference[key], 1, units)}`);
  }
  if (Number.isFinite(result.coverage)) parts.push(`Coverage: ${(result.coverage * 100).toFixed(3)}%`);
  const source = result.source || {};
  for (const [label, value] of [['Source',source.kind || result.sourceKind],['Height unit',source.verticalUnit || result.sourceVerticalUnit || result.verticalUnit],['Height unit basis',source.verticalUnitBasis || result.verticalUnitBasis],['Vertical datum',source.verticalUnitEvidence?.verticalDatum || result.verticalUnitEvidence?.verticalDatum]]) {
    if (typeof value === 'string' && value) parts.push(`${label}: ${value}`);
  }
  if (result.verified === false) parts.push('Not independently verified.');
  if (Array.isArray(result.warnings)) parts.push(...result.warnings);
  return parts.join('\n') || 'No volume quantity saved.';
}

/** Pure report fragment. Text inputs are raw and escaped here; only PNG/JPEG data URLs become image sources. */
export function renderMeasurementReport({ records = [], units = 'imperial', modelName = 'Untitled model', createdAt = new Date(), coordinateReference = {}, currentView = null, orthographicView = null, captureWarning = '', calculationSummary } = {}) {
  const date = new Date(createdAt);
  const readableDate = Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short' }).format(date);
  const currentSrc = imageSource(currentView?.src), orthoSrc = imageSource(orthographicView?.src);
  const figure = (view, src, key, fallback) => `<figure class="measurement-report-figure" data-report-figure="${key}"${src ? '' : ' hidden'}><figcaption><strong>${escape(view?.label || fallback)}</strong>${view?.caption ? `<span>${escape(view.caption)}</span>` : ''}</figcaption><img data-report-image="${key}" alt="${escape(view?.label || fallback)}"${src ? ` src="${src}"` : ' hidden'}></figure>`;
  const metrics = records.map(record => measurementMetrics(record));
  const summaryRows = records.map((record, index) => {
    const metric = metrics[index], result = record.results || {};
    const net = Number.isFinite(result.netM3) ? measurementValue(result.netM3, 3, units) : '—';
    const status = result.status || (Number.isFinite(result.netM3) ? 'Saved result' : 'Not calculated');
    return `<tr><th scope="row"><span class="measurement-report-number">${index + 1}.</span> ${escape(record.name || 'Unnamed measurement')}<small>${record.kind === 'polygon' ? 'Polygon' : 'Distance'} · ${record.collection === 'map' ? 'Map' : '3D'}</small></th><td>${record.kind === 'polygon' ? escape(measurementValue(metric.horizontalAreaM2, 2, units)) : '—'}</td><td>${escape(measurementValue(record.collection === 'map' ? metric.horizontalLengthM : metric.lengthM, 1, units))}<small>${record.collection === 'map' ? 'Horizontal' : '3D'}</small></td><td>${escape(net)}<small>${escape(Number.isFinite(result.volumeM3) && !Number.isFinite(result.netM3) ? 'Enclosed volume in appendix' : status)}</small></td></tr>`;
  }).join('');
  const appendix = records.map((record, index) => {
    const metric = metrics[index];
    const details = calculationSummary ? calculationSummary(record) : calculationDetails(record, units);
    return `<article class="measurement-report-detail"><h3>${index + 1}. ${escape(record.name || 'Unnamed measurement')}</h3><dl>${detail('Geometry', record.kind === 'polygon' ? 'Polygon' : 'Distance')}${detail('Vertices', record.vertices.length)}${detail('Horizontal length', measurementValue(metric.horizontalLengthM, 1, units))}${record.collection !== 'map' ? detail('3D length', measurementValue(metric.lengthM, 1, units)) : ''}${record.kind === 'polygon' ? detail('Horizontal area', measurementValue(metric.horizontalAreaM2, 2, units)) : ''}${record.kind === 'polygon' && record.collection !== 'map' && metric.planarAreaM2 !== null ? detail('Planar area', measurementValue(metric.planarAreaM2, 2, units)) : ''}${detail('Coordinate reference', record.coordinateReference?.crs || coordinateReference?.crs)}${detail('Measurement ID', record.id)}</dl><p class="measurement-report-calculation">${escape(details)}</p><p class="measurement-report-edges"><strong>Edge lengths${record.collection === 'map' ? ' (horizontal)' : ' (3D)'}</strong> ${escape((record.collection === 'map' ? record.vertices.slice(0, record.kind === 'polygon' ? record.vertices.length : -1).map((point, i) => Math.hypot(point[0] - record.vertices[(i + 1) % record.vertices.length][0], point[1] - record.vertices[(i + 1) % record.vertices.length][1])) : metric.edgeLengthsM).map((value, i) => `${i + 1}: ${measurementValue(value, 1, units)}`).join(' · '))}</p></article>`;
  }).join('');
  return `<div class="measurement-actions measurement-report-toolbar"><button data-print>Print / Save as PDF</button><button data-close>Close</button>${currentSrc ? '<label><input type="checkbox" data-report-toggle="current" checked> Include current view</label>' : ''}${orthoSrc ? '<label><input type="checkbox" data-report-toggle="ortho" checked> Include orthographic view</label>' : ''}</div><div class="measurement-report-document"><header class="measurement-report-header"><p class="measurement-report-brand">Ledge Top Drone Services <span>Measurement workspace</span></p><h1>Measurements report</h1><p class="measurement-report-model">${escape(modelName)}</p><p class="measurement-report-meta">${escape(readableDate)} · ${escape(unitNames[units] || units)}${coordinateReference?.crs ? ` · ${escape(coordinateReference.crs)}` : ''}</p></header>${captureWarning ? `<p class="measurement-report-warning">${escape(captureWarning)}</p>` : ''}${figure(currentView, currentSrc, 'current', 'Current view')}${orthoSrc ? figure(orthographicView, orthoSrc, 'ortho', 'Orthographic view') : ''}<section class="measurement-report-summary"><h2>Measurement summary <span>${records.length} ${records.length === 1 ? 'measurement' : 'measurements'}</span></h2><table><colgroup><col class="measurement-report-name-col"><col><col><col></colgroup><thead><tr><th scope="col">Measurement</th><th scope="col">Horizontal area</th><th scope="col">Perimeter / length</th><th scope="col">Net volume</th></tr></thead><tbody>${summaryRows || '<tr><td colspan="4">No measurements selected.</td></tr>'}</tbody></table><div class="measurement-report-notes"><p>Quantities are listed individually. Overlapping measurements are not summed. Net volume is cut minus fill; enclosed-object volume is reported separately in the appendix.</p><p>Display precision does not establish survey accuracy. Consider estimated geometry and missing coverage before using quantities. Map-only geometry has no measured elevation until a surface calculation is performed. Complete coordinates and calculation provenance are available in the JSON export.</p></div></section>${records.length ? `<section class="measurement-report-appendix"><h2>Appendix <span>Geometry & calculation details</span></h2>${appendix}</section>` : ''}</div>`;
}
