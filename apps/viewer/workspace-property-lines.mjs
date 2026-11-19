// Workspace card: choose a project's property-lines source (state parcel map
// or an uploaded boundary file), upload GeoJSON or KML, remove the upload.
// Built with DOM nodes and textContent only; nothing from the server or the
// file is ever inserted as HTML.

export const BOUNDARY_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
let mounts = 0;
const ACCEPT = '.geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml';

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export function boundarySummary(upload) {
  if (!upload) return 'No boundary file uploaded.';
  const format = upload.format === 'kml' ? 'KML' : 'GeoJSON';
  const day = String(upload.uploadedAt || '').slice(0, 10);
  const count = (n, word, plural = `${word}s`) => `${Number(n) || 0} ${Number(n) === 1 ? word : plural}`;
  const dropped = Number(upload.droppedCount) > 0 ? `, ${count(upload.droppedCount, 'unsupported item')} skipped` : '';
  return `${format}: ${count(upload.featureCount, 'feature')}, ${count(upload.vertexCount, 'vertex', 'vertices')}${dropped}${/^\d{4}-\d{2}-\d{2}$/.test(day) ? `, uploaded ${day}` : ''}.`;
}

export function datumLine(upload) {
  if (!upload) return '';
  return upload.datum === 'NAD83'
    ? 'NAD83 lon/lat, no datum shift; expect about 1 to 1.5 m offset on a WGS84 model.'
    : 'WGS84 lon/lat, no datum shift; expect about 1 to 1.5 m offset on a NAD83 model.';
}

// request(path, { method, body, raw }) -> parsed JSON or throws Error(message).
export function mountPropertyLinesSource({ container, projectId, request, toast = () => {}, confirm = async () => true, canWrite = true }) {
  const doc = container.ownerDocument;
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/property-lines`;
  let current = { source: 'state', upload: null }, busy = false;
  const group = `property-lines-source-${++mounts}`;

  const status = el(doc, 'p', { className: 'form-note', role: 'status', dataset: { pl: 'upload-status' } });
  const error = el(doc, 'p', { className: 'form-note bad', role: 'alert', hidden: true, dataset: { pl: 'upload-error' } });
  const radio = (value, label) => {
    const input = el(doc, 'input', { type: 'radio', name: group, value, dataset: { pl: `source-${value}` } });
    input.addEventListener('change', () => { if (input.checked) void choose(value); });
    return { input, label: el(doc, 'label', { className: 'radio-row' }, [input, doc.createTextNode(` ${label}`)]) };
  };
  const stateChoice = radio('state', 'State parcel map (Wisconsin)');
  const uploadChoice = radio('upload', 'Uploaded boundary file');
  const file = el(doc, 'input', { type: 'file', accept: ACCEPT, dataset: { pl: 'file' } });
  const fileLabel = el(doc, 'label', { className: 'field' }, [el(doc, 'span', { text: 'Boundary file (GeoJSON or KML, up to 20 MB)' }), file]);
  const uploadButton = el(doc, 'button', { type: 'button', className: 'primary-button', text: 'Upload', dataset: { pl: 'upload' } });
  const removeButton = el(doc, 'button', { type: 'button', className: 'danger-button', text: 'Remove upload', dataset: { pl: 'remove' } });
  const datum = el(doc, 'p', { className: 'form-note', hidden: true, dataset: { pl: 'upload-datum' } });
  const publicBox = el(doc, 'input', { type: 'checkbox', dataset: { pl: 'public' } });
  publicBox.addEventListener('change', () => { void setPublic(publicBox.checked); });
  const publicLabel = el(doc, 'label', { className: 'radio-row' }, [publicBox, doc.createTextNode(' Show on public links')]);
  const fieldset = el(doc, 'fieldset', { className: 'manage-form' }, [el(doc, 'legend', { text: 'Property lines source' }), stateChoice.label, uploadChoice.label]);
  container.replaceChildren(fieldset, status, datum, publicLabel, ...(canWrite ? [fileLabel, el(doc, 'div', { className: 'row-actions' }, [uploadButton, removeButton])] : []), error);

  function show(next) {
    current = { source: next?.source === 'upload' ? 'upload' : 'state', upload: next?.upload || null };
    stateChoice.input.checked = current.source === 'state';
    uploadChoice.input.checked = current.source === 'upload';
    uploadChoice.input.disabled = !current.upload || !canWrite || busy;
    stateChoice.input.disabled = !canWrite || busy;
    status.textContent = boundarySummary(current.upload);
    datum.hidden = !current.upload;
    datum.textContent = datumLine(current.upload);
    publicBox.checked = current.upload?.publicVisible === true;
    publicBox.disabled = !current.upload || !canWrite || busy;
    removeButton.disabled = !current.upload || busy;
    uploadButton.disabled = busy;
    file.disabled = busy;
  }
  function showError(message) { error.hidden = !message; error.textContent = message || ''; }
  async function run(work) {
    if (busy) return;
    busy = true; showError(''); show(current);
    try { show(await work()); } catch (caught) { showError(String(caught?.message || 'Request failed').slice(0, 300)); show(current); }
    finally { busy = false; show(current); }
  }
  function setPublic(value) {
    return run(async () => { const next = await request(base, { method: 'PATCH', body: { publicVisible: value } }); toast(value ? 'Uploaded boundary shown on public links' : 'Uploaded boundary hidden from public links'); return next; });
  }
  function choose(source) {
    if (source === current.source) return;
    return run(async () => { const next = await request(base, { method: 'PATCH', body: { source } }); toast(source === 'upload' ? 'Using the uploaded boundary file' : 'Using the state parcel map'); return next; });
  }

  uploadButton.addEventListener('click', () => {
    const chosen = file.files?.[0];
    if (!chosen) return showError('Choose a GeoJSON or KML file first.');
    if (chosen.size > BOUNDARY_UPLOAD_MAX_BYTES) return showError('The file is larger than 20 MB.');
    return run(async () => {
      const next = await request(`${base}/boundary`, { method: 'PUT', raw: await chosen.arrayBuffer() });
      file.value = '';
      toast('Boundary file uploaded');
      return next;
    });
  });
  removeButton.addEventListener('click', async () => {
    if (!current.upload || !await confirm('Remove the uploaded boundary file? Property lines go back to the state parcel map.')) return;
    return run(async () => { const next = await request(`${base}/boundary`, { method: 'DELETE', body: {} }); toast('Boundary file removed'); return next; });
  });

  show(current);
  const ready = run(() => request(base));
  return { ready, state: () => ({ ...current }) };
}
