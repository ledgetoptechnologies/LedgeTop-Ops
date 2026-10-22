// Size the saved collection to its actual first two cards, not a fixed pixel
// guess. Text wrapping, permission-specific actions and zoom all change height.
export function createMeasurementListLayout(list, { ResizeObserverClass = globalThis.ResizeObserver, computedStyle = globalThis.getComputedStyle } = {}) {
  let count = 0, rows = [], disposed = false;
  const measure = () => {
    if (disposed || count <= 2 || rows.length < 2) return;
    const heights = rows.map(row => row.getBoundingClientRect().height);
    if (heights.some(height => !Number.isFinite(height) || height <= 0)) return;
    const style = computedStyle?.(list) || {};
    const pixels = value => Number.parseFloat(value) || 0;
    const height = Math.ceil(heights[0] + heights[1] + pixels(style.rowGap) + pixels(style.paddingTop) + pixels(style.paddingBottom));
    if (list.style.maxHeight !== `${height}px`) list.style.maxHeight = `${height}px`;
  };
  const observer = typeof ResizeObserverClass === 'function' ? new ResizeObserverClass(measure) : null;
  return {
    update(recordCount, label = 'Saved measurements') {
      if (disposed) return;
      count = recordCount;
      list.dataset.empty = String(count === 0);
      list.dataset.scrollable = String(count > 2);
      list.setAttribute('tabindex', count > 2 ? '0' : '-1');
      list.setAttribute('aria-label', `${label}, ${count} ${count === 1 ? 'record' : 'records'}${count > 2 ? '. Scroll to see more.' : ''}`);
      observer?.disconnect();
      rows = [...(list.querySelectorAll?.('.measurement-row') || [])].slice(0, 2);
      if (count <= 2) {
        list.style.maxHeight = '';
        list.scrollTop = 0;
      } else {
        observer?.observe(list);
        rows.forEach(row => observer?.observe(row));
        measure();
      }
    },
    dispose() { disposed = true; observer?.disconnect(); rows = []; }
  };
}
