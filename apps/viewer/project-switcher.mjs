/**
 * Fill the project switcher. Titles and IDs come from task records, so they are set as text and
 * properties, never parsed as HTML: a title such as `Site <b>A</b>` shows exactly those characters.
 */
import { openViewerLeaveDialog } from './viewer-staff-navigation.mjs';

export function bindProjectSwitcherNavigation(select, { queryKey, currentUrl, navigate, hasTemporaryMarks, discardTemporaryMarks,
  hasUnfinishedMeasurements, documentRef = select.ownerDocument }) {
  let dialog = null;
  const change = () => {
    if (dialog) return;
    const source = currentUrl();
    const original = new URL(source).searchParams.get(queryKey);
    const target = select.value;
    if (!target || target === original) return;
    const destination = new URL(source);
    destination.searchParams.set(queryKey, target);
    const marks = hasTemporaryMarks(), measurements = hasUnfinishedMeasurements();
    if (!marks && !measurements) {
      navigate(destination.href);
      return;
    }
    select.value = original ?? '';
    const description = marks && measurements ? 'Your temporary marks and unfinished measurement will be lost.'
      : marks ? 'Your temporary marks will be lost.' : 'Your unfinished measurement will be lost.';
    dialog = openViewerLeaveDialog({ documentRef, description,
      onClose: () => { dialog = null; select.focus(); },
      onLeave: () => {
        if (currentUrl() !== source || (hasTemporaryMarks() && !marks) || (hasUnfinishedMeasurements() && !measurements)) return;
        if (marks) discardTemporaryMarks();
        navigate(destination.href);
      },
    });
  };
  select.addEventListener('change', change);
  return () => { select.removeEventListener('change', change); dialog?.remove(); dialog = null; };
}

export function renderProjectSwitcherOptions(select, models) {
  const doc = select.ownerDocument;
  const options = models.map((model) => {
    const option = doc.createElement('option');
    option.value = String(model.id);
    option.textContent = String(model.title ?? '');
    return option;
  });
  select.replaceChildren(...options);
}
