import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { isolatedBrowserArguments } from './launch-network-isolation.mjs';

// One way to start and stop the headless Chrome/Edge used by the Viewer
// browser tests, so a run never leaves a browser behind.
//
// Killing the spawned pid is not enough. On Windows, Edge relaunches itself
// (--edge-skip-compat-layer-relaunch) and the real browser is not a child of
// the pid we hold, so even `taskkill /T` on it misses the browser. Every
// launch therefore gets its own temporary --user-data-dir, and cleanup kills
// every process whose command line names that exact directory, then deletes
// it. Cleanup runs from the test's finally block (stopBrowser), the file's
// after() hook, process exit, SIGINT/SIGTERM and uncaught errors. It only
// ever matches this run's own profile directories.
//
// Every launch also asks the browser to resolve only loopback, whatever the caller
// passes. What that does and does not prove: see launch-network-isolation.mjs.

const registry = new Map(); // resolved profile dir -> { child, removeProfile }
const profileOf = new WeakMap(); // ChildProcess -> resolved profile dir
const USER_DATA_DIR = '--user-data-dir=';
const PROFILE_PREFIX = 'ltds-';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Start a browser on a fresh temporary profile. `args` is the browser's own
// argument list, or a function of the profile dir that returns it (so callers
// keep their exact flag order). Returns { child, profile, cleanup }.
export function launchBrowser(executable, args, { prefix = 'ltds-browser-', spawnOptions = { windowsHide: true, stdio: 'ignore' }, removeProfile = true, networkException, spawnImpl } = {}) {
  if (!/^ltds-[A-Za-z0-9_-]*$/.test(prefix)) throw new Error(`launchBrowser profile prefix must start with ${PROFILE_PREFIX} and be a plain name: ${prefix}`);
  const profile = mkdtempSync(path.join(tmpdir(), prefix));
  let list = typeof args === 'function' ? args(profile) : [...args];
  if (!list.includes(`${USER_DATA_DIR}${profile}`)) {
    if (list.some((arg) => String(arg).startsWith(USER_DATA_DIR))) throw new Error('launchBrowser owns --user-data-dir; pass args as a function of the profile to place it');
    const url = list.length && !String(list.at(-1)).startsWith('-') ? [list.pop()] : [];
    list = [...list, `${USER_DATA_DIR}${profile}`, ...url];
  }
  let child;
  try {
    child = spawnBrowser(executable, list, spawnOptions, { removeProfile, networkException, spawnImpl });
  } catch (error) {
    if (!registry.has(path.resolve(profile))) removeProfileDir(profile); // refused before launch
    throw error;
  }
  return { child, profile, cleanup: (options) => stopBrowser(child, options) };
}

// The kill matches every process naming the profile dir or anything under it,
// so only accept a dir that is safely this harness's own: strictly inside the
// OS temp dir, under a top-level folder named ltds-*. A root, the temp dir
// itself, an empty value (the cwd) or any other path is refused.
export function assertOwnedProfile(profile) {
  const root = path.resolve(tmpdir());
  const resolved = path.resolve(String(profile ?? ''));
  const relative = path.relative(root, resolved);
  const top = relative.split(/[\\/]/)[0];
  if (!profile || !relative || relative.startsWith('..') || path.isAbsolute(relative) || !top.startsWith(PROFILE_PREFIX)) {
    throw new Error(`Refusing browser profile outside ${path.join(root, `${PROFILE_PREFIX}*`)}: ${profile}`);
  }
  return resolved;
}

// Drop-in for child_process.spawn() on a browser command line that already
// carries --user-data-dir=<dir>. Registers that dir for cleanup before the
// browser starts, so even a failed launch is swept.
export function spawnBrowser(executable, args, spawnOptions = { windowsHide: true, stdio: 'ignore' }, { removeProfile = true, networkException, spawnImpl = spawn } = {}) {
  const flag = args.find((arg) => String(arg).startsWith(USER_DATA_DIR));
  if (!flag) throw new Error('spawnBrowser needs a --user-data-dir=<temporary profile> argument');
  const profile = assertOwnedProfile(flag.slice(USER_DATA_DIR.length).replace(/^"(.*)"$/, '$1'));
  const isolated = isolatedBrowserArguments(args, { networkException });
  installHooks();
  const entry = { child: null, removeProfile };
  registry.set(profile, entry);
  const child = spawnImpl(executable, isolated, spawnOptions);
  entry.child = child;
  profileOf.set(child, profile);
  return child;
}

// Kill the browser started on this child (or profile dir) and everything else
// using its profile, then delete the profile. Synchronous, idempotent, and a
// no-op for anything already stopped or never registered.
export function stopBrowser(childOrProfile, { removeProfile } = {}) {
  if (!childOrProfile) return;
  const profile = typeof childOrProfile === 'string' ? path.resolve(childOrProfile) : profileOf.get(childOrProfile);
  if (!profile || !registry.has(profile)) {
    if (typeof childOrProfile === 'object') killChild(childOrProfile);
    return;
  }
  stopProfiles([profile], removeProfile);
}

// Stop every browser this process started and has not stopped yet.
export function stopAllBrowsers() {
  if (registry.size) stopProfiles([...registry.keys()]);
}

function stopProfiles(profiles, removeOverride) {
  const entries = profiles.map((profile) => [profile, registry.get(profile)]);
  for (const [profile] of entries) registry.delete(profile);
  for (const [, entry] of entries) killChild(entry?.child);
  killProfileProcesses(profiles);
  for (const [profile, entry] of entries) {
    if (removeOverride ?? entry?.removeProfile ?? true) removeProfileDir(profile);
  }
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch {}
}

function removeProfileDir(profile) {
  try { assertOwnedProfile(profile); } catch { return; } // only ever delete our own temp dirs
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}

// Exact-directory match: the dir followed by the end of the argument (quote,
// whitespace, path separator or end of line), so ...-abc never matches ...-abcd.
const WINDOWS_KILL = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$skip = @($PID, [int]$env:LTDS_BROWSER_OWNER_PID)
$patterns = @($env:LTDS_BROWSER_PROFILES -split "\n" | Where-Object { $_ } | ForEach-Object {
  $dir = $_.TrimEnd('\', '/')
  foreach ($form in @($dir, $dir.Replace('\', '/'))) { [regex]::Escape($form) + '(?=$|["''\s\\/])' }
})
for ($pass = 0; $pass -lt 4; $pass++) {
  $ids = @(Get-CimInstance Win32_Process -Property ProcessId, CommandLine | Where-Object {
    $line = $_.CommandLine
    $line -and ($skip -notcontains [int]$_.ProcessId) -and @($patterns | Where-Object { $line -match $_ }).Count
  } | ForEach-Object { [int]$_.ProcessId })
  if ($ids.Count -eq 0) { break }
  # Every Edge process (browser, renderers, GPU, crashpad) names the profile
  # itself, so kill exactly the matches: no /T, which could reach the
  # runner's own ancestors. Then wait for them to be gone so their handles on
  # the profile are released before it is deleted.
  & taskkill.exe /F @($ids | ForEach-Object { '/PID'; $_ }) *> $null
  Wait-Process -Id $ids -Timeout 5
}
`;

function killProfileProcesses(profiles) {
  if (!profiles.length) return;
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_KILL], {
      env: { ...process.env, LTDS_BROWSER_PROFILES: profiles.join('\n'), LTDS_BROWSER_OWNER_PID: String(process.pid) },
      stdio: 'ignore', windowsHide: true, timeout: 30_000,
    });
    return;
  }
  for (let pass = 0; pass < 6; pass += 1) {
    if (!findProfileProcesses(profiles).length) return;
    for (const profile of profiles) spawnSync('pkill', ['-KILL', '-f', posixPattern(profile)], { stdio: 'ignore', timeout: 10_000 });
    sleepSync(150);
  }
}

const posixPattern = (profile) => `${profile.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')}([[:space:]/"']|$)`;

// Processes (other than this one) whose command line names one of these
// profile dirs exactly. Exported for the harness's own test and diagnostics.
export function findProfileProcesses(profiles) {
  const list = (Array.isArray(profiles) ? profiles : [profiles]).map((profile) => path.resolve(profile));
  const exact = (line) => list.some((profile) => {
    const forms = process.platform === 'win32' ? [profile.toLowerCase(), profile.toLowerCase().replaceAll('\\', '/')] : [profile];
    const text = process.platform === 'win32' ? line.toLowerCase() : line;
    return forms.some((form) => {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        const next = text[at + form.length];
        if (next === undefined || /["'\s\\/]/.test(next)) return true;
      }
      return false;
    });
  });
  return listProcesses().filter(({ pid, commandLine }) => pid !== process.pid && commandLine && exact(commandLine));
}

function listProcesses() {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId, CommandLine | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    return parseLines(result.stdout);
  }
  if (process.platform === 'linux') {
    const processes = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { processes.push({ pid: Number(name), commandLine: readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() }); } catch {}
    }
    return processes;
  }
  return parseLines(spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 }).stdout, /^\s*(\d+)\s+(.*)$/);
}

function parseLines(text = '', shape = /^(\d+)\t(.*)$/) {
  return String(text).split(/\r?\n/).map((line) => shape.exec(line)).filter(Boolean).map(([, pid, commandLine]) => ({ pid: Number(pid), commandLine }));
}

let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', stopAllBrowsers);
  process.on('uncaughtExceptionMonitor', stopAllBrowsers);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      stopAllBrowsers();
      // Keep the default "terminate" behaviour unless someone else handles it.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

// Registered when a test file imports this module under node:test, so it runs
// after the file's tests even when one timed out before reaching its finally
// block. A plain script importing the helper must not start the test harness;
// it still has the exit and signal hooks.
if (process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test')) after(stopAllBrowsers);
