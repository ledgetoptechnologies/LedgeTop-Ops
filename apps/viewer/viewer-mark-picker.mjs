import { h } from './viewer-mark-dom.mjs';
import { ICONS_BY_GROUP, ICON_CHOICES, MARK_COLORS, colorName, iconMarkup, markIconName, safeColor } from './viewer-mark-style.mjs';

// Icon and colour for the open mark: search, ten named colours, icons by group,
// a live preview and the category's own style.
export function createMarkPicker({ document, on, getDraft, categoryStyleOf, onChange }) {
  const colorInput = h(document, 'input', { name: 'color', type: 'color', 'aria-label': 'Custom colour' });
  const swatches = MARK_COLORS.map(({ name, color }) => h(document, 'button', { type: 'button', class: 'viewer-mark-swatch', 'data-color': color, 'aria-label': name, title: name, style: `background:${color}` }));
  const iconButtons = ICON_CHOICES.map(({ name, label }) => h(document, 'button', { type: 'button', class: 'viewer-mark-icon', 'data-icon': name, 'aria-label': label, title: label }));
  const groups = ICONS_BY_GROUP.map(({ group, icons }) => ({ heading: h(document, 'span', { class: 'hint viewer-mark-icon-group', text: group }),
    buttons: iconButtons.filter(button => icons.some(icon => icon.name === button.dataset.icon)) }));
  const iconField = h(document, 'fieldset', { class: 'viewer-mark-icons' }, h(document, 'legend', { text: 'Icon' }),
    ...groups.flatMap(({ heading, buttons }) => [heading, ...buttons]));
  const search = h(document, 'input', { type: 'search', name: 'iconSearch', autocomplete: 'off', 'aria-label': 'Search icons', placeholder: 'Search icons' });
  const none = h(document, 'p', { class: 'hint', text: 'No icon by that name.', hidden: true });
  const preview = h(document, 'span', { class: 'viewer-mark-preview', 'aria-hidden': 'true' });
  const styleName = h(document, 'span');
  const toggle = h(document, 'button', { type: 'button', class: 'viewer-mark-style', 'aria-expanded': 'false', 'aria-controls': 'viewer-mark-picker' }, preview, styleName);
  const useCategory = h(document, 'button', { type: 'button', text: 'Use category style' });
  const done = h(document, 'button', { type: 'button', text: 'Done' });
  const body = h(document, 'div', { id: 'viewer-mark-picker', class: 'viewer-mark-picker', hidden: true }, search,
    h(document, 'fieldset', { class: 'viewer-mark-colors' }, h(document, 'legend', { text: 'Colour' }), ...swatches, colorInput),
    iconField, none, h(document, 'div', { class: 'viewer-mark-row' }, useCategory, done));
  const element = h(document, 'div', { class: 'viewer-mark-look' }, toggle, body);

  let open = false;
  function setOpen(next, { focus = true } = {}) {
    if (open === next) return;
    open = next;
    if (!open) search.value = '';
    onChange();
    if (focus) (open ? search : toggle).focus?.();
  }
  const pick = change => { const draft = getDraft(); if (draft) { Object.assign(draft, change); if (change.color) colorInput.value = change.color; onChange(); } };

  on(toggle, 'click', () => setOpen(!open));
  on(done, 'click', () => setOpen(false));
  on(search, 'input', () => onChange());
  for (const swatch of swatches) on(swatch, 'click', () => pick({ color: swatch.dataset.color }));
  on(colorInput, 'input', () => { const draft = getDraft(); if (draft) { draft.color = safeColor(colorInput.value); onChange(); } });
  for (const button of iconButtons) on(button, 'click', () => pick({ icon: button.dataset.icon }));
  on(useCategory, 'click', () => pick(categoryStyleOf()));

  return {
    element, colorInput, isOpen: () => open, close: options => setOpen(false, options),
    controls: [toggle, useCategory, search, colorInput, ...swatches, ...iconButtons],
    render(draft) {
      const point = draft.geometry.type === 'Point', color = safeColor(colorInput.value), icon = markIconName(draft.icon);
      const label = ICON_CHOICES.find(choice => choice.name === draft.icon)?.label;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      preview.innerHTML = iconMarkup(draft.icon, color, 22);
      styleName.textContent = ['Icon and colour', [point || draft.geometry.type === 'Polygon' ? label || 'Current icon' : null, colorName(color)].filter(Boolean).join(', ')].join(': ');
      for (const swatch of swatches) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
      const wanted = search.value.trim().toLowerCase();
      let shown = 0;
      for (const { heading, buttons } of groups) {
        let any = false;
        for (const button of buttons) {
          const choice = ICON_CHOICES.find(item => item.name === button.dataset.icon);
          button.hidden = Boolean(wanted) && !(choice.label + ' ' + choice.group).toLowerCase().includes(wanted);
          if (button.hidden) continue;
          any = true;
          shown += 1;
          button.setAttribute('aria-pressed', String(button.dataset.icon === icon && button.dataset.icon === draft.icon));
          if (open) button.innerHTML = iconMarkup(button.dataset.icon, color, 22);
        }
        heading.hidden = !any;
      }
      // A line has no icon of its own on the map.
      iconField.hidden = search.hidden = draft.geometry.type === 'LineString';
      none.hidden = iconField.hidden || shown > 0;
    },
  };
}
