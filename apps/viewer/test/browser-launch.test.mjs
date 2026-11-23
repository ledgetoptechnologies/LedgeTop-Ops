import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProfileProcesses, launchBrowser, stopBrowser } from './browser-launch.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const binary = () => [process.env.CHROME_PATH, process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const flags = (profile) => ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];

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
    const child = spawn(process.execPath, [path.join(here, 'helpers', 'browser-launch-child.mjs'), executable, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  for (const name of ['cleanup stops every browser process', 'process exit without cleanup', 'process crash without cleanup', 'process SIGTERM without cleanup']) {
    assert.match(result.stdout, new RegExp(`✔ ${name}`), `${name} ran and passed in the container`);
  }
});
