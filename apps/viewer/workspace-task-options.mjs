import { boundaryProblem } from './server/boundaryGeojson.mjs';
// The server remains the authority for capability, preset and submission checks.
const REQUIRED = new Set(['pc-ept', 'gltf', '3d-tiles']);
const FILE_OPTIONS = new Set(['align', 'cameras', 'boundary', 'geo', 'gcp', 'image-groups', 'input', 'output', 'project-path']);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
export function taskOptionDomain(spec) {
  let domain = spec.domain;
  if (typeof domain === 'string') {
    try { domain = JSON.parse(domain); } catch {
      const text = domain.trim().toLowerCase();
      if (/^positive (?:integer|int|float|number)$/.test(text)) return { min: 0, minExclusive: true };
      if (/^non[- ]?negative (?:integer|int|float|number)$/.test(text)) return { min: 0 };
      const bound = text.match(/^(?:int|integer|float|number|x)\s*(>=|>|<=|<)\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/);
      if (bound && Number.isFinite(Number(bound[2]))) return bound[1].startsWith('>') ? { min: Number(bound[2]), minExclusive: bound[1] === '>' } : { max: Number(bound[2]), maxExclusive: bound[1] === '<' };
      const range = text.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(<=|<)\s*(?:x|int|integer|float|number)\s*(<=|<)\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/);
      if (range && Number(range[1]) <= Number(range[4])) return { min: Number(range[1]), max: Number(range[4]), minExclusive: range[2] === '<', maxExclusive: range[3] === '<' };
      return null;
    }
  }
  if (Array.isArray(domain)) return domain.length <= 1000 && domain.every(scalar) ? { values: domain } : null;
  if (domain && typeof domain === 'object') return { ...(Number.isFinite(domain.min) ? { min: domain.min } : {}), ...(Number.isFinite(domain.max) ? { max: domain.max } : {}) };
  return null;
}
export function taskOptionRestriction(spec) {
  if (REQUIRED.has(spec.name)) return 'Required for Viewer outputs; enabled automatically.';
  // JSON options carry their content inline (for example a GeoJSON boundary),
  // never a server path, so they are editable as validated JSON text.
  if (spec.type !== 'json' && (FILE_OPTIONS.has(spec.name) || (['string', 'enum'].includes(spec.type) && /\b(?:file|directory|folder|path)\b/i.test(`${spec.domain || ''} ${spec.help || ''}`)))) return 'This input needs a registered file or boundary workflow; arbitrary paths are not supported here.';
  // ODM exposes supported-choice settings as enum, not string. Only accept
  // its bounded string choice list; an unknown/malformed enum is not free text.
  if (spec.type === 'enum') {
    const choices = taskOptionDomain(spec)?.values;
    if (!choices?.length || !choices.every(value => typeof value === 'string' && value.length <= 4000)) return 'This node option type is not supported by this editor.';
  } else if (!['bool', 'int', 'float', 'string', 'json'].includes(spec.type)) return 'This node option type is not supported by this editor.';
  return null;
}
// Short type hint shown after an option name, e.g. "(positive float)".
export function taskOptionTypeHint(spec) {
  const base = { int: 'integer', float: 'float', string: 'string', json: 'json' }[spec?.type];
  if (!base) return '';
  const domain = spec.type === 'json' ? null : taskOptionDomain(spec);
  if (domain?.values) return '';
  if (domain?.min === 0 && domain.max === undefined) return `${domain.minExclusive ? 'positive' : 'non-negative'} ${base}`;
  if (domain && (domain.min !== undefined || domain.max !== undefined)) return `${base} ${domain.min ?? ''}–${domain.max ?? ''}`;
  return base;
}
// Node help text with ODM's argparse placeholders filled in.
export function taskOptionDescription(spec) {
  const choices = taskOptionDomain(spec)?.values;
  return String(spec?.help || '').replace(/%\(choices\)s/g, choices ? choices.join(', ') : '').replace(/%\(default\)s/g, spec?.value === undefined || spec?.value === null ? '' : String(spec.value)).replace(/%%/g, '%').trim();
}
export function parseTaskOption(spec, raw) {
  if (taskOptionRestriction(spec)) throw new Error(taskOptionRestriction(spec));
  let value = raw;
  if (spec.type === 'bool') {
    if (raw === true || raw === 'true') value = true;
    else if (raw === false || raw === 'false') value = false;
    else throw new Error('Choose enabled or disabled.');
  } else if (spec.type === 'int' || spec.type === 'float') {
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) throw new Error('Enter a number.');
    value = Number(raw);
    if (!Number.isFinite(value) || (spec.type === 'int' && !Number.isSafeInteger(value))) throw new Error(spec.type === 'int' ? 'Enter a whole number.' : 'Enter a finite number.');
  } else if (typeof raw !== 'string' || raw.length > 4000) throw new Error('Enter text of at most 4,000 characters.');
  else if (spec.type === 'json') {
    try { JSON.parse(raw); } catch { throw new Error('Enter valid JSON.'); }
    if (spec.name === 'boundary') { const problem = boundaryProblem(raw); if (problem) throw new Error(problem); }
  }
  const domain = taskOptionDomain(spec);
  if (domain?.values && !domain.values.includes(value)) throw new Error('Choose one of the node’s supported values.');
  if (typeof value === 'number' && ((domain?.min !== undefined && value < domain.min) || (domain?.max !== undefined && value > domain.max))) throw new Error('Value is outside the node’s supported range.');
  if (typeof value === 'number' && ((domain?.minExclusive && value === domain.min) || (domain?.maxExclusive && value === domain.max))) throw new Error('Value is outside the node’s supported range.');
  return value;
}
export function createTaskOptionsModel({ provider = null, presetOptions = {} } = {}) {
  let specs = [], inherited = {}, overrides = new Map(), identity;
  function update({ provider: nextProvider = null, presetOptions: nextPreset = {}, preserveOverrides = false } = {}) {
    const nextIdentity = JSON.stringify([nextProvider?.id, nextProvider?.capabilityFingerprint, nextProvider?.capabilities?.options, nextPreset]);
    if (nextIdentity === identity) return false;
    identity = nextIdentity;if(!preserveOverrides)overrides = new Map();
    const names = new Set();
    specs = (Array.isArray(nextProvider?.capabilities?.options) ? nextProvider.capabilities.options : []).slice(0, 1000).filter(spec => {
      if (!spec || typeof spec.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(spec.name) || names.has(spec.name)) return false;
      names.add(spec.name); return true;
    });
    inherited = nextPreset && !Array.isArray(nextPreset) && typeof nextPreset === 'object' ? { ...nextPreset } : {};
    return true;
  }
  update({ provider, presetOptions });
  function setOverride(name, value) {
    if(value===undefined){overrides.delete(name);return;}
    const spec = specs.find(item => item.name === name);
    if (!spec) throw new Error('This option is not available on the selected node.');
    if (taskOptionRestriction(spec)) throw new Error(taskOptionRestriction(spec));
    if (value === undefined) overrides.delete(name); else overrides.set(name, value);
  }
  function validate() {
    const errors = [];
    if (overrides.size > 200) errors.push({ name: '', message: 'Use at most 200 task overrides.' });
    for (const [name, raw] of overrides) { try {const spec=specs.find(item => item.name === name);if(!spec)throw new Error('No longer supported by this node. Remove this retained change or choose a compatible node.');parseTaskOption(spec, raw); } catch (error) { errors.push({ name, message: error.message }); } }
    return { valid: errors.length === 0, errors };
  }
  function getOptions() {
    const checked = validate();
    if (!checked.valid) throw new Error(checked.errors.map(error => `${error.name}: ${error.message}`).join('\n'));
    const result = Object.fromEntries([...overrides].map(([name, value]) => [name, parseTaskOption(specs.find(item => item.name === name), value)]));
    if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw new Error('Task options exceed the request size limit.');
    return result;
  }
  return { update, setOverride, validate, getOptions, entries: () => [
    ...specs.map(spec => ({ spec, restriction: taskOptionRestriction(spec), inherited: REQUIRED.has(spec.name) ? true : Object.hasOwn(inherited, spec.name) ? inherited[spec.name] : spec.value, inheritedFrom: REQUIRED.has(spec.name) ? 'Viewer requirement' : Object.hasOwn(inherited, spec.name) ? 'Preset' : 'Node default', overridden: overrides.has(spec.name), value: overrides.has(spec.name) ? overrides.get(spec.name) : undefined })),
    ...[...overrides].filter(([name])=>!specs.some(spec=>spec.name===name)).map(([name,value])=>({spec:{name,type:'string'},restriction:'This node no longer supports this option. Your draft is retained until you explicitly remove it.',missing:true,overridden:true,value,inheritedFrom:'Previous draft'}))
  ] };
}

let editorSequence = 0;
// Compact WebODM-style list: name, type hint and an (i) button whose
// description is exposed on hover/focus and to screen readers via
// aria-describedby. No inline descriptions.
export function mountTaskOptions({ container, provider = null, presetOptions = {}, title = 'Task options' }) {
  const model = createTaskOptionsModel({ provider, presetOptions }), document = container.ownerDocument, prefix = `task-option-${++editorSequence}`;
  const make = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const root = make('details', 'task-options-editor');
  const summary = make('summary', '', title); root.append(summary);
  const toolbar = make('div', 'task-options-toolbar'); root.append(toolbar);
  const search = make('input'); search.type = 'search'; search.placeholder = 'Filter options'; search.setAttribute('aria-label', 'Filter processing options'); search.setAttribute('data-option-search', ''); toolbar.append(search);
  const changedLabel = make('label', 'task-options-changed'), changedOnly = make('input'); changedOnly.type = 'checkbox'; changedOnly.setAttribute('data-show-changed', ''); changedLabel.append(changedOnly, make('span', '', 'Show only changed')); toolbar.append(changedLabel);
  const list = make('div', 'task-options-list'); root.append(list);
  const status = make('p', 'task-options-status'); status.setAttribute('role', 'status'); root.append(status); container.append(root);
  let rows = [], disposed = false, disabled = false, renderEpoch = 0, openTip = null;
  // Tooltips: hover or keyboard focus shows; a tap or click pins it open and a
  // second tap, Escape, an outside tap or scrolling closes it. Placed with
  // fixed coordinates clamped to the viewport so it is never cut off.
  function placeTip(info, tip) {
    const view = document.defaultView; if (!view || !info.getBoundingClientRect || !tip.style) return;
    const margin = 8, box = info.getBoundingClientRect(), width = Math.max(0, Math.min(320, view.innerWidth - margin * 2));
    tip.style.width = `${width}px`; tip.style.left = `${Math.max(margin, Math.min(box.left, view.innerWidth - width - margin))}px`;
    const height = tip.offsetHeight || 0, below = box.bottom + 4, above = box.top - 4 - height;
    tip.style.top = `${below + height > view.innerHeight - margin && above >= margin ? above : Math.max(margin, Math.min(below, view.innerHeight - margin - height))}px`;
  }
  function hideTip() { if (!openTip) return; openTip.tip.hidden = true; openTip.info.removeAttribute?.('data-open'); openTip = null; }
  function showTip(info, tip, pinned) { if (openTip && openTip.tip !== tip) hideTip(); openTip = { info, tip, pinned: Boolean(pinned || (openTip?.tip === tip && openTip.pinned)) }; info.setAttribute('data-open', ''); tip.hidden = false; placeTip(info, tip); }
  const outside = event => { if (openTip && event.target !== openTip.info && event.target !== openTip.tip) hideTip(); };
  document.addEventListener?.('pointerdown', outside, true);
  function filter() { const query = search.value.toLowerCase().trim(); for (const row of rows) row.element.hidden = !row.search.includes(query) || Boolean(changedOnly.checked && !row.changed()); }
  function showErrors(errors) {
    const byName = new Map(errors.map(error => [error.name, error.message]));
    for (const row of rows) { const message = byName.get(row.name) || ''; row.error.textContent = message; row.error.hidden = !message; row.control.setAttribute('aria-invalid', String(Boolean(message))); }
    const general = errors.filter(error => !rows.some(row => row.name === error.name));
    status.textContent = general.map(error => error.message).join(' ');
  }
  function render() {
    hideTip(); renderEpoch++; list.replaceChildren(); rows = []; status.textContent = '';
    const entries = model.entries();
    entries.forEach((entry, index) => {
      const { spec } = entry, id = `${prefix}-${index}`, row = make('div', 'task-option'); row.setAttribute('data-option', spec.name); row.setAttribute('role', 'group'); row.setAttribute('aria-labelledby', `${id}-name`);
      const head = make('div', 'task-option-head'), name = make('label', 'task-option-name'); name.id = `${id}-name`; name.htmlFor = `${id}-control`;
      const hint = taskOptionTypeHint(spec); name.append(make('strong', '', spec.name)); if (hint) name.append(make('span', 'task-option-type', ` (${hint})`));
      const inherited = entry.inherited === undefined || entry.inherited === null || entry.inherited === '' ? 'not set' : String(entry.inherited);
      const description = [taskOptionDescription(spec), entry.missing ? '' : `${entry.inheritedFrom}: ${inherited}.`, entry.restriction || ''].filter(Boolean).join(' ');
      const info = make('button', 'task-option-info', 'i'); info.type = 'button'; info.setAttribute('aria-label', `About ${spec.name}`); info.setAttribute('aria-describedby', `${id}-tip`); info.setAttribute('data-option-info', '');
      const tip = make('span', 'task-option-tip', description); tip.id = `${id}-tip`; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
      info.addEventListener('mouseenter', () => showTip(info, tip, false)); info.addEventListener('mouseleave', () => { if (openTip?.tip === tip && !openTip.pinned) hideTip(); });
      info.addEventListener('focus', () => showTip(info, tip, false)); info.addEventListener('blur', () => { if (openTip?.tip === tip) hideTip(); });
      info.addEventListener('click', () => { if (openTip?.tip === tip && openTip.pinned) hideTip(); else showTip(info, tip, true); });
      info.addEventListener('keydown', event => { if (event.key === 'Escape' && openTip?.tip === tip) { event.preventDefault?.(); hideTip(); } });
      const reset = make('button', 'task-option-reset', entry.missing ? 'Remove' : '↺'); reset.type = 'button'; reset.setAttribute('data-option-reset', '');
      const resetLabel = entry.missing ? `Remove retained change ${spec.name}` : `Reset ${spec.name} to ${entry.inheritedFrom.toLowerCase()}`; reset.setAttribute('aria-label', resetLabel); reset.title = resetLabel;
      head.append(name, info, tip, reset); row.append(head);
      const domain = spec.type === 'json' ? null : taskOptionDomain(spec), choices = spec.type === 'bool' ? null : domain?.values;
      const control = make(choices ? 'select' : 'input'); control.id = `${id}-control`; control.setAttribute('aria-describedby', `${id}-tip ${id}-error`); control.setAttribute('data-option-control', spec.type); control.setAttribute('aria-label', spec.name);
      let field = control, loadButton = null, fileInput = null;
      if (choices) { const current = entry.overridden ? entry.value : entry.inherited; if (current !== undefined && !choices.some(choice => String(choice) === String(current))) { const retained = make('option', '', `${String(current)} (no longer supported)`); retained.value = String(current); control.append(retained); } for (const choice of choices) { const option = make('option', '', String(choice)); option.value = String(choice); control.append(option); } }
      else if (spec.type === 'bool') { control.type = 'checkbox'; field = make('label', 'task-option-check'); field.append(control, make('span', '', 'Enable')); }
      else { control.type = ['int', 'float'].includes(spec.type) ? 'number' : 'text'; if (control.type === 'number') { control.step = spec.type === 'int' ? '1' : 'any'; if (domain?.min !== undefined) control.min = String(domain.min); if (domain?.max !== undefined) control.max = String(domain.max); } else control.maxLength = 4000; }
      if (spec.type === 'json') {
        field = make('div', 'task-option-json'); fileInput = make('input'); fileInput.type = 'file'; fileInput.accept = '.json,.geojson,application/json,application/geo+json'; fileInput.hidden = true; fileInput.tabIndex = -1;
        loadButton = make('button', 'task-option-load', 'Load file'); loadButton.type = 'button'; loadButton.setAttribute('aria-label', `Load ${spec.name} from a JSON file`); loadButton.setAttribute('data-option-load', '');
        field.append(control, loadButton, fileInput);
      }
      const error = make('p', 'task-option-error'); error.id = `${id}-error`; error.hidden = true; error.setAttribute('data-option-error', '');
      row.append(field, error);
      function showValue(value) { control.value = String(value ?? ''); if (spec.type === 'bool') control.checked = value === true || value === 'true'; }
      showValue(entry.overridden ? entry.value : entry.inherited); control.disabled = disabled || Boolean(entry.restriction); if (loadButton) loadButton.disabled = control.disabled;
      let changed = entry.overridden;
      function showModified(value) { changed = value; reset.hidden = !value; reset.disabled = disabled || !value; row.classList?.toggle?.('is-changed', Boolean(value)); }
      showModified(entry.overridden);
      function save() {
        if (disabled || entry.restriction) return;
        const raw = spec.type === 'bool' ? control.checked : control.value;
        let isChanged = true;
        if (spec.type === 'json' && !String(raw).trim()) isChanged = false;
        else { try { isChanged = parseTaskOption(spec, raw) !== entry.inherited; } catch { /* Keep invalid drafts visible for validation. */ } }
        model.setOverride(spec.name, isChanged ? raw : undefined); showModified(isChanged); showErrors(model.validate().errors); filter();
      }
      reset.addEventListener('click', () => { if (disabled || !model.entries().find(item => item.spec.name === spec.name)?.overridden) return; model.setOverride(spec.name, undefined); if (entry.missing) { render(); return; } showValue(entry.inherited); showModified(false); showErrors(model.validate().errors); filter(); });
      control.addEventListener('input', save); control.addEventListener('change', save);
      loadButton?.addEventListener('click', () => { if (!disabled && !control.disabled) { fileInput.value = ''; fileInput.click(); } });
      let readId = 0;
      fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0], epoch = renderEpoch, current = ++readId; if (!file || disabled) return;
        if (file.size > 4000) { error.textContent = 'Choose a JSON file of at most 4,000 characters.'; error.hidden = false; return; }
        let text;
        try { text = await file.text(); } catch { if (!disposed && epoch === renderEpoch && current === readId) { error.textContent = 'The file could not be read.'; error.hidden = false; } return; }
        // A newer read, a node or preset change, or a re-render wins.
        if (disposed || disabled || epoch !== renderEpoch || current !== readId) return;
        control.value = text; save();
      });
      rows.push({ name: spec.name, element: row, control, error, changed: () => changed, search: spec.name.toLowerCase() }); list.append(row);
    });
    if (!rows.length) status.textContent = 'No processing node selected';
    else showErrors(model.validate().errors);
    filter();
  }
  search.addEventListener('input', filter); changedOnly.addEventListener('change', filter); list.addEventListener('scroll', hideTip, { passive: true }); render();
  return {
    getOptions: model.getOptions,
    validate() { const result = model.validate(); showErrors(result.errors); return result; },
    update(next) { if (!disposed && model.update(next)) render(); },
    // Programmatic value (e.g. a boundary drawn on the photo map); null clears it.
    setValue(name, value) { if (disposed) return; model.setOverride(name, value === null ? undefined : value); render(); },
    supports(name, type) { return model.entries().some(entry => entry.spec.name === name && !entry.missing && !entry.restriction && (!type || entry.spec.type === type)); },
    setDisabled(value) { if (!disposed) { disabled = Boolean(value); search.disabled = disabled; render(); } },
    dispose() { disposed = true; renderEpoch++; hideTip(); document.removeEventListener?.('pointerdown', outside, true); root.remove(); },
  };
}
