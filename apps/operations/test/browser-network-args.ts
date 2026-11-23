// Every Operations browser test launches with these: no test may reach a live host. Playwright
// answers the requests a test routes, but the browser itself would still resolve and
// preconnect to the names it sees. Nothing but loopback resolves, IP literals included.
// Playwright already passes --disable-background-networking, --disable-component-update and
// its own --disable-features list; a second --disable-features would replace that list.
export const BROWSER_NETWORK_ARGS: readonly string[] = Object.freeze([
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
  "--proxy-server=direct://",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--dns-prefetch-disable",
  "--no-pings",
]);
