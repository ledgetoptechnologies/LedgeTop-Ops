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

export function renderStaffNavigation({ container, dashboard, models, logo, company }, session, context) {
  if (!container || !dashboard || !models) return false;
  const targets = staffNavigationTargets(session, context);
  container.hidden = !targets;
  if (company) company.hidden = Boolean(targets);
  for (const [name, anchor] of [['dashboard', dashboard], ['models', models], ['dashboard', logo]]) {
    if (!anchor) continue;
    if (targets) anchor.href = targets[name];
    else anchor.removeAttribute('href');
  }
  if (logo) {
    if (targets) logo.setAttribute('aria-label', 'Dashboard');
    else logo.removeAttribute('aria-label');
  }
  return Boolean(targets);
}

/** Includes drafts disarmed for a save and expiry snapshots kept only in memory. */
export function hasUnfinishedMeasurements(workspace, recovery) {
  return Boolean(workspace?.isDrawing?.() || recovery?.hasPending?.()
    || [...(workspace?.store?.statuses?.values?.() || [])]
      .some(status => status === 'Saving…' || status.startsWith('Not saved:')));
}

export function openViewerLeaveDialog({ documentRef, description, onClose, onLeave }) {
  const dialog = documentRef.createElement('dialog');
  dialog.className = 'staff-leave-dialog';
  dialog.setAttribute('aria-labelledby', 'staff-leave-title');
  dialog.setAttribute('aria-describedby', 'staff-leave-description');
  dialog.innerHTML = '<h2 id="staff-leave-title">Leave this model?</h2><p id="staff-leave-description"></p><div class="actions"><button type="button" data-stay autofocus>Stay</button><button type="button" data-leave>Leave</button></div>';
  dialog.querySelector('#staff-leave-description').textContent = description;
  const close = () => { dialog.remove(); onClose(); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.querySelector('[data-stay]').addEventListener('click', close);
  dialog.querySelector('[data-leave]').addEventListener('click', () => { close(); onLeave(); });
  documentRef.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-stay]').focus();
  return dialog;
}

/** Guard only same-tab exits; modified/new-tab links leave the draft in this tab. */
export function installStaffNavigationGuard({ container, links, hasUnfinishedWork,
  documentRef = document, navigate = href => window.location.assign(href) }) {
  let dialog = null;
  const listeners = [];
  for (const anchor of links.filter(Boolean)) {
    const click = event => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
        || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')
        || container.hidden || !anchor.hasAttribute('href') || !hasUnfinishedWork()) return;
      event.preventDefault();
      if (dialog) return;
      const destination = anchor.href;
      dialog = openViewerLeaveDialog({ documentRef, description: 'Your unfinished measurement will be lost.',
        onClose: () => {
          dialog = null;
          if (anchor.isConnected && !container.hidden && anchor.hasAttribute('href')) anchor.focus();
        },
        onLeave: () => {
          if (anchor.isConnected && !container.hidden && anchor.href === destination && anchor.hasAttribute('href')) navigate(destination);
        },
      });
    };
    anchor.addEventListener('click', click);
    listeners.push(() => anchor.removeEventListener('click', click));
  }
  return () => { for (const remove of listeners) remove(); dialog?.remove(); dialog = null; };
}
