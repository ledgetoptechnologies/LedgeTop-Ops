import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnedProfile, findProfileProcesses, launchBrowser, spawnBrowser, stopBrowser } from './browser-launch.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const binary = () => [process.env.CHROME_PATH, process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const flags = (profile) => ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];

test('refuses any profile that is not its own ltds- temp dir', () => {
  const root = path.resolve(tmpdir());
  const refused = [
    path.parse(root).root, // a drive or filesystem root: would match nearly every process
    '', // empty resolves to the cwd
    root, // the temp dir itself
    path.join(root, 'other-profile'),
    path.join(root, 'nested', 'ltds-profile'),
    path.join(root, '..', 'ltds-profile'),
    path.join(here, 'ltds-profile'), // outside the temp dir
  ];
  for (const profile of refused) {
    assert.throws(() => assertOwnedProfile(profile), /Refusing browser profile/, `assertOwnedProfile(${JSON.stringify(profile)})`);
    // Refused before anything is spawned or registered.
    assert.throws(() => spawnBrowser(process.execPath, ['-e', '0', `--user-data-dir=${profile}`]), /Refusing browser profile/, `spawnBrowser(${JSON.stringify(profile)})`);
  }
  assert.throws(() => spawnBrowser(process.execPath, ['-e', '0']), /needs a --user-data-dir/);
  assert.throws(() => launchBrowser(process.execPath, ['-e', '0'], { prefix: 'other-' }), /must start with ltds-/);
  assert.throws(() => launchBrowser(process.execPath, ['-e', '0'], { prefix: '../ltds-' }), /must start with ltds-/);
  assert.equal(assertOwnedProfile(path.join(root, 'ltds-x-abc123')), path.join(root, 'ltds-x-abc123'));
  assert.equal(assertOwnedProfile(path.join(root, 'ltds-x-abc123', 'profile')), path.join(root, 'ltds-x-abc123', 'profile'));
});

test('cleanup stops every browser process on the profile after the spawned process is killed', { timeout: 90_000 }, async (t) => {
  const executable = binary();
  if (!executable) { t.skip('Chromium-family browser required'); return; }
  const { child, profile, cleanup } = launchBrowser(executable, flags, { prefix: 'ltds-browser-launch-test-' });
  try {
    await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'), { timeoutMs: 30_000 });
    assert.ok(findProfileProcesses(profile).length > 0, 'browser should be running on its profile');
    // The old harness stopped here: kill the pid we spawned. On Windows Edge
    // has already relaunched itself, so the real browser survives this.
    try { child.kill('SIGKILL'); } catch {}
    await delay(500);
    t.diagnostic(`processes still on the profile after killing the spawned pid: ${findProfileProcesses(profile).length}`);
  } finally {
    cleanup();
  }
  assert.deepEqual(findProfileProcesses(profile), [], 'no process may keep using the profile after cleanup');
  assert.equal(existsSync(profile), false, 'profile dir is removed');
  const started = Date.now();
  cleanup();
  stopBrowser(child);
  stopBrowser(profile);
  assert.ok(Date.now() - started < 100, 'repeat cleanup is a quick no-op');
});

for (const [mode, label] of [['exit', 'exit'], ['throw', 'crash'], ['signal', 'SIGTERM']]) {
  test(`process ${label} without cleanup still stops the browser`, { timeout: 90_000 }, async (t) => {
    const executable = binary();
    if (!executable) { t.skip('Chromium-family browser required'); return; }
    // Windows has no catchable SIGTERM: child.kill() there is TerminateProcess.
    if (mode === 'signal' && process.platform === 'win32') { t.skip('POSIX signals only'); return; }
    // A plain script, not a node:test child: the helper must not start the
    // test harness there.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [path.join(here, 'helpers', 'browser-launch-child.mjs'), executable, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (mode === 'signal' && /^PROFILE=/m.test(stdout)) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    const profile = /^PROFILE=(.+)$/m.exec(stdout)?.[1]?.trim();
    assert.ok(profile, `child reported its profile (exit ${code}): ${stdout}${stderr}`);
    if (mode !== 'exit') assert.notEqual(code, 0, 'the process still fails or terminates as before');
    assert.doesNotMatch(stdout, /ℹ tests \d|# tests \d/, 'importing the helper did not start the node:test harness');
    const leftovers = findProfileProcesses(profile);
    if (leftovers.length) stopBrowser(profile);
    assert.deepEqual(leftovers, [], 'the exit hooks stopped the browser');
    assert.equal(existsSync(profile), false, 'the exit hooks removed the profile');
  });
}

// Linux check from a non-Linux host, in a throwaway offline container:
// LTDS_BROWSER_LAUNCH_LINUX_IMAGE=<local image with node and chromium>.
test('cleanup also holds on Linux (container)', { timeout: 180_000 }, (t) => {
  const image = process.env.LTDS_BROWSER_LAUNCH_LINUX_IMAGE;
  if (!image || process.platform === 'linux') { t.skip('set LTDS_BROWSER_LAUNCH_LINUX_IMAGE on a non-Linux host'); return; }
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--pull', 'never', '--read-only', '--tmpfs', '/tmp', '-e', 'HOME=/tmp',
    '-v', `${here}:/viewer-test:ro`, '-w', '/tmp', image, 'node', '--test', '--test-reporter=spec', '/viewer-test/browser-launch.test.mjs'],
  { encoding: 'utf8', timeout: 170_000, windowsHide: true });
  t.diagnostic((result.stdout || '').split('\n').filter((line) => /[✔✖﹣]|# |processes still/.test(line)).join('\n'));
  assert.equal(result.status, 0, `container run failed: ${result.error?.message || ''}${result.stdout}${result.stderr}`);
  for (const name of ['cleanup stops every browser process', 'process exit without cleanup', 'process crash without cleanup', 'process SIGTERM without cleanup', 'refuses any profile']) {
    assert.match(result.stdout, new RegExp(`✔ ${name}`), `${name} ran and passed in the container`);
  }
});
