import { createMarksStore } from './viewer-marks-store.mjs';
import { createMarkMapLayer, geometryFrom, markPositions } from './viewer-mark-map-layer.mjs';
import { MARK_ICONS, MARK_SWATCHES, markIconName, markIconSvg, safeColor } from './viewer-mark-icons.mjs';
import { elevationForDisplay, elevationToMetres, elevationUnit, formatDecimal, formatDms, formatUtm, parseCoordinateInput } from './viewer-mark-coordinates.mjs';
import { geoJsonToMarks, marksToGeoJson } from './viewer-mark-geojson.mjs';

const TYPE_LABEL = { Point: 'Pin', LineString: 'Line', Polygon: 'Area' };
// Clients share with project staff, never with other clients. Staff share with one named client account.
const VISIBILITY_LABEL = { staff: 'Me and project staff', private: 'Only me', internal: 'Staff only', client: 'A client account' };
const ACCOUNT_TYPE = { model_association: 'Client association', direct_client_grant: 'Client grant' };
const accountLabel = key => { const [type, id = ''] = String(key).split(/:(.*)/s); return `${ACCOUNT_TYPE[type] || 'Client'} …${id.slice(-6)}`; };
const LABELS_KEY = 'ltds.viewer.marks.labels';

function h(document, tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.filter(child => child != null));
  return element;
}

function readLabelsPreference(window) {
  try { return window.localStorage?.getItem(LABELS_KEY) !== 'off'; } catch { return true; }
}
function writeLabelsPreference(window, on) {
  try { window.localStorage?.setItem(LABELS_KEY, on ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
}

export function mountViewerMarks({ panel, L, getMap, request = globalThis.fetch, newId = () => crypto.randomUUID(),
  onActivate = () => {}, georef = () => null, units = () => 'imperial', fileName = () => 'marks' }) {
  const document = panel.ownerDocument, window = document.defaultView;
  const listeners = new AbortController();
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  let view = { map: false }, mode = 'idle', drawing = null, draft = null, selectedId = null, preview = null;
  let labels = readLabelsPreference(window), filter = '', armedDelete = null, categoryDraft = null;
  let sessionScope = false, scopeKey;

  const store = createMarksStore({ request, newId, onChange: () => render() });
  const layer = createMarkMapLayer({ L, getMap,
    onSelect: id => select(id, { focus: false }),
    onMove: (mark, geometry) => { void store.update(mark, { geometry }); },
    onDraftMove: geometry => { if (draft) { draft.geometry = geometry; writeCoords(); render(); } },
  });

  // ---- skeleton -------------------------------------------------------------
  const root = panel.querySelector('[data-marks-root]') || panel;
  const status = h(document, 'p', { class: 'hint viewer-mark-status', role: 'status', 'aria-live': 'polite' });
  const addButtons = Object.keys(TYPE_LABEL).map(type => h(document, 'button', { type: 'button', class: 'tool-btn', 'data-add': type, 'aria-pressed': 'false', text: TYPE_LABEL[type] }));
  const tools = h(document, 'div', { class: 'viewer-mark-tools', role: 'toolbar', 'aria-label': 'Add marks' }, ...addButtons);
  const drawCount = h(document, 'span', { class: 'hint' });
  const drawUndo = h(document, 'button', { type: 'button', text: 'Undo point' });
  const drawFinish = h(document, 'button', { type: 'button', text: 'Finish' });
  const drawCancel = h(document, 'button', { type: 'button', text: 'Cancel' });
  const drawBar = h(document, 'div', { class: 'viewer-mark-row viewer-mark-draw', hidden: true }, drawCount, drawUndo, drawFinish, drawCancel);

  const coordInput = h(document, 'input', { name: 'coordinates', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Coordinates', placeholder: '43.0535, -87.9028 · DMS · UTM' });
  const coordDetected = h(document, 'p', { class: 'hint', 'aria-live': 'polite' });
  const coordPlace = h(document, 'button', { type: 'submit', text: 'Place pin' });
  const coordGo = h(document, 'button', { type: 'button', text: 'Go to' });
  const coordForm = h(document, 'form', { class: 'viewer-mark-coords' }, coordInput, coordDetected, h(document, 'div', { class: 'viewer-mark-row' }, coordPlace, coordGo));

  // Editor
  const field = (labelText, control, extra = {}) => h(document, 'label', extra, h(document, 'span', { text: labelText }), control);
  const editorTitle = h(document, 'h4');
  const nameInput = h(document, 'input', { name: 'name', maxlength: '100', required: true, autocomplete: 'off' });
  const categorySelect = h(document, 'select', { name: 'categoryId' });
  const colorInput = h(document, 'input', { name: 'color', type: 'color', 'aria-label': 'Custom colour' });
  const swatches = MARK_SWATCHES.map(color => h(document, 'button', { type: 'button', class: 'viewer-mark-swatch', 'data-color': color, 'aria-label': 'Colour ' + color, style: `background:${color}` }));
  const iconButtons = Object.entries(MARK_ICONS).map(([name, icon]) => {
    const button = h(document, 'button', { type: 'button', class: 'viewer-mark-icon', 'data-icon': name, 'aria-label': icon.label, title: icon.label });
    button.innerHTML = markIconSvg(name, '#555555', 22);
    return button;
  });
  const iconField = h(document, 'fieldset', { class: 'viewer-mark-icons' }, h(document, 'legend', { text: 'Icon' }), ...iconButtons);
  const pointCoords = h(document, 'input', { name: 'pointCoordinates', autocomplete: 'off', spellcheck: 'false' });
  const pointCoordsField = field('Coordinates', pointCoords);
  const coordReadout = h(document, 'p', { class: 'hint viewer-mark-readout' });
  const elevationLabel = h(document, 'span');
  const elevationInput = h(document, 'input', { name: 'elevation', inputmode: 'decimal', autocomplete: 'off' });
  const elevationField = h(document, 'label', {}, elevationLabel, elevationInput);
  const visibilitySelect = h(document, 'select', { name: 'visibility' });
  const visibilityField = field('Visible to', visibilitySelect);
  const accountSelect = h(document, 'select', { name: 'shareAccount' });
  const accountField = field('Client account', accountSelect);
  const noteInput = h(document, 'textarea', { name: 'note', maxlength: '2000', rows: '3' });
  const saveButton = h(document, 'button', { type: 'submit', class: 'viewer-mark-primary', text: 'Save' });
  const deleteButton = h(document, 'button', { type: 'button', text: 'Delete' });
  const closeButton = h(document, 'button', { type: 'button', text: 'Close' });
  const editor = h(document, 'form', { class: 'viewer-mark-form', hidden: true }, editorTitle,
    field('Label', nameInput), field('Category', categorySelect),
    h(document, 'fieldset', { class: 'viewer-mark-colors' }, h(document, 'legend', { text: 'Colour' }), ...swatches, colorInput),
    iconField, pointCoordsField, coordReadout, elevationField, visibilityField, accountField, field('Notes', noteInput),
    h(document, 'div', { class: 'viewer-mark-row' }, saveButton, deleteButton, closeButton));

  // List
  const filterSelect = h(document, 'select', { 'aria-label': 'Show category' });
  const labelsToggle = h(document, 'input', { type: 'checkbox' });
  const undoButton = h(document, 'button', { type: 'button', text: 'Undo' });
  const listHead = h(document, 'div', { class: 'viewer-mark-row viewer-mark-list-head' }, filterSelect,
    h(document, 'label', { class: 'viewer-mark-toggle' }, labelsToggle, h(document, 'span', { text: 'Labels' })), undoButton);
  const list = h(document, 'ul', { class: 'viewer-mark-list', 'aria-label': 'Marks' });

  // Categories
  const categoryList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-categories' });
  const categoryName = h(document, 'input', { name: 'categoryName', maxlength: '60', autocomplete: 'off', 'aria-label': 'Category name', placeholder: 'Name' });
  const categoryColor = h(document, 'input', { type: 'color', value: MARK_SWATCHES[0], 'aria-label': 'Category colour' });
  const categoryIcon = h(document, 'select', { 'aria-label': 'Category icon' },
    ...Object.entries(MARK_ICONS).map(([name, icon]) => h(document, 'option', { value: name, text: icon.label })));
  const categorySave = h(document, 'button', { type: 'submit', text: 'Add' });
  const categoryCancel = h(document, 'button', { type: 'button', text: 'Cancel', hidden: true });
  const categoryForm = h(document, 'form', { class: 'viewer-mark-row viewer-mark-category-form' }, categoryName, categoryColor, categoryIcon, categorySave, categoryCancel);
  const categories = h(document, 'details', { class: 'viewer-mark-section' }, h(document, 'summary', { text: 'Categories' }), categoryList, categoryForm);

  // Import / export
  const exportButton = h(document, 'button', { type: 'button', text: 'Export GeoJSON' });
  const importInput = h(document, 'input', { type: 'file', accept: '.geojson,.json,application/geo+json,application/json', hidden: true });
  const importButton = h(document, 'button', { type: 'button', text: 'Import GeoJSON' });
  const exchange = h(document, 'details', { class: 'viewer-mark-section' }, h(document, 'summary', { text: 'Import / export' }),
    h(document, 'div', { class: 'viewer-mark-row' }, exportButton, importButton, importInput));

  root.replaceChildren(status, tools, drawBar, coordForm, editor, listHead, list, categories, exchange);

  // ---- helpers --------------------------------------------------------------
  const canWrite = () => store.canWrite() && Boolean(view.map);
  const categoryById = id => store.state.categories.find(category => category.id === id) || null;
  const visibleMarks = () => store.state.marks.filter(mark => !filter || (filter === 'none' ? !mark.categoryId : mark.categoryId === filter));
  const defaultVisibility = () => (store.state.capabilities.staff ? 'internal' : 'private');
  const message = text => { store.state.message = text; render(); };

  function setMode(next) {
    // Stop any measuring tool first; it calls cancelPlacement, which must not undo this mode.
    if (next !== 'idle') onActivate();
    mode = next;
    drawing = next === 'LineString' || next === 'Polygon' ? { type: next, positions: [], color: lastStyle().color } : null;
    const map = getMap();
    if (map?.doubleClickZoom) map.doubleClickZoom[drawing ? 'disable' : 'enable']();
  }

  function lastStyle() {
    const category = categoryById(filter) || null;
    return { color: category?.color || MARK_SWATCHES[0], icon: category?.icon || 'pin', categoryId: category?.id || null };
  }

  function startDraft(geometry) {
    const style = lastStyle();
    const category = categoryById(style.categoryId);
    draft = { id: null, geometry, name: category?.name || TYPE_LABEL[geometry.type], note: '', categoryId: style.categoryId,
      color: style.color, icon: style.icon, elevationNavd88M: null, visibility: defaultVisibility() };
    selectedId = null;
    armedDelete = null;
    setMode('idle');
    writeEditor();
    render();
    nameInput.focus?.();
    nameInput.select?.();
  }

  function select(id, { focus = true } = {}) {
    const mark = store.find(id);
    if (!mark || mode !== 'idle') return;
    selectedId = id;
    armedDelete = null;
    draft = { ...mark, geometry: structuredClone(mark.geometry) };
    writeEditor();
    if (focus) layer.focus(mark.geometry);
    render();
  }

  function closeEditor() {
    draft = null;
    selectedId = null;
    armedDelete = null;
    render();
  }

  // A mark can use your own categories (staff: any staff category), or keep the one it has.
  const usableCategory = (category, keep) => category.id === keep || category.mine
    || (store.state.capabilities.staff && category.author === 'staff');

  function fillCategoryOptions(select, value, emptyLabel, usable = () => true) {
    const options = [h(document, 'option', { value: '', text: emptyLabel })];
    if (select === filterSelect) options.push(h(document, 'option', { value: 'none', text: 'No category' }));
    for (const category of store.state.categories.filter(usable)) options.push(h(document, 'option', { value: category.id, text: category.name }));
    select.replaceChildren(...options);
    select.value = value || '';
  }

  function writeEditor() {
    if (!draft) return;
    nameInput.value = draft.name;
    fillCategoryOptions(categorySelect, draft.categoryId, 'None', category => usableCategory(category, draft.categoryId));
    colorInput.value = safeColor(draft.color);
    noteInput.value = draft.note || '';
    elevationInput.value = elevationForDisplay(draft.elevationNavd88M, units());
    const options = store.state.capabilities.staff ? ['internal', 'client', 'private'] : ['private', 'staff'];
    visibilitySelect.replaceChildren(...options.map(value => h(document, 'option', { value, text: VISIBILITY_LABEL[value] })));
    visibilitySelect.value = options.includes(draft.visibility) ? draft.visibility : options[0];
    const accounts = store.state.audiences.map(row => row.account);
    if (draft.shareAccount && !accounts.includes(draft.shareAccount)) accounts.unshift(draft.shareAccount);
    accountSelect.replaceChildren(h(document, 'option', { value: '', text: accounts.length ? 'Choose…' : 'No client with a direct grant has opened Marks here' }),
      ...accounts.map(account => h(document, 'option', { value: account, text: accountLabel(account) })));
    accountSelect.value = draft.shareAccount || '';
    writeCoords();
  }

  function writeCoords() {
    if (draft?.geometry.type !== 'Point') return;
    const [lon, lat] = draft.geometry.coordinates;
    pointCoords.value = formatDecimal(lat, lon);
  }

  function readEditor() {
    const elevation = elevationToMetres(elevationInput.value, units());
    return { name: nameInput.value.trim(), categoryId: categorySelect.value || null, color: safeColor(colorInput.value),
      note: noteInput.value.trim(), elevationNavd88M: elevation, visibility: visibilitySelect.value,
      ...(visibilitySelect.value === 'client' ? { shareAccount: accountSelect.value || null } : {}) };
  }

  function readout(geometry) {
    const positions = markPositions(geometry);
    if (geometry.type !== 'Point') return `${positions.length} points`;
    const [lon, lat] = positions[0];
    const utm = formatUtm(lat, lon, georef());
    return formatDms(lat, lon) + (utm ? ` · UTM ${utm}` : '');
  }

  // ---- render ---------------------------------------------------------------
  function render() {
    const { state } = store;
    panel.hidden = !state.ready && !state.loading && !state.message || state.blocked;
    const writable = canWrite();
    status.textContent = state.message || (state.loading ? 'Loading marks…'
      : !view.map && state.ready ? 'Open Ortho or a height map to place marks.' : '');
    status.hidden = !status.textContent;
    tools.hidden = !writable;
    for (const button of addButtons) {
      const active = mode === button.dataset.add;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = state.busy;
    }
    drawBar.hidden = !drawing;
    if (drawing) {
      const need = drawing.type === 'Polygon' ? 3 : 2;
      drawCount.textContent = `${drawing.positions.length} point${drawing.positions.length === 1 ? '' : 's'}`;
      drawFinish.disabled = drawing.positions.length < need;
      drawUndo.disabled = !drawing.positions.length;
    }
    coordForm.hidden = !state.ready;
    coordPlace.hidden = !writable;

    // Editor
    const existing = draft?.id ? store.find(draft.id) : null;
    const editable = draft && (draft.id ? store.editable(existing) : writable);
    editor.hidden = !draft;
    if (draft) {
      editorTitle.textContent = draft.id ? (editable ? 'Edit ' : '') + TYPE_LABEL[draft.geometry.type].toLowerCase() : 'New ' + TYPE_LABEL[draft.geometry.type].toLowerCase();
      for (const control of [nameInput, categorySelect, colorInput, noteInput, elevationInput, visibilitySelect, accountSelect, pointCoords, saveButton, ...swatches, ...iconButtons])
        control.disabled = !editable || state.busy;
      for (const swatch of swatches) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === safeColor(colorInput.value)));
      for (const button of iconButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.icon === markIconName(draft.icon)));
        button.innerHTML = markIconSvg(button.dataset.icon, button.dataset.icon === markIconName(draft.icon) ? colorInput.value : '#555555', 22);
      }
      iconField.hidden = draft.geometry.type !== 'Point';
      pointCoordsField.hidden = draft.geometry.type !== 'Point';
      coordReadout.textContent = readout(draft.geometry);
      elevationLabel.textContent = `NAVD88 Elevation (${elevationUnit(units())})`;
      visibilityField.hidden = !sessionScope || !state.capabilities.write || Boolean(draft.id && !draft.mine);
      accountField.hidden = visibilityField.hidden || visibilitySelect.value !== 'client';
      deleteButton.hidden = !draft.id || !editable;
      deleteButton.textContent = armedDelete === draft.id ? 'Tap again to delete' : 'Delete';
      deleteButton.disabled = state.busy;
      saveButton.hidden = !editable;
    }

    // List
    fillCategoryOptions(filterSelect, filter, 'All categories');
    if (filterSelect.value !== filter) filter = filterSelect.value;
    labelsToggle.checked = labels;
    const lastUndo = state.undo.at(-1);
    undoButton.hidden = !lastUndo;
    undoButton.disabled = state.busy;
    undoButton.title = lastUndo ? 'Undo ' + lastUndo.label : '';
    const rows = visibleMarks().map(mark => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = mark.geometry.type === 'Point' ? markIconSvg(mark.icon, mark.color, 18)
        : `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="${mark.geometry.type === 'Polygon' ? 'M3 14L5 4l9 2 1 8z' : 'M2 14l5-8 4 5 5-8'}" fill="${mark.geometry.type === 'Polygon' ? safeColor(mark.color) + '55' : 'none'}" stroke="${safeColor(mark.color)}" stroke-width="2"/></svg>`;
      const category = categoryById(mark.categoryId);
      const text = h(document, 'span', { class: 'viewer-mark-list-name' }, h(document, 'span', { text: mark.name }),
        h(document, 'small', { text: [category?.name, !mark.mine && mark.author === 'staff' && !state.capabilities.staff ? 'From project staff'
          : mark.visibility === 'client' && mark.shareAccount ? accountLabel(mark.shareAccount)
            : mark.visibility !== defaultVisibility() && VISIBILITY_LABEL[mark.visibility]].filter(Boolean).join(' · ') }));
      const button = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item', 'aria-current': mark.id === selectedId ? 'true' : false }, icon, text);
      on(button, 'click', () => select(mark.id));
      return h(document, 'li', {}, button);
    });
    list.replaceChildren(...rows);
    listHead.hidden = !state.ready || !state.marks.length && !state.undo.length;

    // Categories
    categories.hidden = !state.ready || !writable && !state.categories.length;
    categoryForm.hidden = !writable;
    categoryList.replaceChildren(...state.categories.map(category => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = markIconSvg(category.icon, category.color, 18);
      const row = h(document, 'li', {}, icon, h(document, 'span', { class: 'viewer-mark-list-name', text: category.name }));
      if (writable && category.editable) {
        const rename = h(document, 'button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + category.name });
        const remove = h(document, 'button', { type: 'button', text: armedDelete === category.id ? 'Tap again' : 'Delete', 'aria-label': 'Delete ' + category.name });
        on(rename, 'click', () => {
          categoryDraft = category;
          categoryName.value = category.name;
          categoryColor.value = safeColor(category.color);
          categoryIcon.value = markIconName(category.icon);
          render();
        });
        on(remove, 'click', async () => {
          if (armedDelete !== category.id) { armedDelete = category.id; render(); return; }
          armedDelete = null;
          if (await store.deleteCategory(category) && filter === category.id) filter = '';
          render();
        });
        row.append(rename, remove);
      }
      return row;
    }));
    categorySave.textContent = categoryDraft ? 'Save' : 'Add';
    categoryCancel.hidden = !categoryDraft;
    exchange.hidden = !state.ready;
    importButton.hidden = !writable;
    exportButton.disabled = !state.marks.length;

    layer.render({ visible: Boolean(view.map && state.ready && !state.blocked), marks: visibleMarks(), draft: editable ? { ...draft, ...(draft.id ? {} : { id: '__draft__' }) } : null,
      selectedId, labels, preview, drawing, editable: mark => mode === 'idle' && store.editable(mark) });
  }


  // ---- events ---------------------------------------------------------------
  for (const button of addButtons) on(button, 'click', () => {
    if (!canWrite()) return;
    draft = null;
    selectedId = null;
    setMode(mode === button.dataset.add ? 'idle' : button.dataset.add);
    render();
  });
  on(drawUndo, 'click', () => { drawing?.positions.pop(); render(); });
  on(drawCancel, 'click', () => { setMode('idle'); render(); });
  on(drawFinish, 'click', () => finishDrawing());

  function finishDrawing() {
    if (!drawing) return false;
    const need = drawing.type === 'Polygon' ? 3 : 2;
    if (drawing.positions.length < need) return false;
    startDraft(geometryFrom(drawing.type, drawing.positions));
    return true;
  }

  on(coordInput, 'input', () => {
    const parsed = parseCoordinateInput(coordInput.value, { georef: georef() });
    preview = parsed.ok ? [parsed.longitude, parsed.latitude] : null;
    coordDetected.textContent = parsed.ok ? `${parsed.format}: ${formatDecimal(parsed.latitude, parsed.longitude)}` : parsed.error;
    render();
  });
  const typedPoint = () => {
    const parsed = parseCoordinateInput(coordInput.value, { georef: georef() });
    if (!parsed.ok) { coordDetected.textContent = parsed.error || 'Enter coordinates.'; return null; }
    return [Math.round(parsed.longitude * 1e8) / 1e8, Math.round(parsed.latitude * 1e8) / 1e8];
  };
  on(coordForm, 'submit', event => {
    event.preventDefault();
    const point = typedPoint();
    if (!point || !canWrite()) return;
    layer.focus({ type: 'Point', coordinates: point });
    startDraft({ type: 'Point', coordinates: point });
  });
  on(coordGo, 'click', () => {
    const point = typedPoint();
    if (point) layer.focus({ type: 'Point', coordinates: point });
  });

  // Reads the coordinates field as it is now. Returns false (and shows why)
  // when the text is not a valid position, leaving the draft untouched.
  function applyPointCoordinates() {
    if (!draft || draft.geometry.type !== 'Point') return true;
    const parsed = parseCoordinateInput(pointCoords.value, { georef: georef() });
    if (!parsed.ok) { message(parsed.error || 'Enter coordinates.'); return false; }
    draft.geometry = { type: 'Point', coordinates: [Math.round(parsed.longitude * 1e8) / 1e8, Math.round(parsed.latitude * 1e8) / 1e8] };
    pointCoords.value = formatDecimal(parsed.latitude, parsed.longitude);
    return true;
  }

  on(pointCoords, 'change', () => {
    if (applyPointCoordinates()) { store.clearMessage(); render(); }
  });
  on(categorySelect, 'change', () => {
    const category = categoryById(categorySelect.value);
    if (!draft) return;
    draft.categoryId = category?.id || null;
    if (category) {
      draft.color = category.color;
      draft.icon = category.icon;
      colorInput.value = safeColor(category.color);
      if (!nameInput.value.trim() || Object.values(TYPE_LABEL).includes(nameInput.value.trim())) nameInput.value = category.name;
    }
    render();
  });
  for (const swatch of swatches) on(swatch, 'click', () => { if (draft) { draft.color = swatch.dataset.color; colorInput.value = swatch.dataset.color; render(); } });
  on(colorInput, 'input', () => { if (draft) { draft.color = safeColor(colorInput.value); render(); } });
  for (const button of iconButtons) on(button, 'click', () => { if (draft) { draft.icon = button.dataset.icon; render(); } });
  on(nameInput, 'input', () => { if (draft) draft.name = nameInput.value; });
  on(closeButton, 'click', closeEditor);
  on(visibilitySelect, 'change', () => render());
  on(deleteButton, 'click', async () => {
    const current = draft?.id ? store.find(draft.id) : null;
    if (!current) return;
    if (armedDelete !== current.id) { armedDelete = current.id; render(); return; }
    armedDelete = null;
    if (await store.remove(current)) closeEditor();
  });
  on(editor, 'submit', async event => {
    event.preventDefault();
    if (!draft) return;
    // Enter or Save can arrive without a change event: never save the coordinates
    // the field showed before. Invalid text keeps the editor open and writes nothing.
    if (!applyPointCoordinates()) return;
    const values = readEditor();
    if (!values.name) { message('Give the mark a label.'); return; }
    if (Number.isNaN(values.elevationNavd88M)) { message('NAVD88 Elevation must be a number.'); return; }
    if (values.visibility === 'client' && !values.shareAccount) { message('Choose a client account to share with.'); return; }
    const changes = { ...values, icon: markIconName(draft.icon), geometry: draft.geometry };
    if (draft.id) {
      const current = store.find(draft.id);
      if (!current) { closeEditor(); return; }
      if (!current.mine) { delete changes.visibility; delete changes.shareAccount; }
      if (await store.update(current, changes)) closeEditor();
    } else if (await store.create(changes)) closeEditor();
  });

  on(filterSelect, 'change', () => { filter = filterSelect.value; render(); });
  on(labelsToggle, 'change', () => { labels = labelsToggle.checked; writeLabelsPreference(window, labels); render(); });
  on(undoButton, 'click', async () => { closeEditor(); await store.undo(); });

  on(categoryForm, 'submit', async event => {
    event.preventDefault();
    const name = categoryName.value.trim();
    if (!name) return;
    const saved = await store.saveCategory({ ...(categoryDraft ? { id: categoryDraft.id, revision: categoryDraft.revision } : {}),
      name, color: safeColor(categoryColor.value), icon: categoryIcon.value });
    if (saved) {
      categoryDraft = null;
      categoryName.value = '';
      render();
    }
  });
  on(categoryCancel, 'click', () => { categoryDraft = null; categoryName.value = ''; render(); });

  on(exportButton, 'click', () => {
    const data = marksToGeoJson(visibleMarks(), store.state.categories);
    const blob = new window.Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
    const url = window.URL.createObjectURL(blob);
    const link = h(document, 'a', { href: url, download: `${String(fileName()).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'marks'}-marks.geojson` });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  });
  on(importButton, 'click', () => importInput.click());
  on(importInput, 'change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { message('GeoJSON files up to 5 MB can be imported.'); return; }
    try {
      const parsed = geoJsonToMarks(JSON.parse(await file.text()), { categories: store.state.categories, newId,
        visibility: defaultVisibility(), defaultColor: MARK_SWATCHES[0] });
      if (!parsed.marks.length) { message('No points, lines or areas were found in that file.'); return; }
      const count = await store.importMarks(parsed);
      if (count) message(`Imported ${count} mark${count === 1 ? '' : 's'}${parsed.skipped ? `; skipped ${parsed.skipped} unsupported` : ''}.`);
    } catch (error) {
      message(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message || 'Could not import that file.');
    }
  });

  const leave = event => {
    if (!store.hasTemporaryMarks()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  on(window, 'beforeunload', leave);

  render();

  return {
    store,
    async setScope(next) {
      sessionScope = next?.mode === 'session';
      if (!next || next.key !== scopeKey) { draft = null; selectedId = null; mode = 'idle'; drawing = null; }
      scopeKey = next?.key;
      return store.setScope(next);
    },
    setView(next) {
      view = next || { map: false };
      if (!view.map && mode !== 'idle') setMode('idle');
      render();
    },
    mapClick({ lat, lng }) {
      if (!canWrite() || store.state.busy) return false;
      const position = [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
      if (mode === 'Point') { startDraft({ type: 'Point', coordinates: position }); return true; }
      if (drawing) {
        if (drawing.positions.length < 500) drawing.positions.push(position);
        render();
        return true;
      }
      return false;
    },
    mapDoubleClick() { return Boolean(drawing) && finishDrawing(); },
    cancelPlacement() { if (mode !== 'idle') { setMode('idle'); render(); } },
    hasTemporaryMarks: () => store.hasTemporaryMarks(),
    discardTemporaryMarks() { closeEditor(); store.discardTemporaryMarks(); },
    dispose() {
      store.dispose();
      layer.dispose();
      listeners.abort();
      panel.hidden = true;
    },
  };
}
