# Bounded live read check

`scripts/ios-live-read-acceptance.mjs` is an operator-run backend check for the
dedicated Staging iOS edge host. It does not enable an origin, change configuration,
obtain credentials, or create an authentication proxy. Merger owns actual resource
qualification, source/data loading, admission and the decision to run it. Do not
invoke it against the current closed candidate before that qualification.

Run `node --test scripts/ios-live-read-acceptance.test.mjs` for network-free fake
transport tests. They do not prove live data or provider acceptance.

For the separately authorized live check, the owner supplies an actual scoped
human OAuth bearer through the transient inherited environment variable
`LT_IOS_ACCEPTANCE_BEARER`, then invokes `node scripts/ios-live-read-acceptance.mjs`
without arguments. Use existing approved custody; do not place the credential in
shell commands/history, files, logs, Git or chat. No machine MCP or snapshot API
key may be substituted. The CLI removes its environment entry after reading it;
that is not a claim to wipe parent environments or every memory copy.

The target is fixed in source to
`https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev`. It cannot be
overridden by environment input or command arguments. Changing the target needs a
source review and independently verified resource ownership. This QA constant
does not populate native or Worker allowlists.

The check performs only cookie-free GETs with redirects refused: a current
read-only session, all permitted business-root pages, then all project pages for
the first returned root. It accepts exactly the native DTO fields and
`project-alpha:primary`/`business` identity, bounds pages to 20 rows and ten pages
per collection, refuses repeated cursors/duplicate rows, caps each JSON body at
1 MiB, and uses a 60-second transport deadline. A page-budget overrun fails rather
than reporting partial counts as complete. Empty roots fail real-data acceptance;
an authorized root may legitimately have zero projects. No selection grant is
inferred from a root name, and permissions remain enforced by the service.

Success prints only fixed booleans and counts. Failure prints only a fixed
category or HTTP status. Names, record IDs, cursors, response bodies, user details
and credentials are never printed or written. Network exceptions are sanitized;
there are no retries or cookie/browser fallbacks.

A live pass proves only the observed backend read path and complete bounded
collections at that time. It does not prove cross-request snapshot consistency,
write denial, refresh/revocation behavior, native UI, restart persistence or device
acceptance. Keep those as separate checks. This script makes no POST or mutation
probe, and a fixture pass is not a live pass.
