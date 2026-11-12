// Viewer workspace sidebar: the same grouped sidebar as Operations and the Client Portal
// (@ltds/ui/app-sidebar), in plain DOM. Section ids, routing and permissions stay with the caller.

const ICONS = {
  dashboard: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  providers: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  background: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  diagnostics: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
};
export const WORKSPACE_NAV_GROUPS = [
  ['Workspace', [['dashboard', 'Dashboard']]],
  ['Processing', [['providers', 'Providers & nodes'], ['background', 'Background work'], ['trash', 'Recycle Bin'], ['diagnostics', 'Diagnostics']]],
];
const COLLAPSED_KEY = 'ltds.viewer.sidebar.collapsed';
const esc = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const icon = id => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id] || ''}</svg>`;

// Reading window.localStorage itself can throw (blocked storage, some embedded or private browsers), so the
// default is resolved inside the same try as the read or write. An explicitly supplied storage is used as is.
function resolveStorage(storage) { return storage === undefined ? globalThis.localStorage : storage; }
export function readNavCollapsed(storage) {
  try { return resolveStorage(storage)?.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
}
function saveNavCollapsed(value, storage) {
  try { resolveStorage(storage)?.setItem(COLLAPSED_KEY, String(value)); } catch { /* Collapsing still works for this visit. */ }
}

/** Renders the grouped sections; collapsed buttons keep their names as aria-label and tooltip. */
export function renderWorkspaceNav({ shell, container, collapseButton, section, onSelect }) {
  const collapsed = shell.classList.contains('nav-collapsed');
  container.innerHTML = WORKSPACE_NAV_GROUPS.map(([group, items]) => `<div class="nav-group"><span class="nav-group-label" aria-hidden="${collapsed}">${esc(group)}</span>${items.map(([id, label]) => {
    const current = section === id;
    return `<button type="button" class="nav-link ${current ? 'active' : ''}" data-section="${esc(id)}"${current ? ' aria-current="page"' : ''}${collapsed ? ` title="${esc(label)}" aria-label="${esc(label)}"` : ''}>${icon(id)}<span class="nav-label">${esc(label)}</span></button>`;
  }).join('')}</div>`).join('');
  for (const link of container.querySelectorAll('.nav-link')) link.onclick = () => onSelect(link.dataset.section);
  if (collapseButton) {
    const name = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    collapseButton.setAttribute('aria-label', name);
    collapseButton.title = name;
    collapseButton.setAttribute('aria-pressed', String(collapsed));
  }
}

/**
 * Wires the collapse rail (remembered between visits) and the phone drawer: the toggle reports
 * aria-expanded, opening moves focus into the menu, and Escape closes it and returns focus.
 */
export function installWorkspaceSidebar({ shell, toggle, collapseButton, container, rerender, documentRef = document, storage }) {
  shell.classList.toggle('nav-collapsed', readNavCollapsed(storage));
  const setOpen = open => {
    shell.classList.toggle('nav-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) container.querySelector('.nav-link')?.focus();
  };
  if (toggle) toggle.onclick = () => setOpen(!shell.classList.contains('nav-open'));
  if (collapseButton) collapseButton.onclick = () => {
    const next = !shell.classList.contains('nav-collapsed');
    saveNavCollapsed(next, storage);
    shell.classList.toggle('nav-collapsed', next);
    rerender();
  };
  documentRef.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !shell.classList.contains('nav-open')) return;
    setOpen(false);
    toggle?.focus();
  });
  return { close: () => setOpen(false) };
}

/** The platform status stays readable when the rail hides its text: a tooltip mirrors the label. */
export function setWorkspaceHealth({ dot, label, foot }, okay) {
  const text = okay ? 'Platform ready' : 'Attention needed';
  if (dot) dot.className = `health-dot ${okay ? 'good' : 'bad'}`;
  if (label) label.textContent = text;
  foot?.setAttribute('title', text);
}
