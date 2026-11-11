// The server remains the authority for capability, preset and submission checks.
const REQUIRED = new Set(['pc-ept', 'gltf', '3d-tiles']);
const FILE_OPTIONS = new Set(['align', 'cameras', 'boundary', 'geo', 'gcp', 'image-groups', 'input', 'output', 'project-path']);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
export function taskOptionDomain(spec) {
  let domain = spec.domain;
  if (typeof domain === 'string') {
    try { domain = JSON.parse(domain); } catch {
      const text = domain.trim().toLowerCase();
      // ODM documents zero as a special value for these exact options even
      // when their catalog uses a positive-domain label.
      if (text === 'positive float' && spec.type === 'float' && ['crop', 'pc-filter', 'pc-sample', 'auto-boundary-distance'].includes(spec.name)) return { min: 0 };
      if (['positive integer','positive int'].includes(text) && spec.type === 'int' && ['matcher-neighbors','matcher-order','dem-gapfill-steps','rolling-shutter-readout','video-limit'].includes(spec.name)) return { min: 0 };
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
  if (domain && typeof domain === 'object') {
    const keys=Object.keys(domain),allowed=new Set(['min','max','minExclusive','maxExclusive']);
    if(!keys.length||keys.some(key=>!allowed.has(key)))return {invalid:true};
    for(const bound of ['min','max'])if(Object.hasOwn(domain,bound)&&!Number.isFinite(domain[bound]))return {invalid:true};
    for(const [flag,bound] of [['minExclusive','min'],['maxExclusive','max']])if(Object.hasOwn(domain,flag)&&(typeof domain[flag]!=='boolean'||!Object.hasOwn(domain,bound)))return {invalid:true};
    if(Object.hasOwn(domain,'min')&&Object.hasOwn(domain,'max')&&(domain.min>domain.max||(domain.min===domain.max&&(domain.minExclusive||domain.maxExclusive))))return {invalid:true};
    return {...domain};
  }
  return null;
}
export function taskOptionRestriction(spec) {
  if (taskOptionDomain(spec)?.invalid) return 'This node option has an invalid domain and cannot be edited.';
  if (REQUIRED.has(spec.name)) return 'Required for Viewer outputs; enabled automatically.';
  if (FILE_OPTIONS.has(spec.name) || (['string', 'enum'].includes(spec.type) && /\b(?:file|directory|folder|path)\b/i.test(`${spec.domain || ''} ${spec.help || ''}`))) return 'This input needs a registered file or boundary workflow; arbitrary paths are not supported here.';
  // ODM exposes supported-choice settings as enum, not string. Only accept
  // its bounded string choice list; an unknown/malformed enum is not free text.
  if (spec.type === 'enum') {
    const choices = taskOptionDomain(spec)?.values;
    if (!choices?.length || !choices.every(value => typeof value === 'string' && value.length <= 4000)) return 'This node option type is not supported by this editor.';
  } else if (!['bool', 'int', 'float', 'string'].includes(spec.type)) return 'This node option type is not supported by this editor.';
  return null;
}
export function parseTaskOption(spec, raw) {
  if (taskOptionRestriction(spec)) throw new Error(taskOptionRestriction(spec));
  let value = raw;
  if (spec.type === 'bool') {
    if (raw === true || raw === 'true') value = true;
    else if (raw === false || raw === 'false') value = false;
    else throw new Error('Choose enabled or disabled.');
  } else if (spec.type === 'int' || spec.type === 'float') {
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(raw.trim()))) throw new Error('Enter a number.');
    value = Number(raw);
    if (!Number.isFinite(value) || (spec.type === 'int' && !Number.isSafeInteger(value))) throw new Error(spec.type === 'int' ? 'Enter a whole number.' : 'Enter a finite number.');
  } else if (typeof raw !== 'string' || raw.length > 4000) throw new Error('Enter text of at most 4,000 characters.');
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

// Presentation-only grouping of the node's advertised options (NodeODM-compatible /options), in the
// spirit of WebODM's task settings. Every advertised option is shown; unknown names fall into Other.
const OPTION_GROUPS = [
  ['quality', 'Quality & features', /^(feature-|min-num-features|matcher-|resize-to|sfm-|sift-|ignore-gsd|use-hybrid-bundle|sky-removal|bg-removal|video-)/],
  ['camera', 'Camera & calibration', /^(cameras$|camera-lens|use-fixed-camera-params|rolling-shutter|primary-band|radiometric-calibration)/],
  ['georeferencing', 'Georeferencing & GPS', /^(gps-|use-exif|force-gps|gcp|geo$|boundary|auto-boundary|crop)/],
  ['point-cloud', 'Point cloud', /^pc-/],
  ['mesh', 'Mesh & 3D', /^(mesh-|texturing-|use-3dmesh|gltf|3d-tiles|skip-3dmodel)/],
  ['elevation', 'Elevation models (DSM/DTM)', /^(dsm|dtm|dem-|smrf-)/],
  ['orthophoto', 'Orthophoto', /^(orthophoto-|fast-orthophoto|skip-orthophoto|cog|tiles|build-overviews)/],
  ['output', 'Output & performance', /^(max-concurrency|optimize-disk-space|split|sm-|merge|end-with|rerun|no-gpu|copy-to|skip-report|skip-band-alignment)/],
];
export function taskOptionGroup(name) {
  const match = OPTION_GROUPS.find(([, , pattern]) => pattern.test(String(name || '')));
  return match ? { id: match[0], label: match[1] } : { id: 'other', label: 'Other' };
}

export function mountTaskOptions({ container, provider = null, presetOptions = {}, title = 'Advanced processing options', helpText = 'Edit settings directly for this task. Reset restores the preset or node default. Changes do not modify your saved preset.', modifiedLabel = 'Modified for this task' }) {
  const model = createTaskOptionsModel({ provider, presetOptions }), document = container.ownerDocument;
  const root = document.createElement('details'); root.className = 'task-options-editor';
  const summary = document.createElement('summary'); summary.textContent = title; root.append(summary);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search options'; search.setAttribute('aria-label', 'Search processing options'); root.append(search);
  const help = document.createElement('p'); help.className = 'form-note'; help.textContent = helpText; root.append(help);
  const list = document.createElement('div'); list.className = 'task-options-list'; root.append(list);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); root.append(status); container.append(root);
  let rows = [], disposed = false, disabled = false;
  let groups = new Map();
  function filter() { const query = search.value.toLowerCase().trim(); for (const row of rows) row.element.hidden = !row.search.includes(query); for (const group of groups.values()) group.section.hidden = !group.rows.some(row => !row.element.hidden); }
  function groupFor(name) {
    const { id, label } = taskOptionGroup(name);
    if (!groups.has(id)) { const section = document.createElement('section'); section.className = 'task-options-group'; section.setAttribute('data-group', id); const heading = document.createElement('h4'); heading.textContent = label; section.append(heading); groups.set(id, { section, rows: [] }); }
    return groups.get(id);
  }
  function render() {
    list.replaceChildren(); rows = []; groups = new Map(); status.textContent = '';
    let optionIndex = 0;
    for (const entry of model.entries()) {
      const { spec } = entry, row = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = spec.name; row.append(legend);
      row.setAttribute('data-option', spec.name); row.setAttribute('data-option-index', String(optionIndex++));
      const info = document.createElement('p'); info.className = 'form-note'; info.textContent = `${entry.inheritedFrom}: ${entry.inherited === undefined || entry.inherited === null ? 'not specified' : String(entry.inherited)}. ${spec.help || ''}`; row.append(info);
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = entry.missing?'Remove retained change':'Reset'; reset.setAttribute('aria-label', entry.missing?`Remove retained change ${spec.name}`:`Reset ${spec.name} to ${entry.inheritedFrom.toLowerCase()}`); row.append(reset);
      const domain = taskOptionDomain(spec), choices = spec.type === 'bool' ? null : domain?.values;
      const control = document.createElement(choices ? 'select' : 'input'); control.setAttribute('aria-label', `${spec.name} override`);
      if (choices) {const current=entry.overridden?entry.value:entry.inherited;if(current!==undefined&&!choices.some(choice=>String(choice)===String(current))){const retained=document.createElement('option');retained.value=String(current);retained.textContent=`${String(current)} (no longer supported)`;control.append(retained)}for (const choice of choices) { const option = document.createElement('option'); option.value = String(choice); option.textContent = spec.type === 'bool' ? choice ? 'Enabled' : 'Disabled' : String(choice); control.append(option); }}
      else { control.type = spec.type === 'bool' ? 'checkbox' : ['int','float'].includes(spec.type) ? 'number' : 'text'; if (control.type === 'number') { control.step = spec.type === 'int' ? '1' : 'any'; if (domain?.min !== undefined) control.min = String(domain.min); if (domain?.max !== undefined) control.max = String(domain.max); } else control.maxLength = 4000; }
      control.setAttribute('aria-label', spec.name);
      function showValue(value) { control.value = String(value ?? ''); if (spec.type === 'bool') control.checked = value === true || value === 'true'; }
      showValue(entry.overridden ? entry.value : entry.inherited); control.disabled = disabled || Boolean(entry.restriction); row.append(control);
      const modified = document.createElement('span'); modified.className = 'form-note'; row.append(modified);
      function showModified(value) { modified.textContent = value ? modifiedLabel : ''; reset.disabled = disabled || !value; }
      showModified(entry.overridden);
      if (entry.restriction) { const note = document.createElement('p'); note.className = 'form-note'; note.textContent = entry.restriction; row.append(note); }
      function save() {
        if (disabled || entry.restriction) return;
        const raw = spec.type === 'bool' ? control.checked : control.value;
        let changed = true;
        try { changed = parseTaskOption(spec, raw) !== entry.inherited; } catch { /* Keep invalid drafts visible for validation. */ }
        model.setOverride(spec.name, changed ? raw : undefined); showModified(changed); status.textContent = '';
      }
      reset.addEventListener('click', () => { if (disabled || !entry.overridden&&!model.entries().find(item=>item.spec.name===spec.name)?.overridden) return; model.setOverride(spec.name, undefined);if(entry.missing){render();return}showValue(entry.inherited); showModified(false); status.textContent = ''; });
      control.addEventListener('input', save); control.addEventListener('change', save);
      const group = groupFor(spec.name), record = { element: row, search: `${spec.name} ${spec.help || ''} ${taskOptionGroup(spec.name).label}`.toLowerCase() };
      rows.push(record); group.rows.push(record); group.section.append(row);
    }
    // Sections in a fixed order so the layout stays predictable between nodes.
    for (const id of [...OPTION_GROUPS.map(([groupId]) => groupId), 'other']) if (groups.has(id)) list.append(groups.get(id).section);
    if (!rows.length) status.textContent = 'Select a node with available processing capabilities.';
    else status.textContent=model.validate().errors.map(error=>`${error.name}: ${error.message}`).join(' ');
    filter();
  }
  search.addEventListener('input', filter); render();
  return { getOptions: model.getOptions, validate() { const result = model.validate(); status.textContent = result.errors.map(error => `${error.name}: ${error.message}`).join(' '); return result; }, update(next) { if (!disposed && model.update(next)) render(); }, setDisabled(value) { if (!disposed) { disabled = Boolean(value); search.disabled = disabled; render(); } }, dispose() { disposed = true; root.remove(); } };
}
