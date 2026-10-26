/** Fixed Operations destinations from server-owned session metadata only. */
export function staffNavigationTargets(session, { viewMode, topLevel } = {}) {
  if (viewMode !== 'session' || topLevel !== true || session?.audience !== 'ops'
    || typeof session.operationsOrigin !== 'string') return null;
  try {
    const origin = new URL(session.operationsOrigin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.origin !== session.operationsOrigin || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) return null;
    return {
      dashboard: new URL('/', origin).href,
      models: new URL('/viewer', origin).href,
    };
  } catch { return null; }
}

export function renderStaffNavigation({ container, dashboard, models }, session, context) {
  if (!container || !dashboard || !models) return false;
  const targets = staffNavigationTargets(session, context);
  container.hidden = !targets;
  for (const [name, anchor] of [['dashboard', dashboard], ['models', models]]) {
    if (targets) anchor.href = targets[name];
    else anchor.removeAttribute('href');
  }
  return Boolean(targets);
}
