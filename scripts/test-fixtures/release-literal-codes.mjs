// Test-only lexical coverage for fixed release refusals. Strings/comments are
// atomic, so a callback semicolon cannot terminate a surrounding need() call.
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    const prior = out.at(-1)?.value;
    if (c === '/' && (prior === undefined || ['(', '[', '{', '=', ',', ':', '?', '!', '&', '|', '=>',
      'return', 'throw', 'case'].includes(prior))) {
      // Regex punctuation must not change the surrounding call's depth.
      let characterClass = false; i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') characterClass = true;
        else if (source[i] === ']') characterClass = false;
        else if (source[i] === '/' && !characterClass) { i++; break; }
        i++;
      }
      while (/[A-Za-z]/u.test(source[i] ?? '')) i++;
      out.push({ kind: 'regex', value: '' }); continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c; let raw = ''; i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { raw += source[i++] + (source[i++] ?? ''); }
        else raw += source[i++];
      }
      i++; out.push({ kind: quote === '`' ? 'template' : 'string', value: raw }); continue;
    }
    const id = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(i));
    if (id) { out.push({ kind: 'id', value: id[0] }); i += id[0].length; continue; }
    if (source.startsWith('=>', i)) { out.push({ kind: 'punct', value: '=>' }); i += 2; continue; }
    out.push({ kind: 'punct', value: c }); i++;
  }
  return out;
}
function argumentsAt(rows, start) {
  const args = []; let begin = start + 1; const stack = ['('];
  for (let i = begin; i < rows.length; i++) {
    const t = rows[i]; if (t.kind !== 'punct') continue;
    if ('([{'.includes(t.value)) stack.push(t.value);
    else if (')]}'.includes(t.value)) {
      stack.pop();
      if (!stack.length) { args.push(rows.slice(begin, i)); return args; }
    } else if (t.value === ',' && stack.length === 1) { args.push(rows.slice(begin, i)); begin = i + 1; }
  }
  return [];
}
export function releaseLiteralCodes(source) {
  const rows = tokens(source), found = new Set();
  const add = row => { if (row?.kind === 'string' && CODE.test(row.value)) found.add(row.value); };
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    if (t.kind === 'id' && ['need', 'fail', 'Error'].includes(t.value) && rows[i + 1]?.value === '(') {
      const args = argumentsAt(rows, i + 1), arg = t.value === 'need' ? args.at(-1) : args[0];
      if (arg?.length === 1) add(arg[0]);
    }
    if (t.value === 'code' && rows[i + 1]?.value === ':') add(rows[i + 2]);
    if (t.kind === 'string' && rows[i - 1]?.value === '=' && rows[i + 1]?.value === ')' && rows[i + 2]?.value === '=>') add(t);
  }
  return found;
}
