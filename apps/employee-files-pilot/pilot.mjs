import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const state = path.join(root, '.pilot');
export const url = 'http://127.0.0.1:18087';
const images = JSON.parse(fs.readFileSync(path.join(root, 'images.lock.json'), 'utf8')).images;
const accounts = ['employee-one', 'employee-two', 'outsider'];

export function docker(args, { quiet = false } = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 900_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Docker command failed (${args[0]}): ${result.error?.message ?? result.stderr ?? result.stdout}`);
  if (!quiet && result.stdout.trim()) console.log(result.stdout.trim());
  return result.stdout.trim();
}

export function compose(args, options) {
  if (!fs.existsSync(path.join(state, 'images.env'))) throw new Error('Run node pilot.mjs init first.');
  assertLocalEngine();
  const expected = Object.entries(images).map(([key, value]) => `${key}=${validateImage(value)}`).join('\n');
  if (fs.readFileSync(path.join(state, 'images.env'), 'utf8').trim().replace(/\r/g, '') !== expected) {
    throw new Error('Local image references differ from images.lock.json; review the version change explicitly.');
  }
  for (const [key, value] of Object.entries(images)) {
    if (process.env[key] && process.env[key] !== value) throw new Error(`Environment override ${key} differs from the reviewed image lock.`);
  }
  return docker(['compose', '--project-name', 'ltds-employee-pilot', '--env-file', '.pilot/images.env', '--file', 'compose.yaml', ...args], options);
}

export function occ(args, options = {}) {
  return compose(['exec', '-T', '--user', 'www-data', 'app', 'php', 'occ', ...args], options);
}

export function secret(account) {
  if (!['admin', 'database', ...accounts].includes(account)) throw new Error('Unknown pilot secret');
  return fs.readFileSync(path.join(state, 'secrets', account), 'utf8').trim();
}

export function validateImage(value) {
  if (!/^(nextcloud|postgres|redis)@sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Expected an immutable official image digest');
  return value;
}

export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !/^(npipe:\/\/\/\/\.\/pipe\/|unix:\/\/\/)/.test(endpoint)) {
    throw new Error('Pilot requires a local Docker socket; remote engines are not permitted.');
  }
  return endpoint;
}

function assertLocalEngine() {
  if (process.env.DOCKER_HOST) validateEndpoint(process.env.DOCKER_HOST);
  const [context] = JSON.parse(docker(['context', 'inspect'], { quiet: true }));
  validateEndpoint(context.Endpoints?.docker?.Host);
}

export function validateMount(mount) {
  if (!mount?.mount_id || mount.storage !== '\\OC\\Files\\Storage\\Local' || mount.authentication_type !== 'null::null' || mount.configuration?.datadir !== '/pilot-source' ||
      !Array.isArray(mount.applicable_users) || JSON.stringify([...mount.applicable_users].sort()) !== JSON.stringify(['employee-one', 'employee-two']) ||
      !Array.isArray(mount.applicable_groups) || mount.applicable_groups.length) {
    throw new Error('Existing external mount differs from the restricted synthetic pilot contract. Resolve it before bootstrap.');
  }
  return mount;
}

function init() {
  assertLocalEngine();
  const initialized = fs.existsSync(path.join(state, 'images.env'));
  const names = ['admin', 'database', ...accounts];
  if (initialized && names.some(name => !fs.existsSync(path.join(state, 'secrets', name)))) {
    throw new Error('Initialized pilot is missing secrets. Restore its original secrets; init will not rotate existing database or account credentials.');
  }
  if (!initialized) {
    const volumes = docker(['volume', 'ls', '--filter', 'label=com.docker.compose.project=ltds-employee-pilot', '--format', '{{.Name}}'], { quiet: true });
    if (volumes) throw new Error('Pilot Docker volumes already exist without local initialization state. Restore the matching .pilot directory before proceeding.');
  }
  fs.mkdirSync(path.join(state, 'secrets'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(state, 'source', 'nested'), { recursive: true });
  for (const name of names) {
    const target = path.join(state, 'secrets', name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  }
  const fixture = path.join(state, 'source', 'nested', 'server-note.txt');
  if (!fs.existsSync(fixture)) fs.writeFileSync(fixture, 'Synthetic LedgeTop employee pilot source. No customer data.\n', { flag: 'wx' });
  // Reinitialization never silently changes the tested image set or credentials.
  if (!fs.existsSync(path.join(state, 'images.env'))) {
    const pinned = [];
    for (const [key, reference] of Object.entries(images)) {
      const digest = validateImage(reference);
      console.log(`Pulling pinned ${key}`);
      docker(['pull', digest], { quiet: true });
      pinned.push(`${key}=${digest}`);
    }
    fs.writeFileSync(path.join(state, 'images.env'), `${pinned.join('\n')}\n`, { flag: 'wx' });
  }
  compose(['config', '--quiet']);
  console.log('Initialized synthetic-only pilot; credentials are in ignored .pilot/secrets.');
}

async function ready() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch(`${url}/status.php`, { signal: AbortSignal.timeout(5000) });
      const status = await response.json();
      if (status.installed && !status.maintenance && !status.needsDbUpgrade) return status;
    } catch { /* Initialization can take several minutes. */ }
    if (attempt % 10 === 0) console.log('Waiting for the local Nextcloud installation...');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Local Nextcloud did not become ready. Inspect this project with docker compose logs.');
}

async function bootstrap() {
  await ready();
  occ(['config:system:set', 'skeletondirectory', '--value=/dev/null']);
  occ(['config:system:set', 'enable_previews', '--type=boolean', '--value=false']);
  occ(['config:system:set', 'shareapi_enabled', '--type=boolean', '--value=false']);
  occ(['config:system:set', 'allow_user_to_change_display_name', '--type=boolean', '--value=false']);
  occ(['config:system:set', 'updatechecker', '--type=boolean', '--value=false']);
  occ(['background:cron']);
  occ(['app:enable', 'files_external']);
  const users = JSON.parse(occ(['user:list', '--output=json'], { quiet: true }));
  for (const user of accounts) {
    if (!(user in users)) compose(['exec', '-T', '--user', 'www-data', 'app', 'php', '/opt/pilot/occ-secret.php', user, 'user:add', '--password-from-env', '--display-name', `Pilot ${user}`, user]);
    occ(['user:setting', user, 'files', 'quota', '2 GB']);
  }
  const mounts = JSON.parse(occ(['files_external:list', '--output=json'], { quiet: true }));
  let mount = Object.values(mounts).find(value => value.mount_point === '/Server Reference');
  if (!mount) {
    occ(['files_external:create', '/Server Reference', 'local', 'null::null', '--config', 'datadir=/pilot-source', '--applicable-user', 'employee-one', '--applicable-user', 'employee-two']);
    const updated = JSON.parse(occ(['files_external:list', '--output=json'], { quiet: true }));
    mount = Object.values(updated).find(value => value.mount_point === '/Server Reference');
  }
  validateMount(mount);
  occ(['files_external:option', String(mount.mount_id), 'readonly', 'true']);
  occ(['files_external:option', String(mount.mount_id), 'enable_sharing', 'false']);
  occ(['files:scan', '--path=employee-one/files/Server Reference']);
  occ(['files:scan', '--path=employee-two/files/Server Reference']);
  fs.writeFileSync(path.join(state, 'bootstrap.json'), JSON.stringify({ url, mountId: mount.mount_id, accounts, source: 'synthetic read-only fixture', opsIdentityIntegrated: false }, null, 2));
  console.log(`Pilot configured at ${url}. Source is read-only; employee personal files are disposable writable test space.`);
}

async function run(command) {
  switch (command) {
    case 'init': return init();
    case 'up': compose(['up', '-d']); await ready(); return;
    case 'bootstrap': return bootstrap();
    case 'test': await ready(); return (await import('./acceptance.mjs')).acceptance();
    case 'status': compose(['ps']); console.log(JSON.stringify(await ready(), null, 2)); return;
    case 'stop': compose(['stop']); return;
    default: throw new Error('Usage: node pilot.mjs init|up|bootstrap|test|status|stop');
  }
}

export async function main(command) {
  if (!['init', 'up', 'bootstrap', 'test', 'status', 'stop'].includes(command)) throw new Error('Usage: node pilot.mjs init|up|bootstrap|test|status|stop');
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, 'command.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Another pilot command is running. If a previous command crashed, verify it has exited before removing .pilot/command.lock.'); }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
    return await run(command);
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
