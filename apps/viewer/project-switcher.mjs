/**
 * Fill the project switcher. Titles and IDs come from task records, so they are set as text and
 * properties, never parsed as HTML: a title such as `Site <b>A</b>` shows exactly those characters.
 */
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
