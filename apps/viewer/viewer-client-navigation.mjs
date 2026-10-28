/** The server supplies the portal origin; page parameters never choose a return destination. */
export function clientPortalTarget(session, { viewMode, topLevel } = {}) {
  if (viewMode !== 'session' || topLevel !== true || session?.audience !== 'client'
    || typeof session.clientPortalOrigin !== 'string') return null;
  try {
    const origin = new URL(session.clientPortalOrigin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.origin !== session.clientPortalOrigin || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) return null;
    return new URL('/portal', origin).href;
  } catch { return null; }
}

export function renderClientNavigation({ container, portal }, session, context) {
  if (!container || !portal) return false;
  const target = clientPortalTarget(session, context);
  container.hidden = !target;
  if (target) portal.href = target;
  else portal.removeAttribute('href');
  return Boolean(target);
}
