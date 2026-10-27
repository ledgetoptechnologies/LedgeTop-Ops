// Explicit "Renew in this tab" offer shown inside the open recovery dialog
// when the normal renewal window could not complete. It never navigates on its
// own: the person must press the button, and must first acknowledge any work
// that a full-page navigation discards. Browser beforeunload guards registered
// elsewhere (busy uploads) still run; if the person cancels that prompt the
// page, its selections and this offer stay as they were.

const OFFER_CLASS = 'recovery-current-tab';

/** Plain-language list of what a full navigation discards, from the
 * workspace's navigation state ({pendingUpload, selectedFileCount, unsavedTaskDraft,
 * unsavedGcpMark, pendingGcpSave}). Selected files may be photos, models or GCP
 * files, so the copy says "files". */
export function describeDiscardedWork(state = {}) {
  const items = [];
  const count = Number.isSafeInteger(state.selectedFileCount) && state.selectedFileCount > 0 ? state.selectedFileCount : 0;
  if (state.pendingUpload) items.push('The upload in progress. Check its status after renewing before you start it again.');
  if (count) items.push(`${count} selected file${count === 1 ? '' : 's'} not uploaded yet. You'll need to select ${count === 1 ? 'it' : 'them'} again.`);
  if (state.unsavedTaskDraft) items.push("The new task form you haven't submitted.");
  if (state.pendingGcpSave) items.push('The GCP mark being saved. Check the saved marks after renewing before you save it again.');
  else if (state.unsavedGcpMark) items.push("The GCP mark you placed but haven't saved.");
  return items;
}

export function renderCurrentTabRecoveryOffer({
  documentRef = document, windowRef = window, container, navigationState = {}, continueInCurrentTab,
  resetDelayMs = 6_000,
}) {
  if (!container || typeof continueInCurrentTab !== 'function') return null;
  container.querySelector(`.${OFFER_CLASS}`)?.remove();
  const discarded = describeDiscardedWork(navigationState);
  const section = documentRef.createElement('section');
  section.className = OFFER_CLASS;
  section.setAttribute('aria-labelledby', 'recovery-current-tab-title');

  const title = documentRef.createElement('h3');
  title.id = 'recovery-current-tab-title';
  title.textContent = 'Renew in this tab instead';
  const intro = documentRef.createElement('p');
  intro.textContent = "The usual renewal didn't finish. You can renew in this tab instead: the page reloads, you sign in through Operations, and the workspace returns to the same project and task. Saved projects, tasks and measurements stay on the server; anything not yet saved on this page is not kept.";
  section.append(title, intro);

  let confirm = null;
  if (discarded.length) {
    const warning = documentRef.createElement('div');
    warning.className = 'recovery-current-tab-loss';
    warning.setAttribute('role', 'alert');
    const lead = documentRef.createElement('p');
    lead.textContent = 'Renewing in this tab discards:';
    const list = documentRef.createElement('ul');
    for (const item of discarded) { const li = documentRef.createElement('li'); li.textContent = item; list.append(li); }
    const label = documentRef.createElement('label');
    confirm = documentRef.createElement('input');
    confirm.type = 'checkbox';
    confirm.name = 'recovery-current-tab-confirm';
    label.append(confirm, documentRef.createTextNode(' I understand this work will be discarded.'));
    warning.append(lead, list, label);
    section.append(warning);
  }

  const status = documentRef.createElement('p');
  status.className = 'recovery-current-tab-status';
  status.setAttribute('role', 'status');
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = 'primary-button';
  button.textContent = 'Renew in this tab';
  const sync = () => { button.disabled = Boolean(confirm && !confirm.checked); };
  confirm?.addEventListener('change', sync);
  sync();

  let leaving = false;
  const markLeaving = () => { leaving = true; };
  windowRef.addEventListener('pagehide', markLeaving, { once: true });
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Renewing…';
    status.textContent = '';
    try {
      continueInCurrentTab();
    } catch {
      button.textContent = 'Renew in this tab';
      sync();
      status.textContent = 'This tab could not start renewal. Open Viewer from Operations again.';
      return;
    }
    // The page can't tell a cancelled leave-page prompt from a slow redirect,
    // so after a pause it re-enables the button with neutral wording instead
    // of claiming the renewal was cancelled.
    windowRef.setTimeout(() => {
      if (leaving || !section.isConnected) return;
      button.textContent = 'Renew in this tab';
      sync();
      status.textContent = 'Still on this page? You can try again or return to Operations.';
    }, resetDelayMs);
  });

  const actions = documentRef.createElement('div');
  actions.className = 'recovery-current-tab-actions';
  actions.append(button);
  section.append(actions, status);
  container.append(section);
  return section;
}
