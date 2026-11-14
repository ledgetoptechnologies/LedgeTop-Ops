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
  const result = bootstrap({ dataDir: path.join(blocker, 'flight-logs') });
  assert.deepEqual([result.ready, result.code], [false, 'data_dir_not_writable']);
  assert.match(result.message, /UID 568/);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
});

test('the template parses: every key is known, machine credentials blank, issuer preset', () => {
  assert.throws(() => parseConfig(TEMPLATE), err => err.code === 'config_missing');
  const parsed = parseConfig(fill(TEMPLATE));
  assert.equal(parsed.ACCESS_ISSUER, 'https://ledgetoptechnologies.cloudflareaccess.com');
  assert.equal(parsed.LOGS_DATA_DIR, '/data/flight-logs');
});
