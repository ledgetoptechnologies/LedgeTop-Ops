// Model-page rail: view modes (the existing #view-tabs buttons; main.js switchMode sets aria-pressed), a Tools button for the existing tool
// panel, and a Measure shortcut that main.js shows only when measuring is permitted. The rail adds
// no destinations and changes no access: it reuses the existing sidebar toggle and measurement panel.

export function installViewerRail({ documentRef = document, MutationObserverImpl = globalThis.MutationObserver } = {}) {
  const sidebar = documentRef.getElementById('sidebar');
  const toggle = documentRef.getElementById('sidebar-toggle');
  const tools = documentRef.getElementById('rail-tools');
  const measure = documentRef.getElementById('rail-measure');
  const panel = documentRef.getElementById('panel-measure');
  if (!sidebar || !toggle || !tools) return null;
  const syncTools = () => tools.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
  syncTools();
  // The sidebar can also be collapsed by the existing responsive start-up rule and its own toggle.
  const observer = MutationObserverImpl ? new MutationObserverImpl(syncTools) : null;
  observer?.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  // Reuse the existing toggle so canvas resizing and aria-expanded on it stay in one place.
  tools.addEventListener('click', () => toggle.click());
  measure?.addEventListener('click', () => {
    if (!panel) return;
    if (sidebar.classList.contains('collapsed')) toggle.click();
    panel.scrollIntoView?.({ block: 'start' });
    // Opening the panel only moves focus; it never starts a tool or changes a measurement.
    const target = panel.querySelector('button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])');
    (target || panel).focus?.({ preventScroll: true });
  });
  return { disconnect: () => observer?.disconnect() };
}
