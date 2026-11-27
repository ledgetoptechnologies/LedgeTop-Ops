import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND_COLORS, LT_MARK, LT_MARK_SVG } from '../packages/ui/src/brand.ts';
import { drift, root } from './viewer-brand.mjs';
import { BRAND_COLORS as VIEWER_BRAND_COLORS } from '../apps/viewer/brand-colors.mjs';

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const viewer = file => read(path.join('apps/viewer', file));
const VIEWER_PAGES = ['index.html', 'workspace.html', 'review-launch.html', 'public/admin-login.html', 'public/pointcloud.html'];
const VIEWER_STYLES = ['workspace.css', 'workspace-management.css', 'workspace-project-list.css', 'workspace-sidebar.css',
  'workspace-task-workflow.css', 'workspace-transfers.css', 'measurement-workspace.css', 'measurement-volume-dialog.css', 'measurement-report-document.css'];
const vars = source => Object.fromEntries([...source.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]));

test('generated Viewer mark and every favicon match packages/ui/src/brand.ts', () => {
  assert.deepEqual(drift(), [], 'run node scripts/viewer-brand.mjs --write');
  assert.equal(viewer('public/lt-mark.svg'), LT_MARK_SVG);
});

test('generated Viewer colour constants equal the shared values', () => {
  assert.deepEqual({ ...VIEWER_BRAND_COLORS }, { ...BRAND_COLORS });
  const main = viewer('main.js');
  assert.match(main, /import \{ BRAND_COLORS \} from '\.\/brand-colors\.mjs';/);
  for (const line of ['LineBasicMaterial({ color: BRAND_COLORS.measureHighlight',
    "L.polygon(m.points, { color: BRAND_COLORS.measureHighlight, weight: 3, fillColor: BRAND_COLORS.orange",
    'L.polyline(m.points, { color: BRAND_COLORS.measureHighlight', 'L.circleMarker(latlng, { radius: 5, color: BRAND_COLORS.measureHighlight']) {
    assert.ok(main.includes(line), `main.js uses the shared constant: ${line}`);
  }
  const pointcloud = viewer('public/pointcloud.html');
  assert.match(pointcloud, /border-top-color: var\(--brand-orange\);/);
  assert.match(pointcloud, /ctx\.strokeStyle = getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--brand-orange'\)\.trim\(\);/);
});

test('CSS variable fallbacks in Viewer styles equal the shared values', () => {
  const fallbackFor = { '--orange': BRAND_COLORS.orange, '--brand-orange': BRAND_COLORS.orange,
    '--orange-action': BRAND_COLORS.orangeAction, '--brand-orange-action': BRAND_COLORS.orangeAction,
    '--orange-dark': BRAND_COLORS.orangeDark, '--brand-orange-dark': BRAND_COLORS.orangeDark,
    '--orange-bright': BRAND_COLORS.orangeOnDark, '--highlight-gold': BRAND_COLORS.measureHighlight };
  const files = fs.readdirSync(path.join(root, 'apps/viewer')).filter(file => /\.(css|html|mjs|js)$/.test(file))
    .concat(fs.readdirSync(path.join(root, 'apps/viewer/public')).filter(file => /\.(html|js)$/.test(file)).map(file => `public/${file}`));
  let checked = 0;
  for (const file of files) {
    for (const [, name, fallback] of viewer(file).matchAll(/var\((--[\w-]+)\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/g)) {
      if (!(name in fallbackFor)) continue;
      checked += 1;
      assert.equal(fallback.toLowerCase(), fallbackFor[name], `${file} var(${name}, ${fallback})`);
    }
  }
  assert.ok(checked >= 6, `expected brand fallbacks to be checked, found ${checked}`);
  assert.doesNotMatch(viewer('measurement-workspace.css'), /scrollbar-color:#ee5007|scrollbar-thumb\{background:#ee5007/);
  assert.doesNotMatch(viewer('measurement-report-document.css'), /solid #ee5007/);
});

test('shared React tokens use the brand values', () => {
  const tokens = vars(read('packages/ui/src/styles.css').match(/:root\s*{[^}]*}/)[0]);
  assert.equal(tokens['--orange'], BRAND_COLORS.orange);
  assert.equal(tokens['--orange-action'], BRAND_COLORS.orangeAction);
  assert.equal(tokens['--orange-dark'], BRAND_COLORS.orangeDark);
});

test('Viewer pages show the shared mark file, not an inline copy or another site\'s logo', () => {
  for (const page of VIEWER_PAGES) {
    const source = viewer(page);
    // The launch tab animates the mark, so it draws the paths inline; they must stay the shared ones.
    if (page === 'review-launch.html') {
      for (const d of [LT_MARK.frame, LT_MARK.accent, LT_MARK.letters]) assert.ok(source.includes(`d="${d}"`), `${page} mark drifted from brand.ts`);
      assert.ok(source.includes(`viewBox="${LT_MARK.viewBox}"`), `${page} mark viewBox drifted`);
      continue;
    }
    assert.ok(!source.includes(LT_MARK.letters), `${page} carries an inline copy of the mark`);
    assert.doesNotMatch(source, /DroneLogo|<img[^>]+src="https?:/i, `${page} loads a logo from another origin`);
  }
  assert.match(viewer('index.html'), /<a id="staff-logo"><img class="lt-mark" src="\/lt-mark\.svg" alt="Ledge Top logo"><\/a>/);
  assert.match(viewer('public/admin-login.html'), /<img class="lt-mark" src="\/lt-mark\.svg" alt="">/);
  assert.match(viewer('workspace.html'), /<img class="brand-mark" src="\/lt-mark\.svg" alt="">/);
  for (const page of ['index.html', 'workspace.html', 'public/admin-login.html']) {
    assert.match(viewer(page), /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/, `${page} favicon`);
  }
});

test('the workspace mark has no frame, like the model viewer top bar', () => {
  const rules = ['workspace.css', 'workspace-density.css', 'workspace-sidebar.css']
    .flatMap(file => [...viewer(file).matchAll(/\.brand-mark\s*{([^}]*)}/g)].map(([, body]) => [file, body]));
  assert.ok(rules.length >= 1, 'expected a .brand-mark rule');
  for (const [file, body] of rules) {
    assert.doesNotMatch(body, /border|background|box-shadow|outline/, `${file} .brand-mark adds a frame: ${body}`);
  }
});

test('Viewer colour variables equal the shared brand values', () => {
  const expected = {
    '--brand-orange': BRAND_COLORS.orange, '--brand-orange-action': BRAND_COLORS.orangeAction, '--brand-orange-dark': BRAND_COLORS.orangeDark,
    '--orange': BRAND_COLORS.orange, '--orange-action': BRAND_COLORS.orangeAction, '--orange-dark': BRAND_COLORS.orangeDark,
    '--orange-bright': BRAND_COLORS.orangeOnDark, '--highlight-gold': BRAND_COLORS.measureHighlight,
  };
  let checked = 0;
  for (const file of [...VIEWER_PAGES, ...VIEWER_STYLES]) {
    const found = vars(viewer(file));
    for (const [name, value] of Object.entries(expected)) {
      if (!(name in found)) continue;
      checked += 1;
      assert.equal(found[name], value, `${file} ${name}`);
    }
    assert.ok(!('--accent-hover' in found) && !('--brand-gold' in found), `${file} still defines a retired brand variable`);
  }
  assert.ok(checked >= 6, 'expected the Viewer pages to define the brand variables');
  // Filled buttons with white text use the action shade, as in packages/ui (white on brand orange is 3.6:1).
  assert.match(viewer('index.html'), /#error-retry \{ background: var\(--brand-orange-action\); color: #fff; \}/);
  assert.match(viewer('public/pointcloud.html'), /background: var\(--brand-orange-action\); color: white;/);
  assert.match(viewer('public/admin-login.html'), /--orange-action: #cc4706/);
});

test('Viewer page titles read "<Page> · Viewer · Ledge Top" like the other apps', () => {
  const title = page => viewer(page).match(/<title>([^<]*)<\/title>/)[1];
  assert.equal(title('index.html'), 'Viewer · Ledge Top');
  assert.equal(title('workspace.html'), 'Viewer workspace · Ledge Top');
  assert.equal(title('review-launch.html'), 'Opening… · Viewer · Ledge Top');
  assert.equal(title('public/admin-login.html'), 'Sign in · Viewer · Ledge Top');
  assert.equal(title('public/pointcloud.html'), 'Point cloud · Viewer · Ledge Top');
  assert.match(viewer('main.js'), /document\.title = `\$\{p\.title\} · Viewer · Ledge Top`;/);
  assert.match(viewer('public/pointcloud.html'), /document\.title = `\$\{PROJECT_TITLE\} · Point cloud · Viewer · Ledge Top`;/);
  for (const page of VIEWER_PAGES) assert.doesNotMatch(title(page), /LTDS|Drone Services/, page);
});
