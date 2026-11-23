import { createMarksStore } from './viewer-marks-store.mjs';
import { createMarkMapLayer, geometryFrom, markPositions } from './viewer-mark-map-layer.mjs';
import { DEFAULT_STYLE, ICONS_BY_GROUP, ICON_CHOICES, MARK_COLORS, categoryBadge, categoryStyle, colorName, iconMarkup, keepIcon, markBadge, markIconName, safeColor } from './viewer-mark-style.mjs';
import { elevationForDisplay, elevationToMetres, elevationUnit, formatDecimal, formatDms, formatUtm, parseCoordinateInput } from './viewer-mark-coordinates.mjs';
import { geoJsonToMarks, marksToGeoJson } from './viewer-mark-geojson.mjs';
import { NO_CATEGORY, categoryOf, createMarkVisibility } from './viewer-mark-visibility.mjs';
import { createMarkDraftRecovery, reconcileMarkDraft } from './viewer-mark-draft-recovery.mjs';

const TYPE_LABEL = { Point: 'Pin', LineString: 'Line', Polygon: 'Area' };
// The server says which of these a person may choose; with one choice the field is hidden.
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
  let labels = readLabelsPreference(window), tab = 'list', search = '', armedDelete = null, categoryDraft = null;
  let sessionScope = false, scopeKey, writtenCoords = null;
  const visibility = createMarkVisibility({ storage: () => window.localStorage });
  // Unsaved work, kept for this person and model. Nothing is kept or cleared until the stored draft was looked at.
  const recovery = createMarkDraftRecovery({ storage: () => window.sessionStorage });
  let draftChecked = false, draftBaseline = null;
  // A saved mark moves only while this is on, and only on Save.
  let moving = false;
  let deleteForGood = null;

  const store = createMarksStore({ request, newId, onChange: () => render() });
  const layer = createMarkMapLayer({ L, getMap,
    // The open mark keeps what is being typed.
    onSelect: id => { if (draft && draft.id === id) nameInput.focus?.(); else select(id, { focus: false }); },
    describe: mark => [mark.name, categoryById(mark.categoryId)?.name, colorName(mark.color)].filter(Boolean).join(', '),
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
  const swatches = MARK_COLORS.map(({ name, color }) => h(document, 'button', { type: 'button', class: 'viewer-mark-swatch', 'data-color': color, 'aria-label': name, title: name, style: `background:${color}` }));
  const iconButtons = ICON_CHOICES.map(({ name, label }) => {
    const button = h(document, 'button', { type: 'button', class: 'viewer-mark-icon', 'data-icon': name, 'aria-label': label, title: label });
    button.innerHTML = iconMarkup(name, '#555555', 22);
    return button;
  });
  const iconField = h(document, 'fieldset', { class: 'viewer-mark-icons' }, h(document, 'legend', { text: 'Icon' }),
    ...ICONS_BY_GROUP.flatMap(({ group, icons }) => [h(document, 'span', { class: 'hint viewer-mark-icon-group', text: group }),
      ...iconButtons.filter(button => icons.some(icon => icon.name === button.dataset.icon))]));
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
  const moveButton = h(document, 'button', { type: 'button', text: 'Move', 'aria-pressed': 'false' });
  const closeButton = h(document, 'button', { type: 'button', text: 'Close' });
  const editor = h(document, 'form', { class: 'viewer-mark-form', hidden: true }, editorTitle,
    field('Label', nameInput), field('Category', categorySelect),
    h(document, 'fieldset', { class: 'viewer-mark-colors' }, h(document, 'legend', { text: 'Colour' }), ...swatches, colorInput),
    iconField, pointCoordsField, coordReadout, elevationField, visibilityField, accountField, field('Notes', noteInput),
    h(document, 'div', { class: 'viewer-mark-row' }, saveButton, moveButton, deleteButton, closeButton));

  // List
  const searchInput = h(document, 'input', { type: 'search', name: 'markSearch', autocomplete: 'off', 'aria-label': 'Search marks', placeholder: 'Search' });
  const labelsToggle = h(document, 'input', { type: 'checkbox' });
  const undoButton = h(document, 'button', { type: 'button', text: 'Undo' });
  // What is hidden is always said, and leads to where it can be shown again.
  const hiddenButton = h(document, 'button', { type: 'button', class: 'viewer-mark-hidden-count' });
  const listHead = h(document, 'div', { class: 'viewer-mark-row viewer-mark-list-head' }, hiddenButton, undoButton);
  const list = h(document, 'ul', { class: 'viewer-mark-list', 'aria-label': 'Marks' });

  // Categories
  const categoryList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-categories' });
  const categoryName = h(document, 'input', { name: 'categoryName', maxlength: '60', autocomplete: 'off', 'aria-label': 'Category name', placeholder: 'Name' });
  const categoryColor = h(document, 'input', { type: 'color', value: DEFAULT_STYLE.color, 'aria-label': 'Category colour' });
  const iconOptions = ICON_CHOICES.map(({ name, label }) => h(document, 'option', { value: name, text: label }));
  const categoryIcon = h(document, 'select', { 'aria-label': 'Category icon' },
    ...iconOptions);
  // An icon this build does not know stays selectable while its category is edited.
  function showCategoryIcon(icon) {
    const extra = ICON_CHOICES.some(choice => choice.name === icon) ? [] : [h(document, 'option', { value: icon, text: 'Current icon' })];
    categoryIcon.replaceChildren(...[...iconOptions, ...extra]);
    categoryIcon.value = icon;
  }
  const categorySave = h(document, 'button', { type: 'submit', text: 'Add' });
  const categoryCancel = h(document, 'button', { type: 'button', text: 'Cancel', hidden: true });
  const categoryForm = h(document, 'form', { class: 'viewer-mark-row viewer-mark-category-form' }, categoryName, categoryColor, categoryIcon, categorySave, categoryCancel);
  const showAllButton = h(document, 'button', { type: 'button', text: 'Show all' });
  const hideAllButton = h(document, 'button', { type: 'button', text: 'Hide all' });
  const categoryTools = h(document, 'div', { class: 'viewer-mark-row' }, showAllButton, hideAllButton,
    h(document, 'label', { class: 'viewer-mark-toggle' }, labelsToggle, h(document, 'span', { text: 'Labels' })));

  // Import / export
  const exportButton = h(document, 'button', { type: 'button', text: 'Export GeoJSON' });
  const importInput = h(document, 'input', { type: 'file', accept: '.geojson,.json,application/geo+json,application/json', hidden: true });
  const importButton = h(document, 'button', { type: 'button', text: 'Import GeoJSON' });
  const exchange = h(document, 'details', { class: 'viewer-mark-section' }, h(document, 'summary', { text: 'Import / export' }),
    h(document, 'div', { class: 'viewer-mark-row' }, exportButton, importButton, importInput));

  // Recently deleted
  const deletedList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-deleted', 'aria-label': 'Recently deleted marks' });

  // One panel: Categories, List, Deleted.
  const sections = {
    categories: h(document, 'div', { id: 'viewer-marks-categories', role: 'tabpanel' }, categoryTools, categoryList, categoryForm),
    list: h(document, 'div', { id: 'viewer-marks-list', role: 'tabpanel' }, searchInput, list),
    deleted: h(document, 'div', { id: 'viewer-marks-deleted', role: 'tabpanel' }, deletedList),
  };
  const tabButtons = Object.entries({ categories: 'Categories', list: 'List', deleted: 'Deleted' }).map(([name, text]) =>
    h(document, 'button', { type: 'button', role: 'tab', 'data-tab': name, 'aria-controls': `viewer-marks-${name}`, text }));
  const tabs = h(document, 'div', { class: 'viewer-mark-row viewer-mark-tabs', role: 'tablist', 'aria-label': 'Marks' }, ...tabButtons);

  root.replaceChildren(status, tools, drawBar, coordForm, editor, listHead, tabs, ...Object.values(sections), exchange);

  // ---- helpers --------------------------------------------------------------
  const canWrite = () => store.canWrite() && Boolean(view.map);
  const categoryById = id => store.state.categories.find(category => category.id === id) || null;
  const visibleMarks = () => store.state.marks.filter(visibility.shows);
  const searched = mark => !search || [mark.name, mark.note, categoryById(mark.categoryId)?.name].some(value => value?.toLowerCase().includes(search));
  const categoryIds = () => [...store.state.categories.map(category => category.id), NO_CATEGORY];
  // Placing or saving into a hidden category shows it again.
  // After a change to what is hidden: nothing hidden at all is Show all, and a
  // choice this browser could not keep is said.
  function shownChanged() {
    if (!categoryIds().some(visibility.isHidden)) visibility.showAll();
    if (!visibility.remembered()) store.state.message = 'Hidden categories could not be remembered in this browser.';
    render();
  }
  const reveal = (...marks) => visibility.show(marks.filter(Boolean).map(categoryOf));
  const defaultVisibility = () => store.state.capabilities.visibility[0];
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
    // New marks go into the category being looked at, when there is just one and it can be used.
    const category = store.state.categories.find(item => item.mine && visibility.isOnly(item.id, categoryIds())) || null;
    return { ...categoryStyle(category), categoryId: category?.id || null };
  }

  function startDraft(geometry) {
    const style = lastStyle();
    const category = categoryById(style.categoryId);
    draft = { id: null, newId: newId(), geometry, name: category?.name || TYPE_LABEL[geometry.type], note: '', categoryId: style.categoryId,
      color: style.color, icon: style.icon, elevationNavd88M: null, visibility: defaultVisibility() };
    selectedId = null;
    armedDelete = null;
    deleteForGood = null;
    moving = false;
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
    deleteForGood = null;
    moving = false;
    draft = { ...mark, geometry: structuredClone(mark.geometry) };
    writeEditor();
    draftBaseline = JSON.stringify(snapshot());
    if (focus) layer.focus(mark.geometry);
    render();
  }

  function closeEditor() {
    draft = null;
    selectedId = null;
    armedDelete = null;
    deleteForGood = null;
    moving = false;
    render();
  }

  // ---- unsaved work ---------------------------------------------------------
  function snapshot() {
    if (drawing) return drawing.positions.length ? { kind: 'drawing', type: drawing.type, positions: structuredClone(drawing.positions) } : null;
    if (!draft || (draft.id && !store.find(draft.id)?.editable)) return null;
    return { kind: 'editor', id: draft.id, newId: draft.newId || null, revision: draft.id ? draft.revision : null, geometry: structuredClone(draft.geometry),
      name: nameInput.value, note: noteInput.value, categoryId: categorySelect.value || null, color: safeColor(colorInput.value), icon: keepIcon(draft.icon),
      elevation: elevationInput.value, units: units() === 'metric' ? 'metric' : 'imperial', visibility: visibilitySelect.value,
      coordinates: draft.geometry.type === 'Point' && pointCoords.value !== writtenCoords ? pointCoords.value : null };
  }

  function keepDraft() {
    if (!sessionScope || !draftChecked || !store.canWrite()) return;
    const current = snapshot();
    if (current && JSON.stringify(current) !== (draft?.id ? draftBaseline : null)) recovery.save(scopeKey, current);
    else recovery.clear();
  }

  // Once per scope, when marks are loaded and the map is open.
  function restoreDraft() {
    if (!sessionScope || draftChecked || !store.state.ready || !view.map) return;
    const saved = recovery.read(scopeKey);
    if (!store.canWrite()) recovery.clear();
    draftChecked = true;
    if (!saved || !store.canWrite() || draft || mode !== 'idle') return;
    if (saved.kind === 'drawing') {
      setMode(saved.type);
      drawing.positions = saved.positions;
      message('Your unfinished drawing was restored.');
      return;
    }
    const { kind, units: savedUnits, elevation, coordinates, changedElsewhere, ...fields } = reconcileMarkDraft(saved, store.find, newId);
    const metres = elevationToMetres(elevation, savedUnits);
    const current = fields.id ? store.find(fields.id) : null;
    draft = { ...(current || {}), ...fields, color: safeColor(fields.color), elevationNavd88M: Number.isFinite(metres) ? metres : null };
    selectedId = draft.id;
    draftBaseline = null;
    writeEditor();
    if (savedUnits === (units() === 'metric' ? 'metric' : 'imperial') || Number.isNaN(metres)) elevationInput.value = elevation;
    if (coordinates !== null && draft.geometry.type === 'Point') pointCoords.value = coordinates;
    message(changedElsewhere ? 'That mark changed elsewhere. Your unsaved edit opened as a new mark.' : 'Your unsaved mark was restored.');
  }

  // A mark can use your own categories (staff: any staff category), or keep the one it has.
  const usableCategory = (category, keep) => category.id === keep || category.mine
    || (store.state.capabilities.staff && category.author === 'staff');

  function fillCategoryOptions(select, value, emptyLabel, usable = () => true) {
    const options = [h(document, 'option', { value: '', text: emptyLabel })];
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
    const options = store.state.capabilities.visibility;
    visibilitySelect.replaceChildren(...options.map(value => h(document, 'option', { value, text: VISIBILITY_LABEL[value] })));
    visibilitySelect.value = options.includes(draft.visibility) ? draft.visibility : options[0];
    const accounts = store.state.audiences.map(row => row.account);
    if (draft.shareAccount && !accounts.includes(draft.shareAccount)) accounts.unshift(draft.shareAccount);
    accountSelect.replaceChildren(h(document, 'option', { value: '', text: accounts.length ? 'Choose…' : 'No client with a direct grant has opened Marks here' }),
      ...accounts.map(account => h(document, 'option', { value: account, text: accountLabel(account) })));
    accountSelect.value = draft.shareAccount || '';
    writeCoords();
  }

  // The editable field carries the stored precision (8 decimals), unlike the
  // 6-decimal summaries, and remembers what it showed so unchanged text never
  // rewrites the geometry.
  const fixed8 = value => value.toFixed(8).replace(/\.?0+$/, '');
  const editableCoords = (lat, lon) => `${fixed8(lat)}, ${fixed8(lon)}`;
  function writeCoords() {
    if (draft?.geometry.type !== 'Point') return;
    const [lon, lat] = draft.geometry.coordinates;
    pointCoords.value = writtenCoords = editableCoords(lat, lon);
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
    editor.hidden = !draft || !state.ready;
    if (draft) {
      editorTitle.textContent = draft.id ? (editable ? 'Edit ' : '') + TYPE_LABEL[draft.geometry.type].toLowerCase() : 'New ' + TYPE_LABEL[draft.geometry.type].toLowerCase();
      for (const control of [nameInput, categorySelect, colorInput, noteInput, elevationInput, visibilitySelect, accountSelect, pointCoords, saveButton, ...swatches, ...iconButtons])
        control.disabled = !editable || state.busy;
      for (const swatch of swatches) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === safeColor(colorInput.value)));
      for (const button of iconButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.icon === markIconName(draft.icon)));
        button.innerHTML = iconMarkup(button.dataset.icon, button.dataset.icon === markIconName(draft.icon) ? colorInput.value : '#555555', 22);
      }
      iconField.hidden = draft.geometry.type !== 'Point';
      pointCoordsField.hidden = draft.geometry.type !== 'Point';
      coordReadout.textContent = readout(draft.geometry);
      elevationLabel.textContent = `NAVD88 Elevation (${elevationUnit(units())})`;
      visibilityField.hidden = !sessionScope || !state.capabilities.write || state.capabilities.visibility.length < 2 || Boolean(draft.id && !draft.mine);
      accountField.hidden = visibilityField.hidden || visibilitySelect.value !== 'client';
      moveButton.hidden = !draft.id || !editable;
      moveButton.disabled = state.busy;
      moveButton.setAttribute('aria-pressed', String(moving));
      deleteButton.hidden = !draft.id || !editable;
      deleteButton.textContent = deleteForGood === draft.id && draft.id ? 'Delete for good' : armedDelete === draft.id ? 'Tap again to delete' : 'Delete';
      deleteButton.disabled = state.busy;
      saveButton.hidden = !editable;
    }

    // List
    const hiddenCount = state.marks.length - visibleMarks().length;
    hiddenButton.hidden = !hiddenCount;
    hiddenButton.textContent = `${hiddenCount} hidden`;
    labelsToggle.checked = labels;
    const lastUndo = state.undo.at(-1);
    undoButton.hidden = !lastUndo;
    undoButton.disabled = state.busy;
    undoButton.title = lastUndo ? 'Undo ' + lastUndo.label : '';
    const rows = visibleMarks().filter(searched).map(mark => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = markBadge(mark);
      const category = categoryById(mark.categoryId);
      const text = h(document, 'span', { class: 'viewer-mark-list-name' }, h(document, 'span', { text: mark.name }),
        h(document, 'small', { text: [category?.name, !mark.mine ? (mark.author === 'staff' ? 'From project staff' : 'From a client')
          : mark.visibility === 'client' && mark.shareAccount ? accountLabel(mark.shareAccount)
            : mark.visibility !== defaultVisibility() && VISIBILITY_LABEL[mark.visibility]].filter(Boolean).join(' · ') }));
      const button = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item', 'aria-current': mark.id === selectedId ? 'true' : false }, icon, text);
      on(button, 'click', () => select(mark.id));
      return h(document, 'li', {}, button);
    });
    list.replaceChildren(...rows);
    listHead.hidden = !state.ready || !hiddenCount && !state.undo.length;
    searchInput.hidden = !state.marks.length;

    // Categories
    const showDeleted = sessionScope && state.capabilities.write;
    if (tab === 'deleted' && !showDeleted) tab = 'list';
    tabs.hidden = !state.ready;
    for (const button of tabButtons) {
      const current = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(current));
      button.classList.toggle('active', current);
      button.hidden = button.dataset.tab === 'deleted' && !showDeleted;
    }
    for (const [name, section] of Object.entries(sections)) section.hidden = !state.ready || name !== tab;
    categoryForm.hidden = !writable;
    showAllButton.disabled = !categoryIds().some(visibility.isHidden);
    hideAllButton.disabled = categoryIds().every(visibility.isHidden);
    const counts = new Map();
    for (const mark of state.marks) counts.set(categoryOf(mark), (counts.get(categoryOf(mark)) || 0) + 1);
    // One row per category: eye, icon, name (only this), count.
    const categoryRow = (id, name, category) => {
      const hidden = visibility.isHidden(id), alone = visibility.isOnly(id, categoryIds());
      const eye = h(document, 'button', { type: 'button', class: 'viewer-mark-eye', 'data-eye': id,
        'aria-label': `${hidden ? 'Show' : 'Hide'} ${name}`, text: hidden ? 'Show' : 'Hide' });
      on(eye, 'click', () => { visibility.toggle(id); shownChanged(); categoryList.querySelector(`[data-eye="${id}"]`)?.focus(); });
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      if (category) icon.innerHTML = categoryBadge(category);
      const only = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item', 'data-only': id, 'aria-pressed': String(alone),
        'aria-label': 'Show only ' + name }, h(document, 'span', { class: 'viewer-mark-list-name' }, h(document, 'span', { text: name }),
        h(document, 'small', { text: category && !category.mine ? (category.author === 'staff' ? 'From project staff' : 'From a client') : '' })));
      on(only, 'click', () => { if (alone) visibility.showAll(); else visibility.only(id); shownChanged(); categoryList.querySelector(`[data-only="${id}"]`)?.focus(); });
      return h(document, 'li', {}, eye, icon, only, h(document, 'span', { class: 'hint', text: String(counts.get(id) || 0) }));
    };
    const rowsByCategory = state.categories.map(category => {
      const row = categoryRow(category.id, category.name, category);
      if (writable && category.editable) {
        const rename = h(document, 'button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + category.name });
        const remove = h(document, 'button', { type: 'button', text: armedDelete === category.id ? 'Delete for good' : 'Delete', 'aria-label': 'Delete ' + category.name });
        on(rename, 'click', () => {
          categoryDraft = category;
          categoryName.value = category.name;
          categoryColor.value = safeColor(category.color);
          showCategoryIcon(category.icon);
          render();
        });
        on(remove, 'click', async () => {
          if (armedDelete !== category.id) { armedDelete = category.id; message("Deleting a category can't be undone. Its marks stay, without a category."); return; }
          armedDelete = null;
          const orphans = state.marks.filter(mark => mark.categoryId === category.id);
          if (await store.deleteCategory(category)) {
            visibility.show([category.id]);
            if (orphans.length) visibility.show([NO_CATEGORY]);
          }
          render();
        });
        row.append(rename, remove);
      }
      return row;
    });
    categoryList.replaceChildren(...rowsByCategory, categoryRow(NO_CATEGORY, 'No category', null));
    deletedList.replaceChildren(...(state.deleted.length ? state.deleted.map(mark => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = markBadge(mark);
      const restore = h(document, 'button', { type: 'button', text: 'Restore', 'aria-label': 'Restore ' + mark.name, disabled: state.busy });
      on(restore, 'click', async () => { const back = await store.restore(mark); if (back) { reveal(back); render(); } });
      return h(document, 'li', {}, icon, h(document, 'span', { class: 'viewer-mark-list-name' }, h(document, 'span', { text: mark.name }),
        h(document, 'small', { text: new Date(mark.deletedAt).toLocaleDateString() })), restore);
    }) : [h(document, 'li', { class: 'hint', text: `None in the last ${state.capabilities.recoveryDays} days.` })]));
    categorySave.textContent = categoryDraft ? 'Save' : 'Add';
    categoryCancel.hidden = !categoryDraft;
    exchange.hidden = !state.ready;
    importButton.hidden = !writable;
    exportButton.disabled = !visibleMarks().length;

    // The open mark follows its saved category like any other; the editor stays.
    const draftShown = !existing || visibility.shows(existing);
    layer.render({ visible: Boolean(view.map && state.ready && !state.blocked), marks: visibleMarks(), draft: editable && draftShown ? { ...draft, movable: !draft.id || moving, ...(draft.id ? {} : { id: '__draft__' }) } : null,
      selectedId, labels, preview, drawing });
    keepDraft();
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
    if (pointCoords.value === writtenCoords) return true;
    const parsed = parseCoordinateInput(pointCoords.value, { georef: georef() });
    if (!parsed.ok) { message(parsed.error || 'Enter coordinates.'); return false; }
    draft.geometry = { type: 'Point', coordinates: [Math.round(parsed.longitude * 1e8) / 1e8, Math.round(parsed.latitude * 1e8) / 1e8] };
    writeCoords();
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
      Object.assign(draft, categoryStyle(category));
      colorInput.value = draft.color;
      if (!nameInput.value.trim() || Object.values(TYPE_LABEL).includes(nameInput.value.trim())) nameInput.value = category.name;
    }
    render();
  });
  for (const swatch of swatches) on(swatch, 'click', () => { if (draft) { draft.color = swatch.dataset.color; colorInput.value = swatch.dataset.color; render(); } });
  on(colorInput, 'input', () => { if (draft) { draft.color = safeColor(colorInput.value); render(); } });
  for (const button of iconButtons) on(button, 'click', () => { if (draft) { draft.icon = button.dataset.icon; render(); } });
  on(nameInput, 'input', () => { if (draft) draft.name = nameInput.value; });
  on(closeButton, 'click', closeEditor);
  on(moveButton, 'click', () => { if (draft?.id && store.editable(store.find(draft.id))) { moving = !moving; render(); } });
  // Fields that do not redraw anything while typing.
  for (const type of ['input', 'change']) on(editor, type, keepDraft);
  on(visibilitySelect, 'change', () => render());
  const readDeleted = () => (tab === 'deleted' ? store.loadDeleted() : null);
  for (const button of tabButtons) on(button, 'click', () => { tab = button.dataset.tab; render(); return readDeleted(); });
  on(tabs, 'keydown', event => {
    const shown = tabButtons.filter(button => !button.hidden), index = shown.indexOf(event.target);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step || index < 0) return;
    event.preventDefault();
    const next = shown[(index + step + shown.length) % shown.length];
    next.focus();
    next.click();
  });
  on(hiddenButton, 'click', () => { tab = 'categories'; render(); });
  on(showAllButton, 'click', () => { visibility.showAll(); shownChanged(); });
  on(hideAllButton, 'click', () => { visibility.hideAll(); shownChanged(); });
  on(searchInput, 'input', () => { search = searchInput.value.trim().toLowerCase(); render(); });
  on(deleteButton, 'click', async () => {
    const current = draft?.id ? store.find(draft.id) : null;
    if (!current) return;
    if (deleteForGood !== current.id && armedDelete !== current.id) { armedDelete = current.id; render(); return; }
    armedDelete = null;
    const permanent = deleteForGood === current.id;
    deleteForGood = null;
    const removed = await store.remove(current, { permanent });
    // Recently deleted is full: this one can still go, but only for good and only if asked again.
    if (!removed && store.state.failure === 'mark_deleted_full' && draft?.id === current.id) deleteForGood = current.id;
    render();
    if (removed) { closeEditor(); await readDeleted(); }
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
    const changes = { ...values, icon: keepIcon(draft.icon), geometry: draft.geometry };
    // A new mark keeps one id, so saving again after a lost answer updates it instead of adding a copy.
    const current = store.find(draft.id || draft.newId);
    if (draft.id && !current) { message('That mark is no longer there.'); return; }
    const saved = current ? await store.update(current, changes) : await store.create({ ...changes, id: draft.newId });
    if (saved) { reveal(saved); closeEditor(); }
  });

  on(labelsToggle, 'change', () => { labels = labelsToggle.checked; writeLabelsPreference(window, labels); render(); });
  on(undoButton, 'click', async () => { closeEditor(); if (await store.undo()) await readDeleted(); });

  on(categoryForm, 'submit', async event => {
    event.preventDefault();
    const name = categoryName.value.trim();
    if (!name) return;
    const saved = await store.saveCategory({ ...(categoryDraft ? { id: categoryDraft.id, revision: categoryDraft.revision } : {}),
      name, color: safeColor(categoryColor.value), icon: keepIcon(categoryIcon.value) });
    if (saved) {
      categoryDraft = null;
      categoryName.value = '';
      showCategoryIcon(DEFAULT_STYLE.icon);
      render();
    }
  });
  on(categoryCancel, 'click', () => { categoryDraft = null; categoryName.value = ''; showCategoryIcon(DEFAULT_STYLE.icon); render(); });

  on(exportButton, 'click', () => {
    // What is shown is what is exported, and it says so when some is not.
    const shown = visibleMarks();
    const data = marksToGeoJson(shown, store.state.categories);
    if (shown.length < store.state.marks.length) message(`Exported ${shown.length} of ${store.state.marks.length} marks; the rest are hidden.`);
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
    // The file belongs to whoever chose it: if the scope changes while it is read, it is dropped.
    const held = store.hold();
    try {
      const text = await file.text();
      if (!held.live()) return;
      const parsed = geoJsonToMarks(JSON.parse(text), { categories: store.state.categories.filter(category => category.mine), newId,
        visibility: defaultVisibility(), defaultColor: DEFAULT_STYLE.color });
      if (!parsed.marks.length) { message('No points, lines or areas were found in that file.'); return; }
      const count = await store.importMarks(parsed);
      if (count && held.live()) reveal(...parsed.marks);
      if (count && held.live()) message(`Imported ${count} mark${count === 1 ? '' : 's'}${parsed.skipped ? `; skipped ${parsed.skipped} unsupported` : ''}.`);
    } catch (error) {
      if (!held.live()) return;
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
    // keepDraft is false when access was refused rather than expired: unsaved work goes too.
    async setScope(next, { keepDraft: mayReturn = true } = {}) {
      sessionScope = next?.mode === 'session';
      if (!mayReturn) recovery.clear();
      // Anyone else's unsaved work goes as soon as they are gone, map open or not.
      else if (sessionScope) recovery.read(next.key);
      if (!next || next.key !== scopeKey) {
        draftChecked = false;
        // Nothing one person typed or picked stays in the panel for the next one.
        draft = null; selectedId = null; mode = 'idle'; drawing = null;
        preview = null; search = ''; tab = 'list'; armedDelete = null; categoryDraft = null; moving = false; deleteForGood = null;
        showCategoryIcon(DEFAULT_STYLE.icon);
        categoryColor.value = DEFAULT_STYLE.color;
        visibility.setScope(sessionScope ? next.key : null);
        for (const input of [searchInput, coordInput, nameInput, noteInput, elevationInput, pointCoords, categoryName]) input.value = '';
        for (const choice of [categorySelect, accountSelect]) choice.replaceChildren();
        for (const shown of [coordDetected, coordReadout]) shown.textContent = '';
      }
      scopeKey = next?.key;
      const result = await store.setScope(next);
      restoreDraft();
      return result;
    },
    setView(next) {
      view = next || { map: false };
      if (!view.map && mode !== 'idle') setMode('idle');
      restoreDraft();
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
