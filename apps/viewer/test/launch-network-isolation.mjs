// No Viewer test may reach a live host, in anyone's local run or in CI. A test that
// answers requests itself is not enough: the browser still resolves and preconnects to
// the names it sees. So every browser these tests start gets this list, and a caller
// cannot replace, weaken or drop any of it.
//
// Nothing but loopback resolves. IP literals are covered too: Chromium applies these
// rules to every host, which is why loopback itself has to be excluded.
const LOOPBACK_RULES = Object.freeze(['MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1', 'EXCLUDE [::1]']);

// Prediction, speculative loading and the services that call home on their own.
const DISABLED_FEATURES = Object.freeze(['PreconnectToSearch', 'NavigationPredictor', 'Prerender2', 'OptimizationHints',
  'MediaRouter', 'DialMediaRouteProvider', 'Translate', 'AutofillServerCommunication', 'InterestFeedContentSuggestions']);

const FIXED = Object.freeze([
  '--proxy-server=direct://', // a system proxy would resolve names itself, past the rules above
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

/** The caller's arguments behind the isolation ones, or an error if it tries to set any of them itself. */
export function isolatedBrowserArguments(args, { networkException } = {}, exceptions = REVIEWED_NETWORK_EXCEPTIONS) {
  const isolation = networkIsolationArguments(networkException, exceptions);
  for (const value of args) {
    const text = String(value);
    if (text.trim() === '--') throw new Error('Browser arguments may not end option parsing with "--"');
    if (OWNED.has(switchName(text))) throw new Error(`The browser launcher owns ${text.split('=', 1)[0].trim()}: tests may not reach a live host`);
  }
  return [...isolation, ...args];
}
