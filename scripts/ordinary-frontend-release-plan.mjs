import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash, need, compileConfig, validateInstallation } from './production-deploy.mjs';
import { domainRecognitionProfile } from './production-domain-recognition.mjs';

const equal = (a, b) => canonical(a) === canonical(b);
const clone = value => structuredClone(value);
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 64 * 1024 * 1024;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function regularBytes(file, limit = MAX_FILE) {
  const stat = fs.lstatSync(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit, 'Release input must be a bounded single-link regular file');
  const bytes = fs.readFileSync(file);
  need(bytes.length === stat.size, 'Release input changed while reading');
  return bytes;
}
function pinnedBytes(pin) {
  need(pin && path.isAbsolute(pin.path) && Number.isSafeInteger(pin.size) && SHA.test(pin.sha256), 'Absolute native artifact pin required');
  const bytes = regularBytes(pin.path);
  need(bytes.length === pin.size && hash(bytes) === pin.sha256, 'Native artifact differs from reviewed pin');
  return bytes;
}
function assetPath(value) {
  need(typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value)
    && value.split('/').slice(1).every(segment => segment && segment !== '.' && segment !== '..')
    && !value.split('/').some(segment => ['.dev.vars', 'wrangler.json', 'wrangler.jsonc', '.assetsignore'].includes(segment)), 'Noncanonical or private asset path');
  return value;
}

/** Verify the complete actual upload tree, including stable public icons.
 * A manifest is local byte policy; it is not a live namespace receipt. */
export function verifyOrdinaryFrontendArtifacts(release) {
  need(release?.schemaVersion === 1 && ['operations', 'client'].includes(release.application)
    && /^[a-f0-9]{40}$/.test(release.sourceCommit) && SHA.test(release.frontendSHA256), 'Reviewed immutable source and frontend fingerprint required');
  pinnedBytes(release.main);
  need(release.sourceMap && typeof release.sourceMap.path === 'string'
    && path.resolve(release.sourceMap.path) === path.resolve(release.main.path + '.map'), 'Native source map must be the genuine main sibling path');
  const map = JSON.parse(pinnedBytes(release.sourceMap));
  need(map.version === 3 && Array.isArray(map.sources) && Array.isArray(map.sourcesContent)
    && map.sources.length === map.sourcesContent.length && map.sourcesContent.every(text => typeof text === 'string'), 'Native source map structure invalid');
  const assets = release.assets;
  need(assets && path.isAbsolute(assets.directory) && Array.isArray(assets.files)
    && assets.files.length >= 2 && assets.files.length <= 20000, 'Complete bounded root asset inventory required');
  need(fs.lstatSync(assets.directory).isDirectory() && !fs.lstatSync(assets.directory).isSymbolicLink(), 'Asset directory must be a real directory');
  const expected = new Map(), folded = new Set();
  for (const row of assets.files) {
    const name = assetPath(row.path), lower = name.toLowerCase();
    need(!folded.has(lower) && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= MAX_FILE && SHA.test(row.sha256), 'Duplicate/case-colliding or invalid asset pin');
    folded.add(lower); expected.set(name, row);
  }
  const actual = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = prefix + '/' + entry.name;
      need(!entry.isSymbolicLink(), 'Asset symlink requires review');
      if (entry.isDirectory()) walk(file, name);
      else {
        need(entry.isFile(), 'Unexpected asset filesystem entry');
        // Vite's generated control file is not a public asset. Its exact two
        // exclusions cannot hide a reviewed public file or another directory.
        if (name === '/.assetsignore') {
          need(regularBytes(file).toString('utf8').replaceAll('\r\n', '\n') === 'wrangler.json\n.dev.vars\n', 'Unreviewed asset ignore policy');
          continue;
        }
        assetPath(name);
        const row = expected.get(name);
        need(row, 'Actual upload tree contains an unreviewed file');
        const bytes = regularBytes(file);
        need(bytes.length === row.size && hash(bytes) === row.sha256, 'Browser asset differs from reviewed inventory');
        actual.push({ path: name, size: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  walk(assets.directory);
  need(actual.length === expected.size && expected.has('/index.html'), 'Complete upload inventory or root index missing');
  const html = regularBytes(path.join(assets.directory, 'index.html')).toString('utf8');
  need(!html.includes('/_ui/') && /\bsrc\s*=\s*["']\/assets\/[^"']+\.js["']/.test(html), 'Ordinary release needs root-base Vite HTML, not prefixed release HTML');
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) for (const reference of tag[0].matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = reference[1];
    if (/^https?:\/\//.test(url)) continue;
    need(url.startsWith('/') && !url.startsWith('//') && expected.has(url), 'HTML references an absent or non-root local asset');
  }
  actual.sort((a, b) => a.path.localeCompare(b.path));
  return freeze({ files: actual, totalBytes: actual.reduce((sum, row) => sum + row.size, 0), inventorySHA256: hash(canonical(actual)) });
}

/** OFFLINE compiler only. The caller pins the source, complete capture and
 * resulting packet before a separately reviewed native versioned execution. */
export function compileOrdinaryFrontendReleasePlan(snapshot, { app, release,
  profile = domainRecognitionProfile('portal-entry-canonical') } = {}) {
  need(['operations', 'client'].includes(app) && release?.application === app, 'Exact frontend application required');
  const before = clone(snapshot), beforeProfile = clone(profile);
  validateInstallation(before, { profile: beforeProfile });
  const browserProof = verifyOrdinaryFrontendArtifacts(release);
  const state = before[app], bindings = state.version.resources.bindings;
  need(bindings.filter(row => row.name === 'ASSETS').length === 1
    && equal(bindings.find(row => row.name === 'ASSETS'), { name: 'ASSETS', type: 'assets' })
    && !bindings.some(row => ['UI_ACTIVE_RELEASE', 'UI_RELEASE_ASSETS'].includes(row.name)), 'Ordinary release requires the original native ASSETS installation');
  const assets = clone(state.modern.assets);
  need(assets && equal(Object.keys(assets), ['config']) && assets.config.base_path === '/'
    && Object.keys(assets.config).every(key => ['base_path', 'html_handling', 'not_found_handling', 'run_worker_first'].includes(key)), 'Unsupported installed asset configuration');
  const config = compileConfig(before, app, release.main.path, beforeProfile);
  config.find_additional_modules = false;
  config.keep_vars = false;
  config.unsafe.metadata.keep_bindings = [];
  // These two overrides would suppress/replace the native assets upload JWT.
  // Let Wrangler register the complete directory and construct assets metadata.
  delete config.unsafe.metadata.assets;
  delete config.unsafe.metadata.keep_assets;
  config.unsafe.bindings = bindings.filter(row => row.name !== 'ASSETS').map(row => ({ name: row.name, type: 'inherit' }));
  const { base_path: ignoredRootPrefix, ...routing } = assets.config;
  config.assets = { directory: release.assets.directory, binding: 'ASSETS', ...routing };
  const expectedProfile = clone(beforeProfile);
  expectedProfile.frontendSHA256 = release.frontendSHA256;
  // Pin even the dynamic onboarding scalars which the base guard checks by shape.
  for (const [name, entry] of Object.entries(before)) for (const row of entry.version.resources.bindings)
    if (row.type === 'plain_text') {
      beforeProfile.workers[name].plainValueSHA256[row.name] = hash(row.text);
      expectedProfile.workers[name].plainValueSHA256[row.name] = hash(row.text);
    }
  return freeze({ schemaVersion: 1, application: app, sourceCommit: release.sourceCommit,
    offlineOnly: true, deploymentEnabled: false, assetsUpload: true, historicalOrphanAssetsRetained: false,
    liveNamespaceVerified: false, nativeCompletionJwtMustRemainUnmodified: true,
    baselineSHA256: hash(canonical(before)), release: clone(release), browserProof, config,
    beforeProfile, expectedProfile, expectedAssetsConfiguration: assets,
    expectedBindings: clone(bindings),
    acceptanceRequired: ['Fresh complete control capture before upload and activation',
      'Exact returned native candidate main, source map when exposed, runtime and all effective bindings',
      'Complete new frontend manifest bytes through the active native asset namespace',
      'Exact previous version rollback and previous version asset-byte checks'],
    retentionPolicy: { minimumHours: 48, automaticPruning: false, satisfiedByThisOfflinePlan: false },
    oldTabBehavior: 'Activation requires a retained asset union and byte verification in the active namespace for releases served within the previous48hours. This offline plan alone is insufficient.' });
}

export function validateOrdinaryFrontendReleasePlan(snapshot, plan, options) {
  need(equal(plan, compileOrdinaryFrontendReleasePlan(snapshot, options)), 'Ordinary frontend release plan changed');
  return plan;
}

