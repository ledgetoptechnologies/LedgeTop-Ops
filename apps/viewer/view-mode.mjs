export const VIEWER_MODES = Object.freeze(['model', 'cloud', 'ortho', 'dsm', 'dtm']);

export function availableViewerModes({ meshSource, cloudMode, ortho, dsm, dtm }) {
  const modes = [];
  // A source GLB/OBJ is intentionally not a browser fallback. The model tab
  // becomes available only after a verified streaming tileset is published.
  if (meshSource === 'tiles') modes.push('model');
  if (cloudMode && cloudMode !== 'none') modes.push('cloud');
  if (ortho) modes.push('ortho');
  if (dsm) modes.push('dsm');
  if (dtm) modes.push('dtm');
  return modes;
}

export function chooseViewerMode(requested, available) {
  if (VIEWER_MODES.includes(requested) && available.includes(requested)) return requested;
  if (available.includes('model')) return 'model';
  if (available.includes('ortho')) return 'ortho';
  return available[0] || null;
}

export function viewerModeFromUrl(href) {
  try {
    const value = new URL(href, 'https://viewer.invalid').searchParams.get('view');
    return VIEWER_MODES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function viewerModeUrl(href, mode) {
  const url = new URL(href, 'https://viewer.invalid');
  if (VIEWER_MODES.includes(mode)) url.searchParams.set('view', mode);
  else url.searchParams.delete('view');
  return `${url.pathname}${url.search}${url.hash}`;
}
