import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { validatePortalReleasePreflight } from '../apps/client/scripts/project-alpha-portal-receiver-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/production-deploy-profile.json')));
const DECLARATION = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/client-portal-release-profile.json')));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function need(ok, message) { if (!ok) throw new Error(message); }
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equal = (a, b) => canonical(a) === canonical(b);
const clone = value => structuredClone(value);
const without = (value, names) => Object.fromEntries(Object.entries(value).filter(([k]) => !names.includes(k)));
function named(rows) {
  need(Array.isArray(rows) && rows.every(x => typeof x.name === 'string') && new Set(rows.map(x => x.name)).size === rows.length, 'Duplicate or invalid binding/handler');
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}
function exactSet(rows) { need(Array.isArray(rows) && new Set(rows).size === rows.length, 'Duplicate array item'); return [...rows].sort(); }
function scriptShape(script) {
  return { handlers: exactSet(script.handlers), named_handlers: named(script.named_handlers).map(x => ({ ...x, handlers: exactSet(x.handlers) })) };
}
export function resourcesShape(resources) {
  return { script: scriptShape(resources.script), script_runtime: resources.script_runtime, bindings: named(resources.bindings) };
}
export function varsOf(state) {
  const rows = state.version.resources.bindings;
  need(rows.every(x => x.type !== 'json'), 'Unreviewed JSON binding type');
  return Object.fromEntries(rows.filter(x => x.type === 'plain_text').map(x => {
    need(typeof x.text === 'string', 'Plain binding value missing'); return [x.name, x.text];
  }));
}
function activeId(state) {
  const rows = state.deployment.versions;
  need(Array.isArray(rows) && rows.length === 1 && rows[0].percentage === 100 && UUID.test(rows[0].version_id), 'Production must have one100% active version');
  return rows[0].version_id;
}
export function validateInstallation(snapshot, { allowLatest = {}, profile = PROFILE, selectedApp } = {}) {
  need(profile.onboardingAdminOrigin === undefined || profile.onboardingAdminOrigin === 'https://ops.ledgetop.app', 'Unreviewed canonical admin origin profile');
  need(snapshot && equal(Object.keys(snapshot).sort(), Object.keys(profile.workers).sort()), 'Existing complete production installation required');
  for (const [app, spec] of Object.entries(profile.workers)) {
    const s = snapshot[app]; const id = activeId(s);
    need(s.version.id === id && s.modern.id === id && UUID.test(s.latest), 'Active/version identity invalid');
    if (!selectedApp || app === selectedApp) need(s.latest === (allowLatest[app] ?? id), 'Latest must equal the selected sole active version; reconcile an incomplete deployment first');
    else if (s.latest !== id) {
      need(s.latestVersion?.id === s.latest && s.latestModern?.id === s.latest && s.latestVersion.resources.script.last_deployed_from === 'wrangler', 'Unselected inactive version lacks native metadata proof');
      need(equal(resourcesShape(s.latestVersion.resources), resourcesShape(s.version.resources)) && equal(s.latestModern.assets ?? null, s.modern.assets ?? null), 'Unselected rolling version changed resources or assets');
    }
    need(equal(without(s.settings, ['bindings', 'annotations']), spec.settings), `${app}: unrecognized production settings`);
    need(equal(named(s.settings.bindings), named(s.version.resources.bindings)), `${app}: settings/version bindings differ`);
    need(equal(scriptShape(s.version.resources.script), scriptShape(spec.script)) && equal(s.version.resources.script_runtime, spec.runtime), `${app}: unrecognized exports/runtime/resources`);
    const rows = named(s.version.resources.bindings);
    need(equal(rows.filter(x => !['plain_text', 'json'].includes(x.type)), named(spec.bindings)), `${app}: unrecognized production resource or secret binding; no bootstrap allowed`);
    need(rows.filter(x => ['plain_text', 'json', 'secret_text', 'secret_key'].includes(x.type)).length <= 128, `${app}: effective text/secret budget exceeds128`);
    const vars = varsOf(s);
    need(equal(Object.keys(vars).sort(), spec.plainNames), `${app}: unrecognized effective scalar names`);
    need(Object.entries(spec.plainValueSHA256).every(([name, sha256]) => hash(vars[name]) === sha256), `${app}: original production scalar configuration changed; review before deployment`);
    // Sync has no ENVIRONMENT scalar in its approved installed profile. Its
    // exact Worker/DB/service bindings and complete scalar hashes identify it.
    need((app === 'ops-sync' || vars.ENVIRONMENT === 'production') && (vars.OPS_AGENT_READ_ENABLED ?? 'false') === 'false', `${app}: production/machine profile invalid`);
    need(spec.forbiddenPlainNames.every(x => !Object.hasOwn(vars, x)), `${app}: omitted default flags were reintroduced`);
    need(equal(exactSet(s.schedules.schedules.map(x => x.cron)), spec.crons), `${app}: exact final schedules required; adapter never repairs them`);
    if (app !== 'ops-sync') need(s.modern.assets && typeof s.modern.assets === 'object', `${app}: existing opaque assets required`);
    need(hash(canonical(s.modern.assets ?? null)) === spec.assetsSHA256, `${app}: unrecognized asset association`);
  }
  const ops = varsOf(snapshot.operations); const client = varsOf(snapshot.client);
  for (const name of ['CLIENT_ONBOARDING_ADMIN_ENABLED', 'CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED', 'CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED', 'PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED']) need(ops[name] === 'true', `Final normal onboarding profile missing: ${name}`);
  need(ops.CLIENT_ONBOARDING_ADMIN_ORIGIN === (profile.onboardingAdminOrigin ?? 'https://ops.ledgetopdroneservices.com'), 'Canonical admin origin required');
  need(client.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED === 'true', 'Client bridge is not the reviewed final normal profile');
  const recipients = JSON.parse(ops.CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS);
  need(Array.isArray(recipients) && recipients.length >= 1 && recipients.length <= 16 && new Set(recipients).size === recipients.length && recipients.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/.test(x)), 'Notification recipient profile malformed');
  need(typeof ops.CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(ops.CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE) && Number.isFinite(Date.parse(ops.CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE)), 'Existing notification cutoff required');
  const config = (name, vars) => ({ name, vars, keep_vars: true });
  const errors = validatePortalReleasePreflight(config('ledgetop-clients', client), config('ledgetop-ops', ops), DECLARATION);
  need(errors.length === 0, `Effective production release profile rejected: ${errors.join('; ')}`);
  return snapshot;
}

export function compileConfig(snapshot, app, main, profile = PROFILE) {
  validateInstallation(snapshot, { profile, selectedApp: app }); need(Object.hasOwn(profile.workers, app), 'Unknown Worker');
  const s = snapshot[app], spec = profile.workers[app];
  const annotations = clone(s.settings.annotations ?? {});
  delete annotations['workers/triggered_by']; // API-owned, rejected by native versions upload.
  return {
    name: spec.name, main, no_bundle: true, upload_source_maps: true,
    keep_vars: true, vars: {}, workers_dev: false, preview_urls: false,
    compatibility_date: s.settings.compatibility_date, compatibility_flags: s.settings.compatibility_flags,
    unsafe: {
      bindings: s.version.resources.bindings.map(x => ({ name: x.name, type: 'inherit' })),
      metadata: { ...clone(spec.metadata), annotations, keep_assets: true },
    },
    // versions upload/versions deploy do not republish triggers. They are
    // declared here for review and checked unchanged before/after every phase.
    triggers: { crons: [...spec.crons] },
  };
}

export function reviewedFrontendDigest(file, digest) {
  // 730e3d18 adds only two read-only Windows staging preflight aliases and
  // their test to the root test command. No app/build/lock inputs change.
  // Both complete reviewed manifests are finite aliases, never script filters.
  if (file === 'package.json' && [
    'f8eb91b8e39b62df7d7a13b6474f96297e05110c443899c1b109fa2a0062a1d0',
    'c2c9b2f65bf33250158efa14ee67ac20432518ce4b33f20b45c23042ca3f2ebf',
  ].includes(digest))
    return '3c5cf8119ffa8eb65d2216db89a583ba79b91a7ada75cbae8aec0856af59ae31';
  // PR243 a045e30f changes worker-only grant DTO/method code. All browser
  // runtime bytes are identical; two source maps embed the changed source.
  // Backend mode retains the ENTIRE old opaque asset association, maps too.
  if (file === 'packages/shared/src/viewer-service.ts' && digest === '075afdc83aee2c288a10be47441e1fd7cf141edfc8a2c9936ba7102d005024b6')
    return 'a7f1b2160fb85c06d99213edbc4ef69c0df8f0e96de6284b7d312c2520f91b0f';
  return digest;
}
export function frontendInputHash(file, raw) {
  // Git checks these text files out with CRLF on this Windows worktree and LF
  // in Linux Builds. Lock source semantics, not the checkout's line endings.
  const text = /\.(?:tsx?|jsx?|mjs|cjs|jsonc?|css|svg|html|md|txt|xml|webmanifest|ya?ml)$/i.test(file);
  const digest = hash(text ? raw.toString('utf8').replaceAll('\r\n', '\n') : raw);
  // Reviewed 159ba842 -> 43f31609: the only root manifest changes add the
  // viewer:check/viewer:build scripts. Exact locked per-app builds produce
  // identical complete browser asset trees (including maps). These finite
  // byte identity aliases (plus the exact staging-only manifest above) do not
  // admit another script, dependency or file.
  return reviewedFrontendDigest(file, digest);
}
export function frontendFingerprint(root = ROOT) {
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      need(!item.isSymbolicLink(), 'Frontend source symlink requires review');
      const p = path.join(directory, item.name);
      if (item.isDirectory()) walk(p); else if (item.isFile()) files.push(path.relative(root, p).split(path.sep).join('/'));
    }
  }
  for (const app of ['client', 'operations']) {
    const base = path.join(root, 'apps', app);
    for (const item of fs.readdirSync(path.join(base, 'src'), { withFileTypes: true })) {
      if (item.name === 'worker') continue;
      const p = path.join(base, 'src', item.name);
      if (item.isDirectory()) walk(p); else files.push(path.relative(root, p).split(path.sep).join('/'));
    }
    walk(path.join(base, 'public'));
    for (const name of ['index.html', 'vite.config.ts', 'package.json', 'package-lock.json']) if (fs.existsSync(path.join(base, name))) files.push(`apps/${app}/${name}`);
  }
  for (const name of ['package.json', 'package-lock.json']) if (fs.existsSync(path.join(root, name))) files.push(name);
  walk(path.join(root, 'packages/shared/src'));
  return hash(canonical([...new Set(files)].sort().map(file => [file, frontendInputHash(file, fs.readFileSync(path.join(root, file)))])));
}
export function checkMode(mode, fingerprint = frontendFingerprint()) {
  need(mode === 'backend', 'UI deployment denied: supply a separately reviewed retained historical asset union before enabling UI mode');
  need(fingerprint === PROFILE.frontendSHA256, 'Frontend/build dependency changes require the retained asset union release path; backend mode cannot publish them');
}

export function buildModulePath(app, root = ROOT) {
  need(Object.hasOwn(PROFILE.workers, app), 'Unknown Worker');
  // Sync uses Wrangler's --outdir dist; the Vite frontends use named Worker
  // subdirectories. Never select a stale nested Sync artifact as a fallback.
  const relative = { operations: 'ledgetop_ops/index.js', client: 'ledgetop_clients/index.js', 'ops-sync': 'index.js' }[app];
  return path.join(root, 'apps', app, 'dist', relative);
}

export class CloudflareReader {
  constructor(account, token, fetchImpl = fetch) {
    // Reject malformed header values before fetch/Headers can echo them in an
    // exception. The CLI prints error messages, never credential values.
    need(/^[a-f0-9]{32}$/.test(account ?? '') && typeof token === 'string' && token.length >= 20 && !/[^\x21-\x7e]/.test(token), 'Conventional CLOUDFLARE_ACCOUNT_ID/API_TOKEN required');
    this.account = account; this.token = token; this.fetch = fetchImpl;
  }
  async get(suffix) {
    need(/^\/workers\//.test(suffix) && !suffix.includes('..'), 'Read endpoint refused');
    const response = await this.fetch(`https://api.cloudflare.com/client/v4/accounts/${this.account}${suffix}`, { method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const bytes = await response.arrayBuffer(); need(bytes.byteLength <= 32 * 1024 * 1024, 'Read response bound exceeded');
    let body; try { body = JSON.parse(Buffer.from(bytes)); } catch { throw new Error('Cloudflare returned invalid JSON'); }
    need(response.status === 200 && body.success === true && body.result, 'Cloudflare metadata GET failed; no automatic retry');
    // Only the two lists intentionally consumed as head0 may be paginated.
    if (body.result_info?.total_pages > 1) need(/^\/workers\/scripts\/[a-z-]+\/(deployments|versions)\?per_page=1$/.test(suffix), 'Incomplete metadata inventory');
    return body.result;
  }
}
export async function capture(reader, { selectedApp } = {}) {
  const out = {};
  for (const [app, spec] of Object.entries(PROFILE.workers)) {
    for (let attempt = 0; ; attempt++) {
    const pre = `/workers/scripts/${spec.name}`;
    const deployments = await reader.get(`${pre}/deployments?per_page=1`);
    need(Array.isArray(deployments.deployments) && deployments.deployments.length >= 1 && deployments.deployments.length <= 100, 'Deployment head missing or unbounded');
    const deployment = deployments.deployments[0];
    const id = activeId({ deployment });
    const versions = await reader.get(`${pre}/versions?per_page=1`);
    need(Array.isArray(versions.items) && versions.items.length >= 1 && versions.items.length <= 100, 'Version head missing or unbounded');
    out[app] = {
      deployment, latest: versions.items[0].id, version: await reader.get(`${pre}/versions/${id}`),
      modern: await reader.get(`/workers/workers/${spec.name}/versions/${id}?include=modules`),
      settings: await reader.get(`${pre}/settings`), schedules: await reader.get(`${pre}/schedules`),
    };
    if (out[app].latest !== id) {
      out[app].latestVersion = await reader.get(`${pre}/versions/${out[app].latest}`);
      out[app].latestModern = await reader.get(`/workers/workers/${spec.name}/versions/${out[app].latest}?include=modules`);
    }
    const stable = equal(await reader.get(`${pre}/deployments?per_page=1`), deployments) && equal(await reader.get(`${pre}/versions?per_page=1`), versions);
    // Independent Worker builds may progress while reading their immutable
    // metadata. Only bounded GET recapture is allowed, never native retries.
    if (stable) break;
    need(selectedApp && app !== selectedApp && attempt < 2, 'Deployment changed during metadata capture');
    }
  }
  return out;
}
function settingsShape(settings) {
  const annotations = settings.annotations ?? {};
  for (const key of ['workers/message', 'workers/triggered_by']) need(annotations[key] === undefined || typeof annotations[key] === 'string', 'Reserved annotation malformed');
  return { ...settings, annotations: without(annotations, ['workers/message', 'workers/triggered_by']) };
}
function stableState(snapshot, selected) {
  return Object.fromEntries(Object.entries(snapshot).map(([app, value]) => [app, app === selected
    ? { ...without(value, ['modern', 'latestVersion', 'latestModern']), settings: settingsShape(value.settings), assets: value.modern.assets ?? null }
    : { resources: resourcesShape(value.version.resources), settings: settingsShape(value.settings), schedules: value.schedules, assets: value.modern.assets ?? null }]));
}
export function verifySourceMap(actual, original) {
  const normalize = value => {
    const x = clone(value);
    need(x?.version === 3 && Array.isArray(x.sources) && Array.isArray(x.sourcesContent) && x.sources.length === x.sourcesContent.length && typeof x.mappings === 'string' && Array.isArray(x.names), 'Source map structure invalid');
    x.sources = x.sources.map(value => {
      need(typeof value === 'string', 'Source map source path invalid');let s = value.replaceAll('\\', '/');
      while (s.startsWith('./') || s.startsWith('../')) s = s.slice(s.indexOf('/') + 1);
      return s;
    });
    // Native upload names this genuine sibling map index.js.map.
    if (x.file === undefined) x.file = 'index.js';
    return x;
  };
  need(equal(normalize(actual), normalize(original)), 'Returned native source map differs from genuine input map');
}
export function verifyCandidate(before, app, candidate, modern, js, sourceMap) {
  need(UUID.test(candidate.id) && candidate.resources.script.last_deployed_from === 'wrangler', 'Native candidate provenance missing');
  need(equal(resourcesShape(candidate.resources), resourcesShape(before[app].version.resources)), 'Candidate resources/bindings/exports differ');
  need(modern.id === candidate.id && equal(modern.assets ?? null, before[app].modern.assets ?? null), 'Opaque assets changed');
  need(Array.isArray(modern.modules) && new Set(modern.modules.map(x => x.name)).size === modern.modules.length && modern.modules.every(x => ['index.js', 'index.js.map'].includes(x.name)), 'Unexpected candidate modules');
  const main = modern.modules.find(x => x.name === 'index.js');
  need(main && hash(Buffer.from(main.content_base64, 'base64')) === hash(js), 'Candidate runtime bytes differ');
  const map = modern.modules.find(x => x.name === 'index.js.map');
  if (map) {
    let value;try { value = JSON.parse(Buffer.from(map.content_base64, 'base64')); } catch { throw new Error('Returned source map JSON invalid'); }
    verifySourceMap(value, sourceMap);
  }
  return { returnedSourceMapSemanticsVerified: !!map, providerDidNotExposeSourceMap: !map };
}
function nativeEnvironment(env) {
  const keys = ['SYSTEMROOT','WINDIR','COMSPEC','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','PATHEXT','HOME'];
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => keys.includes(k.toUpperCase())));
  return { ...clean, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4', CI: 'true', NO_COLOR: '1', WRANGLER_LOG: 'log', WRANGLER_SEND_METRICS: 'false' };
}
export function validateBuildEnvironment(env = process.env) {
  const unsafe = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_USE_ENV_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'];
  need(!Object.entries(env).some(([name, value]) => unsafe.includes(name.toUpperCase()) && value), 'Proxy/TLS/Node injection overrides are unsupported for production deployment');
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const result = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    need(result.status === 0, 'Private journal ACL preparation failed before upload');
  }
}
async function native(cli, args, directory, phase) {
  const logPath = path.join(directory, `${phase}.private.log`);
  const log = fs.openSync(logPath, 'wx', 0o600);
  const intent = { argv: [process.execPath, '--no-warnings', cli, ...args], phase, automaticRetry: false };
  fs.writeFileSync(path.join(directory, `${phase}-intent.json`), JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['--no-warnings', cli, ...args], { cwd: ROOT, env: nativeEnvironment(process.env), stdio: ['ignore', log, log], windowsHide: true });
  fs.writeFileSync(path.join(directory, `${phase}-pid.json`), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  fs.closeSync(log);
  fs.writeFileSync(path.join(directory, `${phase}-exit.json`), JSON.stringify({ code }), { flag: 'wx', mode: 0o600 });
  need(code === 0, `${phase} native command failed/uncertain; preserve journal and reconcile; do not retry`);
  return fs.readFileSync(logPath, 'utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
export async function executeDeployment({ app, mode, cli, main, directory, reader, runNative = native, fingerprint, profile = PROFILE }) {
  checkMode(mode, fingerprint); need(Object.hasOwn(PROFILE.workers, app), 'Unknown Worker');
  need(fs.existsSync(main) && fs.existsSync(`${main}.map`), 'Build Worker index.js and genuine sibling source map before deployment');
  const js = fs.readFileSync(main);
  let sourceMap;try { sourceMap = JSON.parse(fs.readFileSync(`${main}.map`)); } catch { throw new Error('Genuine input source map invalid'); }
  verifySourceMap(sourceMap, sourceMap);
  const before = validateInstallation(await capture(reader, { selectedApp: app }), { profile, selectedApp: app });
  const currentMain = before[app].modern.modules.find(x => x.name === 'index.js');
  if (currentMain && hash(Buffer.from(currentMain.content_base64, 'base64')) === hash(js)) return { unchanged: true, noUpload: true };
  privateDirectory(directory);
  const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  save('before.private.json', before);
  const config = compileConfig(before, app, path.resolve(main), profile);
  const configPath = path.join(directory, 'wrangler.production.private.json');save('wrangler.production.private.json', config);
  const preupload = validateInstallation(await capture(reader, { selectedApp: app }), { profile, selectedApp: app });
  need(equal(stableState(before, app), stableState(preupload, app)), 'Production changed before upload');
  const text = await runNative(cli, ['versions', 'upload', '--config', configPath], directory, 'upload');
  const matches = [...text.matchAll(/Worker Version ID:\s*([a-f0-9-]{36})/g)].map(x => x[1]);
  need(matches.length === 1 && UUID.test(matches[0]), 'Candidate ID not uniquely proven; GET-only reconciliation required');
  const cid = matches[0], name = PROFILE.workers[app].name, pre = `/workers/scripts/${name}`;
  save('candidate.json', { candidate: cid });
  const candidate = await reader.get(`${pre}/versions/${cid}`);
  const modern = await reader.get(`/workers/workers/${name}/versions/${cid}?include=modules`);
  const mapsProof = verifyCandidate(before, app, candidate, modern, js, sourceMap);
  const inactive = await capture(reader, { selectedApp: app });validateInstallation(inactive, { allowLatest: { [app]: cid }, profile, selectedApp: app });
  const expectedInactive = clone(before);expectedInactive[app].latest = cid;
  need(equal(stableState(inactive, app), stableState(expectedInactive, app)), 'Current controls changed after inactive upload');
  save('verified-inactive.private.json', { candidate: cid, runtimeSHA256: hash(js), assetsPreserved: true, resourcesPreserved: true, ...mapsProof });
  // Recheck immediately before the separate native100% activation. No trigger
  // publication or provider POST is implemented in this adapter itself.
  const preactivation = await capture(reader, { selectedApp: app });validateInstallation(preactivation, { allowLatest: { [app]: cid }, profile, selectedApp: app });
  need(equal(stableState(preactivation, app), stableState(inactive, app)), 'Current controls changed before activation');
  await runNative(cli, ['versions', 'deploy', `${cid}@100%`, '--yes', '--config', configPath], directory, 'activate');
  const after = validateInstallation(await capture(reader, { selectedApp: app }), { profile, selectedApp: app });
  need(activeId(after[app]) === cid, 'Activation uncertain; GET-only reconciliation required');
  const finalMapsProof = verifyCandidate(before, app, after[app].version, after[app].modern, js, sourceMap);
  for (const key of Object.keys(PROFILE.workers)) if (key !== app) need(equal(stableState({ [key]: before[key] }, app), stableState({ [key]: after[key] }, app)), 'Another Worker changed protected controls');
  need(equal(settingsShape(after[app].settings), settingsShape(before[app].settings)) && equal(after[app].schedules, before[app].schedules), 'Settings or schedules changed');
  save('after.private.json', after);save('verified-active.json', { candidate: cid, runtimeSHA256: hash(js), assetsPreserved: true, resourcesPreserved: true, settingsPreserved: true, schedulesPreserved: true, ...finalMapsProof, runtimeHTTPAcceptanceStillRequired: true });
  return { candidate: cid, verifiedActive: true, journal: directory };
}
const DOMAIN_PHASE_NAMES = ['baseline', 'ops-alias-preparation', 'client-private-overlap', 'portal-entry-canonical', 'staff-canonical'];
export function parseDeploymentArguments(argv) {
  if (!argv.length || equal(argv, ['--check'])) return {kind:'check'};
  if (equal(argv, ['--check-build-environment'])) return {kind:'environment'};
  if (argv.length === 3 && argv[0] === '--inspect' && argv[1] === '--domain-phase') {
    need(DOMAIN_PHASE_NAMES.includes(argv[2]), 'Unknown reviewed domain phase');
    return {kind:'inspect',phase:argv[2]};
  }
  need([5,7].includes(argv.length) && argv[0] === '--worker' && argv[2] === '--mode' && argv[4] === '--execute'
    && (argv.length === 5 || argv[5] === '--domain-phase'), 'Use --worker operations|client|ops-sync --mode backend --execute [--domain-phase <reviewed-name>], or --inspect --domain-phase <reviewed-name>');
  need(Object.hasOwn(PROFILE.workers, argv[1]), 'Unknown Worker');
  need(argv[3] === 'backend', 'UI deployment denied: backend is the only supported mode');
  const phase = argv.length === 7 ? argv[6] : 'baseline';
  need(DOMAIN_PHASE_NAMES.includes(phase), 'Unknown reviewed domain phase');
  return {kind:'execute',app:argv[1],mode:'backend',phase};
}
export async function inspectProductionInstallation(reader, phase, profile) {
  need(DOMAIN_PHASE_NAMES.includes(phase), 'Unknown reviewed domain phase');
  const snapshot = validateInstallation(await capture(reader), {profile});
  return {recognizedPhase:phase,activeVersionIds:Object.fromEntries(Object.entries(snapshot).map(([app,state]) => [app,activeId(state)])),
    protectedProfileSHA256:hash(canonical(profile)),frontendSHA256:profile.frontendSHA256,
    recognized:true,readOnly:true,uploadEnabled:false,activationEnabled:false,rawSnapshotPrinted:false};
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseDeploymentArguments(argv);
  if (args.kind === 'check') { console.log(JSON.stringify({ offline: true, network: false, profile: PROFILE.profile }));return; }
  if (args.kind === 'environment') {
    const presence = { accountIdPresent: Object.hasOwn(process.env, 'CLOUDFLARE_ACCOUNT_ID'), apiTokenPresent: Object.hasOwn(process.env, 'CLOUDFLARE_API_TOKEN') };
    console.log(JSON.stringify({ offline: true, network: false, valuesPrinted: false, ...presence }));
    need(presence.accountIdPresent && presence.apiTokenPresent, 'Configure conventional production build environment before enabling deployments');return;
  }
  checkMode('backend');
  validateBuildEnvironment();
  const {domainRecognitionProfile} = await import('./production-domain-recognition.mjs');
  const profile = domainRecognitionProfile(args.phase);
  const reader = new CloudflareReader(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN);
  if (args.kind === 'inspect') {
    console.log(JSON.stringify(await inspectProductionInstallation(reader,args.phase,profile)));return;
  }
  const app = args.app;
  const cli = path.join(ROOT, 'apps', app, 'node_modules/wrangler/wrangler-dist/cli.js');
  need(fs.existsSync(cli) && hash(fs.readFileSync(cli)) === PROFILE.wranglerRuntimeSHA256, 'Installed Wrangler runtime changed; qualify before deployment');
  const main = buildModulePath(app);
  const parent = path.join(ROOT, '.backups/production-deploy');fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = path.join(parent, `${app}-${crypto.randomUUID()}`);
  const result = await executeDeployment({ app, mode: args.mode, cli, main, directory, reader, profile });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ HELD: true, message: error.message, automaticRetry: false }));process.exitCode = 1;
});
