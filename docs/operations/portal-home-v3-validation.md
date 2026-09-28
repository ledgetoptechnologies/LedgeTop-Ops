# Portal home permission: validation checkpoint

## Scope and authorization

- Owner approved Client migration `0220` changing the three existing grant,
  audit and receipt tables and their CAS guards for protocol version 3 and the
  explicit `operations.service_home.read` permission.
- Implementation and testing are limited to local fixtures and staging.
  Production deployment, public-link changes and production client activation
  are not authorized by this checkpoint.
- The home permission allows descriptive service labels only. It does not
  authorize files, Viewer access, financial documents or service mutations.

## Completed evidence

- Draft Ops PR131, source head
  `919e5ff01edbd5eebfb67d95b39189878d021678`, contains Client `0220`,
  companion Ops `0147`, shared-stream protocol handling and explicit permission
  checks. Nine CI checks have passed; the Operations suite remains pending at
  this checkpoint. No merge or production deployment occurred.
- Full private staging D1 backups preceded application of Client `0219`–`0220`
  and Ops `0145`–`0147`. Both remote migration ledgers returned no pending
  entries. Readback confirmed the updated guards and zero new grant/receipt
  and outbox/receipt rows. Applying schema did not issue access.
- Local tests include populated pre-migration receipts, unchanged v2
  fingerprints/replay, v3 permission removal, cross-version conflicts,
  immutable evidence, exact receipt acknowledgments and lost-response retries.

## Pending portal bootstrap source

- A separate candidate probes `/api/client/v2/operations/home` before creating
  the legacy PA portal session at `/portal`.
- Only HTTP 404 permits the default-off legacy path. Authentication denial,
  authorization denial, unavailable transport, malformed data and network errors
  remain closed; they do not enter legacy PA routes.
- Discovery accepts at most twenty explicitly permitted homes and rechecks the
  entire authority snapshot after bounded private metadata calls. A concurrent
  revoke or permission/revision change discards the response.
- This first home renders labels, not actionable file/billing/project links.
  Existing public-share routes and legacy non-root portal pages are unchanged.
- Final focused helper, HTTP and authority-writer selection passed 36/36,
  including multi-home snapshot loss; separate UI unit coverage passed 11/11.
  Client TypeScript checking and production build passed. Mocked local Edge
  browser coverage passed 8/8 desktop and 8/8 mobile. These are not live
  credentialed staging acceptance results.

## Remaining acceptance gates

- Complete exact-head CI and independent UI review.
- Preserve the local discovery, multi-home revocation and desktop/mobile
  browser evidence; complete credentialed live acceptance separately.
- Deploy reviewed runtime versions to staging only with all authority/home
  flags off, preserving staging secrets and rollback version IDs.
- Use a reviewed, explicit synthetic authority provisioning workflow for
  positive, denied, revoke/regrant, replay and rollback live acceptance. Do not
  forge grants by bypassing ledger guards or infer membership from email.
- Verify real recipient onboarding and subsequent service-specific capability
  boundaries before declaring the unified portal production-ready.
- Retain the production PA owner-update checkpoint and existing public links.
