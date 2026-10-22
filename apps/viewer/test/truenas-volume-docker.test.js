'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const enabled = process.env.RUN_DOCKER_TESTS === '1';
const image = process.env.VIEWER_DOCKER_TEST_IMAGE || '';

test('pre-created uid 568 host bind persists across restart/upgrade', { skip: !enabled }, () => {
  assert.match(image, /(?:@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{7,64})$/i, 'VIEWER_DOCKER_TEST_IMAGE must be immutable');
  const upgradeImage = process.env.VIEWER_DOCKER_UPGRADE_IMAGE || image;
  assert.match(upgradeImage, /(?:@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{7,64})$/i, 'VIEWER_DOCKER_UPGRADE_IMAGE must be immutable');
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-bind-'));
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    docker('run', '--rm', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '-v', `${storagePath}:/app/storage`, image, 'sh', '-ceu', 'mkdir -p /app/storage/data /app/storage/datasets /app/storage/models /app/storage/cache /app/storage/trash /app/storage/imports/datasets /app/storage/imports/terra; : > /app/storage/.ltds-viewer-storage-root; chown -R 568:568 /app/storage');
    const write = 'const fs=require("node:fs"),{openDatabase}=require("./server/database");fs.writeFileSync("/app/storage/data/restart-marker","preserved");const db=openDatabase("/app/storage/data/viewer.sqlite");db.prepare("INSERT OR REPLACE INTO app_state(key,value,updated_at) VALUES (?,?,?)").run("volume-test","ok",new Date().toISOString());db.close();';
    docker('run', '--rm', '--user', '568:568', '-v', `${storagePath}:/app/storage`, image, 'node', '-e', write);
    const verify = 'const fs=require("node:fs"),{openDatabase}=require("./server/database");if(fs.readFileSync("/app/storage/data/restart-marker","utf8")!=="preserved")process.exit(2);const db=openDatabase("/app/storage/data/viewer.sqlite");if(db.prepare("SELECT value FROM app_state WHERE key=?").get("volume-test")?.value!=="ok")process.exit(3);db.close();';
    docker('run', '--rm', '--user', '568:568', '-v', `${storagePath}:/app/storage`, image, 'node', '-e', verify);
    docker('run', '--rm', '--user', '568:568', '-v', `${storagePath}:/app/storage`, upgradeImage, 'node', '-e', verify);
  } finally {
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      docker('run', '--rm', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '-v', `${storagePath}:/app/storage`, image, 'sh', '-ceu', `chown -R ${process.getuid()}:${process.getgid()} /app/storage`);
    }
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
