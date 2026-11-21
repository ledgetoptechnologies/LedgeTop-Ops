import {clientPortalTarget} from './viewer-client-navigation.mjs';
import {staffNavigationTargets} from './viewer-staff-navigation.mjs';

const terminalKeys = new WeakMap();

/** Terminal authorization failures never replay an expired/revoked capability. */
export function viewerFailureState(error, fallback = 'Could not load this link') {
  const status = error?.status;
  if (status === 410) return {title: 'Link expired', detail: 'Reopen this model from the application that shared it, or ask the link owner for a new link.', retry: false};
  if ([401, 403, 404].includes(status)) return {
    title: status === 404 ? 'Link not found' : 'Viewer access unavailable',
    detail: 'Reopen the model from the application that shared it. If you still need access, contact its owner or your administrator.', retry: false,
  };
  return {title: fallback, detail: 'The Viewer could not finish loading. Try again, or reopen the model from the application that shared it.',
    retry: status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)};
}

/** Clone only a visible fixed destination already rendered for this server session. */
export function visibleViewerReturn(dom, session, context) {
  const portal = clientPortalTarget(session, context);
  const models = staffNavigationTargets(session, context)?.models;
  for (const [link, href, label] of [[dom.clientPortal, portal, 'Back to Client Portal'], [dom.staffModels, models, 'Back to 3D models']]) {
    if (href && link?.hasAttribute('href') && link.href === href && !link.hidden && !link.closest('[hidden]')) return {href, label};
  }
  return null;
}

export function clearViewerTerminalState({surface, actions}) {
  if (!surface) return;
  surface.classList.remove('final');
  terminalKeys.delete(surface);
  for (const key of ['role', 'aria-labelledby', 'aria-describedby']) surface.removeAttribute(key);
  if (actions) { actions.hidden = true; actions.replaceChildren(); }
}

/** Focus a named terminal message once per transition; ordinary progress never steals focus. */
export function renderViewerTerminalState({surface, title, detail, actions}, state,
  {documentRef, retry = null, back = null} = {}) {
  if (!surface?.classList || !title || !detail || !documentRef) return;
  const key = JSON.stringify([state.title, state.detail, Boolean(retry && state.retry), back?.href, back?.label]);
  if (surface.classList.contains('final') && terminalKeys.get(surface) === key) return;
  terminalKeys.set(surface, key);
  surface.classList.add('final');
  surface.setAttribute('role', 'alert');
  surface.setAttribute('aria-labelledby', title.id);
  surface.setAttribute('aria-describedby', detail.id);
  title.textContent = state.title; detail.textContent = state.detail;
  const children = [];
  if (retry && state.retry) {
    const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = 'Try again';
    button.addEventListener('click', retry); children.push(button);
  }
  if (back) { const link = documentRef.createElement('a'); link.href = back.href; link.textContent = back.label; children.push(link); }
  if (actions) { actions.replaceChildren(...children); actions.hidden = children.length === 0; }
  title.setAttribute('tabindex', '-1'); title.focus({preventScroll: true});
}
