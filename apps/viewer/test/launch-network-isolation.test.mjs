// Pure checks of the arguments every Viewer browser test launches with. No browser starts here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, spawnBrowser, stopBrowser } from './browser-launch.mjs';
import { REVIEWED_NETWORK_EXCEPTIONS, isolatedBrowserArguments, networkIsolationArguments, playwrightIsolationArguments } from './launch-network-isolation.mjs';

const RULES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]';
const here = path.dirname(fileURLToPath(import.meta.url));

const switches = (args) => args.filter((arg) => arg.startsWith('-')).map((arg) => arg.replace(/^-+/, '').split('=', 1)[0]);
const usedByTests = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
  '--enable-unsafe-swiftshader', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=/tmp/ltds-x', 'about:blank'];

test('the final list has exactly one of each switch, and a repeated one is refused', () => {
  const final = isolatedBrowserArguments(usedByTests), names = switches(final);
  assert.deepEqual(names, [...new Set(names)]);
  for (const name of ['host-resolver-rules', 'proxy-server', 'disable-features', 'disable-background-networking', 'disable-component-update', 'dns-prefetch-disable', 'no-pings'])
    assert.equal(names.filter((value) => value === name).length, 1, name);
  for (const args of [['--disable-gpu', '--disable-gpu'], ['--headless=new', '--headless'], ['--no-sandbox', '-no-sandbox'], ['--Headless', '--headless']])
    assert.throws(() => isolatedBrowserArguments(args), /given twice/, args.join(' '));
});

test('a Playwright launch keeps the isolation but none of what Playwright passes itself', () => {
  const final = playwrightIsolationArguments(['--disable-gpu']), names = switches(final);
  assert.equal(final[0], RULES); assert.deepEqual(names, [...new Set(names)]);
  assert.deepEqual(names, ['host-resolver-rules', 'proxy-server', 'disable-domain-reliability', 'dns-prefetch-disable', 'no-pings', 'disable-gpu']);
  for (const flag of ['--disable-features=X', '--enable-features=X', '--proxy-server=x', '--host-resolver-rules=x', '--disable-sync']) assert.throws(() => playwrightIsolationArguments([flag]), /launcher owns/, flag);
});

test('every launch asks for loopback-only resolution, no proxy, and no background networking, updates or prediction', () => {
  const args = isolatedBrowserArguments(['--headless=new', 'about:blank']);
  assert.equal(args[0], RULES);
  for (const flag of ['--proxy-server=direct://', '--disable-background-networking', '--disable-component-update', '--dns-prefetch-disable',
    '--no-pings', '--disable-sync', '--disable-domain-reliability']) assert.ok(args.includes(flag), flag);
  const features = args.filter((arg) => arg.startsWith('--disable-features='));
  assert.equal(features.length, 1, 'a second list would replace the first');
  for (const feature of ['PreconnectToSearch', 'NavigationPredictor', 'Prerender2', 'OptimizationHints']) assert.ok(features[0].split(/[=,]/).includes(feature), feature);
  assert.deepEqual(args.slice(-2), ['--headless=new', 'about:blank'], 'the caller keeps its own flags, in order');
  assert.equal(args.filter((arg) => arg.startsWith('--host-resolver-rules')).length, 1);
});

test('a caller cannot override, weaken or repeat what the launcher owns, however it is spelled', () => {
  const refused = [
    RULES, '--host-resolver-rules=MAP * 127.0.0.1', '--host-resolver-rules=', '--host-resolver-rules', '--host-rules=MAP * 10.0.0.1',
    '--proxy-server=http://10.0.0.1:8080', '--proxy-pac-url=http://10.0.0.1/a.pac', '--proxy-auto-detect', '--proxy-bypass-list=*', '--no-proxy-server',
    '--enable-features=Prerender2', '--disable-features=', '--enable-background-networking', '--disable-background-networking', '--disable-component-update=false',
    '--dns-prefetch-disable=0', '--dns-over-https-mode=secure', '--dns-over-https-templates=https://dns.test/', '--no-pings',
    '-host-resolver-rules=MAP * 127.0.0.1', '/host-resolver-rules=MAP * 127.0.0.1', '--HOST-RESOLVER-RULES=x', ' --host-resolver-rules=x', '--Proxy-Server=x',
  ];
  for (const flag of refused) assert.throws(() => isolatedBrowserArguments(['--headless=new', flag, 'about:blank']), /launcher owns/, flag);
  for (const end of ['--', ' -- ']) assert.throws(() => isolatedBrowserArguments([end, 'about:blank']), /end option parsing/);
  // What the tests really pass is untouched.
  const used = [...usedByTests.slice(0, -1), '/tmp/page.html', 'about:blank'];
  assert.deepEqual(isolatedBrowserArguments(used).slice(-used.length), used);
});

test('the only way past it is a named, reviewed exception, and there are none', () => {
  assert.deepEqual(REVIEWED_NETWORK_EXCEPTIONS, {}, 'a new exception must be reviewed here as well');
  assert.ok(Object.isFrozen(REVIEWED_NETWORK_EXCEPTIONS));
  for (const name of ['unknown', '', 'toString', '__proto__', null, true, {}, ['a']]) assert.throws(() => isolatedBrowserArguments([], { networkException: name }), /Not a reviewed network exception/);
  const listed = { tiles: { reason: 'A test that must fetch real map tiles.', hosts: ['tiles.example.test'] } };
  assert.equal(networkIsolationArguments('tiles', listed)[0], `${RULES}, EXCLUDE tiles.example.test`);
  assert.deepEqual(networkIsolationArguments('tiles', listed).slice(1), networkIsolationArguments().slice(1), 'every other rule still applies');
  assert.throws(() => isolatedBrowserArguments(['--host-resolver-rules=x'], { networkException: 'tiles' }, listed), /launcher owns/);
  for (const hosts of [undefined, [], ['*'], ['*.example.test'], ['https://tiles.example.test'], ['tiles.example.test:443'], ['tiles.example.test, EXCLUDE *'], ['localhost']]) {
    assert.throws(() => networkIsolationArguments('tiles', { tiles: { ...listed.tiles, hosts } }), /exact host names/, String(hosts));
  }
  for (const reason of [undefined, '', 'because']) assert.throws(() => networkIsolationArguments('tiles', { tiles: { ...listed.tiles, reason } }), /needs a reason/);
  // Nothing in the environment or the argument list can select one.
  assert.doesNotMatch(readFileSync(path.join(here, 'launch-network-isolation.mjs'), 'utf8'), /process\.env|process\.argv/);
});

test('spawnBrowser and launchBrowser hand the browser the isolated list, and refuse before starting or registering anything', () => {
  const spawned = [];
  const spawnImpl = (executable, args) => { spawned.push({ executable, args }); return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() {} }); };
  const profile = mkdtempSync(path.join(tmpdir(), 'ltds-isolation-test-'));
  const child = spawnBrowser('browser', [`--user-data-dir=${profile}`, 'about:blank'], undefined, { spawnImpl });
  assert.equal(spawned[0].args[0], RULES); assert.deepEqual(spawned[0].args.slice(-2), [`--user-data-dir=${profile}`, 'about:blank']);
  stopBrowser(child);
  assert.equal(existsSync(profile), false);
  const launched = launchBrowser('browser', (dir) => ['--headless=new', `--user-data-dir=${dir}`, 'about:blank'], { prefix: 'ltds-isolation-test-', spawnImpl });
  assert.equal(spawned[1].args[0], RULES); assert.ok(spawned[1].args.includes(`--user-data-dir=${launched.profile}`));
  launched.cleanup();

  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('ltds-isolation-refused-'));
  for (const args of [['--host-resolver-rules=MAP * 127.0.0.1', 'about:blank'], (dir) => ['--no-proxy-server', `--user-data-dir=${dir}`]]) {
    assert.throws(() => launchBrowser('browser', args, { prefix: 'ltds-isolation-refused-', spawnImpl }), /launcher owns/);
  }
  assert.throws(() => launchBrowser('browser', ['about:blank'], { prefix: 'ltds-isolation-refused-', spawnImpl, networkException: 'anything' }), /Not a reviewed/);
  assert.throws(() => spawnBrowser('browser', [`--user-data-dir=${path.join(tmpdir(), 'ltds-x')}`, '--proxy-auto-detect'], undefined, { spawnImpl }), /launcher owns/);
  assert.equal(spawned.length, 2);
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith('ltds-isolation-refused-')), before, 'a refused launch leaves no profile behind');
});

test('no Viewer test starts a browser past the launcher', () => {
  const files = readdirSync(here, { recursive: true }).map(String).filter((name) => /\.(?:m?js|cjs)$/.test(name) && !name.startsWith('launch-network-isolation'));
  assert.ok(files.includes('browser-launch.mjs'));
  for (const name of files) {
    const source = readFileSync(path.join(here, name), 'utf8');
    for (const [launch] of source.matchAll(/chromium\.launch(?:PersistentContext)?\([^\n]*/g)) assert.match(launch, /args: playwrightIsolationArguments\(/, `${name}: ${launch}`);
    if (name !== 'browser-launch.mjs') assert.doesNotMatch(source, /networkException/, name);
    for (const [, command] of source.matchAll(/(?<![\w.])spawn\(\s*([\w.]+)/g)) {
      assert.ok(!/^(?:executable|edge|chrome|browser|browserPath|chromium)$/i.test(command), `${name} spawns ${command} directly`);
    }
  }
});
