// First start on the NAS: create only the flight-logs folders, write the blank private config once, stay not-ready
// until the machine credentials are filled, then report ready, with or without a DJI key. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { bootstrap, startClosed, waitUntilConfigured, upgradeConfigFile, TEMPLATE, NOT_READY_EXIT } from '../src/bootstrap.mjs';
import { parseConfig, effectiveSummary, DATA_DIR, DEFAULT_ACCESS_ISSUER, DEFAULT_OPS_DIRECTORY_BASE_URL, REQUIRED_KEYS } from '../src/config.mjs';
import { machineIdentities, validateMachineConfig } from '../src/machine-config.mjs';

function scratch(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-bootstrap-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, dataDir: path.join(parent, 'flight-logs') };
}
// Tests run with a temp data dir; the real deployment's fixed /app-data/flight-logs is checked in config tests.
const fill = text => text
  .replace('LOGS_INGRESS_HOST=', 'LOGS_INGRESS_HOST=logs-backend-staging.example.test')
  .replace('ACCESS_AUDIENCE=', `ACCESS_AUDIENCE=${'a'.repeat(64)}`)
  .replace('ACCESS_STAFF_PROXY_CLIENT_ID=', 'ACCESS_STAFF_PROXY_CLIENT_ID=staff-proxy.access')
  .replace('ACCESS_DEVICE_PROXY_CLIENT_ID=', 'ACCESS_DEVICE_PROXY_CLIENT_ID=device-proxy.access')
  .replace('OPS_DIRECTORY_BASE_URL=', 'OPS_DIRECTORY_BASE_URL=https://ops-staging.example.test/')
  .replace('OPS_DIRECTORY_CLIENT_ID=', 'OPS_DIRECTORY_CLIENT_ID=logs-directory.access')
  .replace('OPS_DIRECTORY_CLIENT_SECRET=', `OPS_DIRECTORY_CLIENT_SECRET=${'s'.repeat(32)}`);

test('first start creates only the flight-logs folders and a private blank config, once, and is not ready', t => {
  const { parent, dataDir } = scratch(t);
  fs.mkdirSync(path.join(parent, 'sibling-app'));
  fs.writeFileSync(path.join(parent, 'sibling-app', 'keep.txt'), 'untouched');
  const first = bootstrap({ dataDir });
  assert.deepEqual([first.ready, first.code], [false, 'config_created']);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['config', 'db', 'objects']);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['flight-logs', 'sibling-app'], 'nothing else created');
  assert.equal(fs.readFileSync(path.join(parent, 'sibling-app', 'keep.txt'), 'utf8'), 'untouched');
  const config = path.join(dataDir, 'config', 'logs.env');
  assert.equal(fs.readFileSync(config, 'utf8'), TEMPLATE);
  if (process.platform !== 'win32') assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(NOT_READY_EXIT, 78);
});

test('an existing config is never overwritten; missing machine credentials stay not-ready (fail closed)', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.appendFileSync(config, '# my note\n');
  const again = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  assert.deepEqual([again.ready, again.code], [false, 'config_missing']);
  assert.ok(fs.readFileSync(config, 'utf8').endsWith('# my note\n'), 'never overwritten');
  assert.ok(!again.message.includes('s'.repeat(32)));
});

test('filled machine credentials are ready with a blank DJI key (keyless start)', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.writeFileSync(config, fill(TEMPLATE).replace(/^# Ledge Top/m, `LOGS_DATA_DIR=/app-data/flight-logs\n# Ledge Top`), { mode: 0o600 });
  const ready = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  assert.deepEqual([ready.ready, ready.code], [true, 'ready']);
  assert.equal(parseConfig(fs.readFileSync(config, 'utf8')).DJI_API_KEY, '', 'the key may stay blank');
});

test('an unwritable parent stops with a clear error and changes nothing', t => {
  const { parent } = scratch(t);
  const blocker = path.join(parent, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  // Linux: lstat under a file fails with ENOTDIR (caught, not-ready); Windows: lstat finds nothing and mkdir fails.
  const result = bootstrap({ dataDir: path.join(blocker, 'flight-logs') });
  assert.equal(result.ready, false);
  assert.ok(['data_dir_unavailable', 'data_dir_not_writable'].includes(result.code), result.code);
  assert.match(result.message, /UID 568/);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(parent), ['not-a-dir'], 'nothing created next to it');
});

test('a parent the app user cannot read or search is not-ready, never a crash, and nothing is changed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, t => {
  const { parent } = scratch(t);
  const locked = path.join(parent, 'locked');
  fs.mkdirSync(locked, { mode: 0o700 });
  fs.chmodSync(locked, 0o000);
  // Restore access inside the test, before the scratch folder's own cleanup (registered earlier) runs.
  let result, modeAfter;
  try {
    result = bootstrap({ dataDir: path.join(locked, 'flight-logs') });
    modeAfter = fs.statSync(locked).mode & 0o777;
  } finally { fs.chmodSync(locked, 0o700); }
  assert.equal(result.ready, false);
  assert.ok(['data_dir_unavailable', 'data_dir_not_writable'].includes(result.code), result.code);
  assert.equal(modeAfter, 0, 'permissions are never changed');
});

test('a config path that cannot be checked is not-ready with its error code only', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const blocker = path.join(dataDir, 'config', 'file');
  fs.writeFileSync(blocker, 'x');
  const result = bootstrap({ dataDir, configFile: path.join(blocker, 'logs.env') });
  assert.equal(result.ready, false);
  assert.ok(['config_unavailable', 'config_not_writable'].includes(result.code), result.code);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
});

test('the template parses: every key is known, machine credentials blank, issuer preset', () => {
  assert.throws(() => parseConfig(TEMPLATE), err => err.code === 'config_missing');
  const parsed = parseConfig(fill(TEMPLATE));
  assert.equal(parsed.ACCESS_ISSUER, 'https://ledgetoptechnologies.cloudflareaccess.com');
  assert.equal(parsed.LOGS_DATA_DIR, '/app-data/flight-logs');
});

test('malformed machine credentials are not-ready before anything starts, and the message never echoes a value', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  const secret = 'S3cretValue'.repeat(4);
  const good = fill(TEMPLATE).replace(`OPS_DIRECTORY_CLIENT_SECRET=${'s'.repeat(32)}`, `OPS_DIRECTORY_CLIENT_SECRET=${secret}`);
  const cases = {
    access_issuer_invalid: good.replace(/^ACCESS_ISSUER=$/m, 'ACCESS_ISSUER=https://evil.example.test'),
    machine_audience_invalid: good.replace(`ACCESS_AUDIENCE=${'a'.repeat(64)}`, 'ACCESS_AUDIENCE=short'),
    machine_client_id_invalid: good.replace('ACCESS_STAFF_PROXY_CLIENT_ID=staff-proxy.access', 'ACCESS_STAFF_PROXY_CLIENT_ID=bad id'),
    directory_base_url_invalid: good.replace('OPS_DIRECTORY_BASE_URL=https://ops-staging.example.test/', 'OPS_DIRECTORY_BASE_URL=http://ops-staging.example.test/'),
    directory_client_secret_missing: good.replace(`OPS_DIRECTORY_CLIENT_SECRET=${secret}`, 'OPS_DIRECTORY_CLIENT_SECRET=tooshort'),
    ingress_host_invalid: good.replace('LOGS_INGRESS_HOST=logs-backend-staging.example.test', 'LOGS_INGRESS_HOST=bad host/x'),
  };
  for (const [code, text] of Object.entries(cases)) {
    fs.writeFileSync(config, text, { mode: 0o600 });
    const result = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
    assert.deepEqual([result.ready, result.code], [false, code], code);
    assert.ok(!result.message.includes(secret) && !result.message.includes('evil.example.test'), `${code}: no value in the message`);
  }
  fs.writeFileSync(config, good, { mode: 0o600 });
  assert.equal(bootstrap({ dataDir, checkOptions: { platform: 'win32' } }).ready, true);
});

// Directory links: 'junction' works on Windows without privileges and is a plain symlink elsewhere.
const linkDir = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('links are refused, never followed: the root, a subfolder or the config pointing elsewhere', t => {
  for (const which of ['root', 'objects']) {
    const { parent, dataDir } = scratch(t);
    const sibling = path.join(parent, 'sibling-app');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'sentinel.txt'), 'untouched');
    if (which === 'root') linkDir(sibling, dataDir);
    else { fs.mkdirSync(dataDir); linkDir(sibling, path.join(dataDir, 'objects')); }
    const result = bootstrap({ dataDir });
    assert.deepEqual([result.ready, result.code], [false, 'data_dir_unsafe'], which);
    assert.deepEqual(fs.readdirSync(sibling), ['sentinel.txt'], `${which}: nothing written through the link`);
    assert.equal(fs.readFileSync(path.join(sibling, 'sentinel.txt'), 'utf8'), 'untouched');
  }
});

test('a config that is a link (or not a regular file) is refused before it is opened', t => {
  const { parent, dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.rmSync(config);
  fs.mkdirSync(config);
  assert.deepEqual(bootstrap({ dataDir }).code, 'config_unsafe', 'a folder in place of the file');
  fs.rmSync(config, { recursive: true });
  const elsewhere = path.join(parent, 'elsewhere.env');
  fs.writeFileSync(elsewhere, 'SECRET=from-elsewhere');
  try { fs.symlinkSync(elsewhere, config, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('file symlinks need privileges on this Windows host; folder case covered'); return; } throw error; }
  assert.deepEqual(bootstrap({ dataDir }).code, 'config_unsafe');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'SECRET=from-elsewhere');
});

test('partial settings stay closed: any missing security value keeps the host not ready', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  for (const key of ['LOGS_INGRESS_HOST', 'ACCESS_AUDIENCE', 'OPS_DIRECTORY_CLIENT_ID', 'OPS_DIRECTORY_CLIENT_SECRET']) {
    fs.writeFileSync(config, fill(TEMPLATE).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=`), { mode: 0o600 });
    const result = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
    assert.deepEqual([result.ready, result.code, result.missing], [false, 'config_missing', [key]], `${key} blank must stay closed`);
    assert.ok(result.message.includes(key));
  }
  // Both proxy ids blank in the default (separate) profile stays closed: blanks never widen scope.
  const noProxy = fill(TEMPLATE).replace(/^ACCESS_STAFF_PROXY_CLIENT_ID=.*$/m, 'ACCESS_STAFF_PROXY_CLIENT_ID=').replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=.*$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=');
  fs.writeFileSync(config, noProxy, { mode: 0o600 });
  assert.equal(bootstrap({ dataDir, checkOptions: { platform: 'win32' } }).ready, false, 'blank proxy ids stay closed');
});

test('the template has a clearly named blank DJI key entry with a comment', () => {
  assert.match(TEMPLATE, /^# DJI Open API key: paste it here.*\nDJI_API_KEY=$/m);
});

async function get(port, route, host = '127.0.0.1') {
  const response = await fetch(`http://${host}:${port}${route}`);
  return { status: response.status, body: await response.json() };
}

test('a fresh install stays up closed: every request is 404 and health says unconfigured', async t => {
  const host = await startClosed({ code: 'config_created' }, { port: 0, healthPort: 0, host: '127.0.0.1' });
  t.after(() => host.close());
  const port = host.closed.address().port, healthPort = host.health.address().port;
  for (const route of ['/', '/healthz', '/api/flight-logs', '/v1/device/uploads']) assert.equal((await get(port, route)).status, 404);
  const health = await get(healthPort, '/healthz');
  assert.deepEqual([health.status, health.body.state, health.body.configured, health.body.code], [200, 'unconfigured', false, 'config_created']);
  assert.equal((await get(healthPort, '/readyz')).status, 503, 'closed is alive but never ready');
  assert.equal((await get(healthPort, '/other')).status, 404);
});

test('a filesystem problem keeps the closed host up but unhealthy', async t => {
  const host = await startClosed({ code: 'data_dir_not_writable' }, { port: 0, healthPort: 0, host: '127.0.0.1' });
  t.after(() => host.close());
  assert.equal((await get(host.health.address().port, '/healthz')).status, 503);
  assert.equal((await get(host.closed.address().port, '/')).status, 404);
});

const freePort = () => new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => {
  const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('repeated SIGHUPs are serialised: listeners stay bound, never rebind, and startup resolves exactly once', async () => {
  const signals = new EventEmitter();
  const [port, healthPort] = [await freePort(), await freePort()];
  let ready = false, checks = 0, resolved = 0;
  const codes = ['config_missing', 'config_value'];
  const recheck = () => { checks++; return ready ? { ready: true, code: 'ready', message: 'ok' } : { ready: false, code: codes[checks % 2], message: 'm' }; };
  const waiting = waitUntilConfigured({ ready: false, code: 'config_created', message: 'm' },
    { recheck, signals, exit: () => assert.fail('must not exit'), log: () => {}, port, healthPort, host: '127.0.0.1' })
    .then(() => { resolved++; });
  await new Promise(resolve => setTimeout(resolve, 50));
  for (let i = 0; i < 25; i++) signals.emit('SIGHUP');
  assert.equal(checks, 25, 'each signal is one synchronous check, never overlapping');
  assert.equal((await get(port, '/')).status, 404, 'the same closed listener still answers');
  const health = await get(healthPort, '/healthz');
  assert.deepEqual([health.status, health.body.code], [200, codes[25 % 2]], 'health shows the latest check without rebinding');
  assert.equal((await get(healthPort, '/readyz')).status, 503);
  ready = true;
  for (let i = 0; i < 25; i++) signals.emit('SIGHUP');
  await waiting;
  assert.equal(resolved, 1);
  assert.equal(checks, 26, 'after the ready check, further signals are ignored by the closed host');
  assert.equal(signals.listenerCount('SIGHUP') + signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0);
  // The configured host can now bind both ports: no EADDRINUSE.
  for (const p of [port, healthPort]) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
});

test('a pilot config naming the old /data/flight-logs path reads as the new fixed folder', () => {
  const parsed = parseConfig(fill(TEMPLATE) + 'LOGS_DATA_DIR=/data/flight-logs\n');
  assert.equal(parsed.LOGS_DATA_DIR, DATA_DIR);
  assert.equal(DATA_DIR, '/app-data/flight-logs');
});

const SINGLE = text => text.replace(/^ACCESS_TOKEN_PROFILE=.*$/m, 'ACCESS_TOKEN_PROFILE=single')
  .replace(/^ACCESS_STAFF_PROXY_CLIENT_ID=.*$/m, 'ACCESS_STAFF_PROXY_CLIENT_ID=').replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=.*$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=');

test('defaults: blank issuer uses the built-in value; a blank directory URL is production and is reported', t => {
  const parsed = parseConfig(fill(TEMPLATE).replace(/^OPS_DIRECTORY_BASE_URL=.*$/m, 'OPS_DIRECTORY_BASE_URL='));
  assert.equal(parsed.ACCESS_ISSUER, DEFAULT_ACCESS_ISSUER);
  assert.equal(parsed.OPS_DIRECTORY_BASE_URL, DEFAULT_OPS_DIRECTORY_BASE_URL);
  assert.deepEqual(effectiveSummary(parsed), { directoryOrigin: 'https://ops.ledgetop.app', tokenProfile: 'separate' });
  const overridden = parseConfig(fill(TEMPLATE).replace(/^ACCESS_ISSUER=$/m, 'ACCESS_ISSUER=https://other.cloudflareaccess.com'));
  assert.equal(overridden.ACCESS_ISSUER, 'https://other.cloudflareaccess.com');
  assert.ok(!TEMPLATE.includes('KEYCHAIN_ENCRYPTION_KEY'), 'the optional keychain line is not generated');
  assert.equal(parseConfig(fill(TEMPLATE) + 'KEYCHAIN_ENCRYPTION_KEY=abc\n').KEYCHAIN_ENCRYPTION_KEY, 'abc', 'but still honoured');
  assert.match(TEMPLATE, /Staging MUST set its own Ops origin here\.\nOPS_DIRECTORY_BASE_URL=\n/);
  // The not-ready and ready reports carry the effective directory origin (never a secret).
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.writeFileSync(config, fill(TEMPLATE).replace(/^LOGS_INGRESS_HOST=.*$/m, 'LOGS_INGRESS_HOST='), { mode: 0o600 });
  const closed = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  assert.deepEqual(closed.effective, { directoryOrigin: 'https://ops-staging.example.test', tokenProfile: 'separate' });
  fs.writeFileSync(config, fill(TEMPLATE), { mode: 0o600 });
  const ready = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  assert.deepEqual([ready.ready, ready.effective.directoryOrigin], [true, 'https://ops-staging.example.test']);
  assert.ok(!JSON.stringify(ready).includes('s'.repeat(32)));
});

test('separate profile (the default): both proxy ids required, distinct, and not the directory token', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  const run = text => { fs.writeFileSync(config, text, { mode: 0o600 }); return bootstrap({ dataDir, checkOptions: { platform: 'win32' } }); };
  for (const profile of ['', 'separate']) {
    const base = fill(TEMPLATE).replace(/^ACCESS_TOKEN_PROFILE=.*$/m, `ACCESS_TOKEN_PROFILE=${profile}`);
    assert.equal(run(base).ready, true, `profile "${profile}" with two distinct ids`);
    const blanks = base.replace(/^ACCESS_STAFF_PROXY_CLIENT_ID=.*$/m, 'ACCESS_STAFF_PROXY_CLIENT_ID=').replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=.*$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=');
    assert.deepEqual(run(blanks).missing, ['ACCESS_STAFF_PROXY_CLIENT_ID', 'ACCESS_DEVICE_PROXY_CLIENT_ID'], 'blank ids never widen scope');
    assert.deepEqual(run(base.replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=.*$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=')).missing, ['ACCESS_DEVICE_PROXY_CLIENT_ID'],
      'one id is never promoted to the other role');
    assert.equal(run(base.replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=.*$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=staff-proxy.access')).code, 'machine_client_ids_not_distinct');
    assert.equal(run(base.replace(/^OPS_DIRECTORY_CLIENT_ID=.*$/m, 'OPS_DIRECTORY_CLIENT_ID=staff-proxy.access')).code, 'directory_client_id_reused');
  }
  assert.equal(run(fill(TEMPLATE).replace(/^ACCESS_TOKEN_PROFILE=.*$/m, 'ACCESS_TOKEN_PROFILE=shared')).code, 'config_value', 'unknown profile');
  const two = parseConfig(fill(TEMPLATE));
  assert.deepEqual(machineIdentities(two), { 'staff-proxy.access': 'staff-proxy', 'device-proxy.access': 'device-proxy' });
});

test('single profile, chosen explicitly: the directory token is the one id on both route families', t => {
  const one = parseConfig(SINGLE(fill(TEMPLATE)));
  assert.equal(one.ACCESS_STAFF_PROXY_CLIENT_ID, 'logs-directory.access');
  assert.equal(one.ACCESS_DEVICE_PROXY_CLIENT_ID, 'logs-directory.access');
  assert.deepEqual(machineIdentities(one), { 'logs-directory.access': ['staff-proxy', 'device-proxy'] });
  validateMachineConfig(one);
  assert.equal(effectiveSummary(one).tokenProfile, 'single');
  const same = SINGLE(fill(TEMPLATE)).replace(/^ACCESS_STAFF_PROXY_CLIENT_ID=$/m, 'ACCESS_STAFF_PROXY_CLIENT_ID=logs-directory.access');
  assert.equal(parseConfig(same).ACCESS_STAFF_PROXY_CLIENT_ID, 'logs-directory.access', 'a proxy line equal to the token is fine');
  const other = SINGLE(fill(TEMPLATE)).replace(/^ACCESS_DEVICE_PROXY_CLIENT_ID=$/m, 'ACCESS_DEVICE_PROXY_CLIENT_ID=device-proxy.access');
  assert.throws(() => parseConfig(other), err => err.code === 'config_value' && !err.message.includes('device-proxy.access'), 'a different id is refused, never merged');
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  fs.writeFileSync(path.join(dataDir, 'config', 'logs.env'), SINGLE(fill(TEMPLATE)), { mode: 0o600 });
  assert.equal(bootstrap({ dataDir, checkOptions: { platform: 'win32' } }).effective.tokenProfile, 'single');
});

test('the template marks the required keys, the profile choice, and a fresh file reports them by name', () => {
  const lines = TEMPLATE.split('\n');
  const required = lines.map((l, i) => /^# REQUIRED\./.test(l) ? lines.slice(i).find(x => /^[A-Z_]+=/.test(x)).replace('=', '') : null).filter(Boolean);
  assert.deepEqual(required, [...REQUIRED_KEYS]);
  assert.match(TEMPLATE, /# REQUIRED CHOICE\. "single"[^]*?\nACCESS_TOKEN_PROFILE=\n/);
  assert.throws(() => parseConfig(TEMPLATE), err => err.code === 'config_missing'
    && JSON.stringify(err.missing) === JSON.stringify([...REQUIRED_KEYS, 'ACCESS_STAFF_PROXY_CLIENT_ID', 'ACCESS_DEVICE_PROXY_CLIENT_ID']));
  assert.throws(() => parseConfig(TEMPLATE.replace(/^ACCESS_TOKEN_PROFILE=$/m, 'ACCESS_TOKEN_PROFILE=single')),
    err => JSON.stringify(err.missing) === JSON.stringify([...REQUIRED_KEYS]), 'single needs only the four');
  lines.forEach((line, i) => { if (/^[A-Z_]+=/.test(line)) assert.match(lines[i - 1], /^# (REQUIRED|Default when blank:|DJI Open API key)|^# ACCESS_\*_PROXY/, line); });
});

// A file as written by the earlier (PR 653) template, with a filled DJI key (synthetic value) and blanks.
const OLD_TEMPLATE_FILLED = `# Ledge Top flight logs: app configuration (read by the Logs app itself, not by Docker Compose).
# Keep this file private (0600, owned by the app user). Values are never logged.

LOGS_INGRESS_HOST=

# Cloudflare Access app protecting this backend, and the two service tokens allowed to call it.
ACCESS_ISSUER=https://ledgetoptechnologies.cloudflareaccess.com
ACCESS_AUDIENCE=
ACCESS_STAFF_PROXY_CLIENT_ID=
ACCESS_DEVICE_PROXY_CLIENT_ID=

OPS_DIRECTORY_BASE_URL=
OPS_DIRECTORY_CLIENT_ID=
OPS_DIRECTORY_CLIENT_SECRET=

DJI_API_KEY=synthetic-dji-key-0123456789abcdef

KEYCHAIN_ENCRYPTION_KEY=
`;

test('upgrade: an earlier file keeps every byte and its effective scope (separate), gaining only the profile line', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.writeFileSync(config, OLD_TEMPLATE_FILLED, { mode: 0o600 });
  const result = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  const after = fs.readFileSync(config, 'utf8');
  assert.ok(after.startsWith(OLD_TEMPLATE_FILLED), 'every earlier byte is an exact prefix');
  assert.match(after.slice(OLD_TEMPLATE_FILLED.length), /\nACCESS_TOKEN_PROFILE=\n$/, 'only the blank profile line is appended');
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['LOGS_INGRESS_HOST', 'ACCESS_AUDIENCE', 'OPS_DIRECTORY_CLIENT_ID', 'OPS_DIRECTORY_CLIENT_SECRET',
    'ACCESS_STAFF_PROXY_CLIENT_ID', 'ACCESS_DEVICE_PROXY_CLIENT_ID'], 'the earlier rule (both proxy ids required) still applies');
  assert.equal(result.effective.tokenProfile, 'separate');
  assert.ok(!JSON.stringify(result).includes('synthetic-dji-key'), 'never a value');
  // Same scope as before for a previously complete separate file: unchanged bytes still mean two distinct roles.
  const complete = OLD_TEMPLATE_FILLED.replace('ACCESS_AUDIENCE=', `ACCESS_AUDIENCE=${'a'.repeat(64)}`)
    .replace('LOGS_INGRESS_HOST=', 'LOGS_INGRESS_HOST=logs-backend-staging.example.test')
    .replace('ACCESS_STAFF_PROXY_CLIENT_ID=', 'ACCESS_STAFF_PROXY_CLIENT_ID=staff-proxy.access')
    .replace('ACCESS_DEVICE_PROXY_CLIENT_ID=', 'ACCESS_DEVICE_PROXY_CLIENT_ID=device-proxy.access')
    .replace('OPS_DIRECTORY_BASE_URL=', 'OPS_DIRECTORY_BASE_URL=https://ops-staging.example.test/')
    .replace('OPS_DIRECTORY_CLIENT_ID=', 'OPS_DIRECTORY_CLIENT_ID=logs-directory.access')
    .replace('OPS_DIRECTORY_CLIENT_SECRET=', `OPS_DIRECTORY_CLIENT_SECRET=${'s'.repeat(32)}`);
  fs.writeFileSync(config, complete, { mode: 0o600 });
  const ok = bootstrap({ dataDir, checkOptions: { platform: 'win32' } });
  assert.equal(ok.ready, true);
  assert.deepEqual(machineIdentities(parseConfig(fs.readFileSync(config, 'utf8'))),
    { 'staff-proxy.access': 'staff-proxy', 'device-proxy.access': 'device-proxy' }, 'prior effective scope kept exactly');
  const current = fs.readFileSync(config, 'utf8');
  assert.equal(upgradeConfigFile(config, { uid: undefined }).code, 'config_current');
  assert.equal(fs.readFileSync(config, 'utf8'), current, 'a current file is not written');
});

test('upgrade: a partial file only gains the missing keys at the end; every existing byte stays first and in order', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  const partial = '# mine\r\nDJI_API_KEY="synthetic key with spaces"\r\nACCESS_AUDIENCE=' + 'a'.repeat(64);
  fs.writeFileSync(config, partial, { mode: 0o600 });
  const result = upgradeConfigFile(config, { uid: undefined });
  assert.equal(result.code, 'config_upgraded');
  assert.deepEqual(result.added, ['LOGS_INGRESS_HOST', 'ACCESS_TOKEN_PROFILE', 'OPS_DIRECTORY_CLIENT_ID', 'OPS_DIRECTORY_CLIENT_SECRET',
    'ACCESS_STAFF_PROXY_CLIENT_ID', 'ACCESS_DEVICE_PROXY_CLIENT_ID', 'ACCESS_ISSUER', 'OPS_DIRECTORY_BASE_URL']);
  const after = fs.readFileSync(config, 'utf8');
  assert.ok(after.startsWith(partial), 'the original bytes are an exact prefix');
  assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'the file keeps its CRLF line endings');
  if (process.platform !== 'win32') assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.ok(after.includes('DJI_API_KEY="synthetic key with spaces"\r\n'), 'the key line is untouched');
  assert.equal(upgradeConfigFile(config, { uid: undefined }).code, 'config_current', 'idempotent');
  assert.deepEqual(fs.readdirSync(path.dirname(config)), ['logs.env'], 'no temp file left');
});

test('upgrade: a failed write leaves the original intact and removes its temp file', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  fs.writeFileSync(config, 'DJI_API_KEY=synthetic-dji-key\n', { mode: 0o600 });
  const boom = () => { const e = new Error('boom'); e.code = 'EROFS'; throw e; };
  for (const failing of ['openSync', 'writeSync', 'fsyncSync', 'renameSync']) {
    const fsImpl = { ...fs, [failing]: boom };
    const result = upgradeConfigFile(config, { uid: undefined, fsImpl });
    assert.deepEqual([result.code, result.error], ['config_upgrade_failed', 'EROFS'], failing);
    assert.equal(fs.readFileSync(config, 'utf8'), 'DJI_API_KEY=synthetic-dji-key\n', `${failing}: original intact`);
    assert.deepEqual(fs.readdirSync(path.dirname(config)), ['logs.env'], `${failing}: no temp file left`);
  }
  assert.equal(upgradeConfigFile(config, { uid: 99999, fsImpl: { ...fs, lstatSync: f => ({ ...fs.lstatSync(f), isFile: () => true, uid: 1 }) } }).code,
    'config_upgrade_skipped', 'never for a file owned by another user');
});
