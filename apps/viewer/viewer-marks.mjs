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
const VISIBILITY_LABEL = { shared: 'Shared, client can edit', 'shared-view': 'Shared, view only', staff: 'Me and project staff', private: 'Only me', internal: 'Staff only', client: 'A client account' };
const ACCOUNT_TYPE = { model_association: 'Client association', direct_client_grant: 'Client grant' };
const accountLabel = key => { const [type, id = ''] = String(key).split(/:(.*)/s); return `${ACCOUNT_TYPE[type] || 'Client'} …${id.slice(-6)}`; };
const LABELS_KEY = 'ltds.viewer.marks.labels', GROUP_KEY = 'ltds.viewer.marks.group';
const LABEL_MODES = { on: 'On', selected: 'Selected', off: 'Off' };
const SHARED_REFRESH_MS = 30_000;
// Line icons for the buttons (stroke only, in the button's colour).
const GLYPHS = {
  Point: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  LineString: '<path d="M4 18l5-7 5 4 6-9"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="6" r="1.6"/>',
  Polygon: '<path d="M5 8l7-4 7 5-2.5 10h-9z"/>',
  add: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><path d="M12 6.5v6M9 9.5h6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
};
function glyph(document, name) {
  const span = document.createElement('span');
  span.className = 'viewer-mark-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${GLYPHS[name]}</svg>`;
  return span;
}

// Labels and grouping: kept in this browser when signed in, and only in this tab for a
// public link. Never sent anywhere.
function readPreference(storage, key, allowed, fallback) {
  try { const value = storage()?.getItem(key); return allowed.includes(value) ? value : fallback; } catch { return fallback; }
}
function writePreference(storage, key, value) {
  try { storage()?.setItem(key, value); } catch { /* per-viewer convenience only */ }
}

// overlay: where the pop-ups over the map go (the card, the strip while placing).
export function mountViewerMarks({ panel, overlay = panel, L, getMap, request = globalThis.fetch, newId = () => crypto.randomUUID(),
  onActivate = () => {}, onViewerAccessLost = () => {}, focusAfterAccessLoss,
  georef = () => null, units = () => 'imperial', fileName = () => 'marks', obstacles = () => [], mapControls = () => [] }) {
  const document = panel.ownerDocument, window = document.defaultView;
  const listeners = new AbortController();
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  let view = { map: false }, mode = 'idle', drawing = null, draft = null, selectedId = null, preview = null;
  let publicPreferences = false;
  const preferenceStorage = () => (publicPreferences ? window.sessionStorage : window.localStorage);
  let labels, grouping;
  const readPreferences = () => {
    labels = readPreference(preferenceStorage, LABELS_KEY, Object.keys(LABEL_MODES), 'selected');
    grouping = readPreference(preferenceStorage, GROUP_KEY, ['on', 'off'], 'on') === 'on';
  };
  readPreferences();
  // Several marks picked in the list, to change their sharing at once.
  let selecting = false, selected = new Set(), confirming = null, confirmArmed = false;
  // The Marks pop-up, and the list for several marks on one spot.
  let boxOpen = false, picked = null;
  let tab = 'list', search = '', armedDelete = null, categoryDraft = null;
  let sessionScope = false, scopeKey, writtenCoords = null;
  let publicReadOnly = false, history = null;
  let hadMarksAccess = false, hadWriteAccess = false;
  let pendingRestoreFocus = null;
  let sharedRefreshTimer = null, pageSuspended = false;
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
  let barEntry = null, barTimer = null, barHeld = false, barSeen = null, recoveredSeen = null, barError = '';

  const store = createMarksStore({ request, newId, onChange: () => render(),
    onViewerAccessLost: () => {
      const held = store.hold();
      // Finish closing Marks before the Viewer lifecycle can replace its scope.
      queueMicrotask(() => {
        if (!held.live()) return;
        render();
        onViewerAccessLost();
      });
    },
    later: (work, ms) => { const id = window.setTimeout(work, ms); return () => window.clearTimeout(id); } });
  const canRefreshShared = () => sessionScope && store.state.capabilities.shared && store.state.ready
    && !store.state.loading && !store.state.blocked && !pageSuspended && document.visibilityState === 'visible';
  function stopSharedRefresh() {
    if (sharedRefreshTimer !== null) window.clearTimeout(sharedRefreshTimer);
    sharedRefreshTimer = null;
    store.cancelSharedRefresh();
  }
  function syncSharedRefresh() {
    if (!canRefreshShared()) { stopSharedRefresh(); return; }
    if (sharedRefreshTimer !== null) return;
    sharedRefreshTimer = window.setTimeout(() => {
      sharedRefreshTimer = null;
      if (canRefreshShared()) void store.refreshShared();
      syncSharedRefresh();
    }, SHARED_REFRESH_MS);
  }
  function refreshInForeground() {
    if (canRefreshShared()) void store.refreshShared();
    syncSharedRefresh();
  }
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
    onDraftMove: geometry => { if (draft && canWrite()) { draft.geometry = geometry; writeCoords(); render(); } },
  });

  // ---- skeleton -------------------------------------------------------------
  const root = panel.querySelector('[data-marks-root]') || panel;
  const status = h(document, 'p', { class: 'hint viewer-mark-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const addButtons = Object.keys(TYPE_LABEL).map(type => h(document, 'button', { type: 'button', class: 'tool-btn', 'data-add': type, 'aria-pressed': 'false' },
    glyph(document, type), h(document, 'span', { text: TYPE_LABEL[type] })));
  const tools = h(document, 'div', { class: 'viewer-mark-tools', role: 'toolbar', 'aria-label': 'Add marks' }, ...addButtons);
  const drawCount = h(document, 'span', { class: 'hint' });
  const drawUndo = h(document, 'button', { type: 'button', text: 'Undo point' });
  const drawFinish = h(document, 'button', { type: 'button', text: 'Finish' });
  const drawCancel = h(document, 'button', { type: 'button', text: 'Cancel' });
  const drawBar = h(document, 'div', { class: 'viewer-mark-row viewer-mark-draw', hidden: true }, drawCount, drawUndo, drawFinish, drawCancel);

  // Placing, over the map
  // The map's own controls are one column on the right; these two join it.
  const addButton = h(document, 'button', { type: 'button', class: 'viewer-mark-add viewer-mark-rail', 'aria-label': 'Add mark', title: 'Add mark (M)' }, glyph(document, 'add'));
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
  const moveRow = h(document, 'div', { class: 'viewer-mark-row viewer-mark-move', hidden: true }, moveSave, moveCancel);
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
  // Category: typed, with this map's categories offered under the box. A new name becomes a category on Save.
  const categoryInput = h(document, 'input', { name: 'category', maxlength: '60', autocomplete: 'off', spellcheck: 'false', role: 'combobox',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'viewer-mark-category-options', placeholder: 'None' });
  const categoryOptions = h(document, 'ul', { id: 'viewer-mark-category-options', class: 'viewer-mark-suggest', role: 'listbox', 'aria-label': 'Categories', hidden: true });
  let suggestOpen = false, suggestIndex = -1, pickedKey = null;
  const picker = createMarkPicker({ document, on, getDraft: () => draft, onChange: () => render(),
    categoryStyleOf: () => categoryStyle(chosenStarter() || chosenCategory()) });
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
  // Every field in view: no More.
  const editor = h(document, 'form', { class: 'viewer-mark-form', hidden: true }, editorTitle,
    field('Label', nameInput), h(document, 'div', { class: 'viewer-mark-combo' }, field('Category', categoryInput), categoryOptions),
    picker.element, visibilityField, accountField, field('Notes', noteInput),
    h(document, 'div', { class: 'viewer-mark-where' }, pointCoordsField, coordReadout), elevationField,
    h(document, 'div', { class: 'viewer-mark-row viewer-mark-editor-actions' }, saveButton, cancelButton));

  // The card: what a mark is, then Edit, Move or Delete.
  const cardBadge = h(document, 'span', { class: 'viewer-mark-list-icon' });
  const cardName = h(document, 'h4'), cardKind = h(document, 'small'), cardNote = h(document, 'p', { class: 'viewer-mark-card-note' });
  const cardFacts = h(document, 'dl', { class: 'viewer-mark-facts' });
  const editButton = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Edit' });
  const moveButton = h(document, 'button', { type: 'button', text: 'Move' });
  const historyButton = h(document, 'button', { type: 'button', text: 'History' });
  const historyList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-history', 'aria-label': 'Mark history', hidden: true });
  const closeButton = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close', text: '\u00d7' });
  const cardActions = h(document, 'div', { class: 'viewer-mark-row' }, editButton, moveButton, deleteButton, historyButton);
  const cardView = h(document, 'div', { class: 'viewer-mark-view' }, h(document, 'div', { class: 'viewer-mark-card-head' }, cardBadge,
    h(document, 'div', { class: 'viewer-mark-list-name' }, cardName, cardKind), closeButton), cardActions, historyList, cardNote, cardFacts);
  const cardMessage = h(document, 'p', { class: 'hint viewer-mark-card-message', role: 'status', 'aria-live': 'polite' });
  const card = h(document, 'section', { class: 'viewer-mark-card', role: 'dialog', 'aria-label': 'Mark', hidden: true }, cardMessage, cardView, editor);

  // List
  const searchInput = h(document, 'input', { type: 'search', name: 'markSearch', autocomplete: 'off', 'aria-label': 'Search marks', placeholder: 'Search' });
  const labelsSelect = h(document, 'select', { name: 'labels', 'aria-label': 'Labels' }, ...Object.entries(LABEL_MODES).map(([value, text]) => h(document, 'option', { value, text })));
  const groupToggle = h(document, 'input', { type: 'checkbox', name: 'group' });
  const undoButton = h(document, 'button', { type: 'button', text: 'Undo' });
  // What is hidden is always said, and leads to where it can be shown again.
  const hiddenButton = h(document, 'button', { type: 'button', class: 'viewer-mark-hidden-count' });
  const shareAllButton = h(document, 'button', { type: 'button', text: 'Share all' });
  const selectButton = h(document, 'button', { type: 'button', text: 'Select' });
  const listHead = h(document, 'div', { class: 'viewer-mark-row viewer-mark-list-head' }, undoButton, selectButton, shareAllButton);
  // Select mode: how many, All, None, Done; and at the foot, the sharing for all of them.
  const selectCount = h(document, 'span', { class: 'viewer-mark-select-count', role: 'status', 'aria-live': 'polite' });
  const selectAll = h(document, 'button', { type: 'button', text: 'All' });
  const selectNone = h(document, 'button', { type: 'button', text: 'None' });
  const selectDone = h(document, 'button', { type: 'button', text: 'Done' });
  const selectHead = h(document, 'div', { class: 'viewer-mark-row viewer-mark-select-head', hidden: true }, selectCount, selectAll, selectNone, selectDone);
  const bulkVisibility = h(document, 'select', { name: 'bulkVisibility' });
  const bulkAccount = h(document, 'select', { name: 'bulkAccount', 'aria-label': 'Client account' });
  const bulkApply = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Apply' });
  const bulkBar = h(document, 'div', { class: 'viewer-mark-bulk', hidden: true },
    h(document, 'label', {}, h(document, 'span', { text: 'Visible to' }), bulkVisibility), bulkAccount, bulkApply);
  // Asked once before a sharing change for several marks. Cancel has the focus.
  const confirmText = h(document, 'p');
  const confirmCancel = h(document, 'button', { type: 'button', text: 'Cancel' });
  const confirmGo = h(document, 'button', { type: 'button', class: 'viewer-mark-primary', text: 'Change' });
  const confirmBox = h(document, 'div', { class: 'viewer-mark-confirm', role: 'alertdialog', 'aria-label': 'Change sharing', hidden: true },
    confirmText, h(document, 'div', { class: 'viewer-mark-row' }, confirmCancel, confirmGo));
  // The sharing job: how far, why it stopped, Resume.
  const jobText = h(document, 'span', { role: 'status', 'aria-live': 'polite' });
  const jobResume = h(document, 'button', { type: 'button', text: 'Resume' });
  const jobClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close sharing status', text: '×' });
  const jobBar = h(document, 'div', { class: 'viewer-mark-row viewer-mark-job', tabindex: '-1', hidden: true }, jobText, jobResume, jobClose);
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
  const deletedNotice = h(document, 'p', { class: 'hint', role: 'status', 'aria-live': 'polite', hidden: true });
  const deletedList = h(document, 'ul', { class: 'viewer-mark-list viewer-mark-deleted', 'aria-label': 'Recently deleted marks' });

  // One panel: Categories, List, Deleted.
  const sections = {
    categories: h(document, 'div', { id: 'viewer-marks-categories', role: 'tabpanel' }, categoryTools, categoryList, starterSection, categoryForm),
    list: h(document, 'div', { id: 'viewer-marks-list', role: 'tabpanel' }, selectHead, searchInput, list, bulkBar),
    deleted: h(document, 'div', { id: 'viewer-marks-deleted', role: 'tabpanel' }, deletedNotice, deletedList),
  };
  const tabButtons = Object.entries({ list: 'List', categories: 'Categories', deleted: 'Deleted' }).map(([name, text]) =>
    h(document, 'button', { type: 'button', role: 'tab', 'data-tab': name, 'aria-controls': `viewer-marks-${name}`, text }));
  const tabs = h(document, 'div', { class: 'viewer-mark-row viewer-mark-tabs', role: 'tablist', 'aria-label': 'Marks' }, ...tabButtons);
  const activeTab = () => tabButtons.find(button => button.dataset.tab === tab);

  const openBoxCount = h(document, 'span', { class: 'viewer-mark-count' });
  const openBox = h(document, 'button', { type: 'button', class: 'tool-btn full viewer-mark-open', 'aria-expanded': 'false' },
    glyph(document, 'list'), h(document, 'span', { text: 'All marks' }), openBoxCount);
  root.replaceChildren(status, tools, openBox);

  // One Marks pop-up, from the map or the sidebar.
  const boxButton = h(document, 'button', { type: 'button', class: 'viewer-mark-layers viewer-mark-rail', 'aria-label': 'Marks', title: 'Marks (L)', 'aria-expanded': 'false' }, glyph(document, 'list'));
  const boxCount = h(document, 'span', { class: 'viewer-mark-count' });
  const boxClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close marks', text: '\u00d7' });
  const boxMessage = h(document, 'p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const box = h(document, 'section', { class: 'viewer-mark-box', role: 'dialog', 'aria-label': 'Marks', hidden: true },
    h(document, 'div', { class: 'viewer-mark-card-head' }, h(document, 'h4', { text: 'Marks' }), boxCount, boxClose), boxMessage, jobBar, confirmBox, listHead, tabs, ...Object.values(sections), coordForm, exchange);

  // Several marks on one spot
  const pickTitle = h(document, 'h4'), pickList = h(document, 'ul', { class: 'viewer-mark-list', 'aria-label': 'Marks here' });
  const pickZoom = h(document, 'button', { type: 'button', text: 'Zoom in' });
  const pickClose = h(document, 'button', { type: 'button', class: 'viewer-mark-close', 'aria-label': 'Close list', text: '\u00d7' });
  const pick = h(document, 'section', { class: 'viewer-mark-card viewer-mark-pick', role: 'dialog', 'aria-label': 'Marks here', hidden: true },
    h(document, 'div', { class: 'viewer-mark-card-head' }, pickTitle, pickClose), pickList, pickZoom);

  overlay.append(addButton, boxButton, hiddenButton, cross, strip, card, pick, box, undoBar);

  // ---- helpers --------------------------------------------------------------
  const canWrite = () => !publicReadOnly && store.canWrite() && Boolean(view.map);
  const canDelete = mark => !publicReadOnly && store.canWrite() && Boolean(mark?.deletable ?? (!sessionScope && mark?.mine && mark?.editable));
  // Sharing is the owner's to choose: not offered on anyone else's mark, staff's included.
  const canShare = mark => !publicReadOnly && store.canWrite() && (!mark?.id || mark.mine === true);
  const canHistory = mark => !publicReadOnly && store.canWrite() && store.state.capabilities.staff && store.state.capabilities.history && mark?.visibility === 'shared' && canDelete(mark);
  const jobRunning = () => store.state.sharing?.status === 'running';
  // A stopped job is resumed or closed before another starts: it is never replaced unseen.
  const jobOpen = () => Boolean(store.state.sharing) && store.state.sharing.status !== 'done';
  const shareAllAvailable = () => !publicReadOnly && store.canWrite() && store.state.capabilities.staff && store.state.capabilities.shareAll
    && store.state.marks.some(mark => mark.mine && mark.visibility !== 'shared');
  const sharingValue = mark => mark?.visibility === 'shared' && mark.access === 'view' ? 'shared-view' : mark?.visibility;
  // The sharing choices this person has, as the editor and the select bar offer them.
  const sharingOptions = () => store.state.capabilities.visibility.flatMap(value => value === 'shared'
    ? (store.state.capabilities.access || []).map(access => access === 'view' ? 'shared-view' : 'shared') : [value]);
  const choiceOf = (value, account) => ({ visibility: value === 'shared-view' ? 'shared' : value,
    ...(['shared', 'shared-view'].includes(value) ? { access: value === 'shared-view' ? 'view' : 'edit' } : {}),
    ...(value === 'client' ? { shareAccount: account || null } : {}) });
  const selectable = mark => canShare(mark) && Boolean(mark?.id) && mark.editable === true;
  const canSelect = () => sessionScope && !publicReadOnly && store.canWrite() && sharingOptions().length > 1 && store.state.marks.some(selectable);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const canMoveDraft = () => Boolean(moving && view.map && draft?.id && store.editable(store.find(draft.id)));
  const categoryById = id => store.state.categories.find(category => category.id === id) || null;
  const visibleMarks = () => store.state.marks.filter(visibility.shows);
  const searched = mark => !search || [mark.name, mark.note, categoryById(mark.categoryId)?.name].some(value => value?.toLowerCase().includes(search));
  // What the category box names: a category of this map, a suggested one not made yet, a new name, or nothing.
  const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  function categoryChoices() {
    const keep = draft?.categoryId, own = store.state.categories.filter(category => usableCategory(category, keep));
    const starters = store.canWrite() && !visibility.startersHidden() ? store.starters().filter(starter => !own.some(category => sameText(category.name, starter.name))) : [];
    return [...own.map(category => ({ key: category.id, name: category.name, category })), ...starters.map(starter => ({ key: 'starter:' + starter.key, name: starter.name, starter }))];
  }
  // The one picked (or the mark's own) stays chosen while the box still shows its name, even when
  // another category has the same name; typed text is matched by name.
  function categoryChoice() {
    const text = categoryInput.value.trim();
    if (!text) return null;
    const all = categoryChoices(), kept = categoryById(pickedKey);
    const picked = all.find(choice => choice.key === pickedKey) || (kept && { key: kept.id, name: kept.name, category: kept });
    if (picked && sameText(picked.name, text)) return picked;
    return all.find(choice => sameText(choice.name, text)) || { key: 'new', name: text.slice(0, 60), fresh: true };
  }
  const chosenCategory = () => categoryChoice()?.category || null;
  const chosenStarter = () => categoryChoice()?.starter || null;
  const newCategoryName = () => (categoryChoice()?.fresh ? categoryChoice().name : null);
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
    if (keys) keys[(mode === 'Point' && crosshair && canWrite()) || canMoveDraft() ? 'disable' : 'enable']();
  }

  function endMarkInput() {
    if (mode === 'idle' && !moving) return;
    moving = false;
    setMode('idle');
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
    // Placing is done on the map: the list makes room for it.
    boxOpen = false;
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
    if (starter) { categoryInput.value = starter.name; pickedKey = choice; }
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
    if (!view.map || !mark || mode !== 'idle' || unsaved()) return;
    draft = null;
    selectedId = id;
    history = null;
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
    else if (boxRight()) layer.keepRightOf(mark.geometry, boxRight() + 24);
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
    if (next && (narrow() || !roomBeside())) { if (unsaved()) return; closeCard(); picked = null; if (mode !== 'idle') setMode('idle'); }
    boxOpen = next;
    tab = to;
    render();
    (next ? tabButtons.find(button => button.dataset.tab === tab) : view.map ? boxButton : openBox)?.focus?.({ preventScroll: true });
    return next && readDeleted();
  }

  function beginEdit({ move = false } = {}) {
    const mark = store.find(selectedId);
    if (!canWrite() || !store.editable(mark)) return;
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
    history = null;
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
  // Wide map: the list is docked at the top left, beside the zoom buttons; the
  // map's controls are a column on the right. A mark's card is beside its pin,
  // between the two and never over either. Narrow map: sheets at the bottom.
  const RAIL = 64, DOCK_LEFT = 56, GAP = 12;
  const roomBeside = () => (getMap()?.getSize?.().x ?? Infinity) >= DOCK_LEFT + (box.offsetWidth || 340) + GAP + 300 + RAIL;
  const boxRight = () => (!box.hidden && !narrow() ? DOCK_LEFT + (box.offsetWidth || 340) + GAP : 0);
  // The map's own buttons (Reset, Fullscreen, Save view image), measured in the
  // map's pixels where they are now: the row is wider than the rail.
  const controlRects = () => (mapControls() || []).filter(rect => rect && rect.width > 0 && rect.height > 0);
  // A sheet at the bottom stops below them.
  const sheetCap = (size, percent) => {
    const below = Math.max(0, ...controlRects().map(rect => rect.y + rect.height + GAP));
    return below && size ? `min(${percent}%, ${Math.max(0, size.y - below)}px)` : '';
  };
  function placeBeside(element, geometry, full) {
    const size = getMap()?.getSize?.(), sheet = narrow();
    element.classList.toggle('sheet', sheet);
    element.classList.toggle('full', sheet && full);
    const point = !sheet && size && geometry ? layer.anchor(geometry) : null;
    if (!point) { element.style.left = element.style.top = ''; element.style.maxHeight = sheet ? sheetCap(size, full ? 86 : 46) : ''; return; }
    const width = element.offsetWidth || 300, height = element.offsetHeight || 260, gap = 28, edge = 8;
    const min = Math.max(edge, boxRight());
    // Clear of the undo note at the bottom while it is there.
    const bottom = size.y - edge - (undoBar.hidden ? 0 : (undoBar.offsetHeight || 48) + 16);
    // How far right a card at this height may reach: before the rail, and
    // before any of the map's buttons beside it.
    const reach = y => Math.min(size.x - RAIL, ...controlRects().filter(rect => rect.y < y + height + GAP && y < rect.y + rect.height + GAP).map(rect => rect.x - GAP)) - width;
    let top = Math.max(edge, Math.min(point[1] - 60, bottom - height)), max = reach(top), below = false;
    // No room beside them at this height: the card goes below them.
    if (max < min) { top = Math.max(top, ...controlRects().map(rect => rect.y + rect.height + GAP)); max = reach(top); below = true; }
    const right = point[0] + gap <= max;
    const left = right ? point[0] + gap : point[0] - gap - width;
    element.style.left = `${Math.max(min, Math.min(left, max))}px`;
    element.style.top = `${top}px`;
    element.style.maxHeight = `${Math.max(0, bottom - (below ? top : edge))}px`;
  }
  // The undo note sits at the bottom centre, above whatever is docked there.
  function placeUndo() {
    if (undoBar.hidden) return;
    const below = [strip, ...(narrow() ? [card, pick, box] : [])].filter(element => !element.hidden).map(element => element.offsetHeight || 0);
    undoBar.style.bottom = `${16 + (below.length ? Math.max(...below) + 8 : 0)}px`;
  }
  // A screen that becomes narrow has room for one: what is being worked on the map stays.
  function oneSheet() {
    // A map too narrow for the list and a card side by side is the same: the list makes room.
    if (!boxOpen || !(narrow() || !roomBeside()) || (card.hidden && pick.hidden && strip.hidden)) return;
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
    box.style.maxHeight = narrow() ? sheetCap(getMap()?.getSize?.(), 86) : '';
    placeUndo();
  }

  // ---- unsaved work ---------------------------------------------------------
  function snapshot() {
    if (drawing) return drawing.positions.length ? { kind: 'drawing', type: drawing.type, positions: structuredClone(drawing.positions) } : null;
    if (!draft || (draft.id && !store.find(draft.id)?.editable)) return null;
    return { kind: 'editor', id: draft.id, newId: draft.newId || null, revision: draft.id ? draft.revision : null, geometry: structuredClone(draft.geometry),
      name: nameInput.value, note: noteInput.value, categoryId: chosenCategory()?.id || null, starter: chosenStarter()?.key || null, newCategory: newCategoryName(), color: safeColor(colorInput.value), icon: keepIcon(draft.icon),
      elevation: elevationInput.value, units: units() === 'metric' ? 'metric' : 'imperial', ...readSharing(),
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
    const { kind, units: savedUnits, elevation, coordinates, changedElsewhere, starter, newCategory, ...fields } = reconcileMarkDraft(saved, store.find, newId);
    const metres = elevationToMetres(elevation, savedUnits);
    const current = fields.id ? store.find(fields.id) : null;
    draft = { ...(current || {}), ...fields, color: safeColor(fields.color), elevationNavd88M: Number.isFinite(metres) ? metres : null };
    selectedId = draft.id;
    moving = false;
    draftBaseline = null;
    writeEditor();
    if (savedUnits === (units() === 'metric' ? 'metric' : 'imperial') || Number.isNaN(metres)) elevationInput.value = elevation;
    const starterBack = starter && store.starters().find(item => item.key === starter);
    if (starterBack) { categoryInput.value = starterBack.name; pickedKey = 'starter:' + starterBack.key; }
    else if (newCategory) categoryInput.value = newCategory;
    if (coordinates !== null && draft.geometry.type === 'Point') pointCoords.value = coordinates;
    store.expect(draft.id || draft.newId, draft.sent);
    // It was saved, only the answer was lost: nothing is unsaved.
    if (current && draft.sent && coordinates === null && !chosenStarter() && !newCategoryName() && sameMark(current, { ...readEditor(), icon: draft.icon, geometry: draft.geometry })) {
      closeCard();
      return;
    }
    message(changedElsewhere ? 'That mark changed elsewhere. Your unsaved edit opened as a new mark.' : 'Your unsaved mark was restored.');
  }

  // A mark can use your own categories (staff: any staff category), or keep the one it has.
  const usableCategory = (category, keep) => category.id === keep || category.mine
    || (store.state.capabilities.staff && category.author === 'staff');

  function writeEditor() {
    if (!draft) return;
    nameInput.value = draft.name;
    categoryInput.value = categoryById(draft.categoryId)?.name || '';
    pickedKey = draft.categoryId || null;
    suggestOpen = false;
    colorInput.value = safeColor(draft.color);
    noteInput.value = draft.note || '';
    elevationInput.value = elevationForDisplay(draft.elevationNavd88M, units());
    const options = sharingOptions();
    const selected = sharingValue(draft);
    if (selected && !options.includes(selected)) options.push(selected);
    visibilitySelect.replaceChildren(...options.map(value => h(document, 'option', { value, text: VISIBILITY_LABEL[value] })));
    visibilitySelect.value = selected || options[0];
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

  function readSharing() {
    if (!canShare(draft)) return { visibility: draft.visibility, ...(draft.access && { access: draft.access }) };
    return choiceOf(visibilitySelect.value, accountSelect.value);
  }

  function readEditor() {
    const elevation = elevationToMetres(elevationInput.value, units());
    return { name: nameInput.value.trim(), categoryId: chosenCategory()?.id || null, color: safeColor(colorInput.value),
      note: noteInput.value.trim(), elevationNavd88M: elevation, ...readSharing() };
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
    const { state } = store, editable = !publicReadOnly && store.editable(mark), deletable = canDelete(mark), hasHistory = canHistory(mark);
    card.setAttribute('aria-label', mark.name);
    cardBadge.innerHTML = markBadge(mark);
    cardName.textContent = mark.name;
    cardKind.textContent = [categoryById(mark.categoryId)?.name, mark.mine ? null : mark.author === 'staff' ? 'From project staff' : 'From a client',
      state.capabilities.staff && mark.changedBy === 'client' ? 'Changed by a client' : null].filter(Boolean).join(' · ');
    cardNote.textContent = publicReadOnly ? '' : mark.note || '';
    cardNote.hidden = publicReadOnly || !mark.note;
    const facts = [
      sessionScope && mark.mine && state.capabilities.visibility.length > 1 ? ['Visible to', VISIBILITY_LABEL[sharingValue(mark)]] : null,
      [mark.geometry.type === 'Point' ? 'Coordinates' : 'Points', mark.geometry.type === 'Point' ? readout(mark.geometry) : String(markPositions(mark.geometry).length)],
      Number.isFinite(mark.elevationNavd88M) ? ['NAVD88 Elevation', `${elevationForDisplay(mark.elevationNavd88M, units())} ${elevationUnit(units())}`] : null,
    ].filter(Boolean);
    cardFacts.replaceChildren(...facts.flatMap(([term, value]) => [h(document, 'dt', { text: term }), h(document, 'dd', { text: value })]));
    cardActions.hidden = !editable && !deletable && !hasHistory;
    for (const button of [editButton, moveButton]) { button.hidden = !editable; button.disabled = state.busy; }
    deleteButton.hidden = !deletable;
    deleteButton.disabled = historyButton.disabled = state.busy;
    historyButton.hidden = !hasHistory;
    historyList.hidden = !hasHistory || history?.id !== mark.id;
    historyList.replaceChildren(...(!historyList.hidden ? history.versions.map(version => {
      const restore = h(document, 'button', { type: 'button', text: 'Restore', 'data-revert-revision': String(version.revision), disabled: state.busy });
      on(restore, 'click', async () => {
        const current = store.find(mark.id), held = store.hold();
        if (!canHistory(current) || store.state.busy || unsaved()) return;
        if (await store.revert(current, version.revision)) {
          if (!held.live() || selectedId !== mark.id) return;
          history = null;
          render();
          historyButton.focus?.();
        }
      });
      return h(document, 'li', {}, h(document, 'span', { class: 'viewer-mark-list-name', text: `${version.mark.name} · ${version.changedBy === 'client' ? 'Client' : 'Staff'} · ${new Date(version.changedAt).toLocaleString()}` }), restore);
    }) : []));
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
    const recovered = state.recoveredChange;
    if (recovered !== recoveredSeen) {
      recoveredSeen = recovered;
      if (recovered && recovered.at > (top?.at ?? 0)) {
        barEntry = recovered;
        barError = '';
        startTimer();
      }
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
    for (const count of [boxCount, openBoxCount]) count.textContent = ready && state.marks.length ? String(state.marks.length) : '';
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
    const { state } = store, placing = mode !== 'idle' && writable, showMove = canMoveDraft();
    addButton.hidden = !writable || placing || Boolean(draft);
    addButton.disabled = state.busy;
    strip.hidden = !placing && !showMove;
    strip.setAttribute('aria-label', showMove ? 'Move' : 'Add mark');
    cross.hidden = !(placing && mode === 'Point' && crosshair);
    chips.hidden = !placing;
    placeRow.hidden = !placing || Boolean(drawing);
    placeHere.hidden = !crosshair;
    placeHere.disabled = severalButton.disabled = state.busy;
    severalButton.setAttribute('aria-pressed', String(several));
    const hideMove = !showMove;
    if (moveRow.hidden !== hideMove) syncMapKeys();
    moveRow.hidden = moveCancel.disabled = hideMove;
    moveSave.disabled = !showMove || state.busy;
    stripTitle.textContent = showMove ? `Move ${draft.name}` : placing ? `Add ${TYPE_LABEL[mode].toLowerCase()}` : '';
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

  // ---- select several, and the sharing job ------------------------------------
  const shownSelectable = () => visibleMarks().filter(searched).filter(selectable);
  // What Apply changes: the ticked marks still shown after search and hidden categories.
  const pickedShown = () => shownSelectable().filter(mark => selected.has(mark.id)).map(mark => mark.id);
  function toggleSelected(id, on) {
    if (!selecting || store.state.busy || !selectable(store.find(id))) return;
    if (on) selected.add(id); else selected.delete(id);
    render();
  }
  function setSelecting(next) {
    selecting = next && canSelect();
    selected = new Set();
    confirming = null;
    render();
    (selecting ? selectDone : selectButton.hidden ? activeTab() : selectButton)?.focus?.({ preventScroll: true });
  }
  // What a question would ask, worked out from what the controls show now:
  // 'all' is Share all, 'bulk' the ticked marks still shown and the chosen sharing.
  function sharingQuestion(source) {
    const picked = source === 'all' ? store.state.marks.filter(mark => mark.mine && mark.visibility !== 'shared').map(mark => mark.id) : pickedShown();
    const value = source === 'all' ? 'shared' : bulkVisibility.value, account = source === 'all' ? undefined : bulkAccount.value;
    const choice = choiceOf(value, account);
    // Only those it would change are counted and asked about.
    const ids = picked.filter(id => {
      const mark = store.find(id);
      return mark && (sharingValue(mark) !== value || (value === 'client' && (mark.shareAccount ?? null) !== choice.shareAccount));
    });
    return { picked, value, choice, ids, key: JSON.stringify([source, picked, value, choice.shareAccount ?? null, ids]) };
  }
  // What a confirmation would start, if Change is chosen.
  function askSharing(source) {
    const { picked, value, choice, ids, key } = sharingQuestion(source);
    if (!picked.length || store.state.busy || jobOpen() || unsaved()) return;
    if (choice.visibility === 'client' && !choice.shareAccount) { message('Choose a client account to share with.'); return; }
    if (!ids.length) { message(`${picked.length === 1 ? 'It is' : 'They are'} already ${VISIBILITY_LABEL[value]}.`); return; }
    confirming = { source, key, ids, choice, label: VISIBILITY_LABEL[value] };
    confirmArmed = false;
    render();
    confirmCancel.focus?.({ preventScroll: true });
  }
  // The question stands only for exactly what it asks about: the controls are
  // locked while it is open, and if anything it depends on still changes (the
  // ticks, the marks shown, the choice, the marks themselves), or the list
  // closes, it is dropped and asked again.
  function questionStands() {
    if (!confirming) return true;
    if (!boxOpen || (confirming.source === 'bulk' && !selecting) || sharingQuestion(confirming.source).key !== confirming.key) {
      confirming = null;
      confirmArmed = false;
      return false;
    }
    return true;
  }
  function closeConfirm({ focus = true } = {}) {
    const was = confirming;
    confirming = null;
    render();
    if (focus && was) (selecting ? bulkApply : shareAllButton.hidden ? activeTab() : shareAllButton)?.focus?.({ preventScroll: true });
  }
  async function startSharing() {
    // Change runs only what is asked about, as the controls show it right now.
    if (!questionStands()) { render(); return; }
    const job = confirming;
    if (!job || !confirmArmed || store.state.busy || jobRunning()) return;
    confirming = null;
    if (selecting) { selecting = false; selected = new Set(); }
    render();
    jobBar.focus?.({ preventScroll: true });
    await store.changeSharing(job.ids, job.choice);
    render();
  }
  function jobSummary(progress) {
    if (progress.unsure) return 'Stopped. Not sure how many changed.';
    const head = progress.status === 'running' ? `Changing sharing: ${progress.done} of ${progress.total}`
      : `${progress.done} of ${progress.total} changed.`;
    const left = [progress.notYours && `${progress.notYours} not changed: not yours.`,
      progress.changed && `${plural(progress.changed, 'mark')} changed elsewhere, left as they are.`,
      progress.gone && `${progress.gone} deleted.`].filter(Boolean);
    return [head, ...left].join(' ');
  }
  function renderSelecting() {
    const { state } = store, busy = state.busy || jobRunning();
    if (selecting && !canSelect()) { selecting = false; selected = new Set(); }
    for (const id of [...selected]) if (!selectable(store.find(id))) selected.delete(id);
    if (confirming && (!state.ready || !store.canWrite())) confirming = null;
    selectButton.hidden = selecting || !canSelect();
    selectButton.disabled = busy || jobOpen();
    shareAllButton.hidden = selecting || !shareAllAvailable();
    shareAllButton.disabled = busy || jobOpen();
    listHead.hidden = !state.ready || (!state.undo.length && shareAllButton.hidden && selectButton.hidden);
    selectHead.hidden = bulkBar.hidden = !selecting;
    if (selecting) {
      const shown = shownSelectable();
      selectCount.textContent = `${pickedShown().length} selected`;
      const asking = Boolean(confirming);
      selectAll.disabled = busy || asking || shown.every(mark => selected.has(mark.id));
      selectNone.disabled = busy || asking || !selected.size;
      const options = sharingOptions(), value = options.includes(bulkVisibility.value) ? bulkVisibility.value : options[0];
      if ([...bulkVisibility.children].map(option => option.value).join() !== options.join())
        bulkVisibility.replaceChildren(...options.map(option => h(document, 'option', { value: option, text: VISIBILITY_LABEL[option] })));
      bulkVisibility.value = value;
      const accounts = state.audiences.map(row => row.account);
      if ([...bulkAccount.children].slice(1).map(option => option.value).join() !== accounts.join()) {
        const kept = bulkAccount.value;
        bulkAccount.replaceChildren(h(document, 'option', { value: '', text: 'Choose…' }), ...accounts.map(account => h(document, 'option', { value: account, text: accountLabel(account) })));
        bulkAccount.value = accounts.includes(kept) ? kept : '';
      }
      bulkAccount.hidden = value !== 'client';
      bulkVisibility.disabled = bulkAccount.disabled = busy || asking;
      bulkApply.disabled = busy || jobOpen() || !pickedShown().length || Boolean(confirming);
    }
    confirmBox.hidden = !confirming;
    if (confirming) confirmText.textContent = `Change sharing for ${plural(confirming.ids.length, 'mark')} to ${confirming.label}?`;
    confirmGo.disabled = busy;
    const progress = store.sharingProgress();
    jobBar.hidden = !progress;
    if (progress) {
      jobText.textContent = jobSummary(progress);
      jobResume.hidden = progress.status !== 'paused';
      jobResume.disabled = state.busy;
      jobClose.hidden = progress.status === 'running';
    }
  }

  function render() {
    const { state } = store;
    const active = document.activeElement;
    const asked = questionStands();
    const restoreFocus = hadMarksAccess && !state.ready && (pendingRestoreFocus?.()
      || (active && (panel.contains(active) || overlay.contains(active) || active.closest?.('.viewer-map-mark,.viewer-map-area,.viewer-map-group'))));
    const writeAccess = state.ready && state.capabilities.write;
    if (hadWriteAccess && !writeAccess) endMarkInput();
    hadMarksAccess = state.ready;
    hadWriteAccess = writeAccess;
    panel.hidden = !state.ready && !state.loading && !state.message || state.blocked;
    const writable = canWrite();
    status.textContent = state.message || (state.loading ? 'Loading marks…' : '');
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
    coordForm.hidden = !state.ready || !view.map;
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
      for (const control of [nameInput, categoryInput, noteInput, elevationInput, visibilitySelect, accountSelect, pointCoords, saveButton, ...picker.controls])
        control.disabled = !editable || state.busy;
      picker.render(draft);
      renderSuggestions();
      pointCoordsField.hidden = draft.geometry.type !== 'Point';
      coordReadout.textContent = readout(draft.geometry);
      elevationLabel.textContent = `NAVD88 Elevation (${elevationUnit(units())})`;
      visibilityField.hidden = !sessionScope || !canShare(draft) || state.capabilities.visibility.length < 2;
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
            : sharingValue(mark) !== defaultVisibility() && VISIBILITY_LABEL[sharingValue(mark)]].filter(Boolean).join(' · ') }));
      if (selecting) {
        // A tick for each of one's own marks; the row ticks it too.
        const can = selectable(mark), ticked = can && selected.has(mark.id);
        const tick = h(document, 'input', { type: 'checkbox', 'data-select-mark': mark.id, 'aria-label': 'Select ' + mark.name, disabled: !can || state.busy || Boolean(confirming) });
        tick.checked = ticked;
        on(tick, 'change', () => toggleSelected(mark.id, tick.checked));
        const row = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item', 'data-select-row': mark.id, 'aria-pressed': String(ticked), disabled: !can || state.busy || Boolean(confirming) }, icon, text);
        on(row, 'click', () => toggleSelected(mark.id, !selected.has(mark.id)));
        return h(document, 'li', { class: 'viewer-mark-selectable' }, tick, row);
      }
      if (!view.map) return h(document, 'li', {}, icon, text);
      const button = h(document, 'button', { type: 'button', class: 'viewer-mark-list-item', 'aria-current': mark.id === selectedId ? 'true' : false }, icon, text);
      on(button, 'click', () => select(mark.id));
      return h(document, 'li', {}, button);
    });
    // Ticking rebuilds the rows: the focus stays on the same mark's tick or row.
    const focusedTick = list.contains(active) ? active.getAttribute?.('data-select-mark') : null, focusedRow = list.contains(active) ? active.getAttribute?.('data-select-row') : null;
    list.replaceChildren(...rows);
    if (focusedTick || focusedRow) [...list.querySelectorAll(focusedTick ? 'input' : 'button')].find(node => node.getAttribute(focusedTick ? 'data-select-mark' : 'data-select-row') === (focusedTick || focusedRow))?.focus?.({ preventScroll: true });
    renderSelecting();
    // All and None: when the one pressed is spent, the focus goes to the other.
    if (active === selectAll && selectAll.disabled && !selectNone.disabled) selectNone.focus?.({ preventScroll: true });
    else if (active === selectNone && selectNone.disabled && !selectAll.disabled) selectAll.focus?.({ preventScroll: true });
    // A question dropped under the focus hands it back to what asks it.
    if (!asked && confirmBox.contains(active)) [selecting ? bulkApply : shareAllButton, activeTab()].find(node => node && !node.hidden && !node.disabled)?.focus?.({ preventScroll: true });
    searchInput.hidden = !state.marks.length;
    searchInput.disabled = Boolean(confirming);

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
    deletedNotice.textContent = state.deletedTruncated === true ? 'Only some recently deleted marks are shown.' : '';
    deletedNotice.hidden = !deletedNotice.textContent;
    deletedList.replaceChildren(...(state.deleted.length ? state.deleted.map(mark => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = markBadge(mark);
      const restore = h(document, 'button', { type: 'button', text: 'Restore', 'aria-label': 'Restore ' + mark.name,
        'data-restore-mark': mark.id, disabled: state.busy });
      on(restore, 'click', async () => {
        const held = store.hold(), pressed = document.activeElement === restore;
        let focusMoved = false;
        const watchFocus = ({ target }) => { if (target !== restore && target !== document.body) focusMoved = true; };
        const stillOwnsFocus = () => !focusMoved && [restore, document.body, null, undefined].includes(document.activeElement);
        if (pressed) {
          // The busy render removes this row before an access refusal can close Marks.
          pendingRestoreFocus = stillOwnsFocus;
          document.addEventListener('focusin', watchFocus);
        }
        try {
          const back = await store.restore(mark);
          if (!held.live()) return;
          if (back) { reveal(back); render(); }
          // Repainting detaches the pressed control. An unrelated open draft is
          // kept, and any focus the person chose during the request is respected.
          if (pressed && stillOwnsFocus() && boxOpen && tab === 'deleted') {
            const retry = [...deletedList.querySelectorAll('[data-restore-mark]')].find(button => button.dataset.restoreMark === mark.id);
            (retry || activeTab())?.focus?.({ preventScroll: true });
          }
        } finally {
          if (pendingRestoreFocus === stillOwnsFocus) pendingRestoreFocus = null;
          if (pressed) document.removeEventListener('focusin', watchFocus);
        }
      });
      return h(document, 'li', {}, icon, h(document, 'span', { class: 'viewer-mark-list-name' }, h(document, 'span', { text: mark.name }),
        h(document, 'small', { text: new Date(mark.deletedAt).toLocaleDateString() })), restore);
    }) : state.deletedTruncated === true ? [] : [h(document, 'li', { class: 'hint', text: `None in the last ${state.capabilities.recoveryDays} days.` })]));
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
    syncSharedRefresh();
    if (restoreFocus && [active, document.body, null, undefined].includes(document.activeElement)) {
      if (focusAfterAccessLoss) focusAfterAccessLoss();
      else (view.map && getMap()?.getContainer() || status).focus?.({ preventScroll: true });
    }
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
  on(shareAllButton, 'click', () => {
    if (!shareAllAvailable()) return;
    askSharing('all');
  });
  on(selectButton, 'click', () => setSelecting(true));
  on(selectDone, 'click', () => setSelecting(false));
  on(selectAll, 'click', () => { for (const mark of shownSelectable()) selected.add(mark.id); render(); });
  on(selectNone, 'click', () => { selected = new Set(); render(); });
  on(bulkVisibility, 'change', () => render());
  on(bulkApply, 'click', () => askSharing('bulk'));
  on(confirmCancel, 'click', () => closeConfirm());
  on(confirmGo, 'click', () => startSharing());
  // A held key does not answer the question: repeats are dropped, and a key press only
  // counts after the key that opened it was let go. A pointer answers at once.
  for (const button of [confirmCancel, confirmGo, shareAllButton, bulkApply]) {
    on(button, 'keydown', event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); });
  }
  on(confirmBox, 'keyup', () => { confirmArmed = true; });
  on(confirmBox, 'pointerdown', () => { confirmArmed = true; });
  on(confirmBox, 'mousedown', () => { confirmArmed = true; });
  on(jobResume, 'click', async () => { if (!store.state.busy) await store.resumeSharing(); });
  on(jobClose, 'click', () => { store.dismissSharing(); activeTab()?.focus?.({ preventScroll: true }); });
  on(historyButton, 'click', async () => {
    const current = store.find(selectedId), held = store.hold();
    if (!canHistory(current) || store.state.busy || unsaved()) return;
    const versions = await store.history(current);
    if (!versions || !held.live() || selectedId !== current.id || store.find(current.id)?.revision !== current.revision) return;
    history = { id: current.id, versions: [...versions].sort((a, b) => b.revision - a.revision) };
    render();
  });
  on(moveSave, 'click', () => saveDraft());
  on(moveCancel, 'click', () => { if (canMoveDraft()) cancelDraft(); });
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
      else if (draft && canWrite()) cancelDraft();
      else if (mode !== 'idle' && canWrite()) { setMode('idle'); render(); }
      else if (selectedId && !card.hidden) closeCard({ focusPin: true });
      else if (boxOpen && confirming) closeConfirm();
      else if (boxOpen && selecting) setSelecting(false);
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
    const picking = canWrite() && mode === 'Point' && crosshair, movingDraft = canMoveDraft(), step = ARROWS[event.key];
    if (!picking && !movingDraft) return;
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
      if (movingDraft) return saveDraft();
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
    if (!canWrite()) return;
    const point = typedPoint();
    if (!point || unsaved()) return;
    layer.focus({ type: 'Point', coordinates: point });
    startDraft({ type: 'Point', coordinates: point });
  });
  on(coordGo, 'click', () => {
    if (!view.map) return;
    const point = typedPoint();
    if (point) layer.focus({ type: 'Point', coordinates: point });
  });

  // Reads the coordinates field as it is now. Returns false (and shows why)
  // when the text is not a valid position, leaving the draft untouched.
  function applyPointCoordinates() {
    if (!draft || draft.geometry.type !== 'Point') return true;
    if (pointCoords.value === writtenCoords) return true;
    const parsed = parseCoordinateInput(pointCoords.value, { georef: georef() });
    if (!parsed.ok) { pointCoords.focus?.(); message(parsed.error || 'Enter coordinates.'); return false; }
    draft.geometry = { type: 'Point', coordinates: [Math.round(parsed.longitude * 1e8) / 1e8, Math.round(parsed.latitude * 1e8) / 1e8] };
    writeCoords();
    return true;
  }

  on(pointCoords, 'change', () => {
    if (applyPointCoordinates()) { store.clearMessage(); render(); }
  });
  // The category named in the box gives the mark its look, and its name while the name is still the automatic one.
  function applyCategory() {
    if (!draft) return;
    const choice = categoryChoice(), made = choice?.category || choice?.starter || null;
    draft.categoryId = choice?.category?.id || null;
    if (made) {
      Object.assign(draft, categoryStyle(made));
      colorInput.value = draft.color;
    }
    if (choice && (!nameInput.value.trim() || nameInput.value === draft.autoName)) draft.name = draft.autoName = nameInput.value = autoName(choice.name.slice(0, 90));
    render();
  }
  // All of them on focus; while typing, those whose name has the text in it.
  const suggestions = () => {
    const text = categoryInput.value.trim(), all = categoryChoices();
    return !text || all.some(choice => sameText(choice.name, text)) ? all : all.filter(choice => choice.name.toLowerCase().includes(text.toLowerCase()));
  };
  function renderSuggestions() {
    const shown = suggestOpen && draft && !categoryInput.disabled ? suggestions() : [];
    if (suggestIndex >= shown.length) suggestIndex = shown.length - 1;
    categoryOptions.hidden = !shown.length;
    categoryInput.setAttribute('aria-expanded', String(!categoryOptions.hidden));
    categoryOptions.replaceChildren(...shown.map((choice, index) => {
      const icon = h(document, 'span', { class: 'viewer-mark-list-icon' });
      icon.innerHTML = categoryBadge(choice.category || choice.starter);
      const option = h(document, 'li', { role: 'option', id: 'viewer-mark-category-option-' + index, 'data-category': choice.key,
        'aria-selected': String(index === suggestIndex) }, icon, h(document, 'span', { text: choice.name }));
      // Pressing keeps the focus in the box, so the list is still there for the click.
      on(option, 'mousedown', event => event.preventDefault());
      on(option, 'click', () => pickSuggestion(choice));
      return option;
    }));
    if (suggestIndex >= 0 && !categoryOptions.hidden) categoryInput.setAttribute('aria-activedescendant', 'viewer-mark-category-option-' + suggestIndex);
    else categoryInput.removeAttribute?.('aria-activedescendant');
  }
  function openSuggestions(next) {
    suggestOpen = next;
    suggestIndex = -1;
    renderSuggestions();
  }
  function pickSuggestion(choice) {
    categoryInput.value = choice.name;
    pickedKey = choice.key;
    suggestOpen = false;
    suggestIndex = -1;
    applyCategory();
    keepDraft();
  }
  on(categoryInput, 'focus', () => openSuggestions(true));
  on(categoryInput, 'click', () => { if (!suggestOpen) openSuggestions(true); });
  on(categoryInput, 'input', () => { suggestOpen = true; suggestIndex = -1; renderSuggestions(); });
  on(categoryInput, 'blur', () => openSuggestions(false));
  on(categoryInput, 'change', () => applyCategory());
  on(categoryInput, 'keydown', event => {
    const shown = categoryOptions.hidden ? [] : suggestions();
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      if (!suggestOpen || !shown.length) { openSuggestions(true); return; }
      suggestIndex = suggestIndex < 0 ? (step > 0 ? 0 : shown.length - 1) : (suggestIndex + step + shown.length) % shown.length;
      renderSuggestions();
    } else if (event.key === 'Enter' && suggestIndex >= 0 && shown[suggestIndex]) {
      event.preventDefault();
      pickSuggestion(shown[suggestIndex]);
    } else if (event.key === 'Escape' && !categoryOptions.hidden) {
      // Closes the list only; the mark stays open.
      event.preventDefault();
      openSuggestions(false);
    }
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
    if (!current || !canDelete(current) || store.state.busy) return;
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
    if (!draft || !canWrite() || (moving && !canMoveDraft())) return;
    // Enter or Save can arrive without a change event: never save the coordinates
    // the field showed before. Invalid text keeps the editor open and writes nothing.
    if (!applyPointCoordinates()) return;
    const values = readEditor();
    if (!values.name) { message('Give the mark a label.'); return; }
    if (Number.isNaN(values.elevationNavd88M)) { elevationInput.focus?.(); message('NAVD88 Elevation must be a number.'); return; }
    if (values.visibility === 'client' && !values.shareAccount) { message('Choose a client account to share with.'); return; }
    const changes = { ...values, icon: keepIcon(draft.icon), geometry: draft.geometry };
    // A category typed in full and saved without leaving the box still gives its look.
    const named = chosenCategory();
    if (named && draft.categoryId !== named.id) Object.assign(changes, categoryStyle(named));
    const held = store.hold(), open = draft, starter = chosenStarter(), fresh = newCategoryName();
    if (starter) {
      const made = await store.addStarter(starter);
      if (!made || !held.live() || draft !== open || !canWrite()) return;
      open.categoryId = changes.categoryId = made.id;
      categoryInput.value = made.name;
    } else if (fresh) {
      // A name typed for the first time is kept as a category of this map, in the mark's look.
      const made = await store.saveCategory({ name: fresh, color: changes.color, icon: changes.icon });
      if (!made || !held.live() || draft !== open || !canWrite()) return;
      open.categoryId = changes.categoryId = made.id;
      categoryInput.value = made.name;
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

  on(labelsSelect, 'change', () => { labels = labelsSelect.value; writePreference(preferenceStorage, LABELS_KEY, labels); render(); });
  on(groupToggle, 'change', () => { grouping = groupToggle.checked; writePreference(preferenceStorage, GROUP_KEY, grouping ? 'on' : 'off'); render(); });
  // True while the focus has not been taken anywhere else since.
  function focusKeeper() {
    const from = document.activeElement;
    return () => !draft && [from, document.body, null, undefined].includes(document.activeElement);
  }
  // Whether the last change can be undone now; an unsaved edit is said to be in the way.
  const undoNow = () => Boolean(store.state.undo.length) && !store.state.busy && !unsaved();
  function focusOutsideUndoBar() {
    if (boxOpen) activeTab()?.focus?.({ preventScroll: true });
    else layer.focusStop();
  }
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
      if (store.state.failure === 'undo_target_changed') renderBar();
      else barEntry = entry;
      clearTimer();
      barError = store.state.message;
      render();
      if (pressed && stays()) {
        if (undoBar.hidden) focusOutsideUndoBar();
        else (barUndo.hidden ? barClose : barUndo).focus?.({ preventScroll: true });
      }
    }
    return ok;
  }
  on(undoButton, 'click', () => undoLast());
  on(barUndo, 'click', () => undoLast({ focus: true }));
  on(barClose, 'click', () => {
    hideBar();
    focusOutsideUndoBar();
  });
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
      const count = await store.importMarks(parsed, { onImported: imported => { if (held.live()) reveal(...imported); } });
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
  on(document, 'visibilitychange', refreshInForeground);
  on(window, 'focus', refreshInForeground);
  on(window, 'pagehide', () => { pageSuspended = true; stopSharedRefresh(); });
  on(window, 'pageshow', () => { pageSuspended = false; refreshInForeground(); });

  render();

  return {
    store,
    // keepDraft is false when access was refused rather than expired: unsaved work goes too.
    async setScope(next, { keepDraft: mayReturn = true } = {}) {
      publicReadOnly = next?.readOnly === true;
      sessionScope = next?.mode === 'session';
      // A public link's labels and grouping are this tab's alone.
      const publicView = publicReadOnly || next?.mode === 'temporary';
      if (publicView !== publicPreferences) { publicPreferences = publicView; readPreferences(); }
      if (!mayReturn) recovery.clear();
      // Anyone else's unsaved work goes as soon as they are gone, map open or not.
      else if (sessionScope) recovery.read(next.key);
      if (!next || next.key !== scopeKey) {
        draftChecked = false;
        endMarkInput();
        // Nothing one person typed or picked stays in the panel for the next one.
        draft = null; selectedId = null; mode = 'idle'; drawing = null; history = null;
        suggestOpen = false;
        preview = null; placeChoice = null; several = false; crosshair = false;
        picker.close({ focus: false });
        boxOpen = false; picked = null;
        selecting = false; selected = new Set(); confirming = null;
        hideBar();
        barSeen = null;
        recoveredSeen = null;
        search = ''; tab = 'list'; armedDelete = null; categoryDraft = null; moving = false; deleteForGood = null;
        showCategoryIcon(DEFAULT_STYLE.icon);
        categoryColor.value = DEFAULT_STYLE.color;
        visibility.setScope(sessionScope && !publicReadOnly ? next.key : null);
        for (const input of [searchInput, coordInput, nameInput, categoryInput, noteInput, elevationInput, pointCoords, categoryName]) input.value = '';
        accountSelect.replaceChildren();
        categoryOptions.replaceChildren();
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
      stopSharedRefresh();
      store.dispose();
      layer.dispose();
      listeners.abort();
      panel.hidden = true;
      for (const element of [addButton, boxButton, hiddenButton, cross, strip, card, pick, box, undoBar]) element.remove();
      clearTimer();
    },
  };
}
