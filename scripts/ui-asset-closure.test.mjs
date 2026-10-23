import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { closureEvidence, compareTrees, computeClosure, extractReferences, readTree, resolveReference } from './ui-asset-closure.mjs';

const SCRIPT = path.join(import.meta.dirname, 'ui-asset-closure.mjs');

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-closure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}
const paths = closure => closure.files.map(f => f.path);
const kinds = closure => closure.unresolved.map(u => u.kind).sort();

// A trimmed copy of what Vite emits: hashed entry, preload dependency map,
// lazy chunk, CSS with font and image, and a source map comment.
const VITE = {
  'index.html': '<!doctype html><html><head><link rel="icon" href="/favicon.svg"><script type="module" crossorigin src="/assets/index-Abc12345.js"></script><link rel="modulepreload" href="/assets/vendor-Def67890.js"><link rel="stylesheet" href="/assets/index-Ghi24680.css"></head><body><div id="root"></div></body></html>',
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'robots.txt': 'User-agent: *',
  'assets/index-Abc12345.js': 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Editor-Jkl13579.js","assets/Editor-Mno97531.css"])))=>i.map(i=>d[i]);import{a}from"./vendor-Def67890.js";const E=a(()=>__vitePreload(()=>import("./Editor-Jkl13579.js"),__vite__mapDeps([0,1])));\n//# sourceMappingURL=index-Abc12345.js.map',
  'assets/index-Abc12345.js.map': '{"version":3,"sources":[]}',
  'assets/vendor-Def67890.js': 'export const a=x=>x;',
  'assets/index-Ghi24680.css': '@font-face{src:url(/assets/inter-Pqr11223.woff2) format("woff2")}.logo{background:url("./logo-Stu44556.png?v=1#x")}.d{background:url(data:image/png;base64,AAAA)}',
  'assets/inter-Pqr11223.woff2': 'font',
  'assets/logo-Stu44556.png': 'png',
  'assets/Editor-Jkl13579.js': 'export default 1;',
  'assets/Editor-Mno97531.css': '.e{}',
  'assets/orphan-Vwx77889.js': 'unused',
};

test('follows HTML, Vite preload maps, lazy chunks, CSS refs and source maps', t => {
  const closure = computeClosure({ root: tree(t, VITE) });
  assert.deepEqual(paths(closure), [
    '/assets/Editor-Jkl13579.js', '/assets/Editor-Mno97531.css', '/assets/index-Abc12345.js', '/assets/index-Abc12345.js.map',
    '/assets/index-Ghi24680.css', '/assets/inter-Pqr11223.woff2', '/assets/logo-Stu44556.png', '/assets/vendor-Def67890.js',
    '/favicon.svg', '/index.html']);
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(closure.files.find(f => f.path === '/assets/Editor-Jkl13579.js').referencedBy, ['/assets/index-Abc12345.js']);
});

test('lists unreferenced files and marks un-hashed ones as stable URLs', t => {
  const closure = computeClosure({ root: tree(t, VITE) });
  assert.deepEqual(closure.unreferenced.map(f => [f.path, f.stableUrl]),
    [['/assets/orphan-Vwx77889.js', false], ['/robots.txt', true]]);
});

test('srcset, imagesrcset, inline style, inline script and manifest icons are followed', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<link rel="manifest" href="/site.webmanifest"><link rel="preload" as="image" imagesrcset="/a-11111111.png 1x, /b-22222222.png 2x"><img srcset="/c-33333333.png 480w,/d-44444444.png 800w" src="/e-55555555.png"><div style="background:url(/f-66666666.png)"></div><script>const x="/g-77777777.js"</script>',
    'site.webmanifest': '{"icons":[{"src":"/icon-88888888.png","sizes":"192x192"}],"start_url":"/"}',
    ...Object.fromEntries(['a-11111111.png', 'b-22222222.png', 'c-33333333.png', 'd-44444444.png', 'e-55555555.png', 'f-66666666.png', 'g-77777777.js', 'icon-88888888.png'].map(n => [n, n])),
  }) });
  assert.equal(closure.unresolved.length, 0);
  assert.equal(closure.files.length, 10);
});

test('workers and new URL(..., import.meta.url) with literal targets are followed', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<script type="module" src="/assets/main-AAAAAAAA.js"></script>',
    'assets/main-AAAAAAAA.js': 'const w=new Worker(new URL("./worker-BBBBBBBB.js",import.meta.url),{type:"module"});const wasm=new URL("./mod-CCCCCCCC.wasm",import.meta.url);navigator.serviceWorker.register("/sw.js");',
    'assets/worker-BBBBBBBB.js': 'importScripts("./helper-DDDDDDDD.js")',
    'assets/helper-DDDDDDDD.js': '1', 'assets/mod-CCCCCCCC.wasm': 'w', 'sw.js': 'self.onfetch=()=>{}',
  }) });
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(paths(closure), ['/assets/helper-DDDDDDDD.js', '/assets/main-AAAAAAAA.js', '/assets/mod-CCCCCCCC.wasm',
    '/assets/worker-BBBBBBBB.js', '/index.html', '/sw.js']);
});

test('computed targets fail closed as unresolved obligations', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<script type="module" src="/assets/main-AAAAAAAA.js"></script>',
    'assets/main-AAAAAAAA.js': 'import(`./locale-${lang}.js`);import(name);new URL(file,import.meta.url);new Worker(src);const dir="/assets/";const t=`/assets/${n}.png`;',
    'assets/c-BBBBBBBB.css': '',
  }) });
  assert.deepEqual(kinds(closure), ['computed-asset-path', 'computed-template', 'computed-template', 'computed-url', 'computed-worker', 'dynamic-import', 'dynamic-import'].sort());
});

test('route and API templates, regex text and data-URI internals are not asset obligations', () => {
  const js = extractReferences('/assets/a.js', 'const p=`/portal/projects/${id}`;const q=`/api/x/${id}.json`;const g="(?:\\\\b)import(?:\\\\s*all)";', { ignorePrefixes: ['/api/'] });
  assert.deepEqual(js.unresolved, []);
  const css = extractReferences('/assets/a.css', `.c{mask:url("data:image/svg+xml,%3Csvg%3E%3Ccircle mask='url(%23clip)'/%3E%3C/svg%3E")}.d{background:url(data:image/png;base64,AA)}`);
  assert.deepEqual(css, { refs: [], unresolved: [] });
});

test('computed CSS url() is an unresolved obligation', () => {
  const { unresolved } = extractReferences('/a.css', '.x{background:url(var(--img))}');
  assert.deepEqual(unresolved.map(u => u.kind), ['computed-css-url']);
});

test('a reference to a file absent from the build is reported, never dropped', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<script type="module" src="/assets/main-AAAAAAAA.js"></script>',
    'assets/main-AAAAAAAA.js': 'import("./gone-BBBBBBBB.js")',
  }) });
  assert.deepEqual(closure.unresolved.map(u => [u.kind, u.detail]), [['missing-file', 'js-literal → /assets/gone-BBBBBBBB.js']]);
});

test('external, data and fragment references never enter the tree', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><img src="data:image/png;base64,AA"><a href="#top"></a><script src="//cdn.example/x.js"></script>',
  }) });
  assert.deepEqual(closure.external, ['//cdn.example/x.js', 'https://fonts.googleapis.com/css2?family=Inter']);
  assert.deepEqual(paths(closure), ['/index.html']);
});

test('Worker routes under ignored prefixes are not treated as assets', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<script type="module" src="/assets/main-AAAAAAAA.js"></script>',
    'assets/main-AAAAAAAA.js': 'fetch("/api/report.json");fetch("/health.json")',
    'health.json': '{}',
  }) });
  assert.deepEqual(closure.unresolved, []);
  assert.ok(paths(closure).includes('/health.json'));
  assert.ok(!paths(closure).some(p => p.startsWith('/api/')));
});

test('traversal, encoded separators and foreign schemes are rejected', () => {
  assert.throws(() => resolveReference('/assets/%2e%2e/secret.js', '/index.html'), /Encoded/);
  assert.throws(() => resolveReference('/assets/a%2Fb.js', '/index.html'), /Encoded/);
  assert.equal(resolveReference('../../../../etc/passwd.js', '/assets/x.js').path, '/etc/passwd.js');
  assert.throws(() => resolveReference('file:///etc/passwd', '/index.html'), /Unsupported reference scheme/);
  assert.equal(resolveReference('mailto:a@b.c', '/index.html'), null);
});

test('an invalid reference inside the build is an obligation, not a crash', t => {
  const closure = computeClosure({ root: tree(t, {
    'index.html': '<script src="/assets/%2e%2e/x.js"></script>',
  }) });
  assert.deepEqual(kinds(closure), ['invalid-reference']);
});

test('case-colliding paths and symlinks make the tree ambiguous', t => {
  const root = tree(t, { 'index.html': 'x', 'assets/a.js': '1' });
  if (fs.readdirSync(root).includes('index.html') && !fs.existsSync(path.join(root, 'INDEX.HTML'))) {
    fs.writeFileSync(path.join(root, 'INDEX.HTML'), 'y');
    assert.throws(() => readTree(root), /Case-colliding/);
    fs.rmSync(path.join(root, 'INDEX.HTML'));
  }
  try { fs.symlinkSync(path.join(root, 'assets/a.js'), path.join(root, 'assets/link.js')); }
  catch { t.diagnostic('symlink creation not permitted on this host; symlink case skipped'); return; }
  assert.throws(() => readTree(root), /Symlink/);
});

test('missing entry page fails', t => {
  assert.throws(() => computeClosure({ root: tree(t, { 'other.html': '' }) }), /Entry page missing/);
});

test('compareTrees reports byte differences and files present on one side only', t => {
  const a = tree(t, { 'index.html': 'a', 'assets/x.js': '1', 'assets/only-left.js': '1' });
  const b = tree(t, { 'index.html': 'a', 'assets/x.js': '2', 'assets/only-right.js': '1' });
  assert.deepEqual(compareTrees(a, b).differences, [
    { path: '/assets/only-left.js', kind: 'missing-right' }, { path: '/assets/only-right.js', kind: 'missing-left' },
    { path: '/assets/x.js', kind: 'bytes-differ' }]);
  assert.equal(compareTrees(a, b, { only: ['/index.html'] }).identical, true);
});

test('evidence never claims approval, completeness or live verification', t => {
  const root = tree(t, VITE);
  const evidence = closureEvidence({ app: 'operations', root, sourceCommit: '159ba84253e7156b10e3564449c4e3d15cbf64f4' });
  assert.equal(evidence.approvedInventory, false);
  assert.equal(evidence.completenessProved, false);
  assert.equal(evidence.writesPerformed, false);
  assert.equal(evidence.networkUsed, false);
  assert.equal(evidence.provenance.sourceCommitVerified, false);
  assert.equal(evidence.provenance.liveByteComparison, 'not-performed');
  assert.equal(evidence.provenance.historicalVersions, 'unproven');
  assert.equal(evidence.provenance.buildDeterminism, 'not-checked');
  assert.ok(evidence.obligations.some(o => /live production/.test(o)));
  assert.ok(evidence.obligations.some(o => /Owner review/.test(o)));
  assert.equal(JSON.stringify(evidence).includes('"bytes"'), false);
});

test('evidence records a determinism check and its result', t => {
  const a = tree(t, VITE), b = tree(t, VITE), c = tree(t, { ...VITE, 'assets/vendor-Def67890.js': 'changed' });
  assert.equal(closureEvidence({ app: 'client', root: a, determinismRoot: b }).provenance.buildDeterminism, 'two-local-builds-identical');
  const differ = closureEvidence({ app: 'client', root: a, determinismRoot: c });
  assert.equal(differ.provenance.buildDeterminism, 'local-builds-differ');
  assert.ok(differ.obligations.some(o => /byte-identical/.test(o)));
});

test('closure digest is stable across runs and changes with any closure byte', t => {
  const one = closureEvidence({ app: 'client', root: tree(t, VITE) });
  const two = closureEvidence({ app: 'client', root: tree(t, VITE) });
  const three = closureEvidence({ app: 'client', root: tree(t, { ...VITE, 'assets/inter-Pqr11223.woff2': 'other' }) });
  assert.equal(one.closureSHA256, two.closureSHA256);
  assert.notEqual(one.closureSHA256, three.closureSHA256);
});

test('CLI exits 2 on unresolved references and rejects bad input', t => {
  const clean = tree(t, VITE);
  const ok = spawnSync(process.execPath, [SCRIPT, '--app', 'operations', '--root', clean], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).approvedInventory, false);
  const dirty = tree(t, { 'index.html': '<script type="module" src="/a-AAAAAAAA.js"></script>', 'a-AAAAAAAA.js': 'import(x)' });
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--app', 'operations', '--root', dirty], { encoding: 'utf8' }).status, 2);
  const bad = spawnSync(process.execPath, [SCRIPT, '--app', 'operations', '--root', clean, '--source-commit', 'abc'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /full commit SHA/);
});
