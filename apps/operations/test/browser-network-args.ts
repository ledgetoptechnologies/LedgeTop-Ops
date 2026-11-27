// Defense in depth, not proof of no egress. Playwright answers the requests a test routes, but
// the browser itself would still resolve and preconnect to the names it sees.
//
// What these do: ask Chromium to resolve only loopback, use no proxy and skip DNS prefetch and
// pings. Playwright already passes --disable-background-networking, --disable-component-update,
// --disable-sync and its own --disable-features list; none is repeated here, because a second
// copy would replace the first.
// What they do not prove: that nothing left the machine. Managed browser policy (for example
// Edge ProxySettings) overrides command-line proxy options; WebRTC, updaters, crash reporting
// and the Node process (Playwright's `request` fixture included) are outside these rules; and
// nothing here observes traffic. A run whose specs still use real host names needs egress
// denied outside the browser as well.
export const BROWSER_NETWORK_ARGS: readonly string[] = Object.freeze([
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
  "--proxy-server=direct://",
  "--disable-domain-reliability",
  "--dns-prefetch-disable",
  "--no-pings",
]);
