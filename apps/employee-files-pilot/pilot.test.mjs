import assert from 'node:assert/strict';
import test from 'node:test';
import { validateImage, validateEndpoint, validateMount, secret } from './pilot.mjs';

test('Image validation rejects mutable tags and unapproved repositories', () => {
  const hash = 'a'.repeat(64);
  assert.equal(validateImage(`nextcloud@sha256:${hash}`), `nextcloud@sha256:${hash}`);
  for (const image of ['nextcloud:latest', 'nextcloud:34.0.5-apache', `example/nextcloud@sha256:${hash}`, 'redis@sha256:short', undefined]) {
    assert.throws(() => validateImage(image));
  }
});

test('Secret lookup rejects arbitrary paths before reading disk', () => {
  for (const account of ['../admin', '../../.env', 'root', '/etc/passwd', '']) assert.throws(() => secret(account), /Unknown pilot secret/);
});

test('Remote Docker endpoints are rejected before running Compose', () => {
  assert.equal(validateEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine'), 'npipe:////./pipe/dockerDesktopLinuxEngine');
  assert.equal(validateEndpoint('unix:///var/run/docker.sock'), 'unix:///var/run/docker.sock');
  for (const endpoint of ['ssh://nas', 'tcp://192.168.50.80:2375', 'http://127.0.0.1:2375', '', undefined]) assert.throws(() => validateEndpoint(endpoint));
});

test('Bootstrap rejects global, unassigned and redirected source mounts', () => {
  const mount = { mount_id: 1, storage: '\\OC\\Files\\Storage\\Local', authentication_type: 'null::null', configuration: { datadir: '/pilot-source' }, applicable_users: ['employee-two', 'employee-one'], applicable_groups: [] };
  assert.equal(validateMount(mount), mount);
  for (const changed of [undefined, { ...mount, applicable_users: [] }, { ...mount, applicable_users: ['employee-one'] }, { ...mount, applicable_users: [...mount.applicable_users, 'outsider'] }, { ...mount, applicable_groups: ['everyone'] }, { ...mount, configuration: { datadir: '/production' } }, { ...mount, storage: 'SMB' }]) assert.throws(() => validateMount(changed));
});
