import { createMarksStore } from './viewer-marks-store.mjs';
import { createMarkMapLayer, geometryFrom, markPositions } from './viewer-mark-map-layer.mjs';
import { h } from './viewer-mark-dom.mjs';
import { createMarkPicker } from './viewer-mark-picker.mjs';
import { DEFAULT_STYLE, ICON_CHOICES, categoryBadge, categoryStyle, colorName, keepIcon, markBadge, safeColor } from './viewer-mark-style.mjs';
import { elevationForDisplay, elevationToMetres, elevationUnit, formatDecimal, formatDms, formatUtm, parseCoordinateInput } from './viewer-mark-coordinates.mjs';
import { geoJsonToMarks, marksToGeoJson } from './viewer-mark-geojson.mjs';
import { NO_CATEGORY, categoryOf, createMarkVisibility } from './viewer-mark-visibility.mjs';
import { createMarkDraftRecovery, reconcileMarkDraft, sameMark, SENT_LIMIT } from './viewer-mark-draft-recovery.mjs';

const TYPE_LABEL = { Point: 'Pin', LineString: 'Line', Polygon: 'Area' };
// The server says which of these a person may choose; with one choice the field is hidden.
const VISIBILITY_LABEL = { staff: 'Me and project staff', private: 'Only me', internal: 'Staff only', client: 'A client account' };
const ACCOUNT_TYPE = { model_association: 'Client association', direct_client_grant: 'Client grant' };
const accountLabel = key => { const [type, id = ''] = String(key).split(/:(.*)/s); return `${ACCOUNT_TYPE[type] || 'Client'} …${id.slice(-6)}`; };
const LABELS_KEY = 'ltds.viewer.marks.labels', GROUP_KEY = 'ltds.viewer.marks.group';
const LABEL_MODES = { on: 'On', selected: 'Selected', off: 'Off' };

function readPreference(window, key, allowed, fallback) {
  try { const value = window.localStorage?.getItem(key); return allowed.includes(value) ? value : fallback; } catch { return fallback; }
}
function writePreference(window, key, value) {
  try { window.localStorage?.setItem(key, value); } catch { /* per-viewer convenience only */ }
}

// overlay: where the pop-ups over the map go (the card, the strip while placing).
export function mountViewerMarks({ panel, overlay = panel, L, getMap, request = globalThis.fetch, newId = () => crypto.randomUUID(),
  onActivate = () => {}, georef = () => null, units = () => 'imperial', fileName = () => 'marks', obstacles = () => [] }) {
  const document = panel.ownerDocument, window = document.defaultView;
  const listeners = new AbortController();
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  let view = { map: false }, mode = 'idle', drawing = null, draft = null, selectedId = null, preview = null;
  let labels = readPreference(window, LABELS_KEY, Object.keys(LABEL_MODES), 'selected'), grouping = readPreference(window, GROUP_KEY, ['on', 'off'], 'on') === 'on';
  // The Marks pop-up, and the list for several marks on one spot.
  let boxOpen = false, picked = null;
  let tab = 'list', search = '', armedDelete = null, categoryDraft = null;
  let sessionScope = false, scopeKey, writtenCoords = null;
  const visibility = createMarkVisibility({ storage: () => window.localStorage });
  // Unsaved work, kept for this person and model. Nothing is kept or cleared until the stored draft was looked at.
  const recovery = createMarkDraftRecovery({ storage: () => window.sessionStorage });
  let draftChecked = false, draftBaseline = null;
  // A saved mark moves only while this is on, and only on Save.
  let moving = false;
  let deleteForGood = null;
  // Placing: the category for the next mark, whether several go in a row, and
  // whether the spot is the fixed cross (touch, keyboard) or the pointer.
  let placeChoice = null, several = false, crosshair = false;
  // One go at placing, from + to Cancel: a late answer from an earlier one changes nothing in the next.
  let placement = null;
  // The last change that can be undone, shown for a while after it was made.
  let barEntry = null, barTimer = null, barHeld = false, barSeen = null, barError = '';

  const store = createMarksStore({ request, newId, onChange: () => render(),
    later: (work, ms) => { const id = window.setTimeout(work, ms); return () => window.clearTimeout(id); } });
  const layer = createMarkMapLayer({ L, getMap,
    onSelect: (id, { pointer = false } = {}) => {
      if (draft && draft.id === id) { nameInput.focus?.(); return; }
      // Two pins under one finger: ask rather than guess. Groups already do.
      // The open mark is not asked about: it is already open.
      const near = pointer && !grouping && mode === 'idle' && selectedId !== id
        ? layer.near(id, coarse() ? 24 : 13).filter(other => other !== selectedId && other !== draft?.id) : [];
      if (near.length > 1) openPick(near); else select(id, { focus: false });
    },
    onGroup: ids => openPick(ids),
    onDelete: id => { if (mode === 'idle' && !unsaved()) return removeMark(id); },
    obstacles, schedule: work => (window.requestAnimationFrame ? window.requestAnimationFrame(work) : work()),
    onViewChange: () => placeCard(),
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

  // Placing, over the map
  const addButton = h(document, 'button', { type: 'button', class: 'viewer-mark-add', 'aria-label': 'Add mark', title: 'Add mark (M)', text: '+' });
  const stripTitle = h(document, 'strong', { role: 'status', 'aria-live': 'polite' });
  const chips = h(document, 'div', { class: 'viewer-mark-chips', role: 'group', 'aria-label': 'Category' });
  const severalButton = h(document, 'button', { type: 'button', text: 'Place several', 'aria-pressed': 'false' });
  const placeHere = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Place here' });
  const placeCancel = h(document, 'button', { type: 'button', text: 'Cancel' });
  const barText = h(document, 'span', { role: 'status', 'aria-live': 'polite' });
  const barUndo = h(document, 'button', { type: 'button', text: 'Undo' });
  const barClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Dismiss', text: '\u00d7' });
  const undoBar = h(document, 'div', { class: 'viewer-mark-undo', role: 'group', 'aria-label': 'Last change', hidden: true }, barText, barUndo, barClose);
  const moveSave = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Save' });
  const moveCancel = h(document, 'button', { type: 'button', text: 'Cancel' });
  const moveRow = h(document, 'div', { class: 'viewer-mark-row viewer-mark-move' }, moveSave, moveCancel);
  const placeRow = h(document, 'div', { class: 'viewer-mark-row' }, placeHere, severalButton, placeCancel);
  const strip = h(document, 'section', { class: 'viewer-mark-strip', role: 'group', 'aria-label': 'Add mark', hidden: true }, stripTitle, chips, placeRow, drawBar, moveRow);
  const cross = h(document, 'div', { class: 'viewer-mark-cross', 'aria-hidden': 'true', hidden: true });

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
  const picker = createMarkPicker({ document, on, getDraft: () => draft, onChange: () => render(),
    categoryStyleOf: () => categoryStyle(chosenStarter() || categoryById(categorySelect.value)) });
  const { colorInput } = picker;
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
  const cancelButton = h(document, 'button', { type: 'button', text: 'Cancel' });
  const more = h(document, 'details', { class: 'viewer-mark-more' }, h(document, 'summary', { text: 'More' }), pointCoordsField, coordReadout, elevationField, visibilityField, accountField);
  const editor = h(document, 'form', { class: 'viewer-mark-form', hidden: true }, editorTitle,
    field('Label', nameInput), field('Category', categorySelect), picker.element, field('Notes', noteInput), more,
    h(document, 'div', { class: 'viewer-mark-row' }, saveButton, cancelButton));

  // The card: what a mark is, then Edit, Move or Delete.
  const cardBadge = h(document, 'span', { class: 'viewer-mark-list-icon' });
  const cardName = h(document, 'h4'), cardKind = h(document, 'small'), cardNote = h(document, 'p', { class: 'viewer-mark-card-note' });
  const cardFacts = h(document, 'dl', { class: 'viewer-mark-facts' });
  const editButton = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Edit' });
  const moveButton = h(document, 'button', { type: 'button', text: 'Move' });
  const closeButton = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close', text: '\u00d7' });
  const cardActions = h(document, 'div', { class: 'viewer-mark-row' }, editButton, moveButton, deleteButton);
  const cardView = h(document, 'div', { class: 'viewer-mark-view' }, h(document, 'div', { class: 'viewer-mark-card-head' }, cardBadge,
    h(document, 'div', { class: 'viewer-mark-list-name' }, cardName, cardKind), closeButton), cardActions, cardNote, cardFacts);
  const cardMessage = h(document, 'p', { class: 'hint viewer-mark-card-message', role: 'status', 'aria-live': 'polite' });
  const card = h(document, 'section', { class: 'viewer-mark-card', role: 'dialog', 'aria-label': 'Mark', hidden: true }, cardMessage, cardView, editor);

  // List
  const searchInput = h(document, 'input', { type: 'search', name: 'markSearch', autocomplete: 'off', 'aria-label': 'Search marks', placeholder: 'Search' });
  const labelsSelect = h(document, 'select', { name: 'labels', 'aria-label': 'Labels' }, ...Object.entries(LABEL_MODES).map(([value, text]) => h(document, 'option', { value, text })));
  const groupToggle = h(document, 'input', { type: 'checkbox', name: 'group' });
  const undoButton = h(document, 'button', { type: 'button', text: 'Undo' });
  // What is hidden is always said, and leads to where it can be shown again.
  const hiddenButton = h(document, 'button', { type: 'button', class: 'viewer-mark-hidden-count' });
  const listHead = h(document, 'div', { class: 'viewer-mark-row viewer-mark-list-head' }, undoButton);
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
  // Suggested categories: only for someone without their own, and only made when used.
  const starterList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-starters', 'aria-label': 'Suggested categories' });
  const starterAll = h(document, 'button', { type: 'button', text: 'Add all' });
  const starterHide = h(document, 'button', { type: 'button' });
  const starterSection = h(document, 'div', { class: 'viewer-mark-suggested' },
    h(document, 'div', { class: 'viewer-mark-row' }, h(document, 'span', { class: 'hint', text: 'Suggested' }), starterAll, starterHide), starterList);
  const categoryForm = h(document, 'form', { class: 'viewer-mark-row viewer-mark-category-form' }, categoryName, categoryColor, categoryIcon, categorySave, categoryCancel);
  const showAllButton = h(document, 'button', { type: 'button', text: 'Show all' });
  const hideAllButton = h(document, 'button', { type: 'button', text: 'Hide all' });
  const categoryTools = h(document, 'div', { class: 'viewer-mark-row' }, showAllButton, hideAllButton,
    h(document, 'label', { class: 'viewer-mark-toggle' }, h(document, 'span', { text: 'Labels' }), labelsSelect),
    h(document, 'label', { class: 'viewer-mark-toggle' }, groupToggle, h(document, 'span', { text: 'Group' })));

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
    categories: h(document, 'div', { id: 'viewer-marks-categories', role: 'tabpanel' }, categoryTools, categoryList, starterSection, categoryForm),
    list: h(document, 'div', { id: 'viewer-marks-list', role: 'tabpanel' }, searchInput, list),
    deleted: h(document, 'div', { id: 'viewer-marks-deleted', role: 'tabpanel' }, deletedList),
  };
  const tabButtons = Object.entries({ categories: 'Categories', list: 'List', deleted: 'Deleted' }).map(([name, text]) =>
    h(document, 'button', { type: 'button', role: 'tab', 'data-tab': name, 'aria-controls': `viewer-marks-${name}`, text }));
  const tabs = h(document, 'div', { class: 'viewer-mark-row viewer-mark-tabs', role: 'tablist', 'aria-label': 'Marks' }, ...tabButtons);

  const openBox = h(document, 'button', { type: 'button', class: 'viewer-mark-open', text: 'Marks', 'aria-expanded': 'false' });
  root.replaceChildren(status, tools, openBox);

  // One Marks pop-up, from the map or the sidebar.
  const boxButton = h(document, 'button', { type: 'button', class: 'viewer-mark-layers', 'aria-label': 'Marks', title: 'Marks (L)', 'aria-expanded': 'false', text: '\u2630' });
  const boxClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close marks', text: '\u00d7' });
  const boxMessage = h(document, 'p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const box = h(document, 'section', { class: 'viewer-mark-box', role: 'dialog', 'aria-label': 'Marks', hidden: true },
    h(document, 'div', { class: 'viewer-mark-card-head' }, h(document, 'h4', { text: 'Marks' }), boxClose), boxMessage, listHead, tabs, ...Object.values(sections), coordForm, exchange);

  // Several marks on one spot
  const pickTitle = h(document, 'h4'), pickList = h(document, 'ul', { class: 'viewer-mark-list', 'aria-label': 'Marks here' });
  const pickZoom = h(document, 'button', { type: 'button', text: 'Zoom in' });
  const pickClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close list', text: '\u00d7' });
  const pick = h(document, 'section', { class: 'viewer-mark-card viewer-mark-pick', role: 'dialog', 'aria-label': 'Marks here', hidden: true },
    h(document, 'div', { class: 'viewer-mark-card-head' }, pickTitle, pickClose), pickList, pickZoom);

  overlay.append(addButton, boxButton, hiddenButton, cross, strip, card, pick, box, undoBar);

  // ---- helpers --------------------------------------------------------------
  const canWrite = () => store.canWrite() && Boolean(view.map);
  const categoryById = id => store.state.categories.find(category => category.id === id) || null;
  const visibleMarks = () => store.state.marks.filter(visibility.shows);
  const searched = mark => !search || [mark.name, mark.note, categoryById(mark.categoryId)?.name].some(value => value?.toLowerCase().includes(search));
  // Picked in the editor but not made yet: 'starter:gate'.
  const chosenStarter = () => store.starters().find(starter => 'starter:' + starter.key === categorySelect.value) || null;
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
    drawing = next === 'LineString' || next === 'Polygon' ? { type: next, positions: [], color: styleOf(placeChoice).color } : null;
    placement = next === 'idle' ? null : {};
    if (next === 'idle') { crosshair = false; several = false; }
    const map = getMap();
    if (map?.doubleClickZoom) map.doubleClickZoom[drawing ? 'disable' : 'enable']();
    syncMapKeys();
  }

  // While a spot is picked or a mark moved with the keys, the map does not also pan with them.
  function syncMapKeys() {
    const keys = getMap()?.keyboard;
    if (keys) keys[(mode === 'Point' && crosshair) || moving ? 'disable' : 'enable']();
  }

  // The category the next mark starts in: the one picked while placing, else the
  // one being looked at when there is just one and it can be used.
  const onlyShown = () => store.state.categories.find(item => item.mine && visibility.isOnly(item.id, categoryIds()))?.id || null;
  const starterOf = choice => store.starters().find(starter => 'starter:' + starter.key === choice) || null;
  const styleOf = choice => categoryStyle(starterOf(choice) || categoryById(choice));
  // "Gate", then "Gate 2", "Gate 3".
  function autoName(base) {
    const taken = new Set(store.state.marks.map(mark => mark.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`.slice(0, 100);
  }
  const nameFor = (choice, type) => autoName(((starterOf(choice) || categoryById(choice))?.name || TYPE_LABEL[type]).slice(0, 90));

  function startPlacing(type, { cross: useCross = false } = {}) {
    if (!canWrite() || store.state.busy || unsaved()) return;
    closeCard();
    if (narrow()) boxOpen = false;
    placeChoice = onlyShown();
    setMode(type);
    crosshair = type === 'Point' && useCross;
    syncMapKeys();
    render();
  }

  function placeAt(position) {
    if (placement?.busy) return;
    if (several) return placeQuick(position);
    startDraft({ type: 'Point', coordinates: position });
  }

  // Place several: each click is saved as it is and can be undone.
  async function placeQuick(position) {
    // What was chosen at the click, whatever is picked while it is on its way.
    const held = store.hold(), mine = placement, clicked = placeChoice, starter = starterOf(clicked);
    let choice = clicked;
    mine.busy = true;
    try {
      if (starter) {
        const made = await store.addStarter(starter);
        if (!made || !held.live()) return;
        choice = made.id;
        // Cancelled, or begun again: the category is made, the mark is not.
        if (placement !== mine) return;
        if (placeChoice === clicked) placeChoice = choice;
      }
      const category = categoryById(choice);
      // One id until it is placed: a click that was never answered and the next one are one pin.
      mine.id ||= newId();
      const saved = await store.create({ id: mine.id, geometry: { type: 'Point', coordinates: position }, name: nameFor(choice, 'Point'), note: '',
        categoryId: category?.id || null, ...categoryStyle(category), elevationNavd88M: null, visibility: defaultVisibility() });
      if (!held.live()) return;
      // Placed, or changed by someone since it was: the next click is another pin.
      if (saved || store.state.failure === 'mark_id_conflict') mine.id = null;
      if (!saved) return;
      reveal(saved);
      render();
    } finally { mine.busy = false; }
  }

  function startDraft(geometry) {
    const choice = mode === 'idle' ? onlyShown() : placeChoice, starter = starterOf(choice);
    const name = nameFor(choice, geometry.type);
    draft = { id: null, newId: newId(), geometry, name, autoName: name, note: '', categoryId: starter ? null : categoryById(choice)?.id || null,
      ...styleOf(choice), elevationNavd88M: null, visibility: defaultVisibility() };
    selectedId = null;
    armedDelete = null;
    deleteForGood = null;
    moving = false;
    setMode('idle');
    writeEditor();
    if (starter) categorySelect.value = choice;
    render();
    nameInput.focus?.();
    nameInput.select?.();
  }

  // An edit that would be lost by opening something else.
  const unsaved = () => {
    const current = draft && snapshot();
    if (!current || (draft.id && JSON.stringify(current) === draftBaseline)) return false;
    message('Save or cancel the open mark first.');
    return true;
  };

  // Opens the card of a saved mark.
  function select(id, { focus = true } = {}) {
    const mark = store.find(id);
    if (!mark || mode !== 'idle' || unsaved()) return;
    draft = null;
    selectedId = id;
    picked = null;
    if (narrow()) boxOpen = false;
    armedDelete = null;
    deleteForGood = null;
    moving = false;
    syncMapKeys();
    picker.close({ focus: false });
    if (focus) layer.focus(mark.geometry);
    render();
    if (narrow()) layer.keepAbove(mark.geometry, 0.46);
    (editButton.hidden ? closeButton : editButton).focus?.({ preventScroll: true });
  }

  // ---- several marks on one spot, and the Marks pop-up ------------------------
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);
  function openPick(ids) {
    if (mode !== 'idle' || unsaved()) return;
    closeCard();
    picked = [...ids];
    if (narrow()) boxOpen = false;
    render();
    (pickList.querySelector('button') || pickClose).focus?.({ preventScroll: true });
  }
  function closePick({ focusPin = false } = {}) {
    const [id] = picked || [];
    picked = null;
    render();
    if (focusPin && id) layer.focusPin(id);
  }
  function showBox(next, { to = tab } = {}) {
    if (next && narrow()) { if (unsaved()) return; closeCard(); picked = null; if (mode !== 'idle') setMode('idle'); }
    boxOpen = next;
    tab = to;
    render();
    (next ? tabButtons.find(button => button.dataset.tab === tab) : view.map ? boxButton : openBox)?.focus?.({ preventScroll: true });
    return next && readDeleted();
  }

  function beginEdit({ move = false } = {}) {
    const mark = store.find(selectedId);
    if (!mark || !store.editable(mark)) return;
    draft = { ...mark, geometry: structuredClone(mark.geometry) };
    moving = move;
    armedDelete = null;
    writeEditor();
    draftBaseline = JSON.stringify(snapshot());
    if (move) onActivate();
    syncMapKeys();
    render();
    if (!move) nameInput.focus?.();
  }

  // Back to the card, or away for a mark that was never saved.
  function cancelDraft() {
    const was = draft;
    draft = null;
    moving = false;
    syncMapKeys();
    picker.close({ focus: false });
    if (!was?.id) return closeCard();
    render();
    editButton.focus?.({ preventScroll: true });
  }

  function closeCard({ focusPin = false } = {}) {
    const id = selectedId;
    draft = null;
    picked = null;
    selectedId = null;
    armedDelete = null;
    deleteForGood = null;
    moving = false;
    syncMapKeys();
    picker.close({ focus: false });
    render();
    if (focusPin && id) layer.focusPin(id);
  }

  // ---- where the card goes ----------------------------------------------------
  const NARROW = 640;
  const narrow = () => (getMap()?.getSize?.().x ?? Infinity) <= NARROW;
  function placeBeside(element, geometry, full) {
    const size = getMap()?.getSize?.(), sheet = narrow();
    element.classList.toggle('sheet', sheet);
    element.classList.toggle('full', sheet && full);
    const point = !sheet && size && geometry ? layer.anchor(geometry) : null;
    if (!point) { element.style.left = element.style.top = ''; return; }
    const width = element.offsetWidth || 300, height = element.offsetHeight || 260, gap = 28, edge = 8;
    const right = point[0] + gap + width + edge <= size.x;
    element.style.left = `${Math.max(edge, right ? point[0] + gap : point[0] - gap - width)}px`;
    element.style.top = `${Math.max(edge, Math.min(point[1] - 60, size.y - height - edge))}px`;
  }
  // A screen that becomes narrow has room for one: what is being worked on the map stays.
  function oneSheet() {
    if (!boxOpen || !narrow() || (card.hidden && pick.hidden && strip.hidden)) return;
    const inside = box.contains(document.activeElement);
    boxOpen = false;
    render();
    if (!inside) return;
    const next = !card.hidden ? draft ? nameInput : editButton.hidden ? closeButton : editButton
      : !pick.hidden ? pickList.querySelector('button') || pickClose : strip.querySelector('button');
    next?.focus?.({ preventScroll: true });
  }
  function placeCard() {
    oneSheet();
    if (!card.hidden) placeBeside(card, draft?.geometry || store.find(selectedId)?.geometry, Boolean(draft));
    if (!pick.hidden) placeBeside(pick, store.find(picked[0])?.geometry, false);
    box.classList.toggle('sheet', narrow());
    box.classList.toggle('full', narrow());
  }

  // ---- unsaved work ---------------------------------------------------------
  function snapshot() {
    if (drawing) return drawing.positions.length ? { kind: 'drawing', type: drawing.type, positions: structuredClone(drawing.positions) } : null;
    if (!draft || (draft.id && !store.find(draft.id)?.editable)) return null;
    return { kind: 'editor', id: draft.id, newId: draft.newId || null, revision: draft.id ? draft.revision : null, geometry: structuredClone(draft.geometry),
      name: nameInput.value, note: noteInput.value, categoryId: chosenStarter() ? null : categorySelect.value || null, starter: chosenStarter()?.key || null, color: safeColor(colorInput.value), icon: keepIcon(draft.icon),
      elevation: elevationInput.value, units: units() === 'metric' ? 'metric' : 'imperial', visibility: visibilitySelect.value,
      coordinates: draft.geometry.type === 'Point' && pointCoords.value !== writtenCoords ? pointCoords.value : null,
      ...(draft.sent && { sent: draft.sent }) };
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
    const { kind, units: savedUnits, elevation, coordinates, changedElsewhere, starter, ...fields } = reconcileMarkDraft(saved, store.find, newId);
    const metres = elevationToMetres(elevation, savedUnits);
    const current = fields.id ? store.find(fields.id) : null;
    draft = { ...(current || {}), ...fields, color: safeColor(fields.color), elevationNavd88M: Number.isFinite(metres) ? metres : null };
    selectedId = draft.id;
    moving = false;
    draftBaseline = null;
    writeEditor();
    if (savedUnits === (units() === 'metric' ? 'metric' : 'imperial') || Number.isNaN(metres)) elevationInput.value = elevation;
    if (starter && store.starters().some(item => item.key === starter)) categorySelect.value = 'starter:' + starter;
    if (coordinates !== null && draft.geometry.type === 'Point') pointCoords.value = coordinates;
    store.expect(draft.id || draft.newId, draft.sent);
    // It was saved, only the answer was lost: nothing is unsaved.
    if (current && draft.sent && coordinates === null && !chosenStarter() && sameMark(current, { ...readEditor(), icon: draft.icon, geometry: draft.geometry })) {
      closeCard();
      return;
    }
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
    if (store.canWrite() && !visibility.startersHidden()) {
      categorySelect.append(...store.starters().map(starter => h(document, 'option', { value: 'starter:' + starter.key, text: starter.name })));
    }
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
    return { name: nameInput.value.trim(), categoryId: chosenStarter() ? null : categorySelect.value || null, color: safeColor(colorInput.value),
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
  function renderCard(mark) {
    if (!mark) {
      for (const shown of [cardName, cardKind, cardNote]) shown.textContent = '';
      cardBadge.innerHTML = '';
      cardFacts.replaceChildren();
      return;
    }
    const { state } = store, editable = store.editable(mark);
    card.setAttribute('aria-label', mark.name);
    cardBadge.innerHTML = markBadge(mark);
    cardName.textContent = mark.name;
    cardKind.textContent = [categoryById(mark.categoryId)?.name, mark.mine ? null : mark.author === 'staff' ? 'From project staff' : 'From a client'].filter(Boolean).join(' · ');
    cardNote.textContent = mark.note || '';
    cardNote.hidden = !mark.note;
    const facts = [
      sessionScope && mark.mine && state.capabilities.visibility.length > 1 ? ['Visible to', VISIBILITY_LABEL[mark.visibility]] : null,
      [mark.geometry.type === 'Point' ? 'Coordinates' : 'Points', mark.geometry.type === 'Point' ? readout(mark.geometry) : String(markPositions(mark.geometry).length)],
      Number.isFinite(mark.elevationNavd88M) ? ['NAVD88 Elevation', `${elevationForDisplay(mark.elevationNavd88M, units())} ${elevationUnit(units())}`] : null,
    ].filter(Boolean);
    cardFacts.replaceChildren(...facts.flatMap(([term, value]) => [h(document, 'dt', { text: term }), h(document, 'dd', { text: value })]));
    cardActions.hidden = !editable;
    for (const button of [editButton, moveButton, deleteButton]) { button.hidden = !editable; button.disabled = state.busy; }
    deleteButton.textContent = deleteForGood === mark.id ? 'Delete for good' : 'Delete';
  }

  // Categories to place into, the last three used first.
  function placeChoices() {
    const own = store.state.categories.filter(category => category.mine);
    const recent = [];
    for (const mark of [...store.state.marks].filter(item => item.mine && item.categoryId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
      const category = own.find(item => item.id === mark.categoryId);
      if (category && !recent.includes(category)) recent.push(category);
      if (recent.length === 3) break;
    }
    const starters = visibility.startersHidden() ? [] : store.starters();
    return [...recent, ...own.filter(category => !recent.includes(category)), ...starters.map(starter => ({ ...starter, id: 'starter:' + starter.key })),
      { id: null, name: 'No category', ...DEFAULT_STYLE }];
  }

  // Every add, edit, move and delete offers Undo for a while; pointing at the bar or
  // reaching it with the keyboard keeps it there.
  const BAR_MS = 8000;
  function clearTimer() { if (barTimer !== null) window.clearTimeout(barTimer); barTimer = null; }
  function startTimer() {
    clearTimer();
    if (barEntry && !barHeld && !barError) barTimer = window.setTimeout(() => { barTimer = null; hideBar(); }, BAR_MS);
  }
  function hideBar() { clearTimer(); barEntry = null; barError = ''; barHeld = false; undoBar.hidden = true; barText.textContent = ''; }
  function renderBar() {
    const { state } = store, top = state.undo.at(-1) || null;
    // By order, not identity: deleting a category rewrites entries without changing them.
    if ((top?.at ?? 0) !== (barSeen?.at ?? 0)) {
      // Newer than what was shown: a change was just made. Going back to an older one is not.
      const added = top && top.at > (barSeen?.at ?? 0);
      barSeen = top;
      barError = '';
      if (added) { barEntry = top; startTimer(); } else hideBar();
    }
    if (!state.ready || state.blocked) hideBar();
    undoBar.hidden = !barEntry;
    if (!barEntry) return;
    barText.textContent = barError ? `${barEntry.done}. ${barError}` : barEntry.done;
    barUndo.hidden = !state.undo.some(entry => entry.at === barEntry.at);
    barUndo.disabled = state.busy;
  }

  function renderBox() {
    const { state } = store, ready = state.ready && !state.blocked;
    if (!ready) boxOpen = false;
    box.hidden = !boxOpen;
    boxButton.hidden = !ready || !view.map;
    openBox.hidden = !ready;
    for (const button of [boxButton, openBox]) button.setAttribute('aria-expanded', String(boxOpen));
    boxMessage.textContent = boxOpen ? state.message : '';
    boxMessage.hidden = !boxMessage.textContent;
    const here = (picked || []).map(id => store.find(id)).filter(mark => mark && visibility.shows(mark)).sort(byName);
    if (picked && here.length < 2) picked = null;
    pick.hidden = !picked || !view.map || !ready;
    pickTitle.textContent = pick.hidden ? '' : `${here.length} marks here`;
    pickList.replaceChildren(...(pick.hidden ? [] : here.map(mark => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = markBadge(mark);
      const button = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item' }, icon, h(document, 'span', { class: 'viewer-mark-list-name' },
        h(document, 'span', { text: mark.name }), h(document, 'small', { text: categoryById(mark.categoryId)?.name || '' })));
      on(button, 'click', () => select(mark.id, { focus: false }));
      return h(document, 'li', {}, button);
    })));
  }

  function renderStrip(writable) {
    const { state } = store, placing = mode !== 'idle' && writable;
    addButton.hidden = !writable || placing || Boolean(draft);
    addButton.disabled = state.busy;
    strip.hidden = !placing && !moving;
    strip.setAttribute('aria-label', moving ? 'Move' : 'Add mark');
    cross.hidden = !(placing && mode === 'Point' && crosshair);
    chips.hidden = !placing;
    placeRow.hidden = !placing || Boolean(drawing);
    placeHere.hidden = !crosshair;
    placeHere.disabled = severalButton.disabled = state.busy;
    severalButton.setAttribute('aria-pressed', String(several));
    moveRow.hidden = !moving;
    moveSave.disabled = state.busy;
    stripTitle.textContent = moving ? `Move ${draft?.name || 'mark'}` : placing ? `Add ${TYPE_LABEL[mode].toLowerCase()}` : '';
    const focusedChip = [...chips.children].find(chip => chip === document.activeElement)?.dataset.chip;
    chips.replaceChildren(...(placing ? placeChoices().map(choice => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = categoryBadge(choice);
      const chip = h(document, 'button', { type: 'button', class: 'viewer-mark-chip', 'data-chip': choice.id || 'none', 'aria-pressed': String(choice.id === placeChoice) },
        icon, h(document, 'span', { text: choice.name }));
      on(chip, 'click', () => {
        placeChoice = choice.id;
        if (drawing) drawing.color = styleOf(placeChoice).color;
        render();
      });
      return chip;
    }) : []));
    if (focusedChip) [...chips.children].find(chip => chip.dataset.chip === focusedChip)?.focus();
  }

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
    renderStrip(writable);
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
    if (!draft && selectedId && !store.find(selectedId)) selectedId = null;
    const open = !draft && selectedId ? store.find(selectedId) : null;
    card.hidden = !view.map || !state.ready || state.blocked || moving || !(draft || open);
    cardView.hidden = !open;
    editor.hidden = !draft || moving || !state.ready;
    cardMessage.textContent = card.hidden ? '' : state.message;
    cardMessage.hidden = !cardMessage.textContent;
    renderCard(open);
    if (draft) {
      card.setAttribute('aria-label', draft.id ? 'Edit ' + draft.name : 'New mark');
      editorTitle.textContent = (draft.id ? 'Edit ' : 'New ') + TYPE_LABEL[draft.geometry.type].toLowerCase();
      for (const control of [nameInput, categorySelect, noteInput, elevationInput, visibilitySelect, accountSelect, pointCoords, saveButton, ...picker.controls])
        control.disabled = !editable || state.busy;
      picker.render(draft);
      pointCoordsField.hidden = draft.geometry.type !== 'Point';
      coordReadout.textContent = readout(draft.geometry);
      elevationLabel.textContent = `NAVD88 Elevation (${elevationUnit(units())})`;
      visibilityField.hidden = !sessionScope || !state.capabilities.write || state.capabilities.visibility.length < 2 || Boolean(draft.id && !draft.mine);
      accountField.hidden = visibilityField.hidden || visibilitySelect.value !== 'client';
    }

    // List
    const hiddenCount = state.marks.length - visibleMarks().length;
    hiddenButton.hidden = !hiddenCount || !view.map || !state.ready || state.blocked;
    hiddenButton.textContent = `${hiddenCount} hidden`;
    labelsSelect.value = labels;
    groupToggle.checked = grouping;
    renderBox();
    renderBar();
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
    listHead.hidden = !state.ready || !state.undo.length;
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
    const starters = writable ? store.starters() : [], startersHidden = visibility.startersHidden();
    starterSection.hidden = !starters.length;
    starterAll.hidden = starterList.hidden = startersHidden;
    starterAll.disabled = state.busy;
    starterHide.textContent = startersHidden ? 'Show' : 'Hide';
    starterHide.setAttribute('aria-label', startersHidden ? 'Show suggested categories' : 'Hide suggested categories');
    starterList.replaceChildren(...starters.map(starter => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = categoryBadge(starter);
      const addOne = h(document, 'button', { type: 'button', text: 'Add', 'aria-label': 'Add ' + starter.name, disabled: state.busy });
      on(addOne, 'click', () => store.addStarter(starter));
      return h(document, 'li', {}, icon, h(document, 'span', { class: 'viewer-mark-list-name', text: starter.name }), addOne);
    }));
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
    const ghost = mode === 'Point' && !crosshair && writable ? styleOf(placeChoice) : null;
    layer.render({ ghost, visible: Boolean(view.map && state.ready && !state.blocked), marks: visibleMarks(), draft: editable && draftShown ? { ...draft, movable: !draft.id || moving, ...(draft.id ? {} : { id: '__draft__' }) } : null,
      selectedId, labels, group: grouping, preview, drawing });
    placeCard();
    keepDraft();
  }


  // ---- events ---------------------------------------------------------------
  const coarse = () => Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  for (const button of addButtons) on(button, 'click', () => {
    if (mode === button.dataset.add) { setMode('idle'); render(); } else startPlacing(button.dataset.add, { cross: coarse() });
  });
  on(addButton, 'click', () => startPlacing('Point', { cross: coarse() }));
  on(severalButton, 'click', () => { several = !several; render(); });
  on(placeHere, 'click', () => { const centre = layer.centre(); if (centre && mode === 'Point' && !store.state.busy) return placeAt(centre); });
  on(placeCancel, 'click', () => { setMode('idle'); render(); addButton.focus?.(); });
  on(editButton, 'click', () => beginEdit());
  on(moveButton, 'click', () => beginEdit({ move: true }));
  on(moveSave, 'click', () => saveDraft());
  on(moveCancel, 'click', () => cancelDraft());
  on(cancelButton, 'click', () => cancelDraft());
  on(closeButton, 'click', () => closeCard({ focusPin: true }));
  on(drawUndo, 'click', () => { drawing?.positions.pop(); render(); });
  on(drawCancel, 'click', () => { setMode('idle'); render(); });
  on(drawFinish, 'click', () => finishDrawing());

  // Keys over the map: M adds, Escape backs out one step, arrows and Enter pick a
  // spot or move the mark.
  // Where typing goes: a field, or anything editable, however it was made editable.
  function textHost(target) {
    const fieldNode = target?.closest?.('input,textarea,select');
    if (fieldNode) return fieldNode;
    if (target?.isContentEditable) return target;
    for (let node = target; node; node = node.parentElement ?? node.parent ?? null) {
      const value = node.getAttribute?.('contenteditable');
      if (value !== null && value !== undefined) return value.toLowerCase() === 'false' ? null : node;
    }
    return null;
  }
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  on(window, 'keydown', event => {
    if (event.defaultPrevented || event.altKey || (!view.map && !boxOpen)) return;
    if (event.ctrlKey || event.metaKey) {
      // Ctrl+Z is the field's own while typing.
      if (event.key.toLowerCase() !== 'z' || event.shiftKey || event.repeat || event.target?.closest?.('dialog[open]') || textHost(event.target)) return;
      if (mode !== 'idle' || moving || !canWrite() || document.querySelector?.('#photo-modal')?.style.display === 'flex' || !undoNow()) return;
      event.preventDefault();
      return undoLast({ focus: true });
    }
    const typing = textHost(event.target);
    if (event.target?.closest?.('dialog[open]') || (typing && !overlay.contains?.(typing))) return;
    // An open photo is in front: Escape is for it.
    if (document.querySelector?.('#photo-modal')?.style.display === 'flex') return;
    if (event.key === 'Escape') {
      if (picker.isOpen()) picker.close();
      else if (picked) closePick({ focusPin: true });
      else if (draft) cancelDraft();
      else if (mode !== 'idle') { setMode('idle'); render(); }
      else if (selectedId) closeCard({ focusPin: true });
      else if (boxOpen) showBox(false);
      else return;
      event.preventDefault();
      return;
    }
    if (typing) return;
    if ((event.key === 'l' || event.key === 'L') && store.state.ready) {
      event.preventDefault();
      void showBox(!boxOpen);
      return;
    }
    if ((event.key === 'm' || event.key === 'M') && mode === 'idle' && !draft && canWrite()) {
      event.preventDefault();
      startPlacing('Point', { cross: true });
      return;
    }
    const picking = mode === 'Point' && crosshair, step = ARROWS[event.key];
    if (!picking && !moving) return;
    if (step) {
      const size = event.shiftKey ? 40 : 8;
      event.preventDefault();
      if (picking) getMap()?.panBy?.([step[0] * size, step[1] * size], { animate: false });
      else if (draft.geometry.type === 'Point') {
        draft.geometry = { type: 'Point', coordinates: layer.nudge(draft.geometry.coordinates, step[0] * size / 4, step[1] * size / 4) };
        writeCoords();
        render();
      }
    } else if (event.key === 'Enter' && !event.target?.closest?.('button,a,summary')) {
      event.preventDefault();
      if (moving) return saveDraft();
      const centre = layer.centre();
      if (centre && !store.state.busy) return placeAt(centre);
    }
  });

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
    if (!point || !canWrite() || unsaved()) return;
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
    if (!parsed.ok) { more.open = true; message(parsed.error || 'Enter coordinates.'); return false; }
    draft.geometry = { type: 'Point', coordinates: [Math.round(parsed.longitude * 1e8) / 1e8, Math.round(parsed.latitude * 1e8) / 1e8] };
    writeCoords();
    return true;
  }

  on(pointCoords, 'change', () => {
    if (applyPointCoordinates()) { store.clearMessage(); render(); }
  });
  on(categorySelect, 'change', () => {
    const category = chosenStarter() || categoryById(categorySelect.value);
    if (!draft) return;
    draft.categoryId = category?.id || null;
    if (category) {
      Object.assign(draft, categoryStyle(category));
      colorInput.value = draft.color;
      if (!nameInput.value.trim() || nameInput.value === draft.autoName) draft.name = draft.autoName = nameInput.value = autoName(category.name.slice(0, 90));
    }
    render();
  });
  on(nameInput, 'input', () => { if (draft) draft.name = nameInput.value; });
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
  on(starterHide, 'click', () => { visibility.toggleStarters(); shownChanged(); });
  on(starterAll, 'click', async () => {
    for (const starter of store.starters()) if (!await store.addStarter(starter)) return;
  });
  on(hiddenButton, 'click', () => showBox(true, { to: 'categories' }));
  on(boxButton, 'click', () => showBox(!boxOpen));
  on(openBox, 'click', () => showBox(!boxOpen));
  on(boxClose, 'click', () => showBox(false));
  on(pickClose, 'click', () => closePick({ focusPin: true }));
  on(pickZoom, 'click', () => { const here = picked.map(id => store.find(id)).filter(Boolean); closePick(); layer.zoomTo(here.map(mark => mark.geometry)); });
  on(showAllButton, 'click', () => { visibility.showAll(); shownChanged(); });
  on(hideAllButton, 'click', () => { visibility.hideAll(); shownChanged(); });
  on(searchInput, 'input', () => { search = searchInput.value.trim().toLowerCase(); render(); });
  on(deleteButton, 'click', async event => {
    // The second half of a double click is not an answer to what the first one asked.
    if (!store.find(selectedId) || event.detail > 1) return;
    await removeMark(selectedId, { permanent: deleteForGood === selectedId });
  });
  on(deleteButton, 'keydown', event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); });
  // No question for one mark: it can be undone at once and restored for a while. Only
  // when that is not possible any more does it ask, and then says so.
  async function removeMark(id, { permanent = false } = {}) {
    const current = store.find(id);
    if (!current || !store.editable(current) || store.state.busy) return;
    deleteForGood = null;
    const held = store.hold(), open = selectedId, stays = focusKeeper();
    const removed = await store.remove(current, { permanent });
    if (!held.live()) return;
    // Recently deleted is full: this one can still go, but only for good and only if asked again.
    // With something else open by then, the message alone says so.
    const same = !draft && !picked && mode === 'idle' && (selectedId === open || selectedId === current.id);
    if (!removed && same && store.state.failure === 'mark_deleted_full') {
      if (selectedId !== current.id) select(current.id, { focus: false });
      deleteForGood = current.id;
      message(store.state.message || 'Recently deleted is full, so this one could not be brought back.');
    }
    render();
    // Another card opened meanwhile stays.
    if (removed && !draft && !picked && (!selectedId || selectedId === current.id)) closeCard();
    if (removed && stays() && !picked && (!selectedId || selectedId === open)) layer.focusStop();
    if (removed) await readDeleted();
  }
  on(editor, 'submit', event => { event.preventDefault(); return saveDraft(); });
  async function saveDraft() {
    if (!draft) return;
    // Enter or Save can arrive without a change event: never save the coordinates
    // the field showed before. Invalid text keeps the editor open and writes nothing.
    if (!applyPointCoordinates()) return;
    const values = readEditor();
    if (!values.name) { message('Give the mark a label.'); return; }
    if (Number.isNaN(values.elevationNavd88M)) { more.open = true; message('NAVD88 Elevation must be a number.'); return; }
    if (values.visibility === 'client' && !values.shareAccount) { message('Choose a client account to share with.'); return; }
    const changes = { ...values, icon: keepIcon(draft.icon), geometry: draft.geometry };
    const held = store.hold(), open = draft, starter = chosenStarter();
    if (starter) {
      const made = await store.addStarter(starter);
      if (!made || !held.live() || draft !== open) return;
      open.categoryId = changes.categoryId = made.id;
      fillCategoryOptions(categorySelect, made.id, 'None', category => usableCategory(category, made.id));
    }
    // A new mark keeps one id, so saving again after a lost answer updates it instead of adding a copy.
    const current = store.find(draft.id || draft.newId);
    if (draft.id && !current) { message('That mark is no longer there.'); return; }
    // Kept with the draft, so that a reload before the answer knows it again.
    const sending = item => {
      if (!sessionScope) return;
      open.sent = [...(open.sent || []), item].slice(-SENT_LIMIT);
      if (draft === open) keepDraft();
    };
    // Based on what was opened, not on what was read since; once told of a change, on that.
    const refused = store.state.busy, revision = open.told ?? (open.id ? open.revision : null);
    const saved = current && revision ? await store.update(current, changes, { sending, revision }) : await store.create({ ...changes, id: open.id || open.newId }, { sending });
    if (!held.live()) return;
    if (!saved && !refused && ['mark_revision_conflict', 'mark_id_conflict'].includes(store.state.failure)) open.told = store.find(open.id || open.newId)?.revision ?? null;
    if (!saved) return;
    reveal(saved);
    // Cancelled, or something else opened meanwhile: the mark is saved, the rest is not this one's to change.
    if (draft !== open) { render(); return; }
    const kept = open.id === saved.id;
    closeCard();
    // An edited mark goes back to its card, a new one to its pin.
    if (kept) { selectedId = saved.id; render(); editButton.focus?.({ preventScroll: true }); } else layer.focusPin(saved.id);
  }

  on(labelsSelect, 'change', () => { labels = labelsSelect.value; writePreference(window, LABELS_KEY, labels); render(); });
  on(groupToggle, 'change', () => { grouping = groupToggle.checked; writePreference(window, GROUP_KEY, grouping ? 'on' : 'off'); render(); });
  // True while the focus has not been taken anywhere else since.
  function focusKeeper() {
    const from = document.activeElement;
    return () => !draft && [from, document.body, null, undefined].includes(document.activeElement);
  }
  // Whether the last change can be undone now; an unsaved edit is said to be in the way.
  const undoNow = () => Boolean(store.state.undo.length) && !store.state.busy && !unsaved();
  async function undoLast({ focus = false } = {}) {
    if (!undoNow()) return false;
    const entry = store.state.undo.at(-1), held = store.hold(), stays = focusKeeper(), pressed = document.activeElement === barUndo;
    barError = '';
    closeCard();
    const ok = await store.undo();
    if (ok) {
      const back = store.find(entry.before?.id || entry.id);
      if (back) reveal(back);
      render();
      if (focus && stays() && !selectedId) { if (back) layer.focusPin(back.id); else layer.focusStop(); }
      await readDeleted();
    } else if (held.live()) {
      // The offer may be gone by now: what went wrong is said, with another try if there can be one.
      clearTimer();
      barEntry = entry;
      barError = store.state.message;
      render();
      if (pressed && stays()) (barUndo.hidden ? barClose : barUndo).focus?.({ preventScroll: true });
    }
    return ok;
  }
  on(undoButton, 'click', () => undoLast());
  on(barUndo, 'click', () => undoLast({ focus: true }));
  on(barClose, 'click', () => { hideBar(); layer.focusStop(); });
  for (const type of ['mouseenter', 'focusin']) on(undoBar, type, () => { barHeld = true; clearTimer(); });
  for (const type of ['mouseleave', 'focusout']) on(undoBar, type, event => {
    if (event.relatedTarget && undoBar.contains?.(event.relatedTarget)) return;
    barHeld = false;
    startTimer();
  });

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
      // What the store says of it comes first: it may not be possible to undo it.
      if (count && held.live()) message(store.state.message || `Imported ${count} mark${count === 1 ? '' : 's'}${parsed.skipped ? `; skipped ${parsed.skipped} unsupported` : ''}.`);
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
        more.open = false;
        preview = null; placeChoice = null; several = false; crosshair = false;
        picker.close({ focus: false });
        boxOpen = false; picked = null;
        hideBar();
        barSeen = null;
        hideBar();
        search = ''; tab = 'list'; armedDelete = null; categoryDraft = null; moving = false; deleteForGood = null;
        showCategoryIcon(DEFAULT_STYLE.icon);
        categoryColor.value = DEFAULT_STYLE.color;
        visibility.setScope(sessionScope ? next.key : null);
        for (const input of [searchInput, coordInput, nameInput, noteInput, elevationInput, pointCoords, categoryName]) input.value = '';
        for (const choice of [categorySelect, accountSelect]) choice.replaceChildren();
        for (const shown of [coordDetected, coordReadout, editorTitle]) shown.textContent = '';
        card.setAttribute('aria-label', 'Mark');
      }
      scopeKey = next?.key;
      const result = await store.setScope(next);
      restoreDraft();
      return result;
    },
    setView(next) {
      view = next || { map: false };
      if (!view.map && mode !== 'idle') setMode('idle');
      if (!view.map && moving) cancelDraft();
      if (!view.map) picked = null;
      restoreDraft();
      render();
    },
    mapClick({ lat, lng }) {
      if (!canWrite() || store.state.busy) return false;
      const position = [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
      // With the cross, the spot is the cross; a tap on the map only pans.
      if (mode === 'Point') { if (!crosshair) void placeAt(position); return true; }
      if (moving && draft?.geometry.type === 'Point') { draft.geometry = { type: 'Point', coordinates: position }; writeCoords(); render(); return true; }
      if (drawing) {
        if (drawing.positions.length < 500) drawing.positions.push(position);
        render();
        return true;
      }
      return false;
    },
    // Right-click, or holding a finger on the map: opens a draft there, saves nothing.
    mapContextMenu({ lat, lng }) {
      if (!canWrite() || store.state.busy || mode !== 'idle' || moving) return false;
      if (unsaved()) return true;
      closeCard();
      startDraft({ type: 'Point', coordinates: [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8] });
      return true;
    },
    mapDoubleClick() { return Boolean(drawing) && finishDrawing(); },
    cancelPlacement() { if (mode !== 'idle') { setMode('idle'); render(); } },
    hasTemporaryMarks: () => store.hasTemporaryMarks(),
    discardTemporaryMarks() { closeCard(); store.discardTemporaryMarks(); },
    dispose() {
      store.dispose();
      layer.dispose();
      listeners.abort();
      panel.hidden = true;
      for (const element of [addButton, boxButton, hiddenButton, cross, strip, card, pick, box, undoBar]) element.remove();
      clearTimer();
    },
  };
}
