// First start on the NAS: create only the flight-logs folders, write the blank private config once, stay not-ready
// until the machine credentials are filled, then report ready, with or without a DJI key. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrap, TEMPLATE, NOT_READY_EXIT } from '../src/bootstrap.mjs';
import { parseConfig } from '../src/config.mjs';

function scratch(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-bootstrap-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, dataDir: path.join(parent, 'flight-logs') };
}
// Tests run with a temp data dir; the real deployment's fixed /data/flight-logs is checked in config tests.
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
  fs.writeFileSync(config, fill(TEMPLATE).replace(/^# Ledge Top/m, `LOGS_DATA_DIR=/data/flight-logs\n# Ledge Top`), { mode: 0o600 });
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
  t.after(() => fs.chmodSync(locked, 0o700));
  const result = bootstrap({ dataDir: path.join(locked, 'flight-logs') });
  assert.equal(result.ready, false);
  assert.ok(['data_dir_unavailable', 'data_dir_not_writable'].includes(result.code), result.code);
  assert.equal(fs.statSync(locked).mode & 0o777, 0, 'permissions are never changed');
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
  assert.equal(parsed.LOGS_DATA_DIR, '/data/flight-logs');
});

test('malformed machine credentials are not-ready before anything starts, and the message never echoes a value', t => {
  const { dataDir } = scratch(t);
  bootstrap({ dataDir });
  const config = path.join(dataDir, 'config', 'logs.env');
  const secret = 'S3cretValue'.repeat(4);
  const good = fill(TEMPLATE).replace(`OPS_DIRECTORY_CLIENT_SECRET=${'s'.repeat(32)}`, `OPS_DIRECTORY_CLIENT_SECRET=${secret}`);
  const cases = {
    access_issuer_invalid: good.replace('ACCESS_ISSUER=https://ledgetoptechnologies.cloudflareaccess.com', 'ACCESS_ISSUER=https://evil.example.test'),
    machine_audience_invalid: good.replace(`ACCESS_AUDIENCE=${'a'.repeat(64)}`, 'ACCESS_AUDIENCE=short'),
    machine_client_ids_not_distinct: good.replace('ACCESS_DEVICE_PROXY_CLIENT_ID=device-proxy.access', 'ACCESS_DEVICE_PROXY_CLIENT_ID=staff-proxy.access'),
    machine_client_id_invalid: good.replace('ACCESS_STAFF_PROXY_CLIENT_ID=staff-proxy.access', 'ACCESS_STAFF_PROXY_CLIENT_ID=bad id'),
    directory_client_id_reused: good.replace('OPS_DIRECTORY_CLIENT_ID=logs-directory.access', 'OPS_DIRECTORY_CLIENT_ID=staff-proxy.access'),
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
