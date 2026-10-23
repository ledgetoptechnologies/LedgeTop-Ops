/** Offline evidence generator for retained UI assets. It walks one local build
 * tree, follows every reference reachable from the entry HTML, and reports
 * what an already-open tab of that build can request. It performs no network,
 * provider, staging or production calls and cannot upload or activate anything.
 * Its output is evidence for review, never an approved or complete inventory:
 * live byte equality, build provenance and historical versions stay unproven
 * here and are reported as open obligations. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_FILES = 20_000, MAX_BYTES = 32 * 1024 * 1024;
// Extensions a browser can fetch as a sub-resource of the built UI.
const ASSET_EXT = /\.(?:m?js|css|map|html?|json|webmanifest|wasm|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|txt|xml|pdf)$/i;
const HASHED = /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const TEXT_KINDS = { '.html': 'html', '.htm': 'html', '.css': 'css', '.js': 'js', '.mjs': 'js', '.json': 'json', '.webmanifest': 'json', '.svg': 'svg' };

function safeUrlPath(value) {
  need(typeof value === 'string' && value.startsWith('/') && value.length <= 1024, 'Invalid asset path');
  need(!/%(?:2e|2f|5c)/i.test(value) && !value.includes('\\') && !value.includes('//'), 'Encoded or ambiguous asset path');
  for (const segment of value.slice(1).split('/'))
    need(segment && segment !== '.' && segment !== '..' && !/[\u0000-\u001f]/.test(segment), 'Unsafe asset path segment');
  return value;
}

/** Every regular file under root, keyed by URL path. Symlinks, hardlinks and
 * case collisions fail closed because they make served bytes ambiguous. */
export function readTree(root) {
  need(typeof root === 'string' && path.isAbsolute(root), 'An absolute local build directory is required');
  const base = path.resolve(root), files = new Map(), lower = new Set();
  need(fs.lstatSync(base).isDirectory() && !fs.lstatSync(base).isSymbolicLink(), 'Build root must be a real directory');
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
      need(!stat.isSymbolicLink(), `Symlink in build tree: ${entry.name}`);
      if (stat.isDirectory()) { walk(full); continue; }
      need(stat.isFile() && stat.nlink === 1, `Only unlinked regular files are supported: ${entry.name}`);
      need(stat.size <= MAX_BYTES && files.size < MAX_FILES, 'Build tree exceeds evidence bounds');
      const url = safeUrlPath('/' + path.relative(base, full).split(path.sep).join('/'));
      need(!lower.has(url.toLowerCase()), `Case-colliding asset path: ${url}`); lower.add(url.toLowerCase());
      const bytes = fs.readFileSync(full);
      files.set(url, { path: url, size: bytes.length, sha256: sha256(bytes), bytes });
    }
  })(base);
  need(files.size > 0, 'Build tree is empty');
  return files;
}

/** Resolves one reference against the referencing file. Returns null for
 * references that never reach this tree (data:, blob:, fragments). */
export function resolveReference(raw, fromPath, base = fromPath) {
  const value = raw.trim();
  if (!value || value.startsWith('#') || /^(?:data|blob|about|javascript|mailto|tel):/i.test(value)) return null;
  if (/^(?:https?:)?\/\//i.test(value)) return { external: value };
  need(!/^[a-z][a-z0-9+.-]*:/i.test(value), `Unsupported reference scheme: ${value}`);
  // The URL parser decodes %2e%2e into a traversal, so reject before parsing.
  need(!/%(?:2e|2f|5c)/i.test(value.split(/[?#]/)[0]), `Encoded or ambiguous asset path: ${value}`);
  const url = new URL(value, `https://closure.invalid${base}`);
  need(url.origin === 'https://closure.invalid', `Reference escapes the build origin: ${value}`);
  return { path: safeUrlPath(decodeURI(url.pathname)) };
}

/** Cooked value of a JS string literal body, so './lazy.js' is seen as
 * the './lazy.js' the runtime loads. Unknown escapes throw. */
export function decodeJsString(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (whole, escape, offset) => {
    if (/^[ux]/.test(escape) && escape.length > 1) return String.fromCodePoint(parseInt(escape.replace(/^u\{?|^x|\}$/g, ''), 16));
    if (/^(?:\r\n|\n|\r|\u2028|\u2029)$/.test(escape)) return '';
    if (escape === '0' && !/[0-9]/.test(body[offset + 2] ?? '')) return '\0';
    if (/^[ux0-9]$/.test(escape)) throw new Error('Unsupported escape in string literal');
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }[escape] ?? escape;
  });
}

const STRING = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`;
const literalBody = quoted => decodeJsString(quoted.slice(1, -1));

// String literals without interpolation. Template literals with ${} are
// returned separately because their target is computed at runtime.
function jsStrings(text) {
  const out = [], computed = [], undecodable = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`])*)`/g;
  for (let m; (m = re.exec(text));) {
    const body = m[3] !== undefined ? m[3] : m[2];
    if (m[3] !== undefined && body.includes('${')) { computed.push(body.replace(/\$\{[^}]*\}/g, '${}')); continue; }
    try { out.push(decodeJsString(body)); } catch { undecodable.push(body.slice(0, 80)); }
  }
  return { out, computed, undecodable };
}

// A literal is treated as a URL reference when it is shaped like one; anything
// asset-shaped that does not resolve becomes an unresolved obligation.
const urlShaped = s => /^(?:\.{1,2}\/|\/|assets\/)/.test(s) && !/\s/.test(s) && s.length <= 1024;
const assetShaped = s => !/\s/.test(s) && s.length <= 1024 && ASSET_EXT.test(s.split(/[?#]/)[0]);

// HTML attribute values, quoted or unquoted.
function attributes(text, names) {
  const re = new RegExp(String.raw`\s(${names})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))`, 'gi');
  return [...text.matchAll(re)].map(m => ({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] }));
}

/** References out of one text file, plus anything that cannot be resolved
 * statically. ignorePrefixes names root-relative routes served by the Worker
 * (e.g. /api/) that are not static assets. */
export function extractReferences(file, text, { ignorePrefixes = [] } = {}) {
  const kind = TEXT_KINDS[path.extname(file).toLowerCase()];
  const refs = [], unresolved = [];
  const add = (value, via, base) => refs.push({ value, via, ...(base ? { base } : {}) });
  if (!kind) return { refs, unresolved };
  const fromCss = raw => {
    // Inline data: images can carry their own url(#id) references; they never
    // reach the server, so drop them before scanning.
    const css = raw.replace(/url\(\s*(["'])data:[\s\S]*?\1\s*\)/gi, 'url()').replace(/url\(\s*data:[^)]*\)/gi, 'url()');
    for (const m of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) add(m[2], 'css-url');
    for (const m of css.matchAll(/@import\s+(["'])([^"']+)\1/gi)) add(m[2], 'css-import');
    if (/url\(\s*(?:var\(|\$|attr\()/i.test(css)) unresolved.push({ from: file, kind: 'computed-css-url', detail: 'url() argument is computed' });
  };
  const fromJs = source => {
    // Vite's preload dependency map names chunks relative to the base ("/"),
    // not to the chunk holding it. Only that recognized array gets base "/";
    // it is then blanked so the generic scan below does not re-read it.
    const js = source.replace(/(__vite__mapDeps\s*=[^;]*?m\.f\s*=\s*)\[([^\]]*)\]/g, (whole, head, list) => {
      for (const m of list.matchAll(new RegExp(STRING, 'g'))) {
        try { add(literalBody(m[0]), 'vite-preload-map', '/'); }
        catch { unresolved.push({ from: file, kind: 'unsupported-escape', detail: m[0].slice(0, 80) }); }
      }
      return `${head}[]`;
    });
    // Literal arguments in loading contexts are references whatever their shape
    // ('worker.js' is as real as './worker.js'). Static and dynamic import()
    // need no context: browsers reject bare specifiers, and './' or '/' forms
    // are caught by the literal scan below.
    const literal = (quoted, then) => {
      try { then(literalBody(quoted)); }
      catch { unresolved.push({ from: file, kind: 'unsupported-escape', detail: quoted.slice(0, 80) }); }
    };
    for (const m of js.matchAll(new RegExp(String.raw`new\s+URL\s*\(\s*(${STRING})\s*,\s*import\.meta\.url\s*\)`, 'g')))
      literal(m[1], value => add(value, 'new-url'));
    // importScripts resolves against the worker script that calls it.
    for (const m of js.matchAll(new RegExp(String.raw`\bimportScripts\s*\(\s*(${STRING})`, 'g')))
      literal(m[1], value => add(value, 'import-scripts'));
    // new Worker('x.js') and serviceWorker.register('x.js') resolve against the
    // page's address, which on a single-page app can be any route.
    for (const m of js.matchAll(new RegExp(String.raw`\b(?:serviceWorker\.register|new\s+(?:Shared)?Worker)\s*\(\s*(${STRING})`, 'g')))
      literal(m[1], value => {
        if (value.startsWith('/') || /^(?:https?:)?\/\//i.test(value)) add(value, 'worker');
        else unresolved.push({ from: file, kind: 'document-relative-url', detail: `${value} resolves against the page address` });
      });
    const { out, computed, undecodable } = jsStrings(js);
    // Minified code can make the literal scan pair quotes across regex
    // literals; only path-shaped bodies are worth an obligation.
    for (const s of undecodable)
      if (urlShaped(s.replace(/\\./g, '')) && assetShaped(s.replace(/\\./g, '')))
        unresolved.push({ from: file, kind: 'unsupported-escape', detail: s });
    for (const s of out) if (urlShaped(s) && ASSET_EXT.test(s.split(/[?#]/)[0])) add(s, 'js-literal');
    // Without a full JS parser, a regex literal can throw quote pairing off and
    // hide a real reference. A second, pairing-independent scan of quoted
    // path-shaped text keeps the result a superset.
    for (const m of js.matchAll(/["'`]((?:\.{1,2}\/|\/|assets\/)[^"'`\s\\]{1,1024})["'`]/g))
      if (assetShaped(m[1]) && !m[1].includes('${')) add(m[1], 'js-literal');
    for (const s of out) if (/^\/?assets\/?$/.test(s)) unresolved.push({ from: file, kind: 'computed-asset-path', detail: `bare asset directory literal "${s}" suggests a runtime-built path` });
    // Route and API templates (`/portal/${id}`) are navigation, not files. Only
    // templates whose fixed text names an asset location or extension count.
    for (const s of computed) {
      if (ignorePrefixes.some(p => s.startsWith(p))) continue;
      const fixed = s.split(/[?#]/)[0];
      if (/(?:^|\/)assets\//.test(fixed) || (urlShaped(fixed) && ASSET_EXT.test(fixed)))
        unresolved.push({ from: file, kind: 'computed-template', detail: `template literal \`${s}\`` });
    }
    // An import() argument must start like an expression; regex sources in
    // string literals ("import(?:...") are not calls.
    for (const m of js.matchAll(/\bimport\s*\(\s*([A-Za-z_$`'"][^)]*)\)/g))
      if (!/^\s*(["'`])[^"'`$]*\1\s*$/.test(m[1]) && !/^__vite/.test(m[1].trim())) unresolved.push({ from: file, kind: 'dynamic-import', detail: `import(${m[1].trim().slice(0, 80)})` });
    for (const m of js.matchAll(/new\s+URL\s*\(\s*([^,)]+),\s*import\.meta\.url\s*\)/g))
      if (!/^\s*(["'])[^"']*\1\s*$/.test(m[1])) unresolved.push({ from: file, kind: 'computed-url', detail: `new URL(${m[1].trim().slice(0, 80)}, import.meta.url)` });
    for (const m of js.matchAll(/\b(?:serviceWorker\.register|importScripts|new\s+(?:Shared)?Worker)\s*\(\s*([^,)]+)/g))
      if (!/^\s*(["'])[^"']*\1\s*$/.test(m[1]) && !/^\s*new\s+URL\b/.test(m[1])) unresolved.push({ from: file, kind: 'computed-worker', detail: m[0].slice(0, 80) });
    for (const m of js.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)) add(m[1], 'source-map');
  };
  if (kind === 'html' || kind === 'svg') {
    for (const { name, value } of attributes(text, 'src|href|poster|data|xlink:href|content')) {
      // <meta content> is mostly prose; only URL-shaped values count.
      if (name === 'content' && !urlShaped(value)) continue;
      add(value, 'html-attr');
    }
    for (const { value } of attributes(text, 'srcset|imagesrcset'))
      for (const candidate of value.split(',')) { const url = candidate.trim().split(/\s+/)[0]; if (url) add(url, 'srcset'); }
    for (const m of text.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) fromJs(m[1]);
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) fromCss(m[1]);
    for (const { value } of attributes(text, 'style')) fromCss(value);
  } else if (kind === 'css') fromCss(text);
  else if (kind === 'js') fromJs(text);
  else if (kind === 'json') {
    let value; try { value = JSON.parse(text); } catch { unresolved.push({ from: file, kind: 'invalid-json', detail: 'cannot parse' }); return { refs, unresolved }; }
    (function visit(node) {
      // Manifests use bare relative paths ("icons/icon.png") resolved against
      // the manifest URL, so any asset-shaped string counts.
      if (typeof node === 'string') { if (assetShaped(node) && !/^[a-z][a-z0-9+.-]*:/i.test(node)) add(node, 'json-string'); }
      else if (node && typeof node === 'object') for (const v of Object.values(node)) visit(v);
    })(value);
  }
  return { refs: refs.filter(r => !ignorePrefixes.some(p => r.value.startsWith(p))), unresolved };
}

/** Reachable closure from the entry pages of one build tree. */
export function computeClosure({ root, entries = ['/index.html'], ignorePrefixes = ['/api/'] }) {
  const tree = readTree(root);
  for (const entry of entries) need(tree.has(safeUrlPath(entry)), `Entry page missing from build: ${entry}`);
  const reached = new Map(), external = new Set(), unresolved = [], queue = [...entries];
  for (const entry of entries) reached.set(entry, new Set(['(entry)']));
  while (queue.length) {
    const current = queue.shift(), file = tree.get(current);
    const { refs, unresolved: found } = extractReferences(current, file.bytes.toString('utf8'), { ignorePrefixes });
    unresolved.push(...found);
    for (const ref of refs) {
      let target;
      try { target = resolveReference(ref.value, current, ref.base ?? current); }
      catch (error) { unresolved.push({ from: current, kind: 'invalid-reference', detail: `${ref.value}: ${error.message}` }); continue; }
      if (!target) continue;
      if (target.external) { external.add(target.external); continue; }
      if (!tree.has(target.path)) {
        // One obligation per missing target, however many ways it was found.
        unresolved.push({ from: current, kind: 'missing-file', detail: target.path, via: ref.via });
        continue;
      }
      if (!reached.has(target.path)) { reached.set(target.path, new Set()); queue.push(target.path); }
      reached.get(target.path).add(current);
    }
  }
  const files = [...reached.keys()].sort().map(p => ({ path: p, size: tree.get(p).size, sha256: tree.get(p).sha256,
    referencedBy: [...reached.get(p)].sort() }));
  // Files nobody references can still be requested by URL (public/ files,
  // stale bookmarks, crawlers). They are listed, not silently dropped.
  const unreferenced = [...tree.keys()].filter(p => !reached.has(p)).sort()
    .map(p => ({ path: p, size: tree.get(p).size, sha256: tree.get(p).sha256, stableUrl: !HASHED.test(p) }));
  const dedup = new Map(unresolved.map(u => [`${u.from}\u0000${u.kind}\u0000${u.detail}`, u]));
  return { tree, files, unreferenced, external: [...external].sort(), unresolved: [...dedup.values()] };
}

/** Byte comparison of two local trees, e.g. two rebuilds of one commit or a
 * rebuild against a locally saved copy of live bytes. */
export function compareTrees(leftRoot, rightRoot, { only } = {}) {
  const left = readTree(leftRoot), right = readTree(rightRoot);
  const paths = only ? [...new Set(only)].sort() : [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = [];
  for (const p of paths) {
    const a = left.get(p), b = right.get(p);
    if (!a || !b) differences.push({ path: p, kind: a ? 'missing-right' : 'missing-left' });
    else if (a.sha256 !== b.sha256 || a.size !== b.size) differences.push({ path: p, kind: 'bytes-differ' });
  }
  return { identical: differences.length === 0, compared: paths.length, differences };
}

/** Evidence document. Deliberately carries no approval and no completeness
 * claim: those require provenance this tool cannot see. */
export function closureEvidence({ app, root, entries, ignorePrefixes, sourceCommit = null, determinismRoot = null }) {
  need(/^[a-z][a-z0-9-]{0,40}$/.test(app ?? ''), 'An app name is required');
  need(sourceCommit === null || /^[0-9a-f]{40}$/.test(sourceCommit), 'sourceCommit must be a full commit SHA');
  const closure = computeClosure({ root, entries, ignorePrefixes });
  // Comparing a tree with itself proves nothing; refuse rather than report it.
  need(!determinismRoot || path.resolve(determinismRoot) !== path.resolve(root), 'determinismRoot must be a separate build tree');
  const determinism = determinismRoot ? compareTrees(root, determinismRoot) : null;
  const evidence = {
    schemaVersion: 1, kind: 'ui-asset-closure-evidence', app,
    entries: entries ?? ['/index.html'],
    treeSHA256: sha256(JSON.stringify([...closure.tree.values()].map(f => [f.path, f.size, f.sha256]))),
    closureSHA256: sha256(JSON.stringify(closure.files.map(f => [f.path, f.size, f.sha256]))),
    files: closure.files, unreferenced: closure.unreferenced, external: closure.external, unresolved: closure.unresolved,
    determinism: determinism ? { identical: determinism.identical, compared: determinism.compared, differences: determinism.differences } : null,
    provenance: {
      sourceCommit, sourceCommitVerified: false,
      // Byte equality of two local trees only; whether they came from two
      // independent locked builds is not something this tool can observe.
      buildDeterminism: determinism ? (determinism.identical ? 'two-local-trees-byte-identical' : 'local-trees-differ') : 'not-checked',
      independentBuildsAttested: false,
      liveByteComparison: 'not-performed',
      historicalVersions: 'unproven',
      supportedVersionIds: null,
    },
    approvedInventory: false, completenessProved: false, writesPerformed: false, networkUsed: false,
    obligations: [
      ...(closure.unresolved.length ? ['Resolve or explicitly accept every unresolved reference'] : []),
      ...(determinism && !determinism.identical ? ['Explain or remove the byte differences between the two build trees'] : []),
      'Attest that two independent locked builds of the source commit produced byte-identical trees',
      'Review runtime-computed URLs a static scan cannot see (fully computed strings, third-party loaders)',
      'Compare every closure file byte-for-byte with live production',
      'Establish which historical asset trees live tabs may still reference (deployment/version history)',
      'Decide how unreferenced stable-URL files are retained',
      'Owner review and approval of the resulting inventory digest',
    ],
  };
  return evidence;
}

function cli(argv) {
  const args = { entries: [], ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--app') { args.app = value; i++; }
    else if (flag === '--root') { args.root = path.resolve(value); i++; }
    else if (flag === '--entry') { args.entries.push(value); i++; }
    else if (flag === '--ignore-prefix') { args.ignore.push(value); i++; }
    else if (flag === '--source-commit') { args.sourceCommit = value; i++; }
    else if (flag === '--determinism-root') { args.determinismRoot = path.resolve(value); i++; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const evidence = closureEvidence({ app: args.app, root: args.root,
    entries: args.entries.length ? args.entries : undefined,
    ignorePrefixes: args.ignore.length ? args.ignore : undefined,
    sourceCommit: args.sourceCommit ?? null, determinismRoot: args.determinismRoot ?? null });
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  // Non-zero whenever the closure is not statically resolved or builds differ.
  return evidence.unresolved.length || evidence.determinism?.identical === false ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
