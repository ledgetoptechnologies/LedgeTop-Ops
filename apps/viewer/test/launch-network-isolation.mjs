// Defense in depth, not proof of no egress. A test that answers its own requests is not
// enough: the browser still resolves and preconnects to the names it sees. So every
// browser these tests start gets this list, and a caller cannot replace, weaken or drop it.
//
// What these arguments do: ask Chromium's network service to resolve only loopback, to
// use no proxy, and to skip prediction, updates and background services.
// What they do not prove: that nothing left the machine. Managed browser policy (for
// example Edge ProxySettings) overrides command-line proxy options; WebRTC, updaters,
// crash reporting and the Node process running the test are outside these rules; and no
// test observes the traffic. A run that still uses real host names needs egress denied
// outside the browser as well (a container with no network, or a network namespace).
const LOOPBACK_RULES = Object.freeze(['MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1', 'EXCLUDE [::1]']);

// Prediction, speculative loading and the services that call home on their own.
const DISABLED_FEATURES = Object.freeze(['PreconnectToSearch', 'NavigationPredictor', 'Prerender2', 'OptimizationHints',
  'MediaRouter', 'DialMediaRouteProvider', 'Translate', 'AutofillServerCommunication', 'InterestFeedContentSuggestions']);

const FIXED = Object.freeze([
  '--proxy-server=direct://', // a system proxy would resolve names itself; managed policy still wins
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--dns-prefetch-disable',
  '--no-pings',
]);
const FEATURES = `--disable-features=${DISABLED_FEATURES.join(',')}`;

// Playwright passes these itself, with its own --disable-features list. A second copy
// would replace that list, so a Playwright launch keeps Playwright's.
const PLAYWRIGHT_PASSES = new Set(['disable-background-networking', 'disable-component-update', 'disable-default-apps',
  'disable-client-side-phishing-detection', 'disable-sync', 'disable-features']);

// Reviewed exceptions only: name -> { reason, hosts }. Each host is one exact name that
// the browser may then resolve; every other rule still applies. There are none. Adding
// one means editing this table and the test that pins it.
export const REVIEWED_NETWORK_EXCEPTIONS = Object.freeze({});

const OWNED = new Set(['host-resolver-rules', 'host-rules', 'proxy-server', 'proxy-pac-url', 'proxy-auto-detect', 'proxy-bypass-list',
  'no-proxy-server', 'winhttp-proxy-resolver', 'enable-features', 'disable-features', 'enable-background-networking', 'dns-over-https-mode',
  'dns-over-https-templates', ...FIXED.map(switchName)]);

// Chromium accepts --name, -name and, on Windows, /name, in any letter case there.
function switchName(value) {
  return /^(?:--?|\/)([A-Za-z0-9-]+)/.exec(String(value).trim())?.[1].toLowerCase() ?? null;
}

export function networkIsolationArguments(networkException, exceptions = REVIEWED_NETWORK_EXCEPTIONS) {
  let hosts = [];
  if (networkException !== undefined) {
    if (typeof networkException !== 'string' || !Object.hasOwn(exceptions, networkException)) throw new Error(`Not a reviewed network exception: ${String(networkException)}`);
    const { reason, hosts: listed } = exceptions[networkException];
    if (typeof reason !== 'string' || reason.trim().length < 20) throw new Error(`Network exception ${networkException} needs a reason`);
    if (!Array.isArray(listed) || !listed.length || listed.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))) {
      throw new Error(`Network exception ${networkException} must list exact host names`);
    }
    hosts = listed;
  }
  return [`--host-resolver-rules=${[...LOOPBACK_RULES, ...hosts.map((host) => `EXCLUDE ${host}`)].join(', ')}`, ...FIXED, FEATURES];
}

/** The caller's arguments behind the isolation ones, each switch once, or an error if it tries to set any of those itself. */
export function isolatedBrowserArguments(args, { networkException } = {}, exceptions = REVIEWED_NETWORK_EXCEPTIONS) {
  return withoutOverrides(networkIsolationArguments(networkException, exceptions), args);
}

/** For a Playwright launch: the same isolation, less what Playwright already passes. */
export function playwrightIsolationArguments(args) {
  return withoutOverrides(networkIsolationArguments().filter((arg) => !PLAYWRIGHT_PASSES.has(switchName(arg))), args);
}

function withoutOverrides(isolation, args) {
  const seen = new Set();
  for (const value of args) {
    const text = String(value), name = switchName(text);
    if (text.trim() === '--') throw new Error('Browser arguments may not end option parsing with "--"');
    if (OWNED.has(name)) throw new Error(`The browser launcher owns ${text.split('=', 1)[0].trim()}: outside hosts stay blocked`);
    // Which copy of a repeated switch wins is not something a test should depend on.
    if (/^--?/.test(text.trim()) && name) {
      if (seen.has(name)) throw new Error(`Browser argument given twice: --${name}`);
      seen.add(name);
    }
  }
  return [...isolation, ...args];
}
